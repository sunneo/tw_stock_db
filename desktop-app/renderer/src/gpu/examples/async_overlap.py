# -*- coding: utf-8 -*-
# CPU 與 GPU 負載分攤的範例：同一段 CPU 迴圈，先「串列」（先等 GPU 矩陣乘，再算 CPU）、再「重疊」
# （提交 GPU 矩陣乘後立刻算 CPU，最後才取結果），比較兩者的牆鐘時間，並檢查結果一致。
# 用 cupy.matmul_async（非同步提交）；沒有非同步支援的環境會退成 numpy 同步計算，結果仍然正確。
import time

import cupy as cp
import numpy as np

N = 128  # 矩陣大小：先用小尺寸，確認可以跑再加大（真機請先估時間）
CPU_ROUNDS = 200000  # CPU 迴圈的次數

rng = np.random.RandomState(7)
A = rng.rand(N, N).astype(np.float64)
B = rng.rand(N, N).astype(np.float64)


def cpu_work():
    s = 0.0
    for i in range(CPU_ROUNDS):
        s += (i % 7) * 0.5
    return s


# 1. 串列：先同步做矩陣乘（等 GPU），再做 CPU 工作
t0 = time.perf_counter()
C_serial = cp.matmul(A, B)
cpu_a = cpu_work()
t_serial = time.perf_counter() - t0

# 2. 重疊：提交矩陣乘後立刻做 CPU 工作，最後才取結果
s = cp.cuda.Stream()
t0 = time.perf_counter()
with s:
    r = cp.matmul_async(A, B)  # 立刻回傳，GPU 在背景跑
cpu_b = cpu_work()             # 這段 CPU 工作和 GPU 同時進行
C_overlap = r.get()            # 只有在這裡才等 GPU
t_overlap = time.perf_counter() - t0

s.synchronize()

print("矩陣乘大小：%d×%d，CPU 迴圈：%d 次" % (N, N, CPU_ROUNDS))
print("串列：%.3f 秒" % t_serial)
print("重疊：%.3f 秒" % t_overlap)
print("結果一致：%s" % bool(np.allclose(C_serial, C_overlap, rtol=1e-9, atol=1e-9)))
print("CPU 結果一致：%s" % (cpu_a == cpu_b))
