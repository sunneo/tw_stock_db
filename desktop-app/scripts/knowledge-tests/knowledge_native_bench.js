// 大庫實測（不在 run 的測試清單裡，要手動跑）：ELECTRON_RUN_AS_NODE=1 <electron> scripts/knowledge-tests/knowledge_native_bench.js [MB=1024] [cacheMB=16] [dir]
// 產生 MB 大小的 .keeplookup（含片段、全文索引、384 維向量 BLOB）→ 用引擎以 cacheMB 的頁面快取開 → 查詢 → 串流複製（sha256）→ 關閉重開比對
// → 寫到一半 kill -9 再開 quick_check。回報：檔案大小、各步耗時、引擎行程的尖峰 RSS（頁面快取只有 cacheMB）。
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { DatabaseSync } = require('node:sqlite'), { SqliteEngine } = require('../../sqlite-engine.js'), N = require('../../knowledge-native.js');
const S = require('../../renderer/src/knowledge/knowledge_store.js');
const MB = Number(process.argv[2]) || 1024, CACHE = Number(process.argv[3]) || 16, dir = process.argv[4] || fs.mkdtempSync(path.join(os.tmpdir(), 'fa_bench_'));
fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'big.keeplookup'), t = () => Date.now(); const sec = (a) => ((t() - a) / 1000).toFixed(1) + 's';
(async () => {
  let t0 = t(); const d = new DatabaseSync(f); d.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=OFF'); const exec = async (sql, b) => { d.prepare(sql).run(...(b || [])); return []; };
  const st = new S.Store(async (sql, b) => { const s = d.prepare(sql); let cols = []; try { cols = s.columns().map((c) => c.name); } catch (_) { /* */ } const bb = (b || []).map((v) => (v && v.$blob ? Buffer.from(v.$blob, 'base64') : v)); if (!cols.length) { s.run(...bb); return [{ columns: [], rows: [] }]; } s.setReturnArrays(true); return [{ columns: cols, rows: s.all(...bb).map((r) => r.map((v) => typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? { $blob: Buffer.from(v).toString('base64') } : v)) }]; });
  await st.init(); void exec;
  const vec = Buffer.alloc(384 * 4); let id = 0, words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(' ');
  d.exec('BEGIN'); d.prepare("INSERT INTO sources(id,name,kind,hash,notes,text,loc_runs,chars,enabled,added_at,updated_at) VALUES(1,'bench','txt','h','[]','x','[]',1,1,0,0)").run();
  const ins = d.prepare('INSERT INTO chunks(id,source_id,n,line_start,line_end,text,section,section_n,loc,toks) VALUES(?,?,?,?,?,?,?,?,?,?)'), fts = d.prepare('INSERT INTO chunks_fts(rowid,toks) VALUES(?,?)'), vv = d.prepare('INSERT INTO vectors(chunk_id,model,dim,vec) VALUES(?,?,?,?)');
  while (fs.statSync(f).size < MB * 1048576) {
    for (let i = 0; i < 2000; i++) { id++; const toks = Array.from({ length: 120 }, (_, k) => words[(id * 7 + k * 13) % 20] + ((id + k) % 997)).join(' '); for (let k = 0; k < vec.length; k += 4) vec.writeFloatLE(Math.random(), k); ins.run(id, 1, id, id, id, toks, '', 0, '', toks); fts.run(id, toks); vv.run(id, 'bench', 384, vec); }
    d.exec('COMMIT'); d.exec('BEGIN');
  }
  d.exec('COMMIT'); d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); const rows = id; d.close(); const size = fs.statSync(f).size;
  console.log('生成：' + (size / 1048576).toFixed(0) + ' MB、' + rows + ' 片段（含全文索引與向量），' + sec(t0));
  const eng = new SqliteEngine({}); t0 = t(); const op = await eng.call('open', { path: f, cacheMB: CACHE, durable: true }); const ex = async (sql, b) => (await eng.call('exec', { db: op.db, sql, bind: b, limit: 100000, timeoutMs: 600000 })).results;
  const s2 = new S.Store(ex); let peak = 0; const rss = async () => { const r = Number((await eng.call('status', { db: op.db })).rss) / 1048576; if (r > peak) peak = r; return r; };
  const cnt = (await s2.stats()); console.log('開庫＋統計：' + sec(t0) + '，來源 ' + cnt.sources + '、片段 ' + cnt.chunks + '、向量 ' + cnt.vectors + '，引擎 RSS ' + (await rss()).toFixed(0) + ' MB（快取預算 ' + CACHE + ' MB）');
  t0 = t(); const hits = await s2.search('alpha17 beta30', { limit: 5 }); console.log('全文檢索：' + sec(t0) + '，命中 ' + hits.length + '，RSS ' + (await rss()).toFixed(0) + ' MB');
  t0 = t(); await ex('SELECT count(*), sum(length(vec)) FROM vectors'); console.log('掃向量表：' + sec(t0) + '，RSS ' + (await rss()).toFixed(0) + ' MB');
  await eng.call('close', { db: op.db });
  const ops = N.makeOps({ userDataDir: () => dir }); const g = path.join(dir, 'copy.keeplookup'); fs.rmSync(g, { force: true }); t0 = t(); const m0 = process.memoryUsage().rss; const c = await ops.copy({ from: f, to: g }); console.log('串流複製（含兩次 sha256）：' + sec(t0) + '，sha256 ' + c.sha256.slice(0, 12) + '…，本行程 RSS 變化 ' + ((process.memoryUsage().rss - m0) / 1048576).toFixed(0) + ' MB');
  const op2 = await eng.call('open', { path: g, readonly: true, cacheMB: CACHE }); const c2 = await new S.Store(async (sql, b) => (await eng.call('exec', { db: op2.db, sql, bind: b, limit: 100000 })).results).stats(); console.log('複本重開比對：' + (c2.chunks === cnt.chunks && c2.vectors === cnt.vectors && c2.sources === cnt.sources ? '一致' : '不一致 ' + JSON.stringify(c2))); await eng.call('close', { db: op2.db });
  // kill -9：在這個大庫上持續寫，殺掉，quick_check
  const writer = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=-16384');const v=Buffer.alloc(1536,3);let i=1e9;process.send('go');for(;;){d.exec('BEGIN');for(let k=0;k<2000;k++){i++;d.prepare('INSERT INTO vectors(chunk_id,model,dim,vec) VALUES(?,?,?,?)').run(i,'k',384,v);}d.exec('COMMIT');}`;
  const child = cp.spawn(process.execPath, ['-e', writer, g], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); await new Promise((r) => child.once('message', r)); await new Promise((r) => setTimeout(r, 1500)); child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r));
  t0 = t(); const d2 = new DatabaseSync(g); const qc = d2.prepare('PRAGMA quick_check').all(); const nv = d2.prepare('SELECT count(*) c FROM vectors').get().c; d2.close(); console.log('kill -9 寫到一半後重開：quick_check=' + qc.map((r) => r.quick_check).join(',') + '（' + sec(t0) + '），向量 ' + nv + '（原 ' + cnt.vectors + '，多出的是已提交的整批交易）');
  console.log('引擎行程尖峰 RSS ≈ ' + peak.toFixed(0) + ' MB；檔案 ' + (size / 1048576).toFixed(0) + ' MB'); await eng.closeAll(); if (!process.argv[4]) fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.log('bench crashed ' + (e && e.stack || e)); process.exit(1); });
