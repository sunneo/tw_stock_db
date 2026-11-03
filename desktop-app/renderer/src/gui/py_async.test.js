// node renderer/src/gui/py_async.test.js -- 判斷 Python 原始碼要不要走非同步路徑：真的 import gui／pygame 要走；字串、註解與名字相似的模組不能誤判
const assert = require('assert');
const P = require('./py_async.js');
let n = 0; const ok = () => { n++; };

// 會開視窗的寫法：都要走非同步
[
  'import gui\n',
  'from gui import Window\n',
  'import pygame\n',
  'from pygame import display\n',
  'import os, gui\n',
  'import sys\nimport pygame.locals\n',
  '  import gui\n', // 縮排的 import（例如寫在函式或 try 裡）
  'import gui.sub\n',
  'try:\n    import pygame\nexcept ImportError:\n    pass\n',
].forEach((src) => { assert.strictEqual(P.needsAsync(src), true, 'should be async: ' + JSON.stringify(src)); ok(); });

// 一般程式：不走
[
  'print("hello")\n',
  'import os\nimport json\n',
  'import guitar\n', // 名字只是開頭相同
  'from gui_helpers import x\n', // 底線接在後面
  'import pygame_utils\n',
  'import mygui\n',
  'x = 1\n',
  '', // 空字串
  null, // 非字串也不能當掉
].forEach((src) => { assert.strictEqual(P.needsAsync(src), false, 'should be sync: ' + JSON.stringify(src)); ok(); });

// 字串裡出現 import gui：不能誤判
assert.strictEqual(P.needsAsync('s = """\nimport gui\n"""\nprint(s)\n'), false); ok();
assert.strictEqual(P.needsAsync("msg = 'import pygame'\n"), false); ok();
assert.strictEqual(P.needsAsync('msg = "from gui import x"\n'), false); ok();
// 註解裡出現：不能誤判
assert.strictEqual(P.needsAsync('# import gui\nprint(1)\n'), false); ok();
assert.strictEqual(P.needsAsync('x = 1  # from pygame import display\n'), false); ok();
// 字串裡有 # 不算註解：後面真的 import gui 仍要判成 async
assert.strictEqual(P.needsAsync('s = "#not a comment"\nimport gui\n'), true); ok();
// 三引號字串結束後的真 import 仍要判斷到
assert.strictEqual(P.needsAsync('doc = """\nimport pygame\n"""\nimport gui\n'), true); ok();
// 跳脫的引號不會提早結束字串：'it\'s' 之後的 import 仍可判斷
assert.strictEqual(P.needsAsync("s = 'it\\'s'\nimport gui\n"), true); ok();
assert.strictEqual(P.needsAsync("s = 'it\\'s import gui'\n"), false); ok();

// input()／sys.stdin 要讀使用者輸入，也走 Worker；字串或註解裡出現的不算；obj.input( 不算
assert.strictEqual(P.needsAsync('name = input("name? ")\n'), true); ok();
assert.strictEqual(P.needsAsync('import sys\nline = sys.stdin.readline()\n'), true); ok();
assert.strictEqual(P.needsAsync('print("input(x)")  # input()\n'), false); ok();
assert.strictEqual(P.needsAsync('w.input("x")\n'), false); ok();

// blankOut 保留換行數，讓行號與行首比對不會錯位
const sample = 'a = "x\ny"\n# c\nimport gui\n';
assert.strictEqual(P.blankOut(sample).split('\n').length, sample.split('\n').length); ok();
assert.ok(/^import gui$/m.test(P.blankOut(sample))); ok();

console.log('py_async tests passed: ' + n);
