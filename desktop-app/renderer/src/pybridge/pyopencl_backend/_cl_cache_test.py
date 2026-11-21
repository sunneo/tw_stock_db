"""跨行程的快取驗證（由 cl_backend_py.test.js 在同一個 FA_CL_CACHE_FILE 下跑兩次）：用法：python3 -I _cl_cache_test.py first|second
第一次：標準寫法 Program(ctx, source).build() 真的編譯（from_cache 是 None）；第二次（全新行程、全新載入器）：同一份 source 直接拿 binary（from_cache＝'bin'）。"""
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if not os.environ.get("FA_OPENCL_HOST") or not shutil.which(os.environ.get("FA_OPENCL_NODE", "node")):
    print("略過：沒有 FA_OPENCL_HOST 或找不到 node\n0 passed, 0 failed")
    sys.exit(0)
import numpy as np  # noqa: E402
import _cl as cl  # noqa: E402

phase = sys.argv[1]
ctx = cl.Context([cl.get_platforms()[0].get_devices()[0]])
queue = cl.CommandQueue(ctx)
src = "__kernel void tw(__global float* x, float s) { int i = get_global_id(0); x[i] = x[i] * s + 1.0f; }"
prg = cl._Program(ctx, src)
prg._build()
if phase == "first":
    assert prg._from_cache is None, prg._from_cache
else:
    assert prg._from_cache == "bin", prg._from_cache
k = cl.Kernel(prg, "tw")
x = np.arange(16, dtype=np.float32)
X = cl.Buffer(ctx, cl.mem_flags.READ_WRITE | cl.mem_flags.COPY_HOST_PTR, hostbuf=x)
k(queue, (16,), None, X, np.float32(3))
out = np.empty_like(x)
cl._enqueue_read_buffer(queue, X, out)
assert (out == x * 3 + 1).all()
print("%s OK（from_cache=%s）" % (phase, prg._from_cache))
cl._get_transport().close()
