# -*- coding: utf-8 -*-
# numba.cuda 矩陣乘（二維 grid）與直方圖（原子加）的常見寫法，原封不動。
import numpy as np
from numba import cuda


@cuda.jit
def matmul(A, B, C):
    row, col = cuda.grid(2)
    if row < C.shape[0] and col < C.shape[1]:
        tmp = 0.0
        for k in range(A.shape[1]):
            tmp += A[row, k] * B[k, col]
        C[row, col] = tmp


@cuda.jit
def histogram(data, out):
    i = cuda.grid(1)
    if i < data.size:
        cuda.atomic.add(out, data[i], 1)


# 矩陣乘：5×7 乘 7×4
A = np.arange(35, dtype=np.float32).reshape(5, 7) / 10.0
B = np.arange(28, dtype=np.float32).reshape(7, 4) / 10.0
C = np.zeros((5, 4), dtype=np.float32)
matmul[(1, 1), (8, 8)](A, B, C)
print("矩陣乘與 numpy 一致：", bool(np.allclose(C, A @ B, atol=1e-4)))

# 直方圖：0 到 9 的整數，共 100 個
data = (np.arange(100) % 10).astype(np.int32)
hist = np.zeros(10, dtype=np.int32)
histogram[4, 32](data, hist)
print("直方圖：", hist.tolist())
print("直方圖與 bincount 一致：", bool(np.array_equal(hist, np.bincount(data, minlength=10))))
