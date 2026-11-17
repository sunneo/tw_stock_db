// qwen_models.js：模型表、狀態、分段下載（續傳、重試、核對、sha 不符刪除、停止）、讀入。用假 rawfs／假 fetch。
const crypto = require('crypto'); const M = require('./qwen_models.js');
let pass = 0, fail = 0; const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL ' + n); } };
ok(M.get('qwen3-1.7b').file.bytes === 1742387852 && M.get('qwen3-1.7b').file.sha256.length === 64 && M.get('qwen3-1.7b').lora === false && M.get('qwen3-0.6b').lora === true, '模型表：1.7B 大小與 sha256、不支援 LoRA');
ok(M.isFamily('qwen3-1.7b') && M.isFamily('qwen3-4b') && !M.isFamily('smollm2-360m'), 'Qwen3 家族判斷');
ok(M.nParts(M.get('qwen3-1.7b')) === 104 && M.partLen(M.get('qwen3-1.7b'), 103) === 1742387852 - 103 * 16 * 1048576, '分段數與最後一段長度');
const data = crypto.randomBytes(100003), sha = crypto.createHash('sha256').update(data).digest('hex'), tokData = Buffer.from('tok');
const m = { id: 't', dir: 't-q8', repo: 'x/y', label: 'T', downloadHere: true, partBytes: 30000, file: { rel: 'onnx/model_quantized.onnx', bytes: data.length, sha256: sha }, tokenizer: { rel: 'tokenizer.json', bytes: 3, sha256: crypto.createHash('sha256').update(tokData).digest('hex') } };
function mkRaw() { const fs = new Map(); return { fs,
  async stat(p) { if (!fs.has(p)) throw new Error('ENOENT'); return { size: fs.get(p).length }; }, async mkdir() {}, async remove(p) { for (const k of [...fs.keys()]) if (k.startsWith(p)) fs.delete(k); },
  async writeFile(p, o) { fs.set(p, o.base64 != null ? Buffer.from(o.base64, 'base64') : Buffer.from(o.text)); }, async readFile(p, enc) { const b = fs.get(p); if (!b) throw new Error('ENOENT'); return enc === 'base64' ? { base64: b.toString('base64') } : { text: b.toString() }; } }; }
function mkFetch(opt) { const log = []; const f = async (url, init) => { log.push((init && init.headers && init.headers.Range) || 'full'); if (opt && opt.failFirst && log.length === 3) return { ok: false, status: 503 };
  const buf = /tokenizer/.test(url) ? tokData : data; let b = buf; const r = init && init.headers && init.headers.Range; if (r) { const [a, z] = r.replace('bytes=', '').split('-').map(Number); b = buf.subarray(a, z + 1); if (opt && opt.short && log.length === 2) b = b.subarray(0, b.length - 1); }
  return { ok: true, status: r ? 206 : 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; }; f.log = log; return f; }
const deps = (raw, fetch, extra) => Object.assign({ raw, fetch, toBase64: (u) => Buffer.from(u).toString('base64'), sha256Hex: async (u) => crypto.createHash('sha256').update(u).digest('hex') }, extra);
globalThis.atob = globalThis.atob || ((s) => Buffer.from(s, 'base64').toString('binary'));
const G = require('./qwen_gpu.js'); const mm = (b) => b * 1048576;
{
  const m17 = M.get('qwen3-1.7b'), m06 = M.get('qwen3-0.6b');
  let d = M.describe(G, m17, mm(4096)); ok(d.mode === 'full' && /全常駐/.test(d.text), '1.7B 上限 4096 MB：全常駐（' + d.text + '）');
  d = M.describe(G, m17, mm(1500)); ok(d.mode === 'streamed' && d.resident > 0 && d.resident < 28 && /分層/.test(d.text), '1.7B 上限 1500 MB：分層（常駐 ' + d.resident + '）');
  d = M.describe(G, m17, mm(300)); ok(d.mode === 'none' && /放不下/.test(d.text), '1.7B 上限 300 MB：放不下');
  d = M.describe(G, m06, mm(1024)); ok(d.mode === 'full' || d.mode === 'streamed', '0.6B 上限 1 GiB 放得下（' + d.mode + '）');
  const r = M.choosePlan(G, M.shapeW(m17.shape), mm(2400)); ok(r.ok && r.mode === 'full' && r.cfg.maxT === 2048, '1.7B 上限 2400 MB：全常駐、序列上限 2048');
}
(async () => {
  const P = M.paths(m, '/u', '/'); let raw = mkRaw(); let st = await M.status(raw, m, P); ok(st.state === 'none', '一開始沒有');
  let prog = []; let fx = mkFetch(); let r = await M.download(m, '/u', '/', deps(raw, fx, { onProgress: (p) => prog.push(p.done) }));
  ok(r.ok && r.verifiedSha && fx.log.length === 1 + 4, '下載完成並核對 sha256（1 個 tokenizer＋4 段）');
  ok(prog[prog.length - 1] === data.length, '進度到 100%'); st = await M.status(raw, m, P); ok(st.state === 'parts', '狀態：parts');
  const bytes = await M.readBytes(m, '/u', '/', { raw }); ok(Buffer.compare(Buffer.from(bytes), data) === 0, '讀入的位元組與原檔相同');
  // 續傳：刪掉一段與 manifest，只重抓缺的那一段
  raw.fs.delete(P.part(2)); raw.fs.delete(P.manifest); st = await M.status(raw, m, P); ok(st.state === 'partial' && st.parts === 3, '少一段＝partial');
  fx = mkFetch(); r = await M.download(m, '/u', '/', deps(raw, fx)); ok(r.ok && fx.log.length === 1, '續傳只抓缺的 1 段（tokenizer 已在）');
  // 重試：第 3 次請求失敗（503），重試後成功
  raw = mkRaw(); fx = mkFetch({ failFirst: true }); r = await M.download(m, '/u', '/', deps(raw, fx)); ok(r.ok, '單段 503 重試後成功');
  // 段長度不符（伺服器少給 1 位元組）→ 重試
  raw = mkRaw(); fx = mkFetch({ short: true }); r = await M.download(m, '/u', '/', deps(raw, fx)); ok(r.ok, '段太短重試後成功');
  // sha 不符：刪除分段並報錯
  raw = mkRaw(); const bad = Object.assign({}, m, { file: Object.assign({}, m.file, { sha256: '0'.repeat(64) }) });
  let err = ''; try { await M.download(bad, '/u', '/', deps(raw, mkFetch())); } catch (e) { err = e.message; }
  ok(/sha256 不符/.test(err) && ![...raw.fs.keys()].some((k) => /\.bin$/.test(k)), 'sha256 不符：報錯並刪除分段');
  // 停止
  raw = mkRaw(); let n = 0; err = null; try { await M.download(m, '/u', '/', deps(raw, mkFetch(), { isStopped: () => ++n > 3 })); } catch (e) { err = e; }
  ok(err && err.isStopped, '使用者停止：丟 isStopped'); st = await M.status(raw, m, P); ok(st.state === 'partial', '停止後可續傳');
  // 不下載的模型（0.6B 走主程序流程）
  err = ''; try { await M.download(M.get('qwen3-0.6b'), '/u', '/', deps(mkRaw(), mkFetch())); } catch (e) { err = e.message; } ok(/原生模型流程/.test(err), '0.6B 不在這裡下載');
  // 整檔（single）
  raw = mkRaw(); const P2 = M.paths(m, '/u', '/'); raw.fs.set(P2.model, data); raw.fs.set(P2.tok, tokData); st = await M.status(raw, m, P2); ok(st.state === 'single', '整檔也認得');
  console.log(pass + ' 通過 ' + fail + ' 失敗'); process.exit(fail ? 1 : 0);
})();
