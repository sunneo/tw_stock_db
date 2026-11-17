'use strict';
// qwen_models.js — Qwen3 q8 GPU 解碼可用的模型表、本機路徑、下載（分段、可續傳、核對大小與 sha256）與讀入（DESIGN.webgpu-cuda.md §7.30）。
// 只放純邏輯，依賴（rawfs、fetch、sha256）都由呼叫端注入，node 可用假物件測試。
// 為什麼在 renderer 下載：主程序檔（native-slot-model.js）不能熱更新；rawfs（fa:rawfs:*）已在白名單，所以用 Range 請求分段取回、每段寫成獨立檔（續傳＝略過大小相符的段）。
// 儲存：<userData>/native-models/<dir>/（0.6B 是主程序流程下載的單一檔 onnx/model_quantized.onnx；1.7B 是 parts/p00000.bin… ＋ manifest.json）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaQwenModels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MiB = 1048576, GiB = 1073741824;
  const TOK = { rel: 'tokenizer.json', bytes: 9117040, sha256: 'e7a95fce95bf5b0946d0ddb3f9d7caa030b7e850bbe92b0edb26bcf563e9f3d5' };   // Qwen3 全系列共用同一份
  const MODELS = {
    'qwen3-0.6b': { id: 'qwen3-0.6b', dir: 'qwen3-0.6b-q8', repo: 'onnx-community/Qwen3-0.6B-ONNX', label: 'Qwen3 0.6B', family: 'qwen3', downloadHere: false,
      file: { rel: 'onnx/model_quantized.onnx', bytes: 617687575, sha256: null }, tokenizer: TOK, slowdown: 1, lora: true, q4: { rel: 'onnx/model_q4f16.onnx', bytes: 569789750 }, shape: { D: 1024, H: 16, Hkv: 8, I: 3072, L: 28, V: 151936 } },
    'qwen3-1.7b': { id: 'qwen3-1.7b', dir: 'qwen3-1.7b-q8', repo: 'onnx-community/Qwen3-1.7B-ONNX', label: 'Qwen3 1.7B', family: 'qwen3', downloadHere: true, partBytes: 16 * MiB,
      file: { rel: 'onnx/model_quantized.onnx', bytes: 1742387852, sha256: '202ed81928b7f34c31505b46479c310e131fec307a045eab2537e7c494feb427' }, tokenizer: TOK, slowdown: 2.5, lora: false, q4: { rel: 'onnx/model_q4f16.onnx', bytes: 1426069098 }, shape: { D: 2048, H: 16, Hkv: 8, I: 6144, L: 28, V: 151936 } },
  };
  const get = (id) => MODELS[id] || null;
  const getQ4 = (id) => (MODELS[id] && MODELS[id].q4 ? MODELS[id] : null);   // 有 q4f16 檔（transformers.js 預設的 GPU 格式）的模型
  const isFamily = (id) => !!MODELS[id] || /^qwen3-/.test(String(id || ''));
  const urlOf = (m, rel) => 'https://huggingface.co/' + m.repo + '/resolve/main/' + rel;
  const pad = (i) => String(i).padStart(5, '0');
  const nParts = (m) => Math.ceil(m.file.bytes / m.partBytes);
  const partLen = (m, i) => Math.min(m.partBytes, m.file.bytes - i * m.partBytes);
  const sizeOfStat = (st) => (st && (st.size != null ? st.size : st.sizeBytes));
  const fmt = (b) => (b >= GiB ? (b / GiB).toFixed(2) + ' GiB' : Math.round(b / MiB) + ' MiB');

  // userDataDir（例如 st.box 的上一層）→ 各路徑；sep 由呼叫端依平台給
  function paths(m, userData, sep) {
    const dir = userData + sep + 'native-models' + sep + m.dir;
    return { dir, model: dir + sep + 'onnx' + sep + 'model_quantized.onnx', onnxDir: dir + sep + 'onnx', tok: dir + sep + 'tokenizer.json', parts: dir + sep + 'parts', manifest: dir + sep + 'parts' + sep + 'manifest.json', part: (i) => dir + sep + 'parts' + sep + 'p' + pad(i) + '.bin', sep };
  }
  const statOr = async (raw, p) => { try { return sizeOfStat(await raw.stat(p)); } catch (_) { return -1; } };

  // 本機狀態：single（整檔大小相符）｜parts（分段齊全且 manifest.ok）｜partial（有一部分，可續傳）｜none
  async function status(raw, m, P) {
    if ((await statOr(raw, P.model)) === m.file.bytes && (await statOr(raw, P.tok)) > 0) return { state: 'single', have: m.file.bytes, total: m.file.bytes };
    let have = 0, ok = 0; const n = m.partBytes ? nParts(m) : 0;
    for (let i = 0; i < n; i++) { const s = await statOr(raw, P.part(i)); if (s === partLen(m, i)) { have += s; ok++; } }
    const tokOk = (await statOr(raw, P.tok)) > 0;
    let man = null; try { const r = await raw.readFile(P.manifest, 'utf8'); man = JSON.parse(r.text != null ? r.text : r.content); } catch (_) { /* 還沒有 */ }
    if (n && ok === n && tokOk && man && man.ok && man.bytes === m.file.bytes) return { state: 'parts', have, total: m.file.bytes, manifest: man };
    return { state: have > 0 ? 'partial' : 'none', have, total: m.file.bytes, parts: ok, nParts: n };
  }

  // 下載（只在使用者按下載後呼叫）。deps：raw、fetch、toBase64(u8)、sha256Hex(u8)→Promise<string>（可省略＝只驗大小）、onProgress({done,total,part,nParts})、isStopped()
  async function download(m, userData, sep, deps) {
    if (!m.downloadHere) throw new Error(m.label + ' 由桌面版的原生模型流程下載，這裡不處理');
    const raw = deps.raw, P = paths(m, userData, sep), stop = () => { if (deps.isStopped && deps.isStopped()) { const e = new Error('使用者已停止'); e.isStopped = true; throw e; } };
    await raw.mkdir(P.parts); await raw.mkdir(P.onnxDir);
    const get1 = async (url, range) => {
      const r = await deps.fetch(url, range ? { headers: { Range: 'bytes=' + range[0] + '-' + range[1] } } : {});
      if (!r.ok && r.status !== 206) throw new Error('下載失敗：HTTP ' + r.status + ' ' + url);
      return new Uint8Array(await r.arrayBuffer());
    };
    // tokenizer（小檔，核對大小與 sha256）
    if ((await statOr(raw, P.tok)) !== m.tokenizer.bytes) {
      const t = await get1(urlOf(m, m.tokenizer.rel)); if (t.length !== m.tokenizer.bytes) throw new Error('tokenizer 大小不符（' + t.length + '／' + m.tokenizer.bytes + '）');
      if (deps.sha256Hex && m.tokenizer.sha256 && (await deps.sha256Hex(t)) !== m.tokenizer.sha256) throw new Error('tokenizer sha256 不符');
      await raw.writeFile(P.tok, { base64: deps.toBase64(t) });
    }
    const n = nParts(m); let done = 0;
    for (let i = 0; i < n; i++) { if ((await statOr(raw, P.part(i))) === partLen(m, i)) done += partLen(m, i); }   // 續傳：大小相符的段略過
    if (deps.onProgress) deps.onProgress({ done, total: m.file.bytes, part: 0, nParts: n, resumed: done > 0 });
    for (let i = 0; i < n; i++) {
      stop(); const len = partLen(m, i);
      if ((await statOr(raw, P.part(i))) === len) continue;
      let u8 = null, lastErr = null;
      for (let tr = 0; tr < 3 && !u8; tr++) { try { u8 = await get1(urlOf(m, m.file.rel), [i * m.partBytes, i * m.partBytes + len - 1]); if (u8.length !== len) { lastErr = new Error('第 ' + i + ' 段大小不符（' + u8.length + '／' + len + '）'); u8 = null; } } catch (e) { lastErr = e; } }
      if (!u8) throw lastErr || new Error('下載失敗');
      await raw.writeFile(P.part(i), { base64: deps.toBase64(u8) });
      if ((await statOr(raw, P.part(i))) !== len) throw new Error('第 ' + i + ' 段寫入後大小不符（磁碟空間不足？）');
      done += len; if (deps.onProgress) deps.onProgress({ done, total: m.file.bytes, part: i + 1, nParts: n });
    }
    // 整檔核對：讀回、驗大小與 sha256（記憶體吃緊時 digest 可能失敗：那就只驗大小並在 manifest 註明）
    stop(); const bytes = await readBytes(m, userData, sep, { raw, isStopped: deps.isStopped, partsOnly: true });
    let verified = false, note = '';
    if (bytes.length !== m.file.bytes) throw new Error('整檔大小不符（' + bytes.length + '／' + m.file.bytes + '）');
    if (deps.sha256Hex && m.file.sha256) { try { const h = await deps.sha256Hex(bytes); if (h !== m.file.sha256) { await raw.remove(P.parts, true); throw new Error('sha256 不符（' + h.slice(0, 12) + '… ≠ ' + m.file.sha256.slice(0, 12) + '…），已刪除分段，請重新下載'); } verified = true; } catch (e) { if (/sha256 不符/.test(e.message)) throw e; note = 'sha256 沒有核對（' + String((e && e.message) || e).slice(0, 80) + '），只驗了大小'; } }
    await raw.writeFile(P.manifest, { text: JSON.stringify({ ok: true, bytes: m.file.bytes, sha256: m.file.sha256, verifiedSha: verified, note, at: Date.now() }) });
    return { ok: true, verifiedSha: verified, note, bytes: bytes.length };
  }

  // 讀入模型位元組：整檔（0.6B，用注入的 readLarge 分段複製讀入）或 parts（1.7B）
  async function readBytes(m, userData, sep, deps) {
    const raw = deps.raw, P = paths(m, userData, sep), stop = () => { if (deps.isStopped && deps.isStopped()) { const e = new Error('使用者已停止'); e.isStopped = true; throw e; } };
    if (!deps.partsOnly && (await statOr(raw, P.model)) === m.file.bytes) { if (!deps.readLarge) throw new Error('缺少 readLarge'); return deps.readLarge(P.model, P.dir + sep + '_gpu_parts'); }
    const out = new Uint8Array(m.file.bytes); let off = 0; const n = nParts(m);
    for (let i = 0; i < n; i++) {
      stop(); const r = await raw.readFile(P.part(i), 'base64'); const bin = atob(r.base64);
      if (bin.length !== partLen(m, i) || off + bin.length > out.length) throw new Error('第 ' + i + ' 段大小不符（' + bin.length + '）');
      for (let k = 0; k < bin.length; k++) out[off + k] = bin.charCodeAt(k);
      off += bin.length;
    }
    if (off !== m.file.bytes) throw new Error('讀入的大小不符（' + off + '／' + m.file.bytes + '）');
    return out;
  }
  async function remove(m, userData, sep, raw) { const P = paths(m, userData, sep); await raw.remove(P.dir, true); }

  // 只有形狀、沒有權重內容的 W（長度正確），給 estimateEngineBytes／planLayers 在不載入模型時估算用（介面顯示「需要多少、放不放得下」）
  function shapeW(shape, fmt) {
    const q4 = fmt === 'q4', hd = 128, mk = (K, N) => (q4 ? { W: { length: N * (K / 32) * 16 }, S: { length: N * (K / 32) * 2 }, K, N } : { W: { length: K * N } }), { D, H, Hkv, I, L, V } = shape;
    return { fmt: q4 ? 'q4' : undefined, D, H, Hkv, hd, I, V, L, finalNorm: { byteLength: D * 4 }, emb: { W: { length: V * D * (q4 ? 2 : 1) } }, layers: Array.from({ length: L }, () => ({ q: mk(D, H * hd), k: mk(D, Hkv * hd), v: mk(D, Hkv * hd), o: mk(H * hd, D), g: mk(D, I), u: mk(D, I), d: mk(I, D), inNorm: { byteLength: D * 4 }, postNorm: { byteLength: D * 4 } })) };
  }
  const CFGS = [{ maxT: 2048, maxM: 256 }, { maxT: 1024, maxM: 128 }, { maxT: 512, maxM: 64 }];
  // 依 GPU 記憶體上限挑配置（G＝FaQwenGpu）：先找「全常駐」的最大序列上限（快），找不到再允許分層（序列上限由大到小、1024 起，常駐層盡量多）；都放不下回 ok:false（minNeed＝最小分層配置的需求）
  function choosePlan(G, W, budgetBytes) {
    for (const c of CFGS) { const p = G.planLayers(W, { maxT: c.maxT, maxM: c.maxM, budgetBytes, allowStream: false }); if (p.ok) return { ok: true, cfg: c, plan: p, mode: 'full' }; }
    for (const c of CFGS.slice(1)) { const p = G.planLayers(W, { maxT: c.maxT, maxM: c.maxM, budgetBytes }); if (p.ok) return { ok: true, cfg: c, plan: p, mode: 'streamed' }; }
    const c = CFGS[CFGS.length - 1], p = G.planLayers(W, { maxT: c.maxT, maxM: c.maxM, budgetBytes });
    return { ok: false, cfg: c, plan: p, mode: 'none' };
  }
  // 一行說明（介面用）：「需要約 X MB、上限 Y MB → 全常駐／分層（常駐 N／L 層）／放不下」
  function describe(G, m, budgetBytes, fmt) {
    const q4 = fmt === 'q4', W = shapeW(m.shape, fmt), tag = q4 ? ' q4f16' : ' q8', r = choosePlan(G, W, budgetBytes), mb = (b) => Math.round(b / MiB) + ' MB', fullNeed = G.estimateEngineBytes(W, { maxT: 2048, maxM: 256 }).total;
    if (r.mode === 'full') return { mode: 'full', text: m.label + tag + '：全部放進 GPU 約需 ' + mb(r.plan.need.total) + '（序列上限 ' + r.cfg.maxT + '），上限 ' + mb(budgetBytes) + ' → 全常駐' };
    if (r.mode === 'streamed') return { mode: 'streamed', resident: r.plan.resident, text: m.label + tag + '：全部放進 GPU 約需 ' + mb(fullNeed) + '，上限 ' + mb(budgetBytes) + ' → 分層（常駐 ' + r.plan.resident + '／' + W.L + ' 層，其餘每步串流，較慢；序列上限 ' + r.cfg.maxT + '）' };
    return { mode: 'none', text: m.label + tag + '：全部約需 ' + mb(fullNeed) + '，最小分層配置也要 ' + mb(r.plan.need.total) + '，上限 ' + mb(budgetBytes) + ' → 放不下（GPU 解碼不用，改走其他路徑）' };
  }
  return { shapeW, choosePlan, describe, MODELS, get, getQ4, isFamily, paths, status, download, readBytes, remove, urlOf, nParts, partLen, fmt, TOK };
});
