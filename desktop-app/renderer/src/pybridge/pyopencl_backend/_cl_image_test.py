"""圖像／取樣器與 SVM 的端到端測試（Python 的 _cl → stdio → 載入器 → clc 驅動）。
用法：FA_CL_DRIVERS=clc FA_OPENCL_HOST=<cl_host_stdio.js> python3 -I _cl_image_test.py"""
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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
        except Exception:  # noqa: BLE001
            failed += 1
            import traceback
            print("FAIL " + name + "\n   " + "\n   ".join(traceback.format_exc().splitlines()[-6:]))
        return fn
    return deco


mf, co, ct = cl.mem_flags, cl.channel_order, cl.channel_type
ctx = cl.Context([cl.get_platforms()[0].get_devices()[0]])
queue = cl.CommandQueue(ctx)
FMT = cl.ImageFormat(co.RGBA, ct.UNORM_INT8)


def run(src, name, gws, *args):
    prg = cl._Program(ctx, src)
    prg._build()
    k = cl.Kernel(prg, name)
    k(queue, gws, None, *args)


def rd(img, origin, region, dtype, shape):
    out = np.zeros(shape, dtype)
    cl._enqueue_read_image(queue, img, origin, region, out)
    return out


def img2d(shape_wh, fmt=FMT, host=None, flags=mf.READ_WRITE):
    d = cl.ImageDescriptor()
    d.image_type, d.shape = cl.mem_object_type.IMAGE2D, shape_wh
    if host is not None:
        return cl.Image(ctx, flags | mf.COPY_HOST_PTR, fmt, desc=d, hostbuf=host)
    return cl.Image(ctx, flags, fmt, desc=d)


@t("裝置回報圖像能力；支援格式清單不含打包型別與 RGB")
def _():
    dev = ctx.devices[0]
    assert dev.image_support and dev.image2d_max_width >= 8192 and dev.max_samplers >= 16
    fs = cl.get_supported_image_formats(ctx, mf.READ_WRITE, cl.mem_object_type.IMAGE2D)
    names = {(f.channel_order, f.channel_data_type) for f in fs}
    assert (int(co.RGBA), int(ct.FLOAT)) in names and (int(co.RGBA), int(ct.UNORM_INT8)) in names
    assert not any(f.channel_data_type == int(ct.UNORM_SHORT_565) or f.channel_order == int(co.RGB) for f in fs)


@t("Image：info、shape、写入再讀回（含 host 的 row_pitch）")
def _():
    a = np.arange(4 * 3 * 4, dtype=np.uint8).reshape(3, 4, 4)   # 高 3、寬 4、RGBA
    im = img2d((4, 3), host=a)
    assert (im.width, im.height, im.depth, im.element_size, im.row_pitch) == (4, 3, 0, 4, 16)
    assert im.type == cl.mem_object_type.IMAGE2D and im.format.channel_order == int(co.RGBA)
    assert (rd(im, (0, 0), (4, 3), np.uint8, a.shape) == a).all()
    assert (rd(im, (1, 1), (2, 2), np.uint8, (2, 2, 4)) == a[1:3, 1:3]).all()
    padded = np.zeros((3, 5, 4), np.uint8)   # 主機端每列多一個像素（row_pitch 20）
    padded[:, :4] = a
    im2 = img2d((4, 3))
    cl._enqueue_write_image(queue, im2, (0, 0), (4, 3), padded, row_pitch=20)
    assert (rd(im2, (0, 0), (4, 3), np.uint8, a.shape) == a).all()
    back = np.zeros((3, 5, 4), np.uint8)   # 讀回到有 pitch 的主機陣列
    cl._enqueue_read_image(queue, im2, (0, 0), (4, 3), back, row_pitch=20)
    assert (back[:, :4] == a).all() and (back[:, 4] == 0).all()


@t("核心：read_imagef／write_imagef（UNORM 換算）、取樣器當參數")
def _():
    src = np.array([[[0, 51, 102, 255], [255, 0, 0, 255]]], np.uint8)   # 1 列 2 欄
    a, b = img2d((2, 1), host=src), img2d((2, 1))
    SRC = ("""__kernel void inv(__read_only image2d_t a, __write_only image2d_t b, sampler_t s) {
      int x = get_global_id(0); float4 p = read_imagef(a, s, (int2)(x, 0)); write_imagef(b, (int2)(x, 0), (float4)(1.0f - p.x, 1.0f - p.y, 1.0f - p.z, p.w)); }""")
    s = cl.Sampler(ctx, False, cl.addressing_mode.CLAMP_TO_EDGE, cl.filter_mode.NEAREST)
    run(SRC, "inv", (2,), a, b, s)
    out = rd(b, (0, 0), (2, 1), np.uint8, (1, 2, 4))
    assert out.tolist() == [[[255, 204, 153, 255], [0, 255, 255, 255]]], out.tolist()


@t("核心：FLOAT 圖像、線性過濾與 enqueue_fill_image")
def _():
    f = cl.ImageFormat(co.R, ct.FLOAT)
    im = img2d((2, 2), fmt=f, host=np.array([[1, 2], [3, 4]], np.float32))
    o = cl.Buffer(ctx, mf.WRITE_ONLY, 4)
    run("""__kernel void k(__read_only image2d_t im, sampler_t s, __global float* o) { o[0] = read_imagef(im, s, (float2)(1.0f, 1.0f)).x; }""", "k", (1,),
        im, cl.Sampler(ctx, False, cl.addressing_mode.CLAMP_TO_EDGE, cl.filter_mode.LINEAR), o)
    r = np.zeros(1, np.float32)
    cl._enqueue_read_buffer(queue, o, r)
    assert r[0] == 2.5, r   # (1,1) 在四個像素的交界：平均
    cl.enqueue_fill_image(queue, im, np.array([7, 0, 0, 0], np.float32), origin=(0, 0), region=(2, 2))
    assert (rd(im, (0, 0), (2, 2), np.float32, (2, 2)) == 7).all()


@t("3D、copy_image、image↔buffer、map_image")
def _():
    f = cl.ImageFormat(co.R, ct.UNSIGNED_INT16)
    d = cl.ImageDescriptor()
    d.image_type, d.shape = cl.mem_object_type.IMAGE3D, (2, 2, 2)
    vol = np.arange(8, dtype=np.uint16).reshape(2, 2, 2)
    a = cl.Image(ctx, mf.READ_WRITE | mf.COPY_HOST_PTR, f, desc=d, hostbuf=vol)
    assert (a.width, a.height, a.depth) == (2, 2, 2)
    b = cl.Image(ctx, mf.READ_WRITE, f, desc=d)
    cl._enqueue_copy_image(queue, a, b, (0, 0, 0), (0, 0, 0), (2, 2, 2))
    buf = cl.Buffer(ctx, mf.READ_WRITE, 16)
    cl._enqueue_copy_image_to_buffer(queue, b, buf, (0, 0, 0), (2, 2, 2), 0)
    out = np.zeros(8, np.uint16)
    cl._enqueue_read_buffer(queue, buf, out)
    assert out.tolist() == list(range(8))
    cl._enqueue_copy_buffer_to_image(queue, buf, a, 0, (0, 0, 0), (2, 2, 2))
    m, ev, rp, sp = cl.enqueue_map_image(queue, a, cl.map_flags.READ | cl.map_flags.WRITE, (0, 0, 0), (2, 2, 2), (2, 2, 2), np.uint16)
    assert (m == vol).all() and rp == 4 and sp == 8
    m[1, 1, 1] = 99
    m.base.release()
    assert rd(a, (0, 0, 0), (2, 2, 2), np.uint16, (2, 2, 2))[1, 1, 1] == 99


@t("錯誤：格式不符、越界、不支援的格式與 IMAGE1D_BUFFER、型別對不上")
def _():
    a, b = img2d((2, 2)), img2d((2, 2), fmt=cl.ImageFormat(co.RGBA, ct.FLOAT))
    for fn, name in ((lambda: cl._enqueue_copy_image(queue, a, b, (0, 0), (0, 0), (2, 2)), "IMAGE_FORMAT_MISMATCH"),
                     (lambda: cl._enqueue_read_image(queue, a, (1, 1), (4, 4), np.zeros((4, 4, 4), np.uint8)), "INVALID_VALUE")):
        try:
            fn()
        except cl.Error as e:
            assert e.code == getattr(cl.status_code, name), (e.code, name, str(e))
        else:
            raise AssertionError("沒有丟出 " + name)
    try:
        img2d((2, 2), fmt=cl.ImageFormat(co.RGB, ct.UNORM_SHORT_565))
    except cl.Error as e:
        assert e.code == cl.status_code.IMAGE_FORMAT_NOT_SUPPORTED, e.code
    else:
        raise AssertionError("打包格式應該被拒絕")
    prg = cl._Program(ctx, "__kernel void k(__read_only image2d_t a, __global float* o) { o[0] = 1.0f; }")
    prg._build()
    k = cl.Kernel(prg, "k")
    try:
        k.set_arg(0, cl.Buffer(ctx, mf.READ_WRITE, 16))
    except cl.Error as e:
        assert e.code == cl.status_code.INVALID_MEM_OBJECT
    else:
        raise AssertionError("緩衝區不能傳給圖像參數")


@t("SVM：SVMAllocation 與 numpy 共用主機記憶體、核心讀寫、拉回；SVM(...) 包裝與位移")
def _():
    assert ctx.devices[0].svm_capabilities & cl.device_svm_capabilities.COARSE_GRAIN_BUFFER
    n = 64
    al = cl.SVMAllocation(ctx, n * 4, 0, cl.svm_mem_flags.READ_WRITE)
    arr = np.frombuffer((__import__("ctypes").c_float * n).from_address(al.svm_ptr), dtype=np.float32)
    arr[:] = np.arange(n, dtype=np.float32)
    src = "__kernel void dbl(__global float* x) { int i = get_global_id(0); x[i] = x[i] * 2.0f; }"
    run(src, "dbl", (n,), al)
    assert (arr == np.arange(n) * 2).all(), arr[:4]
    run(src, "dbl", (n,), al)   # 第二次：主機端沒改，只拉不推
    assert (arr == np.arange(n) * 4).all()
    arr[0] = 5   # 主機端改了內容 → 下次啟動前推上去
    run(src, "dbl", (n,), cl.SVM(arr))
    assert arr[0] == 10 and arr[1] == 8
    half = cl.SVM(arr[32:])   # 指標位移：核心看到的是後半段
    run(src, "dbl", (32,), half)
    assert arr[32] == 32 * 16 and arr[0] == 10   # 32 → 64 → 128 → 256（第三次整段）→ 512（後半段）
    al.release()
    try:
        run(src, "dbl", (n,), cl.SVM(np.zeros(4, np.float32)))
    except cl.Error as e:
        assert e.code == cl.status_code.INVALID_ARG_VALUE, e.code
    else:
        raise AssertionError("不在 SVM 區塊裡的位址應該被拒絕")


@t("SVM：memcpy／memfill／map／池與分配器；不支援的旗標如實拒絕")
def _():
    a = cl.SVMAllocation(ctx, 32, 0, cl.svm_mem_flags.READ_WRITE)
    b = cl.SVMAllocation(ctx, 32, 0, cl.svm_mem_flags.READ_WRITE)
    cl._enqueue_svm_memfill(queue, a, np.array([7], np.uint8))
    assert (a.buf == 7).all()
    cl._enqueue_svm_memcpy(queue, True, b, a)
    assert (b.buf == 7).all() and b.size == 32
    src = np.arange(32, dtype=np.uint8)
    cl._enqueue_svm_memcpy(queue, True, a, cl.SVM(src))
    assert (a.buf == src).all()
    cl._enqueue_svm_map(queue, True, cl.map_flags.READ, a)
    cl._enqueue_svm_unmap(queue, a)
    pool = cl.SVMPool(cl.SVMAllocator(ctx, 0, cl.svm_mem_flags.READ_WRITE))
    p1 = pool(100)
    assert pool.active_blocks == 1 and p1.size == 100 and pool.alloc_size(pool.bin_number(100)) == 128
    ptr = p1.svm_ptr
    p1.release()
    assert pool.held_blocks == 1 and pool(90).svm_ptr == ptr   # 同箱重用
    try:
        cl.SVMAllocation(ctx, 16, 0, cl.svm_mem_flags.SVM_FINE_GRAIN_BUFFER)
    except cl.Error as e:
        assert e.code == cl.status_code.INVALID_VALUE
    else:
        raise AssertionError("細粒度應該被拒絕（裝置沒有回報這個能力）")


print("%d passed, %d failed" % (passed, failed))
try:
    cl._get_transport().close()
except Exception:  # noqa: BLE001
    pass
sys.exit(1 if failed else 0)
