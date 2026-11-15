# -*- coding: utf-8 -*-
"""
torch 墊片（GPU 相容層，第一階段）：只給「真的 torch 不存在」時使用（見 fa_gpu 的尋找器）。

- 資料容器是 numpy float32；Tensor 有小型自動微分（反向傳播用各運算的閉包），足以訓練小型 MLP。
- .to('cuda')／.cuda() 會標記裝置；cuda 裝置上的二維 matmul 前向走 GPU 橋接（cudaweb），失敗就退回 numpy。
- 反向傳播一律在 numpy 做（第一階段），所以只有前向的 matmul 會經過 GPU。
- 不支援的名稱呼叫時丟 TorchCompatError，訊息格式：「未支援：torch.<名稱>，建議 <替代>」。

子模組：torch.nn（Module、Linear、ReLU、Sigmoid、Tanh、Softmax、LayerNorm、Sequential、MSELoss、CrossEntropyLoss）、
torch.nn.functional、torch.optim（SGD、AdamW）、torch.cuda。
"""
import math

import numpy as np

import fa_gpu

__version__ = "0.0.0+fa-gpu-shim"
float32 = np.float32  # 注意：不在這個模組裡遮蓋內建的 float／bool（下面的程式會用到內建的）
int64 = np.int64
_GRAD = [True]


class TorchCompatError(RuntimeError):
    pass


def _unsupported(name, hint):
    return TorchCompatError("未支援：torch.%s，建議 %s" % (name, hint))


# ---------------------------------------------------------------- Tensor 與自動微分
class Tensor(object):
    __array_priority__ = 1000

    def __init__(self, data, requires_grad=False, device="cpu"):
        self.data = np.array(data, dtype=np.float32, copy=True)
        self.requires_grad = bool(requires_grad)
        self.grad = None
        self.device = device
        self._prev = ()
        self._bw = None
        self._op = "leaf"

    # 基本資訊
    @property
    def shape(self):
        return tuple(self.data.shape)

    def size(self, dim=None):
        return self.shape if dim is None else self.shape[dim]

    def dim(self):
        return self.data.ndim

    def numel(self):
        return int(self.data.size)

    def item(self):
        return float(self.data.reshape(-1)[0])

    def numpy(self):
        return np.array(self.data, copy=True)

    def tolist(self):
        return self.data.tolist()

    def detach(self):
        return Tensor(self.data, device=self.device)

    def __len__(self):
        return len(self.data)

    def __repr__(self):
        g = ", grad_fn=<%s>" % self._op if self._op != "leaf" and self._prev else ""
        return "tensor(%s%s, device='%s'%s)" % (self.data.tolist(), "", self.device, g + (", requires_grad=True" if self.requires_grad and not g else ""))

    def __getitem__(self, idx):
        return Tensor(self.data[idx], device=self.device)

    # 裝置
    def to(self, device=None, *a, **k):
        dev = str(device) if device is not None else self.device
        out = Tensor(self.data, requires_grad=self.requires_grad, device=dev)
        out.grad = self.grad
        return out

    def cuda(self, device=None):
        return self.to("cuda")

    def cpu(self):
        return self.to("cpu")

    # 反向傳播
    def backward(self, gradient=None):
        if gradient is None:
            if self.data.size != 1:
                raise TorchCompatError("backward() 只能用在純量上（或指定 gradient）")
            gradient = np.ones_like(self.data)
        g0 = np.asarray(gradient, dtype=np.float32).reshape(self.data.shape)
        order, seen = [], set()

        def build(v):
            if id(v) in seen:
                return
            seen.add(id(v))
            for p in v._prev:
                build(p)
            order.append(v)

        build(self)
        self.grad = g0 if self.grad is None else self.grad + g0
        for node in reversed(order):
            if node._bw is None or node.grad is None:
                continue
            pgrads = node._bw(node.grad)
            for p, pg in zip(node._prev, pgrads):
                if pg is None or not p.requires_grad:
                    continue
                pg = np.asarray(pg, dtype=np.float32).reshape(p.data.shape)
                p.grad = pg if p.grad is None else p.grad + pg

    # 運算
    def __add__(self, o):
        o = _t(o)
        a, b = self.data, o.data
        return _mk(a + b, [self, o], "add", lambda g: [_unb(g, a.shape), _unb(g, b.shape)])

    __radd__ = __add__

    def __neg__(self):
        return self * -1.0

    def __sub__(self, o):
        return self + (-_t(o))

    def __rsub__(self, o):
        return _t(o) + (-self)

    def __mul__(self, o):
        o = _t(o)
        a, b = self.data, o.data
        return _mk(a * b, [self, o], "mul", lambda g: [_unb(g * b, a.shape), _unb(g * a, b.shape)])

    __rmul__ = __mul__

    def __truediv__(self, o):
        return self * (_t(o) ** -1.0)

    def __pow__(self, p):
        a = self.data
        out = a ** float(p)
        return _mk(out, [self], "pow", lambda g: [g * float(p) * a ** (float(p) - 1.0)])

    def __matmul__(self, o):
        o = _t(o)
        a, b = self.data, o.data
        if a.ndim != 2 or b.ndim != 2:
            raise _unsupported("matmul（非二維）", "把輸入 reshape 成二維後再相乘")
        out = _matmul_data(a, b, self.device)
        return _mk(out, [self, o], "matmul", lambda g: [g @ b.T, a.T @ g])

    def matmul(self, o):
        return self @ o

    def t(self):
        a = self.data
        return _mk(a.T, [self], "t", lambda g: [g.T])

    @property
    def T(self):
        return self.t()

    def reshape(self, *shape):
        a = self.data
        return _mk(a.reshape(*shape), [self], "reshape", lambda g: [g.reshape(a.shape)])

    def view(self, *shape):
        return self.reshape(*shape)

    def sum(self, dim=None, keepdim=False):
        a = self.data
        out = a.sum(axis=dim, keepdims=keepdim)
        return _mk(out, [self], "sum", lambda g: [_expand(g, a.shape, dim, keepdim)])

    def mean(self, dim=None, keepdim=False):
        a = self.data
        n = a.size if dim is None else a.shape[dim]
        out = a.mean(axis=dim, keepdims=keepdim)
        return _mk(out, [self], "mean", lambda g: [_expand(g, a.shape, dim, keepdim) / float(n)])

    def exp(self):
        out = np.exp(self.data)
        return _mk(out, [self], "exp", lambda g: [g * out])

    def log(self):
        a = self.data
        return _mk(np.log(a), [self], "log", lambda g: [g / a])

    def sqrt(self):
        return self ** 0.5

    def rsqrt(self):
        return self ** -0.5

    def relu(self):
        a = self.data
        return _mk(np.maximum(a, 0), [self], "relu", lambda g: [g * (a > 0)])

    def sigmoid(self):
        s = 1.0 / (1.0 + np.exp(-self.data))
        return _mk(s, [self], "sigmoid", lambda g: [g * s * (1.0 - s)])

    def tanh(self):
        th = np.tanh(self.data)
        return _mk(th, [self], "tanh", lambda g: [g * (1.0 - th * th)])

    def softmax(self, dim=-1):
        a = self.data
        e = np.exp(a - a.max(axis=dim, keepdims=True))
        y = e / e.sum(axis=dim, keepdims=True)

        def bw(g):
            return [y * (g - (g * y).sum(axis=dim, keepdims=True))]

        return _mk(y, [self], "softmax", bw)

    def __gt__(self, o):
        return Tensor(self.data > _t(o).data)

    def __lt__(self, o):
        return Tensor(self.data < _t(o).data)


def _t(x):
    return x if isinstance(x, Tensor) else Tensor(x)


def _matmul_data(a, b, device):
    """前向矩陣乘：cuda 裝置上的二維相乘先走 GPU 橋接，失敗就退回 numpy。"""
    if device == "cuda" and a.ndim == 2 and b.ndim == 2 and a.shape[1] == b.shape[0] and np.all(np.isfinite(a)) and np.all(np.isfinite(b)):
        try:
            r = fa_gpu.call("matmul", {"a": a.reshape(-1).tolist(), "b": b.reshape(-1).tolist(),
                                       "m": int(a.shape[0]), "k": int(a.shape[1]), "n": int(b.shape[1])})
            return np.asarray(r, dtype=np.float32).reshape(a.shape[0], b.shape[1])
        except fa_gpu.GpuCompatError as e:
            fa_gpu.note_cpu("GPU 橋接不可用，matmul 改用 numpy：%s" % e)
    return a @ b


def _unb(g, shape):
    """廣播的反向：把梯度加總回原本的形狀。"""
    g = np.asarray(g)
    while g.ndim > len(shape):
        g = g.sum(axis=0)
    for i, s in enumerate(shape):
        if s == 1 and g.shape[i] != 1:
            g = g.sum(axis=i, keepdims=True)
    return g.reshape(shape)


def _expand(g, shape, dim, keepdim):
    g = np.asarray(g)
    if dim is None:
        return np.broadcast_to(g.reshape([1] * len(shape)) if g.ndim == 0 else g, shape).astype(np.float32)
    if not keepdim:
        g = np.expand_dims(g, dim)
    return np.broadcast_to(g, shape).astype(np.float32)


def _mk(data, parents, op, bw):
    rg = _GRAD[0] and any(p.requires_grad for p in parents)
    dev = parents[0].device if parents else "cpu"
    out = Tensor(data, requires_grad=rg, device=dev)
    if rg:
        out._prev = tuple(parents)
        out._bw = bw
        out._op = op
    return out


class no_grad(object):
    def __enter__(self):
        self._p = _GRAD[0]
        _GRAD[0] = False
        return self

    def __exit__(self, *a):
        _GRAD[0] = self._p
        return False

    def __call__(self, fn):
        def wrapper(*a, **k):
            with no_grad():
                return fn(*a, **k)
        return wrapper


def _is_param(x):
    return isinstance(x, Tensor) and getattr(x, "_is_param", False)


def tensor(data, dtype=None, device=None, requires_grad=False):
    t = Tensor(data, requires_grad=requires_grad, device=str(device) if device else "cpu")
    return t


def as_tensor(data, dtype=None, device=None):
    return tensor(data, device=device)


def from_numpy(a):
    return Tensor(a)


def zeros(*shape, requires_grad=False, device=None, dtype=None):
    return Tensor(np.zeros(_shape(shape)), requires_grad=requires_grad, device=str(device) if device else "cpu")


def ones(*shape, requires_grad=False, device=None, dtype=None):
    return Tensor(np.ones(_shape(shape)), requires_grad=requires_grad, device=str(device) if device else "cpu")


def randn(*shape, requires_grad=False, device=None, dtype=None, generator=None):
    return Tensor(np.random.randn(*_shape(shape)), requires_grad=requires_grad, device=str(device) if device else "cpu")


def rand(*shape, requires_grad=False, device=None, dtype=None):
    return Tensor(np.random.rand(*_shape(shape)), requires_grad=requires_grad, device=str(device) if device else "cpu")


def arange(*a, dtype=None, device=None, requires_grad=False):
    return Tensor(np.arange(*a), requires_grad=requires_grad, device=str(device) if device else "cpu")


def manual_seed(seed):
    np.random.seed(int(seed) % (2 ** 32))
    return None


def _shape(shape):
    if len(shape) == 1 and isinstance(shape[0], (list, tuple)):
        return tuple(shape[0])
    return tuple(int(s) for s in shape)


def matmul(a, b):
    return _t(a) @ _t(b)


def mm(a, b):
    return _t(a) @ _t(b)


def bmm(a, b):
    raise _unsupported("bmm", "對每個 batch 用 torch.matmul 迴圈，或改用 @ 搭配 reshape")


def softmax(x, dim=-1):
    return _t(x).softmax(dim)


def relu(x):
    return _t(x).relu()


def sigmoid(x):
    return _t(x).sigmoid()


def tanh(x):
    return _t(x).tanh()


def exp(x):
    return _t(x).exp()


def log(x):
    return _t(x).log()


def sqrt(x):
    return _t(x).sqrt()


def cat(tensors, dim=0):
    raise _unsupported("cat", "用 numpy 組好再 torch.tensor(...)，或把資料一次建立")


class device(object):
    def __init__(self, kind="cpu", index=None):
        self.type = str(kind).split(":")[0]
        self.index = index

    def __str__(self):
        return self.type

    def __repr__(self):
        return "device(type='%s')" % self.type


def __getattr__(name):
    # 其他 torch 名稱第一階段未支援；dunder 照常丟 AttributeError（給 import 機制用）
    if name.startswith("__"):
        raise AttributeError(name)
    raise _unsupported(name, "只用本墊片支援的子集（Tensor、nn、optim、cuda），或改用 numpy 與 numba.cuda")


# 子模組用 importlib 載入：from . import x 會先 getattr，而模組的 __getattr__ 會對未支援的名稱丟 TorchCompatError
import importlib as _importlib  # noqa: E402

cuda = _importlib.import_module(__name__ + ".cuda")
nn = _importlib.import_module(__name__ + ".nn")
optim = _importlib.import_module(__name__ + ".optim")
