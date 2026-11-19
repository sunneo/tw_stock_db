// node scripts/eval/llvm_packed_device.build.js <輸出檔>：內嵌 KIR 模組、新版 llvm_host.js、opencl_vecadd.ll 到 llvm_packed_device.eval.js。
// 執行：FA_EVAL_GL=swiftshader node scripts/eval/run_eval.js <輸出檔>
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SRC = {
    kir: rd('renderer/src/gpu/kir.js'), gen: rd('renderer/src/gpu/kir_gen.js'), webgl: rd('renderer/src/gpu/kir_webgl2.js'),
    front: rd('renderer/src/gpu/cl_front.js'), host: rd('renderer/src/uml/llvm_host.js'),
    vecadd: rd('renderer/src/examples/llc/gpgpu/opencl_vecadd.ll'),
};
const body = fs.readFileSync(path.join(__dirname, 'llvm_packed_device.eval.js'), 'utf8').replace('const SRC = __SRC__;', () => 'const SRC = ' + JSON.stringify(SRC) + ';');
const out = process.argv[2];
if (!out) { console.error('用法：node scripts/eval/llvm_packed_device.build.js <輸出檔>'); process.exit(2); }
fs.writeFileSync(out, body);
console.log('wrote ' + out + ' (' + body.length + ' bytes)');
