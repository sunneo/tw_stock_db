/* 文法自己發現（FaGram）：給一份沒看過的「行導向、用縮排或括號分區塊」的文字格式（YAML、BitBake 的 .bb／.bbappend／local.conf、Makefile、
 * Dockerfile、nginx 設定、INI 類…），程式從文字本身一層一層找出它的規則，存成一份「文法」資料，再用這份文法解析全文、查詢、比較。
 *
 * 不是通用的文法學習（那在理論上做不到：只看例句學不出正確的文脈自由文法），而是針對這一族格式的分層帰納：
 *   ① 詞彙層：註解記號、行尾續行、引號、括號對、變數引用（$ 加括號）
 *   ② 行層：賦值的「運算子」是什麼（=、:=、?=、??=、+=、:、=>…，從文字中統計，不是事先列好）、鍵名後面的「修飾」（:append、:qemux86-64、_append）、
 *      行首的關鍵字（inherit、FROM、include…）、清單記號（- ）、指令記號（!include）、區段標題（[x]）、函式（name() { }）
 *   ③ 結構層：靠縮排還是靠大括號分區塊；函式本體當成不解析的原文
 *   ④ 驗證：用學到的文法解析全文，涵蓋率＝被某條規則吃掉的陳述佔多少；吃不掉的列出來（不假裝都懂）
 *   ⑤ 邊讀邊學：extend() 讀新的文字，只補文法裡沒有的規則（新的運算子、新的關鍵字…）
 * 產出：文法（資料）、解析樹、EBNF／ANTLR 風格的文字描述。全部是純函式，不呼叫模型。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaGram = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const OPCH = '=:?+.!<>~&|';
    const COMMENT_CANDIDATES = ['#', '//', ';', '--'];
    const SECRET_KEY = /(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|auth|passphrase)/i;
    const redact = (key, value) => (key && SECRET_KEY.test(key) && String(value).trim() !== '' ? '***（已遮蔽）' : String(value).replace(/(:\/\/[^\/\s:@]+:)[^@\s\/]+@/g, '$1***@'));
    const VT = [['bool', /^(?:true|false|yes|no|on|off)$/i], ['guid', /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i], ['hex', /^0x[0-9a-f]+$/i], ['int', /^[+-]?\d+$/], ['float', /^[+-]?\d+\.\d+$/], ['version', /^v?\d+(?:\.\d+){1,3}$/], ['url', /^[a-z][a-z0-9+.-]*:\/\/\S+$/i], ['path', /^(?:[A-Za-z]:)?(?:[\\/]|\.{1,2}[\\/])\S*$|^[\w.$(){}-]+(?:[\\/][\w.$(){}@+-]+)+$/]];
    function valueType(raw) {
        const v = String(raw == null ? '' : raw).trim(); if (v === '') return 'empty'; if (/^(?:"[^"]*"|'[^']*')$/.test(v)) { const t = valueType(v.slice(1, -1)); return ['path', 'url', 'guid'].includes(t) ? t : 'string'; }
        if (/^\[.*\]$/.test(v)) return 'array'; if (/^\{.*\}$/.test(v)) return 'table'; for (const [t, re] of VT) if (re.test(v)) return t; return 'string';
    }
    const indentOf = (s) => { let n = 0; for (const c of s) { if (c === ' ') n++; else if (c === '\t') n += 4; else break; } return n; };

    // ---------- ① 切成「邏輯行」（接續行合併）----------
    function logical(lines, g) {
        const out = []; const cont = g && g.continuation; let acc = null;
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (acc) { acc.text += ' ' + l.trim().replace(/\\$/, '').trim(); acc.end = i + 1; acc.contLines++; if (!(cont && /\\\s*$/.test(l))) { out.push(acc); acc = null; } continue; }
            if (cont && /\\\s*$/.test(l) && l.trim() !== '\\') { acc = { n: i + 1, end: i + 1, indent: indentOf(l), text: l.replace(/\\\s*$/, '').trim(), raw: l, contLines: 0 }; continue; }
            out.push({ n: i + 1, end: i + 1, indent: indentOf(l), text: l.trim(), raw: l, contLines: 0 });
        }
        if (acc) out.push(acc); return out;
    }
    // 掃描一行：回傳在「引號、$ 括號」之外的位置判斷用的遮罩（inside[i]=true 表示在字串或變數引用裡）
    function insideMask(text, g) {
        const q = new Set((g && g.quotes) || ['"', "'"]); const mask = new Array(text.length).fill(false); let quote = null; let depth = 0; const sig = (g && g.refSigils) || ['$'];
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (quote) { mask[i] = true; if (c === '\\') { i++; if (i < text.length) mask[i] = true; continue; } if (c === quote) quote = null; continue; }
            if (q.has(c) && !(c === "'" && i > 0 && /\w/.test(text[i - 1]))) { quote = c; mask[i] = true; continue; }
            if (sig.includes(c) && /[{(]/.test(text[i + 1] || '')) { const open = text[i + 1]; const close = open === '{' ? '}' : ')'; let j = i + 2, d = 1; while (j < text.length && d) { if (text[j] === open) d++; else if (text[j] === close) d--; j++; } for (let k = i; k < j; k++) mask[k] = true; i = j - 1; continue; }
        }
        return mask;
    }
    function stripTrailingComment(text, g) {
        const leaders = (g && g.comment && g.comment.trailing) || []; if (!leaders.length) return { code: text, comment: null }; const m = insideMask(text, g);
        for (let i = 1; i < text.length; i++) { if (m[i] || !/\s/.test(text[i - 1])) continue; for (const ld of leaders) if (text.startsWith(ld, i) && !(ld === '#' && text[i + 1] === '{')) return { code: text.slice(0, i).trimEnd(), comment: text.slice(i + ld.length).trim() }; }
        return { code: text, comment: null };
    }

    // ---------- ② 找運算子：最左邊、在字串之外、夾在鍵與值之間的符號串 ----------
    // 規則：符號串（由 OPCH 組成）含「=」，前面是字元或空白、後面不是符號；或剛好是「:」且後面是空白／行尾。「:append」這種冒號後面緊接字母的，是鍵名的修飾，不是運算子。
    function findOp(text, g, accept) {
        const mask = insideMask(text, g); const chars = (g && g.opChars) || OPCH;
        for (let i = 0; i < text.length; i++) {
            if (mask[i] || chars.indexOf(text[i]) < 0) continue; let j = i; while (j < text.length && !mask[j] && chars.indexOf(text[j]) >= 0) j++; const run = text.slice(i, j); const next = text[j]; const prev = text[i - 1];
            const isEq = run.indexOf('=') >= 0 && prev !== undefined && /[\w}\]"'\s)]/.test(prev) && !(run.indexOf('=') >= 0 && /^=+$/.test(run) && run.length > 2);
            const isColon = run === ':' && (next === undefined || /\s/.test(next)) && prev !== undefined && !/\s/.test(prev);
            const learned = !!accept && run !== ':' && accept.includes(run) && prev !== undefined && /[\w}\]"'\s)]/.test(prev);
            if ((isEq || isColon || learned) && (!accept || accept.includes(run))) { const lhs = text.slice(0, i).trim(); if (!lhs) { i = j - 1; continue; } return { op: run, at: i, lhs, rhs: text.slice(j).trim() }; }
            i = j - 1;
        }
        return null;
    }
    function splitLhs(lhs, g) {
        // 修飾：保留字（export、DEFINE…）＋ 名稱 ＋ :qualifier… ＋ [flag]
        let parts = lhs.trim().split(/\s+/); let modifier = null; if (parts.length === 2 && /^[A-Za-z_][\w-]*$/.test(parts[0])) { modifier = parts[0]; parts = [parts[1]]; } if (parts.length !== 1) return null;
        let name = parts[0]; let flag = null; const fm = /^(.*?)\[([^\]]*)\]$/.exec(name); if (fm) { name = fm[1]; flag = fm[2]; }
        const seps = (g && g.qualifierSeps) || []; const quals = []; if (seps.includes(':') && name.indexOf(':') > 0) { const ps = name.split(':'); name = ps[0]; for (const q of ps.slice(1)) quals.push(q); }
        const us = (g && g.underSuffixes) || []; for (const s of us) if (name.length > s.length + 1 && name.endsWith('_' + s)) { name = name.slice(0, -(s.length + 1)); quals.unshift('_' + s); break; }
        if (!name) return null; return { name, quals, modifier, flag };
    }
    const refsOf = (text, g) => { const out = []; const sig = (g && g.refSigils) || ['$']; const re = new RegExp('[' + sig.map((s) => s.replace(/[\\\]^-]/g, '\\$&')).join('') + '][{(]([^})]+)[})]', 'g'); let m; while ((m = re.exec(text))) out.push(m[1]); return out; };
    const unquote = (v) => { const m = /^(["'])([\s\S]*)\1$/.exec(v.trim()); return m ? m[2] : v.trim(); };

    // ---------- ③ 依文法解析一個陳述（文法是資料；這裡只是解讀它）----------
    function classify(g, text) {
        let t = text;
        if (g.section && /^\[\[?[^\]]+\]\]?$/.test(t)) return { rule: 'section', name: t.replace(/^\[+|\]+$/g, '').trim() };
        if ((g.sigils || []).length) { const m = new RegExp('^([' + g.sigils.map((s) => s.replace(/[\\\]^-]/g, '\\$&')).join('') + '])([A-Za-z_][\\w-]*)\\s*(.*)$').exec(t); if (m) return { rule: 'directive', sigil: m[1], kw: m[2], value: m[3] }; }
        if (g.listMarker && new RegExp('^' + g.listMarker.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&') + '(?:\\s+|$)').test(t)) { const rest = t.slice(g.listMarker.length).trim(); const inner = rest ? classify(g, rest) : { rule: 'scalar', value: '' }; return { rule: 'item', inner, value: rest }; }
        if (/^\}\s*$/.test(t) && g.braceBlocks) return { rule: 'close' };
        const fm = g.funcBodies ? /^(?:(\w[\w-]*)\s+)?([A-Za-z_][\w:.${}-]*)\s*\(\s*\)\s*\{?\s*$/.exec(t) : null; if (fm) return { rule: 'func', name: fm[2], lang: fm[1] || null, open: /\{\s*$/.test(t) };
        const fo = findOp(t, g, g.ops); if (fo) { const lh = splitLhs(fo.lhs, g); if (lh) return { rule: 'assign', key: lh.name, quals: lh.quals, modifier: lh.modifier, flag: lh.flag, op: fo.op, value: fo.rhs }; }
        const kw = /^([A-Za-z_][\w-]*)(?:\s+(.*))?$/.exec(t); if (kw && (g.keywords || []).includes(kw[1])) return { rule: 'keyword', kw: kw[1], value: kw[2] || '' };
        if (g.braceBlocks && /\{\s*$/.test(t)) return { rule: 'block', head: t.replace(/\s*\{\s*$/, '') };
        if (/^(?:"[^"]*"|'[^']*'|[^\s:=]+)$/.test(t) && (g.listMarker || g.indentBlocks || g.section)) return { rule: 'scalar', value: t };
        return { rule: 'text', value: t };
    }

    // ---------- 解析成樹（扁平節點，帶 parent）----------
    function parse(g, text, opts) {
        opts = opts || {}; const raw = String(text).split(/\r?\n/); const lines = raw.length > (opts.maxLines || 20000) ? raw.slice(0, opts.maxLines || 20000) : raw; const nodes = []; const stmts = logical(lines, g);
        const stack = []; // 縮排區塊：{indent, node}
        const braces = []; // 大括號區塊：node
        let section = null; let opaque = null; let comments = 0, blanks = 0;
        const leaders = (g.comment && g.comment.leaders) || [];
        for (const s of stmts) {
            if (opaque) { // 函式本體：原文，不解析，直到單獨一行的 }
                if (/^\}\s*$/.test(s.text) && s.indent <= opaque.indent) { opaque.node.endLine = s.n; opaque = null; braces.pop(); continue; } opaque.node.body.push(s.raw); continue;
            }
            if (!s.text) { blanks++; continue; }
            if (leaders.some((ld) => s.text.startsWith(ld) && !(ld === '--' && !/^--\s/.test(s.text)))) { comments++; continue; }
            const sc = stripTrailingComment(s.text, g); const c = classify(g, sc.code); const node = Object.assign({ id: nodes.length, n: s.n, endLine: s.end, indent: s.indent, parent: null, path: '', comment: sc.comment || undefined }, c);
            if (node.rule === 'close') { const b = braces.pop(); if (b) b.endLine = s.n; while (stack.length && stack[stack.length - 1].braceOwner === b) stack.pop(); continue; }
            // 縮排區塊的父節點：往回找縮排比我小的最近節點
            if (g.indentBlocks) { while (stack.length && stack[stack.length - 1].indent >= s.indent) stack.pop(); }
            let parentNode = null; if (braces.length) parentNode = braces[braces.length - 1]; else if (g.indentBlocks && stack.length) parentNode = stack[stack.length - 1].node; else if (section && node.rule !== 'section') parentNode = section;
            if (node.rule === 'section') { section = node; parentNode = null; } node.parent = parentNode ? parentNode.id : null;
            const label = nodeLabel(node); node.path = (parentNode ? parentNode.path + (parentNode.path && label ? '.' : '') : '') + label;
            if (node.rule === 'assign' || node.rule === 'keyword' || node.rule === 'directive' || node.rule === 'item' || node.rule === 'scalar' || node.rule === 'text') { node.vtype = valueType(valueOf(node)); node.refs = refsOf(valueOf(node), g); }
            nodes.push(node);
            if (node.rule === 'func' && node.open) { node.body = []; opaque = { node, indent: s.indent }; braces.push(node); continue; }
            if (node.rule === 'block') braces.push(node);
            if (g.indentBlocks && (node.rule === 'assign' && node.value === '' || node.rule === 'item' && (!node.inner || node.inner.rule === 'assign' || node.inner.rule === 'scalar') || node.rule === 'block' || node.rule === 'keyword' && node.value === '' || node.rule === 'section' === false && node.rule === 'func')) stack.push({ indent: s.indent, node, braceOwner: null });
            else if (g.indentBlocks && node.rule === 'item') stack.push({ indent: s.indent, node });
        }
        const classified = nodes.filter((x) => x.rule !== 'text').length; const unparsed = nodes.filter((x) => x.rule === 'text');
        return { nodes, coverage: nodes.length ? classified / nodes.length : 0, unparsed: unparsed.slice(0, 20).map((x) => ({ line: x.n, text: x.value.slice(0, 120) })), unparsedCount: unparsed.length, statements: nodes.length, comments, blanks, lines: lines.length, truncatedFrom: raw.length > lines.length ? raw.length : null };
    }
    const valueOf = (n) => (n.rule === 'item' ? (n.inner && n.inner.rule === 'assign' ? n.inner.value : n.value) : (n.value == null ? '' : n.value));
    function nodeLabel(n) { if (n.rule === 'assign') return n.key + (n.flag ? '[' + n.flag + ']' : ''); if (n.rule === 'section') return n.name; if (n.rule === 'func') return n.name; if (n.rule === 'block') return n.head.replace(/\s+/g, ' ').trim(); if (n.rule === 'keyword') return n.kw; if (n.rule === 'directive') return n.sigil + n.kw; if (n.rule === 'item') return n.inner && n.inner.rule === 'assign' ? '-' + n.inner.key : '-'; return ''; }

    // ---------- ④ 帰納：從文字找出文法 ----------
    function induce(text, opts) {
        opts = opts || {}; const s = String(text == null ? '' : text); if (!s.trim()) return { ok: false, reason: '沒有內容' };
        let ctrl = 0; const lim = Math.min(s.length, 20000); for (let i = 0; i < lim; i++) { const c = s.charCodeAt(i); if (c < 9 || (c > 13 && c < 32) || c === 0xFFFD) ctrl++; } if (ctrl > 20 || ctrl / lim > 0.01) return { ok: false, kind: 'binary', reason: '含大量控制字元，不像文字格式' };
        const raw = s.split(/\r?\n/); const lines = raw.slice(0, opts.maxLines || 20000); const nonblank = lines.filter((l) => l.trim()).length; if (nonblank < 3) return { ok: false, reason: '行數太少' };
        // 看起來是日誌（大量以時間開頭）就不處理
        const tsLines = lines.filter((l) => /^\s*\[?\d{4}[-/.]\d{2}[-/.]\d{2}[T ]\d{2}:\d{2}|^\s*\[?\d{2}:\d{2}:\d{2}|^\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s\d{2}:/.test(l)).length; if (tsLines / nonblank > 0.4) return { ok: false, kind: 'log', reason: '大部分的行以時間開頭，像日誌（請用日誌格式學習）' };
        const g = { v: 1, opChars: OPCH, trail: [], comment: { leaders: [], trailing: [] }, continuation: false, quotes: [], refSigils: [], ops: [], opCounts: {}, qualifierSeps: [], qualifierWords: {}, underSuffixes: [], keywords: [], keywordCounts: {}, listMarker: null, sigils: [], section: false, funcBodies: false, braceBlocks: false, indentBlocks: false, modifiers: [] };
        extendGrammar(g, lines); return finalize(g, lines, opts);
    }
    function finalize(g, lines, opts) {
        const trail = opts && opts.grow === false ? [] : grow(g, lines, opts || {}); g.trail = (g.trail || []).concat(trail);
        const r = parse(g, lines.join('\n'), opts); const rules = (g.ops.length ? 1 : 0) + (g.keywords.length ? 1 : 0) + (g.section ? 1 : 0) + (g.listMarker ? 1 : 0) + (g.funcBodies ? 1 : 0) + (g.braceBlocks ? 1 : 0) + (g.sigils.length ? 1 : 0);
        const ok = r.statements >= 3 && r.coverage >= (opts.minCoverage || 0.8) && rules >= 1; g.coverage = r.coverage;
        return { ok, trail: g.trail, grammar: g, model: Object.assign({ ok: true, kind: 'grammar', grammar: g }, r, summaryStats(g, r)), reason: ok ? null : '學到的規則吃不掉大部分的行（涵蓋 ' + Math.round(r.coverage * 100) + '%，規則 ' + rules + ' 種）；不像「行導向、有鍵值或關鍵字」的格式' };
    }
    // 讀文字、補文法（induce 與 extend 共用；extend 時 g 已有內容，只加沒有的）
    function extendGrammar(g, lines) {
        // ① 註解記號：行首的候選；後面接的不能是運算（避免把 YAML 的 --- 當註解）
        for (const ld of COMMENT_CANDIDATES) { const re = new RegExp('^\\s*' + ld.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + (ld === '--' ? '\\s' : '')); if (lines.some((l) => re.test(l)) && !g.comment.leaders.includes(ld)) g.comment.leaders.push(ld); }
        for (const ld of g.comment.leaders) if ((ld === '#' || ld === '//') && lines.some((l) => !new RegExp('^\\s*' + ld.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')).test(l) && new RegExp('\\s' + ld.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '\\s').test(l)) && !g.comment.trailing.includes(ld)) g.comment.trailing.push(ld);
        // ② 續行：行尾反斜線，而且下一行存在
        if (!g.continuation && lines.some((l, i) => /\\\s*$/.test(l) && l.trim() !== '\\' && i + 1 < lines.length && lines[i + 1].trim())) g.continuation = true;
        // ③ 引號、變數引用記號
        for (const q of ['"', "'"]) if (!g.quotes.includes(q) && lines.filter((l) => (l.split(q).length - 1) > 0).some((l) => (l.split(q).length - 1) % 2 === 0)) g.quotes.push(q);
        if (!g.refSigils.length && lines.some((l) => /\$[{(][^})]+[})]/.test(l))) g.refSigils.push('$');
        const logi = logical(lines, g); const leaders = g.comment.leaders;
        const isComment = (t) => leaders.some((ld) => t.startsWith(ld) && !(ld === '--' && !/^--\s/.test(t)));
        // ④ 區段、大括號、函式、清單記號、指令記號
        let opaqueDepth = 0; const stmts = []; for (const s of logi) { if (!s.text || isComment(s.text)) continue; if (opaqueDepth) { if (/^\}\s*$/.test(s.text)) opaqueDepth = 0; continue; } const code = stripTrailingComment(s.text, g).code; if (/^(?:(?:\w[\w-]*)\s+)?[A-Za-z_][\w:.${}-]*\s*\(\s*\)\s*\{\s*$/.test(code)) { g.funcBodies = true; g.braceBlocks = true; opaqueDepth = 1; stmts.push(Object.assign({}, s, { code, func: true })); continue; } stmts.push(Object.assign({}, s, { code })); }
        for (const s of stmts) { if (s.func) continue; const t = s.code; if (/^\[\[?[^\]]+\]\]?$/.test(t)) g.section = true; if (/\{\s*$/.test(t) && !insideMask(t, g)[t.length - 1]) g.braceBlocks = true; if (/^\}\s*$/.test(t)) g.braceBlocks = true; }
        const dashLines = stmts.filter((s) => /^-\s+\S|^-$/.test(s.code)).length; if (!g.listMarker && dashLines >= 1) g.listMarker = '-';
        for (const sg of ['!', '@', '%', '.']) { if (g.sigils.includes(sg)) continue; const re = new RegExp('^\\' + sg + '[A-Za-z_][\\w-]*(?:\\s|$)'); if (stmts.filter((s) => re.test(s.code)).length >= 1 && sg !== '.') g.sigils.push(sg); else if (sg === '.' && stmts.filter((s) => re.test(s.code) && !findOp(s.code, g)).length >= 2) g.sigils.push(sg); }
        // ⑤ 運算子：每個陳述（去掉清單記號、指令）最左邊的運算子，統計
        const opStmts = []; for (const s of stmts) { if (s.func) continue; let t = s.code; if (g.listMarker && /^-\s+/.test(t)) t = t.replace(/^-\s+/, ''); if (/^\[\[?[^\]]+\]\]?$/.test(t)) continue; if (g.sigils.some((sg) => t.startsWith(sg))) continue; const fo = findOp(t, g); if (fo && splitLhs(fo.lhs, Object.assign({}, g, { qualifierSeps: [], underSuffixes: [] }))) { g.opCounts[fo.op] = (g.opCounts[fo.op] || 0) + 1; if (!g.ops.includes(fo.op)) g.ops.push(fo.op); opStmts.push({ s, fo, t }); } }
        g.ops.sort((a, b) => (g.opCounts[b] || 0) - (g.opCounts[a] || 0) || a.localeCompare(b));
        // ⑥ 鍵名的修飾：冒號後面接字詞（:append）；底線＋小寫字尾（_append）要在至少 2 個不同的名稱上出現才算
        const colonQ = {}, underBases = {}; for (const { fo } of opStmts) { const nm = fo.lhs.split(/\s+/).pop().replace(/\[[^\]]*\]$/, ''); if (nm.indexOf(':') > 0) for (const q of nm.split(':').slice(1)) colonQ[q] = (colonQ[q] || 0) + 1; const um = /^(.+?)_([a-z][a-z0-9]*)$/.exec(nm); if (um && nm.indexOf(':') < 0) { (underBases[um[2]] = underBases[um[2]] || new Set()).add(um[1]); } }
        if (Object.keys(colonQ).length && !g.qualifierSeps.includes(':')) g.qualifierSeps.push(':'); for (const [q, n] of Object.entries(colonQ)) g.qualifierWords[q] = (g.qualifierWords[q] || 0) + n;
        for (const [suf, bases] of Object.entries(underBases)) if ((bases.size >= 2 && (g.qualifierWords[suf] || bases.size >= 3)) && !g.underSuffixes.includes(suf)) g.underSuffixes.push(suf);
        // ⑦ 行首關鍵字：沒有運算子、第一個詞後面還有內容；出現 ≥2 次，或（小檔案且全小寫）
        const kwCount = {}; for (const s of stmts) { if (s.func) continue; let t = s.code; if (g.listMarker && /^-\s+/.test(t)) continue; if (/^\[\[?[^\]]+\]\]?$/.test(t) || g.sigils.some((sg) => t.startsWith(sg))) continue; if (findOp(t, g)) continue; const m = /^([A-Za-z_][\w-]*)(?:\s+\S.*)?$/.exec(t); if (m && !/\{\s*$/.test(t)) kwCount[m[1]] = (kwCount[m[1]] || 0) + 1; }
        for (const [w, n] of Object.entries(kwCount)) { g.keywordCounts[w] = (g.keywordCounts[w] || 0) + n; if (!g.keywords.includes(w) && keywordOK(w, g.keywordCounts[w], g)) g.keywords.push(w); }
        // ⑧ 縮排區塊：某個陳述後面接著縮得更深的陳述，而且前一個沒有值（「key:」「- 」「name {」）
        if (!g.indentBlocks) { let prev = null, hits = 0; for (const s of stmts) { if (s.func) { prev = null; continue; } if (prev && s.indent > prev.indent && (/:$/.test(prev.code) || /^-$/.test(prev.code) || (g.listMarker && /^-\s+/.test(prev.code)) || /^[^\s=:]+$/.test(prev.code))) hits++; prev = s; } if (hits >= 1) g.indentBlocks = true; }
        return g;
    }
    // ---------- ⑤ 讀 → 建規則 → 驗證 → 再長：用「吃不掉的陳述」提出新規則，通過驗證才採用 ----------
    // 驗證＝用新文法重新解析全文：涵蓋率要上升，而且原本吃得掉的陳述一個都不能壞掉（不退步）。
    // 提案來源全是這份文字本身：吃不掉的行共有的行首符號（註解？指令？清單？）、共有的行首單字（關鍵字）、行裡沒見過的運算子。
    // 防止「把所有吃不掉的都宣告成註解」這種作弊：被新規則吃成註解的行不能超過全部陳述的一半，而且註解提案至少要有 2 行共用同一個記號。
    const cloneG = (g) => JSON.parse(JSON.stringify(g));
    // 什麼樣的行首單字可以當關鍵字：出現 ≥2 次；或全大寫（FROM、RUN）；或全小寫，而且這份格式已經有別的結構規則（運算子、大括號、區段、清單）可以佐證它是格式而不是散文
    const hasStructure = (g) => !!(g.ops.length || g.braceBlocks || g.section || g.listMarker || (g.sigils || []).length);
    const keywordOK = (w, n, g) => n >= 2 || /^[A-Z][A-Z0-9_]+$/.test(w) || (/^[a-z][a-z0-9_]*$/.test(w) && hasStructure(g));
    function snapshot(g, lines, opts) { const r = parse(g, lines.join('\n'), opts); const ok = new Map(); for (const n of r.nodes) if (n.rule !== 'text') ok.set(n.n, n.rule); return { r, ok }; }
    function proposeFrom(g, un) {
        const P = []; const lead = {}, words = {}, runs = {}; const total = un.length;
        for (const n of un) {
            const t = String(n.value || '').trim(); const m = /^([^\w\s"'\[\]{}()<>]{1,2})(.*)$/.exec(t); if (m) { (lead[m[1]] = lead[m[1]] || []).push(n); } const w = /^([A-Za-z_][\w-]*)(?:\s+\S.*)?$/.exec(t); if (w) words[w[1]] = (words[w[1]] || 0) + 1;
            const gx = Object.assign({}, g, { opChars: OPCH + '-*/@^%' }); const fo = findOp(t, Object.assign({}, gx, { ops: null }), null); if (fo && !g.ops.includes(fo.op)) runs[fo.op] = (runs[fo.op] || 0) + 1;
        }
        for (const [sym, ns] of Object.entries(lead)) { if (ns.length >= 2 || total <= 4) {
            if (!(g.comment.leaders.includes(sym))) P.push({ label: '註解記號 ' + lit(sym) + '（' + ns.length + ' 行共用）', weak: true, apply: (c) => { c.comment.leaders.push(sym); } });
            if (sym.length === 1 && !(g.sigils || []).includes(sym) && ns.every((n) => new RegExp('^\\' + sym + '[A-Za-z_]').test(String(n.value).trim()))) P.push({ label: '指令記號 ' + lit(sym), apply: (c) => { c.sigils.push(sym); } });
            if (!g.listMarker && sym.length === 1 && '*+-•'.indexOf(sym) >= 0 && ns.every((n) => new RegExp('^\\' + sym + '\\s').test(String(n.value).trim()))) P.push({ label: '清單記號 ' + lit(sym), apply: (c) => { c.listMarker = sym; } }); } }
        const kwc = Object.entries(words).filter(([w, n]) => !g.keywords.includes(w) && keywordOK(w, n, g));
        if (kwc.length >= 2) P.push({ label: '行首關鍵字 ' + kwc.slice(0, 6).map(([w]) => w).join('、') + (kwc.length > 6 ? '…共 ' + kwc.length + ' 個' : ''), apply: (c) => { for (const [w, n] of kwc) { if (!c.keywords.includes(w)) c.keywords.push(w); c.keywordCounts[w] = (c.keywordCounts[w] || 0) + n; } } });
        for (const [w, n] of kwc) P.push({ label: '行首關鍵字 ' + w + '（' + n + ' 行）', apply: (c) => { c.keywords.push(w); c.keywordCounts[w] = (c.keywordCounts[w] || 0) + n; } });
        for (const [op, n] of Object.entries(runs)) if (n >= 1 && op.length <= 3) P.push({ label: '運算子 ' + lit(op) + '（' + n + ' 行）', apply: (c) => { for (const ch of op) if (c.opChars.indexOf(ch) < 0) c.opChars += ch; if (!c.ops.includes(op)) c.ops.push(op); c.opCounts[op] = (c.opCounts[op] || 0) + n; } });
        return P;
    }
    function grow(g, lines, opts) {
        const trail = []; if (!g.opChars) g.opChars = OPCH; let cur = snapshot(g, lines, opts); const maxRounds = opts.maxRounds || 6;
        for (let round = 1; round <= maxRounds && cur.r.unparsedCount; round++) {
            const un = cur.r.nodes.filter((n) => n.rule === 'text'); const props = proposeFrom(g, un); let best = null;
            for (const p of props) {
                const gc = cloneG(g); p.apply(gc); const s = snapshot(gc, lines, opts);
                let regress = false; for (const [n, rule] of cur.ok) { const now = s.ok.get(n); if (now === undefined) { regress = true; break; } } if (regress) continue;
                const gain = s.r.coverage - cur.r.coverage; if (gain <= 1e-9) continue;
                if (p.weak && (cur.r.statements - s.r.statements) / Math.max(1, cur.r.statements) > 0.5) continue;
                if (!best || gain > best.gain || (gain === best.gain && !p.weak && best.p.weak)) best = { p, gc, s, gain };
            }
            if (!best) break; for (const k of Object.keys(best.gc)) g[k] = best.gc[k];
            trail.push({ round, added: best.p.label, from: Math.round(cur.r.coverage * 1000) / 1000, to: Math.round(best.s.r.coverage * 1000) / 1000, weak: !!best.p.weak }); cur = best.s;
        }
        return trail;
    }
    function summaryStats(g, r) { const byRule = {}; for (const n of r.nodes) byRule[n.rule] = (byRule[n.rule] || 0) + 1; return { byRule }; }
    // 邊讀邊學：新的文字只補文法裡沒有的規則，再重新解析、重算涵蓋率
    function extend(g0, text, opts) {
        const g = JSON.parse(JSON.stringify(g0)); const before = { ops: g.ops.length, kw: g.keywords.length, q: g.qualifierSeps.length + g.underSuffixes.length, sig: g.sigils.length };
        const lines = String(text).split(/\r?\n/).slice(0, (opts && opts.maxLines) || 20000); extendGrammar(g, lines); const r = finalize(g, lines, opts || {});
        r.added = { ops: g.ops.length - before.ops, keywords: g.keywords.length - before.kw, qualifiers: g.qualifierSeps.length + g.underSuffixes.length - before.q, sigils: g.sigils.length - before.sig }; return r;
    }

    // ---------- 把文法寫成人看得懂的規則（EBNF 風格）與 ANTLR 風格 ----------
    const lit = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    function toEbnf(g) {
        const R = []; const alts = ['comment', 'blank'];
        R.push('file        := statement* ;');
        if (g.section) alts.push('section'); if ((g.sigils || []).length) alts.push('directive'); if (g.listMarker) alts.push('item'); if (g.funcBodies) alts.push('function'); if (g.braceBlocks) alts.push('block'); if (g.ops.length) alts.push('assignment'); if (g.keywords.length) alts.push('keyword_stmt'); alts.push('text');
        R.push('statement   := ' + alts.join(' | ') + ' ;');
        R.push('comment     := ' + (g.comment.leaders.length ? g.comment.leaders.map(lit).join(' | ') : '（沒有發現註解記號）') + ' text' + (g.comment.trailing.length ? '    // 行尾也可以有註解：' + g.comment.trailing.map(lit).join('、') : '') + ' ;');
        if (g.section) R.push("section     := '[' name ']' ;");
        if ((g.sigils || []).length) R.push('directive   := (' + g.sigils.map(lit).join(' | ') + ') word value? ;');
        if (g.listMarker) R.push('item        := ' + lit(g.listMarker) + ' (assignment | scalar) ;');
        if (g.ops.length) { R.push('assignment  := ' + (g.modifiers.length ? '(' + g.modifiers.map(lit).join(' | ') + ')? ' : '') + 'key qualifier* flag? operator value ;'); R.push('operator    := ' + g.ops.map(lit).join(' | ') + '    // 出現次數：' + g.ops.map((o) => o + '×' + (g.opCounts[o] || 0)).join('、') + ' ;'); }
        const qw = Object.keys(g.qualifierWords); if (g.qualifierSeps.length || g.underSuffixes.length) R.push('qualifier   := ' + [g.qualifierSeps.length ? "':' word" + (qw.length ? '    // 例如：' + qw.slice(0, 6).join('、') : '') : null, g.underSuffixes.length ? "'_' (" + g.underSuffixes.map(lit).join(' | ') + ')' : null].filter(Boolean).join(' | ') + ' ;');
        if (g.keywords.length) R.push('keyword_stmt := (' + g.keywords.slice(0, 20).map(lit).join(' | ') + (g.keywords.length > 20 ? ' | …共 ' + g.keywords.length + ' 個' : '') + ') value ;');
        if (g.funcBodies) R.push("function    := word? name '(' ')' '{' raw_lines '}' ;    // 本體不解析，當成原文");
        if (g.braceBlocks) R.push("block       := head '{' statement* '}' ;");
        R.push('value       := ' + [g.quotes.length ? '(' + g.quotes.map(lit).join(' | ') + ') chars (' + g.quotes.map(lit).join(' | ') + ')' : null, g.refSigils.length ? "'$' ('{' name '}' | '(' name ')')" : null, 'word+'].filter(Boolean).join(' | ') + ' ;');
        R.push('// 區塊結構：' + [g.indentBlocks ? '縮排（比上一個陳述縮得深的接在它底下）' : null, g.braceBlocks ? '大括號' : null, g.section ? '[區段標題]' : null].filter(Boolean).join('、') + (g.continuation ? '；行尾 \\ 接續到下一行' : ''));
        return R.join('\n');
    }
    function toAntlr(g, name) {
        const nm = (name || 'Learned').replace(/[^A-Za-z0-9_]/g, '') || 'Learned'; const R = ['grammar ' + nm + ';', '', 'file : (statement | NEWLINE)* EOF ;'];
        const alts = []; if (g.section) alts.push('section'); if ((g.sigils || []).length) alts.push('directive'); if (g.listMarker) alts.push('item'); if (g.funcBodies) alts.push('function'); if (g.braceBlocks) alts.push('block'); if (g.ops.length) alts.push('assignment'); if (g.keywords.length) alts.push('keywordStmt'); alts.push('text');
        R.push('statement : ' + alts.join(' | ') + ' NEWLINE ;');
        if (g.section) R.push("section : '[' NAME ']' ;"); if ((g.sigils || []).length) R.push('directive : (' + g.sigils.map(lit).join(' | ') + ') NAME value? ;'); if (g.listMarker) R.push('item : ' + lit(g.listMarker) + ' (assignment | value) ;');
        if (g.ops.length) { R.push('assignment : (' + (g.modifiers.length ? g.modifiers.map(lit).join(' | ') : "'' ") + ")? key qualifier* ('[' NAME ']')? operator value ;"); R.push('operator : ' + g.ops.map(lit).join(' | ') + ' ;'); }
        R.push('key : NAME ;'); if (g.qualifierSeps.length || g.underSuffixes.length) R.push('qualifier : ' + [g.qualifierSeps.length ? "':' NAME" : null, g.underSuffixes.length ? '(' + g.underSuffixes.map((s) => lit('_' + s)).join(' | ') + ')' : null].filter(Boolean).join(' | ') + ' ;');
        if (g.keywords.length) R.push('keywordStmt : KEYWORD value? ;'); if (g.funcBodies) R.push("function : NAME? NAME '(' ')' '{' NEWLINE rawBody '}' ;\nrawBody : ~'}'* ;"); if (g.braceBlocks) R.push("block : text '{' NEWLINE (statement | NEWLINE)* '}' ;");
        R.push('value : (STRING | NAME | REF | PUNCT)+ ;', 'text : (NAME | STRING | PUNCT)+ ;', '', '// ---- lexer ----');
        if (g.keywords.length) R.push('KEYWORD : ' + g.keywords.slice(0, 40).map(lit).join(' | ') + ' ;');
        R.push("NAME : [A-Za-z_] [A-Za-z0-9_.\\-]* ;"); R.push('STRING : ' + (g.quotes.length ? g.quotes.map((q) => (q === '"' ? '\'"\' (~["\\\\] | \'\\\\\' .)* \'"\'' : "'\\'' ~[']* '\\''")).join(' | ') : "'\"' ~[\"]* '\"'") + ' ;'); if (g.refSigils.length) R.push("REF : '$' ('{' ~'}'* '}' | '(' ~')'* ')') ;");
        R.push('PUNCT : ~[ \\t\\r\\n] ;'); R.push('COMMENT : (' + (g.comment.leaders.length ? g.comment.leaders.map(lit).join(' | ') : "'#'") + ") ~[\\r\\n]* -> skip ;"); R.push('NEWLINE : [\\r\\n]+ ;'); R.push('WS : [ \\t]+ -> skip ;' + (g.indentBlocks ? '    // 縮排區塊需要 INDENT／DEDENT：ANTLR 要在 lexer 裡自己產生這兩種記號' : ''));
        return R.join('\n');
    }

    // ---------- 摘要、問答、比較 ----------
    const flat = (m) => m.nodes.filter((n) => ['assign', 'keyword', 'directive', 'func', 'section', 'item', 'scalar', 'block'].includes(n.rule));
    function fmtNode(n) { const q = (n.quals || []).map((x) => (x[0] === '_' ? x : ':' + x)).join(''); if (n.rule === 'assign') return 'L' + n.n + ' ' + (n.modifier ? n.modifier + ' ' : '') + n.key + q + (n.flag ? '[' + n.flag + ']' : '') + ' ' + n.op + ' ' + redact(n.key, n.value).slice(0, 120); if (n.rule === 'keyword') return 'L' + n.n + ' ' + n.kw + ' ' + String(n.value).slice(0, 120); if (n.rule === 'directive') return 'L' + n.n + ' ' + n.sigil + n.kw + ' ' + String(n.value).slice(0, 120); if (n.rule === 'func') return 'L' + n.n + ' ' + (n.lang ? n.lang + ' ' : '') + n.name + '()' + (n.body ? '（' + n.body.length + ' 行）' : ''); if (n.rule === 'section') return 'L' + n.n + ' [' + n.name + ']'; if (n.rule === 'item') return 'L' + n.n + ' - ' + (n.inner && n.inner.rule === 'assign' ? n.inner.key + ' ' + n.inner.op + ' ' + redact(n.inner.key, n.inner.value) : String(n.value)).slice(0, 120); if (n.rule === 'block') return 'L' + n.n + ' ' + n.head + ' { }'; return 'L' + n.n + ' ' + String(n.value || '').slice(0, 120); }
    function summarize(m) {
        const g = m.grammar; const L = []; L.push('格式：從文字自己找出的文法；' + m.lines + ' 行、' + m.statements + ' 個陳述、涵蓋率 ' + Math.round(m.coverage * 100) + '%' + (m.unparsedCount ? '（' + m.unparsedCount + ' 個吃不掉）' : '（全部吃掉）') + (m.truncatedFrom ? '；只分析了前 ' + m.lines + ' 行（全部 ' + m.truncatedFrom + ' 行）' : ''));
        L.push('區塊結構：' + ([g.indentBlocks ? '靠縮排' : null, g.braceBlocks ? '靠大括號' : null, g.section ? '區段標題 [x]' : null].filter(Boolean).join('、') || '沒有（一行一個陳述）') + (g.continuation ? '；行尾 \\ 續行' : ''));
        L.push('註解記號：' + (g.comment.leaders.map(lit).join('、') || '沒發現') + (g.comment.trailing.length ? '（行尾也有）' : ''));
        if (g.ops.length) L.push('賦值的運算子（自己統計出來的）：' + g.ops.map((o) => o + '×' + (g.opCounts[o] || 0)).join('、'));
        const qw = Object.entries(g.qualifierWords).sort((a, b) => b[1] - a[1]); if (qw.length || g.underSuffixes.length) L.push('鍵名的修飾：' + [qw.length ? ':' + qw.slice(0, 8).map(([k, n]) => k + '×' + n).join('、:') : null, g.underSuffixes.length ? '字尾 _' + g.underSuffixes.join('、_') : null].filter(Boolean).join('；'));
        if (g.keywords.length) L.push('行首關鍵字：' + g.keywords.slice(0, 15).map((k) => k + '×' + (g.keywordCounts[k] || 0)).join('、')); if (g.listMarker) L.push('清單記號：' + g.listMarker); if ((g.sigils || []).length) L.push('指令記號：' + g.sigils.join(' '));
        const funcs = m.nodes.filter((n) => n.rule === 'func'); if (funcs.length) L.push('函式（本體當原文）：' + funcs.slice(0, 10).map((f) => f.name).join('、') + (funcs.length > 10 ? '…共 ' + funcs.length + ' 個' : ''));
        const tops = m.nodes.filter((n) => n.rule === 'assign'); const keys = new Map(); for (const n of tops) keys.set(n.key, (keys.get(n.key) || 0) + 1); const multi = Array.from(keys.entries()).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]); if (multi.length) L.push('被多次賦值的鍵：' + multi.slice(0, 6).map(([k, c]) => k + '×' + c).join('、'));
        const tr = g.trail || []; if (tr.length) L.push('自我修正（讀過後提出新規則，用全文重新解析驗證，涵蓋率上升且原本解得好的沒壞才採用）：' + tr.map((x) => '第 ' + x.round + ' 輪加入' + x.added + '，涵蓋率 ' + Math.round(x.from * 100) + '%→' + Math.round(x.to * 100) + '%' + (x.weak ? '（較弱的推測）' : '')).join('；'));
        if (m.unparsed.length) L.push('吃不掉的行：' + m.unparsed.slice(0, 5).map((u) => 'L' + u.line + ' ' + u.text.slice(0, 50)).join('；')); return L;
    }
    function compactContext(m, maxChars) { const g = m.grammar; const body = flat(m).slice(0, 60).map(fmtNode).join('\n'); return (summarize(m).join('\n') + '\n\n文法：\n' + toEbnf(g) + '\n\n前 60 個陳述：\n' + body).slice(0, maxChars || 5000); }
    function ask(m, q) {
        const text = String(q || '').trim(); const nodes = flat(m);
        if (/(?:antlr|g4)/i.test(text)) return { kind: 'antlr', answer: toAntlr(m.grammar) };
        if (/(?:文法|規則|grammar|ebnf|語法)/i.test(text)) return { kind: 'grammar', answer: toEbnf(m.grammar) };
        if (/(?:摘要|總結|概況|summary|overview|整體)/i.test(text)) return { kind: 'summary', answer: summarize(m).join('\n') };
        if (/(?:函式|function|func)/i.test(text) && /(?:哪些|列出|有什麼|有幾個|list)/i.test(text)) { const f = nodes.filter((n) => n.rule === 'func'); return { kind: 'functions', answer: f.length ? f.map(fmtNode).join('\n') : '沒有函式。' }; }
        const kwm = (m.grammar.keywords || []).find((k) => new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)); if (kwm && /(?:哪些|列出|有什麼|有幾個|list|which)/i.test(text)) { const r = nodes.filter((n) => n.rule === 'keyword' && n.kw === kwm); return { kind: 'keyword', answer: r.length ? r.map(fmtNode).join('\n') : '沒有 ' + kwm + '。' }; }
        const opm = (m.grammar.ops || []).slice().sort((a, b) => b.length - a.length).find((o) => text.indexOf(o) >= 0 && o !== ':'); if (opm && /(?:哪些|列出|用了|使用|有哪|list|which)/i.test(text)) { const r = nodes.filter((n) => (n.rule === 'assign' && n.op === opm) || (n.rule === 'item' && n.inner && n.inner.op === opm)); return { kind: 'by_op', answer: r.length ? r.slice(0, 40).map(fmtNode).join('\n') + (r.length > 40 ? '\n…共 ' + r.length + ' 個' : '') : '沒有用 ' + opm + ' 的陳述。' }; }
        const toks = (text.match(/[A-Za-z_$@][\w.:${}\/\[\]\-]{0,80}/g) || []).sort((a, b) => b.length - a.length);
        for (const tk of toks) { const t = tk.replace(/[.:]+$/, '');
            const byPath = nodes.filter((n) => n.path === t || n.path.toLowerCase() === t.toLowerCase()); if (byPath.length) { const kids = m.nodes.filter((c) => byPath.some((p) => c.parent === p.id)); const head = byPath.map(fmtNode).join('\n'); return { kind: 'path', answer: head + (byPath.length > 1 ? '\n（共 ' + byPath.length + ' 次，依檔案順序；後面的操作會疊在前面的上）' : '') + (kids.length ? '\n底下 ' + kids.length + ' 個：\n' + kids.slice(0, 30).map((c) => '  ' + fmtNode(c)).join('\n') + (kids.length > 30 ? '\n  …還有 ' + (kids.length - 30) : '') : '') }; }
            const byKey = nodes.filter((n) => (n.rule === 'assign' && n.key === t) || (n.rule === 'item' && n.inner && n.inner.rule === 'assign' && n.inner.key === t) || (n.rule === 'func' && n.name === t) || (n.rule === 'section' && n.name === t)); if (byKey.length) { const kids = m.nodes.filter((c) => byKey.some((p) => c.parent === p.id && (p.rule === 'section' || p.rule === 'func'))); return { kind: 'key', answer: byKey.map(fmtNode).join('\n') + (byKey.length > 1 ? '\n（共 ' + byKey.length + ' 次，依檔案順序；後面的操作會疊在前面的上）' : '') + (kids.length ? '\n底下 ' + kids.length + ' 個：\n' + kids.slice(0, 30).map((c) => '  ' + fmtNode(c)).join('\n') : '') }; } }
        return { kind: 'open', answer: null, context: compactContext(m), note: '這個問題需要判斷，不是查詢；已附上學到的文法與前幾個陳述，可以交給模型回答' };
    }
    function matchLine(m, line) { const t = String(line).trim(); const c = classify(m.grammar, stripTrailingComment(t, m.grammar).code); if (c.rule === 'text') return null; const key = c.rule === 'assign' ? c.key : (c.rule === 'item' && c.inner && c.inner.rule === 'assign' ? c.inner.key : (c.name || c.kw || null)); const same = flat(m).filter((n) => (n.rule === 'assign' && n.key === key) || (n.rule === 'item' && n.inner && n.inner.key === key) || (n.rule === 'func' && n.name === key) || (n.rule === 'keyword' && n.kw === key)); return { rule: c.rule, key, op: c.op || null, value: c.value, known: same.length > 0, where: same.slice(0, 8).map((n) => ({ line: n.n, path: n.path, text: fmtNode(n) })) }; }
    function keyOf(n) { return n.path + (n.rule === 'assign' ? '|' + (n.quals || []).join(',') + '|' + n.op : '|' + n.rule); }
    function diff(a, b) {
        const grp = (m) => { const mp = new Map(); const cnt = new Map(); for (const n of flat(m)) { if (n.rule === 'section' || n.rule === 'block') continue; const base = keyOf(n) + (n.rule === 'scalar' || n.rule === 'keyword' || n.rule === 'directive' ? '|' + valueOf(n) : ''); const c = (cnt.get(base) || 0) + 1; cnt.set(base, c); mp.set(base + '#' + c, n); } return mp; };
        const A = grp(a), B = grp(b); const added = [], removed = [], changed = []; const secret = (n) => n.key && SECRET_KEY.test(n.key);
        for (const [k, v] of B) { if (!A.has(k)) added.push(v); else { const o = A.get(k); const ov = String(valueOf(o)).trim(), nv = String(valueOf(v)).trim(); if (ov !== nv && !(secret(v) && (ov.indexOf('已遮蔽') >= 0 || nv.indexOf('已遮蔽') >= 0)) && redact(v.key, ov) !== redact(v.key, nv) || (ov !== nv && secret(v) && ov.indexOf('已遮蔽') < 0)) changed.push({ node: v, from: o, secret: !!secret(v) }); } }
        for (const [k, v] of A) if (!B.has(k)) removed.push(v);
        return { added, removed, changed, same: !added.length && !removed.length && !changed.length };
    }
    function describeDiff(d) {
        if (d.same) return ['兩份的結構與值完全相同（不比較註解與空白）。']; const L = ['差異：新增 ' + d.added.length + '、移除 ' + d.removed.length + '、改值 ' + d.changed.length];
        d.changed.slice(0, 30).forEach((c) => L.push('改：' + c.node.path + '：' + (c.secret ? '（機密值有變，內容不顯示）' : redact(c.node.key, valueOf(c.from)).slice(0, 60) + ' → ' + redact(c.node.key, valueOf(c.node)).slice(0, 60)))); d.added.slice(0, 20).forEach((n) => L.push('新增：' + fmtNode(n))); d.removed.slice(0, 20).forEach((n) => L.push('移除：' + fmtNode(n))); return L;
    }

    // ---------- 離線訓練器 ----------
    function toTrainerPattern(m, name, opts) {
        opts = opts || {}; const id = 'gram_' + String(name).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '_').slice(0, 40); const g = m.grammar; const nodes = flat(m);
        const slimNodes = nodes.slice(0, 400).map((n) => { const o = { id: n.id, n: n.n, rule: n.rule, parent: n.parent, path: n.path, indent: n.indent }; if (n.rule === 'assign') Object.assign(o, { key: n.key, quals: n.quals, modifier: n.modifier, flag: n.flag, op: n.op, value: redact(n.key, n.value).slice(0, 140), vtype: n.vtype }); else if (n.rule === 'item') o.value = n.inner && n.inner.rule === 'assign' ? '' : String(n.value).slice(0, 140), n.inner && n.inner.rule === 'assign' ? o.inner = { key: n.inner.key, op: n.inner.op, value: redact(n.inner.key, n.inner.value).slice(0, 140) } : 0; else if (n.rule === 'keyword' || n.rule === 'directive') Object.assign(o, { kw: n.kw, sigil: n.sigil, value: String(n.value).slice(0, 140) }); else if (n.rule === 'func') Object.assign(o, { name: n.name, lang: n.lang, bodyLines: n.body ? n.body.length : 0 }); else if (n.rule === 'section') o.name = n.name; else if (n.rule === 'block') o.head = n.head; else o.value = String(n.value || '').slice(0, 140); return o; });
        const keys = Array.from(new Set(nodes.filter((n) => n.rule === 'assign').map((n) => n.key))).filter((k) => k.length >= 4 && /^[\w.$@\-\/]+$/.test(k)).slice(0, 40); const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); const opRe = g.ops.length ? g.ops.slice().sort((a, b) => b.length - a.length).map(esc).join('|') : '=';
        return { id, type: keys.length ? 'regex' : 'semantic', expr: keys.length ? '^\\s*(?:' + keys.map(esc).join('|') + ')(?::[\\w.-]+)*\\s*(?:' + opRe + ')\\s*\\S?.*$' : undefined, examples: nodes.filter((n) => n.rule === 'assign').slice(0, 5).map((n) => n.key + ' ' + n.op + ' ' + redact(n.key, n.value).slice(0, 60)), intent: '已學過的格式「' + name + '」（自己找出的文法：' + g.ops.length + ' 種運算子、' + g.keywords.length + ' 個關鍵字）', description: summarize(m).slice(0, 3).join('；'), tool: 'log_ask', args: { format: name, question: '這一行是什麼意思', text: '{problem_text}' }, confidence: 0.75, risk: 'safe', source: 'learned', enabled: true, hits: 0, log_model: { v: 1, kind: 'grammar', name, learnedAt: Date.now(), source: opts.source || '', grammar: g, lines: m.lines, statements: m.statements, coverage: m.coverage, comments: m.comments, nodes: slimNodes } };
    }
    function fromSlim(slim) { const nodes = (slim.nodes || []).map((n) => Object.assign({}, n, { refs: [], quals: n.quals || [] })); const m = { ok: true, kind: 'grammar', grammar: slim.grammar, nodes, lines: slim.lines || 0, statements: slim.statements || nodes.length, coverage: slim.coverage || 0, unparsed: [], unparsedCount: 0, comments: slim.comments || 0, blanks: 0 }; return m; }

    return { induce, extend, parse, classify, findOp, summarize, compactContext, ask, matchLine, diff, describeDiff, toEbnf, toAntlr, toTrainerPattern, fromSlim, valueType, flat, fmtNode };
});
