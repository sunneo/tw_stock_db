'use strict';
// tree-sitter 文法取得順序與核對（純函式，不連網）。node renderer/src/behavior/ts_assets.test.js
const assert = require('assert'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const A = require('./ts_assets_core.js'); let n = 0; const t = (name, fn) => { fn(); n++; };
t('MD5 與 node crypto 一致（空、短、64 邊界前後、隨機大小）', () => {
    for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 65537]) { const b = crypto.randomBytes(len); assert.strictEqual(A.md5(b), crypto.createHash('md5').update(b).digest('hex'), 'len ' + len); }
    assert.strictEqual(A.md5(Buffer.from('')), 'd41d8cd98f00b204e9800998ecf8427e'); assert.strictEqual(A.md5(Buffer.from('abc')), '900150983cd24fb0d6963f7d28e17f72');
});
t('核對表十種語言齊全，欄位格式正確', () => {
    assert.deepStrictEqual(Object.keys(A.TABLE).sort(), ['bash', 'c', 'c_sharp', 'cpp', 'go', 'java', 'javascript', 'python', 'ruby', 'rust']);
    for (const k of Object.keys(A.TABLE)) { assert.ok(/^[0-9a-f]{32}$/.test(A.TABLE[k].md5) && A.TABLE[k].bytes > 100000, k); }
});
t('網址釘住完整 commit；快取鍵含 commit 前八碼', () => {
    assert.strictEqual(A.COMMIT.length, 40); const s = A.sources('java'); assert.strictEqual(s[0].url, 'https://raw.githubusercontent.com/sunneo/tw_stock_db/' + A.COMMIT + '/grammars/tree-sitter-java.wasm');
    assert.ok(A.cacheKey('java').includes('@' + A.COMMIT.slice(0, 8))); assert.notStrictEqual(A.cacheKey('java'), A.cacheKey('c'));
});
t('來源順序：python＝內建→分支→jsdelivr；其他＝分支→jsdelivr；ruby 的 jsdelivr 用 0.1.6；沒有核對表的語言只剩 jsdelivr', () => {
    assert.deepStrictEqual(A.sources('python').map((x) => x.kind), ['bundled', 'branch', 'jsdelivr']); assert.strictEqual(A.sources('python')[0].url, './vendor/tree-sitter/tree-sitter-python.wasm');
    assert.deepStrictEqual(A.sources('go').map((x) => x.kind), ['branch', 'jsdelivr']);
    assert.ok(/tree-sitter-wasms@0\.1\.6\//.test(A.sources('ruby')[1].url)); assert.ok(/tree-sitter-wasms@0\.1\.11\//.test(A.sources('c')[1].url));
    assert.deepStrictEqual(A.sources('lua').map((x) => x.kind), ['jsdelivr']); assert.strictEqual(A.verify('lua', Buffer.from('x')).ok, true);
});
t('核對：位元組數不符、MD5 不符都被擋；內建 Python 文法通過', () => {
    const f = path.join(__dirname, '..', '..', 'vendor', 'tree-sitter', 'tree-sitter-python.wasm');
    if (fs.existsSync(f)) { const b = fs.readFileSync(f); assert.deepStrictEqual(A.verify('python', b), { ok: true }); const bad = Buffer.from(b); bad[1000] ^= 1; const r = A.verify('python', bad); assert.ok(!r.ok && /MD5/.test(r.reason)); assert.ok(!A.verify('python', b.slice(0, b.length - 1)).ok && /位元組/.test(A.verify('python', b.slice(1)).reason)); }
    assert.ok(!A.verify('java', Buffer.alloc(10)).ok); assert.ok(!A.verify('java', null).ok);
});
t('宿主 _behAsset 依序用快取→內建→來源表並核對（讀原始碼文字）', () => {
    const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
    const i = fa.indexOf('async _behAsset('); const body = fa.slice(i, i + 3500);
    assert.ok(/FaTsAssets\.verify/.test(fa) && /FaTsAssets\.sources/.test(fa) && /FaTsAssets\.cacheKey/.test(fa), '宿主沒用 FaTsAssets');
    assert.ok(body.indexOf('repoWikiCache.get') < body.indexOf('vendor/tree-sitter') && body.indexOf('vendor/tree-sitter') < body.indexOf('sources'), '順序：快取→內建→來源');
});
console.log('ts_assets.test.js：' + n + ' passed, 0 failed');
