// 原生執行器的分詞器（純函式）：位元組級 BPE，讀 Hugging Face 的 tokenizer.json（Qwen2／Qwen3 同一格式）。
// 流程與 transformers.js 的 tokenizers 相同：NFC 正規化 → 特殊符號（added_tokens）切出 → 預分詞（Split 正規表達式）
//   → 位元組對應到可見字元（GPT-2 的 bytes_to_unicode）→ 依 merges 順序合併 → 查 vocab 取得 id。
// 不做：截斷、填充、後處理樣板（聊天樣板由 template.js 負責）。
'use strict';

function bytesToUnicode() {
    const bs = []; for (let b = 33; b <= 126; b++) bs.push(b); for (let b = 161; b <= 172; b++) bs.push(b); for (let b = 174; b <= 255; b++) bs.push(b);
    const cs = bs.slice(); let n = 0;
    for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
    const b2u = {}, u2b = {};
    bs.forEach((b, i) => { const c = String.fromCharCode(cs[i]); b2u[b] = c; u2b[c] = b; });
    return { b2u, u2b };
}
const { b2u, u2b } = bytesToUnicode();

function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 從 tokenizer.json 的物件建立分詞器
function createTokenizer(tokj) {
    if (!tokj || !tokj.model || tokj.model.type !== 'BPE') throw new Error('只支援 BPE 的 tokenizer.json');
    const vocab = tokj.model.vocab;
    const ranks = new Map();
    tokj.model.merges.forEach((m, i) => { const pair = Array.isArray(m) ? m : m.split(' '); ranks.set(pair[0] + '\u0001' + pair[1], i); });
    const added = (tokj.added_tokens || []).map((t) => ({ content: t.content, id: t.id }));
    const addedMap = new Map(added.map((t) => [t.content, t.id]));
    const addedRe = added.length ? new RegExp('(' + added.map((t) => reEsc(t.content)).sort((a, b) => b.length - a.length).join('|') + ')') : null;
    const pre = tokj.pre_tokenizer && tokj.pre_tokenizer.pretokenizers ? tokj.pre_tokenizer.pretokenizers.find((p) => p.type === 'Split') : null;
    if (!pre || !pre.pattern || !pre.pattern.Regex) throw new Error('tokenizer.json 缺少 Split 預分詞規則');
    // 舊版 Node 不支援行內旗標群組 (?i:...)，這裡把它展開成大小寫都接受的寫法（只處理不含巢狀括號的群組）
    const rx = String(pre.pattern.Regex).replace(/\(\?i:([^()]*)\)/g, (_, body) => '(?:' + body.replace(/[A-Za-z]/g, (ch) => '[' + ch.toLowerCase() + ch.toUpperCase() + ']') + ')');
    const preRe = new RegExp(rx, 'gu');
    const normalizeNFC = !!(tokj.normalizer && tokj.normalizer.type === 'NFC');
    const idToTok = new Map(Object.entries(vocab).map(([k, v]) => [v, k]));
    for (const t of added) idToTok.set(t.id, t.content);

    function bpe(word) {
        let parts = Array.from(word);
        while (parts.length > 1) {
            let best = null, bi = -1;
            for (let i = 0; i < parts.length - 1; i++) {
                const r = ranks.get(parts[i] + '\u0001' + parts[i + 1]);
                if (r !== undefined && (best === null || r < best)) { best = r; bi = i; }
            }
            if (bi < 0) break;
            parts = parts.slice(0, bi).concat([parts[bi] + parts[bi + 1]], parts.slice(bi + 2));
        }
        return parts;
    }
    function encodeChunk(text) {
        const ids = []; preRe.lastIndex = 0; let m;
        while ((m = preRe.exec(text))) {
            const piece = Array.from(Buffer.from(m[0], 'utf8'), (b) => b2u[b]).join('');
            for (const tok of bpe(piece)) {
                const id = vocab[tok];
                if (id === undefined) throw new Error('vocab 找不到 token：' + JSON.stringify(tok));
                ids.push(id);
            }
        }
        return ids;
    }
    function encode(text) {
        const out = [];
        const parts = addedRe ? String(text).split(addedRe) : [String(text)];
        for (const part of parts) {
            if (!part) continue;
            if (addedMap.has(part)) { out.push(addedMap.get(part)); continue; }
            out.push(...encodeChunk(normalizeNFC ? part.normalize('NFC') : part));
        }
        return out;
    }
    function decode(ids) {
        const s = ids.map((i) => (idToTok.has(i) ? idToTok.get(i) : '')).join('');
        // 特殊符號原樣保留；其餘字元依位元組對應還原成 UTF-8
        const specials = new Set(added.map((t) => t.content));
        let out = '', buf = [];
        const flush = () => { if (buf.length) { out += Buffer.from(buf).toString('utf8'); buf = []; } };
        for (const tok of ids.map((i) => (idToTok.has(i) ? idToTok.get(i) : ''))) {
            if (specials.has(tok)) { flush(); out += tok; continue; }
            for (const c of Array.from(tok)) buf.push(u2b[c] !== undefined ? u2b[c] : 0);
        }
        flush();
        return out;
    }
    return { encode, decode, vocabSize: idToTok.size, specials: added.map((t) => t.content) };
}

module.exports = { createTokenizer, bytesToUnicode };
