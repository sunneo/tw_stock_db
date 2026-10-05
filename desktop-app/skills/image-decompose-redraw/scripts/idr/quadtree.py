# -*- coding: utf-8 -*-
"""第 1 步：由上而下的方差分割（variance quadtree）。

做法：整張圖是一個格子；格子裡的顏色變化（方差）大於門檻就切成四塊，一直切到夠均勻、夠小、或用完格子預算。
方差用「積分圖」（summed-area table）算，每個格子 O(1)，所以整個分割是 O(格子數)，跟影像大小無關。

數學：對一個含 n 個像素的格子，Lab 三通道的總方差（協方差矩陣的跡）
    Var = (1/n) Σ‖c_p‖² − ‖(1/n) Σ c_p‖²
Σc_p 與 Σ‖c_p‖² 都能從兩張積分圖 S（三通道和）、Q（平方和）用四個角查出來：
    Σ = S[y1,x1] − S[y0,x1] − S[y1,x0] + S[y0,x0]

「最需要切的先切」：用優先佇列，排序鍵是 SSE = Var × 面積（切了之後最能降低的誤差）。這樣有限的格子預算會花在
細節多的地方（邊緣、紋理），平坦的大片區域只用很少的格子。
"""
import heapq

import numpy as np


class Leaf(object):
    """四叉樹的葉子：像素矩形 [x0,x1)×[y0,y1)。"""
    __slots__ = ("x0", "y0", "x1", "y1", "mean_lab", "var", "depth")

    def __init__(self, x0, y0, x1, y1, mean_lab, var, depth):
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1
        self.mean_lab, self.var, self.depth = mean_lab, var, depth

    @property
    def area(self):
        return (self.x1 - self.x0) * (self.y1 - self.y0)


def build_quadtree(lab, var_thresh=20.0, min_size=4, max_leaves=4000, max_depth=12, refine=None):
    """lab：(H,W,3)。回傳 Leaf 清單（互不重疊、剛好鋪滿整張圖）。
    refine：[(x0,y0,x1,y1,leaf_size)]——這些範圍內不管變化大不大都切到 leaf_size 以下（給需要密集頂點的區域，例如偵測到的臉；不受 max_leaves 限制）。"""
    H, W, _ = lab.shape
    S = np.zeros((H + 1, W + 1, 3))
    S[1:, 1:] = lab.cumsum(0).cumsum(1)
    Q = np.zeros((H + 1, W + 1))
    Q[1:, 1:] = (lab ** 2).sum(2).cumsum(0).cumsum(1)

    def stats(x0, y0, x1, y1):
        n = (x1 - x0) * (y1 - y0)
        s = S[y1, x1] - S[y0, x1] - S[y1, x0] + S[y0, x0]
        q = Q[y1, x1] - Q[y0, x1] - Q[y1, x0] + Q[y0, x0]
        mean = s / n
        return mean, max(float(q / n - (mean ** 2).sum()), 0.0)

    leaves, heap, counter = [], [], [0]

    def can_split(x0, y0, x1, y1):
        return (x1 - x0) >= 2 * min_size or (y1 - y0) >= 2 * min_size

    ref = list(refine or [])

    def forced(x0, y0, x1, y1):
        for (a, b, c, d, s) in ref:
            if x0 < c and x1 > a and y0 < d and y1 > b and max(x1 - x0, y1 - y0) > s and can_split(x0, y0, x1, y1):
                return True
        return False

    def add(x0, y0, x1, y1, depth):
        mean, var = stats(x0, y0, x1, y1)
        if forced(x0, y0, x1, y1):
            counter[0] += 1
            heapq.heappush(heap, (-1e18, counter[0], (x0, y0, x1, y1, depth)))  # 強制細分的格子優先處理，而且不受 max_leaves 限制
        elif var > var_thresh and depth < max_depth and can_split(x0, y0, x1, y1):
            counter[0] += 1
            heapq.heappush(heap, (-var * (x1 - x0) * (y1 - y0), counter[0], (x0, y0, x1, y1, depth)))
        else:
            leaves.append(Leaf(x0, y0, x1, y1, mean, var, depth))

    add(0, 0, W, H, 0)
    while heap and (heap[0][0] <= -1e17 or len(leaves) + len(heap) + 3 <= max_leaves):
        _, _, (x0, y0, x1, y1, d) = heapq.heappop(heap)
        xs = [x0, (x0 + x1) // 2, x1] if (x1 - x0) >= 2 * min_size else [x0, x1]
        ys = [y0, (y0 + y1) // 2, y1] if (y1 - y0) >= 2 * min_size else [y0, y1]
        for j in range(len(ys) - 1):
            for i in range(len(xs) - 1):
                add(xs[i], ys[j], xs[i + 1], ys[j + 1], d + 1)
    while heap:  # 預算用完：剩下的格子就是葉子
        _, _, (x0, y0, x1, y1, d) = heapq.heappop(heap)
        mean, var = stats(x0, y0, x1, y1)
        leaves.append(Leaf(x0, y0, x1, y1, mean, var, d))
    return leaves
