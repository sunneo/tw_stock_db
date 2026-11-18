# -*- coding: utf-8 -*-
# 打磚塊 Breakout
#
# 玩法：用球拍接球並把磚塊全部打掉。球打到球拍的位置不同，反彈角度不同（邊緣角度大）。
#       每清掉一關，球速加快並重新排磚；3 條命用完就結束。
# 操作：左右方向鍵移動球拍；空白鍵發球；遊戲結束後按 Enter 重來；Esc 離開。
#       （先用滑鼠點一下視窗取得鍵盤。）
#
# 繪圖指令預算（每幀上限 200）：
#   清屏 1 + 磚塊 <= 48（每列把「連續相鄰的活磚」併成一個長矩形，最壞情況是每列隔格缺磚，
#   12 欄 -> 最多 6 段，8 列 -> 48）+ 球拍 1 + 球 1 + HUD 文字 3 + 提示文字 <= 2
#   最壞合計約 60 道，遠低於 200。
import pygame

W, H = 480, 400
STEP = 1000 // 60                 # 固定邏輯步長（毫秒）
COLS, ROWS = 12, 8
BW, BH = 36, 16                   # 磚塊寬高
BX0, BY0 = (W - COLS * BW) // 2, 50
ROW_COLORS = [(230, 70, 70), (240, 130, 60), (240, 200, 60), (110, 200, 90),
              (60, 190, 190), (70, 120, 230), (140, 90, 220), (210, 100, 200)]
PADDLE_W, PADDLE_H, PADDLE_Y = 70, 10, H - 30
BALL_R = 5


class Game:
    """遊戲邏輯（不碰畫面），方便單獨測試。"""

    def __init__(self):
        self.score = 0
        self.lives = 3
        self.level = 1
        self.over = False
        self.new_level()

    def new_level(self):
        self.bricks = [[True] * COLS for _ in range(ROWS)]
        self.paddle_x = (W - PADDLE_W) / 2
        self.reset_ball()

    def reset_ball(self):
        self.served = False
        self.bx, self.by = self.paddle_x + PADDLE_W / 2, PADDLE_Y - BALL_R
        self.vx = self.vy = 0.0

    def speed(self):
        return 4.0 + (self.level - 1) * 0.8          # 過關加速

    def serve(self):
        if not self.served and not self.over:
            self.served = True
            self.vx, self.vy = self.speed() * 0.5, -self.speed() * 0.87
            return True
        return False

    def bricks_left(self):
        return sum(row.count(True) for row in self.bricks)

    def update(self, move):
        """move：-1 左、0 不動、1 右。回傳這一步發生的事件清單（供音效使用）。"""
        events = []
        if self.over:
            return events
        self.paddle_x = max(0, min(W - PADDLE_W, self.paddle_x + move * 7))
        if not self.served:
            self.bx = self.paddle_x + PADDLE_W / 2
            return events
        # 速度可能大於磚高，所以把一步拆成幾個小步，避免穿透
        sp = max(abs(self.vx), abs(self.vy))
        n = int(sp // 3) + 1
        for _ in range(n):
            events += self.move_ball(self.vx / n, self.vy / n)
        return events

    def move_ball(self, dx, dy):
        events = []
        self.bx += dx
        self.by += dy
        if self.bx < BALL_R:
            self.bx, self.vx = BALL_R, abs(self.vx)
        elif self.bx > W - BALL_R:
            self.bx, self.vx = W - BALL_R, -abs(self.vx)
        if self.by < BALL_R:
            self.by, self.vy = BALL_R, abs(self.vy)
        # 球拍
        if self.vy > 0 and PADDLE_Y <= self.by + BALL_R <= PADDLE_Y + PADDLE_H + 4 \
                and self.paddle_x - BALL_R <= self.bx <= self.paddle_x + PADDLE_W + BALL_R:
            hit = (self.bx - self.paddle_x) / PADDLE_W - 0.5          # -0.5 .. 0.5
            ang = hit * 2.4                                           # 弧度，邊緣約 ±70 度
            import math
            sp = self.speed()
            self.vx, self.vy = sp * math.sin(ang), -sp * math.cos(ang)
            self.by = PADDLE_Y - BALL_R
            events.append("paddle")
        # 磚塊
        col = int((self.bx - BX0) // BW)
        row = int((self.by - BY0) // BH)
        if 0 <= row < ROWS and 0 <= col < COLS and self.bricks[row][col]:
            self.bricks[row][col] = False
            self.score += (ROWS - row) * 10
            # 依球進入磚塊的方向決定反彈軸
            cx, cy = BX0 + col * BW + BW / 2, BY0 + row * BH + BH / 2
            if abs(self.bx - cx) / BW > abs(self.by - cy) / BH:
                self.vx = -self.vx
            else:
                self.vy = -self.vy
            events.append("brick")
            if self.bricks_left() == 0:
                self.level += 1
                self.new_level()
                events.append("level")
        # 掉出底部
        if self.by > H + BALL_R:
            self.lives -= 1
            events.append("miss")
            if self.lives <= 0:
                self.over = True
            else:
                self.reset_ball()
        return events


def brick_runs(game):
    """把每列連續的活磚併成 (x, y, w, h, color)，大幅減少繪圖指令。"""
    runs = []
    for r in range(ROWS):
        c = 0
        while c < COLS:
            if game.bricks[r][c]:
                start = c
                while c < COLS and game.bricks[r][c]:
                    c += 1
                runs.append((BX0 + start * BW, BY0 + r * BH, (c - start) * BW - 1, BH - 1, ROW_COLORS[r]))
            else:
                c += 1
    return runs


def draw(screen, font, game):
    screen.fill((16, 16, 28))
    for x, y, w, h, color in brick_runs(game):
        pygame.draw.rect(screen, color, pygame.Rect(x, y, w, h))
    pygame.draw.rect(screen, (230, 230, 240), pygame.Rect(int(game.paddle_x), PADDLE_Y, PADDLE_W, PADDLE_H))
    pygame.draw.circle(screen, (255, 255, 120), (int(game.bx), int(game.by)), BALL_R)
    screen.blit(font.render("Score %d" % game.score, True, (255, 255, 255)), (10, 22))
    screen.blit(font.render("Level %d" % game.level, True, (200, 220, 255)), (W // 2 - 25, 22))
    screen.blit(font.render("Lives %d" % game.lives, True, (255, 140, 140)), (W - 80, 22))
    if game.over:
        screen.blit(font.render("GAME OVER  按 Enter 重來", True, (255, 255, 255)), (W // 2 - 90, H // 2))
    elif not game.served:
        screen.blit(font.render("按空白鍵發球", True, (255, 255, 255)), (W // 2 - 42, H // 2))


def main():
    pygame.init()
    pygame.display.set_caption("打磚塊 Breakout")
    screen = pygame.display.set_mode((W, H))
    font = pygame.font.Font(None, 14)
    beep = {"paddle": pygame.mixer.Sound(frequency=330, ms=40), "brick": pygame.mixer.Sound(frequency=520, ms=40),
            "miss": pygame.mixer.Sound(frequency=150, ms=200)}
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
                elif ev.key == pygame.K_SPACE:
                    game.serve()
                elif ev.key == pygame.K_RETURN and game.over:
                    game = Game()
        keys = pygame.key.get_pressed()
        move = (1 if keys[pygame.K_RIGHT] else 0) - (1 if keys[pygame.K_LEFT] else 0)
        acc = min(acc + clock.tick(60), 250)            # 卡頓時最多補 250ms，避免一次算太多
        while acc >= STEP:
            for e in game.update(move):
                if e in beep:
                    beep[e].play()
            acc -= STEP
        draw(screen, font, game)
        pygame.display.flip()
    pygame.quit()


if __name__ == "__main__":
    main()
