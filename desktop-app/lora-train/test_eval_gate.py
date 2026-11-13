"""評量把關的測試（純 Python，不載入模型）：python3 lora-train/test_eval_gate.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eval_gate as G

ok, bad = 0, 0
def check(name, cond, extra=None):
    global ok, bad
    if cond: ok += 1
    else:
        bad += 1; print("FAIL", name, extra if extra is not None else "")

GOLD_NEG = '{"ok":false,"missing":"B"}'
GOLD_POS = '{"ok":true,"missing":""}'
check('極性：ok=false 為負例', G.polarity_of(GOLD_NEG) == 'neg')
check('極性：ok=true 為正例', G.polarity_of(GOLD_POS) == 'pos')
check('極性：沒有 ok 欄位不判', G.polarity_of('{"functions":[]}') is None and G.polarity_of('A') is None)
check('極性：ok 不是布林不判', G.polarity_of('{"ok":"yes"}') is None)

def items(group, n_neg, n_pos, base_ok, tuned_neg_ok, tuned_pos_ok, group_name_extra=()):
    out = []
    for i in range(n_neg):
        out.append({'groups': [group] + list(group_name_extra), 'gold': GOLD_NEG, 'base_ok': base_ok, 'tuned_ok': i < tuned_neg_ok})
    for i in range(n_pos):
        out.append({'groups': [group] + list(group_name_extra), 'gold': GOLD_POS, 'base_ok': base_ok, 'tuned_ok': i < tuned_pos_ok})
    return out

# 1) 退化答案：負例全錯、正例全對 → 有「贏」的表象，但必須算退化、不算通過
a = G.aggregate(items('think_stack/self_validate', 39, 21, False, 0, 21))
check('退化：標成 degenerate', a['degenerate'] == ['think_stack/self_validate'], a)
check('退化：ship 為 False', a['ship'] is False)
check('退化：組統計保留負例與正例計數', a['groups']['think_stack/self_validate']['neg'] == {'n': 39, 'base': 0, 'tuned': 0} and a['groups']['think_stack/self_validate']['pos']['tuned'] == 21, a['groups'])

# 2) 負例有答對（不是全錯）→ 不算退化，正常判定為贏
a2 = G.aggregate(items('think_stack/self_validate', 39, 21, False, 3, 21))
check('負例有對：不算退化', a2['degenerate'] == [] and a2['not_winning'] == [] and a2['ship'] is True, a2)

# 3) 無資料：目標組 0 對 0 → 不算通過（no_data），不當作失敗也不當作通過
nd = [{'groups': ['think_stack/plan_check'], 'gold': 'x', 'base_ok': False, 'tuned_ok': False} for _ in range(60)]
a3 = G.aggregate(nd + items('fn_template/code_split', 0, 60, False, 0, 23))
check('無資料：列入 no_data', a3['no_data'] == ['think_stack/plan_check'], a3)
check('無資料：ship 為 False', a3['ship'] is False)

# 4) 輸給基底：任何組 tuned < base → regress，ship 為 False
r = [{'groups': ['g1'], 'gold': 'x', 'base_ok': True, 'tuned_ok': False} for _ in range(10)]
a4 = G.aggregate(r)
check('輸基底：regress 含 g1', a4['regress'] == ['g1'] and a4['ship'] is False, a4)

# 5) 沒贏夠（+1 列、低於 10%）→ not_winning
w = [{'groups': ['fn_template/x'], 'gold': 'x', 'base_ok': False, 'tuned_ok': i < 1} for i in range(30)]
a5 = G.aggregate(w)
check('未清楚贏：not_winning', a5['not_winning'] == ['fn_template/x'], a5)

# 6) 全部乾淨、目標組清楚贏 → ship
c = [{'groups': ['fn_template/y'], 'gold': 'x', 'base_ok': False, 'tuned_ok': i < 20} for i in range(30)]
a6 = G.aggregate(c)
check('乾淨且清楚贏：ship', a6['ship'] is True and a6['degenerate'] == [] and a6['no_data'] == [], a6)

# 7) 指定 targets 時只看指定組
a7 = G.aggregate(c, targets=['nope'])
check('targets 指定不存在：沒有目標 → 不 ship', a7['targets'] == [] and a7['ship'] is False)

print(f"{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
