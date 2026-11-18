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
host = {"info": {"hasWebGPU": True, "hasAdapter": True, "deviceReady": True, "adapter": "假的 NVIDIA（測試）", "ops": {}, "f64Mode": "auto"},
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
    if op == "kernel":
        # 任意核心（WGSL）：測試宿主不能執行 WGSL，由測試提供的 kernel_impl 用 numpy 代為計算（只驗證傳輸與寫回）
        if host.get("kernel_impl") is None:
            return {"ran": False, "layer": "CPU", "reason": "測試宿主沒有實作 kernel", "outputs": {}}
        return host["kernel_impl"](args)
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
from numba import cuda  # noqa: E402  （讓測試裡的核心原始碼能在模擬中找到 cuda）


def t_no_cudaweb_import():
    run_example("numba_vector_add.py")
    assert "cudaweb" not in sys.modules, "範例執行時不應該 import cudaweb"


def t_vector_add_example():
    out, err = run_example("numba_vector_add.py")
    assert "與 numpy 一致： True" in out, out
    assert "沒有用到 GPU" in (fa_gpu.STATS["layer"] or ""), fa_gpu.STATS


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


def t_torch_example_trains():
    out, _ = run_example("torch_mlp_train.py")
    assert "最後損失低於第一輪： True" in out, out
    assert "訓練準確率 ≥ 0.8： True" in out, out


def t_torch_grad_check_mse():
    import torch
    torch.manual_seed(1)
    lin = torch.nn.Linear(3, 2)
    x = torch.tensor(np.random.RandomState(2).randn(5, 3))
    t = torch.tensor(np.random.RandomState(3).randn(5, 2))
    loss = torch.nn.functional.mse_loss(lin(x), t)
    loss.backward()
    g_auto = np.array(lin.weight.grad, copy=True)
    W = lin.weight.data.copy()
    eps = 1e-3
    g_num = np.zeros_like(W)
    for i in range(W.shape[0]):
        for j in range(W.shape[1]):
            vals = []
            for sgn in (1.0, -1.0):
                Wp = W.copy()
                Wp[i, j] += sgn * eps
                lin.weight.data[...] = Wp
                vals.append(float(torch.nn.functional.mse_loss(lin(x), t).item()))
            g_num[i, j] = (vals[0] - vals[1]) / (2 * eps)
    lin.weight.data[...] = W
    assert np.allclose(g_auto, g_num, atol=2e-3), (g_auto, g_num)


def t_torch_grad_check_cross_entropy():
    import torch
    rs = np.random.RandomState(4)
    logits = torch.tensor(rs.randn(6, 4), requires_grad=True)
    labels = torch.tensor(rs.randint(0, 4, size=6))
    loss = torch.nn.functional.cross_entropy(logits, labels)
    loss.backward()
    g_auto = np.array(logits.grad, copy=True)
    L = logits.data.copy()
    eps = 1e-3
    g_num = np.zeros_like(L)
    for i in range(L.shape[0]):
        for j in range(L.shape[1]):
            vals = []
            for sgn in (1.0, -1.0):
                Lp = L.copy()
                Lp[i, j] += sgn * eps
                logits.data[...] = Lp
                vals.append(float(torch.nn.functional.cross_entropy(logits, labels).item()))
            g_num[i, j] = (vals[0] - vals[1]) / (2 * eps)
    logits.data[...] = L
    assert np.allclose(g_auto, g_num, atol=2e-3), (g_auto, g_num)


def t_torch_cuda_flags_and_matmul_gpu():
    import torch
    fa_gpu.STATS["ops"].clear()
    assert torch.cuda.is_available() is True
    assert torch.cuda.device_count() == 1
    m = torch.nn.Linear(2, 2).to("cuda")
    assert m.weight.device == "cuda"
    a = torch.tensor(np.ones((2, 3))).to("cuda")
    b = torch.tensor(np.ones((3, 2))).to("cuda")
    c = a @ b
    assert np.allclose(c.numpy(), 3.0)
    assert fa_gpu.STATS["ops"].get("matmul") == 1, fa_gpu.STATS["ops"]


def t_torch_unsupported_names_explain():
    import torch
    try:
        torch.compile
    except torch.TorchCompatError as e:
        assert "未支援：torch.compile" in str(e) and "建議" in str(e), str(e)
    else:
        raise AssertionError("torch.compile 應該丟出 TorchCompatError")


def t_pycuda_memcpy_roundtrip_and_source_refused():
    import pycuda.autoinit  # noqa: F401
    import pycuda.driver as drv
    from pycuda.compiler import SourceModule, CompileUnsupported
    src = np.arange(10, dtype=np.float32)
    dev = drv.mem_alloc(src.nbytes)
    drv.memcpy_htod(dev, src)
    back = np.zeros_like(src)
    drv.memcpy_dtoh(back, dev)
    assert np.array_equal(back, src)
    try:
        SourceModule("__global__ void f(){}")
    except CompileUnsupported as e:
        assert "@cuda.jit" in str(e), str(e)
    else:
        raise AssertionError("SourceModule 應該回報不支援")


# ---------------------------------------------------------------- 安裝清單涵蓋所有墊片目錄（web 與桌面）
PYBRIDGE_DIR = os.path.abspath(os.path.join(HERE, "..", "pybridge"))
JS_SRC = os.path.abspath(os.path.join(HERE, "..", "floating-assistant.js"))


def _embedded_map():
    import json
    src = io.open(JS_SRC, encoding="utf-8").read()
    a = src.index("const FA_PYBRIDGE_FILES = ") + len("const FA_PYBRIDGE_FILES = ")
    b = src.index(";\n/* PYBRIDGE-END */", a)
    return json.loads(src[a:b]), src


def _scan_py_files(base):
    out = []
    for dp, dns, fns in os.walk(base):
        dns[:] = [d for d in dns if d != "__pycache__"]
        for fn in fns:
            if fn.endswith(".py"):
                out.append(os.path.relpath(os.path.join(dp, fn), base).replace(os.sep, "/"))
    return sorted(out)


def t_shim_dirs_scan_matches_js_list_and_embed():
    import re
    emb, src = _embedded_map()
    scanned = sorted(n for n in fa_gpu.SHIM_NAMES if os.path.isfile(os.path.join(PYBRIDGE_DIR, n, "__init__.py")))
    assert scanned == sorted(fa_gpu.SHIM_NAMES), "pybridge 下缺墊片目錄：%s" % scanned
    m = re.search(r"FA_GPU_SHIM_DIRS = \[([^\]]*)\]", src)
    assert m, "floating-assistant.js 找不到 FA_GPU_SHIM_DIRS"
    js_dirs = sorted(re.findall(r"'([A-Za-z_]+)'", m.group(1)))
    assert js_dirs == scanned, "FA_GPU_SHIM_DIRS 與目錄掃描不一致：js=%s 掃描=%s" % (js_dirs, scanned)
    for rel in _scan_py_files(PYBRIDGE_DIR):
        top = rel.split("/")[0]
        if rel != "fa_gpu.py" and top not in fa_gpu.SHIM_NAMES:
            continue
        assert rel in emb, "嵌入清單漏了 %s（重新執行 node scripts/embed-code-ui.js）" % rel
        disk = io.open(os.path.join(PYBRIDGE_DIR, rel), encoding="utf-8").read()
        assert emb[rel].replace("\r\n", "\n") == disk.replace("\r\n", "\n"), "嵌入內容與原始碼不同：%s（重新嵌入）" % rel
    assert "fa_gpu.py" in emb


def _materialize_and_import(keys_map, label):
    import subprocess
    import shutil
    d = tempfile.mkdtemp(prefix="fa-gpu-pkg-")
    try:
        for k, v in keys_map.items():
            p = os.path.join(d, k.replace("/", os.sep))
            if not os.path.isdir(os.path.dirname(p)):
                os.makedirs(os.path.dirname(p))
            with io.open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write(v)
        code = ("import sys; sys.path.insert(0, %r); import fa_gpu; fa_gpu.install(); "
                "import numba.cuda, cupy, torch, torch.nn, torch.optim, pycuda.autoinit; print('OK', torch.__file__)") % d
        env = dict(os.environ, FA_GPU_FORCE_SHIM="1", PYTHONIOENCODING="utf-8")
        r = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120)
        assert r.returncode == 0 and "OK" in r.stdout, label + "：" + (r.stderr or r.stdout)[-600:]
    finally:
        shutil.rmtree(d, ignore_errors=True)


def t_desktop_pkg_imports_every_shim():
    # 桌面版：_pyBridgeInstall 把嵌入清單的所有檔案寫進 pkg 資料夾
    emb, _ = _embedded_map()
    _materialize_and_import(emb, "桌面版 pkg")


def t_web_install_filter_imports_every_shim():
    # 網頁版：_cudawebInstallPyodide 只寫 fa_gpu.py 與 FA_GPU_SHIM_DIRS 目錄（用 JS 清單同樣的過濾規則）
    import re
    emb, src = _embedded_map()
    dirs = re.findall(r"'([A-Za-z_]+)'", re.search(r"FA_GPU_SHIM_DIRS = \[([^\]]*)\]", src).group(1))
    keep = {k: v for k, v in emb.items() if k == "fa_gpu.py" or any(k.startswith(d + "/") for d in dirs)}
    assert any(k.startswith("torch/") for k in keep) and any(k.startswith("pycuda/") for k in keep), sorted(keep)
    _materialize_and_import(keep, "網頁版 /fa_gpu")


# ---------------------------------------------------------------- numba → WGSL（第一批）
KERNEL_SEEN = []


def _kernel_host(fn):
    """假的宿主 kernel：讀取 float32／int32 的輸入（bin 或 list），用 numpy 代為計算（不能執行 WGSL），再照協定寫回。"""
    def impl(args):
        KERNEL_SEEN.append(args["wgsl"])
        arrays = {}
        for b in args["bindings"]:
            dt = np.int32 if b["dtype"] == "i32" else np.float32
            arr = np.fromfile(b["bin"], dtype=dt) if "bin" in b else np.asarray(b["list"], dtype=dt)
            if b["dtype"] == "dd":  # 雙 float32：hi、lo 交錯，還原成 float64
                v = arr.reshape(-1, 2)
                arrays[b["name"]] = (v[:, 0].astype(np.float64) + v[:, 1].astype(np.float64)).reshape(b["shape"])
            else:
                arrays[b["name"]] = arr.reshape(b["shape"])
        res = fn(args["wgsl"], arrays)
        outs = {}
        for b in args["bindings"]:
            if not b["write"]:
                continue
            dt = np.int32 if b["dtype"] == "i32" else np.float32
            if b["dtype"] == "dd":
                val = np.asarray(res[b["name"]], dtype=np.float64).reshape(-1)
                hi = val.astype(np.float32)
                lo = (val - hi.astype(np.float64)).astype(np.float32)
                data = np.stack([hi, lo], axis=1).reshape(-1)
            else:
                data = np.asarray(res[b["name"]], dtype=dt).reshape(-1)
            if "out" in b:
                data.tofile(b["out"])
                outs[b["name"]] = {"bin": b["out"]}
            else:
                outs[b["name"]] = {"list": data.tolist()}
        return {"ran": True, "layer": "T1", "reason": "", "outputs": outs}
    return impl


def _fn_by_names(wgsl_text, arrays):
    if "a_A" in arrays:  # 矩陣乘
        return {"a_C": arrays["a_A"] @ arrays["a_B"]}
    if "a_data" in arrays:  # 直方圖（原子加）
        assert "atomicAdd(&a_out[" in wgsl_text, "直方圖應該用 atomicAdd"
        return {"a_out": np.bincount(arrays["a_data"].reshape(-1), minlength=10).astype(np.int32)}
    return {"a_out": arrays["a_x"] + arrays["a_y"]}  # 向量加


def t_wgsl_vector_add_text():
    from numba import wgsl
    x = np.zeros(1000, np.float32)
    y = np.zeros(1000, np.float32)
    out = np.zeros(1000, np.float32)
    src = "def add_kernel(x, y, out):\n    idx = cuda.grid(1)\n    if idx < out.size:\n        out[idx] = x[idx] + y[idx]\n"
    plan = wgsl.compile_kernel("add_kernel", src, [x, y, out], (8, 1, 1), (128, 1, 1))
    assert "@workgroup_size(128, 1, 1)" in plan.wgsl, plan.wgsl
    assert "let v_idx: i32 = i32(gid.x);" in plan.wgsl, plan.wgsl
    assert "a_out[v_idx] = (a_x[v_idx] + a_y[v_idx]);" in plan.wgsl, plan.wgsl
    by = {b["wname"]: b for b in plan.bindings}
    assert set(by) == {"a_x", "a_y", "a_out"}, by.keys()
    assert by["a_out"]["write"] and not by["a_x"]["write"], by
    assert plan.groups == (8, 1)


def t_wgsl_histogram_atomic_text():
    from numba import wgsl
    data = np.zeros(100, np.int32)
    out = np.zeros(10, np.int32)
    src = "def histogram(data, out):\n    i = cuda.grid(1)\n    if i < data.size:\n        cuda.atomic.add(out, data[i], 1)\n"
    plan = wgsl.compile_kernel("histogram", src, [data, out], (4, 1, 1), (32, 1, 1))
    assert "array<atomic<i32>>" in plan.wgsl and "_ = atomicAdd(&a_out[" in plan.wgsl, plan.wgsl
    by = {b["wname"]: b for b in plan.bindings}
    assert by["a_out"]["atomic"] and by["a_out"]["write"] and not by["a_data"]["write"], by


def t_wgsl_matmul_loops_text():
    from numba import wgsl
    A = np.zeros((5, 7), np.float32)
    B = np.zeros((7, 4), np.float32)
    C = np.zeros((5, 4), np.float32)
    src = ("def matmul(A, B, C):\n    row, col = cuda.grid(2)\n    if row < C.shape[0] and col < C.shape[1]:\n"
           "        tmp = 0.0\n        for k in range(A.shape[1]):\n            tmp += A[row, k] * B[k, col]\n        C[row, col] = tmp\n")
    plan = wgsl.compile_kernel("matmul", src, [A, B, C], (1, 1, 1), (8, 8, 1))
    assert "@workgroup_size(8, 8, 1)" in plan.wgsl, plan.wgsl
    assert "for (var v_k: i32 = (0i); v_k < 7i; v_k = v_k + 1i) {" in plan.wgsl, plan.wgsl
    assert plan.groups == (1, 1)


def t_wgsl_refuses_unsupported_with_reason():
    from numba import wgsl
    a64 = np.zeros(4, np.float64)
    try:
        wgsl.compile_kernel("k", "def k(x):\n    i = cuda.grid(1)\n    x[i] = 1.0\n", [a64], (1, 1, 1), (4, 1, 1), mode="exact")
    except wgsl.NotCompilable as e:
        assert "float32" in str(e), str(e)
    else:
        raise AssertionError("float64 陣列應該拒絕")
    try:
        wgsl.compile_kernel("k", "def k(x):\n    try:\n        x[0] = 1.0\n    except Exception:\n        pass\n", [np.zeros(2, np.float32)], (1, 1, 1), (1, 1, 1))
    except wgsl.NotCompilable as e:
        assert "第 2 行" in str(e) and "Try" in str(e), str(e)
    else:
        raise AssertionError("try 應該拒絕")


def t_numba_runs_on_gpu_path_end_to_end():
    import tempfile as _t
    tmp = _t.mkdtemp(prefix="fa-gpu-k-")
    fa_gpu.RPC_DIR = tmp
    host["kernel_impl"] = _kernel_host(_fn_by_names)
    del KERNEL_SEEN[:]
    try:
        out, err = run_example("numba_vector_add.py")
        assert "與 numpy 一致： True" in out, out
        assert "此核心因為" not in err, err
        assert "WebGPU" in (fa_gpu.STATS["layer"] or ""), fa_gpu.STATS
        assert len(KERNEL_SEEN) == 1 and "@workgroup_size(128, 1, 1)" in KERNEL_SEEN[0], KERNEL_SEEN
        out2, err2 = run_example("numba_matmul_hist.py")
        assert "矩陣乘與 numpy 一致： True" in out2 and "直方圖與 bincount 一致： True" in out2, out2
        assert len(KERNEL_SEEN) == 3, len(KERNEL_SEEN)
        leftover = [n for n in os.listdir(tmp) if n.endswith(".bin")]
        assert leftover == [], "輸入與輸出的 .bin 應該都清掉，剩下：%s" % leftover
    finally:
        host["kernel_impl"] = None
        fa_gpu.RPC_DIR = ""


def t_numba_fallback_prints_specific_reason():
    host["kernel_impl"] = None
    out, err = run_example("numba_vector_add.py")
    assert "與 numpy 一致： True" in out, out
    assert "此核心因為 測試宿主沒有實作 kernel 在本機 Python 模擬執行，沒有用到 GPU" in err, err


def t_numba_refused_kernel_reason_printed():
    import inspect as _insp
    host["kernel_impl"] = _kernel_host(_fn_by_names)

    def reverse_block(a, out):
        tid = cuda.threadIdx.x
        i = cuda.grid(1)
        s = cuda.shared.array(64, dtype=np.float32)
        s[tid] = a[i]
        cuda.syncthreads()
        out[i] = s[63 - tid]

    from numba import cuda as _cuda
    try:
        a = np.arange(128, dtype=np.float32)
        out = np.zeros_like(a)
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            reverse_block_k = _cuda.jit(reverse_block)
            reverse_block_k[2, 64](a, out)
        expect = np.concatenate([a[:64][::-1], a[64:][::-1]])
        assert np.array_equal(out, expect)
        assert "此核心因為 核心用到 shared 記憶體或 cuda.syncthreads" in buf.getvalue(), buf.getvalue()
        assert "沒有用到 GPU" in buf.getvalue(), buf.getvalue()
    finally:
        host["kernel_impl"] = None


def t_fa_gpu_installs_without_numpy():
    # 網頁版 Pyodide 剛載入、還沒有 numpy 時，安裝與尋找器必須成功（numpy 只在真的要執行 WGSL 時才需要）
    import subprocess
    code = ("import sys; sys.modules['numpy'] = None; sys.path.insert(0, %r); "
            "import fa_gpu; fa_gpu.install(); fa_gpu.uninstall(); fa_gpu.install(); print('OK')") % os.path.abspath(PYBRIDGE)
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    r = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and "OK" in r.stdout, (r.stderr or r.stdout)[-600:]


# ---------------------------------------------------------------- 字串執行的腳本（網頁版 runPythonAsync）取得核心原始碼
# 模擬助理的網頁版：腳本是字串，用 compile(字串, "<exec>") 執行，沒有檔案；主機端先 register_script 登記。
STRING_SCRIPT = '''import numpy as np
from numba import cuda


@cuda.jit
def add(a, b, c):
    i = cuda.grid(1)
    if i < c.size:
        c[i] = a[i] + b[i]


@cuda.jit(
    'void(float32[:], float32[:], float32[:])'
)
def mul(a, b,
        c):
    i = cuda.grid(1)
    if i < c.size:
        if a[i] > -1.0:
            for k in range(1):
                c[i] = a[i] * b[i]


n = 8
a = np.arange(n, dtype=np.float32)
b = a * 2
c1 = np.zeros(n, np.float32)
c2 = np.zeros(n, np.float32)
add[1, 8](a, b, c1)
mul[1, 8](a, b, c2)
print("ADD", bool(np.allclose(c1, a + b)), "MUL", bool(np.allclose(c2, a * b)))
'''


def _run_string_script(text, isolated):
    import contextlib as _cl
    import io as _io
    g = {"__name__": "__main__"} if not isolated else {"__name__": "__fa_isolated__"}
    buf = _io.StringIO()
    with _cl.redirect_stdout(buf):
        exec(compile(text, "<exec>", "exec"), g)
    return buf.getvalue()


def t_string_script_kernels_get_source_from_registry():
    import inspect as _insp
    fa_gpu.register_script(STRING_SCRIPT)
    out = _run_string_script(STRING_SCRIPT, isolated=False)
    assert "ADD True MUL True" in out, out
    # 確認這個情境真的走到退路：inspect 取不到來源
    g = {}
    exec(compile(STRING_SCRIPT, "<exec>", "exec"), g)
    try:
        _insp.getsource(g["add"])
    except (OSError, TypeError):
        pass
    else:
        raise AssertionError("測試前提不成立：inspect 竟然取得了字串腳本的來源")


def t_string_script_isolated_globals():
    fa_gpu.register_script(STRING_SCRIPT)
    out = _run_string_script(STRING_SCRIPT, isolated=True)
    assert "ADD True MUL True" in out, out


def t_string_script_two_scripts_registered_pick_right_one():
    other = STRING_SCRIPT.replace("c[i] = a[i] + b[i]", "c[i] = a[i] - b[i]").replace("ADD", "ADDX")
    fa_gpu.register_script(other)
    fa_gpu.register_script(STRING_SCRIPT)
    out = _run_string_script(other, isolated=True)
    assert "ADDX" in out and "ADDX False" in out, out  # 先執行 other，但它的 add 是減法，結果對不上加法的檢查
    out2 = _run_string_script(STRING_SCRIPT, isolated=True)
    assert "ADD True MUL True" in out2, out2


def t_unregistered_source_message_explains_cause():
    import fa_gpu as _fg
    saved = list(_fg._SCRIPTS)
    del _fg._SCRIPTS[:]
    try:
        g = {}
        exec(compile("from numba import cuda\n\n@cuda.jit\ndef zz_unregistered(c):\n    c[0] = 1\n", "<stdin>", "exec"), g)
        try:
            fa_gpu.find_kernel_source(g["zz_unregistered"])
        except fa_gpu.SourceUnavailable as e:
            msg = str(e)
            assert "python -c" in msg and "REPL" in msg and "exec" in msg and "解法" in msg and ".py" in msg, msg
        else:
            raise AssertionError("沒有登記時應該丟 SourceUnavailable")
    finally:
        _fg._SCRIPTS[:] = saved


def t_desktop_mailbox_runs_script_file_with_kernel():
    # 桌面版：python fa_run.py --rpc <信箱> -- script.py（真的 Python 跑檔案），信箱的回應由這裡的假宿主處理
    import subprocess
    import shutil
    import time
    import json as _json
    d = tempfile.mkdtemp(prefix="fa-gpu-desk-")
    rpc = os.path.join(d, "rpc")
    os.makedirs(rpc)
    script = os.path.join(d, "desk_kernel.py")
    with io.open(script, "w", encoding="utf-8") as f:
        f.write(STRING_SCRIPT.replace("ADD", "DESK_ADD").replace("MUL", "DESK_MUL"))
    runner = os.path.join(PYBRIDGE, "fa_run.py")
    env = dict(os.environ, FA_GPU_FORCE_SHIM="1", PYTHONIOENCODING="utf-8")
    p = subprocess.Popen([sys.executable, runner, "--rpc", rpc, "--", script], env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
    deadline = time.time() + 120
    try:
        while p.poll() is None and time.time() < deadline:
            for n in os.listdir(rpc):
                if not (n.startswith("req-") and n.endswith(".json")):
                    continue
                rid = n[4:-5]
                req = _json.load(io.open(os.path.join(rpc, n), encoding="utf-8"))
                os.remove(os.path.join(rpc, n))
                if req["op"] == "gpu.info":
                    res = {"ok": True, "result": host["info"]}
                elif req["op"] == "gpu.kernel":
                    res = {"ok": True, "result": {"ran": False, "layer": "CPU", "reason": "測試：無 WebGPU", "outputs": {}}}
                else:
                    res = {"ok": False, "error": "測試宿主沒有實作：" + req["op"]}
                with io.open(os.path.join(rpc, "res-" + rid + ".json"), "w", encoding="utf-8") as f:
                    f.write(_json.dumps(res, ensure_ascii=False))
            time.sleep(0.02)
        out, err = p.communicate(timeout=60)
    finally:
        if p.poll() is None:
            p.kill()
        shutil.rmtree(d, ignore_errors=True)
    assert p.returncode == 0, (err or out)[-800:]
    assert "DESK_ADD True DESK_MUL True" in out, out + err
    assert "此核心因為" in err and "沒有用到 GPU" in err, err


# ---------------------------------------------------------------- float64（Python 預設）：exact／f32／auto(dd)
def _f64_fn(wgsl_text, arrays):
    """假的 GPU 結果（用 numpy 的 float64 算 scale_add）：out = x*2.5 + y - 0.125。"""
    return {"a_out": arrays["a_x"] * 2.5 + arrays["a_y"] - 0.125}


def _with_mode(mode, fn):
    saved = host["info"].get("f64Mode")
    host["info"]["f64Mode"] = mode
    try:
        return fn()
    finally:
        host["info"]["f64Mode"] = saved


def _run_f64_example(kernel_impl):
    host["kernel_impl"] = kernel_impl
    try:
        return run_example("numba_float64.py")
    finally:
        host["kernel_impl"] = None


def t_wgsl_dd_text_and_refusals():
    from numba import wgsl
    x = np.zeros(4)
    y = np.zeros(4)
    out = np.zeros(4)
    src = "def add_kernel(x, y, out):\n    idx = cuda.grid(1)\n    if idx < out.size:\n        out[idx] = x[idx] + y[idx]\n"
    plan = wgsl.compile_kernel("add_kernel", src, [x, y, out], (1, 1, 1), (4, 1, 1), mode="dd")
    assert "fn dd_add(" in plan.wgsl and "a_out[v_idx] = dd_add(a_x[v_idx], a_y[v_idx]);" in plan.wgsl, plan.wgsl
    assert "array<vec2<f32>>" in plan.wgsl, plan.wgsl
    by = {b["wname"]: b for b in plan.bindings}
    assert by["a_x"]["dtype"] == "dd" and by["a_out"]["write"] and by["a_out"]["dtype"] == "dd", by
    assert plan.fmode == "dd"
    # 除法、次方、math.* 在雙 float32 模式會編成 dd_ 函式（清單 O；數值驗證見 scripts/eval/cudaweb_dd_math_check.js，真 Chrome WebGPU）
    for src2, want in (("x[i] = x[i] / 3.0", "dd_div(a_x[v_i], vec2<f32>("), ("x[i] = x[i] ** 3", "dd_powi(a_x[v_i], 3)"), ("x[i] = x[i] ** -2", "dd_powi(a_x[v_i], -2)"),
                       ("x[i] = x[i] ** 0.5", "dd_sqrt(a_x[v_i])"), ("x[i] = x[i] ** 1.5", "dd_pow(a_x[v_i], "), ("x[i] = math.sqrt(x[i])", "dd_sqrt(a_x[v_i])"),
                       ("x[i] = math.exp(x[i])", "dd_exp(a_x[v_i])"), ("x[i] = math.log(x[i])", "dd_log("), ("x[i] = math.sin(x[i]) + math.cos(x[i])", "dd_cos("),
                       ("x[i] = math.tanh(x[i])", "dd_tanh("), ("x[i] = math.floor(x[i])", "dd_floor("), ("x[i] = math.fabs(x[i])", "dd_abs(")):
        pl = wgsl.compile_kernel("k", "def k(x):\n    i = cuda.grid(1)\n    " + src2 + "\n", [np.zeros(4)], (1, 1, 1), (4, 1, 1), mode="dd")
        assert want in pl.wgsl, (src2, pl.wgsl[-300:])
        assert "fn dd_div(" in pl.wgsl and "fn dd_two_prod(" in pl.wgsl and "fma(" not in pl.wgsl.split("fn main")[0].replace("fn dd_two_prod", ""), "dd_mul 不該用 fma（SwiftShader 的 fma 不是融合運算）"
    for bad, want in (("x[i] = x[i] % 3.0", "取餘"), ("x[i] = x[i] // 3.0", "整數除法")):
        try:
            wgsl.compile_kernel("k", "def k(x):\n    i = cuda.grid(1)\n    " + bad + "\n", [np.zeros(4)], (1, 1, 1), (4, 1, 1), mode="dd")
        except wgsl.NotCompilable as e:
            assert want in str(e), str(e)
        else:
            raise AssertionError("dd 模式應該拒絕：" + want)
    f32plan = wgsl.compile_kernel("add_kernel", src, [x, y, out], (1, 1, 1), (4, 1, 1), mode="f32")
    assert {b["wname"]: b["dtype"] for b in f32plan.bindings}["a_x"] == "f32"
    try:
        wgsl.compile_kernel("add_kernel", src, [x, y, out], (1, 1, 1), (4, 1, 1), mode="exact")
    except wgsl.NotCompilable as e:
        assert "cudaCompatFloat64=exact" in str(e), str(e)
    else:
        raise AssertionError("exact 模式應該拒絕 float64 陣列")


def t_float64_example_auto_uses_dd_and_matches():
    before = len(KERNEL_SEEN)
    out, err = _with_mode("auto", lambda: _run_f64_example(_kernel_host(_f64_fn)))
    assert "與 numpy 一致： True" in out, out + err
    assert len(KERNEL_SEEN) == before + 1, "auto 模式應該把核心送到 GPU"
    assert "雙 float32（約 48 位元有效精度）在 WebGPU 執行" in err, err
    assert "此核心因為" not in err, err


def t_float64_auto_sample_check_rejects_wrong_gpu_result():
    def wrong(wgsl_text, arrays):
        return {"a_out": arrays["a_x"] * 2.5 + arrays["a_y"] - 0.125 + 1e-3}  # 故意算錯
    before = len(KERNEL_SEEN)
    out, err = _with_mode("auto", lambda: _run_f64_example(_kernel_host(wrong)))
    assert len(KERNEL_SEEN) == before + 1, "應該真的送到 GPU 才發現不一致"
    assert "抽樣檢查不一致" in err and "改用本機 Python 模擬" in err, err
    assert "與 numpy 一致： True" in out, out + err  # 退回模擬後結果仍正確


def t_float64_exact_mode_stays_on_python():
    before = len(KERNEL_SEEN)
    out, err = _with_mode("exact", lambda: _run_f64_example(_kernel_host(_f64_fn)))
    assert len(KERNEL_SEEN) == before, "exact 模式不應該送 GPU"
    assert "cudaCompatFloat64=exact" in err and "沒有用到 GPU" in err, err
    assert "與 numpy 一致： True" in out, out + err


def t_float64_f32_mode_runs_and_says_precision():
    before = len(KERNEL_SEEN)
    out, err = _with_mode("f32", lambda: _run_f64_example(_kernel_host(_f64_fn)))
    assert len(KERNEL_SEEN) == before + 1, "f32 模式應該送 GPU"
    assert "精度降為 float32" in err, err
    assert "dtype" not in err


def t_dd_pack_roundtrip_precision():
    a = np.array([1.0 / 3.0, 1e10 + 0.1, -2.5e-7, 123456.789012345])
    flat = fa_gpu._pack_flat(a, "dd")
    assert flat.dtype == np.float32 and flat.size == 2 * a.size
    back = fa_gpu._unpack_flat(flat, "dd", a.shape)
    assert np.max(np.abs(back - a) / np.abs(a)) < 1e-13, (back, a)


def t_dd_algorithm_mirror_precision():
    # 用 numpy 的 float32 逐步模擬 WGSL 的 dd_add／dd_mul（fma 用 float64 精確算出後一次捨入，與 WGSL 的 fma 相同），
    # 驗證「雙 float32」的演算法有約 48 位元精度。WGSL 本身的正確性仍要在真的 GPU 上驗證。
    f32 = np.float32

    def two_sum(a, b):
        s = f32(a + b)
        bb = f32(s - a)
        return s, f32(f32(a - f32(s - bb)) + f32(b - bb))

    def quick(a, b):
        s = f32(a + b)
        return s, f32(b - f32(s - a))

    def dd_add(a, b):
        s, t1 = two_sum(a[0], b[0])
        t, t2 = two_sum(a[1], b[1])
        q1 = quick(s, f32(t1 + t))
        return quick(q1[0], f32(q1[1] + t2))

    def dd_mul(a, b):
        p = f32(a[0] * b[0])
        e = f32(np.float64(a[0]) * np.float64(b[0]) - np.float64(p))
        e = f32(e + f32(f32(a[0] * b[1]) + f32(a[1] * b[0])))
        return quick(p, e)

    def split(x):
        hi = f32(x)
        return hi, f32(x - np.float64(hi))

    def val(d):
        return np.float64(d[0]) + np.float64(d[1])

    rs = np.random.RandomState(7)
    worst_add = worst_mul = 0.0
    for _ in range(2000):
        x, y = rs.uniform(-1e3, 1e3, 2)
        ax, ay = split(x), split(y)
        s = val(dd_add(ax, ay))
        p = val(dd_mul(ax, ay))
        worst_add = max(worst_add, abs(s - (x + y)) / (abs(x) + abs(y)))
        worst_mul = max(worst_mul, abs(p - x * y) / abs(x * y))
    assert worst_add < 1e-13 and worst_mul < 1e-13, (worst_add, worst_mul)


# ---------------------------------------------------------------- 一般 run_command 的 GPU 相容層（fa_run --gpu-only）、設定傳遞
def _fa_run(opts, script_text):
    """用真的子行程跑 fa_run.py（不開視窗）。opts 不含腳本路徑；回傳 (returncode, stdout, stderr)。"""
    import subprocess
    import shutil
    d = tempfile.mkdtemp(prefix="fa-gpu-run-")
    try:
        script = os.path.join(d, "s.py")
        with io.open(script, "w", encoding="utf-8") as f:
            f.write(script_text)
        env = dict(os.environ, FA_GPU_FORCE_SHIM="1")
        env.pop("PYTHONIOENCODING", None)
        env.pop("PYTHONUTF8", None)
        env.pop("FA_CUDA_COMPAT", None)
        env.pop("FA_CUDA_F64", None)
        p = subprocess.run([sys.executable, os.path.join(PYBRIDGE, "fa_run.py")] + opts + [script], env=env,
                           capture_output=True, encoding="utf-8", errors="replace", timeout=120)
        return p.returncode, p.stdout, p.stderr
    finally:
        shutil.rmtree(d, ignore_errors=True)


_SHIM_PROBE = (
    "import sys, os\n"
    "print('SHIM', any(type(f).__name__ == '_ShimFinder' for f in sys.meta_path))\n"
    "print('BRIDGE', 'fa_bridge' in sys.modules)\n"
    "print('PYIO', os.environ.get('PYTHONIOENCODING'))\n"
    "print('COMPAT', os.environ.get('FA_CUDA_COMPAT'))\n"
)


def t_script_needs_shim_rule():
    from fa_gpu import script_needs_shim
    yes = ["from numba import cuda\n", "import torch.nn as nn\n", "import cupy as cp\n", "from pycuda import driver\n",
           "import numpy, numba\n", "    from torch import tensor\n"]
    no = ["# import numba\n", "import numpy as np\n", "x = 'numba'\n", "import numba_extra\n",
          # 已知限制：字串裡的 "import torch" 也會判成需要（與網頁版同一條規則，誤判只會多裝墊片，不會改變輸出）
          "import os; from numba_x import y\n"]
    for s in yes:
        assert script_needs_shim(s), "應該判定需要墊片：" + s
    for s in no:
        assert not script_needs_shim(s), "不應該判定需要墊片：" + s


def t_fa_run_gpu_only_plain_script_untouched():
    # 一般 run_command：腳本沒有 import 墊片套件 → 照原樣執行，不裝墊片、不載入 LLM／瀏覽器轉接、不改編碼
    code, out, err = _fa_run(["--gpu-only", "--rpc", "", "--"], _SHIM_PROBE)
    assert code == 0, err
    assert "SHIM False" in out and "BRIDGE False" in out and "PYIO None" in out, out + err


def t_fa_run_gpu_only_shim_script_gets_shim():
    # 腳本 import numba → 只安裝 GPU 相容層（不裝 LLM／瀏覽器轉接）
    code, out, err = _fa_run(["--gpu-only", "--rpc", "", "--"], "import numba\n" + _SHIM_PROBE)
    assert code == 0, err
    assert "SHIM True" in out and "BRIDGE False" in out, out + err


def t_fa_run_cuda_compat_off_skips_shim():
    # 技能包模式＋GPU 相容層關閉：不安裝墊片，fa_bridge 照常載入（轉接不受影響）
    code, out, err = _fa_run(["--cuda-compat", "off", "--rpc", "", "--"], _SHIM_PROBE)
    assert code == 0, err
    assert "SHIM False" in out and "COMPAT off" in out and "BRIDGE True" in out, out + err


def t_fa_run_cuda_compat_off_gpu_only_no_shim():
    # run_command 模式＋關閉：腳本 import numba 不會被墊片遮蔽（真的 numba 沒有安裝時會報 ImportError，這是預期的）
    code, out, err = _fa_run(["--gpu-only", "--cuda-compat", "off", "--rpc", "", "--"], _SHIM_PROBE + "import numba\n")
    assert "SHIM False" in out, out + err
    assert code == 0 or "numba" in err, err


def t_fa_run_passes_f64_mode_to_child():
    code, out, err = _fa_run(["--cuda-f64", "exact", "--rpc", "", "--"],
                             "import fa_gpu\nprint('F64', fa_gpu.f64_mode())\n")
    assert code == 0 and "F64 exact" in out, out + err
    code, out, err = _fa_run(["--cuda-f64", "f32", "--rpc", "", "--"],
                             "import fa_gpu\nprint('F64', fa_gpu.f64_mode())\n")
    assert "F64 f32" in out, out + err


# ---------------------------------------------------------------- 非同步提交（call_async／stream／event）
# 假的非同步宿主：submit 只登記、不執行（模擬 GPU 在背景）；wait／sync 才依序執行 fake_rpc；
# 同一個 stream 出錯後 sticky（之後的操作與 sync 都丟同一個錯誤，直到 reset），與 gpu_async_queue.js 相同。
_async = {"pending": {}, "next": 0, "limit": 0, "poison": {}, "events": {}, "evnext": 0}


def _run_async(hid):
    """執行一筆（若還沒執行）並把結果留在 results，之後 wait 可再取；與 JS 宿主相同，結果保留到 forget。"""
    if hid not in _async.setdefault("results", {}):
        body, stream = _async["pending"].pop(hid)
        if stream in _async["poison"]:
            _async["results"][hid] = ("err", _async["poison"][stream])
        else:
            try:
                _async["results"][hid] = ("ok", fake_rpc("call", body))
            except fa_gpu.GpuCompatError as e:
                _async["poison"][stream] = e
                _async["results"][hid] = ("err", e)
    kind, val = _async["results"][hid]
    if kind == "err":
        raise val
    return val


def fake_arpc(name, args):
    if name == "submit":
        if _async["limit"] and len(_async["pending"]) >= _async["limit"]:
            raise fa_gpu.GpuCompatError("GPU 佇列已滿（未完成的操作達上限 %d），請先等待較早的句柄" % _async["limit"])
        hid = _async["next"]
        _async["next"] += 1
        _async["pending"][hid] = (args["body"], args["stream"])
        return {"handle": hid, "stream": args["stream"]}
    if name == "query":
        return "pending" if args["handle"] in _async["pending"] else "done"
    if name == "wait":
        return _run_async(args["handle"])
    if name == "forget":
        return {"ok": True}
    if name == "reset":
        _async["poison"].pop(args["stream"], None)
        return {"ok": True}
    if name == "sync":
        targets = [args["stream"]] if args["stream"] is not None else None
        for hid in sorted(list(_async["pending"])):
            body, stream = _async["pending"][hid]
            if targets is None or stream in targets:
                try:
                    _run_async(hid)
                except fa_gpu.GpuCompatError:
                    pass  # 錯誤留在 sticky 狀態，下面統一丟
        for s, e in _async["poison"].items():
            if targets is None or s in targets:
                raise e
        return {"ok": True}
    if name == "event_record":
        _async["evnext"] += 1
        _async["events"][_async["evnext"]] = args["stream"]
        return {"event": _async["evnext"]}
    if name == "event_sync":
        stream = _async["events"][args["event"]]
        return fake_arpc("sync", {"stream": stream})
    if name == "event_query":
        return True
    if name == "event_elapsed":
        return {"ms": 0.25}
    raise AssertionError("未知的非同步操作：" + name)


fa_gpu._arpc = fake_arpc


def _async_reset():
    _async["pending"].clear()
    _async["limit"] = 0
    _async["poison"].clear()
    _async.setdefault("results", {}).clear()


def t_async_submit_defers_gpu_until_wait():
    _async_reset()
    del host_calls[:]
    h = fa_gpu.call_async("vector_add", {"a": [1.0, 2.0], "b": [10.0, 20.0]}, stream=1)
    assert host_calls == [], "submit 之後 GPU 操作不應已執行（應該在 wait 才跑）"
    assert h.done() is False, "未完成時 done() 應為 False"
    assert h.wait() == [11.0, 22.0], "wait 結果錯誤"
    assert host_calls == ["vector_add"]
    assert h.done() is True
    assert h.wait() == [11.0, 22.0], "同一句柄可以多次 wait"


def t_async_overlap_cpu_work_between_submit_and_wait():
    _async_reset()
    del host_calls[:]
    h1 = fa_gpu.call_async("matmul", {"a": [1.0, 2.0, 3.0, 4.0], "b": [5.0, 6.0, 7.0, 8.0], "m": 2, "k": 2, "n": 2}, stream=1)
    h2 = fa_gpu.call_async("sum", {"a": [1.0, 2.0, 3.0]}, stream=2)
    cpu = sum(i * i for i in range(20000))  # 這段 CPU 工作發生在提交之後、等待之前
    assert cpu == sum(i * i for i in range(20000))
    assert host_calls == [], "CPU 工作期間 GPU 不應被阻塞式執行"
    assert h2.wait() == 6.0
    assert h1.wait() == [19.0, 22.0, 43.0, 50.0]


def t_async_same_stream_keeps_order():
    _async_reset()
    del host_calls[:]
    hs = [fa_gpu.call_async("sum", {"a": [float(i)]}, stream=3) for i in range(4)]
    fa_gpu.synchronize(3)
    assert host_calls == ["sum"] * 4
    assert [h.wait() for h in hs] == [0.0, 1.0, 2.0, 3.0]


def t_async_error_is_delayed_and_sticky():
    _async_reset()
    host["fail"] = True
    try:
        h1 = fa_gpu.call_async("sum", {"a": [1.0]}, stream=4)  # 提交不丟
        h2 = fa_gpu.call_async("sum", {"a": [2.0]}, stream=4)
        h3 = fa_gpu.call_async("sum", {"a": [3.0]}, stream=5)   # 其他 stream 不受影響
        raised = False
        try:
            h1.wait()  # 這一筆在宿主失敗
        except fa_gpu.GpuCompatError:
            raised = True
        assert raised, "錯誤應在 wait 時丟出"
        host["fail"] = False  # 之後的 fake_rpc 會成功，但 stream 4 應該仍是 sticky
        raised = False
        try:
            h2.wait()  # 同 stream：不執行，直接以同一錯誤失敗
        except fa_gpu.GpuCompatError:
            raised = True
        assert raised, "同 stream 之後的操作應 sticky 失敗"
        assert h3.wait() == 3.0, "其他 stream 應正常完成"
        raised = False
        try:
            fa_gpu.synchronize(4)
        except fa_gpu.GpuCompatError:
            raised = True
        assert raised, "synchronize(stream) 應丟出 sticky 錯誤"
        fa_gpu.reset(4)
        h4 = fa_gpu.call_async("sum", {"a": [4.0]}, stream=4)
        assert h4.wait() == 4.0, "reset 後應可再用"
    finally:
        host["fail"] = False
        _async_reset()


def t_async_queue_full_waits_oldest_then_retries():
    _async_reset()
    _async["limit"] = 2
    try:
        hs = [fa_gpu.call_async("sum", {"a": [float(i)]}, stream=6) for i in range(5)]
        assert [h.wait() for h in hs] == [0.0, 1.0, 2.0, 3.0, 4.0], "佇列滿時應先等最舊的再重試，結果不能錯"
    finally:
        _async_reset()


def t_async_bin_files_live_until_wait():
    _async_reset()
    d = tempfile.mkdtemp(prefix="fa-gpu-async-")
    old_dir = fa_gpu.RPC_DIR
    fa_gpu.RPC_DIR = d
    try:
        h = fa_gpu.call_async("dot", {"x": [1.0, 2.0, 3.0], "y": [4.0, 5.0, 6.0]}, stream=7)
        bins = [p for p in os.listdir(d) if p.startswith("gpu-in-")]
        assert bins, "submit 後輸入的 bin 檔應保留到 wait 之後（宿主還要讀）"
        assert h.wait() == 32.0
        left = [p for p in os.listdir(d) if p.startswith("gpu-in-")]
        assert not left, "wait 完成後輸入的 bin 檔應被清掉：" + str(left)
    finally:
        fa_gpu.RPC_DIR = old_dir
        _async_reset()


def t_async_events_and_elapsed():
    _async_reset()
    ev0 = fa_gpu.event_record(8)
    h = fa_gpu.call_async("sum", {"a": [1.0, 2.0]}, stream=8)
    ev1 = fa_gpu.event_record(8)
    fa_gpu.event_synchronize(ev1)
    assert fa_gpu.event_query(ev1) is True
    assert h.done() is True or h.wait() == 3.0
    ms = fa_gpu.elapsed_ms(ev0, ev1)
    assert ms == 0.25, "elapsed_ms 應來自宿主（假的宿主回 0.25）"
    _async_reset()


for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("")
print("通過 %d 項，失敗 %d 項" % (passes, len(failures)))
if failures:
    print("失敗：" + "、".join(failures))
    sys.exit(1)
