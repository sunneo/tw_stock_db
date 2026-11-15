# -*- coding: utf-8 -*-
"""
fa_gpu — GPU 相容層（numba／cupy／torch／pycuda 墊片）的共用核心。
設計見 DESIGN.python-api-bridge.md「GPU 相容層」與 DESIGN.webgpu-cuda.md §6。

- 不 import cudaweb。墊片只呼叫這裡的 call()／info()，由宿主（floating-assistant.js 的 _pyBridgeGpu）
  轉給渲染程序的 cudaweb 執行期（WebGPU／WebGL2／CPU）。
- 傳輸兩種，一份墊片：
  - 桌面版（真的 Python，run_command）：走 fa_bridge 的檔案信箱；大陣列寫成 float32 .bin 放信箱資料夾，只傳路徑。
  - 網頁版（Pyodide）：走 JS 模組 _fa_gpu（不需要技能包橋接開啟）；陣列直接傳 list。
- 真套件存在時一律用真的（find_spec 檢查），不遮蔽：_ShimFinder 只在真套件找不到時才提供墊片。
"""
import importlib.machinery as _mach
import os
import sys
import uuid
from array import array

# 注意：這個模組不能在模組層級 import numpy。安裝（install）與尋找器必須在沒有 numpy 時也能成功；
# numpy 只在 run_kernel 裡需要時才 import（見下方）。網頁版的 numpy 由主機端在執行腳本前先載入。

_SHIM_DIR = os.path.dirname(os.path.abspath(__file__))
SHIM_NAMES = ("numba", "cupy", "torch", "pycuda")
IN_BROWSER = sys.platform == "emscripten"
RPC_DIR = os.environ.get("FA_BRIDGE_RPC", "")
# 測試用：不看真套件，一律用墊片
FORCE_SHIM = os.environ.get("FA_GPU_FORCE_SHIM") == "1"

STATS = {"layer": None, "reason": None, "calls": 0, "ops": {}}
_noted = [False]


class GpuCompatError(RuntimeError):
    """GPU 相容層的錯誤：不支援的寫法、宿主失敗、或這個環境沒有橋接。"""


def _note(layer, reason):
    STATS["layer"] = layer
    STATS["reason"] = reason
    if not _noted[0]:
        _noted[0] = True
        sys.stderr.write("[fa-bridge] CUDA 相容層：目前使用 %s（%s）\n" % (layer, reason))
        sys.stderr.flush()


def _rpc(op, args):
    """送一個 gpu 操作給宿主並回傳結果；失敗丟 GpuCompatError。"""
    if IN_BROWSER:
        import json
        from pyodide.ffi import run_sync
        import _fa_gpu
        data = json.loads(str(run_sync(_fa_gpu.call(op, json.dumps(args)))))
        if not data.get("ok", False):
            raise GpuCompatError(data.get("error") or ("GPU 相容層呼叫失敗：" + op))
        return data.get("result")
    if not RPC_DIR:
        raise GpuCompatError("GPU 相容層在這個環境不可用：沒有 AI 助理的橋接信箱（請在助理的桌面版或網頁版模擬器裡執行）。")
    import fa_bridge
    try:
        return fa_bridge.call("gpu." + op, args)
    except fa_bridge.BridgeError as e:
        raise GpuCompatError(str(e))


def info():
    """回傳宿主的能力資訊（hasWebGPU、hasAdapter、deviceReady、ops…）。"""
    return _rpc("info", {})


def _pack(values):
    """list → 傳輸用的值。桌面版寫成 float32 .bin（只傳路徑與長度），網頁版原樣傳 list。"""
    vals = [float(v) for v in values]
    if not IN_BROWSER and RPC_DIR:
        path = os.path.join(RPC_DIR, "gpu-in-%s.bin" % uuid.uuid4().hex[:12])
        with open(path, "wb") as f:
            f.write(array("f", vals).tobytes())
        return {"bin": path, "n": len(vals)}
    return vals


def _read_bin(path):
    with open(path, "rb") as f:
        data = f.read()
    a = array("f")
    a.frombytes(data)
    return list(a)


def call(op, args):
    """執行一個 cudaweb 操作（名稱與參數同 renderer/src/pybridge/cudaweb.py：vector_add、matmul、sum、axpy、scal、dot、nrm2、gemv）。
    args 裡的 list 會打包；回傳值是 list（陣列結果）或 float（純量）。"""
    payload = {}
    inputs = []
    for k, v in args.items():
        if isinstance(v, (list, tuple)):
            payload[k] = _pack(v)
            if isinstance(payload[k], dict):
                inputs.append(payload[k]["bin"])
        else:
            payload[k] = v
    out = None
    if not IN_BROWSER and RPC_DIR:
        out = os.path.join(RPC_DIR, "gpu-out-%s.bin" % uuid.uuid4().hex[:12])
    try:
        res = _rpc("call", {"op": op, "args": payload, "out_bin": out})
    finally:
        for p in inputs:
            try:
                os.remove(p)
            except OSError:
                pass
    STATS["calls"] += 1
    STATS["ops"][op] = STATS["ops"].get(op, 0) + 1
    _note(res.get("layer", "未知"), res.get("reason", ""))
    value = res.get("result")
    if isinstance(value, dict) and "bin" in value:
        path = value["bin"]
        value = _read_bin(path)
        try:
            os.remove(path)
        except OSError:
            pass
    return value


def note_cpu(reason):
    """墊片在本機 Python 執行（沒有經過 GPU）時呼叫，讓使用者知道這一段不是 GPU。"""
    _note("Python 本機執行（不經過 GPU）", reason)


def note_fallback(reason):
    """numba 核心沒有在 GPU 執行時呼叫：每一次都印出具體原因（不只第一次），讓使用者知道這段沒有用到 GPU。"""
    STATS["fallbacks"] = STATS.get("fallbacks", 0) + 1
    STATS["layer"] = "Python 本機模擬（沒有用到 GPU）"
    STATS["reason"] = reason
    sys.stderr.write("[fa-bridge] 此核心因為 %s 在本機 Python 模擬執行，沒有用到 GPU\n" % reason)
    sys.stderr.flush()


def _np_dtype(name):
    import numpy as np
    return {"f32": np.float32, "i32": np.int32}[name]


def run_kernel(plan, arrays):
    """把轉譯好的 WGSL（numba/wgsl.py 的 Plan）交給宿主在 WebGPU 執行。
    arrays：參數名 → numpy 陣列。回傳 (是否在 GPU 執行, 原因)；成功時，可寫入的陣列已就地更新。"""
    import numpy as np
    items, inputs, outs = [], [], []
    try:
        for b in plan.bindings:
            flat = np.ascontiguousarray(arrays[b["param"]]).reshape(-1)
            dt = _np_dtype(b["dtype"])
            item = {"name": b["wname"], "dtype": b["dtype"], "n": int(flat.size), "write": bool(b["write"]),
                    "atomic": bool(b["atomic"]), "shape": list(b["shape"])}
            if not IN_BROWSER and RPC_DIR:
                uid = uuid.uuid4().hex[:12]
                p = os.path.join(RPC_DIR, "gpu-k-in-%s.bin" % uid)
                with open(p, "wb") as f:
                    f.write(flat.astype(dt).tobytes())
                inputs.append(p)
                item["bin"] = p
                if b["write"]:
                    op = os.path.join(RPC_DIR, "gpu-k-out-%s.bin" % uid)
                    item["out"] = op
                    outs.append((b, op))
            else:
                item["list"] = flat.astype(dt).tolist()
            items.append(item)
        res = _rpc("kernel", {"wgsl": plan.wgsl, "groups": list(plan.groups), "bindings": items})
    except GpuCompatError as e:
        return False, str(e)
    finally:
        for p in inputs:
            try:
                os.remove(p)
            except OSError:
                pass
    STATS["calls"] += 1
    STATS["ops"]["kernel"] = STATS["ops"].get("kernel", 0) + 1
    if not res.get("ran"):
        return False, res.get("reason") or "宿主沒有回報原因"
    for b in plan.bindings:
        if not b["write"]:
            continue
        arr = arrays[b["param"]]
        o = (res.get("outputs") or {}).get(b["wname"]) or {}
        dt = _np_dtype(b["dtype"])
        if "bin" in o:
            with open(o["bin"], "rb") as f:
                vals = np.frombuffer(f.read(), dtype=dt)
            try:
                os.remove(o["bin"])
            except OSError:
                pass
        else:
            vals = np.asarray(o.get("list", []), dtype=dt)
        arr[...] = vals.reshape(arr.shape)
    _note("WebGPU（T1，numba 核心已編譯成 WGSL）", "numba 核心已在 WebGPU 執行")
    return True, ""


# ---------------------------------------------------------------- 墊片的尋找器
class _ShimFinder(object):
    """真套件存在 → 回傳真套件的 spec（不遮蔽）；不存在 → 回傳墊片。只處理最上層名稱，子模組交給父套件的 __path__。"""

    def find_spec(self, fullname, path=None, target=None):
        top = fullname.partition(".")[0]
        if fullname != top or top not in SHIM_NAMES:
            return None
        if not FORCE_SHIM:
            others = [p for p in sys.path if p and os.path.abspath(p) != _SHIM_DIR]
            real = _mach.PathFinder.find_spec(top, others)
            if real is not None:
                return real
        return _mach.PathFinder.find_spec(top, [_SHIM_DIR])


def install():
    """安裝墊片尋找器（可重複呼叫）。"""
    for f in sys.meta_path:
        if isinstance(f, _ShimFinder):
            return
    sys.meta_path.insert(0, _ShimFinder())


def uninstall():
    """拿掉墊片尋找器，並清掉已載入的墊片模組（真套件不受影響）。"""
    sys.meta_path[:] = [f for f in sys.meta_path if not isinstance(f, _ShimFinder)]
    for name in list(sys.modules):
        top = name.partition(".")[0]
        if top in SHIM_NAMES and getattr(sys.modules[name], "__file__", "") and _SHIM_DIR in sys.modules[name].__file__:
            del sys.modules[name]
