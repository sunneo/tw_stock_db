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

  // 快取模式（midigenai）：past_* 不送，只送 ids 與快取參數；位置 0 才是 reset
  const sk = await api.open({ id: 'm', file: 'm.onnx', bytes: 10 }, { kv: true });
  const mkKv = (P) => ({ ids: new N.Tensor('float32', new Float32Array([1, 2, 3]), [1, 3]), past_k0: new N.Tensor('float32', new Float32Array(P * 4), [1, P, 2, 2]), past_v0: new N.Tensor('float32', new Float32Array(P * 4), [1, P, 2, 2]) });
  await sk.run(mkKv(0)); const k0 = calls.filter((c) => c.op === 'onnx_run').pop().payload; await sk.run(mkKv(3)); const k1 = calls.filter((c) => c.op === 'onnx_run').pop().payload;
  check('快取模式：past_* 不送，只送 ids', k0.inputs.length === 1 && k0.inputs[0].name === 'ids' && k1.inputs.length === 1, k0.inputs.map((x) => x.name));
  check('快取模式：參數（名稱、h／d、位置、列數、reset）', JSON.stringify(k0.kv) === JSON.stringify({ past: ['past_k0', 'past_v0'], neu: ['new_k0', 'new_v0'], h: 2, d: 2, pos: 0, rows: 3, reset: true }) && k1.kv.pos === 3 && k1.kv.reset === false, k1.kv);
  const kn = calls.length; await s.run(mkKv(2)); check('沒開快取模式的 session 不帶 kv', calls.filter((c) => c.op === 'onnx_run').pop().payload.kv === undefined && calls.length > kn);
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
  // ---- 深度估計前後處理（手算期望值）----
  const D = N.depth, ts = (w, h) => JSON.stringify(D.targetSize(w, h));
  check('尺寸 640×480：縮放 518/480=1.0792（離 1 較近），寬 690.6→49×14=686、高 518（手算）', ts(640, 480) === '{"w":686,"h":518}', ts(640, 480));
  check('尺寸 518×518 不變', ts(518, 518) === '{"w":518,"h":518}');
  check('尺寸 1920×1080：縮放 518/1080=0.4796，寬 920.9→66×14=924（手算）', ts(1920, 1080) === '{"w":924,"h":518}', ts(1920, 1080));
  check('尺寸 100×100：放大到 518×518', ts(100, 100) === '{"w":518,"h":518}');
  const chw = D.toChw(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1); // 兩個像素：紅、綠
  const near = (a2, b, e) => Math.abs(a2 - b) < (e || 1e-4);
  check('正規化：紅色像素 R=(1-0.485)/0.229=2.2489、G=(0-0.456)/0.224=-2.0357、B=(0-0.406)/0.225=-1.8044（手算）', near(chw[0], 2.2489) && near(chw[2], -2.0357) && near(chw[4], -1.8044), Array.from(chw));
  check('正規化：排成 NCHW（先 R 平面、再 G、再 B）：綠色像素的 G=(1-0.456)/0.224=2.4286 在 G 平面第 2 個位置', near(chw[3], 2.4286), Array.from(chw));
  let seen = null; const fsess = { inputNames: ['pixel_values'], outputNames: ['predicted_depth'], async run(f) { seen = f.pixel_values; return { predicted_depth: new N.Tensor('float32', new Float32Array(seen.dims[2] * seen.dims[3]).fill(0.5), [1, seen.dims[2], seen.dims[3]]) }; } };
  let closed = false; const est = await D.estimate({}, fsess, { decode: async () => ({ width: 640, height: 480, close() { closed = true; } }), resize: (img, w, h) => new Uint8ClampedArray(w * h * 4).fill(128) });
  check('估計：輸入張量 [1,3,518,686]，輸出縮回原圖大小 640×480（網頁版 Worker 的約定）', seen.dims.join() === '1,3,518,686' && est.w === 640 && est.h === 480 && est.srcW === 640 && est.srcH === 480 && est.data.length === 640 * 480 && near(est.data[0], 0.5) && near(est.data[640 * 480 - 1], 0.5), est && [est.w, est.h]);
  // 雙線性縮放（手算）：2×2 [0,10;20,30] 放大到 4×4，半像素中心。第一列 x：fx=(x+.5)*.5-.5 = -0.25→夾 0、0.25、0.75、1.25→（x0=1,x1夾1）wx=.25...
  const up = D.resizeBilinear(Float32Array.from([0, 10, 20, 30]), 2, 2, 4, 4);
  check('雙線性放大 2×2→4×4：四個角保持原值 0、10、20、30，(1,1) 的位置是 (0.25,0.25) 加權：10×.75×.25+20×.25×.75+30×.25×.25＝7.5（手算）', up[0] === 0 && up[3] === 10 && up[12] === 20 && up[15] === 30 && near(up[5], 7.5, 1e-4), Array.from(up));
  check('縮放到同大小直接複製', D.resizeBilinear(Float32Array.from([1, 2, 3, 4]), 2, 2, 2, 2).join() === '1,2,3,4');
  check('估計：用完關閉解碼後的圖', closed === true);
  // installFromBlob：Blob 依序切片
  const { Blob } = require('buffer'); const blob = new Blob([Buffer.from([1, 2, 3, 4, 5, 6, 7])]);
  await api.installFromBlob({ id: 'm', file: 'm.onnx', bytes: 0 }, blob, { chunk: 3 });
  const ib = calls.filter((c) => c.op === 'onnx_install').pop().payload;
  check('Blob 安裝：7 位元組切 3 片，大小用實際值', JSON.stringify(ib.parts) === '["00000.part","00001.part","00002.part"]' && ib.bytes === 7, ib);
  // ---- 原生註冊表（部分原生）----
  const R = N.routed, flags = {}, get = (k) => (k in flags ? flags[k] : null);
  check('註冊表：已驗證的七個模型走原生', ['basic-pitch', 'yamnet', 'demucs-6s', 'depth-anything-v2-small', 'whisper-base-encoder', 'slimsam-encoder', 'sdxs-512-cpu-int8'].every((id) => R(id, get).native === true));
  check('註冊表外的模型（Whisper 原名、SlimSAM 原名、midigenai、Florence、未知 id）一律不走原生，並說明原因', ['whisper-base', 'sdxs-512-webgpu', 'slimsam-77', 'midigenai-v5-cpu', 'florence-2-base', 'nope', 'constructor', '__proto__'].every((id) => { const r = R(id, get); return r.native === false && /維持舊做法/.test(r.why); }));
  flags[N.switchKey('yamnet')] = '0';
  check('逐模型開關：關掉 YAMNet 只影響 YAMNet', R('yamnet', get).native === false && R('basic-pitch', get).native === true && /開關/.test(R('yamnet', get).why));
  check('讀開關丟例外或沒給讀取函式＝當沒設定（走原生）', R('basic-pitch', () => { throw new Error('x'); }).native === true && R('basic-pitch').native === true);
  console.log(ok + ' 通過，' + bad.length + ' 失敗'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('測試程式錯誤', e); process.exit(2); });
