/* 離線設定檔結構學習（FaCfg）：INI／TOML／EDK2（INF、DEC、DSC、FDF）這類「章節＋鍵值」的文字設定檔。
 * 跟日誌不同：設定檔不是同一句型重複很多次，每一行的「鍵名」本身就是資訊、所屬的章節決定意義。
 * 所以不做模板探勘，而是把檔案切成 章節 → 條目（鍵、值、型別、行號、註解），再做統計、摘要、問答、兩份檔案比較。
 * 全部是純函式（UMD）：不碰畫面、不呼叫模型。認不出就說認不出，不編造。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCfg = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SECTION_RE = /^\s*(\[\[?)\s*([^\]\r\n]+?)\s*\]\]?\s*(?:[;#].*)?$/;
    const COMMENT_RE = /^\s*(?:[;#]|\/\/)/;
    const EDK2_SECTIONS = ['defines', 'sources', 'packages', 'libraryclasses', 'protocols', 'ppis', 'guids', 'pcd', 'pcds', 'pcdsfixedatbuild', 'pcdspatchableinmodule', 'pcdsfeatureflag', 'pcdsdynamic', 'pcdsdynamicex', 'pcdsdynamicdefault', 'pcdsdynamicexdefault', 'depex', 'binaries', 'buildoptions', 'components', 'skuids', 'defaultstores', 'userextensions', 'includes', 'fd', 'fv', 'rule', 'capsule', 'fmpPayload'.toLowerCase(), 'featurepcd', 'patchpcd', 'pcdex', 'buildoptions', 'nmakeoption'];
    const EDK2_KEYS = /^(INF_VERSION|BASE_NAME|FILE_GUID|MODULE_TYPE|VERSION_STRING|ENTRY_POINT|PLATFORM_NAME|PLATFORM_GUID|PLATFORM_VERSION|DSC_SPECIFICATION|OUTPUT_DIRECTORY|SUPPORTED_ARCHITECTURES|BUILD_TARGETS|SKUID_IDENTIFIER|FLASH_DEFINITION|PACKAGE_NAME|PACKAGE_GUID|PACKAGE_VERSION|DEC_SPECIFICATION|FD_BASE_ADDRESS|FDF_VERSION|BASE_ADDRESS|ERASE_POLARITY)$/;

    // ---------- 值的型別 ----------
    const TYPE_TESTS = [
        ['bool', /^(?:true|false|yes|no|on|off|enabled?|disabled?)$/i],
        ['guid', /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i],
        ['hex', /^0x[0-9a-f]+$/i],
        ['int', /^[+-]?\d+$/],
        ['float', /^[+-]?\d+\.\d+(?:[eE][+-]?\d+)?$/],
        ['version', /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?$/],
        ['ip', /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/],
        ['url', /^[a-z][a-z0-9+.-]*:\/\/\S+$/i],
        ['datetime', /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/],
        ['duration', /^\d+(?:\.\d+)?\s?(?:ms|us|s|sec|min|m|h|d)$/i],
        ['size', /^\d+(?:\.\d+)?\s?(?:KB|MB|GB|TB|KiB|MiB|GiB|K|M|G)$/i],
        ['path', /^(?:[A-Za-z]:)?(?:[\\/]|\.{1,2}[\\/]|\$\()[^\s]*$|^[\w.$()-]+(?:[\\/][\w.$()@+-]+)+$/],
    ];
    function valueType(raw) {
        let v = String(raw == null ? '' : raw).trim(); if (v === '') return 'empty';
        if (/^"""|^'''/.test(v)) return 'string'; if (/^(?:"[^"]*"|'[^']*')$/.test(v)) { const inner = v.slice(1, -1); const t = valueType(inner); return t === 'empty' ? 'string' : (['bool', 'int', 'hex', 'float'].includes(t) ? 'string' : t === 'path' || t === 'url' || t === 'guid' || t === 'datetime' ? t : 'string'); }
        if (/^\[.*\]$/.test(v)) return 'array'; if (/^\{.*\}$/.test(v) && !TYPE_TESTS[1][1].test(v)) return 'table';
        for (const [t, re] of TYPE_TESTS) if (re.test(v)) return t;
        if (/[,;]/.test(v) && v.split(/[,;]/).length >= 2 && v.split(/[,;]/).every((x) => x.trim().length)) return 'list';
        return 'string';
    }
    // 疑似機密（密碼、金鑰、token…）：存進訓練器、或交給模型的脈絡裡一律遮掉，只有在本機問答時才顯示
    const SECRET_KEY = /(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|auth|passphrase)/i;
    const redact = (key, value) => (key && SECRET_KEY.test(key) && String(value).trim() !== '' ? '***（已遮蔽）' : String(value).replace(/(:\/\/[^\/\s:@]+:)[^@\s\/]+@/g, '$1***@'));
    const unq = (v) => { v = String(v).trim(); const m = /^("""|''')([\s\S]*?)\1$/.exec(v); if (m) return m[2]; return /^(?:"[^"]*"|'[^']*')$/.test(v) ? v.slice(1, -1) : v; };

    // ---------- 認格式 ----------
    // 回傳 { ok, format, score, ... }；format：toml／ini／edk2_inf／edk2_dec／edk2_dsc／edk2_fdf／edk2／flat（沒有章節的 key=value）
    function detect(text) {
        const s = String(text == null ? '' : text); if (!s.trim()) return { ok: false, reason: '沒有內容' };
        let ctrl = 0; const lim = Math.min(s.length, 20000); for (let i = 0; i < lim; i++) { const c = s.charCodeAt(i); if (c < 9 || (c > 13 && c < 32) || c === 0xFFFD) ctrl++; } if (ctrl > 20 || ctrl / lim > 0.01) return { ok: false, kind: 'binary', reason: '含大量控制字元或無法解碼的字元，不像文字設定檔' };
        const lines = s.split(/\r?\n/).slice(0, 5000); let nonblank = 0, sec = 0, kv = 0, comm = 0, item = 0, tsl = 0, dir = 0; const secNames = []; const keys = new Map(); let toml = 0, edk2key = 0;
        for (const l of lines) {
            if (!l.trim()) continue; nonblank++;
            if (COMMENT_RE.test(l)) { comm++; continue; }
            const m = SECTION_RE.exec(l); if (m) { sec++; secNames.push(m[2]); if (m[1] === '[[') toml++; continue; }
            if (/^\s*!(?:include|if|ifdef|ifndef|else|elseif|endif|error|macro)\b/i.test(l) || /^\s*DEFINE\s+/i.test(l)) { dir++; if (/^\s*DEFINE\s+\w+\s*=/i.test(l)) kv++; continue; }
            const km = /^\s*([A-Za-z_$@][\w.$@\-\[\]\/]*)\s*(=|:|\|)\s*(.*)$/.exec(l);
            if (km && !/^\s*(?:https?|ftp|file):\/\//i.test(l)) { kv++; keys.set(km[1], (keys.get(km[1]) || 0) + 1); if (EDK2_KEYS.test(km[1])) edk2key++; if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:/.test(l)) tsl++; if (km[2] === '=' && /^\s*(?:"[^"]*"|\[.*\]|\{.*\}|true|false)\s*(?:#.*)?$/.test(km[3])) toml++; continue; }
            if (/^\s+\S+/.test(l) || /^[\w./\\$()-]+$/.test(l.trim())) { item++; continue; }
            return { ok: false, reason: '有不像設定檔的行（第 ' + (lines.indexOf(l) + 1) + ' 行）', kind: 'text' };
        }
        const secLower = secNames.map((n) => n.split(/[.,\s]/)[0].toLowerCase()); const edk2Sec = secLower.filter((n) => EDK2_SECTIONS.includes(n)).length;
        const covered = (sec + kv + comm + item + dir) / Math.max(1, nonblank);
        const uniqKeys = keys.size / Math.max(1, Array.from(keys.values()).reduce((a, b) => a + b, 0));
        if (nonblank < 3) return { ok: false, reason: '行數太少' };
        let format = null;
        if (edk2Sec >= 1 && (edk2Sec >= secNames.length * 0.5 || edk2key >= 1)) { const names = new Set(secLower); format = names.has('components') || names.has('pcdsfixedatbuild') && /PLATFORM_NAME|DSC_SPECIFICATION/.test(s) ? 'edk2_dsc' : (/\bINF_VERSION\b/.test(s) ? 'edk2_inf' : (/\bDEC_SPECIFICATION\b|\bPACKAGE_NAME\b/.test(s) ? 'edk2_dec' : (/\bFDF_VERSION\b|\bFD_BASE|\[(?:FD|FV|Rule)\b/i.test(s) ? 'edk2_fdf' : (/\bPLATFORM_NAME\b|\bDSC_SPECIFICATION\b/.test(s) ? 'edk2_dsc' : 'edk2')))); }
        else if (sec >= 1 && covered >= 0.85 && kv + item >= 2) format = (toml >= 1 && (toml >= kv * 0.4 || /^\s*\[\[|^\s*\[[\w-]+\.[\w.-]+\]/m.test(s))) ? 'toml' : 'ini';
        else if (sec === 0 && kv >= 3 && covered >= 0.85 && uniqKeys >= 0.8 && tsl / Math.max(1, kv) < 0.2) format = toml >= kv * 0.5 ? 'toml' : 'flat';
        if (!format) return { ok: false, reason: '不像章節式設定檔（章節 ' + sec + '、鍵值 ' + kv + '、涵蓋 ' + Math.round(covered * 100) + '%）', kind: 'text', sections: sec };
        return { ok: true, format, score: covered, sections: sec, keyValues: kv, edk2Sections: edk2Sec };
    }

    // ---------- 解析 ----------
    const isEdk2 = (f) => /^edk2/.test(f);
    // 章節名稱：INI/TOML 就是名稱；EDK2 的 [Sources.X64, Sources.IA32] 會拆成 {base:'Sources', arch:['X64'], …}（可以有多個，用逗號隔開）
    function sectionParts(name, format) {
        if (!isEdk2(format)) return [{ base: name, qual: [] }];
        return name.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const p = x.split('.'); return { base: p[0], qual: p.slice(1) }; });
    }
    function parse(text, opts) {
        opts = opts || {}; const det = opts.format ? { ok: true, format: opts.format } : detect(text); if (!det.ok) return { ok: false, error: det.reason, kind: det.kind || 'text' };
        const format = det.format; const rawLines = String(text).split(/\r?\n/); const lines = rawLines.length > (opts.maxLines || 20000) ? rawLines.slice(0, opts.maxLines || 20000) : rawLines;
        const sections = []; let cur = { name: '', base: '', parts: [], line: 0, entries: [], comments: 0, implicit: true, tomlArray: false }; sections.push(cur); const directives = []; const defines = {}; let pendingComment = []; let inMulti = null;
        for (let i = 0; i < lines.length; i++) {
            let l = lines[i]; const n = i + 1;
            if (inMulti) { const e = cur.entries[cur.entries.length - 1]; e.raw += '\n' + l; if (l.indexOf(inMulti) >= 0) inMulti = null; continue; }
            if (!l.trim()) { pendingComment = []; continue; }
            if (COMMENT_RE.test(l)) { cur.comments++; pendingComment.push(l.replace(/^\s*(?:[;#]|\/\/)+\s?/, '').trim()); continue; }
            const sm = SECTION_RE.exec(l);
            if (sm) { cur = { name: sm[2], base: sm[2].split(/[.,\s]/)[0], parts: sectionParts(sm[2], format), line: n, entries: [], comments: 0, tomlArray: sm[1] === '[[', doc: pendingComment.join(' ').slice(0, 160) || null }; sections.push(cur); pendingComment = []; continue; }
            const dm = /^\s*!(\w+)\s*(.*)$/.exec(l); if (dm) { directives.push({ line: n, name: dm[1].toLowerCase(), arg: dm[2].trim().slice(0, 200), section: cur.name }); cur.entries.push({ line: n, kind: 'directive', key: '!' + dm[1].toLowerCase(), value: dm[2].trim(), type: 'directive', raw: l.trim() }); continue; }
            const defm = /^\s*DEFINE\s+([\w.]+)\s*=\s*(.*?)\s*$/i.exec(l); if (defm) { defines[defm[1]] = defm[2]; cur.entries.push({ line: n, kind: 'define', key: defm[1], value: defm[2], type: valueType(defm[2]), raw: l.trim() }); continue; }
            // 行尾註解（INI／EDK2 的 # 或 ;，TOML 的 #；字串裡的不算）
            let body = l, tail = null; const cm = /^((?:[^"'#;]|"[^"]*"|'[^']*')*?)\s+([#;].*)$/.exec(l); if (cm) { body = cm[1]; tail = cm[2]; }
            const km = /^\s*([A-Za-z_$@][\w.$@\-\[\]\/ ]*?)\s*(=|:)\s*(.*?)\s*$/.exec(body); const pm = !km && isEdk2(format) ? /^\s*([^\s|=]+(?:\s[^\s|=]+)*?)\s*\|\s*(.*?)\s*$/.exec(body) : null;
            let e;
            if (km && km[2] === '=' || (km && km[2] === ':' && !/^\w:[\\/]/.test(body.trim()) && !isEdk2(format))) { const key = km[1].trim(); e = { line: n, kind: 'kv', key, value: km[3], type: valueType(km[3]), raw: l.trim() }; if (/^"""|^'''/.test(km[3].trim()) && !/("""|''')\s*$/.test(km[3].trim().slice(3))) inMulti = km[3].trim().slice(0, 3); }
            else if (pm) { e = { line: n, kind: 'kv', key: pm[1].trim(), value: pm[2], type: valueType(pm[2].split('|')[0]), raw: l.trim(), pipe: true }; }
            else if (km && km[2] === ':') { e = { line: n, kind: 'kv', key: km[1].trim(), value: km[3], type: valueType(km[3]), raw: l.trim() }; }
            else e = { line: n, kind: 'item', key: null, value: body.trim(), type: valueType(body.trim()) === 'path' ? 'path' : 'item', raw: l.trim() };
            if (tail) e.comment = tail.replace(/^[#;]+\s*/, '').slice(0, 120); if (pendingComment.length) { e.doc = pendingComment.join(' ').slice(0, 160); pendingComment = []; } cur.entries.push(e);
        }
        const out = sections.filter((s, i) => !(i === 0 && s.implicit && !s.entries.length));
        const model = { ok: true, kind: 'config', format, lines: lines.length, truncatedFrom: rawLines.length > lines.length ? rawLines.length : null, sections: out.map((s) => ({ name: s.name, base: s.base, parts: s.parts, line: s.line, tomlArray: !!s.tomlArray, doc: s.doc || null, comments: s.comments, entries: s.entries })), directives, defines };
        return Object.assign(model, stats(model));
    }
    function stats(model) {
        const typeCount = {}; let entries = 0, keyed = 0, items = 0; const dupKeys = []; const keyIndex = new Map(); const guids = new Set(); const bySection = {}; let comments = 0, empties = 0;
        for (const s of model.sections) {
            const seen = new Map(); comments += s.comments; const tally = (bySection[s.name || '(最上層)'] = bySection[s.name || '(最上層)'] || { entries: 0, keys: 0, items: 0, line: s.line });
            for (const e of s.entries) { entries++; tally.entries++; if (e.kind === 'item') { items++; tally.items++; } else if (e.kind === 'kv' || e.kind === 'define') { keyed++; tally.keys++; const k = e.key; if (!keyIndex.has(k)) keyIndex.set(k, []); keyIndex.get(k).push({ section: s.name, line: e.line, value: e.value, type: e.type }); if (seen.has(k) && !s.tomlArray) dupKeys.push({ section: s.name, key: k, lines: [seen.get(k), e.line] }); else seen.set(k, e.line); }
                typeCount[e.type] = (typeCount[e.type] || 0) + 1; if (e.type === 'empty') empties++; const g = String(e.value).match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g); if (g) g.forEach((x) => guids.add(x.toLowerCase())); }
        }
        return { entries, keyed, items, comments, typeCount, dupKeys, guids: Array.from(guids), keyIndex, bySection };
    }
    // keyIndex 是 Map（不能直接 JSON）；存檔時用 slim
    const fmtName = { ini: 'INI', toml: 'TOML', flat: '沒有章節的 key=value', edk2_inf: 'EDK2 INF（模組）', edk2_dec: 'EDK2 DEC（套件宣告）', edk2_dsc: 'EDK2 DSC（平台描述）', edk2_fdf: 'EDK2 FDF（Flash 描述）', edk2: 'EDK2 風格' };

    // ---------- 摘要 ----------
    function get(model, section, key) { for (const s of model.sections) if (s.name === section) for (const e of s.entries) if (e.key === key) return e; return null; }
    function summarize(model, opts) {
        opts = opts || {}; const L = []; const secs = model.sections;
        L.push('格式：' + (fmtName[model.format] || model.format) + '；' + model.lines + ' 行、' + secs.length + ' 個章節、' + model.keyed + ' 個鍵值、' + model.items + ' 個條目（沒有鍵的行，例如檔案清單）、' + model.comments + ' 行註解' + (model.truncatedFrom ? '；只分析了前 ' + model.lines + ' 行（全部 ' + model.truncatedFrom + ' 行）' : ''));
        if (model.format === 'edk2_inf') { const g = (k) => { const e = get(model, 'Defines', k); return e ? e.value : null; }; const bits = ['BASE_NAME', 'MODULE_TYPE', 'FILE_GUID', 'ENTRY_POINT', 'VERSION_STRING'].map((k) => (g(k) ? k + '＝' + g(k) : null)).filter(Boolean); if (bits.length) L.push('模組：' + bits.join('；')); }
        if (model.format === 'edk2_dsc') { const g = (k) => { const e = get(model, 'Defines', k); return e ? e.value : null; }; const bits = ['PLATFORM_NAME', 'PLATFORM_GUID', 'SUPPORTED_ARCHITECTURES', 'BUILD_TARGETS', 'OUTPUT_DIRECTORY'].map((k) => (g(k) ? k + '＝' + g(k) : null)).filter(Boolean); if (bits.length) L.push('平台：' + bits.join('；')); }
        if (model.format === 'edk2_dec') { const g = (k) => { const e = get(model, 'Defines', k); return e ? e.value : null; }; const bits = ['PACKAGE_NAME', 'PACKAGE_GUID', 'PACKAGE_VERSION'].map((k) => (g(k) ? k + '＝' + g(k) : null)).filter(Boolean); if (bits.length) L.push('套件：' + bits.join('；')); }
        L.push('章節：' + secs.slice(0, 30).map((s) => (s.name || '(最上層)') + '（' + s.entries.length + '）').join('、') + (secs.length > 30 ? '…還有 ' + (secs.length - 30) + ' 個' : ''));
        const tc = Object.entries(model.typeCount).sort((a, b) => b[1] - a[1]); if (tc.length) L.push('值的型別：' + tc.map(([k, n]) => k + ' ' + n).join('、'));
        if (model.dupKeys.length) L.push('同一章節內重複的鍵（後面的通常會蓋掉前面的）：' + model.dupKeys.slice(0, 6).map((d) => '[' + d.section + '] ' + d.key + '（第 ' + d.lines.join('、') + ' 行）').join('；') + (model.dupKeys.length > 6 ? '…共 ' + model.dupKeys.length + ' 個' : ''));
        const empt = []; for (const s of secs) for (const e of s.entries) if (e.kind === 'kv' && e.type === 'empty') empt.push('[' + s.name + '] ' + e.key); if (empt.length) L.push('值是空的：' + empt.slice(0, 8).join('、') + (empt.length > 8 ? '…共 ' + empt.length + ' 個' : ''));
        if (model.guids.length) L.push('GUID：' + model.guids.length + ' 個（' + model.guids.slice(0, 3).join('、') + (model.guids.length > 3 ? '…' : '') + '）');
        if (model.directives.length) { const inc = model.directives.filter((d) => d.name === 'include').map((d) => d.arg); L.push('前置指令：' + model.directives.length + ' 個' + (inc.length ? '；引用的檔案：' + inc.slice(0, 6).join('、') : '')); }
        if (isEdk2(model.format)) { const fl = secs.filter((s) => /^sources$/i.test(s.base)).reduce((n, s) => n + s.entries.filter((e) => e.kind === 'item').length, 0); if (fl) L.push('原始檔：' + fl + ' 個（Sources）'); const pcd = secs.filter((s) => /^pcd/i.test(s.base)).reduce((n, s) => n + s.entries.filter((e) => e.kind === 'kv').length, 0); if (pcd) L.push('PCD 設定：' + pcd + ' 個'); }
        const bools = []; for (const s of secs) for (const e of s.entries) if (e.type === 'bool') bools.push((s.name ? '[' + s.name + '] ' : '') + e.key + '＝' + redact(e.key, e.value)); if (bools.length) L.push('布林開關：' + bools.slice(0, 8).join('、') + (bools.length > 8 ? '…共 ' + bools.length + ' 個' : ''));
        return L;
    }
    function compactContext(model, maxChars) {
        const L = summarize(model); const sec = model.sections.slice(0, 25).map((s) => '[' + s.name + ']\n' + s.entries.slice(0, 12).map((e) => '  ' + (e.key ? e.key + ' = ' : '') + redact(e.key, e.value).slice(0, 80)).join('\n') + (s.entries.length > 12 ? '\n  …還有 ' + (s.entries.length - 12) + ' 條' : '')).join('\n'); return (L.join('\n') + '\n\n' + sec).slice(0, maxChars || 4500);
    }

    // ---------- 問答（封閉的查詢）----------
    const norm = (s) => String(s).toLowerCase().replace(/[\s_\-]/g, '');
    function findSection(model, text) { const t = norm(text); const exact = /\[([^\]]+)\]/.exec(text); if (exact) { const nm = norm(exact[1]); const hit = model.sections.filter((s) => norm(s.name) === nm); if (hit.length) return hit; const part = model.sections.filter((s) => norm(s.name).indexOf(nm) === 0); if (part.length) return part; } const cands = model.sections.filter((s) => s.name && t.indexOf(norm(s.name)) >= 0).sort((a, b) => b.name.length - a.name.length); if (cands.length) return cands.filter((s) => s.name === cands[0].name); return []; }
    function ask(model, q) {
        const text = String(q || '').trim(); const lc = text.toLowerCase();
        if (/(?:摘要|總結|概況|summary|overview|整體)/i.test(text)) return { kind: 'summary', answer: summarize(model).join('\n') };
        if (/(?:重複|duplicate|衝突|蓋掉)/i.test(text)) return { kind: 'duplicates', answer: model.dupKeys.length ? model.dupKeys.map((d) => '[' + d.section + '] ' + d.key + '：第 ' + d.lines.join('、') + ' 行').join('\n') : '沒有同一章節內重複的鍵。' };
        const tm = /(布林|開關|bool|guid|十六進位|hex|路徑|path|網址|url|版本|version|ip|數字|整數|int|空的|空值|empty)/i.exec(text);
        if (tm && /(?:哪些|列出|有哪|所有|list|which)/i.test(text)) { const map = { 布林: 'bool', 開關: 'bool', bool: 'bool', guid: 'guid', 十六進位: 'hex', hex: 'hex', 路徑: 'path', path: 'path', 網址: 'url', url: 'url', 版本: 'version', version: 'version', ip: 'ip', 數字: 'int', 整數: 'int', int: 'int', 空的: 'empty', 空值: 'empty', empty: 'empty' }; const ty = map[tm[1].toLowerCase()]; const rows = []; for (const s of model.sections) for (const e of s.entries) if (e.type === ty) rows.push((s.name ? '[' + s.name + '] ' : '') + (e.key ? e.key + ' = ' : '') + redact(e.key, e.value).slice(0, 60)); return { kind: 'by_type', answer: rows.length ? rows.slice(0, 40).join('\n') + (rows.length > 40 ? '\n…共 ' + rows.length + ' 個' : '') : '沒有 ' + ty + ' 型別的值。' }; }
        if (/(?:章節|section|有哪些區塊|區段)/i.test(text) && !/\[[^\]]+\]/.test(text) && !/(?:裡|內|中的|有哪些設定|有哪些鍵)/.test(text)) return { kind: 'sections', answer: model.sections.map((s) => (s.name || '(最上層)') + '（第 ' + (s.line || 1) + ' 行，' + s.entries.length + ' 條）').join('\n') };
        if (isEdk2(model.format) && /(?:檔案|原始檔|sources|source files)/i.test(text) && /(?:幾個|多少|哪些|列出|有什麼)/.test(text)) { const files = []; for (const s of model.sections) if (/^sources$/i.test(s.base)) for (const e of s.entries) if (e.kind === 'item') files.push(e.value + (s.parts[0] && s.parts[0].qual.length ? '（' + s.parts[0].qual.join('.') + '）' : '')); return { kind: 'files', answer: files.length ? '共 ' + files.length + ' 個原始檔：' + files.slice(0, 40).join('、') : '沒有 [Sources] 章節' }; }
        const secs = findSection(model, text);
        // 某個鍵的值（可能出現在多個章節）
        const keyHit = (() => { const toks = text.match(/[A-Za-z_$@][\w.$@\-\/]{1,60}/g) || []; for (const tk of toks.sort((a, b) => b.length - a.length)) { const k = Array.from(model.keyIndex.keys()).find((x) => x.toLowerCase() === tk.toLowerCase()); if (k) return k; } return null; })();
        if (keyHit && !(secs.length && /(?:有哪些|列出|裡面|內容)/.test(text))) { const hits = model.keyIndex.get(keyHit); return { kind: 'key', answer: hits.map((h) => (h.section ? '[' + h.section + '] ' : '') + keyHit + ' = ' + redact(keyHit, h.value).slice(0, 120) + '（' + h.type + '，第 ' + h.line + ' 行）').join('\n') }; }
        if (secs.length) { const rows = []; for (const s of secs) { rows.push('[' + s.name + ']（第 ' + s.line + ' 行，' + s.entries.length + ' 條）' + (s.doc ? '：' + s.doc : '')); s.entries.slice(0, 40).forEach((e) => rows.push('  ' + (e.key ? e.key + ' = ' : '') + redact(e.key, e.value).slice(0, 100) + (e.comment ? '  # ' + e.comment : ''))); if (s.entries.length > 40) rows.push('  …還有 ' + (s.entries.length - 40) + ' 條'); } return { kind: 'section', answer: rows.join('\n') }; }
        return { kind: 'open', answer: null, context: compactContext(model), note: '這個問題需要判斷，不是查詢；已附上設定檔的章節與條目摘要，可以交給模型回答' };
    }

    // ---------- 比對單行「key = value」----------
    function matchLine(model, line) {
        const m = /^\s*([A-Za-z_$@][\w.$@\-\[\]\/ ]*?)\s*(?:=|:|\|)\s*(.*?)\s*$/.exec(String(line)); if (!m) return null; const k = Array.from(model.keyIndex.keys()).find((x) => x === m[1].trim()) || Array.from(model.keyIndex.keys()).find((x) => x.toLowerCase() === m[1].trim().toLowerCase()); if (!k) return null;
        const hits = model.keyIndex.get(k); const t = valueType(m[2]); return { key: k, value: m[2], type: t, where: hits.map((h) => ({ section: h.section, line: h.line, current: redact(k, h.value), type: h.type })), typeMatches: hits.every((h) => h.type === t) };
    }

    // ---------- 兩份比較 ----------
    function flatten(model) { const map = new Map(); for (const s of model.sections) { const cnt = new Map(); for (const e of s.entries) { if (e.kind === 'directive') continue; const base = (s.name || '') + '\u0001' + (e.key == null ? '\u0002' + e.value : e.key); const n = (cnt.get(base) || 0) + 1; cnt.set(base, n); map.set(base + (n > 1 || s.tomlArray ? '#' + n : ''), { section: s.name, key: e.key, value: e.value, type: e.type, item: e.key == null }); } } return map; }
    function diff(a, b) {
        const A = flatten(a), B = flatten(b); const added = [], removed = [], changed = [];
        for (const [k, v] of B) { if (!A.has(k)) added.push(v); else { const o = A.get(k); const secret = v.key && SECRET_KEY.test(v.key); const MARK = '***（已遮蔽）';
                if (secret && (o.value === MARK || v.value === MARK)) continue; // 存起來的版本已經遮蔽，沒辦法比較；不假裝有差異
                const ov = String(o.value).trim(), nv = String(v.value).trim(); if (ov !== nv && redact(v.key, ov) !== redact(v.key, nv)) changed.push({ section: v.section, key: v.key, from: o.value, to: v.value, secret: !!secret });
                else if (ov !== nv && secret) changed.push({ section: v.section, key: v.key, from: o.value, to: v.value, secret: true }); } }
        for (const [k, v] of A) if (!B.has(k)) removed.push(v);
        const secA = new Set(a.sections.map((s) => s.name)), secB = new Set(b.sections.map((s) => s.name));
        return { addedSections: Array.from(secB).filter((x) => !secA.has(x)), removedSections: Array.from(secA).filter((x) => !secB.has(x)), added, removed, changed, same: !added.length && !removed.length && !changed.length };
    }
    function describeDiff(d) {
        if (d.same) return ['兩份的章節、鍵與值完全相同（不比較註解與空白）。'];
        const L = []; L.push('差異：新增 ' + d.added.length + '、移除 ' + d.removed.length + '、改值 ' + d.changed.length + (d.addedSections.length ? '；新增章節 ' + d.addedSections.join('、') : '') + (d.removedSections.length ? '；移除章節 ' + d.removedSections.join('、') : ''));
        const fm = (x) => (x.section ? '[' + x.section + '] ' : '') + (x.key ? x.key + ' = ' : '') + redact(x.key, x.value).slice(0, 80);
        d.changed.slice(0, 30).forEach((c) => L.push('改：' + (c.section ? '[' + c.section + '] ' : '') + (c.key || '') + '：' + (c.secret ? '（機密值有變，內容不顯示）' : redact(c.key, c.from).slice(0, 60) + ' → ' + redact(c.key, c.to).slice(0, 60)))); d.added.slice(0, 20).forEach((x) => L.push('新增：' + fm(x))); d.removed.slice(0, 20).forEach((x) => L.push('移除：' + fm(x)));
        const more = d.changed.length + d.added.length + d.removed.length - Math.min(30, d.changed.length) - Math.min(20, d.added.length) - Math.min(20, d.removed.length); if (more > 0) L.push('…還有 ' + more + ' 項'); return L;
    }

    // ---------- 離線訓練器規則（只存結構，值截短；不存整份檔案）----------
    function toTrainerPattern(model, name, opts) {
        opts = opts || {}; const id = 'cfg_' + String(name).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '_').slice(0, 40); let budget = 400;
        const slim = { v: 1, kind: 'config', name, format: model.format, lines: model.lines, learnedAt: Date.now(), source: opts.source || '', directives: model.directives.slice(0, 40), defines: Object.fromEntries(Object.entries(model.defines).map(([k, v]) => [k, redact(k, v)])), sections: model.sections.map((s) => ({ name: s.name, base: s.base, parts: s.parts, line: s.line, tomlArray: s.tomlArray, doc: s.doc, comments: s.comments, entries: s.entries.slice(0, Math.max(0, Math.min(60, budget))).map((e) => { budget--; return { line: e.line, kind: e.kind, key: e.key, value: redact(e.key, e.value).slice(0, 120), type: e.type, comment: e.comment, secret: (e.key && SECRET_KEY.test(e.key)) || undefined }; }), more: Math.max(0, s.entries.length - 60) })).slice(0, 120) };
        const keys = Array.from(model.keyIndex.keys()).filter((k) => k.length >= 4 && /^[\w.$@\-\/]+$/.test(k)).slice(0, 40); const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
        const sample = model.sections.flatMap((s) => s.entries.filter((e) => e.kind === 'kv').slice(0, 2).map((e) => e.key + ' = ' + redact(e.key, e.value).slice(0, 60))).slice(0, 5);
        return { id, type: keys.length ? 'regex' : 'semantic', expr: keys.length ? '^\\s*(?:' + keys.map(esc).join('|') + ')\\s*(?:=|:|\\|)\\s*\\S?.*$' : undefined, examples: sample, intent: '已學過的設定檔「' + name + '」（' + (fmtName[model.format] || model.format) + '，' + model.sections.length + ' 個章節）', description: summarize(model).slice(0, 3).join('；'), tool: 'log_ask', args: { format: name, question: '這個設定是什麼意思', text: '{problem_text}' }, confidence: 0.75, risk: 'safe', source: 'learned', enabled: true, hits: 0, log_model: slim };
    }
    function fromSlim(slim) {
        const model = { ok: true, kind: 'config', format: slim.format, lines: slim.lines, directives: slim.directives || [], defines: slim.defines || {}, sections: (slim.sections || []).map((s) => Object.assign({}, s, { entries: (s.entries || []).map((e) => Object.assign({ raw: (e.key ? e.key + ' = ' : '') + e.value }, e)) })) };
        return Object.assign(model, stats(model));
    }
    return { detect, parse, valueType, summarize, compactContext, ask, matchLine, diff, describeDiff, toTrainerPattern, fromSlim, get };
});
