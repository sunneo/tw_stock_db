// 整合測試用的「自己的」X 環境：Xvfb（自選一個沒人用的顯示編號）＋ dbus session ＋ AT-SPI 匯流排 ＋ 視窗管理員。
// 鐵則：絕不碰使用者真正的畫面（環境變數 DISPLAY，這台機器是 :5.0）。所有子行程的環境都是明確組出來的，DISPLAY 一定是這裡起的 Xvfb；
// 選編號時也會避開 /tmp/.X11-unix 裡已經存在的（別人的）顯示，並拒絕任何等於呼叫者 DISPLAY 的編號。
'use strict';
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

function which(bin) { const r = spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freeDisplayNumber(from) {
    const real = String(process.env.DISPLAY || '');
    for (let n = from || 91; n < 400; n++) {
        if (real === ':' + n || real.startsWith(':' + n + '.')) continue;
        if (fs.existsSync('/tmp/.X11-unix/X' + n) || fs.existsSync('/tmp/.X' + n + '-lock')) continue;
        return n;
    }
    throw new Error('找不到可用的顯示編號');
}

// 找一個目前沒人監聽的 TCP 埠（只用在 127.0.0.1）
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }

// opts：{ size:'1280x800x24', wm:'xfwm4'|'metacity'|'none', atspi:true, dbus:true, xvnc:{ password?:string } }
// xvnc：改用 TigerVNC 的 Xvnc（自己就是 X 伺服器＋RFB 伺服器，只聽 127.0.0.1），回傳的 rfbPort 就是 RFB 埠；有 password 時用 VNC 驗證。
async function startXEnv(opts) {
    opts = opts || {};
    const procs = []; const cleanups = [];
    const num = freeDisplayNumber(opts.from || 91 + Math.floor(Math.random() * 40));
    const display = ':' + num;
    if (display === process.env.DISPLAY) throw new Error('拒絕使用真實畫面 ' + display);
    let rfbPort = null, passFile = null;
    const geo = String(opts.size || '1280x800x24').split('x');
    let xvfb;
    if (opts.xvnc) {
      rfbPort = await freePort(); const args = [display, '-geometry', geo[0] + 'x' + geo[1], '-depth', geo[2] || '24', '-rfbport', String(rfbPort), '-localhost', '-AlwaysShared', '-nolisten', 'tcp'];
      if (opts.xvnc.password) { const pw = spawnSync('vncpasswd', ['-f'], { input: Buffer.from(opts.xvnc.password + '\n' + opts.xvnc.password + '\n') }); passFile = path.join(require('os').tmpdir(), 'fa-vncpw-' + process.pid + '-' + num); fs.writeFileSync(passFile, pw.stdout, { mode: 0o600 }); cleanups.push(() => { try { fs.unlinkSync(passFile); } catch (_) { /* */ } }); args.push('-SecurityTypes', 'VncAuth', '-PasswordFile', passFile); }
      else args.push('-SecurityTypes', 'None');
      xvfb = spawn('Xvnc', args, { stdio: 'ignore' });
    } else xvfb = spawn('Xvfb', [display, '-screen', '0', opts.size || '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    procs.push(xvfb);
    for (let i = 0; i < 50 && !fs.existsSync('/tmp/.X11-unix/X' + num); i++) await sleep(100);
    if (!fs.existsSync('/tmp/.X11-unix/X' + num)) { stop(); throw new Error('Xvfb 沒有起來'); }
    const env = Object.assign({}, process.env, { DISPLAY: display, GDK_BACKEND: 'x11', NO_AT_BRIDGE: '0', LANG: process.env.LANG || 'C.UTF-8' });
    delete env.WAYLAND_DISPLAY; delete env.XDG_SESSION_TYPE; env.XDG_SESSION_TYPE = 'x11'; delete env.XAUTHORITY;
    env.XDG_CURRENT_DESKTOP = opts.desktop || 'XFCE';
    if (opts.dbus !== false && which('dbus-launch')) {
        const r = spawnSync('dbus-launch', ['--sh-syntax'], { encoding: 'utf8', env });
        const addr = /DBUS_SESSION_BUS_ADDRESS='([^']+)'/.exec(r.stdout || ''), pid = /DBUS_SESSION_BUS_PID=(\d+)/.exec(r.stdout || '');
        if (addr) { env.DBUS_SESSION_BUS_ADDRESS = addr[1]; if (pid) cleanups.push(() => { try { process.kill(Number(pid[1])); } catch (_) { /* */ } }); }
    }
    if (opts.atspi !== false && env.DBUS_SESSION_BUS_ADDRESS) {
        const bin = ['/usr/libexec/at-spi-bus-launcher', '/usr/lib/at-spi2-core/at-spi-bus-launcher'].find((p) => fs.existsSync(p));
        if (bin) {
            procs.push(spawn(bin, ['--launch-immediately'], { env, stdio: 'ignore' })); await sleep(800);
            // 像螢幕閱讀器一樣告訴 a11y 匯流排「無障礙已啟用」：Chromium／Electron 看到這個才會匯出自己的元件樹（--force-renderer-accessibility 單獨用不夠）
            if (opts.a11yOn !== false && which('gdbus')) {
                for (const prop of ['IsEnabled', 'ScreenReaderEnabled']) spawnSync('gdbus', ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus', '--method', 'org.freedesktop.DBus.Properties.Set', 'org.a11y.Status', prop, '<true>'], { env, stdio: 'ignore' });
                env.ACCESSIBILITY_ENABLED = '1';
            }
        }
    }
    const wm = opts.wm === undefined ? 'xfwm4' : opts.wm;
    if (wm && wm !== 'none' && which(wm)) { procs.push(spawn(wm, wm === 'xfwm4' ? ['--compositor=off'] : [], { env, stdio: 'ignore' })); await sleep(1200); }
    function stop() {
        for (const p of procs.slice().reverse()) { try { p.kill('SIGTERM'); } catch (_) { /* */ } }
        for (const c of cleanups) c();
        try { for (const p of procs) if (!p.killed) setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) { /* */ } }, 1500).unref(); } catch (_) { /* */ }
    }
    // 在這個環境裡起一個程式（回傳子行程，stop() 時一併殺掉）
    function run(cmd, args, o) { const p = spawn(cmd, args || [], Object.assign({ env, stdio: 'ignore' }, o || {})); procs.push(p); return p; }
    return { display, env, stop, run, sleep, which, rfbPort };
}

module.exports = { startXEnv, which, sleep, freeDisplayNumber, freePort };
