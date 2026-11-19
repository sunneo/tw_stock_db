# -*- coding: utf-8 -*-
"""IndexedDB 當 swap：處理比記憶體預算還大的陣列（out-of-core）。
用法：python swap_stream.py [--mb 128] [--hot-mb 8] [--device cpu|gpu]
陣列 --mb MB 大，Python 這邊只留 --hot-mb MB 的熱區，其餘頁經橋接放進 IndexedDB。做三件事：寫入、逐塊 y = 2x+1、逐塊求和，並用種子重算比對（結果要一模一樣）。
--device gpu：每一塊交給 GPU 相容層（numba→WGSL）算，沒有 WebGPU 就自動退回 CPU。"""
import argparse, sys, time
import numpy as np
import fa_swap

ap = argparse.ArgumentParser()
ap.add_argument('--mb', type=float, default=128); ap.add_argument('--hot-mb', type=float, default=8)
ap.add_argument('--device', default='cpu', choices=['cpu', 'gpu'])
a = ap.parse_args()

kernel = None
if a.device == 'gpu':
    try:
        from numba import cuda
        @cuda.jit
        def _affine(x, y, n):
            i = cuda.grid(1)
            if i < n:
                y[i] = x[i] * 2.0 + 1.0
        def kernel(blk):
            x = np.ascontiguousarray(blk.ravel()); y = np.zeros_like(x)
            _affine[(x.size + 127) // 128, 128](x, y, x.size)
            return y.reshape(blk.shape)
    except Exception as e:
        print('GPU 不可用（%s），改用 CPU' % e); kernel = None

COLS = 256
rows = int(a.mb * 1048576 / (COLS * 4))
fa_swap.set_hot_mb(a.hot_mb)
arr = fa_swap.array((rows, COLS), 'float32')
print('陣列 %s，%.0f MB；熱區 %.1f MB；後端 %s' % (arr.shape, arr.nbytes / 1048576, a.hot_mb, fa_swap.stats()['backend']))

t = time.time(); rs = np.random.RandomState(7)
for s in range(0, rows, 1024):
    arr[s:s + 1024] = rs.rand(min(1024, rows - s), COLS).astype('float32')
print('寫入 %.2fs' % (time.time() - t))

t = time.time()
arr.apply(kernel if kernel else (lambda b: b * 2 + 1), 1024)
print('y=2x+1（%s）%.2fs' % ('GPU' if kernel else 'CPU', time.time() - t))

t = time.time(); total = 0.0
for _, b in arr.blocks(1024): total += float(b.sum(dtype=np.float64))
rs = np.random.RandomState(7); ref = 0.0
for s in range(0, rows, 1024):
    ref += float((rs.rand(min(1024, rows - s), COLS).astype('float32') * 2 + 1).sum(dtype=np.float64))
print('總和 %.3f（重算 %.3f）%s  %.2fs' % (total, ref, '一致' if abs(total - ref) < 1e-6 * abs(ref) else '不一致！', time.time() - t))
st = fa_swap.stats(); print('swap：熱頁 %d／共 %d 頁，讀 %d 次、寫 %d 次，熱區 %.1f MB' % (st['pages_hot'], st['pages_total'], st['reads'], st['writes'], st['hot_bytes'] / 1048576))
fa_swap.close()
sys.exit(0 if abs(total - ref) < 1e-6 * abs(ref) else 1)
