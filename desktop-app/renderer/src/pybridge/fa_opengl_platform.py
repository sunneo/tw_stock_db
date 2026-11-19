# -*- coding: utf-8 -*-
"""
fa_opengl_platform — 真的 PyOpenGL（pip）的「平台後端」：把 GL 函式導到 Worker 裡 OffscreenCanvas 的 WebGL2。

**PyOpenGL 的 API 完全是真的**（OpenGL.GL、OpenGL.GLU 的名字、簽名、包裝、常數、陣列轉換都是 pip 的）；這裡只提供它底下「呼叫 C 函式庫」的那一層：
  * 現代 API（著色器、緩衝區、頂點屬性、uniform、紋理、狀態、draw）一對一轉發到 WebGL2（OpenGL ES 3.0）；
  * 固定管線（glBegin／glEnd、glVertexPointer、矩陣堆疊、光照、display list、glPolygonMode）WebGL2 沒有，這裡用一支動態著色器模擬；
  * 沒有實作的函式，呼叫時是 PyOpenGL 自己的 NullFunctionError（「Attempt to call an undefined function」），不是悄悄失敗。
畫面：WebGL2 畫在 OffscreenCanvas，每幀（pygame.display.flip／gl3d 的 View.show）擷取成 PNG，經橋接的 image 與 draw 送到視窗畫布（協定不用改）。
用法（標準的 PyOpenGL＋pygame）：
    pygame.display.set_mode((w, h), DOUBLEBUF | OPENGL)      # fa_pygame 會建好 WebGL2 上下文
    from OpenGL.GL import *; from OpenGL.GLU import *
需要 pip 的 PyOpenGL；Pyodide 沒有內建，Worker 會在程式 import OpenGL 時用 micropip 從 PyPI 裝（純 Python）。
後端介面（backend）可注入，測試用假的；真的後端是 WebGL2Backend（用 js 與 pyodide.ffi）。
"""
import ctypes
import math
import os
import sys

_CTX = {"backend": None, "w": 0, "h": 0, "ff": None}
_FN = {}


def gl(*names):
    def deco(f):
        for n in (names or (f.__name__,)):
            _FN[n] = f
        return f
    return deco


# ---------------------------------------------------------------- 值的取出（ctypes 物件／數字／指標 → Python 值）
def _v(x):
    if type(x).__name__ == "CArgObject":   # ctypes 的 from_param 對純量回傳的包裝
        x = x._obj
    return x.value if hasattr(x, "value") and not isinstance(x, (bytes, str)) else x


def _addr(x):
    if x is None:
        return 0
    if isinstance(x, int):
        return x
    if isinstance(x, (bytes, bytearray)):
        return ctypes.cast(ctypes.c_char_p(bytes(x)), ctypes.c_void_p).value or 0
    if hasattr(x, "ctypes") and hasattr(x.ctypes, "data"):   # numpy
        return int(x.ctypes.data)
    if hasattr(x, "value") and isinstance(getattr(x, "value"), int):
        return x.value
    if hasattr(x, "_obj"):   # byref
        return ctypes.addressof(x._obj)
    try:
        return ctypes.cast(x, ctypes.c_void_p).value or 0
    except Exception:
        try:
            return ctypes.addressof(x)
        except Exception:
            return 0


def _read(ptr, nbytes):
    a = _addr(ptr)
    return ctypes.string_at(a, nbytes) if a and nbytes > 0 else b""


def _floats(ptr, n):
    import struct
    return list(struct.unpack("<%df" % n, _read(ptr, 4 * n)))


def _ints(ptr, n):
    import struct
    return list(struct.unpack("<%di" % n, _read(ptr, 4 * n)))


def _write(ptr, data):
    a = _addr(ptr)
    if a:
        ctypes.memmove(a, data, len(data))


TYPE_SIZE = {0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4}   # BYTE UBYTE SHORT USHORT INT UINT FLOAT
FMT_COMP = {0x1903: 1, 0x8227: 2, 0x1907: 3, 0x1908: 4, 0x1909: 1, 0x190A: 2, 0x1906: 1, 0x8D94: 1}   # RED RG RGB RGBA LUMINANCE LUMINANCE_ALPHA ALPHA


def _be():
    b = _CTX["backend"]
    if b is None:
        from OpenGL import error
        raise error.NoContext("沒有 OpenGL 上下文：先用 pygame.display.set_mode(…, OPENGL) 或 gl3d.View 開一個視窗")
    return b


# ---------------------------------------------------------------- 現代 API：一對一轉發（名字、整數 id ↔ WebGL 物件）
class _Names(object):
    def __init__(self):
        self.t, self.n = {}, 0

    def new(self, obj):
        self.n += 1
        self.t[self.n] = obj
        return self.n

    def get(self, i):
        return self.t.get(int(i)) if i else None

    def drop(self, i):
        self.t.pop(int(i), None)


_OBJ = {k: _Names() for k in ("buffer", "shader", "program", "texture", "vao", "uloc")}
_BOUND = {"array": 0, "element": 0, "program": 0, "vao": 0}
_PROG = {}   # program id → {"attribs": {name: loc}}


def _fwd(name, js, n):
    def f(*a):
        ctx = _CTX
        if name in ("glEnable", "glDisable") and ctx.get("ff") is not None and ctx["ff"].caps_hook(name == "glEnable", int(_v(a[0]))):
            return None
        getattr(_be(), js)(*[_v(x) for x in a[:n]])
    _FN[name] = f


for _name, _js, _n in [("glClearColor", "clear_color", 4), ("glClear", "clear", 1), ("glViewport", "viewport", 4), ("glScissor", "scissor", 4),
                       ("glEnable", "enable", 1), ("glDisable", "disable", 1), ("glBlendFunc", "blend_func", 2), ("glBlendFuncSeparate", "blend_func_separate", 4),
                       ("glBlendEquation", "blend_equation", 1), ("glDepthFunc", "depth_func", 1), ("glDepthMask", "depth_mask", 1), ("glCullFace", "cull_face", 1),
                       ("glFrontFace", "front_face", 1), ("glColorMask", "color_mask", 4), ("glLineWidth", "line_width", 1), ("glClearDepth", "clear_depth", 1),
                       ("glPixelStorei", "pixel_storei", 2), ("glActiveTexture", "active_texture", 1), ("glGenerateMipmap", "generate_mipmap", 1),
                       ("glTexParameteri", "tex_parameteri", 3), ("glTexParameterf", "tex_parameteri", 3), ("glDepthRange", "depth_range", 2),
                       ("glFlush", "flush", 0), ("glFinish", "flush", 0), ("glStencilFunc", "stencil_func", 3), ("glStencilOp", "stencil_op", 3), ("glClearStencil", "clear_stencil", 1)]:
    _fwd(_name, _js, _n)


@gl("glGetError")
def _get_error():
    return 0


@gl("glGetString")
def _get_string(name):
    n = int(_v(name))
    return {0x1F00: b"fa-webgl2", 0x1F01: b"WebGL 2.0 (OpenGL ES 3.0)", 0x1F02: b"OpenGL ES 3.0 (WebGL 2.0)", 0x8B8C: b"OpenGL ES GLSL ES 3.00", 0x1F03: b""}.get(n, b"")


@gl("glGetIntegerv")
def _get_integerv(pname, params):
    n = int(_v(pname))
    vals = {0x0BA2: lambda: list(_CTX["ff"].viewport if _CTX["ff"] else (0, 0, _CTX["w"], _CTX["h"])), 0x0D33: lambda: [4096], 0x8B4C: lambda: [16], 0x8872: lambda: [16], 0x0BA0: lambda: [_CTX["ff"].matrix_mode if _CTX["ff"] else 0x1700],
            0x0B21: lambda: [1], 0x0D3A: lambda: [4096, 4096]}.get(n)
    out = vals() if vals else [0]
    _write(params, b"".join(int(x).to_bytes(4, "little", signed=True) for x in out))


@gl("glGetFloatv")
def _get_floatv(pname, params):
    import struct
    n = int(_v(pname))
    ff = _CTX["ff"]
    if ff and n in (0x0BA6, 0x0BA7):   # MODELVIEW_MATRIX／PROJECTION_MATRIX
        _write(params, struct.pack("<16f", *(ff.mv[-1] if n == 0x0BA6 else ff.proj[-1])))
    elif n == 0x0B73:
        _write(params, struct.pack("<4f", *((ff.color if ff else (1, 1, 1, 1)))))
    else:
        _write(params, struct.pack("<f", 1.0))


@gl("glIsEnabled")
def _is_enabled(cap):
    ff = _CTX["ff"]
    return 1 if ff and int(_v(cap)) in ff.enabled else 0


# 緩衝區
@gl("glGenBuffers")
def _gen_buffers(n, out):
    ids = [_OBJ["buffer"].new(_be().create_buffer()) for _ in range(int(_v(n)))]
    _write(out, b"".join(i.to_bytes(4, "little") for i in ids))


@gl("glDeleteBuffers")
def _del_buffers(n, ids):
    for i in _ints(ids, int(_v(n))):
        _be().delete_buffer(_OBJ["buffer"].get(i)); _OBJ["buffer"].drop(i)


@gl("glBindBuffer")
def _bind_buffer(target, buf):
    t, b = int(_v(target)), int(_v(buf))
    _BOUND["array" if t == 0x8892 else "element" if t == 0x8893 else "other"] = b
    _be().bind_buffer(t, _OBJ["buffer"].get(b))


@gl("glBufferData")
def _buffer_data(target, size, data, usage):
    s = int(_v(size)); p = _addr(data)
    _be().buffer_data(int(_v(target)), _read(p, s) if p else s, int(_v(usage)))


@gl("glBufferSubData")
def _buffer_sub_data(target, offset, size, data):
    _be().buffer_sub_data(int(_v(target)), int(_v(offset)), _read(data, int(_v(size))))


# 頂點陣列物件
@gl("glGenVertexArrays")
def _gen_vaos(n, out):
    ids = [_OBJ["vao"].new(_be().create_vertex_array()) for _ in range(int(_v(n)))]
    _write(out, b"".join(i.to_bytes(4, "little") for i in ids))


@gl("glBindVertexArray")
def _bind_vao(vao):
    _BOUND["vao"] = int(_v(vao)); _be().bind_vertex_array(_OBJ["vao"].get(int(_v(vao))))


@gl("glDeleteVertexArrays")
def _del_vaos(n, ids):
    for i in _ints(ids, int(_v(n))):
        _be().delete_vertex_array(_OBJ["vao"].get(i)); _OBJ["vao"].drop(i)


# 著色器與程式
@gl("glCreateShader")
def _create_shader(kind):
    return _OBJ["shader"].new(_be().create_shader(int(_v(kind))))


@gl("glShaderSource")
def _shader_source(shader, count, strings, lengths):
    n = int(_v(count)); arr = ctypes.cast(strings, ctypes.POINTER(ctypes.c_char_p)) if not isinstance(strings, ctypes.Array) else strings
    src = b"".join(arr[i] or b"" for i in range(n)).decode("utf-8", "replace")
    _be().shader_source(_OBJ["shader"].get(int(_v(shader))), src)


@gl("glCompileShader")
def _compile_shader(shader):
    _be().compile_shader(_OBJ["shader"].get(int(_v(shader))))


@gl("glGetShaderiv")
def _get_shaderiv(shader, pname, params):
    s = _OBJ["shader"].get(int(_v(shader))); p = int(_v(pname))
    r = _be().get_shader_parameter(s, p)
    _write(params, int(r if not isinstance(r, bool) else r).to_bytes(4, "little", signed=True) if p != 0x8B84 else int(len(_be().get_shader_info_log(s)) + 1).to_bytes(4, "little"))


@gl("glGetShaderInfoLog")
def _get_shader_log(shader, max_len, length, buf):
    log = (_be().get_shader_info_log(_OBJ["shader"].get(int(_v(shader)))) or "").encode()[:max(0, int(_v(max_len)) - 1)]
    _write(buf, log + b"\0")
    if _addr(length):
        _write(length, len(log).to_bytes(4, "little"))


@gl("glDeleteShader")
def _delete_shader(shader):
    _be().delete_shader(_OBJ["shader"].get(int(_v(shader)))); _OBJ["shader"].drop(int(_v(shader)))


@gl("glCreateProgram")
def _create_program():
    i = _OBJ["program"].new(_be().create_program()); _PROG[i] = {}
    return i


@gl("glAttachShader")
def _attach_shader(prog, shader):
    _be().attach_shader(_OBJ["program"].get(int(_v(prog))), _OBJ["shader"].get(int(_v(shader))))


@gl("glBindAttribLocation")
def _bind_attrib_location(prog, index, name):
    _be().bind_attrib_location(_OBJ["program"].get(int(_v(prog))), int(_v(index)), (name.value if hasattr(name, "value") else name).decode())


@gl("glLinkProgram")
def _link_program(prog):
    _be().link_program(_OBJ["program"].get(int(_v(prog))))


@gl("glGetProgramiv")
def _get_programiv(prog, pname, params):
    p = _OBJ["program"].get(int(_v(prog))); n = int(_v(pname))
    r = _be().get_program_parameter(p, n)
    _write(params, int(len(_be().get_program_info_log(p)) + 1 if n == 0x8B84 else r).to_bytes(4, "little", signed=True))


@gl("glGetProgramInfoLog")
def _get_program_log(prog, max_len, length, buf):
    log = (_be().get_program_info_log(_OBJ["program"].get(int(_v(prog)))) or "").encode()[:max(0, int(_v(max_len)) - 1)]
    _write(buf, log + b"\0")
    if _addr(length):
        _write(length, len(log).to_bytes(4, "little"))


@gl("glUseProgram")
def _use_program(prog):
    _BOUND["program"] = int(_v(prog)); _be().use_program(_OBJ["program"].get(int(_v(prog))))


@gl("glDeleteProgram")
def _delete_program(prog):
    _be().delete_program(_OBJ["program"].get(int(_v(prog)))); _OBJ["program"].drop(int(_v(prog)))


@gl("glGetAttribLocation")
def _get_attrib_location(prog, name):
    return _be().get_attrib_location(_OBJ["program"].get(int(_v(prog))), (name.value if hasattr(name, "value") else name).decode())


@gl("glGetUniformLocation")
def _get_uniform_location(prog, name):
    loc = _be().get_uniform_location(_OBJ["program"].get(int(_v(prog))), (name.value if hasattr(name, "value") else name).decode())
    return _OBJ["uloc"].new(loc) if loc is not None else -1


def _uloc(loc):
    return _OBJ["uloc"].get(int(_v(loc)))


for _k, _nm in ((1, "f"), (2, "f"), (3, "f"), (4, "f")):
    def _mk(k):
        def u(loc, *vals):
            _be().uniform("f", k, _uloc(loc), [float(_v(x)) for x in vals])
        return u
    _FN["glUniform%df" % _k] = _mk(_k)
for _k in (1, 2, 3, 4):
    def _mk2(k):
        def u(loc, *vals):
            _be().uniform("i", k, _uloc(loc), [int(_v(x)) for x in vals])
        return u

        return u
    _FN["glUniform%di" % _k] = _mk2(_k)

    def _mk3(k):
        def u(loc, count, ptr):
            _be().uniform("f", k, _uloc(loc), _floats(ptr, k * int(_v(count))), True)
        return u
    _FN["glUniform%dfv" % _k] = _mk3(_k)

    def _mk4(k):
        def u(loc, count, ptr):
            _be().uniform("i", k, _uloc(loc), _ints(ptr, k * int(_v(count))), True)
        return u
    _FN["glUniform%div" % _k] = _mk4(_k)
for _k in (2, 3, 4):
    def _mk5(k):
        def u(loc, count, transpose, ptr):
            _be().uniform_matrix(k, _uloc(loc), bool(_v(transpose)), _floats(ptr, k * k * int(_v(count))))
        return u
    _FN["glUniformMatrix%dfv" % _k] = _mk5(_k)


@gl("glEnableVertexAttribArray")
def _enable_attr(i):
    _be().enable_vertex_attrib_array(int(_v(i)))


@gl("glDisableVertexAttribArray")
def _disable_attr(i):
    _be().disable_vertex_attrib_array(int(_v(i)))


@gl("glVertexAttribPointer")
def _attr_pointer(index, size, typ, normalized, stride, pointer):
    if not _BOUND["array"]:
        raise RuntimeError("glVertexAttribPointer：沒有綁定 GL_ARRAY_BUFFER（這個環境的現代 API 只支援緩衝區物件；client 端陣列只能用固定管線的 glVertexPointer）")
    _be().vertex_attrib_pointer(int(_v(index)), int(_v(size)), int(_v(typ)), bool(_v(normalized)), int(_v(stride)), _addr(pointer))


@gl("glVertexAttribDivisor")
def _attr_divisor(index, divisor):
    _be().vertex_attrib_divisor(int(_v(index)), int(_v(divisor)))


@gl("glDrawArrays")
def _draw_arrays(mode, first, count):
    ff = _CTX["ff"]
    if ff is not None and _BOUND["program"] == 0:
        return ff.draw_arrays(int(_v(mode)), int(_v(first)), int(_v(count)))
    _be().draw_arrays(int(_v(mode)), int(_v(first)), int(_v(count)))


@gl("glDrawElements")
def _draw_elements(mode, count, typ, indices):
    ff = _CTX["ff"]
    if ff is not None and _BOUND["program"] == 0:
        return ff.draw_elements(int(_v(mode)), int(_v(count)), int(_v(typ)), indices)
    _be().draw_elements(int(_v(mode)), int(_v(count)), int(_v(typ)), _addr(indices))


@gl("glDrawArraysInstanced")
def _draw_arrays_instanced(mode, first, count, instances):
    _be().draw_arrays_instanced(int(_v(mode)), int(_v(first)), int(_v(count)), int(_v(instances)))


@gl("glDrawElementsInstanced")
def _draw_elements_instanced(mode, count, typ, indices, instances):
    _be().draw_elements_instanced(int(_v(mode)), int(_v(count)), int(_v(typ)), _addr(indices), int(_v(instances)))


# 紋理
@gl("glGenTextures")
def _gen_textures(n, out):
    ids = [_OBJ["texture"].new(_be().create_texture()) for _ in range(int(_v(n)))]
    _write(out, b"".join(i.to_bytes(4, "little") for i in ids))


@gl("glBindTexture")
def _bind_texture(target, tex):
    _be().bind_texture(int(_v(target)), _OBJ["texture"].get(int(_v(tex))))


@gl("glDeleteTextures")
def _del_textures(n, ids):
    for i in _ints(ids, int(_v(n))):
        _be().delete_texture(_OBJ["texture"].get(i)); _OBJ["texture"].drop(i)


@gl("glTexImage2D")
def _tex_image_2d(target, level, internal, width, height, border, fmt, typ, pixels):
    w, h, f, t = int(_v(width)), int(_v(height)), int(_v(fmt)), int(_v(typ))
    data = _read(pixels, w * h * FMT_COMP.get(f, 4) * TYPE_SIZE.get(t, 1)) if _addr(pixels) else None
    internal = int(_v(internal))
    if internal in (3, 4, 1, 2):   # 舊式的元件數 → 對應的 sized 格式
        internal = {1: 0x1909, 2: 0x190A, 3: 0x1907, 4: 0x1908}[internal]
    _be().tex_image_2d(int(_v(target)), int(_v(level)), internal, w, h, int(_v(border)), f, t, data)


@gl("glTexSubImage2D")
def _tex_sub_image_2d(target, level, x, y, width, height, fmt, typ, pixels):
    w, h, f, t = int(_v(width)), int(_v(height)), int(_v(fmt)), int(_v(typ))
    _be().tex_sub_image_2d(int(_v(target)), int(_v(level)), int(_v(x)), int(_v(y)), w, h, f, t, _read(pixels, w * h * FMT_COMP.get(f, 4) * TYPE_SIZE.get(t, 1)))


@gl("glReadPixels")
def _read_pixels(x, y, width, height, fmt, typ, data):
    w, h, f, t = int(_v(width)), int(_v(height)), int(_v(fmt)), int(_v(typ))
    _write(data, _be().read_pixels(int(_v(x)), int(_v(y)), w, h, f, t))


# ---------------------------------------------------------------- GLU
@gl("gluPerspective")
def _glu_perspective(fovy, aspect, near, far):
    _CTX["ff"].mult(_perspective(float(_v(fovy)), float(_v(aspect)), float(_v(near)), float(_v(far))))


@gl("gluOrtho2D")
def _glu_ortho2d(l, r, b, t):
    _CTX["ff"].mult(_ortho(float(_v(l)), float(_v(r)), float(_v(b)), float(_v(t)), -1.0, 1.0))


@gl("gluLookAt")
def _glu_lookat(ex, ey, ez, cx, cy, cz, ux, uy, uz):
    _CTX["ff"].mult(_look_at(*[float(_v(x)) for x in (ex, ey, ez, cx, cy, cz, ux, uy, uz)]))


@gl("gluNewQuadric")
def _glu_new_quadric():
    return 1


@gl("gluDeleteQuadric")
def _glu_delete_quadric(q):
    return None


@gl("gluSphere")
def _glu_sphere(q, radius, slices, stacks):
    _CTX["ff"].sphere(float(_v(radius)), int(_v(slices)), int(_v(stacks)))


# ---------------------------------------------------------------- 4×4 矩陣（欄優先）
def _ident():
    return [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def _mul(a, b):
    o = [0.0] * 16
    for c in range(4):
        for r in range(4):
            o[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return o


def _perspective(fovy, aspect, n, f):
    k = 1.0 / math.tan(math.radians(fovy) / 2.0)
    return [k / aspect, 0, 0, 0, 0, k, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]


def _ortho(l, r, b, t, n, f):
    return [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]


def _look_at(ex, ey, ez, cx, cy, cz, ux, uy, uz):
    fx, fy, fz = cx - ex, cy - ey, cz - ez
    fl = math.sqrt(fx * fx + fy * fy + fz * fz) or 1.0
    fx, fy, fz = fx / fl, fy / fl, fz / fl
    sx, sy, sz = fy * uz - fz * uy, fz * ux - fx * uz, fx * uy - fy * ux
    sl = math.sqrt(sx * sx + sy * sy + sz * sz) or 1.0
    sx, sy, sz = sx / sl, sy / sl, sz / sl
    ux2, uy2, uz2 = sy * fz - sz * fy, sz * fx - sx * fz, sx * fy - sy * fx
    m = [sx, ux2, -fx, 0, sy, uy2, -fy, 0, sz, uz2, -fz, 0, 0, 0, 0, 1]
    return _mul(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -ex, -ey, -ez, 1])


def _invert_transpose3(m):
    """左上 3×3 的逆轉置（法線矩陣），回傳 9 個數（欄優先）。"""
    a, b, c, d, e, f, g, h, i = m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-12:
        return [1, 0, 0, 0, 1, 0, 0, 0, 1]
    inv = [(e * i - f * h), -(d * i - f * g), (d * h - e * g), -(b * i - c * h), (a * i - c * g), -(a * h - b * g), (b * f - c * e), -(a * f - c * d), (a * e - b * d)]
    return [x / det for x in inv]


# ---------------------------------------------------------------- 固定管線（WebGL2 沒有）：矩陣堆疊、即時模式、client 陣列、光照、display list、多邊形模式
FF_VS = """#version 300 es
precision highp float;
in vec3 aPos; in vec3 aNrm; in vec4 aCol; in vec2 aTex;
uniform mat4 uMVP; uniform mat4 uMV; uniform mat3 uNM; uniform float uPointSize;
uniform bool uLighting; uniform vec4 uAmbientModel; uniform vec4 uLPos[8]; uniform vec4 uLAmb[8]; uniform vec4 uLDif[8]; uniform vec4 uLSpe[8]; uniform int uLOn;
uniform vec4 uMAmb; uniform vec4 uMDif; uniform vec4 uMSpe; uniform vec4 uMEmi; uniform float uShin; uniform bool uColorMat; uniform bool uNormalize;
out vec4 vCol; out vec2 vTex;
void main() {
  vec4 base = aCol;
  if (uLighting) {
    vec3 n = uNM * aNrm; if (uNormalize || true) n = normalize(n);
    vec3 ep = (uMV * vec4(aPos, 1.0)).xyz;
    vec4 amb = uColorMat ? aCol : uMAmb; vec4 dif = uColorMat ? aCol : uMDif;
    vec3 c = uMEmi.rgb + uAmbientModel.rgb * amb.rgb;
    for (int i = 0; i < 8; i++) {
      if ((uLOn & (1 << i)) == 0) continue;
      vec3 l = uLPos[i].w == 0.0 ? normalize(uLPos[i].xyz) : normalize(uLPos[i].xyz - ep);
      float d = max(dot(n, l), 0.0);
      c += uLAmb[i].rgb * amb.rgb + d * uLDif[i].rgb * dif.rgb;
      if (d > 0.0 && uShin > 0.0) { vec3 h = normalize(l + vec3(0.0, 0.0, 1.0)); c += pow(max(dot(n, h), 0.0), uShin) * uLSpe[i].rgb * uMSpe.rgb; }
    }
    base = vec4(clamp(c, 0.0, 1.0), dif.a);
  }
  vCol = base; vTex = aTex; gl_PointSize = uPointSize; gl_Position = uMVP * vec4(aPos, 1.0);
}"""
FF_FS = """#version 300 es
precision mediump float;
in vec4 vCol; in vec2 vTex; uniform bool uUseTex; uniform sampler2D uTex; out vec4 o;
void main() { o = uUseTex ? vCol * texture(uTex, vTex) : vCol; }"""

CAP = {"DEPTH_TEST": 0x0B71, "LIGHTING": 0x0B50, "LIGHT0": 0x4000, "COLOR_MATERIAL": 0x0B57, "NORMALIZE": 0x0BA1, "TEXTURE_2D": 0x0DE1, "CULL_FACE": 0x0B44,
       "BLEND": 0x0BE2, "FOG": 0x0B60, "ALPHA_TEST": 0x0BC0, "POINT_SMOOTH": 0x0B10, "LINE_SMOOTH": 0x0B20, "SCISSOR_TEST": 0x0C11}
GL_FFN = {}


def _ff_fn(*names):
    def deco(f):
        for n in names or (f.__name__,):
            GL_FFN[n] = f
        return f
    return deco


class FixedFunction(object):
    def __init__(self, backend):
        self.be = backend
        self.reset()
        self.prog = None
        self.vbo = None
        self.recording = None
        self.lists = {}
        self.list_seq = 0

    def reset(self):
        self.matrix_mode = 0x1700
        self.mv, self.proj, self.tex = [_ident()], [_ident()], [_ident()]
        self.color = (1.0, 1.0, 1.0, 1.0)
        self.normal = (0.0, 0.0, 1.0)
        self.texcoord = (0.0, 0.0)
        self.enabled = set()
        self.lights = [{"pos": (0, 0, 1, 0), "amb": (0, 0, 0, 1), "dif": (1, 1, 1, 1) if i == 0 else (0, 0, 0, 1), "spe": (1, 1, 1, 1) if i == 0 else (0, 0, 0, 1)} for i in range(8)]
        self.model_ambient = (0.2, 0.2, 0.2, 1.0)
        self.mat = {"amb": (0.2, 0.2, 0.2, 1.0), "dif": (0.8, 0.8, 0.8, 1.0), "spe": (0, 0, 0, 1.0), "emi": (0, 0, 0, 1.0), "shin": 0.0}
        self.arrays = {"vertex": None, "normal": None, "color": None, "texcoord": None}
        self.enabled_arrays = set()
        self.begin = None
        self.polygon_mode = 0x1B02   # GL_FILL
        self.viewport = (0, 0, _CTX["w"], _CTX["h"])
        self.point_size = 1.0

    # --- 矩陣
    def cur(self):
        return {0x1700: self.mv, 0x1701: self.proj}.get(self.matrix_mode, self.tex)

    def mult(self, m):
        s = self.cur()
        s[-1] = _mul(s[-1], m)

    def caps_hook(self, on, cap):
        """glEnable／glDisable 的固定管線部分：光源、光照、顏色材質等不是 WebGL 的狀態，由這裡記；回傳 True 表示不必再轉給 WebGL。"""
        if on:
            self.enabled.add(cap)
        else:
            self.enabled.discard(cap)
        return cap in (CAP["LIGHTING"], CAP["COLOR_MATERIAL"], CAP["NORMALIZE"], CAP["TEXTURE_2D"], CAP["FOG"], CAP["ALPHA_TEST"], CAP["POINT_SMOOTH"], CAP["LINE_SMOOTH"]) or 0x4000 <= cap <= 0x4007

    # --- 繪製
    def _program(self):
        if self.prog is None:
            be = self.be
            vs, fs = be.create_shader(0x8B31), be.create_shader(0x8B30)
            be.shader_source(vs, FF_VS); be.compile_shader(vs); be.shader_source(fs, FF_FS); be.compile_shader(fs)
            p = be.create_program()
            be.attach_shader(p, vs); be.attach_shader(p, fs)
            for i, n in enumerate(("aPos", "aNrm", "aCol", "aTex")):
                be.bind_attrib_location(p, i, n)
            be.link_program(p)
            if not be.get_program_parameter(p, 0x8B82):
                raise RuntimeError("固定管線著色器編譯失敗：" + str(be.get_program_info_log(p)) + str(be.get_shader_info_log(vs)) + str(be.get_shader_info_log(fs)))
            self.prog = p
            self.vbo = be.create_buffer()
            self.loc = {n: be.get_uniform_location(p, n) for n in ("uMVP", "uMV", "uNM", "uPointSize", "uLighting", "uAmbientModel", "uLPos", "uLAmb", "uLDif", "uLSpe", "uLOn", "uMAmb", "uMDif", "uMSpe", "uMEmi", "uShin", "uColorMat", "uNormalize", "uUseTex", "uTex")}
        return self.prog

    def _flush_uniforms(self):
        be, L = self.be, self.loc
        mv, pr = self.mv[-1], self.proj[-1]
        be.use_program(self.prog)
        be.uniform_matrix(4, L["uMVP"], False, _mul(pr, mv)); be.uniform_matrix(4, L["uMV"], False, mv); be.uniform_matrix(3, L["uNM"], False, _invert_transpose3(mv))
        be.uniform("f", 1, L["uPointSize"], [self.point_size])
        lit = CAP["LIGHTING"] in self.enabled
        be.uniform("i", 1, L["uLighting"], [1 if lit else 0]); be.uniform("i", 1, L["uColorMat"], [1 if CAP["COLOR_MATERIAL"] in self.enabled else 0]); be.uniform("i", 1, L["uNormalize"], [1])
        be.uniform("f", 4, L["uAmbientModel"], list(self.model_ambient))
        on = sum(1 << i for i in range(8) if (0x4000 + i) in self.enabled)
        be.uniform("i", 1, L["uLOn"], [on])
        be.uniform("f", 4, L["uLPos"], [x for l in self.lights for x in l["pos"]], True); be.uniform("f", 4, L["uLAmb"], [x for l in self.lights for x in l["amb"]], True)
        be.uniform("f", 4, L["uLDif"], [x for l in self.lights for x in l["dif"]], True); be.uniform("f", 4, L["uLSpe"], [x for l in self.lights for x in l["spe"]], True)
        m = self.mat
        for k, n in (("amb", "uMAmb"), ("dif", "uMDif"), ("spe", "uMSpe"), ("emi", "uMEmi")):
            be.uniform("f", 4, L[n], list(m[k]))
        be.uniform("f", 1, L["uShin"], [m["shin"]])
        be.uniform("i", 1, L["uUseTex"], [1 if CAP["TEXTURE_2D"] in self.enabled else 0]); be.uniform("i", 1, L["uTex"], [0])

    def submit(self, mode, verts):
        """verts：(x,y,z, nx,ny,nz, r,g,b,a, s,t) 的串列。QUADS、FAN、STRIP、POLYGON 先拆成三角形；多邊形模式為線／點時三角形改畫成線／點。"""
        import struct
        n = len(verts)
        if n == 0:
            return
        tri = None
        if mode == 7:      # GL_QUADS
            tri = [i for q in range(0, n - 3, 4) for i in (q, q + 1, q + 2, q, q + 2, q + 3)]
        elif mode == 9 or mode == 6:    # GL_POLYGON、GL_TRIANGLE_FAN
            tri = [j for i in range(1, n - 1) for j in (0, i, i + 1)]
        elif mode == 8:    # GL_QUAD_STRIP
            tri = [j for q in range(0, n - 3, 2) for j in (q, q + 1, q + 3, q, q + 3, q + 2)]
        elif mode == 5:    # GL_TRIANGLE_STRIP
            tri = [j for i in range(n - 2) for j in ((i, i + 1, i + 2) if i % 2 == 0 else (i + 1, i, i + 2))]
        elif mode == 4:
            tri = list(range(n - n % 3))
        if tri is not None:
            if self.polygon_mode == 0x1B01:      # GL_LINE
                lines = [j for t in range(0, len(tri) - 2, 3) for j in (tri[t], tri[t + 1], tri[t + 1], tri[t + 2], tri[t + 2], tri[t])]
                verts, mode = [verts[i] for i in lines], 1
            elif self.polygon_mode == 0x1B00:    # GL_POINT
                verts, mode = [verts[i] for i in tri], 0
            else:
                verts, mode = [verts[i] for i in tri], 4
        elif mode == 2:    # GL_LINE_LOOP → line strip 補回起點
            verts, mode = verts + verts[:1], 3
        flat = [x for v in verts for x in v]
        self._program()
        self._flush_uniforms()
        be = self.be
        be.bind_buffer(0x8892, self.vbo); be.buffer_data(0x8892, struct.pack("<%df" % len(flat), *flat), 0x88E0)
        stride = 48
        for loc, size, off in ((0, 3, 0), (1, 3, 12), (2, 4, 24), (3, 2, 40)):
            be.enable_vertex_attrib_array(loc); be.vertex_attrib_pointer(loc, size, 0x1406, False, stride, off)
        be.draw_arrays(mode, 0, len(verts))
        be.bind_buffer(0x8892, None)
        be.use_program(None)

    def vertex(self, x, y, z=0.0):
        if self.begin is None:
            return
        self.begin["verts"].append((x, y, z) + tuple(self.normal) + tuple(self.color) + tuple(self.texcoord))

    def end(self):
        b, self.begin = self.begin, None
        if b:
            self.submit(b["mode"], b["verts"])

    def _arr(self, kind, count, first=0, index=None):
        a = self.arrays[kind]
        if a is None or kind not in self.enabled_arrays:
            return None
        size, typ, stride, ptr = a
        esz = TYPE_SIZE.get(typ, 4)
        stride = stride or size * esz
        idxs = index if index is not None else range(first, first + count)
        fmt = {0x1406: "f", 0x1404: "i", 0x1402: "h", 0x1401: "B", 0x1400: "b", 0x1403: "H", 0x1405: "I"}[typ]
        import struct
        out = []
        for i in idxs:
            out.append(struct.unpack_from("<" + fmt * size, _read(ptr + i * stride, size * esz)))
        if kind == "color" and typ == 0x1401:
            out = [tuple(c / 255.0 for c in v) for v in out]
        return out

    def _arrays_to_verts(self, count, first=0, index=None):
        pos = self._arr("vertex", count, first, index)
        if pos is None:
            return []
        nrm, col, tex = self._arr("normal", count, first, index), self._arr("color", count, first, index), self._arr("texcoord", count, first, index)
        out = []
        for k, p in enumerate(pos):
            p3 = tuple(p) + (0.0,) * (3 - len(p))
            n = tuple(nrm[k]) if nrm else tuple(self.normal)
            c = tuple(col[k]) + (1.0,) * (4 - len(col[k])) if col else tuple(self.color)
            t = tuple(tex[k]) + (0.0,) * (2 - len(tex[k])) if tex else tuple(self.texcoord)
            out.append(p3[:3] + n + c[:4] + t[:2])
        return out

    def draw_arrays(self, mode, first, count):
        self.submit(mode, self._arrays_to_verts(count, first))

    def draw_elements(self, mode, count, typ, indices):
        import struct
        fmt = {0x1401: "B", 0x1403: "H", 0x1405: "I"}[typ]
        idx = list(struct.unpack("<%d%s" % (count, fmt), _read(indices, count * TYPE_SIZE[typ])))
        verts = self._arrays_to_verts(max(idx) + 1 if idx else 0)
        self.submit(mode, [verts[i] for i in idx])

    def sphere(self, radius, slices, stacks):
        verts = []
        for i in range(stacks):
            for j in range(slices):
                def p(a, b):
                    t, f = math.pi * a / stacks, 2.0 * math.pi * b / slices
                    nx, ny, nz = math.sin(t) * math.cos(f), math.cos(t), math.sin(t) * math.sin(f)
                    return (radius * nx, radius * ny, radius * nz, nx, ny, nz) + tuple(self.color) + (0.0, 0.0)
                a, b, c, d = p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)
                verts += [a, b, c, a, c, d]
        self.submit(4, verts)


# 固定管線的 GL 函式（先寫進 display list，或立刻執行）
def _ffcall(name):
    def f(*a):
        ff = _CTX["ff"]
        if ff is None:
            _be()
        if ff.recording is not None and name not in ("glEndList", "glGenLists", "glDeleteLists", "glNewList", "glCallList", "glIsList"):
            ff.recording.append((name, a))
            return None
        return GL_FFN[name](ff, *a)
    return f


def _defff(name, fn):
    GL_FFN[name] = fn
    _FN[name] = _ffcall(name)


_defff("glMatrixMode", lambda ff, m: setattr(ff, "matrix_mode", int(_v(m))))
_defff("glLoadIdentity", lambda ff: ff.cur().__setitem__(-1, _ident()))
_defff("glPushMatrix", lambda ff: ff.cur().append(list(ff.cur()[-1])) if len(ff.cur()) < 32 else None)
_defff("glPopMatrix", lambda ff: ff.cur().pop() if len(ff.cur()) > 1 else None)
_defff("glTranslatef", lambda ff, x, y, z: ff.mult([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, float(_v(x)), float(_v(y)), float(_v(z)), 1]))
_defff("glTranslated", GL_FFN["glTranslatef"])
_defff("glScalef", lambda ff, x, y, z: ff.mult([float(_v(x)), 0, 0, 0, 0, float(_v(y)), 0, 0, 0, 0, float(_v(z)), 0, 0, 0, 0, 1]))
_defff("glScaled", GL_FFN["glScalef"])


def _rotate(ff, deg, x, y, z):
    deg, x, y, z = float(_v(deg)), float(_v(x)), float(_v(y)), float(_v(z))
    ln = math.sqrt(x * x + y * y + z * z) or 1.0
    x, y, z = x / ln, y / ln, z / ln
    a = math.radians(deg); c, s = math.cos(a), math.sin(a); t = 1 - c
    ff.mult([t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1])


_defff("glRotatef", _rotate)
_defff("glRotated", _rotate)
_defff("glOrtho", lambda ff, l, r, b, t, n, f: ff.mult(_ortho(*[float(_v(x)) for x in (l, r, b, t, n, f)])))
_defff("glFrustum", lambda ff, l, r, b, t, n, f: ff.mult(_frustum(*[float(_v(x)) for x in (l, r, b, t, n, f)])))
_defff("glLoadMatrixf", lambda ff, m: ff.cur().__setitem__(-1, _floats(m, 16)))
_defff("glMultMatrixf", lambda ff, m: ff.mult(_floats(m, 16)))
_defff("glLoadMatrixd", lambda ff, m: ff.cur().__setitem__(-1, [float(x) for x in __import__("struct").unpack("<16d", _read(m, 128))]))
_defff("glMultMatrixd", lambda ff, m: ff.mult([float(x) for x in __import__("struct").unpack("<16d", _read(m, 128))]))


def _frustum(l, r, b, t, n, f):
    return [2 * n / (r - l), 0, 0, 0, 0, 2 * n / (t - b), 0, 0, (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1, 0, 0, -2 * f * n / (f - n), 0]


_defff("glBegin", lambda ff, mode: setattr(ff, "begin", {"mode": int(_v(mode)), "verts": []}))
_defff("glEnd", lambda ff: ff.end())
_defff("glVertex2f", lambda ff, x, y: ff.vertex(float(_v(x)), float(_v(y))))
_defff("glVertex3f", lambda ff, x, y, z: ff.vertex(float(_v(x)), float(_v(y)), float(_v(z))))
_defff("glVertex2d", GL_FFN["glVertex2f"]); _defff("glVertex3d", GL_FFN["glVertex3f"]); _defff("glVertex2i", GL_FFN["glVertex2f"]); _defff("glVertex3i", GL_FFN["glVertex3f"])
_defff("glVertex3fv", lambda ff, p: ff.vertex(*_floats(p, 3)))
_defff("glVertex2fv", lambda ff, p: ff.vertex(*_floats(p, 2)))
_defff("glColor3f", lambda ff, r, g, b: setattr(ff, "color", (float(_v(r)), float(_v(g)), float(_v(b)), 1.0)))
_defff("glColor4f", lambda ff, r, g, b, a: setattr(ff, "color", (float(_v(r)), float(_v(g)), float(_v(b)), float(_v(a)))))
_defff("glColor3d", GL_FFN["glColor3f"]); _defff("glColor4d", GL_FFN["glColor4f"])
_defff("glColor3ub", lambda ff, r, g, b: setattr(ff, "color", (int(_v(r)) / 255.0, int(_v(g)) / 255.0, int(_v(b)) / 255.0, 1.0)))
_defff("glColor4ub", lambda ff, r, g, b, a: setattr(ff, "color", (int(_v(r)) / 255.0, int(_v(g)) / 255.0, int(_v(b)) / 255.0, int(_v(a)) / 255.0)))
_defff("glColor3fv", lambda ff, p: setattr(ff, "color", tuple(_floats(p, 3)) + (1.0,)))
_defff("glColor4fv", lambda ff, p: setattr(ff, "color", tuple(_floats(p, 4))))
_defff("glNormal3f", lambda ff, x, y, z: setattr(ff, "normal", (float(_v(x)), float(_v(y)), float(_v(z)))))
_defff("glNormal3d", GL_FFN["glNormal3f"])
_defff("glNormal3fv", lambda ff, p: setattr(ff, "normal", tuple(_floats(p, 3))))
_defff("glTexCoord2f", lambda ff, s, t: setattr(ff, "texcoord", (float(_v(s)), float(_v(t)))))
_defff("glTexCoord2d", GL_FFN["glTexCoord2f"])
_defff("glPointSize", lambda ff, s: setattr(ff, "point_size", float(_v(s))))
_defff("glPolygonMode", lambda ff, face, mode: setattr(ff, "polygon_mode", int(_v(mode))))
_defff("glShadeModel", lambda ff, m: None)
_defff("glHint", lambda ff, a, b: None)
_defff("glColorMaterial", lambda ff, face, mode: None)
_defff("glLightModelfv", lambda ff, pname, p: setattr(ff, "model_ambient", tuple(_floats(p, 4))) if int(_v(pname)) == 0x0B53 else None)
_defff("glLightModeli", lambda ff, pname, v: None)
_defff("glLightModelf", lambda ff, pname, v: None)


def _light(ff, light, pname, p):
    i, n = int(_v(light)) - 0x4000, int(_v(pname))
    key = {0x1203: "pos", 0x1200: "amb", 0x1201: "dif", 0x1202: "spe"}.get(n)
    if key and 0 <= i < 8:
        vals = tuple(_floats(p, 4))
        if key == "pos":   # 位置用「設定當下」的模型視圖矩陣轉到眼睛座標，跟固定管線一樣
            m = ff.mv[-1]
            x, y, z, w = vals
            vals = (m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w, w)
        ff.lights[i][key] = vals


_defff("glLightfv", _light)
_defff("glLightf", lambda ff, light, pname, v: None)


def _material(ff, face, pname, p):
    n = int(_v(pname))
    if n == 0x1601:      # GL_SHININESS
        ff.mat["shin"] = _floats(p, 1)[0]
        return
    vals = tuple(_floats(p, 4))
    if n == 0x1602:      # GL_AMBIENT_AND_DIFFUSE
        ff.mat["amb"] = ff.mat["dif"] = vals
    else:
        key = {0x1200: "amb", 0x1201: "dif", 0x1202: "spe", 0x1600: "emi"}.get(n)
        if key:
            ff.mat[key] = vals


_defff("glMaterialfv", _material)
_defff("glMaterialf", lambda ff, face, pname, v: ff.mat.__setitem__("shin", float(_v(v))) if int(_v(pname)) == 0x1601 else None)
_defff("glMateriali", GL_FFN["glMaterialf"])

# 頂點陣列（client 端）：記指標，draw 時才讀記憶體
_ARRAY_KIND = {0x8074: "vertex", 0x8075: "normal", 0x8076: "color", 0x8078: "texcoord"}


def _set_pointer(kind):
    def f(ff, *a):
        if kind == "normal":   # glNormalPointer(type, stride, pointer)
            typ, stride, ptr = a
            size = 3
        else:                  # glVertexPointer／glColorPointer／glTexCoordPointer(size, type, stride, pointer)
            size, typ, stride, ptr = a
        ff.arrays[kind] = (int(_v(size)), int(_v(typ)), int(_v(stride)), _addr(ptr))
    return f


_defff("glVertexPointer", _set_pointer("vertex")); _defff("glNormalPointer", _set_pointer("normal"))
_defff("glColorPointer", _set_pointer("color")); _defff("glTexCoordPointer", _set_pointer("texcoord"))
_defff("glEnableClientState", lambda ff, cap: ff.enabled_arrays.add(_ARRAY_KIND.get(int(_v(cap)), "")))
_defff("glDisableClientState", lambda ff, cap: ff.enabled_arrays.discard(_ARRAY_KIND.get(int(_v(cap)), "")))


# display list：glNewList 之後的固定管線呼叫先記下來，glCallList 時重播（GL_COMPILE_AND_EXECUTE 記下並立刻執行）
def _new_list(ff, lst, mode):
    ff._rec_id, ff._rec_exec, ff.recording = int(_v(lst)), int(_v(mode)) == 0x1301, []


def _end_list(ff):
    if ff.recording is not None:
        calls = ff.recording
        ff.recording = None
        ff.lists[ff._rec_id] = calls
        if ff._rec_exec:
            _replay(ff, calls)


def _replay(ff, calls):
    for name, a in calls:
        GL_FFN[name](ff, *a)


def _call_list(ff, lst):
    calls = ff.lists.get(int(_v(lst)))
    if calls is not None:
        saved, ff.recording = ff.recording, None
        try:
            _replay(ff, calls)
        finally:
            ff.recording = saved


def _gen_lists(ff, n):
    first = ff.list_seq + 1
    ff.list_seq += int(_v(n))
    return first


GL_FFN["glNewList"], GL_FFN["glEndList"], GL_FFN["glCallList"], GL_FFN["glGenLists"] = _new_list, _end_list, _call_list, _gen_lists
for _n in ("glNewList", "glEndList", "glCallList", "glGenLists"):
    _FN[_n] = _ffcall(_n)
_FN["glDeleteLists"] = lambda lst, rng: [_CTX["ff"].lists.pop(i, None) for i in range(int(_v(lst)), int(_v(lst)) + int(_v(rng)))] and None
_FN["glIsList"] = lambda lst: 1 if int(_v(lst)) in _CTX["ff"].lists else 0


# ---------------------------------------------------------------- 後端：WebGL2（真）與假的（測試）
class WebGL2Backend(object):
    """Worker 裡 OffscreenCanvas 的 WebGL2。方法是 WebGL 的 snake_case 版；整數常數就是 GL 的常數。"""

    def __init__(self, w, h):
        import js
        from pyodide.ffi import to_js
        self.js, self.to_js = js, to_js
        self.canvas = js.OffscreenCanvas.new(int(w), int(h))
        attrs = to_js({"preserveDrawingBuffer": True, "antialias": True, "depth": True, "alpha": False, "stencil": True}, dict_converter=js.Object.fromEntries)
        self.g = self.canvas.getContext("webgl2", attrs)
        if self.g is None:
            raise RuntimeError("這個環境沒有 WebGL2（OffscreenCanvas.getContext('webgl2') 回傳空值）")

    def _u8(self, data):
        return self.js.Uint8Array.new(self.to_js(bytes(data)))

    def _f32(self, vals):
        return self.js.Float32Array.new(self.to_js([float(x) for x in vals]))

    def _i32(self, vals):
        return self.js.Int32Array.new(self.to_js([int(x) for x in vals]))

    def clear_color(self, r, g, b, a): self.g.clearColor(r, g, b, a)
    def clear(self, mask): self.g.clear(mask)
    def clear_depth(self, d): self.g.clearDepth(d)
    def clear_stencil(self, s): self.g.clearStencil(s)
    def viewport(self, x, y, w, h): self.g.viewport(x, y, w, h)
    def scissor(self, x, y, w, h): self.g.scissor(x, y, w, h)
    def enable(self, cap): self.g.enable(cap)
    def disable(self, cap): self.g.disable(cap)
    def blend_func(self, s, d): self.g.blendFunc(s, d)
    def blend_func_separate(self, a, b, c, d): self.g.blendFuncSeparate(a, b, c, d)
    def blend_equation(self, m): self.g.blendEquation(m)
    def depth_func(self, f): self.g.depthFunc(f)
    def depth_mask(self, m): self.g.depthMask(bool(m))
    def depth_range(self, a, b): self.g.depthRange(a, b)
    def cull_face(self, m): self.g.cullFace(m)
    def front_face(self, m): self.g.frontFace(m)
    def color_mask(self, r, g, b, a): self.g.colorMask(bool(r), bool(g), bool(b), bool(a))
    def line_width(self, w): self.g.lineWidth(w)
    def pixel_storei(self, p, v): self.g.pixelStorei(p, v)
    def stencil_func(self, f, r, m): self.g.stencilFunc(f, r, m)
    def stencil_op(self, a, b, c): self.g.stencilOp(a, b, c)
    def flush(self): self.g.flush()
    def create_buffer(self): return self.g.createBuffer()
    def delete_buffer(self, b): self.g.deleteBuffer(b)
    def bind_buffer(self, t, b): self.g.bindBuffer(t, b)
    def buffer_data(self, t, data, usage): self.g.bufferData(t, self._u8(data) if not isinstance(data, int) else data, usage)
    def buffer_sub_data(self, t, off, data): self.g.bufferSubData(t, off, self._u8(data))
    def create_vertex_array(self): return self.g.createVertexArray()
    def delete_vertex_array(self, v): self.g.deleteVertexArray(v)
    def bind_vertex_array(self, v): self.g.bindVertexArray(v)
    def create_shader(self, t): return self.g.createShader(t)
    def delete_shader(self, s): self.g.deleteShader(s)
    def shader_source(self, s, src): self.g.shaderSource(s, src)
    def compile_shader(self, s): self.g.compileShader(s)
    def get_shader_parameter(self, s, p): return self.g.getShaderParameter(s, p)
    def get_shader_info_log(self, s): return self.g.getShaderInfoLog(s)
    def create_program(self): return self.g.createProgram()
    def delete_program(self, p): self.g.deleteProgram(p)
    def attach_shader(self, p, s): self.g.attachShader(p, s)
    def bind_attrib_location(self, p, i, n): self.g.bindAttribLocation(p, i, n)
    def link_program(self, p): self.g.linkProgram(p)
    def use_program(self, p): self.g.useProgram(p)
    def get_program_parameter(self, p, n): return self.g.getProgramParameter(p, n)
    def get_program_info_log(self, p): return self.g.getProgramInfoLog(p)
    def get_attrib_location(self, p, n): return self.g.getAttribLocation(p, n)
    def get_uniform_location(self, p, n): return self.g.getUniformLocation(p, n)

    def uniform(self, kind, n, loc, vals, vector=False):
        if loc is None:
            return
        g = self.g
        if kind == "f":
            (g.uniform1fv if n == 1 else g.uniform2fv if n == 2 else g.uniform3fv if n == 3 else g.uniform4fv)(loc, self._f32(vals))
        else:
            (g.uniform1iv if n == 1 else g.uniform2iv if n == 2 else g.uniform3iv if n == 3 else g.uniform4iv)(loc, self._i32(vals))

    def uniform_matrix(self, n, loc, transpose, vals):
        if loc is not None:
            (self.g.uniformMatrix2fv if n == 2 else self.g.uniformMatrix3fv if n == 3 else self.g.uniformMatrix4fv)(loc, bool(transpose), self._f32(vals))

    def enable_vertex_attrib_array(self, i): self.g.enableVertexAttribArray(i)
    def disable_vertex_attrib_array(self, i): self.g.disableVertexAttribArray(i)
    def vertex_attrib_pointer(self, i, size, typ, norm, stride, off): self.g.vertexAttribPointer(i, size, typ, norm, stride, off)
    def vertex_attrib_divisor(self, i, d): self.g.vertexAttribDivisor(i, d)
    def draw_arrays(self, mode, first, count): self.g.drawArrays(mode, first, count)
    def draw_elements(self, mode, count, typ, off): self.g.drawElements(mode, count, typ, off)
    def draw_arrays_instanced(self, mode, first, count, n): self.g.drawArraysInstanced(mode, first, count, n)
    def draw_elements_instanced(self, mode, count, typ, off, n): self.g.drawElementsInstanced(mode, count, typ, off, n)
    def create_texture(self): return self.g.createTexture()
    def delete_texture(self, t): self.g.deleteTexture(t)
    def bind_texture(self, target, t): self.g.bindTexture(target, t)
    def active_texture(self, unit): self.g.activeTexture(unit)
    def generate_mipmap(self, target): self.g.generateMipmap(target)
    def tex_parameteri(self, target, p, v): self.g.texParameteri(target, p, int(v))

    def tex_image_2d(self, target, level, internal, w, h, border, fmt, typ, data):
        self.g.texImage2D(target, level, internal, w, h, border, fmt, typ, self._u8(data) if data is not None else None)

    def tex_sub_image_2d(self, target, level, x, y, w, h, fmt, typ, data):
        self.g.texSubImage2D(target, level, x, y, w, h, fmt, typ, self._u8(data))

    def read_pixels(self, x, y, w, h, fmt, typ):
        buf = self.js.Uint8Array.new(w * h * FMT_COMP.get(fmt, 4) * TYPE_SIZE.get(typ, 1))
        self.g.readPixels(x, y, w, h, fmt, typ, buf)
        return bytes(buf.to_py())

    def resize(self, w, h):
        self.canvas.width, self.canvas.height = int(w), int(h)

    def capture_png(self):
        """畫面 → PNG 位元組（同步等 convertToBlob；Worker 的程式在 JSPI 裡，可以等 Promise）。"""
        from pyodide.ffi import run_sync
        blob = run_sync(self.canvas.convertToBlob(self.to_js({"type": "image/png"}, dict_converter=self.js.Object.fromEntries)))
        return bytes(run_sync(blob.arrayBuffer()).to_bytes())


# ---------------------------------------------------------------- 平台外掛
class _FaFunction(object):
    """PyOpenGL 期待的「C 函式」物件：可呼叫、帶 argtypes／restype／errcheck；呼叫時照 argtypes 轉換參數（跟 ctypes 一樣）再交給驅動。"""

    def __init__(self, name, impl, argtypes, restype):
        self.__name__, self.impl, self.argtypes, self.restype, self.errcheck = name, impl, list(argtypes or ()), restype, None

    def __call__(self, *args):
        conv = []
        for t, a in zip(self.argtypes, args):
            # ctypes 的純量／指標型別：原樣傳（ctypes 自己的 from_param 會回傳讀不出值的 CArgObject）；PyOpenGL 的陣列型別（ArrayDatatype 等）才用它的 from_param 轉成指標
            native = isinstance(t, type) and (issubclass(t, (ctypes._SimpleCData, ctypes._Pointer, ctypes.Array)) or t.__module__ == "ctypes")
            fp = None if native else getattr(t, "from_param", None)
            conv.append(fp(a) if fp is not None else a)
        conv.extend(args[len(self.argtypes):])
        r = self.impl(*conv)
        if self.errcheck is not None:
            r = self.errcheck(r, self, tuple(conv))
        return r


def _make_platform():
    from OpenGL.platform import baseplatform

    class _Lib(object):
        def __init__(self, name):
            self.name = name

        def __repr__(self):
            return "<fa %s>" % self.name

        def __getattr__(self, attr):   # PyOpenGL 偶爾直接取 dll.glGetError 這類符號
            impl = _FN.get(attr)
            if impl is None:
                raise AttributeError(attr)
            return _FaFunction(attr, impl, [], ctypes.c_int)

    class FaPlatform(baseplatform.BasePlatform):
        """PyOpenGL 的平台：GL 函式導到驅動（WebGL2＋固定管線模擬）。"""
        DEFAULT_FUNCTION_TYPE = staticmethod(ctypes.CFUNCTYPE)
        EXPORTED_NAMES = baseplatform.BasePlatform.EXPORTED_NAMES[:]

        def __init__(self):
            self.GL, self.GLU, self.GLUT, self.GLE = _Lib("GL"), _Lib("GLU"), _Lib("GLUT"), _Lib("GLE")

        def GetCurrentContext(self):
            return 1 if _CTX["backend"] is not None else 0

        def CurrentContextIsValid(self):
            return self.GetCurrentContext()

        def getExtensionProcedure(self, name):
            return None

        def getGLUTFontPointer(self, constant):
            raise NotImplementedError("沒有 GLUT")

        def constructFunction(self, functionName, dll, resultType=ctypes.c_int, argTypes=(), doc=None, argNames=(), extension=None, deprecated=False,
                              module=None, force_extension=False, error_checker=None):
            impl = _FN.get(functionName)
            if impl is None:
                raise AttributeError(functionName)   # createBaseFunction 會改成 PyOpenGL 的 NullFunctionError
            func = _FaFunction(functionName, impl, argTypes, resultType)
            func.__doc__, func.argNames, func.DLL, func.extension, func.deprecated = doc, list(argNames or ()), dll, extension, deprecated
            return self.wrapLogging(self.wrapContextCheck(self.errorChecking(func, dll, error_checker=error_checker), dll))

    return FaPlatform


def __getattr__(name):
    """PEP 562：PyOpenGL 載入平台時才會取 FaPlatform（那時 OpenGL.platform 正在 import，baseplatform 才 import 得進來）。"""
    if name == "FaPlatform":
        cls = _make_platform()
        globals()["FaPlatform"] = cls
        return cls
    raise AttributeError(name)


def register():
    """讓 PyOpenGL 選用這個平台。要在 import OpenGL.platform（import OpenGL.GL 也會）之前呼叫；沒有安裝 PyOpenGL 就什麼都不做。回傳是否登記成功。"""
    try:
        import importlib.util
        if importlib.util.find_spec("OpenGL") is None:
            return False
    except Exception:
        return False
    if "OpenGL.platform" in sys.modules:
        return sys.modules["OpenGL.platform"].PLATFORM.__class__.__name__ == "FaPlatform"   # 已經載入了：只有當時選的就是這個才算成功
    from OpenGL import plugins   # 只 import plugins（不會載入 OpenGL.platform）
    if plugins.PlatformPlugin.by_name("fa") is None:
        plugins.PlatformPlugin("fa", __name__ + ".FaPlatform")
    os.environ["PYOPENGL_PLATFORM"] = "fa"
    return True


# ---------------------------------------------------------------- 上下文與畫面
def create_context(w, h, backend=None):
    """建立（或重用）WebGL2 上下文與固定管線模擬器。backend 可注入（測試）。回傳 backend。"""
    if _CTX["backend"] is not None:
        _CTX["backend"].resize(w, h) if hasattr(_CTX["backend"], "resize") else None
    else:
        _CTX["backend"] = backend if backend is not None else WebGL2Backend(w, h)
    _CTX["w"], _CTX["h"] = int(w), int(h)
    if _CTX["ff"] is None:
        _CTX["ff"] = FixedFunction(_CTX["backend"])
    _CTX["ff"].viewport = (0, 0, int(w), int(h))
    _CTX["backend"].viewport(0, 0, int(w), int(h))
    return _CTX["backend"]


def active():
    return _CTX["backend"] is not None


def frame_png():
    """目前畫面的 PNG 位元組（pygame.display.flip／gl3d 的 View.show 之後呼叫）。"""
    return _be().capture_png()


def reset():
    """測試用：丟掉上下文與所有名字。"""
    _CTX.update(backend=None, w=0, h=0, ff=None)
    for t in _OBJ.values():
        t.t.clear(); t.n = 0
    _BOUND.update(array=0, element=0, program=0, vao=0)
