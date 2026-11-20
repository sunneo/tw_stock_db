"""OpenCL 與 OpenGL 的紋理互通（GLTexture／GLRenderBuffer）：OpenCL 核心每幀把紋理畫成漸層動畫，OpenGL 用它貼一個方塊。
標準 pyopencl＋PyOpenGL＋pygame；acquire／release 是兩邊的同步點（沒變的方向不傳輸）。支援 GL_TEXTURE_2D 與 RGBA8／RGBA16F／RGBA32F／R8／R32F／RG8／RG32F。"""
import numpy as np
import pygame
from pygame.locals import DOUBLEBUF, OPENGL, QUIT
from OpenGL.GL import *
import pyopencl as cl
from pyopencl.tools import get_gl_sharing_context_properties

W, H, TW, TH, FRAMES = 640, 480, 128, 128, 90
pygame.init()
pygame.display.set_mode((W, H), DOUBLEBUF | OPENGL)

tex = glGenTextures(1)
glBindTexture(GL_TEXTURE_2D, tex)
glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, TW, TH, 0, GL_RGBA, GL_UNSIGNED_BYTE, np.zeros((TH, TW, 4), np.uint8))
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST)
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST)

platform = cl.get_platforms()[0]
dev = platform.get_devices()[0]
ctx = cl.Context(properties=[(cl.context_properties.PLATFORM, platform)] + get_gl_sharing_context_properties(), devices=[dev])
queue = cl.CommandQueue(ctx)
cl_tex = cl.GLTexture(ctx, cl.mem_flags.WRITE_ONLY, GL_TEXTURE_2D, 0, int(tex), 2)
print("OpenCL 裝置：", dev.name, "｜", cl_tex)

prg = cl.Program(ctx, """
__kernel void paint(__write_only image2d_t im, float t)
{
    int x = get_global_id(0), y = get_global_id(1);
    float u = x / 127.0f, v = y / 127.0f;
    write_imagef(im, (int2)(x, y), (float4)(0.5f + 0.5f * sin(6.28f * (u + t)), 0.5f + 0.5f * sin(6.28f * (v - t)), u * v, 1.0f));
}
""").build()

clock = pygame.time.Clock()
for frame in range(FRAMES):
    for ev in pygame.event.get():
        if ev.type == QUIT:
            raise SystemExit
    cl.enqueue_acquire_gl_objects(queue, [cl_tex])
    prg.paint(queue, (TW, TH), None, cl_tex, np.float32(frame * 0.02))
    cl.enqueue_release_gl_objects(queue, [cl_tex])
    queue.finish()

    glClearColor(0.1, 0.1, 0.1, 1.0)
    glClear(GL_COLOR_BUFFER_BIT)
    glEnable(GL_TEXTURE_2D)
    glBindTexture(GL_TEXTURE_2D, tex)
    glBegin(GL_QUADS)
    for (u, v, x, y) in ((0, 0, -0.6, -0.8), (1, 0, 0.6, -0.8), (1, 1, 0.6, 0.8), (0, 1, -0.6, 0.8)):
        glTexCoord2f(u, v)
        glVertex2f(x, y)
    glEnd()
    pygame.display.flip()
    clock.tick(60)
print("完成 %d 幀" % FRAMES)
