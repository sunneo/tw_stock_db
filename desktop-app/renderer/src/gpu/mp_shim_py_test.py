# -*- coding: utf-8 -*-
# multiprocessing 墊片（FA_MP_SHIM_PY，嵌在 renderer/src/floating-assistant.js）的 API 測試。
# 在一般 CPython 跑：用假的 js／pyodide 模組換掉瀏覽器專用的 import，`_fa_mp` 設為 None，所以全部走「單一執行緒依序執行」的退路。
# 目的是確認 Pool.map／apply_async／starmap、ProcessPoolExecutor.submit／map、Process 的基本用法在墊片裡能跑、結果正確。
# 真正的平行（Web Worker）要在瀏覽器裡驗證，這裡不涵蓋。
# 用法：python renderer/src/gpu/mp_shim_py_test.py
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
FA_JS = os.path.abspath(os.path.join(HERE, "..", "floating-assistant.js"))

# 1. 假的瀏覽器環境
js = types.ModuleType("js")
js.navigator = types.SimpleNamespace(hardwareConcurrency=4)
pyodide = types.ModuleType("pyodide")
ffi = types.ModuleType("pyodide.ffi")
ffi.to_js = lambda x, **k: x
ffi.can_run_sync = lambda: False
ffi.run_sync = lambda x: x
pyodide.ffi = ffi
sys.modules["js"] = js
sys.modules["pyodide"] = pyodide
sys.modules["pyodide.ffi"] = ffi

# 2. 從 floating-assistant.js 取出 FA_MP_SHIM_PY 的 String.raw 文字（與原始碼同步，不另存一份）
src = open(FA_JS, encoding="utf-8").read()
start_tag = "const FA_MP_SHIM_PY = String.raw`"
a = src.index(start_tag) + len(start_tag)
b = src.index("`;", a)
shim_src = src[a:b]

shim = types.ModuleType("fa_mp_shim")
sys.modules["fa_mp_shim"] = shim
exec(compile(shim_src, "<FA_MP_SHIM_PY>", "exec"), shim.__dict__)
sys.modules["multiprocessing"] = shim
import multiprocessing  # noqa: E402  （墊片型式：import multiprocessing 拿到的就是墊片）

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
    except Exception as e:
        failures.append(name)
        print("FAIL " + name + ": " + type(e).__name__ + ": " + str(e))


def sq(x):
    return x * x


def add(a, b):
    return a + b


def t_shim_loaded_from_source():
    assert "class Pool" in shim_src and "class ProcessPoolExecutor" in shim_src, "原始碼裡找不到墊片的類別"


def t_pool_map_order():
    with multiprocessing.Pool(2) as p:
        assert p.map(sq, range(6)) == [0, 1, 4, 9, 16, 25], "Pool.map 結果或順序錯誤"


def t_pool_apply_async_get():
    with multiprocessing.Pool(2) as p:
        r = p.apply_async(sq, (3,))
        assert r.get() == 9, "apply_async().get() 錯誤"


def t_pool_starmap():
    with multiprocessing.Pool(2) as p:
        assert p.starmap(add, [(1, 2), (3, 4)]) == [3, 7], "starmap 錯誤"


def t_pool_error_is_raised():
    def boom(x):
        raise ValueError("壞掉 " + str(x))
    with multiprocessing.Pool(2) as p:
        raised = False
        try:
            p.map(boom, [1])
        except Exception as e:
            raised = "壞掉" in str(e)
        assert raised, "工作的例外應該傳回給呼叫端"


def t_executor_submit_result():
    # 一律用墊片自己的 ProcessPoolExecutor（不用標準庫的，避免測到 CPython 的實作）
    ex = shim.ProcessPoolExecutor(max_workers=2)
    fut = ex.submit(sq, 5)
    assert fut.result() == 25, "submit().result() 錯誤"
    ex.shutdown()


def t_executor_map():
    ex = shim.ProcessPoolExecutor(max_workers=2)
    assert list(ex.map(sq, [1, 2, 3])) == [1, 4, 9], "executor.map 順序錯誤"
    ex.shutdown()


def t_process_start_join():
    out = []
    p = shim.Process(target=lambda: out.append("ran"))
    p.start()
    p.join()
    assert out == ["ran"], "Process.start／join 應執行 target"


def t_cpu_count_is_bounded():
    n = shim.cpu_count()
    assert 1 <= n <= 8, "cpu_count 應在 1 到 8 之間，實際 " + str(n)


for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        check(name[2:], fn)

print("")
print("通過 %d 項，失敗 %d 項" % (passes, len(failures)))
if failures:
    print("失敗：" + "、".join(failures))
    sys.exit(1)
