; SDL2 乒乓球（影像＋鍵盤＋滑鼠）。w/s 或 ↑↓ 或滑鼠控制左邊球拍，Esc 離開。
; 命令列第一個參數＝跑幾幀就自動結束（測試用，沒給就一直跑）。
; 建置：見 ../README.md（llc → 物件檔 → 用 gcc/clang 連 SDL2）。
; SDL_Event 是 56 位元組的 union：type 在 +0；鍵盤 scancode 在 +16；滑鼠移動的 y 在 +24。
target triple = "x86_64-pc-linux-gnu"

@title = private constant [12 x i8] c"IR pong SDL\00"
@fmt_miss = private constant [20 x i8] c"missed! rally = %d\0A\00"
@fmt_end = private constant [19 x i8] c"frames=%d best=%d\0A\00"

declare i32 @SDL_Init(i32)
declare void @SDL_Quit()
declare ptr @SDL_CreateWindow(ptr, i32, i32, i32, i32, i32)
declare ptr @SDL_CreateRenderer(ptr, i32, i32)
declare i32 @SDL_PollEvent(ptr)
declare i32 @SDL_SetRenderDrawColor(ptr, i8, i8, i8, i8)
declare i32 @SDL_RenderClear(ptr)
declare i32 @SDL_RenderFillRect(ptr, ptr)
declare void @SDL_RenderPresent(ptr)
declare void @SDL_Delay(i32)
declare void @SDL_DestroyRenderer(ptr)
declare void @SDL_DestroyWindow(ptr)
declare i32 @atoi(ptr)
declare i32 @printf(ptr, ...)

; ==== HUD BEGIN（模組）==== 由 _gen/_hud_patch.py 產生，勿手改
@hud_font = private constant [1235 x i32] [i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 20, i32 20, i32 20, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 10, i32 20, i32 63, i32 20, i32 20, i32 126, i32 40, i32 40, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 28, i32 40, i32 40, i32 28, i32 10, i32 10, i32 60, i32 8, i32 8, i32 0, i32 0, i32 0, i32 48, i32 72, i32 50, i32 4, i32 24, i32 46, i32 10, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 32, i32 48, i32 74, i32 70, i32 98, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 16, i32 16, i32 16, i32 16, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 16, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 8, i32 42, i32 28, i32 28, i32 42, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 126, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 42, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 2, i32 4, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 6, i32 24, i32 6, i32 2, i32 38, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 12, i32 12, i32 20, i32 36, i32 36, i32 62, i32 4, i32 4, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 32, i32 32, i32 60, i32 6, i32 2, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 48, i32 32, i32 60, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 34, i32 28, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 38, i32 58, i32 2, i32 4, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 28, i32 96, i32 24, i32 6, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 0, i32 126, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 96, i32 28, i32 2, i32 28, i32 96, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 6, i32 4, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 66, i32 78, i32 82, i32 82, i32 78, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 8, i32 24, i32 20, i32 20, i32 36, i32 62, i32 34, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 60, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 50, i32 32, i32 32, i32 32, i32 32, i32 50, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 36, i32 34, i32 34, i32 34, i32 34, i32 36, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 32, i32 32, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 62, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 4, i32 4, i32 4, i32 4, i32 4, i32 36, i32 56, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 36, i32 40, i32 56, i32 40, i32 36, i32 38, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 102, i32 86, i32 90, i32 74, i32 66, i32 66, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 50, i32 50, i32 42, i32 42, i32 42, i32 38, i32 38, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 4, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 38, i32 56, i32 36, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 36, i32 32, i32 48, i32 12, i32 2, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 34, i32 34, i32 36, i32 20, i32 20, i32 24, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 74, i32 90, i32 58, i32 54, i32 54, i32 36, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 52, i32 20, i32 8, i32 24, i32 20, i32 34, i32 98, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 38, i32 20, i32 24, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 2, i32 4, i32 8, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 28, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 28, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 16, i32 16, i32 8, i32 8, i32 4, i32 4, i32 2, i32 0, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 24, i32 0, i32 0, i32 0, i32 0, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 2, i32 62, i32 34, i32 38, i32 58, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 48, i32 32, i32 32, i32 48, i32 30, i32 0, i32 0, i32 0, i32 0, i32 2, i32 2, i32 2, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 62, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 0, i32 14, i32 8, i32 8, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 4, i32 60, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 56, i32 0, i32 0, i32 32, i32 32, i32 32, i32 38, i32 44, i32 56, i32 44, i32 36, i32 34, i32 0, i32 0, i32 0, i32 0, i32 48, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 8, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 54, i32 42, i32 42, i32 42, i32 42, i32 42, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 2, i32 2, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 16, i32 16, i32 16, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 48, i32 12, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 16, i32 62, i32 16, i32 16, i32 16, i32 16, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 36, i32 20, i32 24, i32 24, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 42, i32 58, i32 58, i32 52, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 20, i32 24, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 20, i32 20, i32 24, i32 8, i32 24, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 8, i32 16, i32 16, i32 62, i32 0, i32 0, i32 0, i32 0, i32 12, i32 8, i32 8, i32 8, i32 48, i32 8, i32 8, i32 8, i32 8, i32 12, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 48, i32 8, i32 8, i32 8, i32 4, i32 8, i32 8, i32 8, i32 8, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 48, i32 78, i32 0, i32 0, i32 0, i32 0]
@hud_qa = private constant [21 x i8] c"W/S OR UP DOWN: MOVE\00"
@hud_qb = private constant [7 x i8] c"RALLY \00"
@hud_qc = private constant [6 x i8] c"BEST \00"
@hud_qd = private constant [9 x i8] c"ESC QUIT\00"
define void @hud_text(ptr %ren, i32 %x, i32 %y, ptr %s, i32 %n, i8 %r, i8 %g, i8 %b) {
entry:
  %rc = alloca [4 x i32], align 4
  %row = alloca i32
  %xi = alloca i32
  %st = alloca i32
  %w = mul i32 %n, 7
  %cr = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 %r, i8 %g, i8 %b, i8 -1)
  store i32 0, ptr %row
  br label %rowloop
rowloop:
  %rv = load i32, ptr %row
  %rdone = icmp eq i32 %rv, 13
  br i1 %rdone, label %exit, label %rowbody
rowbody:
  store i32 0, ptr %xi
  store i32 -1, ptr %st
  br label %col
col:
  %xv = load i32, ptr %xi
  %inside = icmp slt i32 %xv, %w
  %ci0 = udiv i32 %xv, 7
  %ci = select i1 %inside, i32 %ci0, i32 0
  %cm = urem i32 %xv, 7
  %cp = getelementptr i8, ptr %s, i32 %ci
  %cb = load i8, ptr %cp
  %cv = zext i8 %cb to i32
  %lo = icmp slt i32 %cv, 32
  %hi = icmp sgt i32 %cv, 126
  %bad = or i1 %lo, %hi
  %cv2 = select i1 %bad, i32 32, i32 %cv
  %gi = sub i32 %cv2, 32
  %gb = mul i32 %gi, 13
  %gidx = add i32 %gb, %rv
  %gp = getelementptr [1235 x i32], ptr @hud_font, i32 0, i32 %gidx
  %gv = load i32, ptr %gp
  %sh = sub i32 6, %cm
  %shv = lshr i32 %gv, %sh
  %bit = and i32 %shv, 1
  %bitb = icmp ne i32 %bit, 0
  %lit = and i1 %bitb, %inside
  %stv = load i32, ptr %st
  %sn = icmp slt i32 %stv, 0
  %begin = and i1 %lit, %sn
  %newst = select i1 %begin, i32 %xv, i32 %stv
  %nlit = xor i1 %lit, 1
  %nsn = xor i1 %sn, 1
  %endrun = and i1 %nlit, %nsn
  %stfin = select i1 %endrun, i32 -1, i32 %newst
  store i32 %stfin, ptr %st
  br i1 %endrun, label %draw, label %cont
draw:
  %dx = add i32 %x, %stv
  %dy = add i32 %y, %rv
  %dl = sub i32 %xv, %stv
  %p0 = getelementptr [4 x i32], ptr %rc, i32 0, i32 0
  %p1 = getelementptr [4 x i32], ptr %rc, i32 0, i32 1
  %p2 = getelementptr [4 x i32], ptr %rc, i32 0, i32 2
  %p3 = getelementptr [4 x i32], ptr %rc, i32 0, i32 3
  store i32 %dx, ptr %p0
  store i32 %dy, ptr %p1
  store i32 %dl, ptr %p2
  store i32 1, ptr %p3
  %fr = call i32 @SDL_RenderFillRect(ptr %ren, ptr %rc)
  br label %cont
cont:
  %x1 = add i32 %xv, 1
  store i32 %x1, ptr %xi
  %more = icmp slt i32 %xv, %w
  br i1 %more, label %col, label %rowend
rowend:
  %r1 = add i32 %rv, 1
  store i32 %r1, ptr %row
  br label %rowloop
exit:
  ret void
}

define void @hud_int(ptr %ren, i32 %x, i32 %y, i32 %v, i8 %r, i8 %g, i8 %b) {
entry:
  %buf = alloca [3 x i8], align 1
  %hq = udiv i32 %v, 100
  %hd = urem i32 %hq, 10
  %tq = udiv i32 %v, 10
  %td = urem i32 %tq, 10
  %od = urem i32 %v, 10
  %hge = icmp uge i32 %v, 100
  %tge = icmp uge i32 %v, 10
  %hc0 = add i32 %hd, 48
  %hc1 = select i1 %hge, i32 %hc0, i32 32
  %tc0 = add i32 %td, 48
  %tc1 = select i1 %tge, i32 %tc0, i32 32
  %oc0 = add i32 %od, 48
  %hc = trunc i32 %hc1 to i8
  %tc = trunc i32 %tc1 to i8
  %oc = trunc i32 %oc0 to i8
  %p0 = getelementptr [3 x i8], ptr %buf, i32 0, i32 0
  %p1 = getelementptr [3 x i8], ptr %buf, i32 0, i32 1
  %p2 = getelementptr [3 x i8], ptr %buf, i32 0, i32 2
  store i8 %hc, ptr %p0
  store i8 %tc, ptr %p1
  store i8 %oc, ptr %p2
  call void @hud_text(ptr %ren, i32 %x, i32 %y, ptr %buf, i32 3, i8 %r, i8 %g, i8 %b)
  ret void
}

; ==== HUD END（模組）====

define void @rect(ptr %r, ptr %rc, i32 %x, i32 %y, i32 %w, i32 %h) {
  %p1 = getelementptr i32, ptr %rc, i32 1
  %p2 = getelementptr i32, ptr %rc, i32 2
  %p3 = getelementptr i32, ptr %rc, i32 3
  store i32 %x, ptr %rc
  store i32 %y, ptr %p1
  store i32 %w, ptr %p2
  store i32 %h, ptr %p3
  call i32 @SDL_RenderFillRect(ptr %r, ptr %rc)
  ret void
}

define i32 @clamp(i32 %v, i32 %lo, i32 %hi) {
  %a = icmp slt i32 %v, %lo
  %b = select i1 %a, i32 %lo, i32 %v
  %c = icmp sgt i32 %b, %hi
  %d = select i1 %c, i32 %hi, i32 %b
  ret i32 %d
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %ev = alloca [56 x i8], align 8
  %rc = alloca [4 x i32], align 4
  %bx = alloca i32
  %by = alloca i32
  %vx = alloca i32
  %vy = alloca i32
  %py = alloca i32
  %ay = alloca i32
  %running = alloca i32
  %frames = alloca i32
  %max = alloca i32
  %rally = alloca i32
  %best = alloca i32
  %renslot = alloca ptr
  %winslot = alloca ptr
  store i32 320, ptr %bx
  store i32 200, ptr %by
  store i32 5, ptr %vx
  store i32 3, ptr %vy
  store i32 165, ptr %py
  store i32 165, ptr %ay
  store i32 1, ptr %running
  store i32 0, ptr %frames
  store i32 0, ptr %max
  store i32 0, ptr %rally
  store i32 0, ptr %best
  %many = icmp sgt i32 %argc, 1
  br i1 %many, label %getmax, label %init
getmax:
  %a1p = getelementptr ptr, ptr %argv, i32 1
  %a1 = load ptr, ptr %a1p
  %n = call i32 @atoi(ptr %a1)
  store i32 %n, ptr %max
  br label %init
init:
  %ok = call i32 @SDL_Init(i32 32)           ; SDL_INIT_VIDEO
  %bad = icmp ne i32 %ok, 0
  br i1 %bad, label %fail, label %mkwin
mkwin:
  %win = call ptr @SDL_CreateWindow(ptr @title, i32 805240832, i32 805240832, i32 640, i32 440, i32 0)   ; 置中
  store ptr %win, ptr %winslot
  %ren = call ptr @SDL_CreateRenderer(ptr %win, i32 -1, i32 2)    ; 2＝ACCELERATED
  %nr = icmp eq ptr %ren, null
  br i1 %nr, label %sw, label %have
sw:
  %ren2 = call ptr @SDL_CreateRenderer(ptr %win, i32 -1, i32 1)   ; 1＝SOFTWARE（沒有加速時退回）
  store ptr %ren2, ptr %renslot
  br label %events
have:
  store ptr %ren, ptr %renslot
  br label %events
events:
  %got = call i32 @SDL_PollEvent(ptr %ev)
  %has = icmp ne i32 %got, 0
  br i1 %has, label %handle, label %logic
handle:
  %type = load i32, ptr %ev
  %isq = icmp eq i32 %type, 256              ; SDL_QUIT
  br i1 %isq, label %doquit, label %chkkey
doquit:
  store i32 0, ptr %running
  br label %events
chkkey:
  %iskey = icmp eq i32 %type, 768            ; SDL_KEYDOWN
  br i1 %iskey, label %key, label %chkmouse
key:
  %scp = getelementptr i8, ptr %ev, i32 16
  %sc = load i32, ptr %scp
  %p0 = load i32, ptr %py
  %isup = icmp eq i32 %sc, 82                ; SDL_SCANCODE_UP
  %isw = icmp eq i32 %sc, 26                 ; W
  %up = or i1 %isup, %isw
  %isdn = icmp eq i32 %sc, 81                ; DOWN
  %iss = icmp eq i32 %sc, 22                 ; S
  %dn = or i1 %isdn, %iss
  %dy1 = select i1 %up, i32 -24, i32 0
  %dy2 = select i1 %dn, i32 24, i32 %dy1
  %np = add i32 %p0, %dy2
  store i32 %np, ptr %py
  %isesc = icmp eq i32 %sc, 41               ; ESC
  br i1 %isesc, label %doquit, label %events
chkmouse:
  %ismm = icmp eq i32 %type, 1024            ; SDL_MOUSEMOTION
  br i1 %ismm, label %mouse, label %events
mouse:
  %myp = getelementptr i8, ptr %ev, i32 24
  %my = load i32, ptr %myp
  %np2 = sub i32 %my, 35
  store i32 %np2, ptr %py
  br label %events
logic:
  %p1 = load i32, ptr %py
  %p2 = call i32 @clamp(i32 %p1, i32 0, i32 330)
  store i32 %p2, ptr %py
  ; AI：追著球的中心，最多每幀 3 像素
  %a0 = load i32, ptr %ay
  %by0 = load i32, ptr %by
  %ac = add i32 %a0, 35
  %below = icmp slt i32 %ac, %by0
  %ad = select i1 %below, i32 3, i32 -3
  %a1v = add i32 %a0, %ad
  %a2 = call i32 @clamp(i32 %a1v, i32 0, i32 330)
  store i32 %a2, ptr %ay
  ; 球
  %bx0 = load i32, ptr %bx
  %vx0 = load i32, ptr %vx
  %vy0 = load i32, ptr %vy
  %bx1 = add i32 %bx0, %vx0
  %by1 = add i32 %by0, %vy0
  %ytop = icmp slt i32 %by1, 0
  %ybot = icmp sgt i32 %by1, 390
  %ybounce = or i1 %ytop, %ybot
  %nvy = sub i32 0, %vy0
  %vy1 = select i1 %ybounce, i32 %nvy, i32 %vy0
  store i32 %vy1, ptr %vy
  store i32 %bx1, ptr %bx
  store i32 %by1, ptr %by
  ; 打到左球拍（x 20..30）
  %c1 = icmp sle i32 %bx1, 30
  %c2 = icmp sge i32 %bx1, 14
  %c3 = add i32 %by1, 10
  %c4 = icmp sge i32 %c3, %p2
  %pb = add i32 %p2, 70
  %c5 = icmp sle i32 %by1, %pb
  %h1 = and i1 %c1, %c2
  %h2 = and i1 %c4, %c5
  %hitp = and i1 %h1, %h2
  br i1 %hitp, label %playerhit, label %chkai
playerhit:
  store i32 6, ptr %vx
  %rl = load i32, ptr %rally
  %rl1 = add i32 %rl, 1
  store i32 %rl1, ptr %rally
  br label %chkmiss
chkai:
  %d1 = icmp sge i32 %bx1, 600
  %d2 = icmp sle i32 %bx1, 616
  %d3 = icmp sge i32 %c3, %a2
  %ab = add i32 %a2, 70
  %d4 = icmp sle i32 %by1, %ab
  %e1 = and i1 %d1, %d2
  %e2 = and i1 %d3, %d4
  %hita = and i1 %e1, %e2
  br i1 %hita, label %aihit, label %chkmiss
aihit:
  store i32 -6, ptr %vx
  br label %chkmiss
chkmiss:
  %bxn = load i32, ptr %bx
  %m1 = icmp slt i32 %bxn, 0
  %m2 = icmp sgt i32 %bxn, 640
  %miss = or i1 %m1, %m2
  br i1 %miss, label %missed, label %draw
missed:
  %r = load i32, ptr %rally
  call i32 (ptr, ...) @printf(ptr @fmt_miss, i32 %r)
  %bst = load i32, ptr %best
  %better = icmp sgt i32 %r, %bst
  %nb = select i1 %better, i32 %r, i32 %bst
  store i32 %nb, ptr %best
  store i32 0, ptr %rally
  store i32 320, ptr %bx
  store i32 200, ptr %by
  store i32 5, ptr %vx
  br label %draw
draw:
  %rend = load ptr, ptr %renslot
  call i32 @SDL_SetRenderDrawColor(ptr %rend, i8 16, i8 24, i8 32, i8 255)
  call i32 @SDL_RenderClear(ptr %rend)
  call i32 @SDL_SetRenderDrawColor(ptr %rend, i8 230, i8 230, i8 230, i8 255)
  %pyd = load i32, ptr %py
  call void @rect(ptr %rend, ptr %rc, i32 20, i32 %pyd, i32 10, i32 70)
  %ayd = load i32, ptr %ay
  call void @rect(ptr %rend, ptr %rc, i32 610, i32 %ayd, i32 10, i32 70)
  %bxd = load i32, ptr %bx
  %byd = load i32, ptr %by
  call void @rect(ptr %rend, ptr %rc, i32 %bxd, i32 %byd, i32 10, i32 10)
  call void @rect(ptr %rend, ptr %rc, i32 319, i32 0, i32 2, i32 400)
  ; ==== HUD BEGIN（畫面）==== 由 _gen/_hud_patch.py 產生，勿手改
  call void @hud_text(ptr %rend, i32 8, i32 412, ptr @hud_qa, i32 20, i8 235, i8 235, i8 235)
  call void @hud_text(ptr %rend, i32 8, i32 428, ptr @hud_qb, i32 6, i8 235, i8 235, i8 235)
  %hud_r = load i32, ptr %rally
  call void @hud_int(ptr %rend, i32 50, i32 428, i32 %hud_r, i8 255, i8 210, i8 90)
  call void @hud_text(ptr %rend, i32 77, i32 428, ptr @hud_qc, i32 5, i8 235, i8 235, i8 235)
  %hud_b = load i32, ptr %best
  call void @hud_int(ptr %rend, i32 112, i32 428, i32 %hud_b, i8 255, i8 210, i8 90)
  call void @hud_text(ptr %rend, i32 147, i32 428, ptr @hud_qd, i32 8, i8 235, i8 235, i8 235)
  ; ==== HUD END（畫面）====
  call void @SDL_RenderPresent(ptr %rend)
  call void @SDL_Delay(i32 16)
  %f = load i32, ptr %frames
  %f1 = add i32 %f, 1
  store i32 %f1, ptr %frames
  %mx = load i32, ptr %max
  %hasmax = icmp sgt i32 %mx, 0
  %reached = icmp sge i32 %f1, %mx
  %stop = and i1 %hasmax, %reached
  br i1 %stop, label %done, label %chkrun
chkrun:
  %run = load i32, ptr %running
  %cont = icmp ne i32 %run, 0
  br i1 %cont, label %events, label %done
done:
  %bf = load i32, ptr %best
  call i32 (ptr, ...) @printf(ptr @fmt_end, i32 %f1, i32 %bf)
  %rend2 = load ptr, ptr %renslot
  %win2 = load ptr, ptr %winslot
  call void @SDL_DestroyRenderer(ptr %rend2)
  call void @SDL_DestroyWindow(ptr %win2)
  call void @SDL_Quit()
  ret i32 0
fail:
  ret i32 1
}
