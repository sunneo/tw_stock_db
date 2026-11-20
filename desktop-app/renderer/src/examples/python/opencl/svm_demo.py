"""共享虛擬記憶體（SVM，粗粒度）：numpy 陣列直接建在 SVM 記憶體上，核心就地修改；不需要 Buffer＋enqueue_copy。
標準 pyopencl API（csvm_empty／SVM／map_rw／svm_empty）。"""
import numpy as np
import pyopencl as cl

ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
dev = ctx.devices[0]
print("裝置：", dev.name, "SVM 能力 =", dev.svm_capabilities)

a = cl.csvm_empty(ctx, 1024, np.float32, alignment=64)    # 一個 numpy 陣列，記憶體是 SVM
a[:] = np.arange(1024, dtype=np.float32)

prg = cl.Program(ctx, "__kernel void sq(__global float* x) { int i = get_global_id(0); x[i] = x[i] * x[i]; }").build()
sq = prg.sq                                                # 重複使用同一個 Kernel 物件
sq(queue, (1024,), None, cl.SVM(a))                        # 把 SVM 指標當核心參數
queue.finish()
assert np.allclose(a, np.arange(1024, dtype=np.float32) ** 2)
print("核心就地平方：a[3] =", a[3])

with cl.SVM(a).map_rw(queue) as m:                         # 粗粒度的標準寫法：map 之後才碰主機端
    m[0] = -1
sq(queue, (1024,), None, cl.SVM(a))
queue.finish()
print("主機改過之後再平方：a[0] =", a[0], "（-1 的平方）")
assert a[0] == 1.0

host = np.empty(1024, np.float32)
cl.enqueue_copy(queue, host, cl.SVM(a))                    # SVM → 主機
queue.finish()
assert (host == a).all()

# 指標位移：只處理後半段
half = cl.SVM(a[512:])
sq(queue, (512,), None, half)
queue.finish()
print("後半段多平方一次：a[512] =", a[512], "｜前半段 a[1] =", a[1])
assert a[1] == 1.0 and a[512] == np.float32(512.0) ** 8
print("OK")
