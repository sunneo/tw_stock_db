/* 網頁版的 SQLite 引擎操作（sqlite-wasm 的 oo1 API；UMD，與環境無關）：
 * 與桌面版 sqlite-engine.js 的 worker 同一組操作與同一個協定（open／exec／query／schema／pragma／status／close），所以終端機 sqlite3、
 * sqlitebrowser、Python 橋接、repo_sql 都不用知道底下是 node:sqlite 還是 wasm。
 * 值的協定同桌面版：BLOB＝{$blob:base64}、超過 2^53 的整數＝{$int:"…"}；typed 模式下整數值的實數＝{$real:"1.0"}。
 * 網頁版的資料庫都在 wasm 記憶體裡（deserialize 進來、export 出去寫回），所以適合小～中型資料庫；大型索引見 DESIGN.sqlite-fap.md。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaWasmOps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function create(sqlite3, SPLIT) {
        const capi = sqlite3.capi, wasm = sqlite3.wasm; let db = null, meta = null;
        const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
        const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(u).toString('base64'); };
        const unb64 = (s) => { if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; } return new Uint8Array(Buffer.from(s, 'base64')); };
        const clean = (e) => { const m = String((e && e.message) || e); return m.replace(/^(?:SQLITE_[A-Z_0-9]+: )?sqlite3 result code \d+: /, ''); };
        const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
        const need = () => { if (!db) throw new Error('資料庫沒有開啟'); return db; };
        // 一個儲存格 → 協定值。type：sqlite3_column_type（1 整數、2 實數、3 文字、4 BLOB、5 NULL）
        function enc(v, type, typed) {
            if (v === null || v === undefined || type === 5) return null;
            if (typeof v === 'bigint') return (v <= SAFE && v >= -SAFE) ? Number(v) : { $int: v.toString() };
            if (v instanceof Uint8Array) return { $blob: b64(v) };
            if (typed && type === 2 && typeof v === 'number') return (Number.isInteger(v) || !Number.isFinite(v)) ? { $real: Number.isFinite(v) ? v.toFixed(1) : (v > 0 ? 'Inf' : '-Inf') } : v;
            return v;
        }
        const decVal = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) { if (typeof v.$blob === 'string') return unb64(v.$blob); if (typeof v.$int === 'string') return BigInt(v.$int); } if (typeof v === 'boolean') return v ? 1 : 0; return v; };
        function bindTo(stmt, bind) {
            if (bind == null) return;
            if (Array.isArray(bind)) { if (bind.length) stmt.bind(bind.map(decVal)); return; }
            const o = {}; // 具名參數：接受不帶前綴的名稱（:name、@name、$name 都對得到）
            for (const [k, v] of Object.entries(bind)) { let key = k; if (!/^[:@$]/.test(k)) { for (const p of [':', '@', '$']) { if (stmt.getParamIndex(p + k) > 0) { key = p + k; break; } } } o[key] = decVal(v); }
            stmt.bind(o);
        }
        function runOne(sql, bind, limit, offset, maxCell, typed) {
            const t0 = Date.now(); const d = need(); const st = d.prepare(sql);
            try {
                bindTo(st, bind); const nc = st.columnCount;
                if (nc > 0) {
                    const cols = st.getColumnNames(); const rows = []; let skipped = 0, truncated = false;
                    while (st.step()) {
                        if (skipped < offset) { skipped++; continue; }
                        if (rows.length >= limit) { truncated = true; break; }
                        const raw = st.get([]); const row = new Array(nc);
                        for (let i = 0; i < nc; i++) { const ty = capi.sqlite3_column_type(st.pointer, i); let v = enc(raw[i], ty, typed); if (maxCell && typeof v === 'string' && v.length > maxCell) v = v.slice(0, maxCell) + '…'; row[i] = v; }
                        rows.push(row);
                    }
                    return { columns: cols, rows, truncated, ms: Date.now() - t0 };
                }
                st.step(); const lid = d.selectValue('select last_insert_rowid()');
                return { columns: [], rows: [], changes: d.changes(), last_id: typeof lid === 'bigint' ? (lid <= SAFE && lid >= -SAFE ? Number(lid) : { $int: lid.toString() }) : lid, ms: Date.now() - t0 };
            } finally { st.finalize(); }
        }
        const ops = {
            open(a) {
                if (db) { try { db.close(); } catch (_) { /* 已關 */ } db = null; }
                db = new sqlite3.oo1.DB(':memory:', 'c');
                if (a.bytes && a.bytes.length) {
                    const u = a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(a.bytes); const p = wasm.allocFromTypedArray(u);
                    const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE | (a.readonly ? capi.SQLITE_DESERIALIZE_READONLY : 0);
                    const rc = capi.sqlite3_deserialize(db.pointer, 'main', p, u.length, u.length, flags); if (rc) { db.close(); db = null; throw new Error('不是有效的 SQLite 資料庫檔案（deserialize 失敗，代碼 ' + rc + '）'); }
                }
                meta = { path: a.label || ':memory:', readonly: !!a.readonly };
                db.exec('PRAGMA foreign_keys=ON; PRAGMA cache_size=-65536;'); if (a.readonly) db.exec('PRAGMA query_only=ON;');
                return { size: a.bytes ? a.bytes.length : 0, version: db.selectValue('select sqlite_version()'), path: meta.path, readonly: meta.readonly };
            },
            exec(a) {
                const { sql, bind, limit = 1000, offset = 0, maxCell = 0, typed = false } = a; const stmts = SPLIT.split(sql); const results = [];
                for (let i = 0; i < stmts.length; i++) {
                    try { results.push(runOne(stmts[i], i === 0 ? bind : undefined, limit, offset, maxCell, typed)); }
                    catch (e) { results.push({ columns: [], rows: [], error: clean(e), code: e && e.resultCode, sql: stmts[i].slice(0, 200) }); break; }
                }
                return { results };
            },
            query(a) {
                const { table, columns, filters, sort, offset = 0, limit = 100, count } = a; const cols = columns && columns.length ? columns.map(q).join(', ') : '*'; const where = [], bind = [];
                for (const f of filters || []) {
                    const c = q(f.col);
                    switch (f.op) {
                        case 'like': where.push(c + " LIKE ? ESCAPE '\\'"); bind.push('%' + String(f.value).replace(/[\\%_]/g, '\\$&') + '%'); break;
                        case 'eq': where.push(c + ' = ?'); bind.push(f.value); break; case 'ne': where.push(c + ' <> ?'); bind.push(f.value); break;
                        case 'gt': where.push(c + ' > ?'); bind.push(f.value); break; case 'ge': where.push(c + ' >= ?'); bind.push(f.value); break;
                        case 'lt': where.push(c + ' < ?'); bind.push(f.value); break; case 'le': where.push(c + ' <= ?'); bind.push(f.value); break;
                        case 'between': where.push(c + ' BETWEEN ? AND ?'); bind.push(f.value, f.value2); break; case 'glob': where.push(c + ' GLOB ?'); bind.push(f.value); break;
                        case 'null': where.push(c + ' IS NULL'); break; case 'notnull': where.push(c + ' IS NOT NULL'); break;
                        default: throw new Error('不認得的過濾運算：' + f.op);
                    }
                }
                const w = where.length ? ' WHERE ' + where.join(' AND ') : ''; const order = sort && sort.length ? ' ORDER BY ' + sort.map((s) => q(s.col) + (s.desc ? ' DESC' : ' ASC')).join(', ') : '';
                let hasRowid = true; try { need().prepare('select rowid from ' + q(table) + ' limit 0').finalize(); } catch (_) { hasRowid = false; }
                const sel = hasRowid ? 'rowid AS "__rowid__", ' + cols : cols; const lim = Number(limit) | 0;
                const r = runOne('SELECT ' + sel + ' FROM ' + q(table) + w + order + ' LIMIT ' + lim + ' OFFSET ' + (Number(offset) | 0), bind, lim, 0, 2000, false);
                let total; if (count !== false) { try { total = Number(bind.length ? need().selectValue('SELECT count(*) FROM ' + q(table) + w, bind.map(decVal)) : need().selectValue('SELECT count(*) FROM ' + q(table) + w)); } catch (_) { total = null; } }
                return { columns: r.columns, rows: r.rows, total, hasRowid };
            },
            schema() {
                const d = need(); const rows = d.selectArrays("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%' order by type, name"); const out = { tables: [], views: [], indices: [], triggers: [] };
                for (const [type, name, tbl, sql] of rows) {
                    if (type === 'table') {
                        const cols = d.selectArrays('PRAGMA table_xinfo(' + q(name) + ')').map((c) => ({ cid: Number(c[0]), name: c[1], type: c[2], notnull: !!c[3], dflt: c[4], pk: Number(c[5]), hidden: Number(c[6]) }));
                        const virtual = /^CREATE VIRTUAL TABLE/i.test(sql || ''); let count = null; if (!virtual) { try { count = Number(d.selectValue('select count(*) from ' + q(name))); } catch (_) { count = null; } }
                        out.tables.push({ name, sql, columns: cols, rows: count, virtual });
                    } else if (type === 'view') out.views.push({ name, sql }); else if (type === 'index') out.indices.push({ name, table: tbl, sql }); else if (type === 'trigger') out.triggers.push({ name, table: tbl, sql });
                }
                return out;
            },
            pragma(a) {
                if (!/^[a-z_]+$/i.test(a.name)) throw new Error('PRAGMA 名稱不合法'); if (/^(load_extension|writable_schema)$/i.test(a.name)) throw new Error('不允許的 PRAGMA：' + a.name);
                const sql = a.value === undefined ? 'PRAGMA ' + a.name : 'PRAGMA ' + a.name + '=' + (typeof a.value === 'number' ? a.value : "'" + String(a.value).replace(/'/g, "''") + "'"); return runOne(sql, undefined, 1000, 0, 0, false);
            },
            checkpoint() { return { ok: true }; },
            status() { const d = need(); const pc = Number(d.selectValue('PRAGMA page_count')), ps = Number(d.selectValue('PRAGMA page_size')); return { pages: pc, pageSize: ps, bytes: pc * ps, path: meta.path, readonly: meta.readonly, inTransaction: false }; },
            // 網頁版的「寫回」：把整個資料庫序列化成位元組，由頁面端寫回來源（fap、沙盒、persistentStorage）
            export() { const u = capi.sqlite3_js_db_export(need().pointer); return { bytes: u }; },
            close() { if (db) { try { db.close(); } catch (_) { /* 已關 */ } db = null; } return { ok: true }; },
        };
        return { ops, runOne };
    }
    return { create };
});
