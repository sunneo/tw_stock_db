# -*- coding: utf-8 -*-
"""色彩空間：sRGB ↔ CIE Lab（D65）。

為什麼用 Lab：本模組所有「顏色像不像」的判斷（四叉樹要不要再切、相鄰區塊要不要合併）都用歐氏距離，
而 Lab 的歐氏距離（ΔE76）跟人眼感受的色差大致成正比，RGB 的歐氏距離不是（暗部同樣的 RGB 差，看起來差很多）。
"""
import numpy as np

_M = np.array([[0.4124564, 0.3575761, 0.1804375],
               [0.2126729, 0.7151522, 0.0721750],
               [0.0193339, 0.1191920, 0.9503041]])
_WHITE = np.array([0.95047, 1.0, 1.08883])


def srgb_to_lab(rgb):
    """rgb：浮點數 0..1，形狀 (..., 3)。回傳 Lab，形狀相同（L 約 0..100，a、b 約 -128..127）。"""
    rgb = np.asarray(rgb, dtype=np.float64)
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    xyz = (lin @ _M.T) / _WHITE
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)
    return np.stack([116.0 * f[..., 1] - 16.0, 500.0 * (f[..., 0] - f[..., 1]), 200.0 * (f[..., 1] - f[..., 2])], axis=-1)


def delta_e(a, b):
    """ΔE76：Lab 空間的歐氏距離。"""
    return np.sqrt(((np.asarray(a) - np.asarray(b)) ** 2).sum(axis=-1))
