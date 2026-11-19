// node scripts/eval/llc_interop.build.js <輸出檔>：內嵌 gpgpu/nbody3d.ll 與 nbody3d_cl.ll 到 llc_interop.eval.js。
// 執行（需要 app 已經 build：node build-assistant.js，讓 renderer/floating-assistant.js 含最新的 interop 掛鉤）：
//   FA_EVAL_GL=gpu FA_EVAL_TIMEOUT_MS=3000000 node scripts/eval/run_eval.js <輸出檔> 17994
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const dir = path.join(root, 'renderer/src/examples/llc/gpgpu');
const LL = {};
for (const f of ['nbody3d.ll', 'nbody3d_cl.ll']) LL[f.replace(/\.ll$/, '')] = fs.readFileSync(path.join(dir, f), 'utf8');
const body = fs.readFileSync(path.join(__dirname, 'llc_interop.eval.js'), 'utf8').replace('const SRC = __SRC__;', () => 'const SRC = ' + JSON.stringify({ LL }) + ';');
const out = process.argv[2];
if (!out) { console.error('用法：node scripts/eval/llc_interop.build.js <輸出檔>'); process.exit(2); }
fs.writeFileSync(out, body);
console.log('wrote ' + out + ' (' + body.length + ' bytes)');
