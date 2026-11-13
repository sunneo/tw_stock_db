"""單檔測試：圖像特徵快取不改變結果。同一筆資料，用完整前向（pixel_values）與快取特徵（mm_encoder_outputs）各算一次 loss，
兩者必須一致（誤差 < 1e-4）；並檢查標籤遮罩只留答案權杖。需要 SmolVLM 權重（預設路徑，可用 --model 指定）。
  python lora-train/vlm/test_vlm_train_cache.py [--model <資料夾>] [--data <資料夾>]"""
import os, sys, argparse, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import torch
import vlm_data as V
import vlm_train_core as C

ap = argparse.ArgumentParser()
ap.add_argument("--model", default=C.DEFAULT_MODEL_DIR)
ap.add_argument("--data", default="/home/hungfu.lee/fa-work/vlm-studio/data1")
a = ap.parse_args()
torch.set_num_threads(int(os.environ.get("VLM_THREADS", "8")))
fails = []
def check(n, c, info=""):
    print(("ok   " if c else "FAIL ") + n, info if not c else "")
    if not c: fails.append(n)

if not os.path.exists(os.path.join(a.data, "train.jsonl")):
    V.make_dataset(a.data)
proc, model = C.load_processor_and_model(a.model)
model.eval()
rows = [r for r in V.read_rows(os.path.join(a.data, "train.jsonl")) if r["split"] == "train"][:2]
base = model
cache = {}
diffs = []
for r in rows:
    path = os.path.join(a.data, r["image"])
    C.image_features(base, proc, path, cache)
    # 完整前向
    from PIL import Image
    img = Image.open(path).convert("RGB")
    user, answer = r["messages"][0]["content"], r["messages"][1]["content"]
    msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": user}]}, {"role": "assistant", "content": [{"type": "text", "text": answer}]}]
    full = proc(text=proc.apply_chat_template(msgs, add_generation_prompt=False), images=[img], return_tensors="pt")
    with torch.no_grad():
        t0 = time.time(); l_full = model(**full, labels=full["input_ids"]).loss.item(); t_full = time.time() - t0
    kw, labels = C.encode_row(proc, r, a.data, cache)
    with torch.no_grad():
        t0 = time.time(); l_cache = model(**kw, labels=labels).loss.item(); t_cache = time.time() - t0
    # 快取版的 loss 只算答案，所以要用同一組標籤比較：完整前向也用遮罩後的標籤
    with torch.no_grad():
        l_full_masked = model(**full, labels=labels).loss.item()
    diffs.append(abs(l_full_masked - l_cache))
    print("row", r["id"], "full(masked)=%.6f cached=%.6f  sec full=%.2f cached=%.2f" % (l_full_masked, l_cache, t_full, t_cache))
check("快取與完整前向的 loss 一致（誤差 < 1e-4）", max(diffs) < 1e-4, diffs)
kw, labels = C.encode_row(proc, rows[0], a.data, cache)
ids = kw["input_ids"][0].tolist(); lab = labels[0].tolist()
check("標籤：提示部分全部 -100，答案與結尾權杖保留", any(x != -100 for x in lab) and all(x == -100 for x in lab[:lab.index(next(x for x in lab if x != -100))]))
check("標籤：答案權杖數 > 0 且 < 總長", 0 < sum(1 for x in lab if x != -100) < len(lab))
print("\n結果：%d 項失敗" % len(fails))
sys.exit(1 if fails else 0)
