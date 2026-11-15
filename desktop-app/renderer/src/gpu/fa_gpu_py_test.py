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
            dt = np.float32 if b["dtype"] == "f32" else np.int32
            arr = np.fromfile(b["bin"], dtype=dt) if "bin" in b else np.asarray(b["list"], dtype=dt)
            arrays[b["name"]] = arr.reshape(b["shape"])
        res = fn(args["wgsl"], arrays)
        outs = {}
        for b in args["bindings"]:
            if not b["write"]:
                continue
            dt = np.float32 if b["dtype"] == "f32" else np.int32
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
        wgsl.compile_kernel("k", "def k(x):\n    i = cuda.grid(1)\n    x[i] = 1.0\n", [a64], (1, 1, 1), (4, 1, 1))
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


for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("")
print("通過 %d 項，失敗 %d 項" % (passes, len(failures)))
if failures:
    print("失敗：" + "、".join(failures))
    sys.exit(1)
