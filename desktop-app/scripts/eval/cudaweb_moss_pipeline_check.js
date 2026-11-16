'use strict';
// MOSS-TTS-Nano 整條 CPU 管線（cudaweb 參考版）對真 ORT 比對：
//   預填（逐列跑全域解碼一步，取代 moss_tts_prefill.onnx）→ 生成迴圈（沿用 tts/moss_core.js 的 generate）→ 取樣（moss_sampling.js）→ codec（onnx_interp.js）。
// 同一個 seed 下，兩邊的音訊幀必須完全一致，codec 音訊的相對誤差要夠小。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_moss_pipeline_check.js <MOSS 資料夾> <文字> <最多幀數> [ref 輸出 json]
// ref 輸出 json 會寫入 ORT 的提示列與幀，給瀏覽器的 GPU 驗證頁當比對目標（cudaweb_moss_pipeline_gpu_check.js）。
const fs = require('fs'), path = require('path');
const M = require('../../renderer/src/tts/moss_core.js');
const MG = require('../../renderer/src/gpu/moss_decoder.js');
const ML = require('../../renderer/src/gpu/moss_local.js');
const MS = require('../../renderer/src/gpu/moss_sampling.js');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const OI = require('../../renderer/src/gpu/onnx_interp.js');

const dir = process.argv[2];
const text = process.argv[3] || '你好';
const maxFrames = Number(process.argv[4] || 6);
if (!dir) { console.error('用法：... cudaweb_moss_pipeline_check.js <MOSS 資料夾> [文字] [最多幀數]'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const P = (n) => path.join(dir, n);
const readBuf = (n) => { const b = fs.readFileSync(P(n)); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
const now = () => Date.now();

(async () => {
  const manifest = JSON.parse(fs.readFileSync(P('browser_poc_manifest.json'), 'utf8'));
  const ttsMeta = JSON.parse(fs.readFileSync(P('tts_browser_onnx_meta.json'), 'utf8'));
  const codecMeta = JSON.parse(fs.readFileSync(P('codec_browser_onnx_meta.json'), 'utf8'));
  const tok = M.parseModel(readBuf('tokenizer.model'));
  const cfg = manifest.tts_config, tpl = manifest.prompt_templates;
  const ids = M.encode(tok, text);
  const prompt = M.buildPrompt(cfg, tpl, null, ids);
  console.log('文字詞元', ids.length, '提示列數', prompt.rows);

  // ---- ORT 參考 ----
  const globalData = readBuf('moss_tts_global_shared.data'), localData = readBuf('moss_tts_local_shared.data'), codecData = readBuf('moss_audio_tokenizer_decode_shared.data');
  const gFiles = { 'moss_tts_global_shared.data': globalData }, lFiles = { 'moss_tts_local_shared.data': localData };
  const opt = () => ({ executionProviders: ['cpu'] });
  const oPrefill = await ort.InferenceSession.create(P('moss_tts_prefill.onnx'), opt());
  const oDecode = await ort.InferenceSession.create(P('moss_tts_decode_step.onnx'), opt());
  const oSample = await ort.InferenceSession.create(P('moss_tts_local_fixed_sampled_frame.onnx'), opt());
  const pn = ttsMeta.onnx.prefill_output_names, dn = ttsMeta.onnx.decode_output_names;
  const lastHidden = (t) => { const d = t.data, rows = t.dims[1], h = t.dims[2]; return Float32Array.from(d.subarray((rows - 1) * h, rows * h)); };
  const T = (type, data, dims) => new ort.Tensor(type, data, dims);
  const ortRunners = {
    prefill: async (ids2, rows) => {
      const o = await oPrefill.run({ input_ids: T('int32', ids2, [1, rows, M.ROW]), attention_mask: T('int32', new Int32Array(rows).fill(1), [1, rows]) });
      const past = []; for (let i = 0; i < M.LAYERS; i++) past.push(o['present_key_' + i], o['present_value_' + i]);
      return { hidden: lastHidden(o[pn[0]]), past };
    },
    decode: async (row, len, past) => {
      const feeds = { input_ids: T('int32', row, [1, 1, M.ROW]), past_valid_lengths: T('int32', new Int32Array([len]), [1]) };
      for (let i = 0; i < M.LAYERS; i++) { feeds['past_key_' + i] = past[2 * i]; feeds['past_value_' + i] = past[2 * i + 1]; }
      const o = await oDecode.run(feeds), next = [];
      for (let i = 0; i < M.LAYERS; i++) next.push(o['present_key_' + i], o['present_value_' + i]);
      return { hidden: lastHidden(o[dn[0]]), past: next };
    },
    sample: async (hidden, seen, u1, u2) => {
      const o = await oSample.run({ global_hidden: T('float32', hidden, [1, M.HIDDEN]), repetition_seen_mask: T('int32', seen, [1, M.NQ, M.CODEBOOK]), assistant_random_u: T('float32', u1, [1]), audio_random_u: T('float32', u2, [1, M.NQ]) });
      return { cont: Number(o.should_continue.data[0]) !== 0, frame: Int32Array.from(o.frame_token_ids.data) };
    },
  };

  // ---- cudaweb CPU 參考 ----
  const gModel = MG.loadMossDecodeStep(readBuf('moss_tts_decode_step.onnx'), gFiles);
  const lModel = ML.loadMossLocal(readBuf('moss_tts_local_decoder.onnx'), lFiles);
  const cwRunners = {
    prefill: async (ids2, rows) => {
      let caches = null, hidden = null;
      for (let r = 0; r < rows; r++) {
        const row = ids2.subarray(r * M.ROW, (r + 1) * M.ROW);
        const out = await MG.decodeStep(gModel, row, caches);
        caches = out.caches; hidden = out.hidden;
      }
      return { hidden: hidden, past: caches };
    },
    decode: async (row, len, past) => {
      const out = await MG.decodeStep(gModel, row, past);
      return { hidden: out.hidden, past: out.caches };
    },
    sample: async (hidden, seen, u1, u2) => {
      const s = await MS.sampleFrame(lModel, hidden, seen, u1[0], u2);
      return { cont: s.shouldContinue === 1, frame: s.frameTokenIds };
    },
  };

  const seed = 7;
  const t0 = now();
  const ro = await M.generate(ortRunners, cfg, prompt, { maxFrames: maxFrames, seed: seed });
  const tOrt = now() - t0;
  const t1 = now();
  const rc = await M.generate(cwRunners, cfg, prompt, { maxFrames: maxFrames, seed: seed });
  const tCw = now() - t1;
  const same = ro.count === rc.count && ro.frames.length === rc.frames.length && ro.frames.every((v, i) => v === rc.frames[i]);
  if (process.argv[5]) fs.writeFileSync(process.argv[5], JSON.stringify({ 文字: text, cfg: cfg, seed: seed, maxFrames: maxFrames, rows: prompt.rows, ids: Array.from(prompt.ids), ortFrames: Array.from(ro.frames), ortCount: ro.count }));
  console.log('幀數 ORT', ro.count, 'cudaweb', rc.count, '幀完全一致', same, '耗時ms ORT', tOrt, 'cudaweb', tCw);

  // ---- codec：同一批幀，ORT 對解釋器 ----
  const codecPath = P(codecMeta.files.decode_full);
  const cOrt = await ort.InferenceSession.create(codecPath, { executionProviders: ['cpu'] });
  const cModel = lite.parseModel(fs.readFileSync(codecPath));
  const cFiles = { 'moss_audio_tokenizer_decode_shared.data': codecData };
  const n = rc.count;
  const framesI32 = Int32Array.from(rc.frames);
  const oOut = await cOrt.run({ audio_codes: T('int32', framesI32, [1, n, M.NQ]), audio_code_lengths: T('int32', new Int32Array([n]), [1]) });
  const jOut = await OI.run(cModel, { audio_codes: { d: [1, n, M.NQ], t: 'i', v: Float64Array.from(framesI32) }, audio_code_lengths: { d: [1], t: 'i', v: Float64Array.from([n]) } }, cFiles);
  const oa = Float32Array.from(oOut.audio.data), ja = jOut.audio.v;
  let d = 0, r = 0; for (let i = 0; i < oa.length; i++) { d = Math.max(d, Math.abs(oa[i] - ja[i])); r = Math.max(r, Math.abs(oa[i])); }
  const result = { 文字: text, 幀數: n, 幀完全一致: same, 續停ORT: ro.stopped, 續停cudaweb: rc.stopped, 音訊樣本數: oa.length, 音訊相對誤差: d / (r || 1), ORT幀: Array.from(ro.frames.slice(0, 16)), cudaweb幀: Array.from(rc.frames.slice(0, 16)) };
  console.log(JSON.stringify(result, null, 1));
  process.exitCode = same && result.音訊相對誤差 < 1e-3 ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
