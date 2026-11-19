# -*- coding: utf-8 -*-
# 產生 ../gpgpu/fluid3d_cl.ll：fluid3d 的 OpenCL 版（DESIGN.webgpu-cuda.md §13 階段 5）。
# 做法：沿用 _gen_fluid3d.py（同一組常數與畫面，單一來源），只把 step 裡 O(N²) 的密度與力兩段換成 sph_gpu()：
#   step 先把 double 的位置／速度轉成 float 暫存陣列 → sph_gpu 寫入 GPU 緩衝區、執行 krho（密度）與 kfx／kfy／kfz（三個分量的力，
#   一個核心只能寫一個輸出），讀回 → 轉回 double 的 rho 與 acc。積分、畫面與 CPU 版相同。
# 精度：OpenCL 核心是 float32（CPU 版是 double），誤差在 tests（renderer/src/uml/fluid3d_cl.test.js）與真 Electron 量測。
# 壓力在核心裡由密度算（max(0,(ρ−ρ0)K)，跟 CPU 的 prs 陣列一樣），所以 step 不再需要 prs。
# 用法：python3 _gen_fluid3d_cl.py   （輸出 ../gpgpu/fluid3d_cl.ll）
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_PATH = os.path.join(HERE, '_gen_fluid3d.py')
OUT = os.path.join(HERE, '..', 'gpgpu', 'fluid3d_cl.ll')

# ---- OpenCL C 核心（子集：一維 gid、for、if（沒有 else）、float 區域變數、+=、sqrt）
KRHO = '''__kernel void krho(__global const float* x, __global const float* y, __global const float* z, __global float* rho, int n, float h2, float c0) {
  int i = get_global_id(0);
  float xi = x[i]; float yi = y[i]; float zi = z[i];
  float s = 0.0f;
  for (int j = 0; j < n; j++) {
    float dx = xi - x[j]; float dy = yi - y[j]; float dz = zi - z[j];
    float mm = h2 - (dx * dx + dy * dy + dz * dz);
    if (mm > 0.0f) {
      s += mm * mm * mm;
    }
  }
  rho[i] = s * c0;
}
'''


def kforce(c):
    # c＝'x'、'y'、'z'；y 分量多加重力 g
    grav = ' + g' if c == 'y' else ''
    return '''__kernel void kf%(c)s(__global const float* x, __global const float* y, __global const float* z, __global const float* vx, __global const float* vy, __global const float* vz, __global const float* rho, __global float* a%(c)s, int n, float h2, float h, float K, float rho0, float cs, float cv, float g) {
  int i = get_global_id(0);
  float xi = x[i]; float yi = y[i]; float zi = z[i]; float v%(c)si = v%(c)s[i];
  float rhoi = rho[i];
  float pi = (rhoi - rho0) * K;
  if (pi < 0.0f) { pi = 0.0f; }
  float f = 0.0f;
  for (int j = 0; j < n; j++) {
    float dx = xi - x[j]; float dy = yi - y[j]; float dz = zi - z[j];
    float r2 = dx * dx + dy * dy + dz * dz;
    if (r2 < h2) {
      if (r2 > 0.000000000001f) {
        float r = sqrt(r2);
        float w = h - r;
        float rhoj = rho[j];
        float pj = (rhoj - rho0) * K;
        if (pj < 0.0f) { pj = 0.0f; }
        float cp = ((pi + pj) / (rhoj * 2.0f)) * (w * w / r) * cs;
        float cvv = (w / rhoj) * cv;
        f += d%(c)s * cp + (v%(c)s[j] - v%(c)si) * cvv;
      }
    }
  }
  a%(c)s[i] = f * (1.0f / rhoi)%(grav)s;
}
''' % {'c': c, 'grav': grav}


KERNELS = ['krho', 'kfx', 'kfy', 'kfz']
SRC_ALL = KRHO + '\n' + kforce('x') + '\n' + kforce('y') + '\n' + kforce('z')

# 句柄槽（@sph_h，20 個）：0 ctx,1 q,2 prog,3 krho,4 kfx,5 kfy,6 kfz,7 bx,8 by,9 bz,10 bvx,11 bvy,12 bvz,13 brho,14 bax,15 bay,16 baz
SLOT = {'ctx': 0, 'q': 1, 'prog': 2, 'krho': 3, 'kfx': 4, 'kfy': 5, 'kfz': 6,
        'bx': 7, 'by': 8, 'bz': 9, 'bvx': 10, 'bvy': 11, 'bvz': 12, 'brho': 13, 'bax': 14, 'bay': 15, 'baz': 16}
# 緩衝區旗標：輸入 READ_ONLY(4)，rho READ_WRITE(1)，輸出 WRITE_ONLY(2)
FLAG = {'bx': 4, 'by': 4, 'bz': 4, 'bvx': 4, 'bvy': 4, 'bvz': 4, 'brho': 1, 'bax': 2, 'bay': 2, 'baz': 2}
# 參數 → 核心引數表（名稱, 種類：'b'＝緩衝區槽、'i'＝i32 純量、'f'＝float 純量）
KRHO_ARGS = [('b', 'bx'), ('b', 'by'), ('b', 'bz'), ('b', 'brho'), ('i', 'n'), ('f', 'h2'), ('f', 'c0')]
KF_ARGS = [('b', 'bx'), ('b', 'by'), ('b', 'bz'), ('b', 'bvx'), ('b', 'bvy'), ('b', 'bvz'), ('b', 'brho'), ('b', None),
           ('i', 'n'), ('f', 'h2'), ('f', 'h'), ('f', 'K'), ('f', 'rho0'), ('f', 'cs'), ('f', 'cv'), ('f', 'g')]
KF_OUT = {'kfx': 'bax', 'kfy': 'bay', 'kfz': 'baz'}


def esc_bytes(b):
    out = []
    for c in b:
        out.append(chr(c) if 32 <= c < 127 and c not in (34, 92) else '\\%02X' % c)
    return ''.join(out)


def _build_glue():
    # 重寫：比上面的版本簡單，直接逐行產生（避免暫名混亂）
    L = []
    A = L.append
    slot = lambda s: 'getelementptr ptr, ptr @sph_h, i32 %d' % SLOT[s]
    A('define void @sph_setup(i32 %n) {')
    A('entry:')
    A('  %plat = alloca ptr')
    A('  %dev = alloca ptr')
    A('  %rc = alloca i32')
    A('  %srcp = alloca ptr')
    A('  store ptr @sph_src, ptr %srcp')
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
    A('  %%hctx = %s' % slot('ctx'))
    A('  store ptr %c, ptr %hctx')
    A('  %q = call ptr @clCreateCommandQueue(ptr %c, ptr %d, i64 0, ptr %rc)')
    A('  %%hq = %s' % slot('q'))
    A('  store ptr %q, ptr %hq')
    A('  %prog = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %rc)')
    A('  %%hprog = %s' % slot('prog'))
    A('  store ptr %prog, ptr %hprog')
    A('  %rb = call i32 @clBuildProgram(ptr %prog, i32 1, ptr %dev, ptr null, ptr null, ptr null)')
    A('  %n64 = sext i32 %n to i64')
    A('  %bytes = mul i64 %n64, 4')
    for k in KERNELS:
        A('  %%k%s = call ptr @clCreateKernel(ptr %%prog, ptr @sph_n_%s, ptr %%rc)' % (k, k))
        A('  %%h%s = %s' % (k, slot(k)))
        A('  store ptr %%k%s, ptr %%h%s' % (k, k))
    for b in ['bx', 'by', 'bz', 'bvx', 'bvy', 'bvz', 'brho', 'bax', 'bay', 'baz']:
        A('  %%%s = call ptr @clCreateBuffer(ptr %%c, i64 %d, i64 %%bytes, ptr null, ptr %%rc)' % (b, FLAG[b]))
        A('  %%h%s = %s' % (b, slot(b)))
        A('  store ptr %%%s, ptr %%h%s' % (b, b))
    A('  %sf = getelementptr [2 x i32], ptr @sph_st, i32 0, i32 0')
    A('  store i32 1, ptr %sf')
    A('  ret void')
    A('}')
    A('')
    A('define void @sph_gpu(ptr %sx, ptr %sy, ptr %sz, ptr %svx, ptr %svy, ptr %svz, ptr %srho, ptr %sax, ptr %say, ptr %saz, i32 %n, float %h2, float %h, float %c0, float %K, float %rho0, float %cs, float %cv, float %g) {')
    A('entry:')
    A('  %gs = alloca i64')
    A('  %nn = alloca i32')
    A('  %pf = alloca [8 x float]')
    A('  %n64 = sext i32 %n to i64')
    A('  %bytes = mul i64 %n64, 4')
    A('  store i64 %n64, ptr %gs')
    A('  store i32 %n, ptr %nn')
    A('  %sf = getelementptr [2 x i32], ptr @sph_st, i32 0, i32 0')
    A('  %rdy = load i32, ptr %sf')
    A('  %z0 = icmp eq i32 %rdy, 0')
    A('  br i1 %z0, label %setup, label %run')
    A('setup:')
    A('  call void @sph_setup(i32 %n)')
    A('  br label %run')
    A('run:')
    scal = [('h2', '%h2', 0), ('h', '%h', 1), ('c0', '%c0', 2), ('K', '%K', 3), ('rho0', '%rho0', 4), ('cs', '%cs', 5), ('cv', '%cv', 6), ('g', '%g', 7)]
    for nm, pv, off in scal:
        A('  %%p_%s = getelementptr [8 x float], ptr %%pf, i32 0, i32 %d' % (nm, off))
        A('  store float %s, ptr %%p_%s' % (pv, nm))
    A('  %%hq = %s' % slot('q'))
    A('  %q = load ptr, ptr %hq')
    for b, src in [('bx', 'sx'), ('by', 'sy'), ('bz', 'sz'), ('bvx', 'svx'), ('bvy', 'svy'), ('bvz', 'svz')]:
        A('  %%hw_%s = %s' % (b, slot(b)))
        A('  %%bw_%s = load ptr, ptr %%hw_%s' % (b, b))
        A('  %%ew_%s = call i32 @clEnqueueWriteBuffer(ptr %%q, ptr %%bw_%s, i32 1, i64 0, i64 %%bytes, ptr %%%s, i32 0, ptr null, ptr null)' % (b, b, src))

    def kload(k):
        A('  %%hk_%s = %s' % (k, slot(k)))
        A('  %%kk_%s = load ptr, ptr %%hk_%s' % (k, k))

    def bindbuf(k, idx, bname):
        A('  %%hb_%s_%d = %s' % (k, idx, slot(bname)))
        A('  %%ar_%s_%d = call i32 @clSetKernelArg(ptr %%kk_%s, i32 %d, i64 8, ptr %%hb_%s_%d)' % (k, idx, k, idx, k, idx))

    def bindscal(k, idx, kind, name):
        if kind == 'i':
            A('  %%ar_%s_%d = call i32 @clSetKernelArg(ptr %%kk_%s, i32 %d, i64 4, ptr %%nn)' % (k, idx, k, idx))
        else:
            A('  %%ar_%s_%d = call i32 @clSetKernelArg(ptr %%kk_%s, i32 %d, i64 4, ptr %%p_%s)' % (k, idx, k, idx, name))

    # 密度核心
    kload('krho')
    bindbuf('krho', 0, 'bx'); bindbuf('krho', 1, 'by'); bindbuf('krho', 2, 'bz'); bindbuf('krho', 3, 'brho')
    A('  %ar_krho_4 = call i32 @clSetKernelArg(ptr %kk_krho, i32 4, i64 4, ptr %nn)')
    A('  %ar_krho_5 = call i32 @clSetKernelArg(ptr %kk_krho, i32 5, i64 4, ptr %p_h2)')
    A('  %ar_krho_6 = call i32 @clSetKernelArg(ptr %kk_krho, i32 6, i64 4, ptr %p_c0)')
    A('  %en_krho = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %kk_krho, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)')
    # 三個力核心
    for k in ['kfx', 'kfy', 'kfz']:
        kload(k)
        for idx, (kind, nm) in enumerate(KF_ARGS):
            if kind == 'b':
                if nm is None:
                    bindbuf(k, idx, KF_OUT[k])
                else:
                    bindbuf(k, idx, nm)
            elif kind == 'i':
                bindscal(k, idx, 'i', 'n')
            else:
                bindscal(k, idx, 'f', nm)
        A('  %%en_%s = call i32 @clEnqueueNDRangeKernel(ptr %%q, ptr %%kk_%s, i32 1, ptr null, ptr %%gs, ptr null, i32 0, ptr null, ptr null)' % (k, k))
    # 讀回：rho、ax、ay、az（阻塞）
    for b, dst in [('brho', 'srho'), ('bax', 'sax'), ('bay', 'say'), ('baz', 'saz')]:
        A('  %%hr_%s = %s' % (b, slot(b)))
        A('  %%br_%s = load ptr, ptr %%hr_%s' % (b, b))
        A('  %%rr_%s = call i32 @clEnqueueReadBuffer(ptr %%q, ptr %%br_%s, i32 1, i64 0, i64 %%bytes, ptr %%%s, i32 0, ptr null, ptr null)' % (b, b, dst))
    A('  call i32 @clFinish(ptr %q)')
    A('  ret void')
    A('}')
    A('')
    return '\n'.join(L) + '\n'


INJECT = """# ---- OpenCL 膠水（由 _gen_fluid3d_cl.py 產生）
class _RawFn(object):
    def __init__(self, t): self.t = t
    def text(self): return self.t
for _line in __DECLS__.split('\\n'):
    _ret, _rest = _line[len('declare '):].split(' @', 1)
    _name, _ps = _rest.split('(', 1)
    m.decl(_ret, _name, *[p.strip() for p in _ps.rstrip(')').split(',')])
_sph_src = __SRC__.encode('utf-8') + b'\\0'
m.globs.append('@sph_src = private constant [%d x i8] c"%s"' % (len(_sph_src), esc(_sph_src)))
for _k in __KERNELS__:
    _kb = _k.encode('ascii') + b'\\0'
    m.globs.append('@sph_n_%s = private constant [%d x i8] c"%s"' % (_k, len(_kb), esc(_kb)))
m.globs.append('@sph_h = global [20 x ptr] zeroinitializer')
m.globs.append('@sph_st = global [2 x i32] zeroinitializer')
m.sigs['sph_gpu'] = ('void', ['ptr'] * 10 + ['i32'] + ['float'] * 8, False)
m.sigs['sph_setup'] = ('void', ['i32'], False)
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


# step 裡換掉的段落：密度與力（兩個 O(N²) 迴圈）。替換成：DSL 把 double 轉 float 進暫存陣列 → sph_gpu → 轉回 double。
NEW_STEP = """sx, sy, sz = step.array('float', N), step.array('float', N), step.array('float', N)
svx, svy, svz = step.array('float', N), step.array('float', N), step.array('float', N)
srho, sax, say, saz = step.array('float', N), step.array('float', N), step.array('float', N), step.array('float', N)
with step.loop(i, 0, N):
    bi = i.get() * 3
    sx[i.get()] = pos[bi].to('float'); sy[i.get()] = pos[bi + 1].to('float'); sz[i.get()] = pos[bi + 2].to('float')
    svx[i.get()] = vel[bi].to('float'); svy[i.get()] = vel[bi + 1].to('float'); svz[i.get()] = vel[bi + 2].to('float')
c('sph_gpu', sx, sy, sz, svx, svy, svz, srho, sax, say, saz, N, H * H, H, MASS * POLY6, K, RHO0, -MASS * SPIKY, MU * MASS * VISC, G)
with step.loop(i, 0, N):
    bi = i.get() * 3
    rho[i.get()] = srho[i.get()].to('double')
    acc_[bi] = sax[i.get()].to('double'); acc_[bi + 1] = say[i.get()].to('double'); acc_[bi + 2] = saz[i.get()].to('double')
"""


def build():
    with open(SRC_PATH, encoding='utf-8') as fh:
        src = fh.read()
    # 1. 換掉密度＋力兩段（從第一個 step 迴圈到積分迴圈之前）
    a = src.index("with step.loop(i, 0, N):\n    acc.set(0.0)")
    b = src.index("with step.loop(i, 0, N):\n    with step.loop(a, 0, 3):")
    src = src[:a] + NEW_STEP + src[b:]
    # 2. 膠水（宣告、全域、核心原始碼、sph_setup／sph_gpu 的 IR 文字）插在 step 之前
    glue = _build_glue()
    inject = (INJECT.replace('__DECLS__', repr(DECLS)).replace('__SRC__', repr(SRC_ALL))
              .replace('__KERNELS__', repr(KERNELS)).replace('__GLUE__', repr(glue)))
    marker = "step = m.fn('void', 'step'"
    assert src.count(marker) == 1
    src = src.replace(marker, inject + marker, 1)
    # 3. 輸出檔名、標頭
    old_out = "'..', 'gpgpu', 'fluid3d.ll'"
    assert src.count(old_out) == 1
    src = src.replace(old_out, "'..', 'gpgpu', 'fluid3d_cl.ll'")
    old_hdr = "（由 _gen/_gen_fluid3d.py 產生；GPGPU 版要等 OpenCL 墊片）"
    assert src.count(old_hdr) == 1
    src = src.replace(old_hdr, "（OpenCL 版：密度與力用 OpenCL 核心（float32），由 _gen/_gen_fluid3d_cl.py 產生）")
    # 3b. HUD 的來源文字：依真正的後端顯示（0＝尚未派送、1＝WebGL2、2＝JS 墊片；不是寫死的 CPU）
    old_txt = "c('snprintf', buf, 160, '%d particles | source: CPU (wasm) | step %d', N, step_no)"
    assert src.count(old_txt) == 1
    ladder = (
        "_bk = c('fa_cl_backend')\n"
        "with draw.if_(_bk.eq(1)):\n"
        "    c('snprintf', buf, 160, '%d particles | source: OpenCL WebGL2 | step %d', N, step_no)\n"
        "with draw.if_(_bk.eq(2)):\n"
        "    c('snprintf', buf, 160, '%d particles | source: OpenCL JS shim (not GPU) | step %d', N, step_no)\n"
        "with draw.if_(_bk.eq(0)):\n"
        "    c('snprintf', buf, 160, '%d particles | source: OpenCL not dispatched yet | step %d', N, step_no)")
    src = src.replace(old_txt, ladder)
    return src


if __name__ == '__main__':
    code = build()
    g = {'__file__': SRC_PATH, '__name__': '__gen__'}
    exec(compile(code, SRC_PATH, 'exec'), g)
    print('wrote', os.path.normpath(OUT))
