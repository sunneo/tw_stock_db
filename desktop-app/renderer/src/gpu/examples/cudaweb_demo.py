# -*- coding: utf-8 -*-
# cudaweb 範例：在 Python 模擬器（Pyodide）裡跑向量加、矩陣乘、歸約，並印出實際用的層與降級原因。
# 有 WebGPU 時走 T1（原生 WGSL）；沒有時自動降到 T4（CPU 參考版），結果一樣正確，只是 backend_info() 會說明原因。
import cudaweb

a = [1.0, 2.0, 3.0, 4.0]
b = [10.0, 20.0, 30.0, 40.0]
print("vector_add:", cudaweb.vector_add(a, b))

A = [[1, 2, 3], [4, 5, 6]]
B = [[7, 8], [9, 10], [11, 12]]
print("matmul:", cudaweb.matmul(A, B))

data = [float(i) for i in range(1, 1001)]
print("sum(1..1000):", cudaweb.sum(data))

info = cudaweb.backend_info()
last = info.get("last") or {}
print("層:", last.get("layer"), "| 方式:", last.get("via"))
if last.get("reason"):
    print("降級原因:", last.get("reason"))
print("有 WebGPU:", info.get("hasWebGPU"), "| 有介面卡:", info.get("hasAdapter"))
