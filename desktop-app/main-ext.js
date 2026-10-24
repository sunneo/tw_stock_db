// main-ext.js —— 可以 live-update 的主行程 IPC 模組（見 main.js 的 LIVE_PATCH_MAIN_FILES）。
// 原本寫在 main.js 裡的 raw filesystem IPC（fa:rawfs:*）搬到這裡；之後新增的 IPC 也寫在這裡。
// main.js 啟動時 require 並呼叫 register(ipcMain, { fs, path })；patch 套用後，下一次啟動就會載入新版（已在記憶體執行的程式碼無法熱抽換）。
// 這個檔案用到的東西都從 ctx 傳進來（fs＝fs/promises、path），不依賴 main.js 的其他函式，所以可以單獨被覆蓋。
"use strict";

function register(ipcMain, ctx) {
  const { fs, path } = ctx;
  const electron = ctx.electron || null;
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

  // computer use（桌面版限定、預設關閉）：IPC、原生核准視窗、中止快捷鍵都在 computer-use-ipc.js；載入失敗不影響其他功能
  try { require("./computer-use-ipc.js").register(ipcMain, ctx); } catch (e) { console.warn("[main-ext] computer use 載入失敗：", e && e.message); }

  // 熱更新的「套用」處理：分檔下載、逐段驗證、接回（長期方案，見 installChunkedUpdater）
  try { installChunkedUpdater(ipcMain, ctx); } catch (e) { console.warn("[main-ext] 分檔下載更新處理載入失敗：", e && e.message); }

  return { rawFsPath, detectLikelyBinary };
}

// 熱更新套用處理的覆寫（長期方案）。
// 為什麼放在這裡：main.js 是入口，只能靠重新安裝更新，但 main-ext.js 在熱更新清單裡、啟動時載入。
// 已安裝的舊版主程式 fa:update:apply 有單檔 8MB 上限、也不認得 manifest 的 parts（分段）；這裡在 app ready 之後
// （main.js 的 handler 這時已經註冊完）把 fa:update:apply 換成：
//   - 沒有大小上限，連上伺服器之後不計時（慢網路也能下載大檔）
//   - 有 parts 的檔案逐段下載（每段最多重試 3 次、各自驗 md5），接回後再驗整個檔案的 md5
//   - 其餘行為跟 main.js 的版本一致（先全部下載驗證完才落地、覆蓋目錄／state.json 格式相同、主行程模組先做語法檢查）
// fa:update:check（只比對 md5）不需要換。manifest.json 的格式見 scripts/make-live-patch.js。
function installChunkedUpdater(ipcMain, ctx) {
  const electron = ctx.electron; if (!electron || !electron.app) return;
  const { fs, path } = ctx; const crypto = require("crypto"); const { app } = electron;
  const BASE = process.env.FA_UPDATE_BASE || "https://raw.githubusercontent.com/sunneo/tw_stock_db/desktop-app-patch"; // FA_UPDATE_BASE：測試時指向本機
  const md5Hex = (b) => crypto.createHash("md5").update(b).digest("hex");
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
    if (!parts || !parts.length) return getBuf(BASE + "/" + rel, { timeoutMs: 30000 });
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
  async function apply() {
    const baselineFile = path.join(mainDir(), "renderer", "update-manifest.json");
    const baseline = (await readJson(baselineFile, null)) || { schema: 1, baseVersion: app.getVersion(), files: {} };
    const baselineVersion = baseline.baseVersion || app.getVersion();
    const stateFile = path.join(patchDir(), "state.json");
    // 目前實際生效的本機 manifest（覆蓋目錄完整可信才採用 state.json）
    let local = { version: baselineVersion, files: { ...baseline.files }, overrideActive: false };
    const state = await readJson(stateFile, null);
    if (state && state.files && typeof state.files === "object" && state.baselineVersion === baselineVersion) {
      let intact = true;
      for (const rel of Object.keys(state.files)) {
        if (!(rel in baseline.files)) continue;
        const actual = await md5Either(path.join(patchDir(), rel));
        if (actual === null && baseline.files[rel] === state.files[rel]) continue;
        if (actual === null || actual.indexOf(state.files[rel]) < 0) { intact = false; break; }
      }
      if (intact) local = { version: state.appliedVersion || baselineVersion, files: { ...baseline.files, ...state.files }, overrideActive: true };
    }
    const remote = JSON.parse((await getBuf(BASE + "/manifest.json", { timeoutMs: 15000 })).toString("utf8"));
    if (!remote || typeof remote.files !== "object") throw new Error("manifest.json格式不正確（缺少files欄位）");
    const toFetch = Object.keys(remote.files).filter((rel) => rel in baseline.files && !rel.includes("..") && remote.files[rel] && typeof remote.files[rel].md5 === "string" && local.files[rel] !== remote.files[rel].md5);
    if (!toFetch.length) return { ok: true, appliedVersion: local.version, changedFiles: [] };
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
    const requiresRestart = toFetch.some((f) => !f.startsWith("renderer/"));
    return { ok: true, appliedVersion: remote.version || local.version, changedFiles: toFetch, requiresRestart };
  }
  app.whenReady().then(() => { // main.js 的 handler 在模組載入時就註冊好了，ready 之後再換
    try { ipcMain.removeHandler("fa:update:apply"); } catch (_) { /* */ }
    ipcMain.handle("fa:update:apply", async () => { try { return await apply(); } catch (err) { return { ok: false, error: String((err && err.message) || err) }; } });
  });
}

module.exports = { register };
