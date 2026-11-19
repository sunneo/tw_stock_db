// node scripts/eval/kir_interop.build.js <輸出檔>：把 KIR 模組與 nbody3d_cl.ll 的 @cl_src 內嵌到 kir_interop.eval.js。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// 讀 LLVM 字串常數：@name = private constant [N x i8] c"…"
function cstr(ir, name) {
  const m = ir.match(new RegExp('@' + name + ' = private constant \\[(\\d+) x i8\\] c"((?:[^"\\\\]|\\\\[0-9A-Fa-f]{2})*)"'));
  if (!m) throw new Error('找不到 @' + name);
  const bytes = []; const s = m[2];
  for (let i = 0; i < s.length;) { if (s[i] === '\\') { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 3; } else { bytes.push(s.charCodeAt(i)); i += 1; } }
  return Buffer.from(bytes).toString('latin1').replace(/\0+$/, '');
}
const nbody = cstr(rd('renderer/src/examples/llc/gpgpu/nbody3d_cl.ll'), 'cl_src');
const SRC = {
  kir: rd('renderer/src/gpu/kir.js'), gen: rd('renderer/src/gpu/kir_gen.js'), webgl: rd('renderer/src/gpu/kir_webgl2.js'),
  webgpu: rd('renderer/src/gpu/kir_webgpu.js'), front: rd('renderer/src/gpu/cl_front.js'), nbody
};
const body = fs.readFileSync(path.join(__dirname, 'kir_interop.eval.js'), 'utf8').replace('const SRC = __SRC__;', () => 'const SRC = ' + JSON.stringify(SRC) + ';');
const out = process.argv[2];
if (!out) { console.error('用法：node scripts/eval/kir_interop.build.js <輸出檔>'); process.exit(2); }
fs.writeFileSync(out, body);
console.log('wrote ' + out + ' (' + body.length + ' bytes)');
