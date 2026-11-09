// 用 Node 24 以上跑（要 node:sqlite；桌面版自帶的 Electron 用 ELECTRON_RUN_AS_NODE=1 就是）。
// 原生磁碟檔：knowledge-native.js 的串流操作（分段寫／讀、複製＋sha256、只認 .keeplookup）、
// 引擎開檔時的 cacheMB／durable、知識庫存進磁碟檔、寫到一半 kill -9 再開仍完整（PRAGMA quick_check）。
try { require('node:sqlite'); } catch (e) { console.log('knowledge_native: skipped（沒有 node:sqlite，要 Node 22.5 以上才會跑）0 failed'); process.exit(0); }
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const N = require('../../knowledge-native.js'), { SqliteEngine } = require('../../sqlite-engine.js');
const K = require('../../renderer/src/knowledge/knowledge_core.js'), S = require('../../renderer/src/knowledge/knowledge_store.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const rej = async (p) => { try { await p; return null; } catch (e) { return String(e.message || e); } };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa_kn_')); const ops = N.makeOps({ userDataDir: () => dir });
  const info = await ops.info(); check('info: native + dir under userData/knowledge', info.native && info.dir === path.join(dir, 'knowledge') && fs.existsSync(info.dir), info);
  // 分段寫：重新開始、位置對不上要拒絕、done 才改名並回 sha256
  const f = path.join(dir, 'a.keeplookup'), data = crypto.randomBytes(300000), h = crypto.createHash('sha256').update(data).digest('hex');
  await ops.writeChunk({ path: f, offset: 0, base64: data.subarray(0, 100000).toString('base64') });
  check('writeChunk: partial goes to .part, final name not there yet', fs.existsSync(f + '.part') && !fs.existsSync(f));
  check('writeChunk: wrong offset is refused', /對不上/.test(await rej(ops.writeChunk({ path: f, offset: 5, base64: 'AAAA' })) || ''));
  await ops.writeChunk({ path: f, offset: 100000, base64: data.subarray(100000, 200000).toString('base64') });
  const w = await ops.writeChunk({ path: f, offset: 200000, base64: data.subarray(200000).toString('base64'), done: true });
  check('writeChunk: done renames, size and sha256 match', w.size === 300000 && w.sha256 === h && !fs.existsSync(f + '.part'), w);
  const r1 = await ops.readChunk({ path: f, offset: 299990, length: 100 }); check('readChunk: clamps at EOF and flags eof', Buffer.from(r1.base64, 'base64').equals(data.subarray(299990)) && r1.eof && r1.size === 300000);
  const g = path.join(dir, 'sub', 'b.keeplookup'); const c = await ops.copy({ from: f, to: g });
  check('copy: streamed, sha256 verified, parent dir created', c.sha256 === h && fs.readFileSync(g).equals(data), c);
  check('copy: refuses to overwrite unless asked', /已經有檔案/.test(await rej(ops.copy({ from: f, to: g })) || '') && (await ops.copy({ from: f, to: g, overwrite: true })).ok);
  check('hash/stat agree', (await ops.hash({ path: g })).sha256 === h && (await ops.stat({ path: g })).size === 300000 && !(await ops.stat({ path: path.join(dir, 'nope.keeplookup') })).exists);
  check('only .keeplookup, absolute paths', /keeplookup/.test(await rej(ops.stat({ path: path.join(dir, 'x.txt') })) || '') && /完整路徑/.test(await rej(ops.stat({ path: 'rel.keeplookup' })) || ''));
  fs.writeFileSync(g + '-journal', 'x'); await ops.remove({ path: g }); check('remove: file and side files gone', !fs.existsSync(g) && !fs.existsSync(g + '-journal'));

  // 引擎＋儲存層放在磁碟檔（和網頁版同一份 .keeplookup 格式；host 的 exec 轉接一樣）
  const eng = new SqliteEngine({}); const kf = path.join(info.dir, 'main.keeplookup');
  const op = await eng.call('open', { path: kf, mode: 'new', cacheMB: 8, durable: true });
  const pr = async (n) => (await eng.call('pragma', { db: op.db, name: n })).rows[0][0];
  check('open: cache_size = -8192 KiB, journal_mode delete, synchronous FULL(2)', Number(await pr('cache_size')) === -8192 && String(await pr('journal_mode')).toLowerCase() === 'delete' && Number(await pr('synchronous')) === 2);
  const exec = async (sql, bind) => (await eng.call('exec', { db: op.db, sql, bind, limit: 1000000 })).results;
  const store = new S.Store(exec); await store.init();
  const a = await store.addSource(K.ingest({ name: '蜘蛛.md', kind: 'md', raw: '# 蜘蛛\n\n多數蜘蛛會結網捕食昆蟲。\n' }));
  check('store on native file: add + search', a.status === 'added' && (await store.search('蜘蛛結網')).length >= 1);
  await eng.call('close', { db: op.db });
  const op2 = await eng.call('open', { path: kf, cacheMB: 8, durable: true }); const ex2 = async (sql, bind) => (await eng.call('exec', { db: op2.db, sql, bind, limit: 1000000 })).results;
  const st2 = new S.Store(ex2); await st2.init(); check('reopen: content still there', (await st2.search('蜘蛛結網')).length >= 1 && (await st2.stats()).sources === 1);
  await eng.call('close', { db: op2.db });
  // 複製檔案＝一份可獨立打開的 .keeplookup（搬家、匯出的基礎）
  const cp2 = path.join(info.dir, 'copy.keeplookup'); await ops.copy({ from: kf, to: cp2 });
  const op3 = await eng.call('open', { path: cp2, readonly: true }); const ex3 = async (sql, bind) => (await eng.call('exec', { db: op3.db, sql, bind, limit: 1000000 })).results; check('copied file opens and has the data', (await new S.Store(ex3).stats()).sources === 1); await eng.call('close', { db: op3.db });

  // kill -9：子行程一直寫大交易，被 SIGKILL 殺掉，再開必須通過 quick_check
  const kf2 = path.join(info.dir, 'kill.keeplookup');
  const writer = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=-8192;CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY,b BLOB);CREATE INDEX IF NOT EXISTS ti ON t(b)');const buf=Buffer.alloc(200000,7);let i=0;process.send&&process.send('go');for(;;){d.exec('BEGIN');for(let k=0;k<20;k++){buf.writeUInt32LE(i++,0);d.prepare('INSERT INTO t(b) VALUES(?)').run(buf);}d.exec('COMMIT');}`;
  let kills = 0, allOk = true;
  for (let round = 0; round < 4; round++) {
    const child = cp.spawn(process.execPath, ['-e', writer, kf2], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await new Promise((res) => child.once('message', res)); await new Promise((res) => setTimeout(res, 300 + round * 170)); child.kill('SIGKILL'); await new Promise((res) => child.once('exit', res)); kills++;
    const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(kf2); const qc = d.prepare('PRAGMA quick_check').all(); const n = d.prepare('SELECT count(*) c FROM t').get().c; d.close();
    if (!(qc.length === 1 && qc[0].quick_check === 'ok' && Number(n) % 20 === 0)) { allOk = false; bad.push('kill -9 round ' + round + ': ' + JSON.stringify(qc).slice(0, 200) + ' rows=' + n); }
  }
  check('kill -9 mid-write ×' + kills + ': quick_check ok and only whole transactions survive', allOk);
  await eng.closeAll(); fs.rmSync(dir, { recursive: true, force: true });
  console.log('knowledge_native: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' failed:\n  ' + bad.join('\n  ') : '')); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('knowledge_native: crashed ' + (e && e.stack || e)); process.exit(1); });
