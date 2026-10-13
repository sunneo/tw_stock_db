'use strict';
// coding-edit.js 的測試：editing 規則＋「產生的 diff 用真的 git apply 套回去要得到一模一樣的檔案」的隨機測試
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const E = require('../coding-edit.js');
let ok = 0; const bad = []; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n + ': ' + e.message); } };
const F = (o) => o;

t('search/replace：唯一就改', () => { const r = E.applyEdits(F({ 'a.c': 'int a;\nint b;\n' }), [{ path: 'a.c', search: 'int b;', replace: 'long b;' }]); assert.ok(r.ok); assert.strictEqual(r.files['a.c'], 'int a;\nlong b;\n'); });
t('出現多次：拒絕並列出行號；all+expect 才改', () => {
  const src = 'x = 1\ny = 1\nz = 1\n';
  const r = E.applyEdits(F({ 'a.py': src }), [{ path: 'a.py', search: '= 1', replace: '= 2' }]); assert.ok(!r.ok); assert.deepStrictEqual(r.errors[0].lines, [1, 2, 3]);
  assert.ok(!E.applyEdits(F({ 'a.py': src }), [{ path: 'a.py', search: '= 1', replace: '= 2', all: true, expect: 2 }]).ok);
  const r2 = E.applyEdits(F({ 'a.py': src }), [{ path: 'a.py', search: '= 1', replace: '= 2', all: true, expect: 3 }]); assert.strictEqual(r2.files['a.py'], 'x = 2\ny = 2\nz = 2\n');
});
t('找不到：回傳最接近的實際內容', () => {
  const r = E.applyEdits(F({ 'a.c': 'int main(void) {\n    return compute(1, 2);\n}\n' }), [{ path: 'a.c', search: 'return compute(1,2);', replace: 'return 0;' }]);
  assert.ok(!r.ok); assert.ok(r.errors[0].closest && /compute/.test(r.errors[0].closest.actual)); assert.ok(/照實際內容/.test(r.errors[0].hint));
});
t('忽略行尾空白', () => {
  const r = E.applyEdits(F({ 'a.js': 'function f() {   \n  go();\n}\n' }), [{ path: 'a.js', search: 'function f() {\n  go();', replace: 'function f() {\n  stop();' }]);
  assert.ok(r.ok, JSON.stringify(r.errors)); assert.strictEqual(r.files['a.js'], 'function f() {\n  stop();\n}\n'); assert.ok(r.changes[0].fuzzy.includes('忽略行尾空白'));
});
t('忽略縮排時 replace 跟著縮排', () => {
  const r = E.applyEdits(F({ 'a.py': 'def f():\n    a = 1\n    b = 2\n' }), [{ path: 'a.py', search: 'a = 1\nb = 2', replace: 'a = 10\nb = 20' }]);
  assert.ok(r.ok); assert.strictEqual(r.files['a.py'], 'def f():\n    a = 10\n    b = 20\n'); assert.ok(r.changes[0].fuzzy.includes('忽略縮排'));
});
t('CRLF 檔案：search/replace 用 LF 寫也能改，結果維持 CRLF', () => {
  const r = E.applyEdits(F({ 'a.c': 'a\r\nb\r\nc\r\n' }), [{ path: 'a.c', search: 'b\nc', replace: 'B\nC' }]); assert.ok(r.ok); assert.strictEqual(r.files['a.c'], 'a\r\nB\r\nC\r\n');
});
t('insert_after／insert_before／create／delete', () => {
  const r = E.applyEdits(F({ 'a.c': '#include <a.h>\nint x;\n', 'old.c': 'zzz\n', 'n.c': null }), [
    { path: 'a.c', insert_after: '#include <a.h>', text: '#include <b.h>' }, { path: 'a.c', insert_before: 'int x;', text: '// the x' },
    { path: 'n.c', create: 'new\n' }, { path: 'old.c', delete: true }]);
  assert.ok(r.ok, JSON.stringify(r.errors)); assert.strictEqual(r.files['a.c'], '#include <a.h>\n#include <b.h>\n// the x\nint x;\n'); assert.strictEqual(r.files['n.c'], 'new\n'); assert.strictEqual(r.files['old.c'], null);
  assert.deepStrictEqual(r.changes.map((c) => c.kind).sort(), ['create', 'delete', 'modify']);
});
t('all-or-nothing：任何一個編輯失敗，全部都不改', () => {
  const r = E.applyEdits(F({ 'a.c': 'a\n', 'b.c': 'b\n' }), [{ path: 'a.c', search: 'a', replace: 'A' }, { path: 'b.c', search: 'nope', replace: 'x' }]);
  assert.ok(!r.ok); assert.deepStrictEqual(r.files, {}); assert.strictEqual(r.errors.length, 1); assert.strictEqual(r.errors[0].index, 1);
});
t('路徑防護', () => { for (const p of ['../x', '/etc/passwd', 'C:/x', '.git/config']) assert.ok(!E.applyEdits(F({}), [{ path: p, create: 'x' }]).ok, p); });
t('create 不覆蓋已存在檔案（除非 overwrite）', () => { assert.ok(!E.applyEdits(F({ 'a': 'x' }), [{ path: 'a', create: 'y' }]).ok); assert.ok(E.applyEdits(F({ 'a': 'x' }), [{ path: 'a', create: 'y', overwrite: true }]).ok); });
t('regexEdits：跨檔、expect_count、$1', () => {
  const files = { 'a.c': 'foo(1); foo(2);\n', 'b.c': 'foo(3);\nbar(4);\n', 'c.c': 'none\n' };
  const r = E.regexEdits(files, { pattern: 'foo\\((\\d)\\)', replacement: 'baz($1)', expect_count: 3, expect_files: 2 }); assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.files['a.c'], 'baz(1); baz(2);\n'); assert.ok(!('c.c' in r.files));
  assert.ok(!E.regexEdits(files, { pattern: 'foo', replacement: 'x', expect_count: 99 }).ok); assert.ok(!E.regexEdits(files, { pattern: '(' , replacement: '' }).ok); assert.ok(!E.regexEdits(files, { pattern: 'nomatch', replacement: '' }).ok);
});

// 隨機測試：diff → 真的 git apply → 要得到新內容
function rnd(n) { return Math.floor(Math.random() * n); }
const vocab = ['int a;', 'int b;', '', '}', '{', 'return 0;', '    x = 1;', '# comment', 'foo(bar);', '  ', 'end'];
const mk = (n) => Array.from({ length: n }, () => vocab[rnd(vocab.length)]);
function mutate(lines) { const o = lines.slice(); const k = rnd(4) + 1; for (let i = 0; i < k; i++) { const op = rnd(3), at = rnd(o.length + 1); if (op === 0) o.splice(at, 0, ...mk(rnd(3) + 1)); else if (op === 1 && o.length) o.splice(at % o.length, rnd(2) + 1); else if (o.length) o[at % o.length] = vocab[rnd(vocab.length)]; } return o; }
t('隨機 diff 用 git apply 還原（300 組：含空檔、結尾沒換行、新增、刪除）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-')); const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.email', 'a@b'); g('config', 'user.name', 'x'); g('config', 'core.autocrlf', 'false');
  let n = 0;
  for (let i = 0; i < 300; i++) {
    const a = mk(rnd(12)), b = mutate(a); const aNl = rnd(4) > 0, bNl = rnd(4) > 0;
    const oldT = a.length ? a.join('\n') + (aNl ? '\n' : '') : (rnd(5) === 0 ? null : '');
    let newT = b.length ? b.join('\n') + (bNl ? '\n' : '') : (rnd(5) === 0 ? null : '');
    if (oldT == null && newT == null) newT = 'x\n';
    const d = E.unifiedDiff('f.txt', oldT, newT); if (!d) { assert.strictEqual(oldT, newT); continue; }
    try { fs.rmSync(path.join(dir, 'f.txt'), { force: true }); } catch (_) {}
    if (oldT != null) fs.writeFileSync(path.join(dir, 'f.txt'), oldT);
    fs.writeFileSync(path.join(dir, 'p.patch'), d);
    try { g('apply', '--check', 'p.patch'); g('apply', 'p.patch'); } catch (e) { throw new Error('git apply 失敗（第 ' + i + ' 組）：' + String(e.stderr) + '\n' + JSON.stringify({ oldT, newT }) + '\n' + d); }
    const got = fs.existsSync(path.join(dir, 'f.txt')) ? fs.readFileSync(path.join(dir, 'f.txt'), 'utf8') : null;
    assert.strictEqual(got, newT, '內容不一致（第 ' + i + ' 組）\n' + d); n++;
  }
  fs.rmSync(dir, { recursive: true, force: true }); assert.ok(n > 200, 'n=' + n);
});
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
