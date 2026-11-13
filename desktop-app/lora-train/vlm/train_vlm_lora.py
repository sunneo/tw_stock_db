"""命令列：產生資料（可選）→ 訓練 VLM LoRA → 存 adapter。
  python lora-train/vlm/train_vlm_lora.py --data <資料夾> --out <輸出> --steps 300
資料夾若沒有 train.jsonl 會先用 vlm_data.make_dataset 產生。"""
import os, sys, argparse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import vlm_data as V
import vlm_train_core as C


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=C.DEFAULT_MODEL_DIR)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=300)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--r", type=int, default=8)
    ap.add_argument("--alpha", type=int, default=16)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    if not os.path.exists(os.path.join(a.data, "train.jsonl")):
        print("產生資料：", V.make_dataset(a.data))
    res = C.train(a.model, a.data, a.out, steps=a.steps, accum=a.accum, lr=a.lr, r=a.r, alpha=a.alpha,
                  seed=a.seed, threads=a.threads or None)
    print(json.dumps({k: v for k, v in res.items() if k not in ("losses", "log")}, ensure_ascii=False, indent=1))


import json
if __name__ == "__main__":
    main()
