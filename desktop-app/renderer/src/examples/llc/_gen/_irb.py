# -*- coding: utf-8 -*-
"""極小的 LLVM IR 產生器（examples/llc 的 .ll 是用它寫的，輸出仍是普通的 .ll 文字；不是編譯器）。
V＝帶型別的值，運算子重載（+ - * / % < <= > >= == != & | ^ << >>）；Var＝可變的區域變數（alloca，+= 等）；f.loop／f.if_／f.while_ 產生迴圈與分支（不用 phi）。
目標子集跟瀏覽器內的 IR 編譯器一樣：i1／i8／i32／i64／float／double／ptr，alloca／load／store／gep／呼叫，沒有 phi 與函式指標呼叫。"""
import struct
from contextlib import contextmanager


def f64(x):
    return "0x%016X" % struct.unpack(">Q", struct.pack(">d", float(x)))[0]


def f32(x):
    return f64(struct.unpack("f", struct.pack("f", float(x)))[0])


INT = {"i1": 1, "i8": 8, "i32": 32, "i64": 64}
FLT = ("float", "double")


def esc(data):
    out = []
    for b in data:
        out.append(chr(b) if 32 <= b < 127 and b not in (34, 92) else "\\%02X" % b)
    return "".join(out)


class V(object):
    def __init__(self, f, name, ty, elem=None):
        self.f, self.name, self.ty, self.elem = f, name, ty, elem

    def __str__(self):
        return self.name

    def _c(self, o):
        o = val(o)
        if isinstance(o, V):
            return o
        return self.f.const(self.ty, o)

    def _bin(self, iop, fop, o):
        o = self._c(o)
        return self.f.bin(fop if self.ty in FLT else iop, self.ty, self, o)

    def __add__(s, o): return s._bin("add", "fadd", o)
    def __sub__(s, o): return s._bin("sub", "fsub", o)
    def __mul__(s, o): return s._bin("mul", "fmul", o)
    def __truediv__(s, o): return s._bin("sdiv", "fdiv", o)
    def __floordiv__(s, o): return s._bin("sdiv", "fdiv", o)
    def __mod__(s, o): return s._bin("srem", "frem", o)
    def __radd__(s, o): return s._c(o) + s
    def __rsub__(s, o): return s._c(o) - s
    def __rmul__(s, o): return s._c(o) * s
    def __rtruediv__(s, o): return s._c(o) / s
    def __and__(s, o): return s.f.bin("and", s.ty, s, s._c(o))
    def __or__(s, o): return s.f.bin("or", s.ty, s, s._c(o))
    def __xor__(s, o): return s.f.bin("xor", s.ty, s, s._c(o))
    def __lshift__(s, o): return s.f.bin("shl", s.ty, s, s._c(o))
    def __rshift__(s, o): return s.f.bin("ashr", s.ty, s, s._c(o))
    def __neg__(s): return (s.f.const(s.ty, 0) - s) if s.ty not in FLT else s.f.bin("fsub", s.ty, s.f.const(s.ty, 0.0), s)

    def _cmp(self, ip, fp, o):
        o = self._c(o)
        return self.f.cmp(fp if self.ty in FLT else ip, self.ty, self, o)

    def __lt__(s, o): return s._cmp("slt", "olt", o)
    def __le__(s, o): return s._cmp("sle", "ole", o)
    def __gt__(s, o): return s._cmp("sgt", "ogt", o)
    def __ge__(s, o): return s._cmp("sge", "oge", o)
    def eq(s, o): return s._cmp("eq", "oeq", o)
    def ne(s, o): return s._cmp("ne", "one", o)
    def ult(s, o): return s._cmp("ult", "olt", o)

    def to(self, ty):
        return self.f.cast(self, ty)

    def __getitem__(self, idx):
        return self.f.load(self.elem, self.at(idx))

    def __setitem__(self, idx, val):
        self.f.store(self.elem, val, self.at(idx))

    def at(self, idx):
        if not isinstance(idx, V):
            idx = self.f.const("i32", idx)
        return self.f.tmp_v("ptr", "getelementptr %s, ptr %s, %s %s" % (self.elem, self.name, idx.ty, idx.name), elem=self.elem)

    def sel(self, a, b):   # 條件（i1）選一個
        a, b = val(a), val(b)
        a = a if isinstance(a, V) else self.f.const(b.ty if isinstance(b, V) else "i32", a)
        b = b if isinstance(b, V) else self.f.const(a.ty, b)
        return self.f.tmp_v(a.ty, "select i1 %s, %s %s, %s %s" % (self.name, a.ty, a.name, b.ty, b.name))


class Var(object):
    """可變的區域變數（alloca）。v.get() 讀、v.set(x) 寫；v += x 等就地更新。"""
    def __init__(self, f, ty, ptr):
        self.f, self.ty, self.ptr = f, ty, ptr

    def get(self): return self.f.load(self.ty, self.ptr)
    def set(self, x):
        self.f.store(self.ty, x if isinstance(x, V) else self.f.const(self.ty, x), self.ptr)
    def _upd(self, op, o):
        cur = self.get()
        self.set(cur + o if op == "+" else cur - o if op == "-" else cur * o if op == "*" else cur / o)   # 只算要的那一個（不能把四個都算出來：多餘的除法會在除數是 0 時 trap）
        return self
    def __iadd__(s, o): return s._upd("+", o)
    def __isub__(s, o): return s._upd("-", o)
    def __imul__(s, o): return s._upd("*", o)
    def __itruediv__(s, o): return s._upd("/", o)
    def __getattr__(self, k):   # 當值用：v.xxx 轉成 get() 的結果
        raise AttributeError(k)
    def __add__(s, o): return s.get() + o
    def __sub__(s, o): return s.get() - o
    def __mul__(s, o): return s.get() * o
    def __truediv__(s, o): return s.get() / o
    def __radd__(s, o): return o + s.get()
    def __rsub__(s, o): return o - s.get()
    def __rmul__(s, o): return o * s.get()
    def __lt__(s, o): return s.get() < o
    def __le__(s, o): return s.get() <= o
    def __gt__(s, o): return s.get() > o
    def __ge__(s, o): return s.get() >= o
    def eq(s, o): return s.get().eq(o)
    def ne(s, o): return s.get().ne(o)
    def to(s, ty): return s.get().to(ty)
    def __and__(s, o): return s.get() & o
    def __mod__(s, o): return s.get() % o
    def __neg__(s): return -s.get()
    @property
    def name(s): return s.get().name
    @property
    def v(s): return s.get()


def val(x):
    return x.get() if isinstance(x, Var) else x


class Fn(object):
    def __init__(self, mod, ret, name, params):
        self.mod, self.rty, self.name, self.params = mod, ret, name, params
        self.lines, self.allocas, self.n, self.nl = [], [], 0, 0
        self.args = [V(self, "%" + pn, pt) for pt, pn in params]
        self.terminated = False

    # ---- 基本
    def tmp(self):
        self.n += 1
        return "%%t%d" % self.n

    def newlabel(self, hint="L"):
        self.nl += 1
        return "%s%d" % (hint, self.nl)

    def emit(self, text):
        if self.terminated:   # 已經結束的區塊後面不能再有指令：開一個沒人跳進來的新區塊（死碼）
            self.label(self.newlabel("dead"))
        self.lines.append("  " + text)

    def tmp_v(self, ty, rhs, elem=None):
        r = self.tmp()
        self.emit("%s = %s" % (r, rhs))
        return V(self, r, ty, elem)

    def const(self, ty, x):
        if ty in FLT:
            return V(self, (f32 if ty == "float" else f64)(x), ty)
        if ty == "i1":
            return V(self, "true" if x else "false", ty)
        if ty == "ptr":
            return V(self, "null", ty)
        return V(self, str(int(x)), ty)

    def v(self, x, ty):
        x = val(x)
        return x if isinstance(x, V) else self.const(ty, x)

    # ---- 記憶體
    def alloca(self, ty, count=None, elem=None):
        r = "%%a%d" % (len(self.allocas) + 1)
        self.allocas.append("  %s = alloca %s" % (r, ty if count is None else "[%d x %s]" % (count, ty)))
        return V(self, r, "ptr", elem or ty)

    def array(self, ty, count):
        return self.alloca(ty, count, elem=ty)

    def var(self, ty, init=0):
        p = self.alloca(ty)
        vr = Var(self, ty, p)
        vr.set(init)
        return vr

    def load(self, ty, ptr):
        ptr = val(ptr)
        return self.tmp_v(ty, "load %s, ptr %s" % (ty, ptr.name if isinstance(ptr, V) else ptr))

    def store(self, ty, v, ptr):
        v, ptr = val(v), val(ptr)
        self.emit("store %s %s, ptr %s" % (ty, self.v(v, ty).name, ptr.name if isinstance(ptr, V) else ptr))

    def gep8(self, base, off):   # 位元組位移
        off = self.v(off, "i32")
        return self.tmp_v("ptr", "getelementptr i8, ptr %s, i32 %s" % (val(base).name, off.name))

    # ---- 運算
    def bin(self, op, ty, a, b):
        a, b = val(a), val(b)
        return self.tmp_v(ty, "%s %s %s, %s" % (op, ty, self.v(a, ty).name, self.v(b, ty).name))

    def cmp(self, pred, ty, a, b):
        a, b = val(a), val(b)
        return self.tmp_v("i1", "%s %s %s %s, %s" % ("fcmp" if ty in FLT else "icmp", pred, ty, self.v(a, ty).name, self.v(b, ty).name))

    def cast(self, x, ty):
        x = val(x)
        a, b = x.ty, ty
        if a == b:
            return x
        if a in INT and b in INT:
            op = "trunc" if INT[a] > INT[b] else ("zext" if a == "i1" else "sext")
        elif a in INT and b in FLT:
            op = "sitofp"
        elif a in FLT and b in INT:
            op = "fptosi"
        elif a == "float" and b == "double":
            op = "fpext"
        elif a == "double" and b == "float":
            op = "fptrunc"
        else:
            raise ValueError("cast %s -> %s" % (a, b))
        return self.tmp_v(ty, "%s %s %s to %s" % (op, a, x.name, ty))

    def zext(self, x, ty):
        return self.tmp_v(ty, "zext %s %s to %s" % (x.ty, x.name, ty))

    def call(self, name, *args, **kw):
        sig = self.mod.decls.get(name) or self.mod.sigs[name]
        ret, ptys, varargs = sig
        out = []
        for i, a in enumerate(args):
            a = val(a)
            ty = ptys[i] if i < len(ptys) else (a.ty if isinstance(a, V) else "i32")
            if isinstance(a, V):
                out.append("%s %s" % (a.ty if varargs and i >= len(ptys) else ty, a.name))
            elif isinstance(a, str):   # 字串常數
                out.append("ptr %s" % self.mod.string(a))
            else:
                out.append("%s %s" % (ty, self.const(ty, a).name))
        fty = "(%s)" % ", ".join(ptys + ["..."]) if varargs else ""
        text = "call %s %s @%s(%s)" % (ret, fty, name, ", ".join(out))
        text = text.replace("call %s  @" % ret, "call %s @" % ret)
        if ret == "void":
            self.emit(text)
            return None
        return self.tmp_v(ret, text)

    # ---- 控制流
    def label(self, name):
        self.lines.append(name + ":")
        self.terminated = False

    def br(self, label):
        if not self.terminated:
            self.lines.append("  br label %%%s" % label)
            self.terminated = True

    def cbr(self, cond, a, b):
        self.lines.append("  br i1 %s, label %%%s, label %%%s" % (cond.name, a, b))
        self.terminated = True

    def ret(self, x=None):
        if x is None:
            self.emit("ret void")
        else:
            self.emit("ret %s %s" % (self.rty, self.v(x, self.rty).name))
        self.terminated = True

    @contextmanager
    def if_(self, cond):
        t, e = self.newlabel("then"), self.newlabel("endif")
        self.cbr(cond, t, e)
        self.label(t)
        yield
        self.br(e)
        self.label(e)

    @contextmanager
    def loop(self, var, lo, hi, step=1):
        """for (var = lo; var < hi; var += step)"""
        c, b, e = self.newlabel("lc"), self.newlabel("lb"), self.newlabel("le")
        var.set(lo)
        self.br(c)
        self.label(c)
        self.cbr(var.get() < hi, b, e)
        self.label(b)
        self._cont = getattr(self, "_cont", [])
        yield
        var.set(var.get() + step)
        self.br(c)
        self.label(e)

    @contextmanager
    def while_(self, cond_fn):
        c, b, e = self.newlabel("wc"), self.newlabel("wb"), self.newlabel("we")
        self.br(c)
        self.label(c)
        self.cbr(cond_fn(), b, e)
        self.label(b)
        self._breaks = getattr(self, "_breaks", [])
        self._breaks.append(e)
        yield
        self._breaks.pop()
        self.br(c)
        self.label(e)

    def break_(self):
        self.br(self._breaks[-1])

    def text(self):
        head = "define %s @%s(%s) {\nentry:" % (self.rty, self.name, ", ".join("%s %%%s" % (t, n) for t, n in self.params))
        body = list(self.lines)
        tail = "" if self.terminated else ("  ret void" if self.rty == "void" else "  ret %s %s" % (self.rty, "0" if self.rty in INT else (f64(0) if self.rty == "double" else f32(0) if self.rty == "float" else "null")))
        return "\n".join([head] + self.allocas + body + ([tail] if tail else []) + ["}"])


class Mod(object):
    def __init__(self, header=""):
        self.header, self.strs, self.globs, self.decls, self.sigs, self.funcs, self.n = header, {}, [], {}, {}, [], 0

    def decl(self, ret, name, *params, varargs=False):
        self.decls[name] = (ret, list(params), varargs)

    def string(self, s):
        if s not in self.strs:
            self.n += 1
            b = s.encode("utf-8") + b"\0"
            self.strs[s] = ("@.s%d" % self.n, b)
        return self.strs[s][0]

    def const_bytes(self, name, data):
        self.globs.append("@%s = private constant [%d x i8] c\"%s\"" % (name, len(data), esc(data)))
        return "@" + name

    def const_array(self, name, ty, vals):
        fmt = (lambda x: (f64(x) if ty == "double" else f32(x) if ty == "float" else str(int(x))))
        self.globs.append("@%s = private constant [%d x %s] [%s]" % (name, len(vals), ty, ", ".join("%s %s" % (ty, fmt(x)) for x in vals)))
        return V(None, "@" + name, "ptr", ty)

    def fn(self, ret, name, *params):
        """params：(ty, name) 二元組。回傳 Fn；呼叫 f.args 取參數。"""
        f = Fn(self, ret, name, list(params))
        self.sigs[name] = (ret, [t for t, _ in params], False)
        self.funcs.append(f)
        return f

    def text(self):
        out = [self.header, ""]
        for name, (ret, ptys, va) in self.decls.items():
            out.append("declare %s @%s(%s)" % (ret, name, ", ".join(ptys + (["..."] if va else []))))
        out.append("")
        for s, (nm, b) in self.strs.items():
            out.append("%s = private constant [%d x i8] c\"%s\"" % (nm, len(b), esc(b)))
        out += self.globs
        out.append("")
        for f in self.funcs:
            out.append(f.text())
            out.append("")
        return "\n".join(out)
