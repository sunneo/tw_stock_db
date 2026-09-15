// Electron主行程——floating-assistant.js桌面版封裝。
//
// 安全模型（跟renderer/preload.js合起來看）：
//   - webPreferences關掉nodeIntegration、開contextIsolation，renderer（含
//     floating-assistant.js自己會動態載入的第三方CDN函式庫，例如
//     isomorphic-git/three.js/jszip）完全碰不到Node API，只能透過
//     preload.js用contextBridge刻意暴露出去的窄接口跟這裡的IPC handler
//     溝通——即使renderer被XSS或載到惡意CDN內容，也不能直接讀寫檔案/
//     執行程式，一定要經過這裡的白名單式IPC handler。
//   - 「檔案直接存取」不是「無限制存取整台電腦」：每個IPC fs handler都先
//     用`resolveWithinRoot()`確認目標路徑真的落在使用者自己用原生資料夾
//     選擇對話框授權過的某個root目錄底下，才會真的碰磁碟——這一層檢查
//     刻意放在主行程（不是renderer），因為renderer的JS理論上可能被繞過，
//     主行程是唯一真正管得住系統呼叫的地方。
//   - 「執行程式」（child_process）是最危險的能力，預設要求每次執行前
//     都跳原生confirm對話框（execConfirmRequired，存在settings.json，
//     使用者可以在renderer的頂部列關掉，但這是使用者自己的選擇，不是
//     這個app的預設姿態）；一律用execFile（傳陣列參數，不經過shell），
//     不用exec/shell:true，避免shell注入；有輸出大小上限與逾時。
"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { execFile } = require("child_process");
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

ipcMain.handle("fa:exec:getSettings", async () => getDesktopSettings());
ipcMain.handle("fa:exec:setSettings", async (_evt, patch) => {
  const cur = await getDesktopSettings();
  const next = { ...cur, ...patch };
  await saveDesktopSettings(next);
  return next;
});

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
  const cmdLine = `${command} ${(args || []).join(" ")}`.trim();
  if (settings.execConfirmRequired !== false) {
    const allowed = await showExecConfirmWindow(cmdLine, cwd);
    if (!allowed) {
      throw new Error("使用者拒絕了這個執行請求。");
    }
  }
  return new Promise((resolve) => {
    execFile(
      command,
      args || [],
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
