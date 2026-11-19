# -*- coding: utf-8 -*-
# 產生 ../gui/midi_player.ll：MIDI 播放器（SDL2 音訊＋影像＋鍵盤＋檔案）。在 IR 裡解析標準 MIDI 檔（SMF 格式 0／1：MThd／MTrk、變長時間、running status、tempo 表、note on/off），
# 即時合成（最多 12 個聲部的正弦）經 SDL_QueueAudio 送出，視窗畫捲動的 piano roll。第一個參數＝.mid 檔路徑（用 fopen 讀終端機沙盒或 /mnt/<名稱>）；沒給（或給 -）就播內嵌的示範曲。
# 空白＝暫停／繼續、R＝從頭、Esc 離開。第二個參數＝跑幾幀後離開（測試用）。
import sys, os, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _irb import *

RATE = 22050
MAXN, MAXT, MAXFILE, VOICES = 2048, 64, 24576, 12


# ---- 內嵌的示範曲：SMF 格式 1、division 480、三個 track（tempo、旋律、低音），旋律用 running status
def vlq(n):
    out = [n & 0x7f]
    n >>= 7
    while n:
        out.append((n & 0x7f) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def track(events):
    data = b"".join(events)
    return b"MTrk" + struct.pack(">I", len(data)) + data


mel = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62, 64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60]
dur = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 0.5, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 0.5, 2]
ev, first = [], True
for k, d in zip(mel, dur):
    ev.append(vlq(0) + (b"\x90" if first else b"") + bytes([k, 90]))       # note on（之後的事件省略狀態位元組：running status）
    first = False
    ev.append(vlq(int(d * 480) - 30) + bytes([k, 0]))                       # note on 力度 0＝note off（running status）
    ev.append(vlq(30) + bytes([k + 12, 0]))                                  # 一個沒開過的音的 off：解析器要忽略
t0 = track([vlq(0) + b"\xff\x51\x03" + struct.pack(">I", 500000)[1:], vlq(0) + b"\xff\x58\x04\x04\x02\x18\x08", vlq(0) + b"\xff\x2f\x00"])
t1 = track(ev + [vlq(0) + b"\xff\x2f\x00"])
bass = []
for k in (48, 55, 48, 55, 48, 55, 48, 55, 48, 55, 48, 55, 48, 55, 48):
    bass.append(vlq(0) + b"\x91" + bytes([k, 70])); bass.append(vlq(1920) + b"\x81" + bytes([k, 0]))
t2 = track(bass + [vlq(0) + b"\xff\x2f\x00"])
DEMO = b"MThd" + struct.pack(">IHHH", 6, 1, 3, 480) + t0 + t1 + t2

m = Mod('; MIDI 播放器（SDL2 音訊＋影像＋鍵盤＋檔案）：在 IR 裡解析標準 MIDI 檔（SMF 格式 0／1、變長時間、running status、tempo 表），即時合成（最多 12 聲部的正弦）\n'
        '; 經 SDL_QueueAudio 送出，視窗畫捲動的 piano roll。第一個參數＝.mid 檔（fopen 讀沙盒或 /mnt/<名稱>）；沒給就播內嵌示範曲。空白＝暫停、R＝從頭、Esc 離開；第二個參數＝跑幾幀後離開（測試用）。\n'
        '; （由 _gen/_gen_midi_player.py 產生）\ntarget triple = "x86_64-pc-linux-gnu"')
D = m.decl
D('i32', 'SDL_Init', 'i32'); D('void', 'SDL_Quit'); D('ptr', 'SDL_CreateWindow', 'ptr', 'i32', 'i32', 'i32', 'i32', 'i32'); D('ptr', 'SDL_CreateRenderer', 'ptr', 'i32', 'i32')
D('i32', 'SDL_PollEvent', 'ptr'); D('i32', 'SDL_SetRenderDrawColor', 'ptr', 'i8', 'i8', 'i8', 'i8'); D('i32', 'SDL_RenderClear', 'ptr'); D('i32', 'SDL_RenderFillRect', 'ptr', 'ptr')
D('void', 'SDL_RenderPresent', 'ptr'); D('void', 'SDL_Delay', 'i32'); D('void', 'SDL_DestroyRenderer', 'ptr'); D('void', 'SDL_DestroyWindow', 'ptr')
D('i32', 'SDL_OpenAudioDevice', 'ptr', 'i32', 'ptr', 'ptr', 'i32'); D('void', 'SDL_PauseAudioDevice', 'i32', 'i32'); D('i32', 'SDL_QueueAudio', 'i32', 'ptr', 'i32')
D('i32', 'SDL_GetQueuedAudioSize', 'i32'); D('void', 'SDL_CloseAudioDevice', 'i32')
D('ptr', 'fopen', 'ptr', 'ptr'); D('i64', 'fread', 'ptr', 'i64', 'i64', 'ptr'); D('i32', 'fclose', 'ptr')
D('double', 'sin', 'double'); D('double', 'pow', 'double', 'double'); D('i32', 'atoi', 'ptr'); D('i32', 'printf', 'ptr', varargs=True)
demo = m.const_bytes('demo', DEMO)


def byte(f, data, i):
    return data[i].to('i32') & 255


# 讀大端 16／32 位元
rd16 = m.fn('i32', 'rd16', ('ptr', 'd'), ('i32', 'i'))
d, i = rd16.args
d.elem = 'i8'
rd16.ret((byte(rd16, d, i) << 8) | byte(rd16, d, i + 1))
rd32 = m.fn('i32', 'rd32', ('ptr', 'd'), ('i32', 'i'))
d, i = rd32.args
d.elem = 'i8'
rd32.ret((byte(rd32, d, i) << 24) | (byte(rd32, d, i + 1) << 16) | (byte(rd32, d, i + 2) << 8) | byte(rd32, d, i + 3))
# 變長數字（VLQ）：從 posp[0] 讀，前進
vq = m.fn('i32', 'vlq', ('ptr', 'd'), ('ptr', 'posp'))
d, posp = vq.args
d.elem = 'i8'; posp.elem = 'i32'
val, more = vq.var('i32', 0), vq.var('i32', 1)
with vq.while_(lambda: more.get().ne(0)):
    b = byte(vq, d, posp[0])
    posp[0] = posp[0] + 1
    val.set((val.get() << 7) | (b & 127))
    with vq.if_((b & 128).eq(0)): more.set(0)
vq.ret(val.get())

# 解析整個檔：notes（起始 tick、結束 tick、音高、力度）、tempo 表（tick、微秒／四分音符）。回傳音符數；info[0]＝division、info[1]＝tempo 個數
parse = m.fn('i32', 'parse', ('ptr', 'd'), ('i32', 'len'), ('ptr', 'ns'), ('ptr', 'ne'), ('ptr', 'nk'), ('ptr', 'nv'), ('ptr', 'tt'), ('ptr', 'tm'), ('ptr', 'info'))
d, ln, ns, ne, nk, nv, tt, tm, info = parse.args
d.elem = 'i8'
for p_ in (ns, ne, nk, nv, tt, tm, info):
    p_.elem = 'i32'
c = parse.call
nn, nt = parse.var('i32', 0), parse.var('i32', 0)
pos, track_i, ntr = parse.var('i32', 0), parse.var('i32', 0), parse.var('i32', 0)
active = parse.array('i32', 2048)
posv = parse.alloca('i32'); posv.elem = 'i32'
with parse.if_(c('rd32', d, 0).ne(0x4d546864)):   # "MThd"
    parse.ret(-1)
info[0] = c('rd16', d, 12)
ntr.set(c('rd16', d, 10))
pos.set(14)
tick, status, end, ty, ln2 = [parse.var('i32', 0) for _ in range(5)]
k = parse.var('i32', 0)
with parse.loop(track_i, 0, ntr):
    with parse.if_((pos.get() + 8 > ln) | c('rd32', d, pos.get()).ne(0x4d54726b)):   # "MTrk"
        parse.ret(nn.get())
    tl = c('rd32', d, pos.get() + 4)
    pos += 8
    end.set(pos.get() + tl)
    with parse.if_(end.get() > ln): end.set(ln)
    tick.set(0); status.set(0)
    with parse.loop(k, 0, 2048): active[k.get()] = -1
    with parse.while_(lambda: pos.get() < end.get()):
        posv[0] = pos.get()
        tick += c('vlq', d, posv)
        pos.set(posv[0])
        b = byte(parse, d, pos.get())
        with parse.if_(b >= 128):
            status.set(b); pos += 1
        s = status.get()
        with parse.if_(s.eq(255)):                                  # meta
            ty.set(byte(parse, d, pos.get())); pos += 1
            posv[0] = pos.get(); ln2.set(c('vlq', d, posv)); pos.set(posv[0])
            with parse.if_(ty.get().eq(0x51) & (ln2.get() >= 3) & (nt.get() < MAXT)):
                tt[nt.get()] = tick.get()
                tm[nt.get()] = (byte(parse, d, pos.get()) << 16) | (byte(parse, d, pos.get() + 1) << 8) | byte(parse, d, pos.get() + 2)
                nt += 1
            pos += ln2.get()
            with parse.if_(ty.get().eq(0x2f)): parse.break_()
        with parse.if_((s.eq(240)) | (s.eq(247))):                  # sysex
            posv[0] = pos.get(); ln2.set(c('vlq', d, posv)); pos.set(posv[0] + ln2.get())
        with parse.if_(s < 240):
            hi, ch = s & 0xf0, s & 15
            one = (hi.eq(0xc0) | hi.eq(0xd0))
            key = byte(parse, d, pos.get())
            vel = one.sel(parse.const('i32', 0), byte(parse, d, pos.get() + 1))
            pos += one.sel(parse.const('i32', 1), parse.const('i32', 2))
            is_on = hi.eq(0x90) & vel.ne(0)
            is_off = hi.eq(0x80) | (hi.eq(0x90) & vel.eq(0))
            slot = ch * 128 + key
            with parse.if_(is_on & ch.ne(9)):
                active[slot] = tick.get()
                av = parse.alloca('i32')   # 力度記在高位元組：active 只記起始，力度另存（簡化：固定 90）
            with parse.if_(is_off & ch.ne(9) & (active[slot] >= 0) & (nn.get() < MAXN)):
                ns[nn.get()] = active[slot]; ne[nn.get()] = tick.get(); nk[nn.get()] = key; nv[nn.get()] = 90
                nn += 1
                active[slot] = -1
    pos.set(end.get())
info[1] = nt.get()
parse.ret(nn.get())

# tick → 取樣數（依 tempo 表分段累加；沒有 tempo 事件就是 500000＝120 BPM）
t2s = m.fn('i32', 't2s', ('i32', 'tick'), ('ptr', 'tt'), ('ptr', 'tm'), ('i32', 'nt'), ('i32', 'div'))
tick, tt, tm, nt, div = t2s.args
tt.elem = tm.elem = 'i32'
c = t2s.call
sec, last, tempo = t2s.var('double', 0.0), t2s.var('i32', 0), t2s.var('i32', 500000)
j = t2s.var('i32', 0)
with t2s.loop(j, 0, nt):
    with t2s.if_(tt[j.get()] < tick):
        sec += (tt[j.get()] - last.get()).to('double') * tempo.get().to('double') / (div.to('double') * 1000000.0)
        last.set(tt[j.get()]); tempo.set(tm[j.get()])
sec += (tick - last.get()).to('double') * tempo.get().to('double') / (div.to('double') * 1000000.0)
t2s.ret((sec.get() * float(RATE)).to('i32'))

# 合成一塊（n 個取樣，從 start）：找出和這一塊有重疊的音（最多 12 個聲部）再逐取樣相加
synth = m.fn('void', 'synth', ('ptr', 'buf'), ('i32', 'n'), ('i32', 'start'), ('ptr', 'ss'), ('ptr', 'se'), ('ptr', 'nk'), ('i32', 'cnt'))
buf, n, start, ss, se, nk, cnt = synth.args
buf.elem = 'i8'; ss.elem = se.elem = nk.elem = 'i32'
c = synth.call
vs, ve, vf = synth.array('i32', VOICES), synth.array('i32', VOICES), synth.array('double', VOICES)
nv_ = synth.var('i32', 0); i = synth.var('i32', 0); s = synth.var('i32', 0); v = synth.var('i32', 0)
with synth.loop(i, 0, cnt):
    with synth.if_((ss[i.get()] < start + n) & (se[i.get()] > start) & (nv_.get() < VOICES)):
        vs[nv_.get()] = ss[i.get()]; ve[nv_.get()] = se[i.get()]
        vf[nv_.get()] = c('pow', 2.0, (nk[i.get()] - 69).to('double') / 12.0) * 440.0
        nv_ += 1
acc = synth.var('double', 0.0)
with synth.loop(s, 0, n):
    acc.set(0.0)
    t = start + s.get()
    with synth.loop(v, 0, nv_):
        with synth.if_((t >= vs[v.get()]) & (t < ve[v.get()])):
            pos = (t - vs[v.get()]).to('double')
            att = pos / 150.0
            att = (att > 1.0).sel(synth.const('double', 1.0), att)
            rel = (ve[v.get()] - t).to('double') / 500.0
            rel = (rel > 1.0).sel(synth.const('double', 1.0), rel)
            acc += c('sin', pos * vf[v.get()] * 6.2831853 / float(RATE)) * att * rel * 2200.0
    x = acc.get().to('i32')
    x = (x > 30000).sel(synth.const('i32', 30000), (x < -30000).sel(synth.const('i32', -30000), x))
    buf[s.get() * 2] = (x & 255).to('i8'); buf[s.get() * 2 + 1] = ((x >> 8) & 255).to('i8')
synth.ret()

# piano roll：播放位置在 x=100，一秒 60 像素；音高 36..96 對應 y 240..0
ui = m.fn('void', 'draw_ui', ('ptr', 'ren'), ('i32', 'cur'), ('ptr', 'ss'), ('ptr', 'se'), ('ptr', 'nk'), ('i32', 'cnt'), ('i32', 'total'), ('i32', 'paused'))
ren, cur, ss, se, nk, cnt, total, paused = ui.args
ss.elem = se.elem = nk.elem = 'i32'
rc = ui.array('i32', 4)
c = ui.call


def rect(x, y, w, h, r, g, b):
    rc[0] = x; rc[1] = y; rc[2] = w; rc[3] = h
    c('SDL_SetRenderDrawColor', ren, r, g, b, 255)
    c('SDL_RenderFillRect', ren, rc)


c('SDL_SetRenderDrawColor', ren, 16, 18, 26, 255); c('SDL_RenderClear', ren)
drawn, i = ui.var('i32', 0), ui.var('i32', 0)
with ui.loop(i, 0, cnt):
    x0 = (ss[i.get()] - cur) * 60 / RATE + 100
    x1 = (se[i.get()] - cur) * 60 / RATE + 100
    with ui.if_((x1 > 0) & (x0 < 640) & (drawn.get() < 190)):
        y = (96 - nk[i.get()]) * 4 + 6
        playing = (ss[i.get()] <= cur) & (se[i.get()] > cur)
        rect(x0, y, (x1 - x0 > 2).sel(x1 - x0, ui.const('i32', 2)), 3, playing.sel(ui.const('i32', 255), ui.const('i32', 80)).to('i8'), playing.sel(ui.const('i32', 210), ui.const('i32', 170)).to('i8'), playing.sel(ui.const('i32', 80), ui.const('i32', 230)).to('i8'))
        drawn += 1
rect(100, 0, 1, 250, 255, 255, 255)
rect(0, 246, (cur * 640) / (total + 1), 4, 90, 200, 120)
with ui.if_(paused.ne(0)):
    rect(590, 10, 8, 20, 255, 180, 60); rect(606, 10, 8, 20, 255, 180, 60)
ui.ret()

f = m.fn('i32', 'main', ('i32', 'argc'), ('ptr', 'argv'))
argc, argv = f.args
c = f.call
data = f.array('i8', MAXFILE)
ev, spec, obt, chunk = f.array('i8', 56), f.array('i8', 32), f.array('i8', 32), f.array('i8', 2048)
ns, ne, nk, nvv = [f.array('i32', MAXN) for _ in range(4)]
ss, se = f.array('i32', MAXN), f.array('i32', MAXN)
tt, tm, info = f.array('i32', MAXT), f.array('i32', MAXT), f.array('i32', 4)
running, frames, maxf, paused, cur, qtotal, flen = [f.var('i32', x) for x in (1, 0, 0, 0, 0, 0, 0)]
argv.elem = 'ptr'
with f.if_(argc > 2):
    maxf.set(c('atoi', f.load('ptr', argv.at(2))))
path = f.var('ptr', 0)
with f.if_(argc > 1):
    path.set(f.load('ptr', argv.at(1)))
usefile = f.var('i32', 0)
with f.if_(argc > 1):
    p1 = f.load('ptr', argv.at(1)); p1.elem = 'i8'
    with f.if_((p1[0].to('i32') & 255).ne(45)): usefile.set(1)     # 第一個參數是 "-" 就用內嵌示範曲
with f.if_(usefile.get().ne(0)):   # 從檔案讀
    fp = c('fopen', path.get(), 'rb')
    with f.if_(fp.ne(f.const('ptr', 0))):
        flen.set(c('fread', data, 1, MAXFILE, fp).to('i32'))
        c('fclose', fp)
    with f.if_(fp.eq(f.const('ptr', 0))):
        c('printf', 'cannot open %s\n', path.get())
        f.ret(1)
with f.if_(flen.get().eq(0)):   # 沒給檔案：內嵌示範曲
    k = f.var('i32', 0)
    demo_p = V(f, demo, 'ptr', 'i8')
    with f.loop(k, 0, len(DEMO)):
        data[k.get()] = demo_p[k.get()]
    flen.set(len(DEMO))
cnt = c('parse', data, flen.get(), ns, ne, nk, nvv, tt, tm, info)
with f.if_(cnt < 0):
    c('printf', 'not a MIDI file\n'); f.ret(1)
total = f.var('i32', 0); i = f.var('i32', 0)
with f.loop(i, 0, cnt):
    ss[i.get()] = c('t2s', ns[i.get()], tt, tm, info[1], info[0])
    se[i.get()] = c('t2s', ne[i.get()], tt, tm, info[1], info[0])
    with f.if_(se[i.get()] > total.get()): total.set(se[i.get()])
c('SDL_Init', 48)
win = c('SDL_CreateWindow', 'IR MIDI player', 805240832, 805240832, 640, 250, 0)
ren = c('SDL_CreateRenderer', win, -1, 1)
for off in (0, 8, 16, 24):
    f.store('i64', 0, f.gep8(spec, off))
f.store('i32', RATE, spec); f.store('i8', 0x10, f.gep8(spec, 4)); f.store('i8', -128, f.gep8(spec, 5)); f.store('i8', 1, f.gep8(spec, 6)); f.store('i8', 2, f.gep8(spec, 9))
dev = c('SDL_OpenAudioDevice', f.const('ptr', 0), 0, spec, obt, 0)
with f.if_(dev.ne(0)): c('SDL_PauseAudioDevice', dev, 0)


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
            with f.if_(sc.eq(21)): cur.set(0)
    with f.if_(dev.ne(0) & paused.get().eq(0)):
        q = c('SDL_GetQueuedAudioSize', dev)
        with f.if_(q < 8820):
            c('synth', chunk, 1024, cur.get(), ss, se, nk, cnt)
            c('SDL_QueueAudio', dev, chunk, 2048)
            cur += 1024
            qtotal += 1024
            with f.if_(cur.get() > total.get() + RATE): cur.set(0)   # 播完從頭
    c('draw_ui', ren, cur.get(), ss, se, nk, cnt, total.get(), paused.get())
    c('SDL_RenderPresent', ren); c('SDL_Delay', 16)
    frames += 1
    with f.if_((maxf.get() > 0) & (frames.get() >= maxf.get())): running.set(0)
c('printf', 'notes=%d tempos=%d div=%d seconds=%d played=%d ok\n', cnt, info[1], info[0], total.get() / RATE, qtotal.get())
with f.if_(dev.ne(0)): c('SDL_CloseAudioDevice', dev)
c('SDL_DestroyRenderer', ren); c('SDL_DestroyWindow', win); c('SDL_Quit')
f.ret(0)
base = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
open(os.path.join(base, 'gui', 'midi_player.ll'), 'w', encoding='utf-8').write(m.text() + "\n")
open(os.path.join(base, 'gui', 'demo.mid'), 'wb').write(DEMO)   # 內嵌示範曲的同一份 .mid 檔（可用 lli gui/midi_player.ll gui/demo.mid 走 fopen 的路）
print('wrote midi_player.ll and demo.mid (%d bytes); expected notes: %d' % (len(DEMO), len(mel) + 15))
