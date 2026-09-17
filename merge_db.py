"""
把 tw_stock.db.partNNN 切割檔合併回完整的 tw_stock.db，並用 manifest.json 內的
sha256 驗證合併結果是否正確（避免下載時某個 part 檔案沒抓完整卻沒發現）。

這份腳本會跟著 tw_stock.db.part000 等檔案一起放在 db-snapshot 分支裡，
不依賴這個專案的其他程式碼，單獨下載也能直接執行（只用 Python 標準函式庫）。

用法（在跟 part 檔案同一個資料夾內執行）：
    python merge_db.py
    python merge_db.py --manifest tw_stock.db.manifest.json --out tw_stock.db
"""
import argparse
import hashlib
import json
import os


def merge(manifest_path: str, out_path: str = None):
    base_dir = os.path.dirname(os.path.abspath(manifest_path))
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    out_path = out_path or manifest["original_filename"]
    sha256 = hashlib.sha256()
    with open(out_path, "wb") as out_f:
        for part_name in manifest["parts"]:
            part_path = os.path.join(base_dir, part_name)
            if not os.path.exists(part_path):
                raise FileNotFoundError(
                    f"缺少 part 檔案：{part_name}，請確認全部 part 都下載完整"
                )
            with open(part_path, "rb") as part_f:
                while True:
                    chunk = part_f.read(1024 * 1024)
                    if not chunk:
                        break
                    out_f.write(chunk)
                    sha256.update(chunk)

    if sha256.hexdigest() != manifest["sha256"]:
        os.remove(out_path)
        raise RuntimeError(
            "合併後的檔案 checksum 與 manifest 不符，檔案可能不完整或損毀，"
            "請重新下載所有 part 檔案後再試一次。"
        )

    print(f"合併完成：{out_path}（{manifest['original_size_bytes']:,} bytes），checksum 驗證通過。")


def main():
    parser = argparse.ArgumentParser(description="合併 tw_stock.db 的 part 切割檔")
    parser.add_argument("--manifest", default="tw_stock.db.manifest.json",
                         help="manifest.json 路徑（預設同目錄下的 tw_stock.db.manifest.json）")
    parser.add_argument("--out", default=None, help="輸出檔名（預設 tw_stock.db）")
    args = parser.parse_args()
    merge(args.manifest, args.out)


if __name__ == "__main__":
    main()
