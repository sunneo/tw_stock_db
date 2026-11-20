"""OpenCL 與 OpenGL 互通（標準 pyopencl＋PyOpenGL＋pygame）：OpenCL 核心每幀更新頂點緩衝區（VBO），OpenGL 直接畫。
流程與 pyopencl 官方的 gl_interop_demo 相同：GLBuffer、enqueue_acquire_gl_objects／enqueue_release_gl_objects。
在這裡 GL 緩衝區在 WebGL2、OpenCL 緩衝區在 OpenCL 裝置，acquire／release 是兩邊的同步點（內容沒變的方向不傳輸）。"""
import numpy as np
import pygame
from pygame.locals import DOUBLEBUF, OPENGL, QUIT
from OpenGL.GL import *
import pyopencl as cl
from pyopencl.tools import get_gl_sharing_context_properties

W, H, N, FRAMES = 640, 480, 2000, 120
pygame.init()
pygame.display.set_mode((W, H), DOUBLEBUF | OPENGL)       # 先有 GL 上下文，OpenCL 才能與它共享
glClearColor(0.05, 0.05, 0.1, 1.0)
glPointSize(3.0)

# 頂點緩衝區：N 個點，每點 (x, y) 兩個 float
rs = np.random.RandomState(0)
pts = (rs.rand(N, 2).astype(np.float32) * 2 - 1) * 0.9
vbo = glGenBuffers(1)
glBindBuffer(GL_ARRAY_BUFFER, vbo)
glBufferData(GL_ARRAY_BUFFER, pts.nbytes, pts, GL_DYNAMIC_DRAW)

# OpenCL 內容要帶上 GL 共享屬性（在網頁上由我們的 GL 上下文回應，不需要 GLX／WGL）
platform = cl.get_platforms()[0]
dev = platform.get_devices()[0]
ctx = cl.Context(properties=[(cl.context_properties.PLATFORM, platform)] + get_gl_sharing_context_properties(), devices=[dev])
queue = cl.CommandQueue(ctx)
print("OpenCL 裝置：", dev.name)
cl_vbo = cl.GLBuffer(ctx, cl.mem_flags.READ_WRITE, int(vbo))
prg = cl.Program(ctx, """
__kernel void swirl(__global float2 *p, float t)
{
    int i = get_global_id(0);
    float2 v = p[i];
    float r = length(v), a = atan2(v.y, v.x) + 0.02f * (1.0f + 0.5f * sin(t + r * 6.0f));
    p[i] = (float2)(r * cos(a), r * sin(a));               // 繞圈
}
""").build()

clock = pygame.time.Clock()
for frame in range(FRAMES):
    for ev in pygame.event.get():
        if ev.type == QUIT:
            raise SystemExit
    cl.enqueue_acquire_gl_objects(queue, [cl_vbo])          # 把緩衝區交給 OpenCL
    prg.swirl(queue, (N,), None, cl_vbo, np.float32(frame * 0.05))
    cl.enqueue_release_gl_objects(queue, [cl_vbo])          # 還給 OpenGL
    queue.finish()

    glClear(GL_COLOR_BUFFER_BIT)
    glEnableClientState(GL_VERTEX_ARRAY)
    glBindBuffer(GL_ARRAY_BUFFER, vbo)
    glVertexPointer(2, GL_FLOAT, 0, None)
    glColor3f(0.4, 0.8, 1.0)
    glDrawArrays(GL_POINTS, 0, N)
    glDisableClientState(GL_VERTEX_ARRAY)
    pygame.display.flip()
    clock.tick(60)
print("完成 %d 幀" % FRAMES)
