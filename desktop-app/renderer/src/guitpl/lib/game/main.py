# -*- coding: utf-8 -*-
# 打磚塊：下方擋板左右移動，球撞到磚塊就得分，掉下去扣一條命，磚塊全打完或命用完就結束。
# 畫布每秒 15 格（frame:screen 事件）推進一格；按鈕與快捷鍵只改狀態，畫面每格重畫（一格不超過 200 道指令）。
import random

W, H = 400, 300
PADDLE_W, PADDLE_H, PADDLE_Y = 70, 8, 276
PADDLE_SPEED = 12
BALL_R = 4
BRICK_W, BRICK_H, GAP = 40, 14, 6
ROW_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#14b8a6"]


def _fresh(lives, rows):
    bricks = []
    for r in range(rows):
        for c in range(8):
            bricks.append([14 + c * (BRICK_W + GAP), 40 + r * (BRICK_H + GAP), r])
    return {"paddle": (W - PADDLE_W) / 2.0, "ball": [W / 2.0, PADDLE_Y - 20.0], "vel": [0.0, 0.0],
            "bricks": bricks, "lives": lives, "score": 0, "running": True, "over": False, "shown": None}


def _step(G):
    x, y = G["ball"]
    vx, vy = G["vel"]
    x += vx
    y += vy
    if x - BALL_R < 0 or x + BALL_R > W:
        vx = -vx
        x = min(max(x, BALL_R), W - BALL_R)
    if y - BALL_R < 0:
        vy = -vy
        y = BALL_R
    p = G["paddle"]
    if vy > 0 and PADDLE_Y - BALL_R <= y <= PADDLE_Y + PADDLE_H and p - BALL_R <= x <= p + PADDLE_W + BALL_R:
        vy = -abs(vy)
        vx = (x - (p + PADDLE_W / 2.0)) / 10.0      # 撞在擋板的哪裡，決定球往哪邊飛
    for b in G["bricks"]:
        bx, by = b[0], b[1]
        if bx - BALL_R <= x <= bx + BRICK_W + BALL_R and by - BALL_R <= y <= by + BRICK_H + BALL_R:
            G["bricks"].remove(b)
            G["score"] += 1
            vy = -vy
            break
    if y > H:                                       # 球掉下去：扣一條命，球回到擋板上
        G["lives"] -= 1
        x, y = p + PADDLE_W / 2.0, PADDLE_Y - 20.0
        vx, vy = 0.0, 0.0
    G["ball"] = [x, y]
    G["vel"] = [vx, vy]


def _end(ctx, G, message):
    G["over"] = True
    G["running"] = False
    ctx.set("over_box", text=message)
    ctx.goto("over")


def _show(ctx, G):
    now = (G["score"], G["lives"])
    if now != G["shown"]:
        G["shown"] = now
        ctx.set("score_text", text="分數 %d" % G["score"])
        ctx.set("lives_text", text="命 %d" % G["lives"])


def _tick(ctx, G, pal):
    if G["running"] and not G["over"]:
        if G["vel"] == [0.0, 0.0]:                  # 還沒發球：球跟著擋板走
            G["ball"] = [G["paddle"] + PADDLE_W / 2.0, PADDLE_Y - 20.0]
        else:
            _step(G)
        if G["lives"] <= 0:
            _end(ctx, G, "命用完了，分數 %d" % G["score"])
        elif not G["bricks"]:
            _end(ctx, G, "全部打完！分數 %d" % G["score"])
    _show(ctx, G)
    ops = [["clear", pal.get("bg", "#000000")]]
    for bx, by, row in G["bricks"]:
        ops.append(["rect", bx, by, BRICK_W, BRICK_H, ROW_COLORS[row % len(ROW_COLORS)]])
    ops.append(["rect", int(G["paddle"]), PADDLE_Y, PADDLE_W, PADDLE_H, pal.get("fg", "#ffffff")])
    ops.append(["circle", int(G["ball"][0]), int(G["ball"][1]), BALL_R, pal.get("accent", "#22c55e")])
    ctx.w.draw(ctx.id("screen"), ops)


def build(win, spec, slots):
    lives = max(1, int(spec["params"].get("lives", 3)))
    rows = max(1, min(6, int(spec["params"].get("rows", 4))))
    pal = spec["style"].get("palette", {})
    G = _fresh(lives, rows)

    def move(d):
        def handler(ctx):
            G["paddle"] = min(max(0.0, G["paddle"] + d), W - PADDLE_W)
        return handler

    def serve(ctx):
        if G["over"]:
            return
        if G["vel"] == [0.0, 0.0]:
            G["vel"] = [random.choice((-2.5, 2.5)), -3.5]
        G["running"] = True

    def pause(ctx):
        if G["over"]:
            return
        G["running"] = not G["running"]
        ctx.set("pause", text="繼續" if not G["running"] else "暫停")

    def restart(ctx):
        G.update(_fresh(lives, rows))
        ctx.set("pause", text="暫停")
        ctx.goto("play")
        _show(ctx, G)

    def frame(ctx):
        _tick(ctx, G, pal)

    return {"handlers": {
        "frame:screen": frame,
        "shortcut:left": move(-PADDLE_SPEED),
        "shortcut:right": move(PADDLE_SPEED),
        "shortcut:serve": serve,
        "click:serve": serve,
        "click:pause": pause,
        "click:restart": restart,
    }}
