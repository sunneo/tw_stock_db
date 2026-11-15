# -*- coding: utf-8 -*-
"""
cupy 墊片（GPU 相容層，第一階段）：以 numpy 為資料容器；熱點（matmul、dot、一維 sum）走 GPU 橋接（cudaweb 的 WebGPU／WebGL2／CPU 層），
其餘運算與不支援的情況退回 numpy。執行時 stderr 會說明目前用的層。真的 cupy 存在時 fa_gpu 會優先用真的。

支援：array／asarray／zeros／ones／arange／empty、四則與 @、matmul／dot、sum／mean／max／min、
exp／log／sqrt／tanh、asnumpy／asarray、cuda.Device、cuda.is_available、cuda.runtime.getDeviceCount。
不支援的名稱呼叫時丟 CupyCompatError，指出建議替代。
"""
import numpy as np

import fa_gpu
from . import cuda  # noqa: F401

__version__ = "0.0.0+fa-gpu-shim"
ndarray = np.ndarray


class CupyCompatError(RuntimeError):
    pass


def _gpu_ok(a):
    """陣列能不能送 GPU：float 的一維或二維、有限數字。"""
    return isinstance(a, np.ndarray) and a.dtype.kind == "f" and a.ndim in (1, 2) and np.all(np.isfinite(a))


def _gpu_or_none(op, args, reason):
    try:
        out = fa_gpu.call(op, args)
    except fa_gpu.GpuCompatError as e:
        fa_gpu.note_cpu("GPU 橋接不可用，改用 numpy：%s" % e)
        return None
    return out


def asarray(obj, dtype=None):
    return np.asarray(obj, dtype=dtype)


def array(obj, dtype=None, copy=True):
    return np.array(obj, dtype=dtype, copy=copy)


def asnumpy(a, stream=None):
    return np.asarray(a)


def zeros(shape, dtype=float):
    return np.zeros(shape, dtype=dtype)


def ones(shape, dtype=float):
    return np.ones(shape, dtype=dtype)


def empty(shape, dtype=float):
    return np.empty(shape, dtype=dtype)


def arange(*a, **k):
    return np.arange(*a, **k)


def matmul(a, b, out=None):
    a = np.asarray(a)
    b = np.asarray(b)
    if a.ndim == 2 and b.ndim == 2 and a.shape[1] == b.shape[0] and _gpu_ok(a) and _gpu_ok(b):
        r = _gpu_or_none("matmul", {"a": a.reshape(-1).tolist(), "b": b.reshape(-1).tolist(),
                                    "m": int(a.shape[0]), "k": int(a.shape[1]), "n": int(b.shape[1])}, "matmul")
        if r is not None:
            res = np.asarray(r, dtype=np.float64).reshape(a.shape[0], b.shape[1])
            if out is not None:
                out[...] = res
                return out
            return res
    return np.matmul(a, b, out=out)


def dot(a, b):
    a = np.asarray(a)
    b = np.asarray(b)
    if a.ndim == 1 and b.ndim == 1 and a.shape == b.shape and _gpu_ok(a) and _gpu_ok(b):
        r = _gpu_or_none("dot", {"x": a.tolist(), "y": b.tolist()}, "dot")
        if r is not None:
            return float(r)
    if a.ndim == 2 and b.ndim == 2:
        return matmul(a, b)
    return np.dot(a, b)


def sum(a, axis=None, dtype=None, keepdims=False):
    a = np.asarray(a)
    if axis is None and a.ndim == 1 and _gpu_ok(a) and not keepdims:
        r = _gpu_or_none("sum", {"a": a.tolist()}, "sum")
        if r is not None:
            return float(r)
    return np.sum(a, axis=axis, dtype=dtype, keepdims=keepdims)


def mean(a, axis=None, dtype=None, keepdims=False):
    return np.mean(np.asarray(a), axis=axis, dtype=dtype, keepdims=keepdims)


def max(a, axis=None, keepdims=False):
    return np.max(np.asarray(a), axis=axis, keepdims=keepdims)


def min(a, axis=None, keepdims=False):
    return np.min(np.asarray(a), axis=axis, keepdims=keepdims)


def exp(a):
    return np.exp(np.asarray(a))


def log(a):
    return np.log(np.asarray(a))


def sqrt(a):
    return np.sqrt(np.asarray(a))


def tanh(a):
    return np.tanh(np.asarray(a))


def __getattr__(name):
    # 其他 cupy 名稱（例如 ElementwiseKernel、RawKernel、cupyx.*）第一階段未支援；dunder 名稱照常丟 AttributeError（給 import 機制用）
    if name.startswith("__"):
        raise AttributeError(name)
    if hasattr(np, name):  # dtype（float32 等）與其他 numpy 同名項目：退回 numpy（資料容器本來就是 numpy）
        return getattr(np, name)
    raise CupyCompatError("cupy.%s 第一階段未支援（建議：用 numpy 同名函式，或改寫為 @numba.cuda.jit 核心）" % name)
