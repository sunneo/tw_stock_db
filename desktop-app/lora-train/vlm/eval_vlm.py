"""看圖說文字的評量：對留出組合（訓練沒看過）的圖跑描述（greedy，固定 max_new_tokens），算顏色／形狀是否說對。
  python lora-train/vlm/eval_vlm.py --data <資料夾> --out <結果.json> [--adapter <adapter 資料夾>] [--full <完整模型資料夾>]
不給 --adapter／--full 就是訓練前的基底模型。結果寫 JSON（含每張圖的輸出文字，供人工檢查）。"""
import os, sys, json, time, argparse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import vlm_data as V
import vlm_train_core as C


def generate_one(proc, model, row, data_root, max_new):
    import torch
    from PIL import Image
    img = Image.open(os.path.join(data_root, row["image"])).convert("RGB")
    msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": row["messages"][0]["content"]}]}]
    prompt = proc.apply_chat_template(msgs, add_generation_prompt=True)
    inputs = proc(text=prompt, images=[img], return_tensors="pt")
    t0 = time.time()
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=max_new, do_sample=False)
    sec = time.time() - t0
    text = proc.batch_decode(out[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0].strip()
    return text, sec


def run(model_dir, data_dir, out_path, adapter=None, full=None, max_new=24, threads=None):
    import torch
    if threads:
        torch.set_num_threads(threads)
    rows = [r for r in V.read_rows(os.path.join(data_dir, "eval.jsonl")) if r["messages"][0]["content"] == V.CAPTION_PROMPT]
    proc, model = C.load_processor_and_model(full or model_dir)
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter)
    model.eval()
    items, c_ok, s_ok, b_ok, secs = [], 0, 0, 0, []
    for r in rows:
        text, sec = generate_one(proc, model, r, data_dir, max_new)
        co, so = V.score_caption(text, r["meta"])
        c_ok += co; s_ok += so; b_ok += (co and so); secs.append(sec)
        items.append({"id": r["id"], "combo": r["meta"]["combo"], "text": text, "color_ok": co, "shape_ok": so, "sec": round(sec, 2)})
    n = len(rows)
    res = {"model": full or model_dir, "adapter": adapter, "n": n,
           "color_acc": round(c_ok / n, 4), "shape_acc": round(s_ok / n, 4), "both_acc": round(b_ok / n, 4),
           "gen_sec_mean": round(sum(secs) / n, 3), "max_new_tokens": max_new, "items": items}
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != "items"}, ensure_ascii=False))
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=C.DEFAULT_MODEL_DIR)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--adapter")
    ap.add_argument("--full")
    ap.add_argument("--max-new", type=int, default=24)
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    run(a.model, a.data, a.out, adapter=a.adapter, full=a.full, max_new=a.max_new, threads=a.threads or None)
