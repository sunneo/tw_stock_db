; 3D N-body（照 examples/python/gpgpu/nbody3d.py，即 sdlmm/exams/nbody3d.c 的移植）：float32 物理、發光點精靈（加法混合）、攝影機追蹤、覆蓋層與滑桿。
; 用法：lli nbody3d.ll [N] [LOOP] [frames]。滑鼠拖曳／方向鍵旋轉、＋－縮放、C 追蹤、R 隨機係數、H 覆蓋層。（由 _gen/_gen_nbody3d.py 產生）
target triple = "x86_64-pc-linux-gnu"

declare i32 @SDL_Init(i32)
declare void @SDL_Quit()
declare ptr @SDL_CreateWindow(ptr, i32, i32, i32, i32, i32)
declare ptr @SDL_GL_CreateContext(ptr)
declare void @SDL_GL_SwapWindow(ptr)
declare i32 @SDL_PollEvent(ptr)
declare void @SDL_Delay(i32)
declare i32 @SDL_GetTicks()
declare void @SDL_GL_DeleteContext(ptr)
declare void @SDL_DestroyWindow(ptr)
declare void @glClearColor(float, float, float, float)
declare void @glClear(i32)
declare void @glMatrixMode(i32)
declare void @glLoadIdentity()
declare void @gluPerspective(double, double, double, double)
declare void @gluLookAt(double, double, double, double, double, double, double, double, double)
declare void @glOrtho(double, double, double, double, double, double)
declare void @glPointSize(float)
declare void @glBegin(i32)
declare void @glEnd()
declare void @glColor3f(float, float, float)
declare void @glColor4f(float, float, float, float)
declare void @glVertex2f(float, float)
declare void @glVertex3f(float, float, float)
declare void @glEnable(i32)
declare void @glDisable(i32)
declare void @glBlendFunc(i32, i32)
declare void @glPointParameterfv(i32, ptr)
declare float @sqrtf(float)
declare double @sin(double)
declare double @cos(double)
declare i32 @atoi(ptr)
declare i32 @printf(ptr, ...)
declare i32 @snprintf(ptr, i64, ptr, ...)

@.s1 = private constant [3 x i8] c"on\00"
@.s2 = private constant [4 x i8] c"off\00"
@.s3 = private constant [32 x i8] c"[%-3d/%-3d] tm:%-3.3f bodies:%d\00"
@.s4 = private constant [24 x i8] c"simulate factor: %-3.5f\00"
@.s5 = private constant [21 x i8] c"random factor: %s[r]\00"
@.s6 = private constant [22 x i8] c"particle size: %-3.1f\00"
@.s7 = private constant [32 x i8] c"cam dist:%.1f angle:(%.2f,%.2f)\00"
@.s8 = private constant [23 x i8] c"camera tracking: %s[C]\00"
@.s9 = private constant [16 x i8] c"compute source:\00"
@.s10 = private constant [71 x i8] c"GPU source: needs the OpenCL layer (not available yet); staying on CPU\00"
@.s11 = private constant [33 x i8] c"MAX_X:%.1f MAX_Y:%.1f MAX_Z:%.1f\00"
@.s12 = private constant [33 x i8] c"MAX_Vel:%.1f Grav:%.1f Soft:%.1f\00"
@.s13 = private constant [48 x i8] c"[h]help [+/-]zoom [arrows/mouse]rotate [C]track\00"
@.s14 = private constant [4 x i8] c"CPU\00"
@.s15 = private constant [4 x i8] c"GPU\00"
@.s16 = private constant [22 x i8] c"[3D] NBody-Simulation\00"
@.s17 = private constant [7 x i8] c"%d %f\0A\00"
@.s18 = private constant [45 x i8] c"frames=%d bodies=%d cx=%.1f cy=%.1f cz=%.1f\0A\00"
@font = private constant [1235 x i32] [i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 20, i32 20, i32 20, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 10, i32 20, i32 63, i32 20, i32 20, i32 126, i32 40, i32 40, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 28, i32 40, i32 40, i32 28, i32 10, i32 10, i32 60, i32 8, i32 8, i32 0, i32 0, i32 0, i32 48, i32 72, i32 50, i32 4, i32 24, i32 46, i32 10, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 32, i32 48, i32 74, i32 70, i32 98, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 16, i32 16, i32 16, i32 16, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 16, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 8, i32 42, i32 28, i32 28, i32 42, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 126, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 42, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 2, i32 4, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 6, i32 24, i32 6, i32 2, i32 38, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 12, i32 12, i32 20, i32 36, i32 36, i32 62, i32 4, i32 4, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 32, i32 32, i32 60, i32 6, i32 2, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 48, i32 32, i32 60, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 34, i32 28, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 38, i32 58, i32 2, i32 4, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 28, i32 96, i32 24, i32 6, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 0, i32 126, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 96, i32 28, i32 2, i32 28, i32 96, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 6, i32 4, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 66, i32 78, i32 82, i32 82, i32 78, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 8, i32 24, i32 20, i32 20, i32 36, i32 62, i32 34, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 60, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 50, i32 32, i32 32, i32 32, i32 32, i32 50, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 36, i32 34, i32 34, i32 34, i32 34, i32 36, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 32, i32 32, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 62, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 4, i32 4, i32 4, i32 4, i32 4, i32 36, i32 56, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 36, i32 40, i32 56, i32 40, i32 36, i32 38, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 102, i32 86, i32 90, i32 74, i32 66, i32 66, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 50, i32 50, i32 42, i32 42, i32 42, i32 38, i32 38, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 4, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 38, i32 56, i32 36, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 36, i32 32, i32 48, i32 12, i32 2, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 34, i32 34, i32 36, i32 20, i32 20, i32 24, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 74, i32 90, i32 58, i32 54, i32 54, i32 36, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 52, i32 20, i32 8, i32 24, i32 20, i32 34, i32 98, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 38, i32 20, i32 24, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 2, i32 4, i32 8, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 28, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 28, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 16, i32 16, i32 8, i32 8, i32 4, i32 4, i32 2, i32 0, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 24, i32 0, i32 0, i32 0, i32 0, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 2, i32 62, i32 34, i32 38, i32 58, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 48, i32 32, i32 32, i32 48, i32 30, i32 0, i32 0, i32 0, i32 0, i32 2, i32 2, i32 2, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 62, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 0, i32 14, i32 8, i32 8, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 4, i32 60, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 56, i32 0, i32 0, i32 32, i32 32, i32 32, i32 38, i32 44, i32 56, i32 44, i32 36, i32 34, i32 0, i32 0, i32 0, i32 0, i32 48, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 8, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 54, i32 42, i32 42, i32 42, i32 42, i32 42, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 2, i32 2, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 16, i32 16, i32 16, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 48, i32 12, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 16, i32 62, i32 16, i32 16, i32 16, i32 16, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 36, i32 20, i32 24, i32 24, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 42, i32 58, i32 58, i32 52, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 20, i32 24, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 20, i32 20, i32 24, i32 8, i32 24, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 8, i32 16, i32 16, i32 62, i32 0, i32 0, i32 0, i32 0, i32 12, i32 8, i32 8, i32 8, i32 48, i32 8, i32 8, i32 8, i32 8, i32 12, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 48, i32 8, i32 8, i32 8, i32 4, i32 8, i32 8, i32 8, i32 8, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 48, i32 78, i32 0, i32 0, i32 0, i32 0]
@colr = private constant [10 x float] [float 0x0000000000000000, float 0x3FD0101020000000, float 0x3FE0101020000000, float 0x3FE8181820000000, float 0x3FF0000000000000, float 0x0000000000000000, float 0x0000000000000000, float 0x3FD8181820000000, float 0x3FE4141420000000, float 0x3FEC1C1C20000000]
@colg = private constant [10 x float] [float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FEC1C1C20000000, float 0x3FE8181820000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000]
@colb = private constant [10 x float] [float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FEC1C1C20000000, float 0x3FE8181820000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000]

define float @rnd(ptr %seed) {
entry:
  %t1 = load i32, ptr %seed
  %t2 = mul i32 %t1, 1103515245
  %t3 = add i32 %t2, 12345
  %t4 = and i32 %t3, 2147483647
  store i32 %t4, ptr %seed
  %t5 = ashr i32 %t4, 8
  %t6 = sitofp i32 %t5 to float
  %t7 = fdiv float %t6, 0x4160000000000000
  ret float %t7
}

define float @urand(ptr %seed, float %lo, float %hi) {
entry:
  %t1 = fsub float %hi, %lo
  %t2 = call float @rnd(ptr %seed)
  %t3 = fmul float %t1, %t2
  %t4 = fadd float %lo, %t3
  ret float %t4
}

define float @clampf(float %v, float %lo, float %hi) {
entry:
  %a1 = alloca float
  store float 0x0000000000000000, ptr %a1
  store float %v, ptr %a1
  %t1 = load float, ptr %a1
  %t2 = fcmp ogt float %t1, %hi
  br i1 %t2, label %then1, label %endif2
then1:
  %t3 = load float, ptr %a1
  %t4 = fadd float %t3, %hi
  %t5 = fmul float %t4, 0x3FE0000000000000
  store float %t5, ptr %a1
  br label %endif2
endif2:
  %t6 = load float, ptr %a1
  %t7 = fcmp olt float %t6, %lo
  br i1 %t7, label %then3, label %endif4
then3:
  %t8 = load float, ptr %a1
  %t9 = fadd float %t8, %lo
  %t10 = fmul float %t9, 0x3FE0000000000000
  store float %t10, ptr %a1
  br label %endif4
endif4:
  %t11 = load float, ptr %a1
  ret float %t11
}

define void @randomize(ptr %par, ptr %seed) {
entry:
  %t1 = call float @urand(ptr %seed, float 0x4024000000000000, float 0x4089000000000000)
  %t2 = getelementptr float, ptr %par, i32 0
  store float %t1, ptr %t2
  %t3 = call float @urand(ptr %seed, float 0x4024000000000000, float 0x4081800000000000)
  %t4 = getelementptr float, ptr %par, i32 1
  store float %t3, ptr %t4
  %t5 = call float @urand(ptr %seed, float 0x4024000000000000, float 0x4089000000000000)
  %t6 = getelementptr float, ptr %par, i32 2
  store float %t5, ptr %t6
  %t7 = call float @urand(ptr %seed, float 0x4024000000000000, float 0x4071800000000000)
  %t8 = getelementptr float, ptr %par, i32 3
  store float %t7, ptr %t8
  %t9 = call float @urand(ptr %seed, float 0x4024000000000000, float 0x404E000000000000)
  %t10 = getelementptr float, ptr %par, i32 4
  store float %t9, ptr %t10
  %t11 = call float @urand(ptr %seed, float 0x4049000000000000, float 0x4069000000000000)
  %t12 = getelementptr float, ptr %par, i32 5
  store float %t11, ptr %t12
  ret void
}

define void @init_bodies(ptr %x, ptr %y, ptr %z, ptr %vx, ptr %vy, ptr %vz, ptr %ms, ptr %par, ptr %seed, i32 %n) {
entry:
  %a1 = alloca i32
  store i32 0, ptr %a1
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t1 = load i32, ptr %a1
  %t2 = icmp slt i32 %t1, %n
  br i1 %t2, label %lb2, label %le3
lb2:
  %t3 = load i32, ptr %a1
  %t4 = getelementptr float, ptr %par, i32 0
  %t5 = load float, ptr %t4
  %t6 = call float @urand(ptr %seed, float 0x0000000000000000, float %t5)
  %t7 = getelementptr float, ptr %x, i32 %t3
  store float %t6, ptr %t7
  %t8 = getelementptr float, ptr %par, i32 1
  %t9 = load float, ptr %t8
  %t10 = call float @urand(ptr %seed, float 0x0000000000000000, float %t9)
  %t11 = getelementptr float, ptr %y, i32 %t3
  store float %t10, ptr %t11
  %t12 = getelementptr float, ptr %par, i32 2
  %t13 = load float, ptr %t12
  %t14 = call float @urand(ptr %seed, float 0x0000000000000000, float %t13)
  %t15 = getelementptr float, ptr %z, i32 %t3
  store float %t14, ptr %t15
  %t16 = getelementptr float, ptr %vx, i32 %t3
  store float 0x0000000000000000, ptr %t16
  %t17 = getelementptr float, ptr %vy, i32 %t3
  store float 0x0000000000000000, ptr %t17
  %t18 = getelementptr float, ptr %vz, i32 %t3
  store float 0x0000000000000000, ptr %t18
  %t19 = call float @urand(ptr %seed, float 0x4069000000000000, float 0x4072C00000000000)
  %t20 = fptosi float %t19 to i32
  %t21 = sitofp i32 %t20 to float
  %t22 = getelementptr float, ptr %ms, i32 %t3
  store float %t21, ptr %t22
  %t23 = load i32, ptr %a1
  %t24 = add i32 %t23, 1
  store i32 %t24, ptr %a1
  br label %lc1
le3:
  ret void
}

define void @step(ptr %x, ptr %y, ptr %z, ptr %vx, ptr %vy, ptr %vz, ptr %ms, ptr %pot, ptr %par, i32 %n) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  %a3 = alloca float
  %a4 = alloca float
  %a5 = alloca float
  %a6 = alloca float
  %a7 = alloca [8192 x float]
  %a8 = alloca [8192 x float]
  %a9 = alloca [8192 x float]
  %t1 = getelementptr float, ptr %par, i32 5
  %t2 = load float, ptr %t1
  %t3 = getelementptr float, ptr %par, i32 5
  %t4 = load float, ptr %t3
  %t5 = fmul float %t2, %t4
  %t6 = getelementptr float, ptr %par, i32 4
  %t7 = load float, ptr %t6
  %t8 = getelementptr float, ptr %par, i32 6
  %t9 = load float, ptr %t8
  store i32 0, ptr %a1
  store i32 0, ptr %a2
  store float 0x0000000000000000, ptr %a3
  store float 0x0000000000000000, ptr %a4
  store float 0x0000000000000000, ptr %a5
  store float 0x0000000000000000, ptr %a6
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t10 = load i32, ptr %a1
  %t11 = icmp slt i32 %t10, %n
  br i1 %t11, label %lb2, label %le3
lb2:
  store float 0x0000000000000000, ptr %a3
  store float 0x0000000000000000, ptr %a4
  store float 0x0000000000000000, ptr %a5
  store float 0x0000000000000000, ptr %a6
  %t12 = load i32, ptr %a1
  %t13 = getelementptr float, ptr %x, i32 %t12
  %t14 = load float, ptr %t13
  %t15 = load i32, ptr %a1
  %t16 = getelementptr float, ptr %y, i32 %t15
  %t17 = load float, ptr %t16
  %t18 = load i32, ptr %a1
  %t19 = getelementptr float, ptr %z, i32 %t18
  %t20 = load float, ptr %t19
  store i32 0, ptr %a2
  br label %lc4
lc4:
  %t21 = load i32, ptr %a2
  %t22 = icmp slt i32 %t21, %n
  br i1 %t22, label %lb5, label %le6
lb5:
  %t23 = load i32, ptr %a1
  %t24 = load i32, ptr %a2
  %t25 = icmp ne i32 %t23, %t24
  br i1 %t25, label %then7, label %endif8
then7:
  %t26 = load i32, ptr %a2
  %t27 = getelementptr float, ptr %x, i32 %t26
  %t28 = load float, ptr %t27
  %t29 = fsub float %t28, %t14
  %t30 = load i32, ptr %a2
  %t31 = getelementptr float, ptr %y, i32 %t30
  %t32 = load float, ptr %t31
  %t33 = fsub float %t32, %t17
  %t34 = load i32, ptr %a2
  %t35 = getelementptr float, ptr %z, i32 %t34
  %t36 = load float, ptr %t35
  %t37 = fsub float %t36, %t20
  %t38 = fmul float %t29, %t29
  %t39 = fmul float %t33, %t33
  %t40 = fadd float %t38, %t39
  %t41 = fmul float %t37, %t37
  %t42 = fadd float %t40, %t41
  %t43 = fadd float %t42, %t5
  %t44 = call float @sqrtf(float %t43)
  %t45 = fdiv float 0x3FF0000000000000, %t44
  %t46 = load i32, ptr %a2
  %t47 = getelementptr float, ptr %ms, i32 %t46
  %t48 = load float, ptr %t47
  %t49 = fmul float %t7, %t48
  %t50 = fmul float %t49, %t45
  %t51 = fmul float %t50, %t45
  %t52 = fmul float %t51, %t45
  %t53 = fmul float %t52, %t29
  %t54 = load float, ptr %a3
  %t55 = fadd float %t54, %t53
  store float %t55, ptr %a3
  %t56 = fmul float %t52, %t33
  %t57 = load float, ptr %a4
  %t58 = fadd float %t57, %t56
  store float %t58, ptr %a4
  %t59 = fmul float %t52, %t37
  %t60 = load float, ptr %a5
  %t61 = fadd float %t60, %t59
  store float %t61, ptr %a5
  %t62 = load i32, ptr %a2
  %t63 = getelementptr float, ptr %ms, i32 %t62
  %t64 = load float, ptr %t63
  %t65 = fmul float %t64, %t45
  %t66 = load float, ptr %a6
  %t67 = fadd float %t66, %t65
  store float %t67, ptr %a6
  br label %endif8
endif8:
  %t68 = load i32, ptr %a2
  %t69 = add i32 %t68, 1
  store i32 %t69, ptr %a2
  br label %lc4
le6:
  %t70 = load float, ptr %a3
  %t71 = load i32, ptr %a1
  %t72 = getelementptr float, ptr %a7, i32 %t71
  store float %t70, ptr %t72
  %t73 = load float, ptr %a4
  %t74 = load i32, ptr %a1
  %t75 = getelementptr float, ptr %a8, i32 %t74
  store float %t73, ptr %t75
  %t76 = load float, ptr %a5
  %t77 = load i32, ptr %a1
  %t78 = getelementptr float, ptr %a9, i32 %t77
  store float %t76, ptr %t78
  %t79 = load float, ptr %a6
  %t80 = load i32, ptr %a1
  %t81 = getelementptr float, ptr %pot, i32 %t80
  store float %t79, ptr %t81
  %t82 = load i32, ptr %a1
  %t83 = add i32 %t82, 1
  store i32 %t83, ptr %a1
  br label %lc1
le3:
  store i32 0, ptr %a1
  br label %lc9
lc9:
  %t84 = load i32, ptr %a1
  %t85 = icmp slt i32 %t84, %n
  br i1 %t85, label %lb10, label %le11
lb10:
  %t86 = load i32, ptr %a1
  %t87 = getelementptr float, ptr %vx, i32 %t86
  %t88 = load float, ptr %t87
  %t89 = getelementptr float, ptr %a7, i32 %t86
  %t90 = load float, ptr %t89
  %t91 = fmul float %t90, %t9
  %t92 = fadd float %t88, %t91
  %t93 = getelementptr float, ptr %vx, i32 %t86
  store float %t92, ptr %t93
  %t94 = getelementptr float, ptr %vy, i32 %t86
  %t95 = load float, ptr %t94
  %t96 = getelementptr float, ptr %a8, i32 %t86
  %t97 = load float, ptr %t96
  %t98 = fmul float %t97, %t9
  %t99 = fadd float %t95, %t98
  %t100 = getelementptr float, ptr %vy, i32 %t86
  store float %t99, ptr %t100
  %t101 = getelementptr float, ptr %vz, i32 %t86
  %t102 = load float, ptr %t101
  %t103 = getelementptr float, ptr %a9, i32 %t86
  %t104 = load float, ptr %t103
  %t105 = fmul float %t104, %t9
  %t106 = fadd float %t102, %t105
  %t107 = getelementptr float, ptr %vz, i32 %t86
  store float %t106, ptr %t107
  %t108 = getelementptr float, ptr %x, i32 %t86
  %t109 = load float, ptr %t108
  %t110 = getelementptr float, ptr %vx, i32 %t86
  %t111 = load float, ptr %t110
  %t112 = getelementptr float, ptr %par, i32 3
  %t113 = load float, ptr %t112
  %t114 = call float @clampf(float %t111, float 0x3FF0000000000000, float %t113)
  %t115 = fmul float %t114, %t9
  %t116 = fadd float %t109, %t115
  %t117 = getelementptr float, ptr %x, i32 %t86
  store float %t116, ptr %t117
  %t118 = getelementptr float, ptr %y, i32 %t86
  %t119 = load float, ptr %t118
  %t120 = getelementptr float, ptr %vy, i32 %t86
  %t121 = load float, ptr %t120
  %t122 = getelementptr float, ptr %par, i32 3
  %t123 = load float, ptr %t122
  %t124 = call float @clampf(float %t121, float 0x3FF0000000000000, float %t123)
  %t125 = fmul float %t124, %t9
  %t126 = fadd float %t119, %t125
  %t127 = getelementptr float, ptr %y, i32 %t86
  store float %t126, ptr %t127
  %t128 = getelementptr float, ptr %z, i32 %t86
  %t129 = load float, ptr %t128
  %t130 = getelementptr float, ptr %vz, i32 %t86
  %t131 = load float, ptr %t130
  %t132 = getelementptr float, ptr %par, i32 3
  %t133 = load float, ptr %t132
  %t134 = call float @clampf(float %t131, float 0x3FF0000000000000, float %t133)
  %t135 = fmul float %t134, %t9
  %t136 = fadd float %t129, %t135
  %t137 = getelementptr float, ptr %z, i32 %t86
  store float %t136, ptr %t137
  %t138 = load i32, ptr %a1
  %t139 = add i32 %t138, 1
  store i32 %t139, ptr %a1
  br label %lc9
le11:
  ret void
}

define void @cluster(ptr %x, ptr %y, ptr %z, ptr %ms, ptr %pot, i32 %n, ptr %out) {
entry:
  %a1 = alloca float
  %a2 = alloca i32
  %a3 = alloca i32
  %a4 = alloca float
  %a5 = alloca float
  %a6 = alloca float
  %a7 = alloca float
  store float 0xBFF0000000000000, ptr %a1
  store i32 0, ptr %a2
  store i32 0, ptr %a3
  store i32 0, ptr %a3
  br label %lc1
lc1:
  %t1 = load i32, ptr %a3
  %t2 = icmp slt i32 %t1, %n
  br i1 %t2, label %lb2, label %le3
lb2:
  %t3 = load i32, ptr %a3
  %t4 = getelementptr float, ptr %pot, i32 %t3
  %t5 = load float, ptr %t4
  %t6 = load float, ptr %a1
  %t7 = fcmp ogt float %t5, %t6
  br i1 %t7, label %then4, label %endif5
then4:
  %t8 = load i32, ptr %a3
  %t9 = getelementptr float, ptr %pot, i32 %t8
  %t10 = load float, ptr %t9
  store float %t10, ptr %a1
  %t11 = load i32, ptr %a3
  store i32 %t11, ptr %a2
  br label %endif5
endif5:
  %t12 = load i32, ptr %a3
  %t13 = add i32 %t12, 1
  store i32 %t13, ptr %a3
  br label %lc1
le3:
  %t14 = load i32, ptr %a2
  %t15 = getelementptr float, ptr %x, i32 %t14
  %t16 = load float, ptr %t15
  %t17 = load i32, ptr %a2
  %t18 = getelementptr float, ptr %y, i32 %t17
  %t19 = load float, ptr %t18
  %t20 = load i32, ptr %a2
  %t21 = getelementptr float, ptr %z, i32 %t20
  %t22 = load float, ptr %t21
  store float 0x0000000000000000, ptr %a4
  store float 0x0000000000000000, ptr %a5
  store float 0x0000000000000000, ptr %a6
  store float 0x0000000000000000, ptr %a7
  store i32 0, ptr %a3
  br label %lc6
lc6:
  %t23 = load i32, ptr %a3
  %t24 = icmp slt i32 %t23, %n
  br i1 %t24, label %lb7, label %le8
lb7:
  %t25 = load i32, ptr %a3
  %t26 = getelementptr float, ptr %x, i32 %t25
  %t27 = load float, ptr %t26
  %t28 = fsub float %t27, %t16
  %t29 = load i32, ptr %a3
  %t30 = getelementptr float, ptr %y, i32 %t29
  %t31 = load float, ptr %t30
  %t32 = fsub float %t31, %t19
  %t33 = load i32, ptr %a3
  %t34 = getelementptr float, ptr %z, i32 %t33
  %t35 = load float, ptr %t34
  %t36 = fsub float %t35, %t22
  %t37 = fmul float %t28, %t28
  %t38 = fmul float %t32, %t32
  %t39 = fadd float %t37, %t38
  %t40 = fmul float %t36, %t36
  %t41 = fadd float %t39, %t40
  %t42 = call float @sqrtf(float %t41)
  %t43 = fcmp olt float %t42, 0x4059000000000000
  br i1 %t43, label %then9, label %endif10
then9:
  %t44 = load i32, ptr %a3
  %t45 = getelementptr float, ptr %ms, i32 %t44
  %t46 = load float, ptr %t45
  %t47 = fadd float %t42, 0x3FF0000000000000
  %t48 = fdiv float %t46, %t47
  %t49 = load float, ptr %a4
  %t50 = fadd float %t49, %t48
  store float %t50, ptr %a4
  %t51 = load i32, ptr %a3
  %t52 = getelementptr float, ptr %x, i32 %t51
  %t53 = load float, ptr %t52
  %t54 = fmul float %t53, %t48
  %t55 = load float, ptr %a5
  %t56 = fadd float %t55, %t54
  store float %t56, ptr %a5
  %t57 = load i32, ptr %a3
  %t58 = getelementptr float, ptr %y, i32 %t57
  %t59 = load float, ptr %t58
  %t60 = fmul float %t59, %t48
  %t61 = load float, ptr %a6
  %t62 = fadd float %t61, %t60
  store float %t62, ptr %a6
  %t63 = load i32, ptr %a3
  %t64 = getelementptr float, ptr %z, i32 %t63
  %t65 = load float, ptr %t64
  %t66 = fmul float %t65, %t48
  %t67 = load float, ptr %a7
  %t68 = fadd float %t67, %t66
  store float %t68, ptr %a7
  br label %endif10
endif10:
  %t69 = load i32, ptr %a3
  %t70 = add i32 %t69, 1
  store i32 %t70, ptr %a3
  br label %lc6
le8:
  %t71 = load float, ptr %a4
  %t72 = fcmp ogt float %t71, 0x0000000000000000
  br i1 %t72, label %then11, label %endif12
then11:
  %t73 = load float, ptr %a5
  %t74 = load float, ptr %a4
  %t75 = fdiv float %t73, %t74
  %t76 = getelementptr float, ptr %out, i32 0
  store float %t75, ptr %t76
  %t77 = load float, ptr %a6
  %t78 = load float, ptr %a4
  %t79 = fdiv float %t77, %t78
  %t80 = getelementptr float, ptr %out, i32 1
  store float %t79, ptr %t80
  %t81 = load float, ptr %a7
  %t82 = load float, ptr %a4
  %t83 = fdiv float %t81, %t82
  %t84 = getelementptr float, ptr %out, i32 2
  store float %t83, ptr %t84
  br label %endif12
endif12:
  ret void
}

define void @text(ptr %s, i32 %x0, i32 %y0) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  %a3 = alloca i32
  store i32 0, ptr %a1
  store i32 0, ptr %a2
  store i32 0, ptr %a3
  br label %wc1
wc1:
  %t1 = load i32, ptr %a1
  %t2 = getelementptr i8, ptr %s, i32 %t1
  %t3 = load i8, ptr %t2
  %t4 = sext i8 %t3 to i32
  %t5 = and i32 %t4, 255
  %t6 = icmp ne i32 %t5, 0
  br i1 %t6, label %wb2, label %we3
wb2:
  %t7 = load i32, ptr %a1
  %t8 = getelementptr i8, ptr %s, i32 %t7
  %t9 = load i8, ptr %t8
  %t10 = sext i8 %t9 to i32
  %t11 = and i32 %t10, 255
  %t12 = icmp sge i32 %t11, 32
  %t13 = icmp slt i32 %t11, 127
  %t14 = and i1 %t12, %t13
  br i1 %t14, label %then4, label %endif5
then4:
  %t15 = sub i32 %t11, 32
  %t16 = mul i32 %t15, 13
  store i32 0, ptr %a2
  br label %lc6
lc6:
  %t17 = load i32, ptr %a2
  %t18 = icmp slt i32 %t17, 13
  br i1 %t18, label %lb7, label %le8
lb7:
  %t19 = load i32, ptr %a2
  %t20 = add i32 %t16, %t19
  %t21 = getelementptr i32, ptr @font, i32 %t20
  %t22 = load i32, ptr %t21
  %t23 = icmp ne i32 %t22, 0
  br i1 %t23, label %then9, label %endif10
then9:
  store i32 0, ptr %a3
  br label %lc11
lc11:
  %t24 = load i32, ptr %a3
  %t25 = icmp slt i32 %t24, 7
  br i1 %t25, label %lb12, label %le13
lb12:
  %t26 = load i32, ptr %a3
  %t27 = sub i32 6, %t26
  %t28 = shl i32 1, %t27
  %t29 = and i32 %t22, %t28
  %t30 = icmp ne i32 %t29, 0
  br i1 %t30, label %then14, label %endif15
then14:
  %t31 = load i32, ptr %a1
  %t32 = mul i32 %t31, 7
  %t33 = add i32 %x0, %t32
  %t34 = load i32, ptr %a3
  %t35 = add i32 %t33, %t34
  %t36 = sitofp i32 %t35 to float
  %t37 = fadd float %t36, 0x3FE0000000000000
  %t38 = load i32, ptr %a2
  %t39 = add i32 %y0, %t38
  %t40 = sub i32 %t39, 2
  %t41 = sitofp i32 %t40 to float
  %t42 = fadd float %t41, 0x3FE0000000000000
  call void @glVertex2f(float %t37, float %t42)
  br label %endif15
endif15:
  %t43 = load i32, ptr %a3
  %t44 = add i32 %t43, 1
  store i32 %t44, ptr %a3
  br label %lc11
le13:
  br label %endif10
endif10:
  %t45 = load i32, ptr %a2
  %t46 = add i32 %t45, 1
  store i32 %t46, ptr %a2
  br label %lc6
le8:
  br label %endif5
endif5:
  %t47 = load i32, ptr %a1
  %t48 = add i32 %t47, 1
  store i32 %t48, ptr %a1
  br label %wc1
we3:
  ret void
}

define void @draw_scene(ptr %x, ptr %y, ptr %z, i32 %n, ptr %ctr, float %dist, float %ax, float %ay, float %size) {
entry:
  %a1 = alloca [3 x float]
  %a2 = alloca i32
  call void @glClearColor(float 0x0000000000000000, float 0x0000000000000000, float 0x0000000000000000, float 0x3FF0000000000000)
  call void @glClear(i32 16640)
  call void @glDisable(i32 2929)
  call void @glMatrixMode(i32 5889)
  call void @glLoadIdentity()
  call void @gluPerspective(double 0x404658691F40987C, double 0x3FF6DB6DB6DB6DB7, double 0x3FB999999999999A, double 0x40B3880000000000)
  call void @glMatrixMode(i32 5888)
  call void @glLoadIdentity()
  %t1 = fpext float %ax to double
  %t2 = fpext float %ay to double
  %t3 = fpext float %dist to double
  %t4 = call double @sin(double %t2)
  %t5 = fmul double %t3, %t4
  %t6 = call double @cos(double %t1)
  %t7 = fmul double %t5, %t6
  %t8 = call double @sin(double %t1)
  %t9 = fmul double %t3, %t8
  %t10 = fsub double 0x0000000000000000, %t3
  %t11 = call double @cos(double %t2)
  %t12 = fmul double %t10, %t11
  %t13 = call double @cos(double %t1)
  %t14 = fmul double %t12, %t13
  call void @gluLookAt(double %t7, double %t9, double %t14, double 0x0000000000000000, double 0x0000000000000000, double 0x0000000000000000, double 0x0000000000000000, double 0x3FF0000000000000, double 0x0000000000000000)
  %t15 = getelementptr float, ptr %a1, i32 0
  store float 0x0000000000000000, ptr %t15
  %t16 = getelementptr float, ptr %a1, i32 1
  store float 0x0000000000000000, ptr %t16
  %t17 = getelementptr float, ptr %a1, i32 2
  store float 0x3F3A36E2E0000000, ptr %t17
  call void @glEnable(i32 3042)
  call void @glBlendFunc(i32 770, i32 1)
  call void @glEnable(i32 2832)
  call void @glPointSize(float %size)
  call void @glPointParameterfv(i32 33065, ptr %a1)
  call void @glBegin(i32 0)
  store i32 0, ptr %a2
  store i32 0, ptr %a2
  br label %lc1
lc1:
  %t18 = load i32, ptr %a2
  %t19 = icmp slt i32 %t18, %n
  br i1 %t19, label %lb2, label %le3
lb2:
  %t20 = load i32, ptr %a2
  %t21 = srem i32 %t20, 10
  %t22 = getelementptr float, ptr @colr, i32 %t21
  %t23 = load float, ptr %t22
  %t24 = getelementptr float, ptr @colg, i32 %t21
  %t25 = load float, ptr %t24
  %t26 = getelementptr float, ptr @colb, i32 %t21
  %t27 = load float, ptr %t26
  call void @glColor4f(float %t23, float %t25, float %t27, float 0x3FE0000000000000)
  %t28 = getelementptr float, ptr %x, i32 %t20
  %t29 = load float, ptr %t28
  %t30 = getelementptr float, ptr %ctr, i32 0
  %t31 = load float, ptr %t30
  %t32 = fsub float %t29, %t31
  %t33 = fmul float %t32, 0x3FB99999A0000000
  %t34 = getelementptr float, ptr %y, i32 %t20
  %t35 = load float, ptr %t34
  %t36 = getelementptr float, ptr %ctr, i32 1
  %t37 = load float, ptr %t36
  %t38 = fsub float %t35, %t37
  %t39 = fmul float %t38, 0x3FB99999A0000000
  %t40 = getelementptr float, ptr %z, i32 %t20
  %t41 = load float, ptr %t40
  %t42 = getelementptr float, ptr %ctr, i32 2
  %t43 = load float, ptr %t42
  %t44 = fsub float %t41, %t43
  %t45 = fmul float %t44, 0x3FB99999A0000000
  call void @glVertex3f(float %t33, float %t39, float %t45)
  %t46 = load i32, ptr %a2
  %t47 = add i32 %t46, 1
  store i32 %t47, ptr %a2
  br label %lc1
le3:
  call void @glEnd()
  call void @glDisable(i32 3042)
  ret void
}

define void @draw_hud(i32 %n, i32 %loop, i32 %loops, float %ms, ptr %par, i32 %rnd_on, float %dist, float %ax, float %ay, i32 %tracking, i32 %note) {
entry:
  %a1 = alloca [128 x i8]
  call void @glMatrixMode(i32 5889)
  call void @glLoadIdentity()
  call void @glOrtho(double 0x0000000000000000, double 0x4089000000000000, double 0x4081800000000000, double 0x0000000000000000, double 0xBFF0000000000000, double 0x3FF0000000000000)
  call void @glMatrixMode(i32 5888)
  call void @glLoadIdentity()
  call void @glDisable(i32 3042)
  call void @glPointSize(float 0x3FF0000000000000)
  call void @glBegin(i32 0)
  %t1 = fdiv float %ms, 0x408F400000000000
  %t2 = fpext float %t1 to double
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  %t3 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s3, i32 %loop, i32 %loops, double %t2, i32 %n)
  call void @text(ptr %a1, i32 5, i32 5)
  %t4 = getelementptr float, ptr %par, i32 6
  %t5 = load float, ptr %t4
  %t6 = fpext float %t5 to double
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  %t7 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s4, double %t6)
  call void @text(ptr %a1, i32 5, i32 25)
  %t8 = icmp ne i32 %rnd_on, 0
  %t9 = select i1 %t8, ptr @.s1, ptr @.s2
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  %t10 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s5, ptr %t9)
  call void @text(ptr %a1, i32 5, i32 45)
  %t11 = getelementptr float, ptr %par, i32 7
  %t12 = load float, ptr %t11
  %t13 = fpext float %t12 to double
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  %t14 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s6, double %t13)
  call void @text(ptr %a1, i32 5, i32 65)
  %t15 = fpext float %dist to double
  %t16 = fpext float %ax to double
  %t17 = fpext float %ay to double
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  %t18 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s7, double %t15, double %t16, double %t17)
  call void @text(ptr %a1, i32 5, i32 85)
  %t19 = icmp ne i32 %tracking, 0
  %t20 = select i1 %t19, ptr @.s1, ptr @.s2
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  %t21 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s8, ptr %t20)
  call void @text(ptr %a1, i32 5, i32 105)
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  %t22 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s9)
  call void @text(ptr %a1, i32 5, i32 125)
  %t23 = icmp ne i32 %note, 0
  br i1 %t23, label %then1, label %endif2
then1:
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FE99999A0000000, float 0x3FD99999A0000000)
  %t24 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s10)
  call void @text(ptr %a1, i32 5, i32 145)
  br label %endif2
endif2:
  %t25 = getelementptr float, ptr %par, i32 0
  %t26 = load float, ptr %t25
  %t27 = fpext float %t26 to double
  %t28 = getelementptr float, ptr %par, i32 1
  %t29 = load float, ptr %t28
  %t30 = fpext float %t29 to double
  %t31 = getelementptr float, ptr %par, i32 2
  %t32 = load float, ptr %t31
  %t33 = fpext float %t32 to double
  call void @glColor3f(float 0x3FE5581060000000, float 0x3FE5581060000000, float 0x3FE5581060000000)
  %t34 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s11, double %t27, double %t30, double %t33)
  call void @text(ptr %a1, i32 5, i32 165)
  %t35 = getelementptr float, ptr %par, i32 3
  %t36 = load float, ptr %t35
  %t37 = fpext float %t36 to double
  %t38 = getelementptr float, ptr %par, i32 4
  %t39 = load float, ptr %t38
  %t40 = fpext float %t39 to double
  %t41 = getelementptr float, ptr %par, i32 5
  %t42 = load float, ptr %t41
  %t43 = fpext float %t42 to double
  call void @glColor3f(float 0x3FE5581060000000, float 0x3FE5581060000000, float 0x3FE5581060000000)
  %t44 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s12, double %t37, double %t40, double %t43)
  call void @text(ptr %a1, i32 5, i32 185)
  call void @glColor3f(float 0x3FE5581060000000, float 0x3FE5581060000000, float 0x3FE5581060000000)
  %t45 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s13)
  call void @text(ptr %a1, i32 5, i32 205)
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @glEnd()
  call void @glBegin(i32 7)
  call void @glColor3f(float 0x3FBEB851E0000000, float 0x3FDEB851E0000000, float 0x3FBEB851E0000000)
  call void @glVertex2f(float 0x4061800000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x4067C00000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x4067C00000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x4061800000000000, float 0x4061C00000000000)
  call void @glColor3f(float 0x3FC851EB80000000, float 0x3FC851EB80000000, float 0x3FC851EB80000000)
  call void @glVertex2f(float 0x4069000000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x406F400000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x406F400000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x4069000000000000, float 0x4061C00000000000)
  %t46 = getelementptr float, ptr %par, i32 6
  %t47 = load float, ptr %t46
  %t48 = fdiv float %t47, 0x4000000000000000
  %t49 = fmul float %t48, 0x4079000000000000
  call void @glColor3f(float 0x3FEFAE1480000000, float 0x3FEFAE1480000000, float 0x0000000000000000)
  %t50 = fmul float %t49, 0x0000000000000000
  %t51 = fadd float 0x4074000000000000, %t50
  call void @glVertex2f(float %t51, float 0x4039000000000000)
  %t52 = fmul float %t49, 0x3FF0000000000000
  %t53 = fadd float 0x4074000000000000, %t52
  call void @glVertex2f(float %t53, float 0x4039000000000000)
  %t54 = fmul float %t49, 0x3FF0000000000000
  %t55 = fadd float 0x4074000000000000, %t54
  call void @glVertex2f(float %t55, float 0x4044000000000000)
  %t56 = fmul float %t49, 0x0000000000000000
  %t57 = fadd float 0x4074000000000000, %t56
  call void @glVertex2f(float %t57, float 0x4044000000000000)
  %t58 = getelementptr float, ptr %par, i32 7
  %t59 = load float, ptr %t58
  %t60 = fsub float %t59, 0x4014000000000000
  %t61 = fdiv float %t60, 0x4068600000000000
  %t62 = fmul float %t61, 0x4079000000000000
  call void @glColor3f(float 0x0000000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  %t63 = fmul float %t62, 0x0000000000000000
  %t64 = fadd float 0x4074000000000000, %t63
  call void @glVertex2f(float %t64, float 0x4050400000000000)
  %t65 = fmul float %t62, 0x3FF0000000000000
  %t66 = fadd float 0x4074000000000000, %t65
  call void @glVertex2f(float %t66, float 0x4050400000000000)
  %t67 = fmul float %t62, 0x3FF0000000000000
  %t68 = fadd float 0x4074000000000000, %t67
  call void @glVertex2f(float %t68, float 0x4054000000000000)
  %t69 = fmul float %t62, 0x0000000000000000
  %t70 = fadd float 0x4074000000000000, %t69
  call void @glVertex2f(float %t70, float 0x4054000000000000)
  call void @glEnd()
  call void @glBegin(i32 1)
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @glVertex2f(float 0x4061800000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x4067C00000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x4061800000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x4067C00000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x4061800000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x4061800000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x4067C00000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x4067C00000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x4069000000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x406F400000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x4069000000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x406F400000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x4069000000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x4069000000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x406F400000000000, float 0x405E800000000000)
  call void @glVertex2f(float 0x406F400000000000, float 0x4061C00000000000)
  call void @glVertex2f(float 0x4074000000000000, float 0x4039000000000000)
  call void @glVertex2f(float 0x4086800000000000, float 0x4039000000000000)
  call void @glVertex2f(float 0x4074000000000000, float 0x4044000000000000)
  call void @glVertex2f(float 0x4086800000000000, float 0x4044000000000000)
  call void @glVertex2f(float 0x4074000000000000, float 0x4039000000000000)
  call void @glVertex2f(float 0x4074000000000000, float 0x4044000000000000)
  call void @glVertex2f(float 0x4086800000000000, float 0x4039000000000000)
  call void @glVertex2f(float 0x4086800000000000, float 0x4044000000000000)
  call void @glVertex2f(float 0x4074000000000000, float 0x4050400000000000)
  call void @glVertex2f(float 0x4086800000000000, float 0x4050400000000000)
  call void @glVertex2f(float 0x4074000000000000, float 0x4054000000000000)
  call void @glVertex2f(float 0x4086800000000000, float 0x4054000000000000)
  call void @glVertex2f(float 0x4074000000000000, float 0x4050400000000000)
  call void @glVertex2f(float 0x4074000000000000, float 0x4054000000000000)
  call void @glVertex2f(float 0x4086800000000000, float 0x4050400000000000)
  call void @glVertex2f(float 0x4086800000000000, float 0x4054000000000000)
  call void @glEnd()
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @glBegin(i32 0)
  call void @text(ptr @.s14, i32 152, i32 125)
  call void @text(ptr @.s15, i32 212, i32 125)
  call void @glEnd()
  ret void
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %a1 = alloca [8192 x float]
  %a2 = alloca [8192 x float]
  %a3 = alloca [8192 x float]
  %a4 = alloca [8192 x float]
  %a5 = alloca [8192 x float]
  %a6 = alloca [8192 x float]
  %a7 = alloca [8192 x float]
  %a8 = alloca [8192 x float]
  %a9 = alloca [8 x float]
  %a10 = alloca [3 x float]
  %a11 = alloca [3 x float]
  %a12 = alloca [3 x float]
  %a13 = alloca [56 x i8]
  %a14 = alloca i32
  %a15 = alloca i32
  %a16 = alloca i32
  %a17 = alloca i32
  %a18 = alloca i32
  %a19 = alloca i32
  %a20 = alloca i32
  %a21 = alloca i32
  %a22 = alloca i32
  %a23 = alloca i32
  %a24 = alloca i32
  %a25 = alloca i32
  %a26 = alloca float
  %a27 = alloca float
  %a28 = alloca float
  %a29 = alloca float
  %a30 = alloca float
  %a31 = alloca float
  %a32 = alloca i32
  %a33 = alloca i32
  %a34 = alloca float
  %a35 = alloca i32
  %a36 = alloca i32
  store i32 12345, ptr %a14
  store i32 3072, ptr %a15
  store i32 2000, ptr %a16
  store i32 0, ptr %a17
  %t1 = icmp sgt i32 %argc, 1
  br i1 %t1, label %then1, label %endif2
then1:
  %t2 = getelementptr ptr, ptr %argv, i32 1
  %t3 = load ptr, ptr %t2
  %t4 = call i32 @atoi(ptr %t3)
  store i32 %t4, ptr %a15
  %t5 = load i32, ptr %a15
  %t6 = icmp slt i32 %t5, 16
  br i1 %t6, label %then3, label %endif4
then3:
  store i32 16, ptr %a15
  br label %endif4
endif4:
  %t7 = load i32, ptr %a15
  %t8 = icmp sgt i32 %t7, 8192
  br i1 %t8, label %then5, label %endif6
then5:
  store i32 8192, ptr %a15
  br label %endif6
endif6:
  br label %endif2
endif2:
  %t9 = icmp sgt i32 %argc, 2
  br i1 %t9, label %then7, label %endif8
then7:
  %t10 = getelementptr ptr, ptr %argv, i32 2
  %t11 = load ptr, ptr %t10
  %t12 = call i32 @atoi(ptr %t11)
  store i32 %t12, ptr %a16
  br label %endif8
endif8:
  %t13 = icmp sgt i32 %argc, 3
  br i1 %t13, label %then9, label %endif10
then9:
  %t14 = getelementptr ptr, ptr %argv, i32 3
  %t15 = load ptr, ptr %t14
  %t16 = call i32 @atoi(ptr %t15)
  store i32 %t16, ptr %a17
  br label %endif10
endif10:
  %t17 = load i32, ptr %a15
  %t18 = call i32 @SDL_Init(i32 32)
  %t19 = call ptr @SDL_CreateWindow(ptr @.s16, i32 805240832, i32 805240832, i32 800, i32 560, i32 2)
  %t20 = call ptr @SDL_GL_CreateContext(ptr %t19)
  %t21 = icmp eq ptr %t20, null
  br i1 %t21, label %then11, label %endif12
then11:
  call void @SDL_Quit()
  ret i32 1
endif12:
  %t22 = getelementptr float, ptr %a9, i32 6
  store float 0x3F947AE140000000, ptr %t22
  %t23 = getelementptr float, ptr %a9, i32 7
  store float 0x402E000000000000, ptr %t23
  call void @randomize(ptr %a9, ptr %a14)
  call void @init_bodies(ptr %a1, ptr %a2, ptr %a3, ptr %a4, ptr %a5, ptr %a6, ptr %a7, ptr %a9, ptr %a14, i32 %t17)
  %t24 = getelementptr float, ptr %a9, i32 0
  %t25 = load float, ptr %t24
  %t26 = fmul float %t25, 0x3FE0000000000000
  %t27 = getelementptr float, ptr %a11, i32 0
  store float %t26, ptr %t27
  %t28 = getelementptr float, ptr %a9, i32 1
  %t29 = load float, ptr %t28
  %t30 = fmul float %t29, 0x3FE0000000000000
  %t31 = getelementptr float, ptr %a11, i32 1
  store float %t30, ptr %t31
  %t32 = getelementptr float, ptr %a9, i32 2
  %t33 = load float, ptr %t32
  %t34 = fmul float %t33, 0x3FE0000000000000
  %t35 = getelementptr float, ptr %a11, i32 2
  store float %t34, ptr %t35
  %t36 = getelementptr float, ptr %a11, i32 0
  %t37 = load float, ptr %t36
  %t38 = getelementptr float, ptr %a12, i32 0
  store float %t37, ptr %t38
  %t39 = getelementptr float, ptr %a11, i32 1
  %t40 = load float, ptr %t39
  %t41 = getelementptr float, ptr %a12, i32 1
  store float %t40, ptr %t41
  %t42 = getelementptr float, ptr %a11, i32 2
  %t43 = load float, ptr %t42
  %t44 = getelementptr float, ptr %a12, i32 2
  store float %t43, ptr %t44
  store i32 1, ptr %a18
  store i32 0, ptr %a19
  store i32 0, ptr %a20
  store i32 0, ptr %a21
  store i32 1, ptr %a22
  store i32 1, ptr %a23
  store i32 0, ptr %a24
  store i32 0, ptr %a25
  store float 0x4049000000000000, ptr %a26
  store float 0x3FD3333340000000, ptr %a27
  store float 0x0000000000000000, ptr %a28
  store float 0x4049000000000000, ptr %a29
  store float 0x3FD3333340000000, ptr %a30
  store float 0x0000000000000000, ptr %a31
  store i32 0, ptr %a32
  store i32 0, ptr %a33
  store float 0x0000000000000000, ptr %a34
  %t45 = call i32 @SDL_GetTicks()
  store i32 %t45, ptr %a35
  %t46 = call i32 @SDL_GetTicks()
  store i32 %t46, ptr %a36
  br label %wc13
wc13:
  %t47 = load i32, ptr %a18
  %t48 = icmp ne i32 %t47, 0
  br i1 %t48, label %wb14, label %we15
wb14:
  br label %wc16
wc16:
  %t49 = call i32 @SDL_PollEvent(ptr %a13)
  %t50 = icmp ne i32 %t49, 0
  br i1 %t50, label %wb17, label %we18
wb17:
  %t51 = load i32, ptr %a13
  %t52 = icmp eq i32 %t51, 256
  br i1 %t52, label %then19, label %endif20
then19:
  store i32 0, ptr %a18
  br label %endif20
endif20:
  %t53 = icmp eq i32 %t51, 768
  br i1 %t53, label %then21, label %endif22
then21:
  %t54 = getelementptr i8, ptr %a13, i32 16
  %t55 = load i32, ptr %t54
  %t56 = icmp eq i32 %t55, 41
  br i1 %t56, label %then23, label %endif24
then23:
  store i32 0, ptr %a18
  br label %endif24
endif24:
  %t57 = icmp eq i32 %t55, 21
  br i1 %t57, label %then25, label %endif26
then25:
  %t58 = load i32, ptr %a21
  %t59 = sub i32 1, %t58
  store i32 %t59, ptr %a21
  br label %endif26
endif26:
  %t60 = icmp eq i32 %t55, 11
  br i1 %t60, label %then27, label %endif28
then27:
  %t61 = load i32, ptr %a23
  %t62 = sub i32 1, %t61
  store i32 %t62, ptr %a23
  br label %endif28
endif28:
  %t63 = icmp eq i32 %t55, 6
  br i1 %t63, label %then29, label %endif30
then29:
  %t64 = load i32, ptr %a22
  %t65 = sub i32 1, %t64
  store i32 %t65, ptr %a22
  %t66 = load i32, ptr %a22
  %t67 = icmp ne i32 %t66, 0
  br i1 %t67, label %then31, label %endif32
then31:
  %t68 = getelementptr float, ptr %a12, i32 0
  %t69 = load float, ptr %t68
  %t70 = getelementptr float, ptr %a11, i32 0
  store float %t69, ptr %t70
  %t71 = getelementptr float, ptr %a12, i32 1
  %t72 = load float, ptr %t71
  %t73 = getelementptr float, ptr %a11, i32 1
  store float %t72, ptr %t73
  %t74 = getelementptr float, ptr %a12, i32 2
  %t75 = load float, ptr %t74
  %t76 = getelementptr float, ptr %a11, i32 2
  store float %t75, ptr %t76
  store float 0x3FD3333340000000, ptr %a30
  store float 0x0000000000000000, ptr %a31
  store float 0x4049000000000000, ptr %a29
  br label %endif32
endif32:
  br label %endif30
endif30:
  %t77 = icmp eq i32 %t55, 46
  %t78 = icmp eq i32 %t55, 87
  %t79 = or i1 %t77, %t78
  br i1 %t79, label %then33, label %endif34
then33:
  %t80 = load float, ptr %a26
  %t81 = fsub float %t80, 0x4008000000000000
  store float %t81, ptr %a26
  store i32 0, ptr %a22
  br label %endif34
endif34:
  %t82 = icmp eq i32 %t55, 45
  %t83 = icmp eq i32 %t55, 86
  %t84 = or i1 %t82, %t83
  br i1 %t84, label %then35, label %endif36
then35:
  %t85 = load float, ptr %a26
  %t86 = fadd float %t85, 0x4008000000000000
  store float %t86, ptr %a26
  store i32 0, ptr %a22
  br label %endif36
endif36:
  %t87 = icmp eq i32 %t55, 82
  br i1 %t87, label %then37, label %endif38
then37:
  %t88 = load float, ptr %a27
  %t89 = fadd float %t88, 0x3FB99999A0000000
  store float %t89, ptr %a27
  store i32 0, ptr %a22
  br label %endif38
endif38:
  %t90 = icmp eq i32 %t55, 81
  br i1 %t90, label %then39, label %endif40
then39:
  %t91 = load float, ptr %a27
  %t92 = fsub float %t91, 0x3FB99999A0000000
  store float %t92, ptr %a27
  store i32 0, ptr %a22
  br label %endif40
endif40:
  %t93 = icmp eq i32 %t55, 80
  br i1 %t93, label %then41, label %endif42
then41:
  %t94 = load float, ptr %a28
  %t95 = fsub float %t94, 0x3FB99999A0000000
  store float %t95, ptr %a28
  store i32 0, ptr %a22
  br label %endif42
endif42:
  %t96 = icmp eq i32 %t55, 79
  br i1 %t96, label %then43, label %endif44
then43:
  %t97 = load float, ptr %a28
  %t98 = fadd float %t97, 0x3FB99999A0000000
  store float %t98, ptr %a28
  store i32 0, ptr %a22
  br label %endif44
endif44:
  br label %endif22
endif22:
  %t99 = getelementptr i8, ptr %a13, i32 20
  %t100 = load i32, ptr %t99
  %t101 = getelementptr i8, ptr %a13, i32 24
  %t102 = load i32, ptr %t101
  %t103 = icmp eq i32 %t51, 1025
  br i1 %t103, label %then45, label %endif46
then45:
  %t104 = load i32, ptr %a23
  %t105 = icmp ne i32 %t104, 0
  %t106 = icmp sge i32 %t100, 320
  %t107 = icmp sle i32 %t100, 720
  %t108 = and i1 %t106, %t107
  %t109 = icmp sge i32 %t102, 25
  %t110 = icmp slt i32 %t102, 40
  %t111 = and i1 %t109, %t110
  %t112 = icmp sge i32 %t102, 65
  %t113 = icmp slt i32 %t102, 80
  %t114 = and i1 %t112, %t113
  %t115 = or i1 %t111, %t114
  %t116 = and i1 %t108, %t115
  %t117 = and i1 %t105, %t116
  br i1 %t117, label %then47, label %endif48
then47:
  store i32 1, ptr %a24
  %t118 = icmp sgt i32 %t102, 25
  %t119 = icmp slt i32 %t102, 40
  %t120 = and i1 %t118, %t119
  %t121 = icmp sge i32 %t100, 320
  %t122 = and i1 %t120, %t121
  %t123 = icmp sle i32 %t100, 720
  %t124 = and i1 %t122, %t123
  br i1 %t124, label %then49, label %endif50
then49:
  %t125 = sub i32 %t100, 320
  %t126 = sitofp i32 %t125 to float
  %t127 = fmul float %t126, 0x4000000000000000
  %t128 = fdiv float %t127, 0x4079000000000000
  %t129 = getelementptr float, ptr %a9, i32 6
  store float %t128, ptr %t129
  br label %endif50
endif50:
  %t130 = icmp sgt i32 %t102, 65
  %t131 = icmp slt i32 %t102, 80
  %t132 = and i1 %t130, %t131
  %t133 = icmp sge i32 %t100, 320
  %t134 = and i1 %t132, %t133
  %t135 = icmp sle i32 %t100, 720
  %t136 = and i1 %t134, %t135
  br i1 %t136, label %then51, label %endif52
then51:
  %t137 = sub i32 %t100, 320
  %t138 = sitofp i32 %t137 to float
  %t139 = fmul float 0x4068600000000000, %t138
  %t140 = fdiv float %t139, 0x4079000000000000
  %t141 = fadd float 0x4014000000000000, %t140
  %t142 = getelementptr float, ptr %a9, i32 7
  store float %t141, ptr %t142
  br label %endif52
endif52:
  br label %endif48
endif48:
  %t143 = load i32, ptr %a23
  %t144 = icmp ne i32 %t143, 0
  %t145 = icmp sge i32 %t100, 320
  %t146 = icmp sle i32 %t100, 720
  %t147 = and i1 %t145, %t146
  %t148 = icmp sge i32 %t102, 25
  %t149 = icmp slt i32 %t102, 40
  %t150 = and i1 %t148, %t149
  %t151 = icmp sge i32 %t102, 65
  %t152 = icmp slt i32 %t102, 80
  %t153 = and i1 %t151, %t152
  %t154 = or i1 %t150, %t153
  %t155 = and i1 %t147, %t154
  %t156 = and i1 %t144, %t155
  %t157 = icmp eq i1 %t156, false
  br i1 %t157, label %then53, label %endif54
then53:
  %t158 = load i32, ptr %a23
  %t159 = icmp ne i32 %t158, 0
  %t160 = icmp sge i32 %t100, 140
  %t161 = icmp sle i32 %t100, 190
  %t162 = and i1 %t160, %t161
  %t163 = icmp sge i32 %t102, 122
  %t164 = and i1 %t162, %t163
  %t165 = icmp sle i32 %t102, 142
  %t166 = and i1 %t164, %t165
  %t167 = icmp sge i32 %t100, 200
  %t168 = icmp sle i32 %t100, 250
  %t169 = and i1 %t167, %t168
  %t170 = icmp sge i32 %t102, 122
  %t171 = and i1 %t169, %t170
  %t172 = icmp sle i32 %t102, 142
  %t173 = and i1 %t171, %t172
  %t174 = or i1 %t166, %t173
  %t175 = and i1 %t159, %t174
  br i1 %t175, label %then55, label %endif56
then55:
  store i32 3, ptr %a24
  store i32 0, ptr %a25
  %t176 = icmp sge i32 %t100, 200
  %t177 = icmp sle i32 %t100, 250
  %t178 = and i1 %t176, %t177
  %t179 = icmp sge i32 %t102, 122
  %t180 = and i1 %t178, %t179
  %t181 = icmp sle i32 %t102, 142
  %t182 = and i1 %t180, %t181
  br i1 %t182, label %then57, label %endif58
then57:
  store i32 1, ptr %a25
  br label %endif58
endif58:
  br label %endif56
endif56:
  %t183 = load i32, ptr %a23
  %t184 = icmp ne i32 %t183, 0
  %t185 = icmp sge i32 %t100, 140
  %t186 = icmp sle i32 %t100, 190
  %t187 = and i1 %t185, %t186
  %t188 = icmp sge i32 %t102, 122
  %t189 = and i1 %t187, %t188
  %t190 = icmp sle i32 %t102, 142
  %t191 = and i1 %t189, %t190
  %t192 = icmp sge i32 %t100, 200
  %t193 = icmp sle i32 %t100, 250
  %t194 = and i1 %t192, %t193
  %t195 = icmp sge i32 %t102, 122
  %t196 = and i1 %t194, %t195
  %t197 = icmp sle i32 %t102, 142
  %t198 = and i1 %t196, %t197
  %t199 = or i1 %t191, %t198
  %t200 = and i1 %t184, %t199
  %t201 = icmp eq i1 %t200, false
  br i1 %t201, label %then59, label %endif60
then59:
  store i32 2, ptr %a24
  store i32 %t100, ptr %a32
  store i32 %t102, ptr %a33
  br label %endif60
endif60:
  br label %endif54
endif54:
  br label %endif46
endif46:
  %t202 = icmp eq i32 %t51, 1026
  br i1 %t202, label %then61, label %endif62
then61:
  store i32 0, ptr %a24
  br label %endif62
endif62:
  %t203 = icmp eq i32 %t51, 1024
  br i1 %t203, label %then63, label %endif64
then63:
  %t204 = load i32, ptr %a24
  %t205 = icmp eq i32 %t204, 1
  br i1 %t205, label %then65, label %endif66
then65:
  %t206 = icmp sgt i32 %t102, 25
  %t207 = icmp slt i32 %t102, 40
  %t208 = and i1 %t206, %t207
  %t209 = icmp sge i32 %t100, 320
  %t210 = and i1 %t208, %t209
  %t211 = icmp sle i32 %t100, 720
  %t212 = and i1 %t210, %t211
  br i1 %t212, label %then67, label %endif68
then67:
  %t213 = sub i32 %t100, 320
  %t214 = sitofp i32 %t213 to float
  %t215 = fmul float %t214, 0x4000000000000000
  %t216 = fdiv float %t215, 0x4079000000000000
  %t217 = getelementptr float, ptr %a9, i32 6
  store float %t216, ptr %t217
  br label %endif68
endif68:
  %t218 = icmp sgt i32 %t102, 65
  %t219 = icmp slt i32 %t102, 80
  %t220 = and i1 %t218, %t219
  %t221 = icmp sge i32 %t100, 320
  %t222 = and i1 %t220, %t221
  %t223 = icmp sle i32 %t100, 720
  %t224 = and i1 %t222, %t223
  br i1 %t224, label %then69, label %endif70
then69:
  %t225 = sub i32 %t100, 320
  %t226 = sitofp i32 %t225 to float
  %t227 = fmul float 0x4068600000000000, %t226
  %t228 = fdiv float %t227, 0x4079000000000000
  %t229 = fadd float 0x4014000000000000, %t228
  %t230 = getelementptr float, ptr %a9, i32 7
  store float %t229, ptr %t230
  br label %endif70
endif70:
  br label %endif66
endif66:
  %t231 = load i32, ptr %a24
  %t232 = icmp eq i32 %t231, 2
  %t233 = getelementptr i8, ptr %a13, i32 16
  %t234 = load i32, ptr %t233
  %t235 = and i32 %t234, 1
  %t236 = icmp ne i32 %t235, 0
  %t237 = and i1 %t232, %t236
  br i1 %t237, label %then71, label %endif72
then71:
  %t238 = load i32, ptr %a32
  %t239 = sub i32 %t100, %t238
  %t240 = sitofp i32 %t239 to float
  %t241 = fmul float %t240, 0x3F747AE140000000
  %t242 = load float, ptr %a28
  %t243 = fadd float %t242, %t241
  store float %t243, ptr %a28
  %t244 = load i32, ptr %a33
  %t245 = sub i32 %t102, %t244
  %t246 = sitofp i32 %t245 to float
  %t247 = fmul float %t246, 0x3F747AE140000000
  %t248 = load float, ptr %a27
  %t249 = fsub float %t248, %t247
  store float %t249, ptr %a27
  %t250 = load float, ptr %a27
  %t251 = fcmp ogt float %t250, 0x3FF8000000000000
  br i1 %t251, label %then73, label %endif74
then73:
  store float 0x3FF8000000000000, ptr %a27
  br label %endif74
endif74:
  %t252 = load float, ptr %a27
  %t253 = fcmp olt float %t252, 0xBFF8000000000000
  br i1 %t253, label %then75, label %endif76
then75:
  store float 0xBFF8000000000000, ptr %a27
  br label %endif76
endif76:
  store i32 %t100, ptr %a32
  store i32 %t102, ptr %a33
  store i32 0, ptr %a22
  br label %endif72
endif72:
  br label %endif64
endif64:
  br label %wc16
we18:
  %t254 = load i32, ptr %a22
  %t255 = icmp ne i32 %t254, 0
  br i1 %t255, label %then77, label %endif78
then77:
  %t256 = load float, ptr %a30
  %t257 = load float, ptr %a27
  %t258 = fsub float %t256, %t257
  %t259 = fmul float %t258, 0x3FB99999A0000000
  %t260 = load float, ptr %a27
  %t261 = fadd float %t260, %t259
  store float %t261, ptr %a27
  %t262 = load float, ptr %a31
  %t263 = load float, ptr %a28
  %t264 = fsub float %t262, %t263
  %t265 = fmul float %t264, 0x3FB99999A0000000
  %t266 = load float, ptr %a28
  %t267 = fadd float %t266, %t265
  store float %t267, ptr %a28
  %t268 = load float, ptr %a29
  %t269 = load float, ptr %a26
  %t270 = fsub float %t268, %t269
  %t271 = fmul float %t270, 0x3FB99999A0000000
  %t272 = load float, ptr %a26
  %t273 = fadd float %t272, %t271
  store float %t273, ptr %a26
  br label %endif78
endif78:
  %t274 = load i32, ptr %a22
  %t275 = icmp eq i32 %t274, 0
  br i1 %t275, label %then79, label %endif80
then79:
  %t276 = load float, ptr %a27
  store float %t276, ptr %a30
  %t277 = load float, ptr %a28
  store float %t277, ptr %a31
  %t278 = load float, ptr %a26
  store float %t278, ptr %a29
  br label %endif80
endif80:
  %t279 = call i32 @SDL_GetTicks()
  call void @step(ptr %a1, ptr %a2, ptr %a3, ptr %a4, ptr %a5, ptr %a6, ptr %a7, ptr %a8, ptr %a9, i32 %t17)
  call void @cluster(ptr %a1, ptr %a2, ptr %a3, ptr %a7, ptr %a8, i32 %t17, ptr %a12)
  %t280 = call i32 @SDL_GetTicks()
  %t281 = sub i32 %t280, %t279
  %t282 = sitofp i32 %t281 to float
  store float %t282, ptr %a34
  %t283 = load i32, ptr %a20
  %t284 = add i32 %t283, 1
  store i32 %t284, ptr %a20
  %t285 = load i32, ptr %a20
  %t286 = load i32, ptr %a16
  %t287 = icmp sge i32 %t285, %t286
  br i1 %t287, label %then81, label %endif82
then81:
  %t288 = call i32 @SDL_GetTicks()
  %t289 = load i32, ptr %a36
  %t290 = sub i32 %t288, %t289
  %t291 = sitofp i32 %t290 to double
  %t292 = fdiv double %t291, 0x408F400000000000
  %t293 = call i32 (ptr, ...) @printf(ptr @.s17, i32 %t17, double %t292)
  %t294 = call i32 @SDL_GetTicks()
  store i32 %t294, ptr %a36
  %t295 = load i32, ptr %a21
  %t296 = icmp ne i32 %t295, 0
  br i1 %t296, label %then83, label %endif84
then83:
  %t297 = call float @urand(ptr %a14, float 0x0000000000000000, float 0x3FF0000000000000)
  %t298 = getelementptr float, ptr %a9, i32 6
  store float %t297, ptr %t298
  br label %endif84
endif84:
  call void @randomize(ptr %a9, ptr %a14)
  call void @init_bodies(ptr %a1, ptr %a2, ptr %a3, ptr %a4, ptr %a5, ptr %a6, ptr %a7, ptr %a9, ptr %a14, i32 %t17)
  store i32 0, ptr %a20
  %t299 = load i32, ptr %a22
  %t300 = icmp ne i32 %t299, 0
  br i1 %t300, label %then85, label %endif86
then85:
  %t301 = getelementptr float, ptr %a9, i32 0
  %t302 = load float, ptr %t301
  %t303 = fmul float %t302, 0x3FE0000000000000
  %t304 = getelementptr float, ptr %a11, i32 0
  store float %t303, ptr %t304
  %t305 = getelementptr float, ptr %a9, i32 1
  %t306 = load float, ptr %t305
  %t307 = fmul float %t306, 0x3FE0000000000000
  %t308 = getelementptr float, ptr %a11, i32 1
  store float %t307, ptr %t308
  %t309 = getelementptr float, ptr %a9, i32 2
  %t310 = load float, ptr %t309
  %t311 = fmul float %t310, 0x3FE0000000000000
  %t312 = getelementptr float, ptr %a11, i32 2
  store float %t311, ptr %t312
  br label %endif86
endif86:
  br label %endif82
endif82:
  %t313 = load i32, ptr %a22
  %t314 = icmp ne i32 %t313, 0
  br i1 %t314, label %then87, label %endif88
then87:
  %t315 = getelementptr float, ptr %a11, i32 0
  %t316 = load float, ptr %t315
  %t317 = getelementptr float, ptr %a10, i32 0
  store float %t316, ptr %t317
  %t318 = getelementptr float, ptr %a11, i32 1
  %t319 = load float, ptr %t318
  %t320 = getelementptr float, ptr %a10, i32 1
  store float %t319, ptr %t320
  %t321 = getelementptr float, ptr %a11, i32 2
  %t322 = load float, ptr %t321
  %t323 = getelementptr float, ptr %a10, i32 2
  store float %t322, ptr %t323
  br label %endif88
endif88:
  %t324 = load i32, ptr %a22
  %t325 = icmp eq i32 %t324, 0
  br i1 %t325, label %then89, label %endif90
then89:
  %t326 = getelementptr float, ptr %a9, i32 0
  %t327 = load float, ptr %t326
  %t328 = fmul float %t327, 0x3FE0000000000000
  %t329 = getelementptr float, ptr %a10, i32 0
  store float %t328, ptr %t329
  %t330 = getelementptr float, ptr %a9, i32 1
  %t331 = load float, ptr %t330
  %t332 = fmul float %t331, 0x3FE0000000000000
  %t333 = getelementptr float, ptr %a10, i32 1
  store float %t332, ptr %t333
  %t334 = getelementptr float, ptr %a9, i32 2
  %t335 = load float, ptr %t334
  %t336 = fmul float %t335, 0x3FE0000000000000
  %t337 = getelementptr float, ptr %a10, i32 2
  store float %t336, ptr %t337
  br label %endif90
endif90:
  %t338 = load float, ptr %a26
  %t339 = load float, ptr %a27
  %t340 = load float, ptr %a28
  %t341 = getelementptr float, ptr %a9, i32 7
  %t342 = load float, ptr %t341
  call void @draw_scene(ptr %a1, ptr %a2, ptr %a3, i32 %t17, ptr %a10, float %t338, float %t339, float %t340, float %t342)
  %t343 = load i32, ptr %a23
  %t344 = icmp ne i32 %t343, 0
  br i1 %t344, label %then91, label %endif92
then91:
  %t345 = load i32, ptr %a20
  %t346 = load i32, ptr %a16
  %t347 = load float, ptr %a34
  %t348 = load i32, ptr %a21
  %t349 = load float, ptr %a26
  %t350 = load float, ptr %a27
  %t351 = load float, ptr %a28
  %t352 = load i32, ptr %a22
  %t353 = load i32, ptr %a25
  call void @draw_hud(i32 %t17, i32 %t345, i32 %t346, float %t347, ptr %a9, i32 %t348, float %t349, float %t350, float %t351, i32 %t352, i32 %t353)
  br label %endif92
endif92:
  call void @SDL_GL_SwapWindow(ptr %t19)
  call void @SDL_Delay(i32 1)
  %t354 = load i32, ptr %a19
  %t355 = add i32 %t354, 1
  store i32 %t355, ptr %a19
  %t356 = load i32, ptr %a17
  %t357 = icmp sgt i32 %t356, 0
  %t358 = load i32, ptr %a19
  %t359 = load i32, ptr %a17
  %t360 = icmp sge i32 %t358, %t359
  %t361 = and i1 %t357, %t360
  br i1 %t361, label %then93, label %endif94
then93:
  store i32 0, ptr %a18
  br label %endif94
endif94:
  br label %wc13
we15:
  %t362 = load i32, ptr %a19
  %t363 = getelementptr float, ptr %a12, i32 0
  %t364 = load float, ptr %t363
  %t365 = fpext float %t364 to double
  %t366 = getelementptr float, ptr %a12, i32 1
  %t367 = load float, ptr %t366
  %t368 = fpext float %t367 to double
  %t369 = getelementptr float, ptr %a12, i32 2
  %t370 = load float, ptr %t369
  %t371 = fpext float %t370 to double
  %t372 = call i32 (ptr, ...) @printf(ptr @.s18, i32 %t362, i32 %t17, double %t365, double %t368, double %t371)
  call void @SDL_GL_DeleteContext(ptr %t20)
  call void @SDL_DestroyWindow(ptr %t19)
  call void @SDL_Quit()
  ret i32 0
}

