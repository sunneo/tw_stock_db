#!/usr/bin/env node
'use strict';
// 產生網頁版的「全螢幕 GUI 入口」（每個有圖形介面的斜線指令一個網址）：
//   web/aiweb/<指令>/index.html      全螢幕頁，例如 .../web/aiweb/musiclib/
//   web/aiweb/fa-gui.js              上面那些頁共用的載入器（SHA 釘住、同源、同一份 IndexedDB／fap）
//   web/aiweb/gui/index.html         指令清單頁（找不到的名稱也會落到這裡，附友善提示）
//   web/aiweb/index.html 的 hash 區塊 #/musiclib 或 #musiclib 轉到上面的全螢幕頁；#/ 或找不到的名稱轉到清單頁
//
// 指令清單來源：floating-assistant.js 裡的 register_slash_command 登錄表（自動解析，不手抄描述）；
// 「哪些有 GUI」由 aiweb-gui/gui-commands.json 指定，每個名稱都要在登錄表裡存在，否則失敗。
//
// 用法：node scripts/gen-aiweb-pages.js --web <網頁版 repo 根目錄> [--sha <40 位完整 commit SHA>] [--src <floating-assistant.js>] [--dry-run]
//   --web 預設讀環境變數 WEB_REPO，再退到 <本 repo>/../videos-嗨投資；--sha 預設讀 <web>/web/index.html 裡的 var SHA。
//   publish.sh 在換完 SHA 之後呼叫，所以發布時入口頁的 SHA 會跟主頁一起更新。

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const DEFAULT_SRC = path.join(HERE, '..', 'renderer', 'src', 'floating-assistant.js');
const TPL_DIR = path.join(HERE, 'aiweb-gui');
const GUI_LIST_FILE = path.join(TPL_DIR, 'gui-commands.json');
const FA_TEMPLATE = path.join(TPL_DIR, 'fa-gui.template.js');
const ROUTER_BEGIN = '<!-- fa-gui-router:begin（由 desktop-app/scripts/gen-aiweb-pages.js 產生，請勿手改）-->';
const ROUTER_END = '<!-- fa-gui-router:end -->';
const GUI_META = 'name="fa-gui-cmd"';
const SHA_RE = /^[0-9a-f]{40}$/;
// 只用來在報告裡提醒「描述像 GUI、但沒列進 gui-commands.json」的指令，不影響產生結果
const GUI_HINT_RE = /編輯器|介面|GUI|圖形|面板|視窗|終端機|播放|曲庫|音樂庫|藏書|畫布|卡片/;

// 解析登錄表：每個 register_slash_command('/名稱', …) 取第一次出現；描述取呼叫參數裡最長的字串常值
function parseRegistry(src) {
  const re = /register_slash_command\(\s*(['"`])(\/[a-z0-9][a-z0-9-]*)\1/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src))) {
    const name = m[2];
    if (out.has(name)) continue;
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 900);
    const cut = rest.search(/\basync\s*\(|\(\s*argsText|\bfunction\b|=>|register_slash_command|\)\s*;\s*(\r?\n|$)/);
    const head = cut >= 0 ? rest.slice(0, cut) : rest;
    const lit = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
    let best = '';
    let l;
    while ((l = lit.exec(head))) {
      const s = l[1] !== undefined ? l[1] : l[2];
      if (s.length > best.length) best = s;
    }
    out.set(name, { cmd: name, desc: best.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

function readGuiList(file = GUI_LIST_FILE) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(j.gui)) throw new Error('gui-commands.json 缺少 gui 陣列');
  const seen = new Set();
  for (const c of j.gui) {
    if (typeof c !== 'string' || !/^\/[a-z0-9][a-z0-9-]*$/.test(c)) throw new Error('指令名稱格式錯誤：' + c);
    if (seen.has(c)) throw new Error('gui-commands.json 重複：' + c);
    seen.add(c);
  }
  return j.gui;
}

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// 指令 → 目錄名（去掉開頭的斜線）。不做任何別的轉換，網址就是 aiweb/<指令名>/
function dirOf(cmd) { return cmd.slice(1); }

// 全螢幕頁。相對路徑依深度計算：aiweb/<指令>/ 往上兩層是 web/
function pageHtml(cmd, desc) {
  return `<!DOCTYPE html>
<html lang="zh-Hant" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="fa-gui-cmd" content="${esc(cmd)}">
<title>${esc(cmd)} · AI 助理</title>
<!-- 離線模型的多執行緒需要 SharedArrayBuffer：同 web/aiweb/index.html，用 coi-serviceworker（相對於 web/） -->
<script src="../../coi-serviceworker.js"></script>
</head>
<body class="fa-gui-page">
<div id="fa-gui-top"><a href="../gui/">← 指令清單</a><span class="fa-gui-cmd">${esc(cmd)}</span><span id="status" class="fa-gui-status"></span></div>
<div id="app"></div>
<noscript>這個全螢幕 GUI 需要 JavaScript。</noscript>
<!-- 指令說明：${esc(desc)} -->
<script src="../fa-gui.js" defer></script>
</body>
</html>
`;
}

// 清單頁：列出所有 GUI 指令；hash 是找不到的名稱時顯示提示
function listHtml(entries) {
  const items = entries.map((e) => `<li><a href="../${esc(dirOf(e.cmd))}/"><code>${esc(e.cmd)}</code></a><span>${esc(e.desc)}</span></li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-Hant" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>全螢幕 GUI 指令清單 · AI 助理</title>
<style>
  html,body{margin:0;background:#0d1117;color:#cbd5e1;font:15px/1.5 -apple-system,"Segoe UI","Noto Sans TC",sans-serif;}
  main{max-width:760px;margin:0 auto;padding:16px;}
  h1{font-size:20px;margin:8px 0 4px;}
  .hint{opacity:.8;font-size:13px;margin:0 0 12px;}
  #notfound{display:none;margin:0 0 12px;padding:10px 12px;border:1px solid #7f1d1d;border-radius:8px;color:#fca5a5;background:#2a1215;}
  ul{list-style:none;padding:0;margin:0;}
  li{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid #30363d;border-radius:8px;margin-bottom:8px;background:#161b22;}
  li a{color:#58a6ff;text-decoration:none;}
  li span{font-size:13px;opacity:.85;}
  a.back{color:#cbd5e1;font-size:13px;}
</style>
</head>
<body>
<main>
  <a class="back" href="../">← AI 助理</a>
  <h1>全螢幕 GUI 指令</h1>
  <p class="hint">每個指令各有一個網址，打開後整頁就是那個 GUI；資料（IndexedDB、fap）與 AI 助理是同一份。也可以用 <code>aiweb/#/指令名</code> 開啟。</p>
  <p id="notfound"></p>
  <ul>
${items}
  </ul>
</main>
<script>
(function () {
  var raw = (location.hash || '').replace(/^#\\/?/, '');
  if (!raw) return;
  var box = document.getElementById('notfound');
  box.textContent = '找不到指令「/' + decodeURIComponent(raw) + '」，或它沒有全螢幕 GUI。以下是可以開的指令。';
  box.style.display = 'block';
})();
</script>
</body>
</html>
`;
}

// hash 轉址區塊（插在 web/aiweb/index.html 的 <body> 之後；沒有 hash 時什麼都不做，AI 助理照舊）
function routerBlock(cmds) {
  const names = cmds.map(dirOf);
  return `${ROUTER_BEGIN}
<script>
/* aiweb hash 形式：#/musiclib 或 #musiclib → ./musiclib/（全螢幕 GUI）；#/ 或找不到的名稱 → ./gui/（清單頁）。
   沒有 hash 時不動，維持原本的 AI 助理頁。名單由產生腳本從 gui-commands.json 寫入。 */
(function () {
  var GUI = ${JSON.stringify(names).replace(/</g, '\\u003c')};
  var hash = location.hash || '';
  if (hash.length < 2) return;
  var name = decodeURIComponent(hash.slice(1)).replace(/^\\/+/, '').replace(/\\/+$/, '');
  if (name && GUI.indexOf(name) >= 0) { location.replace('./' + name + '/'); return; }
  location.replace('./gui/#' + encodeURIComponent(name));
})();
</script>
${ROUTER_END}`;
}

// 把 router 區塊插進 aiweb/index.html（已有區塊就整段換掉，沒有就插在 <body> 之後）
function injectRouter(html, block) {
  const b = html.indexOf(ROUTER_BEGIN), e = html.indexOf(ROUTER_END);
  if (b >= 0 && e > b) return html.slice(0, b) + block + html.slice(e + ROUTER_END.length);
  const m = /<body[^>]*>/i.exec(html);
  if (!m) throw new Error('aiweb/index.html 找不到 <body>，無法插入 hash 轉址');
  const at = m.index + m[0].length;
  return html.slice(0, at) + '\n' + block + '\n' + html.slice(at);
}

// 把 fa-gui.js 模板的 SHA 代入
function faGuiScript(sha, tplText) {
  if (!SHA_RE.test(sha)) throw new Error('SHA 必須是 40 位小寫十六進位完整 commit：' + sha);
  return tplText.replace(/__FA_SHA__/g, sha);
}

// 讀網頁版 web/index.html 的 var SHA 當預設
function readPinnedSha(webRoot) {
  const f = path.join(webRoot, 'web', 'index.html');
  const m = /var SHA = '([0-9a-f]{40})'/.exec(fs.readFileSync(f, 'utf8'));
  if (!m) throw new Error('web/index.html 裡找不到 var SHA 釘住的 commit');
  return m[1];
}

// 產生計畫（不寫檔）：回傳要寫的檔案、要刪的過期入口、報告
function buildPlan({ registrySrc, sha, webRoot, guiList, templateText, aiIndexHtml, existingGuiDirs }) {
  const reg = parseRegistry(registrySrc);
  const entries = [];
  const missing = [];
  for (const cmd of guiList) {
    const e = reg.get(cmd);
    if (!e) missing.push(cmd);
    else entries.push(e);
  }
  if (missing.length) throw new Error('gui-commands.json 裡這些指令沒有在登錄表登錄過：' + missing.join(' '));
  const hints = [...reg.values()].filter((e) => GUI_HINT_RE.test(e.desc) && !guiList.includes(e.cmd)).map((e) => e.cmd);

  const aiweb = path.join(webRoot, 'web', 'aiweb');
  const files = [];
  files.push({ abs: path.join(aiweb, 'fa-gui.js'), content: faGuiScript(sha, templateText) });
  for (const e of entries) files.push({ abs: path.join(aiweb, dirOf(e.cmd), 'index.html'), content: pageHtml(e.cmd, e.desc) });
  files.push({ abs: path.join(aiweb, 'gui', 'index.html'), content: listHtml(entries) });
  files.push({ abs: path.join(aiweb, 'index.html'), content: injectRouter(aiIndexHtml, routerBlock(guiList)) });

  // 過期的全螢幕頁（以前產生、現在已從清單移除）：只刪有 fa-gui-cmd 標記的目錄，不碰手寫的頁面
  const keep = new Set(entries.map((e) => dirOf(e.cmd)));
  const stale = (existingGuiDirs || []).filter((d) => !keep.has(d));
  return { entries, files, stale, hints, reg };
}

function listExistingGuiDirs(aiweb) {
  if (!fs.existsSync(aiweb)) return [];
  return fs.readdirSync(aiweb, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => {
      const f = path.join(aiweb, n, 'index.html');
      return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(GUI_META);
    });
}

function main(argv) {
  const args = { web: process.env.WEB_REPO || path.join(HERE, '..', '..', 'videos-嗨投資'), src: DEFAULT_SRC, sha: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--web') args.web = argv[++i];
    else if (a === '--sha') args.sha = argv[++i];
    else if (a === '--src') args.src = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error('不認得的參數：' + a);
  }
  const webRoot = path.resolve(args.web);
  const sha = args.sha || readPinnedSha(webRoot);
  const aiweb = path.join(webRoot, 'web', 'aiweb');
  const aiIndex = path.join(aiweb, 'index.html');
  const plan = buildPlan({
    registrySrc: fs.readFileSync(args.src, 'utf8'),
    sha,
    webRoot,
    guiList: readGuiList(),
    templateText: fs.readFileSync(FA_TEMPLATE, 'utf8'),
    aiIndexHtml: fs.readFileSync(aiIndex, 'utf8'),
    existingGuiDirs: listExistingGuiDirs(aiweb),
  });
  for (const f of plan.files) {
    if (!args.dryRun) {
      fs.mkdirSync(path.dirname(f.abs), { recursive: true });
      fs.writeFileSync(f.abs, f.content, 'utf8');
    }
  }
  if (!args.dryRun) for (const d of plan.stale) fs.rmSync(path.join(aiweb, d), { recursive: true, force: true });
  const lines = [
    `${args.dryRun ? '[dry-run] ' : ''}SHA ${sha.slice(0, 8)}，全螢幕 GUI ${plan.entries.length} 個：`,
    ...plan.entries.map((e) => `  ${e.cmd} → aiweb/${dirOf(e.cmd)}/`),
    ...(plan.stale.length ? [`已移除過期入口：${plan.stale.join(', ')}`] : []),
    ...(plan.hints.length ? [`提醒（描述像 GUI、但沒列進 gui-commands.json，請確認）：${plan.hints.join(' ')}`] : []),
  ];
  console.log(lines.join('\n'));
  return plan;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error('gen-aiweb-pages 失敗：' + e.message); process.exit(1); }
}

module.exports = { parseRegistry, readGuiList, buildPlan, injectRouter, routerBlock, pageHtml, listHtml, faGuiScript, readPinnedSha, listExistingGuiDirs, dirOf, ROUTER_BEGIN, ROUTER_END };
