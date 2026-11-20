"""OpenCL 2.0 的 Pipe：一個核心寫入 pipe、另一個核心讀出（生產者／消費者）；含 reserve 版本與「滿／空回 -1」。
pipe 的內容只有核心能存取（規格規定），主機端只負責建立與傳給核心。"""
import numpy as np
import pyopencl as cl

ctx = cl.create_some_context()
queue = cl.CommandQueue(ctx)
print("裝置：", ctx.devices[0].name, "max_pipe_args =", ctx.devices[0].max_pipe_args)
mf = cl.mem_flags

pipe = cl.Pipe(ctx, 0, 4, 8)                               # 封包 4 位元組（float）、最多 8 個
print("packet_size =", pipe.get_pipe_info(cl.pipe_info.PACKET_SIZE), "max_packets =", pipe.get_pipe_info(cl.pipe_info.MAX_PACKETS))
status = cl.Buffer(ctx, mf.READ_WRITE, 16 * 4)
vals = cl.Buffer(ctx, mf.READ_WRITE, 16 * 4)

prg = cl.Program(ctx, """
__kernel void produce(__write_only pipe float p, __global int* st) {
    int i = get_global_id(0); float v = 1.5f * i;
    st[i] = write_pipe(p, &v);                              // 0＝成功、-1＝滿了
}
__kernel void consume(__read_only pipe float p, __global float* out, __global int* st) {
    int i = get_global_id(0); float v = -1.0f;
    st[i] = read_pipe(p, &v);                               // 0＝成功、-1＝空了
    out[i] = v;
}
""").build()

prg.produce(queue, (10,), None, pipe, status)               # 10 個工作項寫、容量 8
st = np.empty(10, np.int32)
cl.enqueue_copy(queue, st, status)
print("寫入結果：", st.tolist())
assert st.tolist() == [0] * 8 + [-1] * 2

prg.consume(queue, (10,), None, pipe, vals, status)         # 另一次啟動讀出：pipe 的內容跨啟動保留
out = np.empty(10, np.float32)
cl.enqueue_copy(queue, out, vals)
cl.enqueue_copy(queue, st, status)
print("讀出結果：", st.tolist(), out[:8].tolist())
assert st.tolist() == [0] * 8 + [-1] * 2 and out[:8].tolist() == [1.5 * i for i in range(8)]
print("OK")
