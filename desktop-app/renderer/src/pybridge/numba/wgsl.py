# -*- coding: utf-8 -*-
"""
numba.cuda 核心 → WGSL 轉譯（GPU 相容層，第一批；DESIGN.webgpu-cuda.md §4）。

支援：
- cuda.grid(1)、cuda.grid(2)（對應 WGSL 的 global_invocation_id.x／.y；工作群組大小 = kernel[blocks, threads] 的 threads）
- 一維與二維陣列（二維用 arr[r, c]，列主序）、arr.size、arr.shape[d]（形狀在轉譯時是常數）
- 純量參數（Python int／float）以常數寫進 WGSL 原始碼
- 區域變數、賦值、+= 等擴充賦值、if／else、for i in range(...)、return
- 算術（+ - * / // % **）、比較、and／or／not、min／max／abs／float／int、math.sqrt 等
- cuda.atomic.add（int32 陣列，WGSL atomicAdd）

不支援（丟 NotCompilable，訊息帶行號與原因，上層會在本機 Python 模擬並說明原因）：
shared 記憶體與 syncthreads（下一批）、float64／int64 陣列、float32 原子、try、lambda、推導式、遞迴、print 等。

注意：Python 的 // 與 WGSL 的整數除法對負數的取整不同（WGSL 向零取整）；核心的索引通常是非負數，所以結果一致。
"""
import ast
import math

import numpy as np


class NotCompilable(RuntimeError):
    """核心不能轉成 WGSL；字串是給使用者看的具體原因。"""


F32, I32, BOOL = "f32", "i32", "bool"
_DT = {np.dtype(np.float32): F32, np.dtype(np.int32): I32}
_MATH1 = {"sqrt": "sqrt", "exp": "exp", "log": "log", "sin": "sin", "cos": "cos", "tan": "tan",
          "tanh": "tanh", "floor": "floor", "ceil": "ceil", "fabs": "abs"}
_WTY = {F32: "f32", I32: "i32", BOOL: "bool"}


def _lit(v):
    """Python 常數 → (WGSL 運算式, 型別)。"""
    if isinstance(v, (bool, np.bool_)):
        return ("true" if v else "false"), BOOL
    if isinstance(v, (int, np.integer)):
        iv = int(v)
        if not -(2 ** 31) <= iv < 2 ** 31:
            raise NotCompilable("整數常數 %d 超出 i32 範圍" % iv)
        return "(%di)" % iv, I32
    if isinstance(v, (float, np.floating)):
        fv = float(v)
        if not math.isfinite(fv):
            raise NotCompilable("浮點常數不是有限數字（%r）" % fv)
        s = repr(fv)
        if "." not in s and "e" not in s and "E" not in s:
            s += ".0"
        return "(%sf)" % s, F32
    raise NotCompilable("不支援的常數型別 %s" % type(v).__name__)


def _is_cuda_attr(n, attr):
    return isinstance(n, ast.Attribute) and n.attr == attr and isinstance(n.value, ast.Name) and n.value.id == "cuda"


def _is_grid_call(n):
    return isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "grid" \
        and isinstance(n.func.value, ast.Name) and n.func.value.id == "cuda"


def _is_atomic_add(n):
    return isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "add" \
        and _is_cuda_attr(n.func.value, "atomic")


class _Arr(object):
    def __init__(self, param, dtype, shape):
        self.param = param
        self.w = "a_" + param
        self.dtype = dtype
        self.shape = tuple(shape)
        self.atomic = False
        self.write = False


class Plan(object):
    """轉譯結果：WGSL 原始碼、綁定（依 binding 編號排列）、工作群組數。"""

    def __init__(self, wgsl, bindings, groups):
        self.wgsl = wgsl
        self.bindings = bindings  # 每個 dict：param（numba 參數名）、wname（WGSL 名）、dtype、shape、write、atomic
        self.groups = groups


class _Gen(object):
    def __init__(self, arrays, consts, threads):
        self.arrays = arrays
        self.consts = consts
        self.threads = threads
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

    def coerce(self, node, code, t, to):
        if t == to:
            return code
        if to == F32 and t == I32:
            return "f32(%s)" % code
        if to == I32 and t == F32:
            return "i32(%s)" % code
        self.err(node, "型別不相容（%s 與 %s）" % (t, to))

    def boolean(self, node, code, t):
        if t == BOOL:
            return code
        if t == I32:
            return "(%s != 0i)" % code
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
            return _lit(n.value)
        if isinstance(n, ast.Name):
            if n.id in self.locals:
                return self.locals[n.id]
            if n.id in self.consts:
                return self.consts[n.id]
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
                return "(-%s)" % c, t
            if isinstance(n.op, ast.UAdd):
                return c, t
            self.err(n, "不支援的一元運算")
        if isinstance(n, ast.BinOp):
            return self.binop(n)
        if isinstance(n, ast.Compare):
            if len(n.ops) != 1:
                self.err(n, "不支援鏈式比較（請改成 and）")
            ops = {ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=", ast.Eq: "==", ast.NotEq: "!="}
            op = ops.get(type(n.ops[0]))
            if op is None:
                self.err(n, "不支援的比較運算")
            a, at = self.expr(n.left)
            b, bt = self.expr(n.comparators[0])
            if BOOL in (at, bt):
                self.err(n, "布林值不能直接比較")
            t = F32 if F32 in (at, bt) else I32
            return "(%s %s %s)" % (self.coerce(n, a, at, t), op, self.coerce(n, b, bt, t)), BOOL
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

    def binop(self, n):
        a, at = self.expr(n.left)
        b, bt = self.expr(n.right)
        if BOOL in (at, bt):
            self.err(n, "布林值不能參與算術運算")
        op = type(n.op)
        if op in (ast.Add, ast.Sub, ast.Mult):
            sym = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*"}[op]
            t = F32 if F32 in (at, bt) else I32
            return "(%s %s %s)" % (self.coerce(n, a, at, t), sym, self.coerce(n, b, bt, t)), t
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

    def call(self, n):
        f = n.func
        if isinstance(f, ast.Name) and f.id in ("min", "max") and len(n.args) == 2:
            a, at = self.expr(n.args[0])
            b, bt = self.expr(n.args[1])
            t = F32 if F32 in (at, bt) else I32
            return "%s(%s, %s)" % (f.id, self.coerce(n, a, at, t), self.coerce(n, b, bt, t)), t
        if isinstance(f, ast.Name) and f.id == "abs" and len(n.args) == 1:
            a, at = self.expr(n.args[0])
            if at == BOOL:
                self.err(n, "abs 不能用在布林值")
            return "abs(%s)" % a, at
        if isinstance(f, ast.Name) and f.id in ("float", "int") and len(n.args) == 1:
            a, at = self.expr(n.args[0])
            to = F32 if f.id == "float" else I32
            return self.coerce(n, a, at, to), to
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "math" \
                and f.attr in _MATH1 and len(n.args) == 1:
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
                if lt == F32 and t == I32:
                    c = "f32(%s)" % c
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


def compile_kernel(name, src, values, blocks, threads):
    """把 numba 核心轉成 WGSL。values 是依參數順序的 numpy 陣列或 Python 純量。丟 NotCompilable 時帶具體原因。"""
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
            dt = _DT.get(v.dtype)
            if dt is None:
                raise NotCompilable("參數 %s 是 %s 陣列；WebGPU 第一批只支援 float32 與 int32（改成 float32 會改變數值精度，所以不自動轉換）" % (p, v.dtype))
            if v.ndim not in (1, 2):
                raise NotCompilable("參數 %s 是 %d 維陣列，第一批只支援一維與二維" % (p, v.ndim))
            arrays[p] = _Arr(p, dt, v.shape)
        elif isinstance(v, (bool, int, float, np.integer, np.floating, np.bool_)):
            consts[p] = _lit(v)
        else:
            raise NotCompilable("參數 %s 的型別 %s 不支援" % (p, type(v).__name__))
    _mark_atomics(fdef, arrays)
    g = _Gen(arrays, consts, threads)
    g.stmts(fdef.body)

    decls, bindings = [], []
    for k, arr in enumerate(g.used):
        acc = "read_write" if arr.write else "read"
        elem = "atomic<i32>" if arr.atomic else _WTY[arr.dtype]
        decls.append("@group(0) @binding(%d) var<storage, %s> %s: array<%s>;" % (k, acc, arr.w, elem))
        bindings.append({"param": arr.param, "wname": arr.w, "dtype": "i32" if arr.dtype == I32 else "f32",
                         "shape": list(arr.shape), "write": bool(arr.write), "atomic": bool(arr.atomic)})
    head = "@compute @workgroup_size(%d, %d, 1)\nfn main(@builtin(global_invocation_id) gid: vec3<u32>) {" % (threads[0], threads[1])
    wgsl = "// 由 numba 核心轉譯（GPU 相容層第一批）\n" + "\n".join(decls) + "\n\n" + head + "\n" \
        + "\n".join(g.lines) + ("\n" if g.lines else "") + "}\n"
    return Plan(wgsl, bindings, (int(blocks[0]), int(blocks[1])))
