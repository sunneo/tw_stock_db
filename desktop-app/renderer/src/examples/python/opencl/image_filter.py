"""圖像與取樣器：用 OpenCL 對 RGBA8 圖像做 3×3 模糊（取樣器的線性過濾＋邊界延伸），再用 write_imagef 輸出。
標準 pyopencl 寫法（create_image／Sampler／enqueue_copy 的 origin＋region），結果與 numpy 的對照。"""
import numpy as np
import pyopencl as cl

W, H = 64, 48
ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
print("裝置：", ctx.devices[0].name, "image_support =", ctx.devices[0].image_support)
mf = cl.mem_flags

rs = np.random.RandomState(1)
src = rs.randint(0, 256, (H, W, 4)).astype(np.uint8)
fmt = cl.ImageFormat(cl.channel_order.RGBA, cl.channel_type.UNORM_INT8)
img_in = cl.create_image(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, fmt, shape=(W, H), hostbuf=src)
img_out = cl.create_image(ctx, mf.WRITE_ONLY, fmt, shape=(W, H))

prg = cl.Program(ctx, """
__constant sampler_t smp = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE | CLK_FILTER_NEAREST;
__kernel void blur(__read_only image2d_t src, __write_only image2d_t dst)
{
    int x = get_global_id(0), y = get_global_id(1);
    float4 s = (float4)(0.0f);
    for (int dy = -1; dy <= 1; dy++)
        for (int dx = -1; dx <= 1; dx++)
            s += read_imagef(src, smp, (int2)(x + dx, y + dy));
    write_imagef(dst, (int2)(x, y), s / 9.0f);
}
""").build()
prg.blur(queue, (W, H), None, img_in, img_out)

out = np.empty_like(src)
cl.enqueue_copy(queue, out, img_out, origin=(0, 0), region=(W, H))

# numpy 對照（邊界延伸＝複製邊緣像素；UNORM8 換算與四捨五入）
pad = np.pad(src.astype(np.float32) / 255.0, ((1, 1), (1, 1), (0, 0)), mode="edge")
ref = sum(pad[1 + dy:1 + dy + H, 1 + dx:1 + dx + W] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9.0
ref = np.round(np.clip(ref, 0, 1) * 255).astype(np.uint8)
print("最大差異（灰階 0–255）：", int(np.abs(out.astype(int) - ref.astype(int)).max()))
assert np.abs(out.astype(int) - ref.astype(int)).max() <= 1
print("OK")
