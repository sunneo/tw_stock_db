// 通用 ONNX 張量執行（main-ext.js 的 NRT）單元測試：用假的 onnxruntime（放在暫存資料夾）驗證子程序協定、檔案傳輸、錯誤碼、逾時與崩潰。
// 不需要真的模型或執行包。用法：node tests/native/tensor_host.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { _NRT: NRT } = require('../../main-ext.js');

let ok = 0; const bad = [];
const check = (name, c, x) => { if (c) ok++; else { bad.push(name); console.log('FAIL', name, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nrt-test-'));
const ortDir = path.join(tmp, 'fake-ort'); fs.mkdirSync(ortDir);
// 假 ort：y = x 每個元素乘 2；dims[0]===999 睡 3 秒（測逾時）；dims[0]===777 直接結束行程（測崩潰）；路徑含 missing 載入失敗
fs.writeFileSync(path.join(ortDir, 'index.js'), `
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
const InferenceSession = { async create(p, o) {
  if (/missing/.test(p)) throw new Error('model file not found');
  return { inputNames: ['x'], outputNames: ['y', 'z'], opts: o, async run(feeds) {
    const x = feeds.x; if (x.dims[0] === 999) await new Promise((r) => setTimeout(r, 3000)); if (x.dims[0] === 777) process.exit(9);
    const y = new Float32Array(x.data.length); for (let i = 0; i < y.length; i++) y[i] = x.data[i] * 2;
    return { y: new Tensor('float32', y, x.dims), z: new Tensor('int64', BigInt64Array.from([BigInt(this.opts.intraOpNumThreads), 7n]), [2]) };
  } };
} };
module.exports = { Tensor, InferenceSession };
`);
const writeIn = (name, arr) => { const p = path.join(tmp, name); fs.writeFileSync(p, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)); return p; };

(async () => { const dbg = (s) => process.env.NRT_DBG && console.log(s);
  const host = NRT.createTensorHost({ ortDir, idleMs: 0 });
  // 1. 載入失敗：錯誤碼 load_failed，訊息帶原因
  let e1 = null; try { await host.load({ model_path: path.join(tmp, 'missing.onnx') }); } catch (e) { e1 = e; }
  check('載入不存在的模型：load_failed 並帶原因', e1 && e1.code === 'load_failed' && /not found/.test(e1.message), e1 && [e1.code, e1.message]);
  // 2. 載入成功：回輸入輸出名稱，threads 與圖形最佳化傳到子程序
  const m = await host.load({ model_path: path.join(tmp, 'ok.onnx'), threads: 3, graph_opt: 'disabled' });
  check('載入成功回輸入輸出名稱', JSON.stringify(m.input_names) === '["x"]' && JSON.stringify(m.output_names) === '["y","z"]', m);
  const again = await host.load({ model_path: path.join(tmp, 'ok.onnx') });
  check('同一個檔案再載入直接回傳（不重載）', again === m);
  // 3. 跑一次：輸入檔讀完即刪；輸出檔內容正確（手算：[1,2,3.5] × 2 = [2,4,7]）；int64 輸出的 dtype 與值
  const inp = writeIn('in0.bin', new Float32Array([1, 2, 3.5]));
  const r = await host.run({ inputs: [{ name: 'x', dtype: 'float32', dims: [3], path: inp }], out_dir: path.join(tmp, 'o1') });
  const y = fs.readFileSync(r.outputs[0].path), yf = new Float32Array(y.buffer, y.byteOffset, y.length / 4);
  check('輸出 y = 輸入 × 2', yf[0] === 2 && yf[1] === 4 && yf[2] === 7 && r.outputs[0].dtype === 'float32' && JSON.stringify(r.outputs[0].dims) === '[3]', Array.from(yf));
  const z = fs.readFileSync(r.outputs[1].path), zf = new BigInt64Array(z.buffer, z.byteOffset, z.length / 8);
  check('threads=3 有傳到子程序（z 的第一個值），int64 輸出', zf[0] === 3n && zf[1] === 7n && r.outputs[1].dtype === 'int64', Array.from(zf).map(String));
  check('輸入檔讀完即刪', !fs.existsSync(inp));
  // 4. 位元組數不符：bad_input，不載入壞資料；之後還能正常跑（子程序沒死）
  const inBad = writeIn('in1.bin', new Float32Array([1, 2]));
  let e2 = null; try { await host.run({ inputs: [{ name: 'x', dtype: 'float32', dims: [3], path: inBad }], out_dir: path.join(tmp, 'o2') }); } catch (e) { e2 = e; }
  check('位元組數不符：bad_input', e2 && e2.code === 'bad_input' && /位元組數不符/.test(e2.message), e2 && [e2.code, e2.message]);
  let e3 = null; try { await host.run({ inputs: [{ name: 'x', dtype: 'complex', dims: [1], path: inBad }], out_dir: path.join(tmp, 'o2') }); } catch (e) { e3 = e; }
  check('不支援的 dtype：bad_input', e3 && e3.code === 'bad_input', e3 && e3.code);
  const r2 = await host.run({ inputs: [{ name: 'x', dtype: 'float32', dims: [1], path: writeIn('in2.bin', new Float32Array([5])) }], out_dir: path.join(tmp, 'o3') });
  check('錯誤之後子程序仍可用', r2.outputs.length === 2);
  // 5. 逾時：強制結束子程序（code timeout），下一次呼叫自動重啟，但要重新載入
  let e4 = null; const t0 = Date.now();
  try { await host.run({ inputs: [{ name: 'x', dtype: 'float32', dims: [999], path: writeIn('in3.bin', new Float32Array(999)) }], out_dir: path.join(tmp, 'o4'), timeoutMs: 400 }); } catch (e) { e4 = e; }
  check('逾時：code timeout，且在逾時附近就回來（不等 3 秒）', e4 && e4.code === 'timeout' && Date.now() - t0 < 2000, e4 && [e4.code, Date.now() - t0]);
  check('逾時後子程序已被結束', !host.status().alive);
  await host.load({ model_path: path.join(tmp, 'ok.onnx') });
  const r3 = await host.run({ inputs: [{ name: 'x', dtype: 'float32', dims: [1], path: writeIn('in4.bin', new Float32Array([4])) }], out_dir: path.join(tmp, 'o5') });
  check('逾時後重新載入可再跑', r3.outputs.length === 2);
  // 6. 崩潰：code crashed，訊息有退出碼
  let e5 = null;
  try { await host.run({ inputs: [{ name: 'x', dtype: 'float32', dims: [777], path: writeIn('in5.bin', new Float32Array(777)) }], out_dir: path.join(tmp, 'o6') }); } catch (e) { e5 = e; }
  check('崩潰：code crashed 並帶退出碼 9', e5 && e5.code === 'crashed' && /退出碼 9/.test(e5.message), e5 && [e5.code, e5.message]);
  // 7. 沒有可載入的 ort：load_failed 並說明
  const h2 = NRT.createTensorHost({ ortDir: path.join(tmp, 'no-such-ort'), idleMs: 0 });
  let e6 = null; try { await h2.load({ model_path: 'x.onnx' }); } catch (e) { e6 = e; }
  check('找不到 onnxruntime-node：load_failed', e6 && e6.code === 'load_failed' && /onnxruntime-node/.test(e6.message), e6 && e6.message);
  // 8. dispose
  const h3 = NRT.createTensorHost({ ortDir, idleMs: 0 }); await h3.load({ model_path: path.join(tmp, 'ok.onnx') });
  check('載入後子程序存活', h3.status().alive); h3.dispose();
  check('dispose 後子程序結束', !h3.status().alive);
  // 9. 子程序原始碼自給自足：不含對主程序變數的引用（語法可單獨解析）
  check('子程序原始碼可獨立解析', (() => { try { new Function(NRT.childSource); return true; } catch (_) { return false; } })());
  host.dispose();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 暫存資料夾 */ }
  console.log(ok + ' 通過，' + bad.length + ' 失敗');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('測試程式錯誤', e); process.exit(2); });
