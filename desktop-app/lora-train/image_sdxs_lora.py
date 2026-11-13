#!/usr/bin/env python3
"""圖像生成（SDXS-512）LoRA 訓練核心（CPU，PyTorch）。設計與實測見 DESIGN.lora-training.md §34。

訓練目標與 renderer/src/imagegen/local_sd.js 的一步取樣一致：
  x = σ·n（純雜訊，n 由 seed 決定）；eps = unet(x/√(σ²+1), t=999, 文字向量)；x0 = x − σ·eps；
  損失 = MSE(x0, z)，z = 小型 VAE 編碼器對配對圖片的潛在值。只訓練 LoRA（attention 的 q/k/v/out）。

子命令：
  make-data  產生固定的合成圖文配對（確定、可重現；不需要網路）
  train      訓練 LoRA，輸出 .safetensors（中繼資料含格式版本、rank、alpha、基底版本）
  generate   一步生圖；給 --lora 就先套用 LoRA
  verify     同一提示、同一種子：訓練前後各生一張，量化差異，並核對「從檔案載入」與「同一程序內套用」逐位元組相同

LoRA 檔格式（fa-sdxs-lora-v1）：鍵為「基底 U-Net 模組路徑」加 .lora_A／.lora_B（A 形狀 (rank, in)，B 形狀 (out, rank)）；
  套用：W += (alpha/rank)·strength·(B·A)。JS 端的讀取與合併規則見 renderer/src/studio/image_lora_core.js。
"""
import argparse, json, math, os, sys, time, warnings

warnings.filterwarnings("ignore")
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, ImageDraw
from safetensors import safe_open
from safetensors.torch import load_file, save_file

FORMAT = "fa-sdxs-lora-v1"
BASE_REPO = "IDKiro/sdxs-512-dreamshaper"
BASE_REV = "76f720262bb051da75666b22c902a78c8e16c763"
SIGMA = 14.614646911621094   # 與 local_sd.js 的 SIGMA_MAX 相同
T_FIXED = 999                # 一步取樣固定的時間步
SIZE, LATENT = 512, 64
TARGETS = ("attn1.to_q", "attn1.to_k", "attn1.to_v", "attn1.to_out.0",
           "attn2.to_q", "attn2.to_k", "attn2.to_v", "attn2.to_out.0")

# 固定的合成配對：形狀、前景色、背景色、文字。確定的清單，不靠亂數。
PAIRS = [
    ("a red circle on a white background", "circle", (220, 30, 30), (250, 250, 250)),
    ("a blue square on a black background", "square", (30, 60, 220), (15, 15, 15)),
    ("a green triangle on a yellow background", "triangle", (30, 170, 60), (245, 220, 50)),
    ("an orange stripe pattern on a gray background", "stripes", (240, 130, 20), (120, 120, 120)),
    ("a purple circle on a white background", "circle", (130, 40, 170), (248, 248, 248)),
    ("a yellow square on a blue background", "square", (250, 220, 40), (30, 80, 200)),
    ("a black triangle on a white background", "triangle", (20, 20, 20), (250, 250, 250)),
    ("a white circle on a red background", "circle", (250, 250, 250), (200, 25, 25)),
]


def log(msg):
    print(msg, flush=True)


# ---------- 資料 ----------
def make_dataset(out_dir):
    img_dir = os.path.join(out_dir, "imgs")
    os.makedirs(img_dir, exist_ok=True)
    rows = []
    for i, (cap, shape, fg, bg) in enumerate(PAIRS):
        im = Image.new("RGB", (SIZE, SIZE), bg)
        d = ImageDraw.Draw(im)
        if shape == "circle":
            d.ellipse((120, 120, 392, 392), fill=fg)
        elif shape == "square":
            d.rectangle((140, 140, 372, 372), fill=fg)
        elif shape == "triangle":
            d.polygon([(256, 110), (120, 400), (392, 400)], fill=fg)
        elif shape == "stripes":
            for k in range(0, SIZE, 64):
                d.rectangle((0, k, SIZE, k + 32), fill=fg)
        rel = "imgs/%03d.png" % i
        im.save(os.path.join(out_dir, rel))
        rows.append({"image": rel, "caption": cap})
    with open(os.path.join(out_dir, "pairs.jsonl"), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    log("已寫入 %d 組圖文配對 → %s" % (len(rows), out_dir))
    return rows


def read_pairs(data_dir):
    with open(os.path.join(data_dir, "pairs.jsonl"), encoding="utf-8") as f:
        rows = [json.loads(l) for l in f if l.strip()]
    for r in rows:
        if not r.get("caption", "").strip():
            raise ValueError("配對缺文字：" + r.get("image", "?"))
    return rows


# ---------- 模型 ----------
def load_parts(model_dir):
    from transformers import CLIPTextModel, CLIPTokenizer
    from diffusers import AutoencoderTiny, UNet2DConditionModel
    tok = CLIPTokenizer.from_pretrained(os.path.join(model_dir, "tokenizer"))
    te = CLIPTextModel.from_pretrained(os.path.join(model_dir, "text_encoder"), torch_dtype=torch.float32).eval()
    unet = UNet2DConditionModel.from_pretrained(os.path.join(model_dir, "unet"), torch_dtype=torch.float32)
    vae = AutoencoderTiny.from_pretrained(os.path.join(model_dir, "vae"), torch_dtype=torch.float32).eval()
    return tok, te, unet, vae


@torch.no_grad()
def encode_prompt(tok, te, prompt):
    ids = tok(prompt, padding="max_length", max_length=77, truncation=True, return_tensors="pt").input_ids
    return te(ids)[0]


@torch.no_grad()
def encode_image(vae, path):
    im = Image.open(path).convert("RGB").resize((SIZE, SIZE))
    x = torch.from_numpy(np.asarray(im).copy()).float().permute(2, 0, 1)[None] / 255.
    return vae.encode(x).latents  # 小型 VAE 的編碼器輸入是 [0,1]（已用往返誤差確認）


def noise_for(seed):
    g = torch.Generator().manual_seed(int(seed))
    return torch.randn(1, 4, LATENT, LATENT, generator=g)


def predict_x0(unet, x, emb):
    k = 1.0 / math.sqrt(SIGMA * SIGMA + 1.0)
    eps = unet(x * k, torch.tensor([T_FIXED]), encoder_hidden_states=emb).sample
    return x - SIGMA * eps


@torch.no_grad()
def to_image(vae, x0):
    img = vae.decode(x0).sample  # 解碼器輸出 [0,1]（已確認）
    arr = (img.clamp(0, 1) * 255.0).round().to(torch.uint8)[0].permute(1, 2, 0).numpy()
    return arr


@torch.no_grad()
def sample(unet, vae, emb, seed):
    x = SIGMA * noise_for(seed)
    return to_image(vae, predict_x0(unet, x, emb))


# ---------- LoRA ----------
class LoRALinear(nn.Module):
    def __init__(self, base, rank, alpha):
        super().__init__()
        self.base = base
        self.scale = float(alpha) / float(rank)
        self.lora_A = nn.Parameter(torch.empty(rank, base.in_features))
        self.lora_B = nn.Parameter(torch.zeros(base.out_features, rank))
        nn.init.kaiming_uniform_(self.lora_A, a=math.sqrt(5))

    def forward(self, x):
        return self.base(x) + (x @ self.lora_A.t() @ self.lora_B.t()) * self.scale


def inject_lora(unet, rank, alpha):
    unet.requires_grad_(False)
    names = [n for n, m in unet.named_modules()
             if isinstance(m, nn.Linear) and any(n.endswith(t) for t in TARGETS)]
    for n in names:
        parent, child = n.rsplit(".", 1)
        setattr(unet.get_submodule(parent), child, LoRALinear(unet.get_submodule(n), rank, alpha))
    return names


def lora_state(unet):
    out = {}
    for n, m in unet.named_modules():
        if isinstance(m, LoRALinear):
            out[n + ".lora_A"] = m.lora_A.detach().contiguous().clone()
            out[n + ".lora_B"] = m.lora_B.detach().contiguous().clone()
    return out


def save_lora(unet, path, meta):
    sd = lora_state(unet)
    if not sd:
        raise ValueError("沒有 LoRA 模組可存")
    save_file(sd, path, metadata={k: str(v) for k, v in meta.items()})
    return sum(t.numel() for t in sd.values())


def read_lora_meta(path):
    with safe_open(path, "pt") as f:
        meta = f.metadata() or {}
    if meta.get("format") != FORMAT:
        raise ValueError("不是 %s 格式的 LoRA：%s" % (FORMAT, meta.get("format")))
    return meta


def apply_lora(unet, path, strength=1.0):
    """把 LoRA 檔合併進 U-Net 的線性層（W += (alpha/rank)·strength·B·A）。回傳套用的層數。"""
    meta = read_lora_meta(path)
    rank, alpha = int(meta["rank"]), float(meta["alpha"])
    scale = alpha / rank * float(strength)
    sd = load_file(path)
    mods = dict(unet.named_modules())
    n_applied = 0
    for key in sd:
        if not key.endswith(".lora_A"):
            continue
        n = key[: -len(".lora_A")]
        A, B = sd[n + ".lora_A"], sd[n + ".lora_B"]
        lin = mods.get(n)
        if not isinstance(lin, nn.Linear):
            raise ValueError("基底沒有這個線性層：" + n)
        if tuple(lin.weight.shape) != (B.shape[0], A.shape[1]):
            raise ValueError("形狀不符：" + n)
        with torch.no_grad():
            lin.weight += scale * (B.float() @ A.float())
        n_applied += 1
    return n_applied


# ---------- 訓練 ----------
@torch.no_grad()
def eval_loss(unet, data, seed):
    total = 0.0
    for i, (emb, z) in enumerate(data):
        x = SIGMA * noise_for(seed + i)
        total += float(F.mse_loss(predict_x0(unet, x, emb), z))
    return total / len(data)


def train(args):
    torch.manual_seed(args.seed)
    tok, te, unet, vae = load_parts(args.model)
    rows = read_pairs(args.data)
    if len(rows) < 2:
        raise ValueError("至少要 2 組圖文配對")
    if args.resolution != SIZE:
        raise ValueError("目前只支援 %d 解析度（SDXS-512 固定）" % SIZE)
    data = []
    for r in rows:
        emb = encode_prompt(tok, te, r["caption"])
        z = encode_image(vae, os.path.join(args.data, r["image"]))
        data.append((emb, z))
    del te, tok
    log("配對與潛在值已準備：%d 組" % len(data))

    # 訓練前的基準損失（固定雜訊，兩次比較才有意義）
    unet.eval()
    loss_before = eval_loss(unet, data, args.seed + 7777)
    log("訓練前損失（固定雜訊）：%.6f" % loss_before)

    targets = inject_lora(unet, args.rank, args.alpha)
    params = [p for n, p in unet.named_parameters() if p.requires_grad]
    n_train = sum(p.numel() for p in params)
    log("LoRA 模組 %d 個，可訓練參數 %d（rank=%d alpha=%g）" % (len(targets), n_train, args.rank, args.alpha))
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.0)
    rng = np.random.RandomState(args.seed)
    order = []
    history = []
    t_start = time.time()
    unet.train()
    for step in range(args.steps):
        if not order:
            order = list(rng.permutation(len(data)))
        i = int(order.pop())
        emb, z = data[i]
        x = SIGMA * noise_for(args.seed * 100003 + step)
        t0 = time.time()
        loss = F.mse_loss(predict_x0(unet, x, emb), z)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        rec = {"step": step, "pair": i, "loss": float(loss), "sec": round(time.time() - t0, 2)}
        history.append(rec)
        log("step %d pair %d loss %.6f (%.1fs)" % (step, i, rec["loss"], rec["sec"]))
    unet.eval()
    loss_after = eval_loss(unet, data, args.seed + 7777)
    log("訓練後損失（同一組固定雜訊）：%.6f" % loss_after)
    train_sec = round(time.time() - t_start, 1)

    meta = {"format": FORMAT, "rank": args.rank, "alpha": args.alpha, "targets": ",".join(TARGETS),
            "base_repo": BASE_REPO, "base_rev": BASE_REV, "resolution": SIZE, "steps": args.steps,
            "seed": args.seed, "lr": args.lr, "pairs": len(data), "loss_before": round(loss_before, 6),
            "loss_after": round(loss_after, 6), "train_seconds": train_sec}
    n_params = save_lora(unet, args.out, meta)
    with open(os.path.splitext(args.out)[0] + ".train.json", "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "params": n_params, "history": history}, f, ensure_ascii=False, indent=1)
    log("已存 LoRA：%s（%d 個參數，%d bytes）" % (args.out, n_params, os.path.getsize(args.out)))
    return meta


def generate(args):
    tok, te, unet, vae = load_parts(args.model)
    if args.lora:
        n = apply_lora(unet, args.lora, args.strength)
        log("已套用 LoRA：%d 層（強度 %g）" % (n, args.strength))
    emb = encode_prompt(tok, te, args.prompt)
    unet.eval()
    arr = sample(unet, vae, emb, args.seed)
    Image.fromarray(arr).save(args.out)
    log("已存圖：%s" % args.out)
    return arr


def verify(args):
    """同一提示、同一種子：訓練前後比較。另核對「從檔案套用」與「同一程序內套用」相同。"""
    tok, te, unet, vae = load_parts(args.model)
    unet.eval()
    res = {"prompt": args.prompt, "seed": args.seed, "lora": args.lora, "strength": args.strength}
    emb = encode_prompt(tok, te, args.prompt)
    t0 = time.time(); before = sample(unet, vae, emb, args.seed); res["sec_before"] = round(time.time() - t0, 2)
    again = sample(unet, vae, emb, args.seed)
    res["repeat_identical_before"] = bool(np.array_equal(before, again))
    t0 = time.time(); n = apply_lora(unet, args.lora, args.strength); res["layers_applied"] = n
    t0 = time.time(); after = sample(unet, vae, emb, args.seed); res["sec_after"] = round(time.time() - t0, 2)
    diff = np.abs(after.astype(np.int16) - before.astype(np.int16))
    res["mean_abs_diff_0_255"] = round(float(diff.mean()), 3)
    res["max_abs_diff_0_255"] = int(diff.max())
    res["changed_pixel_fraction"] = round(float((diff.max(axis=2) > 0).mean()), 4)

    def redness(a):  # 紅色佔比：R 明顯大於 G、B 的像素比例（量化「顏色變化」）
        a = a.astype(np.int16)
        return float(((a[..., 0] - np.maximum(a[..., 1], a[..., 2])) > 60).mean())
    res["red_fraction_before"] = round(redness(before), 4)
    res["red_fraction_after"] = round(redness(after), 4)

    # 另開一個新程序從檔案載入，逐位元組比對
    fresh_out = os.path.splitext(args.out_prefix)[0] + "_fresh.png"
    cmd = [sys.executable, os.path.abspath(__file__), "generate", "--model", args.model, "--lora", args.lora,
           "--strength", str(args.strength), "--prompt", args.prompt, "--seed", str(args.seed), "--out", fresh_out]
    import subprocess
    rc = subprocess.run(cmd, check=False).returncode
    res["fresh_process_rc"] = rc
    if rc == 0:
        fresh = np.asarray(Image.open(fresh_out).convert("RGB"))
        res["fresh_process_identical_to_in_process"] = bool(np.array_equal(fresh, after))

    Image.fromarray(before).save(args.out_prefix + "_before.png")
    Image.fromarray(after).save(args.out_prefix + "_after.png")
    with open(args.out_prefix + "_verify.json", "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    log(json.dumps(res, ensure_ascii=False, indent=1))
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("make-data"); d.add_argument("--out", required=True)

    t = sub.add_parser("train")
    t.add_argument("--model", required=True); t.add_argument("--data", required=True)
    t.add_argument("--out", required=True); t.add_argument("--steps", type=int, default=40)
    t.add_argument("--rank", type=int, default=8); t.add_argument("--alpha", type=float, default=8.0)
    t.add_argument("--lr", type=float, default=5e-4); t.add_argument("--seed", type=int, default=1234)
    t.add_argument("--resolution", type=int, default=SIZE)

    g = sub.add_parser("generate")
    g.add_argument("--model", required=True); g.add_argument("--prompt", required=True)
    g.add_argument("--out", required=True); g.add_argument("--seed", type=int, default=1234)
    g.add_argument("--lora", default=None); g.add_argument("--strength", type=float, default=1.0)

    v = sub.add_parser("verify")
    v.add_argument("--model", required=True); v.add_argument("--lora", required=True)
    v.add_argument("--prompt", required=True); v.add_argument("--seed", type=int, default=1234)
    v.add_argument("--strength", type=float, default=1.0); v.add_argument("--out-prefix", required=True)

    a = p.parse_args(argv)
    if a.cmd == "make-data":
        make_dataset(a.out)
    elif a.cmd == "train":
        train(a)
    elif a.cmd == "generate":
        generate(a)
    elif a.cmd == "verify":
        verify(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
