/* sqlite3 命令列的核心（純 JS，UMD）：行為對齊真的 `sqlite3`——輸出模式、點指令、選項、錯誤字樣、結束碼。
 * 不碰任何環境：引擎（exec/open）與檔案讀寫都由呼叫端注入，所以終端機指令、sqlitebrowser 的 SQL 分頁、測試共用同一份。
 *
 * 值的表示（引擎協定，typed:true）：null、字串、整數＝JS number 或 {$int}、實數＝{$real:"1.0"}（整數值的實數）或非整數 number、BLOB＝{$blob:base64}。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./sql_split.js'));
    else root.FaSqliteShell = factory(typeof FaSqlSplit !== 'undefined' ? FaSqlSplit : root.FaSqlSplit);
})(typeof self !== 'undefined' ? self : this, function (SPLIT) {
    'use strict';
    const MODES = ['ascii', 'box', 'csv', 'column', 'html', 'insert', 'json', 'line', 'list', 'markdown', 'quote', 'table', 'tabs', 'tcl'];
    const isInt = (v) => typeof v === 'number' || (v && typeof v === 'object' && v.$int !== undefined);
    const isReal = (v) => v && typeof v === 'object' && v.$real !== undefined;
    const isBlob = (v) => v && typeof v === 'object' && v.$blob !== undefined;
    const b64bytes = (b) => { try { if (typeof Buffer !== 'undefined') return Buffer.from(b, 'base64'); const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; } catch (_) { return new Uint8Array(0); } };
    const utf8 = (u) => (typeof Buffer !== 'undefined' ? Buffer.from(u).toString('utf8') : new TextDecoder().decode(u));
    const hex = (u) => Array.from(u).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
    function realText(v) { // 對齊 sqlite 的 %!.15g（現代版：最短可往返表示，整數值帶 .0）
        if (isReal(v)) return v.$real === 'Inf' ? 'Inf' : v.$real === '-Inf' ? '-Inf' : v.$real; if (typeof v !== 'number') return String(v);
        let s = String(v); if (/e/.test(s)) s = s.replace(/^(-?\d+)e/, '$1.0e'); return s;
    }
    // 一個儲存格在「文字型」輸出（list/column/line/table/box/markdown/csv…）的樣子
    function cellText(v, nullValue) {
        if (v === null || v === undefined) return nullValue;
        if (typeof v === 'string') return v; if (typeof v === 'number') return Number.isInteger(v) ? String(v) : realText(v);
        if (isReal(v)) return realText(v); if (v && v.$int !== undefined) return String(v.$int);
        if (isBlob(v)) return utf8(b64bytes(v.$blob)); return String(v);
    }
    const sqlQuote = (v) => {
        if (v === null || v === undefined) return 'NULL'; if (typeof v === 'string') return "'" + v.replace(/'/g, "''") + "'";
        if (typeof v === 'number') return Number.isInteger(v) ? String(v) : realText(v); if (isReal(v)) return realText(v); if (v && v.$int !== undefined) return String(v.$int);
        if (isBlob(v)) return "X'" + hex(b64bytes(v.$blob)) + "'"; return String(v);
    };
    const csvCell = (v, sep, nullValue) => { if (v === null || v === undefined) return nullValue; const s = cellText(v, nullValue); return (s === '' && typeof v === 'string' ? '' : (/[\r\n"]/.test(s) || s.includes(sep) || /^\s|\s$/.test(s) && false) ? '"' + s.replace(/"/g, '""') + '"' : s); };
    const jsonStr = (s) => '"' + s.replace(/[\\"\u0000-\u001f]/g, (c) => ({ '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))) + '"';
    const jsonVal = (v) => { if (v === null || v === undefined) return 'null'; if (typeof v === 'string') return jsonStr(v); if (typeof v === 'number') return Number.isInteger(v) ? String(v) : realText(v); if (isReal(v)) return realText(v) === 'Inf' ? '9.0e+999' : realText(v) === '-Inf' ? '-9.0e+999' : realText(v); if (v && v.$int !== undefined) return String(v.$int); if (isBlob(v)) return jsonStr(utf8(b64bytes(v.$blob))); return jsonStr(String(v)); };
    const htmlEsc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const width = (s) => { let w = 0; for (const ch of s) { const c = ch.codePointAt(0); w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd))) ? 2 : 1; } return w; };
    const pad = (s, w, right) => { const g = Math.max(0, w - width(s)); return right ? ' '.repeat(g) + s : s + ' '.repeat(g); };

    function create(host) {
        const st = {
            mode: 'list', headers: false, colSep: '|', rowSep: '\n', nullValue: '', widths: [], echo: false, bail: false, timer: false, changes: false, stats: false,
            db: null, dbPath: '', readonly: false, buf: '', exitCode: 0, quit: false, out: null, onceFile: null, outputFile: null, outChunks: [], insertTable: 'table', errorCount: 0, lineNo: 0, scriptName: '', explain: 'auto', limitNote: false,
        };
        const w = (s) => { if (st.outputFile || st.onceFile) st.outChunks.push(s); else host.write(s); };
        const err = (s) => host.writeErr(s);
        const ver = () => host.version || '3.53.4';
        async function flushOut(afterSql) { const f = st.onceFile || st.outputFile; if (f && st.outChunks.length) { const txt = st.outChunks.join(''); st.outChunks = []; await host.io.writeText(f, txt, { append: !!st.outputFile && st._outStarted }); st._outStarted = true; } if (st.onceFile && afterSql) { st.onceFile = null; st._outStarted = false; } }
        const need = async () => { if (!st.db) { await openDb(host.defaultDb || ':memory:', { readonly: false, initial: true }); } return st.db; };
        async function openDb(p, o) { o = o || {}; if (st.db) { try { await host.close(st.db); } catch (_) { /* 已關 */ } st.db = null; } const r = await host.open(p, { readonly: !!o.readonly, create: o.create !== false }); st.db = r.db; st.dbPath = p; st.readonly = !!o.readonly; return r; }

        // ---- 輸出格式化 ----
        function renderRows(res, tableName) {
            const cols = res.columns, rows = res.rows; if (!cols.length) return '';
            const nv = st.nullValue; const out = [];
            switch (st.mode) {
                case 'list': case 'tabs': case 'ascii': {
                    const sep = st.mode === 'tabs' ? '\t' : st.mode === 'ascii' ? '\x1f' : st.colSep; const rs = st.mode === 'ascii' ? '\x1e' : st.rowSep;
                    if (st.headers) out.push(cols.join(sep) + rs); for (const r of rows) out.push(r.map((v) => cellText(v, nv)).join(sep) + rs); break;
                }
                case 'csv': { const sep = st.colSep === '|' ? ',' : st.colSep; const rs = st.rowSep === '\n' ? '\r\n' : st.rowSep; const hs = st._csvCli ? '\n' : rs; if (st.headers) out.push(cols.map((c) => csvCell(c, sep, '')).join(sep) + hs); for (const r of rows) out.push(r.map((v) => csvCell(v, sep, nv)).join(sep) + hs); break; }
                case 'quote': { if (st.headers) out.push(cols.map(sqlQuote).join(',') + '\n'); for (const r of rows) out.push(r.map(sqlQuote).join(',') + '\n'); break; }
                case 'insert': { const tn = st.insertTable; const q = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tn) ? tn : '"' + tn.replace(/"/g, '""') + '"'; for (const r of rows) out.push('INSERT INTO ' + q + (st.headers ? '(' + cols.map((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? c : '"' + c.replace(/"/g, '""') + '"').join(',') + ')' : '') + ' VALUES(' + r.map(sqlQuote).join(',') + ');\n'); break; }
                case 'json': { out.push('['); rows.forEach((r, i) => { out.push((i ? ',\n' : '') + '{' + cols.map((c, j) => jsonStr(c) + ':' + jsonVal(r[j])).join(',') + '}'); }); out.push(']\n'); break; }
                case 'html': { if (st.headers) out.push('<TR>' + cols.map((c) => '<TH>' + htmlEsc(c) + '</TH>').join('') + '\n</TR>\n'); for (const r of rows) out.push('<TR>' + r.map((v) => '<TD>' + htmlEsc(cellText(v, nv)) + '</TD>').join('') + '\n</TR>\n'); break; }
                case 'tcl': { const tq = (s) => '"' + s.replace(/[\\"\n\r\t]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c])) + '"'; if (st.headers) out.push(cols.map(tq).join(' ') + '\n'); for (const r of rows) out.push(r.map((v) => tq(cellText(v, nv))).join(' ') + '\n'); break; }
                case 'line': {
                    const cw = Math.max(...cols.map((c) => width(c))); rows.forEach((r, i) => { if (i) out.push('\n'); cols.forEach((c, j) => out.push(pad(c, cw, true) + ' = ' + cellText(r[j], nv) + '\n')); }); break;
                }
                case 'column': case 'table': case 'box': case 'markdown': {
                    const cells = rows.map((r) => r.map((v) => cellText(v, nv))); const ws = cols.map((c, j) => { let m = width(c); for (const r of cells) m = Math.max(m, ...r[j].split('\n').map(width)); return m; });
                    if (st.mode === 'column' && st.widths.length) st.widths.forEach((x, j) => { if (x && j < ws.length) ws[j] = Math.abs(x); });
                    const right = (j, i) => (st.mode === 'column' && st.widths[j] < 0) || (st.mode !== 'column' && typeof rows[i][j] !== 'string' && rows[i][j] !== null && rows[i][j] !== undefined && !isBlob(rows[i][j]));
                    const line = (l, m, r2, h) => l + ws.map((x) => h.repeat(x + 2)).join(m) + r2 + '\n';
                    if (st.mode === 'column') {
                        if (st.headers) { out.push(cols.map((c, j) => pad(c, ws[j])).join('  ') + '\n'); out.push(ws.map((x) => '-'.repeat(x)).join('  ') + '\n'); }
                        for (const r of cells) out.push(r.map((c, j) => pad(c, ws[j], st.widths[j] < 0)).join('  ') + '\n');
                    } else if (st.mode === 'markdown') {
                        out.push('| ' + cols.map((c, j) => pad(c, ws[j])).join(' | ') + ' |\n'); out.push('|' + ws.map((x) => '-'.repeat(x + 2)).join('|') + '|\n'); for (const r of cells) out.push('| ' + r.map((c, j) => pad(c, ws[j])).join(' | ') + ' |\n');
                    } else {
                        const box = st.mode === 'box'; const L = box ? ['┌', '┬', '┐', '─'] : ['+', '+', '+', '-']; const M = box ? ['├', '┼', '┤', '─'] : ['+', '+', '+', '-']; const B = box ? ['└', '┴', '┘', '─'] : ['+', '+', '+', '-']; const V = box ? '│' : '|';
                        out.push(line(L[0], L[1], L[2], L[3])); out.push(V + cols.map((c, j) => ' ' + pad(c, ws[j]) + ' ').join(V) + V + '\n'); out.push(line(M[0], M[1], M[2], M[3]));
                        cells.forEach((r, i) => out.push(V + r.map((c, j) => ' ' + pad(c, ws[j], right(j, i)) + ' ').join(V) + V + '\n'));
                        out.push(line(B[0], B[1], B[2], B[3]));
                        if (!rows.length) { out.length = 0; out.push(line(L[0], L[1], L[2], L[3])); out.push(V + cols.map((c, j) => ' ' + pad(c, ws[j]) + ' ').join(V) + V + '\n'); out.push(line(B[0], B[1], B[2], B[3])); }
                    }
                    break;
                }
                default: break;
            }
            return out.join('');
        }
        const isNumeric = (s) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s);

        async function runSql(sql) {
            const db = await need(); const t0 = Date.now();
            if (st.echo) w(sql.trim() + '\n');
            const r = await host.exec(db, sql, { typed: true, limit: 1000000 });
            for (const res of r.results) {
                if (res.error) { st.exitCode = 1; st.errorCount++; err('Error: ' + res.error + (res.sql && false ? '' : '') + '\n'); if (st.bail) st.quit = true; return false; }
                if (res.columns && res.columns.length) { if (st.mode === 'column' || st.mode === 'table' || st.mode === 'box' || st.mode === 'markdown') { if (res.rows.length || st.mode !== 'column') w(renderRows(res)); } else w(renderRows(res)); }
                if (st.changes && !(res.columns && res.columns.length)) w('changes: ' + res.changes + '   total_changes: ' + (res.changes) + '\n');
            }
            if (st.timer) w('Run Time: real ' + ((Date.now() - t0) / 1000).toFixed(3) + ' user 0.000000 sys 0.000000\n');
            return true;
        }

        // ---- 點指令 ----
        const HELP = `.backup ?DB? FILE      Backup DB (default "main") to FILE
.bail on|off           Stop after hitting an error.  Default OFF
.databases             List names and files of attached databases
.dump ?OBJECTS?        Render database content as SQL
.echo on|off           Turn command echo on or off
.exit ?CODE?           Exit this program with return-code CODE
.headers on|off        Turn display of headers on or off
.help ?-all? ?PATTERN? Show help text for PATTERN
.import FILE TABLE     Import data from FILE into TABLE
.indexes ?TABLE?       Show names of indexes
.mode MODE ?OPTIONS?   Set output mode
.nullvalue STRING      Use STRING in place of NULL values
.once ?OPTIONS? ?FILE? Output for the next SQL command only to FILE
.open ?OPTIONS? ?FILE? Close existing database and reopen FILE
.output ?FILE?         Send output to FILE or stdout if FILE is omitted
.print STRING...       Print literal STRING
.quit                  Exit this program
.read FILE             Read input from FILE
.save ?OPTIONS? FILE   Write database to FILE (an alias for .backup ...)
.schema ?PATTERN?      Show the CREATE statements matching PATTERN
.separator COL ?ROW?   Change the column and row separators
.show                  Show the current values for various settings
.sync                  Write unsaved changes back to the database file
.tables ?TABLE?        List names of tables matching LIKE pattern TABLE
.timer on|off          Turn SQL timer on or off
.width NUM1 NUM2 ...   Set minimum column widths for columnar output
`;
        const unq = (s) => { s = String(s); const m = /^(['"])([\s\S]*)\1$/.exec(s); if (!m) return s; return m[1] === "'" ? m[2] : m[2].replace(/\\(.)/g, '$1'); };
        function words(line) { // 點指令的引數：單雙引號、反斜線跳脫
            const out = []; let i = 0; const n = line.length;
            while (i < n) { while (i < n && /\s/.test(line[i])) i++; if (i >= n) break; let cur = ''; const q = line[i]; if (q === "'" || q === '"') { i++; while (i < n && line[i] !== q) { if (q === '"' && line[i] === '\\' && i + 1 < n) { const nx = line[i + 1]; cur += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx; i += 2; continue; } cur += line[i++]; } i++; } else { while (i < n && !/\s/.test(line[i])) cur += line[i++]; } out.push(cur); }
            return out;
        }
        const onoff = (s) => /^(on|yes|true|1)$/i.test(s) ? true : /^(off|no|false|0)$/i.test(s) ? false : null;
        async function listObjects(kind, pattern) {
            const db = await need(); const like = pattern ? ' and name like ?' : ''; const r = await host.exec(db, "select name from sqlite_master where type='" + kind + "' and name not like 'sqlite_%'" + like + ' order by 1', { bind: pattern ? [pattern] : undefined, typed: true });
            return (r.results[0].rows || []).map((x) => x[0]);
        }
        async function dotCommand(line) {
            const m = /^\.(\S+)\s*([\s\S]*)$/.exec(line.trim()); if (!m) { err('Error: unknown command or invalid arguments:  "' + line.trim().slice(1) + '". Enter ".help" for help\n'); st.exitCode = 1; return; }
            const cmd = m[1].toLowerCase(); const rest = m[2].trim(); const a = words(rest);
            const bad = (why) => { err((why || 'Error: unknown command or invalid arguments:  "' + cmd + '". Enter ".help" for help') + '\n'); st.exitCode = 1; st.errorCount++; if (st.bail) st.quit = true; };
            switch (cmd) {
                case 'quit': case 'exit': st.quit = true; if (cmd === 'exit' && a[0] != null && /^-?\d+$/.test(a[0])) st.exitCode = parseInt(a[0], 10); return;
                case 'help': w(HELP); return;
                case 'headers': case 'header': { const v = onoff(a[0] || ''); if (v === null) return bad('Usage: .headers on|off'); st.headers = v; return; }
                case 'echo': { const v = onoff(a[0] || ''); if (v === null) return bad('Usage: .echo on|off'); st.echo = v; return; }
                case 'bail': { const v = onoff(a[0] || ''); if (v === null) return bad('Usage: .bail on|off'); st.bail = v; return; }
                case 'timer': { const v = onoff(a[0] || ''); if (v === null) return bad('Usage: .timer on|off'); st.timer = v; return; }
                case 'changes': { const v = onoff(a[0] || ''); if (v === null) return bad('Usage: .changes on|off'); st.changes = v; return; }
                case 'nullvalue': st.nullValue = a[0] != null ? a[0] : ''; return;
                case 'print': w(a.join(' ') + '\n'); return;
                case 'width': st.widths = a.map((x) => parseInt(x, 10) || 0); return;
                case 'separator': { if (!a.length) return bad('Usage: .separator COL ?ROW?'); st.colSep = a[0]; if (a[1] != null) st.rowSep = a[1]; return; }
                case 'mode': {
                    if (!a.length) { w('current output mode: ' + st.mode + '\n'); return; }
                    const md = a[0].toLowerCase(); if (!MODES.includes(md)) return bad('Error: mode should be one of: ' + MODES.join(' '));
                    st.mode = md; st._csvCli = false;
                    if (md === 'csv') { st.colSep = ','; st.rowSep = '\r\n'; } else if (md === 'tabs') { st.colSep = '\t'; st.rowSep = '\n'; } else if (md === 'list') { st.colSep = '|'; st.rowSep = '\n'; } else if (md === 'insert') st.insertTable = a[1] || 'table'; else if (md === 'ascii') { st.colSep = '\x1f'; st.rowSep = '\x1e'; }
                    if (md === 'table' || md === 'box' || md === 'markdown') st.headers = true; return;
                }
                case 'show': { w('     echo: ' + (st.echo ? 'on' : 'off') + '\n  eqp: off\n  explain: auto\n headers: ' + (st.headers ? 'on' : 'off') + '\n    mode: ' + st.mode + '\nnullvalue: "' + st.nullValue + '"\n  output: ' + (st.outputFile || 'stdout') + '\ncolseparator: "' + st.colSep.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"\nrowseparator: "' + st.rowSep.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"\n   stats: off\n   width: ' + st.widths.join(' ') + '\n filename: ' + (st.dbPath || ':memory:') + '\n'); return; }
                case 'open': { const f = a.filter((x) => !x.startsWith('-')).pop(); const ro = a.includes('--readonly'); try { await openDb(f || ':memory:', { readonly: ro }); } catch (e) { return bad('Error: unable to open database "' + f + '": ' + (e.message || e)); } return; }
                case 'tables': { const names = await listObjects('table', a[0]); const views = await listObjects('view', a[0]); const all = names.concat(views).sort(); if (all.length) { const cw = Math.max(...all.map(width)) + 2; const per = Math.max(1, Math.floor(80 / cw)); const rows = Math.ceil(all.length / per); for (let r = 0; r < rows; r++) { let l = ''; for (let c = 0; c < per; c++) { const k = c * rows + r; if (k < all.length) l += pad(all[k], cw); } w(l.replace(/\s+$/, '') + '\n'); } } return; }
                case 'indexes': case 'indices': { const db = await need(); const r = await host.exec(db, "select name from sqlite_master where type='index'" + (a[0] ? ' and tbl_name like ?' : '') + ' order by 1', { bind: a[0] ? [a[0]] : undefined, typed: true }); w((r.results[0].rows || []).map((x) => x[0]).join('\n') + (r.results[0].rows.length ? '\n' : '')); return; }
                case 'schema': { const db = await need(); const like = a.filter((x) => !x.startsWith('-'))[0]; const r = await host.exec(db, "select sql from sqlite_master where sql not null and name not like 'sqlite_%'" + (like ? ' and (tbl_name like ?1 or name like ?1)' : '') + " order by case type when 'table' then 1 when 'index' then 2 when 'view' then 3 else 4 end, rowid", { bind: like ? [like] : undefined, typed: true }); for (const x of r.results[0].rows || []) w(x[0] + ';\n'); return; }
                case 'databases': { const db = await need(); w('main: ' + (st.dbPath && st.dbPath !== ':memory:' ? st.dbPath : '') + ' ' + (st.readonly ? 'r/o' : 'r/w') + '\n'); return; }
                case 'read': { if (!a[0]) return bad('Usage: .read FILE'); let txt; try { txt = await host.io.readText(a[0]); } catch (e) { return bad('Error: cannot open "' + a[0] + '"'); } await runScript(txt, a[0]); return; }
                case 'output': case 'once': { const f = a.filter((x) => !x.startsWith('-'))[0]; if (cmd === 'output') { await flushOut(); st.outputFile = f && f !== 'stdout' ? f : null; st._outStarted = false; st.outChunks = []; } else { if (!f) return bad('Usage: .once FILE'); st.onceFile = f; st.outChunks = []; } return; }
                case 'import': {
                    const opts = a.filter((x) => x.startsWith('-')); const pos = a.filter((x) => !x.startsWith('-')); if (pos.length !== 2) return bad('Usage: .import ?OPTIONS? FILE TABLE'); let txt; try { txt = await host.io.readText(pos[0]); } catch (e) { return bad('Error: cannot open "' + pos[0] + '"'); }
                    const skipI = a.indexOf('--skip'); const skip = skipI >= 0 ? parseInt(a[skipI + 1], 10) || 0 : 0; const sep = (st.mode === 'csv' || opts.includes('-csv') || opts.includes('--csv')) ? ',' : st.colSep; const rows = parseCsv(txt, sep).slice(skip);
                    const db = await need(); const tbl = pos[1]; const q = '"' + tbl.replace(/"/g, '""') + '"'; const exists = (await host.exec(db, "select 1 from sqlite_master where type='table' and name=?", { bind: [tbl], typed: true })).results[0].rows.length > 0;
                    let data = rows; if (!exists) { if (!rows.length) return; const head = rows[0]; data = rows.slice(1); const r = await host.exec(db, 'CREATE TABLE ' + q + '(' + head.map((h) => '"' + h.replace(/"/g, '""') + '" TEXT').join(',') + ')', {}); if (r.results[0].error) return bad('Error: ' + r.results[0].error); }
                    const ncol = (await host.exec(db, 'PRAGMA table_info(' + q + ')', { typed: true })).results[0].rows.length; await host.exec(db, 'BEGIN', {});
                    for (const row of data) { const vals = row.slice(0, ncol); while (vals.length < ncol) vals.push(null); const r = await host.exec(db, 'INSERT INTO ' + q + ' VALUES(' + vals.map(() => '?').join(',') + ')', { bind: vals }); if (r.results[0].error) { await host.exec(db, 'ROLLBACK', {}); return bad('Error: ' + r.results[0].error); } }
                    await host.exec(db, 'COMMIT', {}); return;
                }
                case 'dump': { await dump(a); return; }
                case 'backup': case 'save': { const f = a.filter((x) => !x.startsWith('-')).pop(); if (!f) return bad('Usage: .' + cmd + ' ?DB? FILE'); if (!host.backup) return bad('Error: .' + cmd + ' 在這個環境不支援'); try { await host.backup(await need(), f); } catch (e) { return bad('Error: ' + (e.message || e)); } return; }
                case 'sync': { if (host.sync) await host.sync(await need()); return; }
                case 'shell': case 'system': case 'cd': case 'load': case 'restore': return bad('Error: .' + cmd + ' 在這個環境不支援');
                default: return bad('Error: unknown command or invalid arguments:  "' + cmd + '". Enter ".help" for help');
            }
        }
        function parseCsv(text, sep) {
            const rows = []; let row = [], cur = '', i = 0, inq = false; const n = text.length; let any = false;
            while (i < n) { const c = text[i]; if (inq) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i += 2; continue; } inq = false; i++; continue; } cur += c; i++; continue; } if (c === '"' && cur === '') { inq = true; any = true; i++; continue; } if (text.startsWith(sep, i)) { row.push(cur); cur = ''; i += sep.length; any = true; continue; } if (c === '\r' && text[i + 1] === '\n') { i++; continue; } if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; any = false; i++; continue; } cur += c; any = true; i++; }
            if (cur !== '' || any || row.length) { row.push(cur); rows.push(row); } return rows;
        }
        async function dump(args) {
            const db = await need(); const pats = args.filter((x) => !x.startsWith('-'));
            w('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n');
            const objs = (await host.exec(db, "select type,name,tbl_name,sql from sqlite_master where sql not null and name not like 'sqlite_%' order by case type when 'table' then 1 when 'index' then 2 when 'view' then 3 else 4 end, rowid", { typed: true })).results[0].rows;
            for (const [type, name, tbl, sql] of objs) {
                if (pats.length && !pats.some((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(tbl))) continue;
                w(sql + ';\n');
                if (type === 'table' && !/^CREATE VIRTUAL TABLE/i.test(sql)) {
                    const q = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"'; let off = 0;
                    for (;;) { const r = (await host.exec(db, 'select * from "' + name.replace(/"/g, '""') + '" limit 500 offset ' + off, { typed: true, limit: 500 })).results[0]; if (!r.rows || !r.rows.length) break; for (const row of r.rows) w('INSERT INTO ' + q + ' VALUES(' + row.map(sqlQuote).join(',') + ');\n'); if (r.rows.length < 500) break; off += 500; }
                }
            }
            w('COMMIT;\n');
        }

        // ---- 逐行輸入（REPL 與腳本共用）----
        async function feedLine(line) {
            st.lineNo++;
            if (!st.buf.trim() && /^\s*\./.test(line)) { const isOnce = /^\s*\.once\b/i.test(line); await dotCommand(line); if (!isOnce) await flushOut(false); return; }
            if (!st.buf.trim() && /^\s*$/.test(line)) return;
            st.buf += (st.buf ? '\n' : '') + line;
            if (SPLIT.isComplete(st.buf) && st.buf.trim()) { const sql = st.buf; st.buf = ''; await runSql(sql); await flushOut(true); }
        }
        async function runScript(text, name) {
            const lines = String(text).split(/\r?\n/); const saveName = st.scriptName; st.scriptName = name || '';
            for (const l of lines) { if (st.quit) break; await feedLine(l); }
            if (st.buf.trim() && !st.quit) { const sql = st.buf; st.buf = ''; await runSql(sql); await flushOut(true); } // 最後一句沒有分號：真的 sqlite3 也會執行
            st.scriptName = saveName;
        }
        return {
            state: st, feedLine, runScript, openDb, runSql, dotCommand, flushOut,
            prompt: () => (st.buf.trim() ? '   ...> ' : 'sqlite> '),
            banner: () => 'SQLite version ' + ver() + '\nEnter ".help" for usage hints.\n' + (st.dbPath && st.dbPath !== ':memory:' ? '' : 'Connected to a transient in-memory database.\nUse ".open FILENAME" to reopen on a persistent database.\n'),
            close: async () => { if (st.db) { try { await host.close(st.db); } catch (_) { /* */ } st.db = null; } },
        };
    }

    // ---- 命令列選項（對齊 sqlite3）----
    function parseArgs(argv) {
        const o = { file: null, sql: [], cmds: [], init: null, mode: null, headers: null, readonly: false, bail: false, echo: false, nullvalue: null, separator: null, newline: null, batch: false, version: false, help: false, errors: [], csvCli: false };
        const modeFlags = { '-ascii': 'ascii', '-box': 'box', '-column': 'column', '-csv': 'csv', '-html': 'html', '-json': 'json', '-line': 'line', '-list': 'list', '-markdown': 'markdown', '-quote': 'quote', '-table': 'table', '-tabs': 'tabs', '-tcl': 'tcl' };
        for (let i = 0; i < argv.length; i++) {
            const a = argv[i].replace(/^--/, '-');
            if (modeFlags[a]) { o.mode = modeFlags[a]; if (a === '-csv') o.csvCli = true; }
            else if (a === '-header' || a === '-headers') o.headers = true; else if (a === '-noheader') o.headers = false;
            else if (a === '-readonly') o.readonly = true; else if (a === '-bail') o.bail = true; else if (a === '-echo') o.echo = true; else if (a === '-batch') o.batch = true;
            else if (a === '-version') o.version = true; else if (a === '-help' || a === '-h') o.help = true; else if (a === '-interactive' || a === '-stats' || a === '-safe' || a === '-nofollow') { /* 不影響結果 */ }
            else if (a === '-cmd') { o.cmds.push(argv[++i]); } else if (a === '-init') { o.init = argv[++i]; } else if (a === '-separator') { o.separator = argv[++i]; } else if (a === '-newline') { o.newline = argv[++i]; } else if (a === '-nullvalue') { o.nullvalue = argv[++i]; }
            else if (/^-/.test(argv[i]) && argv[i] !== '-') { o.errors.push('sqlite3: Error: unknown option: ' + argv[i] + '\nUse -help for a list of options.'); }
            else if (o.file === null) o.file = argv[i]; else o.sql.push(argv[i]);
        }
        return o;
    }
    // 一次完整的命令列呼叫：io.stdin＝管線／重導向進來的文字（沒有就 null）；io.interactive＝沒有 SQL 也沒有 stdin 時是否進 REPL
    async function runCli(argv, host, io) {
        io = io || {}; const o = parseArgs(argv);
        if (o.errors.length) { host.writeErr(o.errors[0] + '\n'); return { exitCode: 1 }; }
        if (o.version) { host.write((host.version || '3.53.4') + ' 2026-01-01 00:00:00 (64-bit)\n'); return { exitCode: 0 }; }
        if (o.help) { host.write('Usage: sqlite3 [OPTIONS] FILENAME [SQL...]\n'); return { exitCode: 0 }; }
        const sh = create(host); const st = sh.state;
        if (o.mode) { await sh.dotCommand('.mode ' + o.mode); if (o.csvCli) { st._csvCli = true; st.rowSep = '\n'; } if (o.mode === 'table' || o.mode === 'box' || o.mode === 'markdown') st.headers = true; }
        if (o.headers !== null) st.headers = o.headers; if (o.nullvalue !== null) st.nullValue = o.nullvalue; if (o.separator !== null) st.colSep = o.separator; if (o.newline !== null) st.rowSep = o.newline; st.bail = o.bail; st.echo = o.echo;
        try { await sh.openDb(o.file || host.defaultDb || ':memory:', { readonly: o.readonly, create: !o.readonly }); } catch (e) { host.writeErr('Error: unable to open database "' + (o.file || '') + '": ' + (e && e.message || e) + '\n'); return { exitCode: 1 }; }
        if (o.init) { try { await sh.runScript(await host.io.readText(o.init), o.init); } catch (e) { host.writeErr('Error: cannot open "' + o.init + '"\n'); return { exitCode: 1 }; } }
        for (const c of o.cmds) { if (st.quit) break; await sh.runScript(c, '-cmd'); }
        if (o.sql.length) { for (const s of o.sql) { if (st.quit) break; await sh.runScript(s, 'arg'); } }
        else if (io.stdin != null) await sh.runScript(io.stdin, 'stdin');
        else if (io.interactive && !st.quit) { host.write(sh.banner()); return { exitCode: st.exitCode, shell: sh, interactive: true }; }
        await sh.flushOut(true); await sh.close(); return { exitCode: st.exitCode };
    }
    return { create, parseArgs, runCli, MODES, cellText, sqlQuote, realText, splitSql: SPLIT.split };
});
