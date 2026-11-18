# -*- coding: utf-8 -*-
"""torch.cuda 墊片：裝置查詢來自 GPU 相容層的 info()。"""
import fa_gpu


def is_available():
    try:
        info = fa_gpu.info()
    except Exception:
        return False
    return bool(info.get("hasAdapter")) if isinstance(info, dict) else False


def device_count():
    return 1 if is_available() else 0


def current_device():
    return 0


def get_device_name(device=None):
    return "WebGPU（瀏覽器介面卡，非真 CUDA）"


def synchronize(device=None):
    fa_gpu.synchronize_all()


def empty_cache():
    return None
