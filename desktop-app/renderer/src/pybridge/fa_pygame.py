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
       "presenter": None, "mouse_pos": (0, 0), "mouse_buttons": [False, False, False], "rel": (0, 0), "repeat": None, "held": {}, "pic": "screen", "gl": None}
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
    if _ST["presenter"] is None:
        import fa_present
        _ST["presenter"] = fa_present.Presenter(win, cv, name=_ST["pic"], size=lambda: pygame.display.get_surface().get_size())
    if _ST["gl"]:
        import fa_opengl_platform as G
        _ST["presenter"].show(G.frame_bitmap, G.frame_image)
        return
    def grab_bitmap():
        import js
        from pyodide.ffi import run_sync
        return run_sync(js.createImageBitmap(js.__fa_canvas))
    _ST["presenter"].show(grab_bitmap, lambda: _encode(pygame, surf))   # 零拷貝或 PNG：執行期量測哪一條快（見 fa_present）
    return


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


# ---------------------------------------------------------------- 聲音：pygame.mixer → fa_audio（頁面的 Web Audio）
def _to_s16(raw, size, channels):
    """mixer 格式的 PCM（size：-16 有號 16 位元、16 無號 16、8 無號 8、-32 浮點 32）→ 16 位元有號 PCM 位元組。"""
    import array as _array
    if size == -16:
        return bytes(raw)
    if size == 16:
        a = _array.array("H"); a.frombytes(bytes(raw)[: len(raw) // 2 * 2]); return _array.array("h", (x - 32768 for x in a)).tobytes()
    if size == 8:
        return _array.array("h", ((x - 128) << 8 for x in bytes(raw))).tobytes()
    if size == -32:
        a = _array.array("f"); a.frombytes(bytes(raw)[: len(raw) // 4 * 4]); return _array.array("h", (max(-32768, min(32767, int(x * 32767))) for x in a)).tobytes()
    raise ValueError("不支援的 mixer 取樣格式 size=%r" % (size,))


def _array_to_s16(arr):
    """numpy 陣列（sndarray 風格：(n,) 或 (n, 2)）→ (PCM 位元組, 聲道數)。"""
    import array as _array
    ch = 2 if getattr(arr, "ndim", 1) == 2 and arr.shape[1] == 2 else 1
    dt = str(getattr(arr, "dtype", "int16"))
    flat = arr.reshape(-1)
    if dt == "int16":
        return flat.tobytes(), ch
    if dt == "uint8":
        return _array.array("h", ((int(x) - 128) << 8 for x in flat)).tobytes(), ch
    if dt.startswith("float"):
        return _array.array("h", (max(-32768, min(32767, int(float(x) * 32767))) for x in flat)).tobytes(), ch
    return _array.array("h", (max(-32768, min(32767, int(x))) for x in flat)).tobytes(), ch


def _read_source(file):
    if hasattr(file, "read"):
        return file.read()
    with open(file, "rb") as f:
        return f.read()


def _patch_mixer(pygame):
    import fa_audio
    mixer = pygame.mixer
    st = {"init": None, "seq": 0, "ok": None}

    def fmt():
        return st["init"] or (44100, -16, 2)

    def guard(fn, default=None):
        """頁面沒有音訊（舊頁面、沒有 AudioContext）時不讓程式當掉：只留一聲短嗶當後備。"""
        try:
            r = fn()
            st["ok"] = True
            return r
        except Exception as e:
            if st["ok"] is None:
                import sys
                sys.stderr.write("[fa-pygame] 沒有可用的音訊（%s）；聲音改成短嗶\n" % str(e)[:120])
            st["ok"] = False
            return default

    def beep(freq=440, ms=120):
        try:
            if _ST["window"] is not None:
                _ST["window"].tone(freq, ms)
        except Exception:
            pass

    def _analyse(pcm, rate, ch):
        import array as _array
        smp = _array.array("h"); smp.frombytes(bytes(pcm)[: len(pcm) // 2 * 2])
        if ch > 1:
            smp = smp[::ch]
        n = len(smp)
        if n < 2:
            return 440, 60
        cross = sum(1 for i in range(1, n) if (smp[i - 1] >= 0) != (smp[i] >= 0))
        return max(40, min(4000, int(cross * rate / (2.0 * n)) or 220)), max(20, min(1500, int(n * 1000 / max(1, rate))))

    def init(frequency=44100, size=-16, channels=2, buffer=512, devicename=None, allowedchanges=0):
        st["init"] = (int(frequency), int(size), int(channels))

    class Sound(object):
        def __init__(self, file=None, buffer=None, array=None):
            st["seq"] += 1
            self._name, self._vol, self._pcm, self._rate, self._ch, self._enc, self._len, self._loaded = "s%d" % st["seq"], 1.0, None, 44100, 1, None, 0.0, False
            fr, size, chs = fmt()
            if buffer is not None:
                self._pcm, self._rate, self._ch = _to_s16(buffer, size, chs), fr, 1 if chs == 1 else 2
            elif array is not None:
                self._pcm, self._ch = _array_to_s16(array); self._rate = fr
            elif file is not None:
                data = _read_source(file)
                if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
                    try:
                        import io, wave
                        with wave.open(io.BytesIO(data), "rb") as wf:
                            if wf.getsampwidth() in (1, 2) and wf.getnchannels() in (1, 2) and wf.getcomptype() == "NONE":
                                raw = wf.readframes(wf.getnframes())
                                self._pcm = _to_s16(raw, -16 if wf.getsampwidth() == 2 else 8, wf.getnchannels())
                                self._rate, self._ch = wf.getframerate(), wf.getnchannels()
                    except Exception:
                        self._pcm = None
                if self._pcm is None:
                    self._enc = data
            else:
                raise TypeError("Sound() 需要 file、buffer 或 array")
            if self._pcm is not None:
                self._len = len(self._pcm) / (2.0 * self._ch) / self._rate

        def _ensure(self):
            if self._loaded:
                return
            self._len = fa_audio.load_pcm(self._name, self._pcm, self._rate, self._ch) if self._pcm is not None else fa_audio.load_file(self._name, self._enc)
            self._loaded = True

        def play(self, loops=0, maxtime=0, fade_ms=0):
            def go():
                self._ensure()
                c = fa_audio.play(self._name, loops=loops, volume=self._vol, fade_ms=fade_ms, maxtime_ms=maxtime)
                return Channel(c) if c >= 0 else None
            r = guard(go, False)
            if r is False:   # 沒有音訊：短嗶後備
                if self._pcm is not None:
                    beep(*_analyse(self._pcm, self._rate, self._ch))
                return None
            return r

        def stop(self):
            guard(lambda: fa_audio.stop(name=self._name))

        def fadeout(self, ms):
            guard(lambda: fa_audio.stop(name=self._name, fade_ms=ms))

        def set_volume(self, v): self._vol = max(0.0, min(1.0, float(v)))
        def get_volume(self): return self._vol
        def get_length(self): return float(self._len)
        def get_num_channels(self): return guard(lambda: fa_audio.count(), 0) if self._loaded else 0
        def get_raw(self): return self._pcm if self._pcm is not None else b""

    class Channel(object):
        def __init__(self, id):
            self.id, self._vol, self._sound = int(id), 1.0, None

        def play(self, sound, loops=0, maxtime=0, fade_ms=0):
            sound._ensure()
            fa_audio.play(sound._name, ch=self.id, loops=loops, volume=sound._vol * self._vol, fade_ms=fade_ms, maxtime_ms=maxtime)
            self._sound = sound

        def stop(self): guard(lambda: fa_audio.stop(ch=self.id))
        def pause(self): pass
        def unpause(self): pass
        def fadeout(self, ms): guard(lambda: fa_audio.stop(ch=self.id, fade_ms=ms))
        def set_volume(self, left, right=None): self._vol = max(0.0, min(1.0, float(left))); guard(lambda: fa_audio.set_volume(self.id, self._vol * (self._sound._vol if self._sound else 1.0)))
        def get_volume(self): return self._vol
        def get_busy(self): return bool(guard(lambda: fa_audio.busy(self.id), False))
        def get_sound(self): return self._sound if self.get_busy() else None
        def queue(self, sound):
            if not self.get_busy():
                self.play(sound)
        def get_queue(self): return None
        def set_endevent(self, *a): pass
        def get_endevent(self): return 0

    class _Music(object):
        def __init__(self): self._loaded, self._vol, self._file = False, 1.0, None

        def load(self, filename, namehint=""):
            data = _read_source(filename)
            self._file = data
            self._loaded = False
            self._len = guard(lambda: fa_audio.load_file("music", data), 0.0)
            self._loaded = True

        def unload(self): self.stop(); self._loaded = False
        def play(self, loops=0, start=0.0, fade_ms=0): guard(lambda: fa_audio.play("music", music=True, loops=loops, volume=self._vol, fade_ms=fade_ms))
        def stop(self): guard(lambda: fa_audio.stop(music=True))
        def pause(self): guard(lambda: fa_audio.pause())     # 限制：暫停整個音訊情境（所有聲音），不只音樂
        def unpause(self): guard(lambda: fa_audio.resume())
        def fadeout(self, ms): guard(lambda: fa_audio.stop(music=True, fade_ms=ms))
        def rewind(self): pass
        def set_pos(self, pos): pass
        def get_pos(self): return -1
        def set_volume(self, v): self._vol = max(0.0, min(1.0, float(v))); guard(lambda: fa_audio.set_volume(None, self._vol, music=True))
        def get_volume(self): return self._vol
        def get_busy(self): return bool(guard(lambda: fa_audio.busy(music=True), False))
        def queue(self, filename, namehint="", loops=0): pass

    def num_channels(n=None):
        if n is not None:
            guard(lambda: fa_audio.channels(n))
            st["n"] = int(n)
        return st.get("n", 8)

    mixer.init = init
    mixer.pre_init = lambda frequency=44100, size=-16, channels=2, buffer=512, *a, **k: st.update(init=(frequency, size, channels))
    mixer.quit = lambda: (guard(lambda: fa_audio.stop(all=True)), st.update(init=None))[1]
    mixer.get_init = lambda: st["init"]
    mixer.set_num_channels = lambda n: num_channels(n)
    mixer.get_num_channels = lambda: num_channels()
    mixer.set_reserved = lambda n: 0
    mixer.stop = lambda: guard(lambda: fa_audio.stop(all=True))
    mixer.pause = lambda: guard(lambda: fa_audio.pause())
    mixer.unpause = lambda: guard(lambda: fa_audio.resume())
    mixer.fadeout = lambda ms: guard(lambda: fa_audio.stop(all=True, fade_ms=ms))
    mixer.get_busy = lambda: bool(guard(lambda: fa_audio.count() > 0, False))
    mixer.find_channel = lambda force=False: next((Channel(i) for i in range(num_channels()) if not guard(lambda: fa_audio.busy(i), False)), Channel(0) if force else None)
    mixer.Sound, mixer.Channel, mixer.music = Sound, Channel, _Music()


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
            _ST["presenter"] = None
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
        _ST["presenter"] = None
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
