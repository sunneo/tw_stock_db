# -*- coding: utf-8 -*-
"""
fa_pygame — 真的 pygame（pip 的 pygame-ce）接到 GUI 橋接。**pygame 的 API 完全是真的**，這裡不重新實作任何 pygame 的功能，只補「視窗在哪、事件從哪來」：

  * 畫面：真的 pygame 在 Worker 的 Pyodide 裡用 SDL 的 emscripten 驅動畫在螢幕 Surface 上；display.flip／update 之後，這裡把螢幕 Surface 編成 PNG
    （太大或雜訊太多就用 JPEG），經橋接的 image 與 draw 送到視窗的畫布。畫面沒變就不送。
  * 事件：頁面（視窗）的鍵盤、滑鼠、滾輪、關閉、縮放，在 event.get／poll／wait／pump 之前轉成真的 pygame 事件，用 event.post 放進真的事件佇列。
  * 輸入狀態：key.get_pressed／get_mods、mouse.get_pos／get_pressed／get_rel 讀的是 SDL 的實體輸入狀態（post 不會更新它），所以這幾個換成讀這裡追蹤的狀態。
  * Worker 裡沒有網頁環境，SDL 的 emscripten 驅動會去找 screen、document、canvas 而當掉：先補一組最小的替身，並給它一個 OffscreenCanvas。
  * 沒有音訊情境（mixer.init 會丟錯）：mixer 換成不出聲的替身（Sound.play 只發一聲短嗶）；Sound(buffer=PCM) 會依 PCM 的長度與主頻率發一聲對應的嗶；要真聲音請用 gui 的 tone。
其餘（Surface、Rect、draw、font、image、transform、time、sprite、math、mask、surfarray…）都是真的 pygame-ce，行為與 pip 的一樣。
不要在 sys.path 放名為 pygame.py 的檔案（會遮住真的套件）。install() 由 fa_bridge.install_hooks 呼叫；沒有載入 pygame-ce（程式沒 import pygame）就什麼都不做。
"""
import sys
import time
import zlib
import struct
import base64

try:
    import fa_bridge
except Exception:  # pragma: no cover
    fa_bridge = None

IN_BROWSER = sys.platform == "emscripten"
_ST = {"patched": False, "window": None, "canvas": None, "size": None, "caption": "pygame", "flags": 0, "last_crc": None, "keys": set(), "mods": 0,
       "mouse_pos": (0, 0), "mouse_buttons": [False, False, False], "rel": (0, 0), "repeat": None, "held": {}, "pic": "screen", "gl": None}
MAX_PICTURE = 1000000


# ---------------------------------------------------------------- Worker 裡的網頁環境替身
def _browser_stubs():
    import js
    import pyodide_js
    js.eval("""
globalThis.window = globalThis;
if (typeof globalThis.screen === 'undefined') globalThis.screen = { width: 1280, height: 800, availWidth: 1280, availHeight: 800, colorDepth: 24, pixelDepth: 24 };
globalThis.__fa_fix = (c) => { c.style = c.style || {}; c.getBoundingClientRect = () => ({ left: 0, top: 0, width: c.width, height: c.height, right: c.width, bottom: c.height, x: 0, y: 0 }); return c; };
if (typeof globalThis.document === 'undefined') globalThis.document = {
  createElement: () => globalThis.__fa_fix(new OffscreenCanvas(1, 1)), getElementById: () => globalThis.__fa_canvas, querySelector: () => globalThis.__fa_canvas,
  addEventListener() {}, removeEventListener() {}, body: {}, documentElement: {}, hidden: false, visibilityState: 'visible' };
globalThis.__fa_canvas = globalThis.__fa_fix(new OffscreenCanvas(640, 480));
""")
    pyodide_js.canvas.setCanvas2D(js.__fa_canvas)


# ---------------------------------------------------------------- 畫面 → PNG／JPEG
def _png(w, h, rgb):
    row = w * 3
    raw = b"".join(b"\x00" + rgb[y * row:(y + 1) * row] for y in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 1)) + chunk(b"IEND", b"")


def _encode(pygame, surf):
    w, h = surf.get_size()
    rgb = pygame.image.tobytes(surf, "RGB")
    crc = zlib.crc32(rgb)
    if crc == _ST["last_crc"]:
        return None
    _ST["last_crc"] = crc
    data = _png(w, h, rgb)
    if len(data) <= MAX_PICTURE:
        return data, "image/png"
    import io
    buf = io.BytesIO()
    try:
        pygame.image.save(surf, buf, "frame.jpg")
        if len(buf.getvalue()) <= MAX_PICTURE:
            return buf.getvalue(), "image/jpeg"
    except Exception:
        pass
    raise RuntimeError("畫面編碼後超過 %d 位元組（橋接的圖片上限）；縮小視窗，或讓畫面別有這麼多雜訊" % MAX_PICTURE)


def _present(pygame):
    win, cv = _ST["window"], _ST["canvas"]
    if win is None:
        return
    surf = pygame.display.get_surface()
    if surf is None:
        return
    w, h = surf.get_size()
    if _ST["gl"]:   # OPENGL 視窗：畫面在 WebGL2（OffscreenCanvas），擷取成 PNG（每幀都送：3D 場景幾乎每幀都在變）
        import fa_opengl_platform as G
        data, mime = G.frame_png(), "image/png"
    else:
        enc = _encode(pygame, surf)
        if enc is None:
            return
        data, mime = enc
    win.image(cv, data, mime, name=_ST["pic"])
    win.draw(cv, [["image", _ST["pic"], 0, 0, w, h]])


# ---------------------------------------------------------------- 事件：視窗 → 真的 pygame 事件
_KEYNAMES = {"ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left", "ArrowRight": "right", " ": "space", "Enter": "return", "Escape": "escape",
             "Backspace": "backspace", "Tab": "tab", "Delete": "delete", "Insert": "insert", "Home": "home", "End": "end", "PageUp": "page up",
             "PageDown": "page down", "Shift": "left shift", "Control": "left ctrl", "Alt": "left alt", "CapsLock": "caps lock"}


def _key_of(pygame, name):
    n = _KEYNAMES.get(name, name)
    if isinstance(n, str) and len(n) == 1:
        n = n.lower()
    try:
        return pygame.key.key_code(n)
    except Exception:
        return 0


def _mods_of(pygame, key, down):
    bit = {pygame.K_LSHIFT: pygame.KMOD_LSHIFT, pygame.K_LCTRL: pygame.KMOD_LCTRL, pygame.K_LALT: pygame.KMOD_LALT}.get(key)
    if bit:
        _ST["mods"] = (_ST["mods"] | bit) if down else (_ST["mods"] & ~bit)
    return _ST["mods"]


def _post(pygame, etype, **kw):
    try:
        pygame.event.post(pygame.event.Event(etype, **kw))
    except Exception:
        pass   # 佇列滿了（pygame 的佇列有上限）就丟掉，跟真的一樣


def _pump(pygame):
    win = _ST["window"]
    if win is None:
        return
    now = time.time()
    rep = _ST["repeat"]
    if rep:   # key.set_repeat：按住的鍵過了 delay 之後每隔 interval 再送一次 KEYDOWN
        for key, st in list(_ST["held"].items()):
            if now >= st["next"]:
                st["next"] = now + rep[1] / 1000.0
                _post(pygame, pygame.KEYDOWN, key=key, mod=_ST["mods"], unicode=st["uni"], scancode=0)
    for _ in range(200):
        ev = win.poll()
        if ev is None:
            break
        kind = ev.get("event")
        v = ev.get("value") or {}
        if kind == "close":
            _post(pygame, pygame.QUIT)
        elif kind == "key":
            name, down = str(v.get("key", "")), bool(v.get("down"))
            key = _key_of(pygame, name)
            if not key:
                continue
            uni = name if len(name) == 1 else ("\r" if name == "Enter" else "\x1b" if name == "Escape" else "\x08" if name == "Backspace" else "\t" if name == "Tab" else "")
            mod = _mods_of(pygame, key, down)
            if down:
                _ST["keys"].add(key)
                if _ST["repeat"] and key not in _ST["held"]:
                    _ST["held"][key] = {"next": now + _ST["repeat"][0] / 1000.0, "uni": uni}
            else:
                _ST["keys"].discard(key)
                _ST["held"].pop(key, None)
            _post(pygame, pygame.KEYDOWN if down else pygame.KEYUP, key=key, mod=mod, unicode=uni if down else "", scancode=0)
        elif kind == "mouse":
            x, y = int(v.get("x", 0)), int(v.get("y", 0))
            button = int(v.get("button", 0)) + 1   # 瀏覽器 0／1／2＝左／中／右；pygame 1／2／3
            old = _ST["mouse_pos"]
            if v.get("kind") == "move":
                rel = (x - old[0], y - old[1])
                _ST["rel"] = (_ST["rel"][0] + rel[0], _ST["rel"][1] + rel[1])
                _post(pygame, pygame.MOUSEMOTION, pos=(x, y), rel=rel, buttons=tuple(_ST["mouse_buttons"]), touch=False)
            else:
                down = v.get("kind") == "down"
                if 1 <= button <= 3:
                    _ST["mouse_buttons"][button - 1] = down
                _post(pygame, pygame.MOUSEBUTTONDOWN if down else pygame.MOUSEBUTTONUP, pos=(x, y), button=button, touch=False)
            _ST["mouse_pos"] = (x, y)
        elif kind == "wheel":
            dy = float(v.get("dy", 0))
            y = -1 if dy > 0 else 1   # pygame 的 y 往上滾是正的，瀏覽器的 deltaY 往下滾是正的
            _post(pygame, pygame.MOUSEWHEEL, x=0, y=y, flipped=False, precise_x=0.0, precise_y=float(y), touch=False)
            for t in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEBUTTONUP):   # pygame 2 同時送舊式的按鈕 4／5
                _post(pygame, t, pos=_ST["mouse_pos"], button=4 if y > 0 else 5, touch=False)
        elif kind == "resize":
            w, h = int(v.get("width", 0)), int(v.get("height", 0))
            if w > 0 and h > 0 and (_ST["flags"] & pygame.RESIZABLE):
                _ST["real_set_mode"]((w, h), _ST["flags"] & ~(pygame.FULLSCREEN | getattr(pygame, "SCALED", 0) | pygame.OPENGL | pygame.DOUBLEBUF))
                _ST["size"] = (w, h)
                _ST["last_crc"] = None
                _post(pygame, pygame.VIDEORESIZE, size=(w, h), w=w, h=h)
                _post(pygame, pygame.WINDOWRESIZED, x=w, y=h, window=None)
                _post(pygame, pygame.WINDOWSIZECHANGED, x=w, y=h, window=None)


# ---------------------------------------------------------------- 輸入狀態
class _Pressed(object):
    """key.get_pressed() 的替身：用 pygame 的按鍵常數（K_LEFT、K_a…）當索引。"""
    def __getitem__(self, key):
        return bool(key in _ST["keys"])

    def __len__(self):
        return 512

    def __iter__(self):
        return iter(())


# ---------------------------------------------------------------- 聲音（沒有音訊情境）
def _patch_mixer(pygame):
    mixer = pygame.mixer
    st = {"init": None}

    def init(frequency=44100, size=-16, channels=2, buffer=512, *a, **k):
        st["init"] = (frequency, size, channels)

    def beep(freq=440, ms=120):
        try:
            if _ST["window"] is not None:
                _ST["window"].tone(freq, ms)
        except Exception:
            pass

    def _analyse(raw, rate, channels):
        """16 位元 PCM → (主頻率 Hz, 長度 ms)：用過零點估頻率，供 Sound.play 發一聲對應的嗶（沒有真的音訊情境）。"""
        import array as _array
        smp = _array.array("h")
        try:
            smp.frombytes(bytes(raw)[: len(raw) // 2 * 2])
        except Exception:
            return 440, 120
        if channels > 1:
            smp = smp[::channels]
        n = len(smp)
        if n < 2:
            return 440, 60
        ms = int(n * 1000 / max(1, rate))
        cross = sum(1 for i in range(1, n) if (smp[i - 1] >= 0) != (smp[i] >= 0))
        freq = int(cross * rate / (2.0 * n)) if cross else 0
        return max(40, min(4000, freq or 220)), max(20, min(1500, ms))

    class Sound(object):
        def __init__(self, file=None, buffer=None, array=None):
            self._vol = 1.0
            self._beep = (440, 120)
            fr, size, ch = st["init"] or (44100, -16, 2)
            try:
                if buffer is not None:
                    self._beep = _analyse(buffer, fr, ch)
                elif array is not None:
                    self._beep = _analyse(array.tobytes(), fr, ch if getattr(array, "ndim", 1) == 1 else array.shape[1])
                elif isinstance(file, str) and file.lower().endswith(".wav"):
                    import wave
                    with wave.open(file, "rb") as wf:
                        self._beep = _analyse(wf.readframes(min(wf.getnframes(), 44100 * 2)), wf.getframerate(), wf.getnchannels())
            except Exception:
                pass

        def play(self, loops=0, maxtime=0, fade_ms=0):
            beep(*self._beep)
            return None

        def stop(self): pass
        def fadeout(self, ms): pass
        def set_volume(self, v): self._vol = float(v)
        def get_volume(self): return self._vol
        def get_length(self): return self._beep[1] / 1000.0
        def get_num_channels(self): return 0
        def get_raw(self): return b""

    class _Music(object):
        def __init__(self): self._vol = 1.0; self._busy = False
        def load(self, *a, **k): pass
        def unload(self): pass
        def play(self, loops=0, start=0.0, fade_ms=0): beep(330, 150); self._busy = False
        def stop(self): self._busy = False
        def pause(self): pass
        def unpause(self): pass
        def fadeout(self, ms): pass
        def set_volume(self, v): self._vol = float(v)
        def get_volume(self): return self._vol
        def get_busy(self): return self._busy
        def get_pos(self): return -1
        def queue(self, *a, **k): pass

    mixer.init = init
    mixer.pre_init = lambda *a, **k: None
    mixer.quit = lambda: st.update(init=None)
    mixer.get_init = lambda: st["init"]
    mixer.set_num_channels = lambda n: None
    mixer.get_num_channels = lambda: 8
    mixer.stop = lambda: None
    mixer.pause = lambda: None
    mixer.unpause = lambda: None
    mixer.fadeout = lambda ms: None
    mixer.get_busy = lambda: False
    mixer.Sound = Sound
    mixer.music = _Music()


# ---------------------------------------------------------------- 安裝
def patch(pygame):
    """把後端接到已經載入的真 pygame（可重複呼叫）。回傳 pygame。"""
    if _ST["patched"]:
        return pygame
    _ST["patched"] = True
    display, event, key, mouse = pygame.display, pygame.event, pygame.key, pygame.mouse
    real = {"set_mode": display.set_mode, "flip": display.flip, "update": display.update, "set_caption": display.set_caption, "quit": pygame.quit,
            "get": event.get, "poll": event.poll, "wait": event.wait, "pump": event.pump, "peek": event.peek}
    _ST["real_set_mode"] = real["set_mode"]

    def set_mode(size=(0, 0), flags=0, depth=0, display=0, vsync=0, **kw):
        flags = int(flags)
        gl_mode = bool(flags & pygame.OPENGL)
        # OPENGL 視窗：真的 SDL 這邊開一般的 2D 螢幕 Surface（Worker 裡的 SDL 沒有 GL 輸出），GL 畫在我們自己的 WebGL2 上下文（見 fa_opengl_platform）
        mask = pygame.FULLSCREEN | getattr(pygame, "SCALED", 0) | (pygame.OPENGL | pygame.DOUBLEBUF if gl_mode else 0)
        surf = real["set_mode"](tuple(size), flags & ~mask, depth)
        w, h = surf.get_size()
        _ST["flags"] = flags
        if _ST["window"] is None:
            import gui
            resizable = bool(flags & pygame.RESIZABLE)
            _ST["window"] = gui.Window(_ST["caption"], width=max(160, w + 24), resizable=resizable, maximizable=resizable)
            _ST["canvas"] = _ST["window"].canvas(width=w, height=h, fps=0)
        elif _ST["size"] != (w, h):
            _ST["window"].set(_ST["canvas"], width=w, height=h)
            _ST["last_crc"] = None
        _ST["size"] = (w, h)
        _ST["gl"] = gl_mode
        if gl_mode:
            try:
                import fa_opengl_platform as G
                G.create_context(w, h)
            except Exception as e:
                raise pygame.error("OPENGL 視窗需要 WebGL2（OffscreenCanvas）與 PyOpenGL：" + str(e))
        return surf

    def flip():
        real["flip"]()
        _present(pygame)

    def update(rects=None):
        real["update"](rects) if rects is not None else real["update"]()
        _present(pygame)

    def set_caption(title, icontitle=None):
        _ST["caption"] = str(title)
        return real["set_caption"](title, icontitle) if icontitle is not None else real["set_caption"](title)

    def with_pump(name):
        fn = real[name]

        def call(*a, **k):
            _pump(pygame)
            return fn(*a, **k)
        call.__name__ = name
        return call

    def wait(timeout=0):
        """真的 SDL_WaitEvent 會等一個永遠不會來的 SDL 事件；改成輪詢橋接，直到有事件或逾時（毫秒；0＝一直等）。"""
        t0 = time.time()
        while True:
            _pump(pygame)
            ev = real["poll"]()
            if ev.type != pygame.NOEVENT:
                return ev
            if timeout and (time.time() - t0) * 1000.0 >= timeout:
                return ev
            fa_bridge.sleep(0.01)

    def quit_():
        win = _ST["window"]
        _ST["window"] = None
        _ST["canvas"] = None
        _ST["size"] = None
        _ST["last_crc"] = None
        if win is not None:
            try:
                win.close()
            except Exception:
                pass
        real["quit"]()

    display.set_mode, display.flip, display.update, display.set_caption = set_mode, flip, update, set_caption
    event.get, event.poll, event.pump, event.peek, event.wait = with_pump("get"), with_pump("poll"), with_pump("pump"), with_pump("peek"), wait
    pygame.quit = quit_
    key.get_pressed = lambda: _Pressed()
    key.get_mods = lambda: _ST["mods"]
    key.get_focused = lambda: True
    key.set_repeat = lambda delay=None, interval=None: _ST.update(repeat=(int(delay), int(interval or delay)) if delay else None, held={})
    key.get_repeat = lambda: _ST["repeat"] or (0, 0)
    mouse.get_pos = lambda: _ST["mouse_pos"]
    mouse.get_pressed = lambda num_buttons=3, desktop=False: tuple(_ST["mouse_buttons"])[:num_buttons] if num_buttons == 3 else tuple(_ST["mouse_buttons"]) + (False,) * (num_buttons - 3)
    mouse.get_rel = lambda: (lambda r: (_ST.update(rel=(0, 0)), r)[1])(_ST["rel"])
    mouse.get_focused = lambda: True
    mouse.set_visible = lambda v: True
    mouse.set_pos = lambda *a: None
    mouse.set_cursor = lambda *a, **k: None
    _patch_mixer(pygame)
    return pygame


def install():
    """fa_bridge.install_hooks 呼叫：程式有 import pygame（Worker 路徑會預先載入 pygame-ce）才接上後端。"""
    if _ST["patched"]:
        return
    try:
        import importlib.util
        spec = importlib.util.find_spec("pygame")
    except Exception:
        spec = None
    if spec is None:
        return
    if IN_BROWSER:
        _browser_stubs()
    import pygame
    patch(pygame)
