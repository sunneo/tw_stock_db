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
