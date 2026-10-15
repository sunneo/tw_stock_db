/* 資料檢視器的核心（UMD，純函式，不碰 DOM）：JSON／YAML／TOML／CSV 的解析與轉出、上色、JSON→表格（CSV／XLSX）、XLSX 讀寫、樹展開、搜尋。
 * YAML 的解析與輸出由呼叫端提供（deps.yamlLoad／deps.yamlDump：js-yaml 的 load／dump），XLSX 的 zip 由呼叫端提供（deps.JSZip）。
 * 設計見 DESIGN.data-viewers.md。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaDataCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ===== 小工具 =====
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const isPrim = (v) => v === null || typeof v !== 'object';
    const MAX_CELL = 32767, MAX_ROWS = 1048575;

    // ===== 格式判斷 =====
    function detectFormat(text, hint) {
        const h = String(hint || '').toLowerCase();
        if (h === 'json' || h === 'jsonc' || h === 'json5') return 'json';
        if (h === 'yaml' || h === 'yml') return 'yaml';
        if (h === 'toml') return 'toml';
        if (h === 'csv' || h === 'tsv') return h;
        const t = String(text || '').trimStart();
        if (t[0] === '{') return 'json';
        if (/^\[\[?[A-Za-z0-9_."' -]+\]\]?\s*$/m.test(t) && /^\s*[\w."-]+\s*=/m.test(t)) return 'toml';
        if (t[0] === '[') return 'json';
        return 'yaml';
    }

    // ===== TOML 解析（子集：表、表陣列、點鍵、四種字串、數字、布林、日期時間（當字串）、陣列、行內表）=====
    function parseToml(src) {
        let i = 0; const n = src.length; let line = 1;
        const err = (m) => { const e = new Error(m); e.line = line; throw e; };
        const peek = () => src[i];
        const skipWs = () => { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; };
        const skipComment = () => { if (src[i] === '#') while (i < n && src[i] !== '\n') i++; };
        const skipLine = () => { skipWs(); skipComment(); if (src[i] === '\r') i++; if (i < n && src[i] === '\n') { i++; line++; } else if (i < n) err('這一行後面多了東西'); };
        const skipBlank = () => { for (;;) { skipWs(); skipComment(); if (src[i] === '\r') i++; if (src[i] === '\n') { i++; line++; continue; } break; } };
        const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        function basicStr(multi) {
            let out = '';
            for (;;) {
                if (i >= n) err('字串沒有結尾');
                const c = src[i];
                if (multi) { if (src.startsWith('"""', i)) { let extra = 0; while (src[i + 3 + extra] === '"' && extra < 2) extra++; out += '"'.repeat(extra); i += 3 + extra; return out; } }
                else { if (c === '"') { i++; return out; } if (c === '\n') err('字串沒有結尾'); }
                if (c === '\\') {
                    i++; const e = src[i];
                    if (e === 'u' || e === 'U') { const len = e === 'u' ? 4 : 8; out += String.fromCodePoint(parseInt(src.substr(i + 1, len), 16)); i += len + 1; continue; }
                    if (multi && (e === '\n' || e === '\r' || e === ' ' || e === '\t')) { while (i < n && /[ \t\r\n]/.test(src[i])) { if (src[i] === '\n') line++; i++; } continue; }
                    if (!(e in ESC)) err('不認得的跳脫字元 \\' + e);
                    out += ESC[e]; i++; continue;
                }
                if (c === '\n') line++;
                out += c; i++;
            }
        }
        function litStr(multi) {
            let out = '';
            for (;;) {
                if (i >= n) err('字串沒有結尾');
                if (multi) { if (src.startsWith("'''", i)) { i += 3; return out; } } else { if (src[i] === "'") { i++; return out; } if (src[i] === '\n') err('字串沒有結尾'); }
                if (src[i] === '\n') line++;
                out += src[i++];
            }
        }
        function str() {
            if (src.startsWith('"""', i)) { i += 3; if (src[i] === '\r') i++; if (src[i] === '\n') { i++; line++; } return basicStr(true); }
            if (src.startsWith("'''", i)) { i += 3; if (src[i] === '\r') i++; if (src[i] === '\n') { i++; line++; } return litStr(true); }
            if (src[i] === '"') { i++; return basicStr(false); }
            i++; return litStr(false);
        }
        function keyPart() {
            skipWs();
            if (src[i] === '"' || src[i] === "'") return src[i] === '"' ? (i++, basicStr(false)) : (i++, litStr(false));
            const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 200)); if (!m) err('鍵名不合法'); i += m[0].length; return m[0];
        }
        function keyPath() { const ks = [keyPart()]; for (;;) { skipWs(); if (src[i] === '.') { i++; ks.push(keyPart()); } else break; } return ks; }
        function value() {
            skipWs(); const c = src[i];
            if (c === '"' || c === "'") return str();
            if (c === '[') {
                i++; const arr = [];
                for (;;) { skipBlank(); if (src[i] === ']') { i++; return arr; } arr.push(value()); skipBlank(); if (src[i] === ',') { i++; continue; } skipBlank(); if (src[i] === ']') { i++; return arr; } err('陣列裡缺少逗號或結尾'); }
            }
            if (c === '{') {
                i++; const o = {};
                for (;;) { skipWs(); if (src[i] === '}') { i++; return o; } const ks = keyPath(); skipWs(); if (src[i] !== '=') err('行內表缺少 ='); i++; setPath(o, ks, value()); skipWs(); if (src[i] === ',') { i++; continue; } skipWs(); if (src[i] === '}') { i++; return o; } err('行內表缺少逗號或結尾'); }
            }
            const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 200)); if (!m) err('缺少值'); const tok = m[0]; i += tok.length;
            if (tok === 'true') return true; if (tok === 'false') return false;
            if (/^[+-]?(inf|nan)$/.test(tok)) return tok.indexOf('nan') >= 0 ? NaN : (tok[0] === '-' ? -Infinity : Infinity);
            if (/^[+-]?(0|[1-9](_?\d)*)$/.test(tok)) return parseInt(tok.replace(/_/g, ''), 10);
            if (/^0x[0-9a-fA-F_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ''), 16);
            if (/^0o[0-7_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ''), 8);
            if (/^0b[01_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ''), 2);
            if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(tok)) return parseFloat(tok.replace(/_/g, ''));
            if (/^\d{4}-\d\d-\d\d([Tt ]\d\d:\d\d(:\d\d(\.\d+)?)?([Zz]|[+-]\d\d:\d\d)?)?$/.test(tok) || /^\d\d:\d\d:\d\d(\.\d+)?$/.test(tok)) {
                // 日期時間：TOML 日期若帶空格（"1979-05-27 07:32:00Z"）會被切在空格，這裡把後半接上
                let d = tok; const m2 = /^[ ]\d\d:\d\d(:\d\d(\.\d+)?)?([Zz]|[+-]\d\d:\d\d)?/.exec(src.slice(i, i + 40)); if (m2 && /^\d{4}-\d\d-\d\d$/.test(tok)) { d += m2[0]; i += m2[0].length; } return d;
            }
            err('不認得的值：' + tok);
        }
        function setPath(o, ks, v) { let cur = o; for (let k = 0; k < ks.length - 1; k++) { const key = ks[k]; if (!(key in cur)) cur[key] = {}; cur = Array.isArray(cur[key]) ? cur[key][cur[key].length - 1] : cur[key]; if (!isObj(cur)) err('鍵名 ' + key + ' 已經被當成別的型別'); } const last = ks[ks.length - 1]; if (last in cur) err('鍵名 ' + last + ' 重複了'); cur[last] = v; }
        const rootObj = {}; let cur = rootObj;
        for (;;) {
            skipBlank(); if (i >= n) break;
            if (src[i] === '[') {
                const arrT = src[i + 1] === '['; i += arrT ? 2 : 1; const ks = keyPath(); skipWs();
                if (!src.startsWith(arrT ? ']]' : ']', i)) err('表的標頭缺少 ]'); i += arrT ? 2 : 1;
                let o = rootObj;
                for (let k = 0; k < ks.length; k++) {
                    const key = ks[k]; const lastK = k === ks.length - 1;
                    if (lastK && arrT) { if (!(key in o)) o[key] = []; if (!Array.isArray(o[key])) err('鍵名 ' + key + ' 已經不是陣列'); const nw = {}; o[key].push(nw); o = nw; }
                    else { if (!(key in o)) o[key] = {}; o = Array.isArray(o[key]) ? o[key][o[key].length - 1] : o[key]; if (!isObj(o)) err('鍵名 ' + key + ' 已經被當成別的型別'); }
                }
                cur = o; skipLine(); continue;
            }
            const ks = keyPath(); skipWs(); if (src[i] !== '=') err('缺少 ='); i++; const v = value(); setPath(cur, ks, v); skipLine();
        }
        return rootObj;
    }

    // ===== TOML 輸出 =====
    function tomlKey(k) { return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k); }
    function tomlVal(v) {
        if (v === null || v === undefined) return '""';
        if (typeof v === 'string') return JSON.stringify(v);
        if (typeof v === 'number') return Number.isFinite(v) ? String(v) : (Number.isNaN(v) ? 'nan' : (v > 0 ? 'inf' : '-inf'));
        if (typeof v === 'boolean') return String(v);
        if (Array.isArray(v)) return '[' + v.map(tomlVal).join(', ') + ']';
        return '{ ' + Object.keys(v).filter((k) => v[k] !== null && v[k] !== undefined).map((k) => tomlKey(k) + ' = ' + tomlVal(v[k])).join(', ') + ' }';
    }
    function stringifyToml(obj) {
        const out = [];
        (function emit(o, path) {
            const tables = [], arrT = [];
            for (const k of Object.keys(o)) {
                const v = o[k]; if (v === null || v === undefined) continue;
                if (isObj(v)) tables.push(k); else if (Array.isArray(v) && v.length && v.every(isObj)) arrT.push(k); else out.push(tomlKey(k) + ' = ' + tomlVal(v));
            }
            for (const k of tables) { const p = path.concat(k); out.push('', '[' + p.map(tomlKey).join('.') + ']'); emit(o[k], p); }
            for (const k of arrT) { const p = path.concat(k); for (const el of o[k]) { out.push('', '[[' + p.map(tomlKey).join('.') + ']]'); emit(el, p); } }
        })(isObj(obj) ? obj : { value: obj }, []);
        return out.join('\n').replace(/^\n+/, '') + '\n';
    }

    // ===== CSV =====
    function parseCsv(text, delim) {
        text = String(text || '').replace(/^\ufeff/, '');
        if (!delim) { const first = text.split('\n', 1)[0]; const cnt = (c) => first.split(c).length - 1; delim = cnt('\t') > cnt(',') && cnt('\t') >= cnt(';') ? '\t' : (cnt(';') > cnt(',') ? ';' : ','); }
        const rows = []; let row = [], f = '', q = false, i = 0; const n = text.length;
        while (i < n) {
            const c = text[i];
            if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; } f += c; i++; continue; }
            if (c === '"' && f === '') { q = true; i++; continue; }
            if (c === delim) { row.push(f); f = ''; i++; continue; }
            if (c === '\r') { i++; continue; }
            if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; continue; }
            f += c; i++;
        }
        if (f !== '' || row.length) { row.push(f); rows.push(row); }
        return { rows, delim };
    }
    function csvCell(v, delim) { let s = v === null || v === undefined ? '' : String(v); if (s.length > MAX_CELL) s = s.slice(0, MAX_CELL); return /["\r\n]/.test(s) || s.indexOf(delim) >= 0 ? '"' + s.replace(/"/g, '""') + '"' : s; }
    function sheetToCsv(sheet, opts) {
        opts = opts || {}; const d = opts.delim || ','; const lines = [sheet.columns.map((c) => csvCell(c, d)).join(d)];
        for (const r of sheet.rows) lines.push(sheet.columns.map((_, k) => csvCell(r[k], d)).join(d));
        return (opts.bom === false ? '' : '\ufeff') + lines.join('\r\n') + '\r\n';
    }

    // ===== 解析（統一入口）=====
    function parse(text, fmt, deps) {
        deps = deps || {};
        try {
            if (fmt === 'json') return { ok: true, data: JSON.parse(text) };
            if (fmt === 'yaml') {
                if (!deps.yamlLoad) return { ok: false, error: { message: 'YAML 解析器還沒載入' }, needDeps: 'yaml' };
                const docs = []; try { deps.yamlLoadAll ? deps.yamlLoadAll(text, (d) => docs.push(d)) : docs.push(deps.yamlLoad(text)); } catch (e) { throw e; }
                return { ok: true, data: docs.length > 1 ? docs : docs[0] };
            }
            if (fmt === 'toml') return { ok: true, data: parseToml(text) };
            if (fmt === 'csv' || fmt === 'tsv') { const r = parseCsv(text, fmt === 'tsv' ? '\t' : undefined); const head = r.rows[0] || []; return { ok: true, data: { columns: head, rows: r.rows.slice(1) }, table: true }; }
        } catch (e) {
            let line = e.line || (e.mark && e.mark.line + 1) || null, col = (e.mark && e.mark.column + 1) || null;
            if (!line) { const m = /position (\d+)/.exec(e.message || ''); if (m) { const pos = +m[1]; const up = String(text).slice(0, pos); line = up.split('\n').length; col = pos - up.lastIndexOf('\n'); } }
            return { ok: false, error: { message: String(e.reason || e.message || e).split('\n')[0], line, col } };
        }
        return { ok: false, error: { message: '不支援的格式 ' + fmt } };
    }
    function stringify(data, fmt, deps) {
        deps = deps || {};
        if (fmt === 'json') return JSON.stringify(data, null, 2) + '\n';
        if (fmt === 'yaml') { if (!deps.yamlDump) throw new Error('YAML 輸出器還沒載入'); return deps.yamlDump(data, { lineWidth: -1, noRefs: true }); }
        if (fmt === 'toml') return stringifyToml(data);
        throw new Error('不支援輸出 ' + fmt);
    }

    // ===== 上色：每行回傳 token 陣列 [{c: 類別, t: 文字}]；類別 k=鍵 s=字串 n=數字 b=布林 z=null p=標點 c=註解 h=標題 a=錨點 d=日期 x=一般 =====
    const JSON_RE = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}\[\],:])|(\s+)|([^\s"{}\[\],:]+)/g;
    function tokJsonLine(s) {
        const out = []; let m; JSON_RE.lastIndex = 0;
        while ((m = JSON_RE.exec(s))) {
            if (m[1] !== undefined) { if (m[2]) { out.push({ c: 'k', t: m[1] }, { c: 'p', t: m[2] }); } else out.push({ c: 's', t: m[1] }); }
            else if (m[3] !== undefined) out.push({ c: 'n', t: m[3] }); else if (m[4] !== undefined) out.push({ c: 'b', t: m[4] }); else if (m[5] !== undefined) out.push({ c: 'z', t: m[5] });
            else if (m[6] !== undefined) out.push({ c: 'p', t: m[6] }); else out.push({ c: 'x', t: m[0] });
        }
        return out;
    }
    function scalarTok(v) {
        const t = v.trim(); if (!t) return { c: 'x', t: v };
        let c = 'x';
        if (/^(["']).*\1$/.test(t)) c = 's'; else if (/^(true|false|yes|no|on|off)$/i.test(t)) c = 'b'; else if (/^(null|~)$/i.test(t)) c = 'z';
        else if (/^[+-]?(\d[\d_]*)(\.\d+)?([eE][+-]?\d+)?$|^0x[0-9a-fA-F]+$|^[+-]?\.(inf|nan)$/i.test(t)) c = 'n'; else if (/^\d{4}-\d\d-\d\d/.test(t)) c = 'd'; else if (/^[&*]/.test(t)) c = 'a'; else c = 's';
        return { c, t: v };
    }
    function splitComment(s) { // 找出不在引號裡的 " #"
        let q = ''; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (q) { if (ch === '\\' && q === '"') i++; else if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return [s.slice(0, i), s.slice(i)]; }
        return [s, ''];
    }
    function tokYamlLines(lines) {
        const res = []; let blockIndent = -1;
        for (const line of lines) {
            const ind = /^\s*/.exec(line)[0].length;
            if (blockIndent >= 0) { if (line.trim() === '' || ind > blockIndent) { res.push([{ c: 's', t: line }]); continue; } blockIndent = -1; }
            if (/^\s*#/.test(line)) { res.push([{ c: 'c', t: line }]); continue; }
            if (/^(---|\.\.\.)\s*$/.test(line)) { res.push([{ c: 'p', t: line }]); continue; }
            const [body, cmt] = splitComment(line); const out = [];
            const m = /^(\s*(?:-\s+)*)((?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s#:'"\-\[{][^#:]*?|-[^\s#:][^#:]*?))(\s*:)(\s+|$)(.*)$/.exec(body);
            if (m) {
                if (m[1]) out.push({ c: 'p', t: m[1] }); out.push({ c: 'k', t: m[2] }, { c: 'p', t: m[3] }); if (m[4]) out.push({ c: 'x', t: m[4] });
                const v = m[5]; if (/^[|>][+-]?\d*\s*$/.test(v.trim())) { out.push({ c: 'p', t: v }); blockIndent = ind; } else if (v) out.push(scalarTok(v));
            } else {
                const mm = /^(\s*(?:-\s*)+)(.*)$/.exec(body);
                if (mm) { out.push({ c: 'p', t: mm[1] }); if (mm[2]) { if (/^[|>][+-]?\d*\s*$/.test(mm[2].trim())) { out.push({ c: 'p', t: mm[2] }); blockIndent = ind; } else out.push(scalarTok(mm[2])); } }
                else if (body) out.push(scalarTok(body));
            }
            if (cmt) out.push({ c: 'c', t: cmt }); res.push(out.length ? out : [{ c: 'x', t: line }]);
        }
        return res;
    }
    function tokTomlLines(lines) {
        const res = []; let multi = '';
        for (const line of lines) {
            if (multi) { const e = line.indexOf(multi); if (e >= 0) { res.push([{ c: 's', t: line.slice(0, e + 3) }, ...tokTomlValue(line.slice(e + 3))]); multi = ''; } else res.push([{ c: 's', t: line }]); continue; }
            if (/^\s*#/.test(line)) { res.push([{ c: 'c', t: line }]); continue; }
            const h = /^(\s*)(\[\[?)([^\]]+)(\]\]?)(.*)$/.exec(line);
            if (h) { res.push([{ c: 'x', t: h[1] }, { c: 'p', t: h[2] }, { c: 'h', t: h[3] }, { c: 'p', t: h[4] }, ...tokTomlValue(h[5])]); continue; }
            const kv = /^(\s*)((?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_.-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*))(\s*=)(\s*)(.*)$/.exec(line);
            if (kv) {
                const toks = [{ c: 'x', t: kv[1] }, { c: 'k', t: kv[2] }, { c: 'p', t: kv[3] }, { c: 'x', t: kv[4] }];
                const v = kv[5]; const ml = v.startsWith('"""') ? '"""' : (v.startsWith("'''") ? "'''" : '');
                if (ml && v.indexOf(ml, 3) < 0) { multi = ml; toks.push({ c: 's', t: v }); } else toks.push(...tokTomlValue(v));
                res.push(toks); continue;
            }
            res.push([{ c: 'x', t: line }]);
        }
        return res;
    }
    function tokTomlValue(v) {
        const out = []; const re = /("(?:\\.|[^"\\])*"|'[^']*')|(#.*$)|(\b(?:true|false)\b)|(\d{4}-\d\d-\d\d(?:[Tt ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:[Zz]|[+-]\d\d:\d\d)?)?)|([+-]?(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|inf|nan))|([\[\]{},=])|(\s+)|([^\s\[\]{},=#"']+)/g; let m;
        while ((m = re.exec(v))) { const c = m[1] ? 's' : m[2] ? 'c' : m[3] ? 'b' : m[4] ? 'd' : m[5] ? 'n' : m[6] ? 'p' : 'x'; out.push({ c, t: m[0] }); }
        return out;
    }
    function tokCsvLine(s, delim) {
        const out = []; let i = 0; const d = delim || ',';
        while (i < s.length) { if (s[i] === d) { out.push({ c: 'p', t: d }); i++; continue; } let j = i; if (s[i] === '"') { j = i + 1; while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') j += 2; else { j++; break; } } else j++; } out.push({ c: 's', t: s.slice(i, j) }); } else { while (j < s.length && s[j] !== d) j++; const cell = s.slice(i, j); out.push({ c: /^-?\d+(\.\d+)?$/.test(cell.trim()) ? 'n' : 'x', t: cell }); } i = j; }
        return out;
    }
    function highlight(text, fmt) {
        const lines = String(text).split('\n').map((l) => l.replace(/\r$/, ''));
        if (fmt === 'json') return lines.map(tokJsonLine);
        if (fmt === 'yaml') return tokYamlLines(lines);
        if (fmt === 'toml') return tokTomlLines(lines);
        if (fmt === 'csv' || fmt === 'tsv') return lines.map((l) => tokCsvLine(l, fmt === 'tsv' ? '\t' : ','));
        return lines.map((l) => [{ c: 'x', t: l }]);
    }
    // 單行很長的 JSON（壓縮過）：Source 顯示排版後的版本
    function prettyIfMinified(text, fmt) {
        if (fmt !== 'json') return { text, pretty: false };
        const lines = text.split('\n').length; if (lines > 3 || text.length < 400) return { text, pretty: false };
        try { return { text: JSON.stringify(JSON.parse(text), null, 2), pretty: true }; } catch (_) { return { text, pretty: false }; }
    }

    // ===== JSON → 表格 =====
    const ID_KEYS = ['SPDXID', 'spdxId', 'id', '@id', 'bom-ref', 'purl', 'name'];
    function safeSheetName(name, used) {
        let s = String(name || 'sheet').replace(/[\[\]:*?\/\\]/g, '_').replace(/^'+|'+$/g, '').slice(0, 31) || 'sheet'; let u = s, k = 2;
        while (used.has(u.toLowerCase())) { const suf = '~' + k++; u = s.slice(0, 31 - suf.length) + suf; }
        used.add(u.toLowerCase()); return u;
    }
    function cellValue(v) {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v.length > MAX_CELL ? v.slice(0, MAX_CELL) : v;
        if (typeof v === 'number' || typeof v === 'boolean') return v;
        let s; try { s = JSON.stringify(v); } catch (_) { s = String(v); } return s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s;
    }
    function isObjArray(a) { if (!Array.isArray(a) || !a.length) return false; let o = 0; for (const x of a) if (isObj(x)) o++; return o >= Math.max(1, Math.ceil(a.length * 0.6)); }
    // 把一個物件攤平：巢狀物件用點；原始型別陣列用 "; "；物件陣列交給 onChild
    function flattenObj(o, prefix, out, onChild, depth) {
        for (const k of Object.keys(o)) {
            const v = o[k], p = prefix ? prefix + '.' + k : k;
            if (isPrim(v)) out[p] = v;
            else if (Array.isArray(v)) {
                if (!v.length) out[p] = '';
                else if (v.every(isPrim)) out[p] = v.map((x) => (x === null ? '' : String(x))).join('; ');
                else if (isObjArray(v) && depth < 4) onChild(p, v);
                else out[p] = JSON.stringify(v);
            } else if (depth < 6) flattenObj(v, p, out, onChild, depth + 1); else out[p] = JSON.stringify(v);
        }
        return out;
    }
    function toTables(data, opts) {
        opts = opts || {}; const used = new Set(); const sheets = []; const notes = [];
        const rootName = opts.rootName || 'data';
        function addSheet(name, objs, parent, kind) {
            const sheet = { name: safeSheetName(name, used), baseName: name, columns: [], rows: [], kind: kind || 'rows' };
            sheets.push(sheet); const colIdx = new Map(); const rowsObj = [];
            const getCol = (c) => { let i = colIdx.get(c); if (i === undefined) { i = sheet.columns.length; sheet.columns.push(c); colIdx.set(c, i); } return i; };
            if (parent) { getCol('_parent'); getCol('_parent_id'); }
            const take = Math.min(objs.length, MAX_ROWS); if (objs.length > take) notes.push(sheet.baseName + '：共 ' + objs.length + ' 列，只匯出前 ' + take + ' 列');
            for (let r = 0; r < take; r++) {
                const el = objs[r]; const flat = isObj(el) ? el : { value: el }; const children = [];
                const f = flattenObj(flat, '', {}, (p, arr) => children.push([p, arr]), 0);
                const row = []; if (parent) { row[0] = parent.rowNo; row[1] = parent.id; }
                for (const k of Object.keys(f)) row[getCol(k)] = cellValue(f[k]);
                sheet.rows.push(row);
                let rid = ''; for (const key of ID_KEYS) { if (isPrim(flat[key]) && flat[key] !== undefined && flat[key] !== null && flat[key] !== '') { rid = String(flat[key]); break; } }
                for (const [p, arr] of children) addSheet(sheet.baseName + '.' + p, arr, { rowNo: r + 1, id: rid }, 'child');
            }
            for (const row of sheet.rows) for (let i = 0; i < sheet.columns.length; i++) if (row[i] === undefined) row[i] = '';
            return sheet;
        }
        function summaryOf(o) {
            const rows = []; const walk = (v, p) => { if (isPrim(v)) rows.push([p, cellValue(v), v === null ? 'null' : typeof v]); else if (Array.isArray(v)) { if (v.every(isPrim)) rows.push([p, v.map((x) => (x === null ? '' : String(x))).join('; '), 'array(' + v.length + ')']); else v.forEach((x, i) => walk(x, p + '[' + i + ']')); } else for (const k of Object.keys(v)) walk(v[k], p ? p + '.' + k : k); };
            walk(o, ''); return rows;
        }
        function splitByType(arr, name) {
            for (const tk of ['type', '@type']) {
                const groups = new Map(); let ok = true;
                for (const x of arr) { if (!isObj(x) || typeof x[tk] !== 'string') { ok = false; break; } if (!groups.has(x[tk])) groups.set(x[tk], []); groups.get(x[tk]).push(x); }
                if (ok && groups.size >= 2 && groups.size <= 30) { for (const [t, g] of groups) addSheet(name + ':' + t, g, null); return true; }
            }
            return false;
        }
        if (isObjArray(data)) { if (!splitByType(data, rootName)) addSheet(rootName, data, null); }
        else if (Array.isArray(data)) { const s = { name: safeSheetName('values', used), baseName: 'values', columns: ['index', 'value'], rows: data.map((v, i) => [i, cellValue(v)]), kind: 'rows' }; sheets.push(s); }
        else if (isObj(data)) {
            const rest = {}; let tabular = 0;
            for (const k of Object.keys(data)) { const v = data[k]; if (isObjArray(v)) { tabular++; if (!splitByType(v, k)) addSheet(k, v, null); } else rest[k] = v; }
            const keys = Object.keys(data);
            if (!tabular && keys.length >= 2 && keys.every((k) => isObj(data[k]))) { // 以 id 當鍵的字典
                const rows = keys.map((k) => Object.assign({ _key: k }, data[k])); addSheet(rootName, rows, null); }
            else { const sr = summaryOf(tabular ? rest : data); if (sr.length || !tabular) sheets.unshift({ name: safeSheetName('summary', used), baseName: 'summary', columns: ['path', 'value', 'type'], rows: sr, kind: 'summary' }); }
        } else sheets.push({ name: safeSheetName('summary', used), baseName: 'summary', columns: ['path', 'value', 'type'], rows: [['', cellValue(data), data === null ? 'null' : typeof data]], kind: 'summary' });
        const primary = sheets.reduce((b, s) => (s.kind !== 'summary' && s.kind !== 'child' && (!b || s.rows.length > b.rows.length) ? s : b), null) || sheets[0];
        if (notes.length) sheets.push({ name: safeSheetName('notes', used), baseName: 'notes', columns: ['說明'], rows: notes.map((x) => [x]), kind: 'summary' });
        return { sheets, primary: primary ? primary.name : null };
    }

    // ===== XLSX 寫入（deps.JSZip）=====
    const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
    function colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
    function sheetXml(sheet) {
        const widths = sheet.columns.map((c, i) => { let w = String(c).length; for (let r = 0; r < Math.min(sheet.rows.length, 200); r++) w = Math.max(w, String(sheet.rows[r][i] == null ? '' : sheet.rows[r][i]).length); return Math.min(60, Math.max(8, w + 2)); });
        const cell = (v, r, c, style) => {
            const ref = colLetter(c) + r;
            if (typeof v === 'number' && Number.isFinite(v)) return '<c r="' + ref + '"' + (style ? ' s="' + style + '"' : '') + '><v>' + v + '</v></c>';
            if (typeof v === 'boolean') return '<c r="' + ref + '" t="b"><v>' + (v ? 1 : 0) + '</v></c>';
            const s = v === null || v === undefined ? '' : String(v); if (s === '') return '';
            return '<c r="' + ref + '" t="inlineStr"' + (style ? ' s="' + style + '"' : '') + '><is><t xml:space="preserve">' + xmlEsc(s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s) + '</t></is></c>';
        };
        const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols><sheetData>'];
        parts.push('<row r="1">' + sheet.columns.map((c, i) => cell(String(c), 1, i, 1)).join('') + '</row>');
        for (let r = 0; r < sheet.rows.length; r++) parts.push('<row r="' + (r + 2) + '">' + sheet.rows[r].map((v, i) => cell(v, r + 2, i, 0)).join('') + '</row>');
        parts.push('</sheetData>' + (sheet.columns.length ? '<autoFilter ref="A1:' + colLetter(sheet.columns.length - 1) + (sheet.rows.length + 1) + '"/>' : '') + '</worksheet>');
        return parts.join('');
    }
    async function buildXlsx(sheets, deps) {
        const Z = deps && deps.JSZip; if (!Z) throw new Error('JSZip 還沒載入');
        if (!sheets.length) sheets = [{ name: 'Sheet1', columns: [], rows: [] }];
        { const used = new Set(); sheets = sheets.map((s) => Object.assign({}, s, { name: safeSheetName(s.name, used) })); } // Excel 的工作表名稱限制：31 字元、不能有 []:*?/\、不能重複
        const zip = new Z();
        zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>');
        zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
        zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>');
        zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
        zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>');
        sheets.forEach((s, i) => zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s)));
        return zip.generateAsync({ type: deps.outType || 'uint8array', compression: 'DEFLATE' });
    }

    // ===== XLSX 讀取（regex 解析，不需要 DOM）=====
    const xmlUnesc = (s) => String(s).replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e] || (e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10)))));
    function colIndex(ref) { let n = 0; const m = /^[A-Z]+/.exec(ref); for (const ch of m[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
    async function readXlsx(bytes, deps) {
        const Z = deps && deps.JSZip; if (!Z) throw new Error('JSZip 還沒載入');
        const zip = await Z.loadAsync(bytes); const rd = async (p) => { const f = zip.file(p); return f ? f.async('string') : ''; };
        const wb = await rd('xl/workbook.xml'), rels = await rd('xl/_rels/workbook.xml.rels'), ss = await rd('xl/sharedStrings.xml');
        const shared = []; if (ss) { const re = /<si>([\s\S]*?)<\/si>/g; let m; while ((m = re.exec(ss))) { let t = ''; const tr = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm; while ((tm = tr.exec(m[1]))) t += xmlUnesc(tm[1]); shared.push(t); } }
        const relMap = {}; { const re = /<Relationship\b[^>]*>/g; let m; while ((m = re.exec(rels))) { const id = /Id="([^"]+)"/.exec(m[0]), tg = /Target="([^"]+)"/.exec(m[0]); if (id && tg) relMap[id[1]] = tg[1]; } }
        const sheets = []; const re = /<sheet\b[^>]*>/g; let m;
        while ((m = re.exec(wb))) {
            const name = /name="([^"]*)"/.exec(m[0]), rid = /r:id="([^"]+)"/.exec(m[0]); if (!name || !rid) continue;
            let target = relMap[rid[1]] || ''; target = target.replace(/^\/?(xl\/)?/, 'xl/'); const xml = await rd(target); const rows = [];
            const rr = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g; let rm;
            while ((rm = rr.exec(xml))) {
                const row = []; const cr = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
                while ((cm = cr.exec(rm[1] || ''))) {
                    const attrs = cm[1], body = cm[2] || ''; const ref = /r="([A-Z]+\d+)"/.exec(attrs); if (!ref) continue; const t = (/t="(\w+)"/.exec(attrs) || [])[1]; let v = '';
                    if (t === 'inlineStr') { const tt = /<t[^>]*>([\s\S]*?)<\/t>/g; let x; while ((x = tt.exec(body))) v += xmlUnesc(x[1]); }
                    else { const vm = /<v>([\s\S]*?)<\/v>/.exec(body); if (vm) { const raw = xmlUnesc(vm[1]); if (t === 's') v = shared[+raw] || ''; else if (t === 'b') v = raw === '1'; else if (t === 'str' || t === 'e') v = raw; else { const num = Number(raw); v = Number.isFinite(num) ? num : raw; } } }
                    row[colIndex(ref[1])] = v;
                }
                rows.push(row);
            }
            let width = 0; for (const r of rows) width = Math.max(width, r.length);
            const grid = rows.map((r) => { const o = []; for (let i = 0; i < width; i++) o.push(r[i] === undefined ? '' : r[i]); return o; });
            const head = grid.length ? grid[0].map((x, i) => (x === '' ? colLetter(i) : String(x))) : [];
            sheets.push({ name: xmlUnesc(name[1]), columns: head, rows: grid.slice(1), kind: 'rows' });
        }
        return { sheets };
    }

    // ===== 樹（Viewer 模式）=====
    function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
    function preview(v) {
        if (v === null) return 'null'; if (Array.isArray(v)) return '[' + v.length + ']'; if (isObj(v)) return '{' + Object.keys(v).length + '}';
        if (typeof v === 'string') return JSON.stringify(v.length > 160 ? v.slice(0, 160) + '…' : v); return String(v);
    }
    // 攤成目前看得到的列。expanded 是 Set<路徑字串>；path 用 JSON 指標風格 /a/0/b。
    function visibleRows(data, expanded, opts) {
        opts = opts || {}; const rows = []; const cap = opts.cap || 200000;
        (function walk(v, key, path, depth, last) {
            if (rows.length >= cap) return;
            const container = !isPrim(v); const open = container && expanded.has(path);
            rows.push({ path, key, depth, type: typeOf(v), preview: preview(v), container, open, count: container ? (Array.isArray(v) ? v.length : Object.keys(v).length) : 0, value: container ? undefined : v });
            if (open) { if (Array.isArray(v)) v.forEach((x, i) => walk(x, String(i), path + '/' + i, depth + 1)); else for (const k of Object.keys(v)) walk(v[k], k, path + '/' + k.replace(/~/g, '~0').replace(/\//g, '~1'), depth + 1); }
        })(data, '', '', 0);
        return rows;
    }
    function defaultExpanded(data, maxDepth, maxNodes) {
        const set = new Set(); let nodes = 0;
        (function walk(v, path, depth) { if (isPrim(v) || depth >= maxDepth || nodes > maxNodes) return; set.add(path); const ks = Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v); nodes += ks.length; for (const k of ks.slice(0, 200)) walk(v[k], path + '/' + String(k).replace(/~/g, '~0').replace(/\//g, '~1'), depth + 1); })(data, '', 0);
        return set;
    }
    // 找出鍵名或值含關鍵字的節點路徑（上限 maxHits），並回傳要展開的祖先
    function searchTree(data, q, opts) {
        opts = opts || {}; const max = opts.max || 2000; const needle = String(q).toLowerCase(); const hits = []; const open = new Set();
        if (!needle) return { hits, open };
        (function walk(v, key, path) {
            if (hits.length >= max) return;
            const kHit = key !== '' && String(key).toLowerCase().includes(needle); const vHit = isPrim(v) && v !== null && String(v).toLowerCase().includes(needle);
            if (kHit || vHit) { hits.push(path); const segs = path.split('/'); for (let i = 1; i < segs.length; i++) open.add(segs.slice(0, i).join('/')); }
            if (!isPrim(v)) { if (Array.isArray(v)) v.forEach((x, i) => walk(x, String(i), path + '/' + i)); else for (const k of Object.keys(v)) walk(v[k], k, path + '/' + k.replace(/~/g, '~0').replace(/\//g, '~1')); }
        })(data, '', '');
        return { hits, open };
    }
    function getByPath(data, path) { let cur = data; for (const seg of path.split('/').slice(1)) { if (cur === null || typeof cur !== 'object') return undefined; cur = cur[seg.replace(/~1/g, '/').replace(/~0/g, '~')]; } return cur; }
    // 文字搜尋（Source 模式）：回傳 [{line, col, len}]
    function searchText(lines, q, opts) {
        opts = opts || {}; const max = opts.max || 5000; const needle = String(q).toLowerCase(); const hits = []; if (!needle) return hits;
        for (let i = 0; i < lines.length && hits.length < max; i++) { const l = lines[i].toLowerCase(); let p = 0; while ((p = l.indexOf(needle, p)) >= 0 && hits.length < max) { hits.push({ line: i, col: p, len: needle.length }); p += needle.length || 1; } }
        return hits;
    }
    // 給 AI 看的結構概要（不含大量資料）
    function outline(data, opts) {
        opts = opts || {}; const maxDepth = opts.maxDepth || 3;
        const walk = (v, d) => {
            if (isPrim(v)) return typeOf(v);
            if (Array.isArray(v)) return 'array(' + v.length + ')' + (v.length && d < maxDepth ? ' 每筆≈' + JSON.stringify(walk(v[0], d + 1)) : '');
            if (d >= maxDepth) return 'object(' + Object.keys(v).length + ')';
            const o = {}; const ks = Object.keys(v); ks.slice(0, 30).forEach((k) => { o[k] = walk(v[k], d + 1); }); if (ks.length > 30) o['…'] = '還有' + (ks.length - 30) + '個欄位'; return o;
        };
        const s = JSON.stringify(walk(data, 0)); return s.length > (opts.maxChars || 3000) ? s.slice(0, opts.maxChars || 3000) + '…' : s;
    }

    return { detectFormat, parse, stringify, parseToml, stringifyToml, parseCsv, sheetToCsv, highlight, prettyIfMinified, toTables, buildXlsx, readXlsx, visibleRows, defaultExpanded, searchTree, searchText, getByPath, outline, preview, typeOf, colLetter, isObj };
});
