# -*- coding: utf-8 -*-
"""真 pyopencl 的純 Python 層（不含 .so）＋ 我們的 _cl.py 的整合測試。

需要（沒設就略過；這些都是下載來的第三方檔案，不隨產品或儲存庫出貨）：
  FA_PYOPENCL_ROOT   解開的 pyopencl wheel 根目錄（含 pyopencl/ 與 pyopencl-*.dist-info/）
  FA_PYOPENCL_DEPS   pytools、platformdirs、typing_extensions、mako、markupsafe 的 site 目錄，以 os.pathsep 分隔
  FA_OPENCL_HOST     cl_host_stdio.js 的路徑
做法：把真 pyopencl 的 .py 與 dist-info 複製到暫存組裝目錄（刪掉 .so、.libs、_cl.pyi；**不修改任何一個真檔案**），放進我們的 _cl.py，
再用 test_support/siphash24.py（純 Python 後備）。pyopencl 的編譯快取目錄指到暫存（XDG_CACHE_HOME），不寫使用者家目錄。
用法：python3 -I _real_layer_test.py"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT, DEPS, HOST = os.environ.get("FA_PYOPENCL_ROOT"), os.environ.get("FA_PYOPENCL_DEPS"), os.environ.get("FA_OPENCL_HOST")
if not (ROOT and DEPS and HOST) or not os.path.isdir(os.path.join(ROOT or "", "pyopencl")):
    print("略過：沒有設 FA_PYOPENCL_ROOT／FA_PYOPENCL_DEPS／FA_OPENCL_HOST（見檔頭）\n0 passed, 0 failed")
    sys.exit(0)

tmp = tempfile.mkdtemp(prefix="fa-pyopencl-")
asm = os.path.join(tmp, "asm")
os.makedirs(asm)
shutil.copytree(os.path.join(ROOT, "pyopencl"), os.path.join(asm, "pyopencl"),
                ignore=lambda d, names: [n for n in names if n.endswith(".so") or n in (".libs", "_cl.pyi", "__pycache__")])
for n in os.listdir(ROOT):
    if n.endswith(".dist-info"):
        shutil.copytree(os.path.join(ROOT, n), os.path.join(asm, n))
shutil.copy(os.path.join(HERE, "_cl.py"), os.path.join(asm, "pyopencl", "_cl.py"))
paths = [asm] + DEPS.split(os.pathsep) + [os.path.join(HERE, "test_support"), os.path.dirname(HERE)]   # 最後一個：pybridge（fa_opengl_platform）
env = dict(os.environ, XDG_CACHE_HOME=os.path.join(tmp, "cache"), PYTHONDONTWRITEBYTECODE="1", FA_OPENCL_HOST=HOST)
passed = failed = 0

RUNNER = "import sys, runpy\nfor p in %r: sys.path.insert(0, p)\nrunpy.run_path(sys.argv[1], run_name='__main__')\n" % (paths,)


def run(script, text=None, drivers=None):
    path = script
    if text is not None:
        path = os.path.join(tmp, "snippet.py")
        open(path, "w", encoding="utf-8").write(text)
    e = dict(env, FA_CL_DRIVERS=drivers) if drivers else env   # 驅動：clc＝OpenCL C 前端的 CPU 驅動；kir＝KIR 驅動（預設）
    r = subprocess.run([sys.executable, "-I", "-c", RUNNER, path], capture_output=True, text=True, env=e, timeout=180)
    return r.returncode, r.stdout, r.stderr


def t(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
    except Exception as e:  # noqa: BLE001
        failed += 1
        print("FAIL " + name + "\n   " + str(e)[:1500].replace("\n", "\n   "))


def official_twice():
    for i in (1, 2):   # 第 1 次寫入 pyopencl 的編譯快取，第 2 次從快取（我們的「二進位」）讀回
        rc, out, err = run(os.path.join(HERE, "fixtures", "official_vecadd.py"))
        assert rc == 0 and "OFFICIAL EXAMPLE OK" in out, "第 %d 次 rc=%s\n%s\n%s" % (i, rc, out[-300:], err[-1200:])
    caches = [f for _, _, fs in os.walk(os.path.join(tmp, "cache")) for f in fs]
    assert "binary" in caches, "pyopencl 的編譯快取沒有寫出 binary：%s" % caches


def api_through_real_layer():
    rc, out, err = run(None, """
import numpy as np, pyopencl as cl
p = cl.get_platforms()[0]; d = p.get_devices()[0]; ctx = cl.Context([d]); q = cl.CommandQueue(ctx)
assert p.name == 'fa-kir-js' and d.max_work_group_size == 256 and d.type == cl.device_type.CPU and ctx.devices == [d]
assert 'FA KIR' in repr(d) and cl.VERSION >= (2026, 1)
# 真 Program.build 的錯誤格式（RuntimeError 重建、附 build log 與選項）
try:
    cl.Program(ctx, "__kernel void f(__global float* o) { o[get_global_id(0)] = 1 % 2; }").build()
    raise SystemExit('應該 build 失敗')
except cl.RuntimeError as e:
    s = str(e)
    assert 'clBuildProgram failed: BUILD_PROGRAM_FAILURE' in s and 'Build on' in s and '%' in s, s
    assert e.code == cl.status_code.BUILD_PROGRAM_FAILURE and e.routine == 'clBuildProgram'
# 例外階層與 status_code.to_string（real _monkeypatch 版）
assert cl.status_code.to_string(-11) == 'BUILD_PROGRAM_FAILURE' and set(cl.mem_flags.to_string(cl.mem_flags.READ_ONLY | cl.mem_flags.COPY_HOST_PTR).split(' | ')) == {'READ_ONLY', 'COPY_HOST_PTR'}
# 事件計時走真 layer 的 ProfilingInfoGetter
pq = cl.CommandQueue(ctx, properties=cl.command_queue_properties.PROFILING_ENABLE)
prg = cl.Program(ctx, "__kernel void s(__global const float* x, __global float* y, int n) { int i = get_global_id(0); if (i < n) y[i] = x[i] * 2.0f; }").build()
x = cl.Buffer(ctx, cl.mem_flags.READ_ONLY | cl.mem_flags.COPY_HOST_PTR, hostbuf=np.arange(8, dtype=np.float32)); y = cl.Buffer(ctx, cl.mem_flags.WRITE_ONLY, 32)
ev = prg.s(pq, (8,), None, x, y, np.int32(8)); ev.wait()
assert ev.profile.end >= ev.profile.start > 0
out = np.empty(8, dtype=np.float32); cl.enqueue_copy(pq, out, y)
assert out.tolist() == [0, 2, 4, 6, 8, 10, 12, 14]
# 記憶體池（pyopencl.tools，走我們的 MemoryPool）：還回去的區塊被重用
import pyopencl.tools as tools
pool = tools.MemoryPool(tools.ImmediateAllocator(pq))
b1 = pool.allocate(1000); n1 = b1.int_ptr; b1.release()
b2 = pool.allocate(1000)
assert b2.int_ptr == n1 and pool.held_blocks == 0 and pool.active_blocks == 1, (n1, b2.int_ptr)
print('REAL LAYER API OK')
""")
    assert rc == 0 and "REAL LAYER API OK" in out, "rc=%s\n%s\n%s" % (rc, out[-300:], err[-1500:])


def array_elementwise():
    rc, out, err = run(None, """
import numpy as np, pyopencl as cl, pyopencl.array as cla
ctx = cl.create_some_context(); q = cl.CommandQueue(ctx)
assert ctx.devices[0].name.startswith('FA OpenCL C')
a_np = np.arange(10, dtype=np.float32); b_np = np.linspace(1, 2, 10).astype(np.float32)
a = cla.to_device(q, a_np); b = cla.to_device(q, b_np)
def chk(name, got, want):
    assert np.allclose(got, want, rtol=1e-6), (name, got, want)
chk('a+b', (a + b).get(), a_np + b_np); chk('a-b', (a - b).get(), a_np - b_np); chk('a*b', (a * b).get(), a_np * b_np); chk('a/b', (a / b).get(), a_np / b_np)
chk('a*2.5', (a * 2.5).get(), a_np * 2.5); chk('a+1', (a + 1).get(), a_np + 1); chk('-a', (-a).get(), -a_np); chk('abs', abs(-a).get(), np.abs(a_np))
chk('a>b', (a > b).get(), a_np > b_np); chk('astype', a.astype(np.int32).get(), a_np.astype(np.int32))
d = cla.to_device(q, a_np.astype(np.float64)); chk('double', (d * d).get(), a_np.astype(np.float64) ** 2)
i = cla.to_device(q, np.arange(10, dtype=np.int64)); chk('int64', (i * i + 1).get(), np.arange(10) ** 2 + 1)
z = cla.zeros(q, 8, np.float32); z.fill(3.5); chk('zeros/fill', z.get(), np.full(8, 3.5))
from pyopencl.elementwise import ElementwiseKernel   # 官方文件的 ElementwiseKernel 範例
lin = ElementwiseKernel(ctx, 'float a, float *x, float b, float *y, float *z', 'z[i] = a*x[i] + b*y[i]', 'lin_comb')
r = cla.empty_like(a); lin(2, a, 3, b, r); chk('lin_comb', r.get(), 2 * a_np + 3 * b_np)
big = cla.to_device(q, np.random.RandomState(0).rand(100003).astype(np.float32)); chk('大陣列', (big * 2 + big).get(), big.get() * 3)   # 長度不是工作群大小的倍數
print('ARRAY OK')
""", drivers="clc")
    assert rc == 0 and "ARRAY OK" in out, "rc=%s\n%s\n%s" % (rc, out[-300:], err[-1800:])


GL_SNIPPET = """
import numpy as np, importlib.util
if importlib.util.find_spec('OpenGL') is None:
    print('GL SKIP'); raise SystemExit(0)
import fa_opengl_platform as P
assert P.register()
class Store(object):   # 最小的假 GL 後端：緩衝區存在記憶體，並記錄從「GPU」讀回與寫入的次數
    def __init__(self): self.n = 0; self.bufs = {}; self.cur = {}; self.reads = 0; self.writes = 0
    def create_buffer(self): self.n += 1; h = 'buf%d' % self.n; self.bufs[h] = bytearray(); return h
    def delete_buffer(self, h): self.bufs.pop(h, None)
    def bind_buffer(self, t, h): self.cur[t] = h
    def buffer_data(self, t, data, usage): self.bufs[self.cur[t]] = bytearray(data if not isinstance(data, int) else data)
    def buffer_sub_data(self, t, off, data): self.bufs[self.cur[t]][off:off + len(data)] = data
    def read_buffer(self, h, off, size): self.reads += 1; return bytes(self.bufs[h][off:off + size])
    def write_buffer(self, h, off, data): self.writes += 1; self.bufs[h][off:off + len(data)] = data
    def __getattr__(self, n): return lambda *a, **k: None
store = Store(); P.create_context(64, 64, backend=store)
from OpenGL.GL import *
import fa_pyopencl; fa_pyopencl.install()   # 安裝期鉤子（Pyodide 裡由 fa_bridge.install_hooks 呼叫）：get_gl_sharing_context_properties 改用我們的 GL 上下文回應
import pyopencl as cl
from pyopencl.tools import get_gl_sharing_context_properties   # 官方互通範例的寫法：在 import 時就綁定，所以替換要在 pyopencl.tools 載入完成之後、不管誰先 import
vbo = int(glGenBuffers(1)); glBindBuffer(GL_ARRAY_BUFFER, vbo)
pos = np.arange(16, dtype=np.float32); glBufferData(GL_ARRAY_BUFFER, pos.nbytes, pos, GL_DYNAMIC_DRAW)
def gl_read():   # PyOpenGL 的 glGetBufferSubData 自己配一個 uint8 陣列並回傳（不是寫進呼叫者傳的陣列）
    glBindBuffer(GL_ARRAY_BUFFER, vbo); return np.frombuffer(glGetBufferSubData(GL_ARRAY_BUFFER, 0, 64).tobytes(), dtype=np.float32).copy()
plat = cl.get_platforms()[0]; dev = plat.get_devices()[0]
props = get_gl_sharing_context_properties()
assert [k for k, v in props] == [cl.context_properties.GL_CONTEXT_KHR, cl.context_properties.EGL_DISPLAY_KHR] and props[0][1] != 0, props
ctx = cl.Context(properties=[(cl.context_properties.PLATFORM, plat)] + props, devices=[dev]); q = cl.CommandQueue(ctx)   # 官方互通範例的寫法
assert ctx.properties[0] == cl.context_properties.PLATFORM and cl.context_properties.GL_CONTEXT_KHR in ctx.properties
glbuf = cl.GLBuffer(ctx, cl.mem_flags.READ_WRITE, vbo)
assert cl.have_gl() and glbuf.get_gl_object_info() == (cl.gl_object_type.BUFFER, vbo) and glbuf.size == 64
prg = cl.Program(ctx, 'kernel void scale(global float* p, float s) { int i = get_global_id(0); p[i] = p[i] * s; }').build()
# 5 幀：acquire → 核心 → release。GL 內容只在第一次 acquire 讀進 CL，之後只有 CL 寫過才寫回 GL
expect = pos.copy()
for frame in range(5):
    cl.enqueue_acquire_gl_objects(q, [glbuf]); prg.scale(q, (16,), None, glbuf, np.float32(2)); cl.enqueue_release_gl_objects(q, [glbuf]); expect *= 2
q.finish()
assert np.array_equal(gl_read(), expect), (gl_read(), expect)
reads_after, writes_after = store.reads, store.writes
assert reads_after == 1 + 1, (store.reads, '5 幀只有第一次 acquire 讀 GL（另 1 次是上面 gl_read 驗證用）')
assert writes_after == 5, store.writes
# acquire 之後什麼都不做就 release：CL 沒寫過，不寫回
cl.enqueue_acquire_gl_objects(q, [glbuf]); cl.enqueue_release_gl_objects(q, [glbuf])
assert store.writes == 5, store.writes
# 使用者在 GL 端直接改內容（glBufferSubData）：下一次 acquire 必須讀進來，核心看到新資料
new = np.full(4, 100, dtype=np.float32); glBindBuffer(GL_ARRAY_BUFFER, vbo); glBufferSubData(GL_ARRAY_BUFFER, 0, new.nbytes, new)
r0 = store.reads
cl.enqueue_acquire_gl_objects(q, [glbuf]); prg.scale(q, (16,), None, glbuf, np.float32(0.5)); cl.enqueue_release_gl_objects(q, [glbuf]); q.finish()
assert store.reads == r0 + 1
got = gl_read(); expect2 = expect.copy(); expect2[:4] = 100; expect2 *= 0.5
assert np.array_equal(got, expect2), (got, expect2)
# 錯誤：不存在的 GL 緩衝區、重複 acquire、沒 acquire 就 release、GL 端重新指定大小、非 GLBuffer、緩衝區被刪
def raises(cls, f, name):
    try: f()
    except cl.Error as e:
        assert isinstance(e, cls) and e.code == getattr(cl.status_code, name), (type(e), e.code, name, e); return
    raise AssertionError('沒有丟 ' + name)
raises(cl.LogicError, lambda: cl.Context(properties=[(cl.context_properties.GL_CONTEXT_KHR, 12345)], devices=[dev]), 'INVALID_GL_SHAREGROUP_REFERENCE_KHR')   # 不是目前的 GL 上下文
raises(cl.LogicError, lambda: cl.Context(properties=[(0x9999, 1)], devices=[dev]), 'INVALID_PROPERTY')
raises(cl.LogicError, lambda: cl.GLBuffer(ctx, cl.mem_flags.READ_WRITE, 9999), 'INVALID_GL_OBJECT')
empty = int(glGenBuffers(1)); raises(cl.LogicError, lambda: cl.GLBuffer(ctx, cl.mem_flags.READ_WRITE, empty), 'INVALID_GL_OBJECT')
raises(cl.LogicError, lambda: cl.enqueue_release_gl_objects(q, [glbuf]), 'INVALID_OPERATION')
cl.enqueue_acquire_gl_objects(q, [glbuf]); raises(cl.LogicError, lambda: cl.enqueue_acquire_gl_objects(q, [glbuf]), 'INVALID_OPERATION'); cl.enqueue_release_gl_objects(q, [glbuf])
raises(cl.LogicError, lambda: cl.enqueue_acquire_gl_objects(q, [cl.Buffer(ctx, cl.mem_flags.READ_WRITE, 16)]), 'INVALID_GL_OBJECT')
glBindBuffer(GL_ARRAY_BUFFER, vbo); big = np.zeros(32, dtype=np.float32); glBufferData(GL_ARRAY_BUFFER, big.nbytes, big, GL_DYNAMIC_DRAW)
raises(cl.LogicError, lambda: cl.enqueue_acquire_gl_objects(q, [glbuf]), 'INVALID_GL_OBJECT')
glDeleteBuffers(1, [vbo]); raises(cl.LogicError, lambda: cl.enqueue_acquire_gl_objects(q, [glbuf]), 'INVALID_GL_OBJECT')
print('GL INTEROP OK')
"""


def gl_interop():
    rc, out, err = run(None, GL_SNIPPET, drivers="clc")
    if "GL SKIP" in out:
        print("略過 GL 互通測試：沒有安裝 PyOpenGL")
        return
    assert rc == 0 and "GL INTEROP OK" in out, "rc=%s\n%s\n%s" % (rc, out[-300:], err[-2000:])


def array_reduction():
    rc, out, err = run(None, """
import numpy as np, pyopencl as cl, pyopencl.array as cla
ctx = cl.create_some_context(); q = cl.CommandQueue(ctx); rs = np.random.RandomState(1)
def close(name, got, want, rt=1e-4): assert np.allclose(got, want, rtol=rt), (name, got, want)
for n in (1, 7, 64, 1000, 100003):   # 長度不是工作群大小的倍數、只有 1 個元素、跨多個工作群
    x = rs.rand(n).astype(np.float32); close('sum %d' % n, cla.sum(cla.to_device(q, x)).get(), x.sum())
x = rs.rand(5000).astype(np.float32) * 10 - 5; y = rs.rand(5000).astype(np.float32); a = cla.to_device(q, x); b = cla.to_device(q, y)
close('max', cla.max(a).get(), x.max()); close('min', cla.min(a).get(), x.min()); close('dot', cla.dot(a, b).get(), np.dot(x, y), 1e-3)
close('double', cla.sum(cla.to_device(q, x.astype(np.float64))).get(), x.astype(np.float64).sum(), 1e-9)
assert int(cla.sum(cla.to_device(q, np.arange(1000, dtype=np.int32))).get()) == 499500
from pyopencl.reduction import ReductionKernel   # 官方文件的 dot 範例
krnl = ReductionKernel(ctx, np.float32, neutral='0', reduce_expr='a+b', map_expr='x[i]*y[i]', arguments='__global float *x, __global float *y')
close('ReductionKernel', krnl(a, b).get(), np.dot(x, y), 1e-3)
# 前綴和（scan）：核心用 struct、二維 __local 陣列、barrier
for n in (1, 10, 64, 1000, 5000):
    xs = rs.rand(n).astype(np.float32); assert np.allclose(cla.cumsum(cla.to_device(q, xs)).get(), np.cumsum(xs.astype(np.float64)), rtol=1e-3, atol=1e-2), n
xi = rs.randint(0, 5, 1000).astype(np.int32); assert np.array_equal(cla.cumsum(cla.to_device(q, xi)).get(), np.cumsum(xi))
# 其餘常用的陣列操作
close('maximum', cla.maximum(a, b).get(), np.maximum(x, y)); close('if_positive', cla.if_positive(a > 0, a, b).get(), np.where(x > 0, x, y))
close('arange', cla.arange(q, 10, dtype=np.float32).get(), np.arange(10)); close('切片視圖', a[2:5].get(), x[2:5])
m = cla.to_device(q, x[:12].reshape(3, 4)); close('轉置（F 連續的接收陣列）', m.T.get(), x[:12].reshape(3, 4).T)
import pyopencl.clmath as clmath; close('clmath.sin', clmath.sin(a).get(), np.sin(x), 1e-4)
print('REDUCTION OK')
""", drivers="clc")
    assert rc == 0 and "REDUCTION OK" in out, "rc=%s\n%s\n%s" % (rc, out[-300:], err[-1800:])


def array_complex_vector():
    rc, out, err = run(None, """
import numpy as np, pyopencl as cl, pyopencl.array as cla, pyopencl.clmath as clm, pyopencl.cltypes as ct
ctx = cl.create_some_context(); q = cl.CommandQueue(ctx); rs = np.random.RandomState(3)
a = (rs.rand(50) + 1j * rs.rand(50)).astype(np.complex64); b = (rs.rand(50) + 1j * rs.rand(50)).astype(np.complex64)
A, B = cla.to_device(q, a), cla.to_device(q, b)
def close(name, got, want, rt=1e-4): assert np.allclose(got, want, rtol=rt, atol=1e-6), (name, got, want)
close('a+b', (A + B).get(), a + b); close('a*b', (A * B).get(), a * b); close('a/b', (A / B).get(), a / b); close('a*scalar', (A * (2 + 1j)).get(), a * (2 + 1j))
close('conj', A.conj().get(), a.conj()); close('real', A.real.get(), a.real); close('imag', A.imag.get(), a.imag); close('abs', abs(A).get(), np.abs(a)); close('sum', cla.sum(A).get(), a.sum())
close('exp', clm.exp(A).get(), np.exp(a))
close('complex128', (cla.to_device(q, a.astype(np.complex128)) * cla.to_device(q, b.astype(np.complex128))).get(), (a * b).astype(np.complex128), 1e-9)
v = np.zeros(8, dtype=ct.float4); v['x'] = np.arange(8); v['w'] = 1; assert np.array_equal(cla.to_device(q, v).get(), v)
prg = cl.Program(ctx, 'kernel void k(global float4* o, float4 s) { int i = get_global_id(0); o[i] = s * (float)i; }').build()
o = cla.empty(q, 4, dtype=ct.float4); prg.k(q, (4,), None, o.data, ct.make_float4(1, 2, 3, 4)); r = o.get()
assert np.allclose([r['x'][3], r['y'][3], r['z'][3], r['w'][3]], [3, 6, 9, 12])
# 子緩衝區（經真 layer 的 Buffer 切片）
buf = cl.Buffer(ctx, cl.mem_flags.READ_WRITE | cl.mem_flags.COPY_HOST_PTR, hostbuf=np.arange(16, dtype=np.float32)); sub = buf[16:48]; host = np.empty(8, dtype=np.float32); cl.enqueue_copy(q, host, sub); assert host.tolist() == [4, 5, 6, 7, 8, 9, 10, 11]
print('COMPLEX OK')
""", drivers="clc")
    assert rc == 0 and "COMPLEX OK" in out, "rc=%s\n%s\n%s" % (rc, out[-300:], err[-1800:])


t("官方 vector add 範例原封不動（跑兩次：寫入並命中 pyopencl 的編譯快取）", official_twice)
t("真 layer 的 API：屬性、build 錯誤格式、status_code／mem_flags.to_string、事件計時、MemoryPool 重用", api_through_real_layer)
t("pyopencl.array 複數（complex64／complex128：四則、共軛、實虛部、abs、sum、exp）、向量 dtype（cltypes.float4）與 float4 純量參數、子緩衝區", array_complex_vector)
t("pyopencl.array 歸約（__local＋barrier）：sum（多種長度）、max、min、dot、double、int32、官方 ReductionKernel、前綴和 cumsum（struct＋二維 __local）、maximum、if_positive、arange、切片、轉置、clmath.sin", array_reduction)
t("pyopencl.array 逐元素運算（真 layer＋clc 驅動）：四則、標量、取負、abs、比較、astype、float64、int64、fill、ElementwiseKernel、大陣列；", array_elementwise)
t("PyOpenGL 互通：真 PyOpenGL＋fa 平台 ↔ 真 pyopencl（GLBuffer、acquire／release；多幀只讀 GL 一次、CL 沒寫就不寫回、GL 端改動被看到、錯誤碼）", gl_interop)
shutil.rmtree(tmp, ignore_errors=True)
print("%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
