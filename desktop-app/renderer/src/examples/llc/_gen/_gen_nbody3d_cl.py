# -*- coding: utf-8 -*-
# 產生 ../gpgpu/nbody3d_cl.ll：nbody3d 的 OpenCL 版（DESIGN.webgpu-cuda.md §13 階段 5）。
# 做法：沿用 _gen_nbody3d.py（同一份物理與畫面，單一來源），只把 step 裡 O(N²) 的加速度迴圈換成 accel_cl()：
#   accel_cl 第一次呼叫時建立 OpenCL 平台／裝置（GPU 優先，沒有就 CPU）／context／queue／program／4 個核心／緩衝區，
#   之後每幀：寫入 x,y,z,ms → 執行 4 個核心（ax、ay、az、pot 各一個，因為 KIR 一個核心只能寫一個輸出）→ 讀回。
#   積分（速度、位置、clampf）仍在 IR 裡，跟 CPU 版一樣。
# 核心原始碼（OpenCL C，一維 gid＝i）放在 @cl_src；tests 用 renderer/src/uml/nbody3d_cl.test.js 從產生的 .ll 讀出來驗證。
# 在模擬環境：OpenCL 由 renderer/src/uml/llvm_host.js 提供（有 WebGL2 時走 KIR→GLSL，否則 JS 後備）。
# 用法：python3 _gen_nbody3d_cl.py   （輸出 ../gpgpu/nbody3d_cl.ll）
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_PATH = os.path.join(HERE, '_gen_nbody3d.py')
OUT = os.path.join(HERE, '..', 'gpgpu', 'nbody3d_cl.ll')

# ---- OpenCL C 核心原始碼（子集：一維 gid、for、if（沒有 else）、float 區域變數、+=、sqrt、一個 __global 輸出）
def kernel_src(name, term):
    if name == 'pot':
        acc, init, body = 'p', 'float p = 0.0f;', 'p += ms[j] * inv;'
        store = 'pot[i] = p;'
    else:
        comp = name[-1]   # x, y, z
        acc = 'a'
        init = 'float a = 0.0f;'
        body = 'a += s * d%s;' % comp
        store = 'a%s[i] = a;' % comp
    outname = 'pot' if name == 'pot' else 'a' + name[-1]
    return (
        '__kernel void acc%s(__global const float* x, __global const float* y, __global const float* z, __global const float* ms, __global float* %s, int n, float G, float e2) {\n'
        '  int i = get_global_id(0);\n'
        '  float xi = x[i]; float yi = y[i]; float zi = z[i];\n'
        '  %s\n'
        '  for (int j = 0; j < n; j++) {\n'
        '    if (j != i) {\n'
        '      float dx = x[j] - xi; float dy = y[j] - yi; float dz = z[j] - zi;\n'
        '      float inv = 1.0f / sqrt(dx * dx + dy * dy + dz * dz + e2);\n'
        '      float s = G * ms[j] * inv * inv * inv;\n'
        '      %s\n'
        '    }\n'
        '  }\n'
        '  %s\n'
        '}\n') % (name if name != 'pot' else 'pot', outname, init, body, store)

KERNELS = ['x', 'y', 'z', 'pot']   # 名稱：accx、accy、accz、accpot


def kname(k):
    return 'accpot' if k == 'pot' else 'acc' + k


def kernel_source():
    parts = []
    for k in KERNELS:
        parts.append(kernel_src(k, ''))
    return '\n'.join(parts)


def glue_ir():
    """回傳要插在 step 之前的 IR 文字（全域、宣告、accel_setup、accel_cl）。"""
    src = kernel_source().encode('utf-8') + b'\0'
    # 全域狀態：@cl_h 是 16 個 handle 的槽：0 ctx,1 queue,2 prog,3 kx,4 ky,5 kz,6 kp,7 bx,8 by,9 bz,10 bm,11 bax,12 bay,13 baz,14 bpot
    # @cl_st：0 已初始化、1 n
    lines = []
    L = lines.append
    # 全域（@cl_h、@cl_st、@cl_src、@cl_n_*）由 INJECT 加入 m.globs，這裡只產生函式
    slot = lambda i: 'getelementptr ptr, ptr @cl_h, i32 %d' % i
    # ---- accel_setup(n)
    L('define void @accel_setup(i32 %n) {')
    L('entry:')
    L('  %plat = alloca ptr')
    L('  %dev = alloca ptr')
    L('  %rc = alloca i32')
    L('  %srcp = alloca ptr')
    L('  %n64 = sext i32 %n to i64')
    L('  %bytes = mul i64 %n64, 4')
    L('  store ptr @cl_src, ptr %srcp')
    L('  %r1 = call i32 @clGetPlatformIDs(i32 1, ptr %plat, ptr null)')
    L('  %p = load ptr, ptr %plat')
    L('  %r2 = call i32 @clGetDeviceIDs(ptr %p, i64 4, i32 1, ptr %dev, ptr null)')
    L('  %e2 = icmp ne i32 %r2, 0')
    L('  br i1 %e2, label %cpu, label %ctx')
    L('cpu:')
    L('  %r3 = call i32 @clGetDeviceIDs(ptr %p, i64 2, i32 1, ptr %dev, ptr null)')
    L('  br label %ctx')
    L('ctx:')
    L('  %d = load ptr, ptr %dev')
    L('  %c = call ptr @clCreateContext(ptr null, i32 1, ptr %dev, ptr null, ptr null, ptr %rc)')
    L('  %%hc = %s' % slot(0))
    L('  store ptr %c, ptr %hc')
    L('  %q = call ptr @clCreateCommandQueue(ptr %c, ptr %d, i64 0, ptr %rc)')
    L('  %%hq = %s' % slot(1))
    L('  store ptr %q, ptr %hq')
    L('  %prog = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %rc)')
    L('  %%hp = %s' % slot(2))
    L('  store ptr %prog, ptr %hp')
    L('  %rb = call i32 @clBuildProgram(ptr %prog, i32 1, ptr %dev, ptr null, ptr null, ptr null)')
    for idx, k in zip([3, 4, 5, 6], KERNELS):
        L('  %%k%s = call ptr @clCreateKernel(ptr %%prog, ptr @cl_n_%s, ptr %%rc)' % (k, k))
        L('  %%h%s = %s' % (k, slot(idx)))
        L('  store ptr %%k%s, ptr %%h%s' % (k, k))
    # 緩衝區：輸入 READ_ONLY(4)，輸出 WRITE_ONLY(2)
    for idx, nm, flags in [(7, 'x', 4), (8, 'y', 4), (9, 'z', 4), (10, 'm', 4), (11, 'ax', 2), (12, 'ay', 2), (13, 'az', 2), (14, 'pot', 2)]:
        L('  %%b%s = call ptr @clCreateBuffer(ptr %%c, i64 %d, i64 %%bytes, ptr null, ptr %%rc)' % (nm, flags))
        L('  %%hb%s = %s' % (nm, slot(idx)))
        L('  store ptr %%b%s, ptr %%hb%s' % (nm, nm))
    L('  %sf = getelementptr [2 x i32], ptr @cl_st, i32 0, i32 0')
    L('  store i32 1, ptr %sf')
    L('  %sn = getelementptr [2 x i32], ptr @cl_st, i32 0, i32 1')
    L('  store i32 %n, ptr %sn')
    L('  ret void')
    L('}')
    L('')
    # ---- accel_cl(x,y,z,ms, ax,ay,az,pot, G, e2, n)
    L('define void @accel_cl(ptr %x, ptr %y, ptr %z, ptr %ms, ptr %ax, ptr %ay, ptr %az, ptr %pot, float %G, float %e2, i32 %n) {')
    L('entry:')
    L('  %g = alloca float')
    L('  %ee = alloca float')
    L('  %nn = alloca i32')
    L('  %gs = alloca i64')
    L('  %n64 = sext i32 %n to i64')
    L('  %bytes = mul i64 %n64, 4')
    L('  %sf = getelementptr [2 x i32], ptr @cl_st, i32 0, i32 0')
    L('  %rdy = load i32, ptr %sf')
    L('  %z0 = icmp eq i32 %rdy, 0')
    L('  br i1 %z0, label %setup, label %run')
    L('setup:')
    L('  call void @accel_setup(i32 %n)')
    L('  br label %run')
    L('run:')
    L('  store float %G, ptr %g')
    L('  store float %e2, ptr %ee')
    L('  store i32 %n, ptr %nn')
    L('  store i64 %n64, ptr %gs')
    L('  %%hq = %s' % slot(1))
    L('  %q = load ptr, ptr %hq')
    # 寫入輸入（阻塞）
    for idx, nm, src in [(7, 'x', 'x'), (8, 'y', 'y'), (9, 'z', 'z'), (10, 'm', 'ms')]:
        L('  %%hb%s = %s' % (nm, slot(idx)))
        L('  %%b%s = load ptr, ptr %%hb%s' % (nm, nm))
        L('  %%w%s = call i32 @clEnqueueWriteBuffer(ptr %%q, ptr %%b%s, i32 1, i64 0, i64 %%bytes, ptr %%%s, i32 0, ptr null, ptr null)' % (nm, nm, src))
    # 4 個核心：輸入 bx,by,bz,bm；輸出 bax,bay,baz,bpot
    outs = {'x': ('ax', 11), 'y': ('ay', 12), 'z': ('az', 13), 'pot': ('pot', 14)}
    for k in KERNELS:
        out_nm, out_idx = outs[k]
        kh = {'x': 3, 'y': 4, 'z': 5, 'pot': 6}[k]
        L('  %%hk%s = %s' % (k, slot(kh)))
        L('  %%k%s = load ptr, ptr %%hk%s' % (k, k))
        argmap = [(0, 7, 8, 'bx'), (1, 8, 8, 'by'), (2, 9, 8, 'bz'), (3, 10, 8, 'bm')]
        for ai, hidx, sz, nm in argmap:
            L('  %%a%s%d = %s' % (k, ai, slot(hidx)))
            L('  %%r%s%d = call i32 @clSetKernelArg(ptr %%k%s, i32 %d, i64 8, ptr %%a%s%d)' % (k, ai, k, ai, k, ai))
        L('  %%a%s4 = %s' % (k, slot(out_idx)))
        L('  %%r%s4 = call i32 @clSetKernelArg(ptr %%k%s, i32 4, i64 8, ptr %%a%s4)' % (k, k, k))
        L('  %%r%s5 = call i32 @clSetKernelArg(ptr %%k%s, i32 5, i64 4, ptr %%nn)' % (k, k))
        L('  %%r%s6 = call i32 @clSetKernelArg(ptr %%k%s, i32 6, i64 4, ptr %%g)' % (k, k))
        L('  %%r%s7 = call i32 @clSetKernelArg(ptr %%k%s, i32 7, i64 4, ptr %%ee)' % (k, k))
        L('  %%e%s = call i32 @clEnqueueNDRangeKernel(ptr %%q, ptr %%k%s, i32 1, ptr null, ptr %%gs, ptr null, i32 0, ptr null, ptr null)' % (k, k))
    # 讀回 ax, ay, az, pot（阻塞）
    for nm, dst in [('ax', 'ax'), ('ay', 'ay'), ('az', 'az'), ('pot', 'pot')]:
        L('  %%hr%s = %s' % (nm, slot(outs[{'ax': 'x', 'ay': 'y', 'az': 'z', 'pot': 'pot'}[nm]][1])))
        L('  %%br%s = load ptr, ptr %%hr%s' % (nm, nm))
        L('  %%rr%s = call i32 @clEnqueueReadBuffer(ptr %%q, ptr %%br%s, i32 1, i64 0, i64 %%bytes, ptr %%%s, i32 0, ptr null, ptr null)' % (nm, nm, dst))
    L('  call i32 @clFinish(ptr %q)')
    L('  ret void')
    L('}')
    L('')
    return '\n'.join(lines) + '\n'


DECLS = '''declare i32 @clGetPlatformIDs(i32, ptr, ptr)
declare i32 @clGetDeviceIDs(ptr, i64, i32, ptr, ptr)
declare ptr @clCreateContext(ptr, i32, ptr, ptr, ptr, ptr)
declare ptr @clCreateCommandQueue(ptr, ptr, i64, ptr)
declare ptr @clCreateProgramWithSource(ptr, i32, ptr, ptr, ptr)
declare i32 @clBuildProgram(ptr, i32, ptr, ptr, ptr, ptr)
declare ptr @clCreateKernel(ptr, ptr, ptr)
declare ptr @clCreateBuffer(ptr, i64, i64, ptr, ptr)
declare i32 @clSetKernelArg(ptr, i32, i64, ptr)
declare i32 @clEnqueueNDRangeKernel(ptr, ptr, i32, ptr, ptr, ptr, i32, ptr, ptr)
declare i32 @clEnqueueReadBuffer(ptr, ptr, i32, i64, i64, ptr, i32, ptr, ptr)
declare i32 @clEnqueueWriteBuffer(ptr, ptr, i32, i64, i64, ptr, i32, ptr, ptr)
declare i32 @clFinish(ptr)'''


INJECT = """# ---- OpenCL 膠水（由 _gen_nbody3d_cl.py 產生）
class _RawFn(object):
    def __init__(self, t): self.t = t
    def text(self): return self.t
for _line in __DECLS__.split('\\n'):
    _ret, _rest = _line[len('declare '):].split(' @', 1)
    _name, _ps = _rest.split('(', 1)
    m.decl(_ret, _name, *[p.strip() for p in _ps.rstrip(')').split(',')])
_cl_src = __SRC__.encode('utf-8') + b'\\0'
m.globs.append('@cl_src = private constant [%d x i8] c"%s"' % (len(_cl_src), esc(_cl_src)))
for _k in ['x', 'y', 'z', 'pot']:
    _kn = 'accpot' if _k == 'pot' else 'acc' + _k
    _kb = _kn.encode('ascii') + b'\\0'
    m.globs.append('@cl_n_%s = private constant [%d x i8] c"%s"' % (_k, len(_kb), esc(_kb)))
m.globs.append('@cl_h = global [16 x ptr] zeroinitializer')
m.globs.append('@cl_st = global [2 x i32] zeroinitializer')
m.sigs['accel_cl'] = ('void', ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'float', 'float', 'i32'], False)
m.funcs.append(_RawFn(__GLUE__))

"""


def build():
    with open(SRC_PATH, encoding='utf-8') as fh:
        src = fh.read()
    # 1. 整段加速度迴圈換成 accel_cl 呼叫（integration 迴圈保留）
    a = src.index("with st.loop(i, 0, n):\n    ax.set(0.0)")
    b = src.index("with st.loop(i, 0, n):\n    k = i.get()")
    src = src[:a] + "c('accel_cl', x, y, z, ms, sx, sy, sz, pot, gco, soft2, n)\n" + src[b:]
    # 2. OpenCL 膠水插在 step 之前（宣告、全域、核心原始碼、accel_setup／accel_cl 的 IR 文字）
    glue = glue_ir()   # 只含函式（全域已由 INJECT 加入）
    ksrc = kernel_source()
    inject = INJECT.replace('__DECLS__', repr(DECLS)).replace('__SRC__', repr(ksrc)).replace('__GLUE__', repr(glue))
    marker = "st = m.fn('void', 'step'"
    assert src.count(marker) == 1
    src = src.replace(marker, inject + marker, 1)
    # 3. 輸出檔名、標頭註解
    old_out = "'..', 'gpgpu', 'nbody3d.ll'"
    assert src.count(old_out) == 1
    src = src.replace(old_out, "'..', 'gpgpu', 'nbody3d_cl.ll'")
    old_hdr = "（由 _gen/_gen_nbody3d.py 產生）"
    assert src.count(old_hdr) == 1
    src = src.replace(old_hdr, "（OpenCL 版，由 _gen/_gen_nbody3d_cl.py 產生；加速度用 OpenCL 核心，積分與畫面同 CPU 版）")
    return src


if __name__ == '__main__':
    code = build()
    g = {'__file__': SRC_PATH, '__name__': '__gen__'}
    exec(compile(code, SRC_PATH, 'exec'), g)
    print('wrote', os.path.normpath(OUT))
