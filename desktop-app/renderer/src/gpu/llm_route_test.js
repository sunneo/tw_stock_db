'use strict';
// O12a／O12c／O12d 的檢查（先寫的測試）：
//  1. 描述表的數字與公開 config.json 逐項相同（2026-11-18 取得的 config，見各描述的 verifiedFrom）。
//  2. llama3 RoPE 縮放的頻率公式（純函式）與骨架的 CPU／GPU 版逐位相同；不支援的縮放型別仍然丟錯。
//  3. familyFor／routeFor：支援的結構走骨架或 qwen_gpu，不支援的（pending、無 WebGPU、未知族、不支援的縮放／啟動）退回 ONNX，不悄悄算錯。
//  4. qwen_models：模型族＋模型清單（Llama 3.2 1B 的大小與 sha256 來自 Hugging Face 的 LFS 標頭，尚未下載核對）；isFamily 依描述表判斷。
const assert = require('assert');
const A = require('./llm_arch.js');
const S = require('./llm_skeleton.js');
const G = require('./llm_skeleton_gpu.js');
const M = require('./qwen_models.js');
let passes = 0;
function check(name, fn) { fn(); passes++; console.log('ok   ' + name); }
async function checkAsync(name, fn) { await fn(); passes++; console.log('ok   ' + name); }

// ---------- 1. 描述表與 config.json ----------
const CONFIG = {
  'qwen2-0.5b': { family: 'qwen2', layers: 24, hidden: 896, heads: 14, kvHeads: 2, headDim: 64, ffn: 4864, vocab: 151936, eps: 1e-6, qkNorm: false, rope: { base: 1000000, scaling: null, style: 'half' }, act: 'silu_mul', bias: true, tiedEmbeddings: true, repo: 'Qwen/Qwen2-0.5B-Instruct' },
  'tinyllama-1.1b': { family: 'llama', layers: 22, hidden: 2048, heads: 32, kvHeads: 4, headDim: 64, ffn: 5632, vocab: 32000, eps: 1e-5, qkNorm: false, rope: { base: 10000, scaling: null, style: 'half' }, act: 'silu_mul', bias: false, tiedEmbeddings: false, repo: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0' },
  'smollm2-135m': { family: 'llama', layers: 30, hidden: 576, heads: 9, kvHeads: 3, headDim: 64, ffn: 1536, vocab: 49152, eps: 1e-5, qkNorm: false, rope: { base: 100000, scaling: null, style: 'half' }, act: 'silu_mul', bias: false, tiedEmbeddings: true, repo: 'HuggingFaceTB/SmolLM2-135M-Instruct' },
  'llama-3.2-1b': { family: 'llama', layers: 16, hidden: 2048, heads: 32, kvHeads: 8, headDim: 64, ffn: 8192, vocab: 128256, eps: 1e-5, qkNorm: false, rope: { base: 500000, scaling: { type: 'llama3', factor: 32, lowFreqFactor: 1, highFreqFactor: 4, originalMaxPos: 8192 }, style: 'half' }, act: 'silu_mul', bias: false, tiedEmbeddings: true, repo: 'onnx-community/Llama-3.2-1B-Instruct-ONNX' },
  'qwen3-0.6b': { family: 'qwen3', layers: 28, hidden: 1024, heads: 16, kvHeads: 8, headDim: 128, ffn: 3072, vocab: 151936, eps: 1e-6, qkNorm: true, rope: { base: 1000000, scaling: null, style: 'half' }, act: 'silu_mul', bias: false, tiedEmbeddings: true, repo: 'onnx-community/Qwen3-0.6B-ONNX' },
};
check('描述表數字與 config.json 逐項相同（qwen2、tinyllama、smollm2、llama3.2-1b、qwen3）', () => {
  for (const name of Object.keys(CONFIG)) {
    const want = CONFIG[name], d = A.FAMILIES[name];
    assert.ok(d, name + ' 沒有描述');
    assert.strictEqual(d.status, 'supported', name + ' 應為 supported');
    assert.strictEqual(d.verified, true, name + ' 應已對照 config');
    assert.ok(String(d.verifiedFrom || '').indexOf(want.repo) >= 0, name + ' 的 verifiedFrom 應寫出 repo');
    for (const k of ['family', 'layers', 'hidden', 'heads', 'kvHeads', 'headDim', 'ffn', 'vocab', 'eps', 'qkNorm', 'act', 'bias', 'tiedEmbeddings']) {
      assert.strictEqual(d[k], want[k], name + '.' + k);
    }
    assert.strictEqual(d.rope.base, want.rope.base, name + '.rope.base');
    assert.deepStrictEqual(d.rope.scaling, want.rope.scaling, name + '.rope.scaling');
    assert.strictEqual(d.rope.style, want.rope.style, name + '.rope.style');
  }
});
check('Qwen2-0.5B 的數字已修正（先前寫成 1024／16／16／2816，與 config 不符）', () => {
  const d = A.FAMILIES['qwen2-0.5b'];
  assert.strictEqual(d.hidden, 896); assert.strictEqual(d.heads, 14); assert.strictEqual(d.kvHeads, 2); assert.strictEqual(d.ffn, 4864); assert.strictEqual(d.vocab, 151936);
});
check('Gemma／Phi 仍只標待驗證，不宣稱支援，也沒有路由到骨架', () => {
  for (const name of ['gemma', 'phi']) { assert.strictEqual(A.FAMILIES[name].status, 'pending'); assert.strictEqual(A.isSupported(name), false); }
  assert.strictEqual(A.routeFor('gemma-2b', { webgpu: true }).path, 'onnx');
  assert.strictEqual(A.routeFor('phi-3-mini', { webgpu: true }).path, 'onnx');
});
check('每個 supported 描述都有 idPattern，且能通過驗證', () => {
  for (const name of Object.keys(A.FAMILIES)) {
    const d = A.FAMILIES[name];
    if (d.status !== 'supported') continue;
    assert.ok(d.idPattern instanceof RegExp, name + ' 缺 idPattern');
    assert.ok(A.validateArch(d).ok, name + ' 驗證失敗：' + A.validateArch(d).errors.join('；'));
  }
});

// ---------- 2. llama3 RoPE 縮放 ----------
const L3 = { type: 'llama3', factor: 32, lowFreqFactor: 1, highFreqFactor: 4, originalMaxPos: 8192 };
check('validateArch：llama3 縮放缺欄位時擋下；未知縮放型別擋下', () => {
  const d = A.archFor('llama-3.2-1b'); delete d.rope.scaling.highFreqFactor;
  assert.ok(!A.validateArch(d).ok);
  const e = A.archFor('llama-3.2-1b'); e.rope.scaling = { type: 'yarn', factor: 4 };
  assert.ok(!A.validateArch(e).ok);
});
check('invFreq：無縮放時 base^(−2i/hd)；llama3：最高頻不變、最低頻除以 factor、中間各段落在兩者之間', () => {
  const hd = 64, base = 500000;
  const plain = S.invFreq(hd, base, null);
  for (let i = 0; i < hd / 2; i++) assert.ok(Math.abs(plain[i] - Math.pow(base, -2 * i / hd)) < 1e-15 * Math.max(1, plain[i]), 'plain ' + i);
  const sc = S.invFreq(hd, base, L3);
  assert.strictEqual(sc[0], 1, '最高頻應不變（wavelen 6.28 < 2048）');
  const last = hd / 2 - 1;
  assert.ok(Math.abs(sc[last] - plain[last] / 32) < 1e-12 * plain[last], '最低頻應為 f/32');
  for (let i = 0; i < hd / 2; i++) assert.ok(sc[i] <= plain[i] * (1 + 1e-12) && sc[i] >= plain[i] / 32 * (1 - 1e-12), 'i=' + i + ' 應在 [f/32, f]');
});
check('invFreq：不支援的縮放型別丟錯（不悄悄當作無縮放）', () => {
  assert.throws(() => S.invFreq(64, 10000, { type: 'yarn', factor: 4 }), /RoPE 縮放/);
});

function rng(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return ((s >>> 0) / 4294967296) - 0.5; }; }
function tinyLlama3(scaling) {
  const r = rng(11), H = 16, nh = 2, nkv = 1, hd = 8, F = 12, V = 7, Lyr = 2;
  const arr = (n) => Float32Array.from({ length: n }, () => r() * 0.5);
  const arch = { family: 'llama', status: 'supported', verified: false, layers: Lyr, hidden: H, heads: nh, kvHeads: nkv, headDim: hd, ffn: F,
    norm: 'rmsnorm', eps: 1e-5, qkNorm: false, rope: { base: 500000, scaling: scaling, style: 'half' }, act: 'silu_mul', bias: false, tiedEmbeddings: true, vocab: V, quant: ['f32'] };
  const w = { embed: arr(V * H), finalNorm: arr(H).map((v) => 1 + v), layers: [] };
  for (let i = 0; i < Lyr; i++) w.layers.push({ attnNorm: arr(H).map((v) => 1 + v), wq: arr(nh * hd * H), wk: arr(nkv * hd * H), wv: arr(nkv * hd * H), wo: arr(H * nh * hd), ffnNorm: arr(H).map((v) => 1 + v), wGate: arr(F * H), wUp: arr(F * H), wDown: arr(H * F) });
  return { arch, w };
}
check('骨架：llama3 縮放能跑（先前丟錯），輸出有限，且與無縮放不同', () => {
  const a = tinyLlama3(L3), b = tinyLlama3(null);
  const la = S.run(a.arch, a.w, [1, 3, 0]).logits, lb = S.run(b.arch, b.w, [1, 3, 0]).logits;
  for (const v of la) assert.ok(Number.isFinite(v));
  let diff = 0; for (let i = 0; i < la.length; i++) diff = Math.max(diff, Math.abs(la[i] - lb[i]));
  assert.ok(diff > 0, '縮放應改變輸出');
});
async function gpuSame() {
  const a = tinyLlama3(L3);
  const cpuMv = async (W, rows, cols, x) => S.matvec(W, rows, cols, x);
  const got = await G.runGpu(a.arch, a.w, [1, 3, 0], cpuMv);
  const want = S.run(a.arch, a.w, [1, 3, 0]).logits;
  assert.deepStrictEqual(Array.from(got.logits), Array.from(want), 'GPU 替身與 CPU 參考應逐位相同');
}

// ---------- 3. 路由 ----------
check('familyFor：依 idPattern 找描述；沒有描述的尺寸回 null', () => {
  assert.strictEqual(A.familyFor('qwen3-4b'), 'qwen3');
  assert.strictEqual(A.familyFor('qwen3-1.7b'), 'qwen3');
  assert.strictEqual(A.familyFor('llama-3.2-1b'), 'llama');
  assert.strictEqual(A.familyFor('smollm2-135m'), 'llama');
  assert.strictEqual(A.familyFor('smollm2-360m'), null);
  assert.strictEqual(A.familyFor('gemma-2b'), null);
  assert.strictEqual(A.familyFor(''), null);
});
check('routeFor：Qwen3 走既有 qwen_gpu 路徑；其他支援的族走通用骨架；不支援的退回 ONNX', () => {
  const gpu = { webgpu: true };
  assert.strictEqual(A.routeFor('qwen3-0.6b', gpu).path, 'qwen_gpu');
  assert.strictEqual(A.routeFor('qwen3-1.7b', gpu).path, 'qwen_gpu');
  assert.strictEqual(A.routeFor('llama-3.2-1b', gpu).path, 'generic');
  assert.strictEqual(A.routeFor('tinyllama-1.1b', gpu).path, 'generic');
  assert.strictEqual(A.routeFor('qwen2-0.5b', gpu).path, 'generic');
  const r = A.routeFor('smollm2-360m', gpu); assert.strictEqual(r.path, 'onnx'); assert.ok(/沒有描述表/.test(r.reason));
  const g = A.routeFor('gemma-2b', gpu); assert.strictEqual(g.path, 'onnx'); assert.ok(/pending|待驗證/.test(g.reason));
});
check('routeFor：沒有 WebGPU 一律退回 ONNX（不因為描述表存在就算錯）', () => {
  assert.strictEqual(A.routeFor('llama-3.2-1b', { webgpu: false }).path, 'onnx');
  assert.strictEqual(A.routeFor('qwen3-0.6b', { webgpu: false }).path, 'onnx');
  assert.strictEqual(A.routeFor('llama-3.2-1b', null).path, 'onnx');
});
check('routeFor：骨架不支援的結構（未知縮放、GELU）退回 ONNX，並寫明原因', () => {
  const t = structuredClone(A.FAMILIES);
  t['llama-3.2-1b'].rope.scaling = { type: 'yarn', factor: 4 };
  const a = A.routeFor('llama-3.2-1b', { webgpu: true }, t);
  assert.strictEqual(a.path, 'onnx'); assert.ok(/RoPE|縮放/.test(a.reason), a.reason);
  const u = structuredClone(A.FAMILIES);
  u['tinyllama-1.1b'].act = 'gelu';
  const b = A.routeFor('tinyllama-1.1b', { webgpu: true }, u);
  assert.strictEqual(b.path, 'onnx'); assert.ok(/gelu|啟動/.test(b.reason), b.reason);
});

// ---------- 4. qwen_models ----------
check('modelOf：Qwen3 照舊（與 get 相同）；Llama 3.2 1B 在模型清單，但 get 仍只回 Qwen GPU 表（不改 UI 行為）', () => {
  assert.strictEqual(M.modelOf('qwen3-0.6b'), M.get('qwen3-0.6b'));
  assert.strictEqual(M.get('llama-3.2-1b'), null);
  const l = M.modelOf('llama-3.2-1b');
  assert.ok(l, '應有 llama-3.2-1b');
  assert.strictEqual(l.family, 'llama');
  assert.strictEqual(l.repo, 'onnx-community/Llama-3.2-1B-Instruct-ONNX');
  assert.strictEqual(l.file.rel, 'onnx/model_quantized.onnx');
  assert.strictEqual(l.file.bytes, 1236653951);
  assert.strictEqual(l.file.sha256, 'ad53ed44994c27ab60e8024e83fcd83ce38db4d4ad3a28549b432480eb84d180');
  assert.strictEqual(l.tokenizer.bytes, 11574638);
  assert.strictEqual(l.tokenizer.sha256, '3a223ade375cc1d13b04e897ce1d36a04f50140e1ba3d107021ea68d4b5e614c');
  assert.strictEqual(l.verifiedSha, false, 'sha 來自 LFS 標頭，尚未下載核對，不能標成已核對');
  assert.deepStrictEqual(l.shape, { D: 2048, H: 32, Hkv: 8, I: 8192, L: 16, V: 128256, hd: 64 });
  assert.strictEqual(M.modelOf('nope'), null);
});
check('isFamily：依描述表判斷（qwen3-4b、llama-3.2-1b 為真；smollm2-360m、gemma-2b 為假）', () => {
  assert.strictEqual(M.isFamily('qwen3-4b'), true);
  assert.strictEqual(M.isFamily('qwen3-1.7b'), true);
  assert.strictEqual(M.isFamily('llama-3.2-1b'), true);
  assert.strictEqual(M.isFamily('smollm2-360m'), false);
  assert.strictEqual(M.isFamily('gemma-2b'), false);
});
check('shapeW：支援 hd（Llama 3.2 的 hd=64，不再寫死 128）', () => {
  const W = M.shapeW(M.modelOf('llama-3.2-1b').shape, 'q8');
  assert.strictEqual(W.hd, 64);
  assert.strictEqual(W.layers[0].q.W.length, 2048 * (32 * 64));
  assert.strictEqual(W.layers[0].k.W.length, 2048 * (8 * 64));
  const Q = M.shapeW(M.get('qwen3-0.6b').shape, 'q8');
  assert.strictEqual(Q.hd, 128, 'Qwen3 仍是 128');
});

checkAsync('骨架 llama3 縮放：GPU 替身與 CPU 參考逐位相同', gpuSame).then(() => {
  console.log(passes + ' 項通過');
}, (e) => { console.error('FAIL ' + e.message); process.exit(1); });
