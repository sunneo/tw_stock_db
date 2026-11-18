# -*- coding: utf-8 -*-
# 音樂盒／小型音序器：用 gui 的合成嗶聲（tone）演奏內建旋律，也能點琴鍵自己彈。
#
# 操作方式：
#   * 「播放／暫停」開始或暫停（空白鍵也可以，需先點一下琴鍵畫布取得鍵盤焦點）；「停止」回到開頭。
#   * 左側清單選歌；「速度 −／+」調每分鐘拍數（BPM）；「波形」清單選 sine、square、triangle、sawtooth；可勾選循環。
#   * 用滑鼠點畫布上的琴鍵會發聲；鍵盤 a s d f g h j 是 C4 到 B4 的白鍵、w e t y u 是黑鍵。
#   * 進度條與畫布上方的細條顯示目前播放到哪裡，正在響的音符所在琴鍵會亮起來。
#
# 用到的限制與繞法：
#   * tone 只能播一個短嗶聲而且立刻返回，沒有排程。所以節奏要自己算：迴圈裡用 time.monotonic() 換算成「拍」，
#     時間到了才呼叫 tone。每個音的長度（毫秒）由拍數與 BPM 算出，上限 2000 毫秒。
#   * 畫布每幀最多 200 道指令；兩個八度共 24 個鍵、再加幾條線與文字，遠低於上限。
#   * 事件迴圈用 poll()（不等待）加 time.sleep(0.03)，約每秒 30 次重畫與檢查時間。
import time

import gui

W, H = 560, 220
LOW = 60                     # 畫布上最左邊的白鍵是 C4（MIDI 60），共兩個八度（到 B5 = 83）
WHITE_STEPS = (0, 2, 4, 5, 7, 9, 11)
BLACK_AFTER = {0: 1, 1: 3, 3: 6, 4: 8, 5: 10}   # 白鍵序（0=C）右側的黑鍵相對半音
WAVES = ["sine", "square", "triangle", "sawtooth"]
KEY_MAP = {"a": 60, "s": 62, "d": 64, "f": 65, "g": 67, "h": 69, "j": 71,
           "w": 61, "e": 63, "t": 66, "y": 68, "u": 70}
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# 旋律用文字寫：「音名八度:拍數」，R 是休止；音名如 C4、F#4、Bb3。
SONGS = {
    "小星星": "C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2 "
              "G4:1 G4:1 F4:1 F4:1 E4:1 E4:1 D4:2 G4:1 G4:1 F4:1 F4:1 E4:1 E4:1 D4:2 "
              "C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2",
    "歡樂頌": "E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 E4:1.5 D4:0.5 D4:2 "
              "E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 D4:1.5 C4:0.5 C4:2",
    "兩隻老虎": "C4:1 D4:1 E4:1 C4:1 C4:1 D4:1 E4:1 C4:1 E4:1 F4:1 G4:2 E4:1 F4:1 G4:2 "
              "G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4:1 C4:1 G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4:1 C4:1 C4:1 G4:1 C4:2",
    "給愛麗絲": "E5:0.5 D#5:0.5 E5:0.5 D#5:0.5 E5:0.5 B4:0.5 D5:0.5 C5:0.5 A4:1.5 R:0.5 "
              "C4:0.5 E4:0.5 A4:0.5 B4:1.5 R:0.5 E4:0.5 G#4:0.5 B4:0.5 C5:1.5 R:0.5 "
              "E4:0.5 E5:0.5 D#5:0.5 E5:0.5 D#5:0.5 E5:0.5 B4:0.5 D5:0.5 C5:0.5 A4:1.5",
}


# ---------- 純函式 ----------
def note_to_midi(name):
    """'C4' -> 60、'F#4' -> 66、'Bb3' -> 58；'R' 是休止，回傳 None。"""
    if name.upper() == "R":
        return None
    letter = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[name[0].upper()]
    rest = name[1:]
    if rest[:1] == "#":
        letter, rest = letter + 1, rest[1:]
    elif rest[:1] == "b":
        letter, rest = letter - 1, rest[1:]
    return 12 * (int(rest) + 1) + letter


def midi_to_freq(n):
    return 440.0 * 2 ** ((n - 69) / 12.0)


def parse_melody(text):
    """'C4:1 R:0.5' -> [(60, 1.0), (None, 0.5)]；回傳（音高或 None, 拍數）的列表。"""
    out = []
    for token in text.split():
        name, _, beats = token.partition(":")
        out.append((note_to_midi(name), float(beats or 1)))
    return out


def schedule(melody):
    """加上起始拍：[(start_beat, midi, beats), ...]，並回傳全曲總拍數。"""
    events, t = [], 0.0
    for midi, beats in melody:
        events.append((t, midi, beats))
        t += beats
    return events, t


def beats_to_ms(beats, bpm):
    return max(10, min(2000, int(beats * 60000.0 / bpm * 0.92)))   # 乘 0.92 讓相鄰同音有一點空隙


def due_events(events, last_beat, now_beat):
    """起始拍落在 (last_beat, now_beat] 之間的音符；第一次呼叫用 last_beat = -1 把第 0 拍包含進來。"""
    return [e for e in events if last_beat < e[0] <= now_beat]


def key_rects(low=LOW, octaves=2, x0=10, y0=40, kw=38, kh=150):
    """回傳 [(midi, x, y, w, h, 是黑鍵)]，白鍵在前、黑鍵在後（畫的時候黑鍵蓋在上面）。"""
    whites, blacks = [], []
    for o in range(octaves):
        for i, step in enumerate(WHITE_STEPS):
            x = x0 + (o * 7 + i) * kw
            whites.append((low + o * 12 + step, x, y0, kw, kh, False))
            if i in BLACK_AFTER:
                blacks.append((low + o * 12 + BLACK_AFTER[i], x + kw - kw // 3 + 1, y0, kw * 2 // 3 - 2, kh * 3 // 5, True))
    return whites + blacks


def key_at(rects, x, y):
    """點到哪個琴鍵（黑鍵優先，因為它畫在上面）；沒點到回傳 None。"""
    for midi, kx, ky, kw, kh, black in reversed(rects):
        if kx <= x < kx + kw and ky <= y < ky + kh:
            return midi
    return None


# ---------- 程式本體 ----------
class Player(object):
    def __init__(self):
        w = self.w = gui.Window("音樂盒", width=640, height=470, resizable=True)
        w.theme(palette={"accent": "#7c5cff"})
        body = w.row(grow=1, gap=8)
        side = w.column(parent=body, gap=6)
        w.label("曲目", parent=side)
        self.song_list = w.list(list(SONGS), selected="小星星", rows=4, parent=side)
        w.label("波形", parent=side)
        self.wave_list = w.list(WAVES, selected="square", rows=4, parent=side)
        self.loop_box = w.checkbox("循環播放", parent=side)
        main = w.column(parent=body, grow=1, gap=6)
        self.cv = w.canvas(W, H, fps=0, parent=main, fit=True, grow=1)
        self.progress = w.progress(0, 100, parent=main)
        bar = w.row(parent=main, gap=6)
        self.play_btn = w.button("▶ 播放", parent=bar)
        self.stop_btn = w.button("■ 停止", parent=bar)
        self.slower = w.button("速度 −", parent=bar)
        self.faster = w.button("速度 +", parent=bar)
        self.info = w.label("", parent=main)

        self.bpm = 120
        self.wave = "square"
        self.rects = key_rects()
        self.lit = {}            # midi -> 熄滅的時間點（time.monotonic），讓琴鍵亮一小段時間
        self.playing = False
        self.pos_beats = 0.0     # 目前播放位置（拍）
        self.last_beat = -1.0
        self.t_ref = 0.0
        self.load_song("小星星")
        self.last_pct = -1

    def load_song(self, name):
        self.events, self.total = schedule(parse_melody(SONGS[name]))
        self.pos_beats, self.last_beat, self.playing = 0.0, -1.0, False
        self.w.set(self.play_btn, text="▶ 播放")

    def play_note(self, midi, beats=0.5):
        self.w.tone(midi_to_freq(midi), beats_to_ms(beats, self.bpm), self.wave)
        self.lit[midi] = time.monotonic() + max(0.12, beats * 60.0 / self.bpm)

    def toggle(self):
        if self.playing:
            self.playing = False
            self.w.set(self.play_btn, text="▶ 播放")
        else:
            if self.pos_beats >= self.total:
                self.pos_beats, self.last_beat = 0.0, -1.0
            self.t_ref = time.monotonic() - self.pos_beats * 60.0 / self.bpm
            self.playing = True
            self.w.set(self.play_btn, text="⏸ 暫停")

    def stop(self):
        self.playing = False
        self.pos_beats, self.last_beat = 0.0, -1.0
        self.w.set(self.play_btn, text="▶ 播放")

    def change_bpm(self, delta):
        self.bpm = max(40, min(240, self.bpm + delta))
        self.t_ref = time.monotonic() - self.pos_beats * 60.0 / self.bpm   # 換速度後從同一拍接著走

    def tick(self):
        """播放中：把時間換成拍，發出到期的音符；播完就停或循環。"""
        if not self.playing:
            return
        now_beat = (time.monotonic() - self.t_ref) * self.bpm / 60.0
        for _, midi, beats in due_events(self.events, self.last_beat, now_beat):
            if midi is not None:
                self.play_note(midi, beats)
        self.last_beat = now_beat
        self.pos_beats = now_beat
        if now_beat >= self.total:
            if self.w.value(self.loop_box):
                self.pos_beats, self.last_beat = 0.0, -1.0
                self.t_ref = time.monotonic()
            else:
                self.playing = False
                self.pos_beats = self.total
                self.w.set(self.play_btn, text="▶ 播放")

    def handle(self, ev):
        kind, node, val = ev.get("event"), ev.get("node"), ev.get("value")
        if kind == "click":
            {self.play_btn: self.toggle, self.stop_btn: self.stop,
             self.slower: lambda: self.change_bpm(-10), self.faster: lambda: self.change_bpm(10)}.get(node, lambda: None)()
        elif kind == "select":
            if node == self.song_list and val in SONGS:
                self.load_song(val)
            elif node == self.wave_list and val in WAVES:
                self.wave = val
        elif kind == "mouse" and val.get("kind") == "down" and val.get("button") == 0:
            midi = key_at(self.rects, val["x"], val["y"])
            if midi is not None:
                self.play_note(midi)
        elif kind == "key" and val.get("down"):
            key = str(val.get("key"))
            if key == " ":
                self.toggle()
            elif key in KEY_MAP:
                self.play_note(KEY_MAP[key])

    def draw(self):
        now = time.monotonic()
        playing_now = {m for s, m, b in self.events if m is not None and s <= self.pos_beats < s + b} if self.playing else set()
        ops = [["clear", "#1b1b26"], ["text", 12, 8, "%s  ·  %d BPM  ·  %s" % (self.w.value(self.song_list), self.bpm, self.wave), "#e8e8f0"]]
        frac = min(1.0, self.pos_beats / self.total) if self.total else 0
        ops += [["rect", 10, 28, W - 20, 6, "#34344a"], ["rect", 10, 28, int((W - 20) * frac), 6, "#7c5cff"]]
        for midi, x, y, kw, kh, black in self.rects:
            lit = midi in playing_now or self.lit.get(midi, 0) > now
            color = ("#7c5cff" if lit else "#111111") if black else ("#c9bcff" if lit else "#f4f4f4")
            ops.append(["rect", x, y, kw - 1, kh, color])
            if not black and midi % 12 == 0:
                ops.append(["text", x + 4, y + kh - 18, "C%d" % (midi // 12 - 1), "#555555"])
        self.w.draw(self.cv, ops)
        pct = int(frac * 100)
        if pct != self.last_pct:
            self.last_pct = pct
            self.w.set(self.progress, value=pct)
            self.w.set(self.info, text="第 %.1f / %.1f 拍" % (self.pos_beats, self.total))

    def run(self):
        while True:
            ev = self.w.poll()
            if ev is None:
                self.tick()
                self.draw()
                time.sleep(0.03)
            elif ev.get("event") == "close":
                break
            else:
                self.handle(ev)
        self.w.close()


if __name__ == "__main__":
    Player().run()
