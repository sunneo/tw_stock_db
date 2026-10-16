// node renderer/src/catalog/extract_js.test.js
const acorn = require('acorn'); const fs = require('fs'); const path = require('path');
const Cat = require('./catalog_core.js'); const X = require('./extract_js.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };
const parse = (src, onComment) => { const o = { ecmaVersion: 'latest', locations: false, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, onComment }; try { return acorn.parse(src, Object.assign({ sourceType: 'script' }, o)); } catch (_) { return acorn.parse(src, Object.assign({ sourceType: 'module' }, o)); } };
const ex = (src, o) => X.extract(src, Object.assign({ parse, pkg: 'lib' }, o || {}));
const byName = (r) => Object.fromEntries(r.units.map((u) => [u.name.replace(/^lib\./, ''), u]));

// ---- JSDoc ----
const d = X.parseJsDoc('*\n * Resize an image.\n * Keeps the aspect ratio.\n * @param {number} width target width\n * @param {string} [mode=fit] how\n * @param {Array<string>|string} names\n * @returns {Promise<Blob>} the result\n');
check('jsdoc summary', d.summary === 'Resize an image. Keeps the aspect ratio.', d.summary);
check('jsdoc params', d.params.width.type === 'number' && d.params.mode.optional && d.params.names.type === 'Array<string>|string', d.params);
check('jsdoc returns', d.returns.type === 'Promise<Blob>');
check('jsdoc private/deprecated', X.parseJsDoc('* @private').isPrivate && X.parseJsDoc('* @deprecated use x').deprecated);
const T = X.jsDocType;
check('jsdoc types', T('number') === 'number' && T('string') === 'text' && T('boolean') === 'bool' && T('Array<number>') === 'list<number>' && T('string[]') === 'list<text>' && T('Object') === 'dict' && T('Function') === 'callable' && T('*') === 'any' && T('Uint8Array') === 'bytes' && T('HTMLCanvasElement') === 'any' && T('Promise<string>') === 'text', [T('number'), T('string[]'), T('Promise<string>')]);
check('jsdoc union / nullable', T('string|null') === 'text' && T('number|string') === 'union<number|text>' && T('?number') === 'number' && T('a|b|c|d') === 'any', [T('number|string')]);
check('jsdoc types are valid catalog types', ['Array<Array<number>>', 'string|number', 'Map', 'Foo'].every((t) => { try { Cat.parseType(T(t)); return true; } catch (_) { return false; } }));

// ---- ES module ----
let r = ex('/** Add two numbers. */\nexport function add(a, b = 2) { return a + b; }\nexport const mul = (x, y) => x * y;\nfunction hidden() {}\nexport default function main(opts) { return opts; }\nexport class Box { constructor(w) { this.w = w; } area() { return this.w * this.w; } static make() { return new Box(1); } _secret() {} }');
let b = byName(r);
check('esm exports found', r.ok && ['add', 'mul', 'default', 'Box.new', 'Box.area', 'Box.make'].every((k) => b[k]) && !b.hidden && !b['Box._secret'], Object.keys(b));
check('esm default value makes the param optional with a type', b.add.params[1].required === false && b.add.params[1].type === 'int' && b.add.params[1].type_src === 'default' && b.add.params[0].required === true);
check('esm summary from jsdoc', b.add.summary === 'Add two numbers.');
check('class method touching this is impure', b['Box.area'].pure === false || b['Box.area'].effects.length > 0, b['Box.area']);
check('constructor unit marked', b['Box.new'].call.ctor === true && b['Box.new'].params[0].name === 'w');
check('static method marked', b['Box.make'].call.method === undefined);
check('pure arithmetic function', b.mul.pure === true && b.mul.effects.length === 0 && b.mul.pure_src === 'static' && b.mul.tier === 0);

// ---- CommonJS ----
r = ex("const fs = require('fs');\nfunction readIt(p) { return fs.readFileSync(p, 'utf8'); }\nfunction saveIt(p, s) { fs.writeFileSync(p, s); }\nfunction fetchIt(u) { return fetch(u); }\nmodule.exports = { readIt, saveIt, fetchIt, inline: function (x) { return x; } };");
b = byName(r);
check('cjs object export', ['readIt', 'saveIt', 'fetchIt', 'inline'].every((k) => b[k]), Object.keys(b));
check('cjs effects: fs.read / fs.write / net', b.readIt.effects.join() === 'fs.read' && b.saveIt.effects.join() === 'fs.write' && b.fetchIt.effects.join() === 'net', [b.readIt.effects, b.saveIt.effects, b.fetchIt.effects]);
r = ex('exports.sum = function (a, b) { return a + b; };\nmodule.exports.neg = (x) => -x;');
check('cjs exports.x = …', byName(r).sum && byName(r).neg, Object.keys(byName(r)));
r = ex('function only(x) { return x; }\nmodule.exports = only;');
check('cjs module.exports = fn', byName(r).default && byName(r).default.params[0].name === 'x');

// ---- UMD（包含這個專案自己的 ir_core.js：真實的 UMD 檔案）----
r = ex("(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Lib = factory(); })(this, function () {\n  /** Square it. @param {number} x @returns {number} */\n  function square(x) { return x * x; }\n  function now() { return Date.now(); }\n  function helper(x) { return now() + x; }\n  return { square, helper, other: function (a) { return a; } };\n});");
b = byName(r);
check('umd factory return object', ['square', 'helper', 'other'].every((k) => b[k]) && !b.now, Object.keys(b));
check('umd typed from jsdoc', b.square.params[0].type === 'number' && b.square.params[0].type_src === 'doc' && b.square.returns.type === 'number' && b.square.summary === 'Square it.');
check('effects follow the call chain', b.helper.effects.join() === 'time' && /經由 now/.test((b.helper.effect_evidence || []).join(' ')), b.helper);
const irSrc = fs.readFileSync(path.join(__dirname, 'ir_core.js'), 'utf8'); r = X.extract(irSrc, { parse, pkg: 'ir' });
check('real UMD file (ir_core.js) exports its API', r.ok && ['validate', 'run', 'fromPath', 'toText', 'parsePath'].every((k) => r.exports.includes(k)), r.exports);
const catSrc = fs.readFileSync(path.join(__dirname, 'catalog_core.js'), 'utf8'); const rc = X.extract(catSrc, { parse, pkg: 'cat' });
check('real UMD file (catalog_core.js) finds many exports', rc.ok && rc.units.length >= 10, rc.stats);
check('every extracted unit validates as a catalog unit', [].concat(r.units, rc.units).every((u) => Cat.validateUnit(u).length === 0), [].concat(r.units, rc.units).filter((u) => Cat.validateUnit(u).length).slice(0, 3).map((u) => [u.id, Cat.validateUnit(u)]));

// ---- 瀏覽器全域指令稿與 prototype ----
r = ex('function Camera(el) { this.el = el; }\nCamera.prototype.snap = function (w, h) { var c = document.createElement("canvas"); return c.toDataURL(); };\nCamera.prototype.start = function () { return navigator.mediaDevices.getUserMedia({ video: true }); };\nfunction applyFilter(img, amount) { var c = img.getContext("2d"); c.fillRect(0, 0, 1, 1); }\nfunction _internal() {}');
b = byName(r);
check('global script: top-level functions are the API', b.applyFilter && b.Camera && !b._internal, Object.keys(b));
check('prototype methods', b['Camera.snap'] && b['Camera.start'], Object.keys(b));
check('dom → ui, camera → desktop', b['Camera.snap'].effects.includes('ui') && b['Camera.start'].effects.includes('desktop') && b.applyFilter.effects.includes('ui'), [b['Camera.snap'].effects, b['Camera.start'].effects]);

// ---- 其他 ----
r = ex('export function f(...rest) {}\nexport function g({ a, b }, [c], d = {}) {}\nexport async function h() { return 1; }');
b = byName(r);
check('rest params are skipped; destructuring becomes options/arg', b.f.params.length === 0 && b.g.params[0].name === 'options' && b.g.params[0].type === 'dict' && b.g.params[1].name === 'arg2' && b.g.params[2].required === false, b.g.params);
check('async flagged', b.h.call.async === true);
r = ex('export function danger(code) { return eval(code); }\nexport function rnd() { return Math.random(); }\nexport function store(k, v) { localStorage.setItem(k, v); }\nexport function run(c) { return require("child_process").exec(c); }');
b = byName(r);
check('eval → unknown; random; storage; proc', b.danger.effects.join() === 'unknown' && b.rnd.effects.join() === 'random' && b.store.effects.join() === 'state.write' && b.run.effects.includes('proc'), [b.danger.effects, b.run.effects]);
r = ex('/** @private */\nexport function p() {}\n/** Public. */\nexport function q() {}');
check('@private skipped', byName(r).q && !byName(r).p);
check('syntax error is reported, not thrown', ex('function (').ok === false && /語法/.test(ex('function (').error));
check('missing parser is an error', (() => { try { X.extract('x', {}); return false; } catch (_) { return true; } })());
check('name-based type for params', byName(ex('export function open(url, filePath) {}')).open.params.map((p) => p.type).join() === 'url,path', byName(ex('export function open(url, filePath) {}')).open.params);
check('unit ids are stable and prefixed', byName(ex('export function z() {}', { pkg: 'my-lib' })).z === undefined && ex('export function z() {}', { pkg: 'my-lib' }).units[0].id === 'js:my-lib.z');
check('stats', r.stats.units === 1 || r.stats.units >= 1);

console.log('extract_js: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED' : '')); bad.forEach((x) => console.log('FAIL', x)); process.exit(bad.length ? 1 : 0);
