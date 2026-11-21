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
    assert not any((f.channel_order in (int(co.RGB), 0x10bc)) != (f.channel_data_type in (int(ct.UNORM_SHORT_565), int(ct.UNORM_SHORT_555), int(ct.UNORM_INT_101010))) for f in fs)   # RGB 只配打包型別


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


@t("錯誤：格式不符、越界、不合法的格式組合、型別對不上")
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
        img2d((2, 2), fmt=cl.ImageFormat(co.RGB, ct.FLOAT))
    except cl.Error as e:
        assert e.code == cl.status_code.IMAGE_FORMAT_NOT_SUPPORTED, e.code
    else:
        raise AssertionError("RGB 配 FLOAT 應該被拒絕")
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


@t("打包格式 565／555／101010（RGB）往返與核心讀取；RGB 只能配打包型別")
def _():
    for ctype, bpp, vals in ((ct.UNORM_SHORT_565, 2, (1.0, 0.0, 1.0)), (ct.UNORM_SHORT_555, 2, (0.0, 1.0, 0.0)), (ct.UNORM_INT_101010, 4, (1.0, 0.0, 1.0))):
        im = img2d((2, 1), fmt=cl.ImageFormat(co.RGB, ctype))
        assert im.element_size == bpp
        o = cl.Buffer(ctx, mf.READ_WRITE, 32)
        run("""__kernel void w(__write_only image2d_t im) { write_imagef(im, (int2)(get_global_id(0), 0), (float4)(%ff, %ff, %ff, 1.0f)); }""" % vals, "w", (2,), im)
        run("""__kernel void r(__read_only image2d_t im, __global float* o) { float4 p = read_imagef(im, (int2)(1, 0)); o[0] = p.x; o[1] = p.y; o[2] = p.z; o[3] = p.w; }""", "r", (1,), im, o)
        r = np.zeros(4, np.float32)
        cl._enqueue_read_buffer(queue, o, r)
        assert r.tolist() == [vals[0], vals[1], vals[2], 1.0], (ctype, r)
    assert any(f.channel_order == int(co.RGB) and f.channel_data_type == int(ct.UNORM_SHORT_565) for f in cl.get_supported_image_formats(ctx, mf.READ_WRITE, cl.mem_object_type.IMAGE2D))
    try:
        img2d((2, 2), fmt=cl.ImageFormat(co.RGB, ct.FLOAT))
    except cl.Error as e:
        assert e.code == cl.status_code.IMAGE_FORMAT_NOT_SUPPORTED
    else:
        raise AssertionError("RGB 配 FLOAT 應該被拒絕")
    raw = np.array([0x07E0, 0xF800], np.uint16)   # 565：綠、紅
    im = img2d((2, 1), fmt=cl.ImageFormat(co.RGB, ct.UNORM_SHORT_565), host=raw)
    o = cl.Buffer(ctx, mf.READ_WRITE, 32)
    run("""__kernel void r(__read_only image2d_t im, __global float* o) { float4 a = read_imagef(im, (int2)(0, 0)); float4 b = read_imagef(im, (int2)(1, 0)); o[0] = a.y; o[1] = a.x; o[2] = b.x; }""", "r", (1,), im, o)
    r = np.zeros(3, np.float32)
    cl._enqueue_read_buffer(queue, o, r)
    assert r.tolist() == [1.0, 0.0, 1.0]


@t("IMAGE1D_BUFFER：與緩衝區共用記憶體（雙向可見）")
def _():
    buf = cl.Buffer(ctx, mf.READ_WRITE | mf.COPY_HOST_PTR, hostbuf=np.arange(8, dtype=np.float32))
    d = cl.ImageDescriptor()
    d.image_type, d.shape, d.buffer = cl.mem_object_type.IMAGE1D_BUFFER, (8,), buf
    im = cl.Image(ctx, mf.READ_WRITE, cl.ImageFormat(co.R, ct.FLOAT), desc=d)
    assert im.type == cl.mem_object_type.IMAGE1D_BUFFER and im.get_image_info(cl.image_info.BUFFER) is buf
    o = cl.Buffer(ctx, mf.READ_WRITE, 32)
    run("""__kernel void k(__read_only image1d_buffer_t im, __global float* o) { int i = get_global_id(0); o[i] = read_imagef(im, i).x * 10.0f; }""", "k", (8,), im, o)
    r = np.zeros(8, np.float32)
    cl._enqueue_read_buffer(queue, o, r)
    assert r.tolist() == [i * 10.0 for i in range(8)]
    run("""__kernel void w(__write_only image1d_buffer_t im) { write_imagef(im, (int)get_global_id(0), (float4)(100.0f + get_global_id(0), 0, 0, 0)); }""", "w", (8,), im)
    cl._enqueue_read_buffer(queue, buf, r)   # 寫圖像，緩衝區看得到
    assert r.tolist() == [100.0 + i for i in range(8)]
    cl._enqueue_write_buffer(queue, buf, np.full(8, 3, np.float32))   # 寫緩衝區，圖像看得到
    assert rd(im, (0,), (8,), np.float32, (8,)).tolist() == [3.0] * 8


@t("Pipe：寫入、讀出、空／滿回 -1、reserve 版本、struct／向量封包、跨啟動保留")
def _():
    pipe = cl.Pipe(ctx, 0, 4, 8)
    assert pipe.get_pipe_info(cl.pipe_info.PACKET_SIZE) == 4 and pipe.get_pipe_info(cl.pipe_info.MAX_PACKETS) == 8 and pipe.type == cl.mem_object_type.PIPE
    out = cl.Buffer(ctx, mf.READ_WRITE, 64)
    prod = "__kernel void prod(__write_only pipe float p, __global int* r) { int i = get_global_id(0); float v = 1.5f * i; r[i] = write_pipe(p, &v); }"
    cons = "__kernel void cons(__read_only pipe float p, __global float* o, __global int* r) { int i = get_global_id(0); float v = -1.0f; r[i] = read_pipe(p, &v); o[i] = v; }"
    res = cl.Buffer(ctx, mf.READ_WRITE, 64)
    run(prod, "prod", (10,), pipe, res)   # 容量 8：前 8 個成功，後 2 個滿了
    r = np.zeros(10, np.int32)
    cl._enqueue_read_buffer(queue, res, r)
    assert r.tolist() == [0] * 8 + [-1] * 2, r
    run(cons, "cons", (10,), pipe, out, res)   # 在另一次啟動讀：8 個成功、2 個空
    o = np.zeros(10, np.float32)
    cl._enqueue_read_buffer(queue, out, o)
    cl._enqueue_read_buffer(queue, res, r)
    assert r.tolist() == [0] * 8 + [-1] * 2 and o[:8].tolist() == [1.5 * i for i in range(8)] and o[8] == -1.0, (r, o)
    vp = cl.Pipe(ctx, 0, 16, 4)
    src = """__kernel void k(__write_only pipe float4 w, __read_only pipe float4 rd, __global float* o) {
      float4 v = (float4)(1.0f, 2.0f, 3.0f, 4.0f); write_pipe(w, &v);
      reserve_id_t id = reserve_write_pipe(w, 2); if (is_valid_reserve_id(id)) { float4 a = v * 2.0f; float4 b = v * 3.0f; write_pipe(w, id, 0, &a); write_pipe(w, id, 1, &b); commit_write_pipe(w, id); }
      o[0] = get_pipe_num_packets(w); o[1] = get_pipe_max_packets(w); }"""
    run(src.replace("__read_only pipe float4 rd, ", ""), "k", (1,), vp, out)
    o2 = np.zeros(2, np.float32)
    cl._enqueue_read_buffer(queue, out, o2)
    assert o2.tolist() == [3.0, 4.0], o2
    run("""__kernel void d(__read_only pipe float4 p, __global float* o) { reserve_id_t id = reserve_read_pipe(p, 3); float4 x, y, z; read_pipe(p, id, 0, &x); read_pipe(p, id, 1, &y); read_pipe(p, id, 2, &z); o[0] = x.w; o[1] = y.w; o[2] = z.w; }""", "d", (1,), vp, out)
    o3 = np.zeros(3, np.float32)
    cl._enqueue_read_buffer(queue, out, o3)
    assert o3.tolist() == [4.0, 8.0, 12.0], o3
    try:
        _p = cl._Program(ctx, prod)
        _p._build()
        k = cl.Kernel(_p, "prod")
        k.set_arg(0, cl.Buffer(ctx, mf.READ_WRITE, 16))
    except cl.Error as e:
        assert e.code == cl.status_code.INVALID_MEM_OBJECT
    else:
        raise AssertionError("緩衝區不能傳給 pipe 參數")
    try:
        cl.Pipe(ctx, 0, 0, 4)
    except cl.Error as e:
        assert e.code == cl.status_code.INVALID_PIPE_SIZE
    else:
        raise AssertionError("packet_size 0 應該被拒絕")


try:
    import OpenGL  # noqa: F401
    _HAVE_GL = True
except ImportError:
    _HAVE_GL = False


@t("GLTexture／GLRenderBuffer：acquire／release 同步、修訂號跳過、尺寸變更與不支援的目標")
def _():
    if not _HAVE_GL:
        return
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import fa_opengl_platform as P
    P.register()
    from OpenGL.GL import (glGenTextures, glBindTexture, glTexImage2D, glGenRenderbuffers, glBindRenderbuffer, glRenderbufferStorage, GL_TEXTURE_2D,
                           GL_RGBA, GL_RGBA8, GL_UNSIGNED_BYTE, GL_RENDERBUFFER)
    import ctypes

    class Store(object):
        def __init__(self):
            self.n, self.px, self.rb, self.tex2d, self.reads, self.writes = 0, {}, {}, None, 0, 0

        def __getattr__(self, name):
            return lambda *a, **k: ("h%d" % self.__dict__.setdefault("n", 0)) if name.startswith("create_") else None

        def create_texture(self):
            self.n += 1
            return "t%d" % self.n

        def create_renderbuffer(self):
            self.n += 1
            return "r%d" % self.n

        def bind_texture(self, tg, h):
            self.tex2d = h

        def tex_image_2d(self, tg, level, internal, w, h, border, fmt, typ, data):
            self.px[(self.tex2d, level)] = bytearray(data)

        def read_texture(self, h, level, w, ht, fmt, typ):
            self.reads += 1
            return bytes(self.px[(h, level)])

        def write_texture(self, h, level, w, ht, fmt, typ, data):
            self.writes += 1
            self.px[(h, level)][:] = data

        def read_renderbuffer(self, h, w, ht, fmt, typ):
            self.reads += 1
            return bytes(self.rb.get(h) or bytearray(w * ht * 4))

        def write_renderbuffer(self, h, w, ht, internal, fmt, typ, data):
            self.writes += 1
            self.rb[h] = bytearray(data)

    st = Store()
    P._CTX["backend"] = st
    tx = int(glGenTextures(1))
    glBindTexture(GL_TEXTURE_2D, tx)
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 4, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, (ctypes.c_ubyte * 32)(*range(32)))
    im = cl.GLTexture(ctx, mf.READ_WRITE, 0x0DE1, 0, tx, 2)
    assert im.type == cl.mem_object_type.IMAGE2D and (im.width, im.height) == (4, 2) and im.get_gl_object_info() == (cl.gl_object_type.TEXTURE2D, tx)
    assert im.get_gl_texture_info(cl.gl_texture_info.TEXTURE_TARGET) == 0x0DE1
    cl.enqueue_acquire_gl_objects(queue, [im])
    assert rd(im, (0, 0), (4, 2), np.uint8, (2, 4, 4)).reshape(-1).tolist() == list(range(32))
    run("""__kernel void inv(__read_write image2d_t im) { int x = get_global_id(0), y = get_global_id(1); float4 p = read_imagef(im, (int2)(x, y)); write_imagef(im, (int2)(x, y), (float4)(1.0f - p.x, p.y, p.z, p.w)); }""", "inv", (4, 2), im)
    cl.enqueue_release_gl_objects(queue, [im])
    got = np.frombuffer(P.interop_texture_read(tx), np.uint8)
    assert got[0] == 255 and got[1] == 1 and got[4] == 251, got[:8]   # 第一個像素 r：0 → 255；第二個 4 → 251（UNORM 換算誤差 ≤1）
    assert st.writes == 1
    reads = st.reads
    cl.enqueue_acquire_gl_objects(queue, [im])   # GL 端沒變（修訂號是我們自己寫回後的）→ 不會再讀
    cl.enqueue_release_gl_objects(queue, [im])   # CL 端沒寫 → 不會再寫
    assert st.reads == reads and st.writes == 1
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 4, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, (ctypes.c_ubyte * 32)(*([7] * 32)))   # GL 端重新指定內容
    cl.enqueue_acquire_gl_objects(queue, [im])
    assert (rd(im, (0, 0), (4, 2), np.uint8, (2, 4, 4)) == 7).all()
    cl.enqueue_release_gl_objects(queue, [im])
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 8, 8, 0, GL_RGBA, GL_UNSIGNED_BYTE, (ctypes.c_ubyte * 256)())   # 尺寸變了
    try:
        cl.enqueue_acquire_gl_objects(queue, [im])
    except cl.Error as e:
        assert e.code == cl.status_code.INVALID_GL_OBJECT
    else:
        raise AssertionError("尺寸改變要丟 INVALID_GL_OBJECT")
    for fn in (lambda: cl.GLTexture(ctx, mf.READ_WRITE, 0x8513, 0, tx, 2), lambda: cl.GLTexture(ctx, mf.READ_WRITE, 0x0DE1, 3, tx, 2), lambda: cl.GLTexture(ctx, mf.READ_WRITE, 0x0DE1, 0, 9999, 2)):
        try:
            fn()
        except cl.Error as e:
            assert e.code in (cl.status_code.INVALID_VALUE, cl.status_code.INVALID_GL_OBJECT)
        else:
            raise AssertionError("不支援的目標／層／物件要被拒絕")
    rbo = int(glGenRenderbuffers(1))
    glBindRenderbuffer(GL_RENDERBUFFER, rbo)
    glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, 2, 2)
    rim = cl.GLRenderBuffer(ctx, mf.WRITE_ONLY, rbo)
    assert rim.get_gl_object_info() == (cl.gl_object_type.RENDERBUFFER, rbo) and (rim.width, rim.height) == (2, 2)
    cl.enqueue_acquire_gl_objects(queue, [rim])
    run("""__kernel void fill(__write_only image2d_t im) { write_imagef(im, (int2)(get_global_id(0), get_global_id(1)), (float4)(0.0f, 1.0f, 0.0f, 1.0f)); }""", "fill", (2, 2), rim)
    cl.enqueue_release_gl_objects(queue, [rim])
    assert P.interop_renderbuffer_read(rbo) == bytes([0, 255, 0, 255] * 4)


def _fixture(name):
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", name), "rb") as f:
        return f.read()


@t("IL（SPIR-V）程式：clCreateProgramWithIL、build、向量相加與 __local＋barrier 歸約、二進位往返、錯誤")
def _():
    assert "SPIR-V" in ctx.devices[0].il_version
    p = cl._create_program_with_il(ctx, _fixture("spv_vadd.spv"))
    assert p.kind() == cl.program_kind.IL and p.get_info(cl.program_info.IL) == _fixture("spv_vadd.spv")
    p._build()
    assert p.get_info(cl.program_info.KERNEL_NAMES) == "vadd"
    k = cl.Kernel(p, "vadd")
    a, b = np.arange(100, dtype=np.float32), np.arange(100, dtype=np.float32) * 2
    A, B, C = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=a), cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=b), cl.Buffer(ctx, mf.WRITE_ONLY, a.nbytes)
    k(queue, (100,), None, A, B, C, np.uint32(100))
    out = np.empty_like(a)
    cl._enqueue_read_buffer(queue, C, out)
    assert (out == a + b).all()
    q = cl._create_program_with_il(ctx, _fixture("spv_reduce.spv"))
    q._build()
    kr = cl.Kernel(q, "red")
    x = np.arange(256, dtype=np.float32)
    X, O = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=x), cl.Buffer(ctx, mf.WRITE_ONLY, 16)
    kr(queue, (256,), (64,), X, O, cl.LocalMemory(64 * 4))
    res = np.empty(4, np.float32)
    cl._enqueue_read_buffer(queue, O, res)
    assert res.tolist() == [x[i * 64:(i + 1) * 64].sum() for i in range(4)]
    bins = p.get_info(cl.program_info.BINARIES)   # 「二進位」往返：還原成 IL 程式
    p2 = cl._Program(ctx, ctx.devices, bins)
    assert p2.kind() == cl.program_kind.BINARY   # 從載入器的 binary 容器重建（目標相容就不經 SPIR-V 解碼）
    p2._build()
    assert p2.get_info(cl.program_info.KERNEL_NAMES) == "vadd"
    bad = cl._create_program_with_il(ctx, b"\x03\x02\x23\x07" + b"\x00" * 16)   # 只有檔頭、沒有 Kernel 能力
    try:
        bad._build()
    except cl.Error as e:
        assert e.code == cl.status_code.BUILD_PROGRAM_FAILURE and "Kernel" in str(e) + bad._log, (str(e), bad._log)
    else:
        raise AssertionError("壞的 IL 要建置失敗")
    try:
        cl._create_program_with_il(ctx, b"xyz")
    except cl.Error as e:
        assert e.code == cl.status_code.INVALID_VALUE
    else:
        raise AssertionError("太短的 IL 要被拒絕")


@t("快取是無痕的：原本的 Program(ctx, source) 寫法，同一個行程裡第二個相同的程式不再編譯；binary 容器往返不經前端")
def _():
    src = "__kernel void sq(__global float* x) { int i = get_global_id(0); x[i] = x[i] * x[i]; }"
    p = cl._Program(ctx, src)
    p._build()
    assert p._from_cache in (None, "bin")   # 這個行程的第一次（也可能因為檔案快取而是 bin）
    bins = p.get_info(cl.program_info.BINARIES)
    assert bins[0].startswith(b"FAKIRBN1") and p.get_info(cl.program_info.BINARY_SIZES) == [len(bins[0])]
    q = cl._Program(ctx, ctx.devices, bins)   # pyopencl 的磁碟編譯快取讀回的寫法
    q._build()
    assert q._from_cache == "binary" and q.kind() == cl.program_kind.BINARY
    k = cl.Kernel(q, "sq")
    x = np.arange(8, dtype=np.float32)
    X = cl.Buffer(ctx, mf.READ_WRITE | mf.COPY_HOST_PTR, hostbuf=x)
    k(queue, (8,), None, X)
    out = np.empty_like(x)
    cl._enqueue_read_buffer(queue, X, out)
    assert (out == x * x).all()
    try:
        cl._Program(ctx, ctx.devices, [b"FAKIRBN1" + b"\x00" * 20])._build()
    except cl.Error as e:
        assert e.code in (cl.status_code.INVALID_BINARY, cl.status_code.INVALID_VALUE), e.code
    else:
        raise AssertionError("壞的 binary 要被拒絕")


print("%d passed, %d failed" % (passed, failed))
try:
    cl._get_transport().close()
except Exception:  # noqa: BLE001
    pass
sys.exit(1 if failed else 0)
