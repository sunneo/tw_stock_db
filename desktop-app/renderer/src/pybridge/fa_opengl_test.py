# -*- coding: utf-8 -*-
# fa_opengl_platform（真的 PyOpenGL 接 WebGL2 的平台後端）對假後端的測試。需要 pip 的 PyOpenGL（沒有就略過）。Run: python3 renderer/src/pybridge/fa_opengl_test.py
import ctypes, os, struct, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
try:
    import OpenGL  # noqa: F401
except ImportError:
    print("fa_opengl: 略過（沒有安裝 PyOpenGL）"); sys.exit(0)
import fa_opengl_platform as P
bad = []
def check(n, c, x=None):
    if not c: bad.append(n + (" " + repr(x)[:240] if x is not None else ""))
class Fake(object):
    def __init__(self): self.calls = []; self.n = 0
    def log(self, name): return [c for c in self.calls if c[0] == name]
    def __getattr__(self, name):
        def f(*a, **k):
            self.calls.append((name, a))
            if name.startswith("create_"): self.n += 1; return "h%d" % self.n
            if name in ("get_shader_parameter", "get_program_parameter"): return True
            if name in ("get_shader_info_log", "get_program_info_log"): return ""
            if name == "get_attrib_location": return 0
            if name == "get_uniform_location": return "loc"
            if name == "read_pixels": return b""
            return None
        return f
    def capture_png(self): return b"\x89PNG\r\n\x1a\nfake"
    def capture_image(self, max_bytes=1000000): return self.capture_png(), "image/png"
check("register 成功", P.register() is True and os.environ.get("PYOPENGL_PLATFORM") == "fa")
from OpenGL.GL import *   # noqa: F401,F403
from OpenGL.GLU import *  # noqa: F401,F403
import OpenGL.platform as plat
check("平台是 FaPlatform", plat.PLATFORM.__class__.__name__ == "FaPlatform", plat.PLATFORM)
try:
    glClear(GL_COLOR_BUFFER_BIT); check("沒有上下文要丟 NoContext", False)
except Exception as e:
    check("沒有上下文要丟 NoContext", type(e).__name__ == "NoContext", type(e).__name__)
fk = Fake(); P.create_context(64, 48, backend=fk)
glClearColor(0.1, 0.2, 0.3, 1.0); glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT); glViewport(0, 0, 64, 48)
check("現代 API 一對一轉發", fk.log("clear_color")[-1][1] == (ctypes.c_float(0.1).value, ctypes.c_float(0.2).value, ctypes.c_float(0.3).value, 1.0) or fk.log("clear_color")[-1][1][0] - 0.1 < 1e-6, fk.log("clear_color"))
check("glClear 位元遮罩", fk.log("clear")[-1][1] == (0x4100,), fk.log("clear"))
# 緩衝區、著色器、uniform
vbo = glGenBuffers(1); check("glGenBuffers 回整數 id", int(vbo) >= 1, vbo)
glBindBuffer(GL_ARRAY_BUFFER, vbo); data = (ctypes.c_float * 6)(0, 0, 1, 0, 0, 1)
glBufferData(GL_ARRAY_BUFFER, ctypes.sizeof(data), data, GL_STATIC_DRAW)
bd = fk.log("buffer_data")[-1][1]; check("glBufferData 讀出指標的內容", bd[0] == 0x8892 and struct.unpack("<6f", bd[1]) == (0, 0, 1, 0, 0, 1), bd)
sh = glCreateShader(GL_VERTEX_SHADER); glShaderSource(sh, "#version 300 es\nvoid main(){gl_Position=vec4(0);}"); glCompileShader(sh)
check("glShaderSource 取回原始碼", "gl_Position" in fk.log("shader_source")[-1][1][1], fk.log("shader_source"))
check("glGetShaderiv 編譯狀態", glGetShaderiv(sh, GL_COMPILE_STATUS) == 1)
prog = glCreateProgram(); glAttachShader(prog, sh); glLinkProgram(prog); glUseProgram(prog)
glBindAttribLocation(prog, 2, "aCol"); loc = glGetUniformLocation(prog, "uMVP"); glGetAttribLocation(prog, "aPos"); glUniformMatrix4fv(loc, 1, GL_FALSE, [1.0] * 16); glUniform3f(glGetUniformLocation(prog, "c"), 1, 2, 3)
check("名字沒有結尾的 NUL（PyOpenGL 傳的是 NUL 結尾的緩衝區）", "uMVP" in [x[1][1] for x in fk.log("get_uniform_location")] and "aPos" in [x[1][1] for x in fk.log("get_attrib_location")] and fk.log("bind_attrib_location")[-1][1][2] == "aCol", (fk.log("get_uniform_location"), fk.log("get_attrib_location"), fk.log("bind_attrib_location")))
um = fk.log("uniform_matrix")[-1][1]; check("glUniformMatrix4fv", um[0] == 4 and len(um[3]) == 16, um)
check("glUniform3f", fk.log("uniform")[-1][1][:2] == ("f", 3) and fk.log("uniform")[-1][1][3] == [1.0, 2.0, 3.0], fk.log("uniform")[-1])
glEnableVertexAttribArray(0); glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, ctypes.c_void_p(0)); glDrawArrays(GL_TRIANGLES, 0, 3)
check("glVertexAttribPointer／glDrawArrays（現代，已用程式）", fk.log("vertex_attrib_pointer")[-1][1] == (0, 2, 0x1406, False, 0, 0) and fk.log("draw_arrays")[-1][1] == (4, 0, 3), (fk.log("vertex_attrib_pointer"), fk.log("draw_arrays")))
glUseProgram(0)
# 固定管線：矩陣、即時模式
fk.calls.clear()
glMatrixMode(GL_PROJECTION); glLoadIdentity(); gluPerspective(45.0, 64 / 48.0, 0.1, 50.0); glMatrixMode(GL_MODELVIEW); glLoadIdentity(); glTranslatef(0, 0, -5); glRotatef(30, 0, 1, 0)
glEnable(GL_DEPTH_TEST); glEnable(GL_LIGHTING); glEnable(GL_LIGHT0); glLightfv(GL_LIGHT0, GL_POSITION, (0.5, 0.8, 1.0, 0.0)); glMaterialfv(GL_FRONT, GL_DIFFUSE, (1, 0, 0, 1))
check("glEnable(DEPTH_TEST) 轉給 WebGL，LIGHTING 不轉", fk.log("enable") == [("enable", (0x0B71,))], fk.log("enable"))
glBegin(GL_TRIANGLES); glColor3f(1, 0, 0); glVertex3f(-1, -1, 0); glColor3f(0, 1, 0); glVertex3f(1, -1, 0); glColor3f(0, 0, 1); glVertex3f(0, 1, 0); glEnd()
d = fk.log("draw_arrays")[-1][1]; bd = fk.log("buffer_data")[-1][1]
check("glBegin／glEnd 畫 3 個頂點（每個 12 個 float）", d == (4, 0, 3) and len(bd[1]) == 3 * 48, (d, len(bd[1])))
v = struct.unpack("<36f", bd[1]); check("頂點內容：位置、法線、顏色", v[0:3] == (-1, -1, 0) and v[6:10] == (1, 0, 0, 1) and v[12 + 6:12 + 10] == (0, 1, 0, 1), v[:22])
um = {c[1][2]: c[1] for c in fk.log("uniform_matrix")}
mvp = [x for x in fk.log("uniform_matrix") if x[1][0] == 4][0][1][3]
check("MVP 不是單位矩陣（透視×平移×旋轉）", abs(mvp[10]) > 0 and mvp[11] != 0, mvp)
# QUADS 拆三角形；多邊形模式 GL_LINE 改畫線
fk.calls.clear(); glBegin(GL_QUADS); [glVertex3f(*p) for p in ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0))]; glEnd()
check("GL_QUADS → 6 個頂點的三角形", fk.log("draw_arrays")[-1][1] == (4, 0, 6), fk.log("draw_arrays"))
glPolygonMode(GL_FRONT_AND_BACK, GL_LINE); fk.calls.clear(); glBegin(GL_QUADS); [glVertex3f(*p) for p in ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0))]; glEnd()
check("多邊形模式 GL_LINE：改畫線（12 個頂點）", fk.log("draw_arrays")[-1][1] == (1, 0, 12), fk.log("draw_arrays"))
glPolygonMode(GL_FRONT_AND_BACK, GL_FILL)
# client 陣列 + display list
pos = (ctypes.c_float * 9)(0, 0, 0, 1, 0, 0, 0, 1, 0); fk.calls.clear()
glEnableClientState(GL_VERTEX_ARRAY); glVertexPointer(3, GL_FLOAT, 0, pos); glDrawArrays(GL_TRIANGLES, 0, 3); glDisableClientState(GL_VERTEX_ARRAY)
bd = fk.log("buffer_data")[-1][1]; check("glVertexPointer＋glDrawArrays（client 陣列）", fk.log("draw_arrays")[-1][1] == (4, 0, 3) and struct.unpack_from("<3f", bd[1], 48) == (1, 0, 0), fk.log("draw_arrays"))
lst = glGenLists(1); fk.calls.clear(); glNewList(lst, GL_COMPILE); glBegin(GL_TRIANGLES); [glVertex3f(*p) for p in ((0, 0, 0), (1, 0, 0), (0, 1, 0))]; glEnd(); glEndList()
check("display list：錄製時不畫", not fk.log("draw_arrays"))
glCallList(lst); glCallList(lst); check("glCallList 重播兩次", len(fk.log("draw_arrays")) == 2, fk.log("draw_arrays"))
try:
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0); check("未實作要丟錯", False)
except Exception as e:
    check("未實作要丟錯", "undefined function" in str(e) or type(e).__name__ == "NullFunctionError", type(e).__name__ + str(e)[:80])
check("frame_image", P.frame_image() == (b"\x89PNG\r\n\x1a\nfake", "image/png"))
# ---- 緩衝區讀回與 interop 鉤子（pyopencl 的 GLBuffer 用）：用一個把緩衝區存在記憶體的假後端
class MemStore(Fake):
    def __init__(self): Fake.__init__(self); self.bufs = {}; self.cur = {}; self.reads = 0; self.writes = 0
    def create_buffer(self): self.n += 1; h = "m%d" % self.n; self.bufs[h] = bytearray(); return h
    def bind_buffer(self, t, h): self.cur[t] = h
    def buffer_data(self, t, data, usage): self.bufs[self.cur[t]] = bytearray(data if not isinstance(data, int) else data)
    def buffer_sub_data(self, t, off, data): self.bufs[self.cur[t]][off:off + len(data)] = data
    def read_buffer(self, h, off, size): self.reads += 1; return bytes(self.bufs[h][off:off + size])
    def write_buffer(self, h, off, data): self.writes += 1; self.bufs[h][off:off + len(data)] = data
ms = MemStore(); P._CTX["backend"] = ms
vb = int(glGenBuffers(1)); glBindBuffer(GL_ARRAY_BUFFER, vb)
check("interop_buffer_info：剛建立大小 0、修訂號 0", P.interop_buffer_info(vb) == (0, 0), P.interop_buffer_info(vb))
arr = (ctypes.c_float * 4)(1, 2, 3, 4); glBufferData(GL_ARRAY_BUFFER, 16, arr, GL_STATIC_DRAW)
check("glBufferData 記下大小並加修訂號", P.interop_buffer_info(vb) == (16, 1), P.interop_buffer_info(vb))
check("glGetBufferParameteriv(GL_BUFFER_SIZE)", int(glGetBufferParameteriv(GL_ARRAY_BUFFER, GL_BUFFER_SIZE)) == 16)
check("glGetBufferSubData 讀回", struct.unpack("<4f", bytes(glGetBufferSubData(GL_ARRAY_BUFFER, 0, 16).tobytes())) == (1, 2, 3, 4))
check("glGetBufferSubData 取部分範圍", struct.unpack("<2f", bytes(glGetBufferSubData(GL_ARRAY_BUFFER, 8, 8).tobytes())) == (3, 4))
sub = (ctypes.c_float * 1)(9); glBufferSubData(GL_ARRAY_BUFFER, 4, 4, sub)
check("glBufferSubData 加修訂號、內容變了", P.interop_buffer_info(vb)[1] == 2 and struct.unpack("<4f", P.interop_read(vb)) == (1, 9, 3, 4))
rv = P.interop_write(vb, struct.pack("<4f", 5, 6, 7, 8))
check("interop_write 寫入並回傳新修訂號（不動使用者的綁定）", rv == 3 and ms.cur.get(0x8F37) is None and struct.unpack("<4f", P.interop_read(vb)) == (5, 6, 7, 8) and ms.cur.get(GL_ARRAY_BUFFER) is not None)
check("interop_read 不動 ARRAY_BUFFER 綁定", ms.cur.get(GL_ARRAY_BUFFER) == ms.cur.get(GL_ARRAY_BUFFER) and ms.reads >= 1)
glDeleteBuffers(1, [vb]); check("glDeleteBuffers 清掉紀錄", P.interop_buffer_info(vb) is None)
print("FAILED:\n  " + "\n  ".join(bad) if bad else "fa_opengl: OK"); sys.exit(1 if bad else 0)
