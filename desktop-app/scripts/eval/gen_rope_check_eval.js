#!/usr/bin/env node
// 產生 RoPE 查證的評估檔（給 FA_DEBUG_EVAL_FILE 用，在真的渲染行程裡跑）。
// 目的：把 nn_ops 的 GPU RoPE 核心（createBatch 上的 rope，trainStepDevice 也用它）的輸出原樣回傳，
// 再由 scripts/eval/rope_check_torch.py 用 PyTorch 逐元素比對（真值是 PyTorch，不是 JS 參考）。
// 用法：node scripts/eval/gen_rope_check_eval.js <輸出評估檔> <輸出的 x 與結果 JSON 路徑由評估檔回傳>
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const SRC = path.join(root, 'renderer', 'src');
const out = process.argv[2];
if (!out) { console.error('用法：node gen_rope_check_eval.js <輸出評估檔>'); process.exit(2); }

const ENTRY = ['gpu/nn_ops.js'];
const rel = (abs) => path.relative(SRC, abs).split(path.sep).join('/');
const mods = new Map();
const queue = ENTRY.map((e) => path.join(SRC, e));
while (queue.length) {
  const abs = queue.shift(); const r = rel(abs);
  if (mods.has(r)) continue;
  if (!fs.existsSync(abs)) throw new Error('找不到模組：' + r);
  const srcText = fs.readFileSync(abs, 'utf8');
  mods.set(r, srcText);
  const re = /require\((['"])(\.[^'"]+)\1\)/g; let m;
  while ((m = re.exec(srcText))) queue.push(path.resolve(path.dirname(abs), m[2]));
}
const modBlock = [...mods.entries()].map(([r, s]) => JSON.stringify(r) + ': function (module, exports, require) {\n' + s + '\n}').join(',\n');

const body = `
const __mods = {
${modBlock}
};
const __cache = Object.create(null);
function __norm(base, spec) {
  const parts = base.split('/'); parts.pop();
  for (const seg of spec.split('/')) { if (seg === '.' || seg === '') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return parts.join('/');
}
function __load(name) {
  if (__cache[name]) return __cache[name].exports;
  const fn = __mods[name]; if (!fn) throw new Error('未內嵌的模組：' + name);
  const mod = { exports: {} }; __cache[name] = mod;
  fn.call(mod.exports, mod, mod.exports, (spec) => { if (spec[0] !== '.') throw new Error('不提供 Node 模組：' + spec); return __load(__norm(name, spec)); });
  return mod.exports;
}
const NN = __load('gpu/nn_ops.js');
const g = await NN.getDevice(navigator);
if (!g.dev) return { error: 'no WebGPU device', reason: g.reason || null };
const R = { cases: [] };
// 幾組（T、H、hd）：hd 為 8、16；H 為 2、4
const shapes = [[4, 2, 8], [6, 4, 16], [3, 1, 8]];
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
for (const [T, H, hd] of shapes) {
  const d = H * hd;
  const x = new Float32Array(T * d); for (let i = 0; i < x.length; i++) x[i] = rnd() * 2;
  const B = NN.createBatch(g.dev);
  const h = B.upload(x);
  const yPlus = B.rope(h, T, H, hd, 1);
  const yMinus = B.rope(h, T, H, hd, -1);
  const outs = await B.read([[yPlus, T * d], [yMinus, T * d]]);
  R.cases.push({ T: T, H: H, hd: hd, x: Array.from(x), gpuPlus: Array.from(outs[0]), gpuMinus: Array.from(outs[1]) });
}
R.device = { ok: true };
return R;
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size);
