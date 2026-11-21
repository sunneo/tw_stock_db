# -*- coding: utf-8 -*-
"""
numba.cuda 核心 → OpenCL C 的轉譯（cudaweb 的 CPU 原生路線；DESIGN.pyopencl.md §16）。

cudaweb 的任意核心原本只有兩條路：轉成 WGSL 在 WebGPU 執行（numba/wgsl.py），或退回本機 Python 逐執行緒模擬（慢）。
這個模組補上中間那條：把同一份 Python 核心翻成 OpenCL C，交給 pyopencl 後端（載入器：source→SPIR-V→wasm，不支援就退回 JS）在 CPU 上以原生速度執行。
float64 在 wasm 裡是原生 double，所以 cudaCompatFloat64=exact 也能原生跑（不必降精度）。

支援（超出就丟 NotCL，由呼叫端退回 Python 模擬；訊息帶行號與原因）：
- cuda.grid(1)、x, y = cuda.grid(2)、cuda.threadIdx／blockIdx／blockDim／gridDim 的 .x .y .z
- 一維與二維陣列（二維 arr[r, c]，列主序）、arr.size、arr.shape[d]、len(arr)（形狀在轉譯時是常數）；dtype：float32、float64、int32、int64
- 純量參數（Python int／float／bool：int 是 64 位元 long、float 是 double，與 numba 相同）
- 區域變數（型別由賦值推論，與 numba 的提升規則一致：int64 與 float32 混合得 float64）、賦值、擴充賦值、if／else、for i in range(...)（步長必須是常數）、while、break、continue、return（不帶值）
- 算術（+ - * / // % **，Python 語意：// 向下取整、% 的符號跟除數）、位元運算、比較（含鏈式）、and／or／not（只能放在條件裡）、?:、min／max／abs／int／float／bool／round／len、math.*、cuda.atomic.add（int32 陣列）
不支援：shared 記憶體與 syncthreads（工作群協作需要執行緒）、float32 以外的其他 dtype、遞迴、字串、串列、推導式、try、print、and／or 當值使用。
"""
import ast
import math


class NotCL(RuntimeError):
    """核心不能轉成 OpenCL C；字串是給使用者看的具體原因。"""


_CT = {"float32": "float", "float64": "double", "int32": "int", "int64": "long"}
_ELEM = {"float32": "float", "float64": "double", "int32": "long", "int64": "long"}   # 載入後的 Python 型別（整數一律 long）
_MATH1 = {"sqrt": "sqrt", "exp": "exp", "log": "log", "log2": "log2", "log10": "log10", "sin": "sin", "cos": "cos", "tan": "tan", "tanh": "tanh", "sinh": "sinh", "cosh": "cosh",
          "asin": "asin", "acos": "acos", "atan": "atan", "fabs": "fabs"}
_MATH2 = {"pow": "pow", "atan2": "atan2", "hypot": "hypot", "fmod": "fmod"}
_CMP = {ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=", ast.Eq: "==", ast.NotEq: "!="}
_PRE = """static long pfdiv(long a, long b) { long q = a / b; if ((a % b != 0) && ((a < 0) != (b < 0))) q -= 1; return q; }
static long pmod(long a, long b) { long r = a % b; if (r != 0 && ((r < 0) != (b < 0))) r += b; return r; }
"""


def _unify(a, b):
    """兩個型別的提升（numba 規則）：bool<long；long 與 float32 → double；float32 與 float32 → float；有 double 就是 double。"""
    if a is None:
        return b
    if b is None or a == b:
        return a
    s = {a, b}
    if "double" in s or s == {"long", "float"}:
        return "double"
    if s == {"bool", "long"}:
        return "long"
    if s == {"bool", "float"}:
        return "float"
    return "double"


def _lit(v):
    if isinstance(v, bool):
        return ("1" if v else "0", "bool")
    if isinstance(v, int):
        if not (-2 ** 63 <= v < 2 ** 63):
            raise NotCL("整數常數 %d 超出 64 位元" % v)
        return ("%dL" % v if abs(v) > 2147483647 else "%d" % v, "long")   # 小的整數字面值在 C 裡是 int，運算前會提升成 long
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            raise NotCL("常數 %r 不能寫成 OpenCL C 字面值" % v)
        r = repr(v)
        return (r if ("." in r or "e" in r or "E" in r) else r + ".0", "double")
    raise NotCL("不支援的常數 %r" % (v,))


class _Gen(object):
    def __init__(self, fdef, values, blocks, threads):
        self.fdef = fdef
        self.names = [a.arg for a in fdef.args.args]
        if len(self.names) != len(values):
            raise NotCL("參數個數與呼叫不符")
        self.arrays, self.scalars, self.shapes = {}, {}, {}
        import numpy as np
        for n, v in zip(self.names, values):
            if isinstance(v, np.ndarray):
                dt = str(v.dtype)
                if dt not in _CT:
                    raise NotCL("參數 %s 的 dtype 是 %s（支援 float32／float64／int32／int64）" % (n, dt))
                if v.ndim not in (1, 2):
                    raise NotCL("參數 %s 是 %d 維陣列（支援一維與二維）" % (n, v.ndim))
                if not v.flags.c_contiguous:
                    raise NotCL("參數 %s 不是 C 連續的陣列" % n)
                self.arrays[n] = dt
                self.shapes[n] = tuple(int(x) for x in v.shape)
            elif isinstance(v, (bool, np.bool_)):
                self.scalars[n] = "long"
            elif isinstance(v, (int, np.integer)):
                self.scalars[n] = "long"
            elif isinstance(v, (float, np.floating)):
                self.scalars[n] = "double"
            else:
                raise NotCL("參數 %s 的型別 %s 不支援" % (n, type(v).__name__))
        self.locals = {}
        self.writes = set()
        self.tmp = 0
        self.grid_vars = set()

    # ---- 錯誤
    def err(self, node, msg):
        raise NotCL("第 %d 行：%s" % (getattr(node, "lineno", 0), msg))

    # ---- 型別推論（掃描賦值；跑兩輪讓前向依賴穩定）
    def infer(self):
        for _ in range(3):
            for st in ast.walk(self.fdef):
                if isinstance(st, ast.Assign):
                    if len(st.targets) != 1:
                        self.err(st, "不支援連續賦值")
                    t = st.targets[0]
                    if isinstance(t, ast.Name):
                        self._bind(t.id, self._tyof(st.value), st)
                    elif isinstance(t, ast.Tuple):
                        if not self._is_grid2(st.value):
                            self.err(st, "元組解包只支援 x, y = cuda.grid(2)")
                        for e in t.elts:
                            if not isinstance(e, ast.Name):
                                self.err(st, "元組解包的目標要是名稱")
                            self._bind(e.id, "long", st)
                elif isinstance(st, ast.AugAssign) and isinstance(st.target, ast.Name):
                    if st.target.id not in self.locals and st.target.id not in self.scalars:
                        self.err(st, "擴充賦值的變數 %s 還沒有賦值" % st.target.id)
                    if st.target.id in self.locals:
                        self._bind(st.target.id, self._bin_ty(st.op, self.locals[st.target.id], self._tyof(st.value), st), st)
                elif isinstance(st, ast.For):
                    if isinstance(st.target, ast.Name):
                        self._bind(st.target.id, "long", st)
                    else:
                        self.err(st, "for 的迴圈變數要是單一名稱")

    def _bind(self, name, ty, node):
        if name in self.arrays:
            self.err(node, "不能對陣列參數 %s 重新賦值" % name)
        if name in self.scalars:
            if _unify(self.scalars[name], ty) != self.scalars[name]:
                self.err(node, "不能把參數 %s（%s）賦值成 %s（型別會改變）" % (name, self.scalars[name], ty))
            return
        self.locals[name] = _unify(self.locals.get(name), ty)

    def _is_grid2(self, n):
        return isinstance(n, ast.Call) and self._is_attr(n.func, "grid") and len(n.args) == 1 and isinstance(n.args[0], ast.Constant) and n.args[0].value == 2

    @staticmethod
    def _is_attr(n, attr):
        return isinstance(n, ast.Attribute) and n.attr == attr and isinstance(n.value, ast.Name) and n.value.id == "cuda"

    def _tyof(self, node):
        return self.E(node, dry=True)[1]

    def _bin_ty(self, op, a, b, node):
        if isinstance(op, ast.Div):
            return "float" if (a == "float" and b == "float") else "double"
        if isinstance(op, (ast.LShift, ast.RShift, ast.BitAnd, ast.BitOr, ast.BitXor)):
            return "long"
        t = _unify(a, b)
        if t == "bool":
            t = "long"
        if isinstance(op, ast.Pow) and a in ("long", "bool") and b in ("long", "bool"):
            return "long"
        return t

    # ---- 運算式：回傳 (C 程式碼, 型別)。dry＝只算型別（推論用）
    def cast(self, code, frm, to):
        if frm == to or (frm == "bool" and to == "long"):
            return code
        return "((%s)(%s))" % ({"long": "long", "double": "double", "float": "float", "bool": "int"}[to], code)

    def E(self, n, dry=False):
        t = type(n)
        if t is ast.Constant:
            return _lit(n.value)
        if t is ast.Name:
            if n.id in self.locals:
                return (n.id, self.locals[n.id])
            if n.id in self.scalars:
                return (n.id, self.scalars[n.id])
            if n.id in self.arrays:
                self.err(n, "陣列 %s 要加索引才能使用" % n.id)
            if n.id in ("True", "False"):
                return ("1" if n.id == "True" else "0", "bool")
            if dry:
                return ("0", "long")   # 前向引用（還沒賦值的區域變數）：先當 long，下一輪會修正
            self.err(n, "未定義的名稱 %s" % n.id)
        if t is ast.BinOp:
            return self.binop(n, dry)
        if t is ast.UnaryOp:
            c, ty = self.E(n.operand, dry)
            if isinstance(n.op, ast.USub):
                return ("(-%s)" % self.cast(c, ty, "long" if ty == "bool" else ty), "long" if ty == "bool" else ty)
            if isinstance(n.op, ast.UAdd):
                return (c, "long" if ty == "bool" else ty)
            if isinstance(n.op, ast.Not):
                return ("(!(%s))" % self.truth(c, ty), "bool")
            if isinstance(n.op, ast.Invert):
                if ty not in ("long", "bool"):
                    self.err(n, "~ 只能用在整數")
                return ("(~%s)" % self.cast(c, ty, "long"), "long")
        if t is ast.Compare:
            return (self.compare(n, dry), "bool")
        if t is ast.BoolOp:
            self.err(n, "and／or 只能放在條件裡（當值使用時 Python 回傳的是運算元本身，不是布林）")
        if t is ast.IfExp:
            cc = self.cond(n.test, dry)
            a, ta = self.E(n.body, dry)
            b, tb = self.E(n.orelse, dry)
            tt = _unify("long" if ta == "bool" else ta, "long" if tb == "bool" else tb)
            return ("(%s ? %s : %s)" % (cc, self.cast(a, ta, tt), self.cast(b, tb, tt)), tt)
        if t is ast.Subscript:
            return self.subscript(n, dry)
        if t is ast.Attribute:
            return self.attribute(n)
        if t is ast.Call:
            return self.call(n, dry)
        self.err(n, "不支援的運算式 %s" % t.__name__)

    def truth(self, c, ty):
        return c if ty == "bool" else "(%s) != 0" % c

    def cond(self, n, dry=False):
        if isinstance(n, ast.BoolOp):
            op = " && " if isinstance(n.op, ast.And) else " || "
            return "(" + op.join("(%s)" % self.cond(v, dry) for v in n.values) + ")"
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Not):
            return "(!(%s))" % self.cond(n.operand, dry)
        c, ty = self.E(n, dry)
        return self.truth(c, ty)

    def compare(self, n, dry):
        parts, left = [], n.left
        for op, right in zip(n.ops, n.comparators):
            if type(op) not in _CMP:
                self.err(n, "不支援的比較（in／is 等）")
            if len(n.ops) > 1 and not isinstance(left, (ast.Name, ast.Constant)):
                self.err(n, "鏈式比較的中間項要是單一名稱或常數")
            a, ta = self.E(left, dry)
            b, tb = self.E(right, dry)
            tt = _unify("long" if ta == "bool" else ta, "long" if tb == "bool" else tb)
            parts.append("(%s %s %s)" % (self.cast(a, ta, tt), _CMP[type(op)], self.cast(b, tb, tt)))
            left = right
        return "(" + " && ".join(parts) + ")" if len(parts) > 1 else parts[0]

    def binop(self, n, dry):
        a, ta = self.E(n.left, dry)
        b, tb = self.E(n.right, dry)
        op = n.op
        if isinstance(op, (ast.LShift, ast.RShift, ast.BitAnd, ast.BitOr, ast.BitXor)):
            if ta not in ("long", "bool") or tb not in ("long", "bool"):
                self.err(n, "位元運算只能用在整數")
            sym = {ast.LShift: "<<", ast.RShift: ">>", ast.BitAnd: "&", ast.BitOr: "|", ast.BitXor: "^"}[type(op)]
            return ("(%s %s %s)" % (self.cast(a, ta, "long"), sym, self.cast(b, tb, "long")), "long")
        rt = self._bin_ty(op, ta, tb, n)
        ints = ta in ("long", "bool") and tb in ("long", "bool")
        if isinstance(op, ast.Div):
            return ("(%s / %s)" % (self.cast(a, ta, rt), self.cast(b, tb, rt)), rt)
        if isinstance(op, ast.FloorDiv):
            if ints:
                return ("pfdiv(%s, %s)" % (self.cast(a, ta, "long"), self.cast(b, tb, "long")), "long")
            return ("floor(%s / %s)" % (self.cast(a, ta, rt), self.cast(b, tb, rt)), rt)
        if isinstance(op, ast.Mod):
            if ints:
                return ("pmod(%s, %s)" % (self.cast(a, ta, "long"), self.cast(b, tb, "long")), "long")
            x, y = self.cast(a, ta, rt), self.cast(b, tb, rt)
            return ("(%s - %s * floor(%s / %s))" % (x, y, x, y), rt)
        if isinstance(op, ast.Pow):
            if ints:
                if isinstance(n.right, ast.Constant) and isinstance(n.right.value, int) and 0 <= n.right.value <= 4:
                    k = n.right.value
                    return ("(%s)" % (" * ".join(["(" + self.cast(a, ta, "long") + ")"] * k) if k else "1"), "long")
                return ("((long)pow((double)(%s), (double)(%s)))" % (a, b), "long")
            return ("pow(%s, %s)" % (self.cast(a, ta, rt), self.cast(b, tb, rt)), rt)
        sym = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*"}.get(type(op))
        if sym is None:
            self.err(n, "不支援的運算 %s" % type(op).__name__)
        return ("(%s %s %s)" % (self.cast(a, ta, rt), sym, self.cast(b, tb, rt)), rt)

    def subscript(self, n, dry):
        v = n.value
        if isinstance(v, ast.Attribute) and v.attr == "shape" and isinstance(v.value, ast.Name) and v.value.id in self.arrays:   # arr.shape[d]
            d = n.slice
            if not (isinstance(d, ast.Constant) and isinstance(d.value, int)):
                self.err(n, "shape 的索引要是常數")
            sh = self.shapes[v.value.id]
            if not 0 <= d.value < len(sh):
                self.err(n, "shape[%d] 超出維度" % d.value)
            return ("%d" % sh[d.value], "long")
        if not (isinstance(v, ast.Name) and v.id in self.arrays):
            self.err(n, "只能對陣列參數做索引")
        return ("%s[%s]" % (v.id, self.index(v.id, n.slice, dry)), _ELEM[self.arrays[v.id]])

    def index(self, name, sl, dry):
        sh = self.shapes[name]
        if isinstance(sl, ast.Tuple):
            if len(sl.elts) != len(sh):
                self.err(sl, "陣列 %s 是 %d 維，索引給了 %d 個" % (name, len(sh), len(sl.elts)))
            parts = []
            for k, e in enumerate(sl.elts):
                c, ty = self.E(e, dry)
                if ty not in ("long", "bool"):
                    self.err(e, "索引要是整數")
                parts.append("(%s)" % self.cast(c, ty, "long"))
            if len(parts) == 2:
                return "%s * %dL + %s" % (parts[0], sh[1], parts[1])
            return parts[0]
        if len(sh) != 1:
            self.err(sl, "陣列 %s 是 %d 維，要用 %s[r, c] 索引" % (name, len(sh), name))
        c, ty = self.E(sl, dry)
        if ty not in ("long", "bool"):
            self.err(sl, "索引要是整數")
        if isinstance(sl, ast.UnaryOp) and isinstance(sl.op, ast.USub) and isinstance(sl.operand, ast.Constant):   # a[-1]：Python 的環繞
            return "%d" % (sh[0] - sl.operand.value)
        return self.cast(c, ty, "long")

    def attribute(self, n):
        if isinstance(n.value, ast.Name) and n.value.id in self.arrays:
            sh = self.shapes[n.value.id]
            if n.attr == "size":
                return ("%dL" % int(math.prod(sh)), "long")
            if n.attr == "ndim":
                return ("%d" % len(sh), "long")
            self.err(n, "陣列只支援 .size、.ndim、.shape[d]")
        if isinstance(n.value, ast.Name) and n.value.id == "math":
            if n.attr == "pi":
                return (repr(math.pi), "double")
            if n.attr == "e":
                return (repr(math.e), "double")
        if isinstance(n.value, ast.Attribute) and isinstance(n.value.value, ast.Name) and n.value.value.id == "cuda" and n.attr in ("x", "y", "z"):
            fn = {"threadIdx": "get_local_id", "blockIdx": "get_group_id", "blockDim": "get_local_size", "gridDim": "get_num_groups"}.get(n.value.attr)
            if fn:
                return ("((long)%s(%d))" % (fn, "xyz".index(n.attr)), "long")
        self.err(n, "不支援的屬性 %s" % ast.dump(n)[:60])

    def call(self, n, dry):
        f = n.func
        args = [self.E(a, dry) for a in n.args] if not (isinstance(f, ast.Attribute) and (f.attr == "add" or f.attr == "array")) else []
        if n.keywords:
            self.err(n, "不支援關鍵字引數")
        if isinstance(f, ast.Name):
            nm = f.id
            if nm in ("min", "max") and len(args) == 2:
                (a, ta), (b, tb) = args
                rt = _unify("long" if ta == "bool" else ta, "long" if tb == "bool" else tb)
                if rt == "long":
                    return ("%s(%s, %s)" % (nm, self.cast(a, ta, "long"), self.cast(b, tb, "long")), "long")
                return ("f%s(%s, %s)" % (nm, self.cast(a, ta, rt), self.cast(b, tb, rt)), rt)
            if nm == "abs" and len(args) == 1:
                a, ta = args[0]
                return (("((long)abs(%s))" % self.cast(a, ta, "long"), "long") if ta in ("long", "bool") else ("fabs(%s)" % a, ta))
            if nm == "int" and len(args) == 1:
                return ("((long)(%s))" % args[0][0], "long")
            if nm == "float" and len(args) == 1:
                return ("((double)(%s))" % args[0][0], "double")
            if nm == "bool" and len(args) == 1:
                return ("(((%s) != 0) ? 1 : 0)" % args[0][0], "bool")
            if nm == "round" and len(args) == 1:
                return ("((long)rint(%s))" % args[0][0], "long")
            if nm == "len" and len(n.args) == 1 and isinstance(n.args[0], ast.Name) and n.args[0].id in self.arrays:
                return ("%dL" % self.shapes[n.args[0].id][0], "long")
            self.err(n, "不支援呼叫 %s()" % nm)
        if isinstance(f, ast.Attribute):
            if self._is_attr(f, "grid") and len(n.args) == 1 and isinstance(n.args[0], ast.Constant) and n.args[0].value == 1:
                return ("((long)get_global_id(0))", "long")
            if isinstance(f.value, ast.Name) and f.value.id == "math":
                if f.attr in _MATH1 and len(args) == 1:
                    a, ta = args[0]
                    rt = "float" if ta == "float" else "double"
                    return ("%s(%s)" % (_MATH1[f.attr], self.cast(a, ta, rt)), rt)
                if f.attr in _MATH2 and len(args) == 2:
                    (a, ta), (b, tb) = args
                    rt = "float" if (ta == "float" and tb == "float") else "double"
                    return ("%s(%s, %s)" % (_MATH2[f.attr], self.cast(a, ta, rt), self.cast(b, tb, rt)), rt)
                if f.attr in ("floor", "ceil") and len(args) == 1:
                    a, ta = args[0]
                    return ("((long)%s(%s))" % (f.attr, self.cast(a, ta, "double")), "long")
                self.err(n, "不支援 math.%s" % f.attr)
            if isinstance(f.value, ast.Attribute) and self._is_attr(f.value, "atomic") and f.attr == "add":
                self.err(n, "cuda.atomic.add 要當成敘述使用（回傳舊值的用法不支援）")
        self.err(n, "不支援的呼叫")

    # ---- 敘述
    def S(self, body, ind, out):
        pad = "    " * ind
        for st in body:
            t = type(st)
            if t is ast.Expr:
                v = st.value
                if isinstance(v, ast.Constant):
                    continue   # docstring
                if isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr == "add" and isinstance(v.func.value, ast.Attribute) and self._is_attr(v.func.value, "atomic"):
                    if len(v.args) != 3 or not isinstance(v.args[0], ast.Name) or v.args[0].id not in self.arrays or self.arrays[v.args[0].id] != "int32":
                        self.err(st, "cuda.atomic.add 只支援 int32 陣列：cuda.atomic.add(arr, idx, val)")
                    an = v.args[0].id
                    val, tv = self.E(v.args[2])
                    if tv not in ("long", "bool"):
                        self.err(st, "cuda.atomic.add 的值要是整數")
                    self.writes.add(an)
                    out.append("%satomic_add(&%s[%s], (int)(%s));" % (pad, an, self.index(an, v.args[1], False), val))
                    continue
                if isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr == "syncthreads":
                    self.err(st, "cuda.syncthreads（工作群協作需要執行緒；本環境沒有 SharedArrayBuffer）")
                self.err(st, "不支援的敘述（運算式敘述只能是 cuda.atomic.add）")
            elif t is ast.Assign:
                tg = st.targets[0]
                if isinstance(tg, ast.Name):
                    c, ty = self.E(st.value)
                    dest = self.scalars.get(tg.id) or self.locals[tg.id]
                    out.append("%s%s = %s;" % (pad, tg.id, self.cast(c, ty, dest)))
                elif isinstance(tg, ast.Subscript):
                    self.store(tg, st.value, None, pad, out)
                elif isinstance(tg, ast.Tuple):
                    out.append("%s%s = (long)get_global_id(0); %s = (long)get_global_id(1);" % (pad, tg.elts[0].id, tg.elts[1].id))
                else:
                    self.err(st, "不支援的賦值目標")
            elif t is ast.AugAssign:
                tg = st.target
                if isinstance(tg, ast.Name):
                    cur = (tg.id, self.scalars.get(tg.id) or self.locals[tg.id])
                    c, ty = self.binop(ast.BinOp(left=ast.Name(id=tg.id, ctx=ast.Load()), op=st.op, right=st.value), False)
                    out.append("%s%s = %s;" % (pad, tg.id, self.cast(c, ty, cur[1])))
                elif isinstance(tg, ast.Subscript):
                    self.store(tg, st.value, st.op, pad, out)
                else:
                    self.err(st, "不支援的擴充賦值目標")
            elif t is ast.If:
                out.append("%sif (%s) {" % (pad, self.cond(st.test)))
                self.S(st.body, ind + 1, out)
                if st.orelse:
                    out.append("%s} else {" % pad)
                    self.S(st.orelse, ind + 1, out)
                out.append("%s}" % pad)
            elif t is ast.While:
                if st.orelse:
                    self.err(st, "不支援 while 的 else")
                out.append("%swhile (%s) {" % (pad, self.cond(st.test)))
                self.S(st.body, ind + 1, out)
                out.append("%s}" % pad)
            elif t is ast.For:
                self.for_(st, ind, out)
            elif t is ast.Return:
                if st.value is not None:
                    self.err(st, "核心不能回傳值")
                out.append("%sreturn;" % pad)
            elif t is ast.Break:
                out.append("%sbreak;" % pad)
            elif t is ast.Continue:
                out.append("%scontinue;" % pad)
            elif t is ast.Pass:
                pass
            else:
                self.err(st, "不支援的敘述 %s" % t.__name__)

    def store(self, tg, value, op, pad, out):
        if not (isinstance(tg.value, ast.Name) and tg.value.id in self.arrays):
            self.err(tg, "只能寫入陣列參數的元素")
        an = tg.value.id
        self.writes.add(an)
        idx = self.index(an, tg.slice, False)
        et = _ELEM[self.arrays[an]]
        if op is None:
            c, ty = self.E(value)
        else:
            c, ty = self.binop(ast.BinOp(left=tg, op=op, right=value), False)
        out.append("%s%s[%s] = %s;" % (pad, an, idx, self.cast(c, ty, et) if self.arrays[an] not in ("int32",) else "((int)(%s))" % c))

    def for_(self, st, ind, out):
        pad = "    " * ind
        it = st.iter
        if st.orelse:
            self.err(st, "不支援 for 的 else")
        if not (isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == "range" and 1 <= len(it.args) <= 3):
            self.err(st, "for 只支援 range(...)")
        vals = []
        for a in it.args:
            c, ty = self.E(a)
            if ty not in ("long", "bool"):
                self.err(a, "range 的引數要是整數")
            vals.append(self.cast(c, ty, "long"))
        step = 1
        if len(it.args) == 3:
            s = it.args[2]
            if isinstance(s, ast.UnaryOp) and isinstance(s.op, ast.USub) and isinstance(s.operand, ast.Constant) and isinstance(s.operand.value, int):
                step = -s.operand.value
            elif isinstance(s, ast.Constant) and isinstance(s.value, int):
                step = s.value
            else:
                self.err(st, "range 的步長要是整數常數")
            if step == 0:
                self.err(st, "range 的步長不能是 0")
        start, stop = ("0", vals[0]) if len(vals) == 1 else (vals[0], vals[1])
        self.tmp += 1
        tmp = "_stop%d" % self.tmp
        v = st.target.id
        out.append("%s{ long %s = %s;" % (pad, tmp, stop))
        out.append("%sfor (%s = %s; %s %s %s; %s += %dL) {" % (pad, v, start, v, "<" if step > 0 else ">", tmp, v, step))
        self.S(st.body, ind + 1, out)
        out.append("%s} }" % pad)

    def build(self, name, blocks, threads):
        self.infer()
        body = []
        self.S(self.fdef.body, 1, body)
        params = []
        for n in self.names:
            if n in self.arrays:
                params.append("__global %s%s* %s" % ("" if n in self.writes else "const ", _CT[self.arrays[n]], n))
            else:
                params.append("%s %s" % (self.scalars[n], n))
        decl = ["    %s %s = 0;" % (ty if ty != "bool" else "long", n) for n, ty in self.locals.items() if n not in self.scalars]
        kname = "cw_" + name
        code = _PRE + "__kernel void %s(%s) {\n%s\n%s\n}\n" % (kname, ", ".join(params), "\n".join(decl), "\n".join(body))
        return kname, code


def compile_kernel(name, src, values, blocks, threads):
    """回傳 dict：code（OpenCL C）、name、args（[(參數名, 'buf'|'scalar', numpy dtype 字串)]）、writes（核心會寫的陣列名）、global、local。"""
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        raise NotCL("核心原始碼解析失敗：%s" % e)
    fdef = next((n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name), None)
    if fdef is None:
        raise NotCL("找不到核心函式 %s" % name)
    for node in ast.walk(fdef):
        if isinstance(node, (ast.Lambda, ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp, ast.Try, ast.With, ast.Global, ast.Nonlocal, ast.Yield, ast.Await)):
            raise NotCL("第 %d 行：不支援 %s" % (getattr(node, "lineno", 0), type(node).__name__))
    g = _Gen(fdef, values, blocks, threads)
    kname, code = g.build(name, blocks, threads)
    b = tuple(blocks) + (1,) * (3 - len(blocks))
    t = tuple(threads) + (1,) * (3 - len(threads))
    dims = 3 if (b[2] > 1 or t[2] > 1) else 2 if (b[1] > 1 or t[1] > 1) else 1
    return {"code": code, "name": kname, "args": [(n, "buf" if n in g.arrays else "scalar", g.arrays.get(n) or g.scalars[n]) for n in g.names],
            "writes": set(g.writes), "global": tuple(b[d] * t[d] for d in range(dims)), "local": tuple(t[:dims])}
