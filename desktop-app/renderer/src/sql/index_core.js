/* 專案索引的 SQLite 層（UMD，與環境無關）：建表、分批寫入、完成階段、讀取。
 * 設計（見 DESIGN.project-index.md／DESIGN.sqlite-fap.md）：索引本身就是專案資料夾裡的 SQLite 檔（.floating-assistant/index/index.sqlite3），
 * 建索引時邊讀邊寫、記憶體只跟批次大小有關；查詢時 SQLite 自己用 PRAGMA cache_size（預設 64 MB）管理分頁快取，所以專案多大都不會爆記憶體。
 * 所有函式都吃一個 exec(sql, bind?) -> Promise<[{columns, rows, changes, error?}]>（引擎協定，列是陣列），不碰 DOM、不碰檔案。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaIdxSql = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // 版本：1＝原本；3（2026-10-29，移植 Redmine AIDoc 的除錯定位器）＝加 logmsgs（每個 log 呼叫的訊息字串）、calls（函式層級呼叫邊）、meta.tree_ref（樹版本）。
    // migration：開啟時讀 meta.schema；舊版索引照常能讀（問答、搜尋），但沒有 logmsgs／calls，定位器會明講「這個索引是舊版，請重新建立索引」；重新建立索引（fresh）時整個重建成新版。
    const SCHEMA_VERSION = 3;
    const DDL = [
        'CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)',
        'CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL, dir TEXT, name TEXT, lang TEXT, lines INTEGER, hash TEXT, doc TEXT, sv INTEGER, nsyms INTEGER DEFAULT 0, refs INTEGER DEFAULT 0, used INTEGER DEFAULT 0, note TEXT)',
        'CREATE TABLE symbols(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT, file_id INTEGER NOT NULL, line INTEGER, doc TEXT, sig TEXT, note TEXT, used_by INTEGER DEFAULT 0)',
        'CREATE TABLE imports(src INTEGER NOT NULL, dst INTEGER, kind TEXT, spec TEXT)',
        'CREATE TABLE uses_raw(file_id INTEGER NOT NULL, name TEXT NOT NULL)',
        'CREATE TABLE uses(file_id INTEGER NOT NULL, symbol_id INTEGER NOT NULL)',
        'CREATE TABLE sym_fts_src(id INTEGER PRIMARY KEY, toks TEXT)', 'CREATE TABLE file_fts_src(id INTEGER PRIMARY KEY, toks TEXT)',
        'CREATE TABLE logmsgs(file_id INTEGER NOT NULL, line INTEGER, fn TEXT, fmt TEXT, key TEXT)', 'CREATE TABLE calls_raw(file_id INTEGER NOT NULL, caller TEXT, cline INTEGER, callee TEXT, line INTEGER)', 'CREATE TABLE calls(file_id INTEGER NOT NULL, caller TEXT, cline INTEGER, callee TEXT, line INTEGER)',
    ];
    const INDEXES = [
        'CREATE INDEX idx_files_dir ON files(dir)', 'CREATE INDEX idx_sym_name ON symbols(name COLLATE NOCASE)', 'CREATE INDEX idx_sym_file ON symbols(file_id)',
        'CREATE INDEX idx_imp_src ON imports(src)', 'CREATE INDEX idx_imp_dst ON imports(dst)', 'CREATE INDEX idx_use_file ON uses(file_id)', 'CREATE INDEX idx_use_sym ON uses(symbol_id)', 'CREATE INDEX idx_sym_used ON symbols(used_by DESC) WHERE used_by > 0',
        'CREATE INDEX idx_log_file ON logmsgs(file_id)', 'CREATE INDEX idx_calls_callee ON calls(callee)',
    ];
    const splitNameDefault = (n) => String(n == null ? '' : n).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.:]+/g, ' ').toLowerCase().trim();
    const baseOf = (p) => { const i = String(p).lastIndexOf('/'); return i < 0 ? String(p) : String(p).slice(i + 1); };
    const dirOf = (p) => { const i = String(p).lastIndexOf('/'); return i < 0 ? '' : String(p).slice(0, i); };
    const MAX_VARS = 30000;

    async function run(exec, sql, bind) { const r = await exec(sql, bind); const bad = r.find((x) => x.error); if (bad) { const e = new Error(bad.error + (bad.sql ? '（' + bad.sql.slice(0, 80) + '）' : '')); throw e; } return r; }
    async function rows(exec, sql, bind) { const r = await run(exec, sql, bind); return (r[0] && r[0].rows) || []; }
    async function one(exec, sql, bind) { const r = await rows(exec, sql, bind); return r[0] ? r[0][0] : null; }
    // 多列 INSERT：依變數上限切批
    async function insertMany(exec, table, cols, data) {
        if (!data.length) return; const per = Math.max(1, Math.floor(MAX_VARS / cols.length)); const ph = '(' + cols.map(() => '?').join(',') + ')';
        for (let i = 0; i < data.length; i += per) { const chunk = data.slice(i, i + per); const bind = []; for (const r of chunk) for (const v of r) bind.push(v); await run(exec, 'INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES ' + chunk.map(() => ph).join(','), bind); }
    }

    // ---- 建庫 ----
    function builder(exec, opts) {
        opts = opts || {}; const splitName = opts.splitName || splitNameDefault; const semTokens = opts.semTokens || ((text) => splitName(text)); const batch = opts.batch || 400; const macroKinds = opts.macroKinds || ['macro'];
        const st = { pathId: new Map(), files: [], syms: [], imps: [], uses: [], fts: [], ftsf: [], logs: [], calls: [], nextFile: 1, nextSym: 1, nFiles: 0, nSyms: 0, nImps: 0, nUses: 0, nLogs: 0, nCalls: 0, started: false };
        async function init(o) {
            o = o || {};
            if (o.fresh !== false) { for (const t of ['sym_fts', 'file_fts', 'meta', 'files', 'symbols', 'imports', 'uses_raw', 'uses', 'sym_fts_src', 'file_fts_src', 'logmsgs', 'calls_raw', 'calls']) await run(exec, 'DROP TABLE IF EXISTS ' + t); }
            for (const d of DDL) await run(exec, d);
            await run(exec, "INSERT INTO meta(k,v) VALUES('schema', ?), ('created', ?)", [String(SCHEMA_VERSION), new Date().toISOString()]);
            await run(exec, 'BEGIN'); st.started = true;
        }
        // 一個檔案的完整記錄（舊地圖的格式）：{lang, lines, hash, doc, imports:[{spec,kind,to}], symbols:[{n,k,l,d,sig}], uses:[名稱], sv}
        function addFile(path, rec) {
            const id = st.nextFile++; st.pathId.set(path, id);
            const syms = rec.symbols || []; st.files.push([id, path, dirOf(path), baseOf(path), rec.lang || '', rec.lines || 0, rec.hash || '', rec.doc || '', rec.sv || 0, syms.length]);
            for (const s of syms) { const sid = st.nextSym++; st.syms.push([sid, s.n, s.k || '', id, s.l || 0, s.d || '', s.sig || '', '']); if (!macroKinds.includes(s.k)) st.fts.push([sid, semTokens(s.n + ' ' + (s.d || '') + ' ' + baseOf(path))]); }
            st.ftsf.push([id, semTokens(path + ' ' + (rec.doc || '') + ' ' + syms.slice(0, 25).map((x) => x.n).join(' '))]);
            for (const e of rec.imports || []) st.imps.push([id, e.to || null, e.kind || '', e.spec || '', e.to || null]);
            for (const n of rec.uses || []) st.uses.push([id, n]);
            // 除錯定位器：log 呼叫的訊息字串 {l,fn,fmt,key}、函式層級呼叫邊 {c,cl,f,l}（FaAidocTrace.extractLogs／extractCalls 的輸出）
            for (const g of rec.logs || []) st.logs.push([id, g.l || 0, g.fn || '', g.fmt || '', g.key || '']);
            for (const c of rec.calls || []) st.calls.push([id, c.c || '', c.cl || 0, c.f || '', c.l || 0]);
            return syms.length;
        }
        const pending = () => st.files.length + st.syms.length + st.imps.length + st.uses.length + st.logs.length + st.calls.length;
        async function flush(force) {
            if (!st.started) throw new Error('builder 還沒 init');
            if (!force && st.files.length < batch && st.syms.length < batch * 20) return;
            const f = st.files, s = st.syms, im = st.imps, u = st.uses, ft = st.fts, ff = st.ftsf, lg = st.logs, cl = st.calls; st.files = []; st.syms = []; st.imps = []; st.uses = []; st.fts = []; st.ftsf = []; st.logs = []; st.calls = [];
            await insertMany(exec, 'files', ['id', 'path', 'dir', 'name', 'lang', 'lines', 'hash', 'doc', 'sv', 'nsyms'], f); await insertMany(exec, 'symbols', ['id', 'name', 'kind', 'file_id', 'line', 'doc', 'sig', 'note'], s);
            // imports 的目標路徑要等所有檔案都有 id 才能解析：先把目標路徑暫存在 spec 之外的欄位（dst 先放 NULL，之後用 path 對應）
            await insertMany(exec, 'imports', ['src', 'dst', 'kind', 'spec'], im.map((r) => [r[0], null, r[2], (r[4] ? '\u0001' + r[4] : r[3])]));
            await insertMany(exec, 'uses_raw', ['file_id', 'name'], u); await insertMany(exec, 'sym_fts_src', ['id', 'toks'], ft); await insertMany(exec, 'file_fts_src', ['id', 'toks'], ff);
            await insertMany(exec, 'logmsgs', ['file_id', 'line', 'fn', 'fmt', 'key'], lg); await insertMany(exec, 'calls_raw', ['file_id', 'caller', 'cline', 'callee', 'line'], cl);
            st.nFiles += f.length; st.nSyms += s.length; st.nImps += im.length; st.nUses += u.length; st.nLogs += lg.length; st.nCalls += cl.length;
            await run(exec, 'COMMIT'); await run(exec, 'BEGIN');
        }
        // 完成階段：解析匯入目標、算計數、呼叫關係、索引、全文表
        async function finalize(o) {
            o = o || {}; const prog = o.onProgress || (() => {}); await flush(true);
            prog('匯入關係'); await run(exec, 'COMMIT'); await run(exec, 'CREATE INDEX idx_files_path ON files(path)'); await run(exec, 'BEGIN');
            await run(exec, "UPDATE imports SET dst = (SELECT f.id FROM files f WHERE f.path = substr(imports.spec, 2)), spec = NULL WHERE spec LIKE char(1) || '%'");
            await run(exec, 'DELETE FROM imports WHERE dst IS NULL');
            await run(exec, 'COMMIT'); await run(exec, 'BEGIN');
            prog('索引（名稱／檔案）');
            await run(exec, 'COMMIT'); for (const ix of INDEXES) { await run(exec, ix); } await run(exec, 'BEGIN');
            prog('計數');
            await run(exec, 'UPDATE files SET refs = (SELECT count(*) FROM imports i WHERE i.src = files.id AND i.dst IS NOT NULL), used = (SELECT count(*) FROM imports i WHERE i.dst = files.id)');
            prog('呼叫關係');
            // 與舊引擎一致：名稱的定義不超過 8 個、而且不在自己的檔案
            await run(exec, 'CREATE TEMP TABLE defc(name TEXT PRIMARY KEY, c INTEGER) WITHOUT ROWID'); await run(exec, 'INSERT INTO defc SELECT name, count(*) FROM symbols GROUP BY name HAVING count(*) <= 8');
            await run(exec, 'INSERT INTO uses(file_id, symbol_id) SELECT DISTINCT r.file_id, s.id FROM uses_raw r JOIN defc d ON d.name = r.name JOIN symbols s ON s.name = r.name AND s.file_id <> r.file_id');
            await run(exec, 'DROP TABLE defc'); await run(exec, 'DROP TABLE uses_raw');
            // 呼叫邊：被呼叫的名稱要有 1–8 個函式／方法定義才留（太常見的名稱沒有資訊量；與 uses 同一套做法）
            await run(exec, "INSERT INTO calls(file_id, caller, cline, callee, line) SELECT r.file_id, r.caller, r.cline, r.callee, r.line FROM calls_raw r WHERE r.callee IN (SELECT name FROM symbols WHERE kind IN ('function','method') GROUP BY name HAVING count(*) BETWEEN 1 AND 8)"); await run(exec, 'DROP TABLE calls_raw');
            await run(exec, 'UPDATE symbols SET used_by = (SELECT count(*) FROM uses u WHERE u.symbol_id = symbols.id) WHERE id IN (SELECT DISTINCT symbol_id FROM uses)');
            await run(exec, 'COMMIT'); await run(exec, 'BEGIN');
            prog('全文索引');
            await run(exec, "CREATE VIRTUAL TABLE sym_fts USING fts5(toks, content='', tokenize='unicode61')");
            await run(exec, 'INSERT INTO sym_fts(rowid, toks) SELECT id, toks FROM sym_fts_src');
            await run(exec, 'DROP TABLE sym_fts_src');
            await run(exec, "CREATE VIRTUAL TABLE file_fts USING fts5(toks, content='', tokenize='unicode61')");
            await run(exec, 'INSERT INTO file_fts(rowid, toks) SELECT id, toks FROM file_fts_src');
            await run(exec, 'DROP TABLE file_fts_src');
            const c = { files: await one(exec, 'select count(*) from files'), symbols: await one(exec, 'select count(*) from symbols'), imports: await one(exec, 'select count(*) from imports'), uses: await one(exec, 'select count(*) from uses'), macros: await one(exec, "select count(*) from symbols where kind='macro'"), logmsgs: await one(exec, 'select count(*) from logmsgs'), calls: await one(exec, 'select count(*) from calls') };
            await run(exec, "INSERT OR REPLACE INTO meta(k,v) VALUES ('counts', ?), ('built', ?), ('complete', ?), ('root', ?)", [JSON.stringify(c), new Date().toISOString(), o.complete === false ? '0' : '1', String(o.root || '')]);
            if (o.treeRef) await run(exec, "INSERT OR REPLACE INTO meta(k,v) VALUES ('tree_ref', ?)", [JSON.stringify(o.treeRef)]);
            await run(exec, 'COMMIT'); st.started = false;
            try { await run(exec, 'ANALYZE'); } catch (_) { /* 不影響結果 */ }
            return c;
        }
        return { init, addFile, flush, finalize, pending, st };
    }

    // ---- 讀取 ----
    const ftsQuery = (toks) => toks.filter(Boolean).map((t) => '"' + String(t).replace(/"/g, '""') + '"').join(' OR ');
    function reader(exec) {
        const R = {
            counts: async () => { const v = await one(exec, "select v from meta where k='counts'"); try { return JSON.parse(v); } catch (_) { return null; } },
            meta: async () => Object.fromEntries(await rows(exec, 'select k, v from meta')),
            fileId: (path) => one(exec, 'select id from files where path = ?', [path]),
            filePaths: async (like, limit) => (await rows(exec, 'select path from files where path like ? order by path limit ?', [like, limit || 100])).map((r) => r[0]),
            // 舊地圖格式的一筆檔案記錄（含定義、匯入、呼叫名稱）
            fileRec: async (path) => {
                const f = (await rows(exec, 'select id, lang, lines, hash, doc, sv from files where path = ?', [path]))[0]; if (!f) return null;
                const symbols = (await rows(exec, 'select name, kind, line, doc, sig from symbols where file_id = ? order by id', [f[0]])).map((r) => ({ n: r[0], k: r[1], l: r[2], d: r[3], sig: r[4] }));
                const imports = (await rows(exec, 'select f.path, i.kind from imports i join files f on f.id = i.dst where i.src = ?', [f[0]])).map((r) => ({ kind: r[1], to: r[0] }));
                return { lang: f[1], lines: f[2], hash: f[3], doc: f[4], sv: f[5], symbols, imports, uses: [] };
            },
            symbolsOf: async (path) => (await rows(exec, 'select s.name, s.kind, s.line, s.doc, s.sig from symbols s join files f on f.id = s.file_id where f.path = ? order by s.id', [path])).map((r) => ({ n: r[0], k: r[1], l: r[2], d: r[3], sig: r[4] })),
            // 名稱（不分大小寫）的定義
            symbolsByName: async (name, limit) => (await rows(exec, 'select s.id, s.name, s.kind, f.path, s.line, s.doc, s.sig, s.used_by from symbols s join files f on f.id = s.file_id where s.name = ? collate nocase order by (s.kind=\'macro\'), s.used_by desc limit ?', [name, limit || 50])).map((r) => ({ id: r[0], name: r[1], kind: r[2], path: r[3], line: r[4], doc: r[5], sig: r[6], used_by: r[7] })),
            macros: async (name, mode, limit) => { const like = mode === 'prefix' ? String(name) + '%' : mode === 'contains' ? '%' + name + '%' : null; const sql = like ? "select s.name, f.path, s.line, s.sig from symbols s join files f on f.id = s.file_id where s.kind='macro' and s.name like ? escape '\\' limit ?" : "select s.name, f.path, s.line, s.sig from symbols s join files f on f.id = s.file_id where s.kind='macro' and s.name = ? collate nocase limit ?"; return (await rows(exec, sql, [like ? like.replace(/[\\_]/g, '\\$&') : name, limit || 50])).map((r) => ({ name: r[0], path: r[1], line: r[2], value: r[3] })); },
            // 全文召回：符號（不含巨集）與檔案
            recallSymbols: async (tokens, limit) => { const q = ftsQuery(tokens); if (!q) return []; return (await rows(exec, 'select rowid from sym_fts where sym_fts match ? order by rank limit ?', [q, limit || 60])).map((r) => r[0]); },
            recallFiles: async (tokens, limit) => { const q = ftsQuery(tokens); if (!q) return []; return (await rows(exec, 'select rowid from file_fts where file_fts match ? order by rank limit ?', [q, limit || 40])).map((r) => r[0]); },
            tree: async (dir) => (await rows(exec, "select name, 'f', lang, lines from files where dir = ? union all select distinct substr(substr(dir, ?), 1, instr(substr(dir, ?) || '/', '/') - 1), 'd', null, null from files where dir like ? and dir <> ? order by 2 desc, 1", [dir, dir ? dir.length + 2 : 1, dir ? dir.length + 2 : 1, dir ? dir + '/%' : '%', dir])).map((r) => ({ name: r[0], type: r[1], lang: r[2], lines: r[3] })),
            // ---- 除錯定位器（schema 3）：舊版索引沒有這兩張表 → available:false，由呼叫端明講「請重新建立索引」，不是回報找不到 ----
            schemaVersion: async () => Number(await one(exec, "select v from meta where k='schema'")) || 1,
            hasTable: async (t) => !!(await one(exec, 'select 1 from sqlite_master where name = ?', [t])),
            treeRef: async () => { const v = await one(exec, "select v from meta where k='tree_ref'"); try { const t = v ? JSON.parse(v) : null; return t && typeof t === 'object' ? t : null; } catch (_) { return null; } },
            filesByName: async (name, limit) => (await rows(exec, 'select path from files where name = ? collate nocase order by path limit ?', [String(name || ''), limit || 20])).map((r) => r[0]),
            logCandidates: async (msg, limit) => {
                if (!(await R.hasTable('logmsgs'))) return { available: false, rows: [] };
                const total = await one(exec, 'select count(*) from logmsgs');
                const r = await rows(exec, 'select f.path, l.line, l.fn, l.fmt from logmsgs l join files f on f.id = l.file_id where instr(?, l.key) > 0 order by length(l.key) desc limit ?', [String(msg || '').toLowerCase(), limit || 600]);
                return { available: true, total, rows: r.map((x) => ({ path: x[0], line: x[1], fn: x[2], fmt: x[3] })) };
            },
            callers: async (name, limit) => {
                if (!(await R.hasTable('calls'))) return { available: false, rows: [] };
                const r = await rows(exec, 'select f.path, c.caller, c.cline, c.line from calls c join files f on f.id = c.file_id where c.callee = ? order by f.path, c.line limit ?', [String(name || ''), limit || 40]);
                return { available: true, rows: r.map((x) => ({ path: x[0], caller: x[1], cline: x[2], line: x[3] })) };
            },
            top: async (n) => (await rows(exec, 'select path, lang, lines, refs, used, nsyms from files order by used desc, nsyms desc limit ?', [n || 20])).map((r) => ({ path: r[0], lang: r[1], lines: r[2], refs: r[3], used: r[4], nsyms: r[5] })),
        };
        return R;
    }
    // ---- 說明庫 notes.sqlite3（DESIGN.project-index.md §17.2）----
    // 跟索引庫（index.sqlite3，重建時整檔取代）分開：這個檔案重建索引時絕不碰，才不會把使用者與 AI 寫的說明洗掉。
    // 寫入是「較新者勝」的 upsert（ts 較大者贏；同一個 ts 時 author='user' 優先），所以兩台機器各自寫、再合併都不會讓舊說明蓋掉新說明。
    // 欄位名刻意避開 SQL 關鍵字（不用 by／at）。
    const NOTES_SCHEMA_VERSION = 1;
    const NOTES_DDL = [
        'CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)',
        'CREATE TABLE IF NOT EXISTS file_notes(path TEXT PRIMARY KEY, note TEXT NOT NULL, author TEXT, ts INTEGER NOT NULL DEFAULT 0, hash TEXT)',
        'CREATE TABLE IF NOT EXISTS sym_notes(path TEXT NOT NULL, name TEXT NOT NULL, note TEXT NOT NULL, author TEXT, ts INTEGER NOT NULL DEFAULT 0, hash TEXT, PRIMARY KEY(path, name))',
        'CREATE TABLE IF NOT EXISTS glossary(term TEXT PRIMARY KEY, definition TEXT NOT NULL, author TEXT, ts INTEGER NOT NULL DEFAULT 0)',
    ];
    const NOTES_BATCH = 150;
    async function notesInit(exec) {
        for (const d of NOTES_DDL) await run(exec, d);
        await run(exec, "INSERT INTO meta(k, v) VALUES('schema_version', ?) ON CONFLICT(k) DO NOTHING", [String(NOTES_SCHEMA_VERSION)]);
    }
    const newerSql = (t) => 'excluded.ts > ' + t + '.ts OR (excluded.ts = ' + t + ".ts AND excluded.author = 'user' AND IFNULL(" + t + ".author, '') <> 'user')";
    const tsOf = (v) => { const n = Number(v && (v.at != null ? v.at : v.ts)); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
    const authorOf = (v) => (v && v.by === 'user' ? 'user' : (v && v.author === 'user' ? 'user' : 'ai'));
    // notes 的形狀同 _repoIndexSnapshot().notes：{files:{path:{note,by,at,h}}, symbols:{'path#name':{...}}, glossary:{term:{definition,by,at}}}
    async function notesWrite(exec, notes) {
        notes = notes || {};
        const fileRows = [], symRows = [], termRows = [];
        for (const [p, v] of Object.entries(notes.files || {})) if (v && typeof v.note === 'string' && v.note) fileRows.push([p, v.note, authorOf(v), tsOf(v), v.h == null ? null : String(v.h)]);
        for (const [k, v] of Object.entries(notes.symbols || {})) { const i = k.indexOf('#'); if (i < 1 || !v || typeof v.note !== 'string' || !v.note) continue; symRows.push([k.slice(0, i), k.slice(i + 1), v.note, authorOf(v), tsOf(v), v.h == null ? null : String(v.h)]); }
        for (const [t, v] of Object.entries(notes.glossary || {})) if (v && v.definition) termRows.push([t, String(v.definition), authorOf(v), tsOf(v)]);
        let written = 0;
        const flush = async (table, cols, conflict, batch) => {
            const ph = '(' + cols.map(() => '?').join(',') + ')';
            const sets = cols.filter((c) => conflict.indexOf(c) < 0).map((c) => c + '=excluded.' + c).join(', ');
            const sql = 'INSERT INTO ' + table + '(' + cols.join(',') + ') VALUES ' + batch.map(() => ph).join(',') + ' ON CONFLICT(' + conflict.join(',') + ') DO UPDATE SET ' + sets + ' WHERE ' + newerSql(table);
            await run(exec, sql, batch.reduce((a, r) => a.concat(r), []));
            written += batch.length;
        };
        await run(exec, 'BEGIN');
        try {
            for (let i = 0; i < fileRows.length; i += NOTES_BATCH) await flush('file_notes', ['path', 'note', 'author', 'ts', 'hash'], ['path'], fileRows.slice(i, i + NOTES_BATCH));
            for (let i = 0; i < symRows.length; i += NOTES_BATCH) await flush('sym_notes', ['path', 'name', 'note', 'author', 'ts', 'hash'], ['path', 'name'], symRows.slice(i, i + NOTES_BATCH));
            for (let i = 0; i < termRows.length; i += NOTES_BATCH) await flush('glossary', ['term', 'definition', 'author', 'ts'], ['term'], termRows.slice(i, i + NOTES_BATCH));
            await run(exec, 'COMMIT');
        } catch (e) { try { await exec('ROLLBACK'); } catch (_) { /* 已回滾 */ } throw e; }
        return { rows: written };
    }
    async function notesRead(exec) {
        const out = { files: {}, symbols: {}, glossary: {} };
        for (const r of await rows(exec, 'SELECT path, note, author, ts, hash FROM file_notes')) out.files[r[0]] = { note: r[1], by: r[2], at: r[3], h: r[4] == null ? undefined : r[4] };
        for (const r of await rows(exec, 'SELECT path, name, note, author, ts, hash FROM sym_notes')) out.symbols[r[0] + '#' + r[1]] = { note: r[2], by: r[3], at: r[4], h: r[5] == null ? undefined : r[5] };
        for (const r of await rows(exec, 'SELECT term, definition, author, ts FROM glossary')) out.glossary[r[0]] = { definition: r[1], by: r[2], at: r[3] };
        return out;
    }
    async function notesCounts(exec) {
        const n = async (t) => Number((await rows(exec, 'SELECT count(*) FROM ' + t))[0][0]);
        return { files: await n('file_notes'), symbols: await n('sym_notes'), glossary: await n('glossary') };
    }
    return { builder, reader, insertMany, run, rows, one, DDL, INDEXES, SCHEMA_VERSION, splitNameDefault, dirOf, baseOf, notesInit, notesWrite, notesRead, notesCounts, NOTES_DDL, NOTES_SCHEMA_VERSION };
});
