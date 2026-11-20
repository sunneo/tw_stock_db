// node renderer/src/gpu/cl_host_stdio.js — 把 FaClHostOps 接到標準輸入輸出，給「一般 Python（CPython）」測試 pyopencl._cl 用。
// 不是產品路徑：產品裡 Python 在 Pyodide，走 `_fa_opencl.call`。這個程式讓同一份 `_cl.py` 能在沒有 Pyodide 的環境對真的載入器做端到端測試。
// 框架：每則訊息＝ 4 位元組小端長度 H ＋ 4 位元組小端長度 D ＋ H 位元組 JSON ＋ D 位元組資料。請求 JSON：{ id, op, args }；回應 JSON：{ id, result }。
const ICD = require('./cl_icd.js'), K = require('./kir.js'), F = require('./cl_front.js'), OPS = require('./cl_host_ops.js');
const loader = ICD.createLoader();
// FA_CL_DRIVERS＝以逗號分隔、依序登記的驅動（clc＝OpenCL C 前端的 CPU 驅動，kir＝KIR 驅動）；預設只有 kir。create_some_context 會選第一個。
const CLC = require('./clc_js.js');
for (const d of String(process.env.FA_CL_DRIVERS || 'kir').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (d === 'kir') loader.registerDriver(ICD.makeKirDriver({ mods: { FaClFront: F, FaKir: K }, name: 'fa-kir-js', kind: 'js', deviceName: 'FA KIR JS（CPU 參考）' }));
    else if (d === 'clc') loader.registerDriver(ICD.makeClcDriver({ mods: { FaClc: CLC } }));
    else throw new Error('不認得的驅動 ' + d);
}
const host = OPS.create(loader);

let buf = Buffer.alloc(0), busy = Promise.resolve();
const send = (obj, data) => {
    const h = Buffer.from(JSON.stringify(obj), 'utf8'), d = data ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.alloc(0), head = Buffer.alloc(8);
    head.writeUInt32LE(h.length, 0); head.writeUInt32LE(d.length, 4); process.stdout.write(Buffer.concat([head, h, d]));
};
function pump() {
    for (;;) {
        if (buf.length < 8) return; const hl = buf.readUInt32LE(0), dl = buf.readUInt32LE(4); if (buf.length < 8 + hl + dl) return;
        const req = JSON.parse(buf.subarray(8, 8 + hl).toString('utf8')), data = dl ? new Uint8Array(buf.subarray(8 + hl, 8 + hl + dl)) : null; buf = buf.subarray(8 + hl + dl);
        if (req.op === 'exit') process.exit(0);
        busy = busy.then(async () => { const r = await host.call(req.op, req.args, data); send({ id: req.id, result: r.result }, r.data); });   // 依序處理（in-order）
    }
}
process.stdin.on('data', (c) => { buf = Buffer.concat([buf, c]); pump(); });
process.stdin.on('end', () => busy.then(() => process.exit(0)));
