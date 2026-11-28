"""全參數訓練的 PyTorch 參考（P1 真值）。

用 autograd 求梯度（不手寫反向），前向與 full_param_train.js 逐式相同，並對齊 llm_scratch.py 的密集 Block：
RMSNorm（eps 1e-6）→ q/k/v 投影 →（可選）每頭 qk-norm → 交錯成對 RoPE → 因果注意力（分組查詢）
→ o 投影 → 殘差 → RMSNorm → SiLU 閘控 MLP → 殘差；最後 RMSNorm＋綁定詞嵌入輸出頭。
交叉熵（平均）、全域梯度範數裁剪（max 1.0）、AdamW（betas 0.9/0.999、eps 1e-8、wd 0.01）。

variant：
  dense      ：kvH＝H，無 qk-norm（P1 原版）
  gqa_qkn    ：kvH＝2（H＝4，每 2 個 query 頭共用一組 kv），有 qk-norm（P1 補項）

用法：
  python full_param_ref_torch.py --out <fixture.json> --dtype float64 --variant dense [--steps 20]
輸出 fixture：初始權重、每步的 token 批次、每步的損失與梯度範數、步 1 的全部梯度、最後的權重。
"""
import argparse
import json
import math

import torch
import torch.nn.functional as F

BASE = dict(V=48, d=32, L=2, H=4, F=64, T=12)
VARIANTS = {
    "dense": dict(kvH=4, qkNorm=False),
    "gqa_qkn": dict(kvH=2, qkNorm=True),
}
SEED = 1234
LR = 1e-3
WD = 0.01
CLIP = 1.0
STEPS = 20


def init_weights(cfg, dtype, seed=SEED):
    g = torch.Generator().manual_seed(seed)
    V, d, L, H, Fd, kvH = cfg["V"], cfg["d"], cfg["L"], cfg["H"], cfg["F"], cfg["kvH"]
    hd = d // H
    kd = kvH * hd

    def rnd(shape, sd):
        return (torch.randn(shape, generator=g, dtype=torch.float64) * sd).to(dtype)

    w = {"emb": rnd((V, d), 0.15), "nf": torch.ones(d, dtype=dtype), "layers": []}
    for _ in range(L):
        layer = {
            "n1": torch.ones(d, dtype=dtype), "n2": torch.ones(d, dtype=dtype),
            "Wq": rnd((d, d), 1 / math.sqrt(d)), "Wk": rnd((d, kd), 1 / math.sqrt(d)),
            "Wv": rnd((d, kd), 1 / math.sqrt(d)), "Wo": rnd((d, d), 1 / math.sqrt(d)),
            "Wg": rnd((d, Fd), 1 / math.sqrt(d)), "Wu": rnd((d, Fd), 1 / math.sqrt(d)),
            "Wd": rnd((Fd, d), 1 / math.sqrt(Fd)),
        }
        if cfg["qkNorm"]:
            layer["qn"] = torch.ones(hd, dtype=dtype)
            layer["kn"] = torch.ones(hd, dtype=dtype)
        w["layers"].append(layer)
    return w


def rope(x, T, H, hd, direction):
    # rotate-half（與 llm_scratch.py 的 rot_half 相同）：第 i 與第 i+hd/2 維成對，θ = t·10000^(−2i/hd)
    d = H * hd
    half = hd // 2
    xr = x.reshape(T, H, hd)
    t = torch.arange(T, dtype=x.dtype).reshape(T, 1, 1)
    i = torch.arange(half, dtype=x.dtype).reshape(1, 1, half)
    th = t * torch.pow(torch.tensor(10000.0, dtype=x.dtype), -2 * i / hd)
    c, s = torch.cos(th), direction * torch.sin(th)
    a, b = xr[..., :half], xr[..., half:]
    y0 = a * c - b * s
    y1 = b * c + a * s
    return torch.cat([y0, y1], dim=-1).reshape(T, d)


def rms(x, g):
    inv = 1.0 / torch.sqrt((x * x).mean(-1, keepdim=True) + 1e-6)
    return x * inv * g


def forward_loss(p, tokens, cfg):
    V, d, H, kvH, Fd = cfg["V"], cfg["d"], cfg["H"], cfg["kvH"], cfg["F"]
    hd = d // H
    rep = H // kvH
    T = tokens.shape[0] - 1
    inp, tgt = tokens[:T], tokens[1:]
    h = p["emb"][inp]
    causal = torch.ones(T, T, dtype=torch.bool).tril()
    for L in p["layers"]:
        n1 = rms(h, L["n1"])
        q = (n1 @ L["Wq"]).reshape(T, H, hd)
        k = (n1 @ L["Wk"]).reshape(T, kvH, hd)
        v = (n1 @ L["Wv"]).reshape(T, kvH, hd)
        if cfg["qkNorm"]:
            q = rms(q, L["qn"])
            k = rms(k, L["kn"])
        q = rope(q.reshape(T, H * hd), T, H, hd, 1.0).reshape(T, H, hd).permute(1, 0, 2)
        k = rope(k.reshape(T, kvH * hd), T, kvH, hd, 1.0).reshape(T, kvH, hd).permute(1, 0, 2)
        vh = v.permute(1, 0, 2)
        # 分組查詢：query 頭 hh 用 kv 頭 hh // rep（與 llm_scratch 的 expand+reshape 相同）
        kx = k.repeat_interleave(rep, dim=0)
        vx = vh.repeat_interleave(rep, dim=0)
        sc = (q @ kx.transpose(-1, -2)) / math.sqrt(hd)
        sc = sc.masked_fill(~causal, float("-inf"))
        P = torch.softmax(sc, dim=-1)
        ao = (P @ vx).permute(1, 0, 2).reshape(T, d)
        h1 = h + ao @ L["Wo"]
        n2 = rms(h1, L["n2"])
        g = n2 @ L["Wg"]
        u = n2 @ L["Wu"]
        h = h1 + (F.silu(g) * u) @ L["Wd"]
    nf = rms(h, p["nf"])
    logits = nf @ p["emb"].t()
    return F.cross_entropy(logits, tgt)


def make_batches(steps):
    g = torch.Generator().manual_seed(SEED + 1)
    return [torch.randint(0, BASE["V"], (BASE["T"] + 1,), generator=g).reshape(-1).tolist() for _ in range(steps)]


def flat_params(w):
    out = {"emb": w["emb"], "nf": w["nf"]}
    for li, L in enumerate(w["layers"]):
        for k, v in L.items():
            out["L%d.%s" % (li, k)] = v
    return out


def flat(t):
    # JS 端一律讀行優先的一維陣列，這裡統一攤平
    return t.detach().reshape(-1).tolist()


def run(dtype, steps, variant):
    cfg = dict(BASE); cfg.update(VARIANTS[variant])
    w = init_weights(cfg, dtype)
    init_json = {"emb": flat(w["emb"]), "nf": flat(w["nf"]), "layers": []}
    for L in w["layers"]:
        init_json["layers"].append({k: flat(v) for k, v in L.items()})

    def mkleaf(t):
        return t.clone().detach().requires_grad_(True)
    model = {"emb": mkleaf(w["emb"]), "nf": mkleaf(w["nf"]), "layers": []}
    for L in w["layers"]:
        model["layers"].append({k: mkleaf(v) for k, v in L.items()})
    params = [model["emb"], model["nf"]] + [t for L in model["layers"] for t in L.values()]
    opt = torch.optim.AdamW(params, lr=LR, betas=(0.9, 0.999), eps=1e-8, weight_decay=WD)

    batches = make_batches(steps)
    rec = []
    first = None
    for step in range(steps):
        tokens = torch.tensor(batches[step], dtype=torch.long)
        opt.zero_grad()
        loss = forward_loss(model, tokens, cfg)
        loss.backward()
        if step == 0:
            first = {name: flat(t.grad) for name, t in flat_params(model).items()}
        gn = torch.nn.utils.clip_grad_norm_(params, CLIP)
        opt.step()
        rec.append({"loss": float(loss.detach()), "gradNorm": float(gn)})

    final = {name: flat(t) for name, t in flat_params(model).items()}
    return {
        "cfg": cfg, "variant": variant, "seed": SEED, "lr": LR, "wd": WD, "clip": CLIP, "steps": steps,
        "dtype": str(dtype).replace("torch.", ""), "init": init_json, "batches": batches,
        "perStep": rec, "step1Grads": first, "final": final,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--dtype", default="float64", choices=["float64", "float32"])
    ap.add_argument("--variant", default="dense", choices=sorted(VARIANTS))
    ap.add_argument("--steps", type=int, default=STEPS)
    a = ap.parse_args()
    dtype = torch.float64 if a.dtype == "float64" else torch.float32
    out = run(dtype, a.steps, a.variant)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print("wrote", a.out, "variant", a.variant, "dtype", a.dtype, "steps", a.steps,
          "loss0", out["perStep"][0]["loss"], "lossN", out["perStep"][-1]["loss"])


if __name__ == "__main__":
    main()
