'use strict';
// Studio 假伺服器路由測試：資產列表／匯出／匯入（先確認再合併）／trainer 往返／版面偏好／後端與訓練的轉呼叫／網頁版誠實回報
const Asset = require('./asset_core.js'), Storage = require('./storage_core.js'), Fatrain = require('./fatrain_core.js'), Trainer = require('./trainer_adapter.js');
const { createServer } = require('./studio_server_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const enc = (s) => new TextEncoder().encode(s);
function mk(desktop, hostOps) {
  const storage = Storage.createStorage({ memory: Storage.createMemoryStore() });
  let prefs = {}, downloads = [], picked = null, calls = [], otImported = null;
  const bundle = { format: 'fa-offline-trainer', version: 2, exported_at: '2026-11-11T00:00:00Z', summary: 's', payload: { domains: [{ id: 'd1' }], solutions: [{ q: 1 }], synonyms: {} } };
  bundle.checksum = Trainer.bundleHash(JSON.stringify(bundle.payload));
  const h = { storage, desktop, now: () => 1000, prefsGet: () => prefs, prefsSet: (p) => { prefs = p; }, download: async (n, b) => { downloads.push({ n, b }); }, pickFile: async () => picked,
    call: async (op, p) => { calls.push([op, p]); return hostOps && hostOps[op] ? hostOps[op](p) : { ok: true }; }, workDir: async () => '/ud/studio', otExport: async () => bundle, otImport: async (b, o) => { otImported = { b, o }; return { ok: true, dry: o.dry_run }; } };
  const srv = createServer(h); const pushes = []; srv.setPush((o) => pushes.push(o));
  const req = async (m, path, body) => { const r = await srv.route(m, new URL('http://mock.local' + path), body); return { s: r.s || 200, j: r.j }; };
  return { srv, req, storage, downloads, setPicked: (f) => { picked = f; }, calls, pushes, prefs: () => prefs, otImported: () => otImported };
}
(async () => {
  const t = mk(true, { studio_probe: () => ({ ok: true, backends: [{ id: 'cpu-py', available: false, reason: '找不到 Python' }] }), studio_select: () => ({ ok: false, chosen: null, reason: '沒有可用的後端' }), studio_train_start: (p) => (p.cfg.trainFile === 'bad' ? { ok: false, error: 'cpu-py 不可用：x' } : { ok: true, jobId: 'train1' }) });
  let r = await t.req('GET', '/api/info'); check('info', r.j.ok && r.j.desktop && r.j.tabs.length === 6 && r.j.workDir === '/ud/studio', r.j);
  check('info 回報 fap 沒授權（資料只在記憶體）', r.j.storage.ok === false && /記憶體/.test(r.j.storage.message), r.j.storage);
  // 版面偏好
  r = await t.req('GET', '/api/prefs'); check('預設版面', r.j.layout.panes.left[0] === 'assets');
  r = await t.req('POST', '/api/prefs', { layout: { panes: { left: ['train'], right: ['assets'] }, split: 0.9 } }); check('偏好存起來並正規化', r.j.layout.split === 0.8 && r.j.layout.panes.left[0] === 'train' && t.prefs().layout.split === 0.8, r.j);
  r = await t.req('POST', '/api/prefs', { reset: true }); check('還原版面', r.j.layout.split === 0.45 && r.j.layout.panes.left.length === 3);
  // trainer 往返
  r = await t.req('POST', '/api/trainer/snapshot', { name: 'my-trainer' }); check('快照存成資產', r.j.ok && r.j.name === 'my-trainer', r.j);
  r = await t.req('POST', '/api/trainer/snapshot', { name: 'my-trainer' }); check('同名不覆蓋', r.s === 409);
  r = await t.req('POST', '/api/trainer/snapshot', { name: '../x' }); check('不合法名稱被拒', r.s === 400);
  r = await t.req('GET', '/api/assets'); const tg = r.j.groups.find((g) => g.kind === 'trainer');
  check('資產清單依 kind 分組，標為「我的」', r.j.groups.length === 6 && tg.items.length === 1 && tg.items[0].origin === 'mine', r.j.groups);
  r = await t.req('GET', '/api/asset?kind=trainer&name=my-trainer'); check('資產詳情含驗證', r.j.verify.ok && r.j.files.some((f) => f.path === 'weights/domains.json'), r.j);
  r = await t.req('GET', '/api/asset-file?kind=trainer&name=my-trainer&path=data%2Fsolutions.json'); check('檔案預覽', r.j.text === '[{"q":1}]', r.j);
  r = await t.req('GET', '/api/datasets'); check('資料集列出 data/ 檔案', r.j.files.some((f) => f.path === 'data/solutions.json'), r.j);
  r = await t.req('POST', '/api/trainer/apply', { name: 'my-trainer' }); check('套用先 dry-run（未確認不改動）', r.j.applied === false && t.otImported().o.dry_run === true);
  r = await t.req('POST', '/api/trainer/apply', { name: 'my-trainer', confirmed: true }); check('確認後才真的匯入', r.j.applied === true && t.otImported().o.dry_run === false && t.otImported().b.payload.domains[0].id === 'd1');
  // 匯出
  r = await t.req('POST', '/api/export', { kind: 'trainer', name: 'my-trainer' }); check('匯出 .fatrain', r.j.ok && r.j.filename === 'my-trainer.fatrain' && t.downloads.length === 1 && t.downloads[0].b.length === r.j.bytes, r.j);
  const exported = t.downloads[0].b;
  r = await t.req('POST', '/api/export', { kind: 'trainer', name: 'nope' }); check('匯出不存在的資產 404', r.s === 404);
  // 匯入：先 inspect 再確認；刪除後重新匯入
  r = await t.req('POST', '/api/asset/delete', { kind: 'trainer', name: 'my-trainer' }); check('刪除要先確認', r.s === 400 && r.j.needsConfirm);
  r = await t.req('POST', '/api/asset/delete', { kind: 'trainer', name: 'my-trainer', confirmed: true }); check('確認後刪除', r.j.ok && !(await t.storage.loadManifest('trainer', 'my-trainer')));
  t.setPicked(null); r = await t.req('POST', '/api/import/pick'); check('取消選檔', r.j.cancelled);
  t.setPicked({ name: 'my-trainer.fatrain', bytes: exported }); r = await t.req('POST', '/api/import/pick');
  check('先 inspect 摘要，沒有寫入', r.j.needsConfirm && r.j.summary.name === 'my-trainer' && r.j.plan.action === 'create' && !(await t.storage.loadManifest('trainer', 'my-trainer')), r.j);
  const pid = r.j.pendingId;
  r = await t.req('POST', '/api/import/confirm', { pendingId: 'wrong' }); check('錯的 pendingId 被拒', r.s === 409);
  r = await t.req('POST', '/api/import/confirm', { pendingId: pid }); check('確認後寫入', r.j.ok && !!(await t.storage.loadManifest('trainer', 'my-trainer')) && t.pushes.some((p) => p.type === 'asset_changed'), r.j);
  r = await t.req('GET', '/api/assets'); check('匯入的標為 imported', r.j.groups.find((g) => g.kind === 'trainer').items[0].origin === 'imported');
  t.setPicked({ name: 'bad.fatrain', bytes: enc('not a zip at all') }); r = await t.req('POST', '/api/import/pick'); check('壞檔明確拒絕', r.s === 409 && r.j.error, r.j);
  // 竄改的包（改一個位元組）
  const tam = exported.slice(); tam[tam.length >> 1] ^= 0xff; t.setPicked({ name: 't.fatrain', bytes: tam }); r = await t.req('POST', '/api/import/pick'); check('竄改的包被拒', r.s === 409, r.j);
  // 後端／訓練
  r = await t.req('GET', '/api/backends?kind=lora'); check('後端轉呼叫主行程並附選擇結果', r.j.backends[0].reason === '找不到 Python' && r.j.selection.reason === '沒有可用的後端', r.j);
  r = await t.req('POST', '/api/train/start', { name: 'a', cfg: {} }); check('缺訓練資料檔被拒', r.s === 400);
  r = await t.req('POST', '/api/train/start', { name: 'a/b', cfg: { trainFile: 'x' } }); check('不合法名稱被拒', r.s === 400);
  r = await t.req('POST', '/api/train/start', { name: 'run1', cfg: { trainFile: 'bad' } }); check('主行程拒絕時回具體原因', r.s === 409 && /cpu-py 不可用/.test(r.j.error));
  r = await t.req('POST', '/api/train/start', { name: 'run1', cfg: { trainFile: '/d/t.jsonl' } }); check('啟動訓練並預設輸出資料夾', r.j.ok && r.j.outputDir === '/ud/studio/runs/run1', r.j);
  const call = t.calls.filter((c) => c[0] === 'studio_train_start').pop(); check('把 cfg 轉給主行程', call[1].cfg.trainFile === '/d/t.jsonl' && call[1].cfg.base === 'Qwen/Qwen3-0.6B');
  r = await t.req('POST', '/api/train/pause', {}); check('暫停', r.s === 200);
  r = await t.req('GET', '/api/log'); check('紀錄有項目', r.j.log.length >= 5 && r.j.log.some((x) => /開始訓練/.test(x.text)));
  // 尚未實作的分頁要說原因
  r = await t.req('GET', '/api/teacher'); check('老師明說尚未實作且有原因', r.j.implemented === false && /§10 步驟 7/.test(r.j.reason));
  r = await t.req('GET', '/api/eval'); check('評量明說尚未實作且有原因', r.j.implemented === false && r.j.reason.length > 20);
  r = await t.req('GET', '/api/nope'); check('未知路由 404', r.s === 404);
  // 網頁版
  const w = mk(false);
  r = await w.req('GET', '/api/backends?kind=lora'); check('網頁版後端全灰並說原因', r.j.desktop === false && r.j.backends.every((b) => !b.available && b.reason.length > 10), r.j);
  r = await w.req('POST', '/api/train/start', { name: 'a', cfg: { trainFile: 'x' } }); check('網頁版不能訓練並指向匯出訓練包', r.s === 400 && /匯出訓練包/.test(r.j.error), r.j);
  r = await w.req('POST', '/api/bench/start', {}); check('網頁版不能跑基準', r.s === 400 && /桌面版/.test(r.j.error));
  console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})();
