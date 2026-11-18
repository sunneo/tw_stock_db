# -*- coding: utf-8 -*-
# cudaweb 範例：使用者自己的運算經過 cudaweb 的入口（sum、dot、matmul）時拿到的核心，以及降級原因。
# 有 WebGPU 時走 T1（原生 WGSL）；沒有就自動降到 T4（CPU 參考），結果一樣正確。
# 注意：這裡只用橋接已有的入口。自訂核心的 reduce／transpose／scan 樣板（kernel_templates.js）尚未接進 Python 入口，
# 目前 cudaweb.py 沒有 transpose 與 scan；要用的話請看 gpu/examples/custom_kernel_templates.js。
import cudaweb

x = [float(i) for i in range(1, 1001)]
y = [0.5] * 1000
print("sum(1..1000) =", cudaweb.sum(x))
print("dot(x, y) =", cudaweb.dot(x, y))

A = [[1.0, 2.0], [3.0, 4.0]]
B = [[5.0, 6.0], [7.0, 8.0]]
print("matmul =", cudaweb.matmul(A, B))

info = cudaweb.backend_info()
last = info.get("last") or {}
print("層:", last.get("layer"), "| 方式:", last.get("via"))
if last.get("reason"):
    print("降級原因:", last.get("reason"))
# 效能：這個檔案沒有量時間。優化前後的數字要在真 GPU 上量，並標明硬體。
