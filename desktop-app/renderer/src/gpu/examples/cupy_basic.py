# -*- coding: utf-8 -*-
# cupy 的常見寫法（陣列運算、矩陣乘、歸約），原封不動：不 import cudaweb，直接 import cupy。
import cupy as cp
import numpy as np

x = cp.arange(6, dtype=cp.float32)
y = x * 2 + 1
print("四則運算：", cp.asnumpy(y).tolist())

A = cp.asarray(np.arange(12, dtype=np.float32).reshape(3, 4) / 4.0)
B = cp.asarray(np.arange(8, dtype=np.float32).reshape(4, 2) / 4.0)
C = A @ B
print("矩陣乘與 numpy 一致：", bool(np.allclose(cp.asnumpy(C), cp.asnumpy(A) @ cp.asnumpy(B), atol=1e-4)))

v = cp.asarray(np.linspace(0, 1, 50, dtype=np.float32))
print("總和：", round(float(cp.sum(v)), 4), " 平均：", round(float(cp.mean(v)), 4))
print("裝置數：", cp.cuda.runtime.getDeviceCount())
