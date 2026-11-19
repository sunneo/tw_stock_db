; SDL2 + OpenGL（固定管線）：一個彩色三角形，滑鼠左右拖曳旋轉、滾輪縮放、Esc 離開；影像＋滑鼠＋OpenGL。
; 命令列第一個參數＝跑幾幀就自動結束（測試用）。需要有 OpenGL 的視窗環境（真桌面；虛擬顯示器可能沒有）。
; 事件偏移：type +0；滑鼠移動 xrel +28、按鍵狀態 +16；滾輪 y +20；鍵盤 scancode +16。
target triple = "x86_64-pc-linux-gnu"

@title = private constant [16 x i8] c"IR OpenGL tri\00\00\00"

declare i32 @SDL_Init(i32)
declare void @SDL_Quit()
declare ptr @SDL_CreateWindow(ptr, i32, i32, i32, i32, i32)
declare ptr @SDL_GL_CreateContext(ptr)
declare void @SDL_GL_SwapWindow(ptr)
declare void @SDL_GL_DeleteContext(ptr)
declare void @SDL_DestroyWindow(ptr)
declare i32 @SDL_PollEvent(ptr)
declare void @SDL_Delay(i32)
declare i32 @atoi(ptr)
declare void @glClearColor(float, float, float, float)
declare void @glClear(i32)
declare void @glLoadIdentity()
declare void @glRotatef(float, float, float, float)
declare void @glScalef(float, float, float)
declare void @glBegin(i32)
declare void @glEnd()
declare void @glColor3f(float, float, float)
declare void @glVertex2f(float, float)

; ==== HUD BEGIN（模組）==== 由 _gen/_hud_patch.py 產生，勿手改
declare void @glMatrixMode(i32)
declare void @glOrtho(double, double, double, double, double, double)
@hud_font = private constant [1235 x i32] [i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 20, i32 20, i32 20, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 10, i32 20, i32 63, i32 20, i32 20, i32 126, i32 40, i32 40, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 28, i32 40, i32 40, i32 28, i32 10, i32 10, i32 60, i32 8, i32 8, i32 0, i32 0, i32 0, i32 48, i32 72, i32 50, i32 4, i32 24, i32 46, i32 10, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 32, i32 48, i32 74, i32 70, i32 98, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 16, i32 16, i32 16, i32 16, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 16, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 8, i32 42, i32 28, i32 28, i32 42, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 126, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 42, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 2, i32 4, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 6, i32 24, i32 6, i32 2, i32 38, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 12, i32 12, i32 20, i32 36, i32 36, i32 62, i32 4, i32 4, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 32, i32 32, i32 60, i32 6, i32 2, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 48, i32 32, i32 60, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 34, i32 28, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 38, i32 58, i32 2, i32 4, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 28, i32 96, i32 24, i32 6, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 0, i32 126, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 96, i32 28, i32 2, i32 28, i32 96, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 6, i32 4, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 66, i32 78, i32 82, i32 82, i32 78, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 8, i32 24, i32 20, i32 20, i32 36, i32 62, i32 34, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 60, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 50, i32 32, i32 32, i32 32, i32 32, i32 50, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 36, i32 34, i32 34, i32 34, i32 34, i32 36, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 32, i32 32, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 62, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 4, i32 4, i32 4, i32 4, i32 4, i32 36, i32 56, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 36, i32 40, i32 56, i32 40, i32 36, i32 38, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 102, i32 86, i32 90, i32 74, i32 66, i32 66, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 50, i32 50, i32 42, i32 42, i32 42, i32 38, i32 38, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 4, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 38, i32 56, i32 36, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 36, i32 32, i32 48, i32 12, i32 2, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 34, i32 34, i32 36, i32 20, i32 20, i32 24, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 74, i32 90, i32 58, i32 54, i32 54, i32 36, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 52, i32 20, i32 8, i32 24, i32 20, i32 34, i32 98, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 38, i32 20, i32 24, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 2, i32 4, i32 8, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 28, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 28, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 16, i32 16, i32 8, i32 8, i32 4, i32 4, i32 2, i32 0, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 24, i32 0, i32 0, i32 0, i32 0, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 2, i32 62, i32 34, i32 38, i32 58, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 48, i32 32, i32 32, i32 48, i32 30, i32 0, i32 0, i32 0, i32 0, i32 2, i32 2, i32 2, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 62, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 0, i32 14, i32 8, i32 8, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 4, i32 60, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 56, i32 0, i32 0, i32 32, i32 32, i32 32, i32 38, i32 44, i32 56, i32 44, i32 36, i32 34, i32 0, i32 0, i32 0, i32 0, i32 48, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 8, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 54, i32 42, i32 42, i32 42, i32 42, i32 42, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 2, i32 2, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 16, i32 16, i32 16, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 48, i32 12, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 16, i32 62, i32 16, i32 16, i32 16, i32 16, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 36, i32 20, i32 24, i32 24, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 42, i32 58, i32 58, i32 52, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 20, i32 24, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 20, i32 20, i32 24, i32 8, i32 24, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 8, i32 16, i32 16, i32 62, i32 0, i32 0, i32 0, i32 0, i32 12, i32 8, i32 8, i32 8, i32 48, i32 8, i32 8, i32 8, i32 8, i32 12, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 48, i32 8, i32 8, i32 8, i32 4, i32 8, i32 8, i32 8, i32 8, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 48, i32 78, i32 0, i32 0, i32 0, i32 0]
@hud_ta = private constant [27 x i8] c"DRAG: ROTATE   WHEEL: ZOOM\00"
@hud_tb = private constant [9 x i8] c"ESC QUIT\00"
@hud_tc = private constant [9 x i8] c"DRAGGING\00"
@hud_td = private constant [5 x i8] c"IDLE\00"
define void @hud_text_gl(i32 %x, i32 %y, ptr %s, i32 %n, float %r, float %g, float %b) {
entry:
  %row = alloca i32
  %xi = alloca i32
  %st = alloca i32
  %w = mul i32 %n, 7
  call void @glColor3f(float %r, float %g, float %b)
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
  %dx1 = add i32 %dx, %dl
  %dy1 = add i32 %dy, 1
  %fx0 = sitofp i32 %dx to float
  %fx1 = sitofp i32 %dx1 to float
  %fy0 = sitofp i32 %dy to float
  %fy1 = sitofp i32 %dy1 to float
  call void @glVertex2f(float %fx0, float %fy0)
  call void @glVertex2f(float %fx1, float %fy0)
  call void @glVertex2f(float %fx1, float %fy1)
  call void @glVertex2f(float %fx0, float %fy1)
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

; ==== HUD END（模組）====

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %ev = alloca [56 x i8], align 8
  %ang = alloca float
  %zoom = alloca float
  %drag = alloca i32
  %running = alloca i32
  %frames = alloca i32
  %max = alloca i32
  store float 0x0000000000000000, ptr %ang
  store float 0x3FF0000000000000, ptr %zoom
  store i32 0, ptr %drag
  store i32 1, ptr %running
  store i32 0, ptr %frames
  store i32 0, ptr %max
  %many = icmp sgt i32 %argc, 1
  br i1 %many, label %getmax, label %init
getmax:
  %ap = getelementptr ptr, ptr %argv, i32 1
  %a1 = load ptr, ptr %ap
  %n = call i32 @atoi(ptr %a1)
  store i32 %n, ptr %max
  br label %init
init:
  call i32 @SDL_Init(i32 32)
  %win = call ptr @SDL_CreateWindow(ptr @title, i32 805240832, i32 805240832, i32 640, i32 480, i32 2)   ; SDL_WINDOW_OPENGL
  %ctx = call ptr @SDL_GL_CreateContext(ptr %win)
  %nc = icmp eq ptr %ctx, null
  br i1 %nc, label %fail, label %events
events:
  %got = call i32 @SDL_PollEvent(ptr %ev)
  %has = icmp ne i32 %got, 0
  br i1 %has, label %handle, label %draw
handle:
  %type = load i32, ptr %ev
  %isq = icmp eq i32 %type, 256
  br i1 %isq, label %quit, label %c1
quit:
  store i32 0, ptr %running
  br label %events
c1:
  %iskey = icmp eq i32 %type, 768
  br i1 %iskey, label %key, label %c2
key:
  %scp = getelementptr i8, ptr %ev, i32 16
  %sc = load i32, ptr %scp
  %esc = icmp eq i32 %sc, 41
  br i1 %esc, label %quit, label %events
c2:
  %isdn = icmp eq i32 %type, 1025            ; SDL_MOUSEBUTTONDOWN
  br i1 %isdn, label %down, label %c3
down:
  store i32 1, ptr %drag
  br label %events
c3:
  %isup = icmp eq i32 %type, 1026            ; SDL_MOUSEBUTTONUP
  br i1 %isup, label %up, label %c4
up:
  store i32 0, ptr %drag
  br label %events
c4:
  %ismm = icmp eq i32 %type, 1024
  br i1 %ismm, label %move, label %c5
move:
  %d = load i32, ptr %drag
  %dragging = icmp ne i32 %d, 0
  br i1 %dragging, label %rot, label %events
rot:
  %xp = getelementptr i8, ptr %ev, i32 28
  %xrel = load i32, ptr %xp
  %xf = sitofp i32 %xrel to float
  %a = load float, ptr %ang
  %a2 = fadd float %a, %xf
  store float %a2, ptr %ang
  br label %events
c5:
  %iswh = icmp eq i32 %type, 1027            ; SDL_MOUSEWHEEL
  br i1 %iswh, label %wheel, label %events
wheel:
  %yp = getelementptr i8, ptr %ev, i32 20
  %wy = load i32, ptr %yp
  %wf = sitofp i32 %wy to float
  %step = fmul float %wf, 0x3FB99999A0000000
  %z = load float, ptr %zoom
  %z2 = fadd float %z, %step
  %small = fcmp olt float %z2, 0x3FC99999A0000000
  %z3 = select i1 %small, float 0x3FC99999A0000000, float %z2
  store float %z3, ptr %zoom
  br label %events
draw:
  call void @glClearColor(float 0x3FAEB851E0000000, float 0x3FB70A3D80000000, float 0x3FC0A3D700000000, float 0x3FF0000000000000)
  call void @glClear(i32 16384)              ; GL_COLOR_BUFFER_BIT
  call void @glLoadIdentity()
  %zz = load float, ptr %zoom
  call void @glScalef(float %zz, float %zz, float 0x3FF0000000000000)
  %aa = load float, ptr %ang
  call void @glRotatef(float %aa, float 0x0000000000000000, float 0x0000000000000000, float 0x3FF0000000000000)
  call void @glBegin(i32 4)                  ; GL_TRIANGLES
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FC99999A0000000, float 0x3FC99999A0000000)
  call void @glVertex2f(float 0xBFE3333340000000, float 0xBFE0000000000000)
  call void @glColor3f(float 0x3FC99999A0000000, float 0x3FF0000000000000, float 0x3FC99999A0000000)
  call void @glVertex2f(float 0x3FE3333340000000, float 0xBFE0000000000000)
  call void @glColor3f(float 0x3FD3333340000000, float 0x3FD99999A0000000, float 0x3FF0000000000000)
  call void @glVertex2f(float 0x0000000000000000, float 0x3FE3333340000000)
  call void @glEnd()
  ; ==== HUD BEGIN（畫面）==== 由 _gen/_hud_patch.py 產生，勿手改
  ; 2D 疊加：正交投影（y 向下），畫完三角形之後，交換緩衝區之前
  call void @glMatrixMode(i32 5889)                  ; GL_PROJECTION
  call void @glLoadIdentity()
  call void @glOrtho(double 0.0, double 640.0, double 480.0, double 0.0, double -1.0, double 1.0)
  call void @glMatrixMode(i32 5888)                  ; GL_MODELVIEW
  call void @glLoadIdentity()
  call void @glBegin(i32 7)                          ; GL_QUADS：整段說明一批送出
  call void @hud_text_gl(i32 8, i32 440, ptr @hud_ta, i32 26, float 0x3FED7D7D80000000, float 0x3FED7D7D80000000, float 0x3FED7D7D80000000)
  call void @hud_text_gl(i32 8, i32 458, ptr @hud_tb, i32 8, float 0x3FED7D7D80000000, float 0x3FED7D7D80000000, float 0x3FED7D7D80000000)
  %hud_drag = load i32, ptr %drag
  %hud_isdrag = icmp ne i32 %hud_drag, 0
  br i1 %hud_isdrag, label %hud_dragging, label %hud_idle
hud_dragging:
  call void @hud_text_gl(i32 8, i32 8, ptr @hud_tc, i32 8, float 0x3FF0000000000000, float 0x3FEA5A5A60000000, float 0x3FD69696A0000000)
  br label %hud_end
hud_idle:
  call void @hud_text_gl(i32 8, i32 8, ptr @hud_td, i32 4, float 0x3FF0000000000000, float 0x3FEA5A5A60000000, float 0x3FD69696A0000000)
  br label %hud_end
hud_end:
  call void @glEnd()
  call void @glMatrixMode(i32 5889)
  call void @glLoadIdentity()
  call void @glMatrixMode(i32 5888)
  call void @glLoadIdentity()
  ; ==== HUD END（畫面）====
  call void @SDL_GL_SwapWindow(ptr %win)
  call void @SDL_Delay(i32 16)
  %f = load i32, ptr %frames
  %f1 = add i32 %f, 1
  store i32 %f1, ptr %frames
  %mx = load i32, ptr %max
  %hasmax = icmp sgt i32 %mx, 0
  %reached = icmp sge i32 %f1, %mx
  %stop = and i1 %hasmax, %reached
  br i1 %stop, label %done, label %chk
chk:
  %r = load i32, ptr %running
  %cont = icmp ne i32 %r, 0
  br i1 %cont, label %events, label %done
done:
  call void @SDL_GL_DeleteContext(ptr %ctx)
  call void @SDL_DestroyWindow(ptr %win)
  call void @SDL_Quit()
  ret i32 0
fail:
  call void @SDL_Quit()
  ret i32 1
}
