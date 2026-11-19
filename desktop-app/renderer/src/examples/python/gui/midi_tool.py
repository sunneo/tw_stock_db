# -*- coding: utf-8 -*-
# MIDI 小工具：純 Python 寫出標準 MIDI 檔（SMF format 0 / 1，多音軌、tempo）、讀回並解析成事件表，
# 用 tone 播放，並在鋼琴捲簾（piano roll）畫布上顯示音符。
#
# 操作方式：
#   * 「寫出 format 0」「寫出 format 1」：把內建的兩聲部小曲（旋律＋低音，中途有 tempo 變化）編成 .mid 存到工作資料夾，
#     接著立刻從檔案讀回來解析（等於一次往返驗證），事件列在左側表格，音符畫在右側捲簾。
#   * 「開啟 .mid」：用檔案選擇對話框讀別人的 MIDI 檔（不限大小）。
#   * 「播放／停止」用 tone 的嗶聲演奏；波形清單可換音色。「◀ ▶」左右捲動捲簾，「速度」不影響檔案只影響播放。
#
# 用到的限制與繞法：
#   * tone 一次一個短嗶聲、沒有聲部與力度，多音軌只是把所有音符依時間排好各自發聲；同時很多音會有點雜，是預期的。
#   * 畫布每幀 ≤ 200 道指令：捲簾只畫目前視窗內的音符，最多 150 個矩形，超過的略過（標題會寫「已省略」）。
#   * 表格最多顯示前 300 個事件，避免節點資料過大。
#   * 讀 MIDI 時支援 running status、meta 事件（tempo、拍號、軌名、結束）、sysex（略過）。
import os
import struct
import tempfile
import time

import gui

WORK = "/work" if os.path.isdir("/work") else tempfile.gettempdir()
W, H = 560, 300
MAX_ROWS = 300
MAX_RECTS = 150
WAVES = ["sine", "square", "triangle", "sawtooth"]
TRACK_COLORS = ["#4fc3f7", "#ffb74d", "#81c784", "#ba68c8"]


# ---------- SMF 寫出（純函式） ----------
def vlq(n):
    """可變長度整數：每位元組 7 位，最後一個位元組最高位為 0。"""
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def encode_event(ev):
    """事件用 dict 表示：{"tick", "type", ...}。type: note_on/note_off（ch, note, vel）、program（ch, program）、
    tempo（us_per_beat）、time_sig（num, den_pow2）、track_name（text）。回傳不含 delta time 的位元組。"""
    t = ev["type"]
    if t == "note_on":
        return bytes([0x90 | ev["ch"], ev["note"], ev["vel"]])
    if t == "note_off":
        return bytes([0x80 | ev["ch"], ev["note"], ev["vel"]])
    if t == "program":
        return bytes([0xC0 | ev["ch"], ev["program"]])
    if t == "tempo":
        return b"\xFF\x51\x03" + ev["us"].to_bytes(3, "big")
    if t == "time_sig":
        return b"\xFF\x58\x04" + bytes([ev["num"], ev["den_pow2"], 24, 8])
    if t == "track_name":
        raw = ev["text"].encode("utf-8")
        return b"\xFF\x03" + vlq(len(raw)) + raw
    raise ValueError("不認得的事件 %r" % t)


def encode_track(events):
    """events 依 tick 排序後逐一寫出 delta time，最後加上結束事件 FF 2F 00。"""
    body, last = b"", 0
    order = {"track_name": 0, "tempo": 1, "time_sig": 1, "program": 2, "note_off": 3, "note_on": 4}
    for ev in sorted(events, key=lambda e: (e["tick"], order[e["type"]])):
        body += vlq(ev["tick"] - last) + encode_event(ev)
        last = ev["tick"]
    body += vlq(0) + b"\xFF\x2F\x00"
    return b"MTrk" + struct.pack(">I", len(body)) + body


def write_smf(fmt, division, tracks):
    """tracks：每條音軌是事件 dict 的列表。format 0 只能有一條音軌。"""
    if fmt == 0 and len(tracks) != 1:
        raise ValueError("format 0 只能有一條音軌")
    head = b"MThd" + struct.pack(">IHHH", 6, fmt, len(tracks), division)
    return head + b"".join(encode_track(t) for t in tracks)


# ---------- SMF 讀回（純函式） ----------
def read_vlq(data, pos):
    value = 0
    while True:
        b = data[pos]
        pos += 1
        value = (value << 7) | (b & 0x7F)
        if not b & 0x80:
            return value, pos


def parse_track(body):
    events, pos, tick, status = [], 0, 0, 0
    while pos < len(body):
        delta, pos = read_vlq(body, pos)
        tick += delta
        b = body[pos]
        if b == 0xFF:                      # meta 事件
            mtype = body[pos + 1]
            length, pos = read_vlq(body, pos + 2)
            payload = body[pos:pos + length]
            pos += length
            if mtype == 0x51:
                events.append({"tick": tick, "type": "tempo", "us": int.from_bytes(payload, "big")})
            elif mtype == 0x58:
                events.append({"tick": tick, "type": "time_sig", "num": payload[0], "den_pow2": payload[1]})
            elif mtype == 0x03:
                events.append({"tick": tick, "type": "track_name", "text": payload.decode("utf-8", "replace")})
            elif mtype == 0x2F:
                break
            continue
        if b in (0xF0, 0xF7):              # sysex：略過
            length, pos = read_vlq(body, pos + 1)
            pos += length
            continue
        if b & 0x80:                       # 新的狀態位元組；沒有的話沿用上一個（running status）
            status = b
            pos += 1
        kind, ch = status & 0xF0, status & 0x0F
        if kind in (0xC0, 0xD0):
            arg = body[pos]
            pos += 1
            if kind == 0xC0:
                events.append({"tick": tick, "type": "program", "ch": ch, "program": arg})
        else:
            a, c = body[pos], body[pos + 1]
            pos += 2
            if kind == 0x90 and c > 0:
                events.append({"tick": tick, "type": "note_on", "ch": ch, "note": a, "vel": c})
            elif kind in (0x80, 0x90):     # note on 力度 0 等同 note off
                events.append({"tick": tick, "type": "note_off", "ch": ch, "note": a, "vel": c})
    return events


def parse_smf(data):
    """回傳 {"format", "division", "tracks": [事件列表, ...]}；格式錯誤丟 ValueError。"""
    if data[:4] != b"MThd":
        raise ValueError("不是 MIDI 檔（缺少 MThd）")
    _, fmt, ntrk, division = struct.unpack(">IHHH", data[4:14])
    if division & 0x8000:
        raise ValueError("不支援 SMPTE 時間格式")
    pos, tracks = 14, []
    while pos + 8 <= len(data) and len(tracks) < ntrk:
        tag, length = data[pos:pos + 4], struct.unpack(">I", data[pos + 4:pos + 8])[0]
        if tag == b"MTrk":
            tracks.append(parse_track(data[pos + 8:pos + 8 + length]))
        pos += 8 + length
    return {"format": fmt, "division": division, "tracks": tracks}


# ---------- 音符與時間換算（純函式） ----------
def tempo_map(tracks):
    """[(tick, us_per_beat)]，一定從 tick 0 開始（預設 120 BPM = 500000）。"""
    pts = sorted((e["tick"], e["us"]) for t in tracks for e in t if e["type"] == "tempo")
    return [(0, 500000)] + [p for p in pts if p[0] > 0] if not pts or pts[0][0] > 0 else pts


def tick_to_seconds(tmap, division, tick):
    sec, prev_tick, us = 0.0, 0, tmap[0][1]
    for t, new_us in tmap[1:]:
        if t >= tick:
            break
        sec += (t - prev_tick) * us / division / 1e6
        prev_tick, us = t, new_us
    return sec + (tick - prev_tick) * us / division / 1e6


def extract_notes(tracks):
    """把 note_on／note_off 配對成 (起始 tick, 長度 tick, 音高, 力度, 音軌序)，依起始時間排序。"""
    notes = []
    for ti, track in enumerate(tracks):
        open_notes = {}
        for e in sorted(track, key=lambda e: e["tick"]):
            key = (e.get("ch"), e.get("note"))
            if e["type"] == "note_on":
                open_notes.setdefault(key, []).append(e)
            elif e["type"] == "note_off" and open_notes.get(key):
                on = open_notes[key].pop(0)
                notes.append((on["tick"], e["tick"] - on["tick"], on["note"], on["vel"], ti))
    return sorted(notes)


def describe(e):
    t = e["type"]
    if t in ("note_on", "note_off"):
        return t, "ch%d 音高 %d 力度 %d" % (e["ch"] + 1, e["note"], e["vel"])
    if t == "tempo":
        return t, "%d BPM（%d µs/拍）" % (round(6e7 / e["us"]), e["us"])
    if t == "time_sig":
        return t, "%d/%d" % (e["num"], 2 ** e["den_pow2"])
    if t == "track_name":
        return t, e["text"]
    return t, "ch%d 音色 %d" % (e["ch"] + 1, e["program"])


# ---------- 內建範例曲 ----------
def demo_tracks(fmt, division=480):
    """旋律（音軌 A）與低音（音軌 B）。format 0 時合併成一條；format 1 另有一條放 tempo 的速度軌。第 3 小節起減速。"""
    melody = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60, 60]
    mel, bass = [{"tick": 0, "type": "track_name", "text": "旋律"}, {"tick": 0, "type": "program", "ch": 0, "program": 0}], \
                [{"tick": 0, "type": "track_name", "text": "低音"}, {"tick": 0, "type": "program", "ch": 1, "program": 32}]
    for i, n in enumerate(melody):
        t = i * division // 2
        mel += [{"tick": t, "type": "note_on", "ch": 0, "note": n, "vel": 90},
                {"tick": t + division // 2 - 20, "type": "note_off", "ch": 0, "note": n, "vel": 0}]
    for i, n in enumerate([48, 55, 48, 55, 53, 55, 48, 48]):
        t = i * division
        bass += [{"tick": t, "type": "note_on", "ch": 1, "note": n, "vel": 70},
                 {"tick": t + division - 30, "type": "note_off", "ch": 1, "note": n, "vel": 0}]
    meta = [{"tick": 0, "type": "tempo", "us": 500000}, {"tick": 0, "type": "time_sig", "num": 4, "den_pow2": 2},
            {"tick": 4 * division, "type": "tempo", "us": 700000}]
    if fmt == 0:
        return [meta + mel + bass]
    return [meta, mel, bass]


def roll_layout(notes, view_start, view_len, lo=48, hi=84, x0=34, plot_w=None, plot_h=None):
    """把視窗內的音符換成矩形 (x, y, w, h, 音軌序, 起始 tick)；超出 MAX_RECTS 的略過，回傳（矩形列表, 略過數）。"""
    plot_w = plot_w or W - x0 - 6
    plot_h = plot_h or H - 50
    rows, rects, skipped = hi - lo + 1, [], 0
    for start, length, pitch, vel, ti in notes:
        if start + length < view_start or start > view_start + view_len or not lo <= pitch <= hi:
            continue
        if len(rects) >= MAX_RECTS:
            skipped += 1
            continue
        x = x0 + (max(start, view_start) - view_start) * plot_w / view_len
        end = x0 + min(start + length - view_start, view_len) * plot_w / view_len
        row_h = plot_h / rows
        rects.append((int(x), int(30 + (hi - pitch) * row_h), max(2, int(end - x)), max(2, int(row_h) - 1), ti, start))
    return rects, skipped


# ---------- 程式本體 ----------
class MidiTool(object):
    def __init__(self):
        w = self.w = gui.Window("MIDI 小工具", width=900, height=520, resizable=True)
        bar = w.row(gap=6, role="toolbar")
        self.b0 = w.button("寫出 format 0", parent=bar)
        self.b1 = w.button("寫出 format 1", parent=bar)
        self.bopen = w.filepick("開啟 .mid", accept=".mid,.midi", parent=bar)
        self.bplay = w.button("▶ 播放", parent=bar)
        self.bstop = w.button("■ 停止", parent=bar)
        self.bleft = w.button("◀", parent=bar)
        self.bright = w.button("▶", parent=bar)
        self.wave_box = w.list(WAVES, selected="triangle", rows=2, parent=bar)
        body = w.split("row", 40, grow=1)
        self.table = w.table(["音軌", "tick", "事件", "內容"], [], parent=body)
        right = w.column(parent=body, gap=4)
        self.cv = w.canvas(W, H, parent=right, fit=True, grow=1)
        self.info = w.label("按「寫出 format 1」開始", parent=right)
        self.midi = None
        self.notes, self.total_ticks = [], 1
        self.view_start, self.view_len = 0, 1
        self.play_t0 = None       # 播放開始的時間點；None 表示沒有在播
        self.play_queue = []      # [(秒, 音高)]
        self.play_pos = 0.0
        self.export("format1.mid", 1)

    def export(self, name, fmt):
        """寫檔、再從檔案讀回來解析：畫面顯示的是「讀回的結果」，不是原始資料。"""
        path = os.path.join(WORK, name)
        data = write_smf(fmt, 480, demo_tracks(fmt))
        with open(path, "wb") as f:
            f.write(data)
        with open(path, "rb") as f:
            self.load(f.read(), "%s（%d 位元組）" % (path, len(data)))

    def load(self, data, label):
        try:
            self.midi = parse_smf(data)
        except (ValueError, IndexError, struct.error) as e:
            self.w.set(self.info, text="解析失敗：%s" % e)
            return
        m = self.midi
        self.notes = extract_notes(m["tracks"])
        self.total_ticks = max([n[0] + n[1] for n in self.notes] or [1])
        self.view_start, self.view_len = 0, max(m["division"] * 8, 1)
        self.stop()
        rows = []
        for ti, track in enumerate(m["tracks"]):
            for e in track:
                kind, text = describe(e)
                rows.append([str(ti), str(e["tick"]), kind, text])
        shown = rows[:MAX_ROWS]
        self.w.set(self.table, rows=shown)
        self.w.set(self.info, text="%s｜format %d，%d 條音軌，division %d，%d 個音符，共 %d 個事件%s" % (
            label, m["format"], len(m["tracks"]), m["division"], len(self.notes), len(rows),
            "（表格只列前 %d 個）" % MAX_ROWS if len(rows) > MAX_ROWS else ""))

    def open_file(self, ev):
        try:
            got = self.w.pick_files(ev)
        except Exception as e:
            self.w.set(self.info, text="無法開啟：%s" % e)
            return
        if not got or not got[0]:
            return
        f = got[0][0]
        with open(f["ref"], "rb") as fh:
            self.load(fh.read(), f["name"])

    def start(self):
        if not self.midi:
            return
        tmap, div = tempo_map(self.midi["tracks"]), self.midi["division"]
        self.play_queue = [(tick_to_seconds(tmap, div, n[0]), n[2], tick_to_seconds(tmap, div, n[0] + n[1]) - tick_to_seconds(tmap, div, n[0]))
                           for n in self.notes]
        self.play_end = tick_to_seconds(tmap, div, self.total_ticks)
        self.tmap = tmap
        self.play_t0 = time.monotonic()

    def stop(self):
        self.play_t0 = None
        self.play_queue = []
        self.play_pos = 0.0

    def tick_play(self):
        if self.play_t0 is None:
            return
        now = time.monotonic() - self.play_t0
        while self.play_queue and self.play_queue[0][0] <= now:
            _, pitch, dur = self.play_queue.pop(0)
            self.w.tone(440.0 * 2 ** ((pitch - 69) / 12.0), max(30, min(2000, int(dur * 1000))), self.w.value(self.wave_box) or "triangle")
        self.play_pos = now
        if now > self.play_end + 0.3:
            self.stop()

    def playhead_x(self):
        """目前播放秒數換回 tick，再換成畫布上的 x；不在視窗內回傳 None。"""
        if self.play_t0 is None or not self.midi:
            return None
        div, tmap = self.midi["division"], self.tmap
        lo, hi = 0, self.total_ticks * 2
        for _ in range(30):                        # 二分搜尋：找出秒數對應的 tick
            mid = (lo + hi) / 2.0
            lo, hi = (mid, hi) if tick_to_seconds(tmap, div, mid) < self.play_pos else (lo, mid)
        frac = (lo - self.view_start) / self.view_len
        return 34 + frac * (W - 40) if 0 <= frac <= 1 else None

    def draw(self):
        ops = [["clear", "#15151d"]]
        for pitch in range(48, 85):                # 背景橫線：每個 C 畫一條並標音名
            if pitch % 12 == 0:
                y = int(30 + (84 - pitch) * (H - 50) / 37.0)
                ops += [["line", 34, y, W - 6, y, "#33334a"], ["text", 4, y - 6, "C%d" % (pitch // 12 - 1), "#8888aa"]]
        beat = self.midi["division"] if self.midi else 480
        first = -(-self.view_start // beat)
        for b in range(first, (self.view_start + self.view_len) // beat + 1):   # 每拍一條直線
            x = int(34 + (b * beat - self.view_start) * (W - 40) / self.view_len)
            ops.append(["line", x, 30, x, H - 20, "#262636"])
        rects, skipped = roll_layout(self.notes, self.view_start, self.view_len)
        for x, y, rw, rh, ti, _ in rects:
            ops.append(["rect", x, y, rw, rh, TRACK_COLORS[ti % len(TRACK_COLORS)]])
        px = self.playhead_x()
        if px is not None:
            ops.append(["line", int(px), 30, int(px), H - 20, "#ff5252"])
        title = "鋼琴捲簾　tick %d 起，視窗 %d tick" % (self.view_start, self.view_len) + ("（已省略 %d 個音符）" % skipped if skipped else "")
        ops.append(["text", 10, 8, title, "#e8e8f0"])
        self.w.draw(self.cv, ops)

    def scroll(self, direction):
        step = self.view_len // 2
        limit = max(0, self.total_ticks - step)
        self.view_start = max(0, min(limit, self.view_start + direction * step))

    def run(self):
        while True:
            ev = self.w.poll()
            if ev is None:
                self.tick_play()
                self.draw()
                time.sleep(0.04)
                continue
            kind, node = ev.get("event"), ev.get("node")
            if kind == "close":
                break
            if kind == "pick":
                self.open_file(ev)
            elif kind == "click":
                if node == self.b0:
                    self.export("format0.mid", 0)
                elif node == self.b1:
                    self.export("format1.mid", 1)
                elif node == self.bplay:
                    self.start()
                elif node == self.bstop:
                    self.stop()
                elif node in (self.bleft, self.bright):
                    self.scroll(-1 if node == self.bleft else 1)
        self.w.close()


if __name__ == "__main__":
    MidiTool().run()
