// main-ext.js —— 可以 live-update 的主行程 IPC 模組（見 main.js 的 LIVE_PATCH_MAIN_FILES）。
// 原本寫在 main.js 裡的 raw filesystem IPC（fa:rawfs:*）搬到這裡；之後新增的 IPC 也寫在這裡。
// main.js 啟動時 require 並呼叫 register(ipcMain, { fs, path })；patch 套用後，下一次啟動就會載入新版（已在記憶體執行的程式碼無法熱抽換）。
// 這個檔案用到的東西都從 ctx 傳進來（fs＝fs/promises、path），不依賴 main.js 的其他函式，所以可以單獨被覆蓋。
"use strict";

function register(ipcMain, ctx) {
  const { fs, path } = ctx;
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

  // ---------- coding_edit／coding_patch_tool（coding-tools.js）與 CI/CD 連線的 HTTP（ci-fetch.js）----------
  // 2026-10-14：模組本身也在 live-update 白名單；註冊放在這裡，之後改 IPC 名稱或參數只要發 patch。
  // main.js 的 ctx 可能比這份 main-ext.js 舊（只有 fs、path）：缺少確認閘或對話框時，會執行任意程式／寫入外部服務的 IPC 一律拒絕，不會在沒有確認的情況下放行。
  const needNew = (what) => ({ ok: false, error: "這個動作需要新版主程式（" + what + "）：請重新安裝最新版。" });
  try { require("./coding-tools.js").register(ipcMain, { execConfirmGate: ctx.execConfirmGate }); }
  catch (e) { console.warn("[main-ext] coding-tools 載入失敗：", e && e.message); }
  try { if (ctx.dialog) require("./ci-fetch.js").register(ipcMain, { net: ctx.net, dialog: ctx.dialog, BrowserWindow: ctx.BrowserWindow }); else ipcMain.handle("fa:ci:fetch", async () => needNew("缺少對話框")); }
  catch (e) { console.warn("[main-ext] ci-fetch 載入失敗：", e && e.message); }

  return { rawFsPath, detectLikelyBinary };
}

module.exports = { register };
