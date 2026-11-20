"""分塊矩陣乘法：用 __local 記憶體把 16×16 的磁磚搬到工作群共享區再算（經典寫法），結果對照 numpy。"""
import time
import numpy as np
import pyopencl as cl

ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
print("裝置：", ctx.devices[0].name)
mf = cl.mem_flags
T = 16
src = """
#define T %d
__kernel void matmul(__global const float *A, __global const float *B, __global float *C, int N)
{
    __local float As[T][T];
    __local float Bs[T][T];
    int row = get_global_id(1), col = get_global_id(0);
    int ly = get_local_id(1), lx = get_local_id(0);
    float acc = 0.0f;
    for (int t = 0; t < N / T; t++) {
        As[ly][lx] = A[row * N + t * T + lx];
        Bs[ly][lx] = B[(t * T + ly) * N + col];
        barrier(CLK_LOCAL_MEM_FENCE);
        for (int k = 0; k < T; k++) acc += As[ly][k] * Bs[k][lx];
        barrier(CLK_LOCAL_MEM_FENCE);
    }
    C[row * N + col] = acc;
}
""" % T
prg = cl.Program(ctx, src).build()

N = 64
A = np.random.rand(N, N).astype(np.float32)
B = np.random.rand(N, N).astype(np.float32)
A_g = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=A)
B_g = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=B)
C_g = cl.Buffer(ctx, mf.WRITE_ONLY, A.nbytes)
t0 = time.time()
prg.matmul(queue, (N, N), (T, T), A_g, B_g, C_g, np.int32(N))      # 二維 NDRange，工作群 16×16
C = np.empty_like(A)
cl.enqueue_copy(queue, C, C_g)
print("%d×%d 矩陣乘法：%.1f ms" % (N, N, (time.time() - t0) * 1000))
assert np.allclose(C, A @ B, rtol=1e-3, atol=1e-3)
print("OK（與 numpy 一致）")
