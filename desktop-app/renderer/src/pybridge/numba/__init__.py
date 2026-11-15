# -*- coding: utf-8 -*-
"""
numba 墊片（GPU 相容層）：只提供 numba.cuda 的子集，見 cuda.py。
真的 numba 存在時 fa_gpu 會優先用真的，這個墊片不會遮蔽它。
"""
from . import cuda  # noqa: F401

__version__ = "0.0.0+fa-gpu-shim"
