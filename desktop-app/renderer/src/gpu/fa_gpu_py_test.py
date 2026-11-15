# -*- coding: utf-8 -*-
# python renderer/src/gpu/fa_gpu_py_test.py
# GPU 相容層（renderer/src/pybridge/fa_gpu.py、numba 墊片、cupy 墊片）的單元測試。
# 假的宿主：照 _pyBridgeGpu 的協定（info、call；陣列用 float32 .bin 信箱檔）實作 cudaweb 的運算，
# 所以測試不需要真的 GPU、不需要 Electron；證明「不 import cudaweb、直接 from numba import cuda 能跑、結果與 numpy 一致」。
import io
import os
import sys
import tempfile
import contextlib
import runpy
from array import array

os.environ["FA_GPU_FORCE_SHIM"] = "1"  # 測試一律用墊片（這台機器的真 numba 因 coverage 套件壞掉而無法載入）

HERE = os.path.dirname(os.path.abspath(__file__))
PYBRIDGE = os.path.join(HERE, "..", "pybridge")
EXAMPLES = os.path.join(HERE, "examples")
sys.path.insert(0, os.path.abspath(PYBRIDGE))

import numpy as np  # noqa: E402
import fa_gpu  # noqa: E402

failures = []
passes = 0


def check(name, fn):
    global passes
    try:
        fn()
        passes += 1
        print("ok   " + name)
    except AssertionError as e:
        failures.append(name)
        print("FAIL " + name + ": " + str(e))
    except Exception as e:  # 非預期錯誤也算失敗，並帶上類型
        failures.append(name)
        print("FAIL " + name + ": " + type(e).__name__ + ": " + str(e))


# ---------------------------------------------------------------- 假的宿主
host_calls = []
host = {"info": {"hasWebGPU": True, "hasAdapter": True, "deviceReady": True, "adapter": "假的 NVIDIA（測試）", "ops": {}},
        "fail": False}


def _read_bin(path):
    with open(path, "rb") as f:
        a = array("f")
        a.frombytes(f.read())
    return list(a)


def _write_bin(path, vals):
    with open(path, "wb") as f:
        f.write(array("f", vals).tobytes())


def fake_rpc(op, args):
    """模擬宿主 _pyBridgeGpu：陣列若是 {bin, n} 就讀 float32 檔，結果若要寫 bin 就寫到 out_bin。"""
    if op == "info":
        return host["info"]
    if op != "call":
        raise AssertionError("未知的 gpu 操作：" + op)
    if host["fail"]:
        raise fa_gpu.GpuCompatError("假的宿主失敗（測試）")
    cop = args["op"]
    a = {}
    for k, v in args["args"].items():
        a[k] = _read_bin(v["bin"]) if isinstance(v, dict) and "bin" in v else v
    host_calls.append(cop)
    if cop == "vector_add":
        res = [x + y for x, y in zip(a["a"], a["b"])]
    elif cop == "matmul":
        m, k, n = a["m"], a["k"], a["n"]
        A, B = a["a"], a["b"]
        res = [sum(A[i * k + t] * B[t * n + j] for t in range(k)) for i in range(m) for j in range(n)]
    elif cop == "sum":
        res = sum(a["a"])
    elif cop == "dot":
        res = sum(x * y for x, y in zip(a["x"], a["y"]))
    else:
        raise fa_gpu.GpuCompatError("假的宿主沒有這個操作：" + cop)
    layer = {"layer": "假的 WGSL（測試）", "reason": "測試宿主"}
    if isinstance(res, list):
        if args.get("out_bin"):
            _write_bin(args["out_bin"], res)
            return dict(layer, result={"bin": args["out_bin"], "n": len(res)})
        return dict(layer, result=res)
    return dict(layer, result=float(res))


fa_gpu._rpc = fake_rpc
fa_gpu.RPC_DIR = ""  # 先用純 list 傳輸；binary 測試會另外設定


def run_example(name):
    """原封不動地執行範例腳本，回傳 (stdout 文字, stderr 文字)。"""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        runpy.run_path(os.path.join(EXAMPLES, name), run_name="__main__")
    return out.getvalue(), err.getvalue()


# ---------------------------------------------------------------- 測試
fa_gpu.install()


def t_no_cudaweb_import():
    run_example("numba_vector_add.py")
    assert "cudaweb" not in sys.modules, "範例執行時不應該 import cudaweb"


def t_vector_add_example():
    out, err = run_example("numba_vector_add.py")
    assert "與 numpy 一致： True" in out, out
    assert "不經過 GPU" in (fa_gpu.STATS["layer"] or ""), fa_gpu.STATS


def t_matmul_hist_example():
    out, _ = run_example("numba_matmul_hist.py")
    assert "矩陣乘與 numpy 一致： True" in out, out
    assert "直方圖與 bincount 一致： True" in out, out


def t_numba_syncthreads_shared():
    from numba import cuda

    @cuda.jit
    def reverse_block(a, out):
        tid = cuda.threadIdx.x
        i = cuda.grid(1)
        s = cuda.shared.array(64, dtype=np.float32)
        s[tid] = a[i]
        cuda.syncthreads()
        out[i] = s[63 - tid]

    a = np.arange(128, dtype=np.float32)
    out = np.zeros_like(a)
    reverse_block[2, 64](a, out)
    expect = np.concatenate([a[:64][::-1], a[64:][::-1]])
    assert np.array_equal(out, expect), out[:8].tolist()


def t_numba_device_arrays():
    from numba import cuda

    @cuda.jit
    def scale(x):
        i = cuda.grid(1)
        if i < x.size:
            x[i] = x[i] * 3.0

    d = cuda.to_device(np.arange(10, dtype=np.float32))
    scale[1, 16](d)
    assert np.allclose(d.copy_to_host(), np.arange(10, dtype=np.float32) * 3.0)
    assert cuda.is_available() is True
    assert "假的 NVIDIA" in cuda.get_current_device().name


def t_subset_errors_are_specific():
    from numba import cuda
    CSE = cuda.CudaSubsetError

    @cuda.jit
    def uses_try(x):
        try:
            x[0] = 1
        except Exception:
            pass

    @cuda.jit
    def uses_print(x):
        print(x[0])

    @cuda.jit
    def uses_unknown(x):
        x[0] = foo(x[0])  # noqa: F821

    for k, want in ((uses_try, "try"), (uses_print, "print"), (uses_unknown, "foo")):
        try:
            k[1, 1](np.zeros(2, dtype=np.float32))
        except CSE as e:
            msg = str(e)
            assert "第" in msg and "行" in msg, msg
            assert want in msg, msg
        else:
            raise AssertionError("應該丟出 CudaSubsetError：" + want)


def t_cupy_matmul_uses_gpu():
    import cupy as cp
    fa_gpu.STATS["ops"].clear()
    A = np.arange(6, dtype=np.float64).reshape(2, 3) / 2.0
    B = np.arange(12, dtype=np.float64).reshape(3, 4) / 3.0
    C = cp.matmul(A, B)
    assert np.allclose(C, A @ B, atol=1e-4), C
    assert fa_gpu.STATS["ops"].get("matmul") == 1, fa_gpu.STATS["ops"]


def t_cupy_example_and_sum():
    out, _ = run_example("cupy_basic.py")
    assert "矩陣乘與 numpy 一致： True" in out, out
    assert "總和：" in out, out


def t_cupy_fallback_when_host_fails():
    import cupy as cp
    host["fail"] = True
    try:
        v = cp.asarray(np.arange(5, dtype=np.float64))
        assert float(cp.sum(v)) == 10.0
    finally:
        host["fail"] = False


def t_binary_transport_roundtrip():
    import cupy as cp
    tmp = tempfile.mkdtemp(prefix="fa-gpu-test-")
    fa_gpu.RPC_DIR = tmp
    try:
        a = np.arange(40, dtype=np.float64) / 8.0
        b = np.ones(40, dtype=np.float64) * 0.5
        r = fa_gpu.call("vector_add", {"a": a.tolist(), "b": b.tolist()})
        assert np.allclose(r, a + b, atol=1e-6), r[:4]
        leftover = [n for n in os.listdir(tmp) if n.endswith(".bin")]
        assert leftover == [], "輸入與輸出的 .bin 應該都清掉，剩下：%s" % leftover
        s = cp.sum(cp.asarray(a))
        assert abs(float(s) - float(a.sum())) < 1e-3
    finally:
        fa_gpu.RPC_DIR = ""


def t_info_and_note_once():
    from numba import cuda
    buf = io.StringIO()
    fa_gpu._noted[0] = False
    with contextlib.redirect_stderr(buf):
        fa_gpu.note_cpu("測試一")
        fa_gpu.note_cpu("測試二")
    assert buf.getvalue().count("CUDA 相容層") == 1, buf.getvalue()
    assert cuda.is_available() is True


def t_finder_real_takes_precedence():
    # 真套件存在時，尋找器回傳真套件的位置（不在墊片資料夾），不遮蔽
    saved = fa_gpu.FORCE_SHIM
    fa_gpu.FORCE_SHIM = False
    try:
        spec = fa_gpu._ShimFinder().find_spec("numpy", None)  # numpy 不在 SHIM_NAMES，應回 None
        assert spec is None
        # 真的 numba 在這台機器上找得到（只看 spec，不執行）：origin 不能指到墊片資料夾
        real = fa_gpu._mach.PathFinder.find_spec("numba", [p for p in sys.path if p and os.path.abspath(p) != fa_gpu._SHIM_DIR])
        got = fa_gpu._ShimFinder().find_spec("numba", None)
        if real is not None:
            assert got is not None and os.path.abspath(got.origin or "") != os.path.abspath(os.path.join(fa_gpu._SHIM_DIR, "numba", "__init__.py")), "真 numba 存在時不應遮蔽"
        else:
            assert got is not None and "pybridge" in (got.origin or "")
    finally:
        fa_gpu.FORCE_SHIM = saved


def t_unsupported_api_message():
    import cupy as cp
    try:
        cp.RawKernel
    except cp.CupyCompatError as e:
        assert "建議" in str(e), str(e)
    else:
        raise AssertionError("RawKernel 應該丟出 CupyCompatError")


for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("")
print("通過 %d 項，失敗 %d 項" % (passes, len(failures)))
if failures:
    print("失敗：" + "、".join(failures))
    sys.exit(1)
