// 評測 6：Conv 全 0 的定位探針。在模組裡找 runWgsl（nn_ops）與 conv1dRef（conv_ops），同一組輸入比三種：
//   (a) conv1dRef（真正的 CPU 參考）；(b) runWgsl + WGSL_CONV1D，groups 給「數字」（走扁平分批 chunked）；
//   (c) runWgsl + WGSL_CONV1D，groups 給「陣列」（不分批，一次派發）。
// 另外記錄 GPU 裝置 limits。守則：全新 --user-data-dir、最多兩次、不存檔設定。
const out = { found: {} };
const a = window.desktopAPI;
const save = async () => { try { await a.rawfs.writeFile('E:/Temp/conv_probe.json', { text: JSON.stringify(out, null, 2) }); } catch (_) { /* */ } };
function rnd(n, seed) { const v = new Float32Array(n); let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v[i] = (s / 4294967296) * 2 - 1; } return v; }
function findIn(obj, pred, depth, path) {
  if (!obj || depth < 0) return null;
  for (const k of Object.keys(obj)) { let v; try { v = obj[k]; } catch (_) { continue; } if (pred(v, k)) return { v, path: path + '.' + k }; }
  for (const k of Object.keys(obj)) { let v; try { v = obj[k]; } catch (_) { continue; } if (v && typeof v === 'object' && !Array.isArray(v) && depth > 0) { const r = findIn(v, pred, depth - 1, path + '.' + k); if (r) return r; } }
  return null;
}
try {
  const M0 = window.fa._qwenModule();
  out.topKeys = Object.keys(M0).slice(0, 60);
  const nnRes = findIn(M0, (v) => v && typeof v.runWgsl === 'function' && typeof v.softmax === 'function', 4, 'M');
  // 找 WGSL_CONV1D 原文（以它特有的那一行辨認）
  const wgRes = findIn(M0, (v) => typeof v === 'string' && v.indexOf('let t = idx % p.Lout;') >= 0 && v.indexOf('@compute') >= 0 && v.indexOf('p.groups') >= 0, 4, 'M');
  out.found.nn = nnRes ? nnRes.path : null; out.found.wgsl = wgRes ? wgRes.path : null;
  if (!nnRes || !wgRes) throw new Error('找不到模組：nn=' + !!nnRes + ' wgsl=' + !!wgRes);
  const nn = nnRes.v, WGSL = wgRes.v;
  const ad = await navigator.gpu.requestAdapter();
  const dev = await ad.requestDevice();
  out.limits = { maxComputeInvocationsPerWorkgroup: ad.limits.maxComputeInvocationsPerWorkgroup, maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize };
  const C = 16, L = 256, O = 32, K = 3, stride = 1, pad = 1, Lout = L;
  const x = rnd(C * L, 7), w = rnd(O * C * K, 13);
  const ref = new Float64Array(O * Lout);   // 獨立的 JS 參考（無分組、無偏置）
  for (let o = 0; o < O; o++) for (let t = 0; t < Lout; t++) { let s = 0; for (let c = 0; c < C; c++) for (let j = 0; j < K; j++) { const p = t * stride + j - pad; if (p >= 0 && p < L) s += x[c * L + p] * w[(o * C + c) * K + j]; } ref[o * Lout + t] = s; }
  out.refMaxAbs = Math.max(...Array.from(ref).map(Math.abs));
  const u = new Uint32Array([1, C, L, O, C, K, Lout, stride, pad, 1, 1, 0]);
  const total = O * Lout;
  const bufs = () => [{ data: Float32Array.from(x) }, { data: Float32Array.from(w) }, { data: new Float32Array(1) }, { data: new Float32Array(total), out: true }];
  // (b) 扁平分批
  const rb = await nn.runWgsl(dev, WGSL, bufs(), new Uint8Array(u.buffer), Math.ceil(total / 64));
  // (c) 不分批（陣列 groups）
  const rc = await nn.runWgsl(dev, WGSL, bufs(), new Uint8Array(u.buffer), [Math.ceil(total / 64), 1, 1]);
  const cmp = (got) => { let mx = 0, nz = 0; for (let i = 0; i < ref.length; i++) { const d = Math.abs(got[i] - ref[i]); if (d > mx) mx = d; if (got[i] !== 0) nz++; } return { maxAbsErr: mx, nonZero: nz, n: got.length }; };
  out.chunked = cmp(rb[0]); out.unchunked = cmp(rc[0]);
  out.chunkStat = globalThis.__faGpuChunkStat || null;
} catch (e) { out.error = String((e && e.stack) || e); }
await save();
return out;
