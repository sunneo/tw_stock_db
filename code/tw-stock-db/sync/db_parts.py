"""
把單一大檔案切成固定大小的 part 檔，並產生 manifest.json（含 sha256 供合併後驗證）。

用來避開 Git LFS：GitHub 對單一檔案有 100MB 硬限制，tw_stock.db 有 300MB+，
切成 64MB 一份的 part 檔後，每個 part 都遠低於 100MB，可以直接用一般 git
commit 推送，不需要 Git LFS，也就沒有 LFS 免費額度（每月 1GB 儲存/頻寬）的問題。
"""
import hashlib
import json
import os

PART_SIZE_BYTES = 64 * 1024 * 1024  # 64MB


def split_file(src_path: str, out_dir: str, base_name: str, month_label: str) -> dict:
    """把 src_path 切成 <out_dir>/<base_name>.partNNN，寫出 manifest.json 並回傳其內容。"""
    os.makedirs(out_dir, exist_ok=True)

    # 先清掉舊的 part 檔，避免這個月檔案變小、殘留上個月多出來的 part 沒被覆蓋掉
    for f in os.listdir(out_dir):
        if f.startswith(f"{base_name}.part"):
            os.remove(os.path.join(out_dir, f))

    sha256 = hashlib.sha256()
    total_size = 0
    part_names = []
    with open(src_path, "rb") as src:
        idx = 0
        while True:
            chunk = src.read(PART_SIZE_BYTES)
            if not chunk:
                break
            sha256.update(chunk)
            total_size += len(chunk)
            part_name = f"{base_name}.part{idx:03d}"
            with open(os.path.join(out_dir, part_name), "wb") as part_f:
                part_f.write(chunk)
            part_names.append(part_name)
            idx += 1

    manifest = {
        "original_filename": base_name,
        "original_size_bytes": total_size,
        "sha256": sha256.hexdigest(),
        "part_size_bytes": PART_SIZE_BYTES,
        "num_parts": len(part_names),
        "parts": part_names,
        "month_label": month_label,
    }
    manifest_path = os.path.join(out_dir, f"{base_name}.manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"切割完成：{len(part_names)} 個 part（每份 <= {PART_SIZE_BYTES // (1024*1024)}MB），"
          f"總大小 {total_size:,} bytes，sha256={manifest['sha256'][:12]}...")
    return manifest
