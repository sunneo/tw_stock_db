# -*- coding: utf-8 -*-
# 飛彈指揮官 Missile Command
#
# 玩法：敵方飛彈從天上落下，目標是你的 6 座城市與 3 座飛彈基地。用滑鼠點擊指定位置，
#       從最近且有彈藥的基地發射反飛彈；反飛彈到達後產生爆炸圈，敵彈碰到爆炸圈就被攔截，
#       還會連鎖產生新的小爆炸。每一波的敵彈變多、變快。城市全毀則遊戲結束。
#       過關時依存活城市與剩餘彈藥加分。
# 操作：滑鼠左鍵點擊＝發射到點擊處；也可用方向鍵移動準星、空白鍵發射（沒有滑鼠時用）。
#       Enter：遊戲結束後重來；Esc：離開。（先用滑鼠點一下視窗取得鍵盤。）
#
# 繪圖指令預算（每幀上限 200）：
#   清屏 1 + 地面 1 + 城市 6 + 基地 3 + 敵彈 <= MAX_ENEMY(12) 道線 + 反飛彈 <= MAX_PLAYER(10) 道線
#   + 反飛彈目標叉叉 <= 10 + 爆炸 <= MAX_BOOM(16) 個圓 + 準星 2 + HUD 文字 4 + 提示 1
#   最壞合計約 66 道，低於 200。敵彈與爆炸超過上限時不再新增（敵彈延後發射、爆炸略過）。
import math
import random
import pygame


def tone(freq, ms, rate=22050, volume=0.3):
    """短音效：標準的 pygame 寫法——產生 16 位元單聲道方波 PCM，交給 pygame.mixer.Sound(buffer=…)。"""
    import array as _array, math as _math
    if not pygame.mixer.get_init():
        pygame.mixer.init(rate, -16, 1)
    n = int(rate * ms / 1000)
    pcm = _array.array("h", (int(32767 * volume) if _math.sin(2 * _math.pi * freq * i / rate) >= 0 else -int(32767 * volume) for i in range(n)))
    return pygame.mixer.Sound(buffer=pcm.tobytes())

W, H = 560, 420
STEP = 1000 // 60
GROUND = H - 30
CITY_X = [70, 130, 190, 370, 430, 490]
BASE_X = [20, 280, 540]
MAX_ENEMY, MAX_PLAYER, MAX_BOOM = 12, 10, 16
BOOM_MAX_R = 28
AMMO_PER_BASE = 10


class Game:
    def __init__(self, seed=None):
        self.rnd = random.Random(seed)
        self.cities = [True] * len(CITY_X)
        self.bases = [True] * len(BASE_X)
        self.ammo = [AMMO_PER_BASE] * len(BASE_X)
        self.score = 0
        self.wave = 0
        self.over = False
        self.cross = [W // 2, H // 2]
        self.enemies, self.shots, self.booms = [], [], []
        self.start_wave()

    # ---- 波次 ----
    def start_wave(self):
        self.wave += 1
        self.to_spawn = 5 + 3 * self.wave
        self.spawn_timer = 40
        self.ammo = [AMMO_PER_BASE if alive else 0 for alive in self.bases]
        self.bonus_text = ""

    def targets(self):
        t = [(CITY_X[i], GROUND) for i, a in enumerate(self.cities) if a]
        t += [(BASE_X[i], GROUND) for i, a in enumerate(self.bases) if a]
        return t

    def spawn_enemy(self):
        tg = self.targets()
        if not tg or len(self.enemies) >= MAX_ENEMY:
            return
        tx, ty = self.rnd.choice(tg)
        sx = self.rnd.randint(10, W - 10)
        d = math.hypot(tx - sx, ty)
        sp = min(2.2, 0.55 + 0.08 * self.wave) * self.rnd.uniform(0.8, 1.2)
        self.enemies.append({"x": sx, "y": 0.0, "sx": sx, "tx": tx, "ty": ty,
                             "vx": (tx - sx) / d * sp, "vy": ty / d * sp})

    # ---- 玩家動作 ----
    def fire(self, x, y):
        """往 (x, y) 發射反飛彈：用距離最近且有彈藥的基地。回傳是否成功。"""
        if self.over or len(self.shots) >= MAX_PLAYER:
            return False
        y = min(y, GROUND - 10)
        best = None
        for i, alive in enumerate(self.bases):
            if alive and self.ammo[i] > 0:
                d = abs(BASE_X[i] - x)
                if best is None or d < best[0]:
                    best = (d, i)
        if best is None:
            return False
        i = best[1]
        self.ammo[i] -= 1
        bx, by = BASE_X[i], GROUND - 6
        d = max(1.0, math.hypot(x - bx, y - by))
        self.shots.append({"x": float(bx), "y": float(by), "sx": bx, "sy": by, "tx": x, "ty": y,
                           "vx": (x - bx) / d * 7, "vy": (y - by) / d * 7})
        return True

    def explode(self, x, y, max_r=BOOM_MAX_R):
        if len(self.booms) < MAX_BOOM:
            self.booms.append({"x": x, "y": y, "r": 2.0, "grow": True, "max": max_r})

    # ---- 每步更新 ----
    def update(self):
        """回傳事件清單：'fire'、'hit'（攔截）、'ground'（地面被炸）。"""
        ev = []
        if self.over:
            return ev
        if self.to_spawn > 0:
            self.spawn_timer -= 1
            if self.spawn_timer <= 0:
                self.spawn_enemy()
                self.to_spawn -= 1
                self.spawn_timer = max(15, 70 - 4 * self.wave) + self.rnd.randint(0, 30)
        for s in self.shots[:]:
            s["x"] += s["vx"]
            s["y"] += s["vy"]
            if math.hypot(s["tx"] - s["x"], s["ty"] - s["y"]) <= 7:
                self.shots.remove(s)
                self.explode(s["tx"], s["ty"])
        for b in self.booms[:]:
            b["r"] += 0.8 if b["grow"] else -0.5
            if b["r"] >= b["max"]:
                b["grow"] = False
            if b["r"] <= 0:
                self.booms.remove(b)
        for e in self.enemies[:]:
            e["x"] += e["vx"]
            e["y"] += e["vy"]
            if any(math.hypot(e["x"] - b["x"], e["y"] - b["y"]) <= b["r"] for b in self.booms):
                self.enemies.remove(e)
                self.score += 25
                self.explode(e["x"], e["y"], 18)
                ev.append("hit")
            elif e["y"] >= e["ty"]:
                self.enemies.remove(e)
                self.destroy_at(e["tx"])
                self.explode(e["tx"], GROUND, 24)
                ev.append("ground")
        if not any(self.cities):
            self.over = True
        elif self.to_spawn == 0 and not self.enemies and not self.booms:
            n = sum(self.cities)
            a = sum(self.ammo)
            self.score += n * 100 + a * 5
            self.start_wave()
            self.bonus_text = "Bonus +%d" % (n * 100 + a * 5)
        return ev

    def destroy_at(self, x):
        for i, cx in enumerate(CITY_X):
            if cx == x:
                self.cities[i] = False
        for i, bx in enumerate(BASE_X):
            if bx == x:
                self.bases[i] = False
                self.ammo[i] = 0


def draw(screen, font, g):
    screen.fill((8, 8, 24))
    pygame.draw.rect(screen, (90, 60, 30), pygame.Rect(0, GROUND, W, H - GROUND))
    for x, alive in zip(CITY_X, g.cities):
        if alive:
            pygame.draw.rect(screen, (90, 200, 255), pygame.Rect(x - 14, GROUND - 14, 28, 14))
        else:
            pygame.draw.rect(screen, (70, 50, 40), pygame.Rect(x - 14, GROUND - 3, 28, 3))
    for x, alive in zip(BASE_X, g.bases):
        c = (120, 240, 120) if alive else (70, 50, 40)
        pygame.draw.rect(screen, c, pygame.Rect(x - 10, GROUND - 8, 20, 8))
    for e in g.enemies:
        pygame.draw.line(screen, (255, 90, 90), (e["sx"], 0), (int(e["x"]), int(e["y"])))
    for s in g.shots:
        pygame.draw.line(screen, (120, 200, 255), (s["sx"], s["sy"]), (int(s["x"]), int(s["y"])))
        pygame.draw.rect(screen, (255, 255, 255), pygame.Rect(s["tx"] - 2, s["ty"] - 2, 4, 4))
    for b in g.booms:
        c = (255, 220, 100) if b["grow"] else (255, 120, 60)
        pygame.draw.circle(screen, c, (int(b["x"]), int(b["y"])), max(1, int(b["r"])))
    cx, cy = g.cross
    pygame.draw.line(screen, (255, 255, 255), (cx - 8, cy), (cx + 8, cy))
    pygame.draw.line(screen, (255, 255, 255), (cx, cy - 8), (cx, cy + 8))
    screen.blit(font.render("Score %d" % g.score, True, (255, 255, 255)), (8, 16))
    screen.blit(font.render("Wave %d" % g.wave, True, (200, 220, 255)), (W // 2 - 25, 16))
    screen.blit(font.render("彈藥 %s" % "/".join(str(a) for a in g.ammo), True, (150, 255, 150)), (W - 130, 16))
    if g.bonus_text:
        screen.blit(font.render(g.bonus_text, True, (255, 230, 120)), (W // 2 - 35, 40))
    if g.over:
        screen.blit(font.render("GAME OVER  按 Enter 重來", True, (255, 255, 255)), (W // 2 - 90, H // 2 - 40))


def main():
    pygame.init()
    pygame.display.set_caption("飛彈指揮官 Missile Command")
    screen = pygame.display.set_mode((W, H))
    font = pygame.font.Font(None, 14)
    snd = {"fire": tone(600, 40), "hit": tone(300, 60),
           "ground": tone(120, 150)}
    clock = pygame.time.Clock()
    game = Game()
    acc = 0
    running = True
    while running:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                running = False
            elif ev.type == pygame.MOUSEBUTTONDOWN and ev.button == 1:
                game.cross[:] = ev.pos
                if game.fire(*ev.pos):
                    snd["fire"].play()
            elif ev.type == pygame.KEYDOWN:
                if ev.key == pygame.K_ESCAPE:
                    running = False
                elif ev.key == pygame.K_SPACE:
                    if game.fire(*game.cross):
                        snd["fire"].play()
                elif ev.key == pygame.K_RETURN and game.over:
                    game = Game()
        keys = pygame.key.get_pressed()
        game.cross[0] = max(0, min(W, game.cross[0] + 5 * (keys[pygame.K_RIGHT] - keys[pygame.K_LEFT])))
        game.cross[1] = max(0, min(GROUND, game.cross[1] + 5 * (keys[pygame.K_DOWN] - keys[pygame.K_UP])))
        acc = min(acc + clock.tick(60), 250)
        while acc >= STEP:
            for e in game.update():
                if e in snd:
                    snd[e].play()
            acc -= STEP
        draw(screen, font, game)
        pygame.display.flip()
    pygame.quit()


if __name__ == "__main__":
    main()
