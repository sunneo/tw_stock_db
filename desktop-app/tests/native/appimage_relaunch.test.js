// AppImage 重啟接手（main-ext.js installAppImageRelaunch）：Linux＋AppImage 才接手 app.relaunch，改用脫離的 shell（等 2 秒、清環境變數、失敗退到 extract-and-run）；其他情況不動。
const path = require('path'); const M = require(path.join(__dirname, '..', '..', 'main-ext.js'));
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const mkApp = () => { const a = { calls: [], relaunch(o) { a.calls.push(o); } }; return a; };
// 不是 Linux／沒有 APPIMAGE：不接手
let a = mkApp(); check('Windows 不接手', M._installAppImageRelaunch(a, { platform: 'win32', env: { APPIMAGE: '/x.AppImage' } }) === false && a.relaunch === a.relaunch && !a.__faRelaunchPatched);
a = mkApp(); check('沒有 APPIMAGE 環境變數不接手', M._installAppImageRelaunch(a, { platform: 'linux', env: {} }) === false);
// 接手：app.relaunch 變成脫離的 shell
a = mkApp(); const sp = []; const fake = (cmd, args, o) => { sp.push({ cmd, args, o }); return { unref() { sp.unref = true; } }; };
const env = { APPIMAGE: '/home/u/App.AppImage', APPDIR: '/tmp/.mount_x', ARGV0: 'x', OWD: '/', PATH: '/bin', HOME: '/home/u' };
check('Linux＋AppImage 接手', M._installAppImageRelaunch(a, { platform: 'linux', env, argv: ['/tmp/.mount_x/app', '--flag'], spawn: fake }) === true && a.__faRelaunchPatched === true);
a.relaunch({ execPath: '/tmp/.mount_x/dead', args: ['--a'] });
check('用脫離的 /bin/sh 啟動 AppImage 檔本身（不是已消失的 /tmp/.mount_）', sp.length === 1 && sp[0].cmd === '/bin/sh' && sp[0].args[2] === 'sh' && sp[0].args[3] === '/home/u/App.AppImage' && sp[0].args[4] === '--a', sp);
check('detached＋stdio ignore＋unref', sp[0].o.detached === true && sp[0].o.stdio === 'ignore' && sp.unref === true);
check('清掉 APPIMAGE／APPDIR／ARGV0／OWD，保留其他環境變數', !('APPIMAGE' in sp[0].o.env) && !('APPDIR' in sp[0].o.env) && !('ARGV0' in sp[0].o.env) && !('OWD' in sp[0].o.env) && sp[0].o.env.HOME === '/home/u');
check('腳本：先等 2 秒、失敗退到 APPIMAGE_EXTRACT_AND_RUN=1', /sleep 2/.test(sp[0].args[1]) && /APPIMAGE_EXTRACT_AND_RUN=1/.test(sp[0].args[1]));
check('原本的 app.relaunch 沒被呼叫', a.calls.length === 0);
a.relaunch(); check('沒給 args 時用目前的命令列參數', sp[1].args[4] === '--flag', sp[1]);
check('不重複接手', M._installAppImageRelaunch(a, { platform: 'linux', env }) === false);
// 啟動失敗：退回原本的 app.relaunch
a = mkApp(); M._installAppImageRelaunch(a, { platform: 'linux', env, argv: ['x'], spawn: () => { throw new Error('boom'); } }); a.relaunch({ args: ['--z'] });
check('脫離式啟動丟錯時退回原本的 app.relaunch', a.calls.length === 1 && a.calls[0].args[0] === '--z', a.calls);
console.log(bad.length ? 'FAILED: ' + bad.join('、') : 'appimage_relaunch: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
