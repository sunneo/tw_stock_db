// Knowledge Inventory 的主行程輔助（fa:knowledge:call）：原生磁碟檔 .keeplookup 的串流搬家與核對。見 DESIGN.knowledge-swap.md。
// 資料庫本身由 sqlite-engine.js 直接開磁碟檔（不是這裡）；這裡只做「不把整個檔案放進記憶體」的檔案操作：
//   info／stat／writeChunk（分段寫到 .part、最後 fsync＋改名）／readChunk／copy（串流複製＋sha256 核對）／hash／remove。
// 安全：只接受副檔名 .keeplookup 的檔案（含 .part 暫存與 -journal／-wal／-shm 旁檔）。
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OK_EXT = /\.keeplookup$/i;
function safePath(p) {
  p = String(p || ""); if (!path.isAbsolute(p)) throw new Error("要給完整路徑：" + p);
  p = path.resolve(p); if (!OK_EXT.test(p)) throw new Error("只能處理副檔名 .keeplookup 的檔案：" + p);
  return p;
}
function sha256File(p) {
  return new Promise((resolve, reject) => { const h = crypto.createHash("sha256"); const s = fs.createReadStream(p); s.on("data", (d) => h.update(d)); s.on("error", reject); s.on("end", () => resolve(h.digest("hex"))); });
}
function fsyncPath(p) { const fd = fs.openSync(p, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

function makeOps(ctx) {
  const dataDir = () => path.join(ctx.userDataDir(), "knowledge");
  return {
    async info() { const dir = dataDir(); fs.mkdirSync(dir, { recursive: true }); let free = null; try { const s = fs.statfsSync(dir); free = Number(s.bavail) * Number(s.bsize); } catch (_) { /* 舊 Node 沒有 statfs */ } return { native: true, dir, freeBytes: free }; },
    async stat({ path: p }) { p = safePath(p); try { const s = fs.statSync(p); return { exists: true, size: s.size }; } catch (_) { return { exists: false, size: 0 }; } },
    // offset=0 重新開始寫；done=true 時 fsync 並原子改名成正式檔名，回傳大小與 sha256
    async writeChunk({ path: p, offset, base64, done }) {
      p = safePath(p); const part = p + ".part"; fs.mkdirSync(path.dirname(p), { recursive: true });
      const buf = base64 ? Buffer.from(base64, "base64") : Buffer.alloc(0);
      const off = Number(offset) || 0; const fd = fs.openSync(part, off === 0 ? "w" : "r+");
      try { if (off !== 0 && fs.fstatSync(fd).size !== off) throw new Error("分段寫入的位置對不上（預期 " + fs.fstatSync(fd).size + "，收到 " + off + "）"); fs.writeSync(fd, buf, 0, buf.length, off); if (done) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (!done) return { ok: true, written: off + buf.length };
      for (const sfx of ["-journal", "-wal", "-shm"]) { try { fs.rmSync(p + sfx, { force: true }); } catch (_) { /* */ } }
      fs.renameSync(part, p); return { ok: true, size: fs.statSync(p).size, sha256: await sha256File(p) };
    },
    async readChunk({ path: p, offset, length }) {
      p = safePath(p); const fd = fs.openSync(p, "r");
      try { const size = fs.fstatSync(fd).size, off = Number(offset) || 0, n = Math.max(0, Math.min(Number(length) || 8388608, size - off)); const buf = Buffer.alloc(n); const got = n ? fs.readSync(fd, buf, 0, n, off) : 0; return { base64: buf.subarray(0, got).toString("base64"), size, eof: off + got >= size }; } finally { fs.closeSync(fd); }
    },
    // 串流複製（不經過渲染行程）：來源 sha256 與寫出的檔案 sha256 一致才改名；dest 已存在且沒給 overwrite 就拒絕
    async copy({ from, to, overwrite }) {
      from = safePath(from); to = safePath(to); if (from === to) throw new Error("來源與目的地相同");
      if (fs.existsSync(to) && !overwrite) throw new Error("目的地已經有檔案：" + to);
      fs.mkdirSync(path.dirname(to), { recursive: true }); const part = to + ".part";
      const h = crypto.createHash("sha256");
      await new Promise((resolve, reject) => { const r = fs.createReadStream(from), w = fs.createWriteStream(part); r.on("data", (d) => h.update(d)); r.on("error", reject); w.on("error", reject); w.on("finish", resolve); r.pipe(w); });
      fsyncPath(part); const want = h.digest("hex"), got = await sha256File(part);
      if (want !== got) { try { fs.rmSync(part, { force: true }); } catch (_) { /* */ } throw new Error("複製後核對 sha256 不一致"); }
      for (const sfx of ["-journal", "-wal", "-shm"]) { try { fs.rmSync(to + sfx, { force: true }); } catch (_) { /* */ } }
      fs.renameSync(part, to); return { ok: true, size: fs.statSync(to).size, sha256: got };
    },
    async hash({ path: p }) { p = safePath(p); return { sha256: await sha256File(p), size: fs.statSync(p).size }; },
    async remove({ path: p }) { p = safePath(p); for (const sfx of ["", ".part", "-journal", "-wal", "-shm"]) { try { fs.rmSync(p + sfx, { force: true }); } catch (_) { /* */ } } return { ok: true }; },
  };
}

function register(ipcMain, ctx) {
  const ops = makeOps(ctx);
  ipcMain.handle("fa:knowledge:call", async (_evt, { op, args } = {}) => {
    try { if (!ops[op]) throw new Error("不認得的操作：" + op); return Object.assign({ ok: true }, await ops[op](args || {})); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { register, makeOps, sha256File };
