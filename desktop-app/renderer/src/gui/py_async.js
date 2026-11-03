// 判斷 Python 原始碼要不要走非同步路徑（只有會開視窗的程式才走，既有的 python 行為不動）。
// 做法：先把字串與註解抹成空白（保留換行，讓行首的比對仍然有效），再只看「行首的 import／from」有沒有 gui 或 pygame。
// 所以字串或註解裡出現 import gui 不會誤判，import guitar 也不會（比對到單字邊界為止）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatPyAsync = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 把字串內容與 # 註解換成空白；換行保留。支援單引號、雙引號、三引號與字首（r、b、f、u 等）。
  function blankOut(src) {
    var s = String(src || ''), out = '', i = 0, n = s.length;
    while (i < n) {
      var c = s[i];
      if (c === '#') { // 註解：到行尾為止
        while (i < n && s[i] !== '\n') { out += ' '; i++; }
        continue;
      }
      if (c === '"' || c === "'") {
        var triple = s.substr(i, 3) === c + c + c;
        var q = triple ? c + c + c : c;
        out += q.replace(/./g, ' ');
        i += q.length;
        while (i < n) {
          if (s[i] === '\\' && i + 1 < n) { out += (s[i + 1] === '\n' ? '\n' : '  '); i += 2; continue; }
          if (s.substr(i, q.length) === q) { out += q.replace(/./g, ' '); i += q.length; break; }
          if (!triple && s[i] === '\n') break; // 單行字串遇到換行就結束（不完整的語法交給 Python 報錯）
          out += (s[i] === '\n' ? '\n' : ' ');
          i++;
        }
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  // 行首（允許縮排）的 import：import gui／import os, pygame.locals；行首的 from：from gui import …／from pygame.locals import …
  var GUI_IMPORT = /^[ \t]*(?:import[ \t]+(?:[\w.]+[ \t]*,[ \t]*)*(?:gui|pygame)(?![\w])|from[ \t]+(?:gui|pygame)(?![\w]))/m;

  function needsAsync(src) {
    return GUI_IMPORT.test(blankOut(src));
  }

  return { needsAsync: needsAsync, blankOut: blankOut };
}));
