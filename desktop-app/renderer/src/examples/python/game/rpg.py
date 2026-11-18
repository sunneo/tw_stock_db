# -*- coding: utf-8 -*-
# RPG：小村莊冒險
#
# 玩法：俯視地圖上探索。跟長老、商人、村民說話（面向對方按確認）；長老給你任務「打倒 3 隻史萊姆」；
#       走進深色草叢會隨機遇敵，進入回合制戰鬥（攻擊／魔法／道具／逃跑）；打贏得到經驗值與金幣，
#       經驗值夠就升級；交任務拿鐵劍；商人賣藥水（15 金幣）；村民可以讓你休息回滿；寶箱有獎勵。
#       越往東邊的草叢怪物越強。
# 操作：地圖上 方向鍵＝移動（按住連續走）、空白鍵或 Enter＝對話／調查前方、I＝背包、Esc＝離開遊戲；
#       對話中 空白鍵／Enter＝下一頁，商人詢問時按 Y 買 N 不買；背包中 上下選擇、確認＝使用藥水、I 或 Esc 關閉；
#       戰鬥中 上下選擇指令、確認＝執行。（先用滑鼠點一下視窗取得鍵盤。）
#
# 繪圖指令預算（每幀上限 200）：
#   地圖：只畫畫面內 20x13 格，同一列相鄰的同種地形併成一個長矩形，地形最多畫 TILE_BUDGET(100) 道（草地用清屏當底色不另畫）
#         + NPC 最多 3 x 2 + 寶箱 1 + 主角 2 + 下方狀態列 底 1 + 文字 2
#   對話框：底 1 + 邊 1 + 文字 <= 3 + 提示 1；背包面板：底 1 + 文字 <= 9
#   戰鬥（不畫地圖）：清屏 1 + 敵人圖形 <= 6 + 血條 4 + 指令文字 4 + 訊息 2 + 狀態文字 3
#   最壞（地圖 + 對話框）約 100+6+1+2+3+5 = 117 道，低於 200。
import random
import pygame

W, H = 480, 360
STEP = 1000 // 60
T = 24
VIEW_C, VIEW_R = 20, 13           # 畫面內可見格數（480 / 24、312 / 24）
TILE_BUDGET = 100
MOVE_COOLDOWN = 9                 # 按住方向鍵時，每走一格要等的步數
WALKABLE = ".,="
GRAPHIC = {                       # 地形 -> 顏色；'.' 草地是底色，不用畫
    ",": (40, 110, 55), "#": (30, 80, 40), "~": (50, 110, 210), "=": (200, 175, 120), "H": (150, 90, 60)}
GRASS = (80, 170, 80)

MAP = [
    "########################################",
    "#.#...............=....................#",
    "#.................=.,,,,,,,,,,,,,,,,,,.#",
    "#..HHHHH...HHHHH..=.,,,,,,,,,,,,,,,C,,.#",
    "#..HHHHH...HHHHH..=.,,,,,,,,,,,,,,,,,,.#",
    "#..HHHHH...HHHHH..=.,,,,##,,,,,,,,,,,,.#",
    "#....E.......M....=.,,,,##,,,,,,,,,,,,.#",
    "#.................=.,,,,,,,,,,,,,,,,,,.#",
    "#.................=.,,,,,,,,,,,,,,,,,,.#",
    "#.................=...............###..#",
    "#.====================================.#",
    "#.........V.......P....................#",
    "#.................=...,,,,,,,,,,,,,,,..#",
    "#.........,,,,,,,.=...,,,,,,,,,,,,,,,..#",
    "#..~~~~~..,,,,,,,.=.#.,,,,,,,,,,,,,,,..#",
    "#..~~~~~..,,,,,,,.=.#.,,,,,,,,,,,,,,,..#",
    "#..~~~~~..,,,,,,,.=.#.,,,,,,,,##,,,,,..#",
    "#..~~~~~..,,,,,,,.=.#.,,,,,,,,##,,,,,..#",
    "#..~~~~~..,,,,,,,.=.#.,,,,,,,,,,,,,,,..#",
    "#.........,,,,,,,.=.#.,,,,,,,,,,,,,,,..#",
    "#.........,,,,,,,.=...,,,,,,,,,,,,,,,..#",
    "#.................=...,,,,,,,,,,,,,,,..#",
    "#........#####....=....................#",
    "########################################",
]

ENEMIES = {
    "slime": {"name": "史萊姆", "hp": 14, "atk": 5, "def": 0, "exp": 6, "gold": 4, "color": (90, 220, 120)},
    "bat": {"name": "蝙蝠", "hp": 18, "atk": 7, "def": 0, "exp": 9, "gold": 5, "color": (150, 100, 190)},
    "goblin": {"name": "哥布林", "hp": 32, "atk": 10, "def": 1, "exp": 16, "gold": 9, "color": (120, 170, 60)},
    "wolf": {"name": "野狼", "hp": 40, "atk": 13, "def": 1, "exp": 24, "gold": 12, "color": (160, 160, 170)},
}
CMDS = ["攻擊", "魔法", "道具", "逃跑"]
NPC_INFO = {"E": ("長老", (240, 240, 240)), "M": ("商人", (240, 200, 60)), "V": ("村民", (230, 140, 180))}


def text_width(s):
    """估算字串寬度：英文字母約 7 像素、中文約 14 像素（畫面字型大小固定）。"""
    return sum(7 if ord(ch) < 128 else 14 for ch in s)


def wrap(s, width):
    lines, cur = [], ""
    for ch in s:
        if text_width(cur + ch) > width:
            lines.append(cur)
            cur = ""
        cur += ch
    return lines + [cur]


class Game:
    def __init__(self, seed=None):
        self.rnd = random.Random(seed)
        self.grid = [list(r) for r in MAP]
        self.cols, self.rows = len(MAP[0]), len(MAP)
        assert all(len(r) == self.cols for r in MAP), "地圖每列長度要一致"
        self.npcs = []
        self.chest = None
        for r, row in enumerate(self.grid):
            for c, ch in enumerate(row):
                if ch == "P":
                    self.x, self.y = c, r
                if ch in NPC_INFO:
                    self.npcs.append({"id": ch, "x": c, "y": r})
                if ch == "C":
                    self.chest = {"x": c, "y": r, "open": False}
                if ch in "PEMVC":
                    row[c] = "."
        self.face = (0, 1)
        self.cool = 0
        self.level, self.exp = 1, 0
        self.maxhp, self.maxmp = 30, 10
        self.hp, self.mp = self.maxhp, self.maxmp
        self.base_atk, self.weapon = 6, 0
        self.gold = 0
        self.inv = {"藥水": 1}
        self.quest = 0                      # 0 未接、1 進行中、2 可交付、3 完成
        self.kills = 0
        self.mode = "map"                   # map / dialog / menu / battle / over
        self.pages, self.ask, self.cursor = [], None, 0
        self.battle = None

    # ---- 數值 ----
    def atk(self):
        return self.base_atk + self.weapon

    def defense(self):
        return self.level

    def exp_need(self):
        return 10 * self.level

    def gain_exp(self, n):
        """加經驗值，回傳升級訊息清單。"""
        msgs = []
        self.exp += n
        while self.exp >= self.exp_need():
            self.exp -= self.exp_need()
            self.level += 1
            self.maxhp += 8
            self.maxmp += 3
            self.base_atk += 2
            self.hp, self.mp = self.maxhp, self.maxmp
            msgs.append("升級了！現在是 Lv%d，能力提升、HP/MP 全回復。" % self.level)
        return msgs

    # ---- 地圖 ----
    def npc_at(self, c, r):
        return next((n for n in self.npcs if n["x"] == c and n["y"] == r), None)

    def walkable(self, c, r):
        if not (0 <= c < self.cols and 0 <= r < self.rows):
            return False
        if self.grid[r][c] not in WALKABLE or self.npc_at(c, r):
            return False
        return not (self.chest and (self.chest["x"], self.chest["y"]) == (c, r))

    def update(self, dx, dy):
        """地圖模式下，持續按著方向鍵時每隔幾步走一格。回傳事件清單。"""
        ev = []
        if self.cool > 0:
            self.cool -= 1
        if self.mode != "map" or (dx == 0 and dy == 0) or self.cool > 0:
            return ev
        if dx and dy:
            dy = 0                                   # 不走斜線
        self.face = (dx, dy)
        nx, ny = self.x + dx, self.y + dy
        if self.walkable(nx, ny):
            self.x, self.y = nx, ny
            self.cool = MOVE_COOLDOWN
            if self.grid[ny][nx] == "," and self.rnd.random() < 0.10:
                self.start_battle()
                ev.append("encounter")
        return ev

    def zone_enemy(self):
        if self.x <= 16:
            return "slime"
        if self.x < 26:
            return self.rnd.choice(["slime", "bat"])
        return self.rnd.choice(["bat", "goblin", "goblin", "wolf"])

    # ---- 對話與任務 ----
    def say(self, pages, ask=None):
        self.mode, self.pages, self.ask = "dialog", list(pages), ask

    def interact(self):
        fx, fy = self.x + self.face[0], self.y + self.face[1]
        npc = self.npc_at(fx, fy)
        if npc:
            getattr(self, "talk_" + npc["id"])()
        elif self.chest and (self.chest["x"], self.chest["y"]) == (fx, fy):
            if self.chest["open"]:
                self.say(["寶箱是空的。"])
            else:
                self.chest["open"] = True
                self.inv["藥水"] = self.inv.get("藥水", 0) + 1
                self.gold += 20
                self.say(["打開寶箱，得到藥水 x1 和 20 金幣！"])

    def talk_E(self):                                # 長老：任務
        if self.quest == 0:
            self.quest = 1
            self.say(["年輕的冒險者，村外的草叢出現了史萊姆。", "請你打倒 3 隻史萊姆，我會給你報酬。（西邊的深色草叢）"])
        elif self.quest == 1:
            self.say(["史萊姆還沒打完喔。目前 %d/3。" % self.kills])
        elif self.quest == 2:
            self.quest = 3
            self.weapon = 4
            self.gold += 30
            self.say(["太棒了！這把鐵劍送給你，還有 30 金幣。", "獲得鐵劍，攻擊力 +4。"] + self.gain_exp(20))
        else:
            self.say(["謝謝你保護了村子。東邊的草叢有更強的怪物，要小心。"])

    def talk_M(self):                                # 商人：買藥水
        self.say(["歡迎光臨！藥水一瓶 15 金幣，可回復 30 點 HP。", "要買嗎？（Y 買 / N 不買）"], ask="buy")

    def talk_V(self):                                # 村民：休息
        self.hp, self.mp = self.maxhp, self.maxmp
        self.say(["草叢裡會遇到怪物，按 I 可以開背包用藥水。", "喝杯茶休息一下吧。HP 和 MP 全部回復了！"])

    def press(self, key):
        """處理一次按鍵（確認 ok、取消 cancel、選單 menu、方向 up/down、y、n）。回傳 'quit' 或事件清單。"""
        if self.mode == "over":
            return []
        if self.mode == "map":
            if key == "ok":
                self.interact()
            elif key == "menu":
                self.mode, self.cursor = "menu", 0
            elif key == "cancel":
                return "quit"
        elif self.mode == "dialog":
            if self.ask == "buy" and len(self.pages) <= 1:
                if key == "y":
                    if self.gold >= 15:
                        self.gold -= 15
                        self.inv["藥水"] = self.inv.get("藥水", 0) + 1
                        self.say(["謝謝惠顧！"])
                    else:
                        self.say(["金幣不夠喔。"])
                elif key in ("n", "cancel"):
                    self.say(["那下次再來。"])
                return []
            if key == "ok":
                self.pages.pop(0)
                if not self.pages:
                    self.mode = "map"
        elif self.mode == "menu":
            items = self.items()
            if key in ("menu", "cancel"):
                self.mode = "map"
            elif key == "up":
                self.cursor = max(0, self.cursor - 1)
            elif key == "down":
                self.cursor = min(max(0, len(items) - 1), self.cursor + 1)
            elif key == "ok" and items:
                self.use_item(items[self.cursor])
        elif self.mode == "battle":
            return self.battle_key(key)
        return []

    def items(self):
        return [k for k, v in self.inv.items() if v > 0]

    def use_item(self, name):
        if name == "藥水" and self.inv.get("藥水", 0) > 0 and self.hp < self.maxhp:
            self.inv["藥水"] -= 1
            self.hp = min(self.maxhp, self.hp + 30)
            return True
        return False

    # ---- 戰鬥 ----
    def start_battle(self):
        kind = self.zone_enemy()
        e = dict(ENEMIES[kind])
        e["kind"], e["maxhp"] = kind, e["hp"]
        self.mode = "battle"
        self.battle = {"enemy": e, "phase": "cmd", "cursor": 0, "log": ["出現了 %s！" % e["name"]], "result": None}
        self.battle["phase"] = "msg"

    def damage(self, atk, defense):
        d = atk + self.rnd.randint(-1, 2) - defense
        return max(1, d)

    def battle_key(self, key):
        b = self.battle
        ev = []
        if b["phase"] == "msg":
            if key == "ok":
                b["log"].pop(0)
                if not b["log"]:
                    self.after_messages()
            return ev
        if key == "up":
            b["cursor"] = (b["cursor"] - 1) % 4
        elif key == "down":
            b["cursor"] = (b["cursor"] + 1) % 4
        elif key == "ok":
            ev += self.player_action(b["cursor"])
        return ev

    def after_messages(self):
        b = self.battle
        if b["result"] == "win" or b["result"] == "run":
            self.mode, self.battle = "map", None
        elif b["result"] == "lose":
            self.mode, self.battle = "over", None
        else:
            b["phase"] = "cmd"

    def player_action(self, idx):
        b, e = self.battle, self.battle["enemy"]
        log, ev = [], []
        if idx == 0:
            d = self.damage(self.atk(), e["def"])
            if self.rnd.random() < 0.1:
                d *= 2
                log.append("會心一擊！")
            e["hp"] -= d
            log.append("你攻擊 %s，造成 %d 點傷害。" % (e["name"], d))
            ev.append("hit")
        elif idx == 1:
            if self.mp < 4:
                b["log"], b["phase"] = ["MP 不足，需要 4 點。"], "msg"
                return ev
            self.mp -= 4
            d = 10 + 2 * self.level
            e["hp"] -= d
            log.append("你施放火球，造成 %d 點傷害。" % d)
            ev.append("magic")
        elif idx == 2:
            if self.inv.get("藥水", 0) <= 0:
                b["log"], b["phase"] = ["沒有藥水了。"], "msg"
                return ev
            self.inv["藥水"] -= 1
            self.hp = min(self.maxhp, self.hp + 30)
            log.append("喝下藥水，回復 30 點 HP。")
        else:
            if self.rnd.random() < 0.6:
                b["log"], b["phase"], b["result"] = ["成功逃跑了！"], "msg", "run"
                return ev
            log.append("逃跑失敗！")
        if e["hp"] <= 0:
            e["hp"] = 0
            gold = e["gold"]
            self.gold += gold
            log.append("打倒了 %s！獲得 %d 經驗值、%d 金幣。" % (e["name"], e["exp"], gold))
            log += self.gain_exp(e["exp"])
            if e["kind"] == "slime" and self.quest == 1:
                self.kills += 1
                if self.kills >= 3:
                    self.quest = 2
                    log.append("任務完成！回去找長老。")
            b["result"] = "win"
        else:
            d = self.damage(e["atk"], self.defense())
            self.hp -= d
            log.append("%s 攻擊你，造成 %d 點傷害。" % (e["name"], d))
            ev.append("hurt")
            if self.hp <= 0:
                self.hp = 0
                log.append("你倒下了……")
                b["result"] = "lose"
        b["log"], b["phase"] = log, "msg"
        return ev


# ---------------- 畫面 ----------------
def tile_runs(g):
    """畫面內地形併成長矩形，回傳 (x, y, w, color) 清單。"""
    cx = max(0, min(g.cols - VIEW_C, g.x - VIEW_C // 2))
    cy = max(0, min(g.rows - VIEW_R, g.y - VIEW_R // 2))
    runs = []
    for r in range(cy, cy + VIEW_R):
        c = cx
        while c < cx + VIEW_C:
            ch = g.grid[r][c]
            if ch in GRAPHIC:
                s = c
                while c < cx + VIEW_C and g.grid[r][c] == ch:
                    c += 1
                runs.append(((s - cx) * T, (r - cy) * T, (c - s) * T, GRAPHIC[ch]))
            else:
                c += 1
    return runs, cx, cy


def say_text(screen, font, s, x, y, color=(255, 255, 255)):
    screen.blit(font.render(s, True, color), (x, y + 12))        # 文字的 y 是基線，所以加 12


def draw_map(screen, font, g):
    R = pygame.Rect
    screen.fill(GRASS)
    runs, cx, cy = tile_runs(g)
    for x, y, w, color in runs[:TILE_BUDGET]:
        pygame.draw.rect(screen, color, R(x, y, w, T))
    for n in g.npcs:
        sx, sy = (n["x"] - cx) * T, (n["y"] - cy) * T
        if 0 <= sx < W and 0 <= sy < VIEW_R * T:
            pygame.draw.rect(screen, NPC_INFO[n["id"]][1], R(sx + 4, sy + 6, 16, 16))
            pygame.draw.rect(screen, (60, 40, 30), R(sx + 6, sy + 1, 12, 7))
    ch = g.chest
    if ch and 0 <= ch["x"] - cx < VIEW_C and 0 <= ch["y"] - cy < VIEW_R:
        pygame.draw.rect(screen, (120, 110, 100) if ch["open"] else (230, 170, 40), R((ch["x"] - cx) * T + 3, (ch["y"] - cy) * T + 6, 18, 14))
    px, py = (g.x - cx) * T, (g.y - cy) * T
    pygame.draw.rect(screen, (60, 100, 230), R(px + 4, py + 8, 16, 14))
    pygame.draw.rect(screen, (250, 220, 180), R(px + 6, py + 1, 12, 8))
    pygame.draw.rect(screen, (30, 30, 50), R(0, VIEW_R * T, W, H - VIEW_R * T))
    say_text(screen, font, "Lv%d  HP %d/%d  MP %d/%d  EXP %d/%d  金幣 %d" % (g.level, g.hp, g.maxhp, g.mp, g.maxmp, g.exp, g.exp_need(), g.gold),
             8, VIEW_R * T + 4, (255, 255, 255))
    quest = ["尚未接任務", "任務：打倒史萊姆 %d/3" % g.kills, "任務完成，回去找長老", "任務已完成"][g.quest]
    say_text(screen, font, quest + "    [I]背包 [空白]對話", 8, VIEW_R * T + 26, (255, 220, 120))


def draw_box(screen, font, lines, y, h):
    pygame.draw.rect(screen, (240, 240, 250), pygame.Rect(8, y, W - 16, h))
    pygame.draw.rect(screen, (20, 20, 60), pygame.Rect(11, y + 3, W - 22, h - 6))
    for i, s in enumerate(lines[:3]):
        say_text(screen, font, s, 20, y + 8 + i * 18)


def draw_dialog(screen, font, g):
    lines = wrap(g.pages[0], W - 56) if g.pages else [""]
    draw_box(screen, font, lines, H - 100, 92)
    say_text(screen, font, "Y/N 選擇" if g.ask == "buy" and len(g.pages) <= 1 else "按空白鍵繼續", W - 110, H - 28, (200, 200, 120))


def draw_menu(screen, font, g):
    pygame.draw.rect(screen, (20, 20, 60), pygame.Rect(120, 40, 240, 200))
    say_text(screen, font, "Lv%d  攻擊 %d  防禦 %d" % (g.level, g.atk(), g.defense()), 132, 48, (255, 255, 255))
    say_text(screen, font, "金幣 %d  HP %d/%d" % (g.gold, g.hp, g.maxhp), 132, 70, (255, 255, 255))
    items = g.items()
    for i, name in enumerate(items[:6]):
        say_text(screen, font, "%s%s x%d" % ("> " if i == g.cursor else "  ", name, g.inv[name]), 132, 100 + i * 20, (255, 255, 120))
    if g.weapon:
        say_text(screen, font, "裝備：鐵劍 (+4)", 132, 100 + min(6, len(items)) * 20, (180, 220, 255))
    say_text(screen, font, "確認＝使用  I＝關閉", 132, 218, (200, 200, 200))


def draw_enemy(screen, e):
    R = pygame.Rect
    cx, cy, c = W // 2, 110, e["color"]
    k = e["kind"]
    if k == "slime":
        pygame.draw.circle(screen, c, (cx, cy + 20), 42)
        pygame.draw.circle(screen, (255, 255, 255), (cx - 14, cy + 10), 7)
        pygame.draw.circle(screen, (255, 255, 255), (cx + 14, cy + 10), 7)
        pygame.draw.rect(screen, (20, 60, 30), R(cx - 8, cy + 34, 16, 4))
    elif k == "bat":
        pygame.draw.rect(screen, c, R(cx - 60, cy - 10, 40, 30))
        pygame.draw.rect(screen, c, R(cx + 20, cy - 10, 40, 30))
        pygame.draw.circle(screen, c, (cx, cy + 10), 24)
        pygame.draw.rect(screen, (255, 80, 80), R(cx - 12, cy + 4, 8, 6))
        pygame.draw.rect(screen, (255, 80, 80), R(cx + 4, cy + 4, 8, 6))
    else:
        pygame.draw.rect(screen, c, R(cx - 34, cy - 4, 68, 70))
        pygame.draw.circle(screen, c, (cx, cy - 18), 26)
        pygame.draw.rect(screen, (255, 230, 80), R(cx - 14, cy - 24, 8, 8))
        pygame.draw.rect(screen, (255, 230, 80), R(cx + 6, cy - 24, 8, 8))
        if k == "wolf":
            pygame.draw.rect(screen, (230, 230, 240), R(cx - 10, cy - 6, 20, 6))


def draw_bar(screen, x, y, w, ratio, color):
    pygame.draw.rect(screen, (60, 60, 60), pygame.Rect(x, y, w, 8))
    if ratio > 0:
        pygame.draw.rect(screen, color, pygame.Rect(x, y, max(1, int(w * ratio)), 8))


def draw_battle(screen, font, g):
    b, e = g.battle, g.battle["enemy"]
    screen.fill((30, 25, 50))
    draw_enemy(screen, e)
    say_text(screen, font, "%s  HP %d/%d" % (e["name"], e["hp"], e["maxhp"]), 150, 175, (255, 255, 255))
    draw_bar(screen, 150, 195, 180, e["hp"] / e["maxhp"], (230, 70, 70))
    say_text(screen, font, "Lv%d  HP %d/%d  MP %d/%d" % (g.level, g.hp, g.maxhp, g.mp, g.maxmp), 20, 225, (255, 255, 255))
    draw_bar(screen, 20, 245, 140, g.hp / g.maxhp, (80, 210, 90))
    draw_bar(screen, 20, 257, 140, g.mp / g.maxmp, (80, 140, 240))
    if b["phase"] == "cmd":
        for i, name in enumerate(CMDS):
            say_text(screen, font, ("> " if i == b["cursor"] else "  ") + name, 260 + (i % 2) * 90, 228 + (i // 2) * 24, (255, 255, 120))
    else:
        for i, s in enumerate(wrap(b["log"][0], W - 40)[:2]):
            say_text(screen, font, s, 20, 290 + i * 20, (255, 255, 255))
        say_text(screen, font, "▼", W - 30, 330, (200, 200, 120))


def draw(screen, font, g):
    if g.mode == "battle":
        draw_battle(screen, font, g)
        return
    draw_map(screen, font, g)
    if g.mode == "dialog":
        draw_dialog(screen, font, g)
    elif g.mode == "menu":
        draw_menu(screen, font, g)
    elif g.mode == "over":
        draw_box(screen, font, ["你倒下了……  按 Enter 重來"], 120, 60)


def main():
    pygame.init()
    pygame.display.set_caption("RPG 小村莊冒險")
    screen = pygame.display.set_mode((W, H))
    font = pygame.font.Font(None, 14)
    beep = {"encounter": pygame.mixer.Sound(frequency=200, ms=120), "hit": pygame.mixer.Sound(frequency=400, ms=50),
            "magic": pygame.mixer.Sound(frequency=700, ms=80), "hurt": pygame.mixer.Sound(frequency=150, ms=100)}
    keymap = {pygame.K_UP: "up", pygame.K_DOWN: "down", pygame.K_SPACE: "ok", pygame.K_RETURN: "ok",
              pygame.K_ESCAPE: "cancel", ord("i"): "menu", ord("y"): "y", ord("n"): "n"}
    clock = pygame.time.Clock()
    game = Game()
    acc = 0
    running = True
    while running:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                running = False
            elif ev.type == pygame.KEYDOWN and ev.key in keymap:
                if game.mode == "over":
                    if ev.key == pygame.K_RETURN:
                        game = Game()
                    continue
                r = game.press(keymap[ev.key])
                if r == "quit":
                    running = False
                else:
                    for e in r:
                        beep[e].play()
        k = pygame.key.get_pressed()
        dx = (1 if k[pygame.K_RIGHT] else 0) - (1 if k[pygame.K_LEFT] else 0)
        dy = (1 if k[pygame.K_DOWN] else 0) - (1 if k[pygame.K_UP] else 0)
        acc = min(acc + clock.tick(60), 250)
        while acc >= STEP:
            for e in game.update(dx, dy):
                beep[e].play()
            acc -= STEP
        draw(screen, font, game)
        pygame.display.flip()
    pygame.quit()


if __name__ == "__main__":
    main()
