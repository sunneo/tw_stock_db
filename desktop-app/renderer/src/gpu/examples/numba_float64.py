# -*- coding: utf-8 -*-
# numba.cuda 的 float64（Python 預設）核心：陣列與常數都是 float64，寫法不用改成 float32。
# 設定 cudaCompatFloat64：auto（預設，雙 float32 在 GPU 跑）／f32（精度降為 float32）／exact（不用 GPU）。
import numpy as np
from numba import cuda


@cuda.jit
def scale_add(x, y, out):
    i = cuda.grid(1)
    if i < out.size:
        out[i] = x[i] * 2.5 + y[i] - 0.125


n = 8
x = cuda.to_device(np.arange(1.0, n + 1.0))
y = cuda.to_device(np.linspace(0.1, 0.8, n))
out = cuda.device_array(n)
scale_add[1, n](x, y, out)

res = out.copy_to_host()
expect = np.arange(1.0, n + 1.0) * 2.5 + np.linspace(0.1, 0.8, n) - 0.125
print("與 numpy 一致：", bool(np.allclose(res, expect, rtol=1e-12, atol=1e-12)))
