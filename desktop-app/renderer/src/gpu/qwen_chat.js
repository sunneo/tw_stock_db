// Qwen3 q8 整段 GPU 解碼的「聊天生成迴圈」（DESIGN.webgpu-cuda.md §7.23）：產品的一般離線聊天（_llmGenerateInner）用。
// 引擎（qwen_gpu.createGpuEngine）只負責一步；這裡補上聊天需要的部分：提示切塊預填、取樣（重複懲罰、n-gram、溫度、top-p，語意與原生子程序
// 的 nr-gen-params.js 同一份程式）、結束詞元、逐步輸出文字、取消、逾時。貪婪（do_sample:false 且沒有任何懲罰）時只讀回 argmax 詞元；
// 其餘情況讀回 logits 在主機端取樣（每詞元約 600 KB 回讀）。任何 GPU 錯誤由 generate 丟出，呼叫端退回原路徑。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./nr_gen_params.js'));
  else root.FaQwenChat = factory(root.FaNrGenParams);
})(typeof self !== 'undefined' ? self : this, function (GP) {
  'use strict';
  const EOS = [151645, 151643];
  // 清理輸出：與 nr-engine.js 的 cleanText 相同（遇到對話結束標記就截斷）
  const cleanText = (tok, ids) => tok.decode(ids).replace(/<\|im_end\|>[\s\S]*$/, '').replace(/<\|endoftext\|>[\s\S]*$/, '');
  // gen 是否只需要 argmax（貪婪，且沒有會改變排序的懲罰）：true 時不必讀回 logits
  function isPureGreedy(gen) {
    if (!gen) return true;
    return gen.do_sample === false && !(gen.repetition_penalty != null && gen.repetition_penalty !== 1) && !(gen.no_repeat_ngram_size > 1);
  }
  const withTimeout = (p, ms, what) => !(ms > 0) ? p : new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(what + '逾時（' + ms + ' 毫秒）')), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
  // 能不能走 GPU 解碼：回傳 {ok, why}。引擎上限：提示＋新詞元要放得進 KV（maxT）
  function canRun(engine, promptLen, maxNew) {
    if (!engine || typeof engine.step !== 'function') return { ok: false, why: 'GPU 引擎沒有準備好' };
    const maxT = engine.maxT || 0;
    if (maxT && promptLen + maxNew > maxT) return { ok: false, why: '上下文太長：提示 ' + promptLen + ' ＋生成 ' + maxNew + ' 超過 GPU 引擎的 KV 上限 ' + maxT };
    return { ok: true, why: '' };
  }
  // opts: { engine, tok（encode/decode）, promptIds, maxNew, gen（textGenParams 的結果）, seed, eosIds, onText(增量文字), isCancelled(), stepTimeoutMs }
  // 回傳 { text, ids, finish_reason, gpu:{ steps, sampled, prefillMs, decodeMs } }
  async function generate(o) {
    const eng = o.engine, tok = o.tok, gen = GP.validateGen(Object.assign({}, o.gen || { do_sample: false }));
    const eos = o.eosIds || EOS, maxNew = Math.max(1, o.maxNew || 512), promptIds = o.promptIds;
    if (!promptIds || !promptIds.length) throw new Error('提示是空的');
    const chk = canRun(eng, promptIds.length, maxNew); if (!chk.ok) throw new Error(chk.why);
    const pure = isPureGreedy(gen), rng = gen.do_sample === false ? null : GP.makeRng(o.seed != null ? o.seed : 1);
    const chunk = Math.max(1, eng.maxM || 64), to = o.stepTimeoutMs === undefined ? 20000 : o.stepTimeoutMs;
    const diag = { steps: 0, sampled: !pure, prefillMs: 0, decodeMs: 0 };
    const now = () => Date.now();
    eng.reset();
    let r = null; const t0 = now();
    for (let i = 0; i < promptIds.length; i += chunk) {
      const part = promptIds.slice(i, i + chunk), last = i + chunk >= promptIds.length;
      r = await withTimeout(Promise.resolve().then(() => eng.step(part, { logits: !pure && last })), to > 0 ? to + part.length * 1000 : 0, 'GPU 預填 ');
    }
    diag.prefillMs = now() - t0;
    const out = []; let emitted = 0, finish = 'length';
    for (let s = 0; s < maxNew; s++) {
      if (o.isCancelled && o.isCancelled()) return { cancelled: true, text: '', ids: out, finish_reason: 'cancelled', gpu: diag };
      let next;
      if (pure) next = r.token;
      else { if (!r.logits) throw new Error('GPU 引擎沒有回傳 logits'); next = GP.pickToken(Float32Array.from(r.logits), promptIds, out, gen, rng); }
      out.push(next);
      if (o.onText) { const full = cleanText(tok, out); if (full.length > emitted && !/�$/.test(full)) { o.onText(full.slice(emitted), full); emitted = full.length; } }
      if (eos.indexOf(next) >= 0) { finish = 'stop'; break; }
      if (s === maxNew - 1) break;
      const t1 = now();
      r = await withTimeout(Promise.resolve().then(() => eng.step([next], { logits: !pure })), to, 'GPU 解碼 ');
      diag.decodeMs += now() - t1; diag.steps++;
    }
    return { cancelled: false, text: cleanText(tok, out), ids: out, finish_reason: finish, gpu: diag };
  }
  // 大檔（617 MB 的 q8 模型）讀進 Uint8Array：rawfs.readFile 一次 base64 會超過字串上限，所以先 copyChunked 成每段 partBytes 的暫存檔、逐段讀、拼起來、最後刪暫存。
  // raw：{ copyChunked(src, dstPrefix, partBytes)→{size,parts:[{name}]}, readFile(path,'base64')→{base64}, remove(path,recursive) }
  async function readLargeFile(raw, src, partsDir, sep, partBytes) {
    const cp = await raw.copyChunked(src, partsDir + sep + 'm-', partBytes);
    const bytes = new Uint8Array(cp.size); let off = 0;
    try {
      for (const pt of cp.parts) {
        const r = await raw.readFile(partsDir + sep + pt.name, 'base64'); const bin = atob(r.base64);
        if (off + bin.length > bytes.length) throw new Error('分段總和超過檔案大小');
        for (let i = 0; i < bin.length; i++) bytes[off + i] = bin.charCodeAt(i);
        off += bin.length;
      }
    } finally { try { await raw.remove(partsDir, true); } catch (_) { /* 暫存殘留下次覆蓋 */ } }
    if (off !== cp.size) throw new Error('讀入的大小不符（' + off + '／' + cp.size + '）');
    return bytes;
  }
  return { EOS, cleanText, isPureGreedy, canRun, generate, readLargeFile };
});
