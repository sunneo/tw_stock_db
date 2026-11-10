'use strict';
// Studio 假伺服器路由測試：資產列表／匯出／匯入（先確認再合併）／trainer 往返／版面偏好／後端與訓練的轉呼叫／網頁版誠實回報
const Asset = require('./asset_core.js'), Storage = require('./storage_core.js'), Fatrain = require('./fatrain_core.js'), Trainer = require('./trainer_adapter.js');
const { createServer } = require('./studio_server_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const srvChunk = (tt, id) => tt.srv.S.ingest.chunks.find((c) => c.id === id);
const enc = (s) => new TextEncoder().encode(s);
function mk(desktop, hostOps) {
  const storage = Storage.createStorage({ memory: Storage.createMemoryStore() });
  let prefs = {}, downloads = [], picked = null, pickedFiles = null, calls = [], otImported = null;
  const bundle = { format: 'fa-offline-trainer', version: 2, exported_at: '2026-11-11T00:00:00Z', summary: 's', payload: { domains: [{ id: 'd1' }], solutions: [{ q: 1 }], synonyms: {} } };
  bundle.checksum = Trainer.bundleHash(JSON.stringify(bundle.payload));
  const h = { storage, desktop, now: () => 1000, prefsGet: () => prefs, prefsSet: (p) => { prefs = p; }, download: async (n, b) => { downloads.push({ n, b }); }, pickFile: async () => picked, pickFiles: async () => pickedFiles,
    call: async (op, p) => { calls.push([op, p]); return hostOps && hostOps[op] ? hostOps[op](p) : { ok: true }; }, workDir: async () => '/ud/studio', otExport: async () => bundle, otImport: async (b, o) => { otImported = { b, o }; return { ok: true, dry: o.dry_run }; } };
  const srv = createServer(h); const pushes = []; srv.setPush((o) => pushes.push(o));
  const req = async (m, path, body) => { const r = await srv.route(m, new URL('http://mock.local' + path), body); return { s: r.s || 200, j: r.j }; };
  return { srv, req, storage, downloads, setPicked: (f) => { picked = f; }, setPickFiles: (f) => { pickedFiles = f; }, calls, pushes, prefs: () => prefs, otImported: () => otImported };
}
(async () => {
  const t = mk(true, { studio_probe: () => ({ ok: true, backends: [{ id: 'cpu-py', available: false, reason: '找不到 Python' }] }), studio_select: () => ({ ok: false, chosen: null, reason: '沒有可用的後端' }), studio_train_start: (p) => (p.cfg.trainFile === 'bad' ? { ok: false, error: 'cpu-py 不可用：x' } : { ok: true, jobId: 'train1' }) });
  let r = await t.req('GET', '/api/info'); check('info', r.j.ok && r.j.desktop && r.j.tabs.length === 8 && r.j.workDir === '/ud/studio', r.j);
  check('info 回報 fap 沒授權（資料只在記憶體）', r.j.storage.ok === false && /記憶體/.test(r.j.storage.message), r.j.storage);
  // 版面偏好
  r = await t.req('GET', '/api/prefs'); check('預設版面', r.j.layout.panes.left[0] === 'assets');
  r = await t.req('POST', '/api/prefs', { layout: { panes: { left: ['train'], right: ['assets'] }, split: 0.9 } }); check('偏好存起來並正規化', r.j.layout.split === 0.8 && r.j.layout.panes.left[0] === 'train' && t.prefs().layout.split === 0.8, r.j);
  r = await t.req('POST', '/api/prefs', { reset: true }); check('還原版面', r.j.layout.split === 0.45 && r.j.layout.panes.left.length === 5);
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
  // ===== 第二輪：資料匯入與清洗、老師領取、LoRA 登錄 =====
  const md = (n) => '# 離線訓練工作室說明 ' + n + '\n\n這份文件說明如何安裝並啟動離線訓練工作室，需要先準備好基底模型與訓練資料，然後依步驟執行，最後匯出訓練包到另一台電腦繼續訓練。\n\n## 匯出\n\n匯出時會把資產切成二十 MB 的分片，並且記錄每個檔案的雜湊，匯入時先檢查摘要再確認，避免覆蓋掉使用者原本的資料。聯絡信箱 someone@example.com 不該留下。\n';
  t.setPickFiles(null); r = await t.req('POST', '/api/ingest/pick', { source: 'wiki' }); check('取消選檔', r.j.cancelled);
  r = await t.req('POST', '/api/ingest/pick', { source: 'nope' }); check('未知來源被拒', r.s === 400);
  t.setPickFiles([{ path: 'a.md', content: md(1) }, { path: 'b.md', content: md(2) + '額外一段不同的內容，用來避免被近似去重吃掉：資料匯入先清洗再切塊，授權不明的來源預設不進內建。' }, { path: 'x.png', content: '' }]);
  r = await t.req('POST', '/api/ingest/pick', { source: 'wiki', contextWindowTokens: 2048 });
  check('wiki 匯入產生語料塊與請求單', r.j.has && r.j.stats.chunks >= 1 && r.j.requests.pending >= 1, r.j);
  check('個資被遮掉', r.j.stats.redactions.email >= 1 && !JSON.stringify(r.j.preview).includes('someone@example.com'), r.j.stats);
  check('非文字檔記錄略過原因', r.j.skippedTotal >= 1 && r.j.skipped[0].reason.length > 3, r.j.skipped);
  check('切塊大小依 contextWindowTokens', r.j.sizing.contextWindowTokens === 2048);
  const first = r.j.preview[0].id;
  r = await t.req('POST', '/api/ingest/rules', {}); check('規則樣本（不用 AI）新增若干列', r.j.added >= 1 && r.j.invalid.length === 0, r.j);
  const before = r.j.requests.pending;
  r = await t.req('POST', '/api/ingest/drop', { chunkId: first }); check('逐塊拒絕會一併拿掉請求單', r.j.requests.pending < before && r.j.rejectedTotal >= 1, r.j.requests);
  // 重新匯入，確保有足夠請求單給老師領取
  t.setPickFiles([{ path: 'a.md', content: md(1) }, { path: 'b.md', content: md(2) + '額外一段不同的內容，用來避免被近似去重吃掉：資料匯入先清洗再切塊，授權不明的來源預設不進內建。' }]);
  r = await t.req('POST', '/api/ingest/pick', { source: 'wiki', contextWindowTokens: 2048 });
  r = await t.req('POST', '/api/ingest/rules', {});
  r = await t.req('POST', '/api/teacher/claim', { limit: 2 }); check('老師領取', r.j.requests.length >= 1 && r.j.requests.every((q) => q.status === 'claimed'), r.j);
  const rq = r.j.requests[0];
  r = await t.req('POST', '/api/teacher/submit', { id: rq.id, row: { stage: 'qa', messages: [{ role: 'user', content: '怎麼匯出？' }], completion: '完全無關的火星文字雲朵彩虹獨角獸' } }); check('超出語料塊的答案被驗證擋下並退回待領', r.s === 422 && r.j.problems.length >= 1, r.j);
  r = await t.req('POST', '/api/teacher/claim', { limit: 1 }); const rq2 = r.j.requests[0];
  const chunk2 = srvChunk(t, rq2.chunk_id);
  r = await t.req('POST', '/api/teacher/submit', { id: rq2.id, row: { stage: 'qa', messages: [{ role: 'user', content: '這份文件說明什麼？' }], completion: chunk2.text.replace(/\s+/g, ' ').slice(0, 120) } }); check('有根據的答案通過驗證收進樣本', r.j.accepted === true && r.j.samples >= 1, r.j);
  r = await t.req('POST', '/api/teacher/submit', { id: rq2.id, row: {} }); check('已完成的請求單不能再交', r.s === 409);
  r = await t.req('GET', '/api/teacher'); check('老師分頁仍誠實說迴圈未實作、但顯示佇列', r.j.implemented === false && r.j.queue && r.j.queue.done === 1, r.j);
  r = await t.req('POST', '/api/ingest/save', { name: 'corpus-wiki' }); check('存成資料資產', r.j.ok, r.j);
  r = await t.req('POST', '/api/ingest/save', { name: 'corpus-wiki' }); check('同名不覆蓋', r.s === 409);
  r = await t.req('POST', '/api/ingest/load', { name: 'corpus-wiki' }); check('重新載入資料資產', r.j.has && r.j.stats.chunks >= 1 && r.j.samples >= 1, r.j);
  t.setPickFiles([{ path: 'notes.json', content: '{"not":"aidoc"}' }]); r = await t.req('POST', '/api/ingest/pick', { source: 'aidoc' }); check('aidoc 來源不認得的 JSON 有明確結果', r.s === 200 || r.s === 409, r.j);
  t.setPickFiles([{ path: 'book.txt', content: '第一章\n\n' + '這是使用者自己提供的書本內容，用來測試書本來源的匯入流程與頁碼記錄。'.repeat(8) }]); r = await t.req('POST', '/api/ingest/pick', { source: 'book', title: '測試書' });
  check('書本來源標為使用者提供、不進內建', r.j.has && r.j.preview[0].builtin_allowed === false && r.j.preview[0].user_supplied === true, r.j.preview && r.j.preview[0]);
  // LoRA 登錄
  const mkw = (n) => new Uint8Array(n).fill(7);
  const mkLora = async (name, o) => { const files = { 'weights/lora.bin': mkw(o.size || 1000) }; const m = Asset.createManifest({ kind: 'lora', name, files, base: o.base || 'Qwen/Qwen3-0.6B', compat: { base: o.base || 'Qwen/Qwen3-0.6B', rank: o.rank || 16, alpha: 32, prompt_format_version: o.pfv === undefined ? 1 : o.pfv }, owner: 'user', eval: o.eval, extra: { lora: { domains: o.domains || ['doc_knowledge'], size: o.size || 1000 } } }); await t.storage.saveAsset({ manifest: m, files }, { replace: true }); };
  await mkLora('good', { eval: { groups: { doc_knowledge: { adapter: 0.8, base: 0.5 } } } }); await mkLora('wrongbase', { base: 'Other/Model', eval: { groups: { a: { adapter: 1, base: 0 } } } }); await mkLora('noeval', {}); await mkLora('lose', { eval: { groups: { doc_knowledge: { adapter: 0.2, base: 0.5 } } }, domains: ['colu'] });
  r = await t.req('GET', '/api/lora'); const E = Object.fromEntries(r.j.entries.map((e) => [e.id, e]));
  check('登錄表列出四個 adapter（資料資產不算）', r.j.entries.length === 4 && !E['corpus-wiki'], r.j.entries.map((e) => e.id));
  check('基底不同的標 reject 並說具體原因', E.wrongbase.compat.level === 'reject' && /基底模型不同/.test(E.wrongbase.compat.reasons[0].message), E.wrongbase.compat);
  check('評量判定：贏、輸、未知', E.good.verdict.known && E.good.verdict.lose.length === 0 && E.lose.verdict.lose.length === 1 && !E.noeval.verdict.known, E);
  check('明說套用到推論的阻礙', /nr-host\.js/.test(r.j.applyBlocker), r.j.applyBlocker);
  r = await t.req('POST', '/api/lora/select', { domains: ['doc_knowledge'] }); check('按需選用只選相容且評量贏的', r.j.plan.length === 1 && r.j.plan[0].id === 'good' && r.j.skipped.some((x) => x.id === 'wrongbase'), r.j);
  r = await t.req('POST', '/api/lora/select', { ids: ['wrongbase'] }); check('手動也不能繞過不相容', r.j.plan.length === 0, r.j);
  r = await t.req('POST', '/api/lora/select', { ids: ['noeval'] }); check('手動可選沒評量的', r.j.plan.length === 1 && r.j.plan[0].id === 'noeval', r.j);
  r = await t.req('POST', '/api/lora/load', { domains: ['doc_knowledge'] }); check('載入到記憶體並誠實說尚未套用', r.j.active.join() === 'good' && r.j.handles[0].bytes === 1000 && r.j.applied === false && /nr-host/.test(r.j.applyNote), r.j);
  r = await t.req('GET', '/api/lora'); check('登錄表顯示已載入', r.j.entries.find((e) => e.id === 'good').loaded === true && r.j.loaded.length === 1);
  r = await t.req('POST', '/api/lora/enable', { id: 'good', on: false }); r = await t.req('GET', '/api/lora'); check('停用會卸載並記住', !r.j.entries.find((e) => e.id === 'good').enabled && r.j.loaded.length === 0 && t.prefs().loraEnabled.good === false);
  r = await t.req('POST', '/api/lora/load', { domains: ['doc_knowledge'] }); check('停用的不會被載入', r.j.active.length === 0);
  r = await t.req('POST', '/api/lora/enable', { id: 'zzz', on: true }); check('不存在的 adapter 404', r.s === 404);
  await t.storage.deleteAsset('lora', 'noeval'); r = await t.req('GET', '/api/lora'); check('資產刪除後登錄表同步', !r.j.entries.find((e) => e.id === 'noeval'));
  // 網頁版
  const w = mk(false);
  r = await w.req('GET', '/api/backends?kind=lora'); check('網頁版後端全灰並說原因', r.j.desktop === false && r.j.backends.every((b) => !b.available && b.reason.length > 10), r.j);
  r = await w.req('POST', '/api/train/start', { name: 'a', cfg: { trainFile: 'x' } }); check('網頁版不能訓練並指向匯出訓練包', r.s === 400 && /匯出訓練包/.test(r.j.error), r.j);
  r = await w.req('POST', '/api/bench/start', {}); check('網頁版不能跑基準', r.s === 400 && /桌面版/.test(r.j.error));
  console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})();
