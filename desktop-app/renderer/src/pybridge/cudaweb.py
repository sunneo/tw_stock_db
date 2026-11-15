# -*- coding: utf-8 -*-
"""
cudaweb — 在 Python 模擬器（Pyodide，網頁版與桌面版共用）裡用瀏覽器 WebGPU 跑的最小核心。

提供：
    cudaweb.vector_add(a, b)     向量加，回傳 list
    cudaweb.matmul(A, B)         矩陣乘，A 為 m×k、B 為 k×n 的二維 list，回傳 m×n 的二維 list
    cudaweb.sum(a)               歸約（總和），回傳 float
    cudaweb.backend_info()       回傳實際使用的層（T1 原生 WGSL、T3 WebGL2、T5 純 JS）、原因、裝置能力與降級紀錄

降級：沒有 WebGPU、介面卡不可用、超過儲存緩衝上限、核心執行失敗時，會自動改用 CPU 參考版計算，
結果仍正確；backend_info() 會說明原因。cudaweb 不會因為沒有 WebGPU 而壞掉。

限制：
    - 只支援 f32；精度與 CUDA 不逐位元相同（累加順序不同），見 DESIGN.webgpu-cuda.md §13。
    - 只能在 Python 模擬器（Pyodide）裡使用；一般的 Python（例如桌面版的 python 指令）會直接報錯並說明。
"""
import sys

_ON_EMSCRIPTEN = sys.platform == "emscripten"


class CudaWebError(RuntimeError):
    """cudaweb 的錯誤：輸入不合法、不在模擬器裡、或宿主回報失敗。"""


def _call(op, args):
    if not _ON_EMSCRIPTEN:
        raise CudaWebError(
            "cudaweb 只能在 Python 模擬器（Pyodide）裡使用；目前是一般的 Python，沒有瀏覽器 WebGPU。"
        )
    import json
    from pyodide.ffi import run_sync
    import _fa_cudaweb
    raw = run_sync(_fa_cudaweb.call(op, json.dumps(args)))
    data = json.loads(str(raw))
    if not data.get("ok", False):
        raise CudaWebError(data.get("error") or ("cudaweb 呼叫失敗：" + op))
    return data.get("result")


def _flat_matrix(M, name):
    """二維 list → (扁平 list, m, n)；檢查是不是矩形。"""
    if not isinstance(M, (list, tuple)) or len(M) == 0:
        raise CudaWebError("cudaweb.matmul：%s 必須是非空的二維 list" % name)
    rows = [list(r) for r in M]
    n = len(rows[0])
    if n == 0 or any(len(r) != n for r in rows):
        raise CudaWebError("cudaweb.matmul：%s 不是矩形（每一列的長度要一樣）" % name)
    flat = []
    for r in rows:
        flat.extend(r)
    return flat, len(rows), n


def vector_add(a, b):
    """向量加：a、b 等長，回傳 a + b（list）。"""
    a = list(a)
    b = list(b)
    if len(a) != len(b):
        raise CudaWebError("cudaweb.vector_add：兩個向量長度不同（%d 與 %d）" % (len(a), len(b)))
    return _call("vector_add", {"a": a, "b": b})


def matmul(A, B):
    """矩陣乘：A 為 m×k、B 為 k×n（二維 list），回傳 m×n（二維 list）。"""
    fa, m, k = _flat_matrix(A, "A")
    fb, k2, n = _flat_matrix(B, "B")
    if k != k2:
        raise CudaWebError("cudaweb.matmul：A 的欄數 %d 與 B 的列數 %d 不符" % (k, k2))
    flat = _call("matmul", {"a": fa, "b": fb, "m": m, "k": k, "n": n})
    return [flat[i * n:(i + 1) * n] for i in range(m)]


def sum(a):
    """歸約：回傳 a 的總和（float）。注意這會遮蓋內建的 sum，請用 cudaweb.sum。"""
    return float(_call("sum", {"a": list(a)}))


def axpy(alpha, x, y):
    """y ← alpha·x + y（逐元素），回傳新的 y（list）。"""
    x = list(x)
    y = list(y)
    if len(x) != len(y):
        raise CudaWebError("cudaweb.axpy：x 與 y 長度不同（%d 與 %d）" % (len(x), len(y)))
    return _call("axpy", {"alpha": float(alpha), "x": x, "y": y})


def scal(alpha, x):
    """x ← alpha·x，回傳新的 x（list）。"""
    return _call("scal", {"alpha": float(alpha), "x": list(x)})


def dot(x, y):
    """內積 x·y（float）。"""
    x = list(x)
    y = list(y)
    if len(x) != len(y):
        raise CudaWebError("cudaweb.dot：x 與 y 長度不同（%d 與 %d）" % (len(x), len(y)))
    return float(_call("dot", {"x": x, "y": y}))


def nrm2(x):
    """2-範數 ‖x‖₂（float）。注意：沒有做參考 BLAS 的縮放，極大或極小的值可能溢位或下溢。"""
    return float(_call("nrm2", {"x": list(x)}))


def gemv(A, x):
    """矩陣乘向量：A 為 m×n 的二維 list、x 長度 n，回傳長度 m 的 list。"""
    fa, m, n = _flat_matrix(A, "A")
    x = list(x)
    if len(x) != n:
        raise CudaWebError("cudaweb.gemv：x 的長度 %d 與 A 的欄數 %d 不符" % (len(x), n))
    return _call("gemv", {"a": fa, "x": x, "m": m, "n": n})


def backend_info():
    """目前的能力與降級狀態：hasWebGPU、hasAdapter、deviceReady、last（最後一次呼叫的層與原因）、degradeLog 等。"""
    return _call("backend_info", {})


class _Cublas(object):
    """cuBLAS 風格的最小介面（DESIGN.webgpu-cuda.md §12.1，第一階段）。
    只支援 sgemm 的 transa='N'、transb='N'、alpha=1、beta=0；其他組合直接報錯，不默默算錯。
    A 為 m×k、B 為 k×n、C 為 m×n，都是列主序的扁平 list（cuBLAS 原本是欄主序與裸指標，這裡用 list 代替，已記錄於設計文件）。
    """

    def sgemm(self, transa, transb, m, n, k, alpha, A, B, beta, C=None):
        if transa != "N" or transb != "N":
            raise CudaWebError("cudaweb.cublas.sgemm：第一階段只支援 transa='N'、transb='N'（收到 %r、%r）" % (transa, transb))
        if float(alpha) != 1.0 or float(beta) != 0.0:
            raise CudaWebError("cudaweb.cublas.sgemm：第一階段只支援 alpha=1、beta=0（收到 alpha=%r、beta=%r）" % (alpha, beta))
        A = list(A)
        B = list(B)
        if len(A) != m * k:
            raise CudaWebError("cudaweb.cublas.sgemm：A 的元素數 %d 與 m×k=%d 不符" % (len(A), m * k))
        if len(B) != k * n:
            raise CudaWebError("cudaweb.cublas.sgemm：B 的元素數 %d 與 k×n=%d 不符" % (len(B), k * n))
        flat = _call("matmul", {"a": A, "b": B, "m": int(m), "k": int(k), "n": int(n)})
        return list(flat)


class _CublasLevel1(object):
    """cuBLAS 第一、二級的最小對應（第二階段）：名稱與參數順序照 cuBLAS，去掉 handle，陣列取代裸指標。"""

    def saxpy(self, n, alpha, x, y):
        if len(list(x)[:n]) != n or len(list(y)[:n]) != n:
            raise CudaWebError("cudaweb.cublas.saxpy：x 與 y 的長度要至少是 n=%d" % n)
        return axpy(alpha, list(x)[:n], list(y)[:n])

    def sscal(self, n, alpha, x):
        if len(list(x)[:n]) != n:
            raise CudaWebError("cudaweb.cublas.sscal：x 的長度要至少是 n=%d" % n)
        return scal(alpha, list(x)[:n])

    def sdot(self, n, x, y):
        if len(list(x)[:n]) != n or len(list(y)[:n]) != n:
            raise CudaWebError("cudaweb.cublas.sdot：x 與 y 的長度要至少是 n=%d" % n)
        return dot(list(x)[:n], list(y)[:n])

    def snrm2(self, n, x):
        if len(list(x)[:n]) != n:
            raise CudaWebError("cudaweb.cublas.snrm2：x 的長度要至少是 n=%d" % n)
        return nrm2(list(x)[:n])

    def sgemv(self, transa, m, n, alpha, A, x, beta, y):
        if transa != "N":
            raise CudaWebError("cudaweb.cublas.sgemv：第二階段只支援 transa='N'（收到 %r）" % (transa,))
        if float(alpha) != 1.0 or float(beta) != 0.0:
            raise CudaWebError("cudaweb.cublas.sgemv：第二階段只支援 alpha=1、beta=0")
        flat = list(A)
        if len(flat) != m * n:
            raise CudaWebError("cudaweb.cublas.sgemv：A 的元素數 %d 與 m×n=%d 不符" % (len(flat), m * n))
        return _call("gemv", {"a": flat, "x": list(x), "m": int(m), "n": int(n)})


cublas = _Cublas()
cublas_l1 = _CublasLevel1()
cublas.saxpy = cublas_l1.saxpy
cublas.sscal = cublas_l1.sscal
cublas.sdot = cublas_l1.sdot
cublas.snrm2 = cublas_l1.snrm2
cublas.sgemv = cublas_l1.sgemv
