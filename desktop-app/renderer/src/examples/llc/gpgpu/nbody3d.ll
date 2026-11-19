; 3D N-body（CPU 版，double，O(N²) 引力，半隱式積分）＋ OpenGL 點精靈（SDL2）。同一份 .ll：原生編譯，或在 run terminal 用 lli 跑（wasm host import）。
; 滑鼠左鍵拖曳旋轉、滾輪縮放、空白暫停、R 重置、Esc 離開。第一個參數＝跑幾幀後離開（測試用）。
; （由 _gen/_gen_nbody3d.py 產生；GPGPU 版要等 OpenCL 墊片）
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
declare double @sqrt(double)
declare double @sin(double)
declare double @cos(double)
declare i32 @atoi(ptr)
declare i32 @printf(ptr, ...)

@.s1 = private constant [17 x i8] c"IR nbody3d (CPU)\00"
@.s2 = private constant [24 x i8] c"frames=%d kinetic=%.2f\0A\00"

define double @rnd(ptr %seed) {
entry:
  %t1 = load i32, ptr %seed
  %t2 = mul i32 %t1, 1103515245
  %t3 = add i32 %t2, 12345
  %t4 = and i32 %t3, 2147483647
  store i32 %t4, ptr %seed
  %t5 = ashr i32 %t4, 8
  %t6 = sitofp i32 %t5 to double
  %t7 = fdiv double %t6, 0x4160000000000000
  ret double %t7
}

define void @init(ptr %px, ptr %vx, ptr %ms, ptr %seed) {
entry:
  %a1 = alloca i32
  store i32 0, ptr %a1
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t1 = load i32, ptr %a1
  %t2 = icmp slt i32 %t1, 300
  br i1 %t2, label %lb2, label %le3
lb2:
  %t3 = call double @rnd(ptr %seed)
  %t4 = fmul double 0x4022000000000000, %t3
  %t5 = fadd double 0x4000000000000000, %t4
  %t6 = call double @rnd(ptr %seed)
  %t7 = fmul double 0x401921FB53C8D4F1, %t6
  %t8 = call double @rnd(ptr %seed)
  %t9 = fsub double %t8, 0x3FE0000000000000
  %t10 = fmul double %t9, 0x3FE999999999999A
  %t11 = fdiv double 0x4044000000000000, %t5
  %t12 = call double @sqrt(double %t11)
  %t13 = call double @rnd(ptr %seed)
  %t14 = fmul double 0x3FC999999999999A, %t13
  %t15 = fadd double 0x3FECCCCCCCCCCCCD, %t14
  %t16 = fmul double %t12, %t15
  %t17 = load i32, ptr %a1
  %t18 = mul i32 %t17, 3
  %t19 = call double @cos(double %t7)
  %t20 = fmul double %t5, %t19
  %t21 = getelementptr double, ptr %px, i32 %t18
  store double %t20, ptr %t21
  %t22 = add i32 %t18, 1
  %t23 = getelementptr double, ptr %px, i32 %t22
  store double %t10, ptr %t23
  %t24 = call double @sin(double %t7)
  %t25 = fmul double %t5, %t24
  %t26 = add i32 %t18, 2
  %t27 = getelementptr double, ptr %px, i32 %t26
  store double %t25, ptr %t27
  %t28 = fsub double 0x0000000000000000, %t16
  %t29 = call double @sin(double %t7)
  %t30 = fmul double %t28, %t29
  %t31 = getelementptr double, ptr %vx, i32 %t18
  store double %t30, ptr %t31
  %t32 = add i32 %t18, 1
  %t33 = getelementptr double, ptr %vx, i32 %t32
  store double 0x0000000000000000, ptr %t33
  %t34 = call double @cos(double %t7)
  %t35 = fmul double %t16, %t34
  %t36 = add i32 %t18, 2
  %t37 = getelementptr double, ptr %vx, i32 %t36
  store double %t35, ptr %t37
  %t38 = load i32, ptr %a1
  %t39 = getelementptr double, ptr %ms, i32 %t38
  store double 0x3FF0000000000000, ptr %t39
  %t40 = load i32, ptr %a1
  %t41 = add i32 %t40, 1
  store i32 %t41, ptr %a1
  br label %lc1
le3:
  br i1 true, label %then4, label %endif5
then4:
  %t42 = getelementptr double, ptr %px, i32 0
  store double 0x0000000000000000, ptr %t42
  %t43 = getelementptr double, ptr %px, i32 1
  store double 0x0000000000000000, ptr %t43
  %t44 = getelementptr double, ptr %px, i32 2
  store double 0x0000000000000000, ptr %t44
  %t45 = getelementptr double, ptr %vx, i32 0
  store double 0x0000000000000000, ptr %t45
  %t46 = getelementptr double, ptr %vx, i32 1
  store double 0x0000000000000000, ptr %t46
  %t47 = getelementptr double, ptr %vx, i32 2
  store double 0x0000000000000000, ptr %t47
  %t48 = getelementptr double, ptr %ms, i32 0
  store double 0x4044000000000000, ptr %t48
  br label %endif5
endif5:
  ret void
}

define void @step(ptr %px, ptr %vx, ptr %ms, double %dt) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  %a3 = alloca double
  %a4 = alloca double
  %a5 = alloca double
  store i32 0, ptr %a1
  store i32 0, ptr %a2
  store double 0x0000000000000000, ptr %a3
  store double 0x0000000000000000, ptr %a4
  store double 0x0000000000000000, ptr %a5
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t1 = load i32, ptr %a1
  %t2 = icmp slt i32 %t1, 300
  br i1 %t2, label %lb2, label %le3
lb2:
  store double 0x0000000000000000, ptr %a3
  store double 0x0000000000000000, ptr %a4
  store double 0x0000000000000000, ptr %a5
  %t3 = load i32, ptr %a1
  %t4 = mul i32 %t3, 3
  store i32 0, ptr %a2
  br label %lc4
lc4:
  %t5 = load i32, ptr %a2
  %t6 = icmp slt i32 %t5, 300
  br i1 %t6, label %lb5, label %le6
lb5:
  %t7 = load i32, ptr %a1
  %t8 = load i32, ptr %a2
  %t9 = icmp ne i32 %t7, %t8
  br i1 %t9, label %then7, label %endif8
then7:
  %t10 = load i32, ptr %a2
  %t11 = mul i32 %t10, 3
  %t12 = getelementptr double, ptr %px, i32 %t11
  %t13 = load double, ptr %t12
  %t14 = getelementptr double, ptr %px, i32 %t4
  %t15 = load double, ptr %t14
  %t16 = fsub double %t13, %t15
  %t17 = add i32 %t11, 1
  %t18 = getelementptr double, ptr %px, i32 %t17
  %t19 = load double, ptr %t18
  %t20 = add i32 %t4, 1
  %t21 = getelementptr double, ptr %px, i32 %t20
  %t22 = load double, ptr %t21
  %t23 = fsub double %t19, %t22
  %t24 = add i32 %t11, 2
  %t25 = getelementptr double, ptr %px, i32 %t24
  %t26 = load double, ptr %t25
  %t27 = add i32 %t4, 2
  %t28 = getelementptr double, ptr %px, i32 %t27
  %t29 = load double, ptr %t28
  %t30 = fsub double %t26, %t29
  %t31 = fmul double %t16, %t16
  %t32 = fmul double %t23, %t23
  %t33 = fadd double %t31, %t32
  %t34 = fmul double %t30, %t30
  %t35 = fadd double %t33, %t34
  %t36 = fadd double %t35, 0x3FA999999999999A
  %t37 = load i32, ptr %a2
  %t38 = getelementptr double, ptr %ms, i32 %t37
  %t39 = load double, ptr %t38
  %t40 = call double @sqrt(double %t36)
  %t41 = fmul double %t36, %t40
  %t42 = fdiv double %t39, %t41
  %t43 = fmul double %t16, %t42
  %t44 = load double, ptr %a3
  %t45 = fadd double %t44, %t43
  %t46 = fsub double %t44, %t43
  %t47 = fmul double %t44, %t43
  %t48 = fdiv double %t44, %t43
  store double %t45, ptr %a3
  %t49 = fmul double %t23, %t42
  %t50 = load double, ptr %a4
  %t51 = fadd double %t50, %t49
  %t52 = fsub double %t50, %t49
  %t53 = fmul double %t50, %t49
  %t54 = fdiv double %t50, %t49
  store double %t51, ptr %a4
  %t55 = fmul double %t30, %t42
  %t56 = load double, ptr %a5
  %t57 = fadd double %t56, %t55
  %t58 = fsub double %t56, %t55
  %t59 = fmul double %t56, %t55
  %t60 = fdiv double %t56, %t55
  store double %t57, ptr %a5
  br label %endif8
endif8:
  %t61 = load i32, ptr %a2
  %t62 = add i32 %t61, 1
  store i32 %t62, ptr %a2
  br label %lc4
le6:
  %t63 = getelementptr double, ptr %vx, i32 %t4
  %t64 = load double, ptr %t63
  %t65 = load double, ptr %a3
  %t66 = fmul double %t65, %dt
  %t67 = fadd double %t64, %t66
  %t68 = getelementptr double, ptr %vx, i32 %t4
  store double %t67, ptr %t68
  %t69 = add i32 %t4, 1
  %t70 = getelementptr double, ptr %vx, i32 %t69
  %t71 = load double, ptr %t70
  %t72 = load double, ptr %a4
  %t73 = fmul double %t72, %dt
  %t74 = fadd double %t71, %t73
  %t75 = add i32 %t4, 1
  %t76 = getelementptr double, ptr %vx, i32 %t75
  store double %t74, ptr %t76
  %t77 = add i32 %t4, 2
  %t78 = getelementptr double, ptr %vx, i32 %t77
  %t79 = load double, ptr %t78
  %t80 = load double, ptr %a5
  %t81 = fmul double %t80, %dt
  %t82 = fadd double %t79, %t81
  %t83 = add i32 %t4, 2
  %t84 = getelementptr double, ptr %vx, i32 %t83
  store double %t82, ptr %t84
  %t85 = load i32, ptr %a1
  %t86 = add i32 %t85, 1
  store i32 %t86, ptr %a1
  br label %lc1
le3:
  store i32 0, ptr %a1
  br label %lc9
lc9:
  %t87 = load i32, ptr %a1
  %t88 = icmp slt i32 %t87, 300
  br i1 %t88, label %lb10, label %le11
lb10:
  %t89 = load i32, ptr %a1
  %t90 = mul i32 %t89, 3
  %t91 = getelementptr double, ptr %px, i32 %t90
  %t92 = load double, ptr %t91
  %t93 = getelementptr double, ptr %vx, i32 %t90
  %t94 = load double, ptr %t93
  %t95 = fmul double %t94, %dt
  %t96 = fadd double %t92, %t95
  %t97 = getelementptr double, ptr %px, i32 %t90
  store double %t96, ptr %t97
  %t98 = add i32 %t90, 1
  %t99 = getelementptr double, ptr %px, i32 %t98
  %t100 = load double, ptr %t99
  %t101 = add i32 %t90, 1
  %t102 = getelementptr double, ptr %vx, i32 %t101
  %t103 = load double, ptr %t102
  %t104 = fmul double %t103, %dt
  %t105 = fadd double %t100, %t104
  %t106 = add i32 %t90, 1
  %t107 = getelementptr double, ptr %px, i32 %t106
  store double %t105, ptr %t107
  %t108 = add i32 %t90, 2
  %t109 = getelementptr double, ptr %px, i32 %t108
  %t110 = load double, ptr %t109
  %t111 = add i32 %t90, 2
  %t112 = getelementptr double, ptr %vx, i32 %t111
  %t113 = load double, ptr %t112
  %t114 = fmul double %t113, %dt
  %t115 = fadd double %t110, %t114
  %t116 = add i32 %t90, 2
  %t117 = getelementptr double, ptr %px, i32 %t116
  store double %t115, ptr %t117
  %t118 = load i32, ptr %a1
  %t119 = add i32 %t118, 1
  store i32 %t119, ptr %a1
  br label %lc9
le11:
  ret void
}

define void @draw(ptr %px, ptr %vx, double %yaw, double %pitch, double %dist) {
entry:
  %a1 = alloca i32
  call void @glClearColor(float 0x3F947AE140000000, float 0x3F9EB851E0000000, float 0x3FA99999A0000000, float 0x3FF0000000000000)
  call void @glClear(i32 16640)
  call void @glMatrixMode(i32 5889)
  call void @glLoadIdentity()
  call void @gluPerspective(double 0x4049000000000000, double 0x3FF5555555555555, double 0x3FB999999999999A, double 0x4072C00000000000)
  call void @glMatrixMode(i32 5888)
  call void @glLoadIdentity()
  %t1 = fsub double 0x0000000000000000, %dist
  %t2 = fptrunc double %t1 to float
  call void @glTranslatef(float 0x0000000000000000, float 0x0000000000000000, float %t2)
  %t3 = fptrunc double %pitch to float
  call void @glRotatef(float %t3, float 0x3FF0000000000000, float 0x0000000000000000, float 0x0000000000000000)
  %t4 = fptrunc double %yaw to float
  call void @glRotatef(float %t4, float 0x0000000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  call void @glEnable(i32 2929)
  call void @glPointSize(float 0x4008000000000000)
  call void @glBegin(i32 0)
  store i32 0, ptr %a1
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t5 = load i32, ptr %a1
  %t6 = icmp slt i32 %t5, 300
  br i1 %t6, label %lb2, label %le3
lb2:
  %t7 = load i32, ptr %a1
  %t8 = mul i32 %t7, 3
  %t9 = getelementptr double, ptr %vx, i32 %t8
  %t10 = load double, ptr %t9
  %t11 = getelementptr double, ptr %vx, i32 %t8
  %t12 = load double, ptr %t11
  %t13 = fmul double %t10, %t12
  %t14 = add i32 %t8, 1
  %t15 = getelementptr double, ptr %vx, i32 %t14
  %t16 = load double, ptr %t15
  %t17 = add i32 %t8, 1
  %t18 = getelementptr double, ptr %vx, i32 %t17
  %t19 = load double, ptr %t18
  %t20 = fmul double %t16, %t19
  %t21 = fadd double %t13, %t20
  %t22 = add i32 %t8, 2
  %t23 = getelementptr double, ptr %vx, i32 %t22
  %t24 = load double, ptr %t23
  %t25 = add i32 %t8, 2
  %t26 = getelementptr double, ptr %vx, i32 %t25
  %t27 = load double, ptr %t26
  %t28 = fmul double %t24, %t27
  %t29 = fadd double %t21, %t28
  %t30 = call double @sqrt(double %t29)
  %t31 = fdiv double %t30, 0x4010000000000000
  %t32 = fcmp ogt double %t31, 0x3FF0000000000000
  %t33 = select i1 %t32, double 0x3FF0000000000000, double %t31
  %t34 = fmul double 0x3FE199999999999A, %t33
  %t35 = fadd double 0x3FDCCCCCCCCCCCCD, %t34
  %t36 = fptrunc double %t35 to float
  %t37 = fmul double 0x3FD0000000000000, %t33
  %t38 = fadd double 0x3FE4CCCCCCCCCCCD, %t37
  %t39 = fptrunc double %t38 to float
  %t40 = fmul double 0x3FE3333333333333, %t33
  %t41 = fsub double 0x3FF0000000000000, %t40
  %t42 = fptrunc double %t41 to float
  call void @glColor3f(float %t36, float %t39, float %t42)
  %t43 = getelementptr double, ptr %px, i32 %t8
  %t44 = load double, ptr %t43
  %t45 = fptrunc double %t44 to float
  %t46 = add i32 %t8, 1
  %t47 = getelementptr double, ptr %px, i32 %t46
  %t48 = load double, ptr %t47
  %t49 = fptrunc double %t48 to float
  %t50 = add i32 %t8, 2
  %t51 = getelementptr double, ptr %px, i32 %t50
  %t52 = load double, ptr %t51
  %t53 = fptrunc double %t52 to float
  call void @glVertex3f(float %t45, float %t49, float %t53)
  %t54 = load i32, ptr %a1
  %t55 = add i32 %t54, 1
  store i32 %t55, ptr %a1
  br label %lc1
le3:
  call void @glEnd()
  ret void
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %a1 = alloca [900 x double]
  %a2 = alloca [900 x double]
  %a3 = alloca [300 x double]
  %a4 = alloca i32
  %a5 = alloca [56 x i8]
  %a6 = alloca i32
  %a7 = alloca i32
  %a8 = alloca i32
  %a9 = alloca i32
  %a10 = alloca i32
  %a11 = alloca double
  %a12 = alloca double
  %a13 = alloca double
  %a14 = alloca double
  %a15 = alloca i32
  store i32 12345, ptr %a4
  store i32 1, ptr %a6
  store i32 0, ptr %a7
  store i32 0, ptr %a8
  store i32 0, ptr %a9
  store i32 0, ptr %a10
  store double 0x4034000000000000, ptr %a11
  store double 0x4039000000000000, ptr %a12
  store double 0x403A000000000000, ptr %a13
  %t1 = icmp sgt i32 %argc, 1
  br i1 %t1, label %then1, label %endif2
then1:
  %t2 = getelementptr None, ptr %argv, i32 1
  %t3 = getelementptr i8, ptr %argv, i32 4
  %t4 = load ptr, ptr %t3
  %t5 = call i32 @atoi(ptr %t4)
  store i32 %t5, ptr %a8
  br label %endif2
endif2:
  %t6 = call i32 @SDL_Init(i32 32)
  %t7 = call ptr @SDL_CreateWindow(ptr @.s1, i32 805240832, i32 805240832, i32 640, i32 480, i32 2)
  %t8 = call ptr @SDL_GL_CreateContext(ptr %t7)
  %t9 = icmp eq ptr %t8, null
  br i1 %t9, label %then3, label %endif4
then3:
  call void @SDL_Quit()
  ret i32 1
endif4:
  call void @init(ptr %a1, ptr %a2, ptr %a3, ptr %a4)
  br label %wc5
wc5:
  %t10 = load i32, ptr %a6
  %t11 = icmp ne i32 %t10, 0
  br i1 %t11, label %wb6, label %we7
wb6:
  br label %wc8
wc8:
  %t12 = call i32 @SDL_PollEvent(ptr %a5)
  %t13 = icmp ne i32 %t12, 0
  br i1 %t13, label %wb9, label %we10
wb9:
  %t14 = load i32, ptr %a5
  %t15 = icmp eq i32 %t14, 256
  br i1 %t15, label %then11, label %endif12
then11:
  store i32 0, ptr %a6
  br label %endif12
endif12:
  %t16 = icmp eq i32 %t14, 768
  br i1 %t16, label %then13, label %endif14
then13:
  %t17 = getelementptr i8, ptr %a5, i32 16
  %t18 = load i32, ptr %t17
  %t19 = icmp eq i32 %t18, 41
  br i1 %t19, label %then15, label %endif16
then15:
  store i32 0, ptr %a6
  br label %endif16
endif16:
  %t20 = icmp eq i32 %t18, 44
  br i1 %t20, label %then17, label %endif18
then17:
  %t21 = load i32, ptr %a10
  %t22 = sub i32 1, %t21
  store i32 %t22, ptr %a10
  br label %endif18
endif18:
  %t23 = icmp eq i32 %t18, 21
  br i1 %t23, label %then19, label %endif20
then19:
  call void @init(ptr %a1, ptr %a2, ptr %a3, ptr %a4)
  br label %endif20
endif20:
  br label %endif14
endif14:
  %t24 = icmp eq i32 %t14, 1025
  br i1 %t24, label %then21, label %endif22
then21:
  store i32 1, ptr %a9
  br label %endif22
endif22:
  %t25 = icmp eq i32 %t14, 1026
  br i1 %t25, label %then23, label %endif24
then23:
  store i32 0, ptr %a9
  br label %endif24
endif24:
  %t26 = icmp eq i32 %t14, 1024
  %t27 = load i32, ptr %a9
  %t28 = icmp ne i32 %t27, 0
  %t29 = and i1 %t26, %t28
  br i1 %t29, label %then25, label %endif26
then25:
  %t30 = getelementptr i8, ptr %a5, i32 28
  %t31 = load i32, ptr %t30
  %t32 = sitofp i32 %t31 to double
  %t33 = fmul double %t32, 0x3FD999999999999A
  %t34 = load double, ptr %a11
  %t35 = fadd double %t34, %t33
  %t36 = fsub double %t34, %t33
  %t37 = fmul double %t34, %t33
  %t38 = fdiv double %t34, %t33
  store double %t35, ptr %a11
  %t39 = getelementptr i8, ptr %a5, i32 32
  %t40 = load i32, ptr %t39
  %t41 = sitofp i32 %t40 to double
  %t42 = fmul double %t41, 0x3FD999999999999A
  %t43 = load double, ptr %a12
  %t44 = fadd double %t43, %t42
  %t45 = fsub double %t43, %t42
  %t46 = fmul double %t43, %t42
  %t47 = fdiv double %t43, %t42
  store double %t44, ptr %a12
  br label %endif26
endif26:
  %t48 = icmp eq i32 %t14, 1027
  br i1 %t48, label %then27, label %endif28
then27:
  %t49 = getelementptr i8, ptr %a5, i32 20
  %t50 = load i32, ptr %t49
  %t51 = sitofp i32 %t50 to double
  %t52 = fsub double 0x0000000000000000, %t51
  %t53 = fmul double %t52, 0x3FF8000000000000
  %t54 = load double, ptr %a13
  %t55 = fadd double %t54, %t53
  %t56 = fsub double %t54, %t53
  %t57 = fmul double %t54, %t53
  %t58 = fdiv double %t54, %t53
  store double %t55, ptr %a13
  %t59 = load double, ptr %a13
  %t60 = fcmp olt double %t59, 0x4010000000000000
  br i1 %t60, label %then29, label %endif30
then29:
  store double 0x4010000000000000, ptr %a13
  br label %endif30
endif30:
  br label %endif28
endif28:
  br label %wc8
we10:
  %t61 = load i32, ptr %a10
  %t62 = icmp eq i32 %t61, 0
  br i1 %t62, label %then31, label %endif32
then31:
  call void @step(ptr %a1, ptr %a2, ptr %a3, double 0x3F847AE147AE147B)
  call void @step(ptr %a1, ptr %a2, ptr %a3, double 0x3F847AE147AE147B)
  br label %endif32
endif32:
  %t63 = load double, ptr %a11
  %t64 = load double, ptr %a12
  %t65 = load double, ptr %a13
  call void @draw(ptr %a1, ptr %a2, double %t63, double %t64, double %t65)
  call void @SDL_GL_SwapWindow(ptr %t7)
  call void @SDL_Delay(i32 16)
  %t66 = load i32, ptr %a7
  %t67 = add i32 %t66, 1
  %t68 = sub i32 %t66, 1
  %t69 = mul i32 %t66, 1
  %t70 = sdiv i32 %t66, 1
  store i32 %t67, ptr %a7
  %t71 = load i32, ptr %a8
  %t72 = icmp sgt i32 %t71, 0
  %t73 = load i32, ptr %a7
  %t74 = load i32, ptr %a8
  %t75 = icmp sge i32 %t73, %t74
  %t76 = and i1 %t72, %t75
  br i1 %t76, label %then33, label %endif34
then33:
  store i32 0, ptr %a6
  br label %endif34
endif34:
  br label %wc5
we7:
  store double 0x0000000000000000, ptr %a14
  store i32 0, ptr %a15
  store i32 0, ptr %a15
  br label %lc35
lc35:
  %t77 = load i32, ptr %a15
  %t78 = icmp slt i32 %t77, 900
  br i1 %t78, label %lb36, label %le37
lb36:
  %t79 = load i32, ptr %a15
  %t80 = getelementptr double, ptr %a2, i32 %t79
  %t81 = load double, ptr %t80
  %t82 = fmul double 0x3FE0000000000000, %t81
  %t83 = load i32, ptr %a15
  %t84 = getelementptr double, ptr %a2, i32 %t83
  %t85 = load double, ptr %t84
  %t86 = fmul double %t82, %t85
  %t87 = load double, ptr %a14
  %t88 = fadd double %t87, %t86
  %t89 = fsub double %t87, %t86
  %t90 = fmul double %t87, %t86
  %t91 = fdiv double %t87, %t86
  store double %t88, ptr %a14
  %t92 = load i32, ptr %a15
  %t93 = add i32 %t92, 1
  store i32 %t93, ptr %a15
  br label %lc35
le37:
  %t94 = load i32, ptr %a7
  %t95 = load double, ptr %a14
  %t96 = call i32 (ptr, ...) @printf(ptr @.s2, i32 %t94, double %t95)
  call void @SDL_GL_DeleteContext(ptr %t8)
  call void @SDL_DestroyWindow(ptr %t7)
  call void @SDL_Quit()
  ret i32 0
}

