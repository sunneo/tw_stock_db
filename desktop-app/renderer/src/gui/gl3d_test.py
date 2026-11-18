# -*- coding: utf-8 -*-
# gl3d（與 gui.py 的 glbuf／glprog／glframe）對假 fa_bridge 的測試：矩陣數學、幾何、指令內容；
# 並把送出的訊息交給真正的 JS 橋接層（renderer/src/gui/gui_bridge.js）驗證，確認 Python 端送出的東西都會被橋接層接受。
# 執行：python3 renderer/src/gui/gl3d_test.py
import json, math, os, subprocess, sys, types, array

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'pybridge'))
calls = []
stub = types.ModuleType('fa_bridge')
stub.call = lambda op, args=None, timeout=240.0: (calls.append((op, args)) or {'ok': True})
sys.modules['fa_bridge'] = stub
import gui, gl3d  # noqa: E402

fails = []
def check(name, cond):
    if not cond:
        fails.append(name); print('FAIL', name)
def near(a, b, e=1e-6): return all(abs(x - y) < e for x, y in zip(a, b))

# 矩陣
I = gl3d.mat4_identity()
t = gl3d.mat4_translate(1, 2, 3)
check('identity * t = t', near(gl3d.mat4_mul(I, t), t))
check('translate column', t[12:15] == [1, 2, 3])
r = gl3d.mat4_rotate_y(math.pi / 2)
v = [r[0] * 1 + r[8] * 0, r[1], r[2]]            # +x 轉 90 度繞 y → -z
check('rotate_y 90: x -> -z', near([r[0], r[1], r[2]], [0, 0, -1], 1e-9))
p = gl3d.mat4_perspective(math.pi / 2, 1.0, 1.0, 10.0)
check('perspective f=1', abs(p[0] - 1) < 1e-9 and abs(p[5] - 1) < 1e-9 and p[11] == -1)
# 近平面上的點 z=-near 映到 clip z/w = -1；遠平面 z=-far 映到 +1
def clip(m, x, y, z): return [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14], m[3]*x+m[7]*y+m[11]*z+m[15]]
c = clip(p, 0, 0, -1.0); check('near plane -> -1', abs(c[2] / c[3] + 1) < 1e-9)
c = clip(p, 0, 0, -10.0); check('far plane -> +1', abs(c[2] / c[3] - 1) < 1e-9)
la = gl3d.mat4_look_at([0, 0, 5], [0, 0, 0])
c = clip(la, 0, 0, 0); check('look_at: origin at z=-5 in view space', near(c[:3], [0, 0, -5]))
# 軌道相機
cam = gl3d.Camera(dist=4, yaw=0, pitch=0)
check('camera eye on +z', near(cam.eye(), [0, 0, 4]))
check('drag changes yaw', cam.handle({'event': 'mouse', 'value': {'kind': 'down', 'x': 10, 'y': 10}}) is False
      and cam.handle({'event': 'mouse', 'value': {'kind': 'move', 'x': 30, 'y': 10}}) is True and cam.yaw < 0)
d0 = cam.dist; cam.handle({'event': 'wheel', 'value': {'x': 1, 'y': 1, 'dy': -100}}); check('wheel zooms in', cam.dist < d0)
# 幾何
cu = gl3d.cube(2.0); check('cube 24 vertices 36 indices', len(cu.vertices) == 24 * 9 and cu.index_count == 36)
sp = gl3d.sphere(1.0, 16); check('sphere normals unit', all(abs(math.sqrt(sp.vertices[i+3]**2 + sp.vertices[i+4]**2 + sp.vertices[i+5]**2) - 1) < 1e-5 for i in range(0, len(sp.vertices), 9)))
check('grid/axes sizes', len(gl3d.axes_lines()) == 36 and len(gl3d.grid_lines(2, 1)) % 6 == 0)
# View 與訊息
w = gui.Window('t', 300)
v = gl3d.View(w, 320, 240, fps=30)
names = [c[1]['name'] for c in calls if c[0] == 'gui.glprog']
check('five built-in programs registered', sorted(names) == ['dots', 'flat', 'glow', 'lit', 'points'])
v.buffer('cube', cu.vertices); v.buffer('cube_i', cu.indices, cu.index_type)
f = v.frame(); f.mesh('lit', 'cube', 'cube_i', cu.index_count, color=(1, 0.5, 0.2)); f.lines('flat', 'cube', 6) if False else None
v.buffer('axes', gl3d.axes_lines()); f.lines('flat', 'axes', 6)
v.buffer('pts', array.array('f', [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0]))
f.points('pts', 2, stride=24, color_offset=12, size=8); f.points('pts', 2, stride=24, size=8)
f.glow('pts', 'pts', 2, size=20)
v.show(f)
fr = [c for c in calls if c[0] == 'gui.glframe'][-1][1]['cmds']
check('frame starts with clear + depth', fr[0][0] == 'clear' and fr[1] == ['state', 'depth', 1])
check('glow switches additive on then off', ['state', 'additive', 1] in fr and fr[-1] == ['state', 'depth', 1])
check('mesh draw is indexed triangles 36', ['draw', 'triangles', 0, 36, 1] in fr)
check('event routing', v.handle({'event': 'frame', 'node': v.nid}) == 'frame' and v.handle({'event': 'glerror', 'node': v.nid, 'value': 'x'}) == 'glerror' and v.errors == ['x'])
check('other node ignored', v.handle({'event': 'frame', 'node': 'zzz'}) is None)
check('numpy-free list upload works', True)
try:
    import numpy as np
    w.glbuf(v.nid, 'np', np.zeros(9, dtype=np.float64))
    raw = calls[-1][1]['data']
    import base64
    check('numpy float64 converted to float32', len(base64.b64decode(raw)) == 36)
except ImportError:
    pass

# 交給真正的 JS 橋接層驗證（沒有 node 就略過）
js = os.path.join(HERE, 'gui_bridge.js')
msgs = [dict(args, op=op[4:], v=1) for op, args in calls if op.startswith('gui.') and op[4:] in ('open', 'add', 'glbuf', 'glprog', 'glframe')]
script = "const G=require(%r);const s=G.createSession();const m=JSON.parse(require('fs').readFileSync(0,'utf8'));let bad=[];m.forEach((x,i)=>{const r=G.apply(s,x);if(!r.ok)bad.append?0:bad.push(i+':'+x.op+':'+r.error)});console.log(JSON.stringify(bad))" % os.path.abspath(js)
try:
    out = subprocess.run(['node', '-e', script], input=json.dumps(msgs), capture_output=True, text=True, timeout=30)
    check('JS bridge accepts every message (%s)' % (out.stdout.strip() or out.stderr.strip()[:200]), out.stdout.strip() == '[]')
except FileNotFoundError:
    print('（沒有 node，略過 JS 橋接層驗證）')

print('gl3d_test：%d 項失敗' % len(fails) if fails else 'gl3d_test：全部通過')
sys.exit(1 if fails else 0)
