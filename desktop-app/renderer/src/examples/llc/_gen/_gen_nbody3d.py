# -*- coding: utf-8 -*-
# 產生 ../gpgpu/nbody3d.ll：照 examples/python/gpgpu/nbody3d.py（它是 sdlmm/exams/nbody3d.c 的移植）的 IR 版，內容跟 Python 版一致：
#   物理：float32，F = G·m_j·r / (r² + ε²)^(3/2)，v += Σ·dt，位置 += clampf(v, MIN_velocity, MAX_Velocity)·dt（C 的軟限速）；質量 200..299；
#         一開始在 0..MAX_X×0..MAX_Y×0..MAX_Z 的盒子裡均勻分布、速度 0；每 LOOP（2000）幀印 "N 秒數"、隨機換 MAX_X/Y/Z、MAX_Velocity、Gravity_Coef、SOFTENING 重來。
#   畫面：加法混合的發光（高斯）點精靈、青色系（C 的 glowColors）、座標 ×0.1、攝影機繞原點（距離 50、角度 0.3 與 0）、叢集中心追蹤（位能最高的那顆與 100 以內的鄰居，以 質量/(距離+1) 加權）。
#   控制：滑鼠拖曳＝旋轉；方向鍵＝旋轉；＋／－＝縮放；C＝攝影機追蹤；R＝每個週期隨機模擬係數；H＝顯示／隱藏覆蓋層；覆蓋層的兩個滑桿設模擬係數（0..2）與粒子大小（5..200）。
#   覆蓋層：文字行、兩個滑桿、CPU／GPU 按鈕（GPU 要等 OpenCL 墊片：按了會說明）。
# 用法：lli nbody3d.ll [N] [LOOP] [frames]　N＝天體數（預設 3072，16..8192）、LOOP＝每個週期幾幀（預設 2000）、frames＝跑幾幀後離開（測試用）。
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _irb import *
import _font_data as FD

SCREENX, SCREENY = 800, 560
MAXN = 8192
FONT_W, FONT_H = FD.W, FD.H
GLOW = (0xFFFF00, 0xFFFF40, 0xFFFF80, 0xFFFFC0, 0xFFFFFF, 0xE0E000, 0xC0C000, 0xFFFF60, 0xFFFFA0, 0xFFFFE0)
m = Mod('; 3D N-body（照 examples/python/gpgpu/nbody3d.py，即 sdlmm/exams/nbody3d.c 的移植）：float32 物理、發光點精靈（加法混合）、攝影機追蹤、覆蓋層與滑桿。\n'
        '; 用法：lli nbody3d.ll [N] [LOOP] [frames]。滑鼠拖曳／方向鍵旋轉、＋－縮放、C 追蹤、R 隨機係數、H 覆蓋層。（由 _gen/_gen_nbody3d.py 產生）\n'
        'target triple = "x86_64-pc-linux-gnu"')
D = m.decl
D('i32', 'SDL_Init', 'i32'); D('void', 'SDL_Quit'); D('ptr', 'SDL_CreateWindow', 'ptr', 'i32', 'i32', 'i32', 'i32', 'i32'); D('ptr', 'SDL_GL_CreateContext', 'ptr')
D('void', 'SDL_GL_SwapWindow', 'ptr'); D('i32', 'SDL_PollEvent', 'ptr'); D('void', 'SDL_Delay', 'i32'); D('i32', 'SDL_GetTicks'); D('void', 'SDL_GL_DeleteContext', 'ptr'); D('void', 'SDL_DestroyWindow', 'ptr')
D('void', 'glClearColor', 'float', 'float', 'float', 'float'); D('void', 'glClear', 'i32'); D('void', 'glMatrixMode', 'i32'); D('void', 'glLoadIdentity')
D('void', 'gluPerspective', 'double', 'double', 'double', 'double'); D('void', 'gluLookAt', 'double', 'double', 'double', 'double', 'double', 'double', 'double', 'double', 'double')
D('void', 'glOrtho', 'double', 'double', 'double', 'double', 'double', 'double'); D('void', 'glPointSize', 'float'); D('void', 'glBegin', 'i32'); D('void', 'glEnd')
D('void', 'glColor3f', 'float', 'float', 'float'); D('void', 'glColor4f', 'float', 'float', 'float', 'float'); D('void', 'glVertex2f', 'float', 'float'); D('void', 'glVertex3f', 'float', 'float', 'float')
D('void', 'glEnable', 'i32'); D('void', 'glDisable', 'i32'); D('void', 'glBlendFunc', 'i32', 'i32'); D('void', 'glPointParameterfv', 'i32', 'ptr')
D('float', 'sqrtf', 'float'); D('double', 'sin', 'double'); D('double', 'cos', 'double'); D('i32', 'atoi', 'ptr'); D('i32', 'printf', 'ptr', varargs=True)
D('i32', 'snprintf', 'ptr', 'i64', 'ptr', varargs=True)
font = m.const_array('font', 'i32', FD.ROWS)
colr = m.const_array('colr', 'float', [((c & 0xFF) / 255.0) for c in GLOW])
colg = m.const_array('colg', 'float', [(((c >> 8) & 0xFF) / 255.0) for c in GLOW])
colb = m.const_array('colb', 'float', [(((c >> 16) & 0xFF) / 255.0) for c in GLOW])


def P(f, *names):
    out = []
    for n_, ty in names:
        v = f.args[[a[1] for a in f.params].index(n_)]
        v.elem = ty
        out.append(v)
    return out


# 偽隨機：線性同餘，回傳 [0, 1)；urand(lo, hi)
rnd = m.fn('float', 'rnd', ('ptr', 'seed'))
(seed,) = P(rnd, ('seed', 'i32'))
s = rnd.load('i32', seed); s2 = (s * 1103515245 + 12345) & 0x7fffffff
rnd.store('i32', s2, seed)
rnd.ret((s2 >> 8).to('float') / 8388608.0)
ur = m.fn('float', 'urand', ('ptr', 'seed'), ('float', 'lo'), ('float', 'hi'))
seed, lo, hi = ur.args
ur.ret(lo + (hi - lo) * ur.call('rnd', seed))

# C 的 clampf：超過上限／下限的值往限制移回一半（不是截斷）
clampf = m.fn('float', 'clampf', ('float', 'v'), ('float', 'lo'), ('float', 'hi'))
v, lo, hi = clampf.args
x = clampf.var('float', 0.0)
x.set(v)
with clampf.if_(x.get() > hi): x.set((x.get() + hi) * 0.5)
with clampf.if_(x.get() < lo): x.set((x.get() + lo) * 0.5)
clampf.ret(x.get())

# 參數陣列 par：0 MAX_X 1 MAX_Y 2 MAX_Z 3 MAX_Velocity 4 Gravity_Coef 5 SOFTENING 6 simulate factor(dt) 7 particle size
rz = m.fn('void', 'randomize', ('ptr', 'par'), ('ptr', 'seed'))
par, seed = P(rz, ('par', 'float'), ('seed', 'i32'))
u = lambda lo_, hi_: rz.call('urand', seed, lo_, hi_)
par[0] = u(10.0, float(SCREENX)); par[1] = u(10.0, float(SCREENY)); par[2] = u(10.0, float(max(SCREENX, SCREENY)))
par[3] = u(10.0, SCREENY / 2.0); par[4] = u(10.0, 60.0); par[5] = u(50.0, 200.0)
rz.ret()

ib = m.fn('void', 'init_bodies', ('ptr', 'x'), ('ptr', 'y'), ('ptr', 'z'), ('ptr', 'vx'), ('ptr', 'vy'), ('ptr', 'vz'), ('ptr', 'ms'), ('ptr', 'par'), ('ptr', 'seed'), ('i32', 'n'))
x, y, z, vx, vy, vz, ms, par, seed = P(ib, *[(n_, 'float') for n_ in ('x', 'y', 'z', 'vx', 'vy', 'vz', 'ms', 'par')], ('seed', 'i32'))
n = ib.args[9]
i = ib.var('i32', 0)
with ib.loop(i, 0, n):
    k = i.get()
    x[k] = ib.call('urand', seed, 0.0, par[0]); y[k] = ib.call('urand', seed, 0.0, par[1]); z[k] = ib.call('urand', seed, 0.0, par[2])
    vx[k] = 0.0; vy[k] = 0.0; vz[k] = 0.0
    ms[k] = ib.call('urand', seed, 200.0, 300.0).to('i32').to('float')
ib.ret()

# 一幀的 N-body：對每個 i 加總 j != i 的 s·(xj−xi)，s = G·m_j / (r²+ε²)^(3/2)，並累加位能 Σ m_j / 距離；再積分
st = m.fn('void', 'step', ('ptr', 'x'), ('ptr', 'y'), ('ptr', 'z'), ('ptr', 'vx'), ('ptr', 'vy'), ('ptr', 'vz'), ('ptr', 'ms'), ('ptr', 'pot'), ('ptr', 'par'), ('i32', 'n'))
x, y, z, vx, vy, vz, ms, pot, par = P(st, *[(n_, 'float') for n_ in ('x', 'y', 'z', 'vx', 'vy', 'vz', 'ms', 'pot', 'par')])
n = st.args[9]
c = st.call
soft2 = par[5] * par[5]
gco = par[4]
dt = par[6]
i, j = st.var('i32', 0), st.var('i32', 0)
ax, ay, az, pp = st.var('float', 0.0), st.var('float', 0.0), st.var('float', 0.0), st.var('float', 0.0)
sx, sy, sz = st.array('float', MAXN), st.array('float', MAXN), st.array('float', MAXN)
with st.loop(i, 0, n):
    ax.set(0.0); ay.set(0.0); az.set(0.0); pp.set(0.0)
    xi, yi, zi = x[i.get()], y[i.get()], z[i.get()]
    with st.loop(j, 0, n):
        with st.if_(i.get().ne(j.get())):
            dx, dy, dz = x[j.get()] - xi, y[j.get()] - yi, z[j.get()] - zi
            inv = 1.0 / c('sqrtf', dx * dx + dy * dy + dz * dz + soft2)
            sc = gco * ms[j.get()] * inv * inv * inv
            ax += sc * dx; ay += sc * dy; az += sc * dz
            pp += ms[j.get()] * inv
    sx[i.get()] = ax.get(); sy[i.get()] = ay.get(); sz[i.get()] = az.get(); pot[i.get()] = pp.get()
with st.loop(i, 0, n):
    k = i.get()
    vx[k] = vx[k] + sx[k] * dt; vy[k] = vy[k] + sy[k] * dt; vz[k] = vz[k] + sz[k] * dt
    x[k] = x[k] + c('clampf', vx[k], 1.0, par[3]) * dt
    y[k] = y[k] + c('clampf', vy[k], 1.0, par[3]) * dt
    z[k] = z[k] + c('clampf', vz[k], 1.0, par[3]) * dt
st.ret()

# findClusterCenter：位能最高的那顆，加上 100 以內的鄰居，以 質量/(距離+1) 加權；結果放 out[0..2]
cc = m.fn('void', 'cluster', ('ptr', 'x'), ('ptr', 'y'), ('ptr', 'z'), ('ptr', 'ms'), ('ptr', 'pot'), ('i32', 'n'), ('ptr', 'out'))
x, y, z, ms, pot, out = P(cc, *[(n_, 'float') for n_ in ('x', 'y', 'z', 'ms', 'pot', 'out')])
n = cc.args[5]
c = cc.call
best, bi, i = cc.var('float', -1.0), cc.var('i32', 0), cc.var('i32', 0)
with cc.loop(i, 0, n):
    with cc.if_(pot[i.get()] > best.get()):
        best.set(pot[i.get()]); bi.set(i.get())
kx, ky, kz = x[bi.get()], y[bi.get()], z[bi.get()]
sw, sxx, syy, szz = cc.var('float', 0.0), cc.var('float', 0.0), cc.var('float', 0.0), cc.var('float', 0.0)
with cc.loop(i, 0, n):
    dx, dy, dz = x[i.get()] - kx, y[i.get()] - ky, z[i.get()] - kz
    d = c('sqrtf', dx * dx + dy * dy + dz * dz)
    with cc.if_(d < 100.0):
        w = ms[i.get()] / (d + 1.0)
        sw += w; sxx += x[i.get()] * w; syy += y[i.get()] * w; szz += z[i.get()] * w
with cc.if_(sw.get() > 0.0):
    out[0] = sxx.get() / sw.get(); out[1] = syy.get() / sw.get(); out[2] = szz.get() / sw.get()
cc.ret()

# 文字：從 (x0, y0) 起把字串用點陣字型畫成點（要在 glBegin(GL_POINTS) 裡呼叫；顏色由呼叫端先設）
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
                        tx.call('glVertex2f', (x0 + k.get() * FONT_W + col.get()).to('float') + 0.5, (y0 + r.get() - 2).to('float') + 0.5)   # +0.5：1 像素的點要落在像素中心，不然光柵化可能一個像素都蓋不到
    k += 1
tx.ret()

# 畫一幀的 3D：座標減去中心再 ×0.1，加法混合的發光點精靈（青色系），大小隨距離反比（GL_POINT_DISTANCE_ATTENUATION＝(0,0,1/ref²)，ref＝50）
dr = m.fn('void', 'draw_scene', ('ptr', 'x'), ('ptr', 'y'), ('ptr', 'z'), ('i32', 'n'), ('ptr', 'ctr'), ('float', 'dist'), ('float', 'ax'), ('float', 'ay'), ('float', 'size'))
x, y, z, ctr = P(dr, *[(n_, 'float') for n_ in ('x', 'y', 'z', 'ctr')])
n, dist, ax, ay, size = dr.args[3], dr.args[5], dr.args[6], dr.args[7], dr.args[8]
c = dr.call
c('glClearColor', 0.0, 0.0, 0.0, 1.0); c('glClear', 0x4100); c('glDisable', 0x0B71)
c('glMatrixMode', 0x1701); c('glLoadIdentity'); c('gluPerspective', 0.78 * 180.0 / 3.14159265, SCREENX / float(SCREENY), 0.1, 5000.0)
c('glMatrixMode', 0x1700); c('glLoadIdentity')
axd, ayd, dd = ax.to('double'), ay.to('double'), dist.to('double')
c('gluLookAt', dd * c('sin', ayd) * c('cos', axd), dd * c('sin', axd), -dd * c('cos', ayd) * c('cos', axd), 0.0, 0.0, 0.0, 0.0, 1.0, 0.0)
att = dr.array('float', 3)
att[0] = 0.0; att[1] = 0.0; att[2] = 1.0 / 2500.0
c('glEnable', 0x0BE2); c('glBlendFunc', 0x0302, 1); c('glEnable', 0x0B10); c('glPointSize', size); c('glPointParameterfv', 0x8129, att)
c('glBegin', 0)
i = dr.var('i32', 0)
cr, cg, cb = V(dr, '@colr', 'ptr', 'float'), V(dr, '@colg', 'ptr', 'float'), V(dr, '@colb', 'ptr', 'float')
with dr.loop(i, 0, n):
    k = i.get()
    ci = k % 10
    c('glColor4f', cr[ci], cg[ci], cb[ci], 0.5)
    c('glVertex3f', (x[k] - ctr[0]) * 0.1, (y[k] - ctr[1]) * 0.1, (z[k] - ctr[2]) * 0.1)
c('glEnd'); c('glDisable', 0x0BE2)
dr.ret()

# 覆蓋層（draw3D() 的文字、滑桿、按鈕）：2D 正投影，座標與 Python 版一致
hud = m.fn('void', 'draw_hud', ('i32', 'n'), ('i32', 'loop'), ('i32', 'loops'), ('float', 'ms'), ('ptr', 'par'), ('i32', 'rnd_on'), ('float', 'dist'), ('float', 'ax'), ('float', 'ay'), ('i32', 'tracking'), ('i32', 'note'))
n, loop, loops, ms, par, rnd_on, dist, ax, ay, tracking, note = hud.args
par.elem = 'float'
c = hud.call
buf = hud.array('i8', 128)
S_ON, S_OFF = V(hud, m.string('on'), 'ptr'), V(hud, m.string('off'), 'ptr')
c('glMatrixMode', 0x1701); c('glLoadIdentity'); c('glOrtho', 0.0, float(SCREENX), float(SCREENY), 0.0, -1.0, 1.0); c('glMatrixMode', 0x1700); c('glLoadIdentity')
c('glDisable', 0x0BE2); c('glPointSize', 1.0)
W3, G3, Y3 = (1.0, 1.0, 1.0), (0.667, 0.667, 0.667), (1.0, 0.8, 0.4)


def line(y, color, fmt, *args):
    c('glColor3f', *color)
    c('snprintf', buf, 128, fmt, *args)
    c('text', buf, 5, y)


c('glBegin', 0)
line(5, W3, '[%-3d/%-3d] tm:%-3.3f bodies:%d', loop, loops, (ms / 1000.0).to('double'), n)
line(25, W3, 'simulate factor: %-3.5f', par[6].to('double'))
line(45, W3, 'random factor: %s[r]', rnd_on.ne(0).sel(S_ON, S_OFF))
line(65, W3, 'particle size: %-3.1f', par[7].to('double'))
line(85, W3, 'cam dist:%.1f angle:(%.2f,%.2f)', dist.to('double'), ax.to('double'), ay.to('double'))
line(105, W3, 'camera tracking: %s[C]', tracking.ne(0).sel(S_ON, S_OFF))
line(125, W3, 'compute source:')
with hud.if_(note.ne(0)):
    line(145, Y3, 'GPU source: needs the OpenCL layer (not available yet); staying on CPU')
line(165, G3, 'MAX_X:%.1f MAX_Y:%.1f MAX_Z:%.1f', par[0].to('double'), par[1].to('double'), par[2].to('double'))
line(185, G3, 'MAX_Vel:%.1f Grav:%.1f Soft:%.1f', par[3].to('double'), par[4].to('double'), par[5].to('double'))
line(205, G3, '[h]help [+/-]zoom [arrows/mouse]rotate [C]track')
c('glColor3f', *W3)
c('glEnd')
# 滑桿與按鈕：填色的方塊（GL_QUADS）＋白色外框（GL_LINES）
c('glBegin', 7)
def quad(x1, y1, w_, h_, color):
    c('glColor3f', *color)
    for dx_, dy_ in ((0, 0), (1, 0), (1, 1), (0, 1)):
        c('glVertex2f', (x1 + w_ * dx_), (y1 + h_ * dy_))
quad(140.0, 122.0, 50.0, 20.0, (0.12, 0.48, 0.12))            # CPU 按鈕（目前的計算來源，綠色）
quad(200.0, 122.0, 50.0, 20.0, (0.19, 0.19, 0.19))            # GPU 按鈕（沒有）
quad(320.0, 25.0, (par[6] / 2.0 * 400.0), 15.0, (0.99, 0.99, 0.0))       # 模擬係數滑桿（0..2）
quad(320.0, 65.0, ((par[7] - 5.0) / 195.0 * 400.0), 15.0, (0.0, 1.0, 0.0))  # 粒子大小滑桿（5..200）
c('glEnd')
c('glBegin', 1); c('glColor3f', *W3)
for (rx, ry, rw, rh) in ((140.0, 122.0, 50.0, 20.0), (200.0, 122.0, 50.0, 20.0), (320.0, 25.0, 400.0, 15.0), (320.0, 65.0, 400.0, 15.0)):
    for (a1, b1, a2, b2) in ((0, 0, 1, 0), (0, 1, 1, 1), (0, 0, 0, 1), (1, 0, 1, 1)):
        c('glVertex2f', rx + rw * a1, ry + rh * b1); c('glVertex2f', rx + rw * a2, ry + rh * b2)
c('glEnd')
# 按鈕上的字要最後畫（在填色方塊之後）：否則方塊會蓋住文字（先前的順序造成文字看不到）
c('glColor3f', *W3)
c('glBegin', 0)
c('text', 'CPU', 152, 125)      # 按鈕在 (140,122,50,20)、GPU 在 (200,122,50,20)
c('text', 'GPU', 212, 125)
c('glEnd')
hud.ret()

f = m.fn('i32', 'main', ('i32', 'argc'), ('ptr', 'argv'))
argc, argv = f.args
argv.elem = 'ptr'
c = f.call
X, Y, Z, VX, VY, VZ, MS, POT = [f.array('float', MAXN) for _ in range(8)]
par, ctr, snap, cen = f.array('float', 8), f.array('float', 3), f.array('float', 3), f.array('float', 3)
ev = f.array('i8', 56)
seed = f.alloca('i32'); f.store('i32', 12345, seed)
nv, loops, maxf = f.var('i32', 3072), f.var('i32', 2000), f.var('i32', 0)
with f.if_(argc > 1):
    nv.set(c('atoi', f.load('ptr', argv.at(1))))
    with f.if_(nv.get() < 16): nv.set(16)
    with f.if_(nv.get() > MAXN): nv.set(MAXN)
with f.if_(argc > 2): loops.set(c('atoi', f.load('ptr', argv.at(2))))
with f.if_(argc > 3): maxf.set(c('atoi', f.load('ptr', argv.at(3))))
n = nv.get()
c('SDL_Init', 32)
win = c('SDL_CreateWindow', '[3D] NBody-Simulation', 805240832, 805240832, SCREENX, SCREENY, 2)
ctx = c('SDL_GL_CreateContext', win)
with f.if_(ctx.eq(f.const('ptr', 0))):
    f.call('SDL_Quit'); f.ret(1)
par[6] = 0.02; par[7] = 15.0
c('randomize', par, seed); c('init_bodies', X, Y, Z, VX, VY, VZ, MS, par, seed, n)
snap[0] = par[0] * 0.5; snap[1] = par[1] * 0.5; snap[2] = par[2] * 0.5
cen[0] = snap[0]; cen[1] = snap[1]; cen[2] = snap[2]
running, frames, loop, rnd_on, tracking, show, pressed, note = [f.var('i32', x) for x in (1, 0, 0, 0, 1, 1, 0, 0)]
dist, cax, cay = f.var('float', 50.0), f.var('float', 0.3), f.var('float', 0.0)
tdist, tax, tay = f.var('float', 50.0), f.var('float', 0.3), f.var('float', 0.0)
lastx, lasty, msv = f.var('i32', 0), f.var('i32', 0), f.var('float', 0.0)
t0, tcycle = f.var('i32', c('SDL_GetTicks')), f.var('i32', c('SDL_GetTicks'))


def rd(off):
    return f.load('i32', f.gep8(ev, off))


def manual():
    tracking.set(0)


def slider(xv, yv):
    with f.if_((yv > 25) & (yv < 40) & (xv >= 320) & (xv <= 720)):
        par[6] = (xv - 320).to('float') * 2.0 / 400.0
    with f.if_((yv > 65) & (yv < 80) & (xv >= 320) & (xv <= 720)):
        par[7] = 5.0 + 195.0 * (xv - 320).to('float') / 400.0


def in_slider(xv, yv):
    return (xv >= 320) & (xv <= 720) & (((yv >= 25) & (yv < 40)) | ((yv >= 65) & (yv < 80)))


def in_btn(xv, yv, bx):
    return (xv >= bx) & (xv <= bx + 50) & (yv >= 122) & (yv <= 142)


with f.while_(lambda: running.get().ne(0)):
    with f.while_(lambda: c('SDL_PollEvent', ev).ne(0)):
        ty = f.load('i32', ev)
        with f.if_(ty.eq(256)): running.set(0)
        with f.if_(ty.eq(768)):                      # 鍵盤（kbfnc）
            sc = rd(16)
            with f.if_(sc.eq(41)): running.set(0)
            with f.if_(sc.eq(21)): rnd_on.set(f.const('i32', 1) - rnd_on.get())          # R
            with f.if_(sc.eq(11)): show.set(f.const('i32', 1) - show.get())               # H
            with f.if_(sc.eq(6)):                                                          # C：攝影機追蹤
                tracking.set(f.const('i32', 1) - tracking.get())
                with f.if_(tracking.get().ne(0)):
                    snap[0] = cen[0]; snap[1] = cen[1]; snap[2] = cen[2]
                    tax.set(0.3); tay.set(0.0); tdist.set(50.0)
            with f.if_(sc.eq(46) | sc.eq(87)): dist -= 3.0; manual()                      # + 或 =
            with f.if_(sc.eq(45) | sc.eq(86)): dist += 3.0; manual()                      # -
            with f.if_(sc.eq(82)): cax += 0.1; manual()
            with f.if_(sc.eq(81)): cax -= 0.1; manual()
            with f.if_(sc.eq(80)): cay -= 0.1; manual()
            with f.if_(sc.eq(79)): cay += 0.1; manual()
        mx, my = rd(20), rd(24)
        with f.if_(ty.eq(1025)):                     # 滑鼠按下
            with f.if_(show.get().ne(0) & in_slider(mx, my)):
                pressed.set(1); slider(mx, my)
            with f.if_((show.get().ne(0) & in_slider(mx, my)).eq(0)):
                with f.if_(show.get().ne(0) & (in_btn(mx, my, 140) | in_btn(mx, my, 200))):
                    pressed.set(3); note.set(0)
                    with f.if_(in_btn(mx, my, 200)): note.set(1)                             # GPU 按鈕：說明還沒有
                with f.if_((show.get().ne(0) & (in_btn(mx, my, 140) | in_btn(mx, my, 200))).eq(0)):
                    pressed.set(2); lastx.set(mx); lasty.set(my)
        with f.if_(ty.eq(1026)): pressed.set(0)
        with f.if_(ty.eq(1024)):                     # 滑鼠移動：拖曳滑桿或旋轉
            with f.if_(pressed.get().eq(1)): slider(mx, my)
            with f.if_(pressed.get().eq(2) & (rd(16) & 1).ne(0)):
                cay += (mx - lastx.get()).to('float') * 0.005
                cax -= (my - lasty.get()).to('float') * 0.005
                with f.if_(cax.get() > 1.5): cax.set(1.5)
                with f.if_(cax.get() < -1.5): cax.set(-1.5)
                lastx.set(mx); lasty.set(my); manual()
    # 攝影機轉場：追蹤時往目標平滑靠近（0.1）；不追蹤時目標跟著目前值
    with f.if_(tracking.get().ne(0)):
        cax += (tax.get() - cax.get()) * 0.1; cay += (tay.get() - cay.get()) * 0.1; dist += (tdist.get() - dist.get()) * 0.1
    with f.if_(tracking.get().eq(0)):
        tax.set(cax.get()); tay.set(cay.get()); tdist.set(dist.get())
    ta = c('SDL_GetTicks')
    c('step', X, Y, Z, VX, VY, VZ, MS, POT, par, n)
    c('cluster', X, Y, Z, MS, POT, n, cen)
    msv.set((c('SDL_GetTicks') - ta).to('float'))
    loop += 1
    with f.if_(loop.get() >= loops.get()):           # 一個週期結束：印 "N 秒數"，換新的隨機參數重來
        c('printf', '%d %f\n', n, (c('SDL_GetTicks') - tcycle.get()).to('double') / 1000.0)
        tcycle.set(c('SDL_GetTicks'))
        with f.if_(rnd_on.get().ne(0)):
            par[6] = c('urand', seed, 0.0, 1.0)
        c('randomize', par, seed); c('init_bodies', X, Y, Z, VX, VY, VZ, MS, par, seed, n)
        loop.set(0)
        with f.if_(tracking.get().ne(0)):
            snap[0] = par[0] * 0.5; snap[1] = par[1] * 0.5; snap[2] = par[2] * 0.5
    # 畫面中心：追蹤時用快照，否則用盒子中心
    with f.if_(tracking.get().ne(0)):
        ctr[0] = snap[0]; ctr[1] = snap[1]; ctr[2] = snap[2]
    with f.if_(tracking.get().eq(0)):
        ctr[0] = par[0] * 0.5; ctr[1] = par[1] * 0.5; ctr[2] = par[2] * 0.5
    c('draw_scene', X, Y, Z, n, ctr, dist.get(), cax.get(), cay.get(), par[7])
    with f.if_(show.get().ne(0)):
        c('draw_hud', n, loop.get(), loops.get(), msv.get(), par, rnd_on.get(), dist.get(), cax.get(), cay.get(), tracking.get(), note.get())
    c('SDL_GL_SwapWindow', win); c('SDL_Delay', 1)
    frames += 1
    with f.if_((maxf.get() > 0) & (frames.get() >= maxf.get())): running.set(0)
c('printf', 'frames=%d bodies=%d cx=%.1f cy=%.1f cz=%.1f\n', frames.get(), n, cen[0].to('double'), cen[1].to('double'), cen[2].to('double'))
c('SDL_GL_DeleteContext', ctx); c('SDL_DestroyWindow', win); c('SDL_Quit')
f.ret(0)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gpgpu', 'nbody3d.ll')
open(out, 'w', encoding='utf-8').write(m.text() + "\n")
print('wrote', out)
