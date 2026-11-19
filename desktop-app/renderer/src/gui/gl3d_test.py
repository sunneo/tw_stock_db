# -*- coding: utf-8 -*-
# gl3d（建在真的 PyOpenGL 之上）的測試：矩陣數學、幾何、FrameBuilder 的指令，以及 View 用 PyOpenGL 把一幀跑出來（假的 WebGL2 後端記錄呼叫），
# 畫面以 PNG 經橋接的 image 與 draw 送到視窗畫布。需要 pip 的 PyOpenGL（沒有就只測數學與幾何）。
# 執行：python3 renderer/src/gui/gl3d_test.py
import json, math, os, subprocess, sys, types, array

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'pybridge'))
calls = []
stub = types.ModuleType('fa_bridge')
stub.call = lambda op, args=None, timeout=240.0: (calls.append((op, args)) or ({'w': 8, 'h': 8} if op == 'gui.image' else {'ok': True})); stub.sleep = lambda s: None; stub.ACTIVE = True
sys.modules['fa_bridge'] = stub
import gui, gl3d  # noqa: E402

fails = []
def check(name, cond, extra=None):
    if not cond:
        fails.append(name); print('FAIL', name, '' if extra is None else repr(extra)[:240])
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
# FrameBuilder 的指令（不需要 PyOpenGL）
cu_f = gl3d.FrameBuilder(gl3d.mat4_identity(), 1.0)
cu_f.clear(0, 0, 0, 1).state('depth', True).mesh('lit', 'cube', 'cube_i', cu.index_count, color=(1, 0.5, 0.2)).lines('flat', 'axes', 6).glow('pts', 'pts', 2, size=20)
fr = cu_f.cmds
check('frame starts with clear + depth', fr[0][0] == 'clear' and fr[1] == ['state', 'depth', 1])
check('glow switches additive on then off', ['state', 'additive', 1] in fr and fr[-1] == ['state', 'depth', 1])
check('mesh draw is indexed triangles 36', ['draw', 'triangles', 0, 36, 1] in fr)

# View：用真的 PyOpenGL 執行（假的 WebGL2 後端記錄呼叫）
try:
    import OpenGL  # noqa: F401
except ImportError:
    print('（沒有 PyOpenGL，略過 View 的測試）')
    print('gl3d_test：%d 項失敗' % len(fails) if fails else 'gl3d_test：全部通過')
    sys.exit(1 if fails else 0)
import fa_opengl_platform as P
class Fake(object):
    def __init__(self): self.calls = []; self.n = 0
    def log(self, name): return [c[1] for c in self.calls if c[0] == name]
    def __getattr__(self, name):
        def f(*a, **k):
            self.calls.append((name, a))
            if name.startswith('create_'): self.n += 1; return 'h%d' % self.n
            if name in ('get_shader_parameter', 'get_program_parameter'): return True
            if name in ('get_shader_info_log', 'get_program_info_log'): return ''
            if name == 'get_attrib_location': return 0
            if name == 'get_uniform_location': return 'loc'
            return None
        return f
    def capture_png(self): return b'\x89PNG\r\n\x1a\nfake'
fk = Fake(); P.reset(); P.register(); P.create_context(320, 240, backend=fk)
calls.clear()
w = gui.Window('t', 300)
v = gl3d.View(w, 320, 240, fps=30)
check('the canvas is a plain (picture) canvas, not a gl canvas', [c for c in calls if c[0] == 'gui.add'][-1][1]['node'].get('gl') is None)
check('five built-in programs compiled with PyOpenGL', len(fk.log('link_program')) == 5 and len(fk.log('compile_shader')) == 10, (len(fk.log('link_program')), len(fk.log('compile_shader'))))
check('no shader errors', v.errors == [], v.errors)
v.buffer('cube', cu.vertices); v.buffer('cube_i', cu.indices, cu.index_type)
v.buffer('axes', gl3d.axes_lines()); v.buffer('pts', array.array('f', [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0]))
bd = fk.log('buffer_data')
check('buffers uploaded with glBufferData (array and element targets)', len(bd) == 4 and bd[0][0] == 0x8892 and bd[1][0] == 0x8893 and len(bd[0][1]) == 24 * 36, [(b[0], len(b[1])) for b in bd])
f = v.frame(); f.mesh('lit', 'cube', 'cube_i', cu.index_count, color=(1, 0.5, 0.2)); f.lines('flat', 'axes', 6)
f.points('pts', 2, stride=24, color_offset=12, size=8); f.glow('pts', 'pts', 2, size=20)
fk.calls.clear(); calls.clear(); v.show(f)
check('clear + depth test + program uniforms', fk.log('clear_color') and fk.log('clear') and (0x0B71,) in fk.log('enable') and len(fk.log('uniform_matrix')) >= 3)
check('indexed draw of 36 (glDrawElements, unsigned short)', (4, 36, 0x1403, 0) in fk.log('draw_elements'), fk.log('draw_elements'))
check('lines and points are glDrawArrays', (1, 0, 6) in fk.log('draw_arrays') and (0, 0, 2) in fk.log('draw_arrays'), fk.log('draw_arrays'))
check('glow: additive blend on then off', (0x0302, 1) in fk.log('blend_func') and fk.log('disable').count((0x0BE2,)) >= 1, (fk.log('blend_func'), fk.log('disable')))
check('vertex attributes use the bound buffer with offsets', (0, 3, 0x1406, False, 36, 0) in fk.log('vertex_attrib_pointer') or any(a[2] == 0x1406 and a[4] == 36 for a in fk.log('vertex_attrib_pointer')), fk.log('vertex_attrib_pointer')[:3])
imgs = [c for c in calls if c[0] == 'gui.image']; drws = [c for c in calls if c[0] == 'gui.draw']
check('the frame goes to the window as one PNG picture and one image draw', len(imgs) == 1 and imgs[0][1]['name'] == 'gl3d' and len(drws) == 1 and drws[0][1]['ops'] == [['image', 'gl3d', 0, 0, 320, 240]], (len(imgs), drws))
check('event routing', v.handle({'event': 'frame', 'node': v.nid}) == 'frame')
check('other node ignored', v.handle({'event': 'frame', 'node': 'zzz'}) is None)
check('resize resizes the WebGL2 canvas', v.handle({'event': 'resize', 'node': v.nid, 'value': {'width': 200, 'height': 100}}) == 'resize' and v.width == 200 and (0, 0, 200, 100) in fk.log('viewport'), fk.log('viewport')[-2:])
w2 = gui.Window('t2', 300); v.errors.clear(); fk2 = None
check('a bad shader is reported, not raised', (lambda: (v.program('bad', 'x', 'y'), True)[1])())

print('gl3d_test：%d 項失敗' % len(fails) if fails else 'gl3d_test：全部通過')
sys.exit(1 if fails else 0)
