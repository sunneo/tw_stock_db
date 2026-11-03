# -*- coding: utf-8 -*-
# 打磚塊（pygame 子集，桌面版測試用；Redmine 外掛沒有這個範例，這一支是本專案另寫的）。
# 左右方向鍵移動擋板，空白鍵發球，球打到磚塊就消失並得分，球掉下去扣一條命，三條命用完遊戲結束。
# 每次狀態改變印一行 STATE（擋板 x、球的 x 與 y、剩餘磚塊、剩餘命數、分數），給驗證用的評估檔從終端機輸出核對。
import pygame

W, H = 400, 300
PADDLE_W, PADDLE_H = 70, 8
PADDLE_Y = H - 24
BRICK_COLS, BRICK_ROWS = 8, 4
BRICK_W, BRICK_H = 44, 14
BRICK_GAP = 6
BALL_R = 4
PADDLE_SPEED = 6
COLORS = [(200, 70, 70), (220, 150, 60), (90, 180, 90), (70, 130, 220)]
MAX_LIVES = 3


def new_game():
    bricks = []
    for r in range(BRICK_ROWS):
        for c in range(BRICK_COLS):
            x = 14 + c * (BRICK_W + BRICK_GAP)
            y = 40 + r * (BRICK_H + BRICK_GAP)
            bricks.append((x, y, COLORS[r % len(COLORS)]))
    return {"paddle": (W - PADDLE_W) / 2.0, "ball": [W / 2.0, PADDLE_Y - 20.0], "vel": [0.0, 0.0],
            "bricks": bricks, "lives": MAX_LIVES, "score": 0}


def serve(g):
    """Launches the ball up and to the right (the ball goes straight up when the paddle is not moving)."""
    if g["vel"] == [0.0, 0.0] and g["lives"] > 0:
        g["vel"] = [2.5, -3.5]


def step(g, left, right):
    """One frame: move the paddle, move the ball, bounce it off the walls, the paddle and the bricks."""
    if left:
        g["paddle"] = max(0.0, g["paddle"] - PADDLE_SPEED)
    if right:
        g["paddle"] = min(W - PADDLE_W, g["paddle"] + PADDLE_SPEED)
    if g["vel"] == [0.0, 0.0]:
        g["ball"][0] = g["paddle"] + PADDLE_W / 2.0      # the ball sits on the paddle until it is served
        return
    g["ball"][0] += g["vel"][0]
    g["ball"][1] += g["vel"][1]
    x, y = g["ball"]
    if x - BALL_R < 0 or x + BALL_R > W:
        g["vel"][0] = -g["vel"][0]
    if y - BALL_R < 0:
        g["vel"][1] = -g["vel"][1]
    if g["vel"][1] > 0 and PADDLE_Y - BALL_R <= y <= PADDLE_Y + PADDLE_H and g["paddle"] - BALL_R <= x <= g["paddle"] + PADDLE_W + BALL_R:
        g["vel"][1] = -abs(g["vel"][1])
        g["vel"][0] = (x - (g["paddle"] + PADDLE_W / 2.0)) / 10.0    # where the ball hits the paddle sets the sideways speed
    hit = None
    for b in g["bricks"]:
        bx, by, _ = b
        if bx - BALL_R <= x <= bx + BRICK_W + BALL_R and by - BALL_R <= y <= by + BRICK_H + BALL_R:
            hit = b
            break
    if hit is not None:
        g["bricks"].remove(hit)
        g["score"] += 1
        g["vel"][1] = -g["vel"][1]
    if g["ball"][1] > H:                                     # the ball fell past the paddle
        g["lives"] -= 1
        g["vel"] = [0.0, 0.0]
        g["ball"] = [g["paddle"] + PADDLE_W / 2.0, PADDLE_Y - 20.0]


def draw(screen, g, hud):
    screen.fill((0, 0, 0))
    for bx, by, color in g["bricks"]:
        pygame.draw.rect(screen, color, pygame.Rect(bx, by, BRICK_W, BRICK_H))
    pygame.draw.rect(screen, (230, 230, 230), pygame.Rect(int(g["paddle"]), PADDLE_Y, PADDLE_W, PADDLE_H))
    pygame.draw.circle(screen, (255, 255, 255), (int(g["ball"][0]), int(g["ball"][1])), BALL_R)
    screen.blit(hud.render("score %d  lives %d" % (g["score"], g["lives"]), True, (255, 255, 255)), (6, 6))
    if g["lives"] <= 0:
        screen.blit(hud.render("GAME OVER", True, (255, 80, 80)), (W // 2 - 30, H // 2))


def play(screen):
    clock = pygame.time.Clock()
    hud = pygame.font.Font(None, 16)
    g = new_game()
    left = right = False
    last = None
    while True:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                return
            if ev.type == pygame.KEYDOWN and ev.key == pygame.K_LEFT:
                left = True
            if ev.type == pygame.KEYUP and ev.key == pygame.K_LEFT:
                left = False
            if ev.type == pygame.KEYDOWN and ev.key == pygame.K_RIGHT:
                right = True
            if ev.type == pygame.KEYUP and ev.key == pygame.K_RIGHT:
                right = False
            if ev.type == pygame.KEYDOWN and ev.key == pygame.K_SPACE:
                serve(g)
        step(g, left, right)
        state = (round(g["paddle"]), round(g["ball"][0]), round(g["ball"][1]), len(g["bricks"]), g["lives"], g["score"])
        if state != last:
            last = state
            print("STATE %d %d %d %d %d %d" % state, flush=True)
        draw(screen, g, hud)
        pygame.display.flip()
        clock.tick(30)


def main():
    pygame.init()
    pygame.display.set_caption("Breakout")
    screen = pygame.display.set_mode((W, H))
    play(screen)
    pygame.quit()


main()
