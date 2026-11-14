// node renderer/src/guitpl/guitpl_ai.test.js -- AI 檢索與組合：找範本、逐步問、組合成程式、自己寫的範本、離線字母選擇題；產出的程式用真 Python 檢查（prepare）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const A = require('./guitpl_ai.js');
let n = 0; const ok = () => { n++; };

const lib = path.join(__dirname, 'lib');
const files = {};
(function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { walk(p); } else if (/\.jsonl$/.test(d.name)) { files[path.relative(lib, p).replace(/\\/g, '/').replace(/\.jsonl$/, '')] = fs.readFileSync(p, 'utf8'); }
  });
}(lib));

function pyCheck(code) {
  // 把 run 換成 prepare：只做載入與相依檢查，不開視窗
  const src = 'import sys\nsys.path.insert(0, ' + JSON.stringify(path.join(__dirname, '..', 'pybridge').replace(/\\/g, '/')) + ')\n'
    + 'import guitpl\nguitpl.default_roots = lambda: [' + JSON.stringify(lib.replace(/\\/g, '/')) + ']\n'
    + code.replace('import guitpl\n', '').replace('guitpl.run(', 'guitpl.prepare(');
  const f = path.join(os.tmpdir(), 'guitpl_ai_' + process.pid + '.py');
  fs.writeFileSync(f, src, 'utf8');
  const r = cp.spawnSync('python', ['-I', f], { encoding: 'utf8' });
  fs.unlinkSync(f);
  return r;
}

// 找
const f1 = A.find(files, '幫我做一個待辦清單');
assert.ok(f1.candidates.length > 0 && f1.candidates[0].id.indexOf('office/') === 0, JSON.stringify(f1.candidates[0])); ok();
assert.ok(f1.candidates[0].questions.length > 0); ok();
assert.strictEqual(A.find(files, '完全不相干的事情').status, 'none'); ok();
assert.ok(A.find(files, '完全不相干的事情').hint.indexOf('jsonl') >= 0); ok();

// 離線字母題
const m = A.menu([{ id: 'a/x', title: 'X' }, { id: 'b/y', title: 'Y' }]);
assert.strictEqual(A.letterToId(m, ' b. '), 'b/y'); ok();
assert.strictEqual(A.letterToId(m, 'Z'), null); ok();
assert.strictEqual(A.letterToId(m, '我選第一個'), null); ok();

// 組合現成範本
const c1 = A.compose(files, { id: 'office/main', params: { title: '我的清單' } });
assert.ok(c1.ok, c1.errors && c1.errors.join()); ok();
assert.ok(c1.code.indexOf('guitpl.run("office/main"') >= 0 && c1.defaulted.indexOf('owner') >= 0); ok();
assert.ok(c1.scenes.length >= 2); ok();
let r = pyCheck(c1.code);
assert.strictEqual(r.status, 0, r.stderr); ok();

// 錯誤
assert.ok(!A.compose(files, { id: 'no/such' }).ok); ok();
assert.ok(A.compose(files, { id: 'office/main', params: { nope: 1 } }).errors[0].indexOf('沒有參數') >= 0); ok();

// 模型自己寫的範本（含 py）
const custom = [
  '{"kind":"meta","id":"user/hello","title":"打招呼","keywords":["招呼"],"standalone":true}',
  '{"kind":"param","name":"who","default":"世界","ask":"跟誰打招呼？"}',
  '{"kind":"require","module":"gui","source":"builtin"}',
  '{"kind":"layout","window":{"title":"hi","width":300},"tree":[{"kind":"column","children":[{"id":"t","kind":"label","text":"哈囉 {{who}}"}]}]}'
].join('\n');
const c2 = A.compose(files, { name: 'user/hello', jsonl: custom, params: { who: '你' } });
assert.ok(c2.ok && c2.custom, c2.errors && c2.errors.join()); ok();
assert.ok(c2.code.indexOf('roots=[_d]') >= 0); ok();
r = pyCheck(c2.code);
assert.strictEqual(r.status, 0, r.stderr); ok();
assert.ok(!A.compose(files, { name: 'Bad Name', jsonl: custom }).ok); ok();
assert.ok(!A.compose(files, { name: 'user/x', jsonl: '{bad' }).ok); ok();
assert.ok(!A.compose(files, { name: 'user/x', jsonl: '{"kind":"meta","id":"x","title":"t"}' }).ok, '沒標 standalone 不能直接執行'); ok();

// 分鏡與使用者範本
assert.ok(c1.storyboard.indexOf('分鏡：') === 0 && c1.storyboard.indexOf('換到 list') >= 0, c1.storyboard); ok();
const mine = '{"kind":"meta","id":"user/my_todo","title":"我的待辦","keywords":["我的待辦","待辦","待辦清單"],"extends":"office/main","standalone":true}\n{"kind":"require","module":"guitpl","source":"builtin"}';
const withUser = Object.assign({}, files, { 'user/my_todo': mine });
const fu = A.find(withUser, "我的待辦清單", { userIds: ['user/my_todo'] });
assert.ok(fu.candidates[0].user === true && fu.candidates[0].id === 'user/my_todo', JSON.stringify(fu.candidates.map((x) => [x.id, x.score]))); ok();
const fn = A.find(withUser, '完全不相干的事情', { userIds: ['user/my_todo'] });
assert.ok(fn.status === 'none' && fn.references.length === 1 && fn.references[0].id === 'user/my_todo'); ok();
const cu = A.compose(withUser, { id: 'user/my_todo' }, { userFiles: { 'user/my_todo': { jsonl: mine, py: 'x' } } });
assert.ok(cu.ok && cu.code.indexOf('_w("user/my_todo", ".jsonl"') >= 0 && cu.code.indexOf('roots=[_d]') >= 0, cu.errors && cu.errors.join()); ok();

console.log('guitpl_ai.test.js: ' + n + ' groups OK');
