# -*- coding: utf-8 -*-
"""
numba.cuda 墊片（GPU 相容層，第一階段）。

支援（與 NVIDIA 教學常見寫法一致）：
    @cuda.jit、@cuda.jit('void(float32[:])')（簽名字串只記錄、不檢查）
    kernel[blocks, threads](args…)，blocks／threads 可為整數或 tuple（最多三維）
    cuda.grid(1|2|3)、cuda.threadIdx／blockIdx／blockDim／gridDim（.x .y .z）
    cuda.syncthreads()、cuda.shared.array(shape, dtype)、cuda.atomic.add(arr, idx, val)
    cuda.to_device、cuda.device_array、cuda.device_array_like、DeviceArray.copy_to_host()
    cuda.is_available()、cuda.synchronize()、cuda.get_current_device()

執行層（誠實說明）：第一階段的核心是在本機 Python 逐執行緒模擬（結果與 numpy 一致），**不經過 GPU**。
把核心編譯成 WGSL 的路線（DESIGN.webgpu-cuda.md §4）尚未接上；執行時 stderr 會說明這一點。
子集外的語法在呼叫時丟 CudaSubsetError，指出第幾行、哪個語法、建議替代寫法，不靜默錯。
"""
import ast
import inspect
import textwrap
import threading

import numpy as np

import fa_gpu

_tls = threading.local()


class CudaSubsetError(RuntimeError):
    """核心使用了第一階段不支援的語法或 API。"""


# ---------------------------------------------------------------- 執行緒內的索引（thread-local）
def _ctx():
    c = getattr(_tls, "ctx", None)
    if c is None:
        raise RuntimeError("cuda.threadIdx／blockIdx 等只能在 @cuda.jit 核心裡使用")
    return c


class _Dim3(object):
    def __init__(self, field):
        self._field = field

    def _get(self, axis):
        v = getattr(_ctx()[self._field], axis)
        return v

    @property
    def x(self):
        return self._get("x")

    @property
    def y(self):
        return self._get("y")

    @property
    def z(self):
        return self._get("z")


class _Triple(object):
    def __init__(self, x=0, y=0, z=0):
        self.x, self.y, self.z = x, y, z


threadIdx = _Dim3("thread")
blockIdx = _Dim3("block")
blockDim = _Dim3("bdim")
gridDim = _Dim3("gdim")


def grid(ndim):
    """全域索引：ndim=1 回傳整數；2、3 回傳 tuple。"""
    c = _ctx()
    t, b, bd = c["thread"], c["block"], c["bdim"]
    xs = [b.x * bd.x + t.x]
    if ndim >= 2:
        xs.append(b.y * bd.y + t.y)
    if ndim >= 3:
        xs.append(b.z * bd.z + t.z)
    return xs[0] if ndim == 1 else tuple(xs)


def syncthreads():
    """區塊屏障。第一階段以順序模擬，核心含 syncthreads 時改用執行緒加屏障（見 _launch）。"""
    c = _ctx()
    bar = c.get("barrier")
    if bar is not None:
        bar.wait()


class _Shared(object):
    def array(self, shape, dtype=np.float32):
        c = _ctx()
        k = c["shared_k"]
        c["shared_k"] = k + 1
        store = c["shared_store"]
        with c["shared_lock"]:
            while len(store) <= k:
                store.append(None)
            if store[k] is None:
                store[k] = np.zeros(shape, dtype=dtype)
        return store[k]


shared = _Shared()


class _Atomic(object):
    def add(self, arr, idx, val):
        with _ATOMIC_LOCK:
            old = arr[idx]
            arr[idx] = old + val
            return old


_ATOMIC_LOCK = threading.Lock()
atomic = _Atomic()


# ---------------------------------------------------------------- 裝置陣列
class DeviceArray(object):
    """裝置上的陣列（第一階段：主機記憶體中的 numpy 陣列，形式與 numba 的 DeviceNDArray 相同）。"""

    def __init__(self, arr):
        self._arr = arr

    @property
    def shape(self):
        return self._arr.shape

    @property
    def dtype(self):
        return self._arr.dtype

    @property
    def size(self):
        return self._arr.size

    def copy_to_host(self, ary=None):
        if ary is None:
            return np.array(self._arr, copy=True)
        ary[...] = self._arr
        return ary

    def __getitem__(self, idx):
        return self._arr[idx]

    def __setitem__(self, idx, val):
        self._arr[idx] = val


def to_device(obj, stream=0):
    return DeviceArray(np.array(obj, copy=True))


def device_array(shape, dtype=np.float32, stream=0):
    return DeviceArray(np.zeros(shape, dtype=dtype))


def device_array_like(ary, stream=0):
    return DeviceArray(np.zeros_like(_unwrap(ary)))


def _unwrap(a):
    return a._arr if isinstance(a, DeviceArray) else a


# ---------------------------------------------------------------- 裝置資訊
def is_available():
    try:
        info = fa_gpu.info()
    except Exception:
        return False
    return bool(info.get("hasAdapter")) if isinstance(info, dict) else False


def synchronize():
    return None


class _Device(object):
    def __init__(self):
        try:
            info = fa_gpu.info()
        except Exception as e:
            info = {"error": str(e)}
        self.id = 0
        self.name = (info.get("adapter") if isinstance(info, dict) else None) or "WebGPU（瀏覽器介面卡）"
        self.info = info

    def __repr__(self):
        return "<fa-gpu device 0: %s>" % self.name


def get_current_device():
    return _Device()


class Device(object):
    """cupy.cuda.Device 的同名介面會用到；numba 也有 cuda.gpus，這裡給最小版。"""

    def __init__(self, device_id=0):
        self.id = device_id

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def use(self):
        return self


# ---------------------------------------------------------------- 核心的子集檢查
_BANNED = {
    ast.Try: "try／except（改用錯誤碼）",
    ast.With: "with（改用直接呼叫）",
    ast.Yield: "yield（改寫為迴圈與預先配置的陣列）",
    ast.YieldFrom: "yield from",
    ast.Lambda: "lambda（改寫為具名的 for／if）",
    ast.ListComp: "列表推導式（改寫為 for 迴圈）",
    ast.SetComp: "集合推導式（改寫為 for 迴圈）",
    ast.DictComp: "字典推導式（改寫為 for 迴圈）",
    ast.GeneratorExp: "產生器運算式（改寫為 for 迴圈）",
    ast.AsyncFunctionDef: "async def",
    ast.ClassDef: "class（核心內不能定義類別）",
    ast.Global: "global",
    ast.Nonlocal: "nonlocal",
    ast.Raise: "raise（改用錯誤碼）",
    ast.Assert: "assert",
}

_ALLOWED_CALLS = {"range", "min", "max", "abs", "int", "float", "len", "round", "bool"}
_ALLOWED_ROOTS = {"cuda", "math"}


def _check_subset(fn_name, src):
    """檢查核心原始碼是否在子集內；不在就丟 CudaSubsetError，訊息帶行號與建議。"""
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        raise CudaSubsetError("核心原始碼解析失敗（%s）：%s" % (fn_name, e))
    fdef = None
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == fn_name:
            fdef = node
            break
    if fdef is None:
        raise CudaSubsetError("找不到核心函式 %s 的定義" % fn_name)
    for node in ast.walk(fdef):
        if isinstance(node, ast.FunctionDef) and node is not fdef:
            raise CudaSubsetError("第 %d 行：核心內不能再定義函式（建議：把它寫成核心的 for／if，或另外用 @cuda.jit(device=True)——後者第一階段不支援）" % node.lineno)
        for cls, msg in _BANNED.items():
            if isinstance(node, cls):
                raise CudaSubsetError("第 %d 行：不支援 %s" % (getattr(node, "lineno", 0), msg))
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name):
                if f.id == fn_name:
                    raise CudaSubsetError("第 %d 行：核心不能遞迴（建議：改用顯式堆疊或迴圈）" % node.lineno)
                if f.id == "print":
                    raise CudaSubsetError("第 %d 行：核心內不支援 print（建議：把結果寫進輸出陣列，在主機端列印）" % node.lineno)
                if f.id not in _ALLOWED_CALLS:
                    raise CudaSubsetError("第 %d 行：未支援呼叫 %s()（建議：用內建的 min／max／abs，或改寫為算術）" % (node.lineno, f.id))
            elif isinstance(f, ast.Attribute):
                root = f
                while isinstance(root, ast.Attribute):
                    root = root.value
                if not (isinstance(root, ast.Name) and root.id in _ALLOWED_ROOTS):
                    raise CudaSubsetError("第 %d 行：未支援呼叫 %s（核心只能用 cuda.* 與 math.*）" % (node.lineno, ast.dump(f)[:60]))
                if isinstance(root, ast.Name) and root.id == "cuda":
                    attr = f.attr
                    ok = {"grid", "syncthreads", "atomic", "shared", "threadIdx", "blockIdx", "blockDim", "gridDim", "const"}
                    # cuda.atomic.add、cuda.shared.array 的屬性鏈由上面的 root 檢查已通過；這裡只擋明顯不支援的頂層名稱
                    if attr not in ok and attr not in ("add", "array"):
                        raise CudaSubsetError("第 %d 行：第一階段未支援 cuda.%s（建議：用 cuda.grid、cuda.syncthreads、cuda.shared.array、cuda.atomic.add）" % (node.lineno, attr))
    return fdef


class _Kernel(object):
    def __init__(self, fn, sig=None):
        self._fn = fn
        self._sig = sig
        self._src = None
        self._checked = False
        self.__name__ = fn.__name__

    def _source(self):
        if self._src is None:
            try:
                raw = inspect.getsource(self._fn)
            except (OSError, TypeError) as e:
                raise CudaSubsetError("無法取得核心原始碼（%s）：這個環境看不到檔案來源；請把核心寫在獨立的 .py 檔裡再執行" % e)
            self._src = textwrap.dedent(raw)
        return self._src

    def __getitem__(self, cfg):
        if not isinstance(cfg, tuple) or len(cfg) != 2:
            raise CudaSubsetError("啟動設定要寫成 kernel[blocks, threads]")
        return _Launcher(self, _dim3(cfg[0]), _dim3(cfg[1]))

    def __call__(self, *a, **k):
        raise CudaSubsetError("核心要用 kernel[blocks, threads](args…) 啟動（與 numba.cuda 相同）")


def _dim3(v):
    if isinstance(v, int):
        return (v, 1, 1)
    t = tuple(int(x) for x in v)
    if not 1 <= len(t) <= 3:
        raise CudaSubsetError("blocks／threads 最多三維")
    return t + (1,) * (3 - len(t))


class _Launcher(object):
    def __init__(self, kern, blocks, threads):
        self._k = kern
        self._b = blocks
        self._t = threads

    def __call__(self, *args):
        k = self._k
        if not k._checked:
            _check_subset(k.__name__, k._source())
            k._checked = True
        real_args = [_unwrap(a) for a in args]
        _launch(k._fn, self._b, self._t, real_args, uses_sync="syncthreads" in k._source())
        fa_gpu.note_cpu("numba.cuda 核心在本機 Python 模擬執行（尚未編譯成 WGSL；結果與 numpy 一致，不經過 GPU）")


def _launch(fn, blocks, threads, args, uses_sync):
    gdim = _Triple(*blocks)
    bdim = _Triple(*threads)
    n_threads = threads[0] * threads[1] * threads[2]
    for bz in range(blocks[2]):
        for by in range(blocks[1]):
            for bx in range(blocks[0]):
                block = _Triple(bx, by, bz)
                shared_store, shared_lock = [], threading.Lock()
                barrier = threading.Barrier(n_threads) if uses_sync and n_threads > 1 else None
                jobs = []
                for tz in range(threads[2]):
                    for ty in range(threads[1]):
                        for tx in range(threads[0]):
                            jobs.append(_Triple(tx, ty, tz))
                if barrier is None:
                    for tid in jobs:
                        _run_one(fn, args, tid, block, bdim, gdim, shared_store, shared_lock, None)
                else:
                    errors = []

                    def runner(tid):
                        try:
                            _run_one(fn, args, tid, block, bdim, gdim, shared_store, shared_lock, barrier)
                        except BaseException as e:  # 讓屏障不會永遠等
                            errors.append(e)
                            barrier.abort()

                    ths = [threading.Thread(target=runner, args=(t,)) for t in jobs]
                    for th in ths:
                        th.start()
                    for th in ths:
                        th.join()
                    if errors:
                        raise errors[0]


def _run_one(fn, args, tid, block, bdim, gdim, shared_store, shared_lock, barrier):
    _tls.ctx = {
        "thread": tid, "block": block, "bdim": bdim, "gdim": gdim,
        "shared_k": 0, "shared_store": shared_store, "shared_lock": shared_lock,
        "barrier": barrier,
    }
    try:
        fn(*args)
    finally:
        _tls.ctx = None


def jit(signature_or_fn=None, **kwargs):
    """@cuda.jit 與 @cuda.jit('簽名')。device=True 第一階段不支援，會在呼叫時說明。"""
    if callable(signature_or_fn):
        return _Kernel(signature_or_fn)

    def deco(fn):
        if kwargs.get("device"):
            raise CudaSubsetError("@cuda.jit(device=True) 第一階段尚未支援（建議：把它的內容直接寫進核心）")
        return _Kernel(fn, signature_or_fn)

    return deco


# numba.cuda 的其他常用名稱，第一階段只提供最少，其餘呼叫時丟出說明（見 __getattr__）
_UNSUPPORTED = {"compile_ptx", "jit_compile", "external_stream", "stream", "event", "pinned"}


def __getattr__(name):
    if name in _UNSUPPORTED:
        raise CudaSubsetError("numba.cuda.%s 第一階段未支援（建議：先用 to_device、copy_to_host 與 @cuda.jit 核心）" % name)
    raise AttributeError("module 'numba.cuda' has no attribute %r" % name)
