# -*- coding: utf-8 -*-
# 賽車 Racing（偽 3D 道路）
#
# 玩法：道路用「水平色帶」畫成：越遠的色帶越窄，並依彎道與起伏左右、上下偏移，就有 3D 的感覺。
#       你要在彎道中保持在路上，避開對向來車與前方慢車。撞車會大幅減速；衝出路外會被草地拖慢。
#       倒數計時歸零就結束，每跑滿 CHECKPOINT_M 公尺過一個檢查點並加時。
# 操作：上方向鍵＝油門、下方向鍵＝煞車、左右方向鍵＝轉向；Enter：結束後重來；Esc：離開。
#       （先用滑鼠點一下視窗取得鍵盤。）
#
# 繪圖指令預算（每幀上限 200）：
#   天空 1 + 太陽 1 + 草地底色 1 + 遠方路面 1
#   + 近 NSEG(32) 個色帶，每帶最多 4 道（淺色草帶、紅白路肩、路面、中線）= 最多 128
#   （高度不足 1 像素或被山坡擋住的色帶直接略過，實際更少）
#   + 其他車 <= MAX_CARS(6) 台 x 2 道（車身、車頂）= 12 + 玩家車 4 + HUD 文字 3 + 提示 1
#   最壞合計約 152 道，低於 200。
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

W, H = 480, 360
STEP = 1000 // 60
HY = 150                          # 地平線的 y
NSEG = 32                         # 畫出的色帶（路段）數
TRACK = 600                       # 賽道總長（路段數），之後繞圈
HALF = 170.0                      # 路面半寬（像素，近處、縮放比例 1 時）
A_PROJ, C_PROJ = 531.0, 2.2       # 透視：y = HY + A / (深度 + C)
VMAX = 0.2                        # 最高速（路段／步）
SEG_M = 3                         # 一個路段代表幾公尺
CHECKPOINT_M = 1500
MAX_CARS = 6
CAR_W = 0.4                       # 車寬（以路面半寬為 1）
GRASS = ((40, 140, 50), (50, 165, 60))
ROAD = ((105, 105, 110), (120, 120, 126))
RUMBLE = ((210, 40, 40), (240, 240, 240))


def curve_at(i):
    """第 i 個路段的彎曲量：正＝向右彎。有直路也有彎道。"""
    s = math.sin(2 * math.pi * 3 * i / TRACK) * math.sin(2 * math.pi * 5 * i / TRACK + 0.5) * 2.2
    k = max(0.0, min(1.0, 2.5 * (abs(s) - 0.25)))
    return 0.015 * k * (1 if s > 0 else -1)


def elev_at(z):
    """賽道高度（連續函數，z 可為小數）。頻率取整數，繞一圈能接回起點。"""
    t = 2 * math.pi * z / TRACK
    return 22 * math.sin(8 * t) + 12 * math.sin(19 * t + 1)


class Game:
    def __init__(self, seed=None):
        self.rnd = random.Random(seed)
        self.pos = 0.0            # 沿賽道前進的距離（路段）
        self.v = 0.0
        self.px = 0.0             # 玩家橫向位置，-1..1 在路面上
        self.time = 45.0
        self.next_cp = CHECKPOINT_M
        self.hit_cd = 0           # 撞車後的無敵步數
        self.over = False
        self.msg = ""
        self.msg_t = 0
        self.cars = []
        for k in range(MAX_CARS):
            self.cars.append(self.new_car(40 + k * 45))

    def new_car(self, ahead):
        oncoming = self.rnd.random() < 0.5
        lane = self.rnd.uniform(-0.8, -0.1) if oncoming else self.rnd.uniform(0.1, 0.8)
        speed = -0.07 if oncoming else self.rnd.uniform(0.04, 0.09)    # 對向車的速度為負
        color = self.rnd.choice([(240, 200, 40), (60, 120, 240), (60, 200, 120), (230, 120, 200)])
        return {"z": (self.pos + ahead) % TRACK, "lane": lane, "v": speed, "color": color}

    def update(self, throttle, brake, steer):
        """throttle/brake: 布林；steer: -1、0、1。回傳事件清單：'crash'、'checkpoint'。"""
        ev = []
        if self.over:
            return ev
        vcap = VMAX if abs(self.px) <= 1.0 else 0.07            # 衝出路外：最高速降低
        if throttle:
            self.v += 0.003
        elif brake:
            self.v -= 0.008
        else:
            self.v -= 0.0015
        if self.v > vcap:
            self.v = max(vcap, self.v - 0.006)                  # 衝出路外：被草地拖慢
        self.v = max(0.0, min(self.v, VMAX))
        pct = self.v / VMAX
        self.px += steer * 0.035 * (0.3 + pct)
        self.px -= curve_at(int(self.pos)) * pct * 0.7      # 離心力：彎道把車往外推
        self.px = max(-2.5, min(2.5, self.px))
        self.pos += self.v
        self.time -= STEP / 1000.0
        if self.hit_cd > 0:
            self.hit_cd -= 1
        # 其他車
        for c in self.cars:
            c["z"] = (c["z"] + c["v"]) % TRACK
            rel = (c["z"] - self.pos) % TRACK
            if rel > TRACK / 2:                 # 已被遠遠拋在後面：重生到前方
                c.update(self.new_car(self.rnd.randint(NSEG - 8, NSEG + 20)))
            elif self.hit_cd == 0 and 0.4 <= rel <= 2.2 and abs(c["lane"] - self.px) < CAR_W * 0.9:
                self.v *= 0.25
                self.hit_cd = 90
                ev.append("crash")
        # 檢查點
        if self.pos * SEG_M >= self.next_cp:
            self.next_cp += CHECKPOINT_M
            self.time += 25
            self.msg, self.msg_t = "Checkpoint +25s", 120
            ev.append("checkpoint")
        if self.msg_t > 0:
            self.msg_t -= 1
        if self.time <= 0:
            self.time = 0
            self.over = True
        return ev


def project(pos, px, cars):
    """算出畫面上的色帶與車。回傳 (bands, car_sprites)。這個函式不畫圖，方便單獨測試。
    色帶由近往遠處理，並記錄已畫到的最高 y（top），被山坡擋住的就略過。"""
    i0 = int(pos)
    frac = pos - i0
    hcam = elev_at(pos)
    pts = []                      # 每個路段邊界：(y, 中心偏移, 縮放)
    o, dx = 0.0, 0.0
    for j in range(NSEG + 1):
        d = j - frac
        yb = HY + A_PROJ / (d + C_PROJ)
        sc = (yb - HY) / (H - HY)
        y = yb - (elev_at(i0 + j) - hcam) * sc
        pts.append((y, o, sc))
        o += dx
        dx += curve_at(i0 + j)
    bands = []
    drawn = {}
    top = float(H)
    for j in range(NSEG):
        (yn, on, sn), (yf, of, sf) = pts[j], pts[j + 1]
        if yf >= top - 0.5:
            continue
        y1 = min(yn, top)
        h = int(round(y1)) - int(round(yf))
        top = yf
        if h < 1:
            continue
        om, sm = (on + of) / 2, (sn + sf) / 2
        bands.append({"y": int(round(yf)), "h": h, "cx": W / 2 + (om - px) * HALF * sm, "hw": HALF * sm,
                      "light": ((i0 + j) // 2) % 2, "lane": ((i0 + j) // 2) % 2 == 0})
        drawn[j] = True
    # 最遠處（色帶已細於 1 像素）：用最上面那條色帶的位置，畫一小段窄路面接到地平線
    if bands:
        t = bands[-1]
        far = {"y": HY, "h": max(0, t["y"] - HY), "cx": t["cx"], "hw": max(1.0, t["hw"] * 0.15)}
    else:
        far = {"y": HY, "h": 0, "cx": W / 2, "hw": 1.0}
    sprites = []
    for c in cars:
        rel = (c["z"] - i0) % TRACK
        j = int(rel)
        if j >= NSEG or j not in drawn:
            continue
        t = rel - j
        (yn, on, sn), (yf, of, sf) = pts[j], pts[j + 1]
        y = yn + (yf - yn) * t
        o = on + (of - on) * t
        sc = sn + (sf - sn) * t
        w = CAR_W * HALF * sc
        if w < 2:
            continue
        sprites.append({"x": W / 2 + (o + c["lane"] - px) * HALF * sc, "y": y, "w": w, "color": c["color"], "rel": rel})
    sprites.sort(key=lambda s: -s["rel"])                       # 遠的先畫
    return bands, far, sprites


def draw(screen, font, g):
    bands, far, sprites = project(g.pos, g.px, g.cars)
    R = pygame.Rect
    screen.fill((120, 190, 245))                                # 天空（清屏）
    pygame.draw.circle(screen, (255, 240, 170), (370, 90), 22)
    pygame.draw.rect(screen, GRASS[0], R(0, HY, W, H - HY))
    if far["h"] > 0:
        pygame.draw.rect(screen, ROAD[0], R(int(far["cx"] - far["hw"]), HY, int(far["hw"] * 2), far["h"]))
    for b in reversed(bands):                                   # 由遠到近畫（陣列由近到遠）
        y, h, cx, hw, lt = b["y"], b["h"], b["cx"], b["hw"], b["light"]
        if lt:
            pygame.draw.rect(screen, GRASS[1], R(0, y, W, h))
        rw = hw * 1.12
        pygame.draw.rect(screen, RUMBLE[lt], R(int(cx - rw), y, int(rw * 2), h))
        pygame.draw.rect(screen, ROAD[lt], R(int(cx - hw), y, int(hw * 2), h))
        if b["lane"]:
            lw = max(1, int(hw * 0.03))
            pygame.draw.rect(screen, (240, 240, 240), R(int(cx - lw), y, lw * 2, h))
    for s in sprites:
        w = int(s["w"])
        h = max(2, int(w * 0.55))
        pygame.draw.rect(screen, s["color"], R(int(s["x"] - w / 2), int(s["y"]) - h, w, h))
        pygame.draw.rect(screen, (30, 30, 40), R(int(s["x"] - w / 4), int(s["y"]) - h, max(1, w // 2), max(1, h // 3)))
    # 玩家車（固定在畫面下方；撞車無敵時閃爍）
    if g.hit_cd % 10 < 6:
        pygame.draw.rect(screen, (225, 40, 40), R(W // 2 - 30, H - 58, 60, 26))
        pygame.draw.rect(screen, (40, 40, 60), R(W // 2 - 16, H - 66, 32, 10))
        pygame.draw.rect(screen, (20, 20, 20), R(W // 2 - 34, H - 40, 10, 12))
        pygame.draw.rect(screen, (20, 20, 20), R(W // 2 + 24, H - 40, 10, 12))
    screen.blit(font.render("Time %d" % g.time, True, (255, 255, 255)), (8, 16))
    screen.blit(font.render("%d m" % (g.pos * SEG_M), True, (255, 255, 255)), (W // 2 - 20, 16))
    screen.blit(font.render("%d km/h" % (g.v / VMAX * 180), True, (255, 255, 255)), (W - 80, 16))
    if g.over:
        screen.blit(font.render("TIME UP  %d m  按 Enter 重來" % (g.pos * SEG_M), True, (255, 255, 255)), (W // 2 - 100, 100))
    elif g.msg_t > 0:
        screen.blit(font.render(g.msg, True, (255, 240, 120)), (W // 2 - 50, 100))


def main():
    pygame.init()
    pygame.display.set_caption("賽車 Racing")
    screen = pygame.display.set_mode((W, H))
    font = pygame.font.Font(None, 14)
    snd = {"crash": tone(110, 180), "checkpoint": tone(880, 120)}
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
                elif ev.key == pygame.K_RETURN and game.over:
                    game = Game()
        k = pygame.key.get_pressed()
        steer = (1 if k[pygame.K_RIGHT] else 0) - (1 if k[pygame.K_LEFT] else 0)
        acc = min(acc + clock.tick(60), 250)
        while acc >= STEP:
            for e in game.update(k[pygame.K_UP], k[pygame.K_DOWN], steer):
                snd[e].play()
            acc -= STEP
        draw(screen, font, game)
        pygame.display.flip()
    pygame.quit()


if __name__ == "__main__":
    main()
