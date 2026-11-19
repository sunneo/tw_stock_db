# -*- coding: utf-8 -*-
# fa_pygame（真的 pygame-ce 接 GUI 橋接）對假橋接的測試。需要 pip 的 pygame-ce（沒有就略過）。Run: python3 renderer/src/pybridge/fa_pygame_test.py
import base64, os, sys, types, zlib, struct
os.environ["SDL_VIDEODRIVER"] = "dummy"; os.environ["SDL_AUDIODRIVER"] = "dummy"; os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
try:
    import pygame  # 真的 pip 套件（pybridge 裡不能有名為 pygame.py 的檔案）
except ImportError:
    print("fa_pygame: 略過（沒有安裝 pygame-ce）"); sys.exit(0)
assert os.path.dirname(os.path.abspath(pygame.__file__)) != HERE, "pybridge 裡有 pygame.py 遮住真套件"
calls, queue = [], []
audio_state = {"ch": -1, "busy": True}
def fake_call(op, args=None, timeout=240.0):
    calls.append((op, args))
    if op == "gui.poll": return queue.pop(0) if queue else None
    if op == "gui.image": return {"w": 0, "h": 0}
    if op == "gui.audio":
        c = args["cmd"]
        if c == "load": return {"name": args["name"], "duration": 0.1}
        if c == "play": audio_state["ch"] = (audio_state["ch"] + 1) % 8 if args.get("ch") is None else args["ch"]; return {"ch": -2 if args.get("music") else audio_state["ch"]}
        if c == "busy": return {"busy": audio_state["busy"], "count": 1 if audio_state["busy"] else 0}
        if c == "stop": return {"stopped": 1}
        return {"ok": True}
    return None
stub = types.ModuleType("fa_bridge"); stub.call = fake_call; stub.sleep = lambda s: None; stub.ACTIVE = True; sys.modules["fa_bridge"] = stub
import gui, fa_pygame
bad = []
def check(n, c, x=None):
    if not c: bad.append(n + (" " + repr(x)[:200] if x is not None else ""))
fa_pygame.patch(pygame)
pygame.init()
pygame.display.set_caption("測試")
scr = pygame.display.set_mode((80, 60))
check("set_mode 回真的 Surface", isinstance(scr, pygame.Surface) and scr.get_size() == (80, 60) and pygame.display.get_surface() is scr)
check("開了視窗與畫布", [c[0] for c in calls][:2] == ["gui.open", "gui.add"] and calls[0][1]["title"] == "測試" and calls[1][1]["node"]["kind"] == "canvas" and calls[1][1]["node"]["width"] == 80, calls[:2])
scr.fill((255, 0, 0)); pygame.draw.circle(scr, (0, 255, 0), (40, 30), 10); pygame.draw.ellipse(scr, (0, 0, 255), pygame.Rect(2, 2, 30, 12)); pygame.display.flip()
img = [c for c in calls if c[0] == "gui.image"]; drw = [c for c in calls if c[0] == "gui.draw"]
check("flip 送了一張 PNG 與一個 image 繪圖指令", len(img) == 1 and len(drw) == 1 and drw[0][1]["ops"] == [["image", "screen", 0, 0, 80, 60]], (len(img), len(drw)))
png = base64.b64decode(img[0][1]["data"].split(",", 1)[1]); check("是 PNG", png[:8] == b"\x89PNG\r\n\x1a\n")
w, h = struct.unpack(">II", png[16:24]); i = 8; idat = b""
while i < len(png):
    n = struct.unpack(">I", png[i:i + 4])[0]; tag = png[i + 4:i + 8]
    if tag == b"IDAT": idat += png[i + 8:i + 8 + n]
    i += 12 + n
raw = zlib.decompress(idat); px = lambda x, y: tuple(raw[y * (w * 3 + 1) + 1 + x * 3:y * (w * 3 + 1) + 4 + x * 3])
check("PNG 尺寸與像素正確（圓心綠、背景紅）", (w, h) == (80, 60) and px(40, 30) == (0, 255, 0) and px(70, 55) == (255, 0, 0), (w, h, px(40, 30), px(70, 55)))
pygame.display.flip(); check("畫面沒變不重送", len([c for c in calls if c[0] == "gui.image"]) == 1)
scr.fill((1, 2, 3)); pygame.display.update(); check("變了才送", len([c for c in calls if c[0] == "gui.image"]) == 2)
check("convert／convert_alpha 是真的", pygame.Surface((4, 4)).convert().get_size() == (4, 4) and pygame.Surface((4, 4)).convert_alpha().get_size() == (4, 4))
check("font／transform／Rect 是真的", pygame.font.Font(None, 20).render("hi", True, (255, 255, 255)).get_width() > 0 and pygame.transform.scale(scr, (40, 30)).get_size() == (40, 30) and pygame.Rect(1, 2, 3, 4).colliderect((2, 3, 5, 5)))
# 事件
queue.extend([{"event": "key", "value": {"key": "ArrowLeft", "down": True}}, {"event": "key", "value": {"key": "a", "down": True}}, {"event": "key", "value": {"key": "Shift", "down": True}},
              {"event": "mouse", "value": {"kind": "move", "x": 10, "y": 20, "button": 0}}, {"event": "mouse", "value": {"kind": "down", "x": 10, "y": 20, "button": 0}},
              {"event": "wheel", "value": {"x": 1, "y": 1, "dy": 100}}])
evs = [e for e in pygame.event.get() if e.type in (pygame.KEYDOWN, pygame.KEYUP, pygame.MOUSEMOTION, pygame.MOUSEBUTTONDOWN, pygame.MOUSEBUTTONUP, pygame.MOUSEWHEEL)]
kd = [e for e in evs if e.type == pygame.KEYDOWN]
check("KEYDOWN：方向鍵、字母（含 unicode）", [e.key for e in kd][:2] == [pygame.K_LEFT, pygame.K_a] and kd[1].unicode == "a", [(e.key, getattr(e, "unicode", None)) for e in kd])
check("key.get_pressed 讀追蹤的狀態", pygame.key.get_pressed()[pygame.K_LEFT] and pygame.key.get_pressed()[pygame.K_a] and not pygame.key.get_pressed()[pygame.K_UP])
check("Shift 進 mods", pygame.key.get_mods() & pygame.KMOD_LSHIFT and kd[-1].mod & pygame.KMOD_LSHIFT, pygame.key.get_mods())
mm = [e for e in evs if e.type == pygame.MOUSEMOTION]; check("MOUSEMOTION pos／rel", mm and mm[0].pos == (10, 20) and mm[0].rel == (10, 20), [(e.pos, e.rel) for e in mm])
check("mouse.get_pos／get_pressed", pygame.mouse.get_pos() == (10, 20) and pygame.mouse.get_pressed() == (True, False, False), (pygame.mouse.get_pos(), pygame.mouse.get_pressed()))
check("MOUSEBUTTONDOWN button 1", any(e.type == pygame.MOUSEBUTTONDOWN and e.button == 1 for e in evs))
wh = [e for e in evs if e.type == pygame.MOUSEWHEEL]; check("MOUSEWHEEL 往下滾 y=-1，並有舊式 5 號按鈕", wh and wh[0].y == -1 and any(e.type == pygame.MOUSEBUTTONDOWN and e.button == 5 for e in evs), [(e.y) for e in wh])
queue.append({"event": "key", "value": {"key": "ArrowLeft", "down": False}}); pygame.event.get()
check("放開後 get_pressed 變 False", not pygame.key.get_pressed()[pygame.K_LEFT])
queue.append({"event": "close"}); check("關視窗＝QUIT", any(e.type == pygame.QUIT for e in pygame.event.get()))
queue.append({"event": "key", "value": {"key": " ", "down": True}}); e = pygame.event.wait(100)
check("event.wait 輪詢橋接", e.type == pygame.KEYDOWN and e.key == pygame.K_SPACE, e)
e = pygame.event.wait(30); check("wait 逾時回 NOEVENT", e.type == pygame.NOEVENT, e)
pygame.event.post(pygame.event.Event(pygame.USEREVENT, code=7)); check("event.post 是真的", any(x.type == pygame.USEREVENT and x.code == 7 for x in pygame.event.get()))
# mixer：不出聲的替身，Sound.play 發一聲嗶
import array, math
pygame.mixer.init(22050, -16, 1)
pcm = array.array("h", (12000 if math.sin(2 * math.pi * 440 * i / 22050) >= 0 else -12000 for i in range(2205)))   # 440 Hz、100 ms
snd = pygame.mixer.Sound(buffer=pcm.tobytes()); chn = snd.play(loops=2, fade_ms=10)
au = [c[1] for c in calls if c[0] == "gui.audio"]
ld = [a for a in au if a["cmd"] == "load"][-1]; pl = [a for a in au if a["cmd"] == "play"][-1]
check("Sound(buffer=PCM)：載入 16 位元 PCM（取樣率、聲道、資料）", ld["rate"] == 22050 and ld["channels"] == 1 and len(base64.b64decode(ld["data"])) == 4410, {k: ld[k] for k in ("rate", "channels")})
check("play(loops, fade_ms) 轉給頁面並回傳 Channel", pl["loops"] == 2 and pl["fade_ms"] == 10 and isinstance(chn, pygame.mixer.Channel) and abs(snd.get_length() - 0.1) < 1e-6, pl)
check("Channel.get_busy 讀頁面的狀態", chn.get_busy() is True and (audio_state.update(busy=False) or True) and chn.get_busy() is False)
snd.set_volume(0.4); snd.play(); check("Sound 音量帶進 play", [c[1] for c in calls if c[0] == "gui.audio" and c[1]["cmd"] == "play"][-1]["volume"] == 0.4)
pygame.mixer.set_num_channels(4); check("set_num_channels → channels 指令", [c[1] for c in calls if c[0] == "gui.audio" and c[1]["cmd"] == "channels"][-1]["n"] == 4 and pygame.mixer.get_num_channels() == 4)
pygame.mixer.pre_init(44100, 8, 1); u8 = pygame.mixer.Sound(buffer=bytes([128, 255, 0, 128])); pygame.mixer.pre_init(22050, -16, 1)
u8.play(); ld8 = [c[1] for c in calls if c[0] == "gui.audio" and c[1]["cmd"] == "load"][-1]
check("u8 → s16 的值（128→0、255→32512、0→-32768）", __import__("struct").unpack("<4h", base64.b64decode(ld8["data"])) == (0, 32512, -32768, 0), __import__("struct").unpack("<4h", base64.b64decode(ld8["data"])))
import tempfile, wave
with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf: wp = tf.name
with wave.open(wp, "wb") as wf: wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(8000); wf.writeframes(array.array("h", [1000, -1000] * 400).tobytes())
ws = pygame.mixer.Sound(wp); ws.play(); lw = [c[1] for c in calls if c[0] == "gui.audio" and c[1]["cmd"] == "load"][-1]
check("Sound(wav 檔)：用 wave 解成 PCM（取樣率 8000、0.1 秒）", lw["rate"] == 8000 and abs(ws.get_length() - 0.1) < 1e-6, lw["rate"])
open(wp + ".ogg", "wb").write(b"OggS" + b"\0" * 20); es = pygame.mixer.Sound(wp + ".ogg"); es.play(); le = [c[1] for c in calls if c[0] == "gui.audio" and c[1]["cmd"] == "load"][-1]
check("非 PCM 的檔案（ogg、mp3…）整檔交給瀏覽器解碼", "encoded" in le and "data" not in le)
pygame.mixer.music.load(wp + ".ogg"); pygame.mixer.music.set_volume(0.5); pygame.mixer.music.play(loops=-1)
mp = [c[1] for c in calls if c[0] == "gui.audio" and c[1]["cmd"] == "play"][-1]
check("mixer.music：音樂聲道、無限循環", mp["music"] is True and mp["loops"] == -1 and mp["volume"] == 0.5, mp)
pygame.mixer.music.stop(); pygame.mixer.stop(); check("music.stop／mixer.stop", len([c for c in calls if c[0] == "gui.audio" and c[1]["cmd"] == "stop"]) >= 2)
os.unlink(wp); os.unlink(wp + ".ogg")
pygame.quit(); check("pygame.quit 收掉視窗狀態（視窗已因 close 事件關閉，不重複送 gui.close）", fa_pygame._ST["window"] is None and not any(c[0] == "gui.close" for c in calls))
print("FAILED:\n  " + "\n  ".join(bad) if bad else "fa_pygame: OK"); sys.exit(1 if bad else 0)
