/* MD5 純 JS 實作的單元測試：node renderer/src/musiclib/musiclib_md5_test.js（不需要瀏覽器）。
 * RFC 1321 官方測試向量、分段輸入與一次輸入結果一致、以及和 Node 的 crypto 隨機比對。 */
'use strict';
var assert = require('assert');
var crypto = require('crypto');
var MD5 = require('./musiclib_md5.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

t('RFC 1321 官方測試向量', function () {
  var eighty = '';
  for (var i = 0; i < 8; i++) eighty += '1234567890';
  var vectors = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    [eighty, '57edf4a22be3c955ac49da2e2107b67a']
  ];
  vectors.forEach(function (v) { assert.equal(MD5.md5Hex(v[0]), v[1], '向量 ' + v[0].slice(0, 20)); });
});

t('分段輸入的結果與一次輸入一致（切點在各種位置，含跨 64 位元組邊界）', function () {
  var data = crypto.randomBytes(1000);
  var whole = MD5.md5Hex(data);
  [1, 3, 55, 56, 63, 64, 65, 127, 128, 333].forEach(function (cut) {
    var h = MD5.md5Create();
    for (var p = 0; p < data.length; p += cut) h.update(data.subarray(p, Math.min(data.length, p + cut)));
    assert.equal(h.hex(), whole, '切片大小 ' + cut);
  });
  assert.equal(MD5.md5Hex(data), crypto.createHash('md5').update(data).digest('hex'));
});

t('隨機長度 0～300 位元組：與 Node 的 crypto 一致', function () {
  for (var n = 0; n <= 300; n++) {
    var b = crypto.randomBytes(n);
    assert.equal(MD5.md5Hex(b), crypto.createHash('md5').update(b).digest('hex'), '長度 ' + n);
  }
});

t('字串以 UTF-8 計算（中文）', function () {
  var s = '音樂庫 MD5 測試';
  assert.equal(MD5.md5Hex(s), crypto.createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex'));
});

t('hex 只能呼叫一次；算完後 update 會報錯', function () {
  var h = MD5.md5Create().update('abc');
  h.hex();
  assert.throws(function () { h.update('x'); });
  assert.throws(function () { h.hex(); });
});

(function run() {
  var pass = 0, failed = [];
  tests.forEach(function (x) {
    try { x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  });
  console.log('musiclib_md5 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
