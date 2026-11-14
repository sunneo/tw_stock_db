// node renderer/src/guitpl/yaml_core.test.js -- YAML 子集：JavaScript 與 Python 兩個實作對同一批樣本給出同樣的紀錄，寫錯時兩邊都報錯
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Y = require('./yaml_core.js');
let n = 0; const ok = () => { n++; };

const GOOD = [
  'kind: meta\nid: demo/hello\ntitle: 打招呼\nstandalone: true\nkeywords: [招呼, hello, "a, b"]\n',
  'kind: layout\nwindow: {title: "{{title}}", width: 320, resizable: true}\ntree:\n  - kind: column\n    children:\n      - id: hi\n        kind: label\n        text: 哈囉 # 這是註解\n      - id: b\n        kind: button\n        text: \'It\'\'s\'\n',
  'kind: style\npalette:\n  bg: "#ffffff"\n  fg: \'#222222\'\nsize: 14\nradius: 6.5\nfont: sans-serif\n',
  'kind: scene\nid: a\ntitle: 一\nshow: [x, y]\nhide: []\non: {"click:b": next}\n',
  '# 開頭註解\nkind: param\nname: n\ndefault: null\nask: ~\nflag: false\n',
  'kind: x\nitems:\n- a\n- b: 1\n  c: 2\n-\n  - nested\n  - [1, 2, {k: v}]\n',
  'kind: meta\nid: a\n---\nkind: param\nname: p\ndefault: "line\\nbreak"\n---\n\n---\nkind: shortcut\nkeys: Ctrl+S\ndo: save\n',
  'kind: x\nempty:\nneg: -3\nexp: 1e3\nurl: http://a.b/c\ntime: 12:30\n',
];
const BAD = [
  'kind: x\n\tbad: 1\n',
  'kind: x\nref: *alias\n',
  'kind: x\ntext: |\n  multi\n',
  'kind: x\na: 1\na: 2\n',
  'kind: x\n  odd: indent\n',
  '- just\n- a list\n',
  'kind: x\nlist: [1, 2\n',
  'kind: x\ns: "unterminated\n',
  'kind: x\n<<: {a: 1}\n',
];

// JavaScript 這邊
const jsGood = GOOD.map((t) => Y.parseDocuments(t));
assert.deepStrictEqual(jsGood[0][0], { kind: 'meta', id: 'demo/hello', title: '打招呼', standalone: true, keywords: ['招呼', 'hello', 'a, b'] }); ok();
assert.deepStrictEqual(jsGood[1][0].tree[0].children[1], { id: 'b', kind: 'button', text: "It's" }); ok();
assert.strictEqual(jsGood[1][0].tree[0].children[0].text, '哈囉'); ok();
assert.deepStrictEqual(jsGood[2][0].palette, { bg: '#ffffff', fg: '#222222' }); ok();
assert.strictEqual(jsGood[2][0].radius, 6.5); ok();
assert.deepStrictEqual(jsGood[3][0].on, { 'click:b': 'next' }); ok();
assert.deepStrictEqual(jsGood[4][0], { kind: 'param', name: 'n', default: null, ask: null, flag: false }); ok();
assert.deepStrictEqual(jsGood[5][0].items, ['a', { b: 1, c: 2 }, ['nested', [1, 2, { k: 'v' }]]]); ok();
assert.strictEqual(jsGood[6].length, 3); assert.strictEqual(jsGood[6][1].default, 'line\nbreak'); ok();
assert.deepStrictEqual(jsGood[7][0], { kind: 'x', empty: null, neg: -3, exp: 1000, url: 'http://a.b/c', time: '12:30' }); ok();
BAD.forEach((t) => { assert.throws(() => Y.parseDocuments(t), /./, t); ok(); });
assert.strictEqual(Y.toJsonl(GOOD[0]).trim().split('\n').length, 1); ok();

// Python 那邊：同一批樣本
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml_cmp_'));
fs.writeFileSync(path.join(dir, 'in.json'), JSON.stringify({ good: GOOD, bad: BAD }), 'utf8');
fs.writeFileSync(path.join(dir, 'run.py'), [
  'import json, sys',
  'sys.path.insert(0, ' + JSON.stringify(path.join(__dirname, '..', 'pybridge')) + ')',
  'import guitpl_yaml as Y',
  'd = json.load(open(' + JSON.stringify(path.join(dir, 'in.json')) + ', encoding="utf-8"))',
  'out = {"good": [Y.parse_documents(t) for t in d["good"]], "bad": []}',
  'for t in d["bad"]:',
  '    try:',
  '        Y.parse_documents(t)',
  '        out["bad"].append("no error")',
  '    except Y.YamlError:',
  '        out["bad"].append("error")',
  'open(' + JSON.stringify(path.join(dir, 'out.json')) + ', "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=True))', ''].join('\n'), 'utf8');
const r = cp.spawnSync('python', ['-I', path.join(dir, 'run.py')], { encoding: 'utf8' });
assert.strictEqual(r.status, 0, r.stderr);
const py = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
py.good.forEach((p, i) => { assert.deepStrictEqual(JSON.parse(JSON.stringify(jsGood[i])), p, '樣本 ' + i + ' 兩邊不一樣'); ok(); });
assert.deepStrictEqual(py.bad, BAD.map(() => 'error')); ok();
fs.rmSync(dir, { recursive: true, force: true });

console.log('yaml_core.test.js: ' + n + ' groups OK');
