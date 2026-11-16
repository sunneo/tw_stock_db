# -*- coding: utf-8 -*-
"""
numba.cuda 核心 → WGSL 轉譯（GPU 相容層；DESIGN.webgpu-cuda.md §3、§4）。

支援：
- cuda.grid(1)、cuda.grid(2)（對應 WGSL 的 global_invocation_id.x／.y；工作群組大小 = kernel[blocks, threads] 的 threads）
- 一維與二維陣列（二維用 arr[r, c]，列主序）、arr.size、arr.shape[d]（形狀在轉譯時是常數）
- 純量參數（Python int／float）以常數寫進 WGSL 原始碼
- 區域變數、賦值、+= 等擴充賦值、if／else、for i in range(...)、return
- 算術（+ - * / // % **）、比較、and／or／not、min／max／abs／float／int、math.sqrt 等
- cuda.atomic.add（int32 陣列，WGSL atomicAdd）

float64（Python 預設）的三種模式（由呼叫端選，對應設定 cudaCompatFloat64）：
- exact：float64 陣列不轉換（丟 NotCompilable，由上層退回本機 Python 模擬，與 CUDA 同精度）
- f32：float64 陣列轉成 float32 在 GPU 執行（精度降為 float32，結果轉回 float64）
- dd：float64 陣列以「雙 float32」（hi + lo，約 48 位元有效精度）在 GPU 執行。只支援 + − × 與比較、min、max、abs、neg、float、int；
  除法、次方、math.* 尚未實作（丟 NotCompilable，附原因）。

不支援（丟 NotCompilable，訊息帶行號與原因）：shared 記憶體與 syncthreads、f64 原子、try、lambda、推導式、遞迴、print 等。

注意：Python 的 // 與 WGSL 的整數除法對負數的取整不同（WGSL 向零取整）；核心的索引通常是非負數，所以結果一致。
"""
import ast
import math

import numpy as np


class NotCompilable(RuntimeError):
    """核心不能轉成 WGSL；字串是給使用者看的具體原因。"""


F32, I32, BOOL, DD = "f32", "i32", "bool", "dd"
_WTY = {F32: "f32", I32: "i32", BOOL: "bool", DD: "vec2<f32>"}
_BIND = {F32: "f32", I32: "i32", DD: "dd"}
_DT = {np.dtype(np.float32): F32, np.dtype(np.int32): I32}
_MATH1 = {"sqrt": "sqrt", "exp": "exp", "log": "log", "sin": "sin", "cos": "cos", "tan": "tan",
          "tanh": "tanh", "floor": "floor", "ceil": "ceil", "fabs": "abs"}
_WIDEN = {(I32, F32), (I32, DD), (F32, DD)}
EXACT_MSG = ("參數 %s 是 float64 陣列；cudaCompatFloat64=exact，保持與 CUDA 同精度，所以在本機 Python 模擬。"
             "要用 GPU 請把設定改成 auto（雙 float32，約 48 位元）或 f32（精度降為 float32）")

# 雙 float32（DESIGN.webgpu-cuda.md §3 的 f64 替代）。乘法的誤差項用 Dekker 分割（不用 fma）：Chrome 的軟體 WebGPU（SwiftShader）的 fma 不是融合運算，
# 用 fma 的 dd_mul 在那裡只剩 float32 精度（實測相對誤差 5.8e-8）；Dekker 分割在有／沒有融合乘加的裝置上都正確（編譯器即使把 a*b−p 收縮成 fma 結果仍精確）。
DD_LIB = """// 雙 float32（hi + lo）的運算庫：float64 核心在 cudaCompatFloat64=auto 時用這組函式
fn dd_of_f32(a: f32) -> vec2<f32> { return vec2<f32>(a, 0.0); }
fn dd_to_f32(a: vec2<f32>) -> f32 { return a.x + a.y; }
fn dd_neg(a: vec2<f32>) -> vec2<f32> { return -a; }
fn dd_two_sum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let bb = s - a;
  let e = (a - (s - bb)) + (b - bb);
  return vec2<f32>(s, e);
}
fn dd_quick_two_sum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let e = b - (s - a);
  return vec2<f32>(s, e);
}
fn dd_add(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let s = dd_two_sum(a.x, b.x);
  let t = dd_two_sum(a.y, b.y);
  let q1 = dd_quick_two_sum(s.x, s.y + t.x);
  return dd_quick_two_sum(q1.x, q1.y + t.y);
}
fn dd_sub(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { return dd_add(a, dd_neg(b)); }
fn dd_split(a: f32) -> vec2<f32> {
  let t = 4097.0 * a;
  let hi = t - (t - a);
  return vec2<f32>(hi, a - hi);
}
fn dd_two_prod(a: f32, b: f32) -> vec2<f32> {
  let p = a * b;
  let sa = dd_split(a);
  let sb = dd_split(b);
  let e = ((sa.x * sb.x - p) + sa.x * sb.y + sa.y * sb.x) + sa.y * sb.y;
  return vec2<f32>(p, e);
}
fn dd_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let tp = dd_two_prod(a.x, b.x);
  let e = tp.y + (a.x * b.y + a.y * b.x);
  return dd_quick_two_sum(tp.x, e);
}
fn dd_lt(a: vec2<f32>, b: vec2<f32>) -> bool { return (a.x < b.x) || ((a.x == b.x) && (a.y < b.y)); }
fn dd_eq(a: vec2<f32>, b: vec2<f32>) -> bool { return (a.x == b.x) && (a.y == b.y); }
fn dd_le(a: vec2<f32>, b: vec2<f32>) -> bool { return dd_lt(a, b) || dd_eq(a, b); }
fn dd_gt(a: vec2<f32>, b: vec2<f32>) -> bool { return dd_lt(b, a); }
fn dd_ge(a: vec2<f32>, b: vec2<f32>) -> bool { return dd_le(b, a); }
fn dd_ne(a: vec2<f32>, b: vec2<f32>) -> bool { return !dd_eq(a, b); }
fn dd_min(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { if (dd_lt(b, a)) { return b; } return a; }
fn dd_max(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { if (dd_lt(a, b)) { return b; } return a; }
fn dd_abs(a: vec2<f32>) -> vec2<f32> { if (a.x < 0.0) { return -a; } return a; }
"""


def _ddc(x):
    """高精度常數（Fraction 或 float）→ WGSL 的 vec2<f32>(hi, lo) 字面值。"""
    from fractions import Fraction
    fx = Fraction(x)
    hi = float(np.float32(float(fx)))
    lo = float(np.float32(float(fx - Fraction(hi))))
    return "vec2<f32>(%sf, %sf)" % (repr(hi), repr(lo))


def _dd_ext_lib():
    """雙 float32 的除法、開根號、exp、log、sin／cos／tan、tanh、floor／ceil、整數次方（DESIGN.webgpu-cuda.md §3；用到 dd_add／dd_mul 之上）。
    做法：除法用三次商修正；sqrt 用牛頓一次；exp 先用 ln2 縮到 |r|≤0.35·2⁻⁸ 再泰勒 expm1、平方 8 次還原、乘 2^k（位元構造，k∈[-126,127]）；
    log 以 f32 的 log 起頭、牛頓一次（y += a·exp(−y) − 1）；sin／cos 用 π/2 縮減（|x| 約 1e3 以內有 1e-14 級精度）再泰勒；tanh 用 exp。"""
    from fractions import Fraction
    import math as _m
    ln2 = Fraction("0.693147180559945309417232121458176568075500134360255254120680009")
    pio2 = Fraction("1.570796326794896619231321691639751442098584699687552910487472296")
    fact = [Fraction(1)]
    for n in range(1, 24):
        fact.append(fact[-1] * n)
    sin_c = ", ".join(_ddc(Fraction((-1) ** i, fact[2 * i + 1])) for i in range(10))
    cos_c = ", ".join(_ddc(Fraction((-1) ** i, fact[2 * i])) for i in range(10))
    inv_f = ", ".join(_ddc(Fraction(1, fact[n])) for n in range(2, 9))
    return """
fn dd_mul_f(a: vec2<f32>, b: f32) -> vec2<f32> {
  let tp = dd_two_prod(a.x, b);
  return dd_quick_two_sum(tp.x, tp.y + a.y * b);
}
fn dd_div(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  // 四次商修正：編譯器把分子是常數的 1.0/x 換成近似倒數時（SwiftShader 實測只有約 12 位元），三次修正只到 float32 精度（5.9e-8），四次才夠 48 位元
  let q1 = a.x / b.x;
  let r1 = dd_sub(a, dd_mul_f(b, q1));
  let q2 = r1.x / b.x;
  let r2 = dd_sub(r1, dd_mul_f(b, q2));
  let q3 = r2.x / b.x;
  let r3 = dd_sub(r2, dd_mul_f(b, q3));
  let q4 = r3.x / b.x;
  return dd_add(dd_quick_two_sum(q1, q2), dd_quick_two_sum(q3, q4));
}
fn dd_sqrt(a: vec2<f32>) -> vec2<f32> {
  if (a.x <= 0.0) { return vec2<f32>(sqrt(a.x), 0.0); }
  let y = vec2<f32>(sqrt(a.x), 0.0);
  return dd_mul_f(dd_add(y, dd_div(a, y)), 0.5);
}
fn dd_pow2k(k: i32) -> f32 {
  if (k < -126) { return 0.0; }
  return bitcast<f32>(u32(min(k, 127) + 127) << 23u);
}
fn dd_exp(a: vec2<f32>) -> vec2<f32> {
  if (a.x > 88.0) { return vec2<f32>(3.4028234e38, 0.0); }
  if (a.x < -87.0) { return vec2<f32>(0.0, 0.0); }
  let LN2 = %(ln2)s;
  let k = i32(round(a.x / LN2.x));
  var s = dd_mul_f(dd_sub(a, dd_mul_f(LN2, f32(k))), 0.00390625);
  var p = dd_mul(s, s);
  var t = s;
  var INVF = array<vec2<f32>, 7>(%(invf)s);
  // expm1(s) = s + s²/2! + … + s⁸/8!（|s| ≤ 0.0014，到 s⁸ 已遠小於 1e-30）
  var sum = s;
  for (var i = 0; i < 7; i = i + 1) { sum = dd_add(sum, dd_mul(p, INVF[i])); p = dd_mul(p, s); }
  for (var j = 0; j < 8; j = j + 1) { sum = dd_add(dd_mul_f(sum, 2.0), dd_mul(sum, sum)); }
  return dd_mul_f(dd_add(sum, vec2<f32>(1.0, 0.0)), dd_pow2k(k));
}
fn dd_log(a: vec2<f32>) -> vec2<f32> {
  if (a.x <= 0.0) { return vec2<f32>(log(a.x), 0.0); }
  let y = vec2<f32>(log(a.x), 0.0);
  return dd_sub(dd_add(y, dd_mul(a, dd_exp(dd_neg(y)))), vec2<f32>(1.0, 0.0));
}
fn dd_sincos_core(r: vec2<f32>) -> array<vec2<f32>, 2> {
  var SC = array<vec2<f32>, 10>(%(sinc)s);
  var CC = array<vec2<f32>, 10>(%(cosc)s);
  let r2 = dd_mul(r, r);
  var sn = SC[9];
  var cs = CC[9];
  for (var i = 8; i >= 0; i = i - 1) { sn = dd_add(dd_mul(sn, r2), SC[i]); cs = dd_add(dd_mul(cs, r2), CC[i]); }
  return array<vec2<f32>, 2>(dd_mul(sn, r), cs);
}
fn dd_sincos(a: vec2<f32>) -> array<vec2<f32>, 2> {
  let PIO2 = %(pio2)s;
  let k = round(a.x / PIO2.x);
  let r = dd_sub(a, dd_mul_f(PIO2, k));
  let sc = dd_sincos_core(r);
  let q = ((i32(k) %% 4) + 4) %% 4;
  if (q == 0) { return sc; }
  if (q == 1) { return array<vec2<f32>, 2>(sc[1], -sc[0]); }
  if (q == 2) { return array<vec2<f32>, 2>(-sc[0], -sc[1]); }
  return array<vec2<f32>, 2>(-sc[1], sc[0]);
}
fn dd_sin(a: vec2<f32>) -> vec2<f32> { return dd_sincos(a)[0]; }
fn dd_cos(a: vec2<f32>) -> vec2<f32> { return dd_sincos(a)[1]; }
fn dd_tan(a: vec2<f32>) -> vec2<f32> { let sc = dd_sincos(a); return dd_div(sc[0], sc[1]); }
fn dd_tanh(a: vec2<f32>) -> vec2<f32> {
  if (a.x > 20.0) { return vec2<f32>(1.0, 0.0); }
  if (a.x < -20.0) { return vec2<f32>(-1.0, 0.0); }
  let e = dd_exp(dd_mul_f(a, 2.0));
  return dd_div(dd_sub(e, vec2<f32>(1.0, 0.0)), dd_add(e, vec2<f32>(1.0, 0.0)));
}
fn dd_floor(a: vec2<f32>) -> vec2<f32> {
  let f = floor(a.x);
  if (f == a.x) { return dd_quick_two_sum(f, floor(a.y)); }
  return vec2<f32>(f, 0.0);
}
fn dd_ceil(a: vec2<f32>) -> vec2<f32> { return -dd_floor(-a); }
fn dd_powi(a: vec2<f32>, n: i32) -> vec2<f32> {
  var e = abs(n);
  var base = a;
  var r = vec2<f32>(1.0, 0.0);
  for (var i = 0; i < 31; i = i + 1) {
    if (e == 0) { break; }
    if ((e & 1) == 1) { r = dd_mul(r, base); }
    e = e >> 1u;
    if (e != 0) { base = dd_mul(base, base); }
  }
  // 1/r 寫成 r/(r·r)：分子是編譯期常數 (1,0) 時，SwiftShader 會把 dd_div 內的 two_sum 化簡掉，結果只剩 float32 精度（5.9e-8）；兩個運算元都在執行期才知道就正確
  if (n < 0) { return dd_div(r, dd_mul(r, r)); }
  return r;
}
fn dd_pow(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { return dd_exp(dd_mul(b, dd_log(a))); }
""" % {"ln2": _ddc(ln2), "pio2": _ddc(pio2), "sinc": sin_c, "cosc": cos_c, "invf": inv_f}


DD_LIB = DD_LIB + _dd_ext_lib()


def _fl(x):
    """Python 浮點數 → WGSL f32 字面值（帶括號與 f 後綴）。"""
    s = repr(float(x))
    if "." not in s and "e" not in s and "E" not in s:
        s += ".0"
    return "(%sf)" % s


def _int_lit(v):
    iv = int(v)
    if not -(2 ** 31) <= iv < 2 ** 31:
        raise NotCompilable("整數常數 %d 超出 i32 範圍" % iv)
    return "(%di)" % iv


class _Arr(object):
    def __init__(self, param, dtype, shape):
        self.param = param
        self.w = "a_" + param
        self.dtype = dtype
        self.shape = tuple(shape)
        self.atomic = False
        self.write = False


class Plan(object):
    """轉譯結果：WGSL 原始碼、綁定（依 binding 編號排列）、工作群組數、浮點模式。"""

    def __init__(self, wgsl, bindings, groups, fmode):
        self.wgsl = wgsl
        self.bindings = bindings  # 每個 dict：param（numba 參數名）、wname（WGSL 名）、dtype（f32／i32／dd）、shape、write、atomic
        self.groups = groups
        self.fmode = fmode        # 'f32' 或 'dd'


def _is_cuda_attr(n, attr):
    return isinstance(n, ast.Attribute) and n.attr == attr and isinstance(n.value, ast.Name) and n.value.id == "cuda"


def _is_grid_call(n):
    return isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "grid" \
        and isinstance(n.func.value, ast.Name) and n.func.value.id == "cuda"


def _is_atomic_add(n):
    return isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "add" \
        and _is_cuda_attr(n.func.value, "atomic")


class _Gen(object):
    def __init__(self, arrays, consts, threads, fmode):
        self.arrays = arrays
        self.consts = consts      # 參數名 → Python 純量
        self.threads = threads
        self.fmode = fmode        # 'f32' 或 'dd'：Python 浮點常數與浮點運算的表示
        self.locals = {}
        self.lines = []
        self.ind = 1
        self.used = []

    # ---- 工具
    def err(self, node, msg):
        raise NotCompilable("第 %d 行：%s" % (getattr(node, "lineno", 0), msg))

    def emit(self, s):
        self.lines.append("  " * self.ind + s)

    def use(self, arr):
        if arr not in self.used:
            self.used.append(arr)

    def flit(self, v):
        if self.fmode == DD:
            hi = float(np.float32(v))
            lo = float(np.float32(float(v) - hi))
            return "vec2<f32>(%s, %s)" % (_fl(hi), _fl(lo)), DD
        return _fl(v), F32

    def lit(self, v):
        if isinstance(v, (bool, np.bool_)):
            return ("true" if v else "false"), BOOL
        if isinstance(v, (int, np.integer)):
            return _int_lit(v), I32
        if isinstance(v, (float, np.floating)):
            fv = float(v)
            if not math.isfinite(fv):
                raise NotCompilable("浮點常數不是有限數字（%r）" % fv)
            return self.flit(fv)
        raise NotCompilable("不支援的常數型別 %s" % type(v).__name__)

    def coerce(self, node, code, t, to):
        if t == to:
            return code
        if to == F32:
            if t == I32:
                return "f32(%s)" % code
            if t == DD:
                return "dd_to_f32(%s)" % code
        if to == DD:
            if t == F32:
                return "dd_of_f32(%s)" % code
            if t == I32:
                return "dd_of_f32(f32(%s))" % code
        if to == I32:
            if t == F32:
                return "i32(%s)" % code
            if t == DD:
                return "i32(dd_to_f32(%s))" % code
        self.err(node, "型別不相容（%s 與 %s）" % (_WTY[t], _WTY[to]))

    def boolean(self, node, code, t):
        if t == BOOL:
            return code
        if t == I32:
            return "(%s != 0i)" % code
        if t == DD:
            return "(dd_to_f32(%s) != 0.0f)" % code
        return "(%s != 0.0f)" % code

    def i32(self, node):
        c, t = self.expr(node)
        return self.coerce(node, c, t, I32)

    def const_int(self, node):
        if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
            return node.value
        self.err(node, "這裡需要整數常數")

    # ---- 運算式
    def expr(self, n):
        if isinstance(n, ast.Constant):
            return self.lit(n.value)
        if isinstance(n, ast.Name):
            if n.id in self.locals:
                return self.locals[n.id]
            if n.id in self.consts:
                return self.lit(self.consts[n.id])
            if n.id in self.arrays:
                self.err(n, "陣列 %s 不能直接當數值使用（請用 %s[索引]）" % (n.id, n.id))
            self.err(n, "未定義的名稱 %s（核心只能用參數、迴圈變數與區域變數）" % n.id)
        if isinstance(n, ast.UnaryOp):
            c, t = self.expr(n.operand)
            if isinstance(n.op, ast.Not):
                return "(!%s)" % self.boolean(n.operand, c, t), BOOL
            if t == BOOL:
                self.err(n, "布林值不能做正負號運算")
            if isinstance(n.op, ast.USub):
                return ("dd_neg(%s)" % c if t == DD else "(-%s)" % c), t
            if isinstance(n.op, ast.UAdd):
                return c, t
            self.err(n, "不支援的一元運算")
        if isinstance(n, ast.BinOp):
            return self.binop(n)
        if isinstance(n, ast.Compare):
            return self.compare(n)
        if isinstance(n, ast.BoolOp):
            sym = "&&" if isinstance(n.op, ast.And) else "||"
            parts = []
            for v in n.values:
                c, t = self.expr(v)
                parts.append(self.boolean(v, c, t))
            return "(" + (" %s " % sym).join(parts) + ")", BOOL
        if isinstance(n, ast.Attribute):
            if isinstance(n.value, ast.Name) and n.value.id in self.arrays and n.attr == "size":
                arr = self.arrays[n.value.id]
                # 形狀是常數，不需要綁定陣列（綁了沒用到的綁定會讓管線布局對不上）
                return "%di" % int(np.prod(arr.shape)), I32
            self.err(n, "不支援的屬性 .%s（支援 arr.size、arr.shape[d]）" % n.attr)
        if isinstance(n, ast.Subscript):
            v = n.value
            if isinstance(v, ast.Attribute) and v.attr == "shape" and isinstance(v.value, ast.Name) and v.value.id in self.arrays:
                arr = self.arrays[v.value.id]
                d = self.const_int(n.slice)
                if not 0 <= d < len(arr.shape):
                    self.err(n, "shape 維度 %d 超出範圍" % d)
                return "%di" % arr.shape[d], I32
            if isinstance(v, ast.Name) and v.id in self.arrays:
                arr = self.arrays[v.id]
                self.use(arr)
                ix = self.index(arr, self.index_nodes(n.slice))
                if arr.atomic:
                    return "atomicLoad(&%s[%s])" % (arr.w, ix), arr.dtype
                return "%s[%s]" % (arr.w, ix), arr.dtype
            self.err(n, "只能對陣列做索引")
        if isinstance(n, ast.Call):
            return self.call(n)
        self.err(n, "不支援的運算式 %s" % type(n).__name__)

    def _dd_mode_float(self, at, bt):
        return self.fmode == DD and (DD in (at, bt) or F32 in (at, bt))

    def binop(self, n):
        a, at = self.expr(n.left)
        b, bt = self.expr(n.right)
        if BOOL in (at, bt):
            self.err(n, "布林值不能參與算術運算")
        op = type(n.op)
        if self._dd_mode_float(at, bt):
            if op is ast.Pow:
                e = n.right
                if isinstance(e, ast.UnaryOp) and isinstance(e.op, ast.USub) and isinstance(e.operand, ast.Constant):
                    ev = -e.operand.value
                elif isinstance(e, ast.Constant):
                    ev = e.value
                else:
                    ev = None
                if isinstance(ev, (int, float)) and not isinstance(ev, bool) and float(ev) == int(ev) and abs(int(ev)) <= 64:
                    return "dd_powi(%s, %d)" % (self.coerce(n, a, at, DD), int(ev)), DD
                if ev == 0.5:
                    return "dd_sqrt(%s)" % self.coerce(n, a, at, DD), DD
                # 一般次方：exp(b·log a)（只對 a>0 有意義；a≤0 結果未定義，與 numba 的 NaN 不同）
                return "dd_pow(%s, %s)" % (self.coerce(n, a, at, DD), self.coerce(n, b, bt, DD)), DD
            fn = {ast.Add: "dd_add", ast.Sub: "dd_sub", ast.Mult: "dd_mul", ast.Div: "dd_div"}.get(op)
            if fn is None:
                self.err(n, "雙 float32 模式目前不支援取餘（%）與整數除法（//）（DESIGN.webgpu-cuda.md §3）；"
                            "可改用 cudaCompatFloat64=f32（精度降為 float32）或 exact")
            return "%s(%s, %s)" % (fn, self.coerce(n, a, at, DD), self.coerce(n, b, bt, DD)), DD
        if op in (ast.Add, ast.Sub, ast.Mult):
            sym = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*"}[op]
            t = F32 if F32 in (at, bt) else I32
            return "(%s %s %s)" % (self.coerce(n, a, at, t), sym, self.coerce(n, b, bt, t)), t
        if self.fmode == DD and op in (ast.Div, ast.Pow):
            self.err(n, "雙 float32 模式尚未支援整數除法與次方（DESIGN.webgpu-cuda.md §3，之後再做）；請改用 cudaCompatFloat64=f32 或 exact")
        if op is ast.Div:
            return "(%s / %s)" % (self.coerce(n, a, at, F32), self.coerce(n, b, bt, F32)), F32
        if op is ast.FloorDiv:
            return "(%s / %s)" % (self.coerce(n, a, at, I32), self.coerce(n, b, bt, I32)), I32
        if op is ast.Mod:
            t = F32 if F32 in (at, bt) else I32
            return "(%s %% %s)" % (self.coerce(n, a, at, t), self.coerce(n, b, bt, t)), t
        if op is ast.Pow:
            return "pow(%s, %s)" % (self.coerce(n, a, at, F32), self.coerce(n, b, bt, F32)), F32
        self.err(n, "不支援的運算子 %s" % op.__name__)

    def compare(self, n):
        if len(n.ops) != 1:
            self.err(n, "不支援鏈式比較（請改成 and）")
        a, at = self.expr(n.left)
        b, bt = self.expr(n.comparators[0])
        if BOOL in (at, bt):
            self.err(n, "布林值不能直接比較")
        if self._dd_mode_float(at, bt):
            fn = {ast.Lt: "dd_lt", ast.LtE: "dd_le", ast.Gt: "dd_gt", ast.GtE: "dd_ge",
                  ast.Eq: "dd_eq", ast.NotEq: "dd_ne"}.get(type(n.ops[0]))
            if fn is None:
                self.err(n, "不支援的比較運算")
            return "%s(%s, %s)" % (fn, self.coerce(n, a, at, DD), self.coerce(n, b, bt, DD)), BOOL
        ops = {ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=", ast.Eq: "==", ast.NotEq: "!="}
        op = ops.get(type(n.ops[0]))
        if op is None:
            self.err(n, "不支援的比較運算")
        t = F32 if F32 in (at, bt) else I32
        return "(%s %s %s)" % (self.coerce(n, a, at, t), op, self.coerce(n, b, bt, t)), BOOL

    def call(self, n):
        f = n.func
        if isinstance(f, ast.Name) and f.id in ("min", "max") and len(n.args) == 2:
            a, at = self.expr(n.args[0])
            b, bt = self.expr(n.args[1])
            if self._dd_mode_float(at, bt):
                return "dd_%s(%s, %s)" % (f.id, self.coerce(n, a, at, DD), self.coerce(n, b, bt, DD)), DD
            t = F32 if F32 in (at, bt) else I32
            return "%s(%s, %s)" % (f.id, self.coerce(n, a, at, t), self.coerce(n, b, bt, t)), t
        if isinstance(f, ast.Name) and f.id == "abs" and len(n.args) == 1:
            a, at = self.expr(n.args[0])
            if at == BOOL:
                self.err(n, "abs 不能用在布林值")
            if at == DD:
                return "dd_abs(%s)" % a, DD
            return "abs(%s)" % a, at
        if isinstance(f, ast.Name) and f.id in ("float", "int") and len(n.args) == 1:
            a, at = self.expr(n.args[0])
            if f.id == "float":
                to = DD if self.fmode == DD else F32
            else:
                to = I32
            return self.coerce(n, a, at, to), to
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "math" \
                and f.attr in _MATH1 and len(n.args) == 1:
            if self.fmode == DD:
                a, at = self.expr(n.args[0])
                return "dd_%s(%s)" % ({"fabs": "abs"}.get(f.attr, f.attr), self.coerce(n, a, at, DD)), DD
            a, at = self.expr(n.args[0])
            return "%s(%s)" % (_MATH1[f.attr], self.coerce(n, a, at, F32)), F32
        if _is_grid_call(n) or _is_atomic_add(n):
            self.err(n, "cuda.grid 與 cuda.atomic.add 只能用在單獨的陳述式（grid 要用 i = cuda.grid(1) 的形式）")
        self.err(n, "不支援呼叫這個函式（核心內可用 min、max、abs、float、int、math.*）")

    # ---- 陣列索引
    def index_nodes(self, sl):
        if isinstance(sl, ast.Tuple):
            return list(sl.elts)
        return [sl]

    def index(self, arr, nodes):
        if len(arr.shape) == 1:
            if len(nodes) != 1:
                raise NotCompilable("陣列 %s 是一維，索引要只有一個" % arr.param)
            return self.i32(nodes[0])
        if len(arr.shape) == 2:
            if len(nodes) != 2:
                raise NotCompilable("陣列 %s 是二維，要用 %s[r, c] 索引" % (arr.param, arr.param))
            r = self.i32(nodes[0])
            c = self.i32(nodes[1])
            return "((%s) * %di + (%s))" % (r, arr.shape[1], c)
        raise NotCompilable("第一批只支援一維與二維陣列（%s 是 %d 維）" % (arr.param, len(arr.shape)))

    # ---- 陳述式
    def stmts(self, body):
        for s in body:
            self.stmt(s)

    def stmt(self, s):
        if isinstance(s, ast.Assign):
            if len(s.targets) != 1:
                self.err(s, "不支援多重賦值")
            tgt = s.targets[0]
            if _is_grid_call(s.value):
                return self.grid_assign(s, tgt)
            if isinstance(tgt, ast.Name):
                return self.assign_name(s, tgt.id, s.value)
            if isinstance(tgt, ast.Subscript):
                return self.store(tgt, s.value)
            self.err(s, "不支援這種賦值目標")
        if isinstance(s, ast.AugAssign):
            tgt = s.target
            val = ast.BinOp(left=tgt, op=s.op, right=s.value)
            ast.copy_location(val, s)
            if isinstance(tgt, ast.Name):
                if tgt.id not in self.locals:
                    self.err(s, "%s 在 += 之前還沒有賦值" % tgt.id)
                return self.assign_name(s, tgt.id, val)
            if isinstance(tgt, ast.Subscript):
                return self.store(tgt, val)
            self.err(s, "不支援這種擴充賦值目標")
        if isinstance(s, ast.Expr):
            v = s.value
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                return None
            if _is_atomic_add(v):
                return self.atomic_add(v)
            self.err(s, "不支援這種陳述式（%s）" % type(v).__name__)
        if isinstance(s, ast.If):
            c, t = self.expr(s.test)
            self.emit("if (%s) {" % self.boolean(s.test, c, t))
            self.ind += 1
            self.stmts(s.body)
            self.ind -= 1
            if s.orelse:
                self.emit("} else {")
                self.ind += 1
                self.stmts(s.orelse)
                self.ind -= 1
            self.emit("}")
            return None
        if isinstance(s, ast.For):
            return self.for_range(s)
        if isinstance(s, ast.Return):
            if s.value is not None:
                self.err(s, "核心不能回傳值")
            self.emit("return;")
            return None
        if isinstance(s, ast.Pass):
            return None
        self.err(s, "第一批不支援這種陳述式（%s）" % type(s).__name__)

    def assign_name(self, s, name, value):
        c, t = self.expr(value)
        if name in self.locals:
            w, lt = self.locals[name]
            if lt != t:
                if (t, lt) in _WIDEN:
                    c = self.coerce(s, c, t, lt)
                else:
                    self.err(s, "變數 %s 的型別從 %s 變成 %s（WGSL 需要固定型別，請統一寫法，例如浮點數初值用 0.0）" % (name, _WTY[lt], _WTY[t]))
            self.emit("%s = %s;" % (w, c))
            return None
        w = "v_" + name
        self.locals[name] = (w, t)
        self.emit("var %s: %s = %s;" % (w, _WTY[t], c))
        return None

    def grid_assign(self, s, tgt):
        call = s.value
        if len(call.args) != 1:
            self.err(s, "cuda.grid 要給維度，例如 cuda.grid(1)")
        nd = self.const_int(call.args[0])
        if nd not in (1, 2):
            self.err(s, "cuda.grid(%d) 第一批只支援 1 或 2 維" % nd)
        names = tgt.elts if isinstance(tgt, ast.Tuple) else [tgt]
        if len(names) != nd or not all(isinstance(x, ast.Name) for x in names):
            self.err(s, "cuda.grid(%d) 的結果要用 %d 個變數接，例如 %s" % (nd, nd, "i = cuda.grid(1)" if nd == 1 else "row, col = cuda.grid(2)"))
        comps = ["x", "y"]
        for k, nm in enumerate(names):
            w = "v_" + nm.id
            self.locals[nm.id] = (w, I32)
            self.emit("let %s: i32 = i32(gid.%s);" % (w, comps[k]))
        return None

    def store(self, tgt, value):
        base = tgt.value
        if not (isinstance(base, ast.Name) and base.id in self.arrays):
            self.err(tgt, "只能寫入陣列元素")
        arr = self.arrays[base.id]
        self.use(arr)
        arr.write = True
        if arr.atomic:
            self.err(tgt, "陣列 %s 同時被 cuda.atomic.add 使用，不能直接寫入（請全部改用 cuda.atomic.add）" % arr.param)
        ix = self.index(arr, self.index_nodes(tgt.slice))
        c, t = self.expr(value)
        self.emit("%s[%s] = %s;" % (arr.w, ix, self.coerce(tgt, c, t, arr.dtype)))
        return None

    def atomic_add(self, v):
        if len(v.args) != 3:
            self.err(v, "cuda.atomic.add 要三個參數（陣列、索引、值）")
        base = v.args[0]
        if not (isinstance(base, ast.Name) and base.id in self.arrays):
            self.err(v, "cuda.atomic.add 的第一個參數要是陣列")
        arr = self.arrays[base.id]
        if not arr.atomic or arr.dtype != I32:
            self.err(v, "cuda.atomic.add 第一批只支援 int32 陣列（WebGPU 沒有 float32 原子；float 原子需要 CAS 替代，尚未實作）")
        self.use(arr)
        arr.write = True
        ix = self.index(arr, self.index_nodes(v.args[1]))
        c, t = self.expr(v.args[2])
        self.emit("_ = atomicAdd(&%s[%s], %s);" % (arr.w, ix, self.coerce(v, c, t, I32)))
        return None

    def for_range(self, s):
        it = s.iter
        if not (isinstance(s.target, ast.Name) and isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == "range"):
            self.err(s, "for 迴圈第一批只支援 for 變數 in range(…)")
        a = it.args
        if len(a) == 1:
            start, stop, step = "(0i)", self.i32(a[0]), "1"
        elif len(a) == 2:
            start, stop, step = self.i32(a[0]), self.i32(a[1]), "1"
        elif len(a) == 3:
            sv = self.const_int(a[2])
            if sv <= 0:
                self.err(s, "range 的步長要是正的整數常數")
            start, stop, step = self.i32(a[0]), self.i32(a[1]), str(sv)
        else:
            self.err(s, "range 參數數量不對")
        name = "v_" + s.target.id
        self.locals[s.target.id] = (name, I32)
        self.emit("for (var %s: i32 = %s; %s < %s; %s = %s + %di) {" % (name, start, name, stop, name, name, int(step)))
        self.ind += 1
        self.stmts(s.body)
        self.ind -= 1
        self.emit("}")
        return None


def _mark_atomics(fdef, arrays):
    for node in ast.walk(fdef):
        if _is_atomic_add(node) and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id in arrays:
            arr = arrays[node.args[0].id]
            if arr.dtype != I32:
                raise NotCompilable("第 %d 行：cuda.atomic.add 第一批只支援 int32 陣列（WebGPU 沒有 float32 原子；float 原子需要 CAS 替代，尚未實作）" % node.lineno)
            arr.atomic = True


def compile_kernel(name, src, values, blocks, threads, mode="f32"):
    """把 numba 核心轉成 WGSL。
    values：依參數順序的 numpy 陣列或 Python 純量。
    mode：'exact'（float64 陣列拒絕）、'f32'（float64 陣列當 float32）、'dd'（float64 陣列用雙 float32）。
    丟 NotCompilable 時帶具體原因。"""
    if mode not in ("exact", "f32", "dd"):
        raise NotCompilable("未知的浮點模式 %r" % (mode,))
    fmode = DD if mode == "dd" else F32
    if blocks[2] != 1 or threads[2] != 1:
        raise NotCompilable("三維的 blocks／threads 第一批尚未支援")
    if threads[0] * threads[1] > 256:
        raise NotCompilable("每個工作群組的執行緒數 %d 超過 WebGPU 預設上限 256" % (threads[0] * threads[1]))
    if "syncthreads" in src or "shared" in src:
        raise NotCompilable("核心用到 shared 記憶體或 cuda.syncthreads（需要工作群組共享記憶體與屏障，第一批尚未支援）")
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        raise NotCompilable("核心原始碼無法解析：%s" % e)
    fdef = None
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            fdef = node
            break
    if fdef is None:
        raise NotCompilable("找不到核心函式 %s" % name)
    params = [a.arg for a in fdef.args.args]
    if len(params) != len(values):
        raise NotCompilable("參數數量不符（核心要 %d 個，給了 %d 個）" % (len(params), len(values)))
    arrays, consts = {}, {}
    for p, v in zip(params, values):
        if isinstance(v, np.ndarray):
            if v.dtype == np.float64:
                if mode == "exact":
                    raise NotCompilable(EXACT_MSG % p)
                dt = DD if mode == "dd" else F32
            else:
                dt = _DT.get(v.dtype)
                if dt is None:
                    raise NotCompilable("參數 %s 是 %s 陣列；WebGPU 只支援 float32、int32 與（設定允許時）float64" % (p, v.dtype))
            if v.ndim not in (1, 2):
                raise NotCompilable("參數 %s 是 %d 維陣列，第一批只支援一維與二維" % (p, v.ndim))
            arrays[p] = _Arr(p, dt, v.shape)
        elif isinstance(v, (bool, int, float, np.integer, np.floating, np.bool_)):
            consts[p] = v
        else:
            raise NotCompilable("參數 %s 的型別 %s 不支援" % (p, type(v).__name__))
    _mark_atomics(fdef, arrays)
    g = _Gen(arrays, consts, threads, fmode)
    g.stmts(fdef.body)

    decls, bindings = [], []
    for k, arr in enumerate(g.used):
        acc = "read_write" if arr.write else "read"
        elem = "atomic<i32>" if arr.atomic else _WTY[arr.dtype]
        decls.append("@group(0) @binding(%d) var<storage, %s> %s: array<%s>;" % (k, acc, arr.w, elem))
        bindings.append({"param": arr.param, "wname": arr.w, "dtype": "i32" if arr.dtype == I32 else _BIND[arr.dtype],
                         "shape": list(arr.shape), "write": bool(arr.write), "atomic": bool(arr.atomic)})
    head = "@compute @workgroup_size(%d, %d, 1)\nfn main(@builtin(global_invocation_id) gid: vec3<u32>) {" % (threads[0], threads[1])
    lib = (DD_LIB + "\n") if fmode == DD else ""
    wgsl = "// 由 numba 核心轉譯（GPU 相容層）\n" + lib + "\n".join(decls) + "\n\n" + head + "\n" \
        + "\n".join(g.lines) + ("\n" if g.lines else "") + "}\n"
    return Plan(wgsl, bindings, (int(blocks[0]), int(blocks[1])), fmode)
