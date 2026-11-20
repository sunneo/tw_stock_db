"""N 體引力：用 float4（x、y、z＋質量）緩衝區與向量運算（dot、rsqrt、純量×向量）。每個工作項掃過所有天體，結果對照 numpy。"""
import numpy as np
import pyopencl as cl
import pyopencl.cltypes as cltypes

ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
print("裝置：", ctx.devices[0].name)
mf = cl.mem_flags
src = """
__kernel void accel(__global const float4 *pos, __global float4 *acc, int n, float eps)
{
    int i = get_global_id(0);
    float4 pi = pos[i];
    float4 a = (float4)(0.0f);
    for (int j = 0; j < n; j++) {
        float4 d = pos[j] - pi;                         // 向量相減（w 分量是質量差，不用）
        float r2 = dot(d.xyz, d.xyz) + eps;
        float inv = rsqrt(r2);
        a += pos[j].w * (inv * inv * inv) * d;          // 純量 × 向量
    }
    acc[i] = a;
}
"""
prg = cl.Program(ctx, src).build()
n = 128
rs = np.random.RandomState(1)
pos = np.zeros(n, dtype=cltypes.float4)
pos["x"], pos["y"], pos["z"], pos["w"] = rs.randn(n), rs.randn(n), rs.randn(n), rs.rand(n) + 0.5
pos_g = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=pos)
acc_g = cl.Buffer(ctx, mf.WRITE_ONLY, pos.nbytes)
prg.accel(queue, (n,), None, pos_g, acc_g, np.int32(n), np.float32(1e-3))
acc = np.empty_like(pos)
cl.enqueue_copy(queue, acc, acc_g)

P = np.stack([pos["x"], pos["y"], pos["z"]], 1).astype(np.float64)
M = pos["w"].astype(np.float64)
want = np.zeros_like(P)
for i in range(n):
    d = P - P[i]
    r2 = (d * d).sum(1) + 1e-3
    want[i] = ((M * r2 ** -1.5)[:, None] * d).sum(0)
got = np.stack([acc["x"], acc["y"], acc["z"]], 1)
print("最大相對誤差：%.2e" % (np.abs(got - want).max() / np.abs(want).max()))
assert np.allclose(got, want, rtol=1e-3, atol=1e-3)
print("OK")
