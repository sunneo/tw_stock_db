"""RoPE 查證（真值＝PyTorch）：把 Electron 裡 GPU RoPE 核心的輸出，與兩種慣例逐元素比對。

慣例 A（交錯成對）：第 2i 與 2i+1 維成一對。這是 nn_ops.rope 與 trainStepDevice 使用的核心慣例。
慣例 B（rotate-half）：第 i 與 i+hd/2 維成一對，cos/sin 表為 cat([fr, fr])。
  這是 llm_scratch.py 的 rot_half（行 180–182）與 cos_t/sin_t（行 279–284）的慣例，也是 HF Qwen3 的 rotate_half。

用法：python rope_check_torch.py <結果 JSON>（結果 JSON 由評估檔的 [eval-file] result 行取得）
"""
import json
import math
import sys

import torch

sys.stdout.reconfigure(encoding="utf-8")


def rope_interleaved(x, T, H, hd, direction):
    # 交錯成對：θ = t·10000^(−2i/hd)，(x[2i], x[2i+1]) 旋轉
    xr = x.reshape(T, H, hd // 2, 2)
    t = torch.arange(T, dtype=x.dtype).reshape(T, 1, 1)
    i = torch.arange(hd // 2, dtype=x.dtype).reshape(1, 1, hd // 2)
    th = t * torch.pow(torch.tensor(10000.0, dtype=x.dtype), -2 * i / hd)
    c, s = torch.cos(th), direction * torch.sin(th)
    a, b = xr[..., 0], xr[..., 1]
    return torch.stack([a * c - b * s, a * s + b * c], dim=-1).reshape(T, H * hd)


def rope_rotate_half(x, T, H, hd, direction):
    # llm_scratch.py 的慣例：rot_half(x) = cat([-x[h:], x[:h]])；cos/sin 表 = cat([fr, fr])，fr = outer(t, inv)
    xh = x.reshape(T, H, hd)
    half = hd // 2
    inv = 1.0 / (10000.0 ** (torch.arange(0, hd, 2, dtype=x.dtype) / hd))  # 與 llm_scratch 的 inv 相同
    t = torch.arange(T, dtype=x.dtype)
    fr = torch.outer(t, inv)                       # T × half
    emb = torch.cat([fr, fr], dim=-1)              # T × hd
    cos = emb.cos().reshape(T, 1, hd)
    sin = (direction * emb.sin()).reshape(T, 1, hd)
    rot = torch.cat([-xh[..., half:], xh[..., :half]], dim=-1)
    return (xh * cos + rot * sin).reshape(T, H * hd)


def main():
    res = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    out = {"cases": []}
    print("RoPE 查證：GPU 核心 vs PyTorch 兩種慣例（數字是最大絕對誤差）")
    print("%-14s %-14s %-14s %-14s %-14s" % ("shape T,H,hd", "GPU+1 vs 交錯", "GPU+1 vs 半轉", "GPU-1 vs 交錯", "GPU-1 vs 半轉"))
    for c in res["cases"]:
        T, H, hd = c["T"], c["H"], c["hd"]
        x = torch.tensor(c["x"], dtype=torch.float64).reshape(T, H * hd)
        gp = torch.tensor(c["gpuPlus"], dtype=torch.float64).reshape(T, H * hd)
        gm = torch.tensor(c["gpuMinus"], dtype=torch.float64).reshape(T, H * hd)
        ia_p = rope_interleaved(x, T, H, hd, 1.0); ia_m = rope_interleaved(x, T, H, hd, -1.0)
        rh_p = rope_rotate_half(x, T, H, hd, 1.0); rh_m = rope_rotate_half(x, T, H, hd, -1.0)
        d = {
            "gpu_plus_vs_interleaved": float((gp - ia_p).abs().max()),
            "gpu_plus_vs_rotate_half": float((gp - rh_p).abs().max()),
            "gpu_minus_vs_interleaved": float((gm - ia_m).abs().max()),
            "gpu_minus_vs_rotate_half": float((gm - rh_m).abs().max()),
        }
        out["cases"].append({"T": T, "H": H, "hd": hd, **d})
        print("%-14s %-14.3e %-14.3e %-14.3e %-14.3e" % ("%d,%d,%d" % (T, H, hd), d["gpu_plus_vs_interleaved"], d["gpu_plus_vs_rotate_half"], d["gpu_minus_vs_interleaved"], d["gpu_minus_vs_rotate_half"]))
    ok_rotate = all(c["gpu_plus_vs_rotate_half"] < 1e-5 and c["gpu_minus_vs_rotate_half"] < 1e-5 for c in out["cases"])
    differs_interleaved = all(c["gpu_plus_vs_interleaved"] > 1e-2 for c in out["cases"])
    out["verdict"] = {"GPU核心等於 rotate-half（門檻1e-5，正向與反向）": ok_rotate, "GPU核心與交錯慣例不同（>1e-2，確認已改掉）": differs_interleaved}
    print("結論：", out["verdict"])
    json.dump(out, open(sys.argv[1] + ".verdict.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

