// main-ext.js —— 可以 live-update 的主行程 IPC 模組（見 main.js 的 LIVE_PATCH_MAIN_FILES）。
// 原本寫在 main.js 裡的 raw filesystem IPC（fa:rawfs:*）搬到這裡；之後新增的 IPC 也寫在這裡。
// main.js 啟動時 require 並呼叫 register(ipcMain, { fs, path })；patch 套用後，下一次啟動就會載入新版（已在記憶體執行的程式碼無法熱抽換）。
// 這個檔案用到的東西都從 ctx 傳進來（fs＝fs/promises、path），不依賴 main.js 的其他函式，所以可以單獨被覆蓋。
"use strict";

function register(ipcMain, ctx) {
  // 舊版主程式呼叫 register 時只傳 { fs, path, execConfirmGate, net, dialog, BrowserWindow }：沒有 electron、userDataDir、getMainWindow 等。
  // 後面所有「自己更新自己」的功能（模組覆蓋、更新處理、缺模組自動補回、電腦操作）都靠這些，缺了就補上，不依賴主程式傳進來什麼。
  try {
    ctx = ctx || {};
    if (!ctx.electron) { try { ctx.electron = require("electron"); } catch (_) { /* 不在 Electron 裡（測試）：維持沒有 */ } }
    const E = ctx.electron;
    if (!ctx.BrowserWindow && E) ctx.BrowserWindow = E.BrowserWindow;
    if (!ctx.userDataDir && E && E.app) ctx.userDataDir = () => E.app.getPath("userData");
    // 舊版入口檔沒有把設定檔的讀寫傳進來（Linux 版回報：電腦操作「啟用」重開就沒了）：缺的話在這裡補上，讀寫的是入口檔同一份 userData/desktop-settings.json（淺層合併、不洗掉別的欄位）
    if (!ctx.getDesktopSettings && ctx.userDataDir) {
      const nodeFs = require("fs"), nodePath = require("path"), sf = () => nodePath.join(ctx.userDataDir(), "desktop-settings.json");
      ctx.getDesktopSettings = async () => { try { return JSON.parse(String(nodeFs.readFileSync(sf(), "utf8")).replace(/^﻿/, "")) || {}; } catch (_) { return { execConfirmRequired: true, execEnabled: false }; } };
      if (!ctx.patchDesktopSettings) ctx.patchDesktopSettings = async (patch) => { const next = Object.assign({}, await ctx.getDesktopSettings(), patch), f = sf(); nodeFs.mkdirSync(nodePath.dirname(f), { recursive: true }); const tmp = f + ".tmp"; nodeFs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8"); nodeFs.renameSync(tmp, f); return next; };
    }
    if (!ctx.getMainWindow && E && E.BrowserWindow) ctx.getMainWindow = () => { try { const all = E.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()); return all.find((w) => w.isVisible()) || all[0] || null; } catch (_) { return null; } };
  } catch (_) { /* */ }
  const plog = installPersistentLog(ctx); // 要在其他東西之前：後面的 console 訊息才會被記下來
  try { installTray(ctx, ipcMain); } catch (e) { console.warn("[main-ext] 系統匣載入失敗：", e && e.message); }
  const overlay = installModuleOverlay(ctx); // 必須最先做：後面的 require("./computer-use-ipc.js") 之類要靠它
  const { fs, path } = ctx;
  const electron = ctx.electron || null;
  // ---------- 判題器 IPC（寫程式／修程式；從 main.js 搬到這裡，才能用 patch 熱更新給已安裝的使用者；preload.js 的 judge 橋在白名單內）----------
  {
  const os = require("os");
  // <judge-begin>
// ---------- IPC: 判題器（寫程式／修程式：本機編譯並執行程式來驗收，judge-runner.js）----------
// 這會在本機編譯並執行 AI 產生（或使用者貼來）的程式，所以：
//  1) 一律要「允許AI執行程式」（execEnabled）；
//  2) 第一次呼叫（同一個視窗、10 分鐘內沒有授權過）走既有的 execConfirmGate 跳確認框，顯示語言與程式開頭；確認後同一視窗 10 分鐘內的後續驗收（迴圈每輪都要判題）不再重複詢問；
//  3) 輸入有上限（程式 200KB、測試筆數與大小、逾時），避免被拿來吃光資源。
// 誠實的限制（回傳裡的 sandbox 欄位也會帶）：判題器不是安全沙盒——沒有記憶體上限、沒有檔案與網路隔離，只有時間與輸出上限與精簡環境變數。所以只該跑自己或本機模型產生的程式。
const JUDGE_LIMITS = { sourceBytes: 200 * 1024, tests: 60, testBytes: 256 * 1024, timeoutMs: 20000, grantMs: 10 * 60 * 1000 };
const JUDGE_SANDBOX_NOTE = "判題器不是安全沙盒：只有時間與輸出上限、精簡環境變數、獨立暫存目錄；沒有記憶體上限、沒有檔案與網路隔離。";
const judgeGrants = new Map(); // webContents.id -> 授權到期時間
let _judgeRunner = null;
function judgeRunner() { if (!_judgeRunner) _judgeRunner = require("./judge-runner.js"); return _judgeRunner; }
function judgeFail(error) { return { ok: false, error, sandbox: JUDGE_SANDBOX_NOTE }; }
function judgeCheckLang(lang) { const R = judgeRunner(); return R.ORDER.includes(lang) ? null : `不支援的語言：${String(lang).slice(0, 30)}（支援：${R.ORDER.join("、")}）`; }
function judgeCheckSource(source) {
  if (typeof source !== "string") return "source 必須是字串";
  if (Buffer.byteLength(source, "utf8") > JUDGE_LIMITS.sourceBytes) return `程式太長（上限 ${JUDGE_LIMITS.sourceBytes / 1024}KB）`;
  return null;
}
function judgeCleanTests(list, name) {
  if (list == null) return { list: [] };
  if (!Array.isArray(list) || list.length > JUDGE_LIMITS.tests) return { error: `${name} 必須是陣列且不超過 ${JUDGE_LIMITS.tests} 筆` };
  const out = [];
  for (const t of list) {
    if (!t || typeof t.in !== "string" || typeof t.out !== "string") return { error: `${name} 每筆都要有字串 in 與 out` };
    if (t.in.length > JUDGE_LIMITS.testBytes || t.out.length > JUDGE_LIMITS.testBytes) return { error: `${name} 單筆太大（上限 ${JUDGE_LIMITS.testBytes / 1024}KB）` };
    out.push({ in: t.in, out: t.out });
  }
  return { list: out };
}
async function judgeGate(senderId, lang, source) {
  if (!ctx.getDesktopSettings || !ctx.execConfirmGate) throw new Error("這個版本的主程式沒有提供執行確認，無法執行判題器");
  const exp = judgeGrants.get(senderId);
  if (exp && exp > Date.now()) { const st = await ctx.getDesktopSettings(); if (!st.execEnabled) throw new Error("執行程式功能目前未啟用，請在Advance設定的「桌面版設定」分頁開啟「允許AI執行程式」。"); return; }
  const head = String(source).split("\n").slice(0, 6).join("\n").slice(0, 400);
  await ctx.execConfirmGate(`［編譯並執行 ${lang} 程式來驗收］（${JUDGE_SANDBOX_NOTE}）\n${head}${String(source).length > head.length ? "\n…" : ""}`, os.tmpdir(), senderId);
  judgeGrants.set(senderId, Date.now() + JUDGE_LIMITS.grantMs);
}
ipcMain.handle("fa:judge:available", async (_evt, { lang } = {}) => {
  try { const bad = judgeCheckLang(lang); if (bad) return judgeFail(bad); const r = await judgeRunner().available(lang); return { ok: !!r.ok, version: r.version, reason: r.reason, sandbox: JUDGE_SANDBOX_NOTE }; }
  catch (err) { return judgeFail(String((err && err.message) || err)); }
});
ipcMain.handle("fa:judge:check", async (_evt, { lang, source } = {}) => {
  try {
    const bad = judgeCheckLang(lang) || judgeCheckSource(source); if (bad) return judgeFail(bad);
    await judgeGate(_evt.sender.id, lang, source); // check 也會呼叫編譯器（編譯期巨集、C# 等可能執行程式碼），一樣要把關
    return Object.assign({ sandbox: JUDGE_SANDBOX_NOTE }, await judgeRunner().check({ lang, source }));
  } catch (err) { return judgeFail(String((err && err.message) || err)); }
});
ipcMain.handle("fa:judge:run", async (_evt, { lang, source, problem, timeoutMs } = {}) => {
  try {
    const bad = judgeCheckLang(lang) || judgeCheckSource(source); if (bad) return judgeFail(bad);
    if (!problem || typeof problem !== "object") return judgeFail("缺少 problem（要有 id 與 tests）");
    const t1 = judgeCleanTests(problem.tests, "tests"); if (t1.error) return judgeFail(t1.error);
    const t2 = judgeCleanTests(problem.hidden, "hidden"); if (t2.error) return judgeFail(t2.error);
    if (!t1.list.length) return judgeFail("tests 至少要一筆（沒有測試請改用 fa:judge:check）");
    const clean = { id: String(problem.id || "task").replace(/[^\w.-]/g, "_").slice(0, 60) || "task", tests: t1.list, hidden: t2.list, checker: ["lines", "tokens", "float", "unordered-lines", "unordered-tokens"].includes(problem.checker) ? problem.checker : "tokens", eps: typeof problem.eps === "number" ? problem.eps : undefined };
    const tm = Math.max(200, Math.min(JUDGE_LIMITS.timeoutMs, Number(timeoutMs) || Number(problem.timeoutMs) || 3000));
    await judgeGate(_evt.sender.id, lang, source);
    return Object.assign({ sandbox: JUDGE_SANDBOX_NOTE }, await judgeRunner().judge({ lang, source, problem: clean, timeoutMs: tm }));
  } catch (err) { return judgeFail(String((err && err.message) || err)); }
});
  // <judge-end>

  }
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

  // tw_stock_db客製: 2026-09-26使用者實測回報——弱模型把路徑講成 C:\\Users\\...
  // （JSON跳脫被重複套用，實際字串變成連續兩個反斜線），子agent照樣拿去讀就
  // 「目錄不存在」，AI還誤以為檔案真的不在，整個任務卡死。Windows下路徑分隔字元
  // 連續多個反斜線本來就沒有意義（開頭的UNC路徑除外），一律收斂成單一個，
  // 也順手拿掉AI常多加的一對引號。
  function rawFsPath(p) {
    let s = String(p || "").trim().replace(/^(["'])(.*)\1$/, "$2");
    if (process.platform === "win32") {
      const unc = /^\\\\(?=[^\\])/.test(s) ? "\\\\" : "";
      s = unc + s.slice(unc.length).replace(/\\{2,}/g, "\\");
    }
    return s;
  }

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

  ipcMain.handle("fa:rawfs:stat", async (_evt, { path: p } = {}) => {
    const target = path.resolve(rawFsPath(p));
    const st = await fs.stat(target);
    return { path: target, isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
  });

  ipcMain.handle("fa:rawfs:readdir", async (_evt, { path: p } = {}) => {
    const target = path.resolve(rawFsPath(p));
    const entries = await fs.readdir(target, { withFileTypes: true });
    return Promise.all(entries.map(async (e) => {
      const base = { name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() };
      try {
        const st = await fs.stat(path.join(target, e.name));
        return { ...base, size: st.size, mtimeMs: st.mtimeMs };
      } catch (_) {
        return base;
      }
    }));
  });

  ipcMain.handle("fa:rawfs:readFile", async (_evt, { path: p, encoding } = {}) => {
    const target = path.resolve(rawFsPath(p));
    const buf = await fs.readFile(target);
    if (encoding === "base64") return { path: target, base64: buf.toString("base64"), sizeBytes: buf.length };
    if (detectLikelyBinary(buf)) {
      return { path: target, base64: buf.toString("base64"), sizeBytes: buf.length, likelyBinary: true };
    }
    return { path: target, text: buf.toString("utf8"), sizeBytes: buf.length };
  });

  ipcMain.handle("fa:rawfs:writeFile", async (_evt, { path: p, text, base64 } = {}) => {
    const target = path.resolve(rawFsPath(p));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const buf = base64 != null ? Buffer.from(base64, "base64") : Buffer.from(String(text ?? ""), "utf8");
    await fs.writeFile(target, buf);
    return { ok: true, path: target, sizeBytes: buf.length };
  });

  ipcMain.handle("fa:rawfs:mkdir", async (_evt, { path: p } = {}) => {
    const target = path.resolve(rawFsPath(p));
    await fs.mkdir(target, { recursive: true });
    return { ok: true, path: target };
  });

  // 大檔案「一段一段」複製（匯出大索引用，DESIGN.project-index.md §17.5）：串流、記憶體固定（每次讀 8 MB），不會把整個檔案讀進來。
  //   partBytes 有給：切成 <dstPrefix>0000.part、0001.part…（每份最多 partBytes）；沒給：整份複製成 dst。回傳 { size, parts:[{name,size}] }。
  ipcMain.handle("fa:rawfs:copyChunked", async (_evt, { src, dst, partBytes } = {}) => {
    const fsSync = require("fs"); const from = path.resolve(rawFsPath(src)); const to = path.resolve(rawFsPath(dst));
    const st = await fs.stat(from); await fs.mkdir(path.dirname(to), { recursive: true });
    const CH = 8 * 1024 * 1024; const buf = Buffer.allocUnsafe(CH); const parts = [];
    const rfd = await fs.open(from, "r");
    try {
      const per = partBytes > 0 ? Math.floor(partBytes) : Infinity; let pos = 0, idx = 0;
      do {
        const name = per === Infinity ? path.basename(to) : String(idx).padStart(4, "0") + ".part"; const out = per === Infinity ? to : to + name;
        const wfd = await fs.open(out, "w"); let wrote = 0;
        try {
          while (wrote < per && pos < st.size) {
            const want = Math.min(CH, per - wrote, st.size - pos); const { bytesRead } = await rfd.read(buf, 0, want, pos); if (!bytesRead) break;
            await wfd.write(buf, 0, bytesRead); pos += bytesRead; wrote += bytesRead;
          }
        } finally { await wfd.close(); }
        parts.push({ name: path.basename(out), size: wrote }); idx++;
      } while (pos < st.size);
      return { ok: true, size: st.size, parts };
    } finally { await rfd.close(); }
  });

  ipcMain.handle("fa:rawfs:remove", async (_evt, { path: p, recursive } = {}) => {
    const target = path.resolve(rawFsPath(p));
    await fs.rm(target, { recursive: !!recursive, force: true });
    return { ok: true, path: target };
  });

  ipcMain.handle("fa:rawfs:find", async (_evt, { path: p, pattern, maxDepth, maxResults } = {}) => {
    const startDir = path.resolve(rawFsPath(p));
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

  // 給「終端機檔案傳輸」GUI的Computer分頁用——列出可以當瀏覽起點的磁碟機/根目錄。
  // win32下逐一嘗試A-Z槽（fs.stat失敗代表槽不存在，安靜跳過），非win32直接回傳"/"。
  ipcMain.handle("fa:rawfs:listDrives", async () => {
    if (process.platform === "win32") {
      const drives = [];
      for (let code = 65; code <= 90; code++) {
        const letter = String.fromCharCode(code);
        const root = `${letter}:\\`;
        try {
          await fs.stat(root);
          drives.push({ path: root, label: `${letter}:` });
        } catch (_) {
          // 槽不存在，略過
        }
      }
      return drives;
    }
    return [{ path: "/", label: "/" }];
  });

  // ---------- Knowledge Inventory 原生磁碟檔輔助（knowledge-native.js；見 DESIGN.knowledge-swap.md）----------
  try { if (ctx.userDataDir) require("./knowledge-native.js").register(ipcMain, { userDataDir: ctx.userDataDir }); }
  catch (e) { console.warn("[main-ext] knowledge-native 載入失敗：", e && e.message); }
  // ---------- coding_edit／coding_patch_tool（coding-tools.js）與 CI/CD 連線的 HTTP（ci-fetch.js）----------
  // 2026-10-14：模組本身也在 live-update 白名單；註冊放在這裡，之後改 IPC 名稱或參數只要發 patch。
  // main.js 的 ctx 可能比這份 main-ext.js 舊（只有 fs、path）：缺少確認閘或對話框時，會執行任意程式／寫入外部服務的 IPC 一律拒絕，不會在沒有確認的情況下放行。
  const needNew = (what) => ({ ok: false, error: "這個動作需要新版主程式（" + what + "）：請重新安裝最新版。" });
  try { require("./coding-tools.js").register(ipcMain, { execConfirmGate: ctx.execConfirmGate }); }
  catch (e) { console.warn("[main-ext] coding-tools 載入失敗：", e && e.message); }
  try { if (ctx.dialog) require("./ci-fetch.js").register(ipcMain, { net: ctx.net, dialog: ctx.dialog, BrowserWindow: ctx.BrowserWindow }); else ipcMain.handle("fa:ci:fetch", async () => needNew("缺少對話框")); }
  catch (e) { console.warn("[main-ext] ci-fetch 載入失敗：", e && e.message); }

  // ---------- 下載：不跳系統層級的「另存新檔」，由程式自己決定存哪裡 ----------
  // 瀏覽器端的 <a download> 在 Electron 預設會跳 Windows 的另存新檔視窗；這個視窗在部分機器上不會正常顯示或存不下來（檔案不見）。
  // 這裡接管 will-download：存到 renderer 先指定的資料夾（fa:download:setNext，60 秒內有效），沒指定就存到「下載」資料夾；
  // 檔名重複會自動加 (1)、(2)；存完（或失敗）用 fa:download:done 通知 renderer 顯示「已存到…」。
  if (electron && electron.app && electron.session) {
    const { app, shell, session } = electron; const fsSync = require("fs");
    let nextDir = null, nextAt = 0;
    const safeName = (n) => String(n || "download").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_").slice(0, 180) || "download";
    const uniquePath = (dir, name) => {
      const ext = path.extname(name), base = path.basename(name, ext); let p = path.join(dir, name), i = 1;
      while (fsSync.existsSync(p)) p = path.join(dir, base + " (" + i++ + ")" + ext);
      return p;
    };
    ipcMain.handle("fa:download:defaultDir", async () => app.getPath("downloads"));
    ipcMain.handle("fa:download:setNext", async (_evt, { dir } = {}) => { nextDir = dir ? path.resolve(rawFsPath(dir)) : null; nextAt = Date.now(); return { ok: true, dir: nextDir || app.getPath("downloads") }; });
    ipcMain.handle("fa:download:reveal", async (_evt, { file } = {}) => { if (file) shell.showItemInFolder(path.resolve(String(file))); return { ok: true }; });
    const onWillDownload = (_event, item, wc) => {
      let dir = (nextDir && Date.now() - nextAt < 60000) ? nextDir : app.getPath("downloads"); nextDir = null;
      let target;
      try { fsSync.mkdirSync(dir, { recursive: true }); target = uniquePath(dir, safeName(item.getFilename())); }
      catch (_) { dir = app.getPath("downloads"); fsSync.mkdirSync(dir, { recursive: true }); target = uniquePath(dir, safeName(item.getFilename())); }
      item.setSavePath(target);
      item.once("done", (_e, state) => { try { wc.send("fa:download:done", { state, path: target, name: path.basename(target), size: item.getReceivedBytes() }); } catch (_) { /* 視窗已關 */ } });
    };
    const attach = () => { try { session.defaultSession.on("will-download", onWillDownload); } catch (_) { /* 沒有 session（測試環境） */ } };
    if (app.isReady && app.isReady()) attach(); else app.whenReady().then(attach);
  }
  // ---------- MCP 伺服器（stdio）的子行程管理 ----------
  // MCP 伺服器就是『一個會讀 stdin、寫 stdout 的程式』：這裡負責啟動它、轉送輸出給 renderer、關掉它，以及把安裝包解開到專用資料夾、跑安裝指令。
  // 啟動與跑安裝指令都要過 execConfirmGate（跟 run_command 同一個確認閘，使用者在桌面版設定裡決定要不要每次確認）；沒有確認閘（舊版主程式）就拒絕。
  // 全部 IPC 都在這個檔案，之後改只要發 patch；只有 preload.js 要多一段（同樣可以 patch，下次啟動生效）。
  try {
    const { spawn, execFile } = require("child_process");
    const procs = new Map(); let seq = 0; const MAX_PROCS = 16; const isWin = process.platform === "win32";
    const installRoot = () => path.join(electron.app.getPath("userData"), "mcp-servers");
    const safeSeg = (s) => String(s || "server").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 60) || "server";
    // cmd.exe 的引號規則：含空白或特殊字元就整個包起來，裡面的雙引號跳脫
    const quoteWin = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : '"' + String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"');
    const display = (command, args) => [command].concat(args || []).map((x) => (/\s/.test(String(x)) ? '"' + x + '"' : String(x))).join(" ");
    const plan = (command, args) => (isWin ? { file: [command].concat(args || []).map((x) => quoteWin(String(x))).join(" "), args: [], shell: true } : { file: command, args: args || [], shell: false });
    const gateOr = async (evt, label, cmdLine, cwd) => {
      if (!ctx.execConfirmGate) return needNew("MCP 需要確認閘");
      try { await ctx.execConfirmGate("[" + label + "] " + cmdLine, cwd || process.cwd(), evt.sender.id); return null; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    };
    const killTree = (child) => {
      try { if (isWin && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGTERM"); } catch (_) { /* 已經結束 */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) { /* */ } }, 4000).unref();
    };
    ipcMain.handle("fa:mcp:installDir", async () => installRoot());
    ipcMain.handle("fa:mcp:start", async (evt, { spec } = {}) => {
      if (!spec || !spec.command) return { ok: false, error: "缺少 command" };
      if (procs.size >= MAX_PROCS) return { ok: false, error: "同時執行的 MCP 伺服器太多（上限 " + MAX_PROCS + "）" };
      const cwd = spec.cwd ? path.resolve(rawFsPath(spec.cwd)) : undefined; const denied = await gateOr(evt, "MCP 伺服器 " + (spec.name || ""), display(spec.command, spec.args), cwd); if (denied) return denied;
      const sp = plan(String(spec.command), (spec.args || []).map(String)); const env = Object.assign({}, process.env, spec.env || {}); let child;
      try { child = spawn(sp.file, sp.args, { cwd, env, shell: sp.shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return { ok: false, error: "啟動失敗：" + String((e && e.message) || e) }; }
      const id = "mcp" + (++seq) + "_" + Date.now().toString(36); const rec = { child, wc: evt.sender, name: spec.name, started: Date.now() }; procs.set(id, rec);
      const send = (ch, payload) => { try { if (!rec.wc.isDestroyed()) rec.wc.send(ch, payload); } catch (_) { /* 視窗已關 */ } };
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (d) => send("fa:mcp:data", { id, text: d, stream: "stdout" })); child.stderr.on("data", (d) => send("fa:mcp:data", { id, text: d, stream: "stderr" }));
      child.stdin.on("error", () => { /* 子行程先結束時寫入會 EPIPE：交給 exit 事件處理 */ });
      child.on("exit", (code, signal) => { procs.delete(id); send("fa:mcp:exit", { id, code, signal }); });
      const started = await new Promise((resolve) => { const t = setTimeout(() => resolve({ ok: true }), 1500); child.once("spawn", () => { clearTimeout(t); resolve({ ok: true }); }); child.once("error", (e) => { clearTimeout(t); procs.delete(id); resolve({ ok: false, error: (e && e.code === "ENOENT" ? "找不到程式 " + spec.command + "（沒安裝，或不在 PATH 裡）" : String((e && e.message) || e)) }); }); });
      if (!started.ok) return started; return { ok: true, id, pid: child.pid };
    });
    ipcMain.handle("fa:mcp:write", async (_e, { id, text } = {}) => { const r = procs.get(id); if (!r) return { ok: false, error: "這個 MCP 行程已經結束" }; try { r.child.stdin.write(String(text)); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } });
    ipcMain.handle("fa:mcp:stop", async (_e, { id } = {}) => { const r = procs.get(id); if (!r) return { ok: true, already: true }; killTree(r.child); return { ok: true }; });
    ipcMain.handle("fa:mcp:list", async () => Array.from(procs.entries()).map(([id, r]) => ({ id, name: r.name, pid: r.child.pid, started: r.started })));
    // 把安裝包的檔案寫進專用資料夾。files：[{ path（相對路徑）, base64 }]；clean:true＝先清掉舊的。路徑不能跳出資料夾（擋 ../、絕對路徑、磁碟機代號）。
    ipcMain.handle("fa:mcp:writeFiles", async (_e, { name, files, clean } = {}) => {
      const base = path.join(installRoot(), safeSeg(name)); let written = 0, skipped = 0, bytes = 0;
      try {
        if (clean) await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); await fs.mkdir(base, { recursive: true }); // Windows 上剛結束的程式還會鎖住資料夾一下子，所以重試
        for (const f of files || []) {
          const rel = String(f.path || "").replace(/\\/g, "/").replace(/^\/+/, ""); const segs = rel.split("/").filter(Boolean);
          if (!segs.length || segs.some((s) => s === "..") || /^[A-Za-z]:/.test(rel) || rel.includes("\0")) { skipped++; continue; }
          const target = path.join(base, ...segs); if (!(target + path.sep).startsWith(base + path.sep)) { skipped++; continue; }
          const buf = Buffer.from(String(f.base64 || ""), "base64"); bytes += buf.length; if (bytes > 800 * 1048576) return { ok: false, error: "解開後超過 800MB，停止" };
          await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, buf); written++;
        }
        return { ok: true, dir: base, written, skipped, bytes };
      } catch (e) { return { ok: false, error: String((e && e.message) || e), written }; }
    });
    ipcMain.handle("fa:mcp:removeDir", async (_e, { dir } = {}) => { const d = path.resolve(String(dir || "")); const root = installRoot(); if (!(d + path.sep).startsWith(root + path.sep) || d === root) return { ok: false, error: "只能刪除 MCP 安裝資料夾裡的東西" }; try { await fs.rm(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } });
    // 跑安裝指令（npm install、pip install…）：過確認閘，輸出只留最後 20KB，逾時（預設 10 分鐘）就終止
    ipcMain.handle("fa:mcp:exec", async (evt, { command, args, cwd, timeoutMs, label } = {}) => {
      if (!command) return { ok: false, error: "缺少 command" }; const wd = cwd ? path.resolve(rawFsPath(cwd)) : undefined; const denied = await gateOr(evt, label || "MCP 安裝", display(command, args), wd); if (denied) return denied;
      const sp = plan(String(command), (args || []).map(String)); const t0 = Date.now();
      return await new Promise((resolve) => {
        let out = ""; let done = false; const child = spawn(sp.file, sp.args, { cwd: wd, shell: sp.shell, windowsHide: true, env: process.env });
        const add = (d) => { out += d; if (out.length > 40000) out = out.slice(-20000); }; child.stdout.on("data", add); child.stderr.on("data", add);
        const timer = setTimeout(() => { if (!done) { done = true; killTree(child); resolve({ ok: false, error: "逾時（" + Math.round((timeoutMs || 600000) / 1000) + " 秒），已終止", output: out.slice(-20000), ms: Date.now() - t0 }); } }, timeoutMs || 600000);
        child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e && e.code === "ENOENT" ? "找不到程式 " + command : String((e && e.message) || e), output: out.slice(-20000) }); } });
        child.on("exit", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, code, output: out.slice(-20000), ms: Date.now() - t0, error: code === 0 ? undefined : "結束代碼 " + code }); } });
      });
    });
    // 檢查執行環境有沒有裝（固定的 --version 指令，不過確認閘）
    ipcMain.handle("fa:mcp:runtimes", async () => {
      const probe = (cmd, args) => new Promise((resolve) => { const sp = plan(cmd, args); try { execFile(sp.file, sp.args, { shell: sp.shell, timeout: 6000, windowsHide: true }, (err, stdout, stderr) => resolve(err ? { ok: false } : { ok: true, version: String(stdout || stderr).trim().split(/\r?\n/)[0].slice(0, 80) })); } catch (_) { resolve({ ok: false }); } });
      const names = { node: ["node", ["--version"]], npm: ["npm", ["--version"]], npx: ["npx", ["--version"]], python: [isWin ? "python" : "python3", ["--version"]], pip: [isWin ? "pip" : "pip3", ["--version"]], uv: ["uv", ["--version"]], uvx: ["uvx", ["--version"]], docker: ["docker", ["--version"]] };
      const out = {}; await Promise.all(Object.entries(names).map(async ([k, [c, a]]) => { out[k] = await probe(c, a); })); return out;
    });
    if (electron && electron.app) electron.app.on("before-quit", () => { for (const r of procs.values()) { try { r.child.kill(); } catch (_) { /* */ } } });
  } catch (e) { console.warn("[main-ext] MCP 載入失敗：", e && e.message); }

  // 熱更新後頁面是從 userData/live-patch/renderer/ 載入的，旁邊沒有安裝包內的 renderer/vendor/（three.js 等自己 pin 的程式庫），主控台會一直出現 ERR_FILE_NOT_FOUND、離線時 3D 也載不到：
  // 啟動時把安裝目錄的 vendor 補一份進去（只補缺的檔案；只用 readdir／readFile／writeFile，安裝包是 asar 時 fs.cp 不能用）
  try {
    const fsx = require("fs"), udir = ctx.userDataDir ? ctx.userDataDir() : "", dst = udir ? path.join(udir, "live-patch", "renderer") : "";
    if (dst && fsx.existsSync(dst)) {
      const copyMissing = (from, to) => { fsx.mkdirSync(to, { recursive: true }); for (const ent of fsx.readdirSync(from, { withFileTypes: true })) { const a = path.join(from, ent.name), b = path.join(to, ent.name); if (ent.isDirectory()) copyMissing(a, b); else if (!fsx.existsSync(b)) fsx.writeFileSync(b, fsx.readFileSync(a)); } };
      const src = path.join(__dirname, "renderer", "vendor"); if (fsx.existsSync(src)) copyMissing(src, path.join(dst, "vendor"));
    }
  } catch (e) { console.warn("[main-ext] 補 vendor 資料夾失敗：", e && e.message); }

  // 熱更新的「檢查／套用」處理（分檔下載、逐段驗證、接回）與缺模組自動補回（ctx.healMissingModules），要在載入可選模組之前準備好
  try { installChunkedUpdater(ipcMain, ctx, overlay); } catch (e) { console.warn("[main-ext] 分檔下載更新處理載入失敗：", e && e.message); }

  // 載入「可選模組」：找不到模組（舊安裝沒有打包它們）時，從熱更新來源自動補回、立刻重新載入，不需要重啟。載入失敗不影響其他功能
  const loadInfo = { errors: {}, healed: {}, loaded: {} };
  ipcMain.handle("fa:diag:mainext", async () => { // 給畫面的診斷：這個主行程模組目前的實際狀態（不含任何機密）
    const fsSync = require("fs"), installDir = __dirname; let live = []; try { live = fsSync.readdirSync(path.join(ctx.userDataDir ? ctx.userDataDir() : "", "live-patch")).filter((n) => /^(computer|rfb)-.*\.js$/.test(n)); } catch (_) { /* */ }
    let installHas = []; try { installHas = fsSync.readdirSync(installDir).filter((n) => /^(computer|rfb)-.*\.js$/.test(n)); } catch (_) { /* */ }
    return { ok: true, rev: ctx.mainExtRev || null, platform: process.platform, installDir, installHasComputerModules: installHas.length, liveHasComputerModules: live.length, overlay: [...overlay.sources.keys()].length, loaded: loadInfo.loaded, errors: loadInfo.errors, healed: loadInfo.healed, logFile: plog.file, logTail: plog.tail(40) };
  });
  const loadWithHeal = (label, load) => {
    try { load(); loadInfo.loaded[label] = true; } catch (e) {
      loadInfo.errors[label] = { code: (e && e.code) || null, message: String((e && e.message) || e).split(String.fromCharCode(10))[0].slice(0, 200) };
      if (e && e.code === "MODULE_NOT_FOUND" && ctx.healMissingModules) {
        console.warn("[main-ext] " + label + " 缺模組（" + String(e.message).split(String.fromCharCode(10))[0] + "），自動補回中…");
        Promise.resolve(ctx.healMissingModules()).then((names) => { load(); loadInfo.loaded[label] = true; loadInfo.healed[label] = names; delete loadInfo.errors[label]; console.log("[main-ext] " + label + " 已自動補回 " + names.length + " 個模組並載入"); }).catch((err) => { loadInfo.errors[label + "（自動補回）"] = { message: String((err && err.message) || err).slice(0, 200) }; console.warn("[main-ext] " + label + " 自動補回失敗（離線時下次啟動再試）：", err && err.message); });
      } else console.warn("[main-ext] " + label + " 載入失敗：", e && e.message);
    }
  };
  // computer use（桌面版限定、預設關閉）：IPC、原生核准視窗、中止快捷鍵都在 computer-use-ipc.js
  loadWithHeal("computer use", () => require("./computer-use-ipc.js").register(ipcMain, ctx));
  // 原生執行器信箱（不重裝版，見 DESIGN.TODO.native-runner.md 第 8-C 節）：寫在這個檔案裡，因為 main-ext.js 會被熱更新送達；
  // 子目錄或新檔案（nr-*.js）不在舊安裝的熱更新清單中，無法送達舊版安裝。
  loadWithHeal("native runner mailbox", () => startNativeMailbox(ctx));

  return { rawFsPath, detectLikelyBinary };
}

// 主行程記錄長期保存：以 "[main-ext]"、"[live-patch]"、"[live-update]" 開頭的 console 訊息，同時寫進 userData/logs/main-ext.log。
// 以前這些只印在終端機，使用者沒開終端機就完全看不到，出問題時無從查起。單檔超過 1MB 就輪替，保留最近 8 份（約 8MB，幾個月的量）；
// 檔案裡只有這些前綴的訊息，不含對話內容或機密。診斷 IPC（fa:diag:mainext）會附上最後幾十行。
function installPersistentLog(ctx) {
  const ctl = { file: null, tail(n) { return []; } };
  try {
    const fsSync = require("fs"), path = ctx.path; const userData = ctx.userDataDir ? ctx.userDataDir() : (ctx.electron && ctx.electron.app ? ctx.electron.app.getPath("userData") : null); if (!userData) return ctl;
    const dir = path.join(userData, "logs"), file = path.join(dir, "main-ext.log"), KEEP = 8, MAX = 1024 * 1024;
    fsSync.mkdirSync(dir, { recursive: true }); ctl.file = file;
    const rotate = () => { try { if (fsSync.statSync(file).size < MAX) return; for (let i = KEEP - 1; i >= 1; i--) { try { fsSync.renameSync(file + "." + i, file + "." + (i + 1)); } catch (_) { /* */ } } try { fsSync.unlinkSync(file + "." + KEEP); } catch (_) { /* */ } fsSync.renameSync(file, file + ".1"); } catch (_) { /* 檔案還不存在 */ } };
    const write = (level, args) => { try { const text = args.map((a) => (a && a.stack) ? String(a.stack).split(String.fromCharCode(10)).slice(0, 4).join(" | ") : (typeof a === "string" ? a : JSON.stringify(a))).join(" "); rotate(); fsSync.appendFileSync(file, new Date().toISOString() + " " + level + " " + text.slice(0, 2000) + String.fromCharCode(10)); } catch (_) { /* 記錄失敗不影響功能 */ } };
    for (const level of ["log", "warn", "error"]) {
      const orig = console[level].bind(console);
      console[level] = (...args) => { try { if (typeof args[0] === "string" && /^\[(main-ext|live-patch|live-update)\]/.test(args[0])) write(level, args); } catch (_) { /* */ } return orig(...args); };
    }
    ctl.tail = (n) => { try { return String(fsSync.readFileSync(file, "utf8")).split(String.fromCharCode(10)).filter(Boolean).slice(-n); } catch (_) { return []; } };
    console.log("[main-ext] 啟動 platform=" + process.platform + " electron=" + (process.versions.electron || "?") + " app=" + (ctx.electron && ctx.electron.app ? ctx.electron.app.getVersion() : "?") + " installDir=" + __dirname);
  } catch (_) { /* 沒有記錄就沒有，不影響功能 */ }
  return ctl;
}

// 主行程模組的熱更新覆蓋（長期方案，不依賴 main.js 裡那份名單）。
// main.js（只能靠重新安裝更新）自己有一份「哪些模組可以被覆蓋」的名單，舊版安裝的名單比較短：後來新增的模組（例如 computer-use-*.js）
// 即使熱更新已經下載到 userData/live-patch/，主程式也不會用，而且安裝目錄根本沒有這些檔案，require 直接找不到。
// 這裡在 main-ext.js 載入時（main.js 的名單管不到的地方）補上兩個攔截：
//   1. Module._extensions[".js"]：安裝目錄裡的 xxx.js，只要 live-patch 有通過驗證的版本（state.json 記的 md5 對得上、跟內建不同），就用那個版本編譯。
//   2. Module._resolveFilename：相對路徑 ./xxx.js 找不到（舊安裝沒有這個檔案）而 live-patch 有驗證過的版本時，指到「安裝目錄裡的虛擬路徑」，
//      由上面第 1 個攔截供應內容，所以模組裡的相對 require、__dirname 都跟新安裝完全一樣。
// 範圍是「頂層的 *.js」（main.js、preload.js 除外）；驗證規則跟 main.js 的覆蓋一樣，FA_DISABLE_MAIN_OVERLAY=1 可整個停用。
function installModuleOverlay(ctx) {
  const ctl = { sources: new Map(), refresh() { /* 沒有覆蓋目錄時什麼都不做 */ } };
  if (process.env.FA_DISABLE_MAIN_OVERLAY === "1") return ctl;
  const fsSync = require("fs"), path = ctx.path, crypto = require("crypto"), Module = require("module");
  const electron = ctx.electron || null;
  const userData = (() => { try { return ctx.userDataDir ? ctx.userDataDir() : (electron && electron.app ? electron.app.getPath("userData") : null); } catch (_) { return null; } })();
  if (!userData) return ctl;
  const live = path.join(userData, "live-patch"), installDir = __dirname;
  // 讀 state.json、逐檔驗證 md5，重建「可以用熱更新版本」的名單；自動補回模組（healMissingModules）下載完會再呼叫一次
  ctl.refresh = function () {
    const next = new Map();
    try {
      const state = JSON.parse(fsSync.readFileSync(path.join(live, "state.json"), "utf8"));
      const baseline = JSON.parse(fsSync.readFileSync(path.join(installDir, "renderer", "update-manifest.json"), "utf8"));
      if (state && state.files && state.baselineVersion === (baseline.baseVersion || (electron && electron.app ? electron.app.getVersion() : undefined))) {
        for (const rel of Object.keys(state.files)) {
          if (!/^[\w.-]+\.js$/.test(rel) || rel === "main.js" || rel === "preload.js") continue;
          if (state.files[rel] === (baseline.files || {})[rel]) continue; // 跟內建一樣：沒有覆蓋
          let buf; try { buf = fsSync.readFileSync(path.join(live, rel)); } catch (_) { continue; }
          if (crypto.createHash("md5").update(buf).digest("hex") !== state.files[rel]) continue; // 沒通過驗證：不用
          next.set(rel, buf.toString("utf8"));
        }
      }
    } catch (_) { /* 沒有覆蓋目錄或 state.json：用內建版本 */ }
    ctl.sources.clear(); for (const [k, v] of next) ctl.sources.set(k, v);
  };
  ctl.refresh();
  // 攔截一律裝上（名單可能之後才補齊）
  const orig = Module._extensions[".js"];
  Module._extensions[".js"] = function (mod, filename) {
    if (path.dirname(filename) === installDir) {
      const src = ctl.sources.get(path.basename(filename));
      if (src != null) { try { return mod._compile(src, filename); } catch (err) { console.error("[main-ext] 覆蓋版本 " + path.basename(filename) + " 載入失敗，退回內建版本：", err); } }
    }
    return orig(mod, filename);
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    try { return origResolve.call(this, request, parent, ...rest); } catch (err) {
      const m = err && err.code === "MODULE_NOT_FOUND" && /^\.\/([\w.-]+?)(\.js)?$/.exec(String(request));
      if (m && ctl.sources.has(m[1] + ".js")) return path.join(installDir, m[1] + ".js");
      throw err;
    }
  };
  if (ctl.sources.size) console.log("[main-ext] 主行程模組覆蓋（名單以 live-patch 的 state.json 為準）：" + [...ctl.sources.keys()].join("、"));
  return ctl;
}

// 熱更新套用處理的覆寫（長期方案）。
// 為什麼放在這裡：main.js 是入口，只能靠重新安裝更新，但 main-ext.js 在熱更新清單裡、啟動時載入。
// 已安裝的舊版主程式 fa:update:apply 有單檔 8MB 上限、也不認得 manifest 的 parts（分段）；這裡在 app ready 之後
// （main.js 的 handler 這時已經註冊完）把 fa:update:apply 換成：
//   - 沒有大小上限，連上伺服器之後不計時（慢網路也能下載大檔）
//   - 有 parts 的檔案逐段下載（每段最多重試 3 次、各自驗 md5），接回後再驗整個檔案的 md5
//   - 其餘行為跟 main.js 的版本一致（先全部下載驗證完才落地、覆蓋目錄／state.json 格式相同、主行程模組先做語法檢查）
// fa:update:check 也一併換掉（要讀同一份 manifest.v2.json 才比得對）。兩份 manifest 的格式見 scripts/make-live-patch.js。
function installChunkedUpdater(ipcMain, ctx, overlay) {
  const electron = ctx.electron; if (!electron || !electron.app) return;
  const { fs, path } = ctx; const crypto = require("crypto"); const { app } = electron;
  const BRANCH_BASE = process.env.FA_UPDATE_BASE || "https://raw.githubusercontent.com/sunneo/tw_stock_db/desktop-app-patch"; // FA_UPDATE_BASE：測試時指向本機
  let BASE = BRANCH_BASE;
  // raw.githubusercontent.com 的分支網址會被各地的快取分別保存，同一個分支的 manifest.json、manifest.v2.json、各檔案可能停在不同版本
  // （實測：分支是 187，v2 manifest 還回 186）。所以每次檢查／套用先用 GitHub API（沒有這個快取）問出最新 commit，之後一律用固定 commit 的網址；
  // API 失敗（沒網路、被限流）就退回分支網址。
  async function refreshBase() {
    if (process.env.FA_UPDATE_BASE) { BASE = BRANCH_BASE; return BASE; }
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
      try { const r = await fetch("https://api.github.com/repos/sunneo/tw_stock_db/git/ref/heads/desktop-app-patch", { signal: ctl.signal, headers: { Accept: "application/vnd.github+json" } }); if (r.ok) { const j = await r.json(); const sha = j && j.object && j.object.sha; if (/^[0-9a-f]{40}$/.test(sha || "")) { BASE = "https://raw.githubusercontent.com/sunneo/tw_stock_db/" + sha; return BASE; } } } finally { clearTimeout(timer); }
    } catch (_) { /* 退回分支網址 */ }
    BASE = BRANCH_BASE; return BASE;
  }
  const md5Hex = (b) => crypto.createHash("md5").update(b).digest("hex");
  // 這個更新處理「第一次啟動」時（包含剛從舊版更新、重啟後的那一次），檢查到有更新就請畫面自動跳出更新視窗（只一次）：
  // 舊安裝要分兩輪才能補齊（先換上這個更新處理、重啟，再下載它才知道要收的新模組），不能要使用者自己記得再按一次「檢查更新」。
  // REV 是這個行為的版本戳記；之後想讓所有人再補檢查一次時，把它改成新字串即可。
  const REV = "2026-10-26-vendor"; ctx.mainExtRev = REV; let autoPrompt = false;
  try {
    const seenFile = path.join(ctx.userDataDir ? ctx.userDataDir() : app.getPath("userData"), "main-ext-rev.txt"), fsSync = require("fs");
    let seen = ""; try { seen = fsSync.readFileSync(seenFile, "utf8").trim(); } catch (_) { /* 第一次 */ }
    if (seen !== REV) { autoPrompt = true; try { fsSync.writeFileSync(seenFile, REV); } catch (_) { /* */ } }
  } catch (_) { /* */ }
  const mainDir = () => (require.main && require.main.filename ? path.dirname(require.main.filename) : __dirname);
  const patchDir = () => path.join(ctx.userDataDir ? ctx.userDataDir() : app.getPath("userData"), "live-patch");
  const readJson = async (file, fb) => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (_) { return fb; } };
  const writeJson = async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8"); };
  async function copyDir(src, dest) { // 只用 readdir／readFile／writeFile（asar 內也能讀）
    await fs.mkdir(dest, { recursive: true });
    for (const e of await fs.readdir(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dest, e.name);
      if (e.isDirectory()) await copyDir(s, d); else if (e.isFile()) await fs.writeFile(d, await fs.readFile(s));
    }
  }
  async function md5Either(file) { // 工作目錄可能是 CRLF，基準 md5 是 LF 版本：兩種都算
    try { const buf = await fs.readFile(file), raw = md5Hex(buf); if (buf.indexOf(13) < 0) return [raw]; return [raw, md5Hex(Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1"))]; } catch (_) { return null; }
  }
  async function getBuf(url, { timeoutMs = 0 } = {}) { // timeoutMs 只管「連得上」；連上之後不再計時
    const ctl = new AbortController(); const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const sep = url.includes("?") ? "&" : "?";
      const resp = await fetch(url + sep + "_cb=" + Date.now() + "-" + Math.random().toString(36).slice(2), { signal: ctl.signal, cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      if (timer) clearTimeout(timer);
      return Buffer.from(await resp.arrayBuffer());
    } finally { if (timer) clearTimeout(timer); }
  }
  async function fetchFile(rel, info) {
    const parts = info && Array.isArray(info.parts) ? info.parts : null;
    if (!parts || !parts.length) return getBuf(BASE + "/" + ((info && typeof info.path === "string" && /^[\w./-]+$/.test(info.path) && !info.path.includes("..")) ? info.path : rel), { timeoutMs: 30000 });
    const bufs = [];
    for (const p of parts) {
      if (!p || typeof p.path !== "string" || !/^[\w./-]+$/.test(p.path) || p.path.includes("..")) throw new Error(rel + " 的分段路徑不正確");
      let got = null, last = null;
      for (let i = 0; i < 3 && !got; i++) { // 單段重試：網路不穩時只重抓這一段
        try { const b = await getBuf(BASE + "/" + p.path, { timeoutMs: 30000 }); if (p.md5 && md5Hex(b) !== p.md5) throw new Error(p.path + " 的 md5 不符"); got = b; } catch (e) { last = e; }
      }
      if (!got) throw new Error(rel + " 分段下載失敗：" + String((last && last.message) || last));
      bufs.push(got);
    }
    return Buffer.concat(bufs);
  }
  // 本機目前實際生效的 manifest（覆蓋目錄完整可信才採用 state.json，否則退回內建基準）
  async function loadLocal() {
    const baselineFile = path.join(mainDir(), "renderer", "update-manifest.json");
    const baseline = (await readJson(baselineFile, null)) || { schema: 1, baseVersion: app.getVersion(), files: {} };
    const baselineVersion = baseline.baseVersion || app.getVersion();
    const stateFile = path.join(patchDir(), "state.json");
    let local = { version: baselineVersion, files: { ...baseline.files }, overrideActive: false };
    const state = await readJson(stateFile, null);
    if (state && state.files && typeof state.files === "object" && state.baselineVersion === baselineVersion) {
      let intact = true;
      for (const rel of Object.keys(state.files)) {
        if (!allowedRel(rel, baseline)) continue;
        const actual = await md5Either(path.join(patchDir(), rel));
        if (actual === null && baseline.files[rel] === state.files[rel]) continue;
        if (actual === null || actual.indexOf(state.files[rel]) < 0) { intact = false; break; }
      }
      if (intact) local = { version: state.appliedVersion || baselineVersion, files: { ...baseline.files, ...state.files }, overrideActive: true };
    }
    return { baseline, baselineVersion, stateFile, local };
  }
  // 遠端 manifest：先讀新版格式 manifest.v2.json（單一大檔 + 分段），沒有就用 manifest.json（舊版主程式也看得懂的互換版）
  async function loadRemote() {
    let remote = null;
    try { remote = JSON.parse((await getBuf(BASE + "/manifest.v2.json", { timeoutMs: 15000 })).toString("utf8")); } catch (_) { remote = null; }
    if (!remote || typeof remote.files !== "object") remote = JSON.parse((await getBuf(BASE + "/manifest.json", { timeoutMs: 15000 })).toString("utf8"));
    if (!remote || typeof remote.files !== "object") throw new Error("manifest格式不正確（缺少files欄位）");
    return remote;
  }
  // 可以被熱更新的路徑：renderer 底下的檔案、頂層的 *.js（main.js 除外，它只能靠重新安裝）。不再要求「安裝時就在內建清單裡」：新增的模組也收得到
  const allowedRel = (rel, baseline) => rel in (baseline.files || {}) || (/^(renderer\/[\w./-]+|[\w.-]+\.js)$/.test(rel) && !rel.includes("..") && rel !== "main.js");
  const changedFiles = (baseline, local, remote) => Object.keys(remote.files).filter((rel) => allowedRel(rel, baseline) && remote.files[rel] && typeof remote.files[rel].md5 === "string" && local.files[rel] !== remote.files[rel].md5);
  async function check() {
    await refreshBase();
    const { baseline, local } = await loadLocal(); const remote = await loadRemote(); const files = changedFiles(baseline, local, remote);
    console.log("[main-ext] 檢查更新：目前 " + local.version + "，遠端 " + (remote.version || "?") + "，來源 " + BASE.slice(-12) + "，要更新 " + files.length + " 個檔案" + (files.length ? "：" + files.slice(0, 8).join("、") : ""));
    const prompt = autoPrompt && files.length > 0; if (prompt) autoPrompt = false; // 只提示一次
    return { ok: true, currentVersion: local.version, remoteVersion: remote.version || null, notes: remote.notes || "", publishedAt: remote.publishedAt || null, hasUpdate: files.length > 0, changedFiles: files, autoPrompt: prompt };
  }
  async function apply() {
    await refreshBase();
    const { baseline, baselineVersion, stateFile, local } = await loadLocal();
    const remote = await loadRemote();
    const toFetch = changedFiles(baseline, local, remote);
    if (!toFetch.length) {
      // 沒有檔案要換，但遠端版號不一樣（例如新版只多了本機早就有、內容相同的檔案）：只把紀錄的版號跟上，不然畫面會一直顯示舊版號。
      // 只在覆蓋目錄完整可信（overrideActive）時才寫；沒有覆蓋目錄就沒有 state 可以更新。
      const rv = remote.version ? String(remote.version) : "";
      if (rv && local.overrideActive && String(local.version) !== rv) {
        await writeJson(stateFile, { schema: 1, appliedVersion: rv, appliedAt: new Date().toISOString(), baselineVersion, files: { ...local.files } });
        return { ok: true, appliedVersion: rv, changedFiles: [] };
      }
      return { ok: true, appliedVersion: local.version, changedFiles: [] };
    }

    const downloaded = {};
    for (const rel of toFetch) {
      const buf = await fetchFile(rel, remote.files[rel]);
      if (md5Hex(buf) !== remote.files[rel].md5) throw new Error(rel + " 下載內容跟manifest.json宣告的md5不符，已中止這次更新（沒有寫入任何檔案）");
      if (!rel.startsWith("renderer/") && /\.js$/.test(rel)) { // 主行程模組：套用前先確認語法
        try { new (require("vm").Script)(require("module").wrap(buf.toString("utf8")), { filename: rel }); } catch (e) { throw new Error(rel + " 語法檢查失敗，已中止這次更新（沒有寫入任何檔案）：" + String((e && e.message) || e)); }
      }
      downloaded[rel] = buf;
    }
    if (!local.overrideActive) { // 覆蓋目錄不存在、被改壞或建立在別的基準版本上：整個重建
      await fs.rm(patchDir(), { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(patchDir(), { recursive: true });
      await copyDir(path.join(mainDir(), "renderer"), path.join(patchDir(), "renderer"));
    }
    for (const rel of toFetch) { const dest = path.join(patchDir(), rel); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, downloaded[rel]); }
    const next = { ...local.files }; for (const rel of toFetch) next[rel] = remote.files[rel].md5;
    await writeJson(stateFile, { schema: 1, appliedVersion: remote.version || local.version, appliedAt: new Date().toISOString(), baselineVersion, files: next });
    console.log("[main-ext] 套用更新：" + (remote.version || "?") + "，" + toFetch.length + " 個檔案：" + toFetch.slice(0, 12).join("、"));
    const requiresRestart = toFetch.some((f) => !f.startsWith("renderer/"));
    return { ok: true, appliedVersion: remote.version || local.version, changedFiles: toFetch, requiresRestart };
  }
  // 自動補回缺的模組：舊安裝（打包時沒有 computer-use-*.js 這類後來新增的模組）載入失敗時由 register() 呼叫——
  // 從遠端 manifest 下載「安裝目錄沒有、熱更新目錄也沒有」的頂層模組，寫進 live-patch 並登記進 state.json（逐檔驗 md5），
  // 呼叫端接著重新 require 就能用，不需要使用者重啟或再按一次檢查更新。離線時失敗，下次啟動再試。
  const fsSync = require("fs");
  async function healMissingModules() {
    await refreshBase();
    const { baselineVersion, stateFile, local } = await loadLocal();
    const remote = await loadRemote();
    const installDir = __dirname;
    const want = Object.keys(remote.files).filter((rel) => /^[\w.-]+\.js$/.test(rel) && rel !== "main.js" && rel !== "preload.js" && !fsSync.existsSync(path.join(installDir, rel)) && !overlay.sources.has(rel) && remote.files[rel] && typeof remote.files[rel].md5 === "string");
    if (!want.length) return [];
    const got = {};
    for (const rel of want) {
      const buf = await fetchFile(rel, remote.files[rel]);
      if (md5Hex(buf) !== remote.files[rel].md5) throw new Error(rel + " 下載內容跟manifest宣告的md5不符，沒有寫入");
      try { new (require("vm").Script)(require("module").wrap(buf.toString("utf8")), { filename: rel }); } catch (e) { throw new Error(rel + " 語法檢查失敗，沒有寫入：" + String((e && e.message) || e)); }
      got[rel] = buf;
    }
    for (const rel of want) { const dest = path.join(patchDir(), rel); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, got[rel]); }
    const prev = await readJson(stateFile, null), valid = prev && prev.files && prev.baselineVersion === baselineVersion;
    const files = valid ? { ...prev.files } : {}; for (const rel of want) files[rel] = remote.files[rel].md5;
    await writeJson(stateFile, { schema: 1, appliedVersion: valid ? (prev.appliedVersion || local.version) : (remote.version || local.version), appliedAt: new Date().toISOString(), baselineVersion, files });
    overlay.refresh();
    return want;
  }
  ctx.healMissingModules = healMissingModules;
  app.whenReady().then(() => { // main.js 的 handler 在模組載入時就註冊好了，ready 之後再換
    try { ipcMain.removeHandler("fa:update:apply"); } catch (_) { /* */ }
    try { ipcMain.removeHandler("fa:update:check"); } catch (_) { /* */ }
    ipcMain.handle("fa:update:check", async () => { try { return await check(); } catch (err) { return { ok: false, error: String((err && err.message) || err) }; } });
    ipcMain.handle("fa:update:apply", async () => { try { return await apply(); } catch (err) { return { ok: false, error: String((err && err.message) || err) }; } });
  });
}

// ---------- 系統匣（Windows／Ubuntu／XFCE）：設定「顯示系統匣圖示」「關閉視窗時縮到系統匣」，存在 desktop-settings.json 的 trayIcon／closeToTray ----------
// 關閉＝只把主視窗藏起來（行程、遠端群組、排程都繼續跑），要從系統匣選單「結束」才真的離開。
// Linux 的系統匣靠 StatusNotifier（DBus）；沒有人接（例如 GNOME 沒裝 AppIndicator 外掛、XFCE 面板沒加「通知區域／狀態通知」）時圖示根本不會出現，
// 這時把視窗藏起來就找不回來了，所以偵測不到時「關閉」改成最小化到工作列，並在設定畫面說明原因。
function installTray(ctx, ipcMain) {
  const E = ctx.electron; if (!E || !E.app || !E.Tray || !E.Menu) return;
  const app = E.app, nodePath = require("path"), nodeFs = require("fs"), isLinux = process.platform === "linux";
  const st = { cfg: { trayIcon: false, closeToTray: false }, tray: null, quitting: false, linuxHost: null, error: "" };
  app.on("before-quit", () => { st.quitting = true; });
  // 視窗藏起來（縮到系統匣）、被別的視窗蓋住、最小化時，Chromium 預設會把頁面降速（計時器 1 秒一次、動畫幀停掉、被遮住的視窗當成背景），
  // 匯出 mp4、錄製、長時間任務就會停擺。桌面版是會自己跑長任務的助理，所以整個關掉這些降速（要在 app ready 之前下開關）。
  try { for (const sw of ["disable-renderer-backgrounding", "disable-background-timer-throttling", "disable-backgrounding-occluded-windows"]) app.commandLine.appendSwitch(sw); } catch (_) { /* */ }
  try { const cur = String(app.commandLine.getSwitchValue("disable-features") || ""); const add = ["CalculateNativeWinOcclusion"].filter((f) => cur.split(",").indexOf(f) < 0); if (add.length) app.commandLine.appendSwitch("disable-features", [cur].concat(add).filter(Boolean).join(",")); } catch (_) { /* */ }
  const mainWin = () => { try { const w = ctx.getMainWindow && ctx.getMainWindow(); return w && !w.isDestroyed() ? w : null; } catch (_) { return null; } };
  // 對話框（匯入技能的資料夾選擇、執行確認等）都是 parent＝主視窗的 modal 子視窗，主視窗藏起來時它們會跟著被藏／鎖住：
  // 從系統匣顯示時只剩失控的子視窗、主視窗被它鎖住叫不回來。所以：縮到系統匣前先把子視窗當成「取消」關掉；顯示時主視窗與子視窗一起帶回前景。
  const childWins = (w) => { try { return (w.getChildWindows() || []).filter((c) => c && !c.isDestroyed()); } catch (_) { return []; } };
  // 原生對話框（dialog.showOpenDialog／showMessageBox／showSaveDialog）沒有視窗物件可關：計數，有未回應的就不縮到系統匣
  st.nativeOpen = 0;
  try {
    const D = E.dialog;
    if (D) for (const name of ["showOpenDialog", "showMessageBox", "showSaveDialog"]) {
      const orig = D[name]; if (typeof orig !== "function" || orig.__faCounted) continue;
      const wrapped = function () { st.nativeOpen++; let r; try { r = orig.apply(this, arguments); } catch (e) { st.nativeOpen--; throw e; } return Promise.resolve(r).finally(() => { st.nativeOpen = Math.max(0, st.nativeOpen - 1); }); };
      wrapped.__faCounted = true; try { D[name] = wrapped; } catch (_) { /* 唯讀就算了 */ }
    }
  } catch (_) { /* */ }
  const showWin = () => {
    const w = mainWin(); if (!w) return;
    try { if (w.isMinimized()) w.restore(); w.setSkipTaskbar(false); w.show(); w.focus(); } catch (_) { /* */ }
    for (const c of childWins(w)) { try { if (c.isMinimized()) c.restore(); if (!c.isVisible()) c.show(); c.focus(); } catch (_) { /* */ } }   // 還有開著的子視窗：一起帶回，焦點給它（modal 時主視窗本來就點不了）
  };
  const quit = () => { st.quitting = true; app.quit(); };
  const iconImage = () => {
    const cands = [nodePath.join(app.getAppPath(), "build", "icon.png"), nodePath.join(__dirname, "build", "icon.png")];
    for (const f of cands) { try { const img = E.nativeImage.createFromPath(f); if (!img.isEmpty()) return img.resize({ width: isLinux ? 22 : 16, height: isLinux ? 22 : 16 }); } catch (_) { /* 換下一個 */ } }
    return E.nativeImage.createEmpty();
  };
  const probeLinuxHost = () => new Promise((resolve) => {
    if (!isLinux) return resolve(true);
    try { require("child_process").execFile("busctl", ["--user", "status", "org.kde.StatusNotifierWatcher"], { timeout: 4000 }, (err) => resolve(!err)); } catch (_) { resolve(true); }   // 沒有 busctl：無法判斷，當作有
  });
  const destroyTray = () => { if (st.tray) { try { st.tray.destroy(); } catch (_) { /* */ } st.tray = null; } };
  const buildTray = () => {
    if (st.tray) return; st.error = "";
    try {
      const t = new E.Tray(iconImage()); t.setToolTip("FloatingAssistant");
      t.setContextMenu(E.Menu.buildFromTemplate([{ label: "顯示視窗", click: showWin }, { type: "separator" }, { label: "結束", click: quit }]));
      t.on("click", () => { const w = mainWin(); if (w && w.isVisible() && !w.isMinimized() && !isLinux) { try { w.hide(); w.setSkipTaskbar(true); } catch (_) { /* */ } } else showWin(); });   // Windows：點一下顯示／藏起來；Linux 的 click 常常不會送來，主要靠選單
      t.on("double-click", showWin); st.tray = t;
    } catch (e) { st.error = String((e && e.message) || e); st.tray = null; }
  };
  const apply = async () => {
    if (st.cfg.trayIcon || st.cfg.closeToTray) { if (isLinux && st.linuxHost == null) st.linuxHost = await probeLinuxHost(); buildTray(); } else destroyTray();
  };
  const status = () => ({ trayIcon: !!st.cfg.trayIcon, closeToTray: !!st.cfg.closeToTray, active: !!st.tray, platform: process.platform, linuxHost: st.linuxHost, error: st.error });
  const trayReliable = () => !!st.tray && (!isLinux || st.linuxHost !== false);
  const hook = (win) => {
    if (!win || win.__faTrayHooked) return; win.__faTrayHooked = true;
    try { win.webContents.setBackgroundThrottling(false); } catch (_) { /* 舊版 Electron：只靠上面的命令列開關 */ }
    win.on("close", (ev) => {
      if (st.quitting || !st.cfg.closeToTray || !st.tray || win !== mainWin()) return;
      ev.preventDefault();
      if (st.nativeOpen > 0) { try { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } catch (_) { /* */ } return; }   // 原生對話框還沒回應：不藏起來，把視窗帶到前面讓使用者先處理
      for (const c of childWins(win)) { try { c.close(); } catch (_) { try { c.destroy(); } catch (__) { /* */ } } }   // 子視窗的 closed 處理都是「取消」；關不掉就強制銷毀，免得留下被鎖的孤兒
      try { if (trayReliable()) { win.hide(); win.setSkipTaskbar(true); } else win.minimize(); } catch (_) { /* */ }   // 系統匣不一定看得到：看不到就只最小化，視窗還在工作列上找得回來
    });
  };
  app.on("browser-window-created", (_e, w) => hook(w)); try { E.BrowserWindow.getAllWindows().forEach(hook); } catch (_) { /* */ }
  app.on("second-instance", showWin);
  const load = async () => { try { const c = await ctx.getDesktopSettings(); st.cfg = { trayIcon: !!(c && c.trayIcon), closeToTray: !!(c && c.closeToTray) }; } catch (_) { /* 預設關 */ } await apply(); };
  app.whenReady().then(load).catch(() => {});
  ipcMain.handle("fa:tray:get", async () => status());
  ipcMain.handle("fa:tray:set", async (_evt, patch) => {
    patch = patch || {}; const next = {}; if (typeof patch.trayIcon === "boolean") next.trayIcon = patch.trayIcon; if (typeof patch.closeToTray === "boolean") next.closeToTray = patch.closeToTray;
    if (next.closeToTray) next.trayIcon = true;   // 縮到系統匣一定要有圖示
    if (next.trayIcon === false) next.closeToTray = false;
    Object.assign(st.cfg, next); try { await ctx.patchDesktopSettings(next); } catch (_) { /* 這次還是生效，只是下次啟動不記得 */ }
    await apply(); if (!st.cfg.closeToTray) { const w = mainWin(); if (w && !w.isVisible()) showWin(); } return status();
  });
}

// 執行包（見 DESIGN.TODO.native-runner.md 交接第 (2) 節）：子程序程式（nr-*.js）與 onnxruntime-node 1.22.0 原生檔放在
// userData/native-runtime/<版本>/，manifest.json 記錄每個檔案的大小與 md5。載入前全部核對；任何一個對不上就當作沒有執行包（不用半個）。
const NATIVE_RUNTIME_VERSION = "1.22.0-1";
// 執行包來源（見 main-ext.js 的 NRI）：來源 1 是 npm 官方庫的 tgz；來源 2 是 GitHub 分支 native-runtime-1.22.0，釘住 commit SHA 的 raw 網址。
const NATIVE_NPM_TARBALL = "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.22.0.tgz";
const NATIVE_GITHUB_BASE = "https://raw.githubusercontent.com/sunneo/tw_stock_db/9702b97723a24f61792d0814832a885e3aa756db";
function checkNativeRuntimeDir(dir) {
  const fsSync = require("fs"), pathM = require("path"), crypto = require("crypto");
  let manifest = null;
  try { manifest = JSON.parse(fsSync.readFileSync(pathM.join(dir, "manifest.json"), "utf8")); } catch (_) { return { ok: false, dir, reason: "沒有執行包" }; }
  if (!manifest || manifest.runtimeVersion !== NATIVE_RUNTIME_VERSION || !manifest.files) return { ok: false, dir, reason: "執行包清單版本不符" };
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return { ok: false, dir, reason: "執行包是 " + manifest.platform + "-" + manifest.arch + "，這台電腦是 " + process.platform + "-" + process.arch };
  for (const rel of Object.keys(manifest.files)) {
    const exp = manifest.files[rel];
    let buf = null;
    try { buf = fsSync.readFileSync(pathM.join(dir, ...rel.split("/"))); } catch (_) { return { ok: false, dir, reason: "缺少檔案：" + rel }; }
    if (buf.length !== exp.size || crypto.createHash("md5").update(buf).digest("hex") !== exp.md5) return { ok: false, dir, reason: "檔案核對失敗：" + rel };
  }
  return { ok: true, dir, version: NATIVE_RUNTIME_VERSION, ortVersion: manifest.ortVersion };
}
function nativeRuntimeDir(userData) { return require("path").join(userData, "native-runtime", NATIVE_RUNTIME_VERSION); }
// 從本機資料夾安裝執行包（先複製到 .partial、核對通過才改名）。目前只給測試用（環境變數 FA_NATIVE_RUNTIME_LOCAL_SRC）；真正的下載見第 4 項。
function installNativeRuntimeFromLocal(userData, srcDir) {
  const fsSync = require("fs"), dst = nativeRuntimeDir(userData), tmp = dst + ".partial";
  fsSync.mkdirSync(require("path").dirname(dst), { recursive: true });
  fsSync.rmSync(tmp, { recursive: true, force: true });
  fsSync.cpSync(srcDir, tmp, { recursive: true });
  const check = checkNativeRuntimeDir(tmp);
  if (!check.ok) { fsSync.rmSync(tmp, { recursive: true, force: true }); return check; }
  fsSync.rmSync(dst, { recursive: true, force: true });
  fsSync.renameSync(tmp, dst);
  return checkNativeRuntimeDir(dst);
}

// 原生執行器的主程序信箱（見 DESIGN.TODO.native-runner.md 第 8-C 節）。
// 渲染程序把請求寫成 <userData>/native-runner-box/req-<id>.json（用既有的 desktopAPI.rawfs），這裡每 200 毫秒輪詢，
// 寫回 resp-<id>.json（先寫 .tmp 再改名）。真引擎尚未接上：status 回報沒有子程序，run 回傳 no_engine（不假裝成功）。
// 協定與子程序執行器的程式在 nr-*.js（隨安裝包提供）；接上真引擎後，這裡改為載入執行包（userData/native-runtime）內的程式。
// 執行包按需安裝（併入本檔，因為 main-ext.js 不能 require 不在熱更新清單內的檔案；見 DESIGN.TODO.native-runner.md 第 4 項與「安裝路徑」教訓）。
// 執行包的分割清單（與 GitHub 分支 native-runtime-1.22.0 的 manifest.json 逐位元組相同；內嵌在本檔，因為外部資料檔熱更新送不到舊安裝）。
const NATIVE_RUNTIME_MANIFEST = {
  "runtimeVersion": "1.22.0-1",
  "ortVersion": "1.22.0",
  "license": "MIT",
  "partMaxBytes": 5242880,
  "sources": {
    "npm": {
      "package": "onnxruntime-node@1.22.0",
      "tarball": "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.22.0.tgz",
      "integrity": "sha512-QaAqr7PFekrmEsmu1rpw7OxJYyG+iACjNHoNtQIVt9Oh7st8WDPIIUe6KhF9l35HVJTJd9CV1rePoPmKhSV26g==",
      "tgzBytes": 93267589,
      "note": "npm 官方庫（來源 1）只提供 onnxruntime 相關檔（不含 nr-*.js）"
    },
    "commonPackage": "onnxruntime-common@1.22.0（來源：本機既有安裝，見 DESIGN.TODO.native-runner.md 第 4 項）",
    "github": {
      "branch": "native-runtime-1.22.0",
      "commit": "",
      "note": "來源 2：釘住 commit SHA 的 raw 網址；所有檔案都在這裡"
    }
  },
  "platforms": {
    "win32-x64": 21707587,
    "linux-x64": 31433755
  },
  "files": [
    {
      "path": "node_modules/onnxruntime-node/package.json",
      "platform": "all",
      "size": 1563,
      "sha256": "93822b4dc79a4da16969c13feb57e4ff907bd151cde1c20f9f08abc705f3aa8c",
      "parts": [
        {
          "name": "node_modules__onnxruntime-node__package.json.001.part",
          "size": 1563,
          "md5": "deb73ac61fce96b53949ba4ace09bfd0"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-node/dist/backend.js",
      "platform": "all",
      "size": 6242,
      "sha256": "2fb40405c5dad7aa88dcf1071ea4b8a0e49a3ad59def0a3f23b5dda8ff273d3e",
      "parts": [
        {
          "name": "node_modules__onnxruntime-node__dist__backend.js.001.part",
          "size": 6242,
          "md5": "0fcec928859ae8f5eba82457da377988"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-node/dist/binding.js",
      "platform": "all",
      "size": 1507,
      "sha256": "65be03f9a10c7ad773c22185a94f0b80835cd40ddcdc2acd63c1fbe96f94cbb8",
      "parts": [
        {
          "name": "node_modules__onnxruntime-node__dist__binding.js.001.part",
          "size": 1507,
          "md5": "e75e045ad4c3c947675dfb2f7519785c"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-node/dist/index.js",
      "platform": "all",
      "size": 1602,
      "sha256": "019eb02133b94b1f7fdf2d89eb93b590ce1288d271f7b280647fb3978e6391fa",
      "parts": [
        {
          "name": "node_modules__onnxruntime-node__dist__index.js.001.part",
          "size": 1602,
          "md5": "5c8472d3fa84691984af86b872f0e037"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-node/dist/version.js",
      "platform": "all",
      "size": 361,
      "sha256": "b2a2394cf6f8abf4682cb3ee6488e4b0c72b07bcacd286636881d22880fd5bed",
      "parts": [
        {
          "name": "node_modules__onnxruntime-node__dist__version.js.001.part",
          "size": 361,
          "md5": "8407ced7d136f2c3371042931f205337"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll",
      "platform": "win32-x64",
      "size": 21296680,
      "sha256": "ba2a8a791133d97d6a80da393815565709dd6936f457bc00d8ce4c707873e3a6",
      "parts": [
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__win32__x64__onnxruntime.dll.001.part",
          "size": 5242880,
          "md5": "eafaee9bcec6835d4f98b6ad34913c87"
        },
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__win32__x64__onnxruntime.dll.002.part",
          "size": 5242880,
          "md5": "676cd94729a60d88485fd845a8491832"
        },
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__win32__x64__onnxruntime.dll.003.part",
          "size": 5242880,
          "md5": "214c7110cd3848013a422308e5611d4f"
        },
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__win32__x64__onnxruntime.dll.004.part",
          "size": 5242880,
          "md5": "f09c1f6d9603111b9c03bf4952dceffb"
        },
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__win32__x64__onnxruntime.dll.005.part",
          "size": 325160,
          "md5": "81d30a4abdfc445619230ac984ccdbd5"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
      "platform": "win32-x64",
      "size": 294448,
      "sha256": "93ef9b1ad9d7297ea0a61e8c06d2d58c13df4a4e8b82acef63e454bd0feac0cb",
      "parts": [
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__win32__x64__onnxruntime_binding.node.001.part",
          "size": 294448,
          "md5": "972494a41ee074e8e58369df660773a6"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
      "platform": "linux-x64",
      "size": 30948272,
      "sha256": "08cf3bf4218f0e816c2a534e960d85221274cb319569bdf1136b29da7065b015",
      "parts": [
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__linux__x64__libonnxruntime.so.1.001.part",
          "size": 5242880,
          "md5": "ff291677be8d4c6fd4e26e477a85d0c7"
        },
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__linux__x64__libonnxruntime.so.1.002.part",
          "size": 5242880,
          "md5": "4767f1d949c51bd799dadb8e68c38c0d"
        },
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__linux__x64__libonnxruntime.so.1.003.part",
          "size": 5242880,
          "md5": "e719ec1667e3bf7cd1f19abbe071c111"
        },
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__linux__x64__libonnxruntime.so.1.004.part",
          "size": 5242880,
          "md5": "423b9b0b0ce78885ffe9b7143b2640f8"
        },
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__linux__x64__libonnxruntime.so.1.005.part",
          "size": 5242880,
          "md5": "df470d4d21708c2d4ce3cf59cb8748e7"
        },
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__linux__x64__libonnxruntime.so.1.006.part",
          "size": 4733872,
          "md5": "4345bd92535f32bf6d09be83d28d0664"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
      "platform": "linux-x64",
      "size": 369024,
      "sha256": "229510ccb4eefde35f99c5004a5e5cf402e7735683ddfdaa85ca9b5cda696bb5",
      "parts": [
        {
          "name": "node_modules__onnxruntime-node__bin__napi-v6__linux__x64__onnxruntime_binding.node.001.part",
          "size": 369024,
          "md5": "88b3f0822104128e94d831817b84575f"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/package.json",
      "platform": "all",
      "size": 924,
      "sha256": "172704f8f9132f41e35b35331fd607ca9a2ce0db159f5bb958e5fd0c4948b720",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__package.json.001.part",
          "size": 924,
          "md5": "f61da94ece8007e8928b7efbce3350e9"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/backend-impl.js",
      "platform": "all",
      "size": 5608,
      "sha256": "3d25321895995f7e9480570b9a88f121049adf152e1829d0ecb11218da02d487",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__backend-impl.js.001.part",
          "size": 5608,
          "md5": "be75c4c780f203a3b2144c936318f066"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/backend.js",
      "platform": "all",
      "size": 433,
      "sha256": "325aaee7a2649ea27629666f3ca01c0d80b9751e704ce502e43a8352390749b4",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__backend.js.001.part",
          "size": 433,
          "md5": "580167fb8499ce6b1016a7c527c0ff74"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/env-impl.js",
      "platform": "all",
      "size": 969,
      "sha256": "35cd8cac33973538eab471b68622c86c35a6896f4307d1a74c9ca0eda7abbac6",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__env-impl.js.001.part",
          "size": 969,
          "md5": "88dc4a7f069afbd3e4f1421b96c671bb"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/env.js",
      "platform": "all",
      "size": 366,
      "sha256": "22c7647f8ca1c1b83b437a92b95fee1457fcb72866fa029616b8f146dc609be8",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__env.js.001.part",
          "size": 366,
          "md5": "1359e1f3094a40b5d36fb79289fafc8d"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/index.js",
      "platform": "all",
      "size": 1955,
      "sha256": "d7dd6cc9790e87299099fcd1b0ccb4969c01591d7eec0383a1c64dbea133dd1a",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__index.js.001.part",
          "size": 1955,
          "md5": "e2eed22c99037b33cae03c0cf9a160fd"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/inference-session-impl.js",
      "platform": "all",
      "size": 8726,
      "sha256": "f7dd84f0cbd7f1f5de1b091acd6831f9d56281a08375a519daffe78218894c11",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__inference-session-impl.js.001.part",
          "size": 8726,
          "md5": "3548dd7fd57e6219bd4c97f9237b0a61"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/inference-session.js",
      "platform": "all",
      "size": 467,
      "sha256": "458be26f316c5068d32a56ddbc30ca0aa687c636e079b3d161a69f0f14a683f1",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__inference-session.js.001.part",
          "size": 467,
          "md5": "19954cb9802e55c93ea024fb031a1c4a"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/onnx-model.js",
      "platform": "all",
      "size": 211,
      "sha256": "667f5fdac4b6df25e17f8a864d4dc619507f541f9fa0aafb6d3572fcca1e25e5",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__onnx-model.js.001.part",
          "size": 211,
          "md5": "0fa6c079f9e7182cc9773e36bafe648f"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/onnx-value.js",
      "platform": "all",
      "size": 211,
      "sha256": "8446854766f4955ce438a7338216f49223767ecc508bb502b73a3dc1a1f1998e",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__onnx-value.js.001.part",
          "size": 211,
          "md5": "9d53b845c82e1021aca4f1089d27bab7"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/package.json",
      "platform": "all",
      "size": 20,
      "sha256": "091a04fa67c7907b98e106fcff8b964e13129754fce72d24f3025b97c4887fa3",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__package.json.001.part",
          "size": 20,
          "md5": "a6b7eb31b5dcf3835a90ea0d201f21e3"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/tensor-conversion-impl.js",
      "platform": "all",
      "size": 8153,
      "sha256": "c99276518d66de5826798a3c488166ed827fcd0db2372ca3ace06338cef27e5a",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__tensor-conversion-impl.js.001.part",
          "size": 8153,
          "md5": "0a32dbdce6b3160afc806ce628aac6dc"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/tensor-conversion.js",
      "platform": "all",
      "size": 218,
      "sha256": "28cc462d4a9ea556ecc86c0e6d16a51d61b58d5bc5b4b7b48976b14bc8035bdc",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__tensor-conversion.js.001.part",
          "size": 218,
          "md5": "35c568b3e11f00fed3430979e7380ba3"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/tensor-factory-impl.js",
      "platform": "all",
      "size": 11656,
      "sha256": "a3204838a2c14416e4e61c968dc17c663ab3c9b8b2c4a8b7f2a1c5b06e3e5173",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__tensor-factory-impl.js.001.part",
          "size": 11656,
          "md5": "f8a2752f2daa802ab19fd07068588981"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/tensor-factory.js",
      "platform": "all",
      "size": 215,
      "sha256": "13b8d735350b828a49bda8aeec50b1dac888cf42268006efc4312f50a88b6906",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__tensor-factory.js.001.part",
          "size": 215,
          "md5": "a426f8441535f34d1c53ab02a1f27cfc"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/tensor-impl-type-mapping.js",
      "platform": "all",
      "size": 2995,
      "sha256": "333110edbbffdb7575ea340cb341bcaf691862d6594a649db28097f7d8cb19b7",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__tensor-impl-type-mapping.js.001.part",
          "size": 2995,
          "md5": "ad395af7a584d9eaef868f3f1fc6d519"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/tensor-impl.js",
      "platform": "all",
      "size": 16458,
      "sha256": "11645352ba5d08971344717d3339f86aac560f84f29229b2ebe07f1ec8aa8905",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__tensor-impl.js.001.part",
          "size": 16458,
          "md5": "3f957b33ed99024d7c566d697c48fca0"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/tensor-utils-impl.js",
      "platform": "all",
      "size": 2213,
      "sha256": "e7b1db989d33d54bdd1807b080a0989ff0b10d5f7dd8c93b92bbf293103aa4d5",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__tensor-utils-impl.js.001.part",
          "size": 2213,
          "md5": "2bb223e57b0506d3eb093c3c38c7f769"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/tensor-utils.js",
      "platform": "all",
      "size": 213,
      "sha256": "d3f577e90dc2257c72ac728e5e6355c34af0342d971158d9f22b69d22aa97b8d",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__tensor-utils.js.001.part",
          "size": 213,
          "md5": "c96e0742cba6061381360cc4364ef1ba"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/tensor.js",
      "platform": "all",
      "size": 393,
      "sha256": "9097114de356750f36f28776fa6ccd08d13694f0f9aac9e7669c30b6c43153f7",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__tensor.js.001.part",
          "size": 393,
          "md5": "d18b07a43fd1b8bab9a1876d7eee7b78"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/trace.js",
      "platform": "all",
      "size": 1783,
      "sha256": "f7b21eb2aa4c44bf85274c58b803ae49689a929911e103297fb26220e39e11e6",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__trace.js.001.part",
          "size": 1783,
          "md5": "71de144c3f762b5e65b1ebb37f33e9b1"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/type-helper.js",
      "platform": "all",
      "size": 212,
      "sha256": "7f786da8d2a611ad751c70a74edf4d9acfccd26be8e5c6b1cb730f982892bf32",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__type-helper.js.001.part",
          "size": 212,
          "md5": "b42bb8dd40c691aade1467401d945fbc"
        }
      ]
    },
    {
      "path": "node_modules/onnxruntime-common/dist/cjs/version.js",
      "platform": "all",
      "size": 361,
      "sha256": "b2a2394cf6f8abf4682cb3ee6488e4b0c72b07bcacd286636881d22880fd5bed",
      "parts": [
        {
          "name": "node_modules__onnxruntime-common__dist__cjs__version.js.001.part",
          "size": 361,
          "md5": "8407ced7d136f2c3371042931f205337"
        }
      ]
    },
    {
      "path": "nr-child.js",
      "platform": "all",
      "size": 7629,
      "sha256": "437cb6df334906bdf4633d4ae6ccd25d78383d61aade27e028bec406c39f787e",
      "parts": [
        {
          "name": "nr-child.js.001.part",
          "size": 7629,
          "md5": "db7e4f5b7b1e10987ff1828db7c97445"
        }
      ]
    },
    {
      "path": "nr-engine.js",
      "platform": "all",
      "size": 4514,
      "sha256": "3a6f8943a383b840f2c5c9e54ba60ec60a62e34c6dda5bc28bd88adb84340a79",
      "parts": [
        {
          "name": "nr-engine.js.001.part",
          "size": 4514,
          "md5": "663d698c89f5ecde20de5e0d82d28015"
        }
      ]
    },
    {
      "path": "nr-host.js",
      "platform": "all",
      "size": 11212,
      "sha256": "576357f00e29c9fd4189b85ba0e3ddee23b91d68f23141700848c4d53ed7b34d",
      "parts": [
        {
          "name": "nr-host.js.001.part",
          "size": 11212,
          "md5": "24e6748c3dde747b2c62f79d795d511a"
        }
      ]
    },
    {
      "path": "nr-protocol.js",
      "platform": "all",
      "size": 4424,
      "sha256": "7ffeb1793ee4446893fbb9ce223ed48a6f255c39d3834e011cba26a34097f0e4",
      "parts": [
        {
          "name": "nr-protocol.js.001.part",
          "size": 4424,
          "md5": "e7ecfc335b67492fa5fb79dc98400180"
        }
      ]
    },
    {
      "path": "nr-gen-params.js",
      "platform": "all",
      "size": 5653,
      "sha256": "5641c517f416f0e62452f2536e80abad1d981d7c0ef8061161903a821d757dcd",
      "parts": [
        {
          "name": "nr-gen-params.js.001.part",
          "size": 5653,
          "md5": "b16613584ef2509459fbe2f5f81b5d3b"
        }
      ]
    },
    {
      "path": "nr-template.js",
      "platform": "all",
      "size": 2089,
      "sha256": "f2d8cccdb6a5d4ceaf0bbe3d8787d0c9455b52bc0db2f0b022beb11e6acbccf2",
      "parts": [
        {
          "name": "nr-template.js.001.part",
          "size": 2089,
          "md5": "7cb23cd7ca34b14737c56f3e5298b927"
        }
      ]
    },
    {
      "path": "nr-tokenizer.js",
      "platform": "all",
      "size": 4903,
      "sha256": "55398a744469b67eefb07dfcbf7ae1c0bb7537293daa2dd6aa674e1f999e8b9c",
      "parts": [
        {
          "name": "nr-tokenizer.js.001.part",
          "size": 4903,
          "md5": "9c9e19a3dd31fdce9ec0b3041d482663"
        }
      ]
    }
  ]
};

const NRI = (function () {
// 執行包按需安裝（見 DESIGN.TODO.native-runner.md 第 4 項）。只在主程序使用；由使用者在介面按下安裝時才執行，不會自動下載。
// 來源順序（使用者原話：「用npm官方庫優先，官方庫掛了才跑github branch下載」）：
//   1. npm 官方庫：onnxruntime-node-1.22.0.tgz，用 integrity（sha512）驗證後抽取 onnxruntime 相關檔（不含 onnxruntime-common 與子程序程式）。
//   2. GitHub 分支 native-runtime-1.22.0：釘住 commit SHA 的 raw 網址，分割段逐段 md5，合併後整檔 sha256。
// 切換條件：npm 連線失敗、逾時、HTTP 非 200、或 integrity 驗證失敗，才改走來源 2。兩個來源取得的每個檔案都要 sha256 相同。
// 進度與原因都會寫進 log（哪個來源、為什麼切換）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const NPM_PREFIX = 'node_modules/onnxruntime-node/';

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function sha512Integrity(buf) { return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64'); }

// 讀 tgz 內的檔案（ustar 格式，只取 wanted(名稱) 為真的一般檔案）。名稱是 tgz 內的路徑（例如 package/dist/index.js）。
function tgzEntries(gz, wanted) {
    const buf = zlib.gunzipSync(gz);
    const out = new Map();
    const cstr = (off, len) => { let e = off; while (e < off + len && buf[e] !== 0) e++; return buf.toString('utf8', off, e); };
    let off = 0;
    while (off + 512 <= buf.length) {
        if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
        const name = cstr(off, 100), prefix = cstr(off + 345, 155);
        const full = prefix ? prefix + '/' + name : name;
        const size = parseInt(cstr(off + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(buf[off + 156] || 48);
        if ((type === '0' || type === '\0') && wanted(full)) out.set(full, Buffer.from(buf.subarray(off + 512, off + 512 + size)));
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
}

// tgz 內名稱（package/...）對應到執行包內的路徑（node_modules/onnxruntime-node/...）
function tgzToRel(name) {
    if (!name.startsWith('package/')) return null;
    return NPM_PREFIX + name.slice('package/'.length);
}

function platformFiles(manifest, platformKey) {
    return manifest.files.filter((f) => f.platform === platformKey || f.platform === 'all');
}

// 來源 1：npm。回傳 { ok, why, bufs: Map(rel→Buffer) }。
async function trySourceNpm(manifest, opts) {
    const src = manifest.sources.npm;
    let gz;
    try { gz = await opts.fetchBytes(opts.npmLocation || src.tarball, opts.timeoutMs); }
    catch (e) { return { ok: false, why: 'npm 連線失敗、逾時或 HTTP 非 200：' + String((e && e.message) || e) }; }
    if (sha512Integrity(gz) !== src.integrity) return { ok: false, why: 'npm 的 integrity（sha512）驗證失敗' };
    const want = new Set(platformFiles(manifest, opts.platformKey).map((f) => f.path));
    const entries = tgzEntries(gz, (n) => { const r = tgzToRel(n); return r && want.has(r); });
    const bufs = new Map();
    for (const [name, buf] of entries) bufs.set(tgzToRel(name), buf);
    return { ok: true, bufs, bytes: gz.length };
}

// 來源 2：GitHub 分支的分割段。每段 md5 核對，合併後整檔 sha256 核對。
async function readFromGithub(manifest, file, opts) {
    const parts = [];
    for (const p of file.parts) {
        const b = await opts.fetchBytes(opts.githubBase + '/parts/' + p.name, opts.timeoutMs);
        if (opts.stats) opts.stats.githubBytes = (opts.stats.githubBytes || 0) + b.length;
        if (md5(b) !== p.md5) throw new Error('段 ' + p.name + ' 的 md5 不符');
        parts.push(b);
    }
    const buf = Buffer.concat(parts);
    if (buf.length !== file.size || sha256(buf) !== file.sha256) throw new Error('合併後 ' + file.path + ' 的 sha256 不符');
    return buf;
}

// 主流程。opts: { manifest, platformKey, runtimeDir（最後的目標）, npmLocation?, githubBase, fetchBytes(location, timeoutMs)→Buffer, forceGithub?, timeoutMs, log, nrSourceDir }
// 回傳 { ok, runtimeDir, sourcesUsed: {rel: 'npm'|'github'}, why? }
async function installRuntime(opts) {
    const log = opts.log || (() => {});
    const prog = opts.progress || (() => {}); // prog({ stage, source, detail }) 給介面顯示進度與來源
    const m = opts.manifest;
    const files = platformFiles(m, opts.platformKey);
    const stage = opts.runtimeDir + '.partial';
    fs.rmSync(stage, { recursive: true, force: true });
    let npm = { ok: false, why: '沒有嘗試' };
    if (!opts.forceGithub) {
        log('[native-runtime] 來源 1：npm 官方庫（' + m.sources.npm.package + '）');
        prog({ stage: 'npm', source: 'npm', detail: '正在下載 npm 官方庫的 tgz（約 89 MB）' });
        npm = await trySourceNpm(m, opts);
        if (npm.ok) { log('[native-runtime] npm 成功（' + npm.bytes + ' 位元組），抽取 onnxruntime 相關檔'); prog({ stage: 'npm-ok', source: 'npm', detail: 'npm 下載完成，integrity 驗證通過（' + npm.bytes + ' 位元組）' }); }
        else { log('[native-runtime] 切換到來源 2（GitHub 分支）：' + npm.why); prog({ stage: 'switch', source: 'github', detail: '切換到 GitHub 分支，原因：' + npm.why }); }
    } else {
        log('[native-runtime] 強制使用來源 2（GitHub 分支）');
        prog({ stage: 'switch', source: 'github', detail: '強制使用 GitHub 分支（測試）' });
    }
    const sourcesUsed = {};
    const installed = {};
    try {
        for (const f of files) {
            let buf = npm.ok && npm.bufs.get(f.path) ? npm.bufs.get(f.path) : null;
            let from = 'npm';
            if (buf && sha256(buf) !== f.sha256) { buf = null; log('[native-runtime] npm 的 ' + f.path + ' sha256 不符，改用來源 2'); }
            if (!buf) { buf = await readFromGithub(m, f, opts); from = 'github'; }
            if (sha256(buf) !== f.sha256) throw new Error('最終檔案 ' + f.path + ' 的 sha256 不符');
            const dst = path.join(stage, ...f.path.split('/'));
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.writeFileSync(dst, buf);
            sourcesUsed[f.path] = from;
            installed[f.path] = { size: buf.length, md5: md5(buf), sha256: sha256(buf) };
            prog({ stage: 'file', source: from, detail: '第 ' + (Object.keys(installed).length) + ' / ' + files.length + ' 個檔案（' + from + '）：' + f.path });
        }
        // 子程序程式（nr-*.js）：只能從來源 2 取得（npm 沒有）；名單在 manifest 的 files 裡，source 標示 github
        if (opts.nrSourceDir) {
            // 只有安裝目錄真的有這個檔案才用本機的（舊安裝沒有）；沒有就走來源 2
            for (const f of m.files.filter((x) => /^nr-.*\.js$/.test(x.path) && fs.existsSync(path.join(opts.nrSourceDir, x.path)))) {
                const buf = fs.readFileSync(path.join(opts.nrSourceDir, f.path));
                if (sha256(buf) !== f.sha256) throw new Error('本機 ' + f.path + ' 與分割包不一致');
                fs.writeFileSync(path.join(stage, f.path), buf);
                sourcesUsed[f.path] = 'local';
                installed[f.path] = { size: buf.length, md5: md5(buf), sha256: sha256(buf) };
            }
        }
        for (const f of m.files.filter((x) => /^nr-.*\.js$/.test(x.path))) {
            if (!installed[f.path]) { const buf = await readFromGithub(m, f, opts); fs.writeFileSync(path.join(stage, f.path), buf); sourcesUsed[f.path] = 'github'; installed[f.path] = { size: buf.length, md5: md5(buf), sha256: sha256(buf) }; }
        }
        const [plat, arch] = opts.platformKey.split('-');
        const runtimeFiles = {};
        for (const k of Object.keys(installed)) runtimeFiles[k] = { size: installed[k].size, md5: installed[k].md5 };
        fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ runtimeVersion: m.runtimeVersion, ortVersion: m.ortVersion, platform: plat, arch, license: m.license, files: runtimeFiles }, null, 2) + '\n');
        fs.rmSync(opts.runtimeDir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(opts.runtimeDir), { recursive: true });
        fs.renameSync(stage, opts.runtimeDir);
        return { ok: true, runtimeDir: opts.runtimeDir, sourcesUsed, npmUsed: npm.ok, npmBytes: npm.ok ? npm.bytes : 0, githubBytes: (opts.stats && opts.stats.githubBytes) || 0 };
    } catch (e) {
        fs.rmSync(stage, { recursive: true, force: true });
        return { ok: false, why: String((e && e.message) || e), sourcesUsed };
    }
}

// 本機與測試用的讀取器：location 是檔案路徑（tgz 或目錄）；網址則用 https（只在主程序、產品用）。
function localFetchBytes(location) {
    if (fs.existsSync(location) && fs.statSync(location).isFile()) return Promise.resolve(fs.readFileSync(location));
    return Promise.reject(new Error('找不到來源：' + location));
}

// 產品用的網路讀取器（只在主程序、使用者按下安裝時用）：跟隨最多 5 次轉址，HTTP 非 200 就失敗，逾時就中斷。
function httpsFetchBytes(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const go = (u, hops) => {
            const req = https.get(u, { timeout: timeoutMs || 60000 }, (res) => {
                if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && hops < 5) {
                    res.resume(); go(new URL(res.headers.location, u).toString(), hops + 1); return;
                }
                if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('逾時')));
            req.on('error', reject);
        };
        go(url, 0);
    });
}


return { installRuntime, tgzEntries, sha256, sha512Integrity, localFetchBytes, httpsFetchBytes, NPM_PREFIX };
})();

// ===== 通用 ONNX 張量執行（NRT；見 DESIGN.native-all-models.md 第 8 節）=====
// 子程序只做三件事：載入 ONNX 檔（onnxruntime-node，CPU）、讀輸入張量檔、session.run 後把輸出張量寫成檔。前後處理留在渲染程序。
// 控制訊息走標準輸入輸出（一行一則 JSON），張量走暫存檔（原始二進位）；不開任何埠、不用任何網路通道。
// 為什麼寫在本檔、不放進 nr-protocol.js／nr-child.js：那兩個檔是執行包的一部分，有 md5 釘住並從 GitHub 分支下載，改了會讓已安裝的執行包核對失敗；
// 本檔會被熱更新送達，舊安裝也收得到。子程序用 `electron -e <原始碼>`（ELECTRON_RUN_AS_NODE=1）啟動，原始碼就是下面 tensorChildMain 的 toString，不另寫檔。
const NRT = (function () {
  // 子程序入口：必須完全自給自足（只能用 require 與全域），因為它會被轉成字串在另一個行程執行。
  function tensorChildMain() {
    const fs = require('fs'), path = require('path');
    const TYPED = { float32: Float32Array, float64: Float64Array, int32: Int32Array, int64: BigInt64Array, uint8: Uint8Array };
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    let ort = null, session = null, kvStore = null;
    const fail = (id, code, e) => send({ type: 'error', id, code, message: String((e && e.message) || e) });
    async function load(m) {
      const t0 = Date.now();
      try { ort = ort || require(process.env.NRT_ORT_DIR); } catch (e) { return fail(m.id, 'load_failed', '載入 onnxruntime-node 失敗：' + ((e && e.message) || e)); }
      try {
        session = await ort.InferenceSession.create(m.model_path, { executionProviders: ['cpu'], intraOpNumThreads: m.threads || 4, graphOptimizationLevel: m.graph_opt || 'all', enableMemPattern: false });
      } catch (e) { return fail(m.id, 'load_failed', e); }
      send({ type: 'tensor_loaded', id: m.id, input_names: session.inputNames, output_names: session.outputNames, ms: Date.now() - t0 });
    }
    async function run(m) {
      if (!session) return fail(m.id, 'internal', '還沒載入模型');
      const t0 = Date.now();
      try {
        const feeds = {};
        for (const it of m.inputs) {
          const C = TYPED[it.dtype]; if (!C) return fail(m.id, 'bad_input', '不支援的 dtype：' + it.dtype);
          const buf = fs.readFileSync(it.path); const want = it.dims.reduce((a, b) => a * b, 1) * C.BYTES_PER_ELEMENT;
          if (buf.length !== want) return fail(m.id, 'bad_input', '輸入 ' + it.name + ' 位元組數不符：' + buf.length + ' / ' + want);
          feeds[it.name] = new ort.Tensor(it.dtype, new C(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), it.dims);
          try { fs.unlinkSync(it.path); } catch (_) { /* 讀完即刪，刪不掉不影響結果 */ }
        }
        // 快取模式（midigenai 這類逐字生成）：過去的 key／value 快取留在子程序，請求只帶新的輸入；m.kv = { past:[名稱], neu:[新列輸出名稱], h, d, pos, rows, reset }
        // 快取位置 pos 必須跟子程序記的一致（不一致＝子程序重啟過或步驟漏了），回 kv_mismatch，呼叫端改用網頁版重做這一步
        const kv = m.kv; let kvNext = null;
        if (kv) {
          const row = kv.h * kv.d;
          if (kv.reset) kvStore = { P: 0, cap: 64, bufs: kv.past.map(() => new Float32Array(64 * row)) };
          if (!kvStore || kvStore.P !== kv.pos || kvStore.bufs.length !== kv.past.length) return fail(m.id, 'kv_mismatch', '快取位置不符：子程序 ' + (kvStore ? kvStore.P : '無') + ' / 要求 ' + kv.pos);
          kv.past.forEach((n, j) => { feeds[n] = new ort.Tensor('float32', kvStore.bufs[j].subarray(0, kv.pos * row), [1, kv.pos, kv.h, kv.d]); });
          kvNext = { row, rows: kv.rows };
        }
        const outs = await session.run(feeds);
        if (kvNext) {
          const need = kvStore.P + kvNext.rows;
          if (need > kvStore.cap) { const cap = Math.max(need, Math.ceil(kvStore.cap * 1.5)); kvStore.bufs = kvStore.bufs.map((b) => { const nb = new Float32Array(cap * kvNext.row); nb.set(b.subarray(0, kvStore.P * kvNext.row)); return nb; }); kvStore.cap = cap; }
          kv.neu.forEach((n, j) => { kvStore.bufs[j].set(outs[n].data, kvStore.P * kvNext.row); });
          kvStore.P = need;
        }
        fs.mkdirSync(m.out_dir, { recursive: true });
        const outputs = [];
        session.outputNames.forEach((name, i) => {
          const t = outs[name], d = t.data, p = path.join(m.out_dir, 'out-' + i + '.bin');
          fs.writeFileSync(p, Buffer.from(d.buffer, d.byteOffset, d.byteLength));
          outputs.push({ name, dtype: t.type, dims: Array.from(t.dims), path: p, bytes: d.byteLength });
        });
        send({ type: 'tensor_done', id: m.id, outputs, ms: Date.now() - t0 });
      } catch (e) { fail(m.id, /memory|alloc/i.test(String((e && e.message) || e)) ? 'oom' : 'internal', e); }
    }
    let buf = '', chain = Promise.resolve();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk; const parts = buf.split('\n'); buf = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch (e) { fail('', 'internal', '不是合法的 JSON'); continue; }
        if (m.type === 'tensor_load') chain = chain.then(() => load(m));
        else if (m.type === 'tensor_run') chain = chain.then(() => run(m));
        else if (m.type === 'dispose') { process.exit(0); }
        else fail(m.id || '', 'internal', '子程序不處理的訊息：' + m.type);
      }
    });
    process.stdin.on('end', () => process.exit(0));
  }
  const childSource = '(' + tensorChildMain.toString() + ')()';
  const DTYPE_BYTES = { float32: 4, float64: 8, int32: 4, int64: 8, uint8: 1 };
  const SAFE = /^[A-Za-z0-9._-]+$/;

  // 主程序端：一個 host 管一個子程序（一個模型）。要求一次一個；逾時就強制結束子程序；子程序崩潰時所有等待中的要求都收到 crashed。
  function createTensorHost(o) {
    o = o || {};
    const spawnFn = o.spawnFn || require('child_process').spawn, execPath = o.execPath || process.execPath, log = o.log || (() => {});
    const idleMs = o.idleMs != null ? o.idleMs : 10 * 60 * 1000;
    let child = null, seq = 0, chain = Promise.resolve(), idleTimer = null, loaded = null, lastLoad = null; // lastLoad：閒置關閉或崩潰後下一次 run 要自動重新載入的參數
    const pending = new Map(), tail = [];
    function killChild() { const c = child; child = null; loaded = null; if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } if (c) { c._expected = true; try { c.kill(); } catch (_) { /* 已結束 */ } } }
    function touch() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; if (idleMs > 0 && child) { idleTimer = setTimeout(() => { if (pending.size === 0) { log('[native] 張量子程序閒置關閉'); killChild(); } }, idleMs); if (idleTimer.unref) idleTimer.unref(); } }
    function ensure() {
      if (child) return child;
      const c = spawnFn(execPath, ['-e', o.source || childSource], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: Object.assign({}, process.env, o.env || {}, { ELECTRON_RUN_AS_NODE: '1', NRT_ORT_DIR: o.ortDir || '' }) });
      child = c; let buf = '';
      c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
      c.stdout.on('data', (chunk) => {
        buf += chunk; const parts = buf.split('\n'); buf = parts.pop();
        for (const line of parts) {
          if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch (_) { log('[native] 張量子程序輸出不合法'); continue; }
          const job = pending.get(m.id); if (!job) continue; clearTimeout(job.timer); pending.delete(m.id);
          if (m.type === 'error') { const e = new Error(m.message || m.code); e.code = m.code; job.reject(e); } else job.resolve(m);
          touch();
        }
      });
      c.stderr.on('data', (chunk) => { for (const l of String(chunk).split('\n')) if (l.trim()) { tail.push(l.trim()); if (tail.length > 10) tail.shift(); } });
      c.on('error', (e) => log('[native] 張量子程序 spawn 失敗：' + ((e && e.message) || e)));
      c.on('exit', (code, signal) => {
        if (child === c) { child = null; loaded = null; }
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (c._expected) { for (const [id, j] of pending) { if (j.c !== c) continue; clearTimeout(j.timer); j.reject(Object.assign(new Error('子程序已結束'), { code: 'cancelled' })); pending.delete(id); } return; }
        const why = '張量子程序意外結束（退出碼 ' + code + '，signal ' + (signal || '無') + '）' + (tail.length ? '；最後的日誌：' + tail.slice(-3).join(' | ') : '');
        log('[native] ' + why);
        for (const [id, j] of pending) { if (j.c !== c) continue; clearTimeout(j.timer); j.reject(Object.assign(new Error(why), { code: 'crashed' })); pending.delete(id); }
      });
      return c;
    }
    function send(type, fields, timeoutMs) {
      const job = chain.then(() => new Promise((resolve, reject) => {
        const id = 't' + (++seq), c = ensure(); if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        const timer = timeoutMs > 0 ? setTimeout(() => { if (!pending.has(id)) return; pending.delete(id); killChild(); reject(Object.assign(new Error('逾時（' + timeoutMs + ' 毫秒），已強制結束子程序'), { code: 'timeout' })); }, timeoutMs) : null;
        pending.set(id, { resolve, reject, timer, c });
        try { c.stdin.write(JSON.stringify(Object.assign({ type, id }, fields)) + '\n'); } catch (e) { pending.delete(id); clearTimeout(timer); reject(Object.assign(new Error(String((e && e.message) || e)), { code: 'internal' })); }
      }));
      chain = job.catch(() => {});
      return job;
    }
    return {
      // 載入模型；同一個檔案已載入就直接回上次的名稱
      async load(m) {
        if (loaded && loaded.model_path === m.model_path) return loaded;
        const r = await send('tensor_load', { model_path: m.model_path, threads: m.threads || 4, graph_opt: m.graph_opt || 'all' }, m.timeoutMs || 120000);
        loaded = { model_path: m.model_path, input_names: r.input_names, output_names: r.output_names, ms: r.ms }; lastLoad = { model_path: m.model_path, threads: m.threads, graph_opt: m.graph_opt, timeoutMs: m.timeoutMs }; return loaded;
      },
      async run(m) {
        // 子程序因閒置、逾時或崩潰被結束過：自動重新載入同一個模型再跑（呼叫端手上的 session 物件不用重建）
        if (!loaded && lastLoad) await this.load(lastLoad);
        return send('tensor_run', { inputs: m.inputs, out_dir: m.out_dir, kv: m.kv }, m.timeoutMs || 120000);
      },
      dispose() { lastLoad = null; if (child) { try { child.stdin.write(JSON.stringify({ type: 'dispose', id: 'd' }) + '\n'); } catch (_) { /* 已結束 */ } } killChild(); },
      status() { return { alive: !!child, pid: child ? child.pid : null, pending: pending.size, loaded: loaded ? loaded.model_path : null }; },
    };
  }
  return { tensorChildMain, childSource, createTensorHost, DTYPE_BYTES, SAFE };
})();

function startNativeMailbox(ctx) {
  const fsSync = require("fs"), pathM = require("path");
  const app = ctx.electron && ctx.electron.app;
  const userData = ctx.userDataDir ? ctx.userDataDir() : (app ? app.getPath("userData") : null);
  if (!userData) return { ok: false, reason: "沒有 userData 路徑" };
  const box = pathM.join(userData, "native-runner-box");
  try { fsSync.mkdirSync(box, { recursive: true }); } catch (_) { /* 之後每輪再試 */ }
  let runtime = checkNativeRuntimeDir(nativeRuntimeDir(userData));
  const localSrc = process.env.FA_NATIVE_RUNTIME_LOCAL_SRC;
  if (!runtime.ok && localSrc) {
    try { runtime = installNativeRuntimeFromLocal(userData, localSrc); } catch (e) { runtime = { ok: false, reason: "本機來源安裝失敗：" + String((e && e.message) || e) }; }
  }
  let protocolOk = false;
  if (runtime.ok) { try { require(require("path").join(runtime.dir, "nr-protocol.js")); protocolOk = true; } catch (e) { runtime = { ok: false, reason: "載入子程序協定失敗：" + String((e && e.message) || e) }; } }
  console.log("[main-ext] 執行包：" + (runtime.ok ? "就緒 " + runtime.version + "（onnxruntime-node " + runtime.ortVersion + "）" : "沒有可用（" + runtime.reason + "）"));
  // 真引擎：子程序由 nr-host.js 管理（懶啟動、握手、逾時、崩潰重啟）。模型檔與分詞器路徑由環境變數給（產品端的下載位置見第 4 項）。
  const modelPath = process.env.FA_NATIVE_MODEL_PATH || "", tokenizerPath = process.env.FA_NATIVE_TOKENIZER_PATH || "";
  let host = null;
  let installing = false;
  // 安裝進度：寫進信箱資料夾的 install-progress.json（渲染程序每半秒讀一次）
  const progFile = pathM.join(box, "install-progress.json");
  const writeProg = (o) => { try { fsSync.writeFileSync(progFile + ".tmp", JSON.stringify(Object.assign({ at: Date.now() }, o))); fsSync.renameSync(progFile + ".tmp", progFile); } catch (_) { /* 寫不了就只靠最後的回應 */ } };
  function getHost() {
    if (!host) host = require(pathM.join(runtime.dir, "nr-host.js")).createNativeRunnerHost({
      childPath: pathM.join(runtime.dir, "nr-child.js"),
      progressFile: pathM.join(box, "progress.jsonl"),
      execPath: process.execPath,
      log: (s) => console.log("[main-ext] " + s),
    });
    return host;
  }
  const idleStatus = { alive: false, pid: null, pending: 0, consecutiveCrashes: 0, disabled: false, disabledReason: "" };
  let runQueue = Promise.resolve(); // 生成一次只跑一個（子程序一次只處理一個生成）
  async function doRun(id, p) {
    const tokFile = pathM.join(box, "tok-" + id + ".jsonl");
    try { fsSync.unlinkSync(tokFile); } catch (_) { /* 還沒有 */ }
    try {
      const r = await getHost().run({
        messages: p.messages || [], template: p.template, gen: p.gen, maxTokens: p.maxTokens, stream: !!p.stream, timeoutMs: p.timeoutMs || 0, seed: p.seed,
        modelPath, tokenizerPath,
        onToken: (t) => { try { fsSync.appendFileSync(tokFile, JSON.stringify({ text: t }) + "\n"); } catch (_) { /* 寫不了就只靠最後結果 */ } },
      });
      return { ok: true, text: r.text, ms: r.ms, finish_reason: r.finish_reason, backend: "native" };
    } catch (e) {
      return { ok: false, code: (e && e.code) || "internal", message: String((e && e.message) || e), backend: "native" };
    }
  }
  // ---- 通用 ONNX 張量執行（見 NRT）：模型檔放在 <userData>/native-models/<id>/<檔名>，旁邊的 .ok 檔記大小與 SHA-256（核對過才算裝好）----
  const modelsDir = pathM.join(userData, "native-models"), nrtHosts = new Map();
  const safeName = (s) => typeof s === "string" && NRT.SAFE.test(s) && s !== "." && s !== "..";
  const ortDirOf = () => pathM.join(runtime.dir, "node_modules", "onnxruntime-node");
  function onnxState(p) {
    if (!runtime.ok) return { ok: false, code: "no_engine", message: "原生引擎沒有可用的執行包（" + (runtime.reason || "未知") + "）" };
    if (!safeName(p.id) || !safeName(p.file)) return { ok: false, code: "bad_request", message: "模型 id 或檔名不合法" };
    return null;
  }
  function onnxInstalled(p) {
    const f = pathM.join(modelsDir, p.id, p.file);
    try { const st = fsSync.statSync(f), ok = JSON.parse(fsSync.readFileSync(f + ".ok", "utf8")); return st.size === Number(p.bytes) && ok.bytes === st.size && (!p.sha256 || ok.sha256 === p.sha256) ? f : ""; } catch (_) { return ""; }
  }
  async function handleOnnx(op, p) {
    const bad = (op === "onnx_release" || op === "onnx_run") ? (safeName(p.id) ? null : { ok: false, code: "bad_request", message: "模型 id 不合法" }) : onnxState(p);
    if (bad) return bad;
    try {
      if (op === "onnx_status") { const f = onnxInstalled(p); return { ok: true, installed: !!f, path: f || "" }; }
      if (op === "onnx_install") {
        // 渲染程序把 IndexedDB 的分片依序寫到 <信箱>/models-in/<id>/（檔名清單在 parts）；這裡串接、核對大小與 SHA-256、改名到位
        const crypto = require("crypto"), fsp = fsSync.promises, dir = pathM.join(modelsDir, p.id), dst = pathM.join(dir, p.file), tmp = dst + ".partial", src = pathM.join(box, "models-in", p.id);
        if (!Array.isArray(p.parts) || !p.parts.length || !p.parts.every(safeName)) return { ok: false, code: "bad_request", message: "分片清單不合法" };
        await fsp.mkdir(dir, { recursive: true });
        const h = crypto.createHash("sha256"); let total = 0; const wfd = await fsp.open(tmp, "w");
        try { for (const n of p.parts) { const b = await fsp.readFile(pathM.join(src, n)); h.update(b); total += b.length; await wfd.write(b); } } finally { await wfd.close(); }
        const sha = h.digest("hex");
        if (total !== Number(p.bytes) || (p.sha256 && sha !== p.sha256)) { try { fsSync.unlinkSync(tmp); } catch (_) { /* */ } return { ok: false, code: "verify_failed", message: "模型檔核對失敗：大小 " + total + " / " + p.bytes + "，SHA-256 " + sha.slice(0, 12) + "…" }; }
        try { fsSync.rmSync(dst, { force: true }); } catch (_) { /* */ }
        fsSync.renameSync(tmp, dst); fsSync.writeFileSync(dst + ".ok", JSON.stringify({ bytes: total, sha256: sha, at: Date.now() }));
        try { fsSync.rmSync(src, { recursive: true, force: true }); } catch (_) { /* 分片刪不掉不影響結果 */ }
        return { ok: true, path: dst };
      }
      if (op === "onnx_load") {
        const f = onnxInstalled(p); if (!f) return { ok: false, code: "no_model", message: "原生模型檔還沒安裝或核對不符：" + p.id + "/" + p.file };
        let host = nrtHosts.get(p.id);
        if (!host) { host = NRT.createTensorHost({ execPath: process.execPath, ortDir: ortDirOf(), log: (s) => console.log("[main-ext] " + s) }); nrtHosts.set(p.id, host); }
        const r = await host.load({ model_path: f, threads: p.threads || 4, graph_opt: p.graph_opt || "all" });
        return { ok: true, input_names: r.input_names, output_names: r.output_names, ms: r.ms };
      }
      if (op === "onnx_run") {
        const host = nrtHosts.get(p.id); if (!host) return { ok: false, code: "internal", message: "這個模型還沒載入" };
        // 輸入兩種：file（渲染程序已寫好的檔，檔名在 p.dir 底下）或 b64（小張量直接放在請求裡，省掉一次寫檔與一次行程間通訊）；p.inline_out 為真且輸出不大時，輸出也直接放在回應裡（b64）
        const okIn = (i) => i && typeof i.name === "string" && NRT.DTYPE_BYTES[i.dtype] && Array.isArray(i.dims) && (typeof i.b64 === "string" || safeName(i.file));
        if (!Array.isArray(p.inputs) || !p.inputs.every(okIn) || (p.dir !== undefined && !safeName(p.dir))) return { ok: false, code: "bad_request", message: "張量清單不合法" };
        let keep = false; // 回應用檔案交付（沒有 inline_out 或輸出太大）時，資料夾留給渲染程序讀完再刪
        const tdir = p.dir ? pathM.join(box, p.dir) : pathM.join(box, "t-m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
        try {
          fsSync.mkdirSync(tdir, { recursive: true });
          const ins = p.inputs.map((i, k) => { let fp; if (typeof i.b64 === "string") { fp = pathM.join(tdir, "in-" + k + ".bin"); fsSync.writeFileSync(fp, Buffer.from(i.b64, "base64")); } else fp = pathM.join(tdir, i.file); return { name: i.name, dtype: i.dtype, dims: i.dims, path: fp }; });
          let kv; // 快取模式（見 NRT 子程序）：名稱只收安全字元、數字只收有限整數
          if (p.kv) { const k = p.kv, okN = (a) => Array.isArray(a) && a.length > 0 && a.length <= 256 && a.every((s) => safeName(s)), okI = (v) => Number.isInteger(v) && v >= 0 && v <= 1e7; if (!okN(k.past) || !okN(k.neu) || k.past.length !== k.neu.length || !okI(k.h) || !okI(k.d) || !okI(k.pos) || !okI(k.rows) || !k.h || !k.d) return { ok: false, code: "bad_request", message: "快取參數不合法" }; kv = { past: k.past, neu: k.neu, h: k.h, d: k.d, pos: k.pos, rows: k.rows, reset: !!k.reset }; }
          const r = await host.run({ inputs: ins, out_dir: tdir, kv, timeoutMs: p.timeout_ms || 120000 });
          const total = r.outputs.reduce((a2, o) => a2 + o.bytes, 0);
          if (p.inline_out && total <= 8 * 1048576) return { ok: true, ms: r.ms, outputs: r.outputs.map((o) => ({ name: o.name, dtype: o.dtype, dims: o.dims, bytes: o.bytes, b64: fsSync.readFileSync(o.path).toString("base64") })) };
          keep = true; return { ok: true, ms: r.ms, outputs: r.outputs.map((o) => ({ name: o.name, dtype: o.dtype, dims: o.dims, file: pathM.basename(o.path), bytes: o.bytes })), dir: pathM.basename(tdir) };
        } finally { if (!keep) { try { fsSync.rmSync(tdir, { recursive: true, force: true }); } catch (_) { /* 暫存資料夾刪不掉不影響結果 */ } } }
      }
      if (op === "onnx_release") { const host = nrtHosts.get(p.id); if (host) { host.dispose(); nrtHosts.delete(p.id); } return { ok: true }; }
      return { ok: false, code: "bad_op", message: "未知的操作：" + op };
    } catch (e) { return { ok: false, code: (e && e.code) || "internal", message: String((e && e.message) || e), backend: "native" }; }
  }
  async function handle(op, payload, id) {
    const p = payload || {};
    if (op === "status") return { ok: true, status: host ? host.status() : idleStatus, engine: runtime.ok && modelPath ? "native" : "none", box, runtime: { ok: runtime.ok, version: runtime.version || null, reason: runtime.ok ? "" : runtime.reason, protocolOk, modelReady: !!(runtime.ok && modelPath && tokenizerPath) } };
    if (op === "reenable") { if (host) host.reenable(); return { ok: true, status: host ? host.status() : idleStatus }; }
    if (op === "dispose") { if (host) host.dispose("介面要求"); return { ok: true, status: host ? host.status() : idleStatus }; }
    if (op === "install") {
      // 按需安裝（只有使用者在介面按下安裝時才會送來）。來源 1：npm 官方庫；來源 2：GitHub 分支（釘住 commit SHA）。見 nr-runtime-install.js。
      if (installing) return { ok: false, code: "busy", message: "執行包安裝已經在進行中" };
      installing = true;
      writeProg({ state: "running", stage: "start", source: "", detail: "開始安裝" });
      try {
        const inst = NRI;
        const manifest = NATIVE_RUNTIME_MANIFEST; // 清單直接放在本檔（舊安裝沒有外部資料檔，熱更新也送不到）
        const testNpm = process.env.FA_NATIVE_INSTALL_NPM_FILE || "", testGh = process.env.FA_NATIVE_INSTALL_GH_DIR || "";
        const testing = !!(testNpm || testGh);
        const r = await inst.installRuntime({
          manifest, platformKey: process.platform + "-" + process.arch,
          runtimeDir: nativeRuntimeDir(userData),
          // 測試用覆寫（只給驗證腳本用）：FA_NATIVE_INSTALL_NPM_URL、FA_NATIVE_INSTALL_GH_BASE 可換成別的網址（例如故意不可達的網址）
          npmLocation: testNpm || process.env.FA_NATIVE_INSTALL_NPM_URL || NATIVE_NPM_TARBALL,
          githubBase: testGh || process.env.FA_NATIVE_INSTALL_GH_BASE || NATIVE_GITHUB_BASE,
          fetchBytes: testing ? inst.localFetchBytes : inst.httpsFetchBytes,
          forceGithub: !!(payload && payload.forceGithub),
          stats: {},
          nrSourceDir: __dirname,
          timeoutMs: 120000,
          log: (s) => console.log("[main-ext] " + s),
          progress: (o) => writeProg(Object.assign({ state: "running" }, o)),
        });
        if (!r.ok) {
          writeProg({ state: "failed", stage: "failed", source: "", detail: r.why });
          return { ok: false, code: "install_failed", message: r.why, sourcesUsed: r.sourcesUsed || {} };
        }
        runtime = checkNativeRuntimeDir(nativeRuntimeDir(userData));
        if (host) { try { host.dispose("安裝完成，重新載入"); } catch (_) { /* */ } host = null; }
        const counts = {}; for (const k of Object.keys(r.sourcesUsed)) counts[r.sourcesUsed[k]] = (counts[r.sourcesUsed[k]] || 0) + 1;
        writeProg({ state: "done", stage: "done", source: r.npmUsed ? "npm" : "github", detail: "安裝完成" });
        return { ok: runtime.ok, runtime: { ok: runtime.ok, version: runtime.version || null, reason: runtime.ok ? "" : runtime.reason }, npmUsed: r.npmUsed, sourceCounts: counts, npmBytes: r.npmBytes || 0, githubBytes: r.githubBytes || 0, runtimeDir: r.runtimeDir };
      } catch (e) {
        writeProg({ state: "failed", stage: "failed", source: "", detail: String((e && e.message) || e) });
        return { ok: false, code: "install_failed", message: String((e && e.message) || e) };
      } finally { installing = false; }
    }
    if (op === "remove") {
      // 移除執行包：先關掉子程序，再刪除 userData/native-runtime/<版本>/。不會動安裝目錄。
      if (installing) return { ok: false, code: "busy", message: "安裝中，不能移除" };
      if (host) { try { host.dispose("移除執行包"); } catch (_) { /* */ } host = null; } for (const h of nrtHosts.values()) { try { h.dispose(); } catch (_) { /* */ } } nrtHosts.clear();
      try { fsSync.rmSync(nativeRuntimeDir(userData), { recursive: true, force: true }); } catch (e) { return { ok: false, code: "remove_failed", message: String((e && e.message) || e) }; }
      runtime = checkNativeRuntimeDir(nativeRuntimeDir(userData));
      return { ok: true, runtime: { ok: runtime.ok, version: null, reason: runtime.reason || "" } };
    }
    if (op.indexOf("onnx_") === 0) return handleOnnx(op, p);
    if (op === "run") {
      if (!runtime.ok) return { ok: false, code: "no_engine", message: "原生引擎沒有可用的執行包（" + runtime.reason + "）" };
      if (!modelPath || !tokenizerPath) return { ok: false, code: "no_model", message: "原生引擎沒有模型檔路徑（環境變數 FA_NATIVE_MODEL_PATH／FA_NATIVE_TOKENIZER_PATH 未設定）" };
      const job = runQueue.then(() => doRun(id, p));
      runQueue = job.catch(() => {});
      return job;
    }
    return { ok: false, code: "bad_op", message: "未知的操作：" + String(op) };
  }
  // 每 200 毫秒取一批請求。生成很慢，所以不等待：每個請求各自完成後寫回應，status 之類的請求不會被生成擋住。
  const timer = setInterval(() => {
    let names = [];
    try { names = fsSync.readdirSync(box).filter((n) => /^req-.+\.json$/.test(n)); } catch (_) { names = []; }
    for (const n of names) {
      const id = n.slice(4, -5), reqPath = pathM.join(box, n);
      let req = null;
      try { req = JSON.parse(fsSync.readFileSync(reqPath, "utf8")); } catch (_) { req = null; }
      // 寫到一半的請求檔（大請求不是一次寫完，輪詢又很密）：解析失敗且檔案還很新就先留著，下一輪再讀；超過 10 秒還是壞的才丟掉
      if (!req) { let age = 1e9; try { age = Date.now() - fsSync.statSync(reqPath).mtimeMs; } catch (_) { /* 已被移除 */ } if (age < 10000) continue; }
      try { fsSync.unlinkSync(reqPath); } catch (_) { /* 已移除 */ }
      if (!req) continue;
      Promise.resolve().then(() => handle(String(req.op || ""), req.payload, id))
        .catch((e) => ({ ok: false, code: "internal", message: String((e && e.message) || e) }))
        .then((resp) => {
          try {
            const tmp = pathM.join(box, "resp-" + id + ".tmp"), out = pathM.join(box, "resp-" + id + ".json");
            fsSync.writeFileSync(tmp, JSON.stringify(resp));
            fsSync.renameSync(tmp, out);
          } catch (_) { /* 寫回失敗：渲染程序會逾時重試 */ }
        });
    }
  }, 10); // 每 10 毫秒看一次信箱：張量呼叫（每窗一次）靠它降低延遲；資料夾很小，讀一次幾乎沒成本
  if (timer.unref) timer.unref();
  // 就緒訊號：輪詢已經開始，渲染程序看到 ready.json 才送請求（避免第一次請求等到超時）
  try { fsSync.writeFileSync(pathM.join(box, "ready.json"), JSON.stringify({ at: Date.now(), pid: process.pid, v: 1 })); } catch (_) { /* 寫不了就由渲染程序超時重試 */ }
  return { ok: true, box };
}

module.exports = { register, _NRI: NRI, _NRT: NRT };
