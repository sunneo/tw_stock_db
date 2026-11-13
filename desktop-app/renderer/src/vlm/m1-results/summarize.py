import json, glob, statistics as st, os
rows = []
imgs = sorted(set(os.path.basename(os.path.dirname(p)) for p in glob.glob('img_*/resident_*.json')))
allsame = True; res_hwm = []; st_hwm = []; res_load = []; st_load = []; st_switch = {}
for im in imgs:
    for rep in (1, 2):
        r = json.load(open(f'{im}/resident_{rep}.json')); s = json.load(open(f'{im}/staged_{rep}.json'))
        same = r['tokens'] == s['tokens']; allsame &= same
        res_hwm.append(r['mem']['after']['VmHWM']); st_hwm.append(s['mem']['after']['VmHWM'])
        res_load.append(r['loadMs']); st_load.append(s['loadMs'])
        for x in s['switchMs']:
            st_switch.setdefault((x['stage'], x['phase']), []).append(x['ms'])
        rows.append((im, rep, len(r['tokens']), same, r['totalMs'], s['totalMs'], r['mem']['after']['VmHWM'], s['mem']['after']['VmHWM'], r['mem']['before']['VmHWM']))
for row in rows: print('img %s rep %d tokens=%d same=%s total resident=%dms staged=%dms  HWM resident=%dMB staged=%dMB  (before=%dMB)' % row)
print('ALL TOKENS SAME:', allsame)
print('VmHWM median resident=%.0f MB staged=%.0f MB; reduction=%.1f%%' % (st.median(res_hwm), st.median(st_hwm), 100 * (1 - st.median(st_hwm) / st.median(res_hwm))))
print('loadMs median resident=%.0f staged=%.0f' % (st.median(res_load), st.median(st_load)))
for k, v in sorted(st_switch.items()): print('switch', k, 'median ms=%.0f min=%.0f max=%.0f n=%d' % (st.median(v), min(v), max(v), len(v)))
