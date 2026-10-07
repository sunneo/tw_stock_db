/* 離線日誌格式學習（FaLog）：給一份沒看過的文字日誌（ASCII／UTF-8），程式自己找出它的格式——
 *   認格式 → 遮蔽已知型別（時間、IP、UUID、路徑、數字…）→ 試多種分詞 → 依相似度把重複的行歸成模板、變動的位置變成欄位 →
 *   挑涵蓋最好的分詞 → 統計（次數、第一次／最後一次、欄位的值分布）→ 摘要與問答（全是程式查詢，不經過模型）。
 * 全部是純函式（UMD）：不碰畫面、不連網、不呼叫模型。模板與統計可以存進離線訓練器，之後遇到同格式的紀錄直接比對。
 * 學不出來就說學不出來（二進位、幾乎沒有重複、全是變動）；不編造。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---------- 已知型別的遮蔽（順序＝優先順序）----------
    const MASKS = [
        ['TS', /\b\d{4}[-/.]\d{2}[-/.]\d{2}[T _]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:\s?(?:Z|UTC|[+-]\d{2}:?\d{2}))?/g],
        ['TS', /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/g],
        ['TS', /\b\d{1,2}\/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\/\d{4}:\d{2}:\d{2}:\d{2}(?:\s[+-]\d{4})?/g],
        ['TS', /\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?\b/g],
        ['URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi],
        ['UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
        ['IP', /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g],
        ['MAC', /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi],
        ['HEX', /\b0x[0-9a-f]+\b/gi],
        ['HEX', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi],
        ['PATH', /(?:\b[A-Za-z]:)?(?:[\\/][\w.@+~-]+){2,}[\\/]?/g],
        ['DUR', /(?<![\w.])\d+(?:\.\d+)?\s?(?:ms|us|µs|ns|sec|secs|seconds|s|min|minutes|h)\b/g],
        ['SIZE', /(?<![\w.])\d+(?:\.\d+)?\s?(?:KB|MB|GB|TB|KiB|MiB|GiB|B)\b/g],
        ['NUM', /(?<![A-Za-z0-9_.])-?\d+(?:\.\d+)?(?![A-Za-z_])/g],
    ];
    const TYPE_RE = { TS: /^\d/, IP: /^\d+\.\d+\.\d+\.\d+/, UUID: /^[0-9a-f]{8}-/i, NUM: /^-?\d+(?:\.\d+)?$/, HEX: /^(?:0x)?[0-9a-f]+$/i };
    const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'NOTICE', 'WARN', 'WARNING', 'ERROR', 'ERR', 'FATAL', 'CRITICAL', 'SEVERE', 'CRIT'];
    const LEVEL_NORM = { WARNING: 'WARN', ERR: 'ERROR', CRITICAL: 'FATAL', CRIT: 'FATAL', SEVERE: 'ERROR' };
    const LEVEL_RE = new RegExp('(?:^|[^A-Za-z])(' + LEVELS.join('|') + ')(?![A-Za-z])', 'i');
    const CONT_RE = /^\s+(?:at\s|\.\.\.\s*\d+\s*(?:more|common)|File\s+"|\S.*\s\(.*:\d+\))|^(?:Caused by|Traceback \(most recent call last\)|Exception in thread|\tat\s)/;
    const JSON_MSG = ['message', 'msg', 'event', 'log', 'text'], JSON_TS = ['time', 'timestamp', 'ts', '@timestamp', 'datetime', 'date'], JSON_LV = ['level', 'severity', 'lvl', 'loglevel'];

    // 遮蔽：回傳 { text: 含 <TYPE> 的字串, vars: [{type, value}]（依出現順序）}
    function mask(line) {
        const hits = [];
        for (const [type, re] of MASKS) { re.lastIndex = 0; let m; while ((m = re.exec(line))) { if (!m[0].length) { re.lastIndex++; continue; } const s = m.index, e = s + m[0].length; if (!hits.some((h) => s < h.e && e > h.s)) hits.push({ s, e, type, value: m[0] }); } }
        hits.sort((a, b) => a.s - b.s); let out = '', pos = 0; const vars = [];
        for (const h of hits) { out += line.slice(pos, h.s) + '<' + h.type + '>'; vars.push({ type: h.type, value: h.value }); pos = h.e; }
        return { text: out + line.slice(pos), vars };
    }
    // 分詞：mode 'ws'＝空白；'punct'＝空白＋標點（[]()=:,;|"' 各自成詞）。回傳 [{ t: 詞, sp: 前面有沒有空白, v: 原始值（型別詞才有）}]
    const TOK = { ws: /<[A-Z]+>|\S+/g, punct: /<[A-Z]+>|[^\s\[\](){}:,;=|"'<>]+|[\[\](){}:,;=|"'<>]/g };
    function tokenize(maskedText, vars, mode) {
        const re = new RegExp(TOK[mode].source, 'g'); const out = []; let m, vi = 0, last = 0;
        while ((m = re.exec(maskedText))) {
            const sp = m.index > last; last = m.index + m[0].length; let t = m[0]; let v;
            if (mode === 'ws') { // 空白分詞：一個詞裡可以含多個型別（`user=<NUM>`、`<IP>:<NUM>`）；依序消耗 vars，詞本身保留型別標記
                const parts = t.match(/<[A-Z]+>/g); if (parts) { v = []; for (const p of parts) { if (vars[vi] && '<' + vars[vi].type + '>' === p) v.push(vars[vi++].value); } v = v.join('\u0001'); }
            } else if (/^<[A-Z]+>$/.test(t)) { if (vars[vi] && '<' + vars[vi].type + '>' === t) v = vars[vi++].value; }
            out.push({ t, sp, v });
        }
        return out;
    }

    // ---------- 認格式 ----------
    function detect(text) {
        const s = String(text == null ? '' : text); if (!s.length) return { ok: false, kind: 'empty', reason: '沒有內容' };
        const sample = s.slice(0, 200000); let ctrl = 0; for (let i = 0; i < Math.min(sample.length, 20000); i++) { const c = sample.charCodeAt(i); if ((c < 9 || (c > 13 && c < 32)) || c === 0xFFFD) ctrl++; }
        if (ctrl > 20 || ctrl / Math.min(sample.length, 20000) > 0.01) return { ok: false, kind: 'binary', reason: '含大量控制字元或無法解碼的字元，不像文字日誌' };
        const lines = s.split(/\r?\n/); while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); const first = lines.slice(0, 2000).filter((l) => l.trim()); if (first.length < 3) return { ok: false, kind: 'text', reason: '行數太少（至少要有幾行才找得出重複）' };
        let json = 0, kv = 0, ts = 0, lv = 0, cont = 0, nonAscii = 0; const kvRe = /(?:^|\s)[A-Za-z_][\w.-]*=(?:"[^"]*"|\S+)/g;
        for (const l of first) { if (/^\s*\{.*\}\s*$/.test(l)) { try { JSON.parse(l); json++; } catch (_) {} } if ((l.match(kvRe) || []).length >= 2) kv++; if (/^\s*\[?(?:\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}:\d{2}:\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d)/.test(l) || /^\S+ \S+ \S+ \[\d{1,2}\/\w{3}\/\d{4}/.test(l)) ts++; if (LEVEL_RE.test(l.slice(0, 120))) lv++; if (CONT_RE.test(l)) cont++; if (/[^\x00-\x7f]/.test(l)) nonAscii++; }
        const n = first.length; return { ok: true, kind: 'text', lines: lines.length, encoding: nonAscii ? 'utf8' : 'ascii', jsonRatio: json / n, kvRatio: kv / n, tsRatio: ts / n, levelRatio: lv / n, contRatio: cont / n, format: json / n > 0.8 ? 'json_lines' : (kv / n > 0.6 ? 'key_value' : (ts / n > 0.6 ? 'timestamped' : 'free_text')) };
    }
    // 多行紀錄：開頭沒有時間戳的行（或堆疊追蹤的縮排行）接到上一筆
    function splitRecords(lines, fmt) {
        const recs = []; const tsHead = fmt.tsRatio >= 0.6; const isHead = (l) => /^\s*\[?(?:\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}:\d{2}:\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d)/.test(l) || /^\S+ \S+ \S+ \[\d{1,2}\/\w{3}\/\d{4}/.test(l);
        for (let i = 0; i < lines.length; i++) { const l = lines[i]; if (!l.trim()) continue; const prev = recs[recs.length - 1]; const isCont = prev && fmt.format !== 'json_lines' && (CONT_RE.test(l) || (tsHead && !isHead(l)) || (!tsHead && /^\s+\S/.test(l) && fmt.contRatio > 0.02)); if (isCont) prev.cont.push(l); else recs.push({ n: i + 1, text: l, cont: [] }); }
        return recs;
    }

    // ---------- 時間 ----------
    const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    function parseTs(v) {
        if (v == null) return null; if (typeof v === 'number') return v > 1e12 ? v : (v > 1e9 ? v * 1000 : null); const s = String(v).trim(); let m;
        if ((m = /^(\d{4})[-/.](\d{2})[-/.](\d{2})[T _](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s?(Z|UTC|[+-]\d{2}:?\d{2})?$/.exec(s))) { const ms = m[7] ? Number(('0.' + m[7])) * 1000 : 0; let tz = m[8]; let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + Math.round(ms); if (tz && tz !== 'Z' && tz !== 'UTC') { const sg = tz[0] === '-' ? -1 : 1; const d = tz.replace(/[^\d]/g, ''); t -= sg * (Number(d.slice(0, 2)) * 60 + Number(d.slice(2, 4))) * 60000; } return t; }
        if ((m = /^(\d{1,2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s([+-]\d{2})(\d{2}))?$/.exec(s)) && MON[m[2].toLowerCase()] != null) { let t = Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1], +m[4], +m[5], +m[6]); if (m[7]) { const sg = m[7][0] === '-' ? -1 : 1; t -= sg * (Math.abs(Number(m[7])) * 60 + Number(m[8])) * 60000; } return t; }
        if ((m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})$/i.exec(s))) return Date.UTC(1970, MON[m[1].toLowerCase()], +m[2], +m[3], +m[4], +m[5]); // 沒有年份：只能比較同一份日誌裡的先後
        if ((m = /^(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?$/.exec(s))) return Date.UTC(1970, 0, 1, +m[1], +m[2], +m[3]) + (m[4] ? Math.round(Number('0.' + m[4]) * 1000) : 0); // 只有時間：同上
        const d = Date.parse(s); return Number.isFinite(d) ? d : null;
    }
    const fmtTs = (t) => { if (t == null) return '?'; const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); const y = d.getUTCFullYear(); return (y === 1970 ? '' : y + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ') + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()); };

    // ---------- 一行 → 內容詞（模板用）與標頭（時間、等級）----------
    function lineInfo(rec, fmt, mode) {
        let text = rec.text, ts = null, level = null, extra = null;
        if (fmt.format === 'json_lines') { try { const o = JSON.parse(text); const pick = (keys) => { for (const k of keys) if (o && Object.prototype.hasOwnProperty.call(o, k)) return o[k]; return undefined; }; const tsv = pick(JSON_TS), lvv = pick(JSON_LV), msg = pick(JSON_MSG); ts = parseTs(tsv); if (lvv != null) level = String(lvv).toUpperCase(); const keys = Object.keys(o).sort(); extra = '{' + keys.join(',') + '}'; text = (level ? level + ' ' : '') + (typeof msg === 'string' ? msg : extra); } catch (_) { /* 這一行不是 JSON：照一般文字處理 */ } }
        const mk = mask(text); const toks = tokenize(mk.text, mk.vars, mode);
        if (ts == null) { const first = toks.slice(0, 4).find((x) => x.t.indexOf('<TS>') >= 0 && x.v); if (first) ts = parseTs(String(first.v).split('\u0001')[0]); else { const mt = mk.vars.find((v) => v.type === 'TS'); if (mt) ts = parseTs(mt.value); } }
        // 開頭的時間戳不放進模板（它每行都不同、又不是內容）；其他位置的型別詞留著
        let body = toks; while (body.length && /^<TS>$/.test(body[0].t)) body = body.slice(1); if (body.length) body = body.map((x, i) => (i === 0 ? Object.assign({}, x, { sp: false }) : x));
        if (!level) { const lm = LEVEL_RE.exec(text.slice(0, 160)); if (lm) level = lm[1].toUpperCase(); } if (level && LEVEL_NORM[level]) level = LEVEL_NORM[level];
        return { toks: body, ts, level, extra };
    }

    // ---------- 分群（Drain 風格：先依詞數分桶，桶內比相似度，不同的位置變成欄位）----------
    const WILD = '<*>';
    function simOf(tpl, toks) { let eq = 0, n = tpl.length; for (let i = 0; i < n; i++) if (tpl[i].t === WILD || tpl[i].t === toks[i].t) eq++; return eq / n; }
    function mine(text, opts) {
        opts = opts || {}; const fmt = detect(text); if (!fmt.ok) return { ok: false, error: fmt.reason, kind: fmt.kind };
        const maxLines = opts.maxLines || 50000; const allLines = String(text).split(/\r?\n/); const lines = allLines.length > maxLines ? allLines.slice(0, maxLines) : allLines;
        const recs = splitRecords(lines, fmt); if (recs.length < 3) return { ok: false, error: '有效紀錄太少', kind: 'text' };
        const modes = opts.mode ? [opts.mode] : (fmt.format === 'json_lines' ? ['ws'] : ['ws', 'punct']); const sims = opts.sim ? [opts.sim] : [0.5]; let best = null; const tried = [];
        for (const mode of modes) for (const sim of sims) { const r = cluster(recs, fmt, mode, sim, opts); r.score = scoreOf(r, recs.length); tried.push({ mode, sim, templates: r.templates.length, coverage: round(r.coverage), wildcardRatio: round(r.wildcardRatio), score: round(r.score) }); if (!best || r.score > best.score) best = r; }
        const model = finish(best, recs, fmt, lines.length, allLines.length > maxLines ? allLines.length : null); model.tried = tried;
        if (model.coverage < 0.3) { model.ok = true; model.weak = true; model.note = '重複的行很少（涵蓋率 ' + pct(model.coverage) + '），可能不是日誌或格式變化很大；模板只供參考'; }
        return model;
    }
    const round = (x) => Math.round(x * 1000) / 1000, pct = (x) => Math.round(x * 100) + '%';
    function cluster(recs, fmt, mode, sim, opts) {
        const buckets = new Map(); const templates = []; const infos = []; const cap = opts.maxClustersPerBucket || 300;
        for (let ri = 0; ri < recs.length; ri++) {
            const info = lineInfo(recs[ri], fmt, mode); infos.push(info); const toks = info.toks; if (!toks.length) { info.tpl = null; continue; }
            const key = toks.length + (info.extra || ''); let list = buckets.get(key); if (!list) { list = []; buckets.set(key, list); }
            let bestC = null, bestS = -1; for (const c of list) { const s = simOf(c.toks, toks); if (s > bestS) { bestS = s; bestC = c; } }
            let c;
            if (bestC && (bestS >= sim || list.length >= cap)) { c = bestC; for (let i = 0; i < toks.length; i++) if (c.toks[i].t !== WILD && c.toks[i].t !== toks[i].t) c.toks[i] = { t: WILD, sp: c.toks[i].sp }; }
            else { c = { id: templates.length, toks: toks.map((x) => ({ t: x.t, sp: x.sp })), count: 0, members: [] }; list.push(c); templates.push(c); }
            c.count++; c.members.push(ri); info.tpl = c;
        }
        // 欄位統計：模板的每個變動位置（<*> 或型別詞）蒐集原始值
        const covered = templates.filter((t) => t.count >= 2).reduce((s, t) => s + t.count, 0); let wc = 0, tot = 0; for (const t of templates) { const w = t.toks.filter((x) => x.t === WILD).length; wc += w * t.count; tot += t.toks.length * t.count; }
        return { templates, infos, mode, sim, coverage: covered / recs.length, wildcardRatio: tot ? wc / tot : 1 };
    }
    // 好的分詞：模板少、涵蓋高、不是全都變成 <*>
    function scoreOf(r, n) { const tplRatio = Math.min(1, r.templates.length / Math.max(1, n)); return 0.45 * r.coverage + 0.35 * (1 - tplRatio) + 0.2 * (1 - Math.min(1, r.wildcardRatio * 1.5)); }
    function finish(r, recs, fmt, nLines, truncatedFrom) {
        const infos = r.infos, tpls = r.templates; const out = []; const levelCount = {}; let tMin = null, tMax = null; const exc = new Map(); let withCont = 0; const buckets = new Map();
        for (const t of tpls) {
            const toks = t.toks; const display = toks.map((x, i) => (i && x.sp ? ' ' : '') + x.t).join(''); const fields = []; const posNames = nameFields(toks);
            for (let i = 0; i < toks.length; i++) if (toks[i].t === WILD || /<[A-Z]+>/.test(toks[i].t)) fields.push({ pos: i, name: posNames[i], vals: new Map(), nums: [], types: new Set() });
            out.push({ id: 'T' + (t.id + 1), pattern: display, tokens: toks.map((x) => x.t), count: t.count, level: null, levels: {}, firstLine: Infinity, lastLine: 0, firstTs: null, lastTs: null, fields, example: '', exampleTs: null, withStack: 0, _t: t });
        }
        for (let ri = 0; ri < recs.length; ri++) {
            const info = infos[ri]; const rec = recs[ri]; if (info.ts != null) { if (tMin == null || info.ts < tMin) tMin = info.ts; if (tMax == null || info.ts > tMax) tMax = info.ts; }
            if (info.level) levelCount[info.level] = (levelCount[info.level] || 0) + 1; if (rec.cont.length) withCont++;
            for (const l of rec.cont) { const m = l.match(/\b[A-Za-z_][\w.]*(?:Exception|Error)\b/); if (m) exc.set(m[0], (exc.get(m[0]) || 0) + 1); }
            if (!info.tpl) continue; const T = out[info.tpl.id]; T.firstLine = Math.min(T.firstLine, rec.n); T.lastLine = Math.max(T.lastLine, rec.n); if (!T.example) T.example = rec.text.slice(0, 300);
            if (info.ts != null) { if (T.firstTs == null || info.ts < T.firstTs) T.firstTs = info.ts; if (T.lastTs == null || info.ts > T.lastTs) T.lastTs = info.ts; const b = Math.floor(info.ts / 60000); const k = T.id; if (!T._b) T._b = new Map(); T._b.set(b, (T._b.get(b) || 0) + 1); buckets.set(b, (buckets.get(b) || 0) + 1); }
            if (info.level) T.levels[info.level] = (T.levels[info.level] || 0) + 1; if (rec.cont.length) T.withStack++;
            // 欄位值：從原始 token 取
            const toks = tokenizeForValues(rec, fmt, r.mode);
            for (const f of T.fields) { const tk = toks[f.pos]; if (!tk) continue; const val = valueOf(tk); f.vals.set(val, (f.vals.get(val) || 0) + 1); const ty = typeOfTok(tk); f.types.add(ty); const nv = Number(val); if (ty === 'NUM' && Number.isFinite(nv)) f.nums.push(nv); }
        }
        for (const T of out) {
            let top = null; for (const k of Object.keys(T.levels)) if (!top || T.levels[k] > T.levels[top]) top = k; T.level = top; delete T._t;
            T.fields = T.fields.map((f) => { const arr = Array.from(f.vals.entries()).sort((a, b) => b[1] - a[1]); const o = { pos: f.pos, name: f.name, type: f.types.size === 1 ? Array.from(f.types)[0] : (f.types.size ? 'MIX' : 'TEXT'), distinct: f.vals.size, top: arr.slice(0, 5) }; if (f.nums.length) { o.min = Math.min.apply(null, f.nums); o.max = Math.max.apply(null, f.nums); o.avg = round(f.nums.reduce((a, b) => a + b, 0) / f.nums.length); } return o; });
            if (T._b) { let pk = null; for (const [b, n] of T._b) if (!pk || n > pk[1]) pk = [b, n]; T.peak = pk ? { at: pk[0] * 60000, count: pk[1] } : null; delete T._b; } if (T.firstLine === Infinity) T.firstLine = 0;
        }
        out.sort((a, b) => b.count - a.count); let peak = null; for (const [b, n] of buckets) if (!peak || n > peak.count) peak = { at: b * 60000, count: n };
        const withTpl = infos.filter((i) => i.tpl).length;
        return { ok: true, format: fmt.format, encoding: fmt.encoding, mode: r.mode, sim: r.sim, lines: nLines, records: recs.length, withStack: withCont, truncatedFrom, templates: out, coverage: r.coverage, wildcardRatio: r.wildcardRatio, levels: levelCount, timeRange: tMin != null ? { from: tMin, to: tMax } : null, peakMinute: peak, exceptions: Array.from(exc.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10), unmatched: recs.length - withTpl, fmtInfo: { jsonRatio: round(fmt.jsonRatio), kvRatio: round(fmt.kvRatio), tsRatio: round(fmt.tsRatio), levelRatio: round(fmt.levelRatio) } };
    }
    // 重新取得某一筆紀錄的詞（含原始值）；成本跟 lineInfo 同量級，只在 finish 裡用一次
    function tokenizeForValues(rec, fmt, mode) {
        let text = rec.text; if (fmt.format === 'json_lines') { try { const o = JSON.parse(text); let msg; for (const k of JSON_MSG) if (o && Object.prototype.hasOwnProperty.call(o, k)) { msg = o[k]; break; } let lv; for (const k of JSON_LV) if (o && Object.prototype.hasOwnProperty.call(o, k)) { lv = o[k]; break; } text = (lv != null ? String(lv).toUpperCase() + ' ' : '') + (typeof msg === 'string' ? msg : '{' + Object.keys(o).sort().join(',') + '}'); } catch (_) { /* 不是 JSON */ } }
        const mk = mask(text); let toks = tokenize(mk.text, mk.vars, mode); while (toks.length && toks[0].t === '<TS>') toks = toks.slice(1); return toks;
    }
    const valueOf = (tk) => (tk.v != null ? restore(tk) : tk.t);
    function restore(tk) { if (tk.v == null) return tk.t; const parts = String(tk.v).split('\u0001'); let i = 0; return tk.t.replace(/<[A-Z]+>/g, () => (parts[i++] != null ? parts[i - 1] : '?')); }
    function typeOfTok(tk) { const m = /^<([A-Z]+)>$/.exec(tk.t); if (m) return m[1]; const v = tk.t; if (TYPE_RE.NUM.test(v)) return 'NUM'; return /^[A-Za-z_][\w.-]*$/.test(v) ? 'WORD' : 'TEXT'; }
    // 欄位命名：前一個詞是「=」或「:」就用它前面的鍵名（user=<*> → user）；沒有就用型別或 pN
    function nameFields(toks) { const names = {}; let k = 0; const used = new Set(); for (let i = 0; i < toks.length; i++) { const t = toks[i].t; if (!(t === WILD || /<[A-Z]+>/.test(t))) continue; let nm = null; const eq = /^([A-Za-z_][\w.-]*)=/.exec(t); if (eq) nm = eq[1]; else if (i >= 2 && (toks[i - 1].t === '=' || toks[i - 1].t === ':') && /^[A-Za-z_][\w.-]*$/.test(toks[i - 2].t)) nm = toks[i - 2].t; else if (i >= 1 && /^[A-Za-z_][\w.-]*[:=]$/.test(toks[i - 1].t)) nm = toks[i - 1].t.slice(0, -1); if (!nm) { const ty = /<([A-Z]+)>/.exec(t); nm = ty ? ty[1].toLowerCase() : 'p'; } let u = nm, j = 2; while (used.has(u)) u = nm + j++; used.add(u); names[i] = u; k++; } return names; }

    // ---------- 比對新紀錄 ----------
    function matchLine(model, line) {
        const mode = model.mode; const info = lineInfo({ text: line, cont: [] }, { format: model.format }, mode); const toks = info.toks; if (!toks.length) return null;
        let best = null; for (const T of model.templates) { if (T.tokens.length !== toks.length) continue; let ok = true, eq = 0; for (let i = 0; i < toks.length; i++) { if (T.tokens[i] === WILD) continue; if (T.tokens[i] === toks[i].t) eq++; else { ok = false; break; } } if (ok && (!best || eq > best.eq)) best = { T, eq }; }
        if (!best) return null; const vt = tokenizeForValues({ text: line }, { format: model.format }, mode); const params = {}; for (const f of best.T.fields) { const tk = vt[f.pos]; if (tk) params[f.name] = valueOf(tk); }
        return { template: best.T.id, pattern: best.T.pattern, params, level: info.level, ts: info.ts };
    }
    // 模板 → 正規表示式（給離線訓練器的規則比對用；只要判斷「這一行像不像這個格式」）
    function templateRegex(T) {
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); const cls = { NUM: '-?\\d+(?:\\.\\d+)?', IP: '\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d+)?', UUID: '[0-9a-fA-F-]{36}', TS: '[\\d:.,TZ/ +-]+', HEX: '(?:0x)?[0-9a-fA-F]+' };
        return T.tokens.map((t, i) => { const m = /^<([A-Z]+)>$/.exec(t); let r; if (t === WILD) r = '\\S+'; else if (m) r = cls[m[1]] || '\\S+'; else r = esc(t).replace(/<([A-Z]+)>/g, (x, ty) => cls[ty] || '\\S+'); return r; }).join('\\s*');
    }

    // ---------- 摘要（全是統計）----------
    function summarize(model, opts) {
        opts = opts || {}; const L = []; const top = opts.top || 8;
        L.push('格式：' + ({ json_lines: 'JSON 每行一筆', key_value: 'key=value', timestamped: '開頭有時間戳的文字', free_text: '一般文字' }[model.format] || model.format) + '（' + model.encoding + '）；' + model.lines + ' 行、' + model.records + ' 筆紀錄' + (model.withStack ? '（其中 ' + model.withStack + ' 筆帶堆疊／續行）' : '') + (model.truncatedFrom ? '；只分析了前 ' + model.lines + ' 行（全部 ' + model.truncatedFrom + ' 行）' : ''));
        L.push('找到 ' + model.templates.length + ' 種模板，前 ' + Math.min(top, model.templates.length) + ' 種涵蓋 ' + pct(model.templates.slice(0, top).reduce((s, t) => s + t.count, 0) / model.records) + '；分詞方式 ' + (model.mode === 'ws' ? '空白' : '空白＋標點') + '，重複涵蓋率 ' + pct(model.coverage) + (model.weak ? '（偏低：' + model.note + '）' : ''));
        if (model.timeRange) L.push('時間：' + fmtTs(model.timeRange.from) + ' ～ ' + fmtTs(model.timeRange.to) + (model.peakMinute ? '；最忙的一分鐘是 ' + fmtTs(model.peakMinute.at) + '（' + model.peakMinute.count + ' 筆）' : ''));
        const lv = Object.entries(model.levels).sort((a, b) => b[1] - a[1]); if (lv.length) L.push('等級：' + lv.map(([k, n]) => k + ' ' + n).join('、'));
        model.templates.slice(0, top).forEach((t) => L.push(t.id + '（' + t.count + ' 次' + (t.level ? '，' + t.level : '') + '）' + t.pattern.slice(0, 160)));
        const errs = model.templates.filter((t) => t.level === 'ERROR' || t.level === 'FATAL').slice(0, 5); if (errs.length) { L.push('錯誤類模板：'); errs.forEach((t) => L.push('  ' + t.id + '（' + t.count + ' 次，' + fmtTs(t.firstTs) + ' 起）' + t.pattern.slice(0, 140))); }
        if (model.exceptions.length) L.push('例外類別：' + model.exceptions.map(([k, n]) => k + ' ' + n).join('、'));
        const rare = model.templates.filter((t) => t.count === 1).length; if (rare) L.push('只出現一次的模板：' + rare + ' 種（可能是異常或一次性事件）');
        const conc = []; for (const t of model.templates.slice(0, 30)) for (const f of t.fields) if (t.count >= 5 && f.distinct > 1 && f.top[0] && f.top[0][1] / t.count >= 0.6 && f.type !== 'NUM') conc.push(t.id + '.' + f.name + '＝' + String(f.top[0][0]).slice(0, 40) + '（' + pct(f.top[0][1] / t.count) + '）'); if (conc.length) L.push('值特別集中的欄位：' + conc.slice(0, 6).join('、'));
        return L;
    }
    // 給模型的精簡脈絡（開放式問題用；不含整份日誌）
    function compactContext(model, maxChars) { const s = summarize(model, { top: 12 }).join('\n'); return s.slice(0, maxChars || 3500); }

    // ---------- 問答（封閉的查詢；答不了就明說，並交出精簡脈絡給呼叫端）----------
    function ask(model, q, opts) {
        opts = opts || {}; const text = String(q || '').trim(); const lines = opts.lines || null; const T = model.templates; const lc = text.toLowerCase();
        const levelOf = () => { if (/(?:fatal|致命|嚴重)/i.test(text)) return ['FATAL']; if (/(?:error|錯誤|失敗|例外|exception|異常)/i.test(text)) return ['ERROR', 'FATAL']; if (/(?:warn|警告)/i.test(text)) return ['WARN']; return null; };
        const lv = levelOf(); const pool = lv ? T.filter((t) => lv.includes(t.level) || lv.some((l) => t.levels[l])) : T; const tid = (/\bT(\d+)\b/i.exec(text) || [])[1]; const byId = tid ? T.find((t) => t.id === 'T' + tid) : null;
        if (/(?:摘要|總結|概況|summary|overview|整體)/i.test(text)) return { kind: 'summary', answer: summarize(model).join('\n') };
        if (byId && !/(?:欄位|分布|值)/.test(text)) return { kind: 'template', answer: byId.id + '：' + byId.pattern + '\n次數 ' + byId.count + '；第一次 ' + fmtTs(byId.firstTs) + '（第 ' + byId.firstLine + ' 行）；最後一次 ' + fmtTs(byId.lastTs) + '（第 ' + byId.lastLine + ' 行）\n範例：' + byId.example + (byId.fields.length ? '\n欄位：' + byId.fields.map((f) => f.name + '（' + f.type + '，' + f.distinct + ' 種值，最常見 ' + (f.top[0] ? String(f.top[0][0]).slice(0, 30) + '×' + f.top[0][1] : '無') + '）').join('；') : '') };
        if (/(?:什麼時候|何時|幾點|第一次|最早|開始|最後一次|最晚|最近|when|first|last)/i.test(text) && (lv || byId)) { const ts = (byId ? [byId] : pool).filter((t) => t.firstTs != null); if (!ts.length) return { kind: 'time', answer: '符合的紀錄沒有可解析的時間。' }; const first = Math.min.apply(null, ts.map((t) => t.firstTs)), last = Math.max.apply(null, ts.map((t) => t.lastTs)); return { kind: 'time', answer: '第一次 ' + fmtTs(first) + '，最後一次 ' + fmtTs(last) + '（' + ts.reduce((s, t) => s + t.count, 0) + ' 筆，' + ts.length + ' 種模板）' }; }
        if (/(?:多少|幾筆|幾次|幾個|數量|count|how many)/i.test(text) && !/(?:模板|種類|格式)/.test(text)) { if (lv) return { kind: 'count', answer: '符合的紀錄 ' + pool.reduce((s, t) => s + (lv.reduce((a, l) => a + (t.levels[l] || 0), 0) || 0), 0) + ' 筆（' + lv.join('／') + '），分屬 ' + pool.length + ' 種模板' }; return { kind: 'count', answer: '共 ' + model.records + ' 筆紀錄、' + T.length + ' 種模板' }; }
        if (/(?:最多|最常|top|前幾|排行|常見)/i.test(text)) { const n = Math.min(10, Number((/前\s*(\d+)/.exec(text) || [])[1]) || 5); const r = pool.slice(0, n); return { kind: 'top', answer: r.length ? r.map((t, i) => (i + 1) + '. ' + t.id + '（' + t.count + ' 次）' + t.pattern.slice(0, 140)).join('\n') : '沒有符合的模板' }; }
        if (/(?:欄位|分布|有哪些值|值|取值)/.test(text)) { const nm = [].concat(...T.slice(0, 60).map((t) => t.fields.map((f) => ({ t, f })))).filter((x) => x.f.name.length > 1 && lc.indexOf(x.f.name.toLowerCase()) >= 0); if (nm.length) { const x = nm[0]; return { kind: 'field', answer: x.t.id + ' 的欄位 ' + x.f.name + '（' + x.f.type + '，' + x.f.distinct + ' 種值）：' + x.f.top.map(([v, n]) => String(v).slice(0, 40) + '×' + n).join('、') + (x.f.min != null ? '；範圍 ' + x.f.min + '～' + x.f.max + '，平均 ' + x.f.avg : '') }; } }
        if (/(?:模板|格式|種類|有哪幾種|pattern|template)/i.test(text)) return { kind: 'templates', answer: T.slice(0, 15).map((t) => t.id + '（' + t.count + '）' + t.pattern.slice(0, 140)).join('\n') + (T.length > 15 ? '\n…還有 ' + (T.length - 15) + ' 種' : '') };
        if (/(?:時間|分布|高峰|尖峰|最忙|peak|busiest)/i.test(text)) return { kind: 'peak', answer: model.peakMinute ? '最忙的一分鐘是 ' + fmtTs(model.peakMinute.at) + '（' + model.peakMinute.count + ' 筆）；全部時間 ' + fmtTs(model.timeRange.from) + ' ～ ' + fmtTs(model.timeRange.to) : '紀錄沒有可解析的時間。' };
        // 找包含某個值的行（需要原始行）
        const needle = (/["「『'`]([^"」』'`]{2,80})["」』'`]/.exec(text) || [])[1] || (/(?:包含|含有|搜尋|找|grep|contains?)\s*[:：]?\s*(\S{2,60})/i.exec(text) || [])[1];
        if (needle) { if (!lines) return { kind: 'find', answer: '要找「' + needle + '」需要原始檔案（只存了模板與統計，沒有存整份日誌）；請再提供檔案。', needsLines: true }; const hit = []; for (let i = 0; i < lines.length && hit.length < 200; i++) if (lines[i].indexOf(needle) >= 0) hit.push(i + 1); return { kind: 'find', answer: hit.length ? '「' + needle + '」出現在 ' + hit.length + (hit.length >= 200 ? '+' : '') + ' 行；前幾行：' + hit.slice(0, 8).join('、') + '\n' + hit.slice(0, 3).map((n) => n + ': ' + lines[n - 1].slice(0, 200)).join('\n') : '沒有找到「' + needle + '」', lines: hit.slice(0, 50) }; }
        return { kind: 'open', answer: null, context: compactContext(model), note: '這個問題需要判斷，不是統計查詢；已附上精簡脈絡（模板與統計），可以交給模型回答' };
    }

    // ---------- 離線訓練器的規則 ----------
    // 一個格式 → 一條規則：觸發是「貼上的文字像這個格式」（任一模板的正規表示式命中），附上模板與統計（不含整份日誌）
    function toTrainerPattern(model, name, opts) {
        opts = opts || {}; const id = 'log_' + String(name).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '_').slice(0, 40); const tpls = model.templates.filter((t) => t.count >= 2).slice(0, 25);
        const regs = tpls.map((t) => { try { const r = templateRegex(t); new RegExp(r); return r.length < 400 ? '(?:' + r + ')' : null; } catch (_) { return null; } }).filter(Boolean);
        const slim = { v: 1, name, format: model.format, mode: model.mode, encoding: model.encoding, records: model.records, lines: model.lines, timeRange: model.timeRange, levels: model.levels, exceptions: model.exceptions, coverage: model.coverage, peakMinute: model.peakMinute, learnedAt: Date.now(), source: opts.source || '', templates: model.templates.slice(0, 120).map((t) => ({ id: t.id, pattern: t.pattern, tokens: t.tokens, count: t.count, level: t.level, levels: t.levels, firstLine: t.firstLine, lastLine: t.lastLine, firstTs: t.firstTs, lastTs: t.lastTs, example: t.example, peak: t.peak, fields: t.fields.map((f) => ({ pos: f.pos, name: f.name, type: f.type, distinct: f.distinct, top: f.top.slice(0, 5), min: f.min, max: f.max, avg: f.avg })) })) };
        return { id, type: regs.length ? 'regex' : 'semantic', expr: regs.length ? '^(?:' + regs.join('|') + ')' : undefined, examples: tpls.slice(0, 5).map((t) => t.example), intent: '已學過的日誌格式「' + name + '」（' + model.templates.length + ' 種模板）', description: summarize(model, { top: 4 }).slice(0, 4).join('；'), tool: 'log_ask', args: { format: name, question: '這一行是什麼意思', text: '{problem_text}' }, confidence: 0.8, risk: 'safe', source: 'learned', enabled: true, hits: 0, log_model: slim };
    }
    // 存下來的精簡模型 → 可以問答的模型（沒有原始行）
    function fromSlim(slim) { return { ok: true, format: slim.format, mode: slim.mode, encoding: slim.encoding, records: slim.records, lines: slim.lines, timeRange: slim.timeRange, levels: slim.levels || {}, exceptions: slim.exceptions || [], coverage: slim.coverage || 0, peakMinute: slim.peakMinute || null, withStack: 0, sim: 0.5, templates: (slim.templates || []).map((t) => Object.assign({ fields: [], levels: {} }, t)), unmatched: 0 }; }

    return { detect, mask, tokenize, splitRecords, parseTs, fmtTs, mine, matchLine, templateRegex, summarize, compactContext, ask, toTrainerPattern, fromSlim, WILD };
});
