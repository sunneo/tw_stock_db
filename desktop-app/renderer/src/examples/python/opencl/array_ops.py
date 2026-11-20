"""pyopencl.array：像 numpy 一樣的陣列運算，在 OpenCL 裝置上做——逐元素、歸約、前綴和、複數、自訂 ElementwiseKernel／ReductionKernel。"""
import numpy as np
import pyopencl as cl
import pyopencl.array as cla
import pyopencl.clmath as clmath
from pyopencl.elementwise import ElementwiseKernel
from pyopencl.reduction import ReductionKernel

ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
print("裝置：", ctx.devices[0].name)
rs = np.random.RandomState(0)


def check(name, got, want, rtol=1e-4, atol=1e-5):
    ok = np.allclose(got, want, rtol=rtol, atol=atol)
    print(("OK   " if ok else "錯誤 ") + name)
    assert ok, name


x = rs.rand(10000).astype(np.float32) * 10 - 5
y = rs.rand(10000).astype(np.float32)
a, b = cla.to_device(queue, x), cla.to_device(queue, y)

# 逐元素
check("a + b", (a + b).get(), x + y)
check("a * 2.5 - b", (a * 2.5 - b).get(), x * 2.5 - y)
check("abs(a)", abs(a).get(), np.abs(x))
check("clmath.sin(a)", clmath.sin(a).get(), np.sin(x))
check("maximum(a, b)", cla.maximum(a, b).get(), np.maximum(x, y))

# 歸約與前綴和（核心用 __local 記憶體與 barrier）
check("sum", cla.sum(a).get(), x.sum(), 1e-3)
check("max / min", [cla.max(a).get(), cla.min(a).get()], [x.max(), x.min()])
check("dot", cla.dot(a, b).get(), np.dot(x, y), 1e-3)
check("cumsum", cla.cumsum(a).get(), np.cumsum(x.astype(np.float64)), 1e-3, 0.05)   # float32 的累加順序與 numpy 的 float64 不同，近零的元素用絕對容差

# 複數
c = (rs.rand(1000) + 1j * rs.rand(1000)).astype(np.complex64)
d = (rs.rand(1000) + 1j * rs.rand(1000)).astype(np.complex64)
cc, dd = cla.to_device(queue, c), cla.to_device(queue, d)
check("複數 c * d", (cc * dd).get(), c * d)
check("複數 c / d", (cc / dd).get(), c / d)
check("abs(複數)", abs(cc).get(), np.abs(c))
check("複數 exp", clmath.exp(cc).get(), np.exp(c))

# 自訂核心（官方文件的 ElementwiseKernel／ReductionKernel）
lin_comb = ElementwiseKernel(ctx, "float a, float *x, float b, float *y, float *z", "z[i] = a*x[i] + b*y[i]", "lin_comb")
z = cla.empty_like(a)
lin_comb(2, a, 3, b, z)
check("ElementwiseKernel lin_comb", z.get(), 2 * x + 3 * y)

dot = ReductionKernel(ctx, np.float32, neutral="0", reduce_expr="a+b", map_expr="x[i]*y[i]",
                      arguments="__global float *x, __global float *y")
check("ReductionKernel dot", dot(a, b).get(), np.dot(x, y), 1e-3)

# 切片與轉置
m = cla.to_device(queue, np.arange(12, dtype=np.float32).reshape(3, 4))
check("轉置", m.T.get(), np.arange(12, dtype=np.float32).reshape(3, 4).T)
check("切片", a[100:200].get(), x[100:200])
print("全部通過")
