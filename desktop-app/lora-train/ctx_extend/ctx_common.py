"""上下文擴展共用函式（DESIGN.offline-training-studio.md §16）。

- ORIG_MAX：基底 Qwen3-0.6B 的 max_position_embeddings（40960，來自基底 config.json）。
- yarn_config：把 config.json 改成 YaRN 的 rope 設定（transformers 5.x 格式：rope_parameters）。
- rope_tables：與 HF 模型同一公式算出 cos／sin 表，給 ONNX 圖的 cos_cache／sin_cache 用。
- corpus：repo 內 DESIGN*.md 串成的長文，依檔名雜湊切成訓練／留出兩部分（留出不進訓練）。
"""
import hashlib
import json
import os
import glob

import numpy as np

BASE_DIR = os.path.expanduser("~/fa-work/models/Qwen3-0.6B")
ORIG_MAX = 40960
ROPE_THETA = 1000000.0
HEAD_DIM = 128
REPO_DOCS_GLOB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "DESIGN*.md")


def yarn_rope_parameters(factor):
    """factor=1 代表不擴展（回傳 default）。"""
    if factor == 1:
        return {"rope_type": "default", "rope_theta": ROPE_THETA}
    return {"rope_type": "yarn", "factor": float(factor),
            "original_max_position_embeddings": ORIG_MAX, "rope_theta": ROPE_THETA}


def write_config(base_dir, out_dir, factor):
    """複製基底 config.json，改 rope 與最大位置數（位置數 = 原長度 × 倍數）。"""
    with open(os.path.join(base_dir, "config.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.pop("rope_scaling", None)
    cfg.pop("rope_parameters", None)
    cfg["rope_parameters"] = yarn_rope_parameters(factor)
    cfg["rope_theta"] = ROPE_THETA
    cfg["max_position_embeddings"] = int(ORIG_MAX * factor)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return cfg


def rope_tables(factor, length):
    """與 HF Qwen3 相同：inv_freq 與 attention_scaling（YaRN 的 mscale）。回傳 (cos, sin) float32 [length, 64]。"""
    import torch
    from transformers import AutoConfig
    from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS
    cfg = AutoConfig.from_pretrained(BASE_DIR)
    cfg.rope_parameters = yarn_rope_parameters(factor)
    cfg.max_position_embeddings = int(ORIG_MAX * factor)
    if factor == 1:
        inv = 1.0 / (ROPE_THETA ** (torch.arange(0, HEAD_DIM, 2, dtype=torch.int64).float() / HEAD_DIM))
        att = 1.0
    else:
        inv, att = ROPE_INIT_FUNCTIONS["yarn"](cfg, "cpu")
        att = float(att)
    inv = inv.double().numpy()
    pos = np.arange(length, dtype=np.float64)
    ang = pos[:, None] * inv[None, :]
    cos = (np.cos(ang) * att).astype(np.float32)
    sin = (np.sin(ang) * att).astype(np.float32)
    return cos, sin, {"attention_scaling": att, "inv_freq_first": float(inv[0]), "inv_freq_last": float(inv[-1])}


def corpus_docs():
    """回傳 (訓練文件列表, 留出文件列表)。切分依檔名的 sha256，約 1/10 為留出。"""
    paths = sorted(glob.glob(REPO_DOCS_GLOB))
    train, held = [], []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            text = f.read()
        h = int(hashlib.sha256(os.path.basename(p).encode("utf-8")).hexdigest(), 16)
        (held if h % 10 == 0 else train).append((os.path.basename(p), text))
    return train, held


def join_docs(docs):
    return "\n\n".join(t for _, t in docs)


def encode(tok, text):
    return tok(text, add_special_tokens=False)["input_ids"]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
