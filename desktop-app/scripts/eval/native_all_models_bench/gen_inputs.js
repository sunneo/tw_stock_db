// 產生固定輸入（固定種子）：每個模型每題一個 .bin（原始 little-endian），並寫 inputs/manifest.json（含 SHA-256）。
// 用法：node gen_inputs.js <輸出資料夾>   （原生端與 WASM 端都讀同一份檔案，保證同機同輸入）
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const out = process.argv[2]; if (!out) { console.error('用法：node gen_inputs.js <輸出資料夾>'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench-config.json'), 'utf8'));
const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
const total = (dims) => dims.reduce((a, b) => a * b, 1);
function audio(n, sr, q, seed) {
  const a = new Float32Array(n), r = rng(seed + q);
  const freqs = [[261.63, 329.63], [220], [110, 277.18, 415.3]][q % 3];
  for (let i = 0; i < n; i++) {
    const t = i / sr; let v = 0;
    if (q < 2) { for (const f of freqs) v += Math.sin(2 * Math.PI * f * t) * 0.3 + Math.sin(2 * Math.PI * f * 2 * t) * 0.1; v *= Math.min(1, t * 4); v += (r() - 0.5) * 0.02; }
    else v = (r() - 0.5) * 0.6;
    a[i] = v;
  }
  return a;
}
function gen(kind, dims, q, inp) {
  const n = total(dims);
  if (kind === 'audio22k') return audio(n, 22050, q, 11);
  if (kind === 'audio16k') return audio(n, 16000, q, 12);
  if (kind === 'audio44k_stereo') { const seg = dims[2], a = audio(seg, 44100, q, 13), b = audio(seg, 44100, q, 14); const o = new Float32Array(n); o.set(a, 0); o.set(b, seg); return o; }
  if (kind === 'image') { // 平滑漸層加幾個方塊，像是一張簡單的圖（已正規化的數值範圍約 -2..2）
    const [, C, H, W] = dims, o = new Float32Array(n), r = rng(20 + q);
    const boxes = Array.from({ length: 4 }, () => ({ x: r() * W * 0.7, y: r() * H * 0.7, w: W * 0.25, h: H * 0.25, v: r() * 2 - 1 }));
    for (let c = 0; c < C; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = (x / W - 0.5) * (c + 1) * 0.8 + (y / H - 0.5) * 0.6; for (const b of boxes) if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) v += b.v; o[(c * H + y) * W + x] = v; }
    return o;
  }
  if (kind === 'logmel') { const o = new Float32Array(n), r = rng(30 + q); for (let i = 0; i < n; i++) o[i] = -0.6 + (r() - 0.5) * 0.8; return o; }
  if (kind === 'randn') { const o = new Float32Array(n), r = rng(40 + q + (inp.seed || 0)), std = inp.std || 1; for (let i = 0; i < n; i++) { const u1 = Math.max(r(), 1e-12), u2 = r(); o[i] = std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); } return o; }
  if (kind === 'int64const') return BigInt64Array.from({ length: n }, () => BigInt(inp.value));
  if (kind === 'float32const') return new Float32Array(n).fill(inp.value);
  if (kind === 'int64tokens') { const o = new BigInt64Array(n), r = rng(50 + q); for (let i = 0; i < n; i++) o[i] = i === 0 ? 49406n : BigInt(1000 + Math.floor(r() * 40000)); return o; }
  throw new Error('不認得的產生器 ' + kind);
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const manifest = { seedNote: '種子固定；產生器在 gen_inputs.js', items: [] };
fs.mkdirSync(out, { recursive: true });
for (const m of cfg.models) {
  if (!Array.isArray(m.inputs)) continue;
  for (let q = 0; q < cfg.queries; q++) for (const inp of m.inputs) {
    const f = gen(inp.gen, inp.dims, q, inp), buf = Buffer.from(f.buffer, f.byteOffset, f.byteLength);
    const rel = m.id + '_q' + q + '_' + inp.name + '.bin';
    fs.writeFileSync(path.join(out, rel), buf);
    manifest.items.push({ model: m.id, q, input: inp.name, dtype: inp.dtype, dims: inp.dims, file: rel, bytes: buf.length, sha256: sha(buf) });
  }
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('已寫入', manifest.items.length, '個輸入到', out);
