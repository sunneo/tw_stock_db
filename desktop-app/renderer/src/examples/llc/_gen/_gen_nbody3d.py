# -*- coding: utf-8 -*-
# 產生 ../game/../gpgpu/nbody3d.ll：3D N-body（CPU，double，O(N²)），OpenGL 點精靈；滑鼠拖曳旋轉、滾輪縮放、空白暫停、R 重置、Esc 離開。第一個參數＝跑幾幀後離開（測試用）。
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _irb import *

N = 300
m = Mod('; 3D N-body（CPU 版，double，O(N²) 引力，半隱式積分）＋ OpenGL 點精靈（SDL2）。同一份 .ll：原生編譯，或在 run terminal 用 lli 跑（wasm host import）。\n'
        '; 滑鼠左鍵拖曳旋轉、滾輪縮放、空白暫停、R 重置、Esc 離開。第一個參數＝跑幾幀後離開（測試用）。\n; （由 _gen/_gen_nbody3d.py 產生；GPGPU 版要等 OpenCL 墊片）\n'
        'target triple = "x86_64-pc-linux-gnu"')
D = m.decl
D('i32', 'SDL_Init', 'i32'); D('void', 'SDL_Quit'); D('ptr', 'SDL_CreateWindow', 'ptr', 'i32', 'i32', 'i32', 'i32', 'i32'); D('ptr', 'SDL_GL_CreateContext', 'ptr')
D('void', 'SDL_GL_SwapWindow', 'ptr'); D('i32', 'SDL_PollEvent', 'ptr'); D('void', 'SDL_Delay', 'i32'); D('void', 'SDL_GL_DeleteContext', 'ptr'); D('void', 'SDL_DestroyWindow', 'ptr')
D('void', 'glClearColor', 'float', 'float', 'float', 'float'); D('void', 'glClear', 'i32'); D('void', 'glMatrixMode', 'i32'); D('void', 'glLoadIdentity')
D('void', 'gluPerspective', 'double', 'double', 'double', 'double'); D('void', 'glTranslatef', 'float', 'float', 'float'); D('void', 'glRotatef', 'float', 'float', 'float', 'float')
D('void', 'glPointSize', 'float'); D('void', 'glBegin', 'i32'); D('void', 'glEnd'); D('void', 'glColor3f', 'float', 'float', 'float'); D('void', 'glVertex3f', 'float', 'float', 'float')
D('void', 'glEnable', 'i32'); D('double', 'sqrt', 'double'); D('double', 'sin', 'double'); D('double', 'cos', 'double'); D('i32', 'atoi', 'ptr'); D('i32', 'printf', 'ptr', varargs=True)

# 偽隨機（線性同餘），回傳 [0, 1)
rnd = m.fn('double', 'rnd', ('ptr', 'seed'))
p = rnd.args[0]
s = rnd.load('i32', p)
s2 = (s * 1103515245 + 12345) & 0x7fffffff
rnd.store('i32', s2, p)
rnd.ret(((s2 >> 8).to('double')) / 8388608.0)

# 初始化：中央一個大質量，其餘繞著它在 xz 平面附近轉
init = m.fn('void', 'init', ('ptr', 'px'), ('ptr', 'vx'), ('ptr', 'ms'), ('ptr', 'seed'))
px, vx, ms, seed = init.args
px.elem = vx.elem = ms.elem = 'double'
i = init.var('i32', 0)
with init.loop(i, 0, N):
    r = 2.0 + 9.0 * init.call('rnd', seed)
    th = 6.2831853 * init.call('rnd', seed)
    h = (init.call('rnd', seed) - 0.5) * 0.8
    v = init.call('sqrt', 40.0 / r) * (0.9 + 0.2 * init.call('rnd', seed))
    base = i.get() * 3
    px[base] = r * init.call('cos', th); px[base + 1] = h; px[base + 2] = r * init.call('sin', th)
    vx[base] = -v * init.call('sin', th); vx[base + 1] = 0.0; vx[base + 2] = v * init.call('cos', th)
    ms[i.get()] = m_ = init.const('double', 1.0)
with init.if_(N > 0 and init.const('i1', 1)):
    px[0] = 0.0; px[1] = 0.0; px[2] = 0.0; vx[0] = 0.0; vx[1] = 0.0; vx[2] = 0.0; ms[0] = 40.0
init.ret()

# 一步：O(N²) 加速度，再積分
step = m.fn('void', 'step', ('ptr', 'px'), ('ptr', 'vx'), ('ptr', 'ms'), ('double', 'dt'))
px, vx, ms, dt = step.args
px.elem = vx.elem = ms.elem = 'double'
i = step.var('i32', 0); j = step.var('i32', 0)
ax, ay, az = step.var('double', 0.0), step.var('double', 0.0), step.var('double', 0.0)
with step.loop(i, 0, N):
    ax.set(0.0); ay.set(0.0); az.set(0.0)
    bi = i.get() * 3
    with step.loop(j, 0, N):
        with step.if_(i.get().ne(j.get())):
            bj = j.get() * 3
            dx, dy, dz = px[bj] - px[bi], px[bj + 1] - px[bi + 1], px[bj + 2] - px[bi + 2]
            r2 = dx * dx + dy * dy + dz * dz + 0.05
            inv = ms[j.get()] / (r2 * step.call('sqrt', r2))
            ax += dx * inv; ay += dy * inv; az += dz * inv
    vx[bi] = vx[bi] + ax.get() * dt; vx[bi + 1] = vx[bi + 1] + ay.get() * dt; vx[bi + 2] = vx[bi + 2] + az.get() * dt
with step.loop(i, 0, N):
    bi = i.get() * 3
    px[bi] = px[bi] + vx[bi] * dt; px[bi + 1] = px[bi + 1] + vx[bi + 1] * dt; px[bi + 2] = px[bi + 2] + vx[bi + 2] * dt
step.ret()

# 畫一幀
draw = m.fn('void', 'draw', ('ptr', 'px'), ('ptr', 'vx'), ('double', 'yaw'), ('double', 'pitch'), ('double', 'dist'))
px, vx, yaw, pitch, dist = draw.args
px.elem = vx.elem = 'double'
c = draw.call
c('glClearColor', 0.02, 0.03, 0.05, 1.0); c('glClear', 0x4100)
c('glMatrixMode', 0x1701); c('glLoadIdentity'); c('gluPerspective', 50.0, 640.0 / 480.0, 0.1, 300.0)
c('glMatrixMode', 0x1700); c('glLoadIdentity'); c('glTranslatef', 0.0, 0.0, (-dist).to('float')); c('glRotatef', pitch.to('float'), 1.0, 0.0, 0.0); c('glRotatef', yaw.to('float'), 0.0, 1.0, 0.0)
c('glEnable', 0x0B71); c('glPointSize', 3.0); c('glBegin', 0)
i = draw.var('i32', 0)
with draw.loop(i, 0, N):
    b = i.get() * 3
    sp = c('sqrt', vx[b] * vx[b] + vx[b + 1] * vx[b + 1] + vx[b + 2] * vx[b + 2])
    t = (sp / 4.0)
    t = (t > 1.0).sel(draw.const('double', 1.0), t)
    c('glColor3f', (0.45 + 0.55 * t).to('float'), (0.65 + 0.25 * t).to('float'), (1.0 - 0.6 * t).to('float'))
    c('glVertex3f', px[b].to('float'), px[b + 1].to('float'), px[b + 2].to('float'))
c('glEnd')
draw.ret()

f = m.fn('i32', 'main', ('i32', 'argc'), ('ptr', 'argv'))
argc, argv = f.args
c = f.call
posb, velb, mass = f.array('double', N * 3), f.array('double', N * 3), f.array('double', N)
seed = f.alloca('i32'); f.store('i32', 12345, seed)
ev = f.array('i8', 56)
running, frames, maxf, drag, paused = (f.var('i32', 1), f.var('i32', 0), f.var('i32', 0), f.var('i32', 0), f.var('i32', 0))
yaw, pitch, dist = f.var('double', 20.0), f.var('double', 25.0), f.var('double', 26.0)
with f.if_(argc > 1):
    maxf.set(c('atoi', argv.at(1).__class__ and f.load('ptr', argv.at(1) if False else f.gep8(argv, 4))))
c('SDL_Init', 32)
win = c('SDL_CreateWindow', 'IR nbody3d (CPU)', 805240832, 805240832, 640, 480, 2)
ctx = c('SDL_GL_CreateContext', win)
with f.if_(ctx.eq(f.const('ptr', 0))):
    f.call('SDL_Quit'); f.ret(1)
c('init', posb, velb, mass, seed)


def rd(off):
    return f.load('i32', f.gep8(ev, off))


with f.while_(lambda: running.get().ne(0)):
    with f.while_(lambda: c('SDL_PollEvent', ev).ne(0)):
        ty = f.load('i32', ev)
        with f.if_(ty.eq(256)):
            running.set(0)
        with f.if_(ty.eq(768)):
            sc = rd(16)
            with f.if_(sc.eq(41)): running.set(0)
            with f.if_(sc.eq(44)): paused.set(f.const('i32', 1) - paused.get())
            with f.if_(sc.eq(21)): c('init', posb, velb, mass, seed)
        with f.if_(ty.eq(1025)): drag.set(1)
        with f.if_(ty.eq(1026)): drag.set(0)
        with f.if_(ty.eq(1024) & drag.get().ne(0)):
            yaw += rd(28).to('double') * 0.4
            pitch += rd(32).to('double') * 0.4
        with f.if_(ty.eq(1027)):
            dist += (-(rd(20).to('double'))) * 1.5
            with f.if_(dist.get() < 4.0): dist.set(4.0)
    with f.if_(paused.get().eq(0)):
        c('step', posb, velb, mass, 0.01); c('step', posb, velb, mass, 0.01)
    c('draw', posb, velb, yaw.get(), pitch.get(), dist.get())
    c('SDL_GL_SwapWindow', win); c('SDL_Delay', 16)
    frames += 1
    with f.if_((maxf.get() > 0) & (frames.get() >= maxf.get())):
        running.set(0)
# 結束時印出總動能，確認模擬有在跑
ke = f.var('double', 0.0); i = f.var('i32', 0)
with f.loop(i, 0, N * 3):
    ke += 0.5 * velb[i.get()] * velb[i.get()]
c('printf', 'frames=%d kinetic=%.2f\n', frames.get(), ke.get())
c('SDL_GL_DeleteContext', ctx); c('SDL_DestroyWindow', win); c('SDL_Quit')
f.ret(0)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gpgpu', 'nbody3d.ll')
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'w', encoding='utf-8').write(m.text() + "\n")
print('wrote', out)
