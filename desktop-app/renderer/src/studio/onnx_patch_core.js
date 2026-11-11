/* 網頁版 LoRA：最小的 ONNX（protobuf）讀寫器——只做「找節點／初始值」與「換掉某些初始值」，其他位元組原封不動複製（零拷貝切片）。
 *  純函式核心（UMD）：Node 與瀏覽器（含 Worker）都能載入。不依賴 onnx 套件。
 *  為什麼自己寫：網頁版要在載入 q8 模型前改權重與縮放值（DESIGN.TODO.offline-training-studio.md §14 路線 c），模型約 600 MB，只能在記憶體裡做位元組級修改。
 *  支援範圍（超出就丟明確錯誤，絕不靜默產生壞模型）：
 *   - 權重必須是 raw_data 內嵌（不是外部資料檔、不是 int32_data 之類的欄位）。
 *   - 被換掉的初始值不得同時出現在 graph.input（舊版 IR 把初始值也列為輸入，換形狀會對不上宣告）。
 *  API：
 *   indexModel(bytes) → {graph:{tagStart,start,end}, nodes:[{name,op,inputs,outputs}], inits:Map<name,{dataType,dims,rawStart,rawEnd,tagStart,start,end,external}>, graphInputs:Set, producers:Map<output,node>, consumers:Map<name,node[]>}
 *   encodeTensor({name,dataType,dims,raw}) → Uint8Array（TensorProto）
 *   rewrite(bytes, index, replacements:Map<initName,Uint8Array 新 TensorProto>) → {parts:Uint8Array[], length}
 *   concatParts(parts, length) → Uint8Array；toBlob(parts) → Blob */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaOnnxPatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const TD = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    const TE = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const DT = { FLOAT: 1, UINT8: 2, INT8: 3 };

    function readVarint(b, p) {
        let v = 0, mul = 1, i = 0;
        for (;;) {
            if (p >= b.length) throw new Error('protobuf 讀到檔尾（檔案不完整或不是 ONNX）');
            const c = b[p++];
            v += (c & 0x7f) * mul; mul *= 128; i++;
            if (!(c & 0x80)) return [v, p];
            if (i > 9) throw new Error('protobuf varint 過長');
        }
    }
    function varintBytes(v) {
        const out = [];
        while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
        out.push(v);
        return Uint8Array.from(out);
    }
    // 走訪 [p, end) 內的欄位。回呼 fn({num, wt, tagStart, vs, ve, val}) ；wt=2 時 [vs,ve) 是內容，wt=0 時 val 是數值
    function eachField(b, p, end, fn) {
        while (p < end) {
            const tagStart = p; let tag; [tag, p] = readVarint(b, p);
            const num = Math.floor(tag / 8), wt = tag % 8;
            if (wt === 0) { let val; [val, p] = readVarint(b, p); fn({ num, wt, tagStart, vs: p, ve: p, val, fieldEnd: p }); }
            else if (wt === 2) { let len; [len, p] = readVarint(b, p); if (p + len > end) throw new Error('protobuf 長度超出範圍'); fn({ num, wt, tagStart, vs: p, ve: p + len, fieldEnd: p + len }); p += len; }
            else if (wt === 1) { fn({ num, wt, tagStart, vs: p, ve: p + 8, fieldEnd: p + 8 }); p += 8; }
            else if (wt === 5) { fn({ num, wt, tagStart, vs: p, ve: p + 4, fieldEnd: p + 4 }); p += 4; }
            else throw new Error('protobuf 不支援的 wire type ' + wt);
        }
    }
    const str = (b, s, e) => TD.decode(b.subarray(s, e));

    function parseNode(b, s, e) {
        const n = { name: '', op: '', inputs: [], outputs: [] };
        eachField(b, s, e, (f) => {
            if (f.wt !== 2) return;
            if (f.num === 1) n.inputs.push(str(b, f.vs, f.ve));
            else if (f.num === 2) n.outputs.push(str(b, f.vs, f.ve));
            else if (f.num === 3) n.name = str(b, f.vs, f.ve);
            else if (f.num === 4) n.op = str(b, f.vs, f.ve);
        });
        return n;
    }
    function parseTensor(b, s, e, tagStart) {
        const t = { name: '', dataType: 0, dims: [], rawStart: -1, rawEnd: -1, external: false, otherData: false, tagStart, start: s, end: e };
        eachField(b, s, e, (f) => {
            if (f.num === 1) {
                if (f.wt === 0) t.dims.push(f.val);
                else if (f.wt === 2) { let p = f.vs; while (p < f.ve) { let v; [v, p] = readVarint(b, p); t.dims.push(v); } }
            } else if (f.num === 2 && f.wt === 0) t.dataType = f.val;
            else if (f.num === 8 && f.wt === 2) t.name = str(b, f.vs, f.ve);
            else if (f.num === 9 && f.wt === 2) { t.rawStart = f.vs; t.rawEnd = f.ve; }
            else if (f.num === 13) t.external = true;
            else if (f.num === 14 && f.wt === 0 && f.val === 1) t.external = true;
            else if ([4, 5, 6, 7, 10, 11].includes(f.num)) t.otherData = true;
        });
        return t;
    }
    function parseValueInfoName(b, s, e) { let name = ''; eachField(b, s, e, (f) => { if (f.num === 1 && f.wt === 2) name = str(b, f.vs, f.ve); }); return name; }

    function indexModel(bytes) {
        if (!(bytes instanceof Uint8Array)) throw new Error('indexModel 需要 Uint8Array');
        let graph = null;
        eachField(bytes, 0, bytes.length, (f) => { if (f.num === 7 && f.wt === 2) graph = { tagStart: f.tagStart, start: f.vs, end: f.ve }; });
        if (!graph) throw new Error('找不到 graph 欄位（不是 ONNX 模型檔）');
        const nodes = [], inits = new Map(), graphInputs = new Set(), producers = new Map(), consumers = new Map();
        eachField(bytes, graph.start, graph.end, (f) => {
            if (f.wt !== 2) return;
            if (f.num === 1) nodes.push(parseNode(bytes, f.vs, f.ve));
            else if (f.num === 5) { const t = parseTensor(bytes, f.vs, f.ve, f.tagStart); inits.set(t.name, t); }
            else if (f.num === 11) graphInputs.add(parseValueInfoName(bytes, f.vs, f.ve));
        });
        for (const n of nodes) {
            for (const o of n.outputs) producers.set(o, n);
            for (const i of n.inputs) { if (!consumers.has(i)) consumers.set(i, []); consumers.get(i).push(n); }
        }
        return { graph, nodes, inits, graphInputs, producers, consumers };
    }

    function encodeTensor(t) {
        const name = TE.encode(t.name), raw = t.raw;
        const dimsPayload = []; for (const d of t.dims) dimsPayload.push(...varintBytes(d));
        const parts = [];
        if (t.dims.length) parts.push(Uint8Array.from([0x0a]), varintBytes(dimsPayload.length), Uint8Array.from(dimsPayload)); // 1: dims（packed）
        parts.push(Uint8Array.from([0x10]), varintBytes(t.dataType));                                                            // 2: data_type
        parts.push(Uint8Array.from([0x42]), varintBytes(name.length), name);                                                      // 8: name
        parts.push(Uint8Array.from([0x4a]), varintBytes(raw.length), raw);                                                        // 9: raw_data
        return concat(parts);
    }
    function concat(arrs) {
        let n = 0; for (const a of arrs) n += a.length;
        const out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
        return out;
    }

    // 重寫整個模型：只有被換掉的初始值改變，其餘用 subarray 零拷貝切片串起來。
    function rewrite(bytes, index, replacements) {
        const g = index.graph;
        for (const name of replacements.keys()) {
            if (!index.inits.has(name)) throw new Error('要換的初始值不存在：' + name);
            if (index.graphInputs.has(name)) throw new Error('初始值 ' + name + ' 同時是 graph.input（舊版 IR），換形狀會與宣告不符，不支援');
        }
        const gparts = []; let runStart = g.start, glen = 0;
        const flush = (to) => { if (to > runStart) { gparts.push(bytes.subarray(runStart, to)); glen += to - runStart; } };
        const used = new Set();
        eachField(bytes, g.start, g.end, (f) => {
            if (f.num !== 5 || f.wt !== 2) return;
            const t = parseTensorNameOnly(bytes, f.vs, f.ve);
            const rep = replacements.get(t);
            if (!rep) return;
            if (used.has(t)) throw new Error('初始值重複出現：' + t);
            used.add(t);
            flush(f.tagStart);
            const head = concat([Uint8Array.from([0x2a]), varintBytes(rep.length)]); // graph 的第 5 欄 initializer
            gparts.push(head, rep); glen += head.length + rep.length;
            runStart = f.fieldEnd;
        });
        flush(g.end);
        for (const name of replacements.keys()) if (!used.has(name)) throw new Error('找不到要換的初始值：' + name);
        const ghead = concat([Uint8Array.from([0x3a]), varintBytes(glen)]); // model 的第 7 欄 graph
        const parts = [bytes.subarray(0, g.tagStart), ghead, ...gparts, bytes.subarray(g.end)];
        let length = 0; for (const p of parts) length += p.length;
        return { parts, length };
    }
    function parseTensorNameOnly(b, s, e) { let name = ''; eachField(b, s, e, (f) => { if (f.num === 8 && f.wt === 2) name = str(b, f.vs, f.ve); }); return name; }
    function concatParts(parts, length) {
        const out = new Uint8Array(length); let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }
    function toBlob(parts) { return new Blob(parts, { type: 'application/octet-stream' }); }

    return { indexModel, encodeTensor, rewrite, concatParts, toBlob, readVarint, varintBytes, eachField, DT };
});
