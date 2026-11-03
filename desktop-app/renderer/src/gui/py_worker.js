// 會開視窗的 Python 程式（py_async.js 判斷為 true 的）在 module Worker 裡跑：這裡只放純函式與要送進 Worker 的程式。
// 為什麼要 Worker：同步的 runPython 內不能等 JS 的 Promise；Worker 裡用 JSPI（pyodide.ffi.run_sync）可以在 Python 呼叫處等頁面回覆。
// 為什麼 Worker 是 module：classic Worker 裡 Pyodide 會報「Classic web workers are not supported」（2026-11-03 實測）。
// 為什麼頁面不用 SharedArrayBuffer：頁面 crossOriginIsolated 是 false，所以只能用 Promise 與 postMessage。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatPyWorker = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 送進 Worker 的主程式。用 Function.prototype.toString 取出原始碼，所以函式內不能用外部變數，只能用參數 base（Pyodide 的網址）。
  // 訊息：主執行緒 → Worker：init（檔案、程式、Python 前置程式）、reply（對 call 的回覆）；Worker → 主執行緒：out／err（輸出）、call（橋接請求）、done（結束碼）。
  function workerMain(base) {
    var pending = {}, nextId = 1;
    function request(op, args) {
      return new Promise(function (resolve) {
        var id = nextId++;
        pending[id] = resolve;
        self.postMessage({ type: 'call', id: id, op: op, args: args });
      });
    }
    async function run(m) {
      try {
        var mod = await import(base + 'pyodide.mjs');
        var py = await mod.loadPyodide({ indexURL: base });
        py.setStdout({ batched: function (s) { self.postMessage({ type: 'out', text: s + '\n' }); } });
        py.setStderr({ batched: function (s) { self.postMessage({ type: 'err', text: s + '\n' }); } });
        py.setStdin({ stdin: function () { return null; } });
        // _fa_pybridge：fa_bridge.call 在網頁版直接呼叫它（同步的 run_sync 會等這裡的 Promise）
        py.registerJsModule('_fa_pybridge', {
          call: function (op, argsJson) { return request(String(op), JSON.parse(String(argsJson || '{}'))); },
          sleep: function (ms) { return new Promise(function (r) { setTimeout(r, Number(ms) || 0); }); }
        });
        Object.keys(m.files).forEach(function (k) {
          var full = '/fa_pybridge/' + k, dir = full.slice(0, full.lastIndexOf('/'));
          py.FS.mkdirTree(dir);
          py.FS.writeFile(full, m.files[k]);
        });
        py.FS.mkdirTree('/work');
        m.inputs.forEach(function (f) {
          var full = '/work/' + f.rel, dir = full.slice(0, full.lastIndexOf('/'));
          if (dir !== '/work') py.FS.mkdirTree(dir);
          py.FS.writeFile(full, f.bytes);
        });
        py.FS.chdir('/work');
        py.runPython(m.prelude);
        py.globals.set('__fa_src__', m.src);
        py.globals.set('__fa_path__', '/work/' + m.scriptName);
        py.runPython(m.runner);
        // 程式寫在目前目錄（/work）的檔案送回頁面，讓終端機的 ls 看得到（例如 missile 範例寫出的貼圖）
        function syncBack() {
          var files = [];
          py.FS.readdir('/work').forEach(function (n) {
            var p = '/work/' + n;
            if (n === '.' || n === '..' || !py.FS.isFile(py.FS.stat(p).mode)) { return; }
            files.push({ rel: n, bytes: py.FS.readFile(p) });
          });
          self.postMessage({ type: 'files', files: files });
        }
        var go = py.globals.get('go');
        try {
          var rc = await go.callPromising();   // go() 回傳程式的結束碼（SystemExit 的值，或正常結束的 0）
          syncBack();
          self.postMessage({ type: 'done', code: typeof rc === 'number' ? rc : 0 });
        } catch (e) {
          self.postMessage({ type: 'err', text: String((e && e.message) || e) + '\n' });
          syncBack();
          self.postMessage({ type: 'done', code: 1 });
        } finally {
          go.destroy();
        }
      } catch (e) {
        self.postMessage({ type: 'err', text: '無法啟動 Python（' + String((e && e.message) || e) + '）\n' });
        self.postMessage({ type: 'done', code: 1 });
      }
    }
    self.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.type === 'reply') { var p = pending[m.id]; delete pending[m.id]; if (p) p(m.raw); return; }
      if (m.type === 'init') run(m);
    };
  }

  // 要放進 Worker 執行的原始碼（module）。base 是 Pyodide 的網址，要與頁面用的相同（FA_ASSET_URLS.pyodideJsBase）。
  function workerSource(base) {
    return '(' + workerMain.toString() + ')(' + JSON.stringify(String(base)) + ');';
  }

  // Worker 內先執行：轉接層的路徑、橋接版 fa_bridge（網頁版：IN_BROWSER 時 call 用 run_sync）。sys.path 把 /work 放最前面，跟桌面版的 python 一樣。
  // install_hooks 不放這裡：它會呼叫 run_sync，頂層不在 callPromising 裡會報「Cannot stack switch」，所以放進 RUNNER_PY 的 go() 裡。
  var PRELUDE_PY = [
    'import sys',
    "if '/fa_pybridge' not in sys.path:",
    "    sys.path.insert(0, '/fa_pybridge')",
    "sys.path.insert(0, '/work')",
    'import fa_bridge',
    'fa_bridge.ACTIVE = True',
  ].join('\n');

  // 把程式包在 go() 裡執行：整支程式在 callPromising 裡，頂層的 gui 呼叫才能同步等待。__name__ 設成 __main__，__file__ 指向 /work 內的路徑。
  var RUNNER_PY = [
    'def go():',
    '    fa_bridge.install_hooks()',
    '    import builtins, io',
    '    def _readline(prompt=""):',
    '        return fa_bridge.call("stdin.readline", {"prompt": str(prompt)})',
    '    def _input(prompt=""):',
    '        r = _readline(prompt)',
    '        if r is None:',
    '            raise EOFError("EOF when reading a line")',
    '        return r[:-1] if r.endswith("\\n") else r',
    '    class _Stdin(io.TextIOBase):',
    '        def readable(self): return True',
    '        def isatty(self): return False',
    '        def readline(self, size=-1):',
    '            r = _readline("")',
    '            return "" if r is None else r',
    '        def read(self, size=-1):',
    '            parts = []',
    '            while True:',
    '                r = _readline("")',
    '                if r is None: break',
    '                parts.append(r)',
    '            return "".join(parts)',
    '    builtins.input = _input',
    '    sys.stdin = _Stdin()',
    "    g = {'__name__': '__main__', '__file__': __fa_path__}",
    // SystemExit 與 Python 的 sys.exit 一樣：整數是結束碼，None 是 0，其他值印到 stderr 後結束碼 1；未捕捉的例外仍是 1（由 JS 端的 catch 處理）
    '    try:',
    '        exec(compile(__fa_src__, __fa_path__, "exec"), g)',
    '    except SystemExit as e:',
    '        c = e.code',
    '        if c is None: return 0',
    '        if isinstance(c, int): return c',
    '        sys.stderr.write(str(c) + "\\n")',
    '        return 1',
    '    return 0',
  ].join('\n');

  // gui.* 橋接操作（gui.py 呼叫的名字，去掉 gui. 前綴）。與 gui_bridge.js 的 OPS 對應，另外 poll／wait／image 由頁面處理。
  var GUI_OPS = ['open', 'add', 'set', 'remove', 'close', 'draw', 'image', 'poll', 'wait'];

  // 把 gui.py 送來的參數轉成 "@gui" 協定訊息（v:1 + op + 其餘欄位，欄位名與 gui.py 一致）
  function guiMessage(op, args) {
    var m = { v: 1, op: String(op) };
    Object.keys(args || {}).forEach(function (k) { m[k] = args[k]; });
    return m;
  }

  // 等待視窗的下一個事件（gui.wait）。host.wait 的 resolver 不能取消，超時後下一個事件會被丟掉，所以改成輪詢佇列（host.poll）。
  // 視窗已關閉且佇列空的，回傳 close 事件；超時回傳 null（視窗保持開著，程式可以再等）。
  async function waitEvent(host, winId, timeoutSec, o) {
    var stepMs = (o && o.stepMs) || 15;
    var deadline = o.now() + Math.max(0, Number(timeoutSec) || 0) * 1000;
    for (;;) {
      var line = host.poll(winId);
      if (line !== null && line !== undefined) return JSON.parse(line);
      if (!host.isOpen(winId)) return { event: 'close', id: winId };
      if (o.now() >= deadline) return null;
      await o.sleep(stepMs);
    }
  }

  return {
    workerSource: workerSource,
    workerMain: workerMain,
    PRELUDE_PY: PRELUDE_PY,
    RUNNER_PY: RUNNER_PY,
    GUI_OPS: GUI_OPS,
    guiMessage: guiMessage,
    waitEvent: waitEvent,
  };
}));
