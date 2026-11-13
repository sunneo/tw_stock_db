"""把 VLM 的 LoRA 併回基底，匯出完整模型（safetensors 資料夾），並用匯出的模型重新載入、描述同一批圖，確認和「基底＋adapter」的輸出一致。
  python lora-train/vlm/merge_export_vlm.py --adapter <adapter 資料夾> --out <完整模型資料夾> --data <資料夾> [--n 3]"""
import os, sys, json, argparse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import torch
import vlm_data as V
import vlm_train_core as C
import eval_vlm as E

ap = argparse.ArgumentParser()
ap.add_argument("--model", default=C.DEFAULT_MODEL_DIR)
ap.add_argument("--adapter", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--data", required=True)
ap.add_argument("--n", type=int, default=3)
ap.add_argument("--threads", type=int, default=4)
a = ap.parse_args()
torch.set_num_threads(a.threads)
proc, base = C.load_processor_and_model(a.model)  # 先載入 transformers 模型，再匯入 peft（環境中 peft 直接匯入會因 torchvision 版本不合而失敗）
from peft import PeftModel
m = PeftModel.from_pretrained(base, a.adapter).merge_and_unload().eval()
os.makedirs(a.out, exist_ok=True)
m.save_pretrained(a.out, safe_serialization=True)
proc.save_pretrained(a.out)
size = sum(os.path.getsize(os.path.join(a.out, f)) for f in os.listdir(a.out))
print("匯出完成：", a.out, "大小 %.1f MB" % (size / 1e6))
# 重新載入匯出的完整模型，跟 adapter 版逐字比對
proc2, full = C.load_processor_and_model(a.out)
full.eval()
rows = [r for r in V.read_rows(os.path.join(a.data, "eval.jsonl")) if r["messages"][0]["content"] == V.CAPTION_PROMPT][: a.n]
same = True; outs = []
pm = PeftModel.from_pretrained(C.load_processor_and_model(a.model)[1], a.adapter).eval()  # 另一份基底，確保比的是「基底＋adapter」
for r in rows:
    t_full, _ = E.generate_one(proc2, full, r, a.data, 24)
    t_adp, _ = E.generate_one(proc, pm, r, a.data, 24)
    same &= (t_full == t_adp)
    outs.append({"id": r["id"], "full": t_full, "adapter": t_adp})
res = {"out": a.out, "size_mb": round(size / 1e6, 1), "n": len(rows), "same_text_full_vs_adapter": same, "items": outs}
with open(os.path.join(a.out, "export_check.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in res.items() if k != "items"}, ensure_ascii=False))
