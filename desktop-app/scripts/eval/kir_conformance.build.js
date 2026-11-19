// node scripts/eval/kir_conformance.build.js <輸出檔>：把 KIR 模組（kir、kir_gen、kir_webgl2、kir_webgpu、cl_front）與一致性案例
// （kir_conformance_cases.js）內嵌到 kir_conformance.eval.js。
// 執行：FA_EVAL_GL=gpu FA_EVAL_TIMEOUT_MS=600000 node scripts/eval/run_eval.js <輸出檔> 17994
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SRC = {
    kir: rd('renderer/src/gpu/kir.js'), gen: rd('renderer/src/gpu/kir_gen.js'), webgl: rd('renderer/src/gpu/kir_webgl2.js'),
    webgpu: rd('renderer/src/gpu/kir_webgpu.js'), front: rd('renderer/src/gpu/cl_front.js'), cases: rd('renderer/src/gpu/kir_conformance_cases.js')
};
const body = fs.readFileSync(path.join(__dirname, 'kir_conformance.eval.js'), 'utf8').replace('const SRC = __SRC__;', () => 'const SRC = ' + JSON.stringify(SRC) + ';');
const out = process.argv[2];
if (!out) { console.error('用法：node scripts/eval/kir_conformance.build.js <輸出檔>'); process.exit(2); }
fs.writeFileSync(out, body);
console.log('wrote ' + out + ' (' + body.length + ' bytes)');
