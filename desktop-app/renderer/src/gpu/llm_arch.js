/* llm_arch.js — 解碼器架構描述表（O12a，docs/CHECKLIST.cudaweb-optimize.md 的 O12）。
 * 每個模型族一份純資料描述；通用解碼骨架（O12b）依描述表組出每層的運算序列，不寫死任何模型的維度。
 * 這裡只有資料與驗證函式，沒有任何 GPU 或模型權重。
 * 欄位的數字是依公開的 config.json 寫的，status 與 verified 欄位標示是否已對照實際下載的檔案：
 *   verified: false 的數字都要在下載 config.json 後核對（O12d 的 sha256 與核對一起做）。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaLlmArch。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaLlmArch = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ACT = ['silu_mul', 'gelu'];                  // 前饋啟動：SiLU×up（Llama／Qwen）、GELU
  const NORM = ['rmsnorm', 'layernorm'];
  const ROPE_STYLE = ['half', 'interleaved'];        // half：前後半配對（Llama／Qwen）；interleaved：相鄰配對
  const QUANT = ['q8', 'q4', 'f16', 'f32'];
  const REQUIRED = ['family', 'status', 'layers', 'hidden', 'heads', 'kvHeads', 'ffn', 'norm', 'eps', 'qkNorm', 'rope', 'act', 'bias', 'tiedEmbeddings', 'vocab', 'quant'];

  // status：'supported'＝骨架會用它（仍需對照實際檔案）；'pending'＝只寫欄位與待驗證標記，不宣稱支援。
  const FAMILIES = {
    'tinyllama-1.1b': {
      family: 'llama', status: 'supported', verified: false,
      layers: 22, hidden: 2048, heads: 32, kvHeads: 4, headDim: 64, ffn: 5632,
      norm: 'rmsnorm', eps: 1e-5, qkNorm: false,
      rope: { base: 10000, scaling: null, style: 'half' },
      act: 'silu_mul', bias: false, tiedEmbeddings: false,
      vocab: 32000, quant: ['q8', 'q4', 'f16', 'f32'],
      specialTokens: { bos: 1, eos: 2 },
      note: 'RMSNorm＋RoPE＋GQA＋SiLU（Llama 2 架構）'
    },
    'llama-3.2-1b': {
      family: 'llama', status: 'supported', verified: false,
      layers: 16, hidden: 2048, heads: 32, kvHeads: 8, headDim: 64, ffn: 8192,
      norm: 'rmsnorm', eps: 1e-5, qkNorm: false,
      rope: { base: 500000, scaling: { type: 'llama3', factor: 32 }, style: 'half' },
      act: 'silu_mul', bias: false, tiedEmbeddings: true,
      vocab: 128256, quant: ['q8', 'q4', 'f16', 'f32'],
      specialTokens: { bos: 128000, eos: 128001 },
      note: 'Llama 3.x：RoPE 有 llama3 縮放，嵌入與 lm_head 共用'
    },
    'smollm2-135m': {
      family: 'llama', status: 'supported', verified: false,
      layers: 30, hidden: 576, heads: 9, kvHeads: 3, headDim: 64, ffn: 1536,
      norm: 'rmsnorm', eps: 1e-5, qkNorm: false,
      rope: { base: 100000, scaling: null, style: 'half' },
      act: 'silu_mul', bias: false, tiedEmbeddings: true,
      vocab: 49152, quant: ['q8', 'q4', 'f16', 'f32'],
      specialTokens: { bos: 1, eos: 2 },
      note: 'SmolLM2：Llama 結構的小模型'
    },
    'qwen3-0.6b': {
      family: 'qwen3', status: 'supported', verified: false,
      layers: 28, hidden: 1024, heads: 16, kvHeads: 8, headDim: 128, ffn: 3072,
      norm: 'rmsnorm', eps: 1e-6, qkNorm: true,
      rope: { base: 1000000, scaling: null, style: 'half' },
      act: 'silu_mul', bias: false, tiedEmbeddings: true,
      vocab: 151936, quant: ['q8', 'q4', 'f16', 'f32'],
      specialTokens: { bos: null, eos: 151645 },
      note: 'Qwen3 以描述表表示（qk-norm 開）；現有 qwen_gpu 的覆寫集合在 O12c 才接上'
    },
    'qwen2-0.5b': {
      family: 'qwen2', status: 'supported', verified: false,
      layers: 24, hidden: 1024, heads: 16, kvHeads: 16, headDim: 64, ffn: 2816,
      norm: 'rmsnorm', eps: 1e-6, qkNorm: false,
      rope: { base: 1000000, scaling: null, style: 'half' },
      act: 'silu_mul', bias: true, tiedEmbeddings: true,
      vocab: 152000, quant: ['q8', 'f16', 'f32'],
      specialTokens: { bos: 151643, eos: 151645 },
      note: 'Qwen2（LLaVA-Interleave 0.5B 的語言模型）：q、k、v 有偏置（o 沒有）；config.json 沒寫 rms_norm_eps，eps 取 Qwen2 預設 1e-6（待對 modeling 程式）；kvHeads＝heads（沒有 GQA）'
    },
    'gemma': {
      family: 'gemma', status: 'pending', verified: false,
      layers: null, hidden: null, heads: null, kvHeads: null, headDim: null, ffn: null,
      norm: null, eps: null, qkNorm: null, rope: null, act: null, bias: null, tiedEmbeddings: null,
      vocab: null, quant: [], specialTokens: null,
      note: '待驗證：只寫欄位，不宣稱支援（與 Llama 的差異尚未對照）'
    },
    'phi': {
      family: 'phi', status: 'pending', verified: false,
      layers: null, hidden: null, heads: null, kvHeads: null, headDim: null, ffn: null,
      norm: null, eps: null, qkNorm: null, rope: null, act: null, bias: null, tiedEmbeddings: null,
      vocab: null, quant: [], specialTokens: null,
      note: '待驗證：只寫欄位，不宣稱支援'
    }
  };

  // 驗證一份描述：回傳 { ok, errors[] }。pending 的描述只檢查欄位名稱與 status，不要求數字。
  function validateArch(d) {
    const errors = [];
    if (!d || typeof d !== 'object') return { ok: false, errors: ['描述不是物件'] };
    if (d.status !== 'supported' && d.status !== 'pending') errors.push('status 只能是 supported 或 pending');
    if (d.status === 'pending') {
      if (typeof d.family !== 'string' || !d.family) errors.push('family 必填');
      return { ok: errors.length === 0, errors: errors };
    }
    REQUIRED.forEach((k) => { if (d[k] === undefined) errors.push('缺少欄位 ' + k); });
    const pos = (k) => { if (!(typeof d[k] === 'number' && isFinite(d[k]) && d[k] > 0)) errors.push(k + ' 必須是正數'); };
    ['layers', 'hidden', 'heads', 'kvHeads', 'ffn', 'vocab'].forEach(pos);
    if (typeof d.heads === 'number' && typeof d.kvHeads === 'number') {
      if (d.kvHeads > d.heads) errors.push('kvHeads 不能大於 heads');
      if (d.heads % d.kvHeads !== 0) errors.push('heads 必須是 kvHeads 的整數倍（GQA）');
    }
    if (typeof d.hidden === 'number' && typeof d.heads === 'number') {
      // 有給 headDim 就以它為準（Qwen3 的 head 維度與 hidden／heads 不相等，合法）；沒給就要求 hidden 能被 heads 整除
      if (d.headDim !== undefined) {
        if (!(typeof d.headDim === 'number' && d.headDim > 0)) errors.push('headDim 必須是正數');
      } else if (d.hidden % d.heads !== 0) {
        errors.push('hidden 必須能被 heads 整除（或明確給 headDim）');
      }
    }
    if (NORM.indexOf(d.norm) < 0) errors.push('norm 只能是 ' + NORM.join('、'));
    if (!(typeof d.eps === 'number' && d.eps > 0 && d.eps < 1)) errors.push('eps 必須在 (0,1)');
    if (typeof d.qkNorm !== 'boolean') errors.push('qkNorm 必須是布林');
    if (!d.rope || typeof d.rope !== 'object') errors.push('rope 必須是物件');
    else {
      if (!(typeof d.rope.base === 'number' && d.rope.base > 0)) errors.push('rope.base 必須是正數');
      if (ROPE_STYLE.indexOf(d.rope.style) < 0) errors.push('rope.style 只能是 ' + ROPE_STYLE.join('、'));
    }
    if (ACT.indexOf(d.act) < 0) errors.push('act 只能是 ' + ACT.join('、'));
    if (typeof d.bias !== 'boolean') errors.push('bias 必須是布林');
    if (typeof d.tiedEmbeddings !== 'boolean') errors.push('tiedEmbeddings 必須是布林');
    if (!Array.isArray(d.quant) || d.quant.length === 0) errors.push('quant 至少要一種格式');
    else d.quant.forEach((q) => { if (QUANT.indexOf(q) < 0) errors.push('quant 含不認得的格式：' + q); });
    return { ok: errors.length === 0, errors: errors };
  }

  // 取出一份描述（複製，避免呼叫端改到表本身）；沒有就回 null
  function archFor(name) {
    const d = FAMILIES[name];
    return d ? JSON.parse(JSON.stringify(d)) : null;
  }
  // 只有 status 為 supported 且通過驗證的，骨架才會用它
  function isSupported(name) {
    const d = FAMILIES[name];
    return !!d && d.status === 'supported' && validateArch(d).ok;
  }
  // 每個描述的每層 head 維度（有給就用給的，沒有就由 hidden／heads 推）
  function headDimOf(d) { return d.headDim !== undefined ? d.headDim : d.hidden / d.heads; }

  return { FAMILIES: FAMILIES, validateArch: validateArch, archFor: archFor, isSupported: isSupported, headDimOf: headDimOf, ACT: ACT, NORM: NORM, ROPE_STYLE: ROPE_STYLE, QUANT: QUANT };
}));
