(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaBpeByteLevel = factory()); })(typeof self !== 'undefined' ? self : this, function () {
'use strict';
// 位元組級 BPE（GPT-2／HF ByteLevel 的做法），讀 HF tokenizers 的 tokenizer.json，逐 token 與 HF 一致。
// 流程：預分詞（ByteLevel 的正規式）→ 每段的 UTF-8 位元組 → 位元組對應的可見字元 → 依 merges 排序的貪婪合併 → 查 vocab。
// 支援：model.type = BPE；pre_tokenizer = ByteLevel（add_prefix_space 可為 true／false，use_regex true）；normalizer 與 post_processor 為 null。
// 其他設定一律拒絕（不靜默換成另一種切法）。

// GPT-2 的位元組→字元對應（可見字元保持原樣，其餘位元組映到 256 以上的字元）
function bytesToUnicode() {
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) if (bs.indexOf(b) < 0) { bs.push(b); cs.push(256 + n); n++; }
  const map = new Array(256);
  for (let i = 0; i < bs.length; i++) map[bs[i]] = String.fromCharCode(cs[i]);
  return map;
}
const BYTE_CHAR = bytesToUnicode();

// HF ByteLevel 的預分詞正規式（與 GPT-2 相同）
const PRE_RE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

function utf8(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  return Uint8Array.from(Buffer.from(str, 'utf8'));
}

// 讀 tokenizer.json（已 parse 的物件）
function load(json) {
  if (!json || !json.model || json.model.type !== 'BPE') throw new Error('bpe：只支援 model.type = BPE（收到 ' + (json && json.model && json.model.type) + '）');
  if (json.normalizer) throw new Error('bpe：本實作不支援 normalizer（這個檔有 normalizer）');
  if (json.post_processor) throw new Error('bpe：本實作不支援 post_processor（這個檔有後處理，會加特殊詞元）');
  const pt = json.pre_tokenizer;
  if (!pt || pt.type !== 'ByteLevel' || pt.use_regex === false) throw new Error('bpe：只支援 pre_tokenizer = ByteLevel（use_regex true）');
  const vocab = json.model.vocab;
  const ranks = new Map();
  (json.model.merges || []).forEach((m, i) => {
    const pair = Array.isArray(m) ? m : String(m).split(' ');
    if (pair.length !== 2) throw new Error('bpe：merges 第 ' + i + ' 項格式不對');
    ranks.set(pair[0] + '\u0001' + pair[1], i);
  });
  return { vocab, ranks, addPrefixSpace: !!pt.add_prefix_space, unk: json.model.unk_token || null };
}

// 單一預分詞段 → 詞元 id
function encodeWord(tok, chars) {
  let syms = chars.slice();
  for (;;) {
    let best = -1, bestRank = Infinity;
    for (let i = 0; i < syms.length - 1; i++) {
      const r = tok.ranks.get(syms[i] + '\u0001' + syms[i + 1]);
      if (r !== undefined && r < bestRank) { bestRank = r; best = i; }
    }
    if (best < 0) break;
    const a = syms[best], b = syms[best + 1];
    const out = [];
    for (let i = 0; i < syms.length; i++) {
      if (i < syms.length - 1 && syms[i] === a && syms[i + 1] === b) { out.push(a + b); i++; }
      else out.push(syms[i]);
    }
    syms = out;
  }
  return syms.map((s) => {
    const id = tok.vocab[s];
    if (id === undefined) throw new Error('bpe：詞表沒有符號 ' + JSON.stringify(s));
    return id;
  });
}

// 文字 → 詞元 id（逐段預分詞，段內 BPE）
function encode(tok, text) {
  const ids = [];
  const s = (tok.addPrefixSpace && text.length && !/^\s/.test(text)) ? ' ' + text : text;
  const re = new RegExp(PRE_RE.source, 'gu');
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const chars = Array.from(utf8(m[0]), (b) => BYTE_CHAR[b]);
    const sub = encodeWord(tok, chars);
    for (const id of sub) ids.push(id);
  }
  return ids;
}

return { load, encode, bytesToUnicode, PRE_RE };
});
