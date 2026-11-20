"""自己寫核心：工作群共享的 __local 記憶體＋barrier。樹狀歸約（每個工作群一個和）與 Hillis–Steele 前綴和。"""
import numpy as np
import pyopencl as cl

ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
print("裝置：", ctx.devices[0].name)
mf = cl.mem_flags

GROUP = 64
src = """
#define GROUP %d
__kernel void group_sum(__global const float *in, __global float *out, int n)
{
    __local float tmp[GROUP];                       // 同一個工作群的所有工作項共享
    int lid = get_local_id(0), gid = get_global_id(0);
    tmp[lid] = gid < n ? in[gid] : 0.0f;
    barrier(CLK_LOCAL_MEM_FENCE);
    for (int s = GROUP / 2; s > 0; s >>= 1) {       // 樹狀歸約
        if (lid < s) tmp[lid] += tmp[lid + s];
        barrier(CLK_LOCAL_MEM_FENCE);
    }
    if (lid == 0) out[get_group_id(0)] = tmp[0];
}

__kernel void scan(__global const int *in, __global int *out, __local int *a, __local int *b)
{
    int lid = get_local_id(0), n = get_local_size(0);
    a[lid] = in[get_global_id(0)];
    barrier(CLK_LOCAL_MEM_FENCE);
    for (int d = 1; d < n; d <<= 1) {               // Hillis–Steele 前綴和
        b[lid] = lid >= d ? a[lid] + a[lid - d] : a[lid];
        barrier(CLK_LOCAL_MEM_FENCE);
        a[lid] = b[lid];
        barrier(CLK_LOCAL_MEM_FENCE);
    }
    out[get_global_id(0)] = a[lid];
}
""" % GROUP
prg = cl.Program(ctx, src).build()

n = 10000
x = np.random.rand(n).astype(np.float32)
groups = (n + GROUP - 1) // GROUP
x_g = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=x)
out_g = cl.Buffer(ctx, mf.WRITE_ONLY, groups * 4)
prg.group_sum(queue, (groups * GROUP,), (GROUP,), x_g, out_g, np.int32(n))
partial = np.empty(groups, dtype=np.float32)
cl.enqueue_copy(queue, partial, out_g)
print("歸約：OpenCL %.4f｜numpy %.4f" % (partial.sum(), x.sum()))
assert np.isclose(partial.sum(), x.sum(), rtol=1e-3)

v = np.random.randint(0, 5, 256).astype(np.int32)
v_g = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=v)
o_g = cl.Buffer(ctx, mf.WRITE_ONLY, v.nbytes)
prg.scan(queue, (256,), (64,), v_g, o_g, cl.LocalMemory(64 * 4), cl.LocalMemory(64 * 4))   # __local 參數用 LocalMemory(位元組數)
res = np.empty_like(v)
cl.enqueue_copy(queue, res, o_g)
want = np.concatenate([np.cumsum(v[i:i + 64]) for i in range(0, 256, 64)])   # 每個工作群各自的前綴和
print("前綴和（每 64 個一組）：", "一致" if np.array_equal(res, want) else "不一致")
assert np.array_equal(res, want)
print("OK")
