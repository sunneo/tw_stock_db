// node scripts/computer-tests/windows.test.js -- Windows 後端的腳本產生與解析（fixture；Windows 上實跑是「未實測」）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('../../computer-use-windows.js');
const CS = require('../../computer-use-win-cs.js');
const U = require('../../computer-use-uia.js');
const { suite } = require('./_t.js');
const t = suite('computer-use-windows');

// ---- 腳本產生
const decodeParams = (script) => { const m = /FromBase64String\('([^']+)'\)/.exec(script); return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); };
const s1 = W.buildScript('windowAction', { hwnd: '1234', action: 'close', x: 0, y: 0, w: 0, h: 0 });
t.check('腳本：載入 DLL、DPI 初始化、呼叫、輸出、錯誤處理都在，且參數是 base64 JSON（不用字串拼接，沒有注入面）', /Add-Type -Path \$dll/.test(s1) && /\[FaDpi\]::Init\(\)/.test(s1) && /\[FaWin\]::Action/.test(s1) && /Console\]::Out\.Write\(\$r\)/.test(s1) && /catch \{/.test(s1) && decodeParams(s1).hwnd === '1234');
const evil = "x'; Remove-Item -Recurse C:\\ ; '" + '"$(calc)`';
t.check('腳本：惡意字串只會出現在 base64 參數裡，不會出現在腳本本體', !W.buildScript('clipboardSet', { text: evil }).includes('Remove-Item') && decodeParams(W.buildScript('clipboardSet', { text: evil })).text === evil);
t.check('腳本：中文參數 UTF-8 base64 往返', decodeParams(W.buildScript('clipboardSet', { text: '你好，世界 😀' })).text === '你好，世界 😀');
t.check('每一種腳本都能產生', Object.keys(W.SCRIPTS).every((k) => typeof W.buildScript(k, { ops: [{ op: 'sleep', ms: 1 }] }, true) === 'string'));
t.check('ops 腳本：move／click／drag／wheel／chord／type／sleep 都有對應的 C# 呼叫', (() => { const s = W.SCRIPTS.ops(); return ['Move', 'Click', 'Drag', 'Wheel', 'Chord', 'TypeText'].every((m) => s.includes('[FaInput]::' + m)) && /Start-Sleep/.test(s); })());
const short = W.buildPowerShellInvocation(s1), compile = W.buildCompileScript(), long = W.buildPowerShellInvocation(compile);
t.check('短腳本走 -NoProfile -NonInteractive -STA -EncodedCommand（UTF-16LE base64）', short.mode === 'encoded' && short.args.slice(0, 3).join(' ') === '-NoProfile -NonInteractive -STA' && short.args[3] === '-EncodedCommand' && Buffer.from(short.args[4], 'base64').toString('utf16le') === s1);
t.check('每個動作的腳本都夠短可以走 -EncodedCommand（命令列上限 32767）', Object.keys(W.SCRIPTS).every((k) => W.buildPowerShellInvocation(W.buildScript(k, { hwnd: '1', x: 1, y: 1, w: 1, h: 1, depth: 4, maxNodes: 100, ops: [{ op: 'click', x: 1, y: 2, button: 1, count: 1 }] }, true)).mode === 'encoded'));
t.check('編譯腳本太長 → 改用 -File（暫存 .ps1），並帶 -ExecutionPolicy Bypass', long.mode === 'file' && long.args.includes('-File') && long.args.includes('Bypass') && W.buildPowerShellInvocation(compile, { limit: 10 ** 9 }).mode === 'encoded');
t.check('編譯腳本：here-string 結構正確（@\' 與 \'@ 各一行）、只在 DLL 不存在時編、先編到暫存檔再改名', (() => { const lines = compile.split('\n'); return lines.filter((l) => /^'@$/.test(l)).length === 1 && lines.filter((l) => /-TypeDefinition @'$/.test(l)).length === 1 && /if \(-not \(Test-Path \$dll\)\)/.test(compile) && /Move-Item -Force \$tmp \$dll/.test(compile) && /-OutputAssembly \$tmp -OutputType Library/.test(compile) && compile.includes('UIAutomationClient'); })());
t.check('DLL 檔名含 C# 原始碼雜湊（改版自動重編）', /fa-cu-[0-9a-f]{12}\.dll$/.test(W.DLL_REL) && W.DLL_REL.includes(W.CS_HASH));
t.check('C# 原始碼不含 C# 6+ 語法（?. 、nameof、$"、=>）— Windows PowerShell 5.1 的 Add-Type 只有 C# 5', !/\?\.|nameof\(|\$"|\) =>|\w =>/.test(CS.CS_ALL), (CS.CS_ALL.match(/.{0,20}(\?\.|nameof\(|\$"|=>).{0,20}/) || [])[0]);
t.check('C# 原始碼不含會破壞 PowerShell here-string 的行（以 \'@ 開頭）', !CS.CS_ALL.split('\n').some((l) => /^'@/.test(l)));

// ---- C# 編譯檢查（有 mono 的 mcs 才做）
(() => {
  const mcs = spawnSync('sh', ['-c', 'command -v mcs']).stdout.toString().trim();
  if (!mcs) return t.skip('C# 編譯檢查', '沒有 mono 的 mcs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-cs-')); fs.writeFileSync(path.join(dir, 'a.cs'), CS.CS_NO_UIA);
  const r = spawnSync(mcs, ['-langversion:5', '-target:library', '-out:' + path.join(dir, 'a.dll'), '-r:System.Drawing', '-r:System.Windows.Forms', path.join(dir, 'a.cs')], { encoding: 'utf8' });
  t.check('C#（user32／GDI／輸入／截圖）用 mcs -langversion:5 編譯通過', r.status === 0 && fs.existsSync(path.join(dir, 'a.dll')), (r.stdout + r.stderr).slice(0, 600));
  // 純運算的 FaJson 在 mono 上直接跑：非 ASCII 跳脫與指紋
  fs.writeFileSync(path.join(dir, 'j.cs'), 'class T{static void Main(){System.Console.WriteLine(FaJson.Str("a\\"b\\\\c\\n中文é"));System.Console.WriteLine(FaJson.Fnv("push button|確定"));}}');
  const c2 = spawnSync(mcs, ['-langversion:5', '-out:' + path.join(dir, 'j.exe'), '-r:' + path.join(dir, 'a.dll'), path.join(dir, 'j.cs')], { encoding: 'utf8' });
  const mono = spawnSync('sh', ['-c', 'command -v mono']).stdout.toString().trim();
  if (c2.status === 0 && mono) { fs.copyFileSync(path.join(dir, 'a.dll'), path.join(dir, 'a.dll')); const o = spawnSync(mono, [path.join(dir, 'j.exe')], { encoding: 'utf8' }).stdout.split('\n'); t.check('FaJson.Str 在 mono 上：非 ASCII 全部 \\u 跳脫（輸出純 ASCII）', o[0] === '"a\\"b\\\\c\\n\\u4e2d\\u6587\\u00e9"', o[0]); t.check('C# 的指紋演算法與 AT-SPI／JS 版一致（FNV-1a，UTF-8 前 120 bytes）', o[1] === require('../../computer-use-atspi.js').fingerprint('push button', '確定'), o[1]); }
  fs.rmSync(dir, { recursive: true, force: true });
})();

// ---- 按鍵、nircmd
t.check('chordToVk：ctrl+s、F5、alt+Left、字母數字、不認得回 null', JSON.stringify(W.chordToVk('ctrl+s')) === '[17,83]' && JSON.stringify(W.chordToVk('f5')) === '[116]' && JSON.stringify(W.chordToVk('alt+left')) === '[18,37]' && JSON.stringify(W.chordToVk('ctrl+shift+7')) === '[17,16,55]' && W.chordToVk('ctrl+nonsense') === null);
const nc = W.nircmdCommands;
t.check('nircmd：移動、點擊（單／雙／右）、滾輪、組合鍵、視窗動作、截圖', JSON.stringify(nc({ op: 'move', x: 5, y: 6 })) === '[["setcursor","5","6"]]' && JSON.stringify(nc({ op: 'click', x: 1, y: 2, button: 1, count: 2 })) === '[["setcursor","1","2"],["sendmouse","left","dblclick"]]' && JSON.stringify(nc({ op: 'click', x: 1, y: 2, button: 3, count: 1 })[1]) === '["sendmouse","right","click"]' && JSON.stringify(nc({ op: 'wheel', x: 1, y: 2, dy: 2 })[1]) === '["sendmouse","wheel","-240"]' && JSON.stringify(nc({ op: 'chord', chord: 'ctrl+return' })) === '[["sendkeypress","ctrl+enter"]]' && JSON.stringify(nc({ op: 'window', action: 'close', hwnd: '77' })) === '[["win","close","handle","77"]]' && JSON.stringify(nc({ op: 'window', action: 'move', hwnd: '77', x: 1, y: 2 })) === '[["win","move","handle","77","1","2"]]' && JSON.stringify(nc({ op: 'screenshot', file: 'a.png', x: 0, y: 0, w: 10, h: 10 })) === '[["savescreenshot","a.png","0","0","10","10"]]' && nc({ op: 'type' }) === null);

// ---- 解析
t.check('parseJsonOutput：BOM、前面有雜訊行、錯誤 JSON', W.parseJsonOutput('\uFEFF{"ok":true}').ok === true && W.parseJsonOutput('WARNING: x\r\n{"ok":true,"a":1}\r\n').a === 1 && W.parseJsonOutput('nonsense') === null && W.parseJsonOutput('') === null && W.parseJsonOutput('{"ok":false,"error":"x"}').ok === false);
const listJson = { ok: true, foreground: 66000, windows: [
  { hwnd: 66000, pid: 1234, process: 'notepad', title: '\u7121\u984c - \u8a18\u4e8b\u672c', class: 'Notepad', rect: { x: 108, y: 160, w: 800, h: 560 }, frame: { x: 100, y: 100, w: 816, h: 640 }, outer: { x: 93, y: 100, w: 830, h: 647 }, visible: true, minimized: false, maximized: false, focused: true, enabled: true, cloaked: 0, owned: false, type: 'normal', index: 0, onCurrentDesktop: true, desktopId: 'd1' },
  { hwnd: 70000, pid: 99, process: 'explorer', title: 'Program Manager', class: 'Progman', rect: { x: 0, y: 0, w: 1920, h: 1080 }, frame: { x: 0, y: 0, w: 1920, h: 1080 }, outer: { x: 0, y: 0, w: 1920, h: 1080 }, visible: true, minimized: false, maximized: false, focused: false, enabled: true, cloaked: 0, owned: false, type: 'normal', index: 1, onCurrentDesktop: true, desktopId: '' }] };
const wins = W.normalizeWindows(listJson);
t.check('視窗清單正規化：id 是 0x 十六進位、z 越大越上面、中文標題、狀態', wins.length === 2 && wins[0].id === '0x000101d0' && wins[0].z > wins[1].z && wins[0].title === '無題 - 記事本' && wins[0].focused && wins[0].state.includes('focused') && wins[0].frame.w === 816 && wins[0].source === 'win32', wins[0]);
t.check('視窗 id 解析：0x、十進位、壞格式', W.parseWindowId('0x000101d0') === '66000' && W.parseWindowId('66000') === '66000' && W.parseWindowId('abc') === null && W.parseWindowId('0x1;calc') === null);
t.check('安全引擎能直接用 Windows 視窗清單（topmostAt）', (() => { const S = require('../../computer-use-safety.js'); return S.topmostAt(wins, 200, 200).process === 'notepad' && S.topmostAt(wins, 1500, 900).process === 'explorer'; })());

// ---- UIA 轉換
const uiaNode = { path: '0', fp: 'abc123', controlType: 'ControlType.Window', name: '登入', automationId: 'LoginWindow', className: 'Window', framework: 'WPF', rect: { x: 100, y: 100, w: 400, h: 300 }, enabled: true, offscreen: false, focused: false, isPassword: false, pid: 4321, patterns: ['WindowPatternIdentifiers.Pattern'], children: [
  { path: '0.0', fp: 'a00001', controlType: 'ControlType.Edit', name: '帳號', automationId: 'user', className: 'TextBox', rect: { x: 120, y: 150, w: 200, h: 24 }, enabled: true, offscreen: false, focused: true, isPassword: false, patterns: ['ValuePattern', 'TextPattern'], value: 'alice' },
  { path: '0.1', fp: 'a00002', controlType: 'ControlType.Edit', name: '密碼', automationId: 'pwd', className: 'PasswordBox', rect: { x: 120, y: 190, w: 200, h: 24 }, enabled: true, offscreen: false, focused: false, isPassword: true, patterns: ['ValuePattern'] },
  { path: '0.2', fp: 'a00003', controlType: 'ControlType.Button', name: '登入', automationId: 'ok', className: 'Button', rect: { x: 300, y: 340, w: 80, h: 30 }, enabled: false, offscreen: false, focused: false, isPassword: false, patterns: ['InvokePattern'] },
  { path: '0.3', fp: 'a00004', controlType: 'ControlType.CheckBox', name: '記住我', automationId: '', className: 'CheckBox', rect: { x: 120, y: 230, w: 100, h: 20 }, enabled: true, offscreen: true, isPassword: false, patterns: ['TogglePattern'], toggle: 'On' }] };
const uel = U.toElement(uiaNode, { hwnd: 66000, windowId: '0x000101d0' });
t.check('UIA 節點轉 element：角色、名稱、AutomationId、矩形、座標空間螢幕座標、window id', uel.role === 'window' && uel.name === '登入' && uel.automationId === 'LoginWindow' && uel.rect.x === 100 && uel.source === 'uia' && uel.window === '0x000101d0' && uel.id === 'uia:66000:0:abc123' && uel.children.length === 4, uel.id);
const [eUser, ePwd, eBtn, eChk] = uel.children;
t.check('UIA：文字框有 set_value 與值；密碼欄 role=password、isPassword、沒有 set_value', eUser.role === 'textbox' && eUser.value === 'alice' && eUser.actions.includes('set_value') && eUser.focused && ePwd.role === 'password' && ePwd.isPassword && !ePwd.actions.includes('set_value'), ePwd);
t.check('UIA：停用的按鈕 enabled:false 且有 invoke；勾選框 toggle、checked:true、offscreen→visible:false', !eBtn.enabled && eBtn.actions.includes('invoke') && eChk.checked === true && eChk.actions.includes('toggle') && eChk.visible === false);
t.check('UIA id 解析', JSON.stringify(U.parseId(eUser.id)) === '{"hwnd":"66000","path":"0.0","fp":"a00001"}' && U.parseId('atspi:1:0:abc123') === null);
const E = require('../../computer-use-elements.js');
t.check('UIA 元件可以用共同的搜尋：按名稱「登入」同時找到視窗與按鈕、依 automationId 找密碼欄', E.findElements(uel, { name: '登入' }).length === 2 && E.findElements(uel, { automationId: 'pwd' })[0].isPassword === true);
const w32 = U.win32ToElement({ hwnd: 500, class: 'Edit', text: 'hello', ctrlId: 1001, rect: { x: 10, y: 10, w: 100, h: 20 }, visible: true, enabled: true, children: [{ hwnd: 501, class: 'Button', text: '確定', ctrlId: 1, rect: { x: 10, y: 40, w: 50, h: 20 }, visible: true, enabled: true }] }, { windowId: '0x1f4' });
t.check('Win32 子視窗樹轉 element（類別→角色）', w32.role === 'textbox' && w32.children[0].role === 'button' && w32.children[0].name === '確定' && w32.source === 'win32');

// ---- 以假 exec 驅動後端：第一次先編 DLL（走 -File），之後的動作走 -EncodedCommand；DLL 不見時自動重編
(async () => {
  const calls = []; let dllExists = false;
  const fake = async (cmd, args, o) => {
    const isFile = args.includes('-File'), script = isFile ? fs.readFileSync(args[args.indexOf('-File') + 1], 'utf8').replace(/^\uFEFF/, '') : Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    calls.push({ cmd, mode: isFile ? 'file' : 'encoded', head: script.slice(0, 60), script });
    if (/-TypeDefinition/.test(script)) { dllExists = true; return { ok: true, stdout: '{"ok":true,"compiled":true}', stderr: '' }; }
    if (!dllExists) return { ok: true, stdout: '{"ok":false,"error":"Cannot find path \'C:\\\\Temp\\\\fa.dll\' because it does not exist."}', stderr: '' };
    if (/\[FaWin\]::ListWindows/.test(script)) return { ok: true, stdout: '\uFEFF' + JSON.stringify(listJson) + '\r\n', stderr: '' };
    if (/\[FaWin\]::Monitors/.test(script)) return { ok: true, stdout: '{"ok":true,"monitors":[{"name":"\\\\.\\\\DISPLAY1","primary":true,"rect":{"x":0,"y":0,"w":1920,"h":1080},"dpi":144,"scale":1.5}]}', stderr: '' };
    if (/\[FaInput\]/.test(script)) return { ok: true, stdout: '{"ok":true,"done":1}', stderr: '' };
    if (/Get-Clipboard/.test(script)) return { ok: true, stdout: '{"ok":true,"text":"\\u4f60\\u597d"}', stderr: '' };
    if (/\[FaShot\]::Screen/.test(script)) { const P = require('../../computer-png.js'); const img = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4).fill(200) }; return { ok: true, stdout: JSON.stringify({ ok: true, width: 4, height: 2, origin: { x: -1920, y: 0 }, base64: Buffer.from(P.encodePng(img)).toString('base64') }), stderr: '' }; }
    return { ok: true, stdout: '{"ok":true}', stderr: '' };
  };
  const be = W.createWindowsBackend({ exec: fake, which: (n) => (n === 'powershell' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : ''), nircmd: false });
  await t.acheck('後端：列視窗 → 先編 DLL（-File 模式）再執行（-EncodedCommand 模式），解析 BOM 輸出', async () => { const r = await be.listWindows(); return r.ok && r.windows.length === 2 && r.activeId === '0x000101d0' && calls[0].mode === 'file' && /-TypeDefinition/.test(calls[0].script) && calls[1].mode === 'encoded' && calls.length === 2; });
  await t.acheck('後端：第二次不再編譯', async () => { const n = calls.length; await be.listWindows(); return calls.length === n + 1; });
  await t.acheck('後端：多螢幕座標（負的 origin）與縮放比 1.5 原樣回傳；截圖 PNG 可解碼', async () => { const m = await be.monitors(); const s = await be.screenshot({ rect: { x: -1920, y: 0, w: 4, h: 2 } }); return m.ok && m.monitors[0].scale === 1.5 && s.ok && s.origin.x === -1920 && require('../../computer-png.js').decodePng(s.png).width === 4; });
  await t.acheck('後端：點擊／打字（Unicode）／組合鍵／捲動都是一個 ops 腳本，參數在 base64 裡', async () => {
    await be.click(10, 20, { button: 'right', count: 2 }); await be.typeText('你好 world'); await be.key('ctrl+shift+t'); await be.scroll(5, 5, 0, 3);
    const ops = calls.filter((c) => /\[FaInput\]|foreach \(\$o in/.test(c.script)).slice(-4).map((c) => decodeParams(c.script).ops[0]);
    return ops[0].op === 'click' && ops[0].button === 3 && ops[0].count === 2 && ops[1].op === 'type' && ops[1].text === '你好 world' && JSON.stringify(ops[2].vks) === '[17,16,84]' && ops[3].op === 'wheel' && ops[3].dy === 3;
  });
  await t.acheck('後端：剪貼簿（中文）', async () => { const r = await be.clipboardGet(); await be.clipboardSet('abc'); return r.ok && r.text === '你好'; });
  await t.acheck('後端：視窗動作走 FaWin.Action，id 轉成十進位 hwnd', async () => { await be.windowAction('close', '0x000101d0'); const c = calls[calls.length - 1]; return /FaWin\]::Action/.test(c.script) && decodeParams(c.script).hwnd === '66000' && decodeParams(c.script).action === 'close'; });
  await t.acheck('後端：壞視窗 id 直接拒絕、不跑腳本', async () => { const n = calls.length; const r = await be.windowAction('close', '0x1;calc'); return !r.ok && calls.length === n; });
  await t.acheck('後端：DLL 被清掉（Cannot find path）→ 自動重編再重試', async () => { dllExists = false; const n = calls.length; const r = await be.listWindows(); return r.ok && calls.slice(n).some((c) => /-TypeDefinition/.test(c.script)); });
  await t.acheck('後端：沒有 PowerShell → 優雅回報而不是丟例外', async () => { const b2 = W.createWindowsBackend({ exec: fake, which: () => '' }); const r = await b2.listWindows(); const c = await b2.capabilities(); return !r.ok && /PowerShell/.test(r.error) && c.features.windows.list.ok === false && /找不到 PowerShell/.test(c.summary); });
  await t.acheck('capabilities：標明未實測、nircmd 說明', async () => { const b3 = W.createWindowsBackend({ exec: fake, which: (n) => (n === 'powershell' ? 'p' : n === 'nircmd' ? 'n' : '') }); const c = await b3.capabilities(); return /未實測/.test(c.summary) && c.features.windows.list.unverified === true && c.notes.some((x) => /nircmd/.test(x)) && c.features.a11y.ok === true; });
  await t.acheck('nircmd 只在所有螢幕縮放 100% 時用（這裡 1.5 倍 → 仍走 PowerShell）', async () => { const b4 = W.createWindowsBackend({ exec: fake, which: (n) => (n === 'powershell' ? 'p' : n === 'nircmd' ? 'n.exe' : '') }); const n = calls.length; await b4.click(1, 2); return calls.slice(n).every((c) => c.cmd !== 'n.exe') && calls.slice(n).some((c) => /FaInput/.test(c.script)); });
  t.done();
})();
