# -*- coding: utf-8 -*-
"""pycuda.driver 墊片：裝置記憶體以主機 numpy 緩衝模擬（位元組陣列），搬移用 memcpy_htod／memcpy_dtoh。"""
import numpy as np

import fa_gpu


class Error(RuntimeError):
    pass


def init():
    return None


def get_version():
    return (0, 0, 0)


class Device(object):
    def __init__(self, n=0):
        self.id = int(n)

    def name(self):
        try:
            info = fa_gpu.info()
        except Exception:
            info = {}
        return "WebGPU（瀏覽器介面卡，非真 CUDA）" if info.get("hasAdapter") else "無可用介面卡"

    @staticmethod
    def count():
        try:
            info = fa_gpu.info()
        except Exception:
            return 0
        return 1 if info.get("hasAdapter") else 0


class DeviceAllocation(object):
    def __init__(self, nbytes):
        self.nbytes = int(nbytes)
        self._buf = np.zeros(self.nbytes, dtype=np.uint8)

    def __int__(self):
        return id(self._buf)

    def free(self):
        self._buf = None

    def __del__(self):
        pass


def mem_alloc(nbytes):
    if int(nbytes) < 0:
        raise Error("mem_alloc：位元組數不能是負數")
    return DeviceAllocation(nbytes)


def _as_bytes(a):
    return np.ascontiguousarray(a).reshape(-1).view(np.uint8)


def memcpy_htod(dest, src):
    s = _as_bytes(src)
    if not isinstance(dest, DeviceAllocation):
        raise Error("memcpy_htod：第一個參數要是 mem_alloc 的結果")
    if s.size > dest.nbytes:
        raise Error("memcpy_htod：來源 %d 位元組超過配置的 %d 位元組" % (s.size, dest.nbytes))
    dest._buf[:s.size] = s


def memcpy_dtoh(dst, src):
    if not isinstance(src, DeviceAllocation):
        raise Error("memcpy_dtoh：來源要是 mem_alloc 的結果")
    d = dst.reshape(-1).view(np.uint8) if isinstance(dst, np.ndarray) else np.frombuffer(dst, dtype=np.uint8)
    if d.size > src.nbytes:
        raise Error("memcpy_dtoh：目標 %d 位元組超過配置的 %d 位元組" % (d.size, src.nbytes))
    d[:] = src._buf[:d.size]
