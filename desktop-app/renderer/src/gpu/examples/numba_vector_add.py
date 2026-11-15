# -*- coding: utf-8 -*-
# numba.cuda 向量加（NVIDIA 教學的常見寫法，原封不動）：不 import cudaweb，直接 from numba import cuda。
# 在 GPU 相容層下執行：numba 由墊片提供（第一階段在本機 Python 模擬，結果與 numpy 一致）。
import numpy as np
from numba import cuda


@cuda.jit
def add_kernel(x, y, out):
    idx = cuda.grid(1)
    if idx < out.size:
        out[idx] = x[idx] + y[idx]


n = 1000
x = np.arange(n).astype(np.float32)
y = 2 * x
out = np.empty_like(x)

threadsperblock = 128
blockspergrid = (n + (threadsperblock - 1)) // threadsperblock
add_kernel[blockspergrid, threadsperblock](x, y, out)

expected = x + y
print("前 5 個結果：", out[:5].tolist())
print("與 numpy 一致：", bool(np.allclose(out, expected)))
