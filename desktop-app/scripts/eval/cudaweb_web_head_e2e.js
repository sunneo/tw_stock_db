'use strict';
// 網頁版 greedyGenerate 的隱藏狀態頭：端到端（真 onnxruntime-node＋真 Qwen3-0.6B q8 模型，CPU）。
// 頭的 run() 用 CPU 參考版 q8lmRef 代替 GPU（GPU 與參考版的一致性另由 cudaweb_head_gl_browser.js、cudaweb_infer_browser.js 驗證）。
// 驗證：(1) 頭正常 → 詞元與原路徑相同；(2) 第 3 步起丟錯 → 自動退回，詞元相同；(3) 頭回傳錯誤的 logits → 第 0 步對拍不合，退回，詞元相同；
//      (4) 頭逾時 → 退回，詞元相同。診斷資訊（用了幾步、退回在哪一步、原因、對拍結果）逐項檢查。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_web_head_e2e.js
const fs = require('fs'), path = require('path');
const ort = require(path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const LLM = require('../../renderer/src/studio/llm_web_core.js');
const HS = require('../../renderer/src/gpu/head_service.js');
const OPS = require('../../renderer/src/gpu/infer_ops.js');
const base = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8');
const modelBytes = new Uint8Array(fs.readFileSync(path.join(base, 'onnx', 'model_quantized.onnx')));
const tokj = JSON.parse(fs.readFileSync(path.join(base, 'tokenizer.json'), 'utf8'));
const MAXNEW = 8;
(async () => {
  const t0 = Date.now();
  const lm = HS.extractLmHead(modelBytes);
  const variant = HS.buildVariant(modelBytes, 1024);
  const buildMs = Date.now() - t0;
  const sess = await ort.InferenceSession.create(modelBytes, { executionProviders: ['cpu'] });
  const vsess = await ort.InferenceSession.create(variant.bytes, { executionProviders: ['cpu'] });
  const tok = LLM.createTokenizer(tokj);
  const eosIds = (tokj.added_tokens || []).filter((t) => ['<|im_end|>', '<|endoftext|>'].indexOf(t.content) >= 0).map((t) => t.id);
  const ids = tok.encode('用一句話介紹台北。');
  const cpuRun = async (hidden) => OPS.q8lmRef(hidden, lm.W, lm.meta.zp, lm.meta.V, lm.meta.K, lm.meta.scale);
  const gen = (head) => LLM.greedyGenerate(ort, sess, ids, { maxNew: MAXNEW, eosIds, layers: 28, kvHeads: 8, headDim: 128, head: head ? Object.assign({ variant: vsess, hiddenName: variant.hiddenName, vocab: lm.meta.V }, head) : undefined });
  const cases = [];
  const ref = await gen(null);
  cases.push({ name: '原路徑', tokens: ref.tokens, head: ref.head });
  // (1) 頭正常
  const a = await gen({ run: cpuRun });
  cases.push({ name: '頭正常', tokens: a.tokens, head: a.head });
  // (2) 第 3 步起丟錯
  let n2 = 0;
  const b = await gen({ run: async (h) => { if (n2++ >= 3) throw new Error('模擬 GPU 失效'); return cpuRun(h); } });
  cases.push({ name: '第 3 步起失敗', tokens: b.tokens, head: b.head });
  // (3) 錯誤的 logits（縮放 2 倍）→ 第 0 步對拍不合
  const c = await gen({ run: async (h) => (await cpuRun(h)).map((x) => x * 2) });
  cases.push({ name: '結果不合', tokens: c.tokens, head: c.head });
  // (4) 逾時
  const d = await gen({ timeoutMs: 300, run: () => new Promise(() => {}) });
  cases.push({ name: '逾時', tokens: d.tokens, head: d.head });
  const same = (x) => JSON.stringify(x.tokens) === JSON.stringify(ref.tokens);
  const checks = [
    { name: '頭正常：詞元與原路徑相同，全部步驟走頭', pass: same(a) && a.head.used === a.head.steps && a.head.fallbackAt === -1 && a.head.verify.length === 1 && a.head.verify[0].argmaxSame && a.head.verify[0].maxRel < 1e-3 },
    { name: '第 3 步起失敗：詞元相同，退回位置為第 3 步', pass: same(b) && b.head.fallbackAt === 3 && b.head.used === 3 && /GPU lm_head 失敗/.test(b.head.reason) },
    { name: '結果不合：對拍失敗、詞元相同、退回位置為第 0 步', pass: same(c) && c.head.fallbackAt === 0 && c.head.used === 0 && /結果不合/.test(c.head.reason) },
    { name: '逾時：詞元相同、原因寫明逾時', pass: same(d) && d.head.fallbackAt === 0 && /逾時/.test(d.head.reason) },
  ];
  const out = { buildMs, variantRemovedNodes: variant.removed, maxNew: MAXNEW, refText: tok.decode(ref.tokens), cases: cases, checks: checks, pass: checks.every((x) => x.pass) };
  fs.writeFileSync(path.join(__dirname, 'cudaweb_web_head_e2e.result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ pass: out.pass, checks: checks.map((x) => [x.name, x.pass]), heads: cases.map((x) => [x.name, x.head.used, x.head.fallbackAt, x.head.reason.slice(0, 60)]) }, null, 1));
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
