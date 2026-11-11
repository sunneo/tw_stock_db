// 多個 LoRA adapter 同時套用：依 rank 串接合併（main-ext.js 的 NRL.mergeSlots／applySet、lora-train/lora_slots.py 的孿生）。
// 用小型假模型做數值實驗：各 adapter 單獨算 Σ w_k·x·A_k·B_k 與合併後單一 adapter 的 x·A·B 比較，誤差門檻 1e-5。
// 沒測到的（需要真槽版 ONNX 與 onnxruntime-node）：真模型下多 adapter 的輸出——見 DESIGN.TODO.native-runner.md §9.2。
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const root = path.join(__dirname, '..', '..');
const { _NRL: NRL } = require(path.join(root, 'main-ext.js'));
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };

// 假模型版面：3 層 × 2 個目標（q_proj、down_proj），in/out 各不同，rank 槽 R，位移 64 位元組對齊（與 make_lora_onnx.py 相同）
const R = 16, targets = [[12, 10], [9, 14], [12, 10], [9, 14], [12, 10], [9, 14]];
const layout = { rank: R, total_bytes: 0, tensors: [] };
{
    let off = 0;
    targets.forEach(([din, dout], i) => {
        for (const ab of ['A', 'B']) {
            const dims = ab === 'A' ? [din, R] : [R, dout]; const len = dims[0] * dims[1] * 4;
            layout.tensors.push({ name: 'lora.' + Math.floor(i / 2) + '.' + (i % 2 ? 'down_proj' : 'q_proj') + '.' + ab, dims, offset: off, length: len });
            off += Math.ceil(len / 64) * 64;
        }
    });
    layout.total_bytes = off;
}
// 建一個 rank r 的 adapter（只填前 r 個 rank 槽，其餘零，等同 make_lora_onnx.py pack 的輸出）
function mkAdapter(r) {
    const buf = Buffer.alloc(layout.total_bytes), f = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    for (const t of layout.tensors) {
        const [d0, d1] = t.dims, base = t.offset / 4;
        if (t.name.endsWith('.A')) { for (let i = 0; i < d0; i++) for (let j = 0; j < r; j++) f[base + i * d1 + j] = rnd(); }
        else { for (let i = 0; i < r; i++) for (let j = 0; j < d1; j++) f[base + i * d1 + j] = rnd(); }
    }
    return buf;
}
const F = (buf) => { const ab = new ArrayBuffer(buf.length); new Uint8Array(ab).set(buf); return new Float32Array(ab); };
// y = x·A·B（float64 累加），回每個目標的輸出向量
function forward(buf, x) {
    const f = F(buf), outs = [];
    for (let k = 0; k < targets.length; k++) {
        const [din, dout] = targets[k], tA = layout.tensors[2 * k], tB = layout.tensors[2 * k + 1], xs = x[k];
        const h = new Float64Array(R);
        for (let j = 0; j < R; j++) { let s = 0; for (let i = 0; i < din; i++) s += xs[i] * f[tA.offset / 4 + i * R + j]; h[j] = s; }
        const y = new Float64Array(dout);
        for (let o = 0; o < dout; o++) { let s = 0; for (let j = 0; j < R; j++) s += h[j] * f[tB.offset / 4 + j * dout + o]; y[o] = s; }
        outs.push(y);
    }
    return outs;
}
const xs = targets.map(([din]) => Float64Array.from({ length: din }, () => rnd() * 2));
const maxErr = (a, b) => { let m = 0; for (let k = 0; k < a.length; k++) for (let i = 0; i < a[k].length; i++) m = Math.max(m, Math.abs(a[k][i] - b[k][i])); return m; };

// ---------- 1 數值等價 ----------
const A1 = mkAdapter(4), A2 = mkAdapter(6), A3 = mkAdapter(5);
check('有效 rank 偵測', NRL.effectiveRank(A1, layout) === 4 && NRL.effectiveRank(A2, layout) === 6 && NRL.effectiveRank(Buffer.alloc(layout.total_bytes), layout) === 0);
const ws = [1, 0.5, 2];
const mr = NRL.mergeSlots(layout, [{ id: 'a1', buf: A1, weight: ws[0] }, { id: 'a2', buf: A2, weight: ws[1] }, { id: 'a3', buf: A3, weight: ws[2] }]);
check('合併：三個都套上、rank 4+6+5=15 ≤ 16、位移連續', mr.items.every((i) => i.applied) && mr.rankUsed === 15 && mr.items.map((i) => i.offset).join() === '0,4,10', mr.items);
const ys = [A1, A2, A3].map((b) => forward(b, xs));
const sum = ys[0].map((_, k) => Float64Array.from(ys[0][k], (_, i) => ws[0] * ys[0][k][i] + ws[1] * ys[1][k][i] + ws[2] * ys[2][k][i]));
const err = maxErr(sum, forward(mr.buf, xs));
console.log('數值實驗：三個 adapter（rank 4/6/5、權重 1/0.5/2）合併 vs 各自相加，最大絕對誤差 =', err.toExponential(3));
check('數值等價：誤差 < 1e-5', err < 1e-5, err);
const m1 = NRL.mergeSlots(layout, [{ id: 'a1', buf: A1 }]);
check('單一 adapter 權重 1：合併結果與原檔逐位元組相同', m1.buf.equals(A1));

// ---------- 2 容量：不足就拒絕並明說，不截斷 ----------
const B1 = mkAdapter(10), B2 = mkAdapter(8);
const mc = NRL.mergeSlots(layout, [{ id: 'b1', buf: B1 }, { id: 'b2', buf: B2 }]);
check('容量不足：第二個被拒，code=rank_capacity，訊息有槽／已用／需要', mc.items[0].applied && !mc.items[1].applied && mc.items[1].code === 'rank_capacity' && /槽 16.*已用 10.*需要 8/.test(mc.items[1].message), mc.items);
check('容量不足：沒有截斷（結果仍是 b1 原檔，沒有 b2 的任何一部分）', mc.buf.equals(B1) && mc.rankUsed === 10);
check('其他拒絕原因：全零、權重不合法、大小不符', (() => {
    const m = NRL.mergeSlots(layout, [{ id: 'z', buf: Buffer.alloc(layout.total_bytes) }, { id: 'w', buf: A1, weight: 0 }, { id: 'w2', buf: A1, weight: NaN }, { id: 's', buf: Buffer.alloc(8) }]);
    return m.items.map((i) => i.code).join() === 'empty_adapter,bad_weight,bad_weight,slot_mismatch';
})());

// ---------- 3 與 Python 孿生逐位元組相同（本機有 python＋numpy 才跑）----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-merge-'));
let py = null;
try { const r = cp.spawnSync('python', ['-c', 'import numpy'], { encoding: 'utf8', timeout: 20000 }); if (r.status === 0) py = 'python'; } catch (_) { /* */ }
if (py) {
    const lp = path.join(tmp, 'layout.json'); fs.writeFileSync(lp, JSON.stringify(layout));
    const files = [A1, A2, A3].map((b, i) => { const p = path.join(tmp, 'a' + i + '.bin'); fs.writeFileSync(p, b); return p; });
    const out = path.join(tmp, 'out.bin');
    const r = cp.spawnSync(py, [path.join(root, 'lora-train', 'lora_slots.py'), lp, out, files[0] + ':1', files[1] + ':0.5', files[2] + ':2'], { encoding: 'utf8', timeout: 60000 });
    check('Python lora_slots.py 與 JS mergeSlots 輸出逐位元組相同', r.status === 0 && fs.readFileSync(out).equals(mr.buf), { status: r.status, e: (r.stderr || '').slice(0, 300) });
    const files2 = [B1, B2].map((b, i) => { const p = path.join(tmp, 'b' + i + '.bin'); fs.writeFileSync(p, b); return p; });
    const r2 = cp.spawnSync(py, [path.join(root, 'lora-train', 'lora_slots.py'), lp, out, files2[0], files2[1]], { encoding: 'utf8', timeout: 60000 });
    let rep = {}; try { rep = JSON.parse((r2.stdout || '{}').trim()); } catch (_) { /* */ }
    check('Python：容量不足同樣拒絕第二個', r2.status === 0 && rep.items && rep.items[1].code === 'rank_capacity' && fs.readFileSync(out).equals(B1), r2.stdout);
} else console.log('略過 Python 對照（本機沒有 python＋numpy）');

// ---------- 4 NRL.applySet 全流程 ----------
const ud = path.join(tmp, 'ud'), box = path.join(ud, 'box'), modelDir = path.join(tmp, 'model');
fs.mkdirSync(modelDir, { recursive: true }); fs.mkdirSync(box, { recursive: true });
fs.writeFileSync(path.join(modelDir, 'layout.json'), JSON.stringify(layout));
const runtime = { ok: true, version: '1.22.0-2', features: ['lora'] };
const nrl = NRL.create({ fs, path, crypto, userData: ud, box, getRuntime: () => runtime, getModelPath: () => path.join(modelDir, 'model_quantized.onnx') });
const put = (id, b) => { const d = path.join(box, 'lora-in', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'lora.bin'), b); };
const it = (id, b, w) => ({ id, sha256: sha(b), size: b.length, weight: w });
put('a1', A1); put('a2', A2); put('a3', A3);
let r = nrl.applySet({ items: [it('a1', A1, 1), it('a2', A2, 0.5), it('a3', A3, 2)] });
check('applySet：三個都套上，逐項 applied、id 是 merged-、檔案與 mergeSlots 一致', r.ok && r.items.every((x) => x.applied) && /^merged-[0-9a-f]{12}$/.test(r.id) && r.rankUsed === 15 && fs.readFileSync(nrl._active().path).equals(mr.buf) && nrl._active().sha256 === sha(mr.buf), r);
check('applySet：信箱檔已清', !fs.existsSync(path.join(box, 'lora-in', 'a1')));
const fr = nrl.forRun();
check('applySet：run 前置帶合併檔，verifyDone 認 merged id', fr.ok && fr.lora.id === r.id && nrl.verifyDone({ lora_applied: r.id, lora_sha256: sha(mr.buf) }) === null && (nrl.verifyDone({ lora_applied: 'a1' }) || {}).code === 'lora_not_applied');
check('status 列出各 adapter 與 rank', nrl.status().adapters.map((x) => x.id + ':' + x.rank).join() === 'a1:4,a2:6,a3:5', nrl.status());
put('b1', B1); put('b2', B2);
r = nrl.applySet({ items: [it('b1', B1, 1), it('b2', B2, 1)] });
check('applySet：容量不足 → b2 被拒（rank_capacity、訊息具體），b1 以原檔套用（id 不是 merged）', r.ok && r.items[0].applied && !r.items[1].applied && r.items[1].code === 'rank_capacity' && r.id === 'b1' && /沒套上/.test(r.note), r);
check('applySet：換整組後舊的合併檔與舊 adapter 目錄已清', !fs.existsSync(path.join(ud, 'native-lora', '_merged')) && fs.readdirSync(path.join(ud, 'native-lora')).join() === 'b1');
put('c1', A1);
const before = nrl._active().id;
r = nrl.applySet({ items: [{ id: 'c1', sha256: 'f'.repeat(64), size: A1.length }, { id: 'nofile', sha256: sha(A1) }] });
check('applySet：全部失敗 → ok:false、逐項原因、原狀態不變', !r.ok && r.code === 'verify_failed' && r.items.length === 2 && r.items[1].code === 'no_file' && nrl._active().id === before, r);
put('a1', A1);
r = nrl.applySet({ items: [it('a1', A1, 0.5)] });
const half = NRL.mergeSlots(layout, [{ id: 'a1', buf: A1, weight: 0.5 }]);
check('applySet：單一 adapter 權重 0.5 → 合併檔（B 乘 0.5）', r.ok && /^merged-/.test(r.id) && fs.readFileSync(nrl._active().path).equals(half.buf), r);
put('d1', A1);
r = nrl.applySet({ items: [it('d1', A1, 1), it('d1', A1, 1)] });
check('applySet：同批重複 id 第二個被拒（duplicate_id）', r.ok && r.items.length === 2 && r.items.some((x) => x.code === 'duplicate_id') && r.items.some((x) => x.applied), r);
check('applySet：空清單 bad_request', nrl.applySet({ items: [] }).code === 'bad_request');
check('applySet：超過上限 bad_request', nrl.applySet({ items: Array.from({ length: NRL.MAX_SET + 1 }, (_, i) => ({ id: 'x' + i })) }).code === 'bad_request');
runtime.features = [];
check('applySet：執行包太舊回 runtime_outdated', nrl.applySet({ items: [it('a1', A1, 1)] }).code === 'runtime_outdated');
runtime.features = ['lora'];
r = nrl.clear();
check('clear：全部清掉、forRun 無 lora', r.ok && nrl.forRun().lora === null && fs.readdirSync(path.join(ud, 'native-lora')).length === 0, r);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad.length ? 'native_lora_merge.test.js：通過 ' + ok + ' 項，失敗 ' + bad.length + ' 項：' + bad.join('；') : 'native_lora_merge.test.js：通過 ' + ok + ' 項');
process.exit(bad.length ? 1 : 0);
