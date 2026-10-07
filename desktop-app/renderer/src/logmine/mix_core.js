/* 混合內容的自學習語法高亮（FaMix）：一份文件裡夾著英文敘述、PHP、HTML、JavaScript、WebGL 著色器（GLSL）、TOML、INI、Python、CSS、JSON、YAML、shell、SQL…，
 * 不用事先標記，切出區段、認出各段是什麼、逐詞著色，並給每一段信心度。
 *
 *   ① 明確的進入／離開記號：``` 圍欄（帶語言名稱）、<?php … ?>、<script>／<style>（type 是 x-shader 就是 GLSL）、heredoc、前置的 --- 區塊
 *   ② 其餘的行：每一行對每種語言算一個分數（符號、關鍵字、結構形狀），用 Viterbi 解碼——切換語言要付代價，所以單獨一行沒把握時會沿用前後文
 *      （前後都是 JS，這行就是 JS）；分數都很低的行標成「不確定」，不亂猜
 *   ③ 自學習：區段定下來之後，把「在這個語言的區段裡常出現、在別的區段裡沒出現」的識別字學成這個語言的詞，再重新評分一輪；學到的詞可以存起來沿用
 *   ④ 逐詞著色：每個語言有自己的詞彙層（註解、字串、數字、關鍵字、型別、內建函式、函式名、變數…）
 * 純函式（UMD），不連網、不呼叫模型。語言的特徵是通用知識（不是對你這份文件預先標記）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMix = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const set = (s) => new Set(String(s).split(/\s+/).filter(Boolean));
    const STOP = set('the a an of to in on at for from with by and or but not is are was were be been being it this that these those i you we they he she my your our their me him her them as if then than so do does did have has had will would can could should may might must what why how when where which who whom there here also just only very more most some any all each every other such into over under about after before between through during without within up down out off again once please thanks thank hello hi');

    // ---------- 語言：行層級的特徵（[正規表示式, 權重]）、關鍵字、著色規格 ----------
    const JS_KW = set('const let var function return if else for while do switch case break continue new delete typeof instanceof void this class extends super import export default from async await yield try catch finally throw in of static get set null undefined true false');
    const PHP_KW = set('echo print function return if else elseif for foreach while do switch case break continue new class extends implements interface trait namespace use public private protected static final abstract const try catch finally throw as array isset unset empty null true false and or xor include require include_once require_once global');
    const PY_KW = set('def class return if elif else for while break continue pass import from as with try except finally raise lambda yield global nonlocal assert del in is not and or None True False async await');
    const GLSL_KW = set('void if else for while do return break continue discard uniform varying attribute in out inout const precision highp mediump lowp struct layout flat smooth centroid true false');
    const GLSL_TY = set('float int bool uint vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 uvec2 uvec3 uvec4 mat2 mat3 mat4 mat2x2 mat3x3 mat4x4 sampler2D samplerCube sampler3D sampler2DShadow');
    const GLSL_BI = set('gl_Position gl_FragColor gl_FragCoord gl_FragData gl_PointSize gl_PointCoord gl_VertexID gl_InstanceID texture texture2D textureCube mix clamp smoothstep step normalize dot cross reflect refract length distance pow sqrt abs sign floor ceil fract mod min max sin cos tan asin acos atan exp log exp2 log2 inversesqrt transpose inverse');
    const SQL_KW = set('select insert into values update set delete from where join left right inner outer on group by order having limit offset create table drop alter index primary key foreign references null not and or in as distinct union all like between exists case when then else end');
    const SH_CMD = set('sudo apt apt-get npm npx pip pip3 git cd ls echo export curl wget cat grep sed awk mkdir rm cp mv chmod chown docker kubectl make cmake python python3 node php ssh scp tar unzip systemctl source if then fi for do done while case esac');
    const CSS_AT = /^\s*@(media|import|font-face|keyframes|supports|charset)\b/;

    const L = {
        prose: { name: 'English prose', kind: 'prose' },
        html: { name: 'HTML', kind: 'markup', feats: [[/^\s*<!DOCTYPE\b/i, 5], [/^\s*<\/?[a-zA-Z][\w:-]*(\s[^<>]*)?\/?>/, 3], [/<[a-zA-Z][\w:-]*(\s[^<>]*)?>[^<]*<\/[a-zA-Z][\w:-]*>/, 2.5], [/&(nbsp|amp|lt|gt|quot);/, 1.5], [/\s(class|id|href|src|style|type|rel|name|content|charset)=["'][^"']*["']/, 2], [/^\s*<!--/, 2]] },
        css: { name: 'CSS', kind: 'code', feats: [[/^\s*[.#]?[\w-]+(\s*[>+~,\s]\s*[.#]?[\w:()-]+)*\s*\{\s*$/, 2], [/^\s*[a-z-]{3,}\s*:\s*[^;{}]+;\s*$/, 2.2], [CSS_AT, 4], [/^\s*\}\s*$/, 0.4], [/:\s*(\d+(\.\d+)?(px|em|rem|%|vh|vw)|#[0-9a-fA-F]{3,8}|rgba?\()/, 2]] },
        javascript: { name: 'JavaScript', kind: 'code', kw: JS_KW, feats: [[/^\s*(const|let|var)\s+[\w$]+\s*=/, 3], [/\bfunction\s*\w*\s*\(/, 3], [/=>\s*[{(\w]/, 3], [/\b(console|document|window|Math|JSON|Promise|Object|Array)\.\w+/, 2.5], [/\b(require|import)\s*\(|^\s*import\s+.+\s+from\s+['"]/, 3], [/===|!==/, 2.5], [/\.(then|catch|map|filter|forEach|reduce|addEventListener|querySelector|getElementById)\s*\(/, 2.5], [/;\s*$/, 0.6], [/^\s*(export|async)\s+/, 2]] },
        php: { name: 'PHP', kind: 'code', kw: PHP_KW, feats: [[/<\?(php|=)/, 6], [/\?>/, 3], [/\$[a-zA-Z_]\w*/, 2.2], [/->\s*\w+|::\s*\w+/, 1.5], [/^\s*(echo|print)\b/, 2.5], [/\bfunction\s+\w+\s*\(.*\)\s*\{?/, 1.2], [/\bforeach\s*\(.+\sas\s/, 4], [/\barray\s*\(|\bisset\s*\(|\bempty\s*\(/, 2.5], [/\$this\b/, 3], [/;\s*$/, 0.5]] },
        python: { name: 'Python', kind: 'code', kw: PY_KW, feats: [[/^\s*def\s+\w+\s*\(.*\)\s*(->\s*[\w\[\], .]+)?\s*:\s*$/, 5], [/^\s*class\s+\w+(\(.*\))?\s*:\s*$/, 4], [/^\s*(import\s+[\w.]+(\s+as\s+\w+)?|from\s+[\w.]+\s+import\s+.+)\s*$/, 4], [/^\s*(if|elif|else|for|while|try|except|finally|with)\b.*:\s*$/, 3], [/\bself\.\w+/, 3], [/\b(None|True|False)\b/, 2], [/^\s*print\s*\(/, 1.5], [/^\s*@\w+/, 2], [/^\s*return\b[^;{}]*$/, 0.8]] },
        glsl: { name: 'GLSL (WebGL shader)', kind: 'code', kw: GLSL_KW, feats: [[/^\s*#version\b/, 6], [/\b(uniform|varying|attribute)\s+(highp\s+|mediump\s+|lowp\s+)?(float|int|vec[234]|mat[234]|sampler2D|samplerCube)\b/, 6], [/\bgl_(Position|FragColor|FragCoord|FragData|PointSize|PointCoord)\b/, 6], [/\bvoid\s+main\s*\(\s*(void)?\s*\)/, 4], [/^\s*precision\s+(highp|mediump|lowp)\s+\w+\s*;/, 6], [/\b(vec[234]|mat[234]|ivec[234])\s*\(/, 3.5], [/\b(texture2D|textureCube|texture|smoothstep|mix|clamp|normalize|dot|cross|fract)\s*\(/, 2], [/\b(highp|mediump|lowp)\b/, 3], [/;\s*$/, 0.4]] },
        toml: { name: 'TOML', kind: 'config', feats: [[/^\s*\[\[[\w.\-"]+\]\]\s*$/, 6], [/^\s*\[[\w.\-"]+\.[\w.\-"]+\]\s*$/, 4], [/^\s*[\w.-]+\s*=\s*"[^"]*"\s*(#.*)?$/, 2.5], [/^\s*[\w.-]+\s*=\s*(true|false)\s*(#.*)?$/, 2], [/^\s*[\w.-]+\s*=\s*\[.*\]\s*(#.*)?$/, 2.5], [/^\s*[\w.-]+\s*=\s*\{.*\}\s*$/, 3], [/^\s*[\w.-]+\s*=\s*\d{4}-\d{2}-\d{2}/, 3], [/^\s*\[[\w.\-"]+\]\s*$/, 1.5], [/^\s*[\w.-]+\s*=\s*-?\d[\d_]*(\.\d+)?\s*(#.*)?$/, 1.2]] },
        ini: { name: 'INI', kind: 'config', feats: [[/^\s*\[[^\]\n]+\]\s*$/, 1.8], [/^\s*[\w.][\w. -]*\s*=\s*[^"'\[\]{}=\n][^"\n]*$/, 1.6], [/^\s*;.*$/, 2.5], [/^\s*[\w.-]+\s*=\s*$/, 1.5]] },
        json: { name: 'JSON', kind: 'config', feats: [[/^\s*"[^"\n]+"\s*:\s*("|\d|true|false|null|\[|\{)/, 3.5], [/^\s*[\[{]\s*$/, 1.2], [/^\s*[\]}],?\s*$/, 0.8], [/^\s*"[^"\n]*"\s*,?\s*$/, 1], [/:\s*(true|false|null)\s*,?\s*$/, 1.5]] },
        yaml: { name: 'YAML', kind: 'config', feats: [[/^---\s*$/, 3], [/^\s*[\w.-]+:\s*$/, 2], [/^\s*[\w.-]+:\s+[^\s{[].*$/, 1.6], [/^\s*-\s+[\w.-]+:\s/, 2.5], [/^\s*-\s+\S/, 1.2]] },
        shell: { name: 'Shell', kind: 'code', feats: [[/^#!\/(bin|usr\/bin)\//, 6], [/^\s*\$\s+\S/, 4], [/\$\(|\$\{[\w#]+/, 1.6], [/\s&&\s|\s\|\s|\s>>?\s/, 1.2], [/^\s*(export|source|alias)\s+\w+/, 3]] },
        trace: { name: 'Error output', kind: 'log', feats: [[/^Traceback \(most recent call last\)/, 8], [/^\s+File ".*", line \d+/, 6], [/^\s+at\s+\S+\s*\(.*:\d+:\d+\)/, 6], [/^\s+at\s+.*:\d+/, 3], [/^(\w+\.)*\w*(Error|Exception).*:/, 4], [/^(PHP )?(Fatal error|Warning|Notice|Parse error):/, 6], [/^(ERROR|WARNING):\s*\d+:\d+:/, 6], [/^Uncaught\s+\w+/, 4], [/line \d+.*(error|warning)/i, 3], [/^\s*error[:\[ ]/i, 2.5], [/at\s+\S+:\d+:\d+/, 3]] },
        sql: { name: 'SQL', kind: 'code', kw: SQL_KW, feats: [[/^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i, 5], [/^\s*(FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|VALUES|SET|LIMIT)\b/i, 3], [/;\s*$/, 0.3]] },
    };
    const ALIAS = { js: 'javascript', javascript: 'javascript', jsx: 'javascript', node: 'javascript', mjs: 'javascript', ts: 'javascript', typescript: 'javascript', php: 'php', py: 'python', python: 'python', python3: 'python', glsl: 'glsl', frag: 'glsl', vert: 'glsl', shader: 'glsl', wgsl: 'glsl', hlsl: 'glsl', html: 'html', htm: 'html', xml: 'html', svg: 'html', css: 'css', scss: 'css', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', json: 'json', yaml: 'yaml', yml: 'yaml', sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', console: 'shell', sql: 'sql' };
    const CODE_LANGS = Object.keys(L).filter((k) => k !== 'prose');

    // ---------- 行的分數 ----------
    function proseScore(line) {
        const t = line.trim(); if (!t) return 0; const words = t.split(/\s+/); const alpha = words.filter((w) => /^[A-Za-z][A-Za-z'’-]*[.,;:!?)"']*$/.test(w)); if (words.length < 3) return alpha.length === words.length && /^[A-Z]/.test(t) && /[.!?]$/.test(t) ? 1.5 : (/[=;{}\[\]<>$]/.test(t) ? -1 : 0);
        const stop = words.filter((w) => STOP.has(w.toLowerCase().replace(/[^a-z']/g, ''))).length / words.length; const sym = (t.match(/[{}();=<>$\\|&*\[\]]/g) || []).length / t.length; let s = 0;
        s += alpha.length / words.length * 2.5; s += Math.min(stop, 0.5) * 8; s -= sym * 25; if (/^[A-Z]/.test(t)) s += 0.8; if (/[.!?]$/.test(t)) s += 1.2; if (/\b(is|are|was|were|will|can|should|would|could|does|do|have|has|you|we|I)\b/.test(t) && words.length >= 4) s += 1; if (words.length >= 6) s += 0.6; if (/^\s*(;|\/\/|#)/.test(t)) s -= 2.5; // 註解記號開頭：多半是程式或設定裡的註解，不是散文
        return Math.max(0, s - 1.2);
    }
    function lineScores(line, learned) {
        const sc = {}; const t = line; sc.prose = proseScore(t);
        for (const id of CODE_LANGS) { const spec = L[id]; let s = 0; for (const [re, w] of spec.feats) if (re.test(t)) s += w; if (spec.kw) { const ids = t.match(/[A-Za-z_$][\w$]*/g) || []; let hit = 0; for (const x of ids) if (spec.kw.has(x) || spec.kw.has(x.toLowerCase())) hit++; if (hit) s += Math.min(hit, 4) * 0.5; } if (learned && learned[id]) { const ids = t.match(/[A-Za-z_$][\w$]*/g) || []; let hit = 0; for (const x of ids) if (learned[id].has(x)) hit++; if (hit) s += Math.min(hit, 4) * 0.9; } sc[id] = s; }
        // 程式碼行不像散文：有很多符號時散文分數壓低
        return sc;
    }
    const softmax = (obj, T) => { const ks = Object.keys(obj); const mx = Math.max.apply(null, ks.map((k) => obj[k])); const ex = ks.map((k) => Math.exp((obj[k] - mx) / (T || 1))); const z = ex.reduce((a, b) => a + b, 0); const out = {}; ks.forEach((k, i) => { out[k] = ex[i] / z; }); return out; };

    // ---------- ① 明確的區段記號 ----------
    // 注意：沒有 ?> 結尾的 PHP 檔不當成明確區段（它會一路到文件結尾，吃掉後面的散文）；改由逐行評分＋前後文平滑判斷它在哪裡結束
    function explicitRegions(text) {
        const regs = []; const used = []; const overlap = (a, b) => used.some(([s, e]) => a < e && b > s); const add = (start, end, lang, why, meta) => { while (start < end && text[start] === '\n') start++; if (end <= start || overlap(start, end)) return; used.push([start, end]); regs.push(Object.assign({ start, end, lang, evidence: [why], confidence: 0.99, explicit: true }, meta || {})); };
        let m;
        const fence = /^([ \t]*)(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*$/gm; while ((m = fence.exec(text))) { const inner = m[4]; const s = m.index + m[0].indexOf('\n') + 1; const lang = ALIAS[String(m[3]).toLowerCase()]; if (lang) add(s, s + inner.length, lang, '圍欄標明語言 ' + m[3]); else add(s, s + inner.length, null, '圍欄沒有標語言（內容自己判斷）', { sniff: true }); }
        const here = /<<<['"]?(\w+)['"]?[ \t]*\n([\s\S]*?)\n[ \t]*\1;?/g; while ((m = here.exec(text))) { const s = m.index + m[0].indexOf('\n') + 1; const hint = ALIAS[String(m[1]).toLowerCase()]; add(s, s + m[2].length, hint || null, hint ? 'heredoc 標籤 ' + m[1] : 'heredoc（內容自己判斷）', hint ? {} : { sniff: true }); }
        const php = /<\?(?:php|=)?([\s\S]*?)\?>/g; while ((m = php.exec(text))) { // 裡面已經有更具體的區段（heredoc）就繞開，前後各自是 PHP
            const a0 = m.index, b0 = m.index + m[0].length; const inner = used.filter(([s, e]) => s >= a0 && e <= b0).sort((x, y) => x[0] - y[0]); let cur = a0; for (const [s, e] of inner) { if (s > cur) add(cur, s, 'php', '<?php … ?> 區段'); cur = e; } if (cur < b0) add(cur, b0, 'php', '<?php … ?> 區段'); }
        const script = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi; while ((m = script.exec(text))) { const attrs = m[1]; const s = m.index + m[0].indexOf('>') + 1; const inner = m[2]; const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || ''; let lang = 'javascript', why = '<script> 區段'; if (/x-shader|glsl|vertex|fragment/i.test(type)) { lang = 'glsl'; why = '<script type="' + type + '">：WebGL 著色器'; } else if (/json/i.test(type)) { lang = 'json'; why = '<script type="' + type + '">'; } else if (/\b(gl_FragColor|gl_Position|void\s+main|uniform\s+\w+|precision\s+\w+)/.test(inner) && !/\b(function|const|let|var)\b/.test(inner)) { lang = 'glsl'; why = '<script> 內容是著色器（有 gl_ 與 uniform）'; } add(s, s + inner.length, lang, why); }
        const style = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi; while ((m = style.exec(text))) { const s = m.index + m[0].indexOf('>') + 1; add(s, s + m[1].length, 'css', '<style> 區段'); }
        const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text); if (fm) add(0, fm[0].length, 'yaml', '文件開頭的 --- 區塊');
        regs.sort((a, b) => a.start - b.start); return regs;
    }

    // ---------- ② 自由文字：逐行評分 + Viterbi ----------
    function lineList(text, a, b) { const out = []; let pos = a; const seg = text.slice(a, b); const parts = seg.split('\n'); for (const p of parts) { out.push({ start: pos, end: pos + p.length, text: p }); pos += p.length + 1; } return out; }
    function decode(lines, learned, opts) {
        const langs = ['prose'].concat(CODE_LANGS); const n = lines.length; if (!n) return { labels: [], scores: [] }; const sw = (opts && opts.switchCost) || 2.2;
        const sc = lines.map((ln) => (ln.text.trim() ? lineScores(ln.text, learned) : null)); const T = 1.1;
        const em = sc.map((s) => { if (!s) return null; const p = softmax(s, T); const o = {}; for (const k of langs) o[k] = Math.log(Math.max(p[k], 1e-6)); return o; });
        const V = []; const back = []; for (let i = 0; i < n; i++) { V[i] = {}; back[i] = {}; for (const k of langs) { const e = em[i] ? em[i][k] : 0; if (i === 0) { V[i][k] = e; back[i][k] = null; } else { let best = -Infinity, arg = null; for (const j of langs) { const v = V[i - 1][j] - (j === k ? 0 : sw); if (v > best) { best = v; arg = j; } } V[i][k] = best + e; back[i][k] = arg; } } }
        let last = langs[0], bv = -Infinity; for (const k of langs) if (V[n - 1][k] > bv) { bv = V[n - 1][k]; last = k; } const labels = new Array(n); labels[n - 1] = last; for (let i = n - 1; i > 0; i--) labels[i - 1] = back[i][labels[i]];
        return { labels, scores: sc };
    }
    function blocksFrom(lines, labels, scores) {
        const blocks = []; let cur = null; for (let i = 0; i < lines.length; i++) { const lab = labels[i]; const blank = !lines[i].text.trim(); if (cur && (cur.lang === lab || blank)) { cur.endLine = i; cur.end = lines[i].end; if (!blank) cur.nonblank++; continue; } if (blank && !cur) continue; cur = { lang: lab, startLine: i, endLine: i, start: lines[i].start, end: lines[i].end, nonblank: blank ? 0 : 1 }; blocks.push(cur); }
        for (const b of blocks) { // 區段信心度：這一段各行分數加起來，選中的語言對其他語言的 softmax 機率；全都很低 → 不確定
            const tot = {}; let n = 0; for (let i = b.startLine; i <= b.endLine; i++) if (scores[i]) { n++; for (const k of Object.keys(scores[i])) tot[k] = (tot[k] || 0) + scores[i][k]; } if (!n) { b.confidence = 0; b.lang = 'unknown'; continue; }
            const avg = {}; for (const k of Object.keys(tot)) avg[k] = tot[k] / n; const p = softmax(avg, 1.2); const top = avg[b.lang] || 0; b.confidence = Math.round(p[b.lang] * 100) / 100; b.strength = Math.round(top * 100) / 100; b.alt = Object.keys(avg).filter((k) => k !== b.lang).sort((x, y) => avg[y] - avg[x]).slice(0, 2).map((k) => ({ lang: k, score: Math.round(avg[k] * 100) / 100 }));
            if (top < 0.9 && b.lang !== 'prose') { b.uncertain = true; }
        }
        return blocks;
    }
    // 沒有標語言的圍欄／heredoc：用內容判斷
    function sniff(textBlock) { const lines = textBlock.split('\n'); const tot = {}; for (const ln of lines) if (ln.trim()) { const s = lineScores(ln); for (const k of Object.keys(s)) tot[k] = (tot[k] || 0) + s[k]; } let best = null, bv = 0.5; for (const k of Object.keys(tot)) if (k !== 'prose' && tot[k] > bv) { bv = tot[k]; best = k; } return { lang: best || 'text', score: bv }; }

    // ---------- ③ 自學習：區段裡的識別字學成該語言的詞 ----------
    function learnWords(text, blocks, prior) {
        const per = {}; const all = {}; for (const b of blocks) { if (b.lang === 'prose' || b.lang === 'unknown' || b.lang === 'text') continue; const ids = text.slice(b.start, b.end).match(/[A-Za-z_$][\w$]{2,}/g) || []; per[b.lang] = per[b.lang] || {}; for (const x of ids) { per[b.lang][x] = (per[b.lang][x] || 0) + 1; all[x] = (all[x] || 0) + 1; } }
        const learned = {}; for (const lang of Object.keys(per)) { learned[lang] = new Set(Array.from((prior && prior[lang]) || [])); for (const [x, n] of Object.entries(per[lang])) { if (n >= 2 && n === all[x] && !(L[lang].kw && L[lang].kw.has(x))) learned[lang].add(x); } } return learned;
    }

    // ---------- ④ 逐詞著色 ----------
    const re = (s, f) => new RegExp(s, (f || '') + 'y');
    const NUM = '\\b(?:0[xX][0-9a-fA-F]+|\\d+\\.?\\d*(?:[eE][+-]?\\d+)?[fFuUlL]?|\\.\\d+(?:[eE][+-]?\\d+)?[fF]?)\\b';
    const NUMSIMPLE = '\\b\\d+\\b';
    const SPEC = {
        javascript: { rules: [['comment', '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'], ['string', '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`'], ['number', NUM], ['op', '=>|[=!]==?|[<>]=?|&&|\\|\\||[-+*/%&|^~!?:]'], ['id', '[A-Za-z_$][\\w$]*'], ['punct', '[{}()\\[\\];,.]']], kw: JS_KW, builtin: set('console document window Math JSON Promise Object Array String Number Boolean Date RegExp Error Map Set fetch require module exports process setTimeout setInterval parseInt parseFloat'), },
        php: { rules: [['tag', '<\\?(?:php|=)?|\\?>'], ['comment', '\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'], ['string', '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\''], ['variable', '\\$[A-Za-z_]\\w*'], ['number', NUM], ['op', '->|=>|::|[=!]==?|[<>]=?|&&|\\|\\||\\.=|[-+*/%&|^~!?:.]'], ['id', '[A-Za-z_]\\w*'], ['punct', '[{}()\\[\\];,]']], kw: PHP_KW, builtin: set('strlen count array_map array_filter in_array implode explode json_encode json_decode date time htmlspecialchars mysqli_query var_dump print_r str_replace substr strpos') },
        python: { rules: [['comment', '#[^\\n]*'], ['string', '[rRbBfFuU]{0,2}(?:"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')'], ['decorator', '@[A-Za-z_][\\w.]*'], ['number', NUM], ['op', '->|[=!]=|[<>]=?|\\*\\*|//|[-+*/%&|^~<>=]'], ['id', '[A-Za-z_]\\w*'], ['punct', '[{}()\\[\\]:,.;]']], kw: PY_KW, builtin: set('print len range int str float list dict set tuple open isinstance enumerate zip map filter sorted sum min max abs input super type bool object Exception ValueError') },
        glsl: { rules: [['comment', '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'], ['preproc', '#[ \\t]*\\w+[^\\n]*'], ['number', NUM], ['op', '[=!]=|[<>]=?|&&|\\|\\||[-+*/%&|^~!?:=<>]'], ['id', '[A-Za-z_]\\w*'], ['punct', '[{}()\\[\\];,.]']], kw: GLSL_KW, type: GLSL_TY, builtin: GLSL_BI },
        html: { rules: [['comment', '<!--[\\s\\S]*?-->'], ['doctype', '<!DOCTYPE[^>]*>'], ['tag', '<\\/?[A-Za-z][\\w:-]*|\\/?>'], ['string', '"[^"]*"|\'[^\']*\''], ['entity', '&#?\\w+;'], ['attr', '[A-Za-z_:][\\w:.-]*(?=\\s*=)'], ['punct', '=']] },
        css: { rules: [['comment', '\\/\\*[\\s\\S]*?\\*\\/'], ['atrule', '@[\\w-]+'], ['string', '"[^"]*"|\'[^\']*\''], ['color', '#[0-9a-fA-F]{3,8}\\b'], ['number', '-?\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|s|ms|deg)?\\b'], ['property', '[a-z-]+(?=\\s*:)'], ['selector', '[.#][\\w-]+|::?[\\w-]+'], ['id', '[A-Za-z_-][\\w-]*'], ['punct', '[{}();:,>+~]']] },
        toml: { rules: [['comment', '#[^\\n]*'], ['section', '^[ \\t]*\\[\\[?[^\\]\\n]+\\]\\]?', 'm'], ['key', '^[ \\t]*[\\w.-]+(?=[ \\t]*=)', 'm'], ['string', '"""[\\s\\S]*?"""|"(?:\\\\.|[^"\\\\\\n])*"|\'[^\'\\n]*\''], ['datetime', '\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}:\\d{2}(?:Z|[+-]\\d{2}:\\d{2})?)?'], ['number', '[+-]?\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'], ['literal', 'true|false'], ['punct', '[=\\[\\]{},]']] },
        ini: { rules: [['comment', '[;#][^\\n]*'], ['section', '^[ \\t]*\\[[^\\]\\n]+\\]', 'm'], ['key', '^[ \\t]*[\\w. -]+?(?=[ \\t]*=)', 'm'], ['string', '"[^"\\n]*"'], ['number', '-?\\d+(?:\\.\\d+)?\\b'], ['literal', '\\b(?:true|false|yes|no|on|off)\\b'], ['punct', '=']] },
        json: { rules: [['key', '"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)'], ['string', '"(?:\\\\.|[^"\\\\\\n])*"'], ['number', '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'], ['literal', 'true|false|null'], ['punct', '[{}\\[\\]:,]']] },
        yaml: { rules: [['comment', '#[^\\n]*'], ['key', '^[ \\t]*(?:-[ \\t]+)?[\\w.-]+(?=:)', 'm'], ['string', '"(?:\\\\.|[^"\\\\\\n])*"|\'[^\'\\n]*\''], ['number', '-?\\d+(?:\\.\\d+)?\\b'], ['literal', '\\b(?:true|false|null|yes|no)\\b'], ['punct', '[-:,\\[\\]{}]']] },
        shell: { rules: [['comment', '#[^\\n]*'], ['string', '"(?:\\\\.|[^"\\\\])*"|\'[^\']*\''], ['variable', '\\$\\{?[A-Za-z_]\\w*\\}?|\\$\\(|\\$\\d'], ['flag', '(?<=\\s)--?[A-Za-z][\\w-]*'], ['number', NUM], ['op', '&&|\\|\\||[|><;&]'], ['id', '[A-Za-z_][\\w./-]*'], ['punct', '[(){}\\[\\]=]']], cmd: SH_CMD },
        sql: { rules: [['comment', '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'], ['string', '\'(?:\'\'|[^\'])*\''], ['number', NUM], ['id', '[A-Za-z_]\\w*'], ['op', '[=<>!]+|[-+*/%]'], ['punct', '[(),;.]']], kw: SQL_KW, ci: true },
        trace: { rules: [['path', '[\\w./\\\\-]+\\.(?:py|js|php|glsl|html|css|toml|ini|json)(?::\\d+(?::\\d+)?)?'], ['number', NUMSIMPLE], ['keyword', '\\b(?:Traceback|Error|Exception|Fatal|Warning|Notice|Uncaught|ERROR|WARNING)\\b'], ['string', '"[^"]*"']] },
        prose: { rules: [['code', '`[^`\\n]+`'], ['url', 'https?:\\/\\/[^\\s)>\\]]+'], ['path', '(?:[A-Za-z]:)?(?:\\.{0,2}\\/|\\\\)?[\\w.-]+(?:[\\/\\\\][\\w.-]+)+\\.?\\w*'], ['string', '"[^"\\n]{1,80}"'], ['number', '\\b\\d+(?:\\.\\d+)?\\b'], ['ident', '\\b[a-z]+(?:[A-Z][a-z0-9]+)+\\b|\\b[a-z]+(?:_[a-z0-9]+)+\\b|\\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\\b']] },
    };
    for (const k of Object.keys(SPEC)) SPEC[k].compiled = SPEC[k].rules.map(([cls, src, fl]) => ({ cls, re: re(src, fl) }));
    function tokenize(lang, text, learned) {
        const spec = SPEC[lang]; if (!spec) return [{ s: 0, e: text.length, cls: 'text' }]; const out = []; let i = 0; const n = text.length; const lw = learned && learned[lang];
        while (i < n) {
            let hit = null; for (const r of spec.compiled) { r.re.lastIndex = i; const m = r.re.exec(text); if (m && m[0].length) { hit = { cls: r.cls, len: m[0].length, v: m[0] }; break; } }
            if (!hit) { const s = i; i++; if (out.length && out[out.length - 1].cls === 'text' && out[out.length - 1].e === s) out[out.length - 1].e = i; else out.push({ s, e: i, cls: 'text' }); continue; }
            let cls = hit.cls; if (cls === 'id') { const v = hit.v; const key = spec.ci ? v.toLowerCase() : v; const after = text.slice(i + v.length).match(/^\s*\(/); if (spec.kw && spec.kw.has(key)) cls = 'keyword'; else if (spec.type && spec.type.has(v)) cls = 'type'; else if (spec.builtin && spec.builtin.has(v)) cls = 'builtin'; else if (lw && lw.has(v)) cls = 'builtin'; else if (spec.cmd && spec.cmd.has(v) && /(^|\n)\s*$/.test(text.slice(0, i)) ) cls = 'keyword'; else if (after) cls = 'function'; else cls = 'identifier'; }
            out.push({ s: i, e: i + hit.len, cls }); i += hit.len;
        }
        return out;
    }
    function highlight(lang, text, learned) { return tokenize(lang, text, learned); }

    // ---------- 對外：分析一份混合文件 ----------
    function analyze(text, opts) {
        opts = opts || {}; const src = String(text == null ? '' : text); const regs = explicitRegions(src); const blocks = []; let learned = opts.learned || null;
        // 把文件切成：明確區段 + 之間的自由文字
        const pieces = []; let pos = 0; for (const r of regs) { if (r.start > pos) pieces.push({ free: true, start: pos, end: r.start }); pieces.push(r); pos = r.end; } if (pos < src.length) pieces.push({ free: true, start: pos, end: src.length });
        for (let pass = 0; pass < 2; pass++) {
            blocks.length = 0;
            for (const p of pieces) {
                if (!p.free) { let lang = p.lang, ev = p.evidence.slice(), conf = p.confidence; if (!lang && p.sniff) { const s = sniff(src.slice(p.start, p.end)); lang = s.lang; ev = ev.concat(['內容判斷為 ' + lang]); conf = lang === 'text' ? 0.3 : 0.75; } blocks.push({ start: p.start, end: p.end, lang: lang || 'text', confidence: conf, explicit: true, evidence: ev, nonblank: 1 }); continue; }
                const lines = lineList(src, p.start, p.end); if (!lines.some((l) => l.text.trim())) continue; const d = decode(lines, learned, opts); const bs = blocksFrom(lines, d.labels, d.scores); for (const b of bs) { b.evidence = ['逐行評分＋前後文平滑'].concat(b.uncertain ? ['分數偏低：不確定'] : []); blocks.push(b); }
            }
            if (pass === 0 && opts.learn !== false) learned = learnWords(src, blocks, opts.learned); else break;
        }
        blocks.sort((a, b) => a.start - b.start);
        // 行號
        const lineStarts = [0]; for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1); const lineOf = (off) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
        const out = blocks.map((b, i) => Object.assign({ id: i, kind: b.lang === 'prose' ? 'prose' : (L[b.lang] ? L[b.lang].kind : 'code'), name: (L[b.lang] && L[b.lang].name) || b.lang, fromLine: lineOf(b.start), toLine: lineOf(Math.max(b.start, b.end - 1)), text: src.slice(b.start, b.end) }, { start: b.start, end: b.end, lang: b.lang, confidence: b.confidence, explicit: !!b.explicit, uncertain: !!b.uncertain, evidence: b.evidence, alt: b.alt }));
        const learnedOut = {}; if (learned) for (const k of Object.keys(learned)) learnedOut[k] = Array.from(learned[k]).slice(0, 200);
        return { ok: true, blocks: out, languages: Array.from(new Set(out.map((b) => b.lang))), learned: learnedOut, lines: lineStarts.length, _learned: learned };
    }
    // 把學到的詞存成可序列化、之後再載入
    const loadLearned = (obj) => { const o = {}; for (const k of Object.keys(obj || {})) o[k] = new Set(obj[k]); return o; };

    // ---------- HTML 輸出 ----------
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const COLORS = { comment: '#6a9955', string: '#ce9178', number: '#b5cea8', keyword: '#c586c0', type: '#4ec9b0', builtin: '#4fc1ff', function: '#dcdcaa', variable: '#9cdcfe', identifier: '#d4d4d4', tag: '#569cd6', attr: '#9cdcfe', property: '#9cdcfe', selector: '#d7ba7d', color: '#b5cea8', atrule: '#c586c0', preproc: '#c586c0', section: '#4ec9b0', key: '#9cdcfe', literal: '#569cd6', datetime: '#b5cea8', decorator: '#dcdcaa', flag: '#ce9178', entity: '#d7ba7d', doctype: '#808080', op: '#d4d4d4', punct: '#808080', text: '#d4d4d4', code: '#ce9178', url: '#3794ff', path: '#d7ba7d', ident: '#9cdcfe' };
    function toHtml(result, opts) {
        opts = opts || {}; const src = opts.source; const learned = result._learned; let html = '';
        for (const b of result.blocks) {
            const label = b.name + (b.explicit ? '' : '　信心 ' + Math.round(b.confidence * 100) + '%') + (b.uncertain ? '　（不確定）' : ''); let inner = '';
            const toks = b.kind === 'prose' || SPEC[b.lang] ? tokenize(b.lang, b.text, learned) : [{ s: 0, e: b.text.length, cls: 'text' }]; let p = 0;
            for (const t of toks) { if (t.s > p) inner += esc(b.text.slice(p, t.s)); const seg = b.text.slice(t.s, t.e); inner += (t.cls === 'text' || t.cls === 'identifier') ? esc(seg) : '<span style="color:' + (COLORS[t.cls] || '#d4d4d4') + '" title="' + t.cls + '">' + esc(seg) + '</span>'; p = t.e; } if (p < b.text.length) inner += esc(b.text.slice(p));
            html += '<div style="margin:6px 0;border:1px solid #3c3c3c;border-radius:6px;overflow:hidden"><div style="font:11px sans-serif;padding:2px 8px;background:#2d2d2d;color:#9cdcfe">' + esc(label) + '　第 ' + b.fromLine + '–' + b.toLine + ' 行</div><pre style="margin:0;padding:8px;background:#1e1e1e;color:#d4d4d4;white-space:pre-wrap;font:12px/1.5 Consolas,monospace">' + inner + '</pre></div>';
        }
        return '<div>' + html + '</div>';
    }
    function describe(result) { return result.blocks.map((b) => '第 ' + b.fromLine + '–' + b.toLine + ' 行：' + b.name + (b.explicit ? '（' + b.evidence[0] + '）' : '（信心 ' + Math.round(b.confidence * 100) + '%' + (b.uncertain ? '，不確定' : '') + '）')); }

    return { analyze, tokenize, highlight, toHtml, describe, explicitRegions, lineScores, proseScore, sniff, loadLearned, LANGS: Object.keys(L), ALIAS };
});
