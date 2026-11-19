# -*- coding: utf-8 -*-
# ARPG 地城探索（類暗黑破壞神）
#
# 玩法：每一層都是程序生成的地城（隨機房間 + 走廊）。用滑鼠探索、打怪、撿裝備，
#       找到發光的樓梯往下一層，怪物會越來越強。有戰爭迷霧：走過的地方會留在地圖上（較暗），
#       視線內的區域才是亮的，怪物只有在視線內才看得到。右上角有小地圖。
#       怪物會沿著地形追擊你。紅色血球回復 HP、藍色血球回復 MP；怪物會掉裝備（武器加攻擊、
#       護甲減傷），走過去自動撿起，比較好就自動換上（顏色：白＝普通、藍＝稀有、金＝傳奇）。
# 操作：滑鼠左鍵點地板＝走過去；點怪物＝走過去並持續攻擊；滑鼠右鍵（或按 F）＝往滑鼠方向射火球（耗 8 MP）。
#       沒有滑鼠時：方向鍵移動、空白鍵攻擊身旁的怪、F 射火球。M＝開關小地圖；Enter：死亡後重來；Esc：離開。
#       （先用滑鼠點一下視窗取得鍵盤。）
#
# 繪圖指令預算（每幀上限 200）：
#   清屏 1 + 地板 <= FLOOR_BUDGET(80，同一列相鄰且明暗相同的格子併成一個長矩形；牆壁就是背景色不用畫)
#   + 樓梯 1 + 地上物品 <= MAX_LOOT(10) + 怪物 <= MAX_MON(10) x 2（身體、血條）= 20 + 火球 <= MAX_BOLT(6)
#   + 玩家 2 + 揮擊 1 + 點擊標記 1 + 小地圖 <= MINI_BUDGET(36) + 底 1 + 點 1
#   + HUD：底欄 1 + 血球 2 + 魔球 2 + 文字 5 = 10
#   最壞合計 1+80+1+10+20+6+2+1+1+36+2+10 = 170 道，低於 200。
import math
import random
from collections import deque

import pygame


def tone(freq, ms, rate=22050, volume=0.3):
    """短音效：標準的 pygame 寫法——產生 16 位元單聲道方波 PCM，交給 pygame.mixer.Sound(buffer=…)。"""
    import array as _array, math as _math
    if not pygame.mixer.get_init():
        pygame.mixer.init(rate, -16, 1)
    n = int(rate * ms / 1000)
    pcm = _array.array("h", (int(32767 * volume) if _math.sin(2 * _math.pi * freq * i / rate) >= 0 else -int(32767 * volume) for i in range(n)))
    return pygame.mixer.Sound(buffer=pcm.tobytes())

W, H = 480, 360
VIEW_H = 336                      # 地圖畫面高度，底下 24 像素是狀態列
STEP = 1000 // 60
T = 24
MW, MH = 60, 44                   # 地城大小（格）
VIS = 7                           # 視野半徑（格）
FLOOR_BUDGET, MAX_LOOT, MAX_MON, MAX_BOLT, MINI_BUDGET = 80, 10, 10, 6, 36
MINI_CELL, MINI_PX = 5, 7         # 小地圖：每 5x5 格縮成一個 7 像素的方塊
PLAYER_SPEED, ATTACK_RANGE, ATTACK_CD = 2.2, 36, 24
FLOOR_COLORS = {"dark": (38, 38, 52), "lit": (92, 86, 100)}
RARITY = [((235, 235, 235), "普通"), ((90, 140, 255), "稀有"), ((255, 205, 60), "傳奇")]
KINDS = {
    "skeleton": {"name": "骷髏", "hp": 18, "dmg": 4, "spd": 1.2, "xp": 8, "color": (225, 225, 205)},
    "ghost": {"name": "幽靈", "hp": 12, "dmg": 3, "spd": 1.7, "xp": 7, "color": (120, 200, 230)},
    "brute": {"name": "巨怪", "hp": 46, "dmg": 10, "spd": 0.85, "xp": 22, "color": (190, 90, 60)},
}
NEIGH = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]


class Game:
    def __init__(self, seed=None):
        self.rnd = random.Random(seed)
        self.depth = 0
        self.level, self.xp = 1, 0
        self.maxhp, self.maxmp = 60, 30
        self.hp, self.mp = self.maxhp, self.maxmp
        self.weapon = self.armor = 0
        self.over = False
        self.msg, self.msg_t = "", 0
        self.show_mini = True
        self.new_floor()

    # ---- 地城生成 ----
    def new_floor(self):
        self.depth += 1
        rnd = self.rnd
        grid = [[0] * MW for _ in range(MH)]              # 0 牆、1 地板
        rooms = []
        for _ in range(60):
            w, h = rnd.randint(5, 10), rnd.randint(5, 8)
            x, y = rnd.randint(2, MW - w - 3), rnd.randint(2, MH - h - 3)
            if all(x + w + 2 < r[0] or r[0] + r[2] + 2 < x or y + h + 2 < r[1] or r[1] + r[3] + 2 < y for r in rooms):
                rooms.append((x, y, w, h))
            if len(rooms) >= 12:
                break
        for x, y, w, h in rooms:
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    grid[yy][xx] = 1
        centers = [(x + w // 2, y + h // 2) for x, y, w, h in rooms]
        for (ax, ay), (bx, by) in zip(centers, centers[1:]):   # L 形走廊把相鄰房間接起來
            for xx in range(min(ax, bx), max(ax, bx) + 1):
                grid[ay][xx] = 1
            for yy in range(min(ay, by), max(ay, by) + 1):
                grid[yy][bx] = 1
        self.grid = grid
        self.explored = [[False] * MW for _ in range(MH)]
        self.visible = set()
        self.px, self.py = centers[0][0] * T + T / 2, centers[0][1] * T + T / 2
        self.stairs = centers[-1]
        self.dest = None                  # 滑鼠點擊的走路目的地
        self.path = []
        self.target = None                # 正在追打的怪物
        self.bolts, self.loot, self.mons = [], [], []
        self.atk_cd = 0
        self.swing = 0
        self.marker = 0
        d = self.depth
        for (cx, cy), room in zip(centers[1:], rooms[1:]):
            for _ in range(rnd.randint(1, 2 + d // 2)):
                if len(self.mons) >= 28:
                    break
                kind = rnd.choice(["skeleton", "skeleton", "ghost", "brute"] if d > 1 else ["skeleton", "ghost"])
                k = KINDS[kind]
                x, y = rnd.randint(room[0], room[0] + room[2] - 1), rnd.randint(room[1], room[1] + room[3] - 1)
                hp = k["hp"] + 5 * (d - 1)
                self.mons.append({"kind": kind, "x": x * T + T / 2, "y": y * T + T / 2, "hp": hp, "maxhp": hp,
                                  "cd": 0, "dmg": k["dmg"] + d - 1})
            if rnd.random() < 0.5:
                self.loot.append(self.make_loot(cx * T + T / 2, cy * T + T / 2))
        self.dist = {}
        self.dist_from = None
        self.update_visibility()
        self.say("第 %d 層" % d)

    def say(self, s):
        self.msg, self.msg_t = s, 180

    # ---- 地圖查詢 ----
    def floor(self, c, r):
        return 0 <= c < MW and 0 <= r < MH and self.grid[r][c] == 1

    def tile_of(self, x, y):
        return int(x // T), int(y // T)

    def can_step(self, c, r, dc, dr):
        """從 (c,r) 往 (dc,dr) 方向走一格是否可行（斜走時兩側也不能是牆，避免切角穿牆）。"""
        if not self.floor(c + dc, r + dr):
            return False
        return dc == 0 or dr == 0 or (self.floor(c + dc, r) and self.floor(c, r + dr))

    def los(self, c0, r0, c1, r1):
        """兩格之間沒有牆擋住嗎？（Bresenham 線）"""
        dc, dr = abs(c1 - c0), abs(r1 - r0)
        sc, sr = (1 if c1 > c0 else -1), (1 if r1 > r0 else -1)
        err, c, r = dc - dr, c0, r0
        while (c, r) != (c1, r1):
            if (c, r) != (c0, r0) and not self.floor(c, r):
                return False
            e2 = 2 * err
            if e2 > -dr:
                err -= dr
                c += sc
            if e2 < dc:
                err += dc
                r += sr
        return True

    def update_visibility(self):
        c0, r0 = self.tile_of(self.px, self.py)
        vis = set()
        for r in range(r0 - VIS, r0 + VIS + 1):
            for c in range(c0 - VIS, c0 + VIS + 1):
                if self.floor(c, r) and (c - c0) ** 2 + (r - r0) ** 2 <= VIS * VIS and self.los(c0, r0, c, r):
                    vis.add((c, r))
                    self.explored[r][c] = True
        self.visible = vis

    def bfs(self, start, goal=None, limit=None):
        """從 start 做廣度優先搜尋。有 goal 時回傳路徑（格座標清單）；沒有時回傳距離表（讓怪物追擊用）。"""
        dist, prev = {start: 0}, {}
        q = deque([start])
        while q:
            c, r = q.popleft()
            if goal is not None and (c, r) == goal:
                break
            if limit is not None and dist[(c, r)] >= limit:
                continue
            for dc, dr in NEIGH:
                n = (c + dc, r + dr)
                if n not in dist and self.can_step(c, r, dc, dr):
                    dist[n] = dist[(c, r)] + 1
                    prev[n] = (c, r)
                    q.append(n)
        if goal is None:
            return dist
        if goal not in dist:
            return []
        path, cur = [], goal
        while cur != start:
            path.append(cur)
            cur = prev[cur]
        return path[::-1]

    # ---- 掉落物 ----
    def make_loot(self, x, y, force=None):
        kind = force or self.rnd.choice(["hp", "mp", "weapon", "armor"])
        item = {"kind": kind, "x": x, "y": y}
        if kind in ("weapon", "armor"):
            item["bonus"] = self.rnd.randint(1, 2 + self.depth * 2)
            item["rar"] = 0 if item["bonus"] <= 2 else (1 if item["bonus"] <= 5 else 2)
        return item

    def pickup(self, it):
        k = it["kind"]
        if k == "hp":
            self.hp = min(self.maxhp, self.hp + 30)
            self.say("撿到紅色血球，回復 HP")
        elif k == "mp":
            self.mp = min(self.maxmp, self.mp + 20)
            self.say("撿到藍色血球，回復 MP")
        else:
            name = "武器" if k == "weapon" else "護甲"
            cur = self.weapon if k == "weapon" else self.armor
            if it["bonus"] > cur:
                if k == "weapon":
                    self.weapon = it["bonus"]
                else:
                    self.armor = it["bonus"]
                self.say("換上%s%s +%d" % (RARITY[it["rar"]][1], name, it["bonus"]))
            else:
                self.say("撿到%s%s +%d（不比現在的好）" % (RARITY[it["rar"]][1], name, it["bonus"]))
        return "pickup"

    def gain_xp(self, n):
        self.xp += n
        while self.xp >= 30 * self.level:
            self.xp -= 30 * self.level
            self.level += 1
            self.maxhp += 12
            self.maxmp += 5
            self.hp, self.mp = self.maxhp, self.maxmp
            self.say("升級！Lv%d" % self.level)

    def attack_power(self):
        return 6 + 2 * (self.level - 1) + self.weapon

    # ---- 玩家指令 ----
    def click(self, wx, wy, button=1):
        """滑鼠點擊（世界座標）。左鍵：點怪物＝追打，點地板＝走過去；右鍵：射火球。"""
        if self.over:
            return []
        if button == 3:
            return self.cast(wx, wy)
        for m in self.mons:
            if self.mon_visible(m) and math.hypot(m["x"] - wx, m["y"] - wy) < 16:
                self.target, self.dest, self.path = m, None, []
                return []
        c, r = self.tile_of(wx, wy)
        if self.floor(c, r):
            self.target = None
            self.dest = (wx, wy)
            self.marker = 40
            self.path = self.bfs(self.tile_of(self.px, self.py), (c, r))
        return []

    def cast(self, wx, wy):
        if self.over or self.mp < 8 or len(self.bolts) >= MAX_BOLT:
            return []
        d = math.hypot(wx - self.px, wy - self.py) or 1.0
        self.mp -= 8
        self.bolts.append({"x": self.px, "y": self.py, "vx": (wx - self.px) / d * 5, "vy": (wy - self.py) / d * 5, "life": 90})
        return ["magic"]

    def attack_nearest(self):
        near = [m for m in self.mons if math.hypot(m["x"] - self.px, m["y"] - self.py) <= ATTACK_RANGE]
        if near:
            self.target = min(near, key=lambda m: math.hypot(m["x"] - self.px, m["y"] - self.py))

    def mon_visible(self, m):
        return self.tile_of(m["x"], m["y"]) in self.visible

    def hit_monster(self, m, dmg):
        m["hp"] -= dmg
        if m["hp"] <= 0 and m in self.mons:
            self.mons.remove(m)
            if self.target is m:
                self.target = None
            self.gain_xp(KINDS[m["kind"]]["xp"])
            roll = self.rnd.random()
            if roll < 0.55:
                kind = "weapon" if roll < 0.15 else "armor" if roll < 0.3 else "hp" if roll < 0.43 else "mp"
                if len(self.loot) < 24:
                    self.loot.append(self.make_loot(m["x"], m["y"], kind))
            return "kill"
        return "hit"

    # ---- 每步更新 ----
    def update(self, kx=0, ky=0):
        """kx, ky：方向鍵（無滑鼠時用）。回傳事件清單。"""
        ev = []
        if self.over:
            return ev
        moved = False
        if self.atk_cd > 0:
            self.atk_cd -= 1
        self.swing = max(0, self.swing - 1)
        self.marker = max(0, self.marker - 1)
        self.msg_t = max(0, self.msg_t - 1)
        # 移動：鍵盤優先，否則依目標／路徑走
        if kx or ky:
            self.dest, self.path, self.target = None, [], None
            n = math.hypot(kx, ky)
            moved = self.walk(kx / n * PLAYER_SPEED, ky / n * PLAYER_SPEED)
        elif self.target is not None:
            t = self.target
            if math.hypot(t["x"] - self.px, t["y"] - self.py) <= ATTACK_RANGE:
                if self.atk_cd == 0:
                    dmg = self.attack_power() + self.rnd.randint(0, 3)
                    ev.append(self.hit_monster(t, dmg))
                    self.atk_cd, self.swing = ATTACK_CD, 8
            else:
                if not self.path or self.rnd.random() < 0.05:
                    self.path = self.bfs(self.tile_of(self.px, self.py), self.tile_of(t["x"], t["y"]))
                moved = self.follow_path()
        elif self.path:
            moved = self.follow_path()
        if moved:
            self.update_visibility()
            ev += self.collect()
            if self.tile_of(self.px, self.py) == self.stairs:
                self.new_floor()
                ev.append("stairs")
                return ev
        # 火球
        for b in self.bolts[:]:
            b["x"] += b["vx"]
            b["y"] += b["vy"]
            b["life"] -= 1
            c, r = self.tile_of(b["x"], b["y"])
            hit = next((m for m in self.mons if math.hypot(m["x"] - b["x"], m["y"] - b["y"]) < 14), None)
            if hit:
                ev.append(self.hit_monster(hit, 12 + 3 * self.level))
                self.bolts.remove(b)
            elif b["life"] <= 0 or not self.floor(c, r):
                self.bolts.remove(b)
        ev += self.update_monsters()
        if self.hp <= 0:
            self.hp, self.over = 0, True
        if moved or self.dist_from != self.tile_of(self.px, self.py):
            self.dist_from = self.tile_of(self.px, self.py)
            self.dist = self.bfs(self.dist_from, limit=14)
        return [e for e in ev if e]

    def walk(self, vx, vy):
        """直接依速度走，撞牆就貼著牆滑（x、y 分開處理）。"""
        moved = False
        nx = self.px + vx
        if self.floor(*self.tile_of(nx + (6 if vx > 0 else -6), self.py)):
            self.px, moved = nx, True
        ny = self.py + vy
        if self.floor(*self.tile_of(self.px, ny + (6 if vy > 0 else -6))):
            self.py, moved = ny, True
        return moved

    def follow_path(self):
        if not self.path:
            return False
        tx, ty = self.path[0][0] * T + T / 2, self.path[0][1] * T + T / 2
        d = math.hypot(tx - self.px, ty - self.py)
        if d <= PLAYER_SPEED:
            self.px, self.py = tx, ty
            self.path.pop(0)
        else:
            self.px += (tx - self.px) / d * PLAYER_SPEED
            self.py += (ty - self.py) / d * PLAYER_SPEED
        return True

    def collect(self):
        ev = []
        for it in self.loot[:]:
            if math.hypot(it["x"] - self.px, it["y"] - self.py) < 14:
                self.loot.remove(it)
                ev.append(self.pickup(it))
        return ev

    def update_monsters(self):
        ev = []
        ptile = self.tile_of(self.px, self.py)
        for i, m in enumerate(self.mons):
            if m["cd"] > 0:
                m["cd"] -= 1
            d = math.hypot(self.px - m["x"], self.py - m["y"])
            if d < 22:
                if m["cd"] == 0:
                    self.hp -= max(1, m["dmg"] - self.armor // 2)
                    m["cd"] = 50
                    ev.append("hurt")
                continue
            mt = self.tile_of(m["x"], m["y"])
            if mt not in self.dist:
                continue                                 # 離太遠：沒發現你
            best, bd = None, self.dist[mt]
            for dc, dr in NEIGH:
                n = (mt[0] + dc, mt[1] + dr)
                if n in self.dist and self.dist[n] < bd and self.can_step(mt[0], mt[1], dc, dr):
                    best, bd = n, self.dist[n]
            tx, ty = (best[0] * T + T / 2, best[1] * T + T / 2) if best else (self.px, self.py)
            if mt == ptile:
                tx, ty = self.px, self.py
            dd = math.hypot(tx - m["x"], ty - m["y"]) or 1.0
            sp = KINDS[m["kind"]]["spd"]
            m["x"] += (tx - m["x"]) / dd * sp
            m["y"] += (ty - m["y"]) / dd * sp
            for o in self.mons[:i]:                      # 怪物之間互相推開，避免疊在一起
                ox, oy = m["x"] - o["x"], m["y"] - o["y"]
                if 0 < math.hypot(ox, oy) < 12:
                    m["x"] += ox * 0.05
                    m["y"] += oy * 0.05
        return ev


# ---------------- 畫面 ----------------
def camera(g):
    cx = max(0, min(MW * T - W, g.px - W / 2))
    cy = max(0, min(MH * T - VIEW_H, g.py - VIEW_H / 2))
    return int(cx), int(cy)


def floor_runs(g, cx, cy):
    """畫面內的地板併成長矩形，回傳 (x, y, w, color)。同列相鄰且明暗（視野內／已探索）相同的併在一起。"""
    runs = []
    c0, c1 = cx // T, min(MW, (cx + W) // T + 2)
    for r in range(cy // T, min(MH, (cy + VIEW_H) // T + 2)):
        c = c0
        while c < c1:
            if g.explored[r][c]:
                lit = (c, r) in g.visible
                s = c
                while c < c1 and g.explored[r][c] and ((c, r) in g.visible) == lit:
                    c += 1
                runs.append((s * T - cx, r * T - cy, (c - s) * T, FLOOR_COLORS["lit" if lit else "dark"]))
            else:
                c += 1
    return runs


def minimap_runs(g):
    """小地圖：每 5x5 格縮成一個方塊，同列相鄰的已探索方塊併成一個矩形。回傳 (cx, cy, 方塊數)。"""
    runs = []
    for br in range((MH + MINI_CELL - 1) // MINI_CELL):
        bc = 0
        ncols = (MW + MINI_CELL - 1) // MINI_CELL

        def seen(b):
            return any(g.explored[r][c] for r in range(br * MINI_CELL, min(MH, br * MINI_CELL + MINI_CELL))
                       for c in range(b * MINI_CELL, min(MW, b * MINI_CELL + MINI_CELL)))
        while bc < ncols:
            if seen(bc):
                s = bc
                while bc < ncols and seen(bc):
                    bc += 1
                runs.append((s, br, bc - s))
            else:
                bc += 1
    return runs


def draw(screen, font, g):
    R = pygame.Rect
    cx, cy = camera(g)
    screen.fill((8, 8, 12))
    for x, y, w, color in floor_runs(g, cx, cy)[:FLOOR_BUDGET]:
        pygame.draw.rect(screen, color, R(x, y, w, T))
    sc, sr = g.stairs
    if g.explored[sr][sc]:
        pygame.draw.rect(screen, (120, 255, 200), R(sc * T + 4 - cx, sr * T + 4 - cy, T - 8, T - 8))
    shown = 0
    for it in g.loot:
        if shown >= MAX_LOOT or g.tile_of(it["x"], it["y"]) not in g.visible:
            continue
        shown += 1
        x, y = int(it["x"] - cx), int(it["y"] - cy)
        if it["kind"] in ("hp", "mp"):
            pygame.draw.circle(screen, (230, 50, 60) if it["kind"] == "hp" else (60, 110, 240), (x, y), 5)
        else:
            pygame.draw.rect(screen, RARITY[it["rar"]][0], R(x - 5, y - 5, 10, 10))
    shown = 0
    for m in g.mons:
        if shown >= MAX_MON or not g.mon_visible(m):
            continue
        shown += 1
        x, y = int(m["x"] - cx), int(m["y"] - cy)
        pygame.draw.circle(screen, KINDS[m["kind"]]["color"], (x, y), 9 if m["kind"] != "brute" else 12)
        pygame.draw.rect(screen, (230, 50, 50), R(x - 10, y - 17, max(1, int(20 * m["hp"] / m["maxhp"])), 3))
    for b in g.bolts[:MAX_BOLT]:
        pygame.draw.circle(screen, (255, 160, 40), (int(b["x"] - cx), int(b["y"] - cy)), 4)
    if g.marker and g.dest:
        mx, my = int(g.dest[0] - cx), int(g.dest[1] - cy)
        pygame.draw.rect(screen, (255, 255, 120), R(mx - 2, my - 2, 4, 4))
    x, y = int(g.px - cx), int(g.py - cy)
    pygame.draw.circle(screen, (70, 130, 240), (x, y), 9)
    pygame.draw.rect(screen, (250, 220, 170), R(x - 3, y - 12, 6, 5))
    if g.swing:
        t = g.target
        if t:
            pygame.draw.line(screen, (255, 255, 255), (x, y), (int(t["x"] - cx), int(t["y"] - cy)))
    if g.show_mini:
        ox, oy = W - 7 * 12 - 6, 6
        pygame.draw.rect(screen, (0, 0, 0), R(ox - 2, oy - 2, 7 * 12 + 4, 7 * 9 + 4))
        for bc, br, n in minimap_runs(g)[:MINI_BUDGET]:
            pygame.draw.rect(screen, (110, 110, 140), R(ox + bc * MINI_PX, oy + br * MINI_PX, n * MINI_PX, MINI_PX))
        pc, pr = g.tile_of(g.px, g.py)
        pygame.draw.rect(screen, (255, 80, 80), R(ox + pc // MINI_CELL * MINI_PX + 2, oy + pr // MINI_CELL * MINI_PX + 2, 3, 3))
    # HUD：底欄、血球（紅）、魔球（藍）；球的亮部高度代表剩餘比例
    pygame.draw.rect(screen, (24, 20, 30), R(0, VIEW_H, W, H - VIEW_H))
    for ox, ratio, dark, bright in ((26, g.hp / g.maxhp, (70, 14, 20), (220, 40, 50)), (W - 26, g.mp / g.maxmp, (14, 24, 80), (60, 110, 240))):
        pygame.draw.circle(screen, dark, (ox, VIEW_H - 4), 24)
        pygame.draw.circle(screen, bright, (ox, VIEW_H - 4), max(1, int(24 * math.sqrt(max(0.0, ratio)))))
    screen.blit(font.render("%d/%d" % (g.hp, g.maxhp), True, (255, 255, 255)), (8, VIEW_H - 24))
    screen.blit(font.render("%d/%d" % (g.mp, g.maxmp), True, (255, 255, 255)), (W - 50, VIEW_H - 24))
    screen.blit(font.render("Lv%d  第 %d 層  XP %d/%d" % (g.level, g.depth, g.xp, 30 * g.level), True, (230, 230, 230)), (60, H - 8))
    screen.blit(font.render("武器+%d 護甲+%d" % (g.weapon, g.armor), True, (230, 200, 120)), (300, H - 8))
    if g.msg_t > 0:
        screen.blit(font.render(g.msg, True, (255, 255, 160)), (60, VIEW_H - 8))
    if g.over:
        screen.blit(font.render("你死了……  按 Enter 重來", True, (255, 255, 255)), (W // 2 - 80, VIEW_H // 2))


def main():
    pygame.init()
    pygame.display.set_caption("ARPG 地城探索")
    screen = pygame.display.set_mode((W, H))
    font = pygame.font.Font(None, 14)
    beep = {"hit": tone(380, 40), "kill": tone(560, 70),
            "hurt": tone(140, 90), "magic": tone(800, 60),
            "pickup": tone(900, 50), "stairs": tone(500, 200)}
    clock = pygame.time.Clock()
    game = Game()
    acc = 0
    running = True
    while running:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                running = False
            elif ev.type == pygame.MOUSEBUTTONDOWN and ev.pos[1] < VIEW_H:
                cx, cy = camera(game)
                for e in game.click(ev.pos[0] + cx, ev.pos[1] + cy, ev.button):
                    beep[e].play()
            elif ev.type == pygame.KEYDOWN:
                if ev.key == pygame.K_ESCAPE:
                    running = False
                elif ev.key == pygame.K_RETURN and game.over:
                    game = Game()
                elif ev.key == pygame.K_SPACE:
                    game.attack_nearest()
                elif ev.key == ord("m"):
                    game.show_mini = not game.show_mini
                elif ev.key == ord("f"):
                    mx, my = pygame.mouse.get_pos()
                    cx, cy = camera(game)
                    for e in game.cast(mx + cx, my + cy):
                        beep[e].play()
        k = pygame.key.get_pressed()
        kx = (1 if k[pygame.K_RIGHT] else 0) - (1 if k[pygame.K_LEFT] else 0)
        ky = (1 if k[pygame.K_DOWN] else 0) - (1 if k[pygame.K_UP] else 0)
        acc = min(acc + clock.tick(60), 250)
        while acc >= STEP:
            for e in game.update(kx, ky):
                beep[e].play()
            acc -= STEP
        draw(screen, font, game)
        pygame.display.flip()
    pygame.quit()


if __name__ == "__main__":
    main()
