# -*- coding: utf-8 -*-
"""
fa_audio — 真的音訊：程式把 PCM 或聲音檔交給頁面，頁面用 Web Audio 播出來（Worker 沒有 AudioContext，頁面有）。
pygame.mixer（fa_pygame）就是接在這上面；不用 pygame 的程式也可以直接用：

    import fa_audio
    fa_audio.load_pcm("beep", pcm_bytes, rate=22050, channels=1)    # 16 位元有號 PCM（小端）
    ch = fa_audio.play("beep", loops=0, volume=0.8)                 # 回傳聲道號（-1＝沒有空聲道）；同時可以播很多個（預設 8 個聲道）
    fa_audio.load_file("song", open("a.ogg", "rb").read())          # wav／mp3／ogg／flac…由瀏覽器解碼
    fa_audio.play("song", music=True, loops=-1)                     # 音樂聲道（一個）
    fa_audio.stop(ch=ch)  /  fa_audio.stop(all=True)  /  fa_audio.set_volume(ch, 0.3)  /  fa_audio.busy(ch)

限制：一個聲音至多 8 MB PCM（編碼檔 12 MB）、同時至多 64 個聲音；聲道至多 32；聽不到聲音時先用滑鼠點一下頁面（瀏覽器的自動播放政策）。
程式結束（或 Ctrl+C）時頁面會收掉這支程式播的聲音。
"""
import base64

import fa_bridge


def _call(**kw):
    return fa_bridge.call("gui.audio", kw)


def available():
    """頁面端有沒有音訊（沒有 AudioContext 或頁面太舊就是 False）。"""
    try:
        _call(cmd="info", name="_probe")
        return True
    except Exception:
        return False


def load_pcm(name, pcm, rate=44100, channels=1):
    """載入 16 位元有號 PCM（小端；channels 1 或 2）。回傳長度（秒）。同名會取代。"""
    return float(_call(cmd="load", name=name, rate=int(rate), channels=int(channels), data=base64.b64encode(bytes(pcm)).decode("ascii"))["duration"])


def load_file(name, data, mime=None):
    """載入聲音檔的位元組（wav、mp3、ogg、flac…，由瀏覽器解碼）。回傳長度（秒）。"""
    return float(_call(cmd="load", name=name, encoded=base64.b64encode(bytes(data)).decode("ascii"), mime=mime or "")["duration"])


def unload(name):
    _call(cmd="unload", name=name)


def play(name, ch=None, loops=0, volume=1.0, fade_ms=0, maxtime_ms=0, music=False):
    """播放。loops：0＝一次、-1＝一直播、n＝多播 n 次。回傳聲道號（music 是 -2；沒有空聲道是 -1）。"""
    kw = {"cmd": "play", "name": name, "loops": int(loops), "volume": float(volume), "fade_ms": int(fade_ms), "maxtime_ms": int(maxtime_ms), "music": bool(music)}
    if ch is not None:
        kw["ch"] = int(ch)
    return int(_call(**kw)["ch"])


def stop(ch=None, name=None, all=False, music=False, fade_ms=0):
    kw = {"cmd": "stop", "fade_ms": int(fade_ms)}
    if all:
        kw["all"] = True
    elif music:
        kw["music"] = True
    elif ch is not None:
        kw["ch"] = int(ch)
    elif name is not None:
        kw["name"] = name
    return int(_call(**kw)["stopped"])


def set_volume(ch, volume, music=False):
    return bool(_call(cmd="volume", ch=ch, volume=float(volume), music=bool(music))["ok"])


def set_master(volume):
    _call(cmd="volume", master=float(volume))


def busy(ch=None, music=False):
    kw = {"cmd": "busy"}
    if music:
        kw["music"] = True
    elif ch is not None:
        kw["ch"] = int(ch)
    return bool(_call(**kw)["busy"])


def count():
    """正在播的聲道數。"""
    return int(_call(cmd="busy")["count"])


def channels(n):
    return int(_call(cmd="channels", n=int(n))["n"])


def pause():
    _call(cmd="pause")


def resume():
    _call(cmd="resume")


def info(name):
    """已載入聲音的 {duration}，沒有就是 None。"""
    return _call(cmd="info", name=name)
