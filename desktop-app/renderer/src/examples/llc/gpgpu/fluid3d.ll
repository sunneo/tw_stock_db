; 3D SPH 流體（CPU，double，O(N²)）＋ OpenGL 點精靈（SDL2）。滑鼠左鍵拖曳旋轉、滾輪縮放、空白＝晃一下水、R 重置、Esc 離開。
; 第一個參數＝跑幾幀後離開（測試用）。（由 _gen/_gen_fluid3d.py 產生；GPGPU 版要等 OpenCL 墊片）
target triple = "x86_64-pc-linux-gnu"

declare i32 @SDL_Init(i32)
declare void @SDL_Quit()
declare ptr @SDL_CreateWindow(ptr, i32, i32, i32, i32, i32)
declare ptr @SDL_GL_CreateContext(ptr)
declare void @SDL_GL_SwapWindow(ptr)
declare i32 @SDL_PollEvent(ptr)
declare void @SDL_Delay(i32)
declare void @SDL_GL_DeleteContext(ptr)
declare void @SDL_DestroyWindow(ptr)
declare void @glClearColor(float, float, float, float)
declare void @glClear(i32)
declare void @glMatrixMode(i32)
declare void @glLoadIdentity()
declare void @gluPerspective(double, double, double, double)
declare void @glTranslatef(float, float, float)
declare void @glRotatef(float, float, float, float)
declare void @glPointSize(float)
declare void @glBegin(i32)
declare void @glEnd()
declare void @glColor3f(float, float, float)
declare void @glVertex3f(float, float, float)
declare void @glEnable(i32)
declare void @glDisable(i32)
declare void @glOrtho(double, double, double, double, double, double)
declare void @glVertex2f(float, float)
declare i32 @snprintf(ptr, i64, ptr, ...)
declare double @sqrt(double)
declare i32 @atoi(ptr)
declare i32 @printf(ptr, ...)

@.s1 = private constant [44 x i8] c"%d particles | source: CPU (wasm) | step %d\00"
@.s2 = private constant [57 x i8] c"[drag]rotate [wheel]zoom [space]splash [P]pause [R]reset\00"
@.s3 = private constant [22 x i8] c"IR fluid3d (SPH, CPU)\00"
@.s4 = private constant [28 x i8] c"frames=%d n=%d y_mean=%.3f\0A\00"
@font = private constant [1235 x i32] [i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 20, i32 20, i32 20, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 10, i32 20, i32 63, i32 20, i32 20, i32 126, i32 40, i32 40, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 28, i32 40, i32 40, i32 28, i32 10, i32 10, i32 60, i32 8, i32 8, i32 0, i32 0, i32 0, i32 48, i32 72, i32 50, i32 4, i32 24, i32 46, i32 10, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 32, i32 48, i32 74, i32 70, i32 98, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 16, i32 16, i32 16, i32 16, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 16, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 8, i32 42, i32 28, i32 28, i32 42, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 126, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 42, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 2, i32 4, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 6, i32 24, i32 6, i32 2, i32 38, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 12, i32 12, i32 20, i32 36, i32 36, i32 62, i32 4, i32 4, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 32, i32 32, i32 60, i32 6, i32 2, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 48, i32 32, i32 60, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 34, i32 28, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 38, i32 58, i32 2, i32 4, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 28, i32 96, i32 24, i32 6, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 0, i32 126, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 96, i32 28, i32 2, i32 28, i32 96, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 6, i32 4, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 66, i32 78, i32 82, i32 82, i32 78, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 8, i32 24, i32 20, i32 20, i32 36, i32 62, i32 34, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 60, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 50, i32 32, i32 32, i32 32, i32 32, i32 50, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 36, i32 34, i32 34, i32 34, i32 34, i32 36, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 32, i32 32, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 62, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 4, i32 4, i32 4, i32 4, i32 4, i32 36, i32 56, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 36, i32 40, i32 56, i32 40, i32 36, i32 38, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 102, i32 86, i32 90, i32 74, i32 66, i32 66, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 50, i32 50, i32 42, i32 42, i32 42, i32 38, i32 38, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 4, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 38, i32 56, i32 36, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 36, i32 32, i32 48, i32 12, i32 2, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 34, i32 34, i32 36, i32 20, i32 20, i32 24, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 74, i32 90, i32 58, i32 54, i32 54, i32 36, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 52, i32 20, i32 8, i32 24, i32 20, i32 34, i32 98, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 38, i32 20, i32 24, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 2, i32 4, i32 8, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 28, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 28, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 16, i32 16, i32 8, i32 8, i32 4, i32 4, i32 2, i32 0, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 24, i32 0, i32 0, i32 0, i32 0, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 2, i32 62, i32 34, i32 38, i32 58, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 48, i32 32, i32 32, i32 48, i32 30, i32 0, i32 0, i32 0, i32 0, i32 2, i32 2, i32 2, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 62, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 0, i32 14, i32 8, i32 8, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 4, i32 60, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 56, i32 0, i32 0, i32 32, i32 32, i32 32, i32 38, i32 44, i32 56, i32 44, i32 36, i32 34, i32 0, i32 0, i32 0, i32 0, i32 48, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 8, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 54, i32 42, i32 42, i32 42, i32 42, i32 42, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 2, i32 2, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 16, i32 16, i32 16, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 48, i32 12, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 16, i32 62, i32 16, i32 16, i32 16, i32 16, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 36, i32 20, i32 24, i32 24, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 42, i32 58, i32 58, i32 52, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 20, i32 24, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 20, i32 20, i32 24, i32 8, i32 24, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 8, i32 16, i32 16, i32 62, i32 0, i32 0, i32 0, i32 0, i32 12, i32 8, i32 8, i32 8, i32 48, i32 8, i32 8, i32 8, i32 8, i32 12, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 48, i32 8, i32 8, i32 8, i32 4, i32 8, i32 8, i32 8, i32 8, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 48, i32 78, i32 0, i32 0, i32 0, i32 0]

define void @init(ptr %pos, ptr %vel) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  %a3 = alloca i32
  %a4 = alloca i32
  store i32 0, ptr %a1
  store i32 0, ptr %a2
  store i32 0, ptr %a3
  store i32 0, ptr %a4
  store i32 0, ptr %a2
  br label %lc1
lc1:
  %t1 = load i32, ptr %a2
  %t2 = icmp slt i32 %t1, 10
  br i1 %t2, label %lb2, label %le3
lb2:
  store i32 0, ptr %a3
  br label %lc4
lc4:
  %t3 = load i32, ptr %a3
  %t4 = icmp slt i32 %t3, 10
  br i1 %t4, label %lb5, label %le6
lb5:
  store i32 0, ptr %a4
  br label %lc7
lc7:
  %t5 = load i32, ptr %a4
  %t6 = icmp slt i32 %t5, 10
  br i1 %t6, label %lb8, label %le9
lb8:
  %t7 = load i32, ptr %a1
  %t8 = mul i32 %t7, 3
  %t9 = load i32, ptr %a2
  %t10 = sitofp i32 %t9 to double
  %t11 = fmul double %t10, 0x3FA999999999999A
  %t12 = fadd double %t11, 0x3FA999999999999A
  %t13 = getelementptr double, ptr %pos, i32 %t8
  store double %t12, ptr %t13
  %t14 = load i32, ptr %a3
  %t15 = sitofp i32 %t14 to double
  %t16 = fmul double %t15, 0x3FA999999999999A
  %t17 = fadd double %t16, 0x3FA999999999999A
  %t18 = fadd double %t17, 0x3FD3333333333333
  %t19 = add i32 %t8, 1
  %t20 = getelementptr double, ptr %pos, i32 %t19
  store double %t18, ptr %t20
  %t21 = load i32, ptr %a4
  %t22 = sitofp i32 %t21 to double
  %t23 = fmul double %t22, 0x3FA999999999999A
  %t24 = fadd double %t23, 0x3FA999999999999A
  %t25 = add i32 %t8, 2
  %t26 = getelementptr double, ptr %pos, i32 %t25
  store double %t24, ptr %t26
  %t27 = getelementptr double, ptr %vel, i32 %t8
  store double 0x0000000000000000, ptr %t27
  %t28 = add i32 %t8, 1
  %t29 = getelementptr double, ptr %vel, i32 %t28
  store double 0x0000000000000000, ptr %t29
  %t30 = add i32 %t8, 2
  %t31 = getelementptr double, ptr %vel, i32 %t30
  store double 0x0000000000000000, ptr %t31
  %t32 = load i32, ptr %a1
  %t33 = add i32 %t32, 1
  store i32 %t33, ptr %a1
  %t34 = load i32, ptr %a4
  %t35 = add i32 %t34, 1
  store i32 %t35, ptr %a4
  br label %lc7
le9:
  %t36 = load i32, ptr %a3
  %t37 = add i32 %t36, 1
  store i32 %t37, ptr %a3
  br label %lc4
le6:
  %t38 = load i32, ptr %a2
  %t39 = add i32 %t38, 1
  store i32 %t39, ptr %a2
  br label %lc1
le3:
  ret void
}

define void @step(ptr %pos, ptr %vel, ptr %rho, ptr %prs, ptr %acc) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  %a3 = alloca i32
  %a4 = alloca double
  %a5 = alloca double
  %a6 = alloca double
  %a7 = alloca double
  store i32 0, ptr %a1
  store i32 0, ptr %a2
  store i32 0, ptr %a3
  store double 0x0000000000000000, ptr %a4
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t1 = load i32, ptr %a1
  %t2 = icmp slt i32 %t1, 1000
  br i1 %t2, label %lb2, label %le3
lb2:
  store double 0x0000000000000000, ptr %a4
  %t3 = load i32, ptr %a1
  %t4 = mul i32 %t3, 3
  store i32 0, ptr %a2
  br label %lc4
lc4:
  %t5 = load i32, ptr %a2
  %t6 = icmp slt i32 %t5, 1000
  br i1 %t6, label %lb5, label %le6
lb5:
  %t7 = load i32, ptr %a2
  %t8 = mul i32 %t7, 3
  %t9 = getelementptr double, ptr %pos, i32 %t4
  %t10 = load double, ptr %t9
  %t11 = getelementptr double, ptr %pos, i32 %t8
  %t12 = load double, ptr %t11
  %t13 = fsub double %t10, %t12
  %t14 = add i32 %t4, 1
  %t15 = getelementptr double, ptr %pos, i32 %t14
  %t16 = load double, ptr %t15
  %t17 = add i32 %t8, 1
  %t18 = getelementptr double, ptr %pos, i32 %t17
  %t19 = load double, ptr %t18
  %t20 = fsub double %t16, %t19
  %t21 = add i32 %t4, 2
  %t22 = getelementptr double, ptr %pos, i32 %t21
  %t23 = load double, ptr %t22
  %t24 = add i32 %t8, 2
  %t25 = getelementptr double, ptr %pos, i32 %t24
  %t26 = load double, ptr %t25
  %t27 = fsub double %t23, %t26
  %t28 = fmul double %t13, %t13
  %t29 = fmul double %t20, %t20
  %t30 = fadd double %t28, %t29
  %t31 = fmul double %t27, %t27
  %t32 = fadd double %t30, %t31
  %t33 = fsub double 0x3F847AE147AE147C, %t32
  %t34 = fcmp ogt double %t33, 0x0000000000000000
  br i1 %t34, label %then7, label %endif8
then7:
  %t35 = fmul double %t33, %t33
  %t36 = fmul double %t35, %t33
  %t37 = load double, ptr %a4
  %t38 = fadd double %t37, %t36
  store double %t38, ptr %a4
  br label %endif8
endif8:
  %t39 = load i32, ptr %a2
  %t40 = add i32 %t39, 1
  store i32 %t40, ptr %a2
  br label %lc4
le6:
  %t41 = load double, ptr %a4
  %t42 = fmul double %t41, 0x41A7586A5FC3E4E0
  %t43 = load i32, ptr %a1
  %t44 = getelementptr double, ptr %rho, i32 %t43
  store double %t42, ptr %t44
  %t45 = load i32, ptr %a1
  %t46 = getelementptr double, ptr %rho, i32 %t45
  %t47 = load double, ptr %t46
  %t48 = fsub double %t47, 0x408F400000000000
  %t49 = fmul double %t48, 0x4069000000000000
  %t50 = fcmp ogt double %t49, 0x0000000000000000
  %t51 = select i1 %t50, double %t49, double 0x0000000000000000
  %t52 = load i32, ptr %a1
  %t53 = getelementptr double, ptr %prs, i32 %t52
  store double %t51, ptr %t53
  %t54 = load i32, ptr %a1
  %t55 = add i32 %t54, 1
  store i32 %t55, ptr %a1
  br label %lc1
le3:
  store double 0x0000000000000000, ptr %a5
  store double 0x0000000000000000, ptr %a6
  store double 0x0000000000000000, ptr %a7
  store i32 0, ptr %a1
  br label %lc9
lc9:
  %t56 = load i32, ptr %a1
  %t57 = icmp slt i32 %t56, 1000
  br i1 %t57, label %lb10, label %le11
lb10:
  store double 0x0000000000000000, ptr %a5
  store double 0x0000000000000000, ptr %a6
  store double 0x0000000000000000, ptr %a7
  %t58 = load i32, ptr %a1
  %t59 = mul i32 %t58, 3
  store i32 0, ptr %a2
  br label %lc12
lc12:
  %t60 = load i32, ptr %a2
  %t61 = icmp slt i32 %t60, 1000
  br i1 %t61, label %lb13, label %le14
lb13:
  %t62 = load i32, ptr %a2
  %t63 = mul i32 %t62, 3
  %t64 = getelementptr double, ptr %pos, i32 %t59
  %t65 = load double, ptr %t64
  %t66 = getelementptr double, ptr %pos, i32 %t63
  %t67 = load double, ptr %t66
  %t68 = fsub double %t65, %t67
  %t69 = add i32 %t59, 1
  %t70 = getelementptr double, ptr %pos, i32 %t69
  %t71 = load double, ptr %t70
  %t72 = add i32 %t63, 1
  %t73 = getelementptr double, ptr %pos, i32 %t72
  %t74 = load double, ptr %t73
  %t75 = fsub double %t71, %t74
  %t76 = add i32 %t59, 2
  %t77 = getelementptr double, ptr %pos, i32 %t76
  %t78 = load double, ptr %t77
  %t79 = add i32 %t63, 2
  %t80 = getelementptr double, ptr %pos, i32 %t79
  %t81 = load double, ptr %t80
  %t82 = fsub double %t78, %t81
  %t83 = fmul double %t68, %t68
  %t84 = fmul double %t75, %t75
  %t85 = fadd double %t83, %t84
  %t86 = fmul double %t82, %t82
  %t87 = fadd double %t85, %t86
  %t88 = fcmp olt double %t87, 0x3F847AE147AE147C
  %t89 = fcmp ogt double %t87, 0x3D719799812DEA11
  %t90 = and i1 %t88, %t89
  br i1 %t90, label %then15, label %endif16
then15:
  %t91 = call double @sqrt(double %t87)
  %t92 = fsub double 0x3FB999999999999A, %t91
  %t93 = load i32, ptr %a1
  %t94 = getelementptr double, ptr %prs, i32 %t93
  %t95 = load double, ptr %t94
  %t96 = load i32, ptr %a2
  %t97 = getelementptr double, ptr %prs, i32 %t96
  %t98 = load double, ptr %t97
  %t99 = fadd double %t95, %t98
  %t100 = load i32, ptr %a2
  %t101 = getelementptr double, ptr %rho, i32 %t100
  %t102 = load double, ptr %t101
  %t103 = fmul double %t102, 0x4000000000000000
  %t104 = fdiv double %t99, %t103
  %t105 = fmul double %t92, %t92
  %t106 = fdiv double %t105, %t91
  %t107 = fmul double %t104, %t106
  %t108 = fmul double %t107, 0x413B521D1C1ACAE7
  %t109 = fmul double %t68, %t108
  %t110 = load double, ptr %a5
  %t111 = fadd double %t110, %t109
  store double %t111, ptr %a5
  %t112 = fmul double %t75, %t108
  %t113 = load double, ptr %a6
  %t114 = fadd double %t113, %t112
  store double %t114, ptr %a6
  %t115 = fmul double %t82, %t108
  %t116 = load double, ptr %a7
  %t117 = fadd double %t116, %t115
  store double %t117, ptr %a7
  %t118 = load i32, ptr %a2
  %t119 = getelementptr double, ptr %rho, i32 %t118
  %t120 = load double, ptr %t119
  %t121 = fdiv double %t92, %t120
  %t122 = fmul double %t121, 0x41547D95D514182D
  %t123 = getelementptr double, ptr %vel, i32 %t63
  %t124 = load double, ptr %t123
  %t125 = getelementptr double, ptr %vel, i32 %t59
  %t126 = load double, ptr %t125
  %t127 = fsub double %t124, %t126
  %t128 = fmul double %t127, %t122
  %t129 = load double, ptr %a5
  %t130 = fadd double %t129, %t128
  store double %t130, ptr %a5
  %t131 = add i32 %t63, 1
  %t132 = getelementptr double, ptr %vel, i32 %t131
  %t133 = load double, ptr %t132
  %t134 = add i32 %t59, 1
  %t135 = getelementptr double, ptr %vel, i32 %t134
  %t136 = load double, ptr %t135
  %t137 = fsub double %t133, %t136
  %t138 = fmul double %t137, %t122
  %t139 = load double, ptr %a6
  %t140 = fadd double %t139, %t138
  store double %t140, ptr %a6
  %t141 = add i32 %t63, 2
  %t142 = getelementptr double, ptr %vel, i32 %t141
  %t143 = load double, ptr %t142
  %t144 = add i32 %t59, 2
  %t145 = getelementptr double, ptr %vel, i32 %t144
  %t146 = load double, ptr %t145
  %t147 = fsub double %t143, %t146
  %t148 = fmul double %t147, %t122
  %t149 = load double, ptr %a7
  %t150 = fadd double %t149, %t148
  store double %t150, ptr %a7
  br label %endif16
endif16:
  %t151 = load i32, ptr %a2
  %t152 = add i32 %t151, 1
  store i32 %t152, ptr %a2
  br label %lc12
le14:
  %t153 = load i32, ptr %a1
  %t154 = getelementptr double, ptr %rho, i32 %t153
  %t155 = load double, ptr %t154
  %t156 = fdiv double 0x3FF0000000000000, %t155
  %t157 = load double, ptr %a5
  %t158 = fmul double %t157, %t156
  %t159 = getelementptr double, ptr %acc, i32 %t59
  store double %t158, ptr %t159
  %t160 = load double, ptr %a6
  %t161 = fmul double %t160, %t156
  %t162 = fadd double %t161, 0xC02399999999999A
  %t163 = add i32 %t59, 1
  %t164 = getelementptr double, ptr %acc, i32 %t163
  store double %t162, ptr %t164
  %t165 = load double, ptr %a7
  %t166 = fmul double %t165, %t156
  %t167 = add i32 %t59, 2
  %t168 = getelementptr double, ptr %acc, i32 %t167
  store double %t166, ptr %t168
  %t169 = load i32, ptr %a1
  %t170 = add i32 %t169, 1
  store i32 %t170, ptr %a1
  br label %lc9
le11:
  store i32 0, ptr %a1
  br label %lc17
lc17:
  %t171 = load i32, ptr %a1
  %t172 = icmp slt i32 %t171, 1000
  br i1 %t172, label %lb18, label %le19
lb18:
  store i32 0, ptr %a3
  br label %lc20
lc20:
  %t173 = load i32, ptr %a3
  %t174 = icmp slt i32 %t173, 3
  br i1 %t174, label %lb21, label %le22
lb21:
  %t175 = load i32, ptr %a1
  %t176 = mul i32 %t175, 3
  %t177 = load i32, ptr %a3
  %t178 = add i32 %t176, %t177
  %t179 = getelementptr double, ptr %vel, i32 %t178
  %t180 = load double, ptr %t179
  %t181 = getelementptr double, ptr %acc, i32 %t178
  %t182 = load double, ptr %t181
  %t183 = fmul double %t182, 0x3F689374BC6A7EFA
  %t184 = fadd double %t180, %t183
  %t185 = getelementptr double, ptr %vel, i32 %t178
  store double %t184, ptr %t185
  %t186 = getelementptr double, ptr %pos, i32 %t178
  %t187 = load double, ptr %t186
  %t188 = getelementptr double, ptr %vel, i32 %t178
  %t189 = load double, ptr %t188
  %t190 = fmul double %t189, 0x3F689374BC6A7EFA
  %t191 = fadd double %t187, %t190
  %t192 = getelementptr double, ptr %pos, i32 %t178
  store double %t191, ptr %t192
  %t193 = getelementptr double, ptr %pos, i32 %t178
  %t194 = load double, ptr %t193
  %t195 = fcmp olt double %t194, 0x3F947AE147AE147B
  br i1 %t195, label %then23, label %endif24
then23:
  %t196 = getelementptr double, ptr %pos, i32 %t178
  store double 0x3F947AE147AE147B, ptr %t196
  %t197 = getelementptr double, ptr %vel, i32 %t178
  %t198 = load double, ptr %t197
  %t199 = fmul double %t198, 0xBFD3333333333333
  %t200 = getelementptr double, ptr %vel, i32 %t178
  store double %t199, ptr %t200
  br label %endif24
endif24:
  %t201 = getelementptr double, ptr %pos, i32 %t178
  %t202 = load double, ptr %t201
  %t203 = fcmp ogt double %t202, 0x3FEF5C28F5C28F5C
  br i1 %t203, label %then25, label %endif26
then25:
  %t204 = getelementptr double, ptr %pos, i32 %t178
  store double 0x3FEF5C28F5C28F5C, ptr %t204
  %t205 = getelementptr double, ptr %vel, i32 %t178
  %t206 = load double, ptr %t205
  %t207 = fmul double %t206, 0xBFD3333333333333
  %t208 = getelementptr double, ptr %vel, i32 %t178
  store double %t207, ptr %t208
  br label %endif26
endif26:
  %t209 = load i32, ptr %a3
  %t210 = add i32 %t209, 1
  store i32 %t210, ptr %a3
  br label %lc20
le22:
  %t211 = load i32, ptr %a1
  %t212 = add i32 %t211, 1
  store i32 %t212, ptr %a1
  br label %lc17
le19:
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

define void @draw(ptr %pos, ptr %vel, double %yaw, double %pitch, double %dist, i32 %step_no) {
entry:
  %a1 = alloca i32
  %a2 = alloca [160 x i8]
  call void @glClearColor(float 0x0000000000000000, float 0x0000000000000000, float 0x0000000000000000, float 0x3FF0000000000000)
  call void @glClear(i32 16640)
  call void @glMatrixMode(i32 5889)
  call void @glLoadIdentity()
  call void @gluPerspective(double 0x4046800000000000, double 0x3FF5555555555555, double 0x3FA999999999999A, double 0x4049000000000000)
  call void @glMatrixMode(i32 5888)
  call void @glLoadIdentity()
  %t1 = fsub double 0x0000000000000000, %dist
  %t2 = fptrunc double %t1 to float
  call void @glTranslatef(float 0x0000000000000000, float 0x0000000000000000, float %t2)
  %t3 = fptrunc double %pitch to float
  call void @glRotatef(float %t3, float 0x3FF0000000000000, float 0x0000000000000000, float 0x0000000000000000)
  %t4 = fptrunc double %yaw to float
  call void @glRotatef(float %t4, float 0x0000000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  call void @glTranslatef(float 0xBFE0000000000000, float 0xBFE0000000000000, float 0xBFE0000000000000)
  call void @glEnable(i32 2929)
  call void @glBegin(i32 1)
  call void @glColor3f(float 0x3FE0000000000000, float 0x3FE19999A0000000, float 0x3FE4CCCCC0000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x0000000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x0000000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x0000000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x0000000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x0000000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x0000000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x0000000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x0000000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x0000000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x0000000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x0000000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x0000000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x0000000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @glVertex3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @glEnd()
  call void @glPointSize(float 0x4024000000000000)
  call void @glBegin(i32 0)
  store i32 0, ptr %a1
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t5 = load i32, ptr %a1
  %t6 = icmp slt i32 %t5, 1000
  br i1 %t6, label %lb2, label %le3
lb2:
  %t7 = load i32, ptr %a1
  %t8 = mul i32 %t7, 3
  %t9 = getelementptr double, ptr %vel, i32 %t8
  %t10 = load double, ptr %t9
  %t11 = getelementptr double, ptr %vel, i32 %t8
  %t12 = load double, ptr %t11
  %t13 = fmul double %t10, %t12
  %t14 = add i32 %t8, 1
  %t15 = getelementptr double, ptr %vel, i32 %t14
  %t16 = load double, ptr %t15
  %t17 = add i32 %t8, 1
  %t18 = getelementptr double, ptr %vel, i32 %t17
  %t19 = load double, ptr %t18
  %t20 = fmul double %t16, %t19
  %t21 = fadd double %t13, %t20
  %t22 = add i32 %t8, 2
  %t23 = getelementptr double, ptr %vel, i32 %t22
  %t24 = load double, ptr %t23
  %t25 = add i32 %t8, 2
  %t26 = getelementptr double, ptr %vel, i32 %t25
  %t27 = load double, ptr %t26
  %t28 = fmul double %t24, %t27
  %t29 = fadd double %t21, %t28
  %t30 = call double @sqrt(double %t29)
  %t31 = fdiv double %t30, 0x4008000000000000
  %t32 = fcmp ogt double %t31, 0x3FF0000000000000
  %t33 = select i1 %t32, double 0x3FF0000000000000, double %t31
  %t34 = fmul double 0x3FE999999999999A, %t33
  %t35 = fadd double 0x3FB999999999999A, %t34
  %t36 = fptrunc double %t35 to float
  %t37 = fmul double 0x3FE3333333333333, %t33
  %t38 = fadd double 0x3FD6666666666666, %t37
  %t39 = fptrunc double %t38 to float
  %t40 = fmul double 0x3FB999999999999A, %t33
  %t41 = fadd double 0x3FECCCCCCCCCCCCD, %t40
  %t42 = fptrunc double %t41 to float
  call void @glColor3f(float %t36, float %t39, float %t42)
  %t43 = getelementptr double, ptr %pos, i32 %t8
  %t44 = load double, ptr %t43
  %t45 = fptrunc double %t44 to float
  %t46 = add i32 %t8, 1
  %t47 = getelementptr double, ptr %pos, i32 %t46
  %t48 = load double, ptr %t47
  %t49 = fptrunc double %t48 to float
  %t50 = add i32 %t8, 2
  %t51 = getelementptr double, ptr %pos, i32 %t50
  %t52 = load double, ptr %t51
  %t53 = fptrunc double %t52 to float
  call void @glVertex3f(float %t45, float %t49, float %t53)
  %t54 = load i32, ptr %a1
  %t55 = add i32 %t54, 1
  store i32 %t55, ptr %a1
  br label %lc1
le3:
  call void @glEnd()
  call void @glMatrixMode(i32 5889)
  call void @glLoadIdentity()
  call void @glOrtho(double 0x0000000000000000, double 0x4084000000000000, double 0x407E000000000000, double 0x0000000000000000, double 0xBFF0000000000000, double 0x3FF0000000000000)
  call void @glMatrixMode(i32 5888)
  call void @glLoadIdentity()
  call void @glDisable(i32 2929)
  call void @glPointSize(float 0x3FF0000000000000)
  call void @glBegin(i32 0)
  call void @glColor3f(float 0x3FE8000000000000, float 0x3FE99999A0000000, float 0x3FECCCCCC0000000)
  %t56 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a2, i64 160, ptr @.s1, i32 1000, i32 %step_no)
  call void @text(ptr %a2, i32 5, i32 5)
  call void @text(ptr @.s2, i32 5, i32 25)
  call void @glEnd()
  ret void
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %a1 = alloca [3000 x double]
  %a2 = alloca [3000 x double]
  %a3 = alloca [1000 x double]
  %a4 = alloca [1000 x double]
  %a5 = alloca [3000 x double]
  %a6 = alloca [56 x i8]
  %a7 = alloca i32
  %a8 = alloca i32
  %a9 = alloca i32
  %a10 = alloca i32
  %a11 = alloca i32
  %a12 = alloca double
  %a13 = alloca double
  %a14 = alloca double
  %a15 = alloca i32
  %a16 = alloca i32
  %a17 = alloca i32
  %a18 = alloca double
  store i32 1, ptr %a7
  store i32 0, ptr %a8
  store i32 0, ptr %a9
  store i32 0, ptr %a10
  store i32 0, ptr %a11
  store double 0x4041333333333333, ptr %a12
  store double 0x403419999999999A, ptr %a13
  store double 0x400199999999999A, ptr %a14
  store i32 0, ptr %a15
  store i32 0, ptr %a16
  %t1 = icmp sgt i32 %argc, 1
  br i1 %t1, label %then1, label %endif2
then1:
  %t2 = getelementptr ptr, ptr %argv, i32 1
  %t3 = load ptr, ptr %t2
  %t4 = call i32 @atoi(ptr %t3)
  store i32 %t4, ptr %a9
  br label %endif2
endif2:
  %t5 = call i32 @SDL_Init(i32 32)
  %t6 = call ptr @SDL_CreateWindow(ptr @.s3, i32 805240832, i32 805240832, i32 640, i32 480, i32 2)
  %t7 = call ptr @SDL_GL_CreateContext(ptr %t6)
  %t8 = icmp eq ptr %t7, null
  br i1 %t8, label %then3, label %endif4
then3:
  call void @SDL_Quit()
  ret i32 1
endif4:
  call void @init(ptr %a1, ptr %a2)
  store i32 0, ptr %a17
  br label %wc5
wc5:
  %t9 = load i32, ptr %a7
  %t10 = icmp ne i32 %t9, 0
  br i1 %t10, label %wb6, label %we7
wb6:
  br label %wc8
wc8:
  %t11 = call i32 @SDL_PollEvent(ptr %a6)
  %t12 = icmp ne i32 %t11, 0
  br i1 %t12, label %wb9, label %we10
wb9:
  %t13 = load i32, ptr %a6
  %t14 = icmp eq i32 %t13, 256
  br i1 %t14, label %then11, label %endif12
then11:
  store i32 0, ptr %a7
  br label %endif12
endif12:
  %t15 = icmp eq i32 %t13, 768
  br i1 %t15, label %then13, label %endif14
then13:
  %t16 = getelementptr i8, ptr %a6, i32 16
  %t17 = load i32, ptr %t16
  %t18 = icmp eq i32 %t17, 41
  br i1 %t18, label %then15, label %endif16
then15:
  store i32 0, ptr %a7
  br label %endif16
endif16:
  %t19 = icmp eq i32 %t17, 44
  br i1 %t19, label %then17, label %endif18
then17:
  store i32 1, ptr %a11
  br label %endif18
endif18:
  %t20 = icmp eq i32 %t17, 21
  br i1 %t20, label %then19, label %endif20
then19:
  call void @init(ptr %a1, ptr %a2)
  store i32 0, ptr %a16
  br label %endif20
endif20:
  %t21 = icmp eq i32 %t17, 19
  br i1 %t21, label %then21, label %endif22
then21:
  %t22 = load i32, ptr %a15
  %t23 = xor i32 %t22, 1
  store i32 %t23, ptr %a15
  br label %endif22
endif22:
  br label %endif14
endif14:
  %t24 = icmp eq i32 %t13, 1025
  br i1 %t24, label %then23, label %endif24
then23:
  store i32 1, ptr %a10
  br label %endif24
endif24:
  %t25 = icmp eq i32 %t13, 1026
  br i1 %t25, label %then25, label %endif26
then25:
  store i32 0, ptr %a10
  br label %endif26
endif26:
  %t26 = icmp eq i32 %t13, 1024
  %t27 = load i32, ptr %a10
  %t28 = icmp ne i32 %t27, 0
  %t29 = and i1 %t26, %t28
  br i1 %t29, label %then27, label %endif28
then27:
  %t30 = getelementptr i8, ptr %a6, i32 28
  %t31 = load i32, ptr %t30
  %t32 = sitofp i32 %t31 to double
  %t33 = fmul double %t32, 0x3FD999999999999A
  %t34 = load double, ptr %a12
  %t35 = fadd double %t34, %t33
  store double %t35, ptr %a12
  %t36 = getelementptr i8, ptr %a6, i32 32
  %t37 = load i32, ptr %t36
  %t38 = sitofp i32 %t37 to double
  %t39 = fmul double %t38, 0x3FD999999999999A
  %t40 = load double, ptr %a13
  %t41 = fadd double %t40, %t39
  store double %t41, ptr %a13
  br label %endif28
endif28:
  %t42 = icmp eq i32 %t13, 1027
  br i1 %t42, label %then29, label %endif30
then29:
  %t43 = getelementptr i8, ptr %a6, i32 20
  %t44 = load i32, ptr %t43
  %t45 = sitofp i32 %t44 to double
  %t46 = fsub double 0x0000000000000000, %t45
  %t47 = fmul double %t46, 0x3FC3333333333333
  %t48 = load double, ptr %a14
  %t49 = fadd double %t48, %t47
  store double %t49, ptr %a14
  %t50 = load double, ptr %a14
  %t51 = fcmp olt double %t50, 0x3FE999999999999A
  br i1 %t51, label %then31, label %endif32
then31:
  store double 0x3FE999999999999A, ptr %a14
  br label %endif32
endif32:
  br label %endif30
endif30:
  br label %wc8
we10:
  %t52 = load i32, ptr %a11
  %t53 = icmp ne i32 %t52, 0
  br i1 %t53, label %then33, label %endif34
then33:
  store i32 0, ptr %a17
  br label %lc35
lc35:
  %t54 = load i32, ptr %a17
  %t55 = icmp slt i32 %t54, 1000
  br i1 %t55, label %lb36, label %le37
lb36:
  %t56 = load i32, ptr %a17
  %t57 = mul i32 %t56, 3
  %t58 = getelementptr double, ptr %a2, i32 %t57
  %t59 = load double, ptr %t58
  %t60 = fadd double %t59, 0x4004000000000000
  %t61 = load i32, ptr %a17
  %t62 = mul i32 %t61, 3
  %t63 = getelementptr double, ptr %a2, i32 %t62
  store double %t60, ptr %t63
  %t64 = load i32, ptr %a17
  %t65 = add i32 %t64, 1
  store i32 %t65, ptr %a17
  br label %lc35
le37:
  store i32 0, ptr %a11
  br label %endif34
endif34:
  %t66 = load i32, ptr %a15
  %t67 = icmp eq i32 %t66, 0
  br i1 %t67, label %then38, label %endif39
then38:
  call void @step(ptr %a1, ptr %a2, ptr %a3, ptr %a4, ptr %a5)
  %t68 = load i32, ptr %a16
  %t69 = add i32 %t68, 1
  store i32 %t69, ptr %a16
  br label %endif39
endif39:
  %t70 = load double, ptr %a12
  %t71 = load double, ptr %a13
  %t72 = load double, ptr %a14
  %t73 = load i32, ptr %a16
  call void @draw(ptr %a1, ptr %a2, double %t70, double %t71, double %t72, i32 %t73)
  call void @SDL_GL_SwapWindow(ptr %t6)
  call void @SDL_Delay(i32 16)
  %t74 = load i32, ptr %a8
  %t75 = add i32 %t74, 1
  store i32 %t75, ptr %a8
  %t76 = load i32, ptr %a9
  %t77 = icmp sgt i32 %t76, 0
  %t78 = load i32, ptr %a8
  %t79 = load i32, ptr %a9
  %t80 = icmp sge i32 %t78, %t79
  %t81 = and i1 %t77, %t80
  br i1 %t81, label %then40, label %endif41
then40:
  store i32 0, ptr %a7
  br label %endif41
endif41:
  br label %wc5
we7:
  store double 0x0000000000000000, ptr %a18
  store i32 0, ptr %a17
  br label %lc42
lc42:
  %t82 = load i32, ptr %a17
  %t83 = icmp slt i32 %t82, 1000
  br i1 %t83, label %lb43, label %le44
lb43:
  %t84 = load i32, ptr %a17
  %t85 = mul i32 %t84, 3
  %t86 = add i32 %t85, 1
  %t87 = getelementptr double, ptr %a1, i32 %t86
  %t88 = load double, ptr %t87
  %t89 = load double, ptr %a18
  %t90 = fadd double %t89, %t88
  store double %t90, ptr %a18
  %t91 = load i32, ptr %a17
  %t92 = add i32 %t91, 1
  store i32 %t92, ptr %a17
  br label %lc42
le44:
  %t93 = load i32, ptr %a8
  %t94 = load double, ptr %a18
  %t95 = fdiv double %t94, 0x408F400000000000
  %t96 = call i32 (ptr, ...) @printf(ptr @.s4, i32 %t93, i32 1000, double %t95)
  call void @SDL_GL_DeleteContext(ptr %t7)
  call void @SDL_DestroyWindow(ptr %t6)
  call void @SDL_Quit()
  ret i32 0
}

