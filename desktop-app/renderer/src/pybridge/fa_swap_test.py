# -*- coding: utf-8 -*-
# fa_swap 對假橋接（用 dict 模擬 IndexedDB）的測試。Run: python3 renderer/src/pybridge/fa_swap_test.py
import base64, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fa_swap

bad = []
def check(n, c, x=None):
    if not c: bad.append(n + (' ' + repr(x)[:200] if x is not None else ''))

disk = {}; log = []; seq = [0]
def fake(op, a=None, timeout=0):
    log.append(op)
    if op == 'swap.put': seq[0] += 1; k = 'p%d' % seq[0]; disk[k] = base64.b64decode(a['b64']); return {'id': k, 'size': len(disk[k])}
    if op == 'swap.get': return {'b64': base64.b64encode(disk[a['id']]).decode()}
    if op == 'swap.drop': disk.pop(a['id'], None); return {'ok': True}
    if op == 'swap.close': disk.clear(); return {'ok': True}
    if op == 'swap.stats': return {'items': len(disk), 'hotBytes': 0, 'diskBytes': sum(map(len, disk.values())), 'limit': 0, 'pages': len(disk)}
    raise AssertionError(op)

sw = fa_swap.Swap(hot_bytes=64 * 1024, page_bytes=16 * 1024, call=fake)
check('後端是 indexeddb', sw.backend.name == 'indexeddb')
a = sw.array((1000, 64), 'float32')              # 256 KB，頁 16 KB（64 列）→ 16 頁，熱區 4 頁
check('分頁', a._rows_per_page == 64 and a._npages == 16, (a._rows_per_page, a._npages))
ref = np.random.RandomState(1).rand(1000, 64).astype('float32')
for s in range(0, 1000, 100): a[s:s + 100] = ref[s:s + 100]
check('熱區有上限', sw.stats()['hot_bytes'] <= 64 * 1024 + 16 * 1024, sw.stats())
check('有寫到後端', 'swap.put' in log and len(disk) > 0)
check('整個讀回一致', np.array_equal(a[:], ref))
check('讀有觸發 swap.get', 'swap.get' in log)
check('整數索引', np.array_equal(a[500], ref[500]) and np.array_equal(a[-1], ref[-1]))
check('step 切片', np.array_equal(a[10:900:37], ref[10:900:37]))
check('列號序列', np.array_equal(a[[999, 3, 500, 3]], ref[[999, 3, 500, 3]]))
check('多軸索引', np.array_equal(a[100:200, 5], ref[100:200, 5]) and a[7, 9] == ref[7, 9])
a[100:110, 0] = 42; ref[100:110, 0] = 42; check('多軸寫入', np.array_equal(a[:], ref))
a[3] = 7; ref[3] = 7; check('整列寫入／廣播', np.array_equal(a[3], ref[3]))
a.apply(lambda b: b * 2); check('apply 一塊一塊', np.allclose(a[:], ref * 2))
check('blocks 涵蓋全部', sum(len(b) for _, b in a.blocks(128)) == 1000)
z = sw.array((300, 8), 'int32'); check('沒寫過的頁是 0', int(z[:].sum()) == 0 and z.shape == (300, 8))
f = sw.array((50,), 'float64', fill=1.5); check('fill 初值＋一維', f[:].sum() == 75.0)
big_row = sw.array((4, 100000), 'uint8'); big_row[2] = 9; check('一列比一頁大：一列一頁', big_row._rows_per_page == 1 and big_row[2].min() == 9 and big_row[1].max() == 0)
try: a[1000]; check('越界要丟 IndexError', False)
except IndexError: pass
m = sw.from_array(ref); check('from_array', np.array_equal(m[:], ref))
n_before = len(disk); m.close(); check('close 陣列：後端的頁丟掉', len(disk) < n_before)
sw.set_hot_bytes(0); check('set_hot_bytes(0) 全寫出', sw.stats()['hot_bytes'] <= 16 * 1024)
a.close(); sw.close(); check('close：後端清空', not disk)

# 沒有橋接：退回記憶體
m2 = fa_swap.Swap(hot_bytes=1024, page_bytes=1024, call=None, backend=fa_swap._Backend())
x = m2.array((100, 16), 'float64'); x[:] = np.arange(1600).reshape(100, 16); check('記憶體後端功能一樣', x[99, 15] == 1599 and m2.stats()['backend'] == 'memory')
# 預設（測試環境沒有橋接）
check('預設退回記憶體', fa_swap.default().backend.name == 'memory')
d = fa_swap.array((10, 10)); d[:] = 3; check('模組層函式', d[:].sum() == 300 and fa_swap.stats()['arrays'] == 1)
print('FAILED:\n  ' + '\n  '.join(bad) if bad else 'fa_swap: OK')
sys.exit(1 if bad else 0)
