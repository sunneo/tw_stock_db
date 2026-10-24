// node scripts/computer-tests/linux_parse.test.js -- Linux 後端的純函式：桌面環境偵測、各工具輸出的解析（真實輸出樣本＋依文件的 Wayland／KDE／GNOME 樣本）、按鍵對照、截圖指令、能力矩陣（各種 session）
const P = require('../../computer-use-linux-parse.js');
const A = require('../../computer-use-atspi.js');
const PNG = require('../../computer-png.js');
const { suite } = require('./_t.js');
const t = suite('linux_parse');

// ---- 桌面環境
const S = (env) => P.detectSession(env);
t.check('XFCE X11', (() => { const s = S({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'XFCE', DISPLAY: ':0' }); return s.type === 'x11' && s.desktop === 'xfce' && !s.xwayland && s.hasX; })());
t.check('GNOME Wayland（有 DISPLAY＝XWayland）', (() => { const s = S({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':1' }); return s.type === 'wayland' && s.desktop === 'gnome' && s.xwayland === true; })());
t.check('KDE Wayland（沒有 DISPLAY）／KDE X11', S({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', WAYLAND_DISPLAY: 'wayland-0' }).desktop === 'kde' && !S({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', WAYLAND_DISPLAY: 'wayland-0' }).xwayland && S({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'KDE', DISPLAY: ':0' }).type === 'x11');
t.check('sway＝wlroots；沒有任何環境變數＝unknown；tty', S({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'sway', WAYLAND_DISPLAY: 'w' }).desktop === 'wlroots' && S({}).type === 'unknown' && S({ XDG_SESSION_TYPE: 'tty' }).type === 'tty');
t.check('XDG_SESSION_TYPE 沒設但有 WAYLAND_DISPLAY → wayland', S({ WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'GNOME' }).type === 'wayland');

// ---- wmctrl／xwininfo／xprop／xrandr（真實輸出）
const wm = P.parseWmctrl('0x0060000c  0 89248  110  158  364  134  xterm.XTerm           host1 stevenyc.huang@host1: /home/x/下載 test\n0x00800003  -1 89247  553  397  194  122  zenity.Zenity         host1 T1 Entry\n垃圾行\n');
t.check('parseWmctrl：id 正規化、桌面（-1＝全部）、pid、類別拆 instance／class、標題含空白與中文', wm.length === 2 && wm[0].id === '0x0060000c' && wm[0].instance === 'xterm' && wm[0].class === 'XTerm' && wm[0].title.includes('下載') && wm[1].desktop === -1 && wm[1].pid === 89247 && wm[1].title === 'T1 Entry');
t.check('normId：十進位、大小寫、補零', P.normId('6291468') === '0x0060000c' && P.normId('0X60000C') === '0x0060000c' && P.normId('0x1') === '0x00000001');
const tree = P.parseXwininfoTree(`
xwininfo: Window id: 0x50d (the root window) (has no name)

  Root window id: 0x50d (the root window) (has no name)
  Parent window id: 0x0 (none)
     13 children:
     0x800009 (has no name): ()  1x1+-1+-1  +-1+-1
     0x800001 "zenity": ("zenity" "Zenity")  10x10+10+10  +10+10
     0x200333 (has no name): ()  204x156+543+339  +543+339
        16 children:
        0x800003 "T1 Entry": ("zenity" "Zenity")  194x122+5+29  +548+368
           1 child:
           0x800004 (has no name): ()  1x1+-1+-1  +547+367
`);
t.check('parseXwininfoTree：絕對座標（客戶區 548,368，不是 wmctrl 會偏掉的 553,397）、層級、名稱與類別', tree.length === 5 && tree.find((n) => n.id === '0x00800003').x === 548 && tree.find((n) => n.id === '0x00800003').y === 368 && tree.find((n) => n.id === '0x00800003').depth === 2 && tree.find((n) => n.id === '0x00800003').class === 'Zenity' && tree.find((n) => n.id === '0x00800004').depth === 3 && tree.find((n) => n.id === '0x00800009').x === -1);
t.check('nestXwininfo：還原成巢狀', (() => { const n = P.nestXwininfo(tree); const frame = n.find((x) => x.id === '0x00200333'); return frame.children.length === 1 && frame.children[0].children.length === 1; })());
t.check('parseXwininfoId', (() => { const r = P.parseXwininfoId('  Absolute upper-left X:  548\n  Absolute upper-left Y:  368\n  Width: 194\n  Height: 122\n  Map State: IsViewable\n'); return r.x === 548 && r.w === 194 && r.mapState === 'IsViewable'; })());
const xp = P.parseXprop('_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ, _NET_WM_STATE_FOCUSED\n_NET_FRAME_EXTENTS(CARDINAL) = 5, 5, 29, 5\n_GTK_FRAME_EXTENTS(CARDINAL) = 10, 10, 8, 12\n_NET_WM_PID(CARDINAL) = 89247\nWM_CLASS(STRING) = "zenity", "Zenity"\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DIALOG\n_NET_WM_DESKTOP(CARDINAL) = 2\n');
t.check('parseXprop：狀態、框架範圍（左右上下）、GTK 陰影、pid、WM_CLASS、類型、桌面', xp.state.join() === 'maximized_vert,maximized_horz,focused' && xp.frame.top === 29 && xp.frame.left === 5 && xp.gtkFrame.bottom === 12 && xp.pid === 89247 && xp.wmClass[1] === 'Zenity' && xp.type[0] === 'dialog' && xp.desktop === 2);
t.check('parseXprop：空狀態不會吃到下一行（曾經的 bug）', P.parseXprop('_NET_WM_STATE(ATOM) = \n_NET_FRAME_EXTENTS(CARDINAL) = 5, 5, 29, 5\n').state.length === 0);
const root = P.parseXpropRoot('_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x60000c, 0x800003\n_NET_CURRENT_DESKTOP(CARDINAL) = 0\n_NET_NUMBER_OF_DESKTOPS(CARDINAL) = 4\n_NET_ACTIVE_WINDOW(WINDOW): window id # 0x800003, 0x0\n_NET_WORKAREA(CARDINAL) = 0, 0, 1280, 800\n');
t.check('parseXpropRoot：堆疊順序（底→上）、桌面、作用中視窗、工作區', root.stacking.join() === '0x0060000c,0x00800003' && root.currentDesktop === 0 && root.desktops === 4 && root.active === '0x00800003' && root.workarea.w === 1280);
const mons = P.parseXrandr('Screen 0: minimum 1 x 1, current 3840 x 1080, maximum 16384 x 16384\nHDMI-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 527mm x 296mm\n   1920x1080     60.00*+\neDP-1 connected 1920x1080+1920+0 (normal left inverted right x axis y axis) 344mm x 193mm\nDP-1 disconnected (normal left inverted right x axis y axis)\n');
t.check('parseXrandr：多螢幕位置、primary、mm、DPI（連線的才算）', mons.length === 2 && mons[0].primary && mons[1].rect.x === 1920 && mons[1].dpi === Math.round((1920 / 344) * 25.4) && mons[0].mm.w === 527);
t.check('parseXrandr：沒有 primary 時第一個當 primary；Xvfb 的輸出', P.parseXrandr('screen connected 1280x800+0+0 0mm x 0mm\n')[0].primary === true && P.parseXrandr('screen connected 1280x800+0+0 0mm x 0mm\n')[0].dpi === null);
t.check('parseXrdbDpi、parseMouseLocation', P.parseXrdbDpi('Xft.dpi:\t144\n') === 144 && (() => { const m = P.parseMouseLocation('X=640\nY=400\nSCREEN=0\nWINDOW=8388611\n'); return m.x === 640 && m.y === 400 && m.window === '0x00800003'; })());

// ---- KDE kdotool（依 README，未實測）、GNOME gdbus（未實測）
t.check('kdotool：geometry、視窗 id 列表', (() => { const g = P.parseKdotoolGeometry('Window {7a1b2c3d-1111-2222-3333-444455556666}\n  Position: 100,200\n  Geometry: 800x600\n'); const ids = P.parseKdotoolIds('{7a1b2c3d-1111-2222-3333-444455556666}\n{aaaaaaaa-1111-2222-3333-444455556666}\nnot an id\n'); return g.x === 100 && g.h === 600 && ids.length === 2; })());
const gj = P.parseGnomeWindowsJson('(\'[{"id":123,"title":"Terminal","wm_class":"Gnome-terminal","wm_class_instance":"gnome-terminal-server","pid":4242,"focus":true,"in_current_workspace":true,"x":10,"y":20,"width":800,"height":600},{"id":124,"title":"it\\\'s","wm_class":"Firefox","pid":5,"focus":false,"x":0,"y":0,"width":10,"height":10}]\',)');
t.check('GNOME Window Calls 的 gdbus 輸出（GVariant 字串包 JSON，含跳脫的單引號）', gj && gj.length === 2 && gj[0].id === '123' && gj[0].class === 'Gnome-terminal' && gj[0].focused && gj[0].w === 800 && gj[1].title === "it's");
t.check('GNOME Shell.Eval 輸出格式 (true, \'…\')；失敗格式 (false, \'\') 回 null', P.parseGnomeWindowsJson('(true, \'[{"id":1,"title":"a","cls":"X","pid":2,"x":1,"y":2,"w":3,"h":4,"min":false,"focus":true}]\')')[0].w === 3 && P.parseGnomeWindowsJson("(false, '')") === null && P.parseGnomeWindowsJson('garbage') === null);

// ---- 按鍵對照
t.check('chordToXdotool：修飾鍵、具名鍵、F 鍵、字母、中文、不認得回 null', P.chordToXdotool('ctrl+shift+t') === 'ctrl+shift+t' && P.chordToXdotool('alt+left') === 'alt+Left' && P.chordToXdotool('return') === 'Return' && P.chordToXdotool('f5') === 'F5' && P.chordToXdotool('ctrl+prior') === 'ctrl+Prior' && P.chordToXdotool('super+l') === 'super+l' && P.chordToXdotool('ctrl+nonsense') === null && P.chordToXdotool('ctrl+plus') === 'ctrl+plus');
t.check('chordToYdotool：evdev 按下／放開順序（ctrl+s）、不認得回 null', JSON.stringify(P.chordToYdotool('ctrl+s')) === JSON.stringify(['29:1', '31:1', '31:0', '29:0']) && JSON.stringify(P.chordToYdotool('return')) === JSON.stringify(['28:1', '28:0']) && P.chordToYdotool('ctrl+zzz') === null);
t.check('chordToWtype：-M／-m／-k', JSON.stringify(P.chordToWtype('ctrl+shift+t')) === JSON.stringify(['-M', 'ctrl', '-M', 'shift', '-k', 't', '-m', 'shift', '-m', 'ctrl']) && JSON.stringify(P.chordToWtype('Return'.toLowerCase())) === JSON.stringify(['-k', 'Return']) && JSON.stringify(P.chordToWtype('super+d')) === JSON.stringify(['-M', 'logo', '-k', 'd', '-m', 'logo']));
// 安全引擎的正規化結果都能被三種後端對上（常用鍵）
const SAFE = require('../../computer-use-safety.js'); t.check('常用按鍵經 normalizeChord 後三種後端都認得', ['Enter', 'Esc', 'Tab', 'ctrl+c', 'ctrl+v', 'alt+Left', 'F5', 'PageDown', 'Backspace', 'Delete', 'ctrl+shift+Z', 'shift+Tab'].every((k) => { const c = SAFE.normalizeChord(k); return P.chordToXdotool(c) && P.chordToYdotool(c) && P.chordToWtype(c); }));

// ---- 截圖指令
t.check('screenshotCommand：scrot（含游標 -p）、import、grim、spectacle、gnome-screenshot、xwd；不認得回 null', (() => { const f = '/tmp/a.png'; return JSON.stringify(P.screenshotCommand('scrot', { file: f, pointer: true }).args) === JSON.stringify(['-o', '-p', f]) && P.screenshotCommand('import', { file: f }).args.join(' ') === '-window root png:' + f && P.screenshotCommand('grim', { file: f, pointer: true }).args.join(' ') === '-c -t png ' + f && P.screenshotCommand('spectacle', { file: f }).args.includes('-b') && P.screenshotCommand('gnome-screenshot', { file: f }).args.join(' ') === '-f ' + f && P.screenshotCommand('xwd', { file: f }).format === 'xwd' && P.screenshotCommand('nope', { file: f }) === null; })());
t.check('screenshotPreference：X11 先 scrot；KDE Wayland 先 spectacle；GNOME Wayland 先 gnome-screenshot；其他 Wayland 先 grim', P.screenshotPreference(S({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }))[0] === 'scrot' && P.screenshotPreference(S({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', WAYLAND_DISPLAY: 'w' }))[0] === 'spectacle' && P.screenshotPreference(S({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME', WAYLAND_DISPLAY: 'w' }))[0] === 'gnome-screenshot' && P.screenshotPreference(S({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'sway', WAYLAND_DISPLAY: 'w' }))[0] === 'grim');
// XWD：合成一張 3x2 的 32bpp ZPixmap（小端）再解碼
(() => { const w = 3, h = 2, hdr = 100, bpl = w * 4, buf = Buffer.alloc(hdr + bpl * h); buf.writeUInt32BE(hdr, 0); buf.writeUInt32BE(7, 4); buf.writeUInt32BE(2, 8); buf.writeUInt32BE(24, 12); buf.writeUInt32BE(w, 16); buf.writeUInt32BE(h, 20); buf.writeUInt32BE(0, 28); buf.writeUInt32BE(32, 44); buf.writeUInt32BE(bpl, 48); buf.writeUInt32BE(0xff0000, 56); buf.writeUInt32BE(0x00ff00, 60); buf.writeUInt32BE(0x0000ff, 64); buf.writeUInt32BE(0, 76); for (let i = 0; i < w * h; i++) buf.writeUInt32LE(((i * 40) << 16 | (255 - i * 40) << 8 | (i * 10)) >>> 0, hdr + i * 4); const img = P.decodeXwd(buf); t.check('decodeXwd：32bpp 小端 ZPixmap（遮罩位移）', img.width === 3 && img.height === 2 && img.data[4] === 40 && img.data[5] === 215 && img.data[6] === 10 && img.data[3] === 255 && (() => { try { P.decodeXwd(Buffer.alloc(120)); } catch (_) { return true; } return false; })()); })();

// ---- 能力矩陣：各種 session 的說明
const has = (...n) => Object.fromEntries(n.map((x) => [x, '/usr/bin/' + x]));
const cap = (env, tools, probes) => P.buildCapabilities(S(env), has(...tools), probes || {});
let c = cap({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'XFCE', DISPLAY: ':0' }, ['xdotool', 'wmctrl', 'xprop', 'xwininfo', 'scrot', 'xsel', 'python3'], { atspi: true });
t.check('XFCE X11 全套：視窗／滑鼠／鍵盤／截圖／剪貼簿／a11y 都可用，沒有缺工具', c.features.windows.list.ok && c.features.windows.backend === 'x11' && c.features.input.mouse.ok && c.features.input.backend === 'xdotool' && c.features.screenshot.tool === 'scrot' && c.features.clipboard.set.ok && c.features.a11y.ok && c.missingTools.length === 0 && /X11 \/ xfce/.test(c.summary));
c = cap({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'XFCE', DISPLAY: ':0' }, ['scrot'], {});
t.check('X11 但什麼工具都沒有：每一項附原因與安裝指令，不丟例外', !c.features.windows.list.ok && !c.features.input.mouse.ok && /xdotool/.test(c.features.input.mouse.reason + c.features.input.mouse.hint) && c.missingTools.includes('xdotool') && c.hints.some((h) => /apt install/.test(h)) && c.features.screenshot.screen.ok && !c.features.a11y.ok && /沒有 python3/.test(c.features.a11y.reason));
c = cap({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME', WAYLAND_DISPLAY: 'wayland-0' }, ['python3', 'gdbus', 'gnome-screenshot'], { atspi: true });
t.check('GNOME Wayland、沒有 ydotool、沒有擴充：視窗只能靠 AT-SPI（沒有座標、不能控制）、輸入不可用並說明 Wayland 限制與建議', c.features.windows.backend === 'atspi' && !c.features.windows.focus.ok && /Window Calls/.test(c.features.windows.focus.reason) && !c.features.input.mouse.ok && /Wayland 不允許其他程式送出輸入事件/.test(c.features.input.mouse.reason) && c.features.screenshot.tool === 'gnome-screenshot' && /GNOME Wayland 的截圖/.test(c.notes.join('')) && /Wayland/.test(c.summary) && c.features.a11y.coords === 'window-relative');
c = cap({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME', WAYLAND_DISPLAY: 'wayland-0' }, ['python3', 'gdbus', 'gnome-screenshot', 'ydotool'], { atspi: true, gnomeWindowsExt: true, ydotoold: true, uinput: true });
t.check('GNOME Wayland＋Window Calls 擴充＋ydotool：視窗全可控（gdbus）、輸入走 ydotool（標示未實測、座標要校準）', c.features.windows.backend === 'gnome' && c.features.windows.move.ok && c.features.windows.list.unverified === true && c.features.input.backend === 'ydotool' && c.features.input.mouse.ok && c.features.input.mouse.unverified === true && /校準/.test(c.features.input.mouse.note));
c = cap({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME', WAYLAND_DISPLAY: 'wayland-0' }, ['ydotool', 'gdbus'], { ydotoold: false, uinput: false });
t.check('ydotool 裝了但 ydotoold／uinput 沒有：說明需要 ydotoold 與 /dev/uinput', !c.features.input.mouse.ok && /ydotoold/.test(c.features.input.mouse.reason));
c = cap({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', WAYLAND_DISPLAY: 'wayland-0' }, ['kdotool', 'spectacle', 'wtype', 'ydotool'], { ydotoold: true });
t.check('KDE Wayland＋kdotool＋spectacle：視窗走 kdotool、截圖 spectacle', c.features.windows.backend === 'kdotool' && c.features.windows.list.ok && c.features.screenshot.tool === 'spectacle' && /spectacle/.test(c.notes.join('')));
c = cap({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'sway', WAYLAND_DISPLAY: 'w' }, ['wtype', 'grim'], {});
t.check('sway（wlroots）只有 wtype＋grim：鍵盤可用、滑鼠不可用並建議 ydotool；截圖 grim', c.features.input.backend === 'wtype' && c.features.input.keyboard.ok && !c.features.input.mouse.ok && /ydotool/.test(c.features.input.mouse.reason + c.features.input.mouse.hint) && c.features.screenshot.tool === 'grim');
c = cap({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':1' }, ['xdotool', 'wmctrl', 'xwininfo', 'xprop', 'scrot'], {});
t.check('XWayland（Wayland 工作階段＋X 工具）：X 工具只對 XWayland 視窗有效，說明有哪些看不到', c.features.windows.list.ok && c.features.windows.list.xwaylandOnly === true && c.features.input.mouse.xwaylandOnly === true && /XWayland/.test(c.notes.join('')) && /Wayland 原生視窗收不到/.test(c.notes.join('')));
c = cap({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME', WAYLAND_DISPLAY: 'wayland-0' }, ['gdbus'], { portalRemoteDesktop: true });
t.check('有 xdg-desktop-portal RemoteDesktop 但沒有 ydotool：誠實說明需要互動授權、沒有實作', !c.features.input.mouse.ok && /RemoteDesktop/.test(c.features.input.mouse.reason) && /沒有實作/.test(c.features.input.mouse.reason));
t.check('每個能力項都有 ok 布林；不可用的都有 reason（不會是空訊息）', (() => { const bad = []; const walk = (o, p) => { if (o && typeof o === 'object') { if ('ok' in o && o.ok === false && !o.reason) bad.push(p); if (!('ok' in o)) for (const [k, v] of Object.entries(o)) walk(v, p + '.' + k); } }; for (const env of [{ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME', WAYLAND_DISPLAY: 'w' }, { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, {}]) walk(cap(env, [], {}).features, 'f'); return bad.length === 0; })());

// ---- AT-SPI：id 與轉換（純函式部分）
t.check('AT-SPI id：建立與解析、指紋與內容有關（同角色同名稱同指紋）', (() => { const id = A.buildId(1234, [0, 2, 1], 'push button', '確定'); const r = A.parseId(id); return r.pid === 1234 && r.path.join() === '0,2,1' && r.fp === A.fingerprint('push button', '確定') && A.fingerprint('push button', '取消') !== r.fp && A.parseId('uia:1:0:abc123') === null && A.parseId('atspi:x') === null; })());
t.check('AT-SPI 節點→element：角色正規化、狀態對照、動作對照、密碼欄不給 set_value', (() => { const pw = A.toElement({ path: [0, 1], role: 'password text', name: '', states: ['sensitive', 'showing', 'focusable', 'focused', 'editable'], rect: { x: 1, y: 2, w: 30, h: 10 }, ifaces: ['Component', 'EditableText', 'Text'], actions: [], pid: 5 }); const bt = A.toElement({ path: [0], role: 'push button', name: 'OK', states: ['sensitive', 'showing', 'enabled'], rect: { x: 0, y: 0, w: 5, h: 5 }, ifaces: ['Action', 'Component'], actions: ['click'], pid: 5 }); const dis = A.toElement({ path: [1], role: 'check box', name: 'c', states: ['showing', 'checkable', 'checked'], rect: { x: 0, y: 0, w: 5, h: 5 }, ifaces: ['Action'], actions: ['toggle'], pid: 5 }); const hid = A.toElement({ path: [2], role: 'label', name: 'x', states: [], rect: null, ifaces: [], pid: 5 }); return pw.role === 'password' && pw.isPassword && !pw.actions.includes('set_value') && pw.focused && bt.role === 'button' && bt.actions.includes('invoke') && bt.enabled && !dis.enabled && dis.checked === true && dis.actions.includes('toggle') && hid.visible === false && hid.rect === null; })());
t.done();
