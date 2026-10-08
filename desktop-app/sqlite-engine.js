// SQLite 引擎（主行程）：用 Electron 內建的 node:sqlite（SQLite 3.53，含 FTS5）直接開磁碟上的真實檔案。
//
// 為什麼放在主行程＋工作執行緒：
//   - 檔案在磁碟上、由 SQLite 自己管理分頁快取，所以資料庫多大都不吃頁面記憶體（專案索引爆記憶體的根本解法）。
//   - node:sqlite 是同步 API，長查詢會卡住執行緒；所以每個資料庫連線一個 worker_thread，主行程只轉送訊息；
//     查詢逾時／使用者按取消 → 直接終止那個 worker（交易會被 SQLite 自動回滾，檔案不會壞），下一次呼叫自動重開。
//   - 渲染行程沒有 Node，只能透過 preload 的 sql.call(op, args)（見 fa:sql:call）。
// 取消：node:sqlite 是同步的原生呼叫，worker_thread 的 terminate() 中止不了正在跑的查詢，所以每個連線用一個子行程（ELECTRON_RUN_AS_NODE），取消＝砍行程；SQLite 下次開啟時自動回滾未提交的交易。
// 協定與網頁版的 FaSql 用戶端一致：參數與結果都是可序列化的 JSON，BLOB＝{"$blob":base64}，超過 2^53 的整數＝{"$int":"…"}。
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");

/* SPLIT-SRC-BEGIN */
const SPLIT_SRC = "/* SQL 語句切分與完整性判斷（純函式，UMD）。\n * sqlite3 命令列用 sqlite3_complete() 判斷一段輸入「語句結束了沒」、並把一長串 SQL 切成一句一句送進引擎；\n * node:sqlite／sql.js 沒有這個函式，所以自己寫：分號只在「字串、引號識別字、註解、CREATE TRIGGER 的 BEGIN…END」之外才算語句結尾。 */\n(function (root, factory) {\n    if (typeof module === 'object' && module.exports) module.exports = factory();\n    else root.FaSqlSplit = factory();\n})(typeof self !== 'undefined' ? self : this, function () {\n    'use strict';\n    // 掃描器：回傳 { stmts:[{sql, start, end}], rest, complete }；rest＝最後沒有以分號結尾的殘餘文字\n    function scan(text) {\n        text = String(text); const stmts = []; let start = 0, i = 0; const n = text.length;\n        let depth = 0;         // CREATE TRIGGER ... BEGIN ... END; 裡的分號不算結尾\n        let caseDepth = 0;     // CASE ... END 的 END 不是觸發器的 END\n        let inTrigger = false, seenBeginInTrigger = false, firstWord = '', secondWord = '', words = 0, lastWord = '';\n        const flush = (endIdx) => { const sql = text.slice(start, endIdx); if (sql.trim() && !/^(\\s|--[^\\n]*\\n?|\\/\\*[\\s\\S]*?\\*\\/)*$/.test(sql)) stmts.push({ sql, start, end: endIdx }); start = endIdx; firstWord = secondWord = lastWord = ''; words = 0; inTrigger = false; seenBeginInTrigger = false; depth = 0; caseDepth = 0; };\n        while (i < n) {\n            const c = text[i];\n            if (c === \"'\" || c === '\"' || c === '`') { const q = c; i++; while (i < n) { if (text[i] === q) { if (text[i + 1] === q) { i += 2; continue; } break; } i++; } if (i >= n) return { stmts, rest: text.slice(start), complete: false, open: 'quote' }; i++; lastWord = ''; continue; }\n            if (c === '[') { const j = text.indexOf(']', i + 1); if (j < 0) return { stmts, rest: text.slice(start), complete: false, open: 'bracket' }; i = j + 1; lastWord = ''; continue; }\n            if (c === '-' && text[i + 1] === '-') { const j = text.indexOf('\\n', i); i = j < 0 ? n : j + 1; continue; }\n            if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); if (j < 0) return { stmts, rest: text.slice(start), complete: false, open: 'comment' }; i = j + 2; continue; }\n            if (/[A-Za-z_]/.test(c)) {\n                let j = i + 1; while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++; const w = text.slice(i, j).toUpperCase(); words++;\n                if (words === 1) firstWord = w; else if (words === 2) secondWord = w;\n                // CREATE [TEMP|TEMPORARY] TRIGGER：看前三個字\n                if (words <= 3 && firstWord === 'CREATE' && (w === 'TRIGGER')) inTrigger = true;\n                if (inTrigger) { if (w === 'BEGIN') { seenBeginInTrigger = true; depth = 1; } else if (seenBeginInTrigger) { if (w === 'CASE') caseDepth++; else if (w === 'END') { if (caseDepth > 0) caseDepth--; else depth = 0; } } }\n                lastWord = w; i = j; continue;\n            }\n            if (c === ';') {\n                if (inTrigger && seenBeginInTrigger && depth > 0) { i++; continue; }\n                i++; flush(i); continue;\n            }\n            i++;\n        }\n        const rest = text.slice(start); const trimmed = rest.replace(/(\\s|--[^\\n]*(\\n|$)|\\/\\*[\\s\\S]*?\\*\\/)+/g, '');\n        return { stmts, rest, complete: trimmed === '' && !(inTrigger && seenBeginInTrigger && depth > 0), open: inTrigger && seenBeginInTrigger && depth > 0 ? 'trigger' : null };\n    }\n    const split = (text) => { const r = scan(text); const out = r.stmts.map((s) => s.sql.trim()); if (r.rest.trim() && !/^(\\s|--[^\\n]*(\\n|$)|\\/\\*[\\s\\S]*?\\*\\/)*$/.test(r.rest)) out.push(r.rest.trim()); return out; };\n    // 沒有「還在等下文」的東西：每句都以分號收尾（空白與註解不算），而且不在字串／觸發器中間（空白或只有註解也算完整＝沒東西要送）\n    const isComplete = (text) => scan(text).complete;\n    return { scan, split, isComplete };\n});\n";
/* SPLIT-SRC-END */

// ---------- 工作執行緒的程式（以字串方式啟動，不依賴檔案路徑，所以 asar 與 live-patch 都沒問題）----------
function workerMain() {
  const parentPort = { on: (_e, fn) => process.on("message", fn), postMessage: (m) => process.send(m) };
  const { DatabaseSync } = require("node:sqlite");
  const fs = require("fs");
  const SPLIT = (function () { const module = { exports: {} }; (function (module, self) { eval(process.env.FA_SPLIT_SRC_PLACEHOLDER); }).call(null, module, undefined); return module.exports; })();
  let db = null, meta = null;
  const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  let typedMode = false;
  const enc = (v) => {
    if (v === null || v === undefined) return null;
    // 保留型別模式：讀 BigInt 模式下，整數是 BigInt、實數是 number；整數值的實數（1.0）與 inf 用 {$real} 才分得出來
    if (typedMode && typeof v === "number") return (Number.isInteger(v) || !Number.isFinite(v)) ? { $real: Number.isFinite(v) ? v.toFixed(1) : (v > 0 ? "Inf" : "-Inf") } : v;
    if (typeof v === "bigint") return (v <= SAFE && v >= -SAFE) ? Number(v) : { $int: v.toString() };
    if (v instanceof Uint8Array) return { $blob: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
    return v;
  };
  const dec = (v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) { if (typeof v.$blob === "string") return Buffer.from(v.$blob, "base64"); if (typeof v.$int === "string") return BigInt(v.$int); }
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  };
  const decBind = (b) => (b == null ? [] : Array.isArray(b) ? b.map(dec) : Object.fromEntries(Object.entries(b).map(([k, v]) => [k, dec(v)])));
  const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
  const need = () => { if (!db) throw new Error("資料庫沒有開啟"); return db; };
  const readOnlyStmt = (sql) => /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(select|with|explain|pragma\s+(?!.*=)|values)\b/i.test(sql);
  function runOne(sql, bind, limit, offset, maxCell) {
    const t0 = Date.now(); const st = need().prepare(sql); st.setReadBigInts(true);
    let cols = []; try { cols = st.columns().map((c) => c.name); } catch (_) { cols = []; }
    const bd = decBind(bind); const arrBind = Array.isArray(bd) ? bd : [bd];
    if (cols.length) {
      const rows = []; let truncated = false, skipped = 0, total = 0;
      for (const r of st.iterate(...arrBind)) {
        total++; if (skipped < offset) { skipped++; continue; }
        if (rows.length >= limit) { truncated = true; break; }
        const arr = cols.map((c) => { const v = enc(r[c]); return (maxCell && typeof v === "string" && v.length > maxCell) ? v.slice(0, maxCell) + "…" : v; }); rows.push(arr);
      }
      return { columns: cols, rows, truncated, ms: Date.now() - t0 };
    }
    const info = st.run(...arrBind);
    return { columns: [], rows: [], changes: Number(info.changes), last_id: enc(info.lastInsertRowid), ms: Date.now() - t0 };
  }
  const ops = {
    open({ path: p, readonly, create, memory }) {
      if (db) { try { db.close(); } catch (_) { /* 已關 */ } db = null; }
      if (memory) { db = new DatabaseSync(":memory:"); meta = { path: ":memory:", readonly: false }; }
      else {
        if (!create && !fs.existsSync(p)) throw new Error("找不到資料庫檔案：" + p);
        db = new DatabaseSync(p, { readOnly: !!readonly, open: true }); meta = { path: p, readonly: !!readonly };
      }
      db.exec("PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;"); if (!readonly) { try { db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;"); } catch (_) { /* 唯讀媒體 */ } }
      db.exec("PRAGMA cache_size=-65536;"); if (readonly) db.exec("PRAGMA query_only=ON;");
      const size = meta.path !== ":memory:" ? fs.statSync(p).size : 0; const ver = db.prepare("select sqlite_version() v").get().v;
      return { size, version: ver, path: meta.path, readonly: meta.readonly };
    },
    exec({ sql, bind, limit = 1000, offset = 0, maxCell = 0, typed = false }) {
      typedMode = !!typed; const stmts = SPLIT.split(sql); const results = [];
      for (let i = 0; i < stmts.length; i++) {
        try { results.push(runOne(stmts[i], i === 0 && stmts.length === 1 ? bind : (i === 0 ? bind : undefined), limit, offset, maxCell)); }
        catch (e) { results.push({ columns: [], rows: [], error: String(e && e.message || e), code: e && e.errcode, sql: stmts[i].slice(0, 200) }); break; }
      }
      return { results };
    },
    query({ table, columns, filters, sort, offset = 0, limit = 100, count }) {
      typedMode = false;
      const cols = columns && columns.length ? columns.map(q).join(", ") : "*"; const where = []; const bind = [];
      for (const f of filters || []) {
        const c = q(f.col);
        switch (f.op) {
          case "like": where.push(`${c} LIKE ? ESCAPE '\\'`); bind.push("%" + String(f.value).replace(/[\\%_]/g, "\\$&") + "%"); break;
          case "eq": where.push(`${c} = ?`); bind.push(f.value); break; case "ne": where.push(`${c} <> ?`); bind.push(f.value); break;
          case "gt": where.push(`${c} > ?`); bind.push(f.value); break; case "ge": where.push(`${c} >= ?`); bind.push(f.value); break;
          case "lt": where.push(`${c} < ?`); bind.push(f.value); break; case "le": where.push(`${c} <= ?`); bind.push(f.value); break;
          case "between": where.push(`${c} BETWEEN ? AND ?`); bind.push(f.value, f.value2); break;
          case "glob": where.push(`${c} GLOB ?`); bind.push(f.value); break;
          case "null": where.push(`${c} IS NULL`); break; case "notnull": where.push(`${c} IS NOT NULL`); break;
          default: throw new Error("不認得的過濾運算：" + f.op);
        }
      }
      const w = where.length ? " WHERE " + where.join(" AND ") : ""; const order = sort && sort.length ? " ORDER BY " + sort.map((s) => q(s.col) + (s.desc ? " DESC" : " ASC")).join(", ") : "";
      const hasRowid = (() => { try { need().prepare(`select rowid from ${q(table)} limit 0`); return true; } catch (_) { return false; } })();
      const sel = hasRowid ? `rowid AS "__rowid__", ${cols}` : cols;
      const r = runOne(`SELECT ${sel} FROM ${q(table)}${w}${order} LIMIT ${Number(limit) | 0} OFFSET ${Number(offset) | 0}`, bind, Number(limit) | 0, 0, 2000);
      let total; if (count !== false) { try { total = Number(need().prepare(`SELECT count(*) c FROM ${q(table)}${w}`).get(...bind.map(dec)).c); } catch (_) { total = null; } }
      return { columns: r.columns, rows: r.rows, total, hasRowid };
    },
    schema() {
      const d = need(); const rows = d.prepare("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%' order by type, name").all();
      const out = { tables: [], views: [], indices: [], triggers: [] };
      for (const r of rows) {
        if (r.type === "table") {
          const cols = d.prepare(`PRAGMA table_xinfo(${q(r.name)})`).all().map((c) => ({ cid: Number(c.cid), name: c.name, type: c.type, notnull: !!c.notnull, dflt: c.dflt_value, pk: Number(c.pk), hidden: Number(c.hidden) }));
          let count = null; if (!/^CREATE VIRTUAL TABLE/i.test(r.sql || "")) { try { count = Number(d.prepare(`select count(*) c from ${q(r.name)}`).get().c); } catch (_) { count = null; } }
          out.tables.push({ name: r.name, sql: r.sql, columns: cols, rows: count, virtual: /^CREATE VIRTUAL TABLE/i.test(r.sql || "") });
        } else if (r.type === "view") out.views.push({ name: r.name, sql: r.sql });
        else if (r.type === "index") out.indices.push({ name: r.name, table: r.tbl_name, sql: r.sql });
        else if (r.type === "trigger") out.triggers.push({ name: r.name, table: r.tbl_name, sql: r.sql });
      }
      return out;
    },
    pragma({ name, value }) {
      if (!/^[a-z_]+$/i.test(name)) throw new Error("PRAGMA 名稱不合法");
      if (/^(load_extension|writable_schema)$/i.test(name)) throw new Error("不允許的 PRAGMA：" + name);
      const sql = value === undefined ? `PRAGMA ${name}` : `PRAGMA ${name}=${typeof value === "number" ? value : "'" + String(value).replace(/'/g, "''") + "'"}`;
      return runOne(sql, undefined, 1000, 0, 0);
    },
    checkpoint() { try { need().exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (_) { /* 非 WAL */ } return { ok: true }; },
    status() { const d = need(); const pc = Number(d.prepare("PRAGMA page_count").get().page_count), ps = Number(d.prepare("PRAGMA page_size").get().page_size); return { pages: pc, pageSize: ps, bytes: pc * ps, path: meta.path, readonly: meta.readonly, inTransaction: d.isTransaction === true }; },
    close() { if (db) { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (_) { /* 非 WAL */ } db.close(); db = null; } return { ok: true }; },
  };
  parentPort.on("message", ({ id, op, args }) => {
    try { if (!ops[op]) throw new Error("不認得的操作：" + op); parentPort.postMessage({ id, ok: true, result: ops[op](args || {}) }); }
    catch (e) { parentPort.postMessage({ id, ok: false, error: String(e && e.message || e), code: e && e.errcode }); }
  });
  parentPort.postMessage({ ready: true });
}

// ---------- 主行程：連線管理 ----------
class SqliteEngine {
  constructor(opts) { this.conns = new Map(); this.seq = 0; this.timeoutMs = (opts && opts.timeoutMs) || 120000; this.resolvePath = (opts && opts.resolvePath) || ((p) => path.resolve(p)); }
  _spawn() {
    if (!SqliteEngine._script) {
      const body = "(" + workerMain.toString().replace("eval(process.env.FA_SPLIT_SRC_PLACEHOLDER)", "eval(" + JSON.stringify(SPLIT_SRC) + ")") + ")();\n";
      const f = path.join(os.tmpdir(), "fa-sql-worker-" + crypto.createHash("md5").update(body).digest("hex").slice(0, 12) + ".js");
      if (!fs.existsSync(f)) fs.writeFileSync(f, body); SqliteEngine._script = f;
    }
    const child = spawn(process.execPath, [SqliteEngine._script], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }), stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true });
    return { postMessage: (m) => { if (child.connected) child.send(m); }, on: (ev, fn) => child.on(ev === "message" ? "message" : ev, fn), terminate: () => { try { child.kill("SIGKILL"); } catch (_) { /* 已結束 */ } }, child };
  }
  _conn(db) { const c = this.conns.get(db); if (!c) throw new Error("資料庫連線不存在或已關閉：" + db); return c; }
  _send(c, op, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!c.worker) { c.worker = this._spawn(); c.pending = new Map(); this._wire(c); }
      const id = ++c.rid; let timer = null;
      const done = (fn, v) => { if (timer) clearTimeout(timer); c.pending.delete(id); fn(v); };
      c.pending.set(id, { resolve: (v) => done(resolve, v), reject: (e) => done(reject, e) });
      const lim = timeoutMs || this.timeoutMs;
      if (lim > 0) timer = setTimeout(() => { this._kill(c, new Error("查詢逾時（" + Math.round(lim / 1000) + " 秒），已中止；未提交的變更已自動回滾")); }, lim);
      c.worker.postMessage({ id, op, args });
    });
  }
  _wire(c) {
    const w = c.worker; // 事件處理要綁定「這一個」行程：舊行程晚到的 exit 事件不能殺掉重開後的新行程
    c.worker.on("message", (m) => { if (c.worker !== w) return; if (m.ready) return; const p = c.pending.get(m.id); if (!p) return; if (m.ok) p.resolve(m.result); else { const e = new Error(m.error); e.code = m.code; p.reject(e); } });
    w.on("error", (e) => { if (c.worker === w) this._kill(c, e); });
    w.on("exit", () => { if (c.worker === w) this._kill(c, new Error("資料庫工作行程已結束")); });
  }
  _kill(c, err) {
    const w = c.worker; c.worker = null; const pend = c.pending; c.pending = new Map(); c.needsReopen = true;
    if (w) { try { w.terminate(); } catch (_) { /* 已結束 */ } }
    for (const p of pend.values()) p.reject(err);
  }
  async _ensureOpen(c) {
    if (c.worker && !c.needsReopen) return;
    c.needsReopen = false; await this._send(c, "open", { path: c.path, readonly: c.readonly, create: false, memory: c.memory });
  }
  async call(op, args) {
    args = args || {};
    switch (op) {
      case "open": {
        const memory = args.memory === true || args.path === ":memory:"; const p = memory ? ":memory:" : this.resolvePath(args.path);
        if (!memory) { const exists = fs.existsSync(p); if (!exists && args.mode !== "new" && !args.create) throw new Error("找不到資料庫檔案：" + p); if (!exists) fs.mkdirSync(path.dirname(p), { recursive: true }); }
        // 同一個檔案已經開著：寫入者只能有一個
        if (!memory && !args.readonly) for (const [id, c] of this.conns) if (c.path === p && !c.readonly) throw new Error("這個檔案已經被另一個連線以可寫方式開著（" + id + "）；先關閉它，或改用唯讀開啟");
        const db = "db" + (++this.seq); const c = { id: db, path: p, readonly: !!args.readonly, memory, worker: null, pending: new Map(), rid: 0, needsReopen: false };
        this.conns.set(db, c);
        try { const r = await this._send(c, "open", { path: p, readonly: !!args.readonly, create: args.mode === "new" || !!args.create, memory }); return Object.assign({ db }, r); }
        catch (e) { this.conns.delete(db); if (c.worker) { try { c.worker.terminate(); } catch (_) { /* */ } } throw e; }
      }
      case "close": { const c = this._conn(args.db); try { if (c.worker && !c.needsReopen) await this._send(c, "close", {}, 20000); } finally { this.conns.delete(args.db); if (c.worker) { try { c.worker.terminate(); } catch (_) { /* */ } c.worker = null; } } return { ok: true }; }
      case "cancel": { const c = this._conn(args.db); this._kill(c, new Error("已取消")); return { ok: true }; }
      case "stage": { const dir = path.join(os.tmpdir(), "fa-sql-stage"); fs.mkdirSync(dir, { recursive: true }); return { path: path.join(dir, Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + "-" + String(args.name || "db.sqlite3").replace(/[^\w.-]/g, "_")) }; }
      case "list": return { dbs: Array.from(this.conns.values()).map((c) => ({ db: c.id, path: c.path, readonly: c.readonly })) };
      default: {
        const c = this._conn(args.db); await this._ensureOpen(c);
        // 唯讀連線只允許讀取類語句（引擎層 query_only 已擋寫入；這裡提早給清楚的訊息）
        const timeout = args.timeoutMs; const { db, timeoutMs, ...rest } = args; return this._send(c, op, rest, timeout);
      }
    }
  }
  async closeAll() { for (const id of Array.from(this.conns.keys())) { try { await this.call("close", { db: id }); } catch (_) { /* 盡力 */ } } }
}

function register(ipcMain, opts) {
  const eng = new SqliteEngine(opts);
  ipcMain.handle("fa:sql:call", async (_evt, { op, args } = {}) => {
    try { return { ok: true, ...(await eng.call(op, args)) }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e), code: e && e.code }; }
  });
  return eng;
}

module.exports = { SqliteEngine, register, workerMain };
