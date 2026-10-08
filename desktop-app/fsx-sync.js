// 桌面版終端機 /mnt/<label> 的同步檔案後端（主行程）。
//
// 為什麼要同步：終端機的 shell（wasi-sh）把檔案系統當成同步 API，客體是 wasm 堆疊的最底層，沒有東西可以 await。
// 網頁版的 FAP 是 FileSystemDirectoryHandle（只有非同步 API）所以要用 SharedArrayBuffer＋worker 繞；桌面版的 FAP 是授權的真實資料夾，
// 主行程直接用 fs.*Sync 就好，渲染行程用 ipcRenderer.sendSync 呼叫（桌面版的 handle 是走 IPC 的假 handle，也不能丟給 worker）。
// 路徑一律限制在授權資料夾（root）底下；寫入用「寫暫存檔再改名」（原子替換，寫到一半失敗原檔完好），
// 並檢查檔案是不是還是讀進來時的 size:mtime（外部改過就回報衝突、不覆蓋）。
"use strict";
const fs = require("fs");
const path = require("path");

const BLOCK_MAX = 8 * 1024 * 1024;
const err = (code, message) => ({ error: { code, message: String(message || code) } });
const codeOf = (e) => (e && e.code && /^E[A-Z]+$/.test(e.code)) ? e.code : "EIO";
const idOf = (st) => ({ size: st.size, mtime: Math.floor(st.mtimeMs) });

// roots：{ find(rootId) -> { rootPath } | null }（由 main.js 提供，讀授權資料夾清單）
function create(roots) {
  const target = (rootId, rel) => {
    const rec = roots.find(rootId); if (!rec) throw Object.assign(new Error("找不到授權的資料夾（id=" + rootId + "）"), { code: "ENOENT" });
    const base = path.resolve(rec.rootPath); const p = path.resolve(base, "." + path.sep + String(rel || "").replace(/^[/\\]+/, ""));
    if (p !== base && !p.startsWith(base + path.sep)) throw Object.assign(new Error("路徑「" + rel + "」超出授權的資料夾範圍"), { code: "EACCES" });
    return p;
  };
  const ops = {
    stat(r) { const p = target(r.rootId, r.path); let st; try { st = fs.statSync(p); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return { st: null }; throw e; } return { st: st.isDirectory() ? { kind: "directory", size: 0, mtime: Math.floor(st.mtimeMs) } : { kind: "file", ...idOf(st) } }; },
    list(r) { const p = target(r.rootId, r.path); let ents; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return { entries: null }; throw e; } return { entries: ents.filter((d) => d.isFile() || d.isDirectory()).map((d) => ({ name: d.name, kind: d.isDirectory() ? "directory" : "file" })) }; },
    read(r) {
      const p = target(r.rootId, r.path); const fd = fs.openSync(p, "r");
      try { const st = fs.fstatSync(fd); const start = Math.max(0, r.start | 0), end = Math.min(st.size, r.end == null ? st.size : r.end | 0, start + BLOCK_MAX); const n = Math.max(0, end - start); const buf = Buffer.alloc(n); let got = 0; while (got < n) { const k = fs.readSync(fd, buf, got, n - got, start + got); if (!k) break; got += k; } return { ...idOf(st), bytes: new Uint8Array(buf.buffer, buf.byteOffset, got) }; }
      finally { fs.closeSync(fd); }
    },
    writeFile(r) {
      const p = target(r.rootId, r.path); let st = null; try { st = fs.statSync(p); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (st && st.isDirectory()) throw Object.assign(new Error("是資料夾"), { code: "EISDIR" });
      if (!r.force) { if (st) { if (!r.expect || st.size !== r.expect.size || Math.floor(st.mtimeMs) !== r.expect.mtime) return { ok: false, conflict: true, ...idOf(st) }; } else if (r.expect) return { ok: false, conflict: true, size: 0, mtime: 0 }; }
      const bytes = r.bytes ? Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength) : Buffer.alloc(0);
      const tmp = p + ".fa-tmp-" + process.pid + "-" + Date.now().toString(36);
      try { fs.writeFileSync(tmp, bytes); if (st) { try { fs.chmodSync(tmp, st.mode & 0o7777); } catch (_) { /* 權限複製不了就算了 */ } } fs.renameSync(tmp, p); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) { /* */ } throw e; }
      const now = fs.statSync(p); return { ok: true, ...idOf(now) };
    },
    mkdir(r) { fs.mkdirSync(target(r.rootId, r.path)); return { ok: true }; },
    rmdir(r) { fs.rmdirSync(target(r.rootId, r.path)); return { ok: true }; },
    remove(r) { const p = target(r.rootId, r.path); if (fs.statSync(p).isDirectory()) throw Object.assign(new Error("是資料夾"), { code: "EISDIR" }); fs.unlinkSync(p); return { ok: true }; },
  };
  return { handle(req) { try { if (!req || !ops[req.op]) return err("ENOSYS", "不認得的操作 " + (req && req.op)); return ops[req.op](req); } catch (e) { return err(codeOf(e), e && e.message); } }, ops };
}

function register(ipcMain, roots) {
  const h = create(roots);
  ipcMain.on("fa:fsx:sync", (evt, req) => { evt.returnValue = h.handle(req); });
  return h;
}
module.exports = { create, register };
