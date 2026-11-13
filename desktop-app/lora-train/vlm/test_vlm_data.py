"""vlm_data.py 的單檔測試（不需要 torch）。執行：python lora-train/vlm/test_vlm_data.py"""
import os, sys, tempfile, json, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vlm_data as V

fails = []
def check(name, cond, info=""):
    if cond:
        print("ok  ", name)
    else:
        fails.append(name); print("FAIL", name, info)

# 1. 校驗
good = {"id": "x", "split": "train", "image": "images/1.png",
        "messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]}
check("合格列沒有錯誤", V.validate_row(good) == [], V.validate_row(good))
check("缺欄位會報錯", any("缺欄位" in e for e in V.validate_row({"id": "x"})))
bad_split = dict(good, split="test")
check("split 不合法會報錯", any("split" in e for e in V.validate_row(bad_split)))
swapped = dict(good, messages=list(reversed(good["messages"])))
check("role 順序錯會報錯", any("role" in e for e in V.validate_row(swapped)))
check("絕對路徑會報錯", any("相對" in e for e in V.validate_row(dict(good, image="/etc/x.png"))))
check("上層路徑會報錯", any("相對" in e for e in V.validate_row(dict(good, image="../x.png"))))
empty = dict(good, messages=[{"role": "user", "content": "q"}, {"role": "assistant", "content": "  "}])
check("空答案會報錯", any("非空" in e for e in V.validate_row(empty)))

# 2. 標籤遮罩
ids = [10, 11, 12, 13, 14]
lab = V.mask_labels(ids, 3)
check("遮罩：提示部分為 -100，答案保留", lab == [-100, -100, -100, 13, 14], lab)
check("遮罩：prompt_len=0 全保留", V.mask_labels(ids, 0) == ids)
try:
    V.mask_labels(ids, 9); check("遮罩超界會丟錯", False)
except ValueError:
    check("遮罩超界會丟錯", True)

# 3. 評量打分
check("描述同時含顏色與形狀才算對", V.score_caption("A red circle on a white background.", {"color": "red", "shape": "circle"}) == (True, True))
check("只說顏色不算形狀", V.score_caption("A red blob.", {"color": "red", "shape": "circle"}) == (True, False))
check("整詞比對：circles 不算 circle", V.score_caption("Many circles.", {"color": "red", "shape": "circle"}) == (False, False))

# 4. 組合與留出
combos = V.all_combos()
check("18 組合", len(combos) == 18)
check("留出組合都在組合清單內", V.HELD_OUT_COMBOS <= set(combos))

# 5. 產生資料：切分不重疊、同 seed 位元組相同、列全部合格
with tempfile.TemporaryDirectory() as td:
    d1 = os.path.join(td, "a"); d2 = os.path.join(td, "b")
    c1 = V.make_dataset(d1, train_per_combo=2, eval_per_combo=1)
    V.make_dataset(d2, train_per_combo=2, eval_per_combo=1)
    tr = V.read_rows(os.path.join(d1, "train.jsonl")); ev = V.read_rows(os.path.join(d1, "eval.jsonl"))
    check("訓練列數 = 14 組×2 張×3 種提示（描述＋顏色＋形狀）", len(tr) == 14 * 2 * 3, len(tr))
    check("評量列數 = 4 組×1 張×1 種提示（只有描述）", len(ev) == 4, len(ev))
    trc = {r["meta"]["combo"] for r in tr}; evc = {r["meta"]["combo"] for r in ev}
    check("訓練與評量組合不重疊", trc.isdisjoint(evc), trc & evc)
    check("評量組合就是留出組合", evc == V.HELD_OUT_COMBOS, evc)
    check("所有訓練列都合格", all(V.validate_row(r) == [] for r in tr + ev))
    check("圖片檔都存在", all(os.path.exists(os.path.join(d1, r["image"])) for r in tr + ev))
    h = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
    check("同 seed 的 jsonl 位元組相同", h(os.path.join(d1, "train.jsonl")) == h(os.path.join(d2, "train.jsonl")))
    check("同 seed 的圖片位元組相同", h(os.path.join(d1, "images/000001.png")) == h(os.path.join(d2, "images/000001.png")))
    check("產生的列數回報正確", c1 == {"train": len(tr), "eval": len(ev)}, c1)

print("\n結果：%d 項失敗" % len(fails))
sys.exit(1 if fails else 0)
