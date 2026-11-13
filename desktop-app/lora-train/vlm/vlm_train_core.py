"""看圖說文字 VLM 的 LoRA 訓練核心（需要 torch、transformers、peft、PIL）。

只訓練語言部分（text_model 的線性層）；視覺編碼器與連接器凍結。損失只算 assistant 的答案。
沿用 lora-train/lora_common.py 的做法：提示詞遮罩成 -100、只對答案算損失、列格式與其他訓練一致。
處理器一律 do_image_splitting=False（一張圖固定 64 個影像權杖，CPU 才跑得動；訓練與推論必須一致）。
"""
import os, random, json, time
import vlm_data as V  # noqa: E402

DEFAULT_MODEL_DIR = "/home/hungfu.lee/fa-work/vlm-studio/smolvlm-256m"
TARGET_RE = r".*text_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)"


def load_processor_and_model(model_dir, dtype="float32"):
    import torch
    from transformers import AutoProcessor, AutoModelForImageTextToText
    proc = AutoProcessor.from_pretrained(model_dir, do_image_splitting=False)
    model = AutoModelForImageTextToText.from_pretrained(model_dir, dtype=getattr(torch, dtype))
    return proc, model


def image_features(base_model, proc, img_path, cache):
    """圖 → 連接器輸出（每張圖 64×576）。視覺編碼器與連接器凍結，所以同一張圖只算一次（CPU 上省下大部分時間）。
    與完整前向用的是同一條路徑（processor → get_image_features），快取前後的 loss 要相同（見 test_vlm_train_cache.py）。"""
    import torch
    from PIL import Image
    if img_path in cache:
        return cache[img_path]
    img = Image.open(img_path).convert("RGB")
    pi = proc.image_processor(images=[img], return_tensors="pt")
    with torch.no_grad():
        out = base_model.model.get_image_features(pixel_values=pi["pixel_values"], pixel_attention_mask=pi["pixel_attention_mask"], return_dict=True)
    cache[img_path] = out.pooler_output[0].detach().clone()
    return cache[img_path]


class _MMOut:
    def __init__(self, pooler_output):
        self.pooler_output = pooler_output


def encode_row(proc, row, data_root, feat_cache):
    """回傳 (kwargs, labels)：kwargs 是模型前向參數（input_ids、attention_mask、mm_encoder_outputs），labels 遮罩後形狀同 input_ids。
    feat_cache 是 dict，key＝圖片路徑，值＝圖像特徵（由 image_features 填入）。"""
    import torch
    from PIL import Image
    path = os.path.join(data_root, row["image"])
    user, answer = row["messages"][0]["content"], row["messages"][1]["content"]
    prompt_msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": user}]}]
    full_msgs = prompt_msgs + [{"role": "assistant", "content": [{"type": "text", "text": answer}]}]
    prompt = proc.apply_chat_template(prompt_msgs, add_generation_prompt=True)
    full = proc.apply_chat_template(full_msgs, add_generation_prompt=False)
    if not full.startswith(prompt):
        raise RuntimeError("提示詞不是完整文字的前綴，無法遮罩")
    img = Image.open(path).convert("RGB")
    # 文字權杖：處理器會把 <image> 展開成影像權杖；這裡用同一段文字，只要 pixel 部分改由快取特徵提供
    inputs = proc(text=full, images=[img], return_tensors="pt")
    prompt_len = proc(text=prompt, images=[img], return_tensors="pt")["input_ids"].shape[1]
    ids = inputs["input_ids"][0].tolist()
    labels = torch.tensor([V.mask_labels(ids, prompt_len)])
    feat = feat_cache[path]
    kwargs = {"input_ids": inputs["input_ids"], "attention_mask": inputs["attention_mask"],
              "mm_encoder_outputs": {"image": _MMOut([feat])}}
    return kwargs, labels


def make_lora(model, r=8, alpha=16, dropout=0.0, seed=0):
    from peft import LoraConfig, get_peft_model
    cfg = LoraConfig(r=r, lora_alpha=alpha, lora_dropout=dropout, target_modules=TARGET_RE, bias="none")
    return get_peft_model(model, cfg)


def train(model_dir, data_dir, out_dir, steps=300, accum=4, lr=2e-4, r=8, alpha=16, seed=1234,
          log_every=10, threads=None):
    """steps＝樣本數（每筆一步前向＋反向）；每 accum 筆更新一次參數。回傳訓練紀錄 dict。"""
    import torch
    from lora_common import read_jsonl  # 沿用 lora-train/lora_common.py 的讀檔
    if threads:
        torch.set_num_threads(threads)
    torch.manual_seed(seed)
    rnd = random.Random(seed)
    proc, model = load_processor_and_model(model_dir)
    for p in model.parameters():
        p.requires_grad_(False)
    model = make_lora(model, r=r, alpha=alpha, seed=seed)
    trainable = [p for p in model.parameters() if p.requires_grad]
    n_tr = sum(p.numel() for p in trainable)
    n_all = sum(p.numel() for p in model.parameters())
    rows = [x for x in read_jsonl(os.path.join(data_dir, "train.jsonl")) if x["split"] == "train"]
    for x in rows:
        errs = V.validate_row(x)
        if errs:
            raise ValueError("列 %s 不合格：%s" % (x.get("id"), errs))
    opt = torch.optim.AdamW(trainable, lr=lr, weight_decay=0.0)
    order = []
    while len(order) < steps:
        idx = list(range(len(rows))); rnd.shuffle(idx); order += idx
    order = order[:steps]
    n_upd = max(1, steps // accum)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 5) * max(0.1, 1 - s / n_upd))
    model.train()
    base = model.get_base_model()
    feat_cache = {}
    losses, log = [], []
    t0 = time.time()
    for i, j in enumerate(order):
        image_features(base, proc, os.path.join(data_dir, rows[j]["image"]), feat_cache)
        inputs, labels = encode_row(proc, rows[j], data_dir, feat_cache)
        out = model(**inputs, labels=labels)
        (out.loss / accum).backward()
        losses.append(out.loss.item())
        if (i + 1) % accum == 0 or i == len(order) - 1:
            torch.nn.utils.clip_grad_norm_(trainable, 1.0)
            opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
        if (i + 1) % log_every == 0 or i == 0:
            rec = {"step": i + 1, "loss_mean_recent": round(sum(losses[-log_every:]) / len(losses[-log_every:]), 5),
                   "elapsed_s": round(time.time() - t0, 1), "row_id": rows[j]["id"]}
            log.append(rec); print(json.dumps(rec, ensure_ascii=False), flush=True)
    os.makedirs(out_dir, exist_ok=True)
    model.save_pretrained(os.path.join(out_dir, "adapter"))
    res = {"model_dir": model_dir, "steps": steps, "accum": accum, "lr": lr, "r": r, "alpha": alpha, "seed": seed,
           "trainable_params": n_tr, "total_params": n_all, "trainable_pct": round(100.0 * n_tr / n_all, 4),
           "loss_first10_mean": round(sum(losses[:10]) / len(losses[:10]), 5),
           "loss_last10_mean": round(sum(losses[-10:]) / len(losses[-10:]), 5),
           "losses": [round(x, 6) for x in losses], "log": log, "train_seconds": round(time.time() - t0, 1)}
    with open(os.path.join(out_dir, "train_result.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False)
    return res
