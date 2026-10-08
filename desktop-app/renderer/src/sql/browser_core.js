/* sqlitebrowser 的純函式部分（UMD）：欄位標頭過濾語法、DDL 預覽、儲存格顯示與輸入、危險語句判斷、匯出。
 * 介面（DOM）在 browser_ui.js；這裡不碰 DOM，所以可以直接測。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./sql_split.js'));
    else root.FaSqliteBrowserCore = factory(typeof FaSqlSplit !== 'undefined' ? FaSqlSplit : root.FaSqlSplit);
})(typeof self !== 'undefined' ? self : this, function (SPLIT) {
    'use strict';
    const quoteIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const isNum = (s) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(String(s).trim());
    const num = (s) => (isNum(s) ? Number(s) : s);

    // 欄位標頭的過濾框：abc→含有；=abc→相等；<>x；>5 >=5 <5 <=5；a..b→範圍；*.c ?x→GLOB；NULL／!NULL；/regex/→本頁過濾（JS 端）
    function parseFilter(text) {
        const s = String(text == null ? '' : text); const t = s.trim(); if (!t) return null;
        if (/^null$/i.test(t)) return { op: 'null' }; if (/^!null$/i.test(t)) return { op: 'notnull' };
        let m;
        if ((m = /^\/(.+)\/([a-z]*)$/.exec(t))) { try { new RegExp(m[1], m[2]); return { op: 'regex', value: m[1], flags: m[2] || 'i', local: true }; } catch (_) { return { op: 'like', value: t }; } }
        if ((m = /^(>=|<=|<>|!=|>|<|=)\s*([\s\S]*)$/.exec(t))) { const map = { '>=': 'ge', '<=': 'le', '<>': 'ne', '!=': 'ne', '>': 'gt', '<': 'lt', '=': 'eq' }; const v = m[2]; if (v === '' && m[1] === '=') return { op: 'eq', value: '' }; if (v === '') return null; return { op: map[m[1]], value: num(v) }; }
        if ((m = /^(.+?)\.\.(.+)$/.exec(t)) && !/[*?]/.test(t)) return { op: 'between', value: num(m[1].trim()), value2: num(m[2].trim()) };
        if (/[*?]/.test(t)) return { op: 'glob', value: t };
        return { op: 'like', value: t };
    }
    // 把一組 {欄名: 輸入文字} 轉成引擎 query 用的 filters；regex 類回傳在 local 裡（只能對已載入的頁面過濾）
    function buildFilters(map) {
        const filters = [], local = [];
        for (const [col, txt] of Object.entries(map || {})) { const f = parseFilter(txt); if (!f) continue; if (f.local) local.push({ col, regex: new RegExp(f.value, f.flags) }); else filters.push(Object.assign({ col }, f)); }
        return { filters, local };
    }

    // ---- DDL 預覽（所有結構操作先顯示 SQL 再確認）----
    const colDef = (c) => quoteIdent(c.name) + (c.type ? ' ' + c.type : '') + (c.pk ? ' PRIMARY KEY' + (c.autoinc ? ' AUTOINCREMENT' : '') : '') + (c.notnull && !c.pk ? ' NOT NULL' : '') + (c.unique && !c.pk ? ' UNIQUE' : '') + (c.dflt != null && c.dflt !== '' ? ' DEFAULT ' + c.dflt : '');
    const ddlCreateTable = (name, cols) => 'CREATE TABLE ' + quoteIdent(name) + ' (\n  ' + cols.map(colDef).join(',\n  ') + '\n);';
    const ddlAddColumn = (table, c) => 'ALTER TABLE ' + quoteIdent(table) + ' ADD COLUMN ' + colDef(Object.assign({}, c, { pk: false })) + ';';
    const ddlDropColumn = (table, col) => 'ALTER TABLE ' + quoteIdent(table) + ' DROP COLUMN ' + quoteIdent(col) + ';';
    const ddlRenameColumn = (table, from, to) => 'ALTER TABLE ' + quoteIdent(table) + ' RENAME COLUMN ' + quoteIdent(from) + ' TO ' + quoteIdent(to) + ';';
    const ddlRenameTable = (from, to) => 'ALTER TABLE ' + quoteIdent(from) + ' RENAME TO ' + quoteIdent(to) + ';';
    const ddlCreateIndex = (name, table, cols, unique) => 'CREATE ' + (unique ? 'UNIQUE ' : '') + 'INDEX ' + quoteIdent(name) + ' ON ' + quoteIdent(table) + ' (' + cols.map(quoteIdent).join(', ') + ');';
    const ddlDrop = (kind, name) => 'DROP ' + String(kind).toUpperCase() + ' ' + quoteIdent(name) + ';';

    // ---- 語句分類 ----
    function stripLead(sql) { return String(sql).replace(/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, ''); }
    function classify(sql) {
        const s = stripLead(sql); const w = (/^[A-Za-z]+/.exec(s) || [''])[0].toUpperCase();
        if (/^(SELECT|WITH|VALUES|EXPLAIN)$/.test(w)) return 'read'; if (w === 'PRAGMA') return /=|\(/.test(s) ? 'write' : 'read';
        if (/^(INSERT|UPDATE|DELETE|REPLACE)$/.test(w)) return 'write'; if (/^(CREATE|DROP|ALTER|REINDEX|VACUUM|ANALYZE)$/.test(w)) return 'ddl'; if (/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)$/.test(w)) return 'txn'; return 'other';
    }
    // 危險語句：DROP，或沒有 WHERE 的 DELETE／UPDATE
    function isDangerous(sql) {
        const out = []; for (const st of SPLIT.split(sql)) { const s = stripLead(st); if (/^DROP\b/i.test(s)) out.push('DROP：' + s.slice(0, 60)); else if (/^(DELETE|UPDATE)\b/i.test(s) && !/\bWHERE\b/i.test(s.replace(/'(?:[^']|'')*'/g, "''"))) out.push('沒有 WHERE 的 ' + (/^DELETE/i.test(s) ? 'DELETE' : 'UPDATE') + '：' + s.slice(0, 60)); }
        return out;
    }

    // ---- 儲存格 ----
    const b64len = (b) => Math.floor(String(b).length * 3 / 4) - (String(b).endsWith('==') ? 2 : String(b).endsWith('=') ? 1 : 0);
    function cellDisplay(v, max) {
        max = max || 200;
        if (v === null || v === undefined) return { text: 'NULL', cls: 'null', full: null };
        if (v && typeof v === 'object' && v.$blob !== undefined) return { text: '[BLOB ' + b64len(v.$blob) + ' 位元組]', cls: 'blob', full: v };
        if (v && typeof v === 'object' && v.$int !== undefined) return { text: String(v.$int), cls: 'num', full: v };
        if (v && typeof v === 'object' && v.$real !== undefined) return { text: String(v.$real), cls: 'num', full: v };
        if (typeof v === 'number') return { text: String(v), cls: 'num', full: v };
        const s = String(v); const one = s.replace(/\s*\n\s*/g, ' ⏎ '); return { text: one.length > max ? one.slice(0, max) + '…' : one, cls: s.length > max || /\n/.test(s) ? 'long' : 'text', full: s };
    }
    // 使用者輸入 → 要綁定的值。型別依欄位宣告的親和性；空字串在數值欄位視為 NULL；"NULL"（含大寫）要用「Set NULL」按鈕，避免誤把文字 NULL 當空值
    function parseCellInput(text, declType) {
        const s = String(text == null ? '' : text); const t = String(declType || '').toUpperCase();
        if (/INT/.test(t)) { if (s.trim() === '') return null; if (/^-?\d+$/.test(s.trim())) { const n = Number(s.trim()); return Number.isSafeInteger(n) ? n : { $int: s.trim() }; } if (isNum(s)) return Number(s); return s; }
        if (/REAL|FLOA|DOUB|NUM|DEC/.test(t)) { if (s.trim() === '') return null; return isNum(s) ? Number(s) : s; }
        if (/BLOB/.test(t)) { if (/^x'([0-9a-f]{2})*'$/i.test(s.trim())) { const hex = s.trim().slice(2, -1); let bin = ''; for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.substr(i, 2), 16)); return { $blob: typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64') }; } return s; }
        return s;
    }
    function hexDump(b64, maxBytes) {
        const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary'); const n = Math.min(bin.length, maxBytes || 4096); const lines = [];
        for (let i = 0; i < n; i += 16) { let hex = '', asc = ''; for (let j = 0; j < 16; j++) { if (i + j < n) { const c = bin.charCodeAt(i + j); hex += c.toString(16).padStart(2, '0') + ' '; asc += c >= 32 && c < 127 ? bin[i + j] : '.'; } else hex += '   '; } lines.push(i.toString(16).padStart(8, '0') + '  ' + hex + ' ' + asc); }
        if (bin.length > n) lines.push('… 還有 ' + (bin.length - n) + ' 位元組'); return lines.join('\n');
    }
    function imageType(b64) { const h = String(b64).slice(0, 16); if (h.startsWith('iVBORw0KGgo')) return 'image/png'; if (h.startsWith('/9j/')) return 'image/jpeg'; if (h.startsWith('R0lGOD')) return 'image/gif'; if (h.startsWith('UklGR')) return 'image/webp'; return null; }

    // ---- 匯出 ----
    const csvEsc = (s) => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    const plain = (v) => (v === null || v === undefined ? '' : (v && typeof v === 'object') ? (v.$blob !== undefined ? '' : String(v.$int !== undefined ? v.$int : v.$real)) : String(v));
    const toCsv = (cols, rows) => [cols.map(csvEsc).join(',')].concat(rows.map((r) => r.map((v) => csvEsc(plain(v))).join(','))).join('\r\n') + '\r\n';
    const toJson = (cols, rows) => JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] && typeof r[i] === 'object' && r[i].$int !== undefined ? r[i].$int : (r[i] && typeof r[i] === 'object' && r[i].$real !== undefined ? Number(r[i].$real) : r[i]) ]))), null, 2);
    const toMarkdown = (cols, rows) => '| ' + cols.join(' | ') + ' |\n|' + cols.map(() => '---').join('|') + '|\n' + rows.map((r) => '| ' + r.map((v) => plain(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |').join('\n') + '\n';

    // 編輯用的 WHERE：有 rowid 用 rowid，否則用主鍵欄位；兩者都沒有就不能編輯
    function rowKey(tableInfo, cols, row, hasRowid) {
        if (hasRowid) { const i = cols.indexOf('__rowid__'); if (i >= 0) return { sql: 'rowid = ?', bind: [row[i]] }; }
        const pks = (tableInfo.columns || []).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk); if (!pks.length) return null;
        const parts = [], bind = []; for (const p of pks) { const i = cols.indexOf(p.name); if (i < 0) return null; parts.push(quoteIdent(p.name) + ' = ?'); bind.push(row[i]); }
        return { sql: parts.join(' AND '), bind };
    }
    return { quoteIdent, parseFilter, buildFilters, ddlCreateTable, ddlAddColumn, ddlDropColumn, ddlRenameColumn, ddlRenameTable, ddlCreateIndex, ddlDrop, classify, isDangerous, cellDisplay, parseCellInput, hexDump, imageType, toCsv, toJson, toMarkdown, rowKey, stripLead };
});
