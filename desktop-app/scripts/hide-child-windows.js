'use strict';
// 讓 node 啟動的所有子行程在 Windows 上預設不彈出視窗（windowsHide: true），避免搶走使用者的鍵盤焦點。
// 用法：NODE_OPTIONS="--require <本檔絕對路徑>"（node 子行程會繼承，所以測試再開的 node 也有效）。
// 呼叫端自己明確傳 windowsHide（true 或 false）時尊重呼叫端；只在沒指定時補 true。
if (process.platform === 'win32' && !global.__faHideChildWindows) {
  global.__faHideChildWindows = true;
  const cp = require('child_process');
  const patch = (name, optIndexFn) => {
    const orig = cp[name]; if (typeof orig !== 'function') return;
    cp[name] = function () {
      const args = Array.prototype.slice.call(arguments);
      const i = optIndexFn(args);
      if (i === -1) args.splice(args.length, 0, { windowsHide: true }); // 沒有 options：補一個
      else if (args[i] && typeof args[i] === 'object' && args[i].windowsHide === undefined) args[i] = Object.assign({}, args[i], { windowsHide: true });
      return orig.apply(this, args);
    };
  };
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  // exec(cmd[, options][, cb])、execSync(cmd[, options])
  const execLike = (args) => { for (let k = 1; k < args.length; k++) if (isObj(args[k])) return k; if (typeof args[args.length - 1] === 'function') { return -2; } return -1; };
  // execFile/spawn(file[, args][, options][, cb])
  const fileLike = (args) => { for (let k = 1; k < args.length; k++) if (isObj(args[k])) return k; return -1; };
  const wrap = (name, finder) => {
    const orig = cp[name]; if (typeof orig !== 'function') return;
    cp[name] = function () {
      const args = Array.prototype.slice.call(arguments);
      const k = finder(args);
      if (k >= 0) { if (args[k].windowsHide === undefined) args[k] = Object.assign({}, args[k], { windowsHide: true }); }
      else {
        // 沒有 options：插在 callback 前面；spawn/execFile 的 args 陣列後面
        let at = args.length; if (typeof args[at - 1] === 'function') at--;
        if ((name === 'spawn' || name === 'spawnSync' || name === 'execFile' || name === 'execFileSync') && at === 1) args.splice(at, 0, [], { windowsHide: true });
        else args.splice(at, 0, { windowsHide: true });
      }
      return orig.apply(this, args);
    };
  };
  void patch;
  wrap('exec', execLike); wrap('execSync', execLike);
  wrap('spawn', fileLike); wrap('spawnSync', fileLike); wrap('execFile', fileLike); wrap('execFileSync', fileLike);
  // fork 預設已隱藏主控台視窗，不處理
}
