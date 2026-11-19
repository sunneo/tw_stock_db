// node scripts/eval/gpgpu_bench.build.js <輸出檔>：把 gpgpu/nbody3d(.ll、_cl.ll)、fluid3d(.ll、_cl.ll) 內嵌進 gpgpu_bench.eval.js。
// 真 GPU：FA_EVAL_GL=gpu FA_EVAL_TIMEOUT_MS=3000000 node scripts/eval/run_eval.js <輸出檔>
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const dir = path.join(root, 'renderer/src/examples/llc/gpgpu');
const SRC = {};
for (const f of ['nbody3d.ll', 'nbody3d_cl.ll', 'fluid3d.ll', 'fluid3d_cl.ll']) SRC['gpgpu/' + f] = fs.readFileSync(path.join(dir, f), 'utf8');
const body = fs.readFileSync(path.join(__dirname, 'gpgpu_bench.eval.js'), 'utf8').replace('const SRC = __SRC__;', () => 'const SRC = ' + JSON.stringify(SRC) + ';');
const out = process.argv[2];
if (!out) { console.error('用法：node scripts/eval/gpgpu_bench.build.js <輸出檔>'); process.exit(2); }
fs.writeFileSync(out, body);
console.log('wrote ' + out + ' (' + body.length + ' bytes)');
