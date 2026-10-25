// MOSS-TTS-Nano 的推論 worker（module worker；執行時會在最前面接上 moss_core.js 的內容，所以這裡直接用全域的 FaMossTts）。
// 訊息：
//   { type:'init', jobId, ortUrl, wasmBase, threads, files:{ 檔名: blob 網址 }, manifestText, tokenizerBytes }
//   { type:'generate', jobId, text, codes|null, seed, maxFrames }   → progress {frames}… → result { audio: Float32Array（單聲道 48kHz）, frames, stopped }
//   { type:'encode', jobId, mono, rate }                             → result { codes: Int32Array(T*16), frames }
//   { type:'cancel', jobId }、{ type:'dispose', jobId }
// 回：{ jobId, type:'progress', message } 多次，最後 { jobId, type:'result', ok, ... } 或 { ok:false, error }。
let ort = null, M = self.FaMossTts, manifest = null, tokModel = null, files = null, ttsMeta = null, codecMeta = null;
const sessions = {}; let cancelled = new Set();
const post = (jobId, type, extra) => self.postMessage(Object.assign({ jobId, type }, extra || {}));

async function getSession(key, graph, externals) {
  if (sessions[key]) return sessions[key];
  const url = files[graph]; if (!url) throw new Error('缺少模型檔 ' + graph);
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  if (externals && externals.length) opts.externalData = externals.map((p) => ({ path: p, data: files[p] }));
  sessions[key] = await ort.InferenceSession.create(url, opts);
  return sessions[key];
}
const ttsExt = (g) => (ttsMeta.external_data_files && ttsMeta.external_data_files[g]) || [];
const codecExt = (g) => (codecMeta.external_data_files && codecMeta.external_data_files[g]) || [];
const T = (type, data, dims) => new ort.Tensor(type, data, dims);

async function loadMeta(d) {
  manifest = JSON.parse(d.manifestText); tokModel = M.parseModel(new Uint8Array(d.tokenizerBytes));
  ttsMeta = JSON.parse(d.ttsMetaText); codecMeta = JSON.parse(d.codecMetaText);
}
async function codecDecode(frames, count, jobId) {
  const s = await getSession('codecDecode', codecMeta.files.decode_full || 'moss_audio_tokenizer_decode_full.onnx', codecExt(codecMeta.files.decode_full || 'moss_audio_tokenizer_decode_full.onnx'));
  const out = await s.run({ audio_codes: T('int32', frames, [1, count, M.NQ]), audio_code_lengths: T('int32', new Int32Array([count]), [1]) });
  const a = out.audio, dims = a.dims, L = Number(out.audio_lengths.data[0]) || dims[2], ch = dims[1], data = a.data;
  const mono = new Float32Array(L); // [1, ch, Ltotal]：多聲道平均成單聲道
  for (let i = 0; i < L; i++) { let sum = 0; for (let c = 0; c < ch; c++) sum += data[c * dims[2] + i]; mono[i] = sum / ch; }
  return mono;
}
async function codecEncode(mono, rate) {
  const s = await getSession('codecEncode', codecMeta.files.encode || 'moss_audio_tokenizer_encode.onnx', codecExt(codecMeta.files.encode || 'moss_audio_tokenizer_encode.onnx'));
  const w = M.toCodecInput(mono, rate), out = await s.run({ waveform: T('float32', w.data, [1, 2, w.length]), input_lengths: T('int32', new Int32Array([w.length]), [1]) });
  const n = Number(out.audio_code_lengths.data[0]) || out.audio_codes.dims[1], all = out.audio_codes.data, codes = new Int32Array(n * M.NQ); codes.set(all.subarray(0, n * M.NQ));
  return { codes, frames: n };
}
function makeRunners(prefillS, decodeS, sampleS) {
  const pn = ttsMeta.onnx.prefill_output_names, dn = ttsMeta.onnx.decode_output_names;
  const lastHidden = (t) => { const d = t.data, rows = t.dims[1], h = t.dims[2]; return Float32Array.from(d.subarray((rows - 1) * h, rows * h)); };
  return {
    prefill: async (ids, rows) => {
      const o = await prefillS.run({ input_ids: T('int32', ids, [1, rows, M.ROW]), attention_mask: T('int32', new Int32Array(rows).fill(1), [1, rows]) });
      const past = []; for (let i = 0; i < M.LAYERS; i++) { past.push(o['present_key_' + i], o['present_value_' + i]); }
      return { hidden: lastHidden(o[pn[0]]), past };
    },
    decode: async (row, len, past) => {
      const feeds = { input_ids: T('int32', row, [1, 1, M.ROW]), past_valid_lengths: T('int32', new Int32Array([len]), [1]) };
      for (let i = 0; i < M.LAYERS; i++) { feeds['past_key_' + i] = past[2 * i]; feeds['past_value_' + i] = past[2 * i + 1]; }
      const o = await decodeS.run(feeds), next = []; for (let i = 0; i < M.LAYERS; i++) { next.push(o['present_key_' + i], o['present_value_' + i]); }
      return { hidden: lastHidden(o[dn[0]]), past: next };
    },
    sample: async (hidden, seen, u1, u2) => {
      const o = await sampleS.run({ global_hidden: T('float32', hidden, [1, M.HIDDEN]), repetition_seen_mask: T('int32', seen, [1, M.NQ, M.CODEBOOK]), assistant_random_u: T('float32', u1, [1]), audio_random_u: T('float32', u2, [1, M.NQ]) });
      return { cont: Number(o.should_continue.data[0]) !== 0, frame: Int32Array.from(o.frame_token_ids.data) };
    },
  };
}

self.onmessage = async (e) => {
  const d = e.data || {}, jobId = d.jobId;
  try {
    if (d.type === 'cancel') { cancelled.add(jobId); return; }
    if (d.type === 'dispose') { for (const k of Object.keys(sessions)) { try { await sessions[k].release(); } catch (_) { /* */ } delete sessions[k]; } post(jobId, 'result', { ok: true }); return; }
    if (d.type === 'init') {
      if (!ort) ort = await import(d.ortUrl);
      ort.env.wasm.wasmPaths = d.wasmBase; ort.env.wasm.numThreads = d.threads || 1; ort.env.wasm.proxy = false;
      files = d.files; await loadMeta(d); post(jobId, 'result', { ok: true }); return;
    }
    if (d.type === 'encode') { post(jobId, 'progress', { message: '分析參考聲音…' }); const r = await codecEncode(d.mono, d.rate); post(jobId, 'result', { ok: true, codes: r.codes, frames: r.frames }, undefined); return; }
    if (d.type === 'generate') {
      const cfg = manifest.tts_config, tpl = manifest.prompt_templates, ids = M.encode(tokModel, d.text);
      if (!ids.length) { post(jobId, 'result', { ok: false, error: '這段文字切不出可以念的內容' }); return; }
      const codes = d.codes && d.codes.length ? M.trimPromptCodes(d.codes, d.maxPromptFrames || 250) : null, prompt = M.buildPrompt(cfg, tpl, codes, ids);
      post(jobId, 'progress', { message: '載入語言模型（第一次較慢）…' });
      const prefillS = await getSession('prefill', ttsMeta.files.prefill, ttsExt(ttsMeta.files.prefill));
      const decodeS = await getSession('decode', ttsMeta.files.decode_step, ttsExt(ttsMeta.files.decode_step));
      const sampleS = await getSession('sample', ttsMeta.files.local_fixed_sampled_frame, ttsExt(ttsMeta.files.local_fixed_sampled_frame));
      post(jobId, 'progress', { message: '合成中…' });
      const g = await M.generate(makeRunners(prefillS, decodeS, sampleS), cfg, prompt, { maxFrames: d.maxFrames || 375, seed: d.seed, isCancelled: () => cancelled.has(jobId), onFrame: (n) => { if (n % 4 === 0) post(jobId, 'progress', { frames: n, message: '合成中… 已生成 ' + (n / M.FRAME_RATE).toFixed(1) + ' 秒' }); } });
      cancelled.delete(jobId);
      if (g.stopped === 'cancel') { post(jobId, 'result', { ok: false, error: '已取消' }); return; }
      if (!g.count) { post(jobId, 'result', { ok: false, error: '模型沒有產生任何聲音（文字可能太短或無法念出）' }); return; }
      post(jobId, 'progress', { message: '轉成聲音…' });
      const mono = await codecDecode(g.frames, g.count, jobId);
      self.postMessage({ jobId, type: 'result', ok: true, audio: mono, frames: g.count, stopped: g.stopped }, [mono.buffer]);
      return;
    }
    post(jobId, 'result', { ok: false, error: '未知的 job 類型：' + d.type });
  } catch (err) { post(jobId, 'result', { ok: false, error: String((err && err.message) || err) }); }
};
