# -*- coding: utf-8 -*-
# 產生 ../gpgpu/nbody3d_cl.ll：nbody3d 的 OpenCL 版（DESIGN.webgpu-cuda.md §13 階段 5、階段 6 步驟 1b）。
# 做法：沿用 _gen_nbody3d.py（同一份物理與畫面，單一來源），只換掉 step：step 呼叫 accel_cl()，整個物理步留在裝置上：
#   1. 加速度：accx／accy／accz／accpot（4 個核心，各寫一個輸出，因為一個核心只能寫一個緩衝區）→ ax、ay、az、pot
#   2. 速度：kvx／kvy／kvz：vx' = vx + ax·dt（寫到下一組緩衝區）
#   3. 位置：kpx／kpy／kpz：x' = x + clampf(vx', 1, vmax)·dt（與 C 的 clampf 同一順序：先看上限、再看下限，超過就移回一半）
#   4. 讀回：x'、y'、z'（畫面與 cluster 用）與 pot（cluster 用）→ 主機陣列。速度 vx 留在裝置上，從不讀回。
#   x、y、z、vx、vy、vz 各有兩個緩衝區（ping-pong）：@cl_st[2] 記目前用哪一組，每幀結束交換。
#   主機陣列只在「重設」（init_bodies 之後）上傳：cl_reset() 設旗標，accel_cl 在下一幀開頭整組上傳。
# 用法：python3 _gen_nbody3d_cl.py   （輸出 ../gpgpu/nbody3d_cl.ll）
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_PATH = os.path.join(HERE, '_gen_nbody3d.py')
OUT = os.path.join(HERE, '..', 'gpgpu', 'nbody3d_cl.ll')


# ---- 核心（OpenCL C 子集）
def acc_kernel(comp):
    """comp＝'x'、'y'、'z'：加速度分量；'pot'：位能。"""
    if comp == 'pot':
        return (
            '__kernel void accpot(__global const float* x, __global const float* y, __global const float* z, __global const float* ms, __global float* pot, int n, float G, float e2) {\n'
            '  int i = get_global_id(0);\n'
            '  float xi = x[i]; float yi = y[i]; float zi = z[i];\n'
            '  float p = 0.0f;\n'
            '  for (int j = 0; j < n; j++) {\n'
            '    if (j != i) {\n'
            '      float dx = x[j] - xi; float dy = y[j] - yi; float dz = z[j] - zi;\n'
            '      float inv = 1.0f / sqrt(dx * dx + dy * dy + dz * dz + e2);\n'
            '      p += ms[j] * inv;\n'
            '    }\n'
            '  }\n'
            '  pot[i] = p;\n'
            '}\n')
    return (
        '__kernel void acc%(c)s(__global const float* x, __global const float* y, __global const float* z, __global const float* ms, __global float* a%(c)s, int n, float G, float e2) {\n'
        '  int i = get_global_id(0);\n'
        '  float xi = x[i]; float yi = y[i]; float zi = z[i];\n'
        '  float a = 0.0f;\n'
        '  for (int j = 0; j < n; j++) {\n'
        '    if (j != i) {\n'
        '      float dx = x[j] - xi; float dy = y[j] - yi; float dz = z[j] - zi;\n'
        '      float inv = 1.0f / sqrt(dx * dx + dy * dy + dz * dz + e2);\n'
        '      float s = G * ms[j] * inv * inv * inv;\n'
        '      a += s * d%(c)s;\n'
        '    }\n'
        '  }\n'
        '  a%(c)s[i] = a;\n'
        '}\n') % {'c': comp}


def vel_kernel(c):
    return ('__kernel void kv%(c)s(__global const float* v%(c)s, __global const float* a%(c)s, __global float* ov%(c)s, int n, float dt) {\n'
            '  int i = get_global_id(0);\n'
            '  ov%(c)s[i] = v%(c)s[i] + a%(c)s[i] * dt;\n'
            '}\n') % {'c': c}


def pos_kernel(c):
    # clampf(v, 1, vmax)：先看上限（超過就 (v+hi)/2），再看下限（低於就 (v+lo)/2）；與 _gen_nbody3d.py 的 clampf 同一順序
    return ('__kernel void kp%(c)s(__global const float* %(c)s, __global const float* v%(c)s, __global float* o%(c)s, int n, float dt, float vmax) {\n'
            '  int i = get_global_id(0);\n'
            '  float cv = v%(c)s[i];\n'
            '  if (cv > vmax) { cv = (cv + vmax) * 0.5f; }\n'
            '  if (cv < 1.0f) { cv = (cv + 1.0f) * 0.5f; }\n'
            '  o%(c)s[i] = %(c)s[i] + cv * dt;\n'
            '}\n') % {'c': c}


KNAMES = ['accx', 'accy', 'accz', 'accpot', 'kvx', 'kvy', 'kvz', 'kpx', 'kpy', 'kpz']
SRC_ALL = '\n'.join([acc_kernel('x'), acc_kernel('y'), acc_kernel('z'), acc_kernel('pot'),
                     vel_kernel('x'), vel_kernel('y'), vel_kernel('z'),
                     pos_kernel('x'), pos_kernel('y'), pos_kernel('z')])

# 句柄槽（@cl_h，40 個）：0 ctx、1 queue、2 prog、3..12 核心（KNAMES 順序）、13 ms、14..16 ax/ay/az、17 pot、
# 18..29：x、y、z、vx、vy、vz 各兩個（ping-pong）
SL = {'ctx': 0, 'q': 1, 'prog': 2, 'ms': 13, 'ax': 14, 'ay': 15, 'az': 16, 'pot': 17}
for _i, _k in enumerate(KNAMES):
    SL[_k] = 3 + _i
PAIR = {'x': 18, 'y': 20, 'z': 22, 'vx': 24, 'vy': 26, 'vz': 28}   # PAIR[名]＋0 或＋1
FLAG_RW = 1


def glue_ir():
    """accel_setup、cl_reset、accel_cl 的 IR 文字（全域與宣告在 INJECT 加入）。"""
    L = []
    A = L.append
    cnt = [0]

    def tmp(p='t'):
        cnt[0] += 1
        return '%%%s%d' % (p, cnt[0])

    def static_slot(idx, name=None):
        t = '%' + name if name else tmp('sl')
        A('  %s = getelementptr ptr, ptr @cl_h, i32 %d' % (t, idx))
        return t

    def dyn_slot(base, p_ssa):
        # 位址＝@cl_h[base + p]（p 是 i32 的 SSA 值）
        t1, t2 = tmp('di'), tmp('ds')
        A('  %s = add i32 %s, %d' % (t1, p_ssa, base))
        A('  %s = getelementptr ptr, ptr @cl_h, i32 %s' % (t2, t1))
        return t2

    def load_handle(slot_addr):
        t = tmp('h')
        A('  %s = load ptr, ptr %s' % (t, slot_addr))
        return t

    # ---- accel_setup(i32 n)
    A('define void @accel_setup(i32 %n) {')
    A('entry:')
    A('  %plat = alloca ptr'); A('  %dev = alloca ptr'); A('  %rc = alloca i32'); A('  %srcp = alloca ptr')
    A('  %n64 = sext i32 %n to i64'); A('  %bytes = mul i64 %n64, 4')
    A('  store ptr @cl_src, ptr %srcp')
    A('  %r1 = call i32 @clGetPlatformIDs(i32 1, ptr %plat, ptr null)')
    A('  %p = load ptr, ptr %plat')
    A('  %r2 = call i32 @clGetDeviceIDs(ptr %p, i64 4, i32 1, ptr %dev, ptr null)')
    A('  %e2 = icmp ne i32 %r2, 0')
    A('  br i1 %e2, label %cpu, label %ctx')
    A('cpu:')
    A('  %r3 = call i32 @clGetDeviceIDs(ptr %p, i64 2, i32 1, ptr %dev, ptr null)')
    A('  br label %ctx')
    A('ctx:')
    A('  %d = load ptr, ptr %dev')
    A('  %c = call ptr @clCreateContext(ptr null, i32 1, ptr %dev, ptr null, ptr null, ptr %rc)')
    static_slot(SL['ctx'], 'hctx')
    A('  store ptr %c, ptr %hctx')
    A('  %q = call ptr @clCreateCommandQueue(ptr %c, ptr %d, i64 0, ptr %rc)')
    static_slot(SL['q'], 'hq')
    A('  store ptr %q, ptr %hq')
    A('  %prog = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %rc)')
    static_slot(SL['prog'], 'hprog')
    A('  store ptr %prog, ptr %hprog')
    A('  %rb = call i32 @clBuildProgram(ptr %prog, i32 1, ptr %dev, ptr null, ptr null, ptr null)')
    for k in KNAMES:
        A('  %%k_%s = call ptr @clCreateKernel(ptr %%prog, ptr @cl_n_%s, ptr %%rc)' % (k, k))
        static_slot(SL[k], 'hk_' + k)
        A('  store ptr %%k_%s, ptr %%hk_%s' % (k, k))
    bufs = [('ms', SL['ms']), ('ax', SL['ax']), ('ay', SL['ay']), ('az', SL['az']), ('pot', SL['pot'])]
    for name, base in PAIR.items():
        bufs += [(name + '0', base), (name + '1', base + 1)]
    for name, slot in bufs:
        A('  %%b_%s = call ptr @clCreateBuffer(ptr %%c, i64 %d, i64 %%bytes, ptr null, ptr %%rc)' % (name, FLAG_RW))
        static_slot(slot, 'hb_' + name)
        A('  store ptr %%b_%s, ptr %%hb_%s' % (name, name))
    A('  %sf = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 0'); A('  store i32 1, ptr %sf')
    A('  %sn = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 1'); A('  store i32 %n, ptr %sn')
    A('  %sp = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 2'); A('  store i32 0, ptr %sp')
    A('  ret void'); A('}'); A('')

    # ---- cl_reset()：下一幀整組上傳
    A('define void @cl_reset() {')
    A('entry:')
    A('  %sr = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 3'); A('  store i32 1, ptr %sr'); A('  ret void'); A('}'); A('')

    # ---- accel_cl(x,y,z,ms, vx,vy,vz, pot, G, e2, dt, vmax, n)
    A('define void @accel_cl(ptr %x, ptr %y, ptr %z, ptr %ms, ptr %vx, ptr %vy, ptr %vz, ptr %pot, float %G, float %e2, float %dt, float %vmax, i32 %n) {')
    A('entry:')
    A('  %g = alloca float'); A('  %ee = alloca float'); A('  %dtv = alloca float'); A('  %vmv = alloca float')
    A('  %nn = alloca i32'); A('  %gs = alloca i64')
    A('  %n64 = sext i32 %n to i64'); A('  %bytes = mul i64 %n64, 4')
    A('  %sf = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 0'); A('  %rdy = load i32, ptr %sf')
    A('  %z0 = icmp eq i32 %rdy, 0'); A('  br i1 %z0, label %setup, label %run')
    A('setup:'); A('  call void @accel_setup(i32 %n)'); A('  br label %run')
    A('run:')
    A('  store float %G, ptr %g'); A('  store float %e2, ptr %ee'); A('  store float %dt, ptr %dtv')
    A('  store float %vmax, ptr %vmv'); A('  store i32 %n, ptr %nn'); A('  store i64 %n64, ptr %gs')
    static_slot(SL['q'], 'hq'); A('  %q = load ptr, ptr %hq')
    A('  %spp = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 2'); A('  %p = load i32, ptr %spp')
    A('  %nx = sub i32 1, %p')
    A('  %srs = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 3'); A('  %rs = load i32, ptr %srs')
    A('  %needup = icmp ne i32 %rs, 0'); A('  br i1 %needup, label %upload, label %compute')
    A('upload:')
    for name, src in [('x', '%x'), ('y', '%y'), ('z', '%z'), ('vx', '%vx'), ('vy', '%vy'), ('vz', '%vz')]:
        h = load_handle(dyn_slot(PAIR[name], '%p'))
        A('  %%uw_%s = call i32 @clEnqueueWriteBuffer(ptr %%q, ptr %s, i32 1, i64 0, i64 %%bytes, ptr %s, i32 0, ptr null, ptr null)' % (name, h, src))
    h = load_handle(static_slot(SL['ms']))
    A('  %%uw_ms = call i32 @clEnqueueWriteBuffer(ptr %%q, ptr %s, i32 1, i64 0, i64 %%bytes, ptr %%ms, i32 0, ptr null, ptr null)' % h)
    A('  store i32 0, ptr %srs')
    A('  br label %compute')
    A('compute:')
    # 加速度：x,y,z,ms,out,n,G,e2
    for kname, out_slot in [('accx', SL['ax']), ('accy', SL['ay']), ('accz', SL['az']), ('accpot', SL['pot'])]:
        kh = load_handle(static_slot(SL[kname]))
        A('  %%ka_%s = call i32 @clSetKernelArg(ptr %s, i32 0, i64 8, ptr %s)' % (kname, kh, dyn_slot(PAIR['x'], '%p')))
        A('  %%kb_%s = call i32 @clSetKernelArg(ptr %s, i32 1, i64 8, ptr %s)' % (kname, kh, dyn_slot(PAIR['y'], '%p')))
        A('  %%kc_%s = call i32 @clSetKernelArg(ptr %s, i32 2, i64 8, ptr %s)' % (kname, kh, dyn_slot(PAIR['z'], '%p')))
        A('  %%kd_%s = call i32 @clSetKernelArg(ptr %s, i32 3, i64 8, ptr %s)' % (kname, kh, static_slot(SL['ms'])))
        A('  %%ke_%s = call i32 @clSetKernelArg(ptr %s, i32 4, i64 8, ptr %s)' % (kname, kh, static_slot(out_slot)))
        A('  %%kf_%s = call i32 @clSetKernelArg(ptr %s, i32 5, i64 4, ptr %%nn)' % (kname, kh))
        A('  %%kg_%s = call i32 @clSetKernelArg(ptr %s, i32 6, i64 4, ptr %%g)' % (kname, kh))
        A('  %%kh_%s = call i32 @clSetKernelArg(ptr %s, i32 7, i64 4, ptr %%ee)' % (kname, kh))
        A('  %%en_%s = call i32 @clEnqueueNDRangeKernel(ptr %%q, ptr %s, i32 1, ptr null, ptr %%gs, ptr null, i32 0, ptr null, ptr null)' % (kname, kh))
    # 速度：v（目前）, a, v（下一組）, n, dt
    for c_ in ['x', 'y', 'z']:
        kh = load_handle(static_slot(SL['kv' + c_]))
        A('  %%va_%s = call i32 @clSetKernelArg(ptr %s, i32 0, i64 8, ptr %s)' % (c_, kh, dyn_slot(PAIR['v' + c_], '%p')))
        A('  %%vb_%s = call i32 @clSetKernelArg(ptr %s, i32 1, i64 8, ptr %s)' % (c_, kh, static_slot(SL['a' + c_])))
        A('  %%vc_%s = call i32 @clSetKernelArg(ptr %s, i32 2, i64 8, ptr %s)' % (c_, kh, dyn_slot(PAIR['v' + c_], '%nx')))
        A('  %%vd_%s = call i32 @clSetKernelArg(ptr %s, i32 3, i64 4, ptr %%nn)' % (c_, kh))
        A('  %%ve_%s = call i32 @clSetKernelArg(ptr %s, i32 4, i64 4, ptr %%dtv)' % (c_, kh))
        A('  %%vn_%s = call i32 @clEnqueueNDRangeKernel(ptr %%q, ptr %s, i32 1, ptr null, ptr %%gs, ptr null, i32 0, ptr null, ptr null)' % (c_, kh))
    # 位置：x（目前）, v（下一組）, x（下一組）, n, dt, vmax
    for c_ in ['x', 'y', 'z']:
        kh = load_handle(static_slot(SL['kp' + c_]))
        A('  %%pa_%s = call i32 @clSetKernelArg(ptr %s, i32 0, i64 8, ptr %s)' % (c_, kh, dyn_slot(PAIR[c_], '%p')))
        A('  %%pb_%s = call i32 @clSetKernelArg(ptr %s, i32 1, i64 8, ptr %s)' % (c_, kh, dyn_slot(PAIR['v' + c_], '%nx')))
        A('  %%pc_%s = call i32 @clSetKernelArg(ptr %s, i32 2, i64 8, ptr %s)' % (c_, kh, dyn_slot(PAIR[c_], '%nx')))
        A('  %%pd_%s = call i32 @clSetKernelArg(ptr %s, i32 3, i64 4, ptr %%nn)' % (c_, kh))
        A('  %%pe_%s = call i32 @clSetKernelArg(ptr %s, i32 4, i64 4, ptr %%dtv)' % (c_, kh))
        A('  %%pf_%s = call i32 @clSetKernelArg(ptr %s, i32 5, i64 4, ptr %%vmv)' % (c_, kh))
        A('  %%pn_%s = call i32 @clEnqueueNDRangeKernel(ptr %%q, ptr %s, i32 1, ptr null, ptr %%gs, ptr null, i32 0, ptr null, ptr null)' % (c_, kh))
    # 讀回：pot，以及下一組的位置（阻塞）
    poth = load_handle(static_slot(SL['pot']))
    A('  %%rp = call i32 @clEnqueueReadBuffer(ptr %%q, ptr %s, i32 1, i64 0, i64 %%bytes, ptr %%pot, i32 0, ptr null, ptr null)' % poth)
    for c_, dst in [('x', '%x'), ('y', '%y'), ('z', '%z')]:
        h = load_handle(dyn_slot(PAIR[c_], '%nx'))
        A('  %%rr_%s = call i32 @clEnqueueReadBuffer(ptr %%q, ptr %s, i32 1, i64 0, i64 %%bytes, ptr %s, i32 0, ptr null, ptr null)' % (c_, h, dst))
    A('  %fin = call i32 @clFinish(ptr %q)')
    A('  store i32 %nx, ptr %spp')
    # 後端檢查：本幀若實際走 JS 墊片（fa_cl_backend＝2，不是 WebGL2），退回 CPU 並記下原因（HUD 會顯示）
    A('  %be = call i32 @fa_cl_backend()')
    A('  %isjs = icmp eq i32 %be, 2')
    A('  br i1 %isjs, label %fallback, label %okend')
    A('fallback:')
    A('  call void @cl_pull(ptr %x, ptr %y, ptr %z, ptr %vx, ptr %vy, ptr %vz)')
    A('  store i32 0, ptr @cl_mode')
    A('  store i32 1, ptr @cl_fb')
    A('  br label %okend')
    A('okend:')
    A('  ret void')
    A('}')
    A('')

    # ---- cl_fb()：1＝因為 GPU 後端不可用而自動退回 CPU
    A('define i32 @cl_fb() {')
    A('entry:')
    A('  %fv = load i32, ptr @cl_fb'); A('  ret i32 %fv'); A('}'); A('')

    # ---- cl_mode()：目前的計算來源（0＝CPU、1＝GPU）
    A('define i32 @cl_mode() {')
    A('entry:')
    A('  %mv = load i32, ptr @cl_mode'); A('  ret i32 %mv'); A('}'); A('')

    # ---- cl_pull(x,y,z,vx,vy,vz)：把裝置上最新的位置與速度讀回主機（切到 CPU 前呼叫；未初始化就什麼都不做）
    A('define void @cl_pull(ptr %x, ptr %y, ptr %z, ptr %vx, ptr %vy, ptr %vz) {')
    A('entry:')
    A('  %sf = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 0'); A('  %rdy = load i32, ptr %sf')
    A('  %ok = icmp ne i32 %rdy, 0'); A('  br i1 %ok, label %go, label %done')
    A('go:')
    A('  %sn = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 1'); A('  %nv = load i32, ptr %sn')
    A('  %n64 = sext i32 %nv to i64'); A('  %bytes = mul i64 %n64, 4')
    A('  %spp = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 2'); A('  %p = load i32, ptr %spp')
    A('  %hq = getelementptr ptr, ptr @cl_h, i32 1'); A('  %q = load ptr, ptr %hq')
    for name, dst in [('x', '%x'), ('y', '%y'), ('z', '%z'), ('vx', '%vx'), ('vy', '%vy'), ('vz', '%vz')]:
        h = load_handle(dyn_slot(PAIR[name], '%p'))
        A('  %%pr_%s = call i32 @clEnqueueReadBuffer(ptr %%q, ptr %s, i32 1, i64 0, i64 %%bytes, ptr %s, i32 0, ptr null, ptr null)' % (name, h, dst))
    A('  %pfin = call i32 @clFinish(ptr %q)')
    A('  br label %done')
    A('done:')
    A('  ret void'); A('}'); A('')

    # ---- cl_set_mode(m, x,y,z,vx,vy,vz)：切換計算來源。切到 GPU：下一幀整組上傳；切到 CPU：先讀回
    A('define void @cl_set_mode(i32 %m, ptr %x, ptr %y, ptr %z, ptr %vx, ptr %vy, ptr %vz) {')
    A('entry:')
    A('  %old = load i32, ptr @cl_mode'); A('  %same = icmp eq i32 %old, %m')
    A('  br i1 %same, label %fin, label %chg')
    A('chg:')
    A('  %isgpu = icmp ne i32 %m, 0'); A('  br i1 %isgpu, label %togpu, label %tocpu')
    A('togpu:')
    A('  %sr = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 3'); A('  store i32 1, ptr %sr'); A('  br label %setm')
    A('tocpu:')
    A('  call void @cl_pull(ptr %x, ptr %y, ptr %z, ptr %vx, ptr %vy, ptr %vz)'); A('  br label %setm')
    A('setm:')
    A('  store i32 %m, ptr @cl_mode'); A('  store i32 0, ptr @cl_fb'); A('  br label %fin')
    A('fin:')
    A('  ret void'); A('}'); A('')
    return '\n'.join(L) + '\n'


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
for _k in __KNAMES__:
    _kb = _k.encode('ascii') + b'\\0'
    m.globs.append('@cl_n_%s = private constant [%d x i8] c"%s"' % (_k, len(_kb), esc(_kb)))
m.globs.append('@cl_h = global [40 x ptr] zeroinitializer')
m.globs.append('@cl_st = global [4 x i32] [i32 0, i32 0, i32 0, i32 1]')
m.globs.append('@cl_mode = global i32 1')
m.globs.append('@cl_fb = global i32 0')
m.sigs['cl_fb'] = ('i32', [], False)
m.sigs['cl_mode'] = ('i32', [], False)
m.sigs['cl_set_mode'] = ('void', ['i32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], False)
m.sigs['accel_cl'] = ('void', ['ptr'] * 8 + ['float', 'float', 'float', 'float', 'i32'], False)
m.sigs['accel_setup'] = ('void', ['i32'], False)
m.sigs['cl_reset'] = ('void', [], False)
m.funcs.append(_RawFn(__GLUE__))

"""

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
declare i32 @clFinish(ptr)
declare i32 @fa_cl_backend()'''


def build():
    with open(SRC_PATH, encoding='utf-8') as fh:
        src = fh.read()
    # 1. 整個加速度＋積分（從加速度迴圈到 st.ret()）換成 accel_cl 呼叫；積分留在裝置上
    a = src.index("with st.loop(i, 0, n):\n    ax.set(0.0)")
    b = src.index("st.ret()\n\n# findClusterCenter")
    cpu_block = src[a:b]
    indented = ''.join(('    ' + ln) if ln.strip() else ln for ln in cpu_block.splitlines(True))
    src = (src[:a] + "mode = c('cl_mode')\n"
           "with st.if_(mode.ne(0)):\n"
           "    c('accel_cl', x, y, z, ms, vx, vy, vz, pot, gco, soft2, dt, par[3], n)\n"
           "with st.if_(mode.eq(0)):\n" + indented + src[b:])
    # 2. 每次重設（init_bodies）之後通知 accel_cl 下一幀整組上傳
    old_init = "c('init_bodies', X, Y, Z, VX, VY, VZ, MS, par, seed, n)"
    assert src.count(old_init) == 2, src.count(old_init)
    src = src.replace(old_init, old_init + "; c('cl_reset')")
    # 3. 膠水插在 step 之前
    glue = glue_ir()
    inject = (INJECT.replace('__DECLS__', repr(DECLS)).replace('__SRC__', repr(SRC_ALL))
              .replace('__KNAMES__', repr(KNAMES)).replace('__GLUE__', repr(glue)))
    marker = "st = m.fn('void', 'step'"
    assert src.count(marker) == 1
    src = src.replace(marker, inject + marker, 1)
    old_out = "'..', 'gpgpu', 'nbody3d.ll'"
    assert src.count(old_out) == 1
    src = src.replace(old_out, "'..', 'gpgpu', 'nbody3d_cl.ll'")
    old_hdr = "（由 _gen/_gen_nbody3d.py 產生）"
    assert src.count(old_hdr) == 1
    src = src.replace(old_hdr, "（OpenCL 版：整個物理步在裝置上，由 _gen/_gen_nbody3d_cl.py 產生）")
    return src


if __name__ == '__main__':
    code = build()
    g = {'__file__': SRC_PATH, '__name__': '__gen__', 'CL_VARIANT': True}
    exec(compile(code, SRC_PATH, 'exec'), g)
    print('wrote', os.path.normpath(OUT))
