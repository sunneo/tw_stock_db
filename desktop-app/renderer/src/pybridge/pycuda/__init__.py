# -*- coding: utf-8 -*-
"""pycuda 墊片（GPU 相容層，第一階段最小子集）：pycuda.autoinit、pycuda.driver（mem_alloc、memcpy_htod／dtoh）。
SourceModule（CUDA C 原始碼）第一階段不支援，會明確回報並建議改用 numba.cuda 的 @cuda.jit。"""
from . import driver  # noqa: F401
from . import compiler  # noqa: F401

__version__ = "0.0.0+fa-gpu-shim"
