# -*- coding: utf-8 -*-
"""torch.nn.functional 墊片：softmax、relu、sigmoid、tanh、silu、gelu（tanh 近似）、layer_norm、rms_norm、mse_loss、cross_entropy。"""
import math

import numpy as np

from .. import Tensor, _mk, _t, _unsupported

_names = ["softmax", "relu", "sigmoid", "tanh", "silu", "gelu", "layer_norm", "rms_norm", "mse_loss", "cross_entropy"]


def softmax(x, dim=-1, dtype=None):
    return _t(x).softmax(dim)


def relu(x, inplace=False):
    return _t(x).relu()


def sigmoid(x):
    return _t(x).sigmoid()


def tanh(x):
    return _t(x).tanh()


def silu(x, inplace=False):
    x = _t(x)
    return x * x.sigmoid()


def gelu(x, approximate="tanh"):
    if approximate != "tanh":
        raise _unsupported("F.gelu(approximate='none')", "approximate='tanh'（近似版，誤差很小）")
    x = _t(x)
    inner = (x + (x * x * x) * 0.044715) * math.sqrt(2.0 / math.pi)
    return x * 0.5 * (inner.tanh() + 1.0)


def layer_norm(x, normalized_shape, weight=None, bias=None, eps=1e-5):
    x = _t(x)
    mu = x.mean(-1, keepdim=True)
    c = x - mu
    var = (c * c).mean(-1, keepdim=True)
    y = c * (var + eps) ** -0.5
    if weight is not None:
        y = y * weight
    if bias is not None:
        y = y + bias
    return y


def rms_norm(x, normalized_shape, weight=None, eps=1e-6):
    x = _t(x)
    ms = (x * x).mean(-1, keepdim=True)
    y = x * (ms + eps) ** -0.5
    if weight is not None:
        y = y * weight
    return y


def mse_loss(input, target, reduction="mean"):
    d = _t(input) - _t(target)
    sq = d * d
    if reduction == "mean":
        return sq.mean()
    if reduction == "sum":
        return sq.sum()
    raise _unsupported("mse_loss(reduction=%r)" % reduction, "reduction='mean' 或 'sum'")


def cross_entropy(input, target, reduction="mean"):
    if reduction != "mean":
        raise _unsupported("cross_entropy(reduction=%r)" % reduction, "reduction='mean'")
    lg = _t(input)
    a = lg.data
    if a.ndim != 2:
        raise _unsupported("cross_entropy（非 [N, C] 形狀）", "把 logits 整理成 [N, C]")
    y = np.asarray(_t(target).data).astype(np.int64).reshape(-1)
    n = a.shape[0]
    m = a.max(axis=-1, keepdims=True)
    e = np.exp(a - m)
    s = e.sum(axis=-1, keepdims=True)
    p = e / s
    logp = (a - m) - np.log(s)
    loss = -logp[np.arange(n), y].mean()

    def bw(g):
        dl = p.copy()
        dl[np.arange(n), y] -= 1.0
        return [dl * (g / float(n))]

    return _mk(np.array(loss, dtype=np.float32), [lg], "cross_entropy", bw)


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    raise _unsupported("nn.functional." + name, "第一階段只支援：" + "、".join(_names))
