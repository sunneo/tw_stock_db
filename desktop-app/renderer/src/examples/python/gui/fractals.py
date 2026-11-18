# -*- coding: utf-8 -*-
# 碎形集：Julia 集、Sierpinski 三角、Koch 雪花、碎形樹、龍形曲線、Newton 碎形，每種有兩個可調參數。
#
# 操作方式：左側清單選碎形；「參數 A／B」各有 − ＋ 按鈕調整（名稱與目前值顯示在按鈕旁的文字，隨碎形而變）。
#
# 用到的限制與繞法（需要 numpy，Pyodide 內建）：
#   * 畫布每幀 ≤ 200 道指令，所以分成兩類：
#     - 「線段型」（Koch、樹、龍形）直接送 line 指令，並依線段數限制最大層數（Koch 雪花最多 3 層、樹與龍形最多 7 層（參數範圍已照此設定，max_depth 是第二道保險）），
#       這個上限由 max_depth() 算出，保證不超過 198 條線。
#     - 「像素型」（Julia、Sierpinski、Newton）用 numpy 算成索引色 PNG（1 位元組／像素＋調色盤，通常 < 100 KB，遠低於 256 KB），
#       用 w.image(..., name="view") 註冊，再畫成一道 image 指令。
#   * 參數一變才重新計算；平常的迴圈只重畫同一幀，所以不佔 CPU。
import math
import struct
import time
import zlib

import gui
import numpy as np

CW, CH = 480, 360
MAX_LINES = 198        # 一幀 200 道：扣掉 clear 與標題文字


# ---------- 索引色 PNG ----------
def encode_indexed_png(idx, palette):
    h, w = idx.shape

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + idx[y].tobytes() for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0))
            + chunk(b"PLTE", np.asarray(palette, np.uint8).tobytes()) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def gradient_palette(kind):
    """256 色；索引 0 固定黑色（Julia 集內部）。"""
    t = np.linspace(0, 1, 256)
    sets = {0: (t, t ** 2, 1 - t), 1: (t ** 0.5, t, t ** 3), 2: (0.5 + 0.5 * np.cos(6.28 * t), 0.5 + 0.5 * np.cos(6.28 * (t + 0.33)), 0.5 + 0.5 * np.cos(6.28 * (t + 0.67))),
            3: (t, t, t)}
    pal = (np.clip(np.stack(sets[kind % 4], axis=1), 0, 1) * 255).astype(np.uint8)
    pal[0] = 0
    return pal


# ---------- 像素型碎形（純函式，回傳 uint8 索引陣列與調色盤） ----------
def julia_indices(c, max_iter, w=CW, h=CH, span=3.2):
    """Julia 集 z -> z^2 + c。回傳索引：0 是集合內部，其餘由平滑疊代數決定。"""
    x = (np.arange(w) - w / 2.0) * (span / w)
    y = (np.arange(h) - h / 2.0) * (span / w)
    z = x[None, :] + 1j * y[:, None]
    mu = np.zeros(z.shape)
    alive = np.ones(z.shape, bool)
    for n in range(max_iter):
        z[alive] = z[alive] ** 2 + c
        gone = alive & (np.abs(z) > 16)
        mu[gone] = n + 2 - np.log2(np.log(np.abs(z[gone])))
        alive &= ~gone
        if not alive.any():
            break
    idx = (1 + (mu * 12) % 255).astype(np.uint8)
    idx[alive] = 0
    return idx


def julia_c(angle_deg, radius=0.7885):
    """沿著半徑 0.7885 的圓取 c，這個圓上的 c 都能生出有趣的 Julia 集。"""
    a = math.radians(angle_deg)
    return complex(radius * math.cos(a), radius * math.sin(a))


def sierpinski_indices(depth, w=CW, h=CH):
    """用巴斯卡三角形：第 r 列第 k 格是奇數（k & (r-k) == 0）就塗色。深度 d 時有 2^d 列。"""
    n = 2 ** depth
    side = min(w - 20, (h - 20) * 2 / math.sqrt(3))          # 等邊三角形的邊長（像素）
    cell = side / n
    tri_h = side * math.sqrt(3) / 2
    x0, y0 = (w - side) / 2.0, (h - tri_h) / 2.0 + 4
    py, px = np.mgrid[0:h, 0:w]
    r = np.floor((py - y0) / (tri_h / n)).astype(np.int64)
    k = np.floor((px - (w / 2.0)) / cell + r / 2.0 + 0.5).astype(np.int64)
    ok = (r >= 0) & (r < n) & (k >= 0) & (k <= r)
    rr, kk = np.where(ok, r, 0), np.where(ok, k, 0)
    hit = ok & ((kk & (rr - kk)) == 0)
    idx = np.zeros((h, w), np.uint8)
    idx[hit] = 1 + (rr[hit] * 254 // max(1, n - 1)).astype(np.uint8)    # 由上到下漸層
    return idx


def newton_indices(n_roots, max_iter, w=CW, h=CH, span=3.2):
    """Newton 法解 z^n = 1：依收斂到第幾個根上色，收斂越慢越暗。每個根占 256 // n 個索引。"""
    x = (np.arange(w) - w / 2.0) * (span / w)
    y = (np.arange(h) - h / 2.0) * (span / w)
    z = x[None, :] + 1j * y[:, None]
    z[z == 0] = 1e-6
    roots = np.exp(2j * np.pi * np.arange(n_roots) / n_roots)
    steps = np.full(z.shape, max_iter, np.int32)
    done = np.zeros(z.shape, bool)
    for i in range(max_iter):
        z = np.where(done, z, z - (z ** n_roots - 1) / (n_roots * z ** (n_roots - 1)))
        near = (np.abs(z ** n_roots - 1) < 1e-6) & ~done
        steps[near] = i
        done |= near
        if done.all():
            break
    which = np.argmin(np.abs(z[..., None] - roots[None, None, :]), axis=2)
    band = 255 // n_roots
    shade = np.clip(steps * (band - 1) // max(1, max_iter // 2), 0, band - 1)
    idx = (1 + which * band + (band - 1 - shade)).astype(np.uint8)
    idx[~done] = 0
    return idx


def root_palette(n_roots):
    """每個根一個色相，band 內由亮到暗；索引 0 黑色。"""
    band = 255 // n_roots
    pal = np.zeros((256, 3), np.uint8)
    for r in range(n_roots):
        hue = r / float(n_roots)
        base = np.array([0.5 + 0.5 * math.cos(2 * math.pi * (hue + k / 3.0)) for k in (0, 1, 2)])
        for j in range(band):
            pal[1 + r * band + j] = (base * (0.35 + 0.65 * (j / max(1, band - 1)))) * 255
    return pal


# ---------- 線段型碎形（純函式，回傳線段 [(x1, y1, x2, y2, 深度)]，座標先落在 0..1 方框內再縮放） ----------
def koch_segments(depth, sides):
    """sides 3 = 雪花、4 = 方形島、1 = 單一曲線。每條邊遞迴把中間三分之一換成凸起的小三角。"""
    def edge(a, b, d):
        if d == 0:
            return [(a, b)]
        dx, dy = (b[0] - a[0]) / 3.0, (b[1] - a[1]) / 3.0
        p, q = (a[0] + dx, a[1] + dy), (a[0] + 2 * dx, a[1] + 2 * dy)
        tip = (p[0] + dx * 0.5 - dy * math.sqrt(3) / 2.0, p[1] + dy * 0.5 + dx * math.sqrt(3) / 2.0)
        return edge(a, p, d - 1) + edge(p, tip, d - 1) + edge(tip, q, d - 1) + edge(q, b, d - 1)

    if sides == 1:
        corners = [(-1.0, 0.0), (1.0, 0.0)]
    else:
        r = 1.0
        corners = [(r * math.sin(2 * math.pi * i / sides), -r * math.cos(2 * math.pi * i / sides)) for i in range(sides)]
        corners.reverse()                      # 逆時針走一圈，凸起的小三角才會朝外
    pairs = [(corners[i], corners[(i + 1) % len(corners)]) for i in range(len(corners) if sides > 1 else 1)]
    segs = [s for a, b in pairs for s in edge(a, b, depth)]
    return [(a[0], a[1], b[0], b[1], 0) for a, b in segs]


def tree_segments(depth, angle_deg, ratio=0.72):
    """二元樹：每根樹枝在末端分成左右兩根，長度乘 ratio、各偏 angle_deg 度。共 2^depth - 1 根。"""
    out = []

    def grow(x, y, ang, length, d, level):
        x2, y2 = x + length * math.sin(ang), y - length * math.cos(ang)
        out.append((x, y, x2, y2, level))
        if d > 1:
            for sign in (-1, 1):
                grow(x2, y2, ang + sign * math.radians(angle_deg), length * ratio, d - 1, level + 1)
    grow(0.0, 0.0, 0.0, 1.0, depth, 0)
    return out


def dragon_turns(order):
    """龍形曲線的轉向序列：下一階＝原序列 + 右轉 + 把原序列反過來再左右互換。長度 2^order - 1。"""
    seq = []
    for _ in range(order):
        seq = seq + [1] + [-t for t in reversed(seq)]
    return seq


def dragon_segments(order):
    pts, heading = [(0.0, 0.0), (1.0, 0.0)], (1.0, 0.0)
    for t in dragon_turns(order):
        heading = (-t * heading[1], t * heading[0])       # 轉 90 度（t = 1 右轉、-1 左轉）
        last = pts[-1]
        pts.append((last[0] + heading[0], last[1] + heading[1]))
    return [(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], i * 8 // max(1, len(pts))) for i in range(len(pts) - 1)]


def fit_segments(segs, w=CW, h=CH, margin=24, top=34):
    """把線段整體縮放、置中到畫布的可用區域（保持長寬比）。"""
    xs = [v for s in segs for v in (s[0], s[2])]
    ys = [v for s in segs for v in (s[1], s[3])]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    k = min((w - 2 * margin) / max(1e-9, x1 - x0), (h - top - margin) / max(1e-9, y1 - y0))
    ox, oy = (w - (x1 - x0) * k) / 2.0 - x0 * k, top + (h - top - margin - (y1 - y0) * k) / 2.0 - y0 * k
    return [(a * k + ox, b * k + oy, c * k + ox, d * k + oy, lv) for a, b, c, d, lv in segs]


# ---------- 碎形表：名稱 -> 兩個參數 (名稱, 最小, 最大, 步進, 預設) ----------
FRACTALS = {
    "Julia 集": (("c 的角度（度）", 0, 350, 10, 170), ("最大疊代", 30, 200, 30, 90)),
    "Sierpinski 三角": (("深度", 1, 8, 1, 6), ("調色盤", 0, 3, 1, 0)),
    "Koch 雪花": (("層數", 0, 3, 1, 3), ("邊數（1 曲線、3 雪花、4 方形島）", 1, 4, 1, 3)),
    "碎形樹": (("層數", 1, 7, 1, 7), ("分枝角度（度）", 10, 60, 5, 25)),
    "龍形曲線": (("階數", 1, 7, 1, 7), ("顏色漸層", 0, 1, 1, 0)),
    "Newton 碎形": (("次方 n（z^n = 1）", 3, 6, 1, 3), ("最大疊代", 10, 60, 10, 30)),
}
RASTER = ("Julia 集", "Sierpinski 三角", "Newton 碎形")


def max_depth(name, a, b):
    """線段型碎形的層數上限：保證線段數 ≤ MAX_LINES（畫布每幀只能 200 道指令）。"""
    if name == "Koch 雪花":
        sides = b
        return max(d for d in range(0, 5) if sides * 4 ** d <= MAX_LINES) if sides else 0
    return 7 if name in ("碎形樹", "龍形曲線") else a       # 2^7 = 128 條，2^8 = 256 條超過上限


def segments_for(name, a, b):
    d = min(a, max_depth(name, a, b))
    if name == "Koch 雪花":
        return koch_segments(d, b)
    if name == "碎形樹":
        return tree_segments(d, b)
    return dragon_segments(d)


def line_ops(segs, name, color_mode=0):
    """線段型碎形的繪圖指令；顏色隨深度變化。"""
    top = max([s[4] for s in segs] or [0]) or 1
    ops = []
    for a, b, c, d, lv in segs:
        t = lv / float(top)
        if name == "碎形樹":
            col = "#%02x%02x%02x" % (int(120 - 80 * t), int(70 + 170 * t), int(40 + 20 * t))
        elif name == "龍形曲線" and color_mode:
            col = "#%02x%02x%02x" % (int(255 * t), 120, int(255 * (1 - t)))
        else:
            col = "#7fd0ff" if name == "Koch 雪花" else "#ffcc66"
        ops.append(["line", int(a), int(b), int(c), int(d), col])
    return ops


# ---------- 程式本體 ----------
class App(object):
    def __init__(self):
        w = self.w = gui.Window("碎形集", width=760, height=560, resizable=True)
        body = w.row(grow=1, gap=8)
        side = w.column(parent=body, gap=4)
        w.label("碎形", parent=side)
        self.names = list(FRACTALS)
        self.pick = w.list(self.names, selected=self.names[0], rows=6, parent=side)
        self.rows = []                    # 每個參數：(說明 label, − 按鈕, + 按鈕)
        for _ in range(2):
            label = w.label("", parent=side)
            r = w.row(parent=side, gap=4)
            self.rows.append((label, w.button("−", parent=r), w.button("＋", parent=r)))
        self.info = w.label("", parent=side)
        self.cv = w.canvas(CW, CH, fit=True, grow=1, parent=body)
        self.name = self.names[0]
        self.vals = {n: [p[4] for p in FRACTALS[n]] for n in self.names}
        self.ops = []
        self.rebuild()

    def rebuild(self):
        """參數改變時才重新計算整張圖或整組線段。"""
        a, b = self.vals[self.name]
        specs = FRACTALS[self.name]
        for (label, minus, plus), spec, v in zip(self.rows, specs, (a, b)):
            self.w.set(label, text="%s：%s" % (spec[0], v))
        size = ""
        if self.name in RASTER:
            if self.name == "Julia 集":
                idx, pal = julia_indices(julia_c(a), b), gradient_palette(0)
            elif self.name == "Sierpinski 三角":
                idx, pal = sierpinski_indices(a), gradient_palette(b)
                pal[0] = (16, 16, 24)
            else:
                idx, pal = newton_indices(a, b), root_palette(a)
            png = encode_indexed_png(idx, pal)
            self.w.image(self.cv, png, "image/png", name="view")
            self.ops = [["image", "view", 0, 0, CW, CH]]
            size = "PNG %d 位元組" % len(png)
        else:
            depth = min(a, max_depth(self.name, a, b))
            segs = fit_segments(segments_for(self.name, a, b))
            self.ops = line_ops(segs, self.name, b if self.name == "龍形曲線" else 0)
            size = "%d 道線段指令" % len(self.ops) + ("（層數已限制為 %d）" % depth if depth < a else "")
        self.w.set(self.info, text=size)

    def bump(self, which, direction):
        spec = FRACTALS[self.name][which]
        vals = self.vals[self.name]
        vals[which] = max(spec[1], min(spec[2], vals[which] + direction * spec[3]))
        self.rebuild()

    def draw(self):
        head = ["text", 10, 8, "%s  %s" % (self.name, "  ".join(str(v) for v in self.vals[self.name])), "#e8e8f0"]
        self.w.draw(self.cv, [["clear", "#101018"]] + self.ops[:MAX_LINES] + [head])

    def run(self):
        while True:
            ev = self.w.poll()
            if ev is None:
                self.draw()
                time.sleep(0.05)
                continue
            kind, node = ev.get("event"), ev.get("node")
            if kind == "close":
                break
            if kind == "select" and node == self.pick and ev.get("value") in FRACTALS:
                self.name = ev["value"]
                self.rebuild()
            elif kind == "click":
                for i, (_, minus, plus) in enumerate(self.rows):
                    if node in (minus, plus):
                        self.bump(i, 1 if node == plus else -1)
        self.w.close()


if __name__ == "__main__":
    App().run()
