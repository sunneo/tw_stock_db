"""M1 的前處理（Python，與 Florence-2 處理器一致）：圖 → 768×768 雙三次插值 → 0~1 → ImageNet 正規化（CHW float32）；提示詞用 tokenizer.json 編碼（含 <s> … </s>）。
用法：python staged_vlm_prep.py <Florence-2 資料夾> <圖> <輸出資料夾> [提示詞]
輸出：input.json（input_ids、pixel 檔名與形狀）與 pixel.f32（原始 float32）。"""
import sys, os, json
import numpy as np
from PIL import Image
from tokenizers import Tokenizer

CAPTION_PROMPT = "What does the image describe?"  # Florence-2 的 <CAPTION> 任務提示詞（preprocessor_config.json）


def main():
    model_dir, img_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    prompt = sys.argv[4] if len(sys.argv) > 4 else CAPTION_PROMPT
    os.makedirs(out_dir, exist_ok=True)
    img = Image.open(img_path).convert("RGB").resize((768, 768), Image.BICUBIC)
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[None].astype(np.float32))
    x.tofile(os.path.join(out_dir, "pixel.f32"))
    tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
    ids = tok.encode(prompt).ids
    json.dump({"input_ids": ids, "pixel": {"file": "pixel.f32", "dims": list(x.shape)}, "prompt": prompt,
               "image": os.path.basename(img_path), "max_new_tokens": 40}, open(os.path.join(out_dir, "input.json"), "w"), ensure_ascii=False)
    print(json.dumps({"ids": len(ids), "pixel_dims": list(x.shape)}))


if __name__ == "__main__":
    main()
