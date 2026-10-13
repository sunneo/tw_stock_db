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
  console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'main_ext: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXC', e && e.stack || e); process.exit(1); });
