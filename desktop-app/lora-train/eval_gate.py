"""評量把關（純函式，不載入模型，給 eval_run.py 與 test_eval_gate.py 共用）。

組級統計：每組 n／base／tuned；另外記負例（標準答案 JSON 的 ok=false）與正例（ok=true）的通過數。
判定（ship gate）：
  - 輸給基底（tuned < base）→ regress（任何組都算）；
  - 目標組（預設：n>=5、base<50%、非 pos/）必須「清楚贏」：贏 ≥ win_margin 且 ≥2 列；
  - 退化答案：目標組有負例，而模型對負例全錯（neg.tuned == 0）→ 不算贏，列入 degenerate；只靠正例得分的「贏」是假的；
  - 無資料：目標組 base 與 tuned 都是 0 → 不算通過，列入 no_data（如實標示，不當作失敗也不當作通過）；
  - 其餘未贏 → not_winning。
verdict.ship 只有在沒有 regress、沒有 not_winning、沒有 degenerate、沒有 no_data 時為 True。
"""
import json

def polarity_of(gold):
    """標準答案是 JSON 物件且有布林 ok 欄位：ok=false → 'neg'，ok=true → 'pos'；其他題型回 None（不判極性）。"""
    try:
        g = json.loads(gold) if isinstance(gold, str) else gold
    except Exception:
        return None
    if isinstance(g, dict) and isinstance(g.get('ok'), bool):
        return 'neg' if g['ok'] is False else 'pos'
    return None

def _blank():
    return {'n': 0, 'base': 0, 'tuned': 0}

def aggregate(items, win_margin=0.10, targets=None):
    """items: [{'groups': [組名…], 'gold': 標準答案字串, 'base_ok': bool, 'tuned_ok': bool}, …]。
    targets：None＝預設規則；否則是組名子字串清單（與 eval_run.py 的 --targets 相同）。"""
    st = {}
    for it in items:
        pol = polarity_of(it.get('gold'))
        for name in it['groups']:
            s = st.setdefault(name, {'n': 0, 'base': 0, 'tuned': 0, 'neg': _blank(), 'pos': _blank()})
            s['n'] += 1; s['base'] += bool(it['base_ok']); s['tuned'] += bool(it['tuned_ok'])
            if pol:
                p = s[pol]; p['n'] += 1; p['base'] += bool(it['base_ok']); p['tuned'] += bool(it['tuned_ok'])
    groups, regress = {}, []
    for name in sorted(st):
        s = st[name]
        g = {'n': s['n'], 'base': s['base'], 'tuned': s['tuned']}
        if s['neg']['n'] or s['pos']['n']:
            g['neg'] = dict(s['neg']); g['pos'] = dict(s['pos'])
        groups[name] = g
        if s['tuned'] < s['base']:
            regress.append(name)
    if targets:
        tlist = [k for k in st if any(w in k for w in targets)]
    else:
        tlist = [k for k in st if st[k]['n'] >= 5 and st[k]['base'] / st[k]['n'] < 0.5 and not k.startswith('pos/')]
    not_winning, no_data, degenerate = [], [], []
    for k in tlist:
        s = st[k]
        if s['neg']['n'] > 0 and s['neg']['tuned'] == 0:
            degenerate.append(k); continue
        if s['base'] == 0 and s['tuned'] == 0:
            no_data.append(k); continue
        if not (s['tuned'] - s['base'] >= 2 and (s['tuned'] - s['base']) / s['n'] >= win_margin):
            not_winning.append(k)
    ship = not regress and bool(tlist) and not not_winning and not degenerate and not no_data
    return {'groups': groups, 'regress': regress, 'targets': tlist, 'not_winning': not_winning,
            'no_data': no_data, 'degenerate': degenerate, 'ship': ship}
