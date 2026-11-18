/* llm_arch.js — 解碼器架構描述表（O12a，docs/CHECKLIST.cudaweb-optimize.md 的 O12）。
 * 每個模型族一份純資料描述；通用解碼骨架（O12b）依描述表組出每層的運算序列，不寫死任何模型的維度。
 * 這裡只有資料與驗證函式，沒有任何 GPU 或模型權重。
 * verified: true 表示數字已對照公開的 config.json（verifiedFrom 寫出 repo，2026-11-18 取得）；
 *   權重檔的 sha256 不在這裡核對（那是 qwen_models.js 的事，下載後才做）。
 * idPattern：哪些模型 id 用這份描述（O12d 的 isFamily 與 routeFor 依它判斷）。
 * routeFor：決定一個模型該走哪條路徑：'qwen_gpu'（既有的 Qwen3 GPU 路徑）、'generic'（通用骨架）、'onnx'（退回既有 ONNX 路徑）。
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
  const ROPE_SCALING = ['llama3'];                   // 描述表認得的 RoPE 縮放型別（骨架是否真的會算，見 SKELETON_ROPE）
  const SKELETON_ROPE = ['llama3'];                  // 通用骨架目前會算的縮放型別；其餘縮放一律退回 ONNX
  const SKELETON_ACT = ['silu_mul'];                 // 通用骨架目前會算的啟動；gelu 尚未實作
  const QUANT = ['q8', 'q4', 'f16', 'f32'];
  const REQUIRED = ['family', 'status', 'layers', 'hidden', 'heads', 'kvHeads', 'ffn', 'norm', 'eps', 'qkNorm', 'rope', 'act', 'bias', 'tiedEmbeddings', 'vocab', 'quant'];

  // status：'supported'＝骨架會用它（數字已對照 config）；'pending'＝只寫欄位與待驗證標記，不宣稱支援。
  const FAMILIES = {
    'tinyllama-1.1b': {
      family: 'llama', status: 'supported', verified: true, verifiedFrom: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0 config.json',
      idPattern: /^tinyllama-1\.1b$/,
      layers: 22, hidden: 2048, heads: 32, kvHeads: 4, headDim: 64, ffn: 5632,
      norm: 'rmsnorm', eps: 1e-5, qkNorm: false,
      rope: { base: 10000, scaling: null, style: 'half' },
      act: 'silu_mul', bias: false, tiedEmbeddings: false,
      vocab: 32000, quant: ['q8', 'q4', 'f16', 'f32'],
      specialTokens: { bos: 1, eos: 2 },
      note: 'RMSNorm＋RoPE＋GQA＋SiLU（Llama 2 架構）'
    },
    'llama-3.2-1b': {
      family: 'llama', status: 'supported', verified: true, verifiedFrom: 'onnx-community/Llama-3.2-1B-Instruct-ONNX config.json（與 meta-llama 同架構；原 meta-llama repo 需登入）',
      idPattern: /^llama-3\.2-1b$/,
      layers: 16, hidden: 2048, heads: 32, kvHeads: 8, headDim: 64, ffn: 8192,
      norm: 'rmsnorm', eps: 1e-5, qkNorm: false,
      rope: { base: 500000, scaling: { type: 'llama3', factor: 32, lowFreqFactor: 1, highFreqFactor: 4, originalMaxPos: 8192 }, style: 'half' },
      act: 'silu_mul', bias: false, tiedEmbeddings: true,
      vocab: 128256, quant: ['q8', 'q4', 'f16', 'f32'],
      specialTokens: { bos: 128000, eos: 128001, eosAlso: [128008, 128009] },
      note: 'Llama 3.x：RoPE 有 llama3 縮放（factor 32、low 1、high 4、原始 8192），嵌入與 lm_head 共用；config 的 eos 有三個，這裡列第一個'
    },
    'smollm2-135m': {
      family: 'llama', status: 'supported', verified: true, verifiedFrom: 'HuggingFaceTB/SmolLM2-135M-Instruct config.json',
      idPattern: /^smollm2-135m$/,
      layers: 30, hidden: 576, heads: 9, kvHeads: 3, headDim: 64, ffn: 1536,
      norm: 'rmsnorm', eps: 1e-5, qkNorm: false,
      rope: { base: 100000, scaling: null, style: 'half' },
      act: 'silu_mul', bias: false, tiedEmbeddings: true,
      vocab: 49152, quant: ['q8', 'q4', 'f16', 'f32'],
      specialTokens: { bos: 1, eos: 2 },
      note: 'SmolLM2：Llama 結構的小模型（只有 135M 這個尺寸在表裡；360M 等未列）'
    },
    'qwen3-0.6b': {
      family: 'qwen3', status: 'supported', verified: true, verifiedFrom: 'onnx-community/Qwen3-0.6B-ONNX config.json',
      idPattern: /^qwen3-/,
      layers: 28, hidden: 1024, heads: 16, kvHeads: 8, headDim: 128, ffn: 3072,
      norm: 'rmsnorm', eps: 1e-6, qkNorm: true,
      rope: { base: 1000000, scaling: null, style: 'half' },
      act: 'silu_mul', bias: false, tiedEmbeddings: true,
      vocab: 151936, quant: ['q8', 'q4', 'f16', 'f32'],
      specialTokens: { bos: 151643, eos: 151645 },
      note: 'Qwen3 以描述表表示（qk-norm 開）；現有 qwen_gpu 的覆寫集合在 O12c 才接上。idPattern 涵蓋所有 qwen3-*（1.7B 等與 0.6B 同族）'
    },
    'qwen2-0.5b': {
      family: 'qwen2', status: 'supported', verified: true, verifiedFrom: 'Qwen/Qwen2-0.5B-Instruct config.json',
      idPattern: /^qwen2-0\.5b$/,
      layers: 24, hidden: 896, heads: 14, kvHeads: 2, headDim: 64, ffn: 4864,
      norm: 'rmsnorm', eps: 1e-6, qkNorm: false,
      rope: { base: 1000000, scaling: null, style: 'half' },
      act: 'silu_mul', bias: true, tiedEmbeddings: true,
      vocab: 151936, quant: ['q8', 'f16', 'f32'],
      specialTokens: { bos: 151643, eos: 151645 },
      note: 'Qwen2（LLaVA-Interleave 0.5B 的語言模型）：q、k、v 有偏置（o 沒有）；GQA 為 14 個 query head 對 2 個 kv head。config 的 rms_norm_eps 為 1e-6。'
    },
    'gemma': {
      family: 'gemma', status: 'pending', verified: false, idPattern: /^gemma/,
      layers: null, hidden: null, heads: null, kvHeads: null, headDim: null, ffn: null,
      norm: null, eps: null, qkNorm: null, rope: null, act: null, bias: null, tiedEmbeddings: null,
      vocab: null, quant: [], specialTokens: null,
      note: '待驗證：只寫欄位，不宣稱支援（與 Llama 的差異尚未對照）'
    },
    'phi': {
      family: 'phi', status: 'pending', verified: false, idPattern: /^phi/,
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
      const s = d.rope.scaling;
      if (s !== null && s !== undefined) {
        if (ROPE_SCALING.indexOf(s.type) < 0) errors.push('RoPE 縮放型別只能是 ' + ROPE_SCALING.join('、') + '（實際 ' + s.type + '）');
        else if (s.type === 'llama3') {
          ['factor', 'lowFreqFactor', 'highFreqFactor', 'originalMaxPos'].forEach((k) => { if (!(typeof s[k] === 'number' && isFinite(s[k]) && s[k] > 0)) errors.push('rope.scaling.' + k + ' 必須是正數'); });
          if (typeof s.lowFreqFactor === 'number' && typeof s.highFreqFactor === 'number' && s.highFreqFactor <= s.lowFreqFactor) errors.push('rope.scaling：highFreqFactor 必須大於 lowFreqFactor');
        }
      }
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

  // 模型 id → 描述表的鍵（只看 supported 的；pending 的不回傳）。沒有就 null。
  function nameFor(id, table) {
    const T = table || FAMILIES, s = String(id || '');
    if (!s) return null;
    for (const k of Object.keys(T)) {
      const d = T[k];
      if (d && d.status === 'supported' && d.idPattern instanceof RegExp && d.idPattern.test(s)) return k;
    }
    return null;
  }
  // 模型 id → 族名（例如 'qwen3-4b' → 'qwen3'）；沒有描述就 null
  function familyFor(id, table) {
    const k = nameFor(id, table);
    return k ? (table || FAMILIES)[k].family : null;
  }
  // 決定路徑。caps：{ webgpu: boolean }（沒有就當作不能用 GPU）。回傳 { path, name, reason }
  //   qwen_gpu：Qwen3 族（既有的 GPU 路徑，O12c 之前仍由它負責）
  //   generic ：其他支援的族，骨架能算（需要 WebGPU；app 端尚未接上，呼叫端目前仍會走 ONNX）
  //   onnx    ：不支援、pending、沒有描述、沒有 WebGPU、或骨架不會算的結構
  function routeFor(id, caps, table) {
    const T = table || FAMILIES;
    const name = nameFor(id, T);
    if (!name) return { path: 'onnx', name: null, reason: '沒有描述表（或還是 pending）：' + String(id) };
    const d = T[name];
    const v = validateArch(d);
    if (!v.ok) return { path: 'onnx', name: name, reason: '描述表不合法：' + v.errors.join('；') };
    if (SKELETON_ACT.indexOf(d.act) < 0) return { path: 'onnx', name: name, reason: '骨架尚未支援啟動 ' + d.act };
    if (d.rope.scaling && SKELETON_ROPE.indexOf(d.rope.scaling.type) < 0) return { path: 'onnx', name: name, reason: '骨架尚未支援 RoPE 縮放 ' + d.rope.scaling.type };
    if (!(caps && caps.webgpu)) return { path: 'onnx', name: name, reason: '沒有 WebGPU' };
    return { path: d.family === 'qwen3' ? 'qwen_gpu' : 'generic', name: name, reason: '' };
  }

  return { FAMILIES: FAMILIES, validateArch: validateArch, archFor: archFor, isSupported: isSupported, headDimOf: headDimOf,
    nameFor: nameFor, familyFor: familyFor, routeFor: routeFor,
    ACT: ACT, NORM: NORM, ROPE_STYLE: ROPE_STYLE, ROPE_SCALING: ROPE_SCALING, SKELETON_ROPE: SKELETON_ROPE, SKELETON_ACT: SKELETON_ACT, QUANT: QUANT };
}));
