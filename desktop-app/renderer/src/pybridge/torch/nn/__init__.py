# -*- coding: utf-8 -*-
"""torch.nn 墊片：Module、Parameter、Linear、ReLU、Sigmoid、Tanh、Softmax、LayerNorm、Sequential、MSELoss、CrossEntropyLoss。"""
import numpy as np

import importlib as _importlib

from .. import Tensor, _unsupported

functional = _importlib.import_module(__name__ + ".functional")  # 見 torch/__init__.py：不用 from . import（會先 getattr）

__all__ = ["Module", "Parameter", "Linear", "ReLU", "Sigmoid", "Tanh", "Softmax", "LayerNorm",
           "Sequential", "MSELoss", "CrossEntropyLoss", "functional"]


class Parameter(Tensor):
    def __init__(self, data, requires_grad=True):
        Tensor.__init__(self, data, requires_grad=requires_grad)
        self._is_param = True


class Module(object):
    def __init__(self):
        object.__setattr__(self, "_parameters", {})
        object.__setattr__(self, "_modules", {})
        object.__setattr__(self, "training", True)

    def __setattr__(self, name, value):
        if isinstance(value, Parameter):
            self._parameters[name] = value
        elif isinstance(value, Module):
            self._modules[name] = value
        object.__setattr__(self, name, value)

    def parameters(self):
        for p in self._parameters.values():
            yield p
        for m in self._modules.values():
            for p in m.parameters():
                yield p

    def named_parameters(self, prefix=""):
        for k, p in self._parameters.items():
            yield prefix + k, p
        for mk, m in self._modules.items():
            for n, p in m.named_parameters(prefix + mk + "."):
                yield n, p

    def children(self):
        return iter(self._modules.values())

    def zero_grad(self, set_to_none=True):
        for p in self.parameters():
            p.grad = None

    def to(self, device=None, *a, **k):
        for p in self.parameters():
            p.device = str(device) if device is not None else p.device
        return self

    def cuda(self, device=None):
        return self.to("cuda")

    def cpu(self):
        return self.to("cpu")

    def train(self, mode=True):
        object.__setattr__(self, "training", mode)
        for m in self._modules.values():
            m.train(mode)
        return self

    def eval(self):
        return self.train(False)

    def __call__(self, *a, **k):
        return self.forward(*a, **k)

    def forward(self, *a, **k):
        raise NotImplementedError("子類別要實作 forward")


class Linear(Module):
    def __init__(self, in_features, out_features, bias=True, device=None, dtype=None):
        Module.__init__(self)
        k = 1.0 / np.sqrt(in_features)
        self.weight = Parameter(np.random.uniform(-k, k, (out_features, in_features)))
        self.bias = Parameter(np.random.uniform(-k, k, (out_features,))) if bias else None
        if device is not None:
            self.to(device)

    def forward(self, x):
        y = x @ self.weight.t()
        if self.bias is not None:
            y = y + self.bias
        return y


class ReLU(Module):
    def forward(self, x):
        return x.relu()


class Sigmoid(Module):
    def forward(self, x):
        return x.sigmoid()


class Tanh(Module):
    def forward(self, x):
        return x.tanh()


class Softmax(Module):
    def __init__(self, dim=-1):
        Module.__init__(self)
        self.dim = dim

    def forward(self, x):
        return x.softmax(self.dim)


class LayerNorm(Module):
    def __init__(self, normalized_shape, eps=1e-5, elementwise_affine=True, device=None, dtype=None):
        Module.__init__(self)
        shape = (normalized_shape,) if isinstance(normalized_shape, int) else tuple(normalized_shape)
        if len(shape) != 1:
            raise _unsupported("LayerNorm（多維 normalized_shape）", "只對最後一維做正規化（normalized_shape 用整數）")
        self.eps = eps
        self.weight = Parameter(np.ones(shape)) if elementwise_affine else None
        self.bias = Parameter(np.zeros(shape)) if elementwise_affine else None

    def forward(self, x):
        return functional.layer_norm(x, None, self.weight, self.bias, self.eps)


class Sequential(Module):
    def __init__(self, *mods):
        Module.__init__(self)
        for i, m in enumerate(mods):
            setattr(self, str(i), m)
        self._order = list(mods)

    def forward(self, x):
        for m in self._order:
            x = m(x)
        return x

    def __len__(self):
        return len(self._order)

    def __getitem__(self, i):
        return self._order[i]


class MSELoss(Module):
    def __init__(self, reduction="mean"):
        Module.__init__(self)
        self.reduction = reduction

    def forward(self, input, target):
        return functional.mse_loss(input, target, self.reduction)


class CrossEntropyLoss(Module):
    def __init__(self, reduction="mean"):
        Module.__init__(self)
        self.reduction = reduction

    def forward(self, input, target):
        return functional.cross_entropy(input, target, self.reduction)


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    raise _unsupported("nn." + name, "第一階段只支援 Module、Parameter、Linear、ReLU、Sigmoid、Tanh、Softmax、LayerNorm、Sequential、MSELoss、CrossEntropyLoss")
