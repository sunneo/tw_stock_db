"""圖像格式的進階用法：打包格式 RGB565、IMAGE1D_BUFFER（與緩衝區共用記憶體）、查詢支援的格式。"""
import numpy as np
import pyopencl as cl

ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
mf = cl.mem_flags
print("裝置：", ctx.devices[0].name)

fmts = cl.get_supported_image_formats(ctx, mf.READ_WRITE, cl.mem_object_type.IMAGE2D)
print("支援的 2D 圖像格式：%d 種（含 RGB565／RGB555／RGB101010：%s）" % (len(fmts), any(f.channel_order == cl.channel_order.RGB for f in fmts)))

# 打包格式：565（高位是紅）。像素 0 是純綠、像素 1 是純紅
raw = np.array([0x07E0, 0xF800], np.uint16)
im565 = cl.create_image(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, cl.ImageFormat(cl.channel_order.RGB, cl.channel_type.UNORM_SHORT_565), shape=(2, 1), hostbuf=raw)
out = cl.Buffer(ctx, mf.WRITE_ONLY, 6 * 4)
prg = cl.Program(ctx, """
__kernel void unpack(__read_only image2d_t im, __global float* o) {
    float4 a = read_imagef(im, (int2)(0, 0)), b = read_imagef(im, (int2)(1, 0));
    o[0] = a.x; o[1] = a.y; o[2] = a.z; o[3] = b.x; o[4] = b.y; o[5] = b.z; }
__kernel void scale(__read_only image1d_buffer_t im, __global float* o) { int i = get_global_id(0); o[i] = read_imagef(im, i).x * 10.0f; }
""").build()
unpack, scale = prg.unpack, prg.scale                     # 重複使用 Kernel 物件
unpack(queue, (1,), None, im565, out)
res = np.empty(6, np.float32)
cl.enqueue_copy(queue, res, out)
print("565 解包（r,g,b 兩個像素）：", res.tolist())
assert res.tolist() == [0, 1, 0, 1, 0, 0]

# IMAGE1D_BUFFER：圖像建在緩衝區上，改緩衝區圖像就看得到
buf = cl.Buffer(ctx, mf.READ_WRITE | mf.COPY_HOST_PTR, hostbuf=np.arange(8, dtype=np.float32))
img_buf = cl.create_image(ctx, mf.READ_ONLY, cl.ImageFormat(cl.channel_order.R, cl.channel_type.FLOAT), shape=(8,), buffer=buf)
res2 = cl.Buffer(ctx, mf.WRITE_ONLY, 32)
scale(queue, (8,), None, img_buf, res2)
host = np.empty(8, np.float32)
cl.enqueue_copy(queue, host, res2)
print("1D buffer 圖像讀到：", host.tolist())
assert host.tolist() == [i * 10.0 for i in range(8)]
cl.enqueue_copy(queue, buf, np.full(8, 2, np.float32))        # 改緩衝區
scale(queue, (8,), None, img_buf, res2)
cl.enqueue_copy(queue, host, res2)
assert (host == 20).all()
print("OK")
