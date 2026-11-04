// loadOrt:proxy 開/關兩種模式各拿獨立的 ort 實例,誰先載入都不會改到對方的 env.wasm.proxy(2026-11-03 回歸:第 276/277 版 worker not ready)
const R = require('../../renderer/src/music/audio_runtime.js');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
(async () => {
  // 假的 import:同一個網址永遠回同一個實例(和瀏覽器一樣),不同網址(含查詢字串)回不同實例
  const made = {}; const calls = []; const importFn = async (u) => { calls.push(u); return made[u] || (made[u] = { url: u, env: { wasm: {} } }); };
  const opt = (proxy) => ({ importFn, proxy });

  const gpu1 = await R.loadOrt(opt(false)); const cpu1 = await R.loadOrt(opt(true));
  check('proxy=false 與 proxy=true 是不同的實例', gpu1 !== cpu1 && gpu1.url !== cpu1.url, [gpu1.url, cpu1.url]);
  check('midigenai(false)先、音訊(true)後:各自的 proxy 沒被對方改掉', gpu1.env.wasm.proxy === false && cpu1.env.wasm.proxy === true, [gpu1.env.wasm.proxy, cpu1.env.wasm.proxy]);
  // 反過來再載一次,以及重複載入:實例要快取(不重複 import),proxy 仍維持
  const cpu2 = await R.loadOrt(opt(true)); const gpu2 = await R.loadOrt(opt(false));
  check('重複載入取同一個實例、不重複 import', cpu2 === cpu1 && gpu2 === gpu1 && calls.length === 2, calls);
  check('重複載入後兩邊 proxy 仍各自不變', gpu1.env.wasm.proxy === false && cpu1.env.wasm.proxy === true);
  check('proxy 預設(沒指定)是開', (await R.loadOrt({ importFn })).env.wasm.proxy === true);
  check('wasmPaths 兩個實例都設了', !!gpu1.env.wasm.wasmPaths && !!cpu1.env.wasm.wasmPaths && gpu1.env.wasm.numThreads >= 1);
  // 階段 1（原生執行器）：SharedArrayBuffer 能傳給 Worker 時就多執行緒，不要求 crossOriginIsolated（桌面版實測：頁面 crossOriginIsolated 為 false 仍可多執行緒）
  check('SAB 可用時 numThreads > 1（不要求 crossOriginIsolated）', cpu1.env.wasm.numThreads > 1, cpu1.env.wasm.numThreads);

  // 相反順序(全新的快取要用新的 URL 才能模擬,所以換 ortUrl)
  const importFn2 = async (u) => made[u] || (made[u] = { url: u, env: { wasm: {} } });
  const c = await R.loadOrt({ importFn: importFn2, ortUrl: 'https://x/ort2.mjs', proxy: true }); const g = await R.loadOrt({ importFn: importFn2, ortUrl: 'https://x/ort2.mjs', proxy: false });
  check('音訊(true)先、midigenai(false)後:兩個實例 proxy 各自不變', c !== g && c.env.wasm.proxy === true && g.env.wasm.proxy === false && g.url === 'https://x/ort2.mjs?np=1', [c.url, g.url]);
  // 網址本身已有查詢字串時用 & 接
  const q = await R.loadOrt({ importFn: importFn2, ortUrl: 'https://x/ort3.mjs?v=1', proxy: false }); check('網址已有查詢字串時用 & 接 np=1', q.url === 'https://x/ort3.mjs?v=1&np=1', q.url);
  // import 失敗不能把失敗的承諾永遠快取住
  let n = 0; const flaky = async (u) => { if (n++ === 0) throw new Error('net'); return { url: u, env: { wasm: {} } }; };
  let failed = false; try { await R.loadOrt({ importFn: flaky, ortUrl: 'https://x/ort4.mjs' }); } catch (_) { failed = true; } const ok4 = await R.loadOrt({ importFn: flaky, ortUrl: 'https://x/ort4.mjs' });
  check('import 失敗後下次會重試、不快取失敗', failed && ok4 && ok4.env.wasm.proxy === true);
  // 傳進來的 ort 直接用(舊行為)
  const mine = { env: { wasm: {} } }; check('opts.ort 直接使用', (await R.loadOrt({ ort: mine, proxy: false })) === mine && mine.env.wasm.proxy === false);

  // createSession:多種執行方式時每次給副本(proxy 模式會轉移緩衝),第一種失敗後第二種仍拿得到完整資料
  { const seen = []; const fakeOrt = { InferenceSession: { create: async (b, o) => { seen.push({ len: b.byteLength, same: b === orig, ep: o.executionProviders[0] }); if (o.executionProviders[0] === 'webgpu') { b.buffer.transfer ? b.buffer.transfer() : 0; throw new Error('gpu fail'); } return { ok: 1 }; } } }; const orig = new Uint8Array(16); global.navigator = { gpu: {} };
    const r = await R.createSession(fakeOrt, orig, ['webgpu', 'wasm']); check('createSession:第一種失敗(緩衝被轉移)後第二種仍有完整資料、且不是原緩衝', r.ep === 'wasm' && seen.length === 2 && seen.every((x) => x.len === 16 && !x.same) && orig.byteLength === 16, seen);
    seen.length = 0; await R.createSession(fakeOrt, orig, ['wasm']); check('createSession:只有一種執行方式時不複製(省記憶體)', seen.length === 1 && seen[0].same, seen); delete global.navigator; }
  console.log('audio_runtime: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
