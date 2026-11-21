# -*- coding: utf-8 -*-
"""numba.cuda 核心 → OpenCL C → pyopencl 後端（wasm）的差分測試：同一份 Python 核心，一份交給 numba/cuda.py 的 Python 逐執行緒模擬（_launch），一份走 CPU 原生路線（_try_native），結果要一致。
用法：FA_OPENCL_HOST=<cl_host_stdio.js> FA_CL_DRIVERS=clc python3 -I numba/openclc_test.py   （沒有 node 或沒設環境變數就略過）"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if not os.environ.get("FA_OPENCL_HOST") or not shutil.which(os.environ.get("FA_OPENCL_NODE", "node")):
    print("略過：沒有 FA_OPENCL_HOST 或找不到 node\n0 passed, 0 failed")
    sys.exit(0)
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "pyopencl_backend"))
import math  # noqa: E402,F401
import numpy as np  # noqa: E402
from numba import cuda  # noqa: E402
import numba.cuda as C  # noqa: E402
from numba import openclc  # noqa: E402

passed = failed = 0


def t(name):
    def deco(fn):
        global passed, failed
        try:
            fn()
            passed += 1
        except Exception:  # noqa: BLE001
            failed += 1
            import traceback
            print("FAIL " + name + "\n   " + "\n   ".join(traceback.format_exc().splitlines()[-6:]))
        return fn
    return deco


def both(kern, blocks, threads, mk, tol=1e-5):
    """模擬與原生各跑一次，逐陣列比對；原生必須真的跑起來（_try_native 回 True）。"""
    a, b = mk(), mk()
    blocks, threads = C._dim3(blocks), C._dim3(threads)
    C._launch(kern._fn, blocks, threads, a, uses_sync=False)
    assert C._try_native(kern, blocks, threads, b, "測試"), "原生路線沒有執行：%s／%s" % (C._NATIVE.get("why"), C._NATIVE.get("error"))
    for x, y in zip(a, b):
        if isinstance(x, np.ndarray):
            assert np.allclose(x, y, rtol=tol, atol=tol, equal_nan=True), "結果不同：\n%s\n%s" % (x.reshape(-1)[:12], y.reshape(-1)[:12])
    return b


@cuda.jit
def saxpy(y, x, a):
    i = cuda.grid(1)
    if i < x.size:
        y[i] = a * x[i] + y[i]


@cuda.jit
def add2d(out, p, q):
    x, y = cuda.grid(2)
    if x < out.shape[1] and y < out.shape[0]:
        out[y, x] = p[y, x] + q[y, x] * 2.0


@cuda.jit
def f64k(d, x):
    i = cuda.grid(1)
    if i < d.size:
        d[i] = x[i] * x[i] + 1.0 / 3.0


@cuda.jit
def pyint(r, q):
    i = cuda.grid(1)
    if i < r.size:
        r[i] = (i - 5) // 3 + (i - 5) % 3 * 10 + (-i) % 4
        q[i] = (i - 5.5) // 2.0 + (i - 5.5) % 2.0


@cuda.jit
def loops(out, x, n):
    i = cuda.grid(1)
    if i < out.size:
        s = 0.0
        for j in range(n):
            if j == 5:
                continue
            if j > 12:
                break
            s += x[(i + j) % x.size]
        k = 0
        while k < i:
            s += 0.5
            k += 2
        for m in range(10, 0, -3):
            s -= m
        out[i] = s


@cuda.jit
def maths(o, x):
    i = cuda.grid(1)
    if i < o.size:
        v = x[i]
        o[i] = math.sqrt(math.fabs(v)) + math.floor(v) + v ** 2 + math.exp(-v * v) + min(v, 1.5) + max(v, -1.5) + abs(v)


@cuda.jit
def conds(o, x):
    i = cuda.grid(1)
    if i < o.size:
        v = x[i]
        if (v > 0.0 and v < 3.0) or not (v > -2.0):
            o[i] = 1.0 if v > 1.0 else -1.0
        else:
            o[i] = v


@cuda.jit
def hist(bins, data):
    i = cuda.grid(1)
    if i < data.size:
        cuda.atomic.add(bins, data[i] % 4, 1)


@cuda.jit
def idx3(o):
    i = cuda.blockIdx.x * cuda.blockDim.x + cuda.threadIdx.x
    if i < o.size:
        o[i] = cuda.threadIdx.x * 100 + cuda.blockIdx.x * 10 + cuda.blockDim.x


@cuda.jit
def shared_sync(o):
    t_ = cuda.shared.array(8, dtype=np.float32)
    i = cuda.threadIdx.x
    t_[i] = i
    cuda.syncthreads()
    o[i] = t_[(i + 1) % 8]


@t("一維 saxpy（float32 陣列＋Python float 純量，numba 的 float64 中間值）")
def _():
    both(saxpy, (4,), (32,), lambda: [np.arange(100, dtype=np.float32), np.linspace(-3, 3, 100).astype(np.float32), 2.5])


@t("二維網格與二維陣列索引、arr.shape")
def _():
    rs = np.random.RandomState(3)
    both(add2d, (3, 2), (8, 8), lambda: [np.zeros((13, 21), np.float32), rs.rand(13, 21).astype(np.float32), np.ones((13, 21), np.float32)] if False else [np.zeros((13, 21), np.float32), np.arange(273, dtype=np.float32).reshape(13, 21), np.ones((13, 21), np.float32)])


@cuda.jit
def int64k(o, a):
    i = cuda.grid(1)
    if i < o.size:
        o[i] = a[i] * 3 + i


@t("float64 陣列原生精確（cudaCompatFloat64=exact 也能跑；結果與 Python 逐位元相同）")
def _():
    x = np.linspace(-2, 2, 64)
    r = both(f64k, (2,), (32,), lambda: [np.zeros(64, np.float64), x.copy()], tol=0)
    assert np.array_equal(r[0], x * x + 1.0 / 3.0)


@t("Python 語意：整數與浮點的 // 向下取整、% 的符號跟除數（負數也對）")
def _():
    both(pyint, (1,), (16,), lambda: [np.zeros(16, np.int64), np.zeros(16, np.float64)], tol=0)


@t("迴圈：for／range 含負步長、while、break／continue、擴充賦值")
def _():
    both(loops, (1,), (16,), lambda: [np.zeros(16, np.float32), np.arange(40, dtype=np.float32) * 0.25, 20])


@t("math.*、min／max／abs／**、numba 的型別提升")
def _():
    both(maths, (1,), (16,), lambda: [np.zeros(16, np.float32), np.linspace(-2.5, 2.5, 16).astype(np.float32)], tol=1e-4)


@t("條件：and／or／not、?:")
def _():
    both(conds, (1,), (16,), lambda: [np.zeros(16, np.float32), np.linspace(-4, 4, 16).astype(np.float32)])


@t("cuda.atomic.add（int32 直方圖）；threadIdx／blockIdx／blockDim")
def _():
    both(hist, (4,), (25,), lambda: [np.zeros(4, np.int32), np.arange(100, dtype=np.int32)])
    both(idx3, (3,), (8,), lambda: [np.zeros(24, np.int32)])


@t("int64 陣列")
def _():
    both(int64k, (2,), (16,), lambda: [np.zeros(32, np.int64), np.arange(32, dtype=np.int64) * 1000003])


@t("不能轉譯的核心（shared＋syncthreads）明確回 NotCL 並退回 Python 模擬")
def _():
    try:
        openclc.compile_kernel("shared_sync", shared_sync._source(), [np.zeros(8, np.float32)], (1,), (8,))
    except openclc.NotCL as e:
        assert "shared" in str(e) or "不支援" in str(e) or "呼叫" in str(e), str(e)
    else:
        raise AssertionError("shared／syncthreads 應該被拒絕")
    o = np.zeros(8, np.float32)
    assert not C._try_native(shared_sync, C._dim3((1,)), C._dim3((8,)), [o], "測試")
    C._launch(shared_sync._fn, C._dim3((1,)), C._dim3((8,)), [o], uses_sync=True)
    assert o.tolist() == [1, 2, 3, 4, 5, 6, 7, 0]


@t("轉譯後的 OpenCL C 長相（有 pfdiv／pmod、型別宣告、__global const 標示唯讀）")
def _():
    p = openclc.compile_kernel("saxpy", saxpy._source(), [np.zeros(4, np.float32), np.zeros(4, np.float32), 2.0], (1,), (4,))
    assert "__global float* y" in p["code"] and "__global const float* x" in p["code"] and "double a" in p["code"] and p["writes"] == {"y"} and p["global"] == (4,)


print("%d passed, %d failed" % (passed, failed))
try:
    import _cl
    _cl._get_transport().close()
except Exception:  # noqa: BLE001
    pass
sys.exit(1 if failed else 0)
