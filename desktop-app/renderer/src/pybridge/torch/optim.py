# -*- coding: utf-8 -*-
"""torch.optim 墊片：SGD（可選 momentum、weight_decay）與 AdamW。"""
import numpy as np

from . import _unsupported


class Optimizer(object):
    def __init__(self, params, defaults):
        self.defaults = dict(defaults)
        self.param_groups = [dict(defaults, params=list(params))]
        self.state = {}

    def zero_grad(self, set_to_none=True):
        for g in self.param_groups:
            for p in g["params"]:
                p.grad = None

    def _params(self):
        for g in self.param_groups:
            for p in g["params"]:
                yield g, p


class SGD(Optimizer):
    def __init__(self, params, lr=1e-3, momentum=0.0, weight_decay=0.0, **kw):
        if kw:
            raise _unsupported("SGD(%s)" % ", ".join(kw), "只用 lr、momentum、weight_decay")
        Optimizer.__init__(self, params, {"lr": lr, "momentum": momentum, "weight_decay": weight_decay})

    def step(self, closure=None):
        for g, p in self._params():
            if p.grad is None:
                continue
            grad = p.grad + g["weight_decay"] * p.data
            if g["momentum"]:
                st = self.state.setdefault(id(p), {})
                buf = st.get("momentum_buffer")
                buf = grad.copy() if buf is None else g["momentum"] * buf + grad
                st["momentum_buffer"] = buf
                grad = buf
            p.data -= (g["lr"] * grad).astype(p.data.dtype)


class AdamW(Optimizer):
    def __init__(self, params, lr=1e-3, betas=(0.9, 0.999), eps=1e-8, weight_decay=0.01, **kw):
        if kw:
            raise _unsupported("AdamW(%s)" % ", ".join(kw), "只用 lr、betas、eps、weight_decay")
        Optimizer.__init__(self, params, {"lr": lr, "betas": tuple(betas), "eps": eps, "weight_decay": weight_decay})

    def step(self, closure=None):
        for g, p in self._params():
            if p.grad is None:
                continue
            b1, b2 = g["betas"]
            st = self.state.setdefault(id(p), {"t": 0, "m": np.zeros_like(p.data), "v": np.zeros_like(p.data)})
            st["t"] += 1
            t = st["t"]
            grad = p.grad
            st["m"] = b1 * st["m"] + (1 - b1) * grad
            st["v"] = b2 * st["v"] + (1 - b2) * grad * grad
            mhat = st["m"] / (1 - b1 ** t)
            vhat = st["v"] / (1 - b2 ** t)
            p.data -= (g["lr"] * (mhat / (np.sqrt(vhat) + g["eps"]) + g["weight_decay"] * p.data)).astype(p.data.dtype)
