'use strict';
// 資料匯入輸入欄位：本機路徑（真目錄）、多個資料夾、fap 參照、GitHub wiki／raw 網址（假抓取）、釘選、server 路由（先確認網址再連網）。
const fs = require('fs'), os = require('os'), path = require('path');
const SI = require('./source_input_core.js'), Storage = require('./storage_core.js');
const { createServer } = require('./studio_server_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
const local = { localReadDir: async (p) => fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: e.isFile() ? fs.statSync(path.join(p, e.name)).size : 0 })), localStat: async (p) => { const s = fs.statSync(p); return { isFile: s.isFile(), isDir: s.isDirectory(), size: s.size }; }, localReadFile: async (p) => fs.readFileSync(p, 'utf8') };
(async () => {
  check('parseLine 分類', SI.parseLine('https://a/b').type === 'url' && SI.parseLine('fap:x/y').type === 'fap' && SI.parseLine('C:\\d').type === 'path' && SI.parseLine('  ') === null);
  const cu = SI.classifyUrl('https://github.com/o/r/wiki'); check('wiki 網址 → raw 基底', cu.kind === 'wiki' && cu.rawBase === 'https://raw.githubusercontent.com/wiki/o/r/', cu);
  check('wiki 單頁', SI.classifyUrl('https://github.com/o/r/wiki/Some-Page').page === 'Some-Page');
  check('blob 網址轉 raw', SI.classifyUrl('https://github.com/o/r/blob/main/docs/a.md').rawUrl === 'https://raw.githubusercontent.com/o/r/main/docs/a.md');
  const repoHome = SI.classifyUrl('https://github.com/o/r'); check('倉庫首頁被拒並說明（不下載壓縮檔）', !repoHome.ok && /clone/.test(repoHome.error) && /不下載|本功能不下載/.test(repoHome.error));
  check('非 http 被拒', !SI.classifyUrl('ftp://x/y').ok);
  const plan = SI.planUrls([{ type: 'url', value: 'https://github.com/o/r/wiki' }, { type: 'path', value: 'x' }]); check('planUrls 只列網址、寫明連線主機與網址', plan.length === 1 && plan[0].host === 'raw.githubusercontent.com' && /raw\.githubusercontent\.com\/wiki\/o\/r\//.test(plan[0].willFetch[0]), plan);
  // 真目錄＋多個資料夾
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-test-')); const d1 = path.join(tmp, 'a'), d2 = path.join(tmp, 'b'); fs.mkdirSync(path.join(d1, 'sub'), { recursive: true }); fs.mkdirSync(path.join(d1, '.git')); fs.mkdirSync(d2);
  fs.writeFileSync(path.join(d1, 'x.md'), '# 標題\n\n內容 '.padEnd(200, 'x')); fs.writeFileSync(path.join(d1, 'sub', 'y.txt'), 'yyy'.repeat(80)); fs.writeFileSync(path.join(d1, '.git', 'config'), 'secret'); fs.writeFileSync(path.join(d1, 'p.png'), 'bin'); fs.writeFileSync(path.join(d2, 'z.md'), '# Z\n\n' + 'zz'.repeat(100)); fs.writeFileSync(path.join(d2, 'big.txt'), 'b'.repeat(2000));
  const ex = await SI.expandInputs([{ type: 'path', value: d1 }, { type: 'path', value: d2 }, { type: 'path', value: path.join(d2, 'z.md') }], local, { maxBytes: 1000 });
  check('多個資料夾：各自統計檔數與位元組', ex.sources.length === 3 && ex.sources[0].ok && ex.sources[0].files === 2 && ex.sources[1].files === 1 && ex.sources[2].files === 1 && ex.sources[0].bytes > 0, ex.sources);
  check('略過 .git／二進位／過大檔且有計數', ex.sources[0].skipped === 1 && ex.sources[1].skipped === 1 && !ex.files.some((f) => /\.git/.test(f.path) && f.content != null), ex.sources.map((s) => s.skipped));
  check('相對路徑保留子資料夾', ex.files.some((f) => f.path === 'sub/y.txt' && f.origin === d1));
  const nf = await SI.expandInputs([{ type: 'path', value: path.join(tmp, 'nope') }], local); check('不存在的路徑：失敗原因，不丟例外', nf.sources[0].ok === false && nf.sources[0].error.length > 3, nf.sources[0]);
  const web = await SI.expandInputs([{ type: 'path', value: 'C:\\x' }, { type: 'fap', value: 'fap:a' }, { type: 'url', value: 'https://github.com/o/r/wiki' }], {}); check('缺接口：每種輸入寫具體原因', /沙盒/.test(web.sources[0].error) && /檔案存取資料夾/.test(web.sources[1].error) && /連網/.test(web.sources[2].error), web.sources.map((s) => s.error));
  // fap
  const tree = { 'fap:docs': [{ name: 'a.md', type: 'file', sizeBytes: 60 }, { name: 'd', type: 'directory' }], 'fap:docs/d': [{ name: 'b.md', type: 'file', sizeBytes: 60 }, { name: 'i.png', type: 'file', sizeBytes: 5 }] };
  const fx = await SI.expandInputs([{ type: 'fap', value: 'fap:docs/' }], { fapList: async (r) => ({ entries: tree[r] || [] }), fapRead: async (r) => '# ' + r + '\n' + 't'.repeat(60) });
  check('fap 參照遞迴', fx.sources[0].ok && fx.sources[0].files === 2 && fx.files.some((f) => f.path === 'd/b.md'), fx.sources[0]);
  // wiki（假抓取）
  const pages = { 'https://raw.githubusercontent.com/wiki/o/r/_Sidebar.md': '* [[Intro]]\n* [Guide](Guide)\n* [外部](https://x.com/a)', 'https://raw.githubusercontent.com/wiki/o/r/Home.md': '# Home\n see [[Intro|入門]]', 'https://raw.githubusercontent.com/wiki/o/r/Intro.md': '# Intro\n內容', 'https://raw.githubusercontent.com/wiki/o/r/Guide.md': '# Guide\n指南' };
  const fetched = []; const fetchUrl = async (u) => { fetched.push(u); const t = pages[u]; return t == null ? { ok: false, status: 404, error: 'HTTP 404' } : { ok: true, status: 200, text: t, bytes: Buffer.byteLength(t), contentType: 'text/plain; charset=utf-8' }; };
  const wx = await SI.expandInputs([{ type: 'url', value: 'https://github.com/o/r/wiki' }], { fetchUrl });
  check('wiki 首頁：抓側欄與 Home 中連到的頁面', wx.sources[0].ok && ['Home.md', 'Intro.md', 'Guide.md', '_Sidebar.md'].every((n) => wx.files.some((f) => f.path === n)) && wx.sources[0].files === 4, wx.sources[0]);
  check('只連 raw.githubusercontent.com，外部連結不抓', fetched.every((u) => u.startsWith('https://raw.githubusercontent.com/wiki/o/r/')), fetched);
  check('顯示每次連線的狀態與大小', wx.sources[0].fetched.length >= 4 && wx.sources[0].fetched.every((f) => f.bytes !== undefined || f.error), wx.sources[0].fetched);
  const one = await SI.expandInputs([{ type: 'url', value: 'https://github.com/o/r/wiki/Guide' }], { fetchUrl }); check('wiki 單頁', one.files.length === 1 && one.files[0].path === 'Guide.md');
  const big = await SI.expandInputs([{ type: 'url', value: 'https://raw.githubusercontent.com/o/r/main/a.md' }], { fetchUrl: async () => ({ ok: true, status: 200, text: 'x', bytes: 5e6, contentType: 'text/plain' }) }); check('超過大小上限不收並說明', big.sources[0].ok === false && /上限/.test(big.sources[0].error));
  const binu = await SI.expandInputs([{ type: 'url', value: 'https://raw.githubusercontent.com/o/r/main/a.md' }], { fetchUrl: async () => ({ ok: true, status: 200, text: 'x', bytes: 5, contentType: 'application/zip' }) }); check('非文字內容不收', binu.sources[0].ok === false && /不是文字/.test(binu.sources[0].error));
  const f404 = await SI.expandInputs([{ type: 'url', value: 'https://github.com/o/r/wiki/Nope' }], { fetchUrl }); check('404：錯誤含 HTTP 狀態', f404.sources[0].ok === false && /404/.test(f404.sources[0].error));
  // 釘選
  let pins = []; let r = SI.addPin(pins, { type: 'path', value: 'C:\\docs', label: '文件' }); pins = r.pins; check('釘選', r.ok && pins.length === 1);
  check('重複釘選被拒', SI.addPin(pins, { type: 'path', value: 'C:\\docs' }).ok === false); check('不合法被拒', SI.addPin(pins, { type: 'zzz', value: 'x' }).ok === false);
  check('取消釘選', SI.removePin(pins, pins[0].id).pins.length === 0);

  // ===== server 路由 =====
  let prefs = {}; const storage = Storage.createStorage({ memory: Storage.createMemoryStore() });
  const h = Object.assign({ storage, desktop: true, now: () => 1, prefsGet: () => prefs, prefsSet: (p) => { prefs = p; }, fetchUrl, fapList: async () => ({ entries: [] }), fapRead: async () => '' }, local);
  const srv = createServer(h); srv.setPush(() => {}); const req = async (m, p, b) => { const x = await srv.route(m, new URL('http://mock.local' + p), b); return { s: x.s || 200, j: x.j }; };
  let q = await req('POST', '/api/ingest/from', { source: 'wiki', lines: d1 + '\n' + d2, contextWindowTokens: 4096 });
  check('多資料夾輸入 → 清洗出語料塊，並回報各輸入來源', q.j.ok && q.j.stats.chunks >= 2 && q.j.inputs.length === 2 && q.j.inputs.every((s) => s.ok), q.j.inputs || q.j);
  q = await req('POST', '/api/ingest/from', { source: 'wiki', lines: 'https://github.com/o/r/wiki' }); const nFetch = fetched.length;
  check('網址沒確認：不連網，回 needsConfirm 與要連的網址', q.s === 400 && q.j.needsConfirm && q.j.urls[0].host === 'raw.githubusercontent.com' && fetched.length === nFetch, q.j);
  q = await req('POST', '/api/ingest/from', { source: 'wiki', lines: 'https://github.com/o/r/wiki', confirmedUrls: true }); check('確認後才連網並匯入；畫面可顯示連線明細', q.j.ok && fetched.length > nFetch && q.j.inputs[0].fetched.length >= 4 && q.j.inputs[0].kind === 'wiki', q.j.inputs);
  q = await req('POST', '/api/ingest/from', { source: 'wiki', lines: path.join(tmp, 'nope') }); check('全部失敗：409 並列各輸入原因', q.s === 409 && q.j.sources.length === 1 && q.j.sources[0].error, q.j);
  q = await req('POST', '/api/ingest/from', { source: 'wiki', lines: '' }); check('沒填輸入被拒', q.s === 400);
  q = await req('POST', '/api/ingest/from', { source: 'zzz', lines: 'x' }); check('來源不合法被拒', q.s === 400);
  q = await req('POST', '/api/ingest/pin', { type: 'url', value: 'https://github.com/o/r/wiki', label: 'my wiki' }); q = await req('GET', '/api/ingest/pins'); check('伺服器釘選存進偏好並回報可用類型', q.j.pins.length === 1 && prefs.ingestPins.length === 1 && q.j.can.path && q.j.can.url, q.j);
  const pid = q.j.pins[0].id; q = await req('POST', '/api/ingest/unpin', { id: pid }); check('取消釘選', q.j.pins.length === 0);
  const hw = createServer({ storage, desktop: false, now: () => 1, prefsGet: () => prefs, prefsSet: () => {} }); hw.setPush(() => {});
  const wq = await hw.route('POST', new URL('http://mock.local/api/ingest/from'), { source: 'wiki', lines: 'C:\\docs' }); check('網頁版：路徑輸入回具體原因與替代方案', wq.s === 409 && /沙盒/.test(JSON.stringify(wq.j)) && /fap:/.test(JSON.stringify(wq.j)), wq.j);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('source_input 測試：通過 ' + ok + ' 項，失敗 ' + bad.length + ' 項'); if (bad.length) process.exit(1);
})().catch((e) => { console.log('ERR', e && e.stack || e); process.exit(1); });
