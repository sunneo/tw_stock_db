// node renderer/src/studio/train_fallback.test.js
// 桌面版訓練「自動」模式：Python／GPU 後端都不能用，或啟動失敗 → 自動退到網頁處理器（頁內 WebAssembly），並把原因告訴使用者；指定後端時不亂換。
const Asset = require('./asset_core.js'), Storage = require('./storage_core.js');
const { createServer } = require('./studio_server_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
function mk(hostOps, web) {
  const storage = Storage.createStorage({ memory: Storage.createMemoryStore() }); const calls = [], webCalls = [];
  const h = { storage, desktop: true, now: () => 1000, prefsGet: () => ({}), prefsSet: () => {}, download: async () => {}, workDir: async () => '/ud/studio',
    call: async (op, p) => { calls.push(op); return hostOps[op] ? hostOps[op](p) : { ok: true }; },
    webTrain: web === null ? undefined : { probe: async () => ({ available: true, device: { name: 'wasm' } }), start: async (o) => { webCalls.push(o); return web && web.fail ? { ok: false, error: web.fail } : { ok: true, jobId: 'web-1' }; }, status: async () => ({ ok: true }) } };
  const srv = createServer(h); srv.setPush(() => {});
  const req = async (m, path, body) => { const r = await srv.route(m, new URL('http://m' + path), body); return { s: r.s || 200, j: r.j }; };
  return { req, calls, webCalls };
}
const body = { kind: 'lora', name: 'my-lora', backend: 'auto', cfg: { trainFile: 'C:\\data\\train.jsonl', steps: 5 } };
(async () => {
  // 1. 桌面版後端都不能用 → 自動退到網頁處理器
  let t = mk({ studio_probe: () => ({ ok: true, backends: [{ id: 'cpu-py', available: false, reason: '缺少套件：transformers、peft' }, { id: 'webgpu', available: false, reason: '尚未點亮' }] }), studio_train_start: () => ({ ok: true, jobId: 'host-1' }) });
  let r = await t.req('POST', '/api/train/start', body);
  check('後端都不能用：改走網頁處理器', r.j.ok !== false && r.j.web === true && r.j.fallback && r.j.fallback.to === 'wasm-web', r.j);
  check('回傳寫明原因（缺少套件）', /transformers/.test(r.j.fallback && r.j.fallback.reason));
  check('沒有去呼叫桌面版的 studio_train_start', t.calls.indexOf('studio_train_start') < 0);
  check('網頁訓練拿到本機 .jsonl 路徑當資料來源', t.webCalls[0] && /train\.jsonl/.test(t.webCalls[0].fromAsset) && t.webCalls[0].cfg.steps === 5);
  // 2. 桌面版看起來可用但啟動失敗 → 自動模式再試網頁處理器
  t = mk({ studio_probe: () => ({ ok: true, backends: [{ id: 'cpu-py', available: true, reason: '' }] }), studio_train_start: () => ({ ok: false, error: '找不到基底模型' }) });
  r = await t.req('POST', '/api/train/start', body);
  check('桌面版啟動失敗：自動退到網頁處理器並帶原因', r.j.web === true && /找不到基底模型/.test(r.j.fallback.reason), r.j);
  // 3. 使用者指定 cpu-py：不亂換，照實回錯
  t = mk({ studio_probe: () => ({ ok: true, backends: [{ id: 'cpu-py', available: false, reason: 'x' }] }), studio_train_start: () => ({ ok: false, error: '缺少套件' }) });
  r = await t.req('POST', '/api/train/start', Object.assign({}, body, { backend: 'cpu-py' }));
  check('指定 cpu-py：不退網頁處理器，回原本的錯誤', r.s === 409 && /缺少套件/.test(r.j.error) && t.webCalls.length === 0, r);
  // 4. 桌面版後端可用：照常走桌面版
  t = mk({ studio_probe: () => ({ ok: true, backends: [{ id: 'cpu-py', available: true, reason: '' }] }), studio_train_start: () => ({ ok: true, jobId: 'host-1' }) });
  r = await t.req('POST', '/api/train/start', body);
  check('桌面版後端可用：不退網頁處理器', r.j.jobId === 'host-1' && !r.j.fallback && t.webCalls.length === 0, r.j);
  // 5. 網頁處理器也起不來：兩個原因都講
  t = mk({ studio_probe: () => ({ ok: true, backends: [{ id: 'cpu-py', available: false, reason: '缺少套件' }] }) }, { fail: '找不到基底模型的瀏覽器快取' });
  r = await t.req('POST', '/api/train/start', body);
  check('兩邊都不行：訊息同時寫桌面版原因與網頁處理器原因', r.s === 409 && /缺少套件/.test(r.j.error) && /瀏覽器快取/.test(r.j.error), r);
  // 6. 沒有頁內宿主：照實回桌面版的錯誤
  t = mk({ studio_probe: () => ({ ok: true, backends: [{ id: 'cpu-py', available: false, reason: '缺少套件' }] }), studio_train_start: () => ({ ok: false, error: '缺少套件' }) }, null);
  r = await t.req('POST', '/api/train/start', body);
  check('沒有頁內宿主：回桌面版的錯誤', r.s === 409 && /缺少套件/.test(r.j.error), r);
  console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})();
