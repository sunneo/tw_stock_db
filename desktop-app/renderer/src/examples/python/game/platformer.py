# -*- coding: utf-8 -*-
# 類馬力歐闖關 Platformer
#
# 玩法：橫向捲動的闖關遊戲。左右跑、跳躍（按得越久跳得越高）、跳過坑洞，踩敵人的頭可以消滅牠
#       （從側面碰到會掉命），撿金幣，從下方頂「?」磚塊會噴出金幣，碰到終點旗桿過關。
#       共 2 個關卡，通關後顯示勝利畫面。3 條命，掉進坑洞或被敵人碰到都扣 1 條。
# 操作：左右方向鍵＝移動；上方向鍵或空白鍵＝跳躍；Enter：結束後重來；Esc：離開。
#       （先用滑鼠點一下視窗取得鍵盤。）
#
# 地圖字元：'.' 空、'#' 地面、'B' 磚塊、'?' 問號磚、'X' 已用完的磚、'o' 金幣、
#           'E' 敵人出生點、'P' 玩家起點、'F' 旗桿。
#
# 繪圖指令預算（每幀上限 200）：
#   只畫畫面內的格子，且把「同一列、連續、同顏色」的地形格併成一個長矩形。
#   清屏 1 + 雲 2 + 地形 <= TILE_BUDGET(100，超過就略過多的) + 金幣 <= MAX_COINS(30)
#   + 旗桿 2 + 敵人 <= MAX_ENEMIES(10) x 2 = 20 + 玩家 2 + HUD 1 + 提示 1
#   最壞合計 = 1+2+100+30+2+20+2+2 = 159 道，低於 200。
import pygame


def tone(freq, ms, rate=22050, volume=0.3):
    """短音效：標準的 pygame 寫法——產生 16 位元單聲道方波 PCM，交給 pygame.mixer.Sound(buffer=…)。"""
    import array as _array, math as _math
    if not pygame.mixer.get_init():
        pygame.mixer.init(rate, -16, 1)
    n = int(rate * ms / 1000)
    pcm = _array.array("h", (int(32767 * volume) if _math.sin(2 * _math.pi * freq * i / rate) >= 0 else -int(32767 * volume) for i in range(n)))
    return pygame.mixer.Sound(buffer=pcm.tobytes())

W, H = 480, 312
STEP = 1000 // 60
T = 24                            # 一格的像素大小
ROWS = 13
TILE_BUDGET, MAX_COINS, MAX_ENEMIES = 100, 30, 10
SOLID = "#B?X"
GRAVITY, JUMP_V, MAX_FALL, RUN = 0.5, -9.8, 12.0, 2.8
PW, PH = 18, 22                   # 玩家碰撞盒
EW, EH = 20, 20                   # 敵人碰撞盒

# 每關 13 列字串（由上到下），每列長度必須相同
LEVELS = [
    [
        "................................................................",
        "................................................................",
        "................................................................",
        ".............o..................................................",
        "................................................................",
        "...............................o....ooo.............BBB.........",
        "....................................###.....ooo.............F...",
        ".........?..B?B...............ooo....................#......F...",
        "..............................###...................##......F...",
        "................oooo.....oo........................###......F...",
        "...P..................E...........E.....E.........####....E.F...",
        "#########################...#################...################",
        "#########################...#################...################",
    ],
    [
        "................................................................................................",
        "................................................................................................",
        "................................................................................................",
        "................................................................................................",
        "................................................................................................",
        "......ooooo..........ooo.................ooo.........oooo.......................................",
        "..............................................................o....oooo...........#.........F...",
        ".......B?B...................................................BBBBB...............##.........F...",
        "...............ooo..#####......oooo.....B?BBB........oooo..............ooo......###.........F...",
        "...............................oooo...................##.......................####.........F...",
        "...P........E.........E..E............E...E.....E...........E..E..E...........#####.E...E...F...",
        "###############...#############....##################....##############...######################",
        "###############...#############....##################....##############...######################",
    ],
]


class Game:
    def __init__(self):
        self.level = 0
        self.score = 0
        self.coins = 0
        self.lives = 3
        self.state = "play"        # play / clear / win / over
        self.timer = 0
        self.load_level(0)

    def load_level(self, n):
        rows = LEVELS[n]
        assert len(rows) == ROWS and len({len(r) for r in rows}) == 1, "地圖每列長度要一致"
        self.level = n
        self.grid = [list(r) for r in rows]
        self.cols = len(rows[0])
        self.enemies = []
        for r, row in enumerate(self.grid):
            for c, ch in enumerate(row):
                if ch == "P":
                    self.start = (c * T + 3, r * T + T - PH)
                elif ch == "E":
                    self.enemies.append({"x": c * T + 2.0, "y": r * T + T - EH + 0.0, "vx": -0.7, "vy": 0.0, "alive": True})
                if ch in "PE":
                    row[c] = "."
        self.respawn()
        self.cam = 0.0

    def respawn(self):
        self.x, self.y = float(self.start[0]), float(self.start[1])
        self.vx = self.vy = 0.0
        self.on_ground = False
        self.jump_held = False
        self.inv = 90              # 重生後短暫無敵（步數）

    # ---- 地圖查詢 ----
    def tile(self, c, r):
        if c < 0 or c >= self.cols:
            return "#"             # 左右邊界是牆
        if r < 0 or r >= ROWS:
            return "."
        return self.grid[r][c]

    def hits(self, x, y, w, h):
        """矩形碰到的所有實心格 (c, r)。"""
        out = []
        for r in range(int(y // T), int((y + h - 0.01) // T) + 1):
            for c in range(int(x // T), int((x + w - 0.01) // T) + 1):
                if self.tile(c, r) in SOLID:
                    out.append((c, r))
        return out

    def move_body(self, b, w, h):
        """移動一個有 x, y, vx, vy 的物體並處理碰撞（先 x 後 y，各自貼齊格線）。
        回傳 (落地?, 撞到的頭頂格, 撞牆?)。固定步長下速度 < 一格，所以不會穿牆。"""
        landed, bumped, wall = False, [], False
        b["x"] += b["vx"]
        hs = self.hits(b["x"], b["y"], w, h)
        if hs:
            wall = True
            if b["vx"] > 0:
                b["x"] = min(c for c, r in hs) * T - w
            else:
                b["x"] = (max(c for c, r in hs) + 1) * T
        b["y"] += b["vy"]
        hs = self.hits(b["x"], b["y"], w, h)
        if hs:
            if b["vy"] > 0:
                b["y"] = min(r for c, r in hs) * T - h
                landed = True
            else:
                b["y"] = (max(r for c, r in hs) + 1) * T
                bumped = hs
            b["vy"] = 0.0
        return landed, bumped, wall

    # ---- 每步更新 ----
    def update(self, move, jump):
        ev = []
        if self.state in ("win", "over"):
            return ev
        if self.state == "clear":
            self.timer -= 1
            if self.timer <= 0:
                if self.level + 1 >= len(LEVELS):
                    self.state = "win"
                else:
                    self.load_level(self.level + 1)
                    self.state = "play"
            return ev
        # 玩家
        self.vx += (move * RUN - self.vx) * 0.25
        if jump and self.on_ground and not self.jump_held:
            self.vy = JUMP_V
            ev.append("jump")
        if not jump and self.vy < -3:
            self.vy = -3                        # 提早放開：跳得比較低
        self.jump_held = jump
        self.vy = min(MAX_FALL, self.vy + GRAVITY)
        me = {"x": self.x, "y": self.y, "vx": self.vx, "vy": self.vy}
        landed, bumped, wall = self.move_body(me, PW, PH)
        self.x, self.y, self.vy = me["x"], me["y"], me["vy"]
        self.vx = 0.0 if wall else me["vx"]
        self.on_ground = landed
        for c, r in bumped[:1]:
            if self.grid[r][c] == "?":
                self.grid[r][c] = "X"
                self.coins += 1
                self.score += 100
                ev.append("coin")
        # 金幣與旗桿
        for r in range(int(self.y // T), int((self.y + PH - 0.01) // T) + 1):
            for c in range(int(self.x // T), int((self.x + PW - 0.01) // T) + 1):
                ch = self.tile(c, r)
                if ch == "o":
                    self.grid[r][c] = "."
                    self.coins += 1
                    self.score += 50
                    ev.append("coin")
                elif ch == "F" and self.state == "play":
                    self.state, self.timer = "clear", 120
                    self.score += 500
                    ev.append("clear")
        if self.inv > 0:
            self.inv -= 1
        # 敵人
        for e in self.enemies:
            if not e["alive"] or abs(e["x"] - self.x) > W:
                continue
            e["vy"] = min(MAX_FALL, e["vy"] + GRAVITY)
            landed, _, wall = self.move_body(e, EW, EH)
            ahead = e["x"] + (EW + 1 if e["vx"] > 0 else -1)
            if wall or (landed and self.tile(int(ahead // T), int((e["y"] + EH + 2) // T)) not in SOLID):
                e["vx"] = -e["vx"]
            if self.state == "play" and abs(e["x"] - self.x) < (PW + EW) / 2 and abs(e["y"] - self.y) < PH:
                if self.vy > 0 and self.y + PH - self.vy <= e["y"] + 8:
                    e["alive"] = False
                    self.vy = -6.0
                    self.score += 100
                    ev.append("stomp")
                elif self.inv == 0:
                    ev += self.lose_life()
        if self.state == "play" and self.y > ROWS * T + 40:
            ev += self.lose_life()
        self.cam = max(0.0, min(self.cols * T - W, self.x - W / 3))
        return ev

    def lose_life(self):
        self.lives -= 1
        if self.lives <= 0:
            self.state = "over"
        else:
            self.respawn()
        return ["hurt"]


def tile_runs(g):
    """畫面內的地形格併成長矩形：回傳 (x, y, w, color) 清單（高度固定為 T）。"""
    runs = []
    c0 = int(g.cam // T)
    c1 = min(g.cols, c0 + W // T + 2)
    for r in range(ROWS):
        c = c0
        while c < c1:
            ch = g.grid[r][c]
            if ch in SOLID:
                color = tile_color(g, ch, c, r)
                s = c
                while c < c1 and g.grid[r][c] in SOLID and tile_color(g, g.grid[r][c], c, r) == color:
                    c += 1
                runs.append((int(s * T - g.cam), r * T, (c - s) * T, color))
            else:
                c += 1
    return runs


def tile_color(g, ch, c, r):
    if ch == "#":
        return (90, 190, 70) if g.tile(c, r - 1) not in SOLID else (140, 90, 50)    # 上面沒東西＝草地
    return {"B": (190, 90, 60), "?": (245, 200, 50), "X": (110, 90, 80)}[ch]


def draw(screen, font, g):
    R = pygame.Rect
    screen.fill((110, 185, 245))
    for k in range(2):                                      # 兩朵雲，慢速視差捲動
        cx = (k * 330 + 60 - int(g.cam * 0.3)) % (W + 120) - 60
        pygame.draw.rect(screen, (245, 250, 255), R(cx, 50 + k * 40, 70, 16))
    for x, y, w, color in tile_runs(g)[:TILE_BUDGET]:
        pygame.draw.rect(screen, color, R(x, y, w, T))
    c0, c1 = int(g.cam // T), min(g.cols, int(g.cam // T) + W // T + 2)
    n_coin = 0
    pole_rows = {}
    for r in range(ROWS):
        for c in range(c0, c1):
            ch = g.grid[r][c]
            if ch == "o" and n_coin < MAX_COINS:
                n_coin += 1
                pygame.draw.circle(screen, (255, 220, 40), (int(c * T + T / 2 - g.cam), r * T + T // 2), 5)
            elif ch == "F":
                lo, hi = pole_rows.get(c, (r, r))
                pole_rows[c] = (min(lo, r), max(hi, r))
    for c, (lo, hi) in pole_rows.items():
        px = int(c * T + T / 2 - g.cam)
        pygame.draw.rect(screen, (235, 235, 235), R(px - 2, lo * T, 4, (hi - lo + 1) * T))
        pygame.draw.rect(screen, (230, 50, 50), R(px + 2, lo * T + 2, 18, 12))
    shown = 0
    for e in g.enemies:
        if e["alive"] and -T < e["x"] - g.cam < W and shown < MAX_ENEMIES:
            shown += 1
            ex, ey = int(e["x"] - g.cam), int(e["y"])
            pygame.draw.rect(screen, (150, 80, 40), R(ex, ey, EW, EH))
            pygame.draw.rect(screen, (255, 255, 255), R(ex + 4, ey + 5, 12, 5))
    if g.inv % 8 < 5 and g.state != "over":
        px, py = int(g.x - g.cam), int(g.y)
        pygame.draw.rect(screen, (60, 90, 230), R(px, py + 8, PW, PH - 8))
        pygame.draw.rect(screen, (230, 50, 50), R(px - 1, py, PW + 2, 8))
    screen.blit(font.render("Lv%d  Coins %d  Score %d  Lives %d" % (g.level + 1, g.coins, g.score, g.lives), True, (20, 30, 60)), (8, 16))
    if g.state == "clear":
        screen.blit(font.render("Level Clear!", True, (20, 30, 60)), (W // 2 - 35, 120))
    elif g.state == "win":
        screen.blit(font.render("YOU WIN!  Score %d  按 Enter 重來" % g.score, True, (20, 30, 60)), (W // 2 - 110, 120))
    elif g.state == "over":
        screen.blit(font.render("GAME OVER  按 Enter 重來", True, (20, 30, 60)), (W // 2 - 85, 120))


def main():
    pygame.init()
    pygame.display.set_caption("類馬力歐闖關 Platformer")
    screen = pygame.display.set_mode((W, H))
    font = pygame.font.Font(None, 14)
    snd = {"jump": tone(440, 50), "coin": tone(990, 50),
           "stomp": tone(250, 70), "hurt": tone(120, 200),
           "clear": tone(700, 250)}
    clock = pygame.time.Clock()
    game = Game()
    acc = 0
    running = True
    while running:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                running = False
            elif ev.type == pygame.KEYDOWN:
                if ev.key == pygame.K_ESCAPE:
                    running = False
                elif ev.key == pygame.K_RETURN and game.state in ("win", "over"):
                    game = Game()
        k = pygame.key.get_pressed()
        move = (1 if k[pygame.K_RIGHT] else 0) - (1 if k[pygame.K_LEFT] else 0)
        jump = bool(k[pygame.K_UP] or k[pygame.K_SPACE])
        acc = min(acc + clock.tick(60), 250)
        while acc >= STEP:
            for e in game.update(move, jump):
                snd[e].play()
            acc -= STEP
        draw(screen, font, game)
        pygame.display.flip()
    pygame.quit()


if __name__ == "__main__":
    main()
