# -*- coding: utf-8 -*-
"""
gl3d -- small 3D helpers on top of PyOpenGL (the real pip package): an orbit camera, matrix math, geometry (cube, sphere, grid, axes),
a few built-in GLSL programs, and a retained "frame" of commands (clear, use, uniforms, attributes, draw) that View executes with PyOpenGL
calls (glCreateShader, glGenBuffers, glBufferData, glUniform*, glVertexAttribPointer, glDrawArrays …). The calls go to WebGL2 through the
fa_opengl_platform backend, so a program that uses gl3d and one that calls OpenGL.GL directly draw the same way; gl3d adds no protocol of its own.

    import gui, gl3d
    w = gui.Window("cube", width=520)
    view = gl3d.View(w, 480, 360, fps=30)               # an orbit camera (drag to turn, Ctrl+wheel to zoom) and a WebGL2 context
    cube = gl3d.cube(1.0)
    view.buffer("cube", cube.vertices)                  # interleaved: x y z  nx ny nz  r g b
    view.buffer("cube_i", cube.indices, "u16")
    while not w.closed:
        ev = w.wait(timeout=1, also=())                  # or w.poll() in a game loop
        if ev and view.handle(ev) == "frame":
            f = view.frame()                             # starts a frame: clear + depth test + the camera's matrices
            f.mesh("lit", "cube", "cube_i", cube.index_count, color=(0.9, 0.6, 0.2))
            view.show(f)                                 # runs the frame with PyOpenGL, then shows the picture in the window

Contents: math (mat4_* functions, column-major lists of 16 floats, as OpenGL wants them), Camera (orbit), geometry, built-in programs (flat, lit,
points, dots, glow), FrameBuilder (commands), View (window canvas + camera + buffers + frame). Limits: the picture of a frame is a PNG of at most 1 MB.
Shaders run on the GPU unchecked beyond the browser's own validation: a shader with an endless loop can hang the GPU.
"""
import array as _array
import math

import gui

# ---------------------------------------------------------------- math (column-major mat4 as a list of 16 floats)


def mat4_identity():
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def mat4_mul(a, b):
    """a * b (apply b first, then a), both column-major."""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    return out


def mat4_translate(x, y, z):
    m = mat4_identity(); m[12], m[13], m[14] = x, y, z
    return m


def mat4_scale(x, y=None, z=None):
    y = x if y is None else y
    z = x if z is None else z
    m = mat4_identity(); m[0], m[5], m[10] = x, y, z
    return m


def mat4_rotate_x(a):
    c, s = math.cos(a), math.sin(a)
    m = mat4_identity(); m[5], m[6], m[9], m[10] = c, s, -s, c
    return m


def mat4_rotate_y(a):
    c, s = math.cos(a), math.sin(a)
    m = mat4_identity(); m[0], m[2], m[8], m[10] = c, -s, s, c
    return m


def mat4_rotate_z(a):
    c, s = math.cos(a), math.sin(a)
    m = mat4_identity(); m[0], m[1], m[4], m[5] = c, s, -s, c
    return m


def mat4_perspective(fovy, aspect, near, far):
    """OpenGL perspective (clip z from -1 to 1). fovy in radians."""
    f = 1.0 / math.tan(fovy / 2.0)
    m = [0.0] * 16
    m[0] = f / aspect; m[5] = f
    m[10] = (far + near) / (near - far); m[11] = -1.0
    m[14] = 2.0 * far * near / (near - far)
    return m


def _sub(a, b): return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
def _cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
def _dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _norm(a):
    n = math.sqrt(_dot(a, a)) or 1.0
    return [a[0] / n, a[1] / n, a[2] / n]


def mat4_look_at(eye, center, up=(0.0, 1.0, 0.0)):
    f = _norm(_sub(center, eye))
    s = _norm(_cross(f, up))
    u = _cross(s, f)
    return [s[0], u[0], -f[0], 0.0, s[1], u[1], -f[1], 0.0, s[2], u[2], -f[2], 0.0, -_dot(s, eye), -_dot(u, eye), _dot(f, eye), 1.0]


def mat3_normal(m):
    """The upper-left 3x3 of a model matrix as a list of 9 (enough for rotations and uniform scales; use it for the lit program's normals)."""
    return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]


# ---------------------------------------------------------------- camera


class Camera(object):
    """An orbit camera: yaw and pitch (radians) around target at dist. Feed it the canvas's mouse and wheel events with handle()."""

    def __init__(self, target=(0.0, 0.0, 0.0), dist=4.0, yaw=0.6, pitch=0.4, fovy=0.9, near=0.05, far=200.0):
        self.target = list(target); self.dist = float(dist); self.yaw = float(yaw); self.pitch = float(pitch)
        self.fovy = fovy; self.near = near; self.far = far
        self._drag = None

    def eye(self):
        cp = math.cos(self.pitch)
        return [self.target[0] + self.dist * cp * math.sin(self.yaw), self.target[1] + self.dist * math.sin(self.pitch),
                self.target[2] + self.dist * cp * math.cos(self.yaw)]

    def view(self):
        return mat4_look_at(self.eye(), self.target)

    def projection(self, aspect):
        return mat4_perspective(self.fovy, aspect, self.near, self.far)

    def handle(self, ev):
        """Turn a canvas event into camera motion. Returns True if the camera changed. Left drag turns, Ctrl+wheel zooms."""
        kind = ev.get("event")
        v = ev.get("value") or {}
        if kind == "mouse":
            k = v.get("kind")
            if k == "down":
                self._drag = (v["x"], v["y"])
            elif k == "up":
                self._drag = None
            elif k == "move" and self._drag is not None:
                dx, dy = v["x"] - self._drag[0], v["y"] - self._drag[1]
                self._drag = (v["x"], v["y"])
                self.yaw -= dx * 0.01
                self.pitch = max(-1.5, min(1.5, self.pitch + dy * 0.01))
                return True
        elif kind == "wheel":
            self.dist = max(0.3, min(100.0, self.dist * (1.0 + 0.001 * v.get("dy", 0))))
            return True
        return False


# ---------------------------------------------------------------- geometry
# Interleaved float32 vertices: x y z  nx ny nz  r g b (9 floats = 36 bytes). Use the "lit" program with them: stride 36, offsets 0, 12, 24.


class Mesh(object):
    def __init__(self, vertices, indices):
        self.vertices = _array.array("f", vertices)
        self.indices = _array.array("H" if len(vertices) // 9 < 65536 else "I", indices)
        self.index_type = "u16" if self.indices.typecode == "H" else "u32"
        self.index_count = len(self.indices)


def cube(size=1.0, color=(1.0, 1.0, 1.0)):
    h = size / 2.0
    faces = [((0, 0, 1), (-h, -h, h), (h, -h, h), (h, h, h), (-h, h, h)), ((0, 0, -1), (h, -h, -h), (-h, -h, -h), (-h, h, -h), (h, h, -h)),
             ((1, 0, 0), (h, -h, h), (h, -h, -h), (h, h, -h), (h, h, h)), ((-1, 0, 0), (-h, -h, -h), (-h, -h, h), (-h, h, h), (-h, h, -h)),
             ((0, 1, 0), (-h, h, h), (h, h, h), (h, h, -h), (-h, h, -h)), ((0, -1, 0), (-h, -h, -h), (h, -h, -h), (h, -h, h), (-h, -h, h))]
    vs, ix = [], []
    for n, a, b, c, d in faces:
        base = len(vs) // 9
        for p in (a, b, c, d):
            vs.extend([p[0], p[1], p[2], n[0], n[1], n[2], color[0], color[1], color[2]])
        ix.extend([base, base + 1, base + 2, base, base + 2, base + 3])
    return Mesh(vs, ix)


def sphere(radius=1.0, segments=24, color=(1.0, 1.0, 1.0)):
    vs, ix = [], []
    rings = max(3, segments // 2)
    for i in range(rings + 1):
        phi = math.pi * i / rings
        for j in range(segments + 1):
            th = 2.0 * math.pi * j / segments
            nx, ny, nz = math.sin(phi) * math.cos(th), math.cos(phi), math.sin(phi) * math.sin(th)
            vs.extend([radius * nx, radius * ny, radius * nz, nx, ny, nz, color[0], color[1], color[2]])
    for i in range(rings):
        for j in range(segments):
            a = i * (segments + 1) + j
            b = a + segments + 1
            ix.extend([a, b, a + 1, a + 1, b, b + 1])
    return Mesh(vs, ix)


def grid_lines(half=5, step=1.0, y=0.0, color=(0.35, 0.35, 0.4)):
    """Line segments of a floor grid, as 'flat' vertices (x y z r g b, 6 floats): draw with mode 'lines'."""
    vs = []
    n = int(half / step)
    for i in range(-n, n + 1):
        t = i * step
        vs.extend([t, y, -half, color[0], color[1], color[2], t, y, half, color[0], color[1], color[2]])
        vs.extend([-half, y, t, color[0], color[1], color[2], half, y, t, color[0], color[1], color[2]])
    return _array.array("f", vs)


def axes_lines(length=1.0):
    """Three colored axis segments (x red, y green, z blue) as 'flat' vertices (6 floats each): mode 'lines', 6 vertices."""
    L = length
    return _array.array("f", [0, 0, 0, 1, 0.2, 0.2, L, 0, 0, 1, 0.2, 0.2, 0, 0, 0, 0.2, 1, 0.2, 0, L, 0, 0.2, 1, 0.2, 0, 0, 0, 0.3, 0.5, 1, 0, 0, L, 0.3, 0.5, 1])


# ---------------------------------------------------------------- built-in programs (GLSL ES 3.00)

FLAT_VS = """#version 300 es
in vec3 pos; in vec3 col; uniform mat4 mvp; out vec3 vcol;
void main(){ vcol = col; gl_Position = mvp * vec4(pos, 1.0); }"""
FLAT_FS = """#version 300 es
precision mediump float; in vec3 vcol; out vec4 o;
void main(){ o = vec4(vcol, 1.0); }"""

LIT_VS = """#version 300 es
in vec3 pos; in vec3 nrm; in vec3 col; uniform mat4 mvp; uniform mat3 nmat; out vec3 vn; out vec3 vcol;
void main(){ vn = nmat * nrm; vcol = col; gl_Position = mvp * vec4(pos, 1.0); }"""
LIT_FS = """#version 300 es
precision mediump float; in vec3 vn; in vec3 vcol; uniform vec3 tint; uniform vec3 light; out vec4 o;
void main(){ float d = max(dot(normalize(vn), normalize(light)), 0.0); o = vec4(vcol * tint * (0.25 + 0.75 * d), 1.0); }"""

# points: one vertex = x y z (+ optional per-point color r g b when the 'col' attribute is given); round, shaded sprites; size in pixels
POINTS_VS = """#version 300 es
in vec3 pos; in vec3 col; uniform mat4 mvp; uniform float size; uniform vec3 tint; out vec3 vcol;
void main(){ vcol = col * tint; gl_Position = mvp * vec4(pos, 1.0); gl_PointSize = max(1.0, size / max(gl_Position.w, 0.2)); }"""
POINTS_FS = """#version 300 es
precision mediump float; in vec3 vcol; out vec4 o;
void main(){ vec2 d = gl_PointCoord - vec2(0.5); float r = dot(d, d); if (r > 0.25) discard; o = vec4(vcol * (1.0 - 1.4 * r), 1.0); }"""

# dots: like points, but every point has the same color (the tint uniform); positions only, no color attribute
DOTS_VS = """#version 300 es
in vec3 pos; uniform mat4 mvp; uniform float size; out float vd;
void main(){ gl_Position = mvp * vec4(pos, 1.0); vd = 1.0; gl_PointSize = max(1.0, size / max(gl_Position.w, 0.2)); }"""
DOTS_FS = """#version 300 es
precision mediump float; in float vd; uniform vec3 tint; out vec4 o;
void main(){ vec2 d = gl_PointCoord - vec2(0.5); float r = dot(d, d); if (r > 0.25) discard; o = vec4(tint * (1.0 - 1.4 * r) * vd, 1.0); }"""

# glow: gaussian sprites for additive blending (use with state "additive"); one color per point; size is in pixels at distance `ref`
GLOW_VS = """#version 300 es
in vec3 pos; in vec3 col; uniform mat4 mvp; uniform float size; uniform float ref; out vec3 vcol;
void main(){ vcol = col; gl_Position = mvp * vec4(pos, 1.0); gl_PointSize = max(1.0, size * ref / max(gl_Position.w, 0.2)); }"""
GLOW_FS = """#version 300 es
precision mediump float; in vec3 vcol; uniform float gain; out vec4 o;
void main(){ vec2 d = gl_PointCoord - vec2(0.5); float r2 = dot(d, d) * 4.0; if (r2 > 1.0) discard; o = vec4(vcol, gain * exp(-4.0 * r2)); }"""

PROGRAMS = {"flat": (FLAT_VS, FLAT_FS), "lit": (LIT_VS, LIT_FS), "points": (POINTS_VS, POINTS_FS), "dots": (DOTS_VS, DOTS_FS),
            "glow": (GLOW_VS, GLOW_FS)}

# ---------------------------------------------------------------- frame commands


class FrameBuilder(object):
    """Collects the commands of one frame. Raw commands: clear, state, use, uf, ui, attr, index, draw. Helpers: mesh, lines, points."""

    def __init__(self, view_proj, aspect=1.0):
        self.cmds = []
        self.vp = view_proj
        self.aspect = aspect

    # -- raw commands
    def clear(self, r=0.05, g=0.06, b=0.09, a=1.0): self.cmds.append(["clear", r, g, b, a]); return self
    def state(self, name, on=True): self.cmds.append(["state", name, 1 if on else 0]); return self
    def use(self, prog): self.cmds.append(["use", prog]); return self
    def uf(self, name, *vals): self.cmds.append(["uf", name] + [float(v) for v in vals]); return self
    def ui(self, name, v): self.cmds.append(["ui", name, int(v)]); return self
    def attr(self, name, buf, size, stride, offset=0, divisor=0): self.cmds.append(["attr", name, buf, size, stride, offset, divisor]); return self
    def index(self, buf): self.cmds.append(["index", buf]); return self
    def draw(self, mode, first, count, instances=1): self.cmds.append(["draw", mode, first, count, instances]); return self

    def glow(self, pos_buf, col_buf, count, size=15.0, ref=50.0, gain=0.5, model=None, restore=True):
        """Glowing point sprites with additive blending (a gaussian falloff; overlapping sprites add up). pos_buf holds count x 3 floats (x y z),
        col_buf count x 3 floats (r g b, 0..1). size is the sprite's width in pixels at distance ref from the camera, gain scales its brightness.
        Depth testing is switched off while drawing; restore=True switches it (and additive blending) back afterwards."""
        m = model or mat4_identity()
        self.state("depth", False).state("additive", True)
        self.use("glow").uf("mvp", *mat4_mul(self.vp, m)).uf("size", size).uf("ref", ref).uf("gain", gain)
        self.attr("pos", pos_buf, 3, 12, 0).attr("col", col_buf, 3, 12, 0)
        self.draw("points", 0, count)
        if restore:
            self.state("additive", False).state("depth", True)
        return self

    # -- helpers (model = a model matrix; default identity)
    def mesh(self, prog, vbuf, ibuf, index_count, model=None, color=(1.0, 1.0, 1.0), light=(0.5, 0.8, 0.6)):
        """Draw an indexed mesh built by cube() / sphere() with the 'lit' program (stride 36: pos, normal, color)."""
        m = model or mat4_identity()
        self.use(prog).uf("mvp", *mat4_mul(self.vp, m)).uf("nmat", *mat3_normal(m)).uf("tint", *color).uf("light", *light)
        self.attr("pos", vbuf, 3, 36, 0).attr("nrm", vbuf, 3, 36, 12).attr("col", vbuf, 3, 36, 24)
        self.index(ibuf).draw("triangles", 0, index_count)
        return self

    def lines(self, prog, vbuf, vertex_count, model=None, mode="lines"):
        """Draw 'flat' vertices (x y z r g b, stride 24) as lines."""
        m = model or mat4_identity()
        self.use(prog).uf("mvp", *mat4_mul(self.vp, m))
        self.attr("pos", vbuf, 3, 24, 0).attr("col", vbuf, 3, 24, 12)
        self.draw(mode, 0, vertex_count)
        return self

    def points(self, vbuf, count, stride=12, color_offset=None, size=6.0, model=None, tint=(1.0, 1.0, 1.0)):
        """Draw round point sprites (size in pixels at distance 1). Positions are 3 floats at offset 0 of each stride-byte vertex. With
        color_offset (3 floats per point) each point has its own color (the 'points' program, multiplied by tint); without it every point
        is tint (the 'dots' program)."""
        m = model or mat4_identity()
        self.use("dots" if color_offset is None else "points").uf("mvp", *mat4_mul(self.vp, m)).uf("size", size).uf("tint", *tint)
        self.attr("pos", vbuf, 3, stride, 0)
        if color_offset is not None:
            self.attr("col", vbuf, 3, stride, color_offset)
        self.draw("points", 0, count)
        return self


# ---------------------------------------------------------------- the view: a window canvas, a WebGL2 context (PyOpenGL) and a camera

_DRAW_MODES = {"points": 0x0000, "lines": 0x0001, "line_strip": 0x0003, "triangles": 0x0004, "triangle_strip": 0x0005}
_BUFFER_KINDS = {"f32": 4, "u16": 2, "u32": 4}


class _Renderer(object):
    """Executes gl3d's buffers, programs and frame commands with real PyOpenGL calls."""

    def __init__(self, width, height):
        import fa_opengl_platform as G
        G.register()
        G.create_context(width, height)
        import ctypes
        from OpenGL import GL
        self.G, self.GL, self.ct = G, GL, ctypes
        self.programs, self.buffers, self.locs = {}, {}, {}
        self.current = None
        self.errors = []

    def resize(self, width, height):
        self.G.create_context(width, height)

    def program(self, name, vs, fs):
        GL = self.GL
        shaders = []
        for kind, src in ((GL.GL_VERTEX_SHADER, vs), (GL.GL_FRAGMENT_SHADER, fs)):
            sh = GL.glCreateShader(kind)
            GL.glShaderSource(sh, src)
            GL.glCompileShader(sh)
            if not GL.glGetShaderiv(sh, GL.GL_COMPILE_STATUS):
                log = GL.glGetShaderInfoLog(sh)
                self.errors.append("shader %s: %s" % (name, log.decode("utf-8", "replace") if isinstance(log, bytes) else log))
                return False
            shaders.append(sh)
        prog = GL.glCreateProgram()
        for sh in shaders:
            GL.glAttachShader(prog, sh)
        GL.glLinkProgram(prog)
        if not GL.glGetProgramiv(prog, GL.GL_LINK_STATUS):
            log = GL.glGetProgramInfoLog(prog)
            self.errors.append("program %s: %s" % (name, log.decode("utf-8", "replace") if isinstance(log, bytes) else log))
            return False
        self.programs[name] = prog
        self.locs = {k: v for k, v in self.locs.items() if k[0] != name}
        return True

    def buffer(self, name, data, kind):
        GL, ct = self.GL, self.ct
        if data is None:
            old = self.buffers.pop(name, None)
            if old:
                GL.glDeleteBuffers(1, [old[0]])
            return
        raw = gui._gl_bytes(data, kind)
        buf = (ct.c_ubyte * len(raw)).from_buffer_copy(raw)
        vbo = self.buffers[name][0] if name in self.buffers else GL.glGenBuffers(1)
        target = GL.GL_ELEMENT_ARRAY_BUFFER if kind in ("u16", "u32") else GL.GL_ARRAY_BUFFER
        GL.glBindBuffer(target, vbo)
        GL.glBufferData(target, len(raw), buf, GL.GL_STATIC_DRAW)
        self.buffers[name] = (vbo, kind, target)

    def _loc(self, kind, name):
        key = (self.current, kind, name)
        if key not in self.locs:
            prog = self.programs[self.current]
            self.locs[key] = (self.GL.glGetUniformLocation(prog, name) if kind == "u" else self.GL.glGetAttribLocation(prog, name))
        return self.locs[key]

    def run(self, cmds):
        GL, ct = self.GL, self.ct
        enabled, index = [], None
        for c in cmds:
            op = c[0]
            if op == "clear":
                GL.glClearColor(c[1], c[2], c[3], c[4]); GL.glClear(GL.GL_COLOR_BUFFER_BIT | GL.GL_DEPTH_BUFFER_BIT)
            elif op == "state":
                name, on = c[1], bool(c[2])
                if name == "depth":
                    (GL.glEnable if on else GL.glDisable)(GL.GL_DEPTH_TEST)
                elif name == "cull":
                    (GL.glEnable if on else GL.glDisable)(GL.GL_CULL_FACE)
                elif name in ("blend", "additive"):
                    (GL.glEnable if on else GL.glDisable)(GL.GL_BLEND)
                    if on:
                        GL.glBlendFunc(GL.GL_SRC_ALPHA, GL.GL_ONE if name == "additive" else GL.GL_ONE_MINUS_SRC_ALPHA)
            elif op == "use":
                self.current = c[1]
                GL.glUseProgram(self.programs[c[1]])
            elif op == "uf":
                loc, vals = self._loc("u", c[1]), [float(x) for x in c[2:]]
                if loc is None or loc < 0:
                    continue
                n = len(vals)
                if n == 16:
                    GL.glUniformMatrix4fv(loc, 1, False, vals)
                elif n == 9:
                    GL.glUniformMatrix3fv(loc, 1, False, vals)
                else:
                    {1: GL.glUniform1f, 2: GL.glUniform2f, 3: GL.glUniform3f, 4: GL.glUniform4f}[n](loc, *vals)
            elif op == "ui":
                loc = self._loc("u", c[1])
                if loc is not None and loc >= 0:
                    GL.glUniform1i(loc, int(c[2]))
            elif op == "attr":
                _, name, buf, size, stride, offset, divisor = c
                loc = self._loc("a", name)
                if loc is None or loc < 0:
                    continue
                vbo = self.buffers[buf][0]
                GL.glBindBuffer(GL.GL_ARRAY_BUFFER, vbo)
                GL.glEnableVertexAttribArray(loc)
                GL.glVertexAttribPointer(loc, size, GL.GL_FLOAT, False, stride, ct.c_void_p(offset))
                GL.glVertexAttribDivisor(loc, divisor)
                enabled.append(loc)
            elif op == "index":
                index = self.buffers[c[1]]
            elif op == "draw":
                _, mode, first, count, instances = c
                m = _DRAW_MODES[mode]
                if index is not None:
                    typ = GL.GL_UNSIGNED_SHORT if index[1] == "u16" else GL.GL_UNSIGNED_INT
                    GL.glBindBuffer(GL.GL_ELEMENT_ARRAY_BUFFER, index[0])
                    off = ct.c_void_p(first * _BUFFER_KINDS[index[1]])
                    (GL.glDrawElementsInstanced(m, count, typ, off, instances) if instances > 1 else GL.glDrawElements(m, count, typ, off))
                    index = None
                else:
                    (GL.glDrawArraysInstanced(m, first, count, instances) if instances > 1 else GL.glDrawArrays(m, first, count))
        for loc in enabled:
            GL.glVertexAttribDivisor(loc, 0)
            GL.glDisableVertexAttribArray(loc)
        GL.glUseProgram(0)


class View(object):
    """A canvas in window w, an orbit camera, a WebGL2 context driven through PyOpenGL, and the built-in programs already compiled."""

    PICTURE = "gl3d"

    def __init__(self, w, width=480, height=360, fps=30, parent=None, camera=None, grow=None, fit=False):
        self.w = w
        kw = {"grow": grow} if grow else {}
        self.nid = w.canvas(width, height, fps=fps, parent=parent, fit=fit, **kw)   # the page shows each rendered frame as a picture on this canvas
        self.width, self.height = int(width), int(height)
        self.camera = camera or Camera()
        self.errors = []
        self._r = _Renderer(self.width, self.height)
        for name, (vs, fs) in PROGRAMS.items():
            self.program(name, vs, fs)

    def program(self, name, vs, fs):
        if not self._r.program(name, vs, fs):
            self.errors.append(self._r.errors[-1])

    def buffer(self, name, data, kind="f32"):
        self._r.buffer(name, data, kind)

    def handle(self, ev):
        """Pass any window event here. Returns "frame" on the canvas's frame tick (time to draw), "camera" if the camera moved,
        "resize" if the canvas changed size, else None. Shader errors are in self.errors."""
        if not ev or ev.get("node") != self.nid:
            return None
        kind = ev.get("event")
        if kind == "frame":
            return "frame"
        if kind == "resize":
            v = ev.get("value") or {}
            self.width, self.height = int(v.get("width", self.width)), int(v.get("height", self.height))
            self._r.resize(self.width, self.height)
            return "resize"
        if self.camera.handle(ev):
            return "camera"
        return None

    def frame(self, clear=(0.05, 0.06, 0.09, 1.0), depth=True):
        aspect = self.width / float(self.height)
        f = FrameBuilder(mat4_mul(self.camera.projection(aspect), self.camera.view()), aspect)
        f.clear(*clear).state("depth", depth)
        return f

    def show(self, frame):
        self._r.run(frame.cmds)
        data, mime = self._r.G.frame_image()
        self.w.image(self.nid, data, mime, name=self.PICTURE)
        self.w.draw(self.nid, [["image", self.PICTURE, 0, 0, self.width, self.height]])
