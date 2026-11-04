// 原生執行器的生成參數語意（純函式）：與 transformers.js 的 logits 處理器做法相同，參數名稱與桌面版 FaVlm.textGenParams 一致。
// 不自訂預設：產品端（renderer/src/vlm/vlm_core.js 的 textGenParams）算出 gen 物件，原生端照字面套用。
// 支援的鍵：do_sample、temperature、top_p、repetition_penalty、no_repeat_ngram_size。其他鍵直接報錯（不靜默忽略）。
// 處理順序（與 transformers.js 相同）：重複懲罰 → 不重複 n-gram → 溫度 → top-p → 取樣（do_sample 為 false 時取 argmax）。
'use strict';

const SUPPORTED = ['do_sample', 'temperature', 'top_p', 'repetition_penalty', 'no_repeat_ngram_size'];

function validateGen(gen) {
    if (!gen || typeof gen !== 'object' || Array.isArray(gen)) throw new Error('gen 必須是物件（產品端的 textGenParams 結果）');
    for (const k of Object.keys(gen)) if (SUPPORTED.indexOf(k) < 0) throw new Error('原生端不支援的生成參數：' + k);
    if (gen.repetition_penalty != null && !(Number(gen.repetition_penalty) > 0)) throw new Error('repetition_penalty 必須大於 0');
    if (gen.temperature != null && !(Number(gen.temperature) > 0)) throw new Error('temperature 必須大於 0');
    if (gen.top_p != null && !(Number(gen.top_p) > 0 && Number(gen.top_p) <= 1)) throw new Error('top_p 必須在 (0, 1]');
    if (gen.no_repeat_ngram_size != null && !(Number.isInteger(gen.no_repeat_ngram_size) && gen.no_repeat_ngram_size >= 0)) throw new Error('no_repeat_ngram_size 必須是非負整數');
    return gen;
}

// 重複懲罰（RepetitionPenaltyLogitsProcessor）：對 input 加已生成的全部 token 的 logits，正數除以 penalty、負數乘以 penalty。
function applyRepetitionPenalty(logits, seenIds, penalty) {
    if (penalty == null || penalty === 1) return;
    const seen = new Set(seenIds);
    for (const t of seen) {
        if (t < 0 || t >= logits.length) continue;
        const v = logits[t];
        logits[t] = v > 0 ? v / penalty : v * penalty;
    }
}

// 不重複 n-gram（NoRepeatNGramLogitsProcessor）：若某個 n-1 前綴已在序列中出現過，就禁止接續出現過的下一個 token。
function applyNoRepeatNGram(logits, seqIds, n) {
    if (!n || n <= 1 || seqIds.length < n) return;
    const banned = new Map(); // 前綴字串 → 禁止的下一個 token 集合
    for (let i = 0; i + n <= seqIds.length; i++) {
        const prefix = seqIds.slice(i, i + n - 1).join(',');
        const next = seqIds[i + n - 1];
        if (!banned.has(prefix)) banned.set(prefix, new Set());
        banned.get(prefix).add(next);
    }
    const tail = seqIds.slice(seqIds.length - (n - 1)).join(',');
    const bans = banned.get(tail);
    if (bans) for (const t of bans) logits[t] = -Infinity;
}

// 溫度（TemperatureLogitsWarper）
function applyTemperature(logits, temperature) {
    if (temperature == null || temperature === 1) return;
    for (let i = 0; i < logits.length; i++) logits[i] = logits[i] / temperature;
}

// top-p（TopPLogitsWarper）：依 transformers.js 的做法，升序排序後累積機率 ≤ (1 − top_p) 的 token 移除；至少保留 1 個。
function applyTopP(logits, topP) {
    if (topP == null || topP >= 1) return;
    const idx = Array.from(logits.keys()).sort((a, b) => logits[a] - logits[b]); // 升序
    let max = -Infinity; for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
    let sum = 0; const e = new Float64Array(logits.length);
    for (let i = 0; i < logits.length; i++) { e[i] = Math.exp(logits[i] - max); sum += e[i]; }
    let cum = 0;
    for (let j = 0; j < idx.length; j++) {
        const t = idx[j];
        cum += e[t] / sum;
        if (cum <= 1 - topP && j < idx.length - 1) logits[t] = -Infinity; else break;
    }
}

// 可重現的亂數（mulberry32）：同一個 seed 得到同一串數字
function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 依 gen 從 logits 選出下一個 token。logits 會被就地修改。
// promptIds：輸入的 token；genIds：已生成的 token；rng：do_sample 為 true 時使用（必須傳入，保證可重現）。
function pickToken(logits, promptIds, genIds, gen, rng) {
    validateGen(gen);
    const all = promptIds.concat(genIds);
    applyRepetitionPenalty(logits, all, gen.repetition_penalty);
    applyNoRepeatNGram(logits, all, gen.no_repeat_ngram_size);
    if (gen.do_sample === false) {
        let best = 0, bv = -Infinity;
        for (let i = 0; i < logits.length; i++) if (logits[i] > bv) { bv = logits[i]; best = i; }
        return best;
    }
    if (typeof rng !== 'function') throw new Error('取樣需要可重現的亂數函式（rng），不能用 Math.random');
    applyTemperature(logits, gen.temperature);
    applyTopP(logits, gen.top_p);
    let max = -Infinity; for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
    let sum = 0; const p = new Float64Array(logits.length);
    for (let i = 0; i < logits.length; i++) { p[i] = logits[i] === -Infinity ? 0 : Math.exp(logits[i] - max); sum += p[i]; }
    const r = rng() * sum;
    let acc = 0;
    for (let i = 0; i < p.length; i++) { acc += p[i]; if (r < acc) return i; }
    return p.length - 1;
}

module.exports = { SUPPORTED, validateGen, applyRepetitionPenalty, applyNoRepeatNGram, applyTemperature, applyTopP, makeRng, pickToken };
