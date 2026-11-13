'use strict';
/* 提案 A（DESIGN.offline-training-studio.md §12）M1：VLM 分階段載入（Florence-2 的 onnx 圖）。
 *  三個階段，每階段只載入自己需要的工作階段（session），用完就 release()，權重從「儲存」讀（網頁版＝IndexedDB 的 swap_store）：
 *    vision ：vision_encoder（圖 → image_features）
 *    encode ：embed_tokens（提示詞權杖 → 嵌入） + encoder_model（合併嵌入 → 編碼器隱藏狀態）
 *    decode ：embed_tokens（新權杖 → 嵌入） + decoder_model_merged（自回歸，貪婪解碼，KV 快取）
 *  常駐（resident）模式：四個工作階段一開始全部載入，之後不釋放。兩種模式跑的是同一段數學程式（同一個 runPipeline），
 *  所以輸出權杖必須逐字相同；這是 M1 的比對條件。
 *
 *  注入的依賴（讓這個檔案不綁定瀏覽器或 Node）：
 *    store.get(name) → Promise<Uint8Array>            權重位元組（網頁版＝IndexedDB；Node 測試＝檔案）
 *    createSession(name, bytes) → Promise<{ run(feeds) → Promise<{名稱: {data, dims}}>, release() }>
 *    now() → 毫秒（可選，預設 Date.now）
 *  feeds 與輸出的張量格式：{ data: TypedArray, dims: number[], type: 'float32'|'int64'|'bool' }
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaStagedVlm = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var HIDDEN = 768, HEADS = 12, HEAD_DIM = 64, LAYERS = 6;
  var STAGES = {
    vision: ['vision'],
    encode: ['embed', 'encoder'],
    decode: ['embed', 'decoder'],
  };
  var FILES = { vision: 'onnx/vision_encoder_quantized.onnx', embed: 'onnx/embed_tokens_quantized.onnx', encoder: 'onnx/encoder_model_quantized.onnx', decoder: 'onnx/decoder_model_merged_quantized.onnx' };

  function argmax(arr, off, n) { var best = 0, bv = -Infinity; for (var i = 0; i < n; i++) { var v = arr[off + i]; if (v > bv) { bv = v; best = i; } } return best; }

  // 共用的數學程式。S.get(name) 取得工作階段（同一階段內可重複取用）；S.stage(name) 宣告進入階段（會載入）；S.leave(name) 離開階段（會釋放）。
  async function runPipeline(S, o) {
    var ids = o.inputIds, pixel = o.pixelValues, maxNew = o.maxNewTokens || 32, decoderStart = o.decoderStartTokenId == null ? 2 : o.decoderStartTokenId, forcedBos = o.forcedBosTokenId == null ? 0 : o.forcedBosTokenId, eos = o.eosTokenId == null ? 2 : o.eosTokenId;
    var L = ids.length;
    // 階段一：視覺
    await S.enter('vision');
    var vis = await S.get('vision').run({ pixel_values: { data: pixel.data, dims: pixel.dims, type: 'float32' } });
    var imgFeat = vis.image_features;  // [1, N, 768]
    var N = imgFeat.dims[1];
    await S.leave('vision');
    // 階段二：編碼（嵌入提示詞 → 與圖的特徵合併 → 編碼器）
    await S.enter('encode');
    var emb = await S.get('embed').run({ input_ids: { data: BigInt64Array.from(ids.map(BigInt)), dims: [1, L], type: 'int64' } });
    var txt = emb.inputs_embeds.data;  // [1, L, 768]
    var merged = new Float32Array((N + L) * HIDDEN);
    merged.set(imgFeat.data, 0); merged.set(txt, N * HIDDEN);
    var mask = new BigInt64Array(N + L); mask.fill(1n);
    var enc = await S.get('encoder').run({ attention_mask: { data: mask, dims: [1, N + L], type: 'int64' }, inputs_embeds: { data: merged, dims: [1, N + L, HIDDEN], type: 'float32' } });
    var encHidden = enc.last_hidden_state;  // [1, S, 768]
    var S_LEN = N + L;
    await S.leave('encode');
    // 階段三：解碼（貪婪）
    await S.enter('decode');
    var embD = S.get('embed'), dec = S.get('decoder');
    var encMask = { data: mask, dims: [1, S_LEN], type: 'int64' };
    var encHid = { data: encHidden.data, dims: encHidden.dims, type: 'float32' };
    var past = {};
    for (var l = 0; l < LAYERS; l++) for (var kind of ['decoder', 'encoder']) for (var kv of ['key', 'value']) past['past_key_values.' + l + '.' + kind + '.' + kv] = { data: new Float32Array(0), dims: [1, HEADS, 0, HEAD_DIM], type: 'float32' };
    var out = [], tok = decoderStart, useCache = false;
    for (var step = 0; step < maxNew; step++) {
      var e = await embD.run({ input_ids: { data: BigInt64Array.from([BigInt(tok)]), dims: [1, 1], type: 'int64' } });
      var feeds = Object.assign({ encoder_attention_mask: encMask, encoder_hidden_states: encHid, inputs_embeds: { data: e.inputs_embeds.data, dims: [1, 1, HIDDEN], type: 'float32' }, use_cache_branch: { data: [useCache], dims: [1], type: 'bool' } }, past);
      var r = await dec.run(feeds);
      var logits = r.logits, V = logits.dims[2];
      var next = argmax(logits.data, 0, V);
      if (step === 1 && forcedBos != null) next = forcedBos;  // 與 BART 系列一樣，第二個權杖強制為 BOS
      if (next === eos) break;
      out.push(next);
      // 下一步的過去：present.* → past_key_values.*
      // 編碼器的 KV 只在第一步算出（之後 present.*.encoder.* 會是空的），之後沿用第一步的結果；解碼器的 KV 每步更新
      var nextPast = {};
      for (var k in r) if (k.indexOf('present.') === 0) {
        var pk = 'past_key_values.' + k.slice(8);
        if (k.indexOf('.encoder.') >= 0 && useCache) nextPast[pk] = past[pk]; else nextPast[pk] = r[k];
      }
      past = nextPast;
      useCache = true; tok = next;
    }
    await S.leave('decode');
    return { tokens: out, imageTokens: N, encoderLength: S_LEN };
  }

  // 常駐：全部一開始載入，之後不釋放（對照組）
  async function generateResident(o) {
    var sessions = {};
    var t0 = o.now ? o.now() : Date.now();
    for (var stage in STAGES) for (var name of STAGES[stage]) if (!sessions[name]) sessions[name] = await o.createSession(name, await o.store.get(name));
    var loadMs = (o.now ? o.now() : Date.now()) - t0;
    var S = { get: function (n) { return sessions[n]; }, enter: async function () {}, leave: async function () {} };
    var res = await runPipeline(S, o);
    for (var n in sessions) await sessions[n].release();
    res.mode = 'resident'; res.loadMs = loadMs; res.switchMs = []; return res;
  }

  // 分階段：每階段開始時載入該階段的工作階段，結束時釋放；記錄每次切換（讀取＋建立）的毫秒數
  async function generateStaged(o) {
    var now = o.now || Date.now;
    var live = {}, switchMs = [], peakLive = 0, cur = null;
    var S = {
      get: function (n) { if (!live[n]) throw new Error('階段外取用工作階段：' + n); return live[n].s; },
      enter: async function (stage) {
        cur = stage; var t0 = now();
        for (var name of STAGES[stage]) {
          var bytes = await o.store.get(name);
          live[name] = { s: await o.createSession(name, bytes) };
        }
        switchMs.push({ stage: stage, phase: 'load', ms: now() - t0 });
        peakLive = Math.max(peakLive, Object.keys(live).length);
      },
      leave: async function (stage) {
        var t0 = now();
        for (var name of STAGES[stage]) { if (live[name]) { await live[name].s.release(); delete live[name]; } }
        switchMs.push({ stage: stage, phase: 'release', ms: now() - t0 });
      },
    };
    var res = await runPipeline(S, o);
    res.mode = 'staged'; res.switchMs = switchMs; res.maxSessionsAtOnce = peakLive; res.loadMs = switchMs.filter(function (x) { return x.phase === 'load'; }).reduce(function (a, b) { return a + b.ms; }, 0);
    return res;
  }

  return { HIDDEN: HIDDEN, HEADS: HEADS, HEAD_DIM: HEAD_DIM, LAYERS: LAYERS, STAGES: STAGES, FILES: FILES, argmax: argmax, runPipeline: runPipeline, generateResident: generateResident, generateStaged: generateStaged };
});
