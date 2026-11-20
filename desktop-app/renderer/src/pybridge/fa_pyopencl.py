# -*- coding: utf-8 -*-
"""
fa_pyopencl — 標準 pyopencl 的安裝期鉤子（與 fa_opengl_platform.register()、fa_pygame.install() 同一類，由 fa_bridge.install_hooks() 呼叫）。

標準 pyopencl 有一處在網頁上根本不可能運作：`pyopencl.tools.get_gl_sharing_context_properties()` 要向 GLX／WGL／CGL 問「目前的 GL 上下文」，
Pyodide（sys.platform == "emscripten"）上它直接丟 NotImplementedError，Linux 上需要真的 GLX。網頁上 GL 上下文就是 fa_opengl_platform 的 WebGL2 後端，
所以這個函式改用我們自己的方式回應屬性：GL_CONTEXT_KHR＝目前 GL 上下文的代號（fa_opengl_platform.interop_context_handle()）、
EGL_DISPLAY_KHR＝瀏覽器的 EGL 顯示（固定 1）——格式與真的完全一樣（list of (context_properties, 值)），官方互通範例原封不動可用：

    ctx = cl.Context(properties=[(cl.context_properties.PLATFORM, platform)] + get_gl_sharing_context_properties(), devices=[dev])

做法：不修改 pyopencl 的任何檔案；在 pyopencl.tools 載入完成「之後」替換這一個函式（用 import 鉤子，不管誰先 import）。
使用者的決定（2026-11-20）：「web always 不會用真的 glx」，用我們的 python opengl／interop 方式回應屬性。
"""
import importlib.abc
import sys

_TARGET = "pyopencl.tools"


def gl_sharing_context_properties():
    """真的 get_gl_sharing_context_properties() 的替代：回傳 [(context_properties, 值), …]。沒有 GL 上下文時代號是 0（與 glXGetCurrentContext() 回 NULL 一樣；
    之後 cl.Context 會因為 GL 上下文無效而丟 INVALID_GL_SHAREGROUP_REFERENCE_KHR）。"""
    import pyopencl as cl
    cp = cl.context_properties
    try:
        import fa_opengl_platform as P
        ctx, disp = P.interop_context_handle(), P.interop_display_handle()
    except ImportError:
        ctx, disp = 0, 0
    return [(cp.GL_CONTEXT_KHR, ctx), (cp.EGL_DISPLAY_KHR, disp)]


def _patch(mod):
    mod.get_gl_sharing_context_properties = gl_sharing_context_properties


class _WrappedLoader(importlib.abc.Loader):
    def __init__(self, inner):
        self._inner = inner

    def create_module(self, spec):
        return self._inner.create_module(spec) if hasattr(self._inner, "create_module") else None

    def exec_module(self, module):
        self._inner.exec_module(module)
        _patch(module)   # pyopencl.tools 載入完成之後才替換，所以不管誰先 import 都對


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != _TARGET:
            return None
        for f in sys.meta_path:
            if f is self or not hasattr(f, "find_spec"):
                continue
            spec = f.find_spec(name, path, target)
            if spec is not None and spec.loader is not None:
                spec.loader = _WrappedLoader(spec.loader)
                return spec
        return None


def install():
    """裝上鉤子（可重複呼叫）。pyopencl.tools 已經載入就直接替換。"""
    if not any(isinstance(f, _Finder) for f in sys.meta_path):
        sys.meta_path.insert(0, _Finder())
    mod = sys.modules.get(_TARGET)
    if mod is not None:
        _patch(mod)
    return True
