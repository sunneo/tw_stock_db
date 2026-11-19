// node scripts/eval/llc_kir_e2e.build.js <輸出檔>：內嵌 gpgpu/nbody3d(.ll、_cl.ll)、fluid3d(.ll、_cl.ll) 與字型到 llc_kir_e2e.eval.js。
// 執行（需要 app 已經 build：node build-assistant.js，讓 renderer/floating-assistant.js 含最新的 KIR 掛鉤）：
//   FA_EVAL_GL=gpu FA_EVAL_TIMEOUT_MS=1500000 node scripts/eval/run_eval.js <輸出檔> 17994
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dir = path.join(root, 'renderer/src/examples/llc/gpgpu');
const LL = {};
for (const f of ['nbody3d.ll', 'nbody3d_cl.ll', 'fluid3d.ll', 'fluid3d_cl.ll']) LL[f.replace(/\.ll$/, '')] = fs.readFileSync(path.join(dir, f), 'utf8');
const m = rd('renderer/src/examples/llc/_gen/_font_data.py').match(/ROWS = \[([\s\S]*?)\]/);
if (!m) throw new Error('找不到 ROWS');
const ROWS = (m[1].match(/0x[0-9A-Fa-f]+/g) || []).map((h) => parseInt(h, 16));
if (ROWS.length !== 95 * 13) throw new Error('字型列數不對：' + ROWS.length);
const body = fs.readFileSync(path.join(__dirname, 'llc_kir_e2e.eval.js'), 'utf8').replace('const SRC = __SRC__;', () => 'const SRC = ' + JSON.stringify({ LL, ROWS }) + ';');
const out = process.argv[2];
if (!out) { console.error('用法：node scripts/eval/llc_kir_e2e.build.js <輸出檔>'); process.exit(2); }
fs.writeFileSync(out, body);
console.log('wrote ' + out + ' (' + body.length + ' bytes)');
