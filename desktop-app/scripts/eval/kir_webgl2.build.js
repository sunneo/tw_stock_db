// node scripts/eval/kir_webgl2.build.js <輸出檔>：把 KIR 模組、OpenCL 核心原始碼（取自 kir_test.js）與 cl_front.js 內嵌進
// scripts/eval/kir_webgl2.eval.js，產生可以用 FA_DEBUG_EVAL_FILE 在真 Electron 執行的檔案（不依賴 embed 流程）。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const test = rd('renderer/src/gpu/kir_test.js');
const grab = (name) => { const m = test.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;')); if (!m) throw new Error('找不到 ' + name); return m[1]; };
const SRC = {
    kir: rd('renderer/src/gpu/kir.js'),
    gen: rd('renderer/src/gpu/kir_gen.js'),
    webgl: rd('renderer/src/gpu/kir_webgl2.js'),
    front: rd('renderer/src/gpu/cl_front.js'),
    nbody: grab('NBODY_CL'),
    sph: grab('SPH_CL'),
};
const body = rd('scripts/eval/kir_webgl2.eval.js').replace('const SRC = __SRC__;', () => 'const SRC = ' + JSON.stringify(SRC) + ';');
const out = process.argv[2];
if (!out) { console.error('用法：node scripts/eval/kir_webgl2.build.js <輸出檔>'); process.exit(2); }
fs.writeFileSync(out, body);
console.log('wrote ' + out + ' (' + body.length + ' bytes)');
