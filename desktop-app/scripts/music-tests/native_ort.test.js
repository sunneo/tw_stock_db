// 原生 ONNX 工作階段包裝（renderer/src/music/native_ort.js）單元測試：用假的信箱橋接（記憶體檔案系統＋手算結果的假執行）。用法：node scripts/music-tests/native_ort.test.js
'use strict';
const N = require('../../renderer/src/music/native_ort.js');
let ok = 0; const bad = [];
const check = (name, c, x) => { if (c) ok++; else { bad.push(name); console.log('FAIL', name, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

const files = new Map(); const calls = [];
const rawfs = {
  async writeFile(p, o) { files.set(p, Buffer.from(o.base64, 'base64')); },
  async readFile(p, enc) { if (!files.has(p)) throw new Error('ENOENT ' + p); return { path: p, base64: files.get(p).toString('base64') }; },
  async remove(p, rec) { for (const k of Array.from(files.keys())) if (k === p || (rec && k.startsWith(p + '/'))) files.delete(k); },
};
let failRun = false, runCount = 0, lastRunMode = '';
// 假主程序：onnx_run 把每個 float32 輸入乘 2 當輸出 y（手算：[1,2] → [2,4]），並回一個 int64 輸出
async function call(op, payload, timeoutMs) {
  calls.push({ op, payload, timeoutMs });
  if (op === 'onnx_status') return { ok: true, installed: payload.id === 'have' };
  if (op === 'onnx_install') { const total = payload.parts.reduce((a, n) => a + files.get('/box/models-in/' + payload.id + '/' + n).length, 0); return total === payload.bytes ? { ok: true } : { ok: false, code: 'verify_failed', message: '大小不符 ' + total }; }
  if (op === 'onnx_load') return payload.id === 'broken' ? { ok: false, code: 'load_failed', message: '壞檔' } : { ok: true, input_names: ['x'], output_names: ['y', 'n'], ms: 5 };
  if (op === 'onnx_run') {
    runCount++; if (failRun) return { ok: false, code: 'crashed', message: '子程序意外結束' };
    const inp = payload.inputs[0], b = inp.b64 !== undefined ? Buffer.from(inp.b64, 'base64') : files.get('/box/' + payload.dir + '/' + inp.file), x = new Float32Array(b.buffer, b.byteOffset, b.length / 4), y = Float32Array.from(x, (v) => v * 2);
    lastRunMode = inp.b64 !== undefined ? 'inline' : 'file';
    const o0 = Buffer.from(y.buffer), o1 = Buffer.from(BigInt64Array.from([42n]).buffer);
    if (payload.inline_out) return { ok: true, ms: 3, outputs: [{ name: 'y', dtype: 'float32', dims: inp.dims, bytes: o0.length, b64: o0.toString('base64') }, { name: 'n', dtype: 'int64', dims: [1], bytes: 8, b64: o1.toString('base64') }] };
    files.set('/box/' + payload.dir + '/out-0.bin', o0); files.set('/box/' + payload.dir + '/out-1.bin', o1);
    return { ok: true, ms: 3, outputs: [{ name: 'y', dtype: 'float32', dims: inp.dims, file: 'out-0.bin', bytes: o0.length }, { name: 'n', dtype: 'int64', dims: [1], file: 'out-1.bin', bytes: 8 }] };
  }
  if (op === 'onnx_release') return { ok: true };
  return { ok: false, code: 'bad_op' };
}
(async () => {
  const api = N.create({ call, rawfs, box: '/box', sep: '/', uid: (() => { let i = 0; return () => 'u' + (++i); })() });
  // 狀態
  check('status：已安裝', (await api.state({ id: 'have', file: 'a.onnx', bytes: 1 })).installed === true);
  check('status：沒安裝', (await api.state({ id: 'none', file: 'a.onnx', bytes: 1 })).installed === false);
  // 從商店分片安裝：3 片（chunk=4）共 10 位元組；分片依序寫到信箱、清單用 5 位數序號
  const store = new Map([['k0', Buffer.from([1, 2, 3, 4])], ['k1', Buffer.from([5, 6, 7, 8])], ['k2', Buffer.from([9, 10])]]);
  const st = { get: async (k) => store.get(k) && new Uint8Array(store.get(k)) };
  await api.installFromStore({ id: 'm', file: 'm.onnx', bytes: 10, sha256: 'abc' }, { store: st, keyOf: (i) => 'k' + i, chunk: 4 });
  const inst = calls.filter((c) => c.op === 'onnx_install')[0];
  check('安裝：分片名稱依序、帶大小與 SHA-256', JSON.stringify(inst.payload.parts) === '["00000.part","00001.part","00002.part"]' && inst.payload.bytes === 10 && inst.payload.sha256 === 'abc', inst.payload);
  let e1 = null; try { await api.installFromStore({ id: 'm', file: 'm.onnx', bytes: 11 }, { store: st, keyOf: (i) => 'k' + i, chunk: 4 }); } catch (e) { e1 = e; }
  check('分片不完整就丟錯（不送給主程序假裝成功）', e1 && /不完整/.test(e1.message), e1 && e1.message);
  // 載入與執行
  const s = await api.open({ id: 'm', file: 'm.onnx', bytes: 10 }, { threads: 3, graphOpt: 'disabled' });
  const ld = calls.filter((c) => c.op === 'onnx_load')[0].payload;
  check('載入：threads 與圖形最佳化有傳', ld.threads === 3 && ld.graph_opt === 'disabled', ld);
  check('session 介面：inputNames、outputNames、backend', s.inputNames[0] === 'x' && s.outputNames.length === 2 && s.backend === 'native');
  const out = await s.run({ x: new N.Tensor('float32', new Float32Array([1, 2]), [1, 2]) });
  check('執行：y = x × 2（手算 [2,4]），dims 保留', out.y.data[0] === 2 && out.y.data[1] === 4 && out.y.dims.join() === '1,2' && out.y.type === 'float32', out.y);
  check('執行：int64 輸出還原成 BigInt64Array', out.n.data instanceof BigInt64Array && out.n.data[0] === 42n);
  
  check('小張量走內嵌（不經檔案）', lastRunMode === 'inline');
  const bigIn = new Float32Array(1600000).fill(1.5); const ob = await s.run({ x: new N.Tensor('float32', bigIn, [1600000]) });
  check('大張量（>6 MB）走檔案，結果正確', lastRunMode === 'file' && ob.y.data.length === 1600000 && ob.y.data[0] === 3 && ob.y.data[1599999] === 3);
  check('大張量的暫存資料夾也刪掉', Array.from(files.keys()).filter((k) => k.startsWith('/box/t-')).length === 0);
  // subarray 輸入（byteOffset 不為 0）要只送自己那一段
  const big = new Float32Array([9, 9, 3, 5, 9]); const o2 = await s.run({ x: new N.Tensor('float32', big.subarray(2, 4), [2]) });
  check('subarray 輸入只送自己的範圍（[3,5]→[6,10]）', o2.y.data[0] === 6 && o2.y.data[1] === 10 && o2.y.data.length === 2, Array.from(o2.y.data));
  let e2 = null; try { await s.run({ x: new N.Tensor('float32', [1, 2], [2]) }); } catch (e) { e2 = e; }
  check('輸入不是對應的 TypedArray 就丟錯', e2 && /不支援|不符/.test(e2.message), e2 && e2.message);
  // 載入失敗：錯誤碼與訊息帶出來
  let e3 = null; try { await api.open({ id: 'broken', file: 'b.onnx', bytes: 1 }); } catch (e) { e3 = e; }
  check('載入失敗：code 與原因', e3 && e3.code === 'load_failed' && /壞檔/.test(e3.message), e3 && [e3.code, e3.message]);
  // 退回：原生 run 失敗 → 切到網頁版，記下原因，之後不再回頭；結果格式不變
  let events = [], fbMade = 0, fbRuns = 0;
  const fbFactory = async () => { fbMade++; return { ort: { Tensor: class { constructor(t, d, dm) { this.type = t; this.data = d; this.dims = dm; } } }, session: { async run(f) { fbRuns++; const x = f.x.data; return { y: { data: Float32Array.from(x, (v) => v * 2), dims: f.x.dims }, n: { data: BigInt64Array.from([42n]), dims: [1] } }; } } }; };
  const nat2 = await api.open({ id: 'm', file: 'm.onnx', bytes: 10 });
  const h = N.withFallback(nat2, fbFactory, (ev) => events.push(ev));
  const a1 = await h.run({ x: new N.Tensor('float32', new Float32Array([1, 2]), [2]) });
  check('正常時走原生、不建網頁版', h.backend === 'native' && fbMade === 0 && a1.y.data[1] === 4);
  failRun = true;
  const a2 = await h.run({ x: new N.Tensor('float32', new Float32Array([1, 2]), [2]) });
  check('原生失敗：退回網頁版，結果仍正確', h.backend === 'wasm' && a2.y.data[1] === 4 && fbMade === 1 && fbRuns === 1, [h.backend, fbMade]);
  check('退回事件帶真實原因', events.length === 1 && events[0].type === 'fallback' && /意外結束/.test(events[0].reason) && /意外結束/.test(h.lastError), events);
  failRun = false; const before = runCount; await h.run({ x: new N.Tensor('float32', new Float32Array([3]), [1]) });
  check('切到退路後不再回頭問原生', runCount === before && fbRuns === 2 && fbMade === 1);
  // 退路也失敗：訊息同時有兩個原因
  const nat3 = await api.open({ id: 'm', file: 'm.onnx', bytes: 10 }); failRun = true;
  const h2 = N.withFallback(nat3, async () => { throw new Error('CDN 連不上'); });
  let e4 = null; try { await h2.run({ x: new N.Tensor('float32', new Float32Array([1]), [1]) }); } catch (e) { e4 = e; }
  check('兩邊都失敗：訊息含原生與退路兩個原因', e4 && /意外結束/.test(e4.message) && /CDN 連不上/.test(e4.message), e4 && e4.message);
  console.log(ok + ' 通過，' + bad.length + ' 失敗'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('測試程式錯誤', e); process.exit(2); });
