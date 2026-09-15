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

// tw_stock_db客製: 2026-09-15使用者實際遇到的bug——AI呼叫run_command時把
// 整條指令（含參數與路徑）都塞進單一`command`字串、`args`留空（例如
// `{"command":"ls -la /home/.../StepAction/"}`），execFile不經過shell，
// 會把這一整串含空白的文字當成「執行檔名稱」直接去spawn，真實世界沒有
// 這個檔名的檔案，直接ENOENT——這跟File Access Point的root範圍限制是
//完全不同的兩回事（run_command本來就不吃FAP的root範圍檢查）。這裡加一個
// 保守、不引入shell的修補：`args`是空的、且`command`裡有空白時，用簡單
// 的、認識雙引號/單引號的分詞器自己切出「程式名稱＋參數陣列」，行為上仍然
// 等同execFile(陣列參數)，**不會**解釋管線(|)/重導向(>)/&&等shell語法
// （那需要真的呼叫shell，是更大的能力升級，複雜度與風險都不同，這裡先
// 只解決「AI塞了一整行進command卻忘記拆args」這個具體、常見的呼叫失誤）。
function splitCommandLineIfNeeded(command, args) {
  if (Array.isArray(args) && args.length) return { program: command, args };
  const s = String(command || "").trim();
  if (!s.includes(" ")) return { program: s, args: [] };
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) tokens.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return { program: tokens[0] || s, args: tokens.slice(1) };
}

ipcMain.handle("fa:exec:run", async (_evt, { rootId, command, args, cwdRel }) => {
  const settings = await getDesktopSettings();
  if (!settings.execEnabled) {
    throw new Error("執行程式功能目前未啟用，請在應用程式頂部列開啟「允許AI執行程式」。");
  }
  let cwd = app.getPath("home");
  if (rootId) {
    const rec = await findRoot(rootId);
    cwd = resolveWithinRoot(rec.rootPath, cwdRel || ".");
  }
  const { program, args: finalArgs } = splitCommandLineIfNeeded(command, args);
  const cmdLine = `${program} ${finalArgs.join(" ")}`.trim();
  if (settings.execConfirmRequired !== false) {
    const allowed = await showExecConfirmWindow(cmdLine, cwd);
    if (!allowed) {
      throw new Error("使用者拒絕了這個執行請求。");
    }
  }
  return new Promise((resolve) => {
    execFile(
      program,
      finalArgs,
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_EXEC_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error || error.code === undefined,
          exitCode: error && typeof error.code === "number" ? error.code : (error ? -1 : 0),
          signal: (error && error.signal) || null,
          stdout: String(stdout || "").slice(0, 200000),
          stderr: String(stderr || "").slice(0, 200000),
          timedOut: !!(error && error.killed),
          errorMessage: error ? String(error.message || error) : null,
        });
      }
    );
  });
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
