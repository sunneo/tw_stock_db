# -*- coding: utf-8 -*-
# 產生 ../gpgpu/fluid3d.ll：3D SPH 流體（CPU，double，O(N²)，Müller 2003 的 poly6／spiky／黏滯核），OpenGL 點精靈＋外框。
# 滑鼠左鍵拖曳旋轉、滾輪縮放、空白＝晃一下水、R 重置、Esc 離開。第一個參數＝跑幾幀後離開（測試用）。常數先用 numpy 原型驗證過（水落下、沉澱成一層、沒有爆掉）。
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _irb import *

N, H, MASS, K, MU, G, DT = 500, 0.12, 0.02, 40.0, 0.6, -9.8, 0.004
POLY6 = 315.0 / (64.0 * math.pi * H ** 9); SPIKY = -45.0 / (math.pi * H ** 6); VISC = 45.0 / (math.pi * H ** 6)
m = Mod('; 3D SPH 流體（CPU，double，O(N²)）＋ OpenGL 點精靈（SDL2）。滑鼠左鍵拖曳旋轉、滾輪縮放、空白＝晃一下水、R 重置、Esc 離開。\n'
        '; 第一個參數＝跑幾幀後離開（測試用）。（由 _gen/_gen_fluid3d.py 產生；GPGPU 版要等 OpenCL 墊片）\ntarget triple = "x86_64-pc-linux-gnu"')
D = m.decl
D('i32', 'SDL_Init', 'i32'); D('void', 'SDL_Quit'); D('ptr', 'SDL_CreateWindow', 'ptr', 'i32', 'i32', 'i32', 'i32', 'i32'); D('ptr', 'SDL_GL_CreateContext', 'ptr')
D('void', 'SDL_GL_SwapWindow', 'ptr'); D('i32', 'SDL_PollEvent', 'ptr'); D('void', 'SDL_Delay', 'i32'); D('void', 'SDL_GL_DeleteContext', 'ptr'); D('void', 'SDL_DestroyWindow', 'ptr')
D('void', 'glClearColor', 'float', 'float', 'float', 'float'); D('void', 'glClear', 'i32'); D('void', 'glMatrixMode', 'i32'); D('void', 'glLoadIdentity')
D('void', 'gluPerspective', 'double', 'double', 'double', 'double'); D('void', 'glTranslatef', 'float', 'float', 'float'); D('void', 'glRotatef', 'float', 'float', 'float', 'float')
D('void', 'glPointSize', 'float'); D('void', 'glBegin', 'i32'); D('void', 'glEnd'); D('void', 'glColor3f', 'float', 'float', 'float'); D('void', 'glVertex3f', 'float', 'float', 'float')
D('void', 'glEnable', 'i32'); D('double', 'sqrt', 'double'); D('i32', 'atoi', 'ptr'); D('i32', 'printf', 'ptr', varargs=True)

# 初始：左下角一塊格子排列的水
init = m.fn('void', 'init', ('ptr', 'pos'), ('ptr', 'vel'))
pos, vel = init.args
pos.elem = vel.elem = 'double'
side = int(round(N ** (1 / 3.0))) + 1
n = init.var('i32', 0); i = init.var('i32', 0); j = init.var('i32', 0); k = init.var('i32', 0)
with init.loop(i, 0, side):
    with init.loop(j, 0, side * 2):
        with init.loop(k, 0, side):
            with init.if_(n.get() < N):
                b = n.get() * 3
                pos[b] = (i.get().to('double') + 0.5) * 0.07 + 0.05
                pos[b + 1] = (j.get().to('double') + 0.5) * 0.07 + 0.05
                pos[b + 2] = (k.get().to('double') + 0.5) * 0.07 + 0.05
                vel[b] = 0.0; vel[b + 1] = 0.0; vel[b + 2] = 0.0
                n += 1
init.ret()

# 一步 SPH
step = m.fn('void', 'step', ('ptr', 'pos'), ('ptr', 'vel'), ('ptr', 'rho'), ('ptr', 'prs'), ('double', 'rest'))
pos, vel, rho, prs, rest = step.args
pos.elem = vel.elem = rho.elem = prs.elem = 'double'
c = step.call
i, j, a = step.var('i32', 0), step.var('i32', 0), step.var('i32', 0)
acc = step.var('double', 0.0)
with step.loop(i, 0, N):
    acc.set(0.0)
    bi = i.get() * 3
    with step.loop(j, 0, N):
        bj = j.get() * 3
        dx, dy, dz = pos[bi] - pos[bj], pos[bi + 1] - pos[bj + 1], pos[bi + 2] - pos[bj + 2]
        mm = H * H - (dx * dx + dy * dy + dz * dz)
        with step.if_(mm > 0.0):
            acc += mm * mm * mm
    rho[i.get()] = acc.get() * (MASS * POLY6)
    prs[i.get()] = (rho[i.get()] - rest) * K
fx, fy, fz = step.var('double', 0.0), step.var('double', 0.0), step.var('double', 0.0)
with step.loop(i, 0, N):
    fx.set(0.0); fy.set(0.0); fz.set(0.0)
    bi = i.get() * 3
    with step.loop(j, 0, N):
        with step.if_(i.get().ne(j.get())):
            bj = j.get() * 3
            dx, dy, dz = pos[bi] - pos[bj], pos[bi + 1] - pos[bj + 1], pos[bi + 2] - pos[bj + 2]
            r2 = dx * dx + dy * dy + dz * dz
            with step.if_(r2 < H * H):
                r = c('sqrt', r2) + 1e-9
                w = H - r
                cp = ((prs[i.get()] + prs[j.get()]) / (rho[j.get()] * 2.0)) * (w * w / r) * (-MASS * SPIKY)
                fx += dx * cp; fy += dy * cp; fz += dz * cp
                cv = (w / rho[j.get()]) * (MU * MASS * VISC)
                fx += (vel[bj] - vel[bi]) * cv; fy += (vel[bj + 1] - vel[bi + 1]) * cv; fz += (vel[bj + 2] - vel[bi + 2]) * cv
    inv = 1.0 / rho[i.get()]
    vel[bi] = vel[bi] + fx.get() * inv * DT
    vel[bi + 1] = vel[bi + 1] + (fy.get() * inv + G) * DT
    vel[bi + 2] = vel[bi + 2] + fz.get() * inv * DT
with step.loop(i, 0, N):
    with step.loop(a, 0, 3):
        idx = i.get() * 3 + a.get()
        pos[idx] = pos[idx] + vel[idx] * DT
        with step.if_(pos[idx] < 0.0):
            pos[idx] = 0.0; vel[idx] = vel[idx] * -0.3
        with step.if_(pos[idx] > 1.0):
            pos[idx] = 1.0; vel[idx] = vel[idx] * -0.3
step.ret()

# 開機時的靜止密度（平均）× 0.9 當作目標密度
restf = m.fn('double', 'rest_density', ('ptr', 'pos'), ('ptr', 'rho'))
pos, rho = restf.args
pos.elem = rho.elem = 'double'
i, j = restf.var('i32', 0), restf.var('i32', 0)
acc, tot = restf.var('double', 0.0), restf.var('double', 0.0)
with restf.loop(i, 0, N):
    acc.set(0.0); bi = i.get() * 3
    with restf.loop(j, 0, N):
        bj = j.get() * 3
        dx, dy, dz = pos[bi] - pos[bj], pos[bi + 1] - pos[bj + 1], pos[bi + 2] - pos[bj + 2]
        mm = H * H - (dx * dx + dy * dy + dz * dz)
        with restf.if_(mm > 0.0):
            acc += mm * mm * mm
    tot += acc.get() * (MASS * POLY6)
restf.ret(tot.get() / float(N) * 0.9)

draw = m.fn('void', 'draw', ('ptr', 'pos'), ('ptr', 'rho'), ('double', 'yaw'), ('double', 'pitch'), ('double', 'dist'), ('double', 'rest'))
pos, rho, yaw, pitch, dist, rest = draw.args
pos.elem = rho.elem = 'double'
c = draw.call
c('glClearColor', 0.03, 0.04, 0.07, 1.0); c('glClear', 0x4100)
c('glMatrixMode', 0x1701); c('glLoadIdentity'); c('gluPerspective', 45.0, 640.0 / 480.0, 0.05, 50.0)
c('glMatrixMode', 0x1700); c('glLoadIdentity'); c('glTranslatef', 0.0, 0.0, (-dist).to('float')); c('glRotatef', pitch.to('float'), 1.0, 0.0, 0.0); c('glRotatef', yaw.to('float'), 0.0, 1.0, 0.0)
c('glTranslatef', -0.5, -0.5, -0.5); c('glEnable', 0x0B71)
# 外框（12 條邊）
c('glBegin', 1); c('glColor3f', 0.35, 0.4, 0.55)
edges = []
for x in (0.0, 1.0):
    for y in (0.0, 1.0):
        edges += [((x, y, 0.0), (x, y, 1.0)), ((x, 0.0, y), (x, 1.0, y)), ((0.0, x, y), (1.0, x, y))]
for a_, b_ in edges:
    c('glVertex3f', *a_); c('glVertex3f', *b_)
c('glEnd')
c('glPointSize', 7.0); c('glBegin', 0)
i = draw.var('i32', 0)
with draw.loop(i, 0, N):
    b = i.get() * 3
    t = (rho[i.get()] / (rest * 1.3))
    t = (t > 1.0).sel(draw.const('double', 1.0), t)
    c('glColor3f', (0.25 + 0.5 * t).to('float'), (0.55 + 0.35 * t).to('float'), 1.0)
    c('glVertex3f', pos[b].to('float'), pos[b + 1].to('float'), pos[b + 2].to('float'))
c('glEnd')
draw.ret()

f = m.fn('i32', 'main', ('i32', 'argc'), ('ptr', 'argv'))
argc, argv = f.args
c = f.call
posb, velb, rho, prs = f.array('double', N * 3), f.array('double', N * 3), f.array('double', N), f.array('double', N)
ev = f.array('i8', 56)
running, frames, maxf, drag, slosh = f.var('i32', 1), f.var('i32', 0), f.var('i32', 0), f.var('i32', 0), f.var('i32', 0)
yaw, pitch, dist, rest = f.var('double', 25.0), f.var('double', 20.0), f.var('double', 2.6), f.var('double', 0.0)
with f.if_(argc > 1):
    argv.elem = 'ptr'
    maxf.set(c('atoi', f.load('ptr', argv.at(1))))
c('SDL_Init', 32)
win = c('SDL_CreateWindow', 'IR fluid3d (SPH, CPU)', 805240832, 805240832, 640, 480, 2)
ctx = c('SDL_GL_CreateContext', win)
with f.if_(ctx.eq(f.const('ptr', 0))):
    f.call('SDL_Quit'); f.ret(1)
c('init', posb, velb); rest.set(c('rest_density', posb, rho))


def rd(off):
    return f.load('i32', f.gep8(ev, off))


i = f.var('i32', 0)
with f.while_(lambda: running.get().ne(0)):
    with f.while_(lambda: c('SDL_PollEvent', ev).ne(0)):
        ty = f.load('i32', ev)
        with f.if_(ty.eq(256)): running.set(0)
        with f.if_(ty.eq(768)):
            sc = rd(16)
            with f.if_(sc.eq(41)): running.set(0)
            with f.if_(sc.eq(44)): slosh.set(1)
            with f.if_(sc.eq(21)): c('init', posb, velb)
        with f.if_(ty.eq(1025)): drag.set(1)
        with f.if_(ty.eq(1026)): drag.set(0)
        with f.if_(ty.eq(1024) & drag.get().ne(0)):
            yaw += rd(28).to('double') * 0.4
            pitch += rd(32).to('double') * 0.4
        with f.if_(ty.eq(1027)):
            dist += (-(rd(20).to('double'))) * 0.15
            with f.if_(dist.get() < 1.2): dist.set(1.2)
    with f.if_(slosh.get().ne(0)):   # 晃一下：全部粒子給一個朝 +x 的速度
        with f.loop(i, 0, N):
            velb[i.get() * 3] = velb[i.get() * 3] + 2.5
        slosh.set(0)
    c('step', posb, velb, rho, prs, rest.get()); c('step', posb, velb, rho, prs, rest.get())
    c('draw', posb, rho, yaw.get(), pitch.get(), dist.get(), rest.get())
    c('SDL_GL_SwapWindow', win); c('SDL_Delay', 16)
    frames += 1
    with f.if_((maxf.get() > 0) & (frames.get() >= maxf.get())): running.set(0)
ymean = f.var('double', 0.0)
with f.loop(i, 0, N):
    ymean += posb[i.get() * 3 + 1]
c('printf', 'frames=%d y_mean=%.3f\n', frames.get(), (ymean.get() / float(N)))
c('SDL_GL_DeleteContext', ctx); c('SDL_DestroyWindow', win); c('SDL_Quit')
f.ret(0)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gpgpu', 'fluid3d.ll')
open(out, 'w', encoding='utf-8').write(m.text() + "\n")
print('wrote', out)
