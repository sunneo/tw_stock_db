/* 語音合成的意圖辨識（UMD，純函式）：使用者用自然語言說「用英文語音說 Goodnight sleepy head」「把「晚安」念出來」「tts: hello」時，
 * 程式直接認出來、抽出「要念的字」，走跟 /media-text-to-speech 同一條路——不經過模型，念的字一個字都不改。
 * 原因（2026-10-17 使用者實測）：交給模型時，它先說「我沒有語音合成工具」（text_to_speech 在影音領域，不在最上層），重來後念的內容也不對；
 * 這種「動作明確、參數就是使用者打的字」的需求，程式比模型可靠。
 * 只認「像命令」的句子：提問（怎麼用語音合成？你有語音功能嗎？）、句子太長、有附件，都不當成命令，交給模型。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaTtsIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const LANGS = { 英文: 'en', 英語: 'en', english: 'en', 中文: 'zh', 國語: 'zh', 普通話: 'zh', 粵語: 'yue', 廣東話: 'yue', 日文: 'ja', 日語: 'ja', 韓文: 'ko', 韓語: 'ko' };
    const LANG_RE = '(英文|英語|English|中文|國語|普通話|粵語|廣東話|日文|日語|韓文|韓語)';
    const POLITE = '(?:請|麻煩|幫我|幫忙|可以|能不能|你可以)?\\s*(?:請)?';
    const QUESTION = /(怎麼|如何|為什麼|為何|是什麼|什麼是|能不能|可不可以|可以嗎|有沒有|有嗎|支援|不能|不行|壞了|失敗|設定|在哪|哪裡|教我|教學|說明|\?|？|嗎\s*$|呢\s*$)/;
    const unquote = (t) => { let s = String(t).trim(); const pairs = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"], ['‘', '’']]; for (const [a, b] of pairs) if (s.length >= 2 && s.startsWith(a) && s.endsWith(b)) { s = s.slice(1, -1).trim(); break; } return s; };
    // 回傳 { text, lang, form } 或 null
    function parse(message) {
        const raw = String(message || '').trim(); if (!raw || raw.length > 400 || raw.startsWith('/')) return null;
        let m;
        // C：tts: hello／TTS hello world
        if ((m = /^tts\s*[：:]?\s*([\s\S]+)$/i.exec(raw))) return done(m[1], null, 'tts');
        // D：read aloud: hello／say out loud hello
        if ((m = /^(?:please\s+)?(?:read|say|speak)\s+(?:aloud|out\s*loud)\s*[：:]?\s*([\s\S]+)$/i.exec(raw))) return done(m[1], null, 'aloud');
        // B：把「晚安」念出來／把這句念出來：Hello
        if ((m = new RegExp('^' + POLITE + '把\\s*([\\s\\S]+?)\\s*(?:念|唸|讀|朗讀)(?:出來|一下|給我聽)?\\s*$').exec(raw))) { const t = unquote(m[1]); if (!/^(這句|這段|這個|它|上面|剛剛|上一句)/.test(t)) return done(t, null, 'ba'); }
        // B2：把這句念出來：Hello
        if ((m = new RegExp('^' + POLITE + '把\\s*(?:這句|這段|這個|以下|下面)[話文字]*\\s*(?:念|唸|讀|朗讀)(?:出來|一下|給我聽)?\\s*[：:，,]\\s*([\\s\\S]+)$').exec(raw))) return done(m[1], null, 'ba2');
        // A：用英文語音說 xxx／請用語音念：xxx／朗讀 xxx／念出來：xxx
        if ((m = new RegExp('^' + POLITE + '(?:用|以|使用)?\\s*' + LANG_RE + '?\\s*(語音|聲音|配音|發音)?\\s*(說|講|唸|念|讀|朗讀|唸出|念出|讀出)((?:出來|一下|看看|給我聽)?)\\s*([：:，,]?)\\s*([\\s\\S]+)$', 'i').exec(raw))) {
            const lang = m[1] ? LANGS[m[1].toLowerCase()] || LANGS[m[1]] : null, voiceWord = m[2], verb = m[3], suffix = m[4], sep = m[5], text = m[6];
            if ((verb === '說' || verb === '講') && !voiceWord) return null; // 單純「說」不一定是語音合成（「說明一下…」「說說看…」）
            // 「念／唸／讀」也常見於別的意思（念書、讀一下檔案）：沒說「語音」也沒指定語言時，要有「出來／給我聽」或冒號才算
            if (['念', '唸', '讀'].includes(verb) && !voiceWord && !lang && !/出來|給我聽/.test(suffix) && !sep) return null;
            return done(text, lang, 'a');
        }
        return null;
        function done(text, lang, form) {
            const t = unquote(text); if (!t || t.length > 300) return null; if (QUESTION.test(raw) && !/^["「『“]/.test(String(text).trim())) return null;
            if (/^(這個功能|語音合成|語音功能|語音|聲音|tts)$/i.test(t)) return null; // 只剩功能名稱，不是要念的字
            return { text: t, lang: lang || null, form };
        }
    }
    return { parse, unquote, LANGS };
});
