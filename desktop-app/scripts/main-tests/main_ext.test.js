// node scripts/main-tests/main_ext.test.js -- main-ext.js（可 live-update 的主行程 IPC 模組）：不開 Electron，用假的 ipcMain 直接呼叫每個 fa:rawfs:* handler。
const fsp = require('fs/promises'); const path = require('path'); const os = require('os');
const handlers = new Map(); const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
const ext = require('../../main-ext.js').register(ipcMain, { fs: fsp, path });
let ok = 0; const bad = [];
function check(n, c, x) { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); }
const call = (ch, arg) => handlers.get(ch)({}, arg);
(async () => {
  const names = ['stat', 'readdir', 'readFile', 'writeFile', 'mkdir', 'copyChunked', 'remove', 'find', 'listDrives'];
  check('all 9 fa:rawfs handlers are registered', names.every((n) => handlers.has('fa:rawfs:' + n)), [...handlers.keys()]);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mainext-')); const f = path.join(dir, 'a.txt');
  await call('fa:rawfs:mkdir', { path: path.join(dir, 'sub') }); await call('fa:rawfs:writeFile', { path: f, text: 'hello 世界' });
  const rf = await call('fa:rawfs:readFile', { path: f }); check('write then read text', rf.text === 'hello 世界' && !rf.likelyBinary, rf);
  await call('fa:rawfs:writeFile', { path: path.join(dir, 'b.bin'), base64: Buffer.from([0, 1, 2, 3]).toString('base64') }); const rb = await call('fa:rawfs:readFile', { path: path.join(dir, 'b.bin') }); check('binary is detected and returned as base64', rb.likelyBinary === true && !!rb.base64, rb);
  const st = await call('fa:rawfs:stat', { path: f }); check('stat', st.isFile && st.size === Buffer.byteLength('hello 世界'), st);
  const ls = await call('fa:rawfs:readdir', { path: dir }); check('readdir lists files and the folder', ls.some((e) => e.name === 'a.txt') && ls.some((e) => e.name === 'sub' && e.isDirectory), ls.map((e) => e.name));
  const fd = await call('fa:rawfs:find', { path: dir, pattern: 'a\.txt' }); check('find by name', fd.length === 1 && /a\.txt$/.test(fd[0].path), fd);
  let badPat = ''; try { await call('fa:rawfs:find', { path: dir, pattern: '(' }); } catch (e) { badPat = e.message; } check('an invalid pattern is explained', /pattern/.test(badPat), badPat);
  // 分段複製：25 KB、每份 10 KB → 3 份
  const big = Buffer.alloc(25 * 1024, 7); await fsp.writeFile(path.join(dir, 'big.db'), big);
  const cc = await call('fa:rawfs:copyChunked', { src: path.join(dir, 'big.db'), dst: path.join(dir, 'out', 'db-'), partBytes: 10 * 1024 });
  const partsBytes = Buffer.concat(await Promise.all(cc.parts.map((p) => fsp.readFile(path.join(dir, 'out', p.name)))));
  check('copyChunked: 3 parts, sizes, content identical', cc.parts.length === 3 && cc.size === big.length && partsBytes.equals(big) && cc.parts[0].name.endsWith('0000.part'), cc);
  const cw = await call('fa:rawfs:copyChunked', { src: path.join(dir, 'big.db'), dst: path.join(dir, 'whole.db') }); check('copyChunked without partBytes copies the whole file', cw.parts.length === 1 && (await fsp.readFile(path.join(dir, 'whole.db'))).equals(big), cw);
  await call('fa:rawfs:remove', { path: dir, recursive: true }); let gone = false; try { await fsp.stat(dir); } catch (_) { gone = true; } check('remove (recursive)', gone);
  check('rawFsPath strips the quotes the AI adds' + (process.platform === 'win32' ? ' and collapses doubled backslashes' : ''), ext.rawFsPath("\"C:\\\\Users\\\\x\"") === (process.platform === 'win32' ? "C:\\Users\\x" : "C:\\\\Users\\\\x"), ext.rawFsPath("\"C:\\\\Users\\\\x\""));
  const dr = await call('fa:rawfs:listDrives'); check('listDrives returns at least one', Array.isArray(dr) && dr.length >= 1, dr);
  // coding_edit／coding_patch_tool／CI HTTP 的註冊（2026-10-14 搬進 main-ext.js）：完整 ctx 與「舊版 main.js 的 ctx（只有 fs、path）」兩種
  {
    const h2 = new Map(); const ipc2 = { handle: (ch, fn) => h2.set(ch, fn) }; let gated = 0;
    require('../../main-ext.js').register(ipc2, { fs: fsp, path, execConfirmGate: async () => { gated++; }, net: null, dialog: { showMessageBox: async () => ({ response: 0 }) }, BrowserWindow: null });
    check('完整 ctx：三個 IPC 都註冊了', ['fa:codingtools:edit', 'fa:codingtools:script', 'fa:ci:fetch'].every((n) => h2.has(n)), [...h2.keys()]);
    const d2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'mainext2-')); await fsp.writeFile(path.join(d2, 'a.txt'), 'one\ntwo\n');
    const er = await h2.get('fa:codingtools:edit')({}, { cwdAbs: d2, edits: [{ path: 'a.txt', search: 'two', replace: '2' }] }); check('coding_edit 經由 main-ext 註冊的 IPC 可用', er.ok && er.applied && (await fsp.readFile(path.join(d2, 'a.txt'), 'utf8')) === 'one\n2\n', er);
    const sr = await h2.get('fa:codingtools:script')({ sender: { id: 1 } }, { cwdAbs: d2, name: 'x', language: 'node', code: '1' }); check('script 會先經過確認閘（非工作區會被擋，但閘門沒被繞過）', !sr.ok && /工作區/.test(sr.error || ''), sr);
    const h3 = new Map(); const ipc3 = { handle: (ch, fn) => h3.set(ch, fn) };
    require('../../main-ext.js').register(ipc3, { fs: fsp, path });
    const old = await h3.get('fa:codingtools:script')({ sender: { id: 1 } }, { cwdAbs: d2, name: 'x', language: 'node', code: "require('fs').writeFileSync('pwned','1')" });
    check('舊版 main.js（沒有確認閘）：script 一律拒絕、沒有執行', !old.ok && /新版主程式/.test(old.error || '') && !require('fs').existsSync(path.join(d2, 'pwned')), old);
    const oc = await h3.get('fa:ci:fetch')({}, { url: 'http://127.0.0.1:1/', method: 'POST' }); check('舊版 main.js（沒有對話框）：CI 的 HTTP 拒絕', !oc.ok && /新版主程式/.test(oc.error || ''), oc);
    await fsp.rm(d2, { recursive: true, force: true });
  }
  // ---- 下載：will-download 由程式接管（不跳系統另存新檔）
  {
    const EventEmitter = require('events'); const sess = new EventEmitter(); const hs = new Map(); const ipc2 = { handle: (ch, fn) => hs.set(ch, fn) };
    const dl = await fsp.mkdtemp(path.join(os.tmpdir(), 'dlt-')); const other = path.join(dl, 'picked');
    const electron = { app: { isReady: () => true, getPath: (n) => (n === 'downloads' ? dl : os.tmpdir()), whenReady: () => Promise.resolve() }, shell: { showItemInFolder: () => {} }, session: { defaultSession: sess } };
    require('../../main-ext.js').register(ipc2, { fs: fsp, path, electron });
    check('download IPC handlers registered', ['fa:download:defaultDir', 'fa:download:setNext', 'fa:download:reveal'].every((c) => hs.has(c)));
    const mkItem = (name) => { const it = new EventEmitter(); it.getFilename = () => name; it.setSavePath = (p) => { it.savePath = p; }; it.getReceivedBytes = () => 123; return it; };
    const sent = []; const wc = { send: (ch, info) => sent.push([ch, info]) };
    const it1 = mkItem('project-wiki-sqlite.html'); sess.emit('will-download', {}, it1, wc);
    check('default: saved to the downloads folder without a dialog', it1.savePath === path.join(dl, 'project-wiki-sqlite.html'), it1.savePath);
    await fsp.writeFile(it1.savePath, 'x'); it1.emit('done', {}, 'completed');
    check('renderer is told where it was saved', sent.length === 1 && sent[0][0] === 'fa:download:done' && sent[0][1].state === 'completed' && sent[0][1].path === it1.savePath, sent);
    const it2 = mkItem('project-wiki-sqlite.html'); sess.emit('will-download', {}, it2, wc);
    check('same name gets (1)', it2.savePath === path.join(dl, 'project-wiki-sqlite (1).html'), it2.savePath);
    await hs.get('fa:download:setNext')({}, { dir: other }); const it3 = mkItem('a.zip'); sess.emit('will-download', {}, it3, wc);
    check('setNext: next download goes to the chosen folder (created if missing), once', it3.savePath === path.join(other, 'a.zip') && require('fs').existsSync(other), it3.savePath);
    const it4 = mkItem('b.zip'); sess.emit('will-download', {}, it4, wc); check('only the next download uses it', it4.savePath === path.join(dl, 'b.zip'), it4.savePath);
    const it5 = mkItem('..\\..\\evil:name?.txt'); sess.emit('will-download', {}, it5, wc); check('hostile file name is made safe', path.dirname(it5.savePath) === dl && !/[:?]/.test(path.basename(it5.savePath)), it5.savePath);
    await fsp.rm(dl, { recursive: true, force: true });
  }
  console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'main_ext: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXC', e && e.stack || e); process.exit(1); });
