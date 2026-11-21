// node scripts/gen-spv-ll.js — 由 opencl_icd_reduce.ll（OpenCL C 版）產生 SPIR-V 版 opencl_spirv_reduce.ll：核心換成 spv_fixtures.js 的 SPIR-V 位元組，
// clCreateProgramWithSource 換成 clCreateProgramWithIL。同一個歸約核心、同樣的主機流程——差別只在程式從 IL 建立（沒有 OpenCL C 前端的建置）。
const fs = require('fs'), path = require('path');
const A = require('../renderer/src/gpu/spv_asm.js'), F = require('../renderer/src/gpu/spv_fixtures.js');
const dir = path.join(__dirname, '..', 'renderer', 'src', 'examples', 'llc', 'gpgpu');
let ir = fs.readFileSync(path.join(dir, 'opencl_icd_reduce.ll'), 'utf8');
const il = A.assemble(F.REDUCE);
const esc = Array.from(il).map((c) => (c >= 32 && c < 127 && c !== 34 && c !== 92 ? String.fromCharCode(c) : '\\' + c.toString(16).toUpperCase().padStart(2, '0'))).join('');
const cst = '@il = private constant [' + il.length + ' x i8] c"' + esc + '"';
ir = ir.replace(/^@src = .*$/m, cst);
ir = ir.replace('declare ptr @clCreateProgramWithSource(ptr, i32, ptr, ptr, ptr)', 'declare ptr @clCreateProgramWithIL(ptr, ptr, i64, ptr)');
ir = ir.replace('  store ptr @src, ptr %srcp\n  %prog = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %rc)', '  %prog = call ptr @clCreateProgramWithIL(ptr %c, ptr @il, i64 ' + il.length + ', ptr %rc)');
ir = ir.replace(/^; OpenCL 局部記憶體歸約（ICD 模式）.*\n; 第一行註解.*\n; 真機器.*\n/m, '; OpenCL 局部記憶體歸約，核心是 SPIR-V（clCreateProgramWithIL）：不經 OpenCL C 前端，建置時間只剩二進位解碼加轉 JS。\n; 核心的 SPIR-V 由 scripts/gen-spv-ll.js 從 renderer/src/gpu/spv_fixtures.js 的組合語言組成（形狀仿 clang＋llvm-spirv 的輸出）；與 opencl_icd_reduce.ll 同一個核心。\n; "fa-opencl: icd" 註解讓 cl* 呼叫改走 ICD 載入器（IL 程式只有載入器模式支援）。真機器要有支援 OpenCL 2.1+（clCreateProgramWithIL）的驅動。\n');
if (!/clCreateProgramWithIL\(ptr %c/.test(ir) || !/@il = /.test(ir)) { console.error('樣板沒有對上，沒有寫出'); process.exit(1); }
fs.writeFileSync(path.join(dir, 'opencl_spirv_reduce.ll'), ir);
console.log('寫出 opencl_spirv_reduce.ll（SPIR-V ' + il.length + ' 位元組）');
