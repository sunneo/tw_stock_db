# -*- coding: utf-8 -*-
# 產生 ../gui/music_player.ll：音樂盒（SDL2 音訊＋影像＋鍵盤）。內建〈歡樂頌〉，即時合成（方波／三角波／正弦）經 SDL_QueueAudio 送出；視窗畫兩個八度的琴鍵、目前的音、播放進度。
# 空白＝暫停／繼續、↑↓＝速度 ±10 BPM、1 2 3＝方波／三角波／正弦、R＝從頭、Esc 離開。第一個參數＝跑幾幀後離開（測試用）。
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _irb import *
from _hud import install_dsl

NOTES = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62, 64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60,
         62, 62, 64, 60, 62, 64, 65, 64, 60, 62, 64, 65, 64, 62, 60, 62, 55, 64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60]
DURS = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 1, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 1, 4,
        2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 1, 4]
NN = len(NOTES)
TOTAL = sum(DURS)
RATE = 22050
m = Mod('; 音樂盒（SDL2 音訊＋影像＋鍵盤）：內建〈歡樂頌〉，即時合成，經 SDL_QueueAudio 送出（佇列模式）。空白＝暫停／繼續、↑↓＝速度、1 2 3＝波形、R＝從頭、Esc 離開。\n'
        '; 第一個參數＝跑幾幀後離開（測試用）。（由 _gen/_gen_music_player.py 產生）\ntarget triple = "x86_64-pc-linux-gnu"')
D = m.decl
install_dsl(m)   # 螢幕說明（HUD）的字型與 hud_text／hud_int（_hud.py）
D('i32', 'SDL_Init', 'i32'); D('void', 'SDL_Quit'); D('ptr', 'SDL_CreateWindow', 'ptr', 'i32', 'i32', 'i32', 'i32', 'i32'); D('ptr', 'SDL_CreateRenderer', 'ptr', 'i32', 'i32')
D('i32', 'SDL_PollEvent', 'ptr'); D('i32', 'SDL_SetRenderDrawColor', 'ptr', 'i8', 'i8', 'i8', 'i8'); D('i32', 'SDL_RenderClear', 'ptr'); D('i32', 'SDL_RenderFillRect', 'ptr', 'ptr')
D('void', 'SDL_RenderPresent', 'ptr'); D('void', 'SDL_Delay', 'i32'); D('void', 'SDL_DestroyRenderer', 'ptr'); D('void', 'SDL_DestroyWindow', 'ptr')
D('i32', 'SDL_OpenAudioDevice', 'ptr', 'i32', 'ptr', 'ptr', 'i32'); D('void', 'SDL_PauseAudioDevice', 'i32', 'i32'); D('i32', 'SDL_QueueAudio', 'i32', 'ptr', 'i32')
D('i32', 'SDL_GetQueuedAudioSize', 'i32'); D('void', 'SDL_CloseAudioDevice', 'i32')
D('double', 'sin', 'double'); D('double', 'pow', 'double', 'double'); D('double', 'floor', 'double'); D('i32', 'atoi', 'ptr'); D('i32', 'printf', 'ptr', varargs=True)
notes = m.const_array('notes', 'i32', NOTES)
durs = m.const_array('durs', 'i32', DURS)

# 半拍序號（已取餘數）→ 第幾個音；accp[0]＝這個音開始的半拍
ni = m.fn('i32', 'note_idx', ('i32', 'hb'), ('ptr', 'accp'))
hb, accp = ni.args
accp.elem = 'i32'
dd = V(ni, '@durs', 'ptr', 'i32')
k, acc = ni.var('i32', 0), ni.var('i32', 0)
with ni.while_(lambda: (acc.get() + dd[k.get()]).ult(hb + 1) & (k.get() < NN - 1)):   # acc + dur <= hb
    acc += dd[k.get()]; k += 1
accp[0] = acc.get()
ni.ret(k.get())


def synth_fn():
    f = m.fn('void', 'synth', ('ptr', 'buf'), ('i32', 'n'), ('i32', 'start'), ('i32', 'spb'), ('i32', 'wave'))
    buf, n, start, spb, wave = f.args
    buf.elem = 'i8'
    s = f.var('i32', 0)
    accp = f.alloca('i32'); accp.elem = 'i32'
    nt = V(f, '@notes', 'ptr', 'i32')
    with f.loop(s, 0, n):
        tt = (start + s.get()) % (spb * TOTAL)
        hbn = tt / spb
        idx = f.call('note_idx', hbn, accp)
        a0 = accp[0]
        pos = tt - a0 * spb
        ln = V(f, '@durs', 'ptr', 'i32')[idx] * spb
        midi = nt[idx]
        freq = f.call('pow', 2.0, (midi - 69).to('double') / 12.0) * 440.0
        cyc = pos.to('double') * freq / float(RATE)
        ph = cyc - f.call('floor', cyc)            # 0..1
        sq = (ph < 0.5).sel(f.const('double', 1.0), f.const('double', -1.0))
        tri = ((ph < 0.5).sel(ph * 4.0 - 1.0, 3.0 - ph * 4.0))
        sn = f.call('sin', ph * 6.2831853)
        w0 = (wave.eq(0)).sel(sq, (wave.eq(1)).sel(tri, sn))
        # 包絡：開頭 200 取樣淡入、結尾 600 取樣淡出
        att = pos.to('double') / 200.0
        att = (att > 1.0).sel(f.const('double', 1.0), att)
        rel = (ln - pos).to('double') / 600.0
        rel = (rel > 1.0).sel(f.const('double', 1.0), rel)
        v = (w0 * att * rel * 5000.0).to('i32')
        lo = (v & 255).to('i8'); hi = ((v >> 8) & 255).to('i8')
        o = s.get() * 2
        buf[o] = lo; buf[o + 1] = hi
    f.ret()


synth_fn()

# 畫面：兩個八度（C4..B5）的琴鍵；目前的音亮起；上方進度條；下方顯示波形（3 個小方塊亮起其中一個）
ui = m.fn('void', 'draw_ui', ('ptr', 'ren'), ('i32', 'midi'), ('i32', 'prog'), ('i32', 'wave'), ('i32', 'paused'), ('i32', 'bpm'))
ren, midi, prog, wave, paused, bpm = ui.args
rc = ui.array('i32', 4)
c = ui.call


def rect(x, y, w, h, r, g, b):
    rc[0] = x; rc[1] = y; rc[2] = w; rc[3] = h
    c('SDL_SetRenderDrawColor', ren, r, g, b, 255)
    c('SDL_RenderFillRect', ren, rc)


c('SDL_SetRenderDrawColor', ren, 18, 20, 28, 255); c('SDL_RenderClear', ren)
rect(0, 0, 640, 12, 40, 44, 60)
rect(0, 0, prog, 12, 90, 200, 120)
k = ui.var('i32', 0)
with ui.loop(k, 0, 24):
    sc = k.get() % 12
    black = (sc.eq(1) | sc.eq(3) | sc.eq(6) | sc.eq(8) | sc.eq(10))
    lit = (k.get() + 60).eq(midi)
    x = k.get() * 26 + 8
    # 白鍵比較高、黑鍵比較矮，顏色區分
    r = lit.sel(ui.const('i32', 255), black.sel(ui.const('i32', 40), ui.const('i32', 235)))
    g = lit.sel(ui.const('i32', 200), black.sel(ui.const('i32', 40), ui.const('i32', 235)))
    b = lit.sel(ui.const('i32', 60), black.sel(ui.const('i32', 50), ui.const('i32', 240)))
    hh = black.sel(ui.const('i32', 90), ui.const('i32', 150))
    rect(x, 40, 24, hh, r.to('i8'), g.to('i8'), b.to('i8'))
w = ui.var('i32', 0)
with ui.loop(w, 0, 3):
    on = w.get().eq(wave)
    rect(w.get() * 40 + 8, 220, 32, 12, on.sel(ui.const('i32', 120), ui.const('i32', 50)).to('i8'), on.sel(ui.const('i32', 220), ui.const('i32', 54)).to('i8'), on.sel(ui.const('i32', 255), ui.const('i32', 70)).to('i8'))
with ui.if_(paused.ne(0)):
    rect(560, 215, 12, 24, 255, 180, 60); rect(580, 215, 12, 24, 255, 180, 60)
# 螢幕說明（HUD）：第 1 行＝真實狀態（播放／暫停、目前波形、BPM），第 2、3 行＝操作。狀態文字每幀依 paused／wave／bpm 重畫。
with ui.if_(paused.eq(0)):
    c('hud_text', ren, 8, 198, 'PLAYING', 7, 255, 210, 90)
with ui.if_(paused.ne(0)):
    c('hud_text', ren, 8, 198, 'PAUSED ', 7, 255, 210, 90)
with ui.if_(wave.eq(0)):
    c('hud_text', ren, 64, 198, 'SQUARE  ', 8, 255, 210, 90)
with ui.if_(wave.eq(1)):
    c('hud_text', ren, 64, 198, 'TRIANGLE', 8, 255, 210, 90)
with ui.if_(wave.eq(2)):
    c('hud_text', ren, 64, 198, 'SINE    ', 8, 255, 210, 90)
c('hud_int', ren, 127, 198, bpm, 255, 210, 90)
c('hud_text', ren, 155, 198, 'BPM', 3, 255, 210, 90)
c('hud_text', ren, 8, 244, 'SPACE PAUSE  1 2 3 WAVE', len('SPACE PAUSE  1 2 3 WAVE'), 220, 220, 220)
c('hud_text', ren, 8, 262, 'UP DOWN TEMPO', len('UP DOWN TEMPO'), 220, 220, 220)
ui.ret()

f = m.fn('i32', 'main', ('i32', 'argc'), ('ptr', 'argv'))
argc, argv = f.args
c = f.call
ev, spec, obt = f.array('i8', 56), f.array('i8', 32), f.array('i8', 32)
chunk = f.array('i8', 2048)
running, frames, maxf, paused, bpm, wave, pos, queued_total = [f.var('i32', x) for x in (1, 0, 0, 0, 110, 1, 0, 0)]
accp = f.alloca('i32'); accp.elem = 'i32'
with f.if_(argc > 1):
    argv.elem = 'ptr'
    maxf.set(c('atoi', f.load('ptr', argv.at(1))))
c('SDL_Init', 48)
win = c('SDL_CreateWindow', 'IR music player', 805240832, 805240832, 640, 280, 0)
ren = c('SDL_CreateRenderer', win, -1, 1)
for off in (0, 8, 16, 24):
    f.store('i64', 0, f.gep8(spec, off))
f.store('i32', RATE, spec)
f.store('i8', 0x10, f.gep8(spec, 4)); f.store('i8', -128, f.gep8(spec, 5)); f.store('i8', 1, f.gep8(spec, 6)); f.store('i8', 2, f.gep8(spec, 9))
dev = c('SDL_OpenAudioDevice', f.const('ptr', 0), 0, spec, obt, 0)
with f.if_(dev.ne(0)):
    c('SDL_PauseAudioDevice', dev, 0)


def rd(off):
    return f.load('i32', f.gep8(ev, off))


with f.while_(lambda: running.get().ne(0)):
    with f.while_(lambda: c('SDL_PollEvent', ev).ne(0)):
        ty = f.load('i32', ev)
        with f.if_(ty.eq(256)): running.set(0)
        with f.if_(ty.eq(768)):
            sc = rd(16)
            with f.if_(sc.eq(41)): running.set(0)
            with f.if_(sc.eq(44)): paused.set(f.const('i32', 1) - paused.get())
            with f.if_(sc.eq(82) & (bpm.get() < 200)): bpm += 10
            with f.if_(sc.eq(81) & (bpm.get() > 50)): bpm -= 10
            with f.if_(sc.eq(30)): wave.set(0)
            with f.if_(sc.eq(31)): wave.set(1)
            with f.if_(sc.eq(32)): wave.set(2)
            with f.if_(sc.eq(21)): pos.set(0)
    # 佇列裡少於 200 ms（8820 位元組）就再合成 1024 個取樣
    with f.if_(dev.ne(0) & paused.get().eq(0)):
        q = c('SDL_GetQueuedAudioSize', dev)
        with f.if_(q < 8820):
            spb = f.const('i32', RATE * 30) / bpm.get()    # 每半拍的取樣數＝RATE*60/bpm/2
            c('synth', chunk, 1024, pos.get(), spb, wave.get())
            c('SDL_QueueAudio', dev, chunk, 2048)
            pos += 1024
            queued_total += 1024
    spb2 = f.const('i32', RATE * 30) / bpm.get()
    tt = pos.get() % (spb2 * TOTAL)
    idx = c('note_idx', tt / spb2, accp)
    nt = V(f, '@notes', 'ptr', 'i32')
    prog_px = (tt * 640) / (spb2 * TOTAL)
    c('draw_ui', ren, nt[idx], prog_px, wave.get(), paused.get(), bpm.get())
    c('SDL_RenderPresent', ren); c('SDL_Delay', 16)
    frames += 1
    with f.if_((maxf.get() > 0) & (frames.get() >= maxf.get())): running.set(0)
c('printf', 'frames=%d samples=%d bpm=%d ok\n', frames.get(), queued_total.get(), bpm.get())
with f.if_(dev.ne(0)): c('SDL_CloseAudioDevice', dev)
c('SDL_DestroyRenderer', ren); c('SDL_DestroyWindow', win); c('SDL_Quit')
f.ret(0)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gui', 'music_player.ll')
open(out, 'w', encoding='utf-8').write(m.text() + "\n")
print('wrote', out)
