# -*- coding: utf-8 -*-
"""pycuda.compiler 墊片：第一階段不編譯 CUDA C。"""


class CompileUnsupported(RuntimeError):
    pass


class SourceModule(object):
    def __init__(self, source, *a, **k):
        raise CompileUnsupported(
            "尚不支援 CUDA C 原始碼（SourceModule），第一階段不會編譯 C。"
            "請改用 numba.cuda 的 @cuda.jit 寫法（同樣的 grid、shared、atomic 概念），GPU 相容層會把它轉給瀏覽器執行。"
        )
