# -*- coding: utf-8 -*-
"""cupy.cuda 墊片：Device 與 runtime 的最小介面，裝置資訊來自 GPU 相容層的 info()。"""
import fa_gpu


def is_available():
    try:
        info = fa_gpu.info()
    except Exception:
        return False
    return bool(info.get("hasAdapter")) if isinstance(info, dict) else False


class Device(object):
    def __init__(self, device_id=0):
        self.id = int(device_id)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def use(self):
        return self

    def synchronize(self):
        return None

    @property
    def compute_capability(self):
        return "webgpu"


class _Runtime(object):
    def getDeviceCount(self):
        return 1 if is_available() else 0


runtime = _Runtime()
