/* 專案索引的 SQLite 層（UMD，與環境無關）：建表、分批寫入、完成階段、讀取。
 * 設計（見 DESIGN.project-index.md／DESIGN.sqlite-fap.md）：索引本身就是專案資料夾裡的 SQLite 檔（.floating-assistant/index/index.sqlite3），
 * 建索引時邊讀邊寫、記憶體只跟批次大小有關；查詢時 SQLite 自己用 PRAGMA cache_size（預設 64 MB）管理分頁快取，所以專案多大都不會爆記憶體。
 * 所有函式都吃一個 exec(sql, bind?) -> Promise<[{columns, rows, changes, error?}]>（引擎協定，列是陣列），不碰 DOM、不碰檔案。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaIdxSql = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const SCHEMA_VERSION = 1;
    const DDL = [
        'CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)',
        'CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL, dir TEXT, name TEXT, lang TEXT, lines INTEGER, hash TEXT, doc TEXT, sv INTEGER, nsyms INTEGER DEFAULT 0, refs INTEGER DEFAULT 0, used INTEGER DEFAULT 0, note TEXT)',
        'CREATE TABLE symbols(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT, file_id INTEGER NOT NULL, line INTEGER, doc TEXT, sig TEXT, note TEXT, used_by INTEGER DEFAULT 0)',
        'CREATE TABLE imports(src INTEGER NOT NULL, dst INTEGER, kind TEXT, spec TEXT)',
        'CREATE TABLE uses_raw(file_id INTEGER NOT NULL, name TEXT NOT NULL)',
        'CREATE TABLE uses(file_id INTEGER NOT NULL, symbol_id INTEGER NOT NULL)',
        'CREATE TABLE sym_fts_src(id INTEGER PRIMARY KEY, toks TEXT, doc TEXT, base TEXT)',
    ];
    const INDEXES = [
        'CREATE INDEX idx_files_dir ON files(dir)', 'CREATE INDEX idx_sym_name ON symbols(name COLLATE NOCASE)', 'CREATE INDEX idx_sym_file ON symbols(file_id)',
        'CREATE INDEX idx_imp_src ON imports(src)', 'CREATE INDEX idx_imp_dst ON imports(dst)', 'CREATE INDEX idx_use_file ON uses(file_id)', 'CREATE INDEX idx_use_sym ON uses(symbol_id)',
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
        opts = opts || {}; const splitName = opts.splitName || splitNameDefault; const batch = opts.batch || 400; const macroKinds = opts.macroKinds || ['macro'];
        const st = { pathId: new Map(), files: [], syms: [], imps: [], uses: [], fts: [], nextFile: 1, nextSym: 1, nFiles: 0, nSyms: 0, nImps: 0, nUses: 0, started: false };
        async function init(o) {
            o = o || {};
            if (o.fresh !== false) { for (const t of ['sym_fts', 'file_fts', 'meta', 'files', 'symbols', 'imports', 'uses_raw', 'uses', 'sym_fts_src']) await run(exec, 'DROP TABLE IF EXISTS ' + t); }
            for (const d of DDL) await run(exec, d);
            await run(exec, "INSERT INTO meta(k,v) VALUES('schema', ?), ('created', ?)", [String(SCHEMA_VERSION), new Date().toISOString()]);
            await run(exec, 'BEGIN'); st.started = true;
        }
        // 一個檔案的完整記錄（舊地圖的格式）：{lang, lines, hash, doc, imports:[{spec,kind,to}], symbols:[{n,k,l,d,sig}], uses:[名稱], sv}
        function addFile(path, rec) {
            const id = st.nextFile++; st.pathId.set(path, id);
            const syms = rec.symbols || []; st.files.push([id, path, dirOf(path), baseOf(path), rec.lang || '', rec.lines || 0, rec.hash || '', rec.doc || '', rec.sv || 0, syms.length]);
            for (const s of syms) { const sid = st.nextSym++; st.syms.push([sid, s.n, s.k || '', id, s.l || 0, s.d || '', s.sig || '', '']); if (!macroKinds.includes(s.k)) st.fts.push([sid, splitName(s.n), s.d || '', baseOf(path)]); }
            for (const e of rec.imports || []) st.imps.push([id, e.to || null, e.kind || '', e.spec || '', e.to || null]);
            for (const n of rec.uses || []) st.uses.push([id, n]);
            return syms.length;
        }
        const pending = () => st.files.length + st.syms.length + st.imps.length + st.uses.length;
        async function flush(force) {
            if (!st.started) throw new Error('builder 還沒 init');
            if (!force && st.files.length < batch && st.syms.length < batch * 20) return;
            const f = st.files, s = st.syms, im = st.imps, u = st.uses, ft = st.fts; st.files = []; st.syms = []; st.imps = []; st.uses = []; st.fts = [];
            await insertMany(exec, 'files', ['id', 'path', 'dir', 'name', 'lang', 'lines', 'hash', 'doc', 'sv', 'nsyms'], f); await insertMany(exec, 'symbols', ['id', 'name', 'kind', 'file_id', 'line', 'doc', 'sig', 'note'], s);
            // imports 的目標路徑要等所有檔案都有 id 才能解析：先把目標路徑暫存在 spec 之外的欄位（dst 先放 NULL，之後用 path 對應）
            await insertMany(exec, 'imports', ['src', 'dst', 'kind', 'spec'], im.map((r) => [r[0], null, r[2], (r[4] ? '\u0001' + r[4] : r[3])]));
            await insertMany(exec, 'uses_raw', ['file_id', 'name'], u); await insertMany(exec, 'sym_fts_src', ['id', 'toks', 'doc', 'base'], ft);
            st.nFiles += f.length; st.nSyms += s.length; st.nImps += im.length; st.nUses += u.length;
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
            await run(exec, 'UPDATE symbols SET used_by = (SELECT count(*) FROM uses u WHERE u.symbol_id = symbols.id) WHERE id IN (SELECT DISTINCT symbol_id FROM uses)');
            await run(exec, 'COMMIT'); await run(exec, 'BEGIN');
            prog('全文索引');
            await run(exec, "CREATE VIRTUAL TABLE sym_fts USING fts5(toks, doc, base, content='', tokenize='unicode61')");
            await run(exec, "INSERT INTO sym_fts(rowid, toks, doc, base) SELECT id, toks, doc, base FROM sym_fts_src");
            await run(exec, 'DROP TABLE sym_fts_src');
            await run(exec, "CREATE VIRTUAL TABLE file_fts USING fts5(path, doc, note, tokenize='unicode61')");
            await run(exec, "INSERT INTO file_fts(rowid, path, doc, note) SELECT id, replace(replace(path, '/', ' '), '_', ' '), doc, '' FROM files");
            const c = { files: await one(exec, 'select count(*) from files'), symbols: await one(exec, 'select count(*) from symbols'), imports: await one(exec, 'select count(*) from imports'), uses: await one(exec, 'select count(*) from uses'), macros: await one(exec, "select count(*) from symbols where kind='macro'") };
            await run(exec, "INSERT OR REPLACE INTO meta(k,v) VALUES ('counts', ?), ('built', ?), ('complete', ?), ('root', ?)", [JSON.stringify(c), new Date().toISOString(), o.complete === false ? '0' : '1', String(o.root || '')]);
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
            top: async (n) => (await rows(exec, 'select path, lang, lines, refs, used, nsyms from files order by used desc, nsyms desc limit ?', [n || 20])).map((r) => ({ path: r[0], lang: r[1], lines: r[2], refs: r[3], used: r[4], nsyms: r[5] })),
        };
        return R;
    }
    return { builder, reader, insertMany, run, rows, one, DDL, INDEXES, SCHEMA_VERSION, splitNameDefault, dirOf, baseOf };
});
