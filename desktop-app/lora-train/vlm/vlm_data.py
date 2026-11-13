"""看圖說文字（VLM）訓練資料：格式、合成資料、切分與標籤遮罩（純 Python，不需要 torch，可單檔測試）。

資料列格式（JSONL，一行一筆；圖片路徑相對於資料檔所在資料夾）：
  {"id": "...", "split": "train"|"eval", "image": "images/000001.png",
   "messages": [{"role": "user", "content": "<提示詞>"}, {"role": "assistant", "content": "<答案>"}],
   "meta": {"color": "red", "shape": "circle", "combo": "red-circle"}}   # meta 可省略，只給評量用
- 只有一張圖，放在第一則 user 訊息前面（處理器會把圖展開成影像權杖）。
- 只有 assistant 的內容參與損失；提示詞（含圖的權杖）全部遮罩成 -100。
- 切分：eval 組的「顏色×形狀組合」與 train 組完全不重疊，評量才看得出是學到概念，不是背題。
"""
import json, os, random

COLORS = {"red": (220, 30, 30), "blue": (30, 60, 220), "green": (30, 160, 60),
          "yellow": (240, 210, 20), "purple": (130, 40, 170), "orange": (250, 130, 20)}
SHAPES = ["circle", "square", "triangle"]
# 留出的組合（不進訓練）：評量只用這幾組
HELD_OUT_COMBOS = {"blue-triangle", "green-circle", "yellow-square", "purple-triangle"}
CAPTION_PROMPT = "Describe this image in one short sentence."
COLOR_QUESTION = "What color is the shape?"
SHAPE_QUESTION = "What shape is shown?"
ROLES = {"user", "assistant"}


def caption_answer(color, shape):
    return "A %s %s on a white background." % (color, shape)


def all_combos():
    return ["%s-%s" % (c, s) for c in COLORS for s in SHAPES]


def validate_row(row):
    """回傳錯誤清單（空＝合格）。"""
    errs = []
    for k in ("id", "split", "image", "messages"):
        if k not in row:
            errs.append("缺欄位 " + k)
    if errs:
        return errs
    if row["split"] not in ("train", "eval"):
        errs.append("split 只能是 train 或 eval")
    msgs = row["messages"]
    if not isinstance(msgs, list) or len(msgs) != 2:
        errs.append("messages 必須剛好兩則（user、assistant）")
        return errs
    if [m.get("role") for m in msgs] != ["user", "assistant"]:
        errs.append("messages 的 role 順序必須是 user、assistant")
    for m in msgs:
        if not isinstance(m.get("content"), str) or not m["content"].strip():
            errs.append("content 必須是非空字串")
    if os.path.isabs(row["image"]) or ".." in row["image"].replace("\\", "/").split("/"):
        errs.append("image 必須是資料夾內的相對路徑")
    return errs


def mask_labels(input_ids, prompt_len):
    """前 prompt_len 個權杖遮罩成 -100，其餘保留（只算答案的損失）。"""
    if prompt_len < 0 or prompt_len > len(input_ids):
        raise ValueError("prompt_len 超出範圍")
    return [-100] * prompt_len + list(input_ids[prompt_len:])


def render_image(color, shape, seed, size=256):
    """用 PIL 畫一個有顏色的形狀，白底；位置與大小由 seed 決定（可重現）。"""
    from PIL import Image, ImageDraw
    rnd = random.Random(seed)
    img = Image.new("RGB", (size, size), (255, 255, 255))
    d = ImageDraw.Draw(img)
    r = rnd.randint(size // 6, size // 3)
    cx, cy = rnd.randint(r + 8, size - r - 8), rnd.randint(r + 8, size - r - 8)
    fill = COLORS[color]
    if shape == "circle":
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)
    elif shape == "square":
        d.rectangle((cx - r, cy - r, cx + r, cy + r), fill=fill)
    elif shape == "triangle":
        d.polygon([(cx, cy - r), (cx - r, cy + r), (cx + r, cy + r)], fill=fill)
    else:
        raise ValueError("未知形狀 " + shape)
    return img


def make_dataset(out_dir, train_per_combo=30, eval_per_combo=3, seed=20261113):
    """產生資料集到 out_dir（images/ 與 train.jsonl、eval.jsonl）。同一 seed 產生的檔案位元組相同。"""
    os.makedirs(os.path.join(out_dir, "images"), exist_ok=True)
    rows = {"train": [], "eval": []}
    n = 0
    for ci, combo in enumerate(all_combos()):
        color, shape = combo.split("-")
        held = combo in HELD_OUT_COMBOS
        split = "eval" if held else "train"
        count = eval_per_combo if held else train_per_combo
        for k in range(count):
            n += 1
            s = seed * 1000 + ci * 100 + k
            rel = "images/%06d.png" % n
            render_image(color, shape, s).save(os.path.join(out_dir, rel))
            meta = {"color": color, "shape": shape, "combo": combo, "seed": s}
            rows[split].append({"id": "cap-%06d" % n, "split": split, "image": rel,
                                "messages": [{"role": "user", "content": CAPTION_PROMPT},
                                             {"role": "assistant", "content": caption_answer(color, shape)}],
                                "meta": meta})
            if not held:  # 問答樣本只放進訓練組（評量只用描述題，避免洩題）
                rows[split].append({"id": "qc-%06d" % n, "split": split, "image": rel,
                                    "messages": [{"role": "user", "content": COLOR_QUESTION},
                                                 {"role": "assistant", "content": color}], "meta": meta})
                rows[split].append({"id": "qs-%06d" % n, "split": split, "image": rel,
                                    "messages": [{"role": "user", "content": SHAPE_QUESTION},
                                                 {"role": "assistant", "content": shape}], "meta": meta})
    for split, fn in (("train", "train.jsonl"), ("eval", "eval.jsonl")):
        with open(os.path.join(out_dir, fn), "w", encoding="utf-8") as f:
            for r in rows[split]:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return {"train": len(rows["train"]), "eval": len(rows["eval"])}


def read_rows(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def score_caption(text, meta):
    """描述是否同時含正確的顏色與形狀（小寫、整詞比對）。回傳 (color_ok, shape_ok)。"""
    words = set(w.strip(".,;:!?\"'") for w in text.lower().split())
    return meta["color"] in words, meta["shape"] in words
