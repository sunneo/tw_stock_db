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
import re
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
        try:
            import _fa_gpu
        except ImportError:
            _fa_gpu = None
        if _fa_gpu is None:
            # 圖形工作者（import gui／pygame 的程式在 Worker 裡跑）沒有 _fa_gpu：改走 fa_bridge，頁面端的 gpu.* 分派會接手（同一個 _pyBridgeGpu）
            import fa_bridge
            try:
                return fa_bridge.call("gpu." + op, args)
            except fa_bridge.BridgeError as e:
                raise GpuCompatError(str(e))
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


# ---------------------------------------------------------------- 非同步提交（stream／event）
# call_async 立刻回傳句柄（AsyncHandle）：GPU 工作在宿主背景執行，Python 可以繼續做 CPU 工作；
# 要結果時才 h.wait()，或 synchronize(stream)。宿主協定見 renderer/src/gpu/gpu_async_queue.js。
# 語意與 CUDA 相同：同一個 stream 保序、不同 stream 可重疊、錯誤延遲到等待點丟出（同 stream sticky）。
# 沒有用 call_async 的程式完全不受影響（call 仍是同步）。

_OUTSTANDING = []  # 已提交、尚未 wait 的句柄（提交順序）；佇列滿時拿來等最舊的一筆


def _arpc(name, args):
    """非同步協定的一次往返（submit／wait／query／forget／sync／reset／event_*）。
    網頁版：run_sync(_fa_gpu.aop(...))；這個往返本身很短（submit 不等 GPU），真正的等待只發生在 wait／sync。"""
    if IN_BROWSER:
        import json
        from pyodide.ffi import run_sync
        try:
            import _fa_gpu
        except ImportError:
            _fa_gpu = None
        if _fa_gpu is None:
            import fa_bridge
            try:
                return fa_bridge.call("gpu.a." + name, args)
            except fa_bridge.BridgeError as e:
                raise GpuCompatError(str(e))
        data = json.loads(str(run_sync(_fa_gpu.aop(name, json.dumps(args)))))
        if not data.get("ok", False):
            raise GpuCompatError(data.get("error") or ("GPU 非同步操作失敗：" + name))
        return data.get("result")
    if not RPC_DIR:
        raise GpuCompatError("GPU 相容層在這個環境不可用：沒有 AI 助理的橋接信箱（請在助理的桌面版或網頁版模擬器裡執行）。")
    import fa_bridge
    try:
        return fa_bridge.call("gpu.a." + name, args)
    except fa_bridge.BridgeError as e:
        raise GpuCompatError(str(e))


def _remove_files(paths):
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass


def _finish_value(res, op, out):
    """和 call() 結尾相同：記錄層與統計，並把寫成 bin 的陣列讀回來。"""
    STATS["calls"] += 1
    STATS["ops"][op] = STATS["ops"].get(op, 0) + 1
    _note(res.get("layer", "未知"), res.get("reason", ""))
    value = res.get("result")
    if isinstance(value, dict) and "bin" in value:
        path = value["bin"]
        value = _read_bin(path)
        _remove_files([path])
    return value


class AsyncHandle(object):
    """call_async 回傳的句柄。不持有結果；wait() 才取得結果（或丟出它的錯誤）。可以多次 wait。"""
    __slots__ = ("id", "stream", "_op", "_inputs", "_out", "_state", "_value", "_error")

    def __init__(self, hid, stream, op, inputs, out):
        self.id = hid
        self.stream = stream
        self._op = op
        self._inputs = inputs
        self._out = out
        self._state = "pending"
        self._value = None
        self._error = None

    def done(self):
        """非阻塞查詢：這筆是否已在宿主完成（完成或失敗都算）。"""
        if self._state != "pending":
            return True
        return _arpc("query", {"handle": self.id}) != "pending"

    def wait(self):
        if self._state == "pending":
            try:
                res = _arpc("wait", {"handle": self.id})
                self._value = _finish_value(res, self._op, self._out)
                self._state = "done"
            except Exception as e:  # 宿主回報的錯誤、或讀回失敗：都記在句柄上，之後每次 wait 都丟同一個
                self._error = e
                self._state = "error"
            _remove_files(self._inputs)
            self._inputs = []
            try:
                _OUTSTANDING.remove(self)
            except ValueError:
                pass
            try:
                _arpc("forget", {"handle": self.id})
            except GpuCompatError:
                pass
        if self._state == "error":
            raise self._error
        return self._value


def call_async(op, args, stream=0):
    """call 的非同步版：立刻回傳 AsyncHandle，不等 GPU。取結果用 h.wait()，或 synchronize(stream) 等整條 stream。
    宿主的未完成句柄達上限（64 筆）時，先等最舊的一筆再重試（不會丟錯給使用者）。"""
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
    body = {"op": op, "args": payload, "out_bin": out}
    while True:
        try:
            r = _arpc("submit", {"name": "call", "body": body, "stream": int(stream)})
            break
        except GpuCompatError as e:
            if "佇列已滿" in str(e) and _OUTSTANDING:
                try:
                    _OUTSTANDING[0].wait()  # 最舊的那筆的錯誤會留在它自己的句柄上，不在這裡丟
                except Exception:
                    pass
                continue
            _remove_files(inputs)
            raise
    h = AsyncHandle(r["handle"], r.get("stream", stream), op, inputs, out)
    _OUTSTANDING.append(h)
    return h


def synchronize(stream=None):
    """等指定 stream（None＝全部 stream）的所有已提交操作；宿主的 sticky 錯誤在這裡丟出（GpuCompatError）。"""
    _arpc("sync", {"stream": None if stream is None else int(stream)})


def reset(stream=0):
    """清掉指定 stream 的 sticky 錯誤（出錯後要重新開始時用）。"""
    _arpc("reset", {"stream": int(stream)})


class AsyncEvent(object):
    __slots__ = ("id",)

    def __init__(self, eid):
        self.id = eid


def event_record(stream=0):
    """在 stream 目前的位置記一個事件：事件完成 = 此刻之前已提交的操作全部完成。"""
    return AsyncEvent(_arpc("event_record", {"stream": int(stream)})["event"])


def event_synchronize(ev):
    _arpc("event_sync", {"event": ev.id})


def event_query(ev):
    return bool(_arpc("event_query", {"event": ev.id}))


def elapsed_ms(start, end):
    """兩個已完成事件之間的毫秒數。這是主機牆鐘時間，不是 GPU 時間戳（我沒有實作 GPU 時間戳）。未完成時回傳 NaN。"""
    ms = _arpc("event_elapsed", {"start": start.id, "end": end.id}).get("ms")
    return float("nan") if ms is None else float(ms)


_stream_seq = [0]
_stack = [0]  # with stream 的堆疊；棧頂是目前的 stream（0＝預設 stream）


def current_stream():
    return _stack[-1]


class Stream(object):
    """cupy.cuda.Stream／numba.cuda.stream() 的墊片。null=True 是預設 stream（id 0）。
    with 區塊內，matmul_async 等沒指定 stream 的非同步提交會掛到這條 stream。"""

    def __init__(self, null=False, non_blocking=False, ptds=False):
        if null:
            self._sid = 0
        else:
            _stream_seq[0] += 1
            self._sid = _stream_seq[0]
        self.ptr = self._sid

    def __enter__(self):
        _stack.append(self._sid)
        return self

    def __exit__(self, *a):
        if len(_stack) > 1 and _stack[-1] == self._sid:
            _stack.pop()
        return False

    def use(self):
        return self

    def synchronize(self):
        synchronize(self._sid)

    def record(self, event=None):
        ev = event if event is not None else Event()
        ev.record(self)
        return ev

    def wait_event(self, event):
        """CUDA 的 wait_event 讓 stream 等事件而不阻塞主機；這裡保守地在主機上等事件（結果正確，但會阻塞）。"""
        event.synchronize()


class Event(object):
    """cupy.cuda.Event／numba.cuda.event() 的墊片。record 之後才有意義；未 record 的事件 query 為 True、synchronize 不動作。"""

    def __init__(self, block=False, disable_timing=False, interprocess=False):
        self._ev = None
        self._timing = not disable_timing

    def record(self, stream=None):
        if isinstance(stream, Stream):
            sid = stream._sid
        elif stream is None:
            sid = current_stream()
        else:
            sid = int(stream)
        self._ev = event_record(sid)
        return self

    def synchronize(self):
        if self._ev is not None:
            event_synchronize(self._ev)

    def query(self):
        return True if self._ev is None else event_query(self._ev)

    def elapsed_time(self, end):
        """兩個事件之間的毫秒數（主機牆鐘，不是 GPU 時間戳；見 elapsed_ms）。未 record 回傳 NaN。"""
        if self._ev is None or end._ev is None:
            return float("nan")
        return elapsed_ms(self._ev, end._ev)


def synchronize_all():
    """cupy.cuda.Device.synchronize／numba.cuda.synchronize／torch.cuda.synchronize 共用：
    沒有未完成的非同步操作時什麼都不做（不碰宿主，和以前的行為一樣）；有的話等所有 stream。"""
    if _OUTSTANDING:
        synchronize(None)


def note_cpu(reason):
    """墊片在本機 Python 執行（沒有經過 GPU）時呼叫，讓使用者知道這一段不是 GPU。"""
    _note("Python 本機執行（不經過 GPU）", reason)


def note_precision(text):
    """精度相關的說明（每次執行都印，讓使用者知道結果的精度）。"""
    sys.stderr.write("[fa-bridge] %s\n" % text)
    sys.stderr.flush()


def note_fallback(reason):
    """numba 核心沒有在 GPU 執行時呼叫：每一次都印出具體原因（不只第一次），讓使用者知道這段沒有用到 GPU。"""
    STATS["fallbacks"] = STATS.get("fallbacks", 0) + 1
    STATS["layer"] = "Python 本機模擬（沒有用到 GPU）"
    STATS["reason"] = reason
    sys.stderr.write("[fa-bridge] 此核心因為 %s 在本機 Python 模擬執行，沒有用到 GPU\n" % reason)
    sys.stderr.flush()


def _np_dtype(name):
    """綁定的 WGSL 型別對應到傳輸用的 numpy 型別。dd（雙 float32）以 float32 交錯傳送（hi, lo, hi, lo…）。"""
    import numpy as np
    return {"f32": np.float32, "i32": np.int32, "dd": np.float32}[name]


def _pack_flat(arr, dtname):
    """numpy 陣列 → 傳輸用的一維陣列。dd：float64 拆成 hi（float32）與 lo（float32 的餘數）交錯排列。"""
    import numpy as np
    if dtname == "dd":
        a = np.ascontiguousarray(arr, dtype=np.float64).reshape(-1)
        hi = a.astype(np.float32)
        lo = (a - hi.astype(np.float64)).astype(np.float32)
        return np.stack([hi, lo], axis=1).reshape(-1)
    return np.ascontiguousarray(arr).reshape(-1).astype(_np_dtype(dtname))


def _unpack_flat(vals, dtname, shape):
    """宿主回傳的 float32／int32 一維陣列 → 目標形狀的值（dd 會合併成 float64）。"""
    import numpy as np
    if dtname == "dd":
        v = np.asarray(vals, dtype=np.float32).reshape(-1, 2)
        return (v[:, 0].astype(np.float64) + v[:, 1].astype(np.float64)).reshape(shape)
    return np.asarray(vals, dtype=_np_dtype(dtname)).reshape(shape)


_SHIM_IMPORT_RE = re.compile(r"\bimport\s+[^\n#;]*\b(?:numba|cupy|torch|pycuda)\b|\bfrom\s+(?:numba|cupy|torch|pycuda)\b")


def script_needs_shim(text):
    """腳本是否 import numba／cupy／torch／pycuda（與 renderer/src/gpu/gpu_preload.js 的 scriptNeedsNumpy 用同一條規則）。
    先去掉 # 註解（寧可漏掉也不要誤判）。"""
    code = re.sub(r"#[^\n]*", "", str(text or ""))
    return _SHIM_IMPORT_RE.search(code) is not None


def f64_mode():
    """設定 cudaCompatFloat64（exact／f32／auto）。優先看環境變數 FA_CUDA_F64（桌面版由 fa_run 的 --cuda-f64 設定）；
    否則宿主在 gpu.info 回傳；沒有橋接時回 auto（之後執行會說明橋接不可用）。"""
    env = os.environ.get("FA_CUDA_F64")
    if env in ("exact", "f32", "auto"):
        return env
    try:
        m = str(info().get("f64Mode") or "auto")
    except (GpuCompatError, AttributeError):
        return "auto"
    return m if m in ("exact", "f32", "auto") else "auto"


def run_kernel(plan, arrays, check=None):
    """把轉譯好的 WGSL（numba/wgsl.py 的 Plan）交給宿主在 WebGPU 執行。
    arrays：參數名 → numpy 陣列。check(outs) 若有給，會在寫回前呼叫（outs：參數名 → 結果陣列），回傳 (通過?, 原因)；
    不通過就不寫回，回傳 (False, 原因)。回傳 (是否在 GPU 執行, 原因)；成功時，可寫入的陣列已就地更新。"""
    import numpy as np
    items, inputs, outs = [], [], []
    try:
        for b in plan.bindings:
            flat = _pack_flat(arrays[b["param"]], b["dtype"])
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
    outs_np = {}
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
        outs_np[b["param"]] = _unpack_flat(vals, b["dtype"], arr.shape)
    if check is not None:
        ok, why = check(outs_np)
        if not ok:
            return False, why
    for p, v in outs_np.items():
        arrays[p][...] = v
    _note("WebGPU（T1，numba 核心已編譯成 WGSL）", "numba 核心已在 WebGPU 執行")
    return True, ""


# ---------------------------------------------------------------- 核心原始碼的取得
# 網頁版的助理用 runPythonAsync(字串) 執行使用者腳本：函式沒有檔案，inspect.getsource 必然失敗。
# 所以主機端在執行前把腳本文字登記進來（register_script），找不到時依函式名稱與行號從登記的腳本裡找出來。
_SCRIPTS = []


class SourceUnavailable(RuntimeError):
    """取不到函式原始碼（inspect 與登記的腳本都找不到）。"""


def register_script(text):
    """登記一份腳本原始碼（只留最近 8 份）。主機端在執行使用者腳本前呼叫。"""
    t = str(text or "")
    if not t:
        return
    _SCRIPTS[:] = [s for s in _SCRIPTS if s != t][-7:] + [t]


def _block_from_text(text, name, firstlineno):
    """在腳本文字裡找出名為 name、起始行（含裝飾器）等於 firstlineno 的函式定義，回傳它的原始碼區塊。"""
    import ast
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None
    lines = text.splitlines(True)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            start = min([node.lineno] + [d.lineno for d in node.decorator_list])
            if firstlineno in (start, node.lineno):
                end = getattr(node, "end_lineno", None) or len(lines)
                return "".join(lines[start - 1:end])
    return None


def _code_equal(x, y):
    """兩個 code 物件的位元組碼、名稱與常數都相同（不比行號，因為同一段程式在不同腳本裡行號可能不同）。"""
    import inspect
    if x.co_code != y.co_code or x.co_names != y.co_names or len(x.co_consts) != len(y.co_consts):
        return False
    for a, b in zip(x.co_consts, y.co_consts):
        if inspect.iscode(a) or inspect.iscode(b):
            if not (inspect.iscode(a) and inspect.iscode(b) and _code_equal(a, b)):
                return False
        elif a != b:
            return False
    return True


def _matching_code(block, name):
    import inspect
    import textwrap
    try:
        mod = compile(textwrap.dedent(block), "<fa-kernel-src>", "exec")
    except SyntaxError:
        return None
    for c in mod.co_consts:
        if inspect.iscode(c) and c.co_name == name:
            return c
    return None


def find_kernel_source(fn):
    """取得 Python 函式的原始碼。(a) inspect.getsource；(b) 登記的腳本（從新到舊）：
    先找「名稱、起始行相同、而且編譯後的程式碼與 fn 相同」的區塊，找不到才退回「名稱與起始行相同」的區塊。
    兩者都失敗就丟 SourceUnavailable，並說明原因與解法。"""
    import inspect
    try:
        return inspect.getsource(fn)
    except (OSError, TypeError):
        pass
    code = getattr(fn, "__code__", None)
    if code is not None:
        loose = None
        for text in reversed(_SCRIPTS):
            blk = _block_from_text(text, fn.__name__, code.co_firstlineno)
            if blk is None:
                continue
            same = _matching_code(blk, fn.__name__)
            if same is not None and _code_equal(code, same):
                return blk
            if loose is None:
                loose = blk
        if loose is not None:
            return loose
    raise SourceUnavailable(
        "無法取得核心「%s」的原始碼：檔案來源與登記的腳本都找不到這個函式。"
        "這通常是 python -c、REPL，或程式碼是用 exec／動態產生的。"
        "助理在網頁版是以字串執行腳本，已登記的腳本仍找不到時就會這樣。"
        "解法：把 @cuda.jit 核心直接寫在腳本裡（不要用 exec 或動態產生），或把腳本存成 .py 檔再用 python 執行。" % fn.__name__
    )


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
