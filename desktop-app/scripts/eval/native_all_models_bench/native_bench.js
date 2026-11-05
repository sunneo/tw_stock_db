// 原生端量測（onnxruntime-node CPU）。以 Electron 的 node 模式執行（ELECTRON_RUN_AS_NODE=1），不開任何網路通道，不下載任何檔案。
// 環境變數：NAB_ORT=onnxruntime-node 資料夾；NAB_MODELS=模型資料夾；NAB_WORK=輸入／輸出工作資料夾（內含 inputs/manifest.json）；NAB_OUT=結果 jsonl；NAB_ONLY=模型 id（逗號分隔，可省略）。
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const E = process.env, cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench-config.json'), 'utf8'));
const ort = require(E.NAB_ORT), WORK = E.NAB_WORK, MODELS = E.NAB_MODELS, OUT = E.NAB_OUT;
const only = E.NAB_ONLY ? E.NAB_ONLY.split(',') : null;
// 不調整優先權：WASM 端的渲染／背景執行緒行程無法同樣調整，兩邊都用一般優先權才公平
const man = JSON.parse(fs.readFileSync(path.join(WORK, 'inputs', 'manifest.json'), 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const emit = (o) => { fs.appendFileSync(OUT, JSON.stringify(Object.assign({ backend: 'native-cpu', ts: new Date().toISOString() }, o)) + '\n'); };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const TYPED = { float32: Float32Array, int64: BigInt64Array, int32: Int32Array, uint8: Uint8Array };
const T0 = Date.now();
function loadInputs(m, q, sess) {
  const feeds = {};
  for (const it of man.items.filter((x) => x.model === m.id && x.q === q)) {
    const buf = fs.readFileSync(path.join(WORK, 'inputs', it.file)); const C = TYPED[it.dtype];
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    feeds[/^auto\d+$/.test(it.input) ? sess.inputNames[+it.input.slice(4)] : it.input] = new ort.Tensor(it.dtype, new C(ab), it.dims);
  }
  return feeds;
}
(async () => {
  for (const m of cfg.models) {
    if (only && !only.includes(m.id)) continue;
    if (Date.now() - T0 > cfg.time_cap_ms) { emit({ model: m.id, aborted: 'time_cap' }); continue; }
    const fp = path.join(MODELS, m.file);
    if (!fs.existsSync(fp)) { emit({ model: m.id, skipped: 'needs_download', needs_download: { file: m.file, source: m.source, bytes: m.bytes } }); continue; }
    const st = fs.statSync(fp);
    if (m.bytes && st.size !== m.bytes) { emit({ model: m.id, ok: false, error: '位元組數不符 ' + st.size + ' / ' + m.bytes }); continue; }
    try {
      const tl = Date.now();
      const sess = await ort.InferenceSession.create(fp, { executionProviders: ['cpu'], intraOpNumThreads: cfg.threads, graphOptimizationLevel: m.graph_opt || 'all', enableMemPattern: false });
      const loadMs = Date.now() - tl;
      emit({ model: m.id, event: 'loaded', load_ms: loadMs, inputs: sess.inputNames, outputs: sess.outputNames, maxrss_mb: Math.round(process.resourceUsage().maxRSS / 1024) });
      if (!Array.isArray(m.inputs)) { emit({ model: m.id, skipped: 'special_inputs_not_implemented' }); continue; }
      for (let q = 0; q < cfg.queries; q++) {
        const feeds = loadInputs(m, q, sess); const times = []; let outs = null, err = null;
        for (let r = 0; r < cfg.warmup + (m.runs || cfg.runs); r++) {
          const t = Date.now();
          try { outs = await sess.run(feeds); } catch (e) { err = String(e && e.message || e); break; }
          const ms = Date.now() - t; if (r >= cfg.warmup) times.push(ms);
          if (ms > cfg.timeout_ms) { err = 'timeout ' + ms; break; }
        }
        if (err) { emit({ model: m.id, q, ok: false, error: err }); continue; }
        const hs = []; fs.mkdirSync(path.join(WORK, 'out', 'native'), { recursive: true });
        for (const name of sess.outputNames) { const d = outs[name].data; const b = Buffer.from(d.buffer, d.byteOffset, d.byteLength); hs.push(b); fs.writeFileSync(path.join(WORK, 'out', 'native', m.id + '_q' + q + '_' + name.replace(/[^\w.-]/g, '_') + '.bin'), b); }
        emit({ model: m.id, q, ok: true, ms: median(times), all_ms: times, out_hash: sha(Buffer.concat(hs)), out_dims: sess.outputNames.map((n) => outs[n].dims), out_names: sess.outputNames, maxrss_mb: Math.round(process.resourceUsage().maxRSS / 1024) });
      }
      await sess.release();
    } catch (e) { emit({ model: m.id, ok: false, error: String(e && e.stack || e).slice(0, 400) }); }
  }
  emit({ event: 'done', total_ms: Date.now() - T0, node: process.versions.node, electron: process.versions.electron || null, ort_node: require(path.join(E.NAB_ORT, 'package.json')).version, cpus: os.cpus().length, cpu: os.cpus()[0].model });
})();
