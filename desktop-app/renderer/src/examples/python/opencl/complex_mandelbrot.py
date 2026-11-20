"""用複數型別 cfloat_t（pyopencl 的 pyopencl-complex.h）在 OpenCL 裡算曼德博集合，印成字元畫。"""
import numpy as np
import pyopencl as cl

ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
print("裝置：", ctx.devices[0].name)
mf = cl.mem_flags
src = """
#include <pyopencl-complex.h>
__kernel void mandel(__global const cfloat_t *c_in, __global int *count, int max_iter)
{
    int i = get_global_id(0);
    cfloat_t c = c_in[i], z = cfloat_new(0.0f, 0.0f);
    int k = 0;
    while (k < max_iter && cfloat_abs_squared(z) <= 4.0f) {
        z = cfloat_add(cfloat_mul(z, z), c);            // z = z² + c
        k++;
    }
    count[i] = k;
}
"""
prg = cl.Program(ctx, src).build()
W, H = 64, 24
xs = np.linspace(-2.2, 0.8, W, dtype=np.float32)
ys = np.linspace(-1.1, 1.1, H, dtype=np.float32)
c = (xs[None, :] + 1j * ys[:, None]).astype(np.complex64).ravel()
c_g = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=c)
n_g = cl.Buffer(ctx, mf.WRITE_ONLY, c.size * 4)
prg.mandel(queue, (c.size,), None, c_g, n_g, np.int32(40))
count = np.empty(c.size, dtype=np.int32)
cl.enqueue_copy(queue, count, n_g)
chars = " .:-=+*#%@"
for row in count.reshape(H, W):
    print("".join(chars[min(9, k * 10 // 41)] for k in row))
print("集合內的點：%d／%d" % ((count == 40).sum(), count.size))
