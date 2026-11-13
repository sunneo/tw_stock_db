#!/usr/bin/env python3
"""從零建立小型 LLM（工作室「建立 LLM（從零開始）」）。
子命令（依序執行，每一步都印 JSON 行，最後一行是該步的結果；進度行帶 step 與 loss）：
  prep       語料清理與切分（留出集以區塊為單位，不逐行切）
  tokenizer  訓練位元組級 BPE 分詞器（HF tokenizers），輸出與原生執行環境相容的 tokenizer.json，並量測留出集壓縮率
  pretrain   預訓練（下一詞預測）；印訓練損失與留出損失／困惑度；前後生成樣本
  sft        指令微調（qwen3-chatml 樣板，只對助理回答算損失）；印留出損失與留出題的生成對照
  export-hf  標準 Hugging Face Qwen3 格式（safetensors），用 transformers 載入核對；LoRA 微調與加長上下文由此接手
  export     匯出 ONNX fp32，動態量化為 q8，並與 PyTorch 比對（logits 與貪婪 token）
  check      以 onnxruntime 重新載入 q8 模型兩次，貪婪生成，核對兩次與匯出時的結果逐字一致
架構：Qwen3 同型（RMSNorm、RoPE 旋轉半、q_norm／k_norm、SwiGLU、詞嵌入與輸出頭共享）。
原生執行環境（nr-engine.js）寫死 28 層、8 個 KV 頭、head_dim 128，所以這裡的預設都符合這三個數字，
只改寬度（hidden、intermediate）與詞彙表大小。設計與參考來源見 DESIGN.offline-training-studio.md。
"""
import argparse, hashlib, json, math, os, sys, time, unicodedata, glob

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
# 與 Qwen2／Qwen3 同一套預分詞規則（JS 與 Rust 的 regex 都支援）
PRETOK = r"""'s|'t|'re|'ve|'m|'ll|'d|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+"""
SPECIALS = ["<|endoftext|>", "<|im_start|>", "<|im_end|>", "<think>", "</think>"]
PAD_ID = 0          # <|endoftext|>
IM_END_ID = None    # 由分詞器決定（SFT 與匯出時讀取）
LAYERS, KV_HEADS, HEAD_DIM, HEADS = 28, 8, 128, 8   # 與 nr-engine.js 的 LAYERS／KV／HD 一致
PRESETS = {
    "mini": {"hidden": 96, "intermediate": 256},     # 約 1,400 萬參數（詞彙 8192 時）
    "small": {"hidden": 128, "intermediate": 384},   # 約 2,000 萬參數（詞彙 8192 時）
}
DEFAULT_BUILTIN = os.path.join(HERE, "llm_scratch_builtin_zh.txt")
DEFAULT_SFT = os.path.join(HERE, "llm_scratch_sft_zh.jsonl")


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def fail(msg):
    emit({"ok": False, "error": msg})
    sys.exit(2)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(p, obj):
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------- prep
def is_useful(line):
    body = [c for c in line if not c.isspace()]
    if not body:
        return False
    good = sum(1 for c in body if c.isalnum() or "一" <= c <= "鿿")
    return good / len(body) >= 0.5


def clean_lines(raw):
    s = unicodedata.normalize("NFC", raw).replace("　", " ").replace("\r\n", "\n").replace("\r", "\n")
    s = "".join(c for c in s if c in "\n\t" or unicodedata.category(c)[0] != "C")
    out, seen = [], set()
    for ln in s.split("\n"):
        ln = ln.rstrip()
        if len(ln.strip()) < 8 or not is_useful(ln) or ln in seen:
            continue
        seen.add(ln)
        out.append(ln)
    return out


def cmd_prep(a):
    if a.builtin:
        files = [DEFAULT_BUILTIN]
    else:
        if not a.corpus or not os.path.exists(a.corpus):
            fail("找不到語料：%s" % a.corpus)
        if os.path.isdir(a.corpus):
            files = sorted(glob.glob(os.path.join(a.corpus, "**", "*.txt"), recursive=True) + glob.glob(os.path.join(a.corpus, "**", "*.md"), recursive=True))
        else:
            files = [a.corpus]
    if not files:
        fail("語料資料夾裡沒有 .txt 或 .md 檔")
    raw_chars, lines_in, kept = 0, 0, []
    for f in files:
        with open(f, "r", encoding="utf-8", errors="replace") as fh:
            txt = fh.read()
        raw_chars += len(txt)
        lines_in += txt.count("\n") + 1
        kept += clean_lines(txt)
    if not kept:
        fail("清理後沒有可用的文字（每行至少 8 字，且需以文字為主）")
    # 留出集：以 20 行為一區塊，區塊序號 %20==0 的整塊留出（避免相鄰行洩漏）
    train, held = [], []
    for i in range(0, len(kept), 20):
        blk = kept[i:i + 20]
        (held if (i // 20) % 20 == 0 else train).extend(blk)
    if not held or not train:
        fail("語料太少，無法切出留出集（至少需要 40 行可用文字）")
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "train.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(train) + "\n")
    with open(os.path.join(a.out, "heldout.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(held) + "\n")
    rep = {"files": len(files), "raw_chars": raw_chars, "lines_in": lines_in, "lines_kept": len(kept),
           "clean_chars": sum(len(x) for x in kept), "train_chars": sum(len(x) for x in train),
           "heldout_chars": sum(len(x) for x in held), "builtin": bool(a.builtin)}
    write_json(os.path.join(a.out, "prep_report.json"), rep)
    emit(dict(rep, event="prep", ok=True))


# ---------------------------------------------------------------- tokenizer
def cmd_tokenizer(a):
    from tokenizers import Tokenizer, models, pre_tokenizers, decoders, normalizers, trainers, Regex
    tok = Tokenizer(models.BPE())
    tok.normalizer = normalizers.NFC()
    tok.pre_tokenizer = pre_tokenizers.Sequence([
        pre_tokenizers.Split(Regex(PRETOK), behavior="isolated"),
        pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False)])
    tok.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(vocab_size=a.vocab, min_frequency=2, special_tokens=SPECIALS,
                                  initial_alphabet=pre_tokenizers.ByteLevel.alphabet(), show_progress=False)
    train_txt = os.path.join(a.data, "train.txt")
    held_txt = os.path.join(a.data, "heldout.txt")
    tok.train([train_txt], trainer)
    os.makedirs(a.out, exist_ok=True)
    tpath = os.path.join(a.out, "tokenizer.json")
    tok.save(tpath)
    # 留出集壓縮率：UTF-8 位元組數 ÷ token 數（越大越省）；同時核對 encode→decode 可還原
    with open(held_txt, "r", encoding="utf-8") as f:
        held_lines = [ln for ln in f.read().split("\n") if ln]
    nbytes = nchars = ntok = 0
    rt_ok = 0
    for ln in held_lines:
        ids = tok.encode(ln).ids
        nbytes += len(ln.encode("utf-8")); nchars += len(ln); ntok += len(ids)
        if tok.decode(ids, skip_special_tokens=False) == ln:
            rt_ok += 1
    # 訓練語料也 encode 成 uint16 陣列，供預訓練讀取
    with open(train_txt, "r", encoding="utf-8") as f:
        train_text = f.read()
    tr_ids = np.array(tok.encode(train_text).ids, dtype=np.uint16)
    ho_ids = np.array(tok.encode(open(held_txt, "r", encoding="utf-8").read()).ids, dtype=np.uint16)
    np.save(os.path.join(a.data, "train_ids.npy"), tr_ids)
    np.save(os.path.join(a.data, "heldout_ids.npy"), ho_ids)
    rep = {"vocab_size": tok.get_vocab_size(), "heldout_lines": len(held_lines),
           "heldout_bytes": nbytes, "heldout_chars": nchars, "heldout_tokens": ntok,
           "bytes_per_token": round(nbytes / max(ntok, 1), 4), "chars_per_token": round(nchars / max(ntok, 1), 4),
           "roundtrip_lines_ok": rt_ok, "roundtrip_all_ok": rt_ok == len(held_lines),
           "train_tokens": int(tr_ids.size), "heldout_ids": int(ho_ids.size)}
    write_json(os.path.join(a.out, "tokenizer_report.json"), rep)
    emit(dict(rep, event="tokenizer", ok=True))


# ---------------------------------------------------------------- model
def build_model_classes():
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    class RMSNorm(nn.Module):
        def __init__(s, dim, eps):
            super().__init__(); s.eps = eps; s.weight = nn.Parameter(torch.ones(dim))

        def forward(s, x):
            return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + s.eps) * s.weight

    def rot_half(x):
        h = x.shape[-1] // 2
        return torch.cat([-x[..., h:], x[..., :h]], dim=-1)

    class Block(nn.Module):
        def __init__(s, c):
            super().__init__()
            s.hd, s.h, s.kvh = c["head_dim"], c["heads"], c["kv_heads"]
            H = c["hidden"]
            s.q = nn.Linear(H, s.h * s.hd, bias=False); s.k = nn.Linear(H, s.kvh * s.hd, bias=False)
            s.v = nn.Linear(H, s.kvh * s.hd, bias=False); s.o = nn.Linear(s.h * s.hd, H, bias=False)
            s.qn = RMSNorm(s.hd, c["eps"]); s.kn = RMSNorm(s.hd, c["eps"])
            s.n1 = RMSNorm(H, c["eps"]); s.n2 = RMSNorm(H, c["eps"])
            s.gate = nn.Linear(H, c["intermediate"], bias=False); s.up = nn.Linear(H, c["intermediate"], bias=False)
            s.down = nn.Linear(c["intermediate"], H, bias=False)

        def forward(s, x, cos, sin, addmask, pk, pv):
            B, S, _ = x.shape
            hsrc = s.n1(x)
            q = s.q(hsrc).view(B, S, s.h, s.hd).transpose(1, 2)
            k = s.k(hsrc).view(B, S, s.kvh, s.hd).transpose(1, 2)
            v = s.v(hsrc).view(B, S, s.kvh, s.hd).transpose(1, 2)
            q = s.qn(q); k = s.kn(k)
            q = q * cos + rot_half(q) * sin
            k = k * cos + rot_half(k) * sin
            if pk is not None:
                k = torch.cat([pk, k], dim=2); v = torch.cat([pv, v], dim=2)
            T = k.shape[2]
            P = T - S
            qpos = torch.arange(S) + P
            kpos = torch.arange(T)
            causal = torch.where(kpos.unsqueeze(0) <= qpos.unsqueeze(1), 0.0, -1e9)   # (S, T)
            att = torch.matmul(q, k.transpose(-1, -2)) * (1.0 / math.sqrt(s.hd))
            att = att + causal + addmask
            att = torch.softmax(att, dim=-1)
            y = torch.matmul(att, v).transpose(1, 2).reshape(B, S, s.h * s.hd)
            x = x + s.o(y)
            h2 = s.n2(x)
            x = x + s.down(F.silu(s.gate(h2)) * s.up(h2))
            return x, k, v

    class LM(nn.Module):
        def __init__(s, c):
            super().__init__()
            s.c = c
            s.emb = nn.Embedding(c["vocab"], c["hidden"])
            s.layers = nn.ModuleList([Block(c) for _ in range(c["layers"])])
            s.norm = RMSNorm(c["hidden"], c["eps"])
            inv = 1.0 / (c["rope_theta"] ** (torch.arange(0, c["head_dim"], 2).float() / c["head_dim"]))
            t = torch.arange(c["max_pos"]).float()
            fr = torch.outer(t, inv)
            emb = torch.cat([fr, fr], dim=-1)
            s.register_buffer("cos_t", emb.cos(), persistent=False)
            s.register_buffer("sin_t", emb.sin(), persistent=False)
            for m in s.modules():
                if isinstance(m, (nn.Linear, nn.Embedding)):
                    nn.init.normal_(m.weight, std=0.02)
            # 殘差輸出投影縮小（GPT-2 式），穩定深層訓練
            for blk in s.layers:
                nn.init.normal_(blk.o.weight, std=0.02 / math.sqrt(2 * c["layers"]))
                nn.init.normal_(blk.down.weight, std=0.02 / math.sqrt(2 * c["layers"]))

        def forward(s, ids, am, pos, past=None):
            x = s.emb(ids)
            cos = s.cos_t[pos].unsqueeze(1); sin = s.sin_t[pos].unsqueeze(1)
            addmask = ((1.0 - am.to(x.dtype)) * -1e9)[:, None, None, :]
            pres = []
            for i, blk in enumerate(s.layers):
                pk = past[2 * i] if past is not None else None
                pv = past[2 * i + 1] if past is not None else None
                x, k, v = blk(x, cos, sin, addmask, pk, pv)
                pres.append(k); pres.append(v)
            x = s.norm(x)
            return x @ s.emb.weight.t(), pres

    return LM


def make_config(vocab, preset):
    p = PRESETS[preset]
    return {"model_type": "qwen3", "architectures": ["Qwen3ForCausalLM"], "vocab": int(vocab), "hidden": p["hidden"],
            "intermediate": p["intermediate"], "layers": LAYERS, "heads": HEADS, "kv_heads": KV_HEADS,
            "head_dim": HEAD_DIM, "rope_theta": 1000000.0, "max_pos": 4096, "eps": 1e-6, "preset": preset}


def hf_config(c, tok_vocab):
    return {"architectures": ["Qwen3ForCausalLM"], "model_type": "qwen3", "vocab_size": c["vocab"],
            "hidden_size": c["hidden"], "intermediate_size": c["intermediate"], "num_hidden_layers": c["layers"],
            "num_attention_heads": c["heads"], "num_key_value_heads": c["kv_heads"], "head_dim": c["head_dim"],
            "rms_norm_eps": c["eps"], "rope_theta": c["rope_theta"], "max_position_embeddings": c["max_pos"],
            "tie_word_embeddings": True, "hidden_act": "silu", "bos_token_id": None, "eos_token_id": None,
            "pad_token_id": PAD_ID, "use_cache": True, "torch_dtype": "float32", "tokenizer_vocab_size": tok_vocab}


def load_ckpt(model_dir):
    import torch
    LM = build_model_classes()
    ck = torch.load(os.path.join(model_dir, "ckpt.pt"), map_location="cpu", weights_only=False)
    m = LM(ck["config"]); m.load_state_dict(ck["state"]); m.eval()
    return m, ck["config"]


def count_params(m):
    return int(sum(p.numel() for p in m.parameters()))


def greedy_cached(m, prompt_ids, n_new):
    """與 nr-engine.js 相同的貪婪迴圈：先整段預填，之後每步一個 token，沿用 KV 快取。"""
    import torch
    out = []
    past = None
    cur = torch.tensor([prompt_ids], dtype=torch.long)
    total = len(prompt_ids)
    pos = torch.arange(total).unsqueeze(0)
    with torch.no_grad():
        for _ in range(n_new):
            am = torch.ones(1, total, dtype=torch.long)
            logits, pres = m(cur, am, pos, past)
            nxt = int(torch.argmax(logits[0, -1]).item())
            out.append(nxt)
            past = pres
            cur = torch.tensor([[nxt]], dtype=torch.long)
            pos = torch.tensor([[total]], dtype=torch.long)
            total += 1
    return out


def decode_ids(tok, ids):
    return tok.decode(ids, skip_special_tokens=False)


def sample_prompts(data_dir, k=4):
    with open(os.path.join(data_dir, "heldout.txt"), "r", encoding="utf-8") as f:
        lines = [ln for ln in f.read().split("\n") if len(ln) >= 20]
    step = max(1, len(lines) // k)
    return [ln[:12] for ln in lines[::step][:k]]


# ---------------------------------------------------------------- pretrain
def cmd_pretrain(a):
    import torch
    from tokenizers import Tokenizer
    torch.manual_seed(a.seed)
    np.random.seed(a.seed)
    torch.set_num_threads(max(1, int(a.threads)))
    tok = Tokenizer.from_file(a.tok)
    vocab = tok.get_vocab_size()
    cfg = make_config(vocab, a.preset)
    LM = build_model_classes()
    m = LM(cfg)
    n_params = count_params(m)
    tr = np.load(os.path.join(a.data, "train_ids.npy")).astype(np.int64)
    ho = np.load(os.path.join(a.data, "heldout_ids.npy")).astype(np.int64)
    if tr.size <= a.seq + 1:
        fail("訓練 token 數不足（%d），請用更多語料或縮短序列長度" % tr.size)
    os.makedirs(a.out, exist_ok=True)
    prompts = sample_prompts(a.data)
    emit({"event": "start", "params": n_params, "vocab": vocab, "train_tokens": int(tr.size), "heldout_tokens": int(ho.size),
          "preset": a.preset, "steps": a.steps, "batch": a.batch, "seq": a.seq})

    # 留出損失：固定的一組視窗（不隨訓練改變）
    rng_eval = np.random.default_rng(12345)
    n_eval_win = 32
    starts = rng_eval.integers(0, max(1, ho.size - a.seq - 1), size=n_eval_win)

    def heldout_loss():
        import torch.nn.functional as F
        m.eval(); tot, cnt = 0.0, 0
        with torch.no_grad():
            for i in range(0, n_eval_win, 8):
                ss = starts[i:i + 8]
                x = torch.tensor(np.stack([ho[s:s + a.seq] for s in ss]))
                y = torch.tensor(np.stack([ho[s + 1:s + a.seq + 1] for s in ss]))
                B = x.shape[0]
                logits, _ = m(x, torch.ones(B, a.seq, dtype=torch.long), torch.arange(a.seq).unsqueeze(0).expand(B, -1), None)
                l = F.cross_entropy(logits.reshape(-1, vocab), y.reshape(-1), reduction="sum")
                tot += float(l); cnt += y.numel()
        m.train()
        return tot / cnt

    def gen_samples():
        res = []
        for p in prompts:
            ids = tok.encode(p).ids
            new = greedy_cached(m, ids, a.sample_tokens)
            res.append({"prompt": p, "completion": decode_ids(tok, new)})
        return res

    h0 = heldout_loss()
    samples_before = gen_samples()
    emit({"event": "eval", "step": 0, "heldout_loss": round(h0, 5), "heldout_ppl": round(math.exp(h0), 3)})

    decay, no_decay = [], []
    for name, p in m.named_parameters():
        (decay if p.dim() >= 2 and "emb" not in name and "norm" not in name else no_decay).append(p)
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": 0.1}, {"params": no_decay, "weight_decay": 0.0}],
                            lr=a.lr, betas=(0.9, 0.95), eps=1e-8)

    def lr_at(step):
        if step < a.warmup:
            return a.lr * (step + 1) / a.warmup
        t = (step - a.warmup) / max(1, a.steps - a.warmup)
        return a.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * t)))

    rng = np.random.default_rng(a.seed)
    t0 = time.time()
    m.train()
    curve = []
    recent = []
    for step in range(1, a.steps + 1):
        idx = rng.integers(0, tr.size - a.seq - 1, size=a.batch)
        x = torch.tensor(np.stack([tr[i:i + a.seq] for i in idx]))
        y = torch.tensor(np.stack([tr[i + 1:i + a.seq + 1] for i in idx]))
        for g in opt.param_groups:
            g["lr"] = lr_at(step - 1)
        logits, _ = m(x, torch.ones(a.batch, a.seq, dtype=torch.long), torch.arange(a.seq).unsqueeze(0).expand(a.batch, -1), None)
        loss = torch.nn.functional.cross_entropy(logits.reshape(-1, vocab), y.reshape(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0)
        opt.step()
        lv = float(loss.item()); recent.append(lv)
        if step % a.log_every == 0 or step == 1:
            curve.append({"step": step, "loss": round(lv, 5)})
            emit({"step": step, "loss": round(lv, 5), "lr": lr_at(step - 1), "elapsed_s": round(time.time() - t0, 1)})
        if step % a.eval_every == 0 and step != a.steps:
            hl = heldout_loss()
            emit({"event": "eval", "step": step, "heldout_loss": round(hl, 5), "heldout_ppl": round(math.exp(hl), 3)})

    h1 = heldout_loss()
    samples_after = gen_samples()
    emit({"event": "eval", "step": a.steps, "heldout_loss": round(h1, 5), "heldout_ppl": round(math.exp(h1), 3)})
    torch.save({"config": cfg, "state": m.state_dict()}, os.path.join(a.out, "ckpt.pt"))
    write_json(os.path.join(a.out, "config.json"), hf_config(cfg, vocab))
    with open(os.path.join(a.out, "samples_before.jsonl"), "w", encoding="utf-8") as f:
        for s in samples_before:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    with open(os.path.join(a.out, "samples_after.jsonl"), "w", encoding="utf-8") as f:
        for s in samples_after:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    import shutil
    shutil.copy(a.tok, os.path.join(a.out, "tokenizer.json"))
    meta = {"params": n_params, "preset": a.preset, "vocab": vocab, "steps": a.steps, "batch": a.batch, "seq": a.seq,
            "lr": a.lr, "seed": a.seed, "heldout_loss_before": round(h0, 5), "heldout_loss_after": round(h1, 5),
            "heldout_ppl_before": round(math.exp(h0), 3), "heldout_ppl_after": round(math.exp(h1), 3),
            "train_loss_first": curve[0]["loss"] if curve else None, "train_loss_last_avg": round(float(np.mean(recent[-20:])), 5),
            "elapsed_s": round(time.time() - t0, 1), "curve": curve}
    write_json(os.path.join(a.out, "pretrain_meta.json"), meta)
    emit({"event": "pretrain_done", "ok": True, "heldout_loss_before": meta["heldout_loss_before"],
          "heldout_loss_after": meta["heldout_loss_after"], "heldout_ppl_before": meta["heldout_ppl_before"],
          "heldout_ppl_after": meta["heldout_ppl_after"], "params": n_params, "elapsed_s": meta["elapsed_s"]})


# ---------------------------------------------------------------- sft
def load_sft(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for i, ln in enumerate(f):
            ln = ln.strip()
            if not ln:
                continue
            o = json.loads(ln)
            msgs = o.get("messages")
            if not isinstance(msgs, list) or len(msgs) < 2 or msgs[-1].get("role") != "assistant":
                raise ValueError("第 %d 行 messages 必須是以 assistant 結尾的陣列" % (i + 1))
            rows.append(msgs)
    return rows


def chat_prompt_text(msgs):
    """與 nr-template.js 的 qwen3-chatml（enable_thinking=false）逐字相同。"""
    s = ""
    for m in msgs[:-1]:
        s += "<|im_start|>" + m["role"] + "\n" + m["content"] + "<|im_end|>\n"
    return s + "<|im_start|>assistant\n<think>\n\n</think>\n\n"


def cmd_sft(a):
    import torch
    import torch.nn.functional as F
    from tokenizers import Tokenizer
    torch.manual_seed(a.seed)
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    tok = Tokenizer.from_file(os.path.join(a.base, "tokenizer.json"))
    m, cfg = load_ckpt(a.base)
    rows = load_sft(a.data or DEFAULT_SFT)
    rng = np.random.default_rng(a.seed)
    order = rng.permutation(len(rows))
    n_held = max(2, int(round(len(rows) * a.heldout_frac)))
    held_idx, train_idx = order[:n_held], order[n_held:]
    end_id = tok.token_to_id("<|im_end|>")

    def encode_row(msgs):
        p = tok.encode(chat_prompt_text(msgs)).ids
        ans = tok.encode(msgs[-1]["content"] + "<|im_end|>").ids
        return p, ans

    enc = [encode_row(r) for r in rows]
    emit({"event": "start", "rows": len(rows), "train_rows": len(train_idx), "heldout_rows": len(held_idx), "steps": a.steps})

    def batch_of(idxs):
        seqs, labs = [], []
        for i in idxs:
            p, ans = enc[i]
            ids = (p + ans)[: a.seq]
            lab = ([-100] * len(p) + ans)[: a.seq]
            seqs.append(ids); labs.append(lab)
        L = max(len(s) for s in seqs)
        X = torch.full((len(seqs), L), PAD_ID, dtype=torch.long)
        Y = torch.full((len(seqs), L), -100, dtype=torch.long)
        A = torch.zeros((len(seqs), L), dtype=torch.long)
        for j, (s, l) in enumerate(zip(seqs, labs)):
            X[j, :len(s)] = torch.tensor(s); Y[j, :len(l)] = torch.tensor(l); A[j, :len(s)] = 1
        return X, Y, A

    def heldout_loss():
        m.eval(); tot, cnt = 0.0, 0
        with torch.no_grad():
            X, Y, A = batch_of(held_idx)
            pos = torch.arange(X.shape[1]).unsqueeze(0).expand(X.shape[0], -1)
            logits, _ = m(X, A, pos, None)
            tot = float(F.cross_entropy(logits.reshape(-1, logits.shape[-1]), Y.reshape(-1), ignore_index=-100, reduction="sum"))
            cnt = int((Y != -100).sum())
        m.train()
        return tot / max(cnt, 1)

    def answers():
        out = []
        for i in held_idx:
            p, _ = enc[i]
            new = greedy_cached(m, p, a.answer_tokens)
            if end_id in new:
                new = new[:new.index(end_id)]
            out.append({"question": rows[i][-2]["content"], "expected": rows[i][-1]["content"], "answer": decode_ids(tok, new)})
        return out

    h0 = heldout_loss(); ans0 = answers()
    emit({"event": "eval", "step": 0, "heldout_loss": round(h0, 5), "heldout_ppl": round(math.exp(h0), 3)})
    opt = torch.optim.AdamW(m.parameters(), lr=a.lr, betas=(0.9, 0.95), weight_decay=0.0)
    t0 = time.time(); m.train()
    for step in range(1, a.steps + 1):
        idxs = rng.choice(train_idx, size=min(a.batch, len(train_idx)), replace=False)
        X, Y, A = batch_of(idxs)
        pos = torch.arange(X.shape[1]).unsqueeze(0).expand(X.shape[0], -1)
        logits, _ = m(X, A, pos, None)
        loss = F.cross_entropy(logits.reshape(-1, logits.shape[-1]), Y.reshape(-1), ignore_index=-100)
        opt.zero_grad(set_to_none=True); loss.backward()
        torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0); opt.step()
        if step % a.log_every == 0 or step == 1:
            emit({"step": step, "loss": round(float(loss.item()), 5), "elapsed_s": round(time.time() - t0, 1)})
    h1 = heldout_loss(); ans1 = answers()
    emit({"event": "eval", "step": a.steps, "heldout_loss": round(h1, 5), "heldout_ppl": round(math.exp(h1), 3)})
    os.makedirs(a.out, exist_ok=True)
    torch.save({"config": cfg, "state": m.state_dict()}, os.path.join(a.out, "ckpt.pt"))
    import shutil
    shutil.copy(os.path.join(a.base, "tokenizer.json"), os.path.join(a.out, "tokenizer.json"))
    write_json(os.path.join(a.out, "config.json"), hf_config(cfg, tok.get_vocab_size()))
    with open(os.path.join(a.out, "answers_before.jsonl"), "w", encoding="utf-8") as f:
        for r in ans0: f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(os.path.join(a.out, "answers_after.jsonl"), "w", encoding="utf-8") as f:
        for r in ans1: f.write(json.dumps(r, ensure_ascii=False) + "\n")
    meta = {"rows": len(rows), "train_rows": int(len(train_idx)), "heldout_rows": int(len(held_idx)), "steps": a.steps,
            "lr": a.lr, "batch": a.batch, "seed": a.seed, "heldout_loss_before": round(h0, 5), "heldout_loss_after": round(h1, 5),
            "heldout_ppl_before": round(math.exp(h0), 3), "heldout_ppl_after": round(math.exp(h1), 3),
            "answer_end_rate_after": round(float(np.mean([("<|im_end|>" not in r["answer"]) for r in ans1])), 3),
            "elapsed_s": round(time.time() - t0, 1)}
    write_json(os.path.join(a.out, "sft_meta.json"), meta)
    emit({"event": "sft_done", "ok": True, "heldout_loss_before": meta["heldout_loss_before"], "heldout_loss_after": meta["heldout_loss_after"],
          "heldout_ppl_before": meta["heldout_ppl_before"], "heldout_ppl_after": meta["heldout_ppl_after"], "elapsed_s": meta["elapsed_s"]})


# ---------------------------------------------------------------- export
def cmd_export(a):
    import torch
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic, QuantType
    from tokenizers import Tokenizer
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    m, cfg = load_ckpt(a.model)
    if (cfg["layers"], cfg["kv_heads"], cfg["head_dim"]) != (LAYERS, KV_HEADS, HEAD_DIM):
        fail("原生執行環境寫死 %d 層／%d 個 KV 頭／head_dim %d，模型不符" % (LAYERS, KV_HEADS, HEAD_DIM))
    tok = Tokenizer.from_file(os.path.join(a.model, "tokenizer.json"))
    L = cfg["layers"]
    fp_dir = os.path.join(a.out, "fp32"); q_dir = os.path.join(a.out, "q8")
    os.makedirs(fp_dir, exist_ok=True); os.makedirs(q_dir, exist_ok=True)
    fp = os.path.join(fp_dir, "model.onnx"); q8 = os.path.join(q_dir, "model_quantized.onnx")
    in_names = ["input_ids", "attention_mask", "position_ids"] + [f"past_key_values.{l}.{k}" for l in range(L) for k in ("key", "value")]
    out_names = ["logits"] + [f"present.{l}.{k}" for l in range(L) for k in ("key", "value")]
    dyn = {"input_ids": {1: "seq"}, "attention_mask": {1: "total"}, "position_ids": {1: "seq"}, "logits": {1: "seq"}}
    for l in range(L):
        for k in ("key", "value"):
            dyn[f"past_key_values.{l}.{k}"] = {2: "past"}
            dyn[f"present.{l}.{k}"] = {2: "total"}

    class Wrap(torch.nn.Module):
        def __init__(s, lm):
            super().__init__(); s.lm = lm

        def forward(s, input_ids, attention_mask, position_ids, *past):
            logits, pres = s.lm(input_ids, attention_mask, position_ids, list(past))
            return (logits,) + tuple(pres)

    w = Wrap(m).eval()
    ex_ids = torch.tensor([[1, 2, 3, 4]]); ex_am = torch.ones(1, 6, dtype=torch.long); ex_pos = torch.tensor([[2, 3, 4, 5]])
    ex_past = [torch.zeros(1, cfg["kv_heads"], 2, cfg["head_dim"]) for _ in range(2 * L)]
    with torch.no_grad():
        torch.onnx.export(w, (ex_ids, ex_am, ex_pos, *ex_past), fp, input_names=in_names, output_names=out_names,
                          dynamic_axes=dyn, opset_version=17, do_constant_folding=True, dynamo=False)
    emit({"event": "export_fp32", "path": fp, "bytes": os.path.getsize(fp)})
    quantize_dynamic(fp, q8, weight_type=QuantType.QInt8)
    emit({"event": "export_q8", "path": q8, "bytes": os.path.getsize(q8)})

    # 核對 1：ORT fp32 與 PyTorch 的首步 logits（含 2 個 past 的第二步）
    prompt = tok.encode("<|im_start|>user\n你好<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n").ids
    sess_fp = ort.InferenceSession(fp, providers=["CPUExecutionProvider"])
    sess_q = ort.InferenceSession(q8, providers=["CPUExecutionProvider"])

    def ort_greedy(sess, ids, n):
        past = {f"past_key_values.{l}.{k}": np.zeros((1, cfg["kv_heads"], 0, cfg["head_dim"]), np.float32) for l in range(L) for k in ("key", "value")}
        cur = list(ids); total = 0; out = []; first_logits = None
        for _ in range(n):
            q = cur
            feed = dict(past)
            feed["input_ids"] = np.array([q], np.int64)
            feed["attention_mask"] = np.ones((1, total + len(q)), np.int64)
            feed["position_ids"] = np.arange(total, total + len(q), dtype=np.int64)[None]
            r = sess.run(out_names, feed)
            if first_logits is None:
                first_logits = r[0][0, -1].copy()
            nxt = int(np.argmax(r[0][0, -1]))
            out.append(nxt)
            for li in range(L):
                past[f"past_key_values.{li}.key"] = r[1 + 2 * li]
                past[f"past_key_values.{li}.value"] = r[2 + 2 * li]
            total += len(q)
            cur = [nxt]
        return out, first_logits

    n_check = 24
    ids_fp, lg_fp = ort_greedy(sess_fp, prompt, n_check)
    ids_q, lg_q = ort_greedy(sess_q, prompt, n_check)
    with torch.no_grad():
        t_new = greedy_cached(m, prompt, n_check)
        t_lg = m(torch.tensor([prompt]), torch.ones(1, len(prompt), dtype=torch.long),
                 torch.arange(len(prompt)).unsqueeze(0), None)[0][0, -1].numpy()
    max_abs_fp = float(np.max(np.abs(lg_fp - t_lg)))
    fp_match = (ids_fp == t_new)
    q_match_frac = float(np.mean([x == y for x, y in zip(ids_q, ids_fp)]))
    q_lg_diff = float(np.max(np.abs(lg_q - lg_fp)))
    rel = q_lg_diff / max(float(np.max(np.abs(lg_fp))), 1e-9)
    expected = {"prompt_ids": prompt, "n_new": n_check, "ids": ids_q, "text": decode_ids(tok, ids_q)}
    write_json(os.path.join(a.out, "expected.json"), expected)
    import shutil
    shutil.copy(os.path.join(a.model, "tokenizer.json"), os.path.join(a.out, "tokenizer.json"))
    shutil.copy(os.path.join(a.model, "config.json"), os.path.join(a.out, "config.json"))
    manifest = {"format": "onnx", "quant": "q8", "files": {
                    "q8/model_quantized.onnx": {"sha256": sha256_file(q8), "bytes": os.path.getsize(q8)},
                    "tokenizer.json": {"sha256": sha256_file(os.path.join(a.out, "tokenizer.json")), "bytes": os.path.getsize(os.path.join(a.out, "tokenizer.json"))}},
                "arch": {"model_type": "qwen3", "layers": L, "kv_heads": cfg["kv_heads"], "head_dim": cfg["head_dim"], "hidden": cfg["hidden"], "vocab": cfg["vocab"]},
                "verify": {"fp32_vs_torch_max_abs_logit_diff": max_abs_fp, "fp32_greedy_matches_torch": fp_match,
                           "q8_greedy_match_fp32_frac": q_match_frac, "q8_max_abs_logit_diff": q_lg_diff, "q8_rel_logit_diff": rel}}
    write_json(os.path.join(a.out, "manifest.json"), manifest)
    emit({"event": "export_verify", "ok": True, "fp32_vs_torch_max_abs_logit_diff": max_abs_fp, "fp32_greedy_matches_torch": fp_match,
          "q8_greedy_match_fp32_frac": q_match_frac, "q8_rel_logit_diff": round(rel, 5), "q8_bytes": os.path.getsize(q8),
          "fp32_bytes": os.path.getsize(fp), "sample": expected["text"]})


# ---------------------------------------------------------------- export-hf
def cmd_export_hf(a):
    """標準 Hugging Face Qwen3 格式（safetensors＋config.json＋tokenizer.json）：給 LoRA 微調與加長上下文接手，並用 transformers 載入核對。"""
    import torch
    from safetensors.torch import save_file
    from tokenizers import Tokenizer
    m, cfg = load_ckpt(a.model)
    tok = Tokenizer.from_file(os.path.join(a.model, "tokenizer.json"))
    sd = {"model.embed_tokens.weight": m.emb.weight.detach().clone(), "model.norm.weight": m.norm.weight.detach().clone()}
    for i, b in enumerate(m.layers):
        P = "model.layers.%d." % i
        sd[P + "self_attn.q_proj.weight"] = b.q.weight.detach().clone(); sd[P + "self_attn.k_proj.weight"] = b.k.weight.detach().clone()
        sd[P + "self_attn.v_proj.weight"] = b.v.weight.detach().clone(); sd[P + "self_attn.o_proj.weight"] = b.o.weight.detach().clone()
        sd[P + "self_attn.q_norm.weight"] = b.qn.weight.detach().clone(); sd[P + "self_attn.k_norm.weight"] = b.kn.weight.detach().clone()
        sd[P + "input_layernorm.weight"] = b.n1.weight.detach().clone(); sd[P + "post_attention_layernorm.weight"] = b.n2.weight.detach().clone()
        sd[P + "mlp.gate_proj.weight"] = b.gate.weight.detach().clone(); sd[P + "mlp.up_proj.weight"] = b.up.weight.detach().clone(); sd[P + "mlp.down_proj.weight"] = b.down.weight.detach().clone()
    os.makedirs(a.out, exist_ok=True)
    save_file(sd, os.path.join(a.out, "model.safetensors"), metadata={"format": "pt"})
    hc = hf_config(cfg, tok.get_vocab_size())
    hc.update({"attention_bias": False, "attention_dropout": 0.0, "bos_token_id": tok.token_to_id("<|endoftext|>"), "eos_token_id": tok.token_to_id("<|im_end|>"),
               "rope_scaling": None, "sliding_window": None, "use_sliding_window": False, "max_window_layers": cfg["layers"], "initializer_range": 0.02})
    write_json(os.path.join(a.out, "config.json"), hc)
    import shutil
    shutil.copy(os.path.join(a.model, "tokenizer.json"), os.path.join(a.out, "tokenizer.json"))
    # 訓練環境的 torchvision 與 transformers 版本不合時（import 時 torchvision::nms 不存在），只在這一步讓 transformers 看不到 torchvision（本來就用不到）
    if "torchvision" not in sys.modules:
        sys.modules["torchvision"] = None
    from transformers import AutoModelForCausalLM
    hm = AutoModelForCausalLM.from_pretrained(a.out, torch_dtype=torch.float32).eval()
    prompt = tok.encode("<|im_start|>user\n你好<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n").ids
    with torch.no_grad():
        ours = m(torch.tensor([prompt]), torch.ones(1, len(prompt), dtype=torch.long), torch.arange(len(prompt)).unsqueeze(0), None)[0]
        theirs = hm(torch.tensor([prompt])).logits
        hf_ids = hm.generate(torch.tensor([prompt]), attention_mask=torch.ones(1, len(prompt), dtype=torch.long), max_new_tokens=24, do_sample=False, pad_token_id=0)[0, len(prompt):].tolist()
    our_ids = greedy_cached(m, prompt, 24)
    n = min(len(hf_ids), len(our_ids))
    rep = {"event": "export_hf", "ok": True, "transformers_loads": True, "max_abs_logit_diff": float((ours - theirs).abs().max()),
           "greedy_identical": hf_ids[:n] == our_ids[:n], "params": count_params(m), "files": ["model.safetensors", "config.json", "tokenizer.json"]}
    write_json(os.path.join(a.out, "hf_check.json"), rep)
    emit(rep)


# ---------------------------------------------------------------- check
def cmd_check(a):
    import onnxruntime as ort
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(os.path.join(a.model_dir, "tokenizer.json"))
    exp = json.load(open(os.path.join(a.model_dir, "expected.json"), "r", encoding="utf-8"))
    cfg = json.load(open(os.path.join(a.model_dir, "config.json"), "r", encoding="utf-8"))
    L, KV, HD = cfg["num_hidden_layers"], cfg["num_key_value_heads"], cfg["head_dim"]
    q8 = os.path.join(a.model_dir, "q8", "model_quantized.onnx")
    out_names = ["logits"] + [f"present.{l}.{k}" for l in range(L) for k in ("key", "value")]

    def run_once():
        sess = ort.InferenceSession(q8, providers=["CPUExecutionProvider"])   # 每次都重新載入
        past = {f"past_key_values.{l}.{k}": np.zeros((1, KV, 0, HD), np.float32) for l in range(L) for k in ("key", "value")}
        cur = list(exp["prompt_ids"]); total = 0; out = []
        for _ in range(exp["n_new"]):
            feed = dict(past)
            feed["input_ids"] = np.array([cur], np.int64)
            feed["attention_mask"] = np.ones((1, total + len(cur)), np.int64)
            feed["position_ids"] = np.arange(total, total + len(cur), dtype=np.int64)[None]
            r = sess.run(out_names, feed)
            nxt = int(np.argmax(r[0][0, -1])); out.append(nxt)
            for li in range(L):
                past[f"past_key_values.{li}.key"] = r[1 + 2 * li]; past[f"past_key_values.{li}.value"] = r[2 + 2 * li]
            total += len(cur); cur = [nxt]
        del sess
        return out

    run1 = run_once(); run2 = run_once()
    rep = {"reload_identical": run1 == run2, "matches_export": run1 == exp["ids"], "n_tokens": len(run1),
           "sample_text": tok.decode(run1, skip_special_tokens=False), "file_sha256": sha256_file(q8)}
    write_json(os.path.join(a.model_dir, "check.json"), rep)
    emit(dict(rep, event="check", ok=rep["reload_identical"] and rep["matches_export"]))


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="從零建立小型 LLM（工作室用）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prep"); p.add_argument("--corpus", default=""); p.add_argument("--builtin", action="store_true"); p.add_argument("--out", required=True)
    p = sub.add_parser("tokenizer"); p.add_argument("--data", required=True); p.add_argument("--out", required=True); p.add_argument("--vocab", type=int, default=8192)
    p = sub.add_parser("pretrain"); p.add_argument("--data", required=True); p.add_argument("--tok", required=True); p.add_argument("--out", required=True)
    p.add_argument("--preset", default="small", choices=sorted(PRESETS)); p.add_argument("--steps", type=int, default=1500); p.add_argument("--batch", type=int, default=8)
    p.add_argument("--seq", type=int, default=256); p.add_argument("--lr", type=float, default=0.002); p.add_argument("--warmup", type=int, default=50)
    p.add_argument("--seed", type=int, default=0); p.add_argument("--eval-every", dest="eval_every", type=int, default=250); p.add_argument("--log-every", dest="log_every", type=int, default=10)
    p.add_argument("--sample-tokens", dest="sample_tokens", type=int, default=48); p.add_argument("--threads", type=int, default=8)
    p = sub.add_parser("sft"); p.add_argument("--base", required=True); p.add_argument("--data", default=""); p.add_argument("--out", required=True)
    p.add_argument("--steps", type=int, default=300); p.add_argument("--batch", type=int, default=8); p.add_argument("--lr", type=float, default=0.0005)
    p.add_argument("--seq", type=int, default=256); p.add_argument("--seed", type=int, default=0); p.add_argument("--heldout-frac", dest="heldout_frac", type=float, default=0.2)
    p.add_argument("--answer-tokens", dest="answer_tokens", type=int, default=48); p.add_argument("--log-every", dest="log_every", type=int, default=10)
    p = sub.add_parser("export"); p.add_argument("--model", required=True); p.add_argument("--out", required=True)
    p = sub.add_parser("export-hf"); p.add_argument("--model", required=True); p.add_argument("--out", required=True)
    p = sub.add_parser("check"); p.add_argument("--model-dir", dest="model_dir", required=True)
    a = ap.parse_args()
    {"prep": cmd_prep, "tokenizer": cmd_tokenizer, "pretrain": cmd_pretrain, "sft": cmd_sft, "export": cmd_export, "export-hf": cmd_export_hf, "check": cmd_check}[a.cmd](a)


if __name__ == "__main__":
    main()
