# -*- coding: utf-8 -*-
# 曼德博集合：互動縮放、疊代次數與調色盤可調、漸進式（先粗後細）渲染。
#
# 操作方式：
#   * 左鍵「點一下」以該點為中心放大 2 倍；右鍵點一下縮小 2 倍（也有「縮小」按鈕，因為某些環境右鍵會跳出選單）。
#   * 左鍵按住拖曳＝平移（拖曳時先移動現有畫面，放開後才重新計算）。
#   * 「疊代 −／+」把最大疊代次數減半或加倍（32 到 2048），放大越深越需要更多次；右側清單選調色盤；「重設」回到初始視野。
#   * 畫面上方文字顯示中心座標、縮放倍率與目前渲染的解析度層級。
#
# 用到的限制與繞法（需要 numpy，Pyodide 內建）：
#   * 畫布每幀 ≤ 200 道指令，大量像素只能用圖片：把結果編成 PNG 以 w.image(..., name="view") 註冊，之後同名再註冊就取代舊圖。
#   * 每張圖 ≤ 256 KB：用「索引色 PNG」（每像素 1 位元組＋256 色調色盤），480×320 約 100 KB 上下，比 RGB 小很多。
#   * 漸進式：每個畫面依序渲染 1/8、1/4、1/2、1/1 解析度；每個事件迴圈只算一層，所以使用者動作會馬上中斷舊的渲染重新開始。
#   * 平滑著色用 mu = n + 1 - log2(log|z|)，再映射到調色盤索引；集合內部固定為索引 0（黑）。
import math
import struct
import time
import zlib

import gui
import numpy as np

CW, CH = 480, 320
LEVELS = (8, 4, 2, 1)             # 每層的像素縮小倍數
ITERS = (32, 64, 128, 256, 512, 1024, 2048)
HOME = (-0.5, 0.0, 3.2)           # 中心實部、虛部、畫面寬度涵蓋的複數寬度
PALETTES = ["火焰", "海洋", "彩虹", "灰階"]
CLICK_SLOP = 4                    # 滑鼠移動不超過這麼多像素就算「點一下」


# ---------- 純函式 ----------
def pixel_to_complex(view, px, py, w=CW, h=CH):
    cx, cy, span = view
    scale = span / w
    return (cx + (px - w / 2.0) * scale, cy + (py - h / 2.0) * scale)


def zoom_view(view, px, py, factor):
    """以畫面上 (px, py) 的點為新中心，再把寬度除以 factor（factor 2 = 放大 2 倍）。"""
    re, im = pixel_to_complex(view, px, py)
    return (re, im, view[2] / factor)


def pan_view(view, dx, dy, w=CW):
    """畫面往右拖 dx 像素＝視野往左移 dx 像素對應的複數距離。"""
    scale = view[2] / w
    return (view[0] - dx * scale, view[1] - dy * scale, view[2])


def mandel_iter(c, max_iter):
    """向量化的 Mandelbrot 疊代；回傳平滑疊代數（浮點陣列），沒發散的點為 0。"""
    z = np.zeros_like(c)
    mu = np.zeros(c.shape, np.float64)
    alive = np.ones(c.shape, bool)
    for n in range(max_iter):
        z[alive] = z[alive] ** 2 + c[alive]
        gone = alive & (z.real * z.real + z.imag * z.imag > 256.0)    # 半徑 16：讓平滑公式更準
        if gone.any():
            mag = np.log(np.abs(z[gone]))
            mu[gone] = n + 2 - np.log2(np.maximum(mag, 1e-9))
            alive &= ~gone
        if not alive.any():
            break
    return mu


def escape_count(re, im, max_iter):
    """單一點的整數疊代次數（測試用）：沒發散回傳 max_iter。"""
    z = complex(0, 0)
    c = complex(re, im)
    for n in range(max_iter):
        z = z * z + c
        if abs(z) > 2:
            return n
    return max_iter


def make_palette(name):
    """256 色；索引 0 保留給集合內部（黑色）。回傳 uint8 陣列 (256, 3)。"""
    t = np.linspace(0, 1, 255, endpoint=False)
    if name == "火焰":
        rgb = np.stack([np.clip(t * 3, 0, 1), np.clip(t * 3 - 1, 0, 1), np.clip(t * 3 - 2, 0, 1)], axis=1)
    elif name == "海洋":
        rgb = np.stack([0.1 + 0.4 * t ** 2, 0.25 + 0.7 * t, 0.5 + 0.5 * np.sin(t * math.pi)], axis=1)
    elif name == "彩虹":
        rgb = np.stack([0.5 + 0.5 * np.cos(2 * math.pi * (t + k / 3.0)) for k in (0, 1, 2)], axis=1)
    else:
        rgb = np.stack([t, t, t], axis=1)
    pal = np.zeros((256, 3), np.uint8)
    pal[1:] = (np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    return pal


def to_index(mu, cycle=24.0):
    """平滑疊代數 -> 調色盤索引 1..255；0 留給沒發散的點。調色盤每 cycle 次疊代循環一圈。"""
    idx = (1 + (mu * (255.0 / cycle)) % 255).astype(np.uint8)
    idx[mu == 0] = 0
    return idx


def encode_indexed_png(idx, palette):
    """idx：uint8 (高, 寬)；palette：(256, 3)。每列前加濾波類型 0，其餘只用 zlib 與 struct。"""
    h, w = idx.shape

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + idx[y].tobytes() for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0))
            + chunk(b"PLTE", palette.astype(np.uint8).tobytes()) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def render(view, max_iter, palette, step):
    """渲染一層：每 step 個像素取一個樣本，回傳 PNG 位元組（尺寸是 CW/step × CH/step，畫布會把它拉伸到整個畫面）。"""
    w, h = CW // step, CH // step
    cx, cy, span = view
    scale = span / CW
    xs = cx + ((np.arange(w) + 0.5) * step - CW / 2.0) * scale
    ys = cy + ((np.arange(h) + 0.5) * step - CH / 2.0) * scale
    c = xs[None, :] + 1j * ys[:, None]
    return encode_indexed_png(to_index(mandel_iter(c, max_iter)), palette)


# ---------- 程式本體 ----------
class App(object):
    def __init__(self):
        w = self.w = gui.Window("曼德博集合", width=700, height=520, resizable=True)
        bar = w.row(gap=4, role="toolbar")
        self.b_less = w.button("疊代 −", parent=bar)
        self.b_more = w.button("疊代 +", parent=bar)
        self.b_out = w.button("縮小", parent=bar)
        self.b_home = w.button("重設", parent=bar)
        self.pal_list = w.list(PALETTES, selected="火焰", rows=4, parent=bar)
        self.cv = w.canvas(CW, CH, fit=True, grow=1)
        self.status = w.label("")
        self.view = HOME
        self.iter_i = 2
        self.palette_name = "火焰"
        self.level = len(LEVELS)      # 目前已完成到第幾層；等於 len(LEVELS) 表示全部完成
        self.shift = (0.0, 0.0)       # 拖曳中暫時位移（像素）
        self.drag = None
        self.last_png = 0
        self.dirty_text = True

    def restart(self):
        self.level = 0
        self.dirty_text = True

    def render_next(self):
        """每次只算一層，算完立刻註冊同名圖片，所以畫面會由粗變細。"""
        if self.level >= len(LEVELS) or self.drag:
            return
        step = LEVELS[self.level]
        png = render(self.view, ITERS[self.iter_i], make_palette(self.palette_name), step)
        self.last_png = len(png)
        self.w.image(self.cv, png, "image/png", name="view")
        self.level += 1
        self.shift = (0.0, 0.0)
        self.dirty_text = True

    def on_mouse(self, v):
        x, y, kind, button = v["x"], v["y"], v["kind"], v.get("button", 0)
        if kind == "down":
            self.drag = (x, y, button)
        elif kind == "move" and self.drag and self.drag[2] == 0:
            self.shift = (x - self.drag[0], y - self.drag[1])
        elif kind == "up" and self.drag:
            x0, y0, b = self.drag
            self.drag = None
            if abs(x - x0) <= CLICK_SLOP and abs(y - y0) <= CLICK_SLOP:
                self.view = zoom_view(self.view, x0, y0, 2.0 if b == 0 else 0.5)
            elif b == 0:
                self.view = pan_view(self.view, x - x0, y - y0)
            else:
                self.shift = (0.0, 0.0)
                return
            self.restart()

    def handle(self, ev):
        kind, node, v = ev.get("event"), ev.get("node"), ev.get("value")
        if kind == "mouse":
            self.on_mouse(v)
        elif kind == "click":
            if node == self.b_more:
                self.iter_i = min(len(ITERS) - 1, self.iter_i + 1)
            elif node == self.b_less:
                self.iter_i = max(0, self.iter_i - 1)
            elif node == self.b_out:
                self.view = zoom_view(self.view, CW / 2.0, CH / 2.0, 0.5)
            elif node == self.b_home:
                self.view = HOME
            else:
                return
            self.restart()
        elif kind == "select" and node == self.pal_list and v in PALETTES:
            self.palette_name = v
            self.restart()

    def draw(self):
        sx, sy = self.shift
        ops = [["clear", "#000000"]]
        if self.level > 0:
            ops.append(["image", "view", int(sx), int(sy), CW, CH])
        self.w.draw(self.cv, ops)
        if self.dirty_text:
            done = "完成" if self.level >= len(LEVELS) else "渲染中 1/%d" % LEVELS[min(self.level, len(LEVELS) - 1)]
            self.w.set(self.status, text="中心 %.10g %+.10gi　寬度 %.3g（放大 %.3g 倍）　最大疊代 %d　%s　PNG %d 位元組" % (
                self.view[0], self.view[1], self.view[2], HOME[2] / self.view[2], ITERS[self.iter_i], done, self.last_png))
            self.dirty_text = False

    def run(self):
        self.restart()
        while True:
            ev = self.w.poll()
            if ev is not None:
                if ev.get("event") == "close":
                    break
                self.handle(ev)
                continue                 # 先把排隊的事件處理完，再繼續渲染
            self.render_next()
            self.draw()
            time.sleep(0.02)
        self.w.close()


if __name__ == "__main__":
    App().run()
