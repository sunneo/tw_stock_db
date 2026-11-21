// node scripts/gen-spv-fixtures.js — 把 renderer/src/gpu/spv_fixtures.js 的文字組合語言組成 .spv，寫進 pybridge/pyopencl_backend/fixtures/（Python 的 IL 測試用）
const fs = require('fs'), path = require('path');
const A = require('../renderer/src/gpu/spv_asm.js'), F = require('../renderer/src/gpu/spv_fixtures.js');
const out = path.join(__dirname, '..', 'renderer', 'src', 'pybridge', 'pyopencl_backend', 'fixtures');
fs.mkdirSync(out, { recursive: true });
for (const [name, text] of [['spv_vadd', F.VADD], ['spv_reduce', F.REDUCE]]) { const bin = A.assemble(text); fs.writeFileSync(path.join(out, name + '.spv'), bin); console.log(name + '.spv', bin.length, '位元組'); }

// Python 範例：把 SPIR-V 位元組嵌成 base64（範例必須自己帶 IL；真實流程是 clang＋llvm-spirv 離線產生 .spv 後 open(...).read()）
const ex = path.join(__dirname, '..', 'renderer', 'src', 'examples', 'python', 'opencl', 'spirv_vector_add.py');
const b64 = fs.readFileSync(path.join(out, 'spv_vadd.spv')).toString('base64').match(/.{1,76}/g).map((l) => '    "' + l + '"').join('\n');
const text = `"""SPIR-V 程式（clCreateProgramWithIL）：標準 pyopencl 的寫法——Program(ctx, bytes) 的 bytes 是 SPIR-V，不是原始碼。
IL 程式不經 OpenCL C 前端（建置只剩二進位解碼加轉換）；正式流程是離線用 clang＋llvm-spirv（或 clspv）產生 .spv，再 \`open("k.spv", "rb").read()\`。
這個範例沒有外部檔案，所以把一個向量相加核心的 SPIR-V 以 base64 嵌在下面（由 scripts/gen-spv-fixtures.js 從組合語言產生，形狀仿 clang 的輸出）。"""
import base64
import numpy as np
import pyopencl as cl

SPIRV_VADD = base64.b64decode(
${b64}
)

ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
dev = ctx.devices[0]
print("裝置：", dev.name, "｜IL 版本：", dev.il_version)

prg = cl.Program(ctx, SPIRV_VADD).build()          # bytes＝SPIR-V（標準 pyopencl 用 bytes 區分 IL 與原始碼 str）
print("程式種類：", prg.kind() if hasattr(prg, "kind") else "IL", "｜核心：", prg.kernel_names)

a = np.random.rand(50000).astype(np.float32)
b = np.random.rand(50000).astype(np.float32)
mf = cl.mem_flags
a_g = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=a)
b_g = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=b)
c_g = cl.Buffer(ctx, mf.WRITE_ONLY, a.nbytes)
knl = prg.vadd
knl(queue, a.shape, None, a_g, b_g, c_g, np.uint32(a.size))   # SPIR-V 的 uint 參數：用 numpy.uint32
c = np.empty_like(a)
cl.enqueue_copy(queue, c, c_g)
print("誤差範數：", np.linalg.norm(c - (a + b)))
assert np.array_equal(c, a + b)
print("OK")
`;
fs.writeFileSync(ex, text); console.log('寫出範例', path.relative(process.cwd(), ex));
