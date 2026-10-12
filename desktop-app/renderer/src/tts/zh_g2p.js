// 中文語音（Kokoro 的國語聲音）用的「文字 → 音素」轉換：瀏覽器端沒有 misaki 的中文 G2P（那是 Python 套件），這裡自己做一份。
// 流程跟 misaki 的 ZHG2P（Kokoro v1.0 用的舊式路徑）一樣：數字轉中文數字 → 標點轉換 → 分詞 → 每個字轉拼音（帶聲調）→ 拼音轉 IPA 音素（聲母＋韻母＋聲調箭頭）。
// 拼音表（聲母、韻母、聲調）改寫自 misaki 的 transcription.py（原作 pinyin-to-ipa，MIT 授權）。
// 這個檔案是純函式、不碰 DOM、不載入外部函式庫：「文字轉拼音」「繁體轉簡體」「分詞」由呼叫端注入（瀏覽器載入 pinyin-pro、opencc-js、Intl.Segmenter；測試時用 node 裝的套件）。
// node 與瀏覽器都能跑；嵌入成 FaZhTts（見 scripts/embed-code-ui.js）。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaZhTts = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const ZH = String.fromCharCode(0xAB67); // ꭧ（tʂ）
    // ---- 聲母（拼音 → 音素）
    const INITIAL = { b: 'p', c: 'ʦʰ', ch: ZH + 'ʰ', d: 't', f: 'f', g: 'k', h: 'x', j: 'ʨ', k: 'kʰ', l: 'l', m: 'm', n: 'n', p: 'pʰ', q: 'ʨʰ', r: 'ɻ', s: 's', sh: 'ʂ', t: 'tʰ', x: 'ɕ', z: 'ʦ', zh: ZH };
    const INITIAL_KEYS = ['zh', 'ch', 'sh', 'b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't', 'x', 'z']; // 先比對雙字母
    // ---- 韻母（"0" 是聲調要放的位置；U+032F 那個「非音節」小記號已拿掉，跟 misaki 最後 replace(chr(815)) 一樣）
    const FINAL = {
        a: ['a0'], ai: ['ai0'], an: ['a0', 'n'], ang: ['a0', 'ŋ'], ao: ['au0'], e: ['ɤ0'], ei: ['ei0'], en: ['ə0', 'n'], eng: ['ə0', 'ŋ'], i: ['i0'],
        ia: ['j', 'a0'], ian: ['j', 'ɛ0', 'n'], iang: ['j', 'a0', 'ŋ'], iao: ['j', 'au0'], ie: ['j', 'e0'], in: ['i0', 'n'], iou: ['j', 'ou0'], ing: ['i0', 'ŋ'],
        iong: ['j', 'ʊ0', 'ŋ'], ong: ['ʊ0', 'ŋ'], ou: ['ou0'], u: ['u0'], uei: ['w', 'ei0'], ua: ['w', 'a0'], uai: ['w', 'ai0'], uan: ['w', 'a0', 'n'],
        uen: ['w', 'ə0', 'n'], uang: ['w', 'a0', 'ŋ'], ueng: ['w', 'ə0', 'ŋ'], uo: ['w', 'o0'], o: ['w', 'o0'],
        'ü': ['y0'], 'üe': ['ɥ', 'e0'], 'üan': ['ɥ', 'ɛ0', 'n'], 'ün': ['y0', 'n'],
    };
    const AFTER_ZH_CH_SH_R = 'ɨ0'; // zhi chi shi ri 的 i（舌尖後元音，Kokoro 用 ɨ）
    const AFTER_Z_C_S = 'ɨ0';      // zi ci si 的 i
    const SYLLABIC = { hm: ['h', 'm0'], hng: ['h', 'ŋ0'], m: ['m0'], n: ['n0'], ng: ['ŋ0'] };
    const INTERJECTION = { io: ['j', 'ɔ0'], 'ê': ['ɛ0'], er: ['ɚ0'], o: ['ɔ0'] };
    const TONE = { 1: '→', 2: '↗', 3: '↓', 4: '↘', 5: '' };

    // 帶聲調數字的拼音（"ni3"、"lü4"、"shang0"）→ { initial, final, tone, special }
    function splitPinyin(py) {
        let s = String(py == null ? '' : py).trim().toLowerCase().replace(/v/g, 'ü');
        const m = /^([a-zü ê]+?)([0-5])?$/.exec(s); if (!m) return null;
        let base = m[1].trim(), tone = m[2] == null ? 5 : Number(m[2]); if (tone === 0) tone = 5;
        if (INTERJECTION[base] && !(base === 'o' && false)) { return { special: INTERJECTION[base], tone, base }; }
        if (SYLLABIC[base]) return { special: SYLLABIC[base], tone, base };
        let initial = '', fin = base;
        if (base[0] === 'y') {
            const rest = base.slice(1);
            if (/^(i|in|ing)$/.test(rest)) fin = rest;
            else if (rest[0] === 'u') fin = 'ü' + rest.slice(1); // yu yue yuan yun
            else if (rest === 'o') fin = 'o';                     // yo（跟 misaki 一樣當 o）
            else fin = 'i' + rest;                                // ya ye yao you yan yang yong
        } else if (base[0] === 'w') {
            const rest = base.slice(1);
            fin = rest === 'u' ? 'u' : 'u' + rest;                // wa wo wai wei wan wen wang weng
        } else {
            for (const k of INITIAL_KEYS) { if (base.startsWith(k) && base.length > k.length) { initial = k; break; } }
            fin = base.slice(initial.length);
            if (initial && 'jqx'.includes(initial)) fin = fin.replace(/^u(e|an|n)?$/, (x, y) => 'ü' + (y || '')); // ju qu xu → ü
            else if (initial) { if (fin === 'ui') fin = 'uei'; else if (fin === 'un') fin = 'uen'; }
            if (initial && fin === 'iu') fin = 'iou'; // liu jiu qiu xiu
        }
        // y 開頭時 iou/uen 之類也要走標準寫法（you→iou 已是；yin 之類已處理）
        return { initial, final: fin, tone, base };
    }
    // 一個音節 → IPA 音素字串（含聲調箭頭）；認不得的音節回 ''
    function syllableToIpa(py) {
        const sp = splitPinyin(py); if (!sp) return '';
        const t = TONE[sp.tone] != null ? TONE[sp.tone] : '';
        if (sp.special) return sp.special.map((p) => p.replace('0', t)).join('');
        const parts = [];
        if (sp.initial) parts.push(INITIAL[sp.initial]);
        let fp;
        if (sp.final === 'i' && ['zh', 'ch', 'sh', 'r'].includes(sp.initial)) fp = [AFTER_ZH_CH_SH_R];
        else if (sp.final === 'i' && ['z', 'c', 's'].includes(sp.initial)) fp = [AFTER_Z_C_S];
        else fp = FINAL[sp.final];
        if (!fp) return '';
        return parts.concat(fp.map((p) => p.replace('0', t))).join('');
    }

    // ---- 數字：阿拉伯數字 → 中文念法（cn2an 的 an2cn 那一類，做常用的子集）
    const DIG = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    const UNIT = ['', '十', '百', '千'];
    function intToZh(str) {
        str = str.replace(/^0+(?=\d)/, ''); if (str === '0') return '零';
        if (str.length > 12) return str.split('').map((d) => DIG[+d]).join('');
        const groups = []; for (let i = str.length; i > 0; i -= 4) groups.unshift(str.slice(Math.max(0, i - 4), i));
        const BIG = ['', '万', '亿'];
        let out = '', zeroPending = false;
        groups.forEach((g, gi) => {
            const bigIdx = groups.length - 1 - gi; const n = +g;
            if (n === 0) { if (out) zeroPending = true; return; }
            let seg = '', z = false;
            const gs = g.padStart(4, '0');
            for (let i = 0; i < 4; i++) { const d = +gs[i]; if (d === 0) { if (seg) z = true; continue; } if (z) { seg += '零'; z = false; } seg += DIG[d] + UNIT[3 - i]; }
            if (/^一十/.test(seg) && !out) seg = seg.slice(1); // 十、十二（開頭的「一十」念「十」）
            if (zeroPending || (out && +gs[0] === 0)) { out += '零'; zeroPending = false; }
            out += seg + BIG[bigIdx];
        });
        return out;
    }
    function normalizeNumbers(text) {
        let s = String(text);
        s = s.replace(/(\d{4})\s*年/g, (m, y) => y.split('').map((d) => DIG[+d]).join('') + '年');                     // 2024年 → 二零二四年
        s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, (m, n) => '百分之' + n);                                                  // 50% → 百分之50
        s = s.replace(/\d+(?:\.\d+)?/g, (m) => { const [i, f] = m.split('.'); const intPart = i.length > 9 && !f ? i.split('').map((d) => DIG[+d]).join('') : intToZh(i); return f ? intPart + '点' + f.split('').map((d) => DIG[+d]).join('') : intPart; });
        return s;
    }
    // ---- 標點（跟 misaki 的 map_punctuation 一樣）；Kokoro 的字彙裡只有半形與少數符號
    function mapPunctuation(text) {
        return String(text).replace(/[、，]/g, ', ').replace(/[。．]/g, '. ').replace(/！/g, '! ').replace(/：/g, ': ').replace(/；/g, '; ').replace(/？/g, '? ')
            .replace(/[«《「【]/g, ' “').replace(/[»》」】]/g, '” ').replace(/（/g, ' (').replace(/）/g, ') ').replace(/[…⋯]+/g, '… ').replace(/[—─]+/g, '— ').replace(/\s+/g, ' ').trim();
    }
    // ---- 英文字母：Kokoro 的中文聲音念不出英文單字，這裡把字母一個一個唸出來（照中文裡念字母的習慣）
    const LETTER = { a: 'ei1', b: 'bi4', c: 'xi1', d: 'di4', e: 'yi4', f: 'ai4 fu2', g: 'ji4', h: 'ai4 chi4', i: 'ai4', j: 'jie4', k: 'kai4', l: 'ai4 lu4', m: 'ai4 mu3', n: 'en1', o: 'ou1', p: 'pi4', q: 'qiu1', r: 'a4', s: 'ai4 si1', t: 'ti4', u: 'you1', v: 'wei1', w: 'da2 bu4 liu2', x: 'ai4 ke4 si1', y: 'wai4', z: 'zei4' };
    function latinToIpa(run) { return run.toLowerCase().split('').map((c) => (LETTER[c] || '').split(' ').filter(Boolean).map(syllableToIpa).join('')).filter(Boolean).join(' '); }
    const ALLOWED_OTHER = /[,.!?:;“”()—…'\-\s]/;
    const CJK_RE = /[㐀-䶿一-鿿]+/;

    // 一段文字（沒有句號等分句）→ 音素字串。deps：{ toSimplified?(s), pinyin(s) → 每個字一個「帶聲調數字」的拼音陣列, segment?(s) → 詞陣列 }
    function textToPhonemes(text, deps) {
        deps = deps || {}; const s = mapPunctuation(normalizeNumbers(text)); const out = [];
        const re = /([㐀-䶿一-鿿]+)|([A-Za-z]+)|([^㐀-䶿一-鿿A-Za-z]+)/g; let m;
        while ((m = re.exec(s))) {
            if (m[1]) {
                let run = m[1]; let simp = run; try { if (deps.toSimplified) { const c = deps.toSimplified(run); if (c && c.length === run.length) simp = c; } } catch (_) { /* 用原文 */ }
                let toks = []; try { toks = deps.pinyin(simp) || []; } catch (_) { toks = []; }
                if (toks.length !== simp.length) toks = Array.from(simp).map((ch) => { try { return (deps.pinyin(ch) || [])[0] || ''; } catch (_) { return ''; } });
                let words = [simp]; try { if (deps.segment) { const w = deps.segment(simp); if (Array.isArray(w) && w.join('') === simp) words = w; } } catch (_) { /* 整段當一個詞 */ }
                let pos = 0; const ws = [];
                for (const w of words) { const n = Array.from(w).length; ws.push(toks.slice(pos, pos + n).map(syllableToIpa).join('')); pos += n; }
                out.push(ws.filter(Boolean).join(' '));
            } else if (m[2]) out.push(' ' + latinToIpa(m[2]) + ' ');
            else out.push(Array.from(m[3]).map((c) => (ALLOWED_OTHER.test(c) ? c : ' ')).join(''));
        }
        return out.join('').replace(/\s+/g, ' ').replace(/\s+([,.!?:;])/g, '$1').trim();
    }
    // 整篇文字 → 一段一段的音素（每段不超過 maxLen 個字元，模型一次最多吃 510 個符號）：先照句末標點切，再把相鄰的句子併起來
    function textToChunks(text, deps, maxLen) {
        maxLen = maxLen || 460; const sentences = String(text == null ? '' : text).split(/(?<=[。！？!?；;…\n])/).map((x) => x.trim()).filter(Boolean);
        const ph = []; for (const sn of sentences) { const p = textToPhonemes(sn, deps); if (!p) continue; if (p.length <= maxLen) ph.push(p); else { let cur = ''; for (const piece of p.split(/(?<=[,;:])\s*/)) { if ((cur + ' ' + piece).trim().length > maxLen && cur) { ph.push(cur.trim()); cur = piece; } else cur = (cur + ' ' + piece).trim(); } if (cur) ph.push(cur.slice(0, maxLen)); } }
        const chunks = []; let cur = ''; for (const p of ph) { if (cur && (cur + ' ' + p).length > maxLen) { chunks.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; } if (cur) chunks.push(cur);
        return chunks;
    }
    // Kokoro 的中文聲音（v1.0 模型內建）
    const VOICES = [
        { id: 'zf_xiaoxiao', name: '曉曉', gender: '女' }, { id: 'zf_xiaoni', name: '曉妮', gender: '女' }, { id: 'zf_xiaoyi', name: '曉伊', gender: '女' }, { id: 'zf_xiaobei', name: '曉貝', gender: '女' },
        { id: 'zm_yunxi', name: '雲希', gender: '男' }, { id: 'zm_yunyang', name: '雲揚', gender: '男' }, { id: 'zm_yunjian', name: '雲健', gender: '男' }, { id: 'zm_yunxia', name: '雲夏', gender: '男' },
    ];
    return { splitPinyin, syllableToIpa, normalizeNumbers, mapPunctuation, latinToIpa, textToPhonemes, textToChunks, intToZh, VOICES, INITIAL, FINAL };
});
