# -*- coding: utf-8 -*-
"""
fa_present — 把畫面送到視窗畫布的「執行期選路」：同一份程式（標準的 pygame／PyOpenGL／gl3d），底下有兩條路，執行期量測哪一條讓頁面畫得更快就走哪一條。
  * bitmap：零拷貝。Worker 的 OffscreenCanvas 擷取成 ImageBitmap（GPU 上的點陣圖），轉移所有權給頁面直接畫；不編碼、不等頁面回覆（來不及的幀丟掉，不白做擷取）。
  * png：擷取像素編成 PNG（或 JPEG），經橋接的 image＋draw 送出，等頁面解碼完才返回。
哪一條快跟環境有關：有真的 GPU 時 bitmap 是貼圖複製、幾乎免費；軟體渲染（沒有 GPU、虛擬機、遠端桌面）時 bitmap 要先讀回像素，常常比 png 還慢。所以不靠猜：
**一個 process（頁面）只量一次**，結果存在頁面端（所有程式共用）與 GPU 相容層的速率紀錄（同一台機器之後的 process 直接沿用、不再量）：
沒有結果時兩條路各跑約 1 秒（量測期間畫面會卡一下，所以不重測），比「頁面實際畫出的幀率」（bitmap 用頁面的確認張數，png 用已送出的張數）：
bitmap 不比 png 慢太多（>= 80%）就用 bitmap（省 CPU），否則用 png。頁面不支援 bitmap（舊頁面）就只走 png，不測。
"""
import time

import fa_bridge

PROBE_SECS = 1.0
PROBE_MIN_FRAMES = 8
KEEP_RATIO = 0.8


class Presenter(object):
    def __init__(self, win, node, name="screen", size=lambda: (0, 0), now=time.perf_counter, bridge=fa_bridge):
        self.win, self.node, self.name, self.size, self.now, self.br = win, node, name, size, now, bridge
        self.mode = None            # 決定好的路：'bitmap'、'png'；None＝還在量測
        self.phase = None           # 量測中的路
        self.t0 = self.n0 = self.frames = 0
        self.rate = {}

    def _supported(self):
        return bool(getattr(self.br, "can_present", lambda: False)())

    def _start(self, phase):
        self.phase, self.t0, self.frames = phase, self.now(), 0
        self.n0 = self.br.present_acked() if phase == "bitmap" else 0

    def _finish_phase(self):
        dt = max(1e-6, self.now() - self.t0)
        self.rate[self.phase] = ((self.br.present_acked() - self.n0) if self.phase == "bitmap" else self.frames) / dt
        if self.phase == "bitmap":
            self._start("png")
        else:
            self.mode = "bitmap" if self.rate["bitmap"] >= KEEP_RATIO * self.rate["png"] else "png"
            self.phase = None
            getattr(self.br, "present_pref_set", lambda *a: None)(self.mode, self.rate["bitmap"], self.rate["png"])

    def show(self, grab_bitmap, grab_image):
        """畫一幀。grab_bitmap()→ImageBitmap（只有走 bitmap 才會呼叫）；grab_image()→(位元組, mime) 或 None（畫面沒變就不送）。回傳實際走的路：'bitmap'、'png'、'dropped'。"""
        if not self._supported():
            return self._png(grab_image)
        if self.mode is None and self.phase is None:
            pref = getattr(self.br, "present_pref", lambda: None)()   # 這個 process 或這台機器已經量過就直接用
            if pref and pref.get("mode") in ("bitmap", "png"):
                self.mode = pref["mode"]
            else:
                self._start("bitmap")
        path = self.mode or self.phase
        r = self._bitmap(grab_bitmap) if path == "bitmap" else self._png(grab_image)
        if self.mode is None and self.phase is not None:
            self.frames += 1
            if self.now() - self.t0 >= PROBE_SECS and self.frames >= PROBE_MIN_FRAMES:
                self._finish_phase()
        return r

    def _bitmap(self, grab_bitmap):
        if not self.br.present_ready():
            return "dropped"
        r = self.br.present(self.win.id, self.node, grab_bitmap())
        if r == -1:   # 頁面不支援：永遠走 png
            self.mode, self.phase = "png", None
            return "dropped"
        return "bitmap" if r == 1 else "dropped"

    def _png(self, grab_image):
        enc = grab_image()
        if enc is None:
            return "png"
        data, mime = enc
        w, h = self.size()
        self.win.image(self.node, data, mime, name=self.name)
        self.win.draw(self.node, [["image", self.name, 0, 0, w, h]])
        return "png"
