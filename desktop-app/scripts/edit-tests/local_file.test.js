// node scripts/edit-tests/local_file.test.js -- 本機檔案綁定核心：開檔、存回、外部修改衝突、讀回驗證、web 控制代碼、路徑辨識
const L = require('../../renderer/src/edit/local_file.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const enc = (s) => new TextEncoder().encode(s), dec = (b) => new TextDecoder().decode(b);
// 假的桌面檔案系統（可以注入「寫壞」與「外部修改」）
function fakeDesk() { const files = new Map(); let clock = 1000, corrupt = 0; return { files, tick() { clock += 10; return clock; }, corruptNext(n) { corrupt = n; },
  stat: async (p) => { const f = files.get(p); if (!f) { const e = new Error('ENOENT'); throw e; } return { isDirectory: false, size: f.bytes.length, mtimeMs: f.mtimeMs }; }, read: async (p) => { const f = files.get(p); if (!f) { throw new Error('ENOENT'); } return f.bytes; },
  write: async (p, bytes) => { clock += 10; files.set(p, { bytes: corrupt-- > 0 ? bytes.slice(0, Math.max(0, bytes.length - 1)) : bytes, mtimeMs: clock }); } }; }
function fakeWeb() { const files = new Map(); let clock = 5000, allow = true; return { files, set allow(v) { allow = v; }, external(h, text) { clock += 10; files.set(h, { bytes: enc(text), mtimeMs: clock, name: h.name }); },
  pick: async () => { const h = { name: 'a.txt', id: 'h1' }; files.set(h, { bytes: enc('web 原文'), mtimeMs: clock, name: h.name }); return h; }, pickSave: async (o) => { const h = { name: (o && o.suggestedName) || 'new.txt', id: 'h2' }; files.set(h, { bytes: new Uint8Array(0), mtimeMs: clock, name: h.name }); return h; },
  file: async (h) => { const f = files.get(h); return { bytes: f.bytes, size: f.bytes.length, mtimeMs: f.mtimeMs, name: f.name }; }, write: async (h, bytes) => { clock += 10; files.set(h, { bytes: bytes, mtimeMs: clock, name: h.name }); }, allowed: async () => allow }; }
(async () => {
  check('路徑辨識', L.looksLikePath('/home/a/b.csv') && L.looksLikePath('C:\\Users\\a\\b.docx') && L.looksLikePath('"D:/x/y.md"') && L.looksLikePath('~/doc/a.txt') && L.looksLikePath('\\\\srv\\share\\a.csv') && !L.looksLikePath('notes.md') && !L.looksLikePath('/') && !L.looksLikePath('把第 2 段改成 /x') && !L.looksLikePath('a/b'));
  check('hash 對內容敏感且穩定', L.hash(enc('abc')) === L.hash(enc('abc')) && L.hash(enc('abc')) !== L.hash(enc('abd')) && L.hash(new Uint8Array(0)) === L.hash(new Uint8Array(0)));
  // ── 桌面
  const d = fakeDesk(); d.files.set('/t/a.csv', { bytes: enc('a,b\n1,2\n'), mtimeMs: 1 }); const lf = L.create({ desk: d });
  check('支援情況', lf.supported().desktop === true && lf.supported().web === false);
  const o = await lf.bindDesktop('"/t/a.csv"'); check('開檔並綁定', dec(o.bytes) === 'a,b\n1,2\n' && o.binding.via === 'desktop' && o.binding.name === 'a.csv' && o.binding.path === '/t/a.csv' && o.binding.size === 8);
  let s = await lf.save(o.binding, 'k', enc('a,b\n1,3\n')); check('存回', s.ok && dec(d.files.get('/t/a.csv').bytes) === 'a,b\n1,3\n' && s.binding.hash === L.hash(enc('a,b\n1,3\n')) && s.binding.mtimeMs !== o.binding.mtimeMs);
  let b = s.binding; s = await lf.save(b, 'k', enc('x\n')); check('連續存回（用上次的綁定）', s.ok && dec(d.files.get('/t/a.csv').bytes) === 'x\n'); b = s.binding;
  d.files.set('/t/a.csv', { bytes: enc('外面改的'), mtimeMs: d.tick() }); s = await lf.save(b, 'k', enc('我的')); check('外部修改：不覆蓋、回報衝突', !s.ok && s.conflict === true && dec(d.files.get('/t/a.csv').bytes) === '外面改的');
  s = await lf.save(b, 'k', enc('我的'), { force: true }); check('確認後強制覆蓋', s.ok && dec(d.files.get('/t/a.csv').bytes) === '我的'); b = s.binding;
  d.files.set('/t/a.csv', { bytes: enc('我的'), mtimeMs: d.tick() }); check('只有修改時間變、內容沒變：不算被改過', (await lf.check(b, 'k')).changed === false);
  const r = await lf.read(b, 'k'); check('重新載入', dec(r.bytes) === '我的' && r.binding.mtimeMs === d.files.get('/t/a.csv').mtimeMs);
  d.files.delete('/t/a.csv'); const c2 = await lf.check(b, 'k'); check('檔案被刪掉：回報 missing，不當成衝突', c2.missing === true && c2.changed === false); s = await lf.save(b, 'k', enc('復活')); check('檔案被刪掉時存回會重新建立', s.ok && dec(d.files.get('/t/a.csv').bytes) === '復活');
  d.corruptNext(1); b = s.binding; s = await lf.save(b, 'k', enc('0123456789')); check('寫入被截斷：自動重寫一次並通過檢查', s.ok && dec(d.files.get('/t/a.csv').bytes) === '0123456789');
  d.corruptNext(2); s = await lf.save(s.binding, 'k', enc('abcdef')); check('連續寫壞：回報錯誤不假裝成功', !s.ok && /讀回來/.test(s.error), s);
  let sa = await lf.saveAsDesktop('/t/new.txt', enc('hello')); check('另存新檔並綁定', sa.ok && sa.binding.path === '/t/new.txt' && dec(d.files.get('/t/new.txt').bytes) === 'hello');
  sa = await lf.saveAsDesktop('/t/new.txt', enc('again')); check('另存到已存在的檔案：先問（exists）', sa.ok === false && sa.exists === true && dec(d.files.get('/t/new.txt').bytes) === 'hello'); sa = await lf.saveAsDesktop('/t/new.txt', enc('again'), { overwrite: true }); check('同意後覆蓋', sa.ok && dec(d.files.get('/t/new.txt').bytes) === 'again');
  let e = ''; try { await lf.bindDesktop('/t/none.txt'); } catch (x) { e = x.message; } check('開不存在的檔案：丟錯誤', /ENOENT/.test(e));
  // ── Web
  const w = fakeWeb(), store = new Map(); const lw = L.create({ web: w, store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } } });
  check('web 支援', lw.supported().web === true && lw.supported().desktop === false);
  const wo = await lw.bindWeb('k1'); check('web：選檔並綁定、控制代碼存起來', dec(wo.bytes) === 'web 原文' && wo.binding.via === 'web' && store.has('k1'));
  let ws = await lw.save(wo.binding, 'k1', enc('web 新')); check('web：存回', ws.ok && dec((await lw.read(ws.binding, 'k1')).bytes) === 'web 新');
  w.external(store.get('k1'), '外部'); ws = await lw.save(ws.binding, 'k1', enc('衝突')); check('web：外部修改衝突', !ws.ok && ws.conflict);
  w.allow = false; ws = await lw.save(wo.binding, 'k1', enc('x'), { force: true }); check('web：沒有寫入權限：說清楚', !ws.ok && /權限/.test(ws.error), ws); w.allow = true;
  const wsa = await lw.saveAsWeb('k2', enc('另存'), { suggestedName: 'out.txt' }); check('web：另存並綁定', wsa.ok && wsa.binding.name === 'out.txt' && store.has('k2'));
  store.delete('k1'); ws = await lw.save(wo.binding, 'k1', enc('y')); check('控制代碼不見：說清楚要重新綁定', !ws.ok && /重新綁定/.test(ws.error), ws);
  console.log('local_file: ' + ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '：\n  ' + bad.join('\n  ') : '')); process.exit(bad.length ? 1 : 0);
})();
