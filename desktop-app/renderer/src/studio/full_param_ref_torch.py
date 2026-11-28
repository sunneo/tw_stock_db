"""全參數訓練的 PyTorch 參考（P1 真值）。

用 autograd 求梯度（不手寫反向），與 full_param_train.js 的前向公式逐式相同：
RMSNorm（eps 1e-6）、RoPE（交錯成對）、因果注意力、SiLU 閘控 MLP、綁定詞嵌入輸出頭、
交叉熵（平均）、全域梯度範數裁剪（max 1.0）、AdamW（betas 0.9/0.999、eps 1e-8、wd 0.01）。

用法：
  python full_param_ref_torch.py --out <fixture.json> --dtype float64 [--steps 20]
輸出 fixture：初始權重、每步的 token 批次、每步的損失與梯度範數、步 1 的全部梯度、最後的權重。
JS 測試（full_param_train.test.js）讀 fixture 做比對。
"""
import argparse
import json
import math

import torch
import torch.nn.functional as F

CFG = dict(V=48, d=32, L=2, H=4, F=64, T=12)
SEED = 1234
LR = 1e-3
WD = 0.01
CLIP = 1.0
STEPS = 20


def init_weights(dtype, seed=SEED):
    g = torch.Generator().manual_seed(seed)
    V, d, L, H, Fd = CFG["V"], CFG["d"], CFG["L"], CFG["H"], CFG["F"]

    def rnd(shape, sd):
        return (torch.randn(shape, generator=g, dtype=torch.float64) * sd).to(dtype)

    w = {"emb": rnd((V, d), 0.15), "nf": torch.ones(d, dtype=dtype), "layers": []}
    for _ in range(L):
        w["layers"].append({
            "n1": torch.ones(d, dtype=dtype), "n2": torch.ones(d, dtype=dtype),
            "Wq": rnd((d, d), 1 / math.sqrt(d)), "Wk": rnd((d, d), 1 / math.sqrt(d)),
            "Wv": rnd((d, d), 1 / math.sqrt(d)), "Wo": rnd((d, d), 1 / math.sqrt(d)),
            "Wg": rnd((d, Fd), 1 / math.sqrt(d)), "Wu": rnd((d, Fd), 1 / math.sqrt(d)),
            "Wd": rnd((Fd, d), 1 / math.sqrt(Fd)),
        })
    return w


def rope(x, T, H, hd, direction):
    # x: [T, d]；與 JS rope() 相同：每個頭內，(2i, 2i+1) 成對旋轉 θ = t·10000^(−2i/hd)
    d = H * hd
    xr = x.reshape(T, H, hd // 2, 2)
    t = torch.arange(T, dtype=x.dtype).reshape(T, 1, 1)
    i = torch.arange(hd // 2, dtype=x.dtype).reshape(1, 1, hd // 2)
    th = t * torch.pow(torch.tensor(10000.0, dtype=x.dtype), -2 * i / hd)
    c, s = torch.cos(th), direction * torch.sin(th)
    a, b = xr[..., 0], xr[..., 1]
    y0 = a * c - b * s
    y1 = a * s + b * c
    return torch.stack([y0, y1], dim=-1).reshape(T, d)


def rms(x, g):
    inv = 1.0 / torch.sqrt((x * x).mean(-1, keepdim=True) + 1e-6)
    return x * inv * g


def forward_loss(p, tokens):
    V, d, H, Fd = CFG["V"], CFG["d"], CFG["H"], CFG["F"]
    hd = d // H
    T = tokens.shape[0] - 1
    inp, tgt = tokens[:T], tokens[1:]
    h = p["emb"][inp]
    causal = torch.ones(T, T, dtype=torch.bool).tril()
    for L in p["layers"]:
        n1 = rms(h, L["n1"])
        q = rope(n1 @ L["Wq"], T, H, hd, 1.0)
        k = rope(n1 @ L["Wk"], T, H, hd, 1.0)
        v = n1 @ L["Wv"]
        qh = q.reshape(T, H, hd).permute(1, 0, 2)  # [H, T, hd]
        kh = k.reshape(T, H, hd).permute(1, 0, 2)
        vh = v.reshape(T, H, hd).permute(1, 0, 2)
        sc = (qh @ kh.transpose(-1, -2)) / math.sqrt(hd)
        sc = sc.masked_fill(~causal, float("-inf"))
        P = torch.softmax(sc, dim=-1)
        ao = (P @ vh).permute(1, 0, 2).reshape(T, d)
        h1 = h + ao @ L["Wo"]
        n2 = rms(h1, L["n2"])
        g = n2 @ L["Wg"]
        u = n2 @ L["Wu"]
        h = h1 + (F.silu(g) * u) @ L["Wd"]
    nf = rms(h, p["nf"])
    logits = nf @ p["emb"].t()
    return F.cross_entropy(logits, tgt)


def make_batches(steps, dtype=None):
    g = torch.Generator().manual_seed(SEED + 1)
    batches = []
    for _ in range(steps):
        batches.append(torch.randint(0, CFG["V"], (CFG["T"] + 1,), generator=g).reshape(-1).tolist())
    return batches


def flat_params(w):
    out = {"emb": w["emb"], "nf": w["nf"]}
    for li, L in enumerate(w["layers"]):
        for k, v in L.items():
            out["L%d.%s" % (li, k)] = v
    return out


def flat(t):
    # JS 端一律讀行優先的一維陣列，這裡統一攤平
    return t.detach().reshape(-1).tolist()


def run(dtype, steps):
    w = init_weights(dtype)
    init_json = {"emb": flat(w["emb"]), "nf": flat(w["nf"]), "layers": []}
    for L in w["layers"]:
        init_json["layers"].append({k: flat(v) for k, v in L.items()})

    # 依參數建立可求梯度的葉節點
    leaves = {}
    def mkleaf(t):
        return t.clone().detach().requires_grad_(True)
    leaves["emb"] = mkleaf(w["emb"]); leaves["nf"] = mkleaf(w["nf"])
    layers = []
    for L in w["layers"]:
        layers.append({k: mkleaf(v) for k, v in L.items()})
    model = {"emb": leaves["emb"], "nf": leaves["nf"], "layers": layers}
    params = [leaves["emb"], leaves["nf"]] + [t for L in layers for t in L.values()]
    opt = torch.optim.AdamW(params, lr=LR, betas=(0.9, 0.999), eps=1e-8, weight_decay=WD)

    batches = make_batches(steps)
    rec = []
    for step in range(steps):
        tokens = torch.tensor(batches[step], dtype=torch.long)
        opt.zero_grad()
        loss = forward_loss(model, tokens)
        loss.backward()
        step1_grads = None
        if step == 0:
            step1_grads = {}
            for name, t in flat_params(model).items():
                step1_grads[name] = flat(t.grad)
        gn = torch.nn.utils.clip_grad_norm_(params, CLIP)
        opt.step()
        rec.append({"loss": float(loss.detach()), "gradNorm": float(gn)})
        if step == 0:
            first = step1_grads

    final = {name: flat(t) for name, t in flat_params(model).items()}
    return {
        "cfg": CFG, "seed": SEED, "lr": LR, "wd": WD, "clip": CLIP, "steps": steps,
        "dtype": str(dtype).replace("torch.", ""), "init": init_json, "batches": batches,
        "perStep": rec, "step1Grads": first, "final": final,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--dtype", default="float64", choices=["float64", "float32"])
    ap.add_argument("--steps", type=int, default=STEPS)
    a = ap.parse_args()
    dtype = torch.float64 if a.dtype == "float64" else torch.float32
    out = run(dtype, a.steps)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print("wrote", a.out, "steps", a.steps, "dtype", a.dtype, "loss0", out["perStep"][0]["loss"], "lossN", out["perStep"][-1]["loss"])


if __name__ == "__main__":
    main()
