# -*- coding: utf-8 -*-
# 產生 ../gpgpu/fluid3d.ll：3D SPH 流體（CPU，double，O(N²)，Müller 2003 的 poly6／spiky／黏滯核），OpenGL 點精靈＋外框。
# 滑鼠左鍵拖曳旋轉、滾輪縮放、空白＝晃一下水、R 重置、Esc 離開。第一個參數＝跑幾幀後離開（測試用）。常數先用 numpy 原型驗證過（水落下、沉澱成一層、沒有爆掉）。
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _irb import *
import _font_data as FD

# 常數照 examples/python/gpgpu/fluid3d.py（side=10 → 1000 顆）
SIDE = 10; N = SIDE ** 3; H = 0.1; SPACING = H / 2.0; RHO0 = 1000.0; MASS = RHO0 * SPACING ** 3
K, MU, G, DT = 200.0, 3.0, -9.8, 0.003; WLO, WHI, WDAMP = 0.02, 0.98, 0.3
FONT_W, FONT_H = FD.W, FD.H
POLY6 = 315.0 / (64.0 * math.pi * H ** 9); SPIKY = -45.0 / (math.pi * H ** 6); VISC = 45.0 / (math.pi * H ** 6)
m = Mod('; 3D SPH 流體（CPU，double，O(N²)）＋ OpenGL 點精靈（SDL2）。滑鼠左鍵拖曳旋轉、滾輪縮放、空白＝晃一下水、R 重置、Esc 離開。\n'
        '; 第一個參數＝跑幾幀後離開（測試用）。（由 _gen/_gen_fluid3d.py 產生；GPGPU 版要等 OpenCL 墊片）\ntarget triple = "x86_64-pc-linux-gnu"')
D = m.decl
D('i32', 'SDL_Init', 'i32'); D('void', 'SDL_Quit'); D('ptr', 'SDL_CreateWindow', 'ptr', 'i32', 'i32', 'i32', 'i32', 'i32'); D('ptr', 'SDL_GL_CreateContext', 'ptr')
D('void', 'SDL_GL_SwapWindow', 'ptr'); D('i32', 'SDL_PollEvent', 'ptr'); D('void', 'SDL_Delay', 'i32'); D('void', 'SDL_GL_DeleteContext', 'ptr'); D('void', 'SDL_DestroyWindow', 'ptr')
D('void', 'glClearColor', 'float', 'float', 'float', 'float'); D('void', 'glClear', 'i32'); D('void', 'glMatrixMode', 'i32'); D('void', 'glLoadIdentity')
D('void', 'gluPerspective', 'double', 'double', 'double', 'double'); D('void', 'glTranslatef', 'float', 'float', 'float'); D('void', 'glRotatef', 'float', 'float', 'float', 'float')
D('void', 'glPointSize', 'float'); D('void', 'glBegin', 'i32'); D('void', 'glEnd'); D('void', 'glColor3f', 'float', 'float', 'float'); D('void', 'glVertex3f', 'float', 'float', 'float')
D('void', 'glEnable', 'i32'); D('void', 'glDisable', 'i32'); D('void', 'glOrtho', 'double', 'double', 'double', 'double', 'double', 'double'); D('void', 'glVertex2f', 'float', 'float'); D('i32', 'snprintf', 'ptr', 'i64', 'ptr', varargs=True); D('double', 'sqrt', 'double'); D('i32', 'atoi', 'ptr'); D('i32', 'printf', 'ptr', varargs=True)

# 初始：SIDE³ 格子，間距 H/2，起點 0.05，y 再 +0.3（同 Python 的 make_fluid）
init = m.fn('void', 'init', ('ptr', 'pos'), ('ptr', 'vel'))
pos, vel = init.args
pos.elem = vel.elem = 'double'
n = init.var('i32', 0); i = init.var('i32', 0); j = init.var('i32', 0); k = init.var('i32', 0)
with init.loop(i, 0, SIDE):
    with init.loop(j, 0, SIDE):
        with init.loop(k, 0, SIDE):
            b = n.get() * 3
            pos[b] = i.get().to('double') * SPACING + 0.05
            pos[b + 1] = j.get().to('double') * SPACING + 0.05 + 0.3
            pos[b + 2] = k.get().to('double') * SPACING + 0.05
            vel[b] = 0.0; vel[b + 1] = 0.0; vel[b + 2] = 0.0
            n += 1
init.ret()

# 一步 SPH：密度（poly6）→ 壓力 p＝K·max(ρ-ρ0,0) → 壓力（spiky）＋黏滯力 → 半隱式 Euler → 反射牆（同 Python 的 forces_cpu／Sim.step）
step = m.fn('void', 'step', ('ptr', 'pos'), ('ptr', 'vel'), ('ptr', 'rho'), ('ptr', 'prs'), ('ptr', 'acc'))
pos, vel, rho, prs, acc_ = step.args
pos.elem = vel.elem = rho.elem = prs.elem = acc_.elem = 'double'
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
    pp = (rho[i.get()] - RHO0) * K
    prs[i.get()] = (pp > 0.0).sel(pp, step.const('double', 0.0))
fx, fy, fz = step.var('double', 0.0), step.var('double', 0.0), step.var('double', 0.0)
with step.loop(i, 0, N):
    fx.set(0.0); fy.set(0.0); fz.set(0.0)
    bi = i.get() * 3
    with step.loop(j, 0, N):
        bj = j.get() * 3
        dx, dy, dz = pos[bi] - pos[bj], pos[bi + 1] - pos[bj + 1], pos[bi + 2] - pos[bj + 2]
        r2 = dx * dx + dy * dy + dz * dz
        with step.if_((r2 < H * H) & (r2 > 1e-12)):
            r = c('sqrt', r2)
            w = H - r
            cp = ((prs[i.get()] + prs[j.get()]) / (rho[j.get()] * 2.0)) * (w * w / r) * (-MASS * SPIKY)
            fx += dx * cp; fy += dy * cp; fz += dz * cp
            cv = (w / rho[j.get()]) * (MU * MASS * VISC)
            fx += (vel[bj] - vel[bi]) * cv; fy += (vel[bj + 1] - vel[bi + 1]) * cv; fz += (vel[bj + 2] - vel[bi + 2]) * cv
    inv = 1.0 / rho[i.get()]
    acc_[bi] = fx.get() * inv; acc_[bi + 1] = fy.get() * inv + G; acc_[bi + 2] = fz.get() * inv
with step.loop(i, 0, N):
    with step.loop(a, 0, 3):
        idx = i.get() * 3 + a.get()
        vel[idx] = vel[idx] + acc_[idx] * DT
        pos[idx] = pos[idx] + vel[idx] * DT
        with step.if_(pos[idx] < WLO):
            pos[idx] = WLO; vel[idx] = vel[idx] * -WDAMP
        with step.if_(pos[idx] > WHI):
            pos[idx] = WHI; vel[idx] = vel[idx] * -WDAMP
step.ret()

# 文字（點陣字型，同 nbody3d）
font = m.const_array('font', 'i32', FD.ROWS)
tx = m.fn('void', 'text', ('ptr', 's'), ('i32', 'x0'), ('i32', 'y0'))
s_, x0, y0 = tx.args
s_.elem = 'i8'
fnt = V(tx, '@font', 'ptr', 'i32')
k, r, col = tx.var('i32', 0), tx.var('i32', 0), tx.var('i32', 0)
with tx.while_(lambda: (s_[k.get()].to('i32') & 255).ne(0)):
    ch = s_[k.get()].to('i32') & 255
    with tx.if_((ch >= 32) & (ch < 127)):
        base = (ch - 32) * FONT_H
        with tx.loop(r, 0, FONT_H):
            bits = fnt[base + r.get()]
            with tx.if_(bits.ne(0)):
                with tx.loop(col, 0, FONT_W):
                    mask = tx.const('i32', 1) << (FONT_W - 1 - col.get())
                    with tx.if_((bits & mask).ne(0)):
                        tx.call('glVertex2f', (x0 + k.get() * FONT_W + col.get()).to('float') + 0.5, (y0 + r.get() - 2).to('float') + 0.5)
    k += 1
tx.ret()

draw = m.fn('void', 'draw', ('ptr', 'pos'), ('ptr', 'vel'), ('double', 'yaw'), ('double', 'pitch'), ('double', 'dist'), ('i32', 'step_no'))
pos, vel, yaw, pitch, dist, step_no = draw.args
pos.elem = vel.elem = 'double'
c = draw.call
c('glClearColor', 0.0, 0.0, 0.0, 1.0); c('glClear', 0x4100)
c('glMatrixMode', 0x1701); c('glLoadIdentity'); c('gluPerspective', 45.0, 640.0 / 480.0, 0.05, 50.0)
c('glMatrixMode', 0x1700); c('glLoadIdentity'); c('glTranslatef', 0.0, 0.0, (-dist).to('float')); c('glRotatef', pitch.to('float'), 1.0, 0.0, 0.0); c('glRotatef', yaw.to('float'), 0.0, 1.0, 0.0)
c('glTranslatef', -0.5, -0.5, -0.5); c('glEnable', 0x0B71)
# 外框（12 條邊）
c('glBegin', 1); c('glColor3f', 0.5, 0.55, 0.65)
edges = []
for x in (0.0, 1.0):
    for y in (0.0, 1.0):
        edges += [((x, y, 0.0), (x, y, 1.0)), ((x, 0.0, y), (x, 1.0, y)), ((0.0, x, y), (1.0, x, y))]
for a_, b_ in edges:
    c('glVertex3f', *a_); c('glVertex3f', *b_)
c('glEnd')
c('glPointSize', 10.0); c('glBegin', 0)
i = draw.var('i32', 0)
with draw.loop(i, 0, N):
    b = i.get() * 3
    t = c('sqrt', vel[b] * vel[b] + vel[b + 1] * vel[b + 1] + vel[b + 2] * vel[b + 2]) / 3.0
    t = (t > 1.0).sel(draw.const('double', 1.0), t)
    c('glColor3f', (0.1 + 0.8 * t).to('float'), (0.35 + 0.6 * t).to('float'), (0.9 + 0.1 * t).to('float'))
    c('glVertex3f', pos[b].to('float'), pos[b + 1].to('float'), pos[b + 2].to('float'))
c('glEnd')
# 資訊列（Python 版的 info 標籤）
buf = draw.array('i8', 160)
c('glMatrixMode', 0x1701); c('glLoadIdentity'); c('glOrtho', 0.0, 640.0, 480.0, 0.0, -1.0, 1.0); c('glMatrixMode', 0x1700); c('glLoadIdentity')
c('glDisable', 0x0B71); c('glPointSize', 1.0); c('glBegin', 0); c('glColor3f', 0.75, 0.8, 0.9)
c('snprintf', buf, 160, '%d particles | source: CPU (wasm) | step %d', N, step_no)
c('text', buf, 5, 5)
c('text', '[drag]rotate [wheel]zoom [space]splash [P]pause [R]reset', 5, 25)
c('glEnd')
draw.ret()

f = m.fn('i32', 'main', ('i32', 'argc'), ('ptr', 'argv'))
argc, argv = f.args
c = f.call
posb, velb, rho, prs, accb = f.array('double', N * 3), f.array('double', N * 3), f.array('double', N), f.array('double', N), f.array('double', N * 3)
ev = f.array('i8', 56)
running, frames, maxf, drag, slosh = f.var('i32', 1), f.var('i32', 0), f.var('i32', 0), f.var('i32', 0), f.var('i32', 0)
yaw, pitch, dist = f.var('double', 34.4), f.var('double', 20.1), f.var('double', 2.2)
paused, steps = f.var('i32', 0), f.var('i32', 0)
with f.if_(argc > 1):
    argv.elem = 'ptr'
    maxf.set(c('atoi', f.load('ptr', argv.at(1))))
c('SDL_Init', 32)
win = c('SDL_CreateWindow', 'IR fluid3d (SPH, CPU)', 805240832, 805240832, 640, 480, 2)
ctx = c('SDL_GL_CreateContext', win)
with f.if_(ctx.eq(f.const('ptr', 0))):
    f.call('SDL_Quit'); f.ret(1)
c('init', posb, velb)


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
            with f.if_(sc.eq(21)): c('init', posb, velb); steps.set(0)
            with f.if_(sc.eq(19)): paused.set(paused.get() ^ 1)
        with f.if_(ty.eq(1025)): drag.set(1)
        with f.if_(ty.eq(1026)): drag.set(0)
        with f.if_(ty.eq(1024) & drag.get().ne(0)):
            yaw += rd(28).to('double') * 0.4
            pitch += rd(32).to('double') * 0.4
        with f.if_(ty.eq(1027)):
            dist += (-(rd(20).to('double'))) * 0.15
            with f.if_(dist.get() < 0.8): dist.set(0.8)
    with f.if_(slosh.get().ne(0)):   # 晃一下：全部粒子給一個朝 +x 的速度
        with f.loop(i, 0, N):
            velb[i.get() * 3] = velb[i.get() * 3] + 2.5
        slosh.set(0)
    with f.if_(paused.get().eq(0)):
        c('step', posb, velb, rho, prs, accb); steps += 1
    c('draw', posb, velb, yaw.get(), pitch.get(), dist.get(), steps.get())
    c('SDL_GL_SwapWindow', win); c('SDL_Delay', 16)
    frames += 1
    with f.if_((maxf.get() > 0) & (frames.get() >= maxf.get())): running.set(0)
ymean = f.var('double', 0.0)
with f.loop(i, 0, N):
    ymean += posb[i.get() * 3 + 1]
c('printf', 'frames=%d n=%d y_mean=%.3f\n', frames.get(), N, (ymean.get() / float(N)))
c('SDL_GL_DeleteContext', ctx); c('SDL_DestroyWindow', win); c('SDL_Quit')
f.ret(0)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gpgpu', 'fluid3d.ll')
open(out, 'w', encoding='utf-8').write(m.text() + "\n")
print('wrote', out)
