'use strict';
// 把 MOSS codec 整圖執行時，每一次共用卷積（conv_ops.conv1d）的真實輸入、權重、參數與 CPU 輸出存成二進位檔，
// 給真 Chrome 的 WebGPU 驗證頁（cudaweb_conv_gpu_check.js）當比對目標。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_conv_dump.js <MOSS 資料夾> <輸出資料夾> [T]
const fs = require('fs'), path = require('path');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const OI = require('../../renderer/src/gpu/onnx_interp.js');
const CONV = require('../../renderer/src/gpu/conv_ops.js');
const dir = process.argv[2], outDir = process.argv[3], T = Number(process.argv[4] || 4);
if (!dir || !outDir) { console.error('用法：... cudaweb_conv_dump.js <MOSS 資料夾> <輸出資料夾> [T]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const cases = [];
const origConv = CONV.conv1d;
// 攔截：記錄輸入與 CPU 輸出（不改結果）
CONV.conv1d = async function (x, N, C, L, w, M, Cg, K, b, p, ops) {
  const y = await origConv(x, N, C, L, w, M, Cg, K, b, p, { gpu: false });
  const id = cases.length;
  const save = (name, arr) => { const f = 'case' + id + '_' + name + '.bin'; fs.writeFileSync(path.join(outDir, f), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)); return f; };
  cases.push({
    id: id, N: N, C: C, L: L, M: M, Cg: Cg, K: K, hasB: !!b, p: { stride: p.stride || 1, pads: p.pads || [0, 0], dilation: p.dilation || 1, groups: p.groups || 1 },
    x: save('x', Float32Array.from(x)), w: save('w', Float32Array.from(w)), b: b ? save('b', Float32Array.from(b)) : null,
    y: save('y', Float32Array.from(y)), Lout: y.length / (N * M),
  });
  return y;
};

(async () => {
  const onnxPath = path.join(dir, 'moss_audio_tokenizer_decode_full.onnx');
  const buf = fs.readFileSync(onnxPath);
  const dataBuf = fs.readFileSync(path.join(dir, 'moss_audio_tokenizer_decode_shared.data'));
  const dataFiles = { 'moss_audio_tokenizer_decode_shared.data': new Uint8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length) };
  const model = lite.parseModel(buf);
  const codes = new Float64Array(T * 16);
  for (let t = 0; t < T; t++) for (let c = 0; c < 16; c++) codes[t * 16 + c] = (c * 37 + t * 101 + 5) % 1024;
  await OI.run(model, { audio_codes: { d: [1, T, 16], t: 'i', v: codes }, audio_code_lengths: { d: [1], t: 'i', v: Float64Array.from([T]) } }, dataFiles);
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ T: T, cases: cases }, null, 1));
  console.log('卷積案例數', cases.length, '寫入', outDir);
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
