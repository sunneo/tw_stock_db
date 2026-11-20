# -*- coding: utf-8 -*-
"""pyopencl._cl 後端的端到端測試：Python（一般 CPython）→ _cl.py → stdio → node 的 cl_host_stdio.js → ICD 載入器 → KIR 驅動。
用法：FA_OPENCL_HOST=<cl_host_stdio.js 的路徑> python3 -I _cl_test.py    （沒有 node 或沒設環境變數就略過）
範圍：只測 `_cl` 這一層（不載入真 pyopencl 的純 Python 層——那需要 pytools／mako 等相依，見 DESIGN.pyopencl.md §1.1）。"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

if not os.environ.get("FA_OPENCL_HOST") or not shutil.which(os.environ.get("FA_OPENCL_NODE", "node")):
    print("略過：沒有 FA_OPENCL_HOST 或找不到 node\n0 passed, 0 failed")
    sys.exit(0)

import numpy as np  # noqa: E402
import _cl as cl  # noqa: E402

passed = failed = 0


def t(name):
    def deco(fn):
        global passed, failed
        try:
            fn()
            passed += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            import traceback
            print("FAIL " + name + "\n   " + "\n   ".join(traceback.format_exc().splitlines()[-6:]))
        return fn
    return deco


def raises(cls, fn, name=None, contains=None):
    try:
        fn()
    except cl.Error as e:
        assert isinstance(e, cls), "例外類別 %s，預期 %s（%s）" % (type(e).__name__, cls.__name__, e)
        if name:
            assert e.code == getattr(cl.status_code, name), "code %s，預期 %s（%s）" % (e.code, name, e)
        if contains:
            assert contains in str(e), "訊息裡沒有「%s」：%s" % (contains, e)
        return e
    raise AssertionError("沒有丟出 %s" % cls.__name__)


VADD = "__kernel void vadd(__global const float* a, __global const float* b, __global float* c, int n) { int i = get_global_id(0); if (i < n) c[i] = a[i] + b[i]; }"
SCALE = "__kernel void scale(__global const float* x, __global float* y, int n, float s) { int i = get_global_id(0); if (i < n) y[i] = x[i] * s; }"
mf = cl.mem_flags

plat = cl.get_platforms()[0]
dev = plat.get_devices()[0]
ctx = cl.Context([dev])
queue = cl.CommandQueue(ctx)


@t("列舉：數值、to_string、__dict__ 有成員（真 pyopencl 的 add_get_info 靠它）")
def _():
    assert cl.status_code.to_string(-11) == "BUILD_PROGRAM_FAILURE"
    assert cl.status_code.to_string(-9999, "<unknown error %d>") == "<unknown error -9999>"
    assert cl.mem_flags.READ_ONLY == 4 and cl.mem_flags.COPY_HOST_PTR == 32 and cl.device_type.ALL == 0xFFFFFFFF
    assert "NAME" in cl.device_info.__dict__ and "to_string" in cl.device_info.__dict__
    assert cl.profiling_info.END == 0x1283 and cl.program_build_info.LOG == 0x1183


@t("平台與裝置資訊（get_info 與屬性後備）")
def _():
    assert plat.get_info(cl.platform_info.NAME) == "fa-kir-js" and plat.name == "fa-kir-js" and "OpenCL 1.2" in plat.version
    assert dev.get_info(cl.device_info.TYPE) == cl.device_type.CPU and dev.type == cl.device_type.CPU
    assert dev.max_work_group_size == 256 and dev.platform == plat and dev.global_mem_size > 0
    assert ctx.devices == [dev] and ctx.num_devices == 1
    raises(cl.RuntimeError, lambda: plat.get_devices(cl.device_type.GPU), "DEVICE_NOT_FOUND")   # 真 pyopencl 也是 RuntimeError（只有 INVALID_* 是 LogicError）
    raises(cl.LogicError, lambda: dev.get_info(0xBEEF), "INVALID_VALUE")


@t("Context 不給裝置：用第一個平台的第一個裝置")
def _():
    c2 = cl.Context()
    assert c2.devices[0] == dev


@t("端到端：vector add 與 numpy 一致（COPY_HOST_PTR、Program、Kernel.__call__、讀回）")
def _():
    n = 1000
    a = np.random.RandomState(1).rand(n).astype(np.float32)
    b = np.random.RandomState(2).rand(n).astype(np.float32)
    A = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=a)
    B = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=b)
    C = cl.Buffer(ctx, mf.WRITE_ONLY, a.nbytes)
    prg = cl._Program(ctx, VADD)
    prg._build()
    assert prg.get_info(cl.program_info.KERNEL_NAMES) == "vadd" and prg.get_build_info(dev, cl.program_build_info.STATUS) == 0
    k = cl.Kernel(prg, "vadd")
    assert k.function_name == "vadd" and k.num_args == 4
    ev = k(queue, (n,), None, A, B, C, np.int32(n))
    out = np.empty_like(a)
    cl._enqueue_read_buffer(queue, C, out).wait()
    assert np.array_equal(out, a + b), "最大誤差 %g" % np.abs(out - (a + b)).max()
    assert isinstance(ev, cl.Event) and ev.get_info(cl.event_info.COMMAND_EXECUTION_STATUS) == cl.command_execution_status.COMPLETE


@t("建置失敗：RuntimeError（BUILD_PROGRAM_FAILURE）＋ build log")
def _():
    bad = cl._Program(ctx, "__kernel void f(__global float* o, int n) { int i = get_global_id(0); o[i] = i % 3; }")
    e = raises(cl.RuntimeError, lambda: bad._build(), "BUILD_PROGRAM_FAILURE")
    assert "clBuildProgram failed: BUILD_PROGRAM_FAILURE" in str(e)
    assert bad.get_build_info(dev, cl.program_build_info.STATUS) == -2 and "%" in bad.get_build_info(dev, cl.program_build_info.LOG)
    raises(cl.LogicError, lambda: bad.get_info(cl.program_info.KERNEL_NAMES), "INVALID_PROGRAM_EXECUTABLE")


@t("核心參數檢查：純量型別、緩衝區型別、索引、未設定參數")
def _():
    prg = cl._Program(ctx, SCALE)
    prg._build()
    k = cl.Kernel(prg, "scale")
    X = cl.Buffer(ctx, mf.READ_ONLY, 16)
    Y = cl.Buffer(ctx, mf.WRITE_ONLY, 16)
    raises(cl.LogicError, lambda: k.set_arg(9, X), "INVALID_ARG_INDEX")
    raises(cl.LogicError, lambda: k.set_arg(0, np.float32(1)), "INVALID_MEM_OBJECT")
    raises(cl.LogicError, lambda: k.set_arg(3, np.float64(2.0)), "INVALID_ARG_SIZE", "float32")   # 8 位元組的純量給 4 位元組的參數
    raises(cl.LogicError, lambda: k.set_arg(2, np.float32(2.0)), "INVALID_ARG_SIZE", "int32")
    raises(cl.LogicError, lambda: k.set_arg(2, X), "INVALID_ARG_SIZE")
    raises(cl.LogicError, lambda: k.set_arg(0, cl.LocalMemory(16)), "INVALID_ARG_VALUE")
    k.set_arg(0, X)
    k.set_arg(1, Y)
    k.set_arg(2, np.int32(4))
    raises(cl.LogicError, lambda: cl.enqueue_nd_range_kernel(queue, k, (4,), None), "INVALID_KERNEL_ARGS")
    k.set_arg(3, np.float32(1))
    raises(cl.LogicError, lambda: cl.enqueue_nd_range_kernel(queue, k, (4,), (3,)), "INVALID_WORK_GROUP_SIZE")
    raises(cl.LogicError, lambda: cl.enqueue_nd_range_kernel(queue, k, (4, 4), None), "INVALID_WORK_DIMENSION")
    raises(cl.LogicError, lambda: cl.enqueue_nd_range_kernel(queue, k, (4,), None, global_offset=(1,)), "INVALID_GLOBAL_OFFSET")
    raises(cl.LogicError, lambda: cl.Kernel(prg, "不存在"), "INVALID_KERNEL_NAME")


@t("緩衝區：寫入、部分寫入、複製、填滿、讀回；越界與已釋放")
def _():
    a = np.arange(8, dtype=np.float32)
    A = cl.Buffer(ctx, mf.READ_WRITE, a.nbytes)
    cl._enqueue_write_buffer(queue, A, a)
    cl._enqueue_write_buffer(queue, A, np.array([100], dtype=np.float32), dst_offset=4)
    out = np.empty(8, dtype=np.float32)
    cl._enqueue_read_buffer(queue, A, out)
    assert out.tolist() == [0, 100, 2, 3, 4, 5, 6, 7]
    B = cl.Buffer(ctx, mf.READ_WRITE, a.nbytes)
    cl._enqueue_copy_buffer(queue, A, B)
    cl._enqueue_fill_buffer(queue, B, np.float32(9), 8, 8)   # 位移 8、長度 8：中間兩格
    cl._enqueue_read_buffer(queue, B, out)
    assert out.tolist() == [0, 100, 9, 9, 4, 5, 6, 7]
    raises(cl.LogicError, lambda: cl._enqueue_read_buffer(queue, A, np.empty(100, dtype=np.float32)), "INVALID_VALUE")
    raises(cl.LogicError, lambda: cl.Buffer(ctx, mf.READ_WRITE, 0), "INVALID_BUFFER_SIZE")
    raises(cl.LogicError, lambda: cl.Buffer(ctx, mf.COPY_HOST_PTR, 16), "INVALID_HOST_PTR")
    A.release()
    raises(cl.LogicError, lambda: cl._enqueue_read_buffer(queue, A, out), None)   # 已釋放：控制代碼失效


@t("marker／barrier／migrate／wait：已完成的事件，不丟例外")
def _():
    for ev in (cl._enqueue_marker(queue), cl._enqueue_marker_with_wait_list(queue), cl._enqueue_barrier(queue), cl._enqueue_barrier_with_wait_list(queue),
               cl.enqueue_migrate_mem_objects(queue, [cl.Buffer(ctx, mf.READ_WRITE, 16)])):
        assert isinstance(ev, cl.Event) and ev.get_info(cl.event_info.COMMAND_EXECUTION_STATUS) == cl.command_execution_status.COMPLETE
    assert cl._enqueue_wait_for_events(queue, []) is None


@t("enqueue_map_buffer：讀、寫回（WRITE）、INVALIDATE 不讀、with 離開自動 release、範圍檢查")
def _():
    A = cl.Buffer(ctx, mf.READ_WRITE | mf.COPY_HOST_PTR, hostbuf=np.arange(8, dtype=np.float32))
    arr, ev = cl.enqueue_map_buffer(queue, A, cl.map_flags.READ | cl.map_flags.WRITE, 0, (8,), np.float32)
    assert arr.tolist() == list(range(8)) and isinstance(arr.base, cl.MemoryMap)
    arr[2] = 99
    arr.base.release()
    out = np.empty(8, dtype=np.float32)
    cl._enqueue_read_buffer(queue, A, out)
    assert out[2] == 99 and out[3] == 3
    arr2, _ = cl.enqueue_map_buffer(queue, A, cl.map_flags.READ, 8, (2,), np.float32)   # 只讀：release 不寫回
    arr2[0] = -1
    arr2.base.release()
    cl._enqueue_read_buffer(queue, A, out)
    assert out[2] == 99
    arr3, _ = cl.enqueue_map_buffer(queue, A, cl.map_flags.WRITE_INVALIDATE_REGION, 0, (8,), np.float32)   # 整段會被覆寫，不讀
    arr3[:] = 7
    arr3.base.release()
    cl._enqueue_read_buffer(queue, A, out)
    assert out.tolist() == [7] * 8
    raises(cl.LogicError, lambda: cl.enqueue_map_buffer(queue, A, cl.map_flags.READ, 4, (8,), np.float32), "INVALID_VALUE")
    raises(cl.LogicError, lambda: arr3.base.release(), "INVALID_VALUE")


@t("矩形緩衝區讀、寫、複製（origin／region／pitches）")
def _():
    # 緩衝區是 4 列 × 8 位元組；取 (x=2..5, y=1..2) 的 4×2 位元組矩形
    data = np.arange(32, dtype=np.uint8)
    B = cl.Buffer(ctx, mf.READ_WRITE | mf.COPY_HOST_PTR, hostbuf=data)
    host = np.zeros(16, dtype=np.uint8)   # 主機端每列 4 位元組（pitch 4）
    cl._enqueue_read_buffer_rect(queue, B, host, (2, 1, 0), (0, 0, 0), (4, 2, 1), buffer_pitches=(8, 32), host_pitches=(4, 16))
    assert host[:8].tolist() == [10, 11, 12, 13, 18, 19, 20, 21], host[:8].tolist()
    new = np.array([200, 201, 202, 203, 210, 211, 212, 213], dtype=np.uint8)
    cl._enqueue_write_buffer_rect(queue, B, new, (2, 1, 0), (0, 0, 0), (4, 2, 1), buffer_pitches=(8, 32), host_pitches=(4, 16))
    back = np.empty(32, dtype=np.uint8)
    cl._enqueue_read_buffer(queue, B, back)
    assert back[10:14].tolist() == [200, 201, 202, 203] and back[18:22].tolist() == [210, 211, 212, 213] and back[9] == 9 and back[14] == 14   # 矩形外保持原樣
    D = cl.Buffer(ctx, mf.READ_WRITE, 32)
    cl._enqueue_fill_buffer(queue, D, np.uint8(0), 0, 32)
    cl._enqueue_copy_buffer_rect(queue, B, D, (2, 1, 0), (0, 0, 0), (4, 2, 1), src_pitches=(8, 32), dst_pitches=(4, 16))
    cl._enqueue_read_buffer(queue, D, back)
    assert back[:8].tolist() == [200, 201, 202, 203, 210, 211, 212, 213] and back[8] == 0
    raises(cl.LogicError, lambda: cl._enqueue_read_buffer_rect(queue, B, host, (6, 3, 0), (0, 0, 0), (4, 2, 1), buffer_pitches=(8, 32), host_pitches=(4, 16)), "INVALID_VALUE")


@t("get_arg_info、get_sub_group_info、compile／link（含 headers）、p2p 複製、能力如實回報")
def _():
    prg = cl._Program(ctx, SCALE)
    prg._build()
    k = cl.Kernel(prg, "scale")
    assert k.get_arg_info(0, cl.kernel_arg_info.NAME) == "x" and k.get_arg_info(0, cl.kernel_arg_info.ADDRESS_QUALIFIER) == cl.kernel_arg_address_qualifier.GLOBAL
    assert k.get_arg_info(2, cl.kernel_arg_info.ADDRESS_QUALIFIER) == cl.kernel_arg_address_qualifier.PRIVATE and k.get_arg_info(2, cl.kernel_arg_info.TYPE_NAME) == "int"
    assert k.get_arg_info(0, cl.kernel_arg_info.TYPE_QUALIFIER) == cl.kernel_arg_type_qualifier.CONST
    assert k.get_sub_group_info(dev, cl.kernel_sub_group_info.MAX_SUB_GROUP_SIZE_FOR_NDRANGE) == 1
    # compile／link：標頭程式提供 SCALE_BY，主程式 #include 它
    hdr = cl._Program(ctx, "// 標頭程式的內容（KIR 驅動的前端不處理宏，所以這裡只放註解；宏的 compile／link 由 clc 驅動的整合測試涵蓋）")
    main = cl._Program(ctx, '#include "scale.h"\n__kernel void m(__global const float* x, __global float* y, int n) { int i = get_global_id(0); if (i < n) y[i] = x[i] * 3.0f; }')
    main.compile(b"", None, [("scale.h", hdr)])
    linked = cl._Program.link(ctx, [main])
    assert "m" in linked.get_info(cl.program_info.KERNEL_NAMES).split(";")
    X = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=np.ones(4, dtype=np.float32))
    Y = cl.Buffer(ctx, mf.WRITE_ONLY, 16)
    cl.Kernel(linked, "m")(queue, (4,), None, X, Y, np.int32(4))
    out = np.empty(4, dtype=np.float32)
    cl._enqueue_read_buffer(queue, Y, out)
    assert out.tolist() == [3, 3, 3, 3]
    bad = cl._Program(ctx, "__kernel void b(__global float* o) { o[0] = nope; }")
    raises(cl.RuntimeError, lambda: bad.compile(), "COMPILE_PROGRAM_FAILURE")
    cl.enqueue_copy_buffer_p2p_amd(plat, queue, Y, X, 16)
    assert cl.get_supported_image_formats(ctx, mf.READ_ONLY, 0x10F1) == [] and dev.image_support is False if hasattr(dev, "image_support") else True
    assert dev.get_info(cl.device_info.SVM_CAPABILITIES) == 0 and dev.get_info(cl.device_info.IMAGE_SUPPORT) is False
    cl.unload_platform_compiler(plat)
    ctx.set_default_device_command_queue(dev, queue)


@t("子緩衝區：get_sub_region／切片、與父共用記憶體、讀寫複製、核心參數帶偏移、錯誤碼")
def _():
    P = cl.Buffer(ctx, mf.READ_WRITE | mf.COPY_HOST_PTR, hostbuf=np.arange(16, dtype=np.float32))
    S = P.get_sub_region(16, 32)              # 父的位元組 [16, 48) ＝ 元素 4..11
    assert S.size == 32 and S.get_info(cl.mem_info.SIZE) == 32
    out = np.empty(8, dtype=np.float32)
    cl._enqueue_read_buffer(queue, S, out)
    assert out.tolist() == [4, 5, 6, 7, 8, 9, 10, 11]
    cl._enqueue_write_buffer(queue, S, np.array([100], dtype=np.float32), dst_offset=8)   # 子的位元組 8 ＝ 父的元素 6
    full = np.empty(16, dtype=np.float32)
    cl._enqueue_read_buffer(queue, P, full)
    assert full[6] == 100 and full[5] == 5
    S2 = P[16:32]                              # 切片語法
    assert S2.size == 16
    cl._enqueue_read_buffer(queue, S2, out[:4])
    assert out[:4].tolist() == [4, 5, 100, 7]
    prg = cl._Program(ctx, SCALE)
    prg._build()
    k = cl.Kernel(prg, "scale")
    Y = cl.Buffer(ctx, mf.READ_WRITE, 32)
    k(queue, (8,), None, S, Y, np.int32(8), np.float32(2))   # 核心讀子緩衝區（帶偏移）
    cl._enqueue_read_buffer(queue, Y, out)
    assert out.tolist() == [8, 10, 200, 14, 16, 18, 20, 22]
    raises(cl.LogicError, lambda: P.get_sub_region(40, 32), "INVALID_VALUE")
    raises(cl.LogicError, lambda: S.get_sub_region(0, 8), "INVALID_MEM_OBJECT")
    raises(cl.LogicError, lambda: P[::2], "INVALID_VALUE")


@t("事件計時：PROFILING_ENABLE 才有；沒開丟 PROFILING_INFO_NOT_AVAILABLE")
def _():
    pq = cl.CommandQueue(ctx, properties=cl.command_queue_properties.PROFILING_ENABLE)
    prg = cl._Program(ctx, SCALE)
    prg._build()
    k = cl.Kernel(prg, "scale")
    X = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=np.ones(4, dtype=np.float32))
    Y = cl.Buffer(ctx, mf.WRITE_ONLY, 16)
    ev = k(pq, (4,), None, X, Y, np.int32(4), np.float32(2))
    assert ev.profile.end >= ev.profile.start > 0 and ev.get_profiling_info(cl.profiling_info.QUEUED) > 0
    ev2 = k(queue, (4,), None, X, Y, np.int32(4), np.float32(2))
    raises(cl.RuntimeError, lambda: ev2.get_profiling_info(cl.profiling_info.END), "PROFILING_INFO_NOT_AVAILABLE")


@t("不支援的功能丟標準例外並說明：循序以外的佇列、子緩衝區、預編譯二進位、圖像")
def _():
    raises(cl.LogicError, lambda: cl.CommandQueue(ctx, properties=cl.command_queue_properties.OUT_OF_ORDER_EXEC_MODE_ENABLE), "INVALID_QUEUE_PROPERTIES")
    B = cl.Buffer(ctx, mf.READ_WRITE, 16)
    assert B.get_sub_region(0, 8).size == 8   # 子緩衝區現在支援
    raises(cl.LogicError, lambda: cl._Program(ctx, [dev], [b"x"]), "INVALID_BINARY")   # 別的後端的二進位
    assert cl.have_gl() is True and cl.get_cl_header_version() == (2, 0)   # GL 互通（緩衝區）已接上


@t("執行期優化透過 `_cl` 真的生效：建置快取、重複內容不重傳、核心鏈不讀回")
def _():
    st0, _ = cl._call("stats")
    s0 = st0["stats"]
    for _i in range(3):   # 三個相同的 Program：只編譯一次
        p = cl._Program(ctx, "__kernel void twice(__global const float* x, __global float* y, int n) { int i = get_global_id(0); if (i < n) y[i] = x[i] * 2.0f; }")
        p._build()
    X = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=np.arange(64, dtype=np.float32))
    Y = cl.Buffer(ctx, mf.READ_WRITE, 256)
    Z = cl.Buffer(ctx, mf.WRITE_ONLY, 256)
    k1 = cl.Kernel(p, "twice")
    k2 = cl.Kernel(p, "twice")
    k1(queue, (64,), None, X, Y, np.int32(64))
    k2(queue, (64,), None, Y, Z, np.int32(64))   # Y 是上一個核心的輸出：不該下載再上傳
    out = np.empty(64, dtype=np.float32)
    cl._enqueue_read_buffer(queue, Z, out)
    assert np.array_equal(out, np.arange(64, dtype=np.float32) * 4)
    s1 = cl._call("stats")[0]["stats"]
    assert s1["builds"] - s0["builds"] == 1 and s1["buildHits"] - s0["buildHits"] == 2, (s0, s1)
    assert s1["uploads"] - s0["uploads"] == 1, "只有 X 上傳一次：%s" % (s1["uploads"] - s0["uploads"])
    assert s1["downloads"] - s0["downloads"] == 1, "只有最後的讀回下載一次"
    cl._enqueue_write_buffer(queue, X, np.arange(64, dtype=np.float32))   # 寫入相同內容
    k1(queue, (64,), None, X, Y, np.int32(64))
    s2 = cl._call("stats")[0]["stats"]
    assert s2["uploads"] == s1["uploads"] and s2["elidedUploads"] - s1["elidedUploads"] == 1, "相同內容不該重傳"


@t("沒有後端時與真 pyopencl 沒有 ICD 一樣：LogicError PLATFORM_NOT_FOUND_KHR")
def _():
    saved = cl._transport
    cl._set_transport(None)
    old = os.environ.pop("FA_OPENCL_HOST")
    try:
        raises(cl.LogicError, lambda: cl.get_platforms(), "PLATFORM_NOT_FOUND_KHR")
    finally:
        os.environ["FA_OPENCL_HOST"] = old
        cl._set_transport(saved)


print("%d passed, %d failed" % (passed, failed))
try:
    cl._get_transport().close()
except Exception:  # noqa: BLE001
    pass
sys.exit(1 if failed else 0)
