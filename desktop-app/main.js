// Electron主行程——floating-assistant.js桌面版封裝。
//
// 安全模型（跟renderer/preload.js合起來看）：
//   - webPreferences關掉nodeIntegration、開contextIsolation，renderer（含
//     floating-assistant.js自己會動態載入的第三方CDN函式庫，例如
//     isomorphic-git/three.js/jszip）完全碰不到Node API，只能透過
//     preload.js用contextBridge刻意暴露出去的窄接口跟這裡的IPC handler
//     溝通——即使renderer被XSS或載到惡意CDN內容，也不能直接讀寫檔案/
//     執行程式，一定要經過這裡的白名單式IPC handler。
//   - 「檔案直接存取」有兩層：預設走`fap_*`工具＋`resolveWithinRoot()`，
//     只能碰使用者自己用原生資料夾選擇對話框（或直接輸入路徑）明確授權過
//     的root目錄；2026-09-15使用者明確要求桌面版「不應該有任何限制」，
//     額外加上一組`fs_*`raw filesystem工具（`fa:rawfs:*` IPC），完全不做
//     root範圍檢查，可以直接讀寫這台電腦上任何`rootPath`使用者帳號有OS
//     權限碰到的路徑——這是使用者自己選的取捨（見AskUserQuestion紀錄：
//     「完全不限制：整台電腦任何路徑」），不是預設行為，只有桌面版有、
//     不影響web部署（floating-assistant.js核心完全沒有這個能力）。
//   - 「執行程式」（child_process）與「檔案寫入/刪除」（含raw fs）都要求
//     `execEnabled`/`settings.execEnabled`先被使用者在頂部列打開才能用；
//     預設也要求每次執行前跳原生confirm對話框（execConfirmRequired，存在
//     settings.json，使用者可以自己在頂部列關掉，但這是使用者自己的
//     選擇，不是這個app的預設姿態）。2026-09-15使用者要求`run_command`
//     要有真正的bash/shell能力（管線、重導向、&&等），改用真的shell
//     （POSIX是`/bin/bash -c`，Windows是`cmd.exe /d /c`）執行——這比原本
//     `execFile`（陣列參數、不經過shell）多了shell注入的風險面，是使用者
//     明確要求、拿confirm對話框當唯一防線換來的能力，不是預設偷偷放寬。
"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { execFile, spawn } = require("child_process");
const { startLocalProxy } = require("./local-proxy.js");

const USER_DATA_DIR = () => app.getPath("userData");
const ROOTS_FILE = () => path.join(USER_DATA_DIR(), "fap-roots.json");
const SETTINGS_FILE = () => path.join(USER_DATA_DIR(), "desktop-settings.json");
// tw_stock_db客製: 2026-09-15使用者要求——「server configure」讓NVAPI_KEY/
// OpenRouter key只存在主行程這一側（renderer/localStorage完全看不到真正
// 的金鑰值），呼應worker.js既有的handleNvidiaProxy/handleOpenRouterProxy
// 那套「client端只送假金鑰、真金鑰在server端注入」設計，只是這裡的
// 「server」換成本機Electron主行程，不需要真的部署雲端服務。使用者要求
// 存成JSON（不要.env），格式：{"NVAPI_KEY":"...","OPENROUTER_API_KEY":"..."}。
const SECRETS_FILE = () => path.join(USER_DATA_DIR(), "secrets.json");

let mainWindow = null;
let localProxyPort = null;

// ---------- roots（使用者授權的直接存取資料夾）持久化 ----------
async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}
async function writeJsonSafe(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function listRoots() {
  return readJsonSafe(ROOTS_FILE(), []);
}
async function saveRoots(roots) {
  await writeJsonSafe(ROOTS_FILE(), roots);
}

async function getDesktopSettings() {
  return readJsonSafe(SETTINGS_FILE(), { execConfirmRequired: true, execEnabled: false });
}
async function saveDesktopSettings(settings) {
  await writeJsonSafe(SETTINGS_FILE(), settings);
}

// 環境變數優先（給想用CI/系統層級設定的使用者），檔案是主要途徑（使用者
// 要求的「server configure」，人可以直接編輯這個JSON檔）。回傳的物件只
// 在主行程內部使用——絕對不要整個回傳給renderer，IPC只回報「有沒有設定」
// 的布林值（見下面fa:secrets:status），真正的金鑰值只有local-proxy.js
// 組請求header時才會讀取。
async function getSecrets() {
  const fromFile = await readJsonSafe(SECRETS_FILE(), {});
  return {
    NVAPI_KEY: process.env.NVAPI_KEY || fromFile.NVAPI_KEY || "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || fromFile.OPENROUTER_API_KEY || "",
  };
}
async function saveSecrets(patch) {
  const cur = await readJsonSafe(SECRETS_FILE(), {});
  const next = { ...cur, ...patch };
  await writeJsonSafe(SECRETS_FILE(), next);
  return next;
}

// path traversal防禦：把rootPath跟relPath解析成絕對路徑後，確認結果路徑
// 真的落在rootPath底下（含rootPath本身），不然一律拒絕——這是renderer端
// FapGitFs/fap_*工具已經有的`.`/`..`片段檢查的「主行程再把關一次」版本，
// 不能只信任renderer那層防禦。
function resolveWithinRoot(rootPath, relPath) {
  const target = path.resolve(rootPath, relPath || ".");
  const normalizedRoot = path.resolve(rootPath);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`路徑「${relPath}」超出授權的資料夾範圍`);
  }
  return target;
}

async function findRoot(rootId) {
  const roots = await listRoots();
  const rec = roots.find((r) => r.id === rootId);
  if (!rec) throw new Error(`找不到授權的資料夾（id=${rootId}）`);
  return rec;
}

// ---------- IPC: roots ----------
ipcMain.handle("fa:roots:list", async () => listRoots());

async function registerRoot(rootPath, label) {
  const roots = await listRoots();
  const id = "root_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const rec = { id, label: label || path.basename(rootPath), rootPath, addedAt: Date.now() };
  roots.push(rec);
  await saveRoots(roots);
  return rec;
}

ipcMain.handle("fa:roots:add", async (_evt, { label } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "選擇要授權給AI直接讀寫的資料夾",
  });
  if (result.canceled || !result.filePaths.length) return null;
  return registerRoot(result.filePaths[0], label);
});

// tw_stock_db客製: 2026-09-15使用者回報——floating-assistant.js核心內建的
// 「+新增資料夾」按鈕（走window.showDirectoryPicker→這裡的fa:roots:add→
// dialog.showOpenDialog）在他的環境點了完全沒反應，懷疑是這台機器（雙螢幕
// 佈局，這次除錯過程也另外發現過螢幕座標系統混亂的問題）讓原生資料夾選擇
// 對話框開到看不到的地方，或某種環境相容性問題——不管根本原因是什麼，
// 使用者明確要求要有一個「跳過原生對話框，直接輸入路徑」的後路。這條路由
// 完全不經過dialog.showOpenDialog，使用者自己在renderer的文字輸入框打
// 絕對路徑，這裡只做「路徑真的存在且是資料夾」的驗證後直接註冊——跟
// fa:roots:add共用同一個registerRoot()，註冊完的root跟透過原生對話框選的
// 完全等價（renderer那邊的ElectronFapStore/floating-assistant.js的fap_*
// 工具無從分辨兩者差異）。
ipcMain.handle("fa:roots:addByPath", async (_evt, { folderPath, label } = {}) => {
  const raw = String(folderPath || "").trim();
  if (!raw) throw new Error("請輸入資料夾路徑");
  const resolved = path.resolve(raw);
  let st;
  try {
    st = await fs.stat(resolved);
  } catch (err) {
    throw new Error(`路徑不存在或無法存取：${resolved}`);
  }
  if (!st.isDirectory()) throw new Error(`這不是一個資料夾：${resolved}`);
  return registerRoot(resolved, label);
});

ipcMain.handle("fa:roots:rename", async (_evt, { id, label }) => {
  const roots = await listRoots();
  const rec = roots.find((r) => r.id === id);
  if (!rec) return false;
  rec.label = label;
  await saveRoots(roots);
  return true;
});

ipcMain.handle("fa:roots:remove", async (_evt, { id }) => {
  const roots = await listRoots();
  const next = roots.filter((r) => r.id !== id);
  await saveRoots(next);
  return true;
});

// ---------- IPC: 檔案系統（一律要求rootId，只在該root底下操作） ----------
ipcMain.handle("fa:fs:stat", async (_evt, { rootId, relPath }) => {
  const rec = await findRoot(rootId);
  const target = resolveWithinRoot(rec.rootPath, relPath);
  const st = await fs.stat(target);
  return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
});

ipcMain.handle("fa:fs:readdir", async (_evt, { rootId, relPath }) => {
  const rec = await findRoot(rootId);
  const target = resolveWithinRoot(rec.rootPath, relPath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
});

ipcMain.handle("fa:fs:mkdir", async (_evt, { rootId, relPath }) => {
  const rec = await findRoot(rootId);
  const target = resolveWithinRoot(rec.rootPath, relPath);
  await fs.mkdir(target, { recursive: true });
  return true;
});

ipcMain.handle("fa:fs:readFile", async (_evt, { rootId, relPath, encoding }) => {
  const rec = await findRoot(rootId);
  const target = resolveWithinRoot(rec.rootPath, relPath);
  const buf = await fs.readFile(target);
  if (encoding === "utf8") return { text: buf.toString("utf8") };
  return { base64: buf.toString("base64") };
});

ipcMain.handle("fa:fs:writeFile", async (_evt, { rootId, relPath, text, base64 }) => {
  const rec = await findRoot(rootId);
  const target = resolveWithinRoot(rec.rootPath, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const buf = base64 != null ? Buffer.from(base64, "base64") : Buffer.from(String(text ?? ""), "utf8");
  await fs.writeFile(target, buf);
  return { ok: true, sizeBytes: buf.length };
});

ipcMain.handle("fa:fs:remove", async (_evt, { rootId, relPath, recursive }) => {
  const rec = await findRoot(rootId);
  const target = resolveWithinRoot(rec.rootPath, relPath);
  await fs.rm(target, { recursive: !!recursive, force: true });
  return true;
});

// ---------- IPC: raw filesystem（完全不做root範圍檢查，2026-09-15使用者 ----------
// 明確要求「桌面版不應該有任何限制」——這組handler直接吃使用者/AI給的
// 絕對路徑，不透過fap_*那套「先授權root、再用相對路徑」的模型，唯一的
// 邊界就是OS本身的檔案權限（這個Electron process的執行帳號有沒有權限碰
// 那個路徑）。跟fa:fs:*（root-scoped）並存，不是取代——Advance Settings
// 「檔案存取管理」清單/既有fap_*工具仍然是原本的授權模型，這組是額外提供
// 給desktop_ops domain的無限制工具，讀寫都不需要先在roots.json登記。
function detectLikelyBinary(buf) {
  // 簡單啟發式：前8KB內出現NUL byte就視為二進位——文字檔案(含UTF-8多語言
  // 內容)幾乎不會有NUL byte，這是業界常見(例如git/diff)判斷二進位的方式。
  const sample = buf.subarray(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

ipcMain.handle("fa:rawfs:stat", async (_evt, { path: p } = {}) => {
  const target = path.resolve(String(p || ""));
  const st = await fs.stat(target);
  return { path: target, isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
});

ipcMain.handle("fa:rawfs:readdir", async (_evt, { path: p } = {}) => {
  const target = path.resolve(String(p || ""));
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
});

ipcMain.handle("fa:rawfs:readFile", async (_evt, { path: p, encoding } = {}) => {
  const target = path.resolve(String(p || ""));
  const buf = await fs.readFile(target);
  if (encoding === "base64") return { path: target, base64: buf.toString("base64"), sizeBytes: buf.length };
  if (detectLikelyBinary(buf)) {
    return { path: target, base64: buf.toString("base64"), sizeBytes: buf.length, likelyBinary: true };
  }
  return { path: target, text: buf.toString("utf8"), sizeBytes: buf.length };
});

ipcMain.handle("fa:rawfs:writeFile", async (_evt, { path: p, text, base64 } = {}) => {
  const target = path.resolve(String(p || ""));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const buf = base64 != null ? Buffer.from(base64, "base64") : Buffer.from(String(text ?? ""), "utf8");
  await fs.writeFile(target, buf);
  return { ok: true, path: target, sizeBytes: buf.length };
});

ipcMain.handle("fa:rawfs:mkdir", async (_evt, { path: p } = {}) => {
  const target = path.resolve(String(p || ""));
  await fs.mkdir(target, { recursive: true });
  return { ok: true, path: target };
});

ipcMain.handle("fa:rawfs:remove", async (_evt, { path: p, recursive } = {}) => {
  const target = path.resolve(String(p || ""));
  await fs.rm(target, { recursive: !!recursive, force: true });
  return { ok: true, path: target };
});

// 遞迴搜尋檔名（不比對內容），深度/結果數都有上限避免掃到整個磁碟卡死。
async function findFilesRecursive(startDir, pattern, maxDepth, maxResults, out, depth) {
  if (out.length >= maxResults || depth > maxDepth) return;
  let entries;
  try {
    entries = await fs.readdir(startDir, { withFileTypes: true });
  } catch (_) {
    return; // 沒有權限/已被刪除的目錄，安靜略過，不中斷整個搜尋
  }
  for (const e of entries) {
    if (out.length >= maxResults) return;
    const full = path.join(startDir, e.name);
    if (pattern.test(e.name)) out.push({ path: full, isDirectory: e.isDirectory(), isFile: e.isFile() });
    if (e.isDirectory()) await findFilesRecursive(full, pattern, maxDepth, maxResults, out, depth + 1);
  }
}

ipcMain.handle("fa:rawfs:find", async (_evt, { path: p, pattern, maxDepth, maxResults } = {}) => {
  const startDir = path.resolve(String(p || ""));
  let regex;
  try {
    regex = new RegExp(String(pattern || ""), "i");
  } catch (err) {
    throw new Error(`不合法的pattern（正規表示式）：${String(err.message || err)}`);
  }
  const out = [];
  await findFilesRecursive(startDir, regex, Number(maxDepth) > 0 ? Number(maxDepth) : 8, Number(maxResults) > 0 ? Number(maxResults) : 200, out, 0);
  return out;
});

// ---------- IPC: 執行本機程式 ----------
const MAX_EXEC_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB輸出上限，避免暴走程式塞爆記憶體
const EXEC_TIMEOUT_MS = 120000; // 2分鐘逾時，避免卡死的程式讓工具呼叫永遠不回應

function escapeHtmlForConfirmWindow(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// tw_stock_db客製: 2026-09-15使用者實測回報——`dialog.showMessageBox(mainWindow,
// {...})`在他的環境（跟之前`dialog.showOpenDialog`的symptom一致）不會真的
// 顯示出來：使用者勾了「每次執行前跳確認框」，AI呼叫run_command卻完全沒有
// 任何對話框跳出來，後來確認是`await dialog.showMessageBox(...)`整個卡住
// 沒有resolve（不是「跳過確認直接執行」，是原生對話框本身沒有真的顯示、
// 卡在那裡等一個使用者看不到、點不到的視窗）。改成不依賴Electron`dialog`
// 模組這個API，自己開一個真正的`BrowserWindow`（parent+modal:true，仍然是
// 主行程完全掌控的內容，不是renderer可以繞過的東西——安全性質跟原本
// `dialog.showMessageBox`一樣：使用者一定要真的點下「執行」才會繼續，
// renderer/AI都無法跳過這一步）當作確認視窗，載入純字串組出來的`data:`
// HTML（只有這個小視窗才開`nodeIntegration:true`，因為這裡100%是自己
// 組的固定內容、不會載入任何CDN/AI產生的可執行內容，cmdLine/cwd顯示前有
// 做HTML escape，不會有XSS風險）。
function showExecConfirmWindow(cmdLine, cwd) {
  return new Promise((resolve) => {
    const responseChannel = `fa:exec-confirm-response:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const confirmWin = new BrowserWindow({
      width: 560,
      height: 280,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "AI要求執行程式",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    confirmWin.setMenuBarVisibility(false);
    let settled = false;
    const finish = (allowed) => {
      if (settled) return;
      settled = true;
      resolve(allowed);
      if (!confirmWin.isDestroyed()) confirmWin.close();
    };
    ipcMain.once(responseChannel, (_evt, allowed) => finish(!!allowed));
    confirmWin.on("closed", () => finish(false)); // 使用者直接關掉這個視窗＝視同拒絕
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, "Segoe UI", sans-serif; background:#161b22; color:#e5e7eb; margin:0; padding:20px; box-sizing:border-box; }
      h3 { margin:0 0 12px 0; }
      .detail { background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:10px 12px; font-size:12px; white-space:pre-wrap; word-break:break-all; margin-bottom:18px; }
      .buttons { display:flex; justify-content:flex-end; gap:10px; }
      button { padding:7px 16px; border-radius:6px; cursor:pointer; font-size:13px; }
      #deny { background:#21262d; color:#e5e7eb; border:1px solid #30363d; }
      #allow { background:#c0392b; color:#fff; border:none; }
    </style></head><body>
      <h3>⚠️ AI要求執行程式</h3>
      <div class="detail">指令：${escapeHtmlForConfirmWindow(cmdLine)}\n工作目錄：${escapeHtmlForConfirmWindow(cwd)}</div>
      <div class="buttons">
        <button id="deny">取消</button>
        <button id="allow">執行</button>
      </div>
      <script>
        const { ipcRenderer } = require("electron");
        document.getElementById("deny").onclick = () => ipcRenderer.send(${JSON.stringify(responseChannel)}, false);
        document.getElementById("allow").onclick = () => ipcRenderer.send(${JSON.stringify(responseChannel)}, true);
      </script>
    </body></html>`;
    confirmWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });
}

// tw_stock_db客製: 2026-09-15使用者實測回報——floating-assistant.js核心到處
// 用`window.prompt()`/`window.confirm()`問使用者（檔案存取管理的「重新
// 命名」用prompt、「移除」用confirm，其餘散落在整個核心程式碼裡的一次性
// 小型互動也是同一套），Electron從來沒有實作`window.prompt()`（這是
// Electron本身長年的已知限制，不是這個app的bug——`alert`/`confirm`
// Chromium有內建，`prompt`從來沒有），呼叫了不會顯示任何東西、直接回傳
// null，讓使用者覺得「按了沒反應」。不能改floating-assistant.js本身（那個
// 檔案要維持host-agnostic，在真正的瀏覽器裡prompt()/confirm()完全正常），
// 所以在桌面版把這兩個全域函式**整個蓋掉**，改用跟上面showExecConfirmWindow
// 同一種「自己開一個真正的BrowserWindow」機制——差別是prompt()/confirm()
// 呼叫端期待的是**同步**回傳值（`const label = prompt(...);`接下來那行
// 就要用到結果，不是Promise），所以renderer那端要改用
// `ipcRenderer.sendSync()`（真的會讓renderer那個執行緒暫停，直到主行程
// 把`event.returnValue`設好為止——即使主行程那端的handler內部是
// `async`、中間await了顯示視窗等使用者互動的Promise，也完全沒問題，
// sendSync在底層等的是「這個sync channel真的收到回覆」，不是「handler
// 函式同步return」，這是Electron本身支援、有文件記載的合法用法）。
function showTextInputWindow(message, defaultValue) {
  return new Promise((resolve) => {
    const responseChannel = `fa:prompt-response:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const win = new BrowserWindow({
      width: 480, height: 220, parent: mainWindow, modal: true,
      resizable: false, minimizable: false, maximizable: false,
      title: "FloatingAssistant",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.setMenuBarVisibility(false);
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; resolve(result); if (!win.isDestroyed()) win.close(); };
    ipcMain.once(responseChannel, (_evt, result) => finish(result));
    win.on("closed", () => finish(null));
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, "Segoe UI", sans-serif; background:#161b22; color:#e5e7eb; margin:0; padding:20px; box-sizing:border-box; }
      p { margin:0 0 12px 0; font-size:13px; white-space:pre-wrap; }
      input { width:100%; box-sizing:border-box; padding:7px 9px; border:1px solid #30363d; border-radius:6px; background:#0d1117; color:#e5e7eb; font-size:13px; margin-bottom:16px; }
      .buttons { display:flex; justify-content:flex-end; gap:10px; }
      button { padding:7px 16px; border-radius:6px; cursor:pointer; font-size:13px; border:1px solid #30363d; background:#21262d; color:#e5e7eb; }
      #ok { background:#3182ce; color:#fff; border:none; }
    </style></head><body>
      <p>${escapeHtmlForConfirmWindow(message)}</p>
      <input type="text" id="val" value="${escapeHtmlForConfirmWindow(defaultValue || "")}">
      <div class="buttons">
        <button id="cancel">取消</button>
        <button id="ok">確定</button>
      </div>
      <script>
        const { ipcRenderer } = require("electron");
        const input = document.getElementById("val");
        const send = (v) => ipcRenderer.send(${JSON.stringify(responseChannel)}, v);
        document.getElementById("cancel").onclick = () => send(null);
        document.getElementById("ok").onclick = () => send(input.value);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(input.value); });
        input.focus();
        input.select();
      </script>
    </body></html>`;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });
}

function showConfirmWindow(message) {
  return new Promise((resolve) => {
    const responseChannel = `fa:confirm-response:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const win = new BrowserWindow({
      width: 480, height: 200, parent: mainWindow, modal: true,
      resizable: false, minimizable: false, maximizable: false,
      title: "FloatingAssistant",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.setMenuBarVisibility(false);
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; resolve(result); if (!win.isDestroyed()) win.close(); };
    ipcMain.once(responseChannel, (_evt, result) => finish(!!result));
    win.on("closed", () => finish(false));
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, "Segoe UI", sans-serif; background:#161b22; color:#e5e7eb; margin:0; padding:20px; box-sizing:border-box; }
      p { margin:0 0 18px 0; font-size:13px; white-space:pre-wrap; }
      .buttons { display:flex; justify-content:flex-end; gap:10px; }
      button { padding:7px 16px; border-radius:6px; cursor:pointer; font-size:13px; border:1px solid #30363d; background:#21262d; color:#e5e7eb; }
      #ok { background:#3182ce; color:#fff; border:none; }
    </style></head><body>
      <p>${escapeHtmlForConfirmWindow(message)}</p>
      <div class="buttons">
        <button id="cancel">取消</button>
        <button id="ok">確定</button>
      </div>
      <script>
        const { ipcRenderer } = require("electron");
        document.getElementById("cancel").onclick = () => ipcRenderer.send(${JSON.stringify(responseChannel)}, false);
        document.getElementById("ok").onclick = () => ipcRenderer.send(${JSON.stringify(responseChannel)}, true);
      </script>
    </body></html>`;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });
}

function showAlertWindow(message) {
  return new Promise((resolve) => {
    const responseChannel = `fa:alert-response:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const win = new BrowserWindow({
      width: 480, height: 180, parent: mainWindow, modal: true,
      resizable: false, minimizable: false, maximizable: false,
      title: "FloatingAssistant",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.setMenuBarVisibility(false);
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); if (!win.isDestroyed()) win.close(); };
    ipcMain.once(responseChannel, () => finish());
    win.on("closed", () => finish());
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, "Segoe UI", sans-serif; background:#161b22; color:#e5e7eb; margin:0; padding:20px; box-sizing:border-box; }
      p { margin:0 0 18px 0; font-size:13px; white-space:pre-wrap; }
      .buttons { display:flex; justify-content:flex-end; }
      button { padding:7px 16px; border-radius:6px; cursor:pointer; font-size:13px; background:#3182ce; color:#fff; border:none; }
    </style></head><body>
      <p>${escapeHtmlForConfirmWindow(message)}</p>
      <div class="buttons"><button id="ok">確定</button></div>
      <script>
        const { ipcRenderer } = require("electron");
        document.getElementById("ok").onclick = () => ipcRenderer.send(${JSON.stringify(responseChannel)});
      </script>
    </body></html>`;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });
}

ipcMain.on("fa:sync-prompt", async (event, { message, defaultValue } = {}) => {
  event.returnValue = await showTextInputWindow(message, defaultValue);
});
ipcMain.on("fa:sync-confirm", async (event, { message } = {}) => {
  event.returnValue = await showConfirmWindow(message);
});
ipcMain.on("fa:sync-alert", async (event, { message } = {}) => {
  await showAlertWindow(message);
  event.returnValue = true;
});

// tw_stock_db客製: 2026-09-15使用者要求——「直接輸入路徑」對話框太難用，
// 要有真的可以瀏覽的按鈕。不能用`dialog.showOpenDialog`（已知在這台機器
// 不會顯示），改成自己刻一個最小可用的資料夾瀏覽器視窗——不是完整的檔案
// 總管，只需要「列出目前目錄底下的子目錄、點進去、回上一層、選定目前
// 目錄」這幾個操作。因為這個視窗100%是這裡自己組的固定內容（不會載入
// 任何CDN/AI產生的內容），直接開`nodeIntegration:true`讓它自己
// `require('fs')`列目錄，不需要另外設計一組IPC來回傳目錄清單。
function showFolderBrowserWindow(startPath) {
  return new Promise((resolve) => {
    const responseChannel = `fa:folder-browser-response:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const win = new BrowserWindow({
      width: 640, height: 480, parent: mainWindow, modal: true,
      title: "選擇資料夾",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.setMenuBarVisibility(false);
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; resolve(result); if (!win.isDestroyed()) win.close(); };
    ipcMain.once(responseChannel, (_evt, result) => finish(result || null));
    win.on("closed", () => finish(null));
    const initialPathJson = JSON.stringify(startPath || app.getPath("home"));
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, "Segoe UI", sans-serif; background:#161b22; color:#e5e7eb; margin:0; padding:0; display:flex; flex-direction:column; height:100vh; box-sizing:border-box; }
      #toolbar { padding:10px 14px; border-bottom:1px solid #30363d; display:flex; gap:8px; align-items:center; }
      #pathInput { flex:1; padding:6px 8px; border:1px solid #30363d; border-radius:6px; background:#0d1117; color:#e5e7eb; font-size:12px; }
      #list { flex:1; overflow-y:auto; padding:6px 10px; }
      .item { padding:7px 10px; border-radius:6px; cursor:pointer; font-size:13px; }
      .item:hover { background:#21262d; }
      #footer { padding:10px 14px; border-top:1px solid #30363d; display:flex; justify-content:flex-end; gap:8px; }
      button { padding:6px 14px; border-radius:6px; cursor:pointer; font-size:13px; border:1px solid #30363d; background:#21262d; color:#e5e7eb; }
      #select { background:#3182ce; color:#fff; border:none; }
      .err { color:#93a4b7; padding:10px 4px; font-size:12px; }
    </style></head><body>
      <div id="toolbar">
        <button id="up">⬆ 上一層</button>
        <input type="text" id="pathInput">
        <button id="go">前往</button>
      </div>
      <div id="list"></div>
      <div id="footer">
        <button id="cancel">取消</button>
        <button id="select">選擇這個資料夾</button>
      </div>
      <script>
        const fs = require("fs");
        const path = require("path");
        const { ipcRenderer } = require("electron");
        let current = ${initialPathJson};
        const pathInput = document.getElementById("pathInput");
        const list = document.getElementById("list");
        function render() {
          pathInput.value = current;
          list.innerHTML = "";
          let entries = [];
          try {
            entries = fs.readdirSync(current, { withFileTypes: true })
              .filter((e) => { try { return e.isDirectory(); } catch (_) { return false; } })
              .map((e) => e.name)
              .sort((a, b) => a.localeCompare(b));
          } catch (err) {
            list.innerHTML = '<div class="err">無法讀取：' + String((err && err.message) || err) + '</div>';
            return;
          }
          if (!entries.length) list.innerHTML = '<div class="err">（沒有子資料夾）</div>';
          for (const name of entries) {
            const div = document.createElement("div");
            div.className = "item";
            div.textContent = "\\uD83D\\uDCC1 " + name;
            div.onclick = () => { current = path.join(current, name); render(); };
            list.appendChild(div);
          }
        }
        document.getElementById("up").onclick = () => { current = path.dirname(current); render(); };
        document.getElementById("go").onclick = () => { current = pathInput.value.trim() || current; render(); };
        pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("go").click(); });
        document.getElementById("cancel").onclick = () => ipcRenderer.send(${JSON.stringify(responseChannel)}, null);
        document.getElementById("select").onclick = () => ipcRenderer.send(${JSON.stringify(responseChannel)}, current);
        render();
      </script>
    </body></html>`;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });
}

ipcMain.handle("fa:roots:browse", async (_evt, { startPath } = {}) => showFolderBrowserWindow(startPath));

ipcMain.handle("fa:exec:getSettings", async () => getDesktopSettings());
ipcMain.handle("fa:exec:setSettings", async (_evt, patch) => {
  const cur = await getDesktopSettings();
  const next = { ...cur, ...patch };
  await saveDesktopSettings(next);
  return next;
});

// tw_stock_db客製: 2026-09-15使用者明確要求「單機版就是可以編輯、測試、
// 執行」——run_command要有真正的bash/shell能力（管線、重導向、&&、AI把
// 整條指令塞進單一command字串也要能跑，見下方splitCommandLineIfNeeded的
// 說明），而不是原本execFile(陣列參數、不經過shell)那種只能單一執行檔+
// 固定參數陣列的形式。真正修好這個bug的根本方式就是交給一個真的shell去
// 解析——POSIX找/bin/bash（不存在才退回/bin/sh），Windows依序找Git Bash→
// PowerShell→cmd.exe（使用者明確指定的優先順序：「windows用powershell,
// 找看有沒有gitbash, 或用cmd」——這裡解讀成「三選一，優先用能提供bash
// 語意的Git Bash，找不到才退而求其次」，因為使用者同一則訊息也明確要求
// 「bash的能力」，Git Bash是三者中唯一能真正給出bash語法的選項）。
// 安全性不是靠「不給shell」，是靠既有的execEnabled開關＋每次執行前顯示
// 完整指令內容的confirm視窗（使用者必須親自點「執行」）——這條防線在這次
// 改動前後完全沒變，shell能力是使用者在這個防線之上明確要求換來的。
const { existsSync } = require("fs");
const { execFileSync } = require("child_process");

// tw_stock_db客製: 一開始用寫死的幾條C:\Program Files\Git\...路徑找Git
// Bash，實測在這台開發機上完全找不到——Git實際裝在`J:\Program
// Files\Git\`（非標準磁碟機代號），寫死路徑的做法在「Git裝在C碟以外」的
// 機器上一律失效。改成呼叫Windows內建的`where`指令動態找出所有名為
// bash.exe的可執行檔，再從結果裡挑路徑含「Git」的那個——刻意排開
// `C:\Windows\System32\bash.exe`／`...\WindowsApps\bash.exe`這兩個WSL
// launcher stub（呼叫它們會嘗試啟動WSL發行版，不是使用者要的「Git Bash」，
// 沒裝WSL發行版時甚至會直接跳出Windows市集頁面，完全不是預期行為）。
function findExecutableCandidates(exeName) {
  try {
    const out = execFileSync("where", [exeName], { windowsHide: true, encoding: "utf8" });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

let cachedWindowsShell = null;
function resolveWindowsShell() {
  if (cachedWindowsShell) return cachedWindowsShell;
  const bashCandidates = findExecutableCandidates("bash.exe").filter((p) => { try { return existsSync(p); } catch (_) { return false; } });
  const gitBash = bashCandidates.find((p) => /\\Git\\/i.test(p)) || bashCandidates.find((p) => !/\\(System32|WindowsApps)\\/i.test(p));
  if (gitBash) {
    cachedWindowsShell = { name: "git-bash", file: gitBash, buildArgs: (cmd) => ["-c", cmd] };
  } else {
    // PowerShell幾乎必然存在（Windows 7+內建），當作第二選擇；真的連
    // powershell.exe都叫不動時（極端環境），最後才退到cmd.exe。注意：
    // Windows內建的powershell.exe是5.1版，不支援`&&`/`||`語法鏈接
    // （那是PowerShell 7+/pwsh.exe才有的功能）——這是已知限制，如實告知：
    // 找不到Git Bash時，AI下的`&&`鏈接指令在這個fallback下會失敗，
    // 使用者可以安裝Git for Windows（連帶附上Git Bash）來解除這個限制。
    cachedWindowsShell = { name: "powershell", file: "powershell.exe", buildArgs: (cmd) => ["-NoProfile", "-NonInteractive", "-Command", cmd] };
  }
  return cachedWindowsShell;
}

function buildShellSpawnArgs(fullCommandLine) {
  if (process.platform === "win32") {
    const shell = resolveWindowsShell();
    return { file: shell.file, args: shell.buildArgs(fullCommandLine) };
  }
  const bash = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  return { file: bash, args: ["-c", fullCommandLine] };
}

// AI呼叫run_command時，`command`可能已經是完整指令行（含參數/管線等，AI
// 常見的塞法，過去曾因為execFile不經過shell而ENOENT），也可能是乾淨的
// 執行檔名稱+獨立args陣列——兩種都支援，有args就用平台對應的shell-quote
// 規則組回一行，交給上面真正的shell解析（管線/重導向/&&等語法從這裡開始
// 就能正常使用）。
function shellQuoteArg(arg, isWindows) {
  const s = String(arg);
  if (isWindows) {
    if (!/[\s"^&|<>()]/.test(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
  }
  if (!/[^A-Za-z0-9_\/:=.,@%+-]/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildFullCommandLine(command, args) {
  const isWindows = process.platform === "win32";
  if (Array.isArray(args) && args.length) {
    return `${command} ${args.map((a) => shellQuoteArg(a, isWindows)).join(" ")}`;
  }
  return String(command || "").trim();
}

function runShellCommand(fullCommandLine, cwd) {
  return new Promise((resolve) => {
    let spawnSpec;
    try {
      spawnSpec = buildShellSpawnArgs(fullCommandLine);
    } catch (err) {
      resolve({ ok: false, exitCode: -1, signal: null, stdout: "", stderr: "", timedOut: false, errorMessage: String(err.message || err) });
      return;
    }
    let child;
    try {
      child = spawn(spawnSpec.file, spawnSpec.args, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, exitCode: -1, signal: null, stdout: "", stderr: "", timedOut: false, errorMessage: String(err.message || err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        ok: false, exitCode: -1, signal: null,
        stdout: stdout.slice(0, 200000), stderr: stderr.slice(0, 200000),
        timedOut: true, errorMessage: `執行逾時（超過 ${EXEC_TIMEOUT_MS / 1000} 秒），已強制中止。`,
      });
    }, EXEC_TIMEOUT_MS);
    child.stdout.on("data", (d) => { if (stdout.length < MAX_EXEC_OUTPUT_BYTES) stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_EXEC_OUTPUT_BYTES) stderr += d.toString("utf8"); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, exitCode: -1, signal: null, stdout: "", stderr: "", timedOut: false, errorMessage: String(err.message || err) });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0, exitCode: code == null ? -1 : code, signal: signal || null,
        stdout: stdout.slice(0, 200000), stderr: stderr.slice(0, 200000),
        timedOut: false, errorMessage: code === 0 ? null : `命令結束，exit code ${code}`,
      });
    });
  });
}

// 共用confirm gate：run_command與下面的tmux_*工具都是「真的執行東西」，
// 統一走同一個execEnabled檢查＋同一個confirm視窗（顯示同樣格式的指令/
// 工作目錄），不要各自重複一份判斷邏輯。
async function execConfirmGate(cmdLineForDisplay, cwdForDisplay) {
  const settings = await getDesktopSettings();
  if (!settings.execEnabled) {
    throw new Error("執行程式功能目前未啟用，請在Advance設定的「桌面版設定」分頁開啟「允許AI執行程式」。");
  }
  if (settings.execConfirmRequired !== false) {
    const allowed = await showExecConfirmWindow(cmdLineForDisplay, cwdForDisplay);
    if (!allowed) throw new Error("使用者拒絕了這個執行請求。");
  }
}

ipcMain.handle("fa:exec:run", async (_evt, { rootId, command, args, cwdRel, cwdAbs } = {}) => {
  let cwd = app.getPath("home");
  if (cwdAbs) {
    cwd = cwdAbs; // 配合fs_*系列unrestricted工具，允許直接指定絕對路徑當cwd，不受root限制
  } else if (rootId) {
    const rec = await findRoot(rootId);
    cwd = resolveWithinRoot(rec.rootPath, cwdRel || ".");
  }
  const fullCommandLine = buildFullCommandLine(command, args);
  if (!fullCommandLine) throw new Error("缺少要執行的指令內容");
  await execConfirmGate(fullCommandLine, cwd);
  return runShellCommand(fullCommandLine, cwd);
});

// ---------- IPC: tmux（持久化/互動式session，2026-09-15使用者明確要求 ----------
// 「執行指令也要有有bash, tmux的能力」——run_command每次呼叫都是獨立、
// 跑完就結束的子行程，沒辦法維持一個長時間執行/互動式程式（例如開發伺服器、
// REPL）跨越多次工具呼叫的狀態。tmux（POSIX限定，Windows沒有對應工具，
// 呼叫時會得到明確的「這個平台不支援」錯誤，不是silently失敗）讓AI可以
// 開一個具名session、之後分好幾次send-keys/capture-pane，模擬真人打開一個
// 終端機視窗持續操作。三個「會改變狀態/等同執行任意指令」的操作
// （start/send-keys/kill）都走跟run_command同一個execConfirmGate；純讀取
// 的list/capture不用confirm（不會讓任何新東西被執行），但仍要求
// execEnabled已開啟（tmux本身也是一種「執行程式」能力）。
function isTmuxAvailable() {
  return process.platform !== "win32";
}
function requireTmuxAvailable() {
  if (!isTmuxAvailable()) {
    throw new Error("tmux是POSIX（Linux/macOS）限定工具，這台電腦是Windows，沒有這個能力。Windows上請改用run_command，或改用長時間執行時搭配輪詢的方式。");
  }
}
function execFileP(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_EXEC_OUTPUT_BYTES, windowsHide: true, ...opts }, (error, stdout, stderr) => {
      if (error && error.code === "ENOENT") { reject(new Error("找不到tmux，請先在這台電腦安裝tmux（例如 apt install tmux / brew install tmux）。")); return; }
      resolve({ ok: !error, exitCode: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), errorMessage: error ? String(error.message || error) : null });
    });
  });
}

ipcMain.handle("fa:tmux:start", async (_evt, { name, command, cwd } = {}) => {
  requireTmuxAvailable();
  const sessionName = String(name || "").trim();
  if (!sessionName) throw new Error("缺少session名稱");
  const workDir = cwd ? path.resolve(String(cwd)) : app.getPath("home");
  const displayCmd = `tmux new-session -d -s ${sessionName}${command ? ` "${command}"` : ""}`;
  await execConfirmGate(displayCmd, workDir);
  const tmuxArgs = ["new-session", "-d", "-s", sessionName, "-c", workDir];
  if (command) tmuxArgs.push(String(command));
  return execFileP("tmux", tmuxArgs);
});

ipcMain.handle("fa:tmux:sendKeys", async (_evt, { name, keys, enter } = {}) => {
  requireTmuxAvailable();
  const sessionName = String(name || "").trim();
  if (!sessionName) throw new Error("缺少session名稱");
  const keysStr = String(keys || "");
  await execConfirmGate(`tmux send-keys -t ${sessionName} ${keysStr}${enter !== false ? " <Enter>" : ""}`, `(tmux session: ${sessionName})`);
  const tmuxArgs = ["send-keys", "-t", sessionName, keysStr];
  if (enter !== false) tmuxArgs.push("Enter");
  return execFileP("tmux", tmuxArgs);
});

ipcMain.handle("fa:tmux:capture", async (_evt, { name, lines } = {}) => {
  requireTmuxAvailable();
  const settings = await getDesktopSettings();
  if (!settings.execEnabled) throw new Error("執行程式功能目前未啟用，請在Advance設定的「桌面版設定」分頁開啟「允許AI執行程式」。");
  const sessionName = String(name || "").trim();
  if (!sessionName) throw new Error("缺少session名稱");
  const tmuxArgs = ["capture-pane", "-t", sessionName, "-p"];
  if (Number(lines) > 0) tmuxArgs.push("-S", `-${Number(lines)}`);
  return execFileP("tmux", tmuxArgs);
});

ipcMain.handle("fa:tmux:list", async () => {
  requireTmuxAvailable();
  const settings = await getDesktopSettings();
  if (!settings.execEnabled) throw new Error("執行程式功能目前未啟用，請在Advance設定的「桌面版設定」分頁開啟「允許AI執行程式」。");
  const r = await execFileP("tmux", ["list-sessions"]);
  if (!r.ok && /no server running|no sessions/i.test(r.stderr || "")) return { ok: true, exitCode: 0, stdout: "", stderr: "", errorMessage: null };
  return r;
});

ipcMain.handle("fa:tmux:kill", async (_evt, { name } = {}) => {
  requireTmuxAvailable();
  const sessionName = String(name || "").trim();
  if (!sessionName) throw new Error("缺少session名稱");
  await execConfirmGate(`tmux kill-session -t ${sessionName}`, `(tmux session: ${sessionName})`);
  return execFileP("tmux", ["kill-session", "-t", sessionName]);
});

// ---------- IPC: API金鑰（server configure） ----------
// 刻意只回報「有沒有設定」，不回傳實際金鑰值——renderer沒有必要、也不應該
// 看到真正的NVAPI_KEY/OPENROUTER_API_KEY內容，這些值只在local-proxy.js
// 組轉發請求的header時，於主行程內部讀取使用。
ipcMain.handle("fa:secrets:status", async () => {
  const secrets = await getSecrets();
  return {
    nvidia: !!secrets.NVAPI_KEY,
    openrouter: !!secrets.OPENROUTER_API_KEY,
    secretsFile: SECRETS_FILE(),
  };
});
// set是唯一允許renderer「送出」金鑰值的方向（使用者自己在UI打進去要儲存），
// 不是讀取——資料流向跟fa:secrets:status完全相反，各自只開放單一方向。
ipcMain.handle("fa:secrets:set", async (_evt, patch) => {
  const allowedKeys = ["NVAPI_KEY", "OPENROUTER_API_KEY"];
  const filtered = {};
  for (const k of allowedKeys) {
    if (typeof patch[k] === "string") filtered[k] = patch[k].trim();
  }
  await saveSecrets(filtered);
  return true;
});

// ---------- IPC: 其他 ----------
ipcMain.handle("fa:config:getLocalProxyPort", async () => localProxyPort);
ipcMain.handle("fa:shell:openExternal", async (_evt, url) => {
  if (!/^https?:\/\//i.test(String(url))) throw new Error("只允許開啟http(s)網址");
  await shell.openExternal(url);
  return true;
});

// ---------- 視窗建立 ----------
function createWindow() {
  // tw_stock_db客製: 2026-09-15使用者要求——桌面版是單一用途的全螢幕對話
  // 視窗，不是「小工具疊在別的頁面上」的浮動widget，開啟時就該佔滿畫面。
  // 一開始用show:false+ready-to-show裡呼叫maximize()+show()，實測（真的
  // 跑起來截圖檢查）在這台機器上完全沒有效果，視窗還是維持建構時給的
  // 預設大小——`maximize()`在視窗還沒真的show()之前呼叫，在Windows上是
  // 已知會不穩定/沒有效果的時機點（原生視窗handle的工作區邊界要等視窗真的
  // 被OS window manager map出來才會正確計算）。改成從一開始就直接用
  // `screen.getPrimaryDisplay().workAreaSize`算出視窗大小、定位在(0,0)——
  // 不依賴事後呼叫maximize()這個有時機競爭疑慮的API，第一幀畫面就已經是
  // 正確的滿版大小，不會有「先小視窗再跳大」的閃爍，也不會受時機影響。
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    title: "FloatingAssistant",
    // build/icon.png是執行時的視窗/工作列圖示（Linux尤其吃這個，AppImage
    // 桌面捷徑本身的圖示是另外由package.json的build.linux.icon決定，兩者
    // 都要設，缺一個就會出現「桌面捷徑圖示對，但開啟後工作列圖示變回
    // Electron預設」這種不一致）；Windows下打包後的exe圖示是由
    // build.win.icon（build/icon.ico）烘進執行檔本身決定，這裡主要影響
    // `npm start`開發模式下的視窗圖示。
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  if (process.env.FA_DEBUG_CONSOLE) {
    mainWindow.webContents.on("console-message", (_evt, level, message, line, sourceId) => {
      console.log(`[renderer console] ${message} (${sourceId}:${line})`);
    });
  }
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  if (process.env.FA_DEBUG_LAYOUT) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const info = await mainWindow.webContents.executeJavaScript(`
            (() => {
              const describe = (el) => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return { id: el.id, tag: el.tagName, rect: { w: r.width, h: r.height }, style: { width: cs.width, height: cs.height, position: cs.position, display: cs.display } };
              };
              return {
                innerWidth, innerHeight,
                html: describe(document.documentElement),
                body: describe(document.body),
                app: describe(document.getElementById('app')),
                win: describe(document.getElementById('ai-floating-window')),
                winInlineStyle: (document.getElementById('ai-floating-window') || {}).getAttribute && document.getElementById('ai-floating-window').getAttribute('style'),
              };
            })()
          `);
          console.log("[layout-debug] " + JSON.stringify(info, null, 2));
        } catch (err) {
          console.log("[layout-debug] error: " + err);
        }
      }, 1000);
    });
  }
  if (process.env.FA_DEBUG_EXEC_TEST) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          await saveDesktopSettings({ execEnabled: true, execConfirmRequired: true });
          console.log("[exec-test] calling fa:exec:run directly, waiting for confirm window...");
          const result = await mainWindow.webContents.executeJavaScript(`
            window.desktopAPI.exec.run({ command: "cmd", args: ["/c", "echo hello-from-exec-test"] })
              .then(r => ({ ok: true, result: r }))
              .catch(e => ({ ok: false, error: String(e && e.message || e) }))
          `);
          console.log("[exec-test] result: " + JSON.stringify(result, null, 2));
        } catch (err) {
          console.log("[exec-test] error: " + err);
        }
      }, 1500);
    });
  }
  // 一次性除錯用hook（沿用FA_DEBUG_EXEC_TEST同一種模式）：Windows-MCP這類
  // 螢幕自動化工具在這台機器上對「原始像素座標點擊」不可靠（這個桌面app的
  // 齒輪/垃圾桶圖示不是有名稱的可存取元件，點不到），改用這個env var直接從
  // main行程呼叫window.prompt/confirm/alert，驗證新的全域override＋
  // showTextInputWindow/showConfirmWindow/showAlertWindow modal視窗真的會
  // 彈出、可以互動、且呼叫端拿得到正確的回傳值。
  if (process.env.FA_DEBUG_DIALOG_TEST) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          console.log("[dialog-test] calling window.prompt() directly, waiting for prompt window...");
          const promptResult = await mainWindow.webContents.executeJavaScript(
            `window.prompt("測試prompt：請輸入新名稱", "預設值ABC")`
          );
          console.log("[dialog-test] prompt result: " + JSON.stringify(promptResult));
          console.log("[dialog-test] calling window.confirm() directly, waiting for confirm window...");
          const confirmResult = await mainWindow.webContents.executeJavaScript(
            `window.confirm("測試confirm：要移除授權「測試資料夾」嗎？")`
          );
          console.log("[dialog-test] confirm result: " + JSON.stringify(confirmResult));
        } catch (err) {
          console.log("[dialog-test] error: " + err);
        }
      }, 1500);
    });
  }
  // 一次性除錯hook：直接從main行程觸發「打開Advance設定→切到桌面版設定
  // 分頁」，繞過Windows-MCP對這個app齒輪圖示點不準的既有限制，驗證2026-
  // 09-15新增的「桌面版設定」分頁（🔑設定API金鑰/允許AI執行程式/每次執行
  // 前跳確認框三個控制項搬過去之後）真的有正確插入、切分頁互動正常。
  if (process.env.FA_DEBUG_ADV_SETTINGS_TEST) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          console.log("[adv-settings-test] opening advanced modal + switching to desktop-app pane...");
          const info = await mainWindow.webContents.executeJavaScript(`
            (() => {
              document.getElementById('ai-btn-config').click();
              const cat = document.querySelector('.ai-advanced-cat[data-cat="desktop-app"]');
              if (cat) cat.click();
              const pane = document.querySelector('.ai-advanced-pane[data-pane="desktop-app"]');
              return {
                catFound: !!cat,
                paneFound: !!pane,
                paneHidden: pane ? pane.classList.contains('hidden') : null,
                secretsBtnInPane: !!(pane && pane.querySelector('#topbar-secrets-btn')),
                execEnabledInPane: !!(pane && pane.querySelector('#topbar-exec-enabled')),
                execConfirmInPane: !!(pane && pane.querySelector('#topbar-exec-confirm')),
                topbarStillHasThem: !!document.querySelector('#topbar #topbar-secrets-btn'),
              };
            })()
          `);
          console.log("[adv-settings-test] result: " + JSON.stringify(info, null, 2));
        } catch (err) {
          console.log("[adv-settings-test] error: " + err);
        }
      }, 1500);
    });
  }
  // 一次性除錯hook：驗證2026-09-15新增的「真正shell」能力（Git Bash/
  // PowerShell/cmd.exe，依平台+可用性自動選擇）——用&&串接兩個echo，
  // 這種語法用原本的execFile(陣列參數、不經過shell)完全不可能跑得動，
  // 能得到兩行輸出才代表真的換成shell執行、不是換湯不換藥。同時也用會
  // 造成ENOENT的「整條指令塞進command、args留空」呼叫方式，驗證這次真的
  // 修好使用者實際回報的那個bug。
  if (process.env.FA_DEBUG_SHELL_TEST) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          await saveDesktopSettings({ execEnabled: true, execConfirmRequired: false });
          console.log("[shell-test] running: echo step1 && echo step2 ...");
          const r1 = await mainWindow.webContents.executeJavaScript(
            `window.desktopAPI.exec.run({ command: "echo step1 && echo step2" }).then(r => JSON.stringify(r))`
          );
          console.log("[shell-test] chained result: " + r1);
          console.log("[shell-test] running the reported failure pattern: full command line (with args/spaces) stuffed into command, args empty...");
          const r2 = await mainWindow.webContents.executeJavaScript(
            `window.desktopAPI.exec.run({ command: "echo hello from a full command line with spaces" }).then(r => JSON.stringify(r))`
          );
          console.log("[shell-test] full-line-in-command result: " + r2);
          console.log("[shell-test] calling tmux_start via desktopAPI.tmux.start (should cleanly report unsupported on this platform)...");
          const r3 = await mainWindow.webContents.executeJavaScript(
            `window.desktopAPI.tmux.start("test-session", null, null).then(r => JSON.stringify({ ok: true, r })).catch(e => JSON.stringify({ ok: false, error: String(e && e.message || e) }))`
          );
          console.log("[shell-test] tmux result: " + r3);
        } catch (err) {
          console.log("[shell-test] error: " + err);
        }
      }, 1500);
    });
  }
  // 一次性除錯hook：重現使用者回報的「subagent模式4(hierarchical)+桌面版
  // 讀/列檔案，只輸出思考過程」問題。直接把multiSubAgentMode切成
  // 'hierarchical'、透過_submitChatInput實際送一則會觸發desktop_ops
  // domain委派（fs_list_files）的訊息，等回應跑完後印出完整的
  // fa.messages內容（含role/content/tool_calls/reasoning等欄位），藉此
  // 看清楚回應到底停在哪一步、有沒有真的呼叫到工具。
  if (process.env.FA_DEBUG_HIER_REPRO) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          console.log("[hier-repro] clearing persisted chat history (avoid contamination from earlier test runs)...");
          await mainWindow.webContents.executeJavaScript(`
            (() => {
              window.fa._clearChatHistory();
              window.fa.advancedSettings.multiSubAgentMode = 'hierarchical';
              window.fa._saveAdvancedSettings();
              return window.fa.multiSubAgentMode;
            })()
          `);
          console.log("[hier-repro] sending the user's real reported request (multi-file folder parse)...");
          await mainWindow.webContents.executeJavaScript(`
            (() => {
              const input = document.getElementById('ai-input-text');
              input.value = ${JSON.stringify('解析一下 D:\\Downloads\\SRC\\IDE_QaRobotZ-docs\\KeywordDocs\\StepAction 每個檔案內容')};
              return window.fa._submitChatInput(input, null);
            })()
          `);
          console.log("[hier-repro] waiting up to 320s for the full response (deeper nested chain now: route -> subagent -> fs_list_files -> batch_process_items -> 20 parallel sub-subagents -> reduce -> root)...");
          await new Promise((r) => setTimeout(r, 320000));
          const dump = await mainWindow.webContents.executeJavaScript(`
            JSON.stringify(window.fa.messages.slice(-60).map(m => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content.slice(0, 2000) : m.content,
              tool_calls: m.tool_calls,
              reasoning_content: m.reasoning_content ? String(m.reasoning_content).slice(0, 500) : undefined,
              _isThinking: m._isThinking,
              _visualSuperseded: m._visualSuperseded,
            })), null, 2)
          `);
          console.log("[hier-repro] last messages dump:\n" + dump);
        } catch (err) {
          console.log("[hier-repro] error: " + err);
        }
      }, 1500);
    });
  }
  // 一次性除錯hook：直接呼叫新增的batch_process_items工具本身（不透過
  // 根模型自己判斷要不要用它——那是prompt引導、不是保證，這裡要驗證的是
  // 「這個工具機制本身接線正確」），對StepAction資料夾裡的20個真實XML檔案
  // 做map-reduce式平行處理，確認：(1)每個檔案真的各自獨立的子任務處理、
  // 不會共用/累積同一份對話歷史，(2)全部檔案都成功產出結果，(3)不會像
  // 循序逐一呼叫fs_read_file那樣，20個檔案就把單一子任務的maxRounds(20)
  // 直接用完、來不及產出結論。
  if (process.env.FA_DEBUG_BATCH_TEST) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const startedAt = Date.now();
          console.log("[batch-test] calling batch_process_items tool directly against the real StepAction folder (20 files)...");
          const result = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const listRaw = await window.fa.tools['fs_list_files'].callback(JSON.stringify({ path: 'D:/Downloads/SRC/IDE_QaRobotZ-docs/KeywordDocs/StepAction' }));
              const listed = JSON.parse(listRaw);
              const paths = listed.entries.filter(e => e.isFile).map(e => 'D:/Downloads/SRC/IDE_QaRobotZ-docs/KeywordDocs/StepAction/' + e.name);
              const raw = await window.fa.tools['batch_process_items'].callback(JSON.stringify({
                items: paths,
                instruction: '用fs_read_file讀取這個檔案的內容（純文字XML），一句話摘要這個keyword的用途。',
                concurrency: 4,
              }));
              return JSON.stringify({ fileCount: paths.length, raw: JSON.parse(raw) });
            })()
          `);
          const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.log(`[batch-test] done in ${elapsedSec}s. result:\n` + result);
        } catch (err) {
          console.log("[batch-test] error: " + err);
        }
      }, 1500);
    });
  }
  // 一次性除錯hook：驗證2026-09-15新增的_domainGatedToolNames修補——直接
  // 檢查_getRootToolNames()在router/hierarchical模式下，還看不看得到
  // fs_read_file/run_command這類桌面專屬工具（修好之前：看得到，根模型可以
  // 繞過delegate_to_subagent直接呼叫；修好之後：看不到，只能透過委派）。
  if (process.env.FA_DEBUG_GATING_TEST) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const result = await mainWindow.webContents.executeJavaScript(`
            (() => {
              window.fa.advancedSettings.multiSubAgentMode = 'router';
              window.fa._saveAdvancedSettings();
              const rootNamesRouter = window.fa._getRootToolNames();
              window.fa.advancedSettings.multiSubAgentMode = 'hierarchical';
              window.fa._saveAdvancedSettings();
              const rootNamesHier = window.fa._getRootToolNames();
              window.fa.advancedSettings.multiSubAgentMode = 'off';
              window.fa._saveAdvancedSettings();
              const rootNamesOff = window.fa._getRootToolNames();
              const watch = ['fs_read_file','fs_list_files','run_command','batch_process_items','tmux_start_session'];
              return JSON.stringify({
                router_stillExposed: watch.filter(n => rootNamesRouter.includes(n)),
                hierarchical_stillExposed: watch.filter(n => rootNamesHier.includes(n)),
                off_exposed_asExpected: watch.filter(n => rootNamesOff.includes(n)),
              }, null, 2);
            })()
          `);
          console.log("[gating-test] result:\n" + result);
        } catch (err) {
          console.log("[gating-test] error: " + err);
        }
      }, 1500);
    });
  }
  // 一次性除錯hook：驗證2026-09-15新增的「逐一設定rpm」——LLM Model管理
  // 分頁每個row是否真的渲染出新欄位、輸入後是否正確寫回row.requestsPerMinute、
  // runBatchSubAgents是否正確resolve並傳給_acquireBatchRateSlot。
  if (process.env.FA_DEBUG_ROW_RPM_TEST) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const result = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              document.getElementById('ai-btn-config').click();
              document.querySelector('.ai-advanced-cat[data-cat="llm-sampling"]').click();
              await new Promise(r => setTimeout(r, 200));
              const row = window.fa._getModelRows()[0];
              const input = document.querySelector('input[data-row-id="' + row.id + '"][data-field="requestsPerMinute"]');
              const fieldFound = !!input;
              let updatedValue = null;
              if (input) {
                input.value = '3';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, 100));
                updatedValue = window.fa._getModelRows()[0].requestsPerMinute;
              }
              const start = Date.now();
              const timestamps = [];
              for (let i = 0; i < 5; i++) {
                await window.fa._acquireBatchRateSlot(window.fa._getModelRows()[0].requestsPerMinute);
                timestamps.push(Date.now() - start);
              }
              return JSON.stringify({ fieldFound, updatedValue, timestamps, note: 'with row limit=3, 5th acquire should wait until ~60s after the 1st (sliding window), so timestamps[4] should jump' });
            })()
          `);
          console.log("[row-rpm-test] result:\n" + result);
        } catch (err) {
          console.log("[row-rpm-test] error: " + err);
        }
      }, 1500);
    });
  }
  // 一次性除錯hook：驗證2026-09-15使用者實測回報的bug——_loopFetch文字式
  // 協定分支裡，工具呼叫失敗（例如模型呼叫了一個不存在的工具名稱）時原本
  // 誤呼叫`this.executeChat(errorText)`，被當成「使用者插話」觸發
  // [Steering]機制。用mock fetch確定性地重現這個情境（第一輪回傳
  // `[CALL: list_directory({...})]`——一個真實不存在的工具名稱，第二輪
  // 回傳一段正常文字），不依賴真實模型會不會剛好猜錯工具名稱。
  if (process.env.FA_DEBUG_TOOL_ERROR_TEST) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const result = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              window.fa._clearChatHistory();
              // 這台機器設定的端點原生支援tool_calls，_ensureNativeToolSupportProbed
              // 的探測結果會讓executeChat()走_loopFetchNative而不是要測試的
              // _loopFetch文字協定分支——強制切成'text'協定，才會真的走到
              // 剛才修好的那段程式碼。
              window.fa.advancedSettings.toolCallMode = 'text';
              window.fa.advancedSettings.multiSubAgentMode = 'off';
              window.fa._saveAdvancedSettings();
              // 文字協定分支走的是SSE串流解析（見_loopFetch的說明：
              // response.body.getReader()逐段解 "data: {...}\\n\\n"），不是
              // 單純的await response.json()——第一次mock用plain JSON body
              // 導致串流解析器完全讀不到任何"data: "行、rawContent變成空字串，
              // 這裡改成真的組一個符合格式的SSE ReadableStream。
              const sse = (text, finishReason) => {
                const encoder = new TextEncoder();
                const body = new ReadableStream({
                  start(controller) {
                    controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] }) + '\\n\\n'));
                    controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }] }) + '\\n\\n'));
                    controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));
                    controller.close();
                  }
                });
                return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
              };
              let callCount = 0;
              const realFetch = window.fetch;
              window.fetch = async (url, opts) => {
                callCount++;
                if (callCount === 1) return sse('[CALL: list_directory({"path":"/tmp"})]');
                return sse('測試完成：已改用正確工具重試並得到最終答案。');
              };
              const input = document.getElementById('ai-input-text');
              input.value = '這是一個會觸發工具呼叫失敗的測試訊息';
              await window.fa._submitChatInput(input, null);
              await new Promise(r => setTimeout(r, 3000));
              window.fetch = realFetch;
              const msgs = window.fa.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 300) : m.content }));
              const hasSteering = msgs.some(m => typeof m.content === 'string' && m.content.startsWith('[Steering]'));
              const hasToolErrorFeedback = msgs.some(m => typeof m.content === 'string' && m.content.includes('執行失敗') && m.content.includes('找不到工具'));
              const finalAnswer = msgs.find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('測試完成'));
              return JSON.stringify({ callCount, hasSteering, hasToolErrorFeedback, finalAnswerFound: !!finalAnswer, allMessages: msgs }, null, 2);
            })()
          `);
          console.log("[tool-error-test] result:\n" + result);
        } catch (err) {
          console.log("[tool-error-test] error: " + err);
        }
      }, 1500);
    });
  }

  // tw_stock_db客製: 2026-09-15新增——使用者用nvidia/nemotron-3-super-120b-a12b
  // 實測回報「端點完全沒有回應任何內容」，追查發現根因是_loopFetch/
  // _loopFetchNative裡判斷「這一輪是不是完全沒拿到任何東西、值得自動重試」
  // 的條件原本額外要求finishReason==='stop'，但空回應常常帶著其他（或缺席
  // 的）finish_reason，導致連第一次重試機會都沒有、直接把空白內容當成
  // 「已完成」，使用者被迫手動重新輸入。這裡跟FA_DEBUG_TOOL_ERROR_TEST同一種
  // 手法（mock window.fetch、真的跑一次_submitChatInput、在真實renderer/
  // Electron環境裡驗證），驗證修好之後的兩個情境：(1)端點持續回空——要能
  // 自動重試很多次、最後放棄時訊息裡要看得到真正的診斷資訊（不是空白警告）；
  // (2)端點只有第一次回空、第二次就回真正內容——要能自動復原、使用者完全
  // 不需要自己重新輸入。native路徑（tool_calls，非串流JSON）是使用者實際
  // 撞到的路徑，這裡優先測這個。
  if (process.env.FA_DEBUG_NETWORK_DEADEND_TEST) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const result = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              window.fa._clearChatHistory();
              window.fa.advancedSettings.toolCallMode = 'native';
              window.fa.advancedSettings.multiSubAgentMode = 'off';
              window.fa._saveAdvancedSettings();
              const emptyNative = () => new Response(JSON.stringify({
                choices: [{ message: {}, finish_reason: 'error' }]
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
              const realNative = (text) => new Response(JSON.stringify({
                choices: [{ message: { content: text }, finish_reason: 'stop' }]
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });

              // 情境一：端點每次都回完全空白（模擬持續異常的端點）。
              let callCount1 = 0;
              const realFetch = window.fetch;
              window.fetch = async () => { callCount1++; return emptyNative(); };
              const input1 = document.getElementById('ai-input-text');
              input1.value = '測試情境一：端點持續回空白';
              await window.fa._submitChatInput(input1, null);
              await new Promise(r => setTimeout(r, 6000));
              window.fetch = realFetch;
              const msgs1 = window.fa.messages.filter(m => m.role === 'assistant');
              const last1 = msgs1[msgs1.length - 1];
              const hasDiagInfo1 = !!(last1 && typeof last1.content === 'string' && last1.content.includes('診斷'));
              const debugLogKinds1 = window.fa._networkDebugLog.map(e => e.kind);

              // 順便驗證Advance設定「LLM Debug」分頁真的會把_networkDebugLog
              // 畫出來（不只是資料層有記錄，UI也要看得到）。
              window.fa._openAdvancedModal();
              document.querySelector('#ai-advanced-modal .ai-advanced-cat[data-cat="llm-debug"]').click();
              const panelEl = document.getElementById('ai-network-debug-list');
              const panelHtml = panelEl ? panelEl.innerHTML : null;
              const panelShowsHttpStatus = !!(panelHtml && panelHtml.includes('HTTP 200'));
              const panelShowsEmptyIcon = !!(panelHtml && panelHtml.includes('⚠️'));
              window.fa._closeAdvancedModal();

              // 情境二：端點第一次回空白，第二次就回真正答案（模擬偶發異常）。
              window.fa._clearChatHistory();
              window.fa._networkDebugLog = [];
              let callCount2 = 0;
              window.fetch = async () => {
                callCount2++;
                if (callCount2 === 1) return emptyNative();
                return realNative('測試情境二：這是真正的答案內容。');
              };
              const input2 = document.getElementById('ai-input-text');
              input2.value = '測試情境二：端點第一次回空白、第二次恢復正常';
              await window.fa._submitChatInput(input2, null);
              await new Promise(r => setTimeout(r, 3000));
              window.fetch = realFetch;
              const msgs2 = window.fa.messages.filter(m => m.role === 'assistant');
              const last2 = msgs2[msgs2.length - 1];
              const recovered = !!(last2 && typeof last2.content === 'string' && last2.content.includes('測試情境二：這是真正的答案內容'));
              const noWarningShown2 = !(last2 && typeof last2.content === 'string' && last2.content.includes('⚠️'));

              return JSON.stringify({
                scenario1_alwaysEmpty: { callCount: callCount1, hasDiagInfoInFinalMessage: hasDiagInfo1, finalMessagePreview: last1 ? String(last1.content).slice(0, 400) : null, debugLogEntryCount: debugLogKinds1.length, panelShowsHttpStatus, panelShowsEmptyIcon },
                scenario2_recoversOnRetry: { callCount: callCount2, autoRecovered: recovered, noWarningShownToUser: noWarningShown2, finalMessagePreview: last2 ? String(last2.content).slice(0, 200) : null },
              }, null, 2);
            })()
          `);
          console.log("[network-deadend-test] result:\n" + result);
        } catch (err) {
          console.log("[network-deadend-test] error: " + err);
        }
      }, 1500);
    });
  }
}

app.whenReady().then(async () => {
  try {
    const { port } = await startLocalProxy({
      preferredPort: Number(process.env.FA_DESKTOP_PROXY_PORT) || 47891,
      getSecrets,
      onLog: (m) => console.log(m),
    });
    localProxyPort = port;
  } catch (err) {
    console.error("[main] 本地proxy啟動失敗（git/搜尋等需要CORS繞道的功能會受影響）：", err);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
