/* 桌面版：把標準版 q8 ONNX（quantize_dynamic 的 Qwen3-0.6B）改寫成「LoRA 槽版」——lora-train/make_lora_onnx.py build 的 JavaScript 孿生，使用者免 Python。
 *  純 Node（CommonJS，只用 fs／crypto），主行程與測試都能載入；不依賴 onnx 套件。
 *
 *  做的事（與 make_lora_onnx.py 一致）：28 層 × q/k/v/o/gate/up/down = 196 個目標線性層，各加一條旁支
 *      y = y_base + (x @ A) @ B
 *  A [in, R]、B [R, out] 是外部資料初始值（lora.bin，64 位元組對齊，排布順序＝層升冪 × q,k,v,o,gate,up,down × (A,B)）。
 *  原本產生 y 的節點（..._output_scale_mul）輸出改名為 y_base，之後插入 MatMul／MatMul／Add 三個節點，Add 輸出沿用原 y 名稱。
 *  lora.bin 全零時旁支為零，輸出與原模型位元相同。
 *
 *  串流：輸入檔以檔案描述元逐段讀、輸出逐段寫（每段 8 MiB），只在記憶體保留節點本體與索引。
 *  記憶體峰值＝複製緩衝 8 MiB + 節點／索引（幾 MB）＋ Node 基本量；與模型大小無關（617 MB 的輸入實測見 DESIGN.lora-training.md）。
 *  輸入也可以是位元組（Uint8Array），此時整份在記憶體（呼叫端已經持有），輸出以 parts 陣列回傳。
 *
 *  API：
 *   buildSlotModel({ srcPath | srcBytes, outDir?, rank=16, align=64, writeZeroBin=true, onProgress? })
 *      → { layout:{rank,total_bytes,tensors}, targets, outBytes, parts? , ms, peakRss }
 *      outDir 給了就寫 model_quantized.onnx、layout.json、lora.bin（全零，可關）；沒給就回傳 parts（位元組輸入限定）。
 *   makeLayout(targets, rank) 只算排布（測試用）。 */
'use strict';
const fs = require('fs');
const path = require('path');

const PROJ = [['attn', 'q_proj'], ['attn', 'k_proj'], ['attn', 'v_proj'], ['attn', 'o_proj'], ['mlp', 'gate_proj'], ['mlp', 'up_proj'], ['mlp', 'down_proj']];
const CHUNK = 8 * 1024 * 1024;
const TE = new TextEncoder();
const TD = new TextDecoder('utf-8');

function varintBytes(v) {
    const out = [];
    while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
    out.push(v);
    return Uint8Array.from(out);
}
function concat(arrs) {
    let n = 0; for (const a of arrs) n += a.length;
    const out = new Uint8Array(n); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
}
function lenField(num, payload) { return concat([varintBytes(num * 8 + 2), varintBytes(payload.length), payload]); }
function strField(num, s) { return lenField(num, TE.encode(s)); }
function intField(num, v) { return concat([varintBytes(num * 8), varintBytes(v)]); }

// ---- 來源抽象：檔案（逐段讀）或位元組 ----
function openSource(opts) {
    if (opts.srcBytes) {
        const b = opts.srcBytes;
        return { size: b.length, read: (pos, len) => b.subarray(pos, pos + len), close() {}, inMemory: true };
    }
    const fd = fs.openSync(opts.srcPath, 'r');
    const size = fs.fstatSync(fd).size;
    const small = Buffer.alloc(64);
    return {
        size, inMemory: false,
        read(pos, len) {
            const buf = len <= 64 ? small : Buffer.allocUnsafe(len);
            const n = fs.readSync(fd, buf, 0, len, pos);
            if (n !== len) throw new Error('讀檔不完整（檔案被截斷？）：位置 ' + pos + ' 要 ' + len + ' 得 ' + n);
            return len <= 64 ? Uint8Array.prototype.slice.call(buf, 0, len) : buf;
        },
        copyTo(pos, len, sink) {
            const buf = Buffer.allocUnsafe(Math.min(CHUNK, len));
            let done = 0;
            while (done < len) {
                const want = Math.min(buf.length, len - done);
                const n = fs.readSync(fd, buf, 0, want, pos + done);
                if (n <= 0) throw new Error('讀檔不完整：位置 ' + (pos + done));
                sink.write(buf.subarray(0, n));
                done += n;
            }
        },
        close() { fs.closeSync(fd); },
    };
}

function readVarintAt(src, p) {
    let v = 0, mul = 1;
    for (let i = 0; i < 10; i++) {
        const c = src.read(p++, 1)[0];
        v += (c & 0x7f) * mul; mul *= 128;
        if (!(c & 0x80)) return [v, p];
    }
    throw new Error('protobuf varint 過長');
}
// 走訪 [p, end) 的欄位；只讀標籤與長度，不讀內容
function scanFields(src, p, end, fn) {
    while (p < end) {
        const tagStart = p; let tag; [tag, p] = readVarintAt(src, p);
        const num = Math.floor(tag / 8), wt = tag % 8;
        if (wt === 0) { let val; [val, p] = readVarintAt(src, p); fn({ num, wt, tagStart, vs: p, ve: p, val, fieldEnd: p }); }
        else if (wt === 2) { let len; [len, p] = readVarintAt(src, p); if (p + len > end) throw new Error('protobuf 長度超出範圍（不是完整的 ONNX 檔）'); fn({ num, wt, tagStart, vs: p, ve: p + len, fieldEnd: p + len }); p += len; }
        else if (wt === 1) { fn({ num, wt, tagStart, vs: p, ve: p + 8, fieldEnd: p + 8 }); p += 8; }
        else if (wt === 5) { fn({ num, wt, tagStart, vs: p, ve: p + 4, fieldEnd: p + 4 }); p += 4; }
        else throw new Error('protobuf 不支援的 wire type ' + wt);
    }
}
function scanBuf(b, fn) { // 小緩衝內的欄位走訪
    const src = { read: (pos, len) => b.subarray(pos, pos + len) };
    scanFields(src, 0, b.length, fn);
}

function parseNodeBody(b) {
    const n = { name: '', op: '', inputs: [], outputs: [] };
    scanBuf(b, (f) => {
        if (f.wt !== 2) return;
        const s = TD.decode(b.subarray(f.vs, f.ve));
        if (f.num === 1) n.inputs.push(s); else if (f.num === 2) n.outputs.push(s);
        else if (f.num === 3) n.name = s; else if (f.num === 4) n.op = s;
    });
    return n;
}
// 只讀初始值的 名稱／維度／是否外部資料，不讀 raw_data
function parseTensorHead(src, s, e) {
    const t = { name: '', dims: [], external: false };
    scanFields(src, s, e, (f) => {
        if (f.num === 1) {
            if (f.wt === 0) t.dims.push(f.val);
            else if (f.wt === 2) { let p = f.vs; while (p < f.ve) { let v; [v, p] = readVarintAt(src, p); t.dims.push(v); } }
        } else if (f.num === 8 && f.wt === 2) t.name = TD.decode(src.read(f.vs, f.ve - f.vs));
        else if (f.num === 13) t.external = true;
        else if (f.num === 14 && f.wt === 0 && f.val === 1) t.external = true;
    });
    return t;
}

// 重建節點本體：把輸出 y 改名 yNew，其他欄位原樣
function renameOutput(body, y, yNew) {
    const parts = []; let found = false;
    scanBuf(body, (f) => {
        if (f.num === 2 && f.wt === 2 && TD.decode(body.subarray(f.vs, f.ve)) === y) { parts.push(strField(2, yNew)); found = true; }
        else parts.push(body.subarray(f.tagStart, f.fieldEnd));
    });
    if (!found) throw new Error('節點輸出找不到：' + y);
    return concat(parts);
}
function makeNode(inputs, outputs, name, op) {
    return concat([...inputs.map((s) => strField(1, s)), ...outputs.map((s) => strField(2, s)), strField(3, name), strField(4, op)]);
}
function externalTensor(name, dims, offset, length) {
    const entry = (k, v) => lenField(13, concat([strField(1, k), strField(2, v)])); // external_data = StringStringEntryProto{key,value}
    return concat([
        ...dims.map((d) => intField(1, d)), intField(2, 1), strField(8, name),
        entry('location', 'lora.bin'), entry('offset', String(offset)), entry('length', String(length)),
        intField(14, 1), // data_location = EXTERNAL
    ]);
}

// ---- 排布：與 make_lora_onnx.py 的 external() 逐步相同 ----
function makeLayout(targets, rank, align) {
    const tensors = []; let off = 0;
    for (const t of targets) {
        for (const [ab, dims] of [['A', [t.din, rank]], ['B', [rank, t.dout]]]) {
            const length = dims[0] * dims[1] * 4;
            tensors.push({ name: `lora.${t.layer}.${t.proj}.${ab}`, dims, offset: off, length });
            off += Math.ceil(length / align) * align;
        }
    }
    return { rank, total_bytes: off, tensors };
}

function buildSlotModel(opts) {
    const t0 = Date.now();
    const rank = opts.rank === undefined ? 16 : opts.rank, align = opts.align || 64;
    if (!(rank >= 1 && rank <= 256)) throw new Error('rank 必須在 1–256');
    if (!opts.srcBytes && !opts.srcPath) throw new Error('需要 srcPath 或 srcBytes');
    const src = openSource(opts);
    let outFd = null; const parts = []; let outBytes = 0; let peakRss = process.memoryUsage().rss;
    const tick = () => { const r = process.memoryUsage().rss; if (r > peakRss) peakRss = r; };
    const prog = (stage, done, total) => { tick(); if (opts.onProgress) opts.onProgress({ stage, done, total }); };
    const sink = {
        write(buf) {
            outBytes += buf.length;
            if (outFd !== null) { let o = 0; while (o < buf.length) o += fs.writeSync(outFd, buf, o, buf.length - o); }
            else parts.push(buf.length > 4096 ? buf : Uint8Array.from(buf));
        },
    };
    try {
        // 1. 找 graph
        let graph = null;
        scanFields(src, 0, src.size, (f) => { if (f.num === 7 && f.wt === 2) graph = f; });
        if (!graph) throw new Error('找不到 graph 欄位（不是 ONNX 模型檔）');
        // 2. 索引 graph：節點（讀本體）、初始值（只讀頭）
        const entries = []; // {num, tagStart, fieldEnd, vs, ve, node?}
        const inits = new Map();
        const nodeByOutput = new Map();
        scanFields(src, graph.vs, graph.ve, (f) => {
            const e = { num: f.num, tagStart: f.tagStart, fieldEnd: f.fieldEnd, vs: f.vs, ve: f.ve };
            if (f.wt === 2 && f.num === 1) {
                const body = Uint8Array.from(src.read(f.vs, f.ve - f.vs));
                e.body = body; e.node = parseNodeBody(body);
                for (const o of e.node.outputs) nodeByOutput.set(o, e);
            } else if (f.wt === 2 && f.num === 5) {
                const t = parseTensorHead(src, f.vs, f.ve);
                if (t.external) throw new Error('來源模型使用外部資料檔（' + t.name + '），不支援；請用單檔的 model_quantized.onnx');
                inits.set(t.name, t);
                if (/^lora\.\d+\./.test(t.name)) throw new Error('來源已經是 LoRA 槽版（有 ' + t.name + '），不需要再轉換');
            }
            entries.push(e);
        });
        prog('index', entries.length, entries.length);
        // 3. 找 196 個目標（與 Python 同一套判斷）
        const quant = new Map();
        for (const e of entries) if (e.node && e.node.op === 'MatMulInteger') quant.set(e.node.name, e);
        const layerSet = new Set();
        for (const e of entries) if (e.node && e.node.op === 'MatMulInteger' && e.node.name.includes('/layers.')) layerSet.add(parseInt(e.node.name.split('/layers.')[1].split('/')[0], 10));
        const layers = [...layerSet].sort((a, b) => a - b);
        if (!layers.length) throw new Error('來源不是 quantize_dynamic 的 q8 圖（找不到 MatMulInteger 層）');
        const targets = [];
        // 兩種命名都認：官方 q8（ORT 融合後）是 attn/…/MatMul/output_0；optimum＋quantize_dynamic 匯出的是 self_attn/…/MatMul_output_0
        const GRP_ALIASES = { attn: ['attn', 'self_attn'], mlp: ['mlp'] };
        for (const L of layers) {
            for (const [grp, proj] of PROJ) {
                let hit = null;
                for (const g of GRP_ALIASES[grp] || [grp]) for (const yName of ['/output_0', '_output_0']) {
                    const b = `/model/layers.${L}/${g}/${proj}/MatMul`;
                    const m0 = quant.get(b + '_quant'), p0 = nodeByOutput.get(b + yName);
                    if (m0 && p0) { hit = { base: b, mi: m0, y: b + yName, prod: p0 }; break; }
                }
                if (!hit) throw new Error('找不到目標層（預期 quantize_dynamic 的 q8 圖）：/model/layers.' + L + '/' + grp + '|self_attn/' + proj + '/MatMul');
                const { base, mi, y, prod } = hit;
                let x = mi.node.inputs[0];
                if (!x.endsWith('_quantized')) throw new Error('量化輸入命名不符：' + x);
                x = x.slice(0, -'_quantized'.length);
                const w = inits.get(mi.node.inputs[1]);
                if (!w || w.dims.length !== 2) throw new Error('權重初始值不是 2 維：' + mi.node.inputs[1]);
                targets.push({ layer: L, proj, x, y, din: w.dims[0], dout: w.dims[1], prod });
            }
        }
        const layout = makeLayout(targets, rank, align);
        // 4. 新增的節點與初始值本體
        const afterNode = new Map(); // 產生 y 的 entry → 要插入的節點本體
        const newInits = [];
        const renamed = new Map();
        targets.forEach((t, i) => {
            const tag = `lora.${t.layer}.${t.proj}`;
            const A = layout.tensors[i * 2], B = layout.tensors[i * 2 + 1];
            newInits.push(externalTensor(A.name, A.dims, A.offset, A.length), externalTensor(B.name, B.dims, B.offset, B.length));
            if (renamed.has(t.prod)) throw new Error('同一個節點產生兩個目標輸出：' + t.y);
            renamed.set(t.prod, [t.y, t.y + '_base']);
            // 診斷用（預設關閉，正式轉換不用）：旁支吃「DynamicQuantizeLinear 之後再反量化」的啟動值，模擬網頁版併權重時看到的量化輸入
            const lin = opts.dqLoraInput ? t.x + '.dqlora.' + tag : t.x;
            const dqNodes = opts.dqLoraInput ? [makeNode([t.x + '_quantized', t.x + '_scale', t.x + '_zero_point'], [lin], tag + '.dq', 'DequantizeLinear')] : [];
            afterNode.set(t.prod, [
                ...dqNodes,
                makeNode([lin, A.name], [tag + '.h'], tag + '.mmA', 'MatMul'),
                makeNode([tag + '.h', B.name], [tag + '.d'], tag + '.mmB', 'MatMul'),
                makeNode([t.y + '_base', tag + '.d'], [t.y], tag + '.add', 'Add'),
            ]);
        });
        // 5. 輸出：順序＝原 graph 欄位順序；新初始值接在最後一個初始值之後
        let lastInit = -1; entries.forEach((e, i) => { if (e.num === 5) lastInit = i; });
        if (lastInit < 0) lastInit = entries.length - 1;
        // 先算新 graph 長度
        let glen = 0;
        const nodeOut = new Map(); // entry → 改名後本體
        for (const [e, [y, yb]] of renamed) nodeOut.set(e, renameOutput(e.body, y, yb));
        const nodeField = (body) => { const h = concat([varintBytes(1 * 8 + 2), varintBytes(body.length)]); return [h, body]; };
        entries.forEach((e, i) => {
            if (nodeOut.has(e)) {
                const b = nodeOut.get(e); glen += 1 + varintBytes(b.length).length + b.length;
                for (const nb of afterNode.get(e)) glen += 1 + varintBytes(nb.length).length + nb.length;
            } else glen += e.fieldEnd - e.tagStart;
            if (i === lastInit) for (const tb of newInits) glen += 1 + varintBytes(tb.length).length + tb.length;
        });
        if (opts.outDir) {
            fs.mkdirSync(opts.outDir, { recursive: true });
            outFd = fs.openSync(path.join(opts.outDir, 'model_quantized.onnx.partial'), 'w');
        }
        const copy = (from, to) => {
            if (to <= from) return;
            if (src.copyTo) src.copyTo(from, to - from, sink); else sink.write(src.read(from, to - from));
        };
        copy(0, graph.tagStart);
        sink.write(concat([varintBytes(7 * 8 + 2), varintBytes(glen)]));
        const graphStartOut = outBytes;
        let runStart = graph.vs;
        const emitNew = (num, body) => { sink.write(concat([varintBytes(num * 8 + 2), varintBytes(body.length)])); sink.write(body); };
        entries.forEach((e, i) => {
            if (nodeOut.has(e)) {
                copy(runStart, e.tagStart);
                emitNew(1, nodeOut.get(e));
                for (const nb of afterNode.get(e)) emitNew(1, nb);
                runStart = e.fieldEnd;
            }
            if (i === lastInit) {
                copy(runStart, e.fieldEnd); runStart = e.fieldEnd;
                for (const tb of newInits) emitNew(5, tb);
            }
            if (i % 64 === 0) prog('write', e.tagStart, graph.ve);
        });
        copy(runStart, graph.ve);
        if (outBytes - graphStartOut !== glen) throw new Error('內部錯誤：graph 長度算錯 ' + (outBytes - graphStartOut) + ' vs ' + glen);
        copy(graph.ve, src.size);
        prog('write', src.size, src.size);
        if (outFd !== null) {
            fs.fsyncSync(outFd); fs.closeSync(outFd); outFd = null;
            fs.renameSync(path.join(opts.outDir, 'model_quantized.onnx.partial'), path.join(opts.outDir, 'model_quantized.onnx'));
            fs.writeFileSync(path.join(opts.outDir, 'layout.json'), JSON.stringify(layout));
            if (opts.writeZeroBin !== false) {
                const lfd = fs.openSync(path.join(opts.outDir, 'lora.bin'), 'w');
                try { fs.ftruncateSync(lfd, layout.total_bytes); } finally { fs.closeSync(lfd); } // 全零（稀疏延伸）
            }
        }
        tick();
        return { layout, targets: targets.length, outBytes, parts: outFd === null && !opts.outDir ? parts : undefined, ms: Date.now() - t0, peakRss };
    } finally {
        if (outFd !== null) { try { fs.closeSync(outFd); } catch (_) { /* */ } }
        src.close();
    }
}

module.exports = { buildSlotModel, makeLayout, PROJ };

// 命令列（給主行程以 ELECTRON_RUN_AS_NODE 開子行程用）：--cli <來源> <輸出資料夾> <rank>；每行一個 JSON：{progress:{done,total}} 或最後的 {result}
if (require.main === module && process.argv[2] === '--cli') {
    let last = 0;
    try {
        const r = buildSlotModel({ srcPath: process.argv[3], outDir: process.argv[4], rank: parseInt(process.argv[5], 10) || 16, onProgress: (p) => { const now = Date.now(); if (now - last > 300) { last = now; process.stdout.write(JSON.stringify({ progress: { done: p.done, total: p.total } }) + '\n'); } } });
        const ru = process.resourceUsage ? process.resourceUsage().maxRSS / 1024 : null;
        process.stdout.write(JSON.stringify({ result: { targets: r.targets, outBytes: r.outBytes, ms: r.ms, peakRssMB: ru } }) + '\n');
    } catch (e) { process.stderr.write(String((e && e.message) || e) + '\n'); process.exit(2); }
}
