# -*- coding: utf-8 -*-
# 照片檢視器：可拖曳平移的視埠、縮放、適合視窗／100%、水平與垂直翻轉、旋轉 90 度、顯示尺寸與縮放比。
#
# 操作方式：
#   * 「開啟圖片」選 PNG／JPEG／GIF／WebP；沒選時顯示程式自己產生的範例圖（有一個不對稱的 F 字，方便看出翻轉與旋轉）。
#   * 左鍵按住拖曳＝平移；Ctrl+滾輪、按鈕「放大／縮小」、鍵盤 + 與 - 縮放（以滑鼠或視窗中心為準）。
#   * 「適合視窗」「100%」切換縮放；「水平翻轉」「垂直翻轉」「向右轉 90°」「向左轉 90°」變換圖片。
#   * 鍵盤：方向鍵平移、0＝適合視窗、1＝100%、h／v 翻轉、r 右轉、l 左轉（先點一下畫布取得鍵盤焦點）。
#
# 用到的限制與繞法（需要 numpy，Pyodide 內建；PIL 有的話會用來解碼 JPEG／GIF／WebP）：
#   * 畫布沒有旋轉指令，所以旋轉要自己改像素：PNG 用內建解碼器（支援 8 位元、非交錯、灰階／RGB／RGBA／調色盤）；
#     其他格式要有 PIL 才能旋轉，沒有的話旋轉按鈕只會提示，翻轉與縮放仍可用（翻轉用畫布 image 指令的 flip 參數，不改像素）。
#   * 圖片註冊沒有大小上限（大圖由 gui 函式庫自動分段傳送）：沒旋轉時直接送原檔位元組，原樣顯示、放大看到的是真正的像素；旋轉後才重新編成 PNG。
#   * 註冊同一個名字（name="view"）會取代舊圖，不佔 16 張的額度；只有旋轉或換圖時才重新註冊，平移縮放只改繪圖座標。
#   * 畫布每幀只送 ≤ 200 道指令；這裡每幀不到 10 道。
import os
import struct
import time
import zlib

import gui
import numpy as np

CW, CH = 640, 420          # 畫布的繪圖座標系大小（fit=True，會自動縮放到視窗大小）
MIN_ZOOM, MAX_ZOOM = 0.05, 32.0


# ---------- PNG 編碼／解碼（只用 zlib 與 struct） ----------
def _chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def encode_png(arr):
    """arr：numpy uint8 陣列，形狀 (高, 寬, 3)；回傳 PNG 位元組。"""
    h, w = arr.shape[:2]
    raw = b"".join(b"\x00" + arr[y].tobytes() for y in range(h))   # 每列前面加濾波類型 0
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(raw, 6)) + _chunk(b"IEND", b""))


def decode_png(data):
    """回傳 (高, 寬, 3) 的 uint8 陣列；不支援的格式丟 ValueError。"""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG")
    pos, idat, plte, w = 8, b"", None, 0
    while pos < len(data):
        n, tag = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if tag == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or interlace:
                raise ValueError("只支援 8 位元、非交錯 PNG")
        elif tag == b"PLTE":
            plte = np.frombuffer(body, np.uint8).reshape(-1, 3)
        elif tag == b"IDAT":
            idat += body
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    raw = np.frombuffer(zlib.decompress(idat), np.uint8).reshape(h, 1 + w * ch)
    out = np.zeros((h, w * ch), np.int32)
    for y in range(h):                       # 還原每列的濾波（None／Sub／Up／Average／Paeth）
        f, line = raw[y, 0], raw[y, 1:].astype(np.int32)
        up = out[y - 1] if y else np.zeros(w * ch, np.int32)
        if f == 0:
            out[y] = line
        elif f == 2:
            out[y] = (line + up) & 255
        else:                                # Sub／Average／Paeth 依賴左邊的像素，只能逐位元組
            cur = out[y]
            for i in range(w * ch):
                a = cur[i - ch] if i >= ch else 0
                c = up[i - ch] if i >= ch else 0
                if f == 1:
                    p = a
                elif f == 3:
                    p = (a + up[i]) // 2
                else:
                    pa, pb, pc = abs(up[i] - c), abs(a - c), abs(a + up[i] - 2 * c)
                    p = a if pa <= pb and pa <= pc else (up[i] if pb <= pc else c)
                cur[i] = (line[i] + p) & 255
    px = out.reshape(h, w, ch).astype(np.uint8)
    if ctype == 3:
        px = plte[px[:, :, 0]]
    elif ctype == 0:
        px = np.repeat(px, 3, axis=2)
    elif ctype == 4:
        px = np.repeat(px[:, :, :1], 3, axis=2)
    return np.ascontiguousarray(px[:, :, :3])


def decode_any(data, mime):
    """能解就回傳 (高, 寬, 3) 陣列；JPEG／GIF／WebP 要有 PIL，沒有就回傳 None。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        try:
            return decode_png(data)
        except (ValueError, KeyError, struct.error, zlib.error):
            pass
    try:
        from PIL import Image
        import io
        return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.uint8).copy()
    except Exception:
        return None


def sample_image(w=320, h=240):
    """程式產生的範例圖：漸層背景、四角色塊、一個不對稱的 F 字與圓。"""
    y, x = np.mgrid[0:h, 0:w]
    img = np.zeros((h, w, 3), np.uint8)
    img[..., 0] = 40 + 120 * x // w
    img[..., 1] = 60 + 140 * y // h
    img[..., 2] = 200 - 120 * x // w
    for (x0, y0, c) in ((0, 0, (230, 60, 60)), (w - 30, 0, (60, 200, 60)), (0, h - 30, (240, 220, 60)), (w - 30, h - 30, (250, 250, 250))):
        img[y0:y0 + 30, x0:x0 + 30] = c
    img[60:180, 100:124] = (255, 255, 255)       # F 的直線
    img[60:84, 100:190] = (255, 255, 255)        # 上橫
    img[108:130, 100:160] = (255, 255, 255)      # 中橫
    img[((x - 235) ** 2 + (y - 150) ** 2) < 35 ** 2] = (20, 20, 40)
    return img


# ---------- 視埠數學（純函式；view = (zoom, offx, offy)，offx／offy 是圖片左上角在畫布上的位置） ----------
def fit_zoom(iw, ih, vw=CW, vh=CH, margin=10):
    return min((vw - margin) / float(iw), (vh - margin) / float(ih))


def centered(iw, ih, zoom, vw=CW, vh=CH):
    return (zoom, (vw - iw * zoom) / 2.0, (vh - ih * zoom) / 2.0)


def zoom_at(view, factor, cx, cy):
    """以畫布上一點 (cx, cy) 為不動點縮放，那一點底下的圖片位置縮放前後相同。"""
    zoom, ox, oy = view
    nz = max(MIN_ZOOM, min(MAX_ZOOM, zoom * factor))
    k = nz / zoom
    return (nz, cx - (cx - ox) * k, cy - (cy - oy) * k)


def screen_to_image(view, sx, sy):
    zoom, ox, oy = view
    return ((sx - ox) / zoom, (sy - oy) / zoom)


def image_to_screen(view, ix, iy):
    zoom, ox, oy = view
    return (ix * zoom + ox, iy * zoom + oy)


def clamp_pan(view, iw, ih, vw=CW, vh=CH, keep=60):
    """平移時至少讓圖片留 keep 像素在視窗內，不會拖到完全看不到。"""
    zoom, ox, oy = view
    ox = max(keep - iw * zoom, min(vw - keep, ox))
    oy = max(keep - ih * zoom, min(vh - keep, oy))
    return (zoom, ox, oy)


# ---------- 程式本體 ----------
class Viewer(object):
    def __init__(self):
        w = self.w = gui.Window("照片檢視器", width=820, height=600, resizable=True)
        bar = w.row(gap=4, role="toolbar")
        self.b_open = w.filepick("開啟圖片", accept="image/png,image/jpeg,image/gif,image/webp", parent=bar)
        self.buttons = {}
        for text, name in (("放大", "in"), ("縮小", "out"), ("適合視窗", "fit"), ("100%", "100"), ("水平翻轉", "fx"),
                           ("垂直翻轉", "fy"), ("向右轉 90°", "cw"), ("向左轉 90°", "ccw")):
            self.buttons[w.button(text, parent=bar)] = name
        self.cv = w.canvas(CW, CH, fps=0, fit=True, grow=1)
        self.status = w.label("", role="statusbar")
        self.src = None          # 原圖 (高, 寬, 3)；None 表示解不開，只能直接顯示原始位元組
        self.raw = None
        self.mime = "image/png"
        self.rot = 0             # 0..3，順時針轉幾個 90 度
        self.flip = [0, 0]       # 畫面上的水平、垂直翻轉
        self.orig = None         # (原檔位元組, mime)：沒旋轉時直接送原檔
        self.name = "範例圖"
        self.view = (1.0, 0.0, 0.0)
        self.dragging = None
        self.mouse = (CW / 2.0, CH / 2.0)
        self.dirty = True
        self.message = ""
        self.set_image(sample_image(), "範例圖")

    # --- 圖片 ---
    def work_array(self):
        return np.rot90(self.src, -self.rot) if self.src is not None else None

    def size(self):
        """目前顯示的圖片尺寸（旋轉後）。縮小註冊時仍回報原圖尺寸。"""
        if self.src is None:
            return self.dims
        h, w = self.src.shape[:2]
        return (h, w) if self.rot % 2 else (w, h)

    def set_image(self, arr, name, orig=None):
        self.src, self.name, self.rot, self.flip, self.raw = arr, name, 0, [0, 0], None
        self.orig = orig
        self.message = ""
        self.dims = (arr.shape[1], arr.shape[0])
        self.register()
        self.view = centered(*self.size(), fit_zoom(*self.size()))

    def register(self):
        """把目前（旋轉後）的像素編成 PNG 註冊成 "view"；可能縮小，縮小時顯示座標仍用原尺寸。"""
        if self.src is not None:
            if self.rot == 0 and self.orig is not None:
                data, mime = self.orig
            else:
                mime, data = "image/png", encode_png(np.ascontiguousarray(self.work_array()))
        else:
            mime, data = self.mime, self.raw
        self.w.image(self.cv, data, mime, name="view")
        self.dirty = True

    def open_file(self, ev):
        try:
            got = self.w.pick_files(ev)
        except Exception as e:
            self.note("無法開啟：%s" % e)
            return
        if not got or not got[0]:
            return
        f = got[0][0]
        with open(f["ref"], "rb") as fh:
            data = fh.read()
        arr = decode_any(data, f["mime"])
        if arr is not None:
            self.set_image(arr, f["name"], (data, f["mime"] or "image/jpeg"))
            return
        self.src, self.raw, self.mime, self.name, self.rot, self.flip = None, data, f["mime"] or "image/jpeg", f["name"], 0, [0, 0]
        try:
            _, iw, ih = self.w.image(self.cv, data, self.mime, name="view")
        except Exception as e:
            self.note("圖片無法解碼：%s" % e)
            return
        self.dims = (iw, ih)
        self.view = centered(iw, ih, fit_zoom(iw, ih))
        self.note("此格式沒有 PIL，無法旋轉（翻轉與縮放可用）")

    # --- 動作 ---
    def note(self, text):
        self.message = text
        self.dirty = True

    def act(self, name):
        iw, ih = self.size()
        cx, cy = CW / 2.0, CH / 2.0
        if name in ("in", "out"):
            self.view = zoom_at(self.view, 1.25 if name == "in" else 0.8, cx, cy)
        elif name == "fit":
            self.view = centered(iw, ih, fit_zoom(iw, ih))
        elif name == "100":
            self.view = centered(iw, ih, 1.0)
        elif name == "fx":
            self.flip[0] ^= 1
        elif name == "fy":
            self.flip[1] ^= 1
        elif name in ("cw", "ccw"):
            if self.src is None:
                self.note("此格式無法旋轉（需要 PIL）")
                return
            self.rot = (self.rot + (1 if name == "cw" else -1)) % 4
            # 翻轉是「畫面上」的鏡射（顯示時才套用），所以旋轉後翻轉旗標不用調整
            self.register()
            niw, nih = self.size()
            self.view = centered(niw, nih, fit_zoom(niw, nih))
        self.dirty = True

    def on_mouse(self, v):
        x, y, kind = v["x"], v["y"], v["kind"]
        self.mouse = (x, y)
        if kind == "down" and v.get("button") == 0:
            self.dragging = (x, y, self.view)
        elif kind == "move" and self.dragging:
            x0, y0, v0 = self.dragging
            self.view = clamp_pan((v0[0], v0[1] + x - x0, v0[2] + y - y0), *self.size())
            self.dirty = True
        elif kind == "up":
            self.dragging = None

    def on_key(self, key):
        step = 30
        table = {"+": "in", "=": "in", "-": "out", "_": "out", "0": "fit", "1": "100", "h": "fx", "v": "fy", "r": "cw", "l": "ccw"}
        if key in table:
            self.act(table[key])
        elif key in ("ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"):
            dx = {"ArrowLeft": step, "ArrowRight": -step}.get(key, 0)
            dy = {"ArrowUp": step, "ArrowDown": -step}.get(key, 0)
            z, ox, oy = self.view
            self.view = clamp_pan((z, ox + dx, oy + dy), *self.size())
            self.dirty = True

    # --- 繪製 ---
    def draw(self):
        iw, ih = self.size()
        z, ox, oy = self.view
        shown_w = iw * z
        shown_h = ih * z
        ops = [["clear", "#2b2b30"], ["image", "view", int(ox), int(oy), int(shown_w), int(shown_h), self.flip[0], self.flip[1]]]
        self.w.draw(self.cv, ops)
        if self.dirty:
            mx, my = screen_to_image(self.view, *self.mouse)
            extra = ""
            flips = "".join(s for s, f in (("　水平翻轉", self.flip[0]), ("　垂直翻轉", self.flip[1])) if f)
            msg = self.message
            self.w.set(self.status, text="%s　%d × %d 像素　縮放 %d%%　旋轉 %d°%s%s　游標在圖片 (%d, %d)%s%s" % (
                self.name, iw, ih, round(z * 100), self.rot * 90, flips, extra, int(mx), int(my), "　" if msg else "", msg))
            self.dirty = False

    def run(self):
        while True:
            ev = self.w.poll()
            if ev is None:
                self.draw()
                time.sleep(0.03)
                continue
            kind, v = ev.get("event"), ev.get("value")
            if kind == "close":
                break
            if kind == "pick":
                self.open_file(ev)
            elif kind == "click" and ev.get("node") in self.buttons:
                self.act(self.buttons[ev["node"]])
            elif kind == "mouse":
                self.on_mouse(v)
            elif kind == "wheel":
                self.view = zoom_at(self.view, 0.88 if v["dy"] > 0 else 1.14, v["x"], v["y"])
                self.dirty = True
            elif kind == "key" and v.get("down"):
                self.on_key(str(v.get("key")))
        self.w.close()


if __name__ == "__main__":
    Viewer().run()
