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
