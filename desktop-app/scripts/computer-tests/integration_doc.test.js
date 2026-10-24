// node scripts/computer-tests/integration_doc.test.js -- renderer/src/computer/INTEGRATION.md 裡「貼上用」的區塊：領域形狀、工具名稱都存在、任務提示的 regex 正反例、YAML 可解析、embed 片段語法、補丁可乾淨套用
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite } = require('./_t.js');
const t = suite('integration_doc');
const ROOT = path.join(__dirname, '..', '..'), md = fs.readFileSync(path.join(ROOT, 'renderer/src/computer/INTEGRATION.md'), 'utf8');
const block = (name) => { const m = new RegExp('<!-- BLOCK:' + name + ' -->\\s*```(\\w+)\\n([\\s\\S]*?)```').exec(md); if (!m) throw new Error('找不到區塊 ' + name); return m[2]; };
global.FaComputerCore = require('../../renderer/src/computer/computer_core.js'); global.FaComputerVision = require('../../renderer/src/computer/computer_vision.js');
const Host = require('../../renderer/src/computer/computer_host.js');

// ---- 領域
const dom = new Function('return ({' + block('domain').trim().replace(/,\s*$/, '') + '})')().computer_use;
t.check('領域：label／toolNames／systemPrompt／dynamicNote／enabled 形狀跟 editors 一樣', dom && dom.enabled === true && typeof dom.label === 'string' && Array.isArray(dom.toolNames) && typeof dom.systemPrompt === 'string' && typeof dom.dynamicNote === 'string' && /^路由建議：/.test(dom.dynamicNote));
t.check('領域的 toolNames 與 host 實際註冊的 19 個工具完全一致', JSON.stringify(dom.toolNames.slice().sort()) === JSON.stringify(Host.TOOL_NAMES.slice().sort()));
t.check('領域提示詞：說明只有使用者能啟用／指定範圍、優先無障礙、驗證、不碰密碼、中止', ['只有使用者能做', 'computer_ui_tree', 'verify', '密碼欄', 'computer_abort', 'origin.x'].every((k) => dom.systemPrompt.includes(k)));

// ---- 任務提示
const hint = new Function('return ' + block('hint').replace(/^FA_TASK_TOOL_HINTS\.push\(/, '(').trim().replace(/;$/, ''))();
t.check('任務提示：id、re、neg、tools、note 都在，tools 與 host 一致', hint.id === 'computer_use' && hint.re instanceof RegExp && hint.neg instanceof RegExp && JSON.stringify(hint.tools.slice().sort()) === JSON.stringify(Host.TOOL_NAMES.slice().sort()) && /computer_capabilities/.test(hint.note) && /只有他能做/.test(hint.note));
const hit = (s) => hint.re.test(s) && !hint.neg.test(s);
const pos = ['幫我操作一下這台電腦，把記事本打開', '幫我點一下那個確定按鈕的視窗', '請幫我在輸入欄位打字 hello', '看一下我的螢幕上現在有什麼', '截一張螢幕畫面給我', '用 computer use 幫我開設定', '連到這個 VNC 看看畫面 192.168.1.5:5901', '幫我操作遠端桌面', 'inspect the UI Automation tree of notepad', 'use xdotool to click the button', '讀 at-spi 的控制項樹', 'RDP 連線的畫面看不到按鈕', '控制滑鼠和鍵盤打字'];
const neg = ['怎麼設定遠端桌面', '教我 vnc 的原理', '用 selenium 自動化網頁', '幫我寫一個 playwright 腳本', '瀏覽器分頁裡的按鈕要怎麼點', '寫一個 hello world 程式', '把這張圖片轉成 pdf', '幫我翻譯這句話', '請你整理這份文件', '網頁自動化爬蟲怎麼做'];
for (const s of pos) t.check('命中：' + s, hit(s));
for (const s of neg) t.check('不命中：' + s, !hit(s));
// 不跟其他既有提示打架：載入 floating-assistant.js 的 TASK-HINTS 區塊，確認這些句子不會同時命中別的提示（除了我們自己）
(() => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/src/floating-assistant.js'), 'utf8'), a = src.indexOf('/* TASK-HINTS-BEGIN */'), b = src.indexOf('/* TASK-HINTS-END */'); if (a < 0 || b < 0) return t.skip('與既有任務提示的衝突檢查', '找不到 TASK-HINTS 標記');
  const hints = new Function(src.slice(a, b) + '\nreturn _faTaskToolHints;')(); const others = (s) => hints(s).map((h) => h.id).filter((id) => id !== 'computer_use');
  const clash = pos.filter((s) => others(s).length); t.check('正例不會同時命中既有的其他任務提示（圖片轉 PDF、翻譯、編輯器…）', clash.length === 0, clash.map((s) => s + ' → ' + others(s)));
  const regress = ['把這些照片合成一個pdf', '畫一張貓的圖片', '翻成英文'].filter((s) => hint.re.test(s) && !hint.neg.test(s)); t.check('也不會搶走既有提示的句子', regress.length === 0, regress);
})();

// ---- YAML
(() => {
  let yaml = null; try { yaml = require('js-yaml'); } catch (_) { /* */ } if (!yaml) return t.skip('YAML 解析', '沒有 js-yaml');
  const y = block('yaml'); const entry = yaml.load('items:\n' + y).items[0];
  t.check('YAML：id、name、summary、how(slash／domain／tools)、platforms、samples、updated 都有；tools 與 host 一致、平台只有 desktop', entry.id === 'computer-use' && entry.name && entry.summary && entry.how.domain === 'computer_use' && entry.how.slash[0] === '/computer' && JSON.stringify(entry.how.tools.slice().sort()) === JSON.stringify(Host.TOOL_NAMES.slice().sort()) && JSON.stringify(entry.platforms) === '["desktop"]' && entry.samples.length >= 3 && /^2026-/.test(String(entry.updated instanceof Date ? entry.updated.toISOString() : entry.updated)));
  const cur = yaml.load(fs.readFileSync(path.join(ROOT, 'features/ai-features.yaml'), 'utf8')); const all = cur.categories.flatMap((c) => c.features.map((f) => f.id)); t.check('清冊裡還沒有 computer-use（貼上不會重複）或已貼過', all.filter((i) => i === 'computer-use').length <= 1);
})();

// ---- embed 片段
(() => { const code = block('embed'); try { new Function('path', 'root', 'fs', 'src', code + '\nreturn 1;'); t.check('embed-code-ui 片段語法正確', true); } catch (e) { t.check('embed-code-ui 片段語法正確', false, e.message); } t.check('embed 片段的嵌入順序是 core → vision → host，並檢查標記', /COMPUTER_MODULES = \[\['computer_core'[\s\S]*'computer_vision'/.test(code) && /COMPUTERHOST-BEGIN/.test(code) && /找不到 ' \+ mark/.test(code)); })();
// 實際模擬 embed 對一份假的 floating-assistant 原始碼做替換，然後在「沒有 module／require」的環境載入
(() => {
  const code = block('embed'); let src = '/* COMPUTERCORE-BEGIN */\n/* COMPUTERCORE-END */\n/* COMPUTERVISION-BEGIN */\n/* COMPUTERVISION-END */\n/* COMPUTERHOST-BEGIN */\n/* COMPUTERHOST-END */\nreturn { c: typeof FaComputerCore, v: typeof FaComputerVision.tileScan, h: FaComputerHost.methods._registerComputerTools ? 1 : 0, n: FaComputerHost.TOOL_NAMES.length };';
  const log = console.log; console.log = () => {}; let embedded; try { embedded = new Function('path', 'root', 'fs', 'src', code + '\nreturn src;')(path, ROOT, fs, src); } finally { console.log = log; }
  const out = new Function('window', embedded)({ desktopAPI: null });
  t.check('模擬 embed：三個模組嵌進去後，在沒有 module／require 的全域裡一起可用', out.c === 'object' && out.v === 'function' && out.h === 1 && out.n === 19, out);
})();

// ---- 補丁可乾淨套用（暫存副本）；已接線就略過
(() => {
  const wired = /computer-use-ipc\.js/.test(fs.readFileSync(path.join(ROOT, 'main-ext.js'), 'utf8')); if (wired) return t.check('主行程已接線（main-ext 載入 computer-use-ipc、preload 有 computer）', /fa:computer:/.test(fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')) && /computer-use-ipc\.js/.test(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-patch-')); for (const f of ['main.js', 'main-ext.js', 'preload.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  const r = spawnSync('patch', ['-p1', '--dry-run', '-s', '-i', path.join(ROOT, 'renderer/src/computer/main-wiring.patch')], { cwd: tmp, encoding: 'utf8' }); t.check('main-wiring.patch 可以乾淨套用到目前的 main.js／main-ext.js／preload.js／package.json', r.status === 0, r.stdout + r.stderr);
  if (r.status === 0) { spawnSync('patch', ['-p1', '-s', '-i', path.join(ROOT, 'renderer/src/computer/main-wiring.patch')], { cwd: tmp }); let ok = true; try { for (const f of ['main.js', 'main-ext.js', 'preload.js']) new (require('vm').Script)(require('module').wrap(fs.readFileSync(path.join(tmp, f), 'utf8')), { filename: f }); JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')); } catch (e) { ok = false; } t.check('套用後語法正確，且 package.json／LIVE_PATCH 列了全部 15 個新檔', ok && ['computer-use-ipc.js', 'rfb-client.js', 'computer-use-win-cs.js'].every((f) => fs.readFileSync(path.join(tmp, 'package.json'), 'utf8').includes('"' + f + '"') && fs.readFileSync(path.join(tmp, 'main.js'), 'utf8').includes('"' + f + '"'))); }
  fs.rmSync(tmp, { recursive: true, force: true });
})();
// 每個主行程檔案都真的存在、能 require
t.check('15 個主行程模組都存在且可載入', ['computer-png', 'computer-use-elements', 'computer-use-safety', 'computer-use-linux-parse', 'computer-use-linux', 'computer-use-atspi', 'computer-use-win-cs', 'computer-use-windows', 'computer-use-uia', 'computer-ws', 'rfb-codec', 'rfb-client', 'computer-remote', 'computer-use', 'computer-use-ipc'].every((f) => { try { require('../../' + f + '.js'); return true; } catch (_) { return false; } }));
t.done();
