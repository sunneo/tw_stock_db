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
declare double @sqrt(double)
declare i32 @atoi(ptr)
declare i32 @printf(ptr, ...)

@.s1 = private constant [22 x i8] c"IR fluid3d (SPH, CPU)\00"
@.s2 = private constant [23 x i8] c"frames=%d y_mean=%.3f\0A\00"

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
  %t2 = icmp slt i32 %t1, 9
  br i1 %t2, label %lb2, label %le3
lb2:
  store i32 0, ptr %a3
  br label %lc4
lc4:
  %t3 = load i32, ptr %a3
  %t4 = icmp slt i32 %t3, 18
  br i1 %t4, label %lb5, label %le6
lb5:
  store i32 0, ptr %a4
  br label %lc7
lc7:
  %t5 = load i32, ptr %a4
  %t6 = icmp slt i32 %t5, 9
  br i1 %t6, label %lb8, label %le9
lb8:
  %t7 = load i32, ptr %a1
  %t8 = icmp slt i32 %t7, 500
  br i1 %t8, label %then10, label %endif11
then10:
  %t9 = load i32, ptr %a1
  %t10 = mul i32 %t9, 3
  %t11 = load i32, ptr %a2
  %t12 = sitofp i32 %t11 to double
  %t13 = fadd double %t12, 0x3FE0000000000000
  %t14 = fmul double %t13, 0x3FB1EB851EB851EC
  %t15 = fadd double %t14, 0x3FA999999999999A
  %t16 = getelementptr double, ptr %pos, i32 %t10
  store double %t15, ptr %t16
  %t17 = load i32, ptr %a3
  %t18 = sitofp i32 %t17 to double
  %t19 = fadd double %t18, 0x3FE0000000000000
  %t20 = fmul double %t19, 0x3FB1EB851EB851EC
  %t21 = fadd double %t20, 0x3FA999999999999A
  %t22 = add i32 %t10, 1
  %t23 = getelementptr double, ptr %pos, i32 %t22
  store double %t21, ptr %t23
  %t24 = load i32, ptr %a4
  %t25 = sitofp i32 %t24 to double
  %t26 = fadd double %t25, 0x3FE0000000000000
  %t27 = fmul double %t26, 0x3FB1EB851EB851EC
  %t28 = fadd double %t27, 0x3FA999999999999A
  %t29 = add i32 %t10, 2
  %t30 = getelementptr double, ptr %pos, i32 %t29
  store double %t28, ptr %t30
  %t31 = getelementptr double, ptr %vel, i32 %t10
  store double 0x0000000000000000, ptr %t31
  %t32 = add i32 %t10, 1
  %t33 = getelementptr double, ptr %vel, i32 %t32
  store double 0x0000000000000000, ptr %t33
  %t34 = add i32 %t10, 2
  %t35 = getelementptr double, ptr %vel, i32 %t34
  store double 0x0000000000000000, ptr %t35
  %t36 = load i32, ptr %a1
  %t37 = add i32 %t36, 1
  store i32 %t37, ptr %a1
  br label %endif11
endif11:
  %t38 = load i32, ptr %a4
  %t39 = add i32 %t38, 1
  store i32 %t39, ptr %a4
  br label %lc7
le9:
  %t40 = load i32, ptr %a3
  %t41 = add i32 %t40, 1
  store i32 %t41, ptr %a3
  br label %lc4
le6:
  %t42 = load i32, ptr %a2
  %t43 = add i32 %t42, 1
  store i32 %t43, ptr %a2
  br label %lc1
le3:
  ret void
}

define void @step(ptr %pos, ptr %vel, ptr %rho, ptr %prs, double %rest) {
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
  %t2 = icmp slt i32 %t1, 500
  br i1 %t2, label %lb2, label %le3
lb2:
  store double 0x0000000000000000, ptr %a4
  %t3 = load i32, ptr %a1
  %t4 = mul i32 %t3, 3
  store i32 0, ptr %a2
  br label %lc4
lc4:
  %t5 = load i32, ptr %a2
  %t6 = icmp slt i32 %t5, 500
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
  %t33 = fsub double 0x3F8D7DBF487FCB92, %t32
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
  %t42 = fmul double %t41, 0x41572A56D33AF5E7
  %t43 = load i32, ptr %a1
  %t44 = getelementptr double, ptr %rho, i32 %t43
  store double %t42, ptr %t44
  %t45 = load i32, ptr %a1
  %t46 = getelementptr double, ptr %rho, i32 %t45
  %t47 = load double, ptr %t46
  %t48 = fsub double %t47, %rest
  %t49 = fmul double %t48, 0x4044000000000000
  %t50 = load i32, ptr %a1
  %t51 = getelementptr double, ptr %prs, i32 %t50
  store double %t49, ptr %t51
  %t52 = load i32, ptr %a1
  %t53 = add i32 %t52, 1
  store i32 %t53, ptr %a1
  br label %lc1
le3:
  store double 0x0000000000000000, ptr %a5
  store double 0x0000000000000000, ptr %a6
  store double 0x0000000000000000, ptr %a7
  store i32 0, ptr %a1
  br label %lc9
lc9:
  %t54 = load i32, ptr %a1
  %t55 = icmp slt i32 %t54, 500
  br i1 %t55, label %lb10, label %le11
lb10:
  store double 0x0000000000000000, ptr %a5
  store double 0x0000000000000000, ptr %a6
  store double 0x0000000000000000, ptr %a7
  %t56 = load i32, ptr %a1
  %t57 = mul i32 %t56, 3
  store i32 0, ptr %a2
  br label %lc12
lc12:
  %t58 = load i32, ptr %a2
  %t59 = icmp slt i32 %t58, 500
  br i1 %t59, label %lb13, label %le14
lb13:
  %t60 = load i32, ptr %a1
  %t61 = load i32, ptr %a2
  %t62 = icmp ne i32 %t60, %t61
  br i1 %t62, label %then15, label %endif16
then15:
  %t63 = load i32, ptr %a2
  %t64 = mul i32 %t63, 3
  %t65 = getelementptr double, ptr %pos, i32 %t57
  %t66 = load double, ptr %t65
  %t67 = getelementptr double, ptr %pos, i32 %t64
  %t68 = load double, ptr %t67
  %t69 = fsub double %t66, %t68
  %t70 = add i32 %t57, 1
  %t71 = getelementptr double, ptr %pos, i32 %t70
  %t72 = load double, ptr %t71
  %t73 = add i32 %t64, 1
  %t74 = getelementptr double, ptr %pos, i32 %t73
  %t75 = load double, ptr %t74
  %t76 = fsub double %t72, %t75
  %t77 = add i32 %t57, 2
  %t78 = getelementptr double, ptr %pos, i32 %t77
  %t79 = load double, ptr %t78
  %t80 = add i32 %t64, 2
  %t81 = getelementptr double, ptr %pos, i32 %t80
  %t82 = load double, ptr %t81
  %t83 = fsub double %t79, %t82
  %t84 = fmul double %t69, %t69
  %t85 = fmul double %t76, %t76
  %t86 = fadd double %t84, %t85
  %t87 = fmul double %t83, %t83
  %t88 = fadd double %t86, %t87
  %t89 = fcmp olt double %t88, 0x3F8D7DBF487FCB92
  br i1 %t89, label %then17, label %endif18
then17:
  %t90 = call double @sqrt(double %t88)
  %t91 = fadd double %t90, 0x3E112E0BE826D695
  %t92 = fsub double 0x3FBEB851EB851EB8, %t91
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
  %t108 = fmul double %t107, 0x40F76C534020CD92
  %t109 = fmul double %t69, %t108
  %t110 = load double, ptr %a5
  %t111 = fadd double %t110, %t109
  store double %t111, ptr %a5
  %t112 = fmul double %t76, %t108
  %t113 = load double, ptr %a6
  %t114 = fadd double %t113, %t112
  store double %t114, ptr %a6
  %t115 = fmul double %t83, %t108
  %t116 = load double, ptr %a7
  %t117 = fadd double %t116, %t115
  store double %t117, ptr %a7
  %t118 = load i32, ptr %a2
  %t119 = getelementptr double, ptr %rho, i32 %t118
  %t120 = load double, ptr %t119
  %t121 = fdiv double %t92, %t120
  %t122 = fmul double %t121, 0x40EC1B9719C0F6AF
  %t123 = getelementptr double, ptr %vel, i32 %t64
  %t124 = load double, ptr %t123
  %t125 = getelementptr double, ptr %vel, i32 %t57
  %t126 = load double, ptr %t125
  %t127 = fsub double %t124, %t126
  %t128 = fmul double %t127, %t122
  %t129 = load double, ptr %a5
  %t130 = fadd double %t129, %t128
  store double %t130, ptr %a5
  %t131 = add i32 %t64, 1
  %t132 = getelementptr double, ptr %vel, i32 %t131
  %t133 = load double, ptr %t132
  %t134 = add i32 %t57, 1
  %t135 = getelementptr double, ptr %vel, i32 %t134
  %t136 = load double, ptr %t135
  %t137 = fsub double %t133, %t136
  %t138 = fmul double %t137, %t122
  %t139 = load double, ptr %a6
  %t140 = fadd double %t139, %t138
  store double %t140, ptr %a6
  %t141 = add i32 %t64, 2
  %t142 = getelementptr double, ptr %vel, i32 %t141
  %t143 = load double, ptr %t142
  %t144 = add i32 %t57, 2
  %t145 = getelementptr double, ptr %vel, i32 %t144
  %t146 = load double, ptr %t145
  %t147 = fsub double %t143, %t146
  %t148 = fmul double %t147, %t122
  %t149 = load double, ptr %a7
  %t150 = fadd double %t149, %t148
  store double %t150, ptr %a7
  br label %endif18
endif18:
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
  %t157 = getelementptr double, ptr %vel, i32 %t57
  %t158 = load double, ptr %t157
  %t159 = load double, ptr %a5
  %t160 = fmul double %t159, %t156
  %t161 = fmul double %t160, 0x3F70624DD2F1A9FC
  %t162 = fadd double %t158, %t161
  %t163 = getelementptr double, ptr %vel, i32 %t57
  store double %t162, ptr %t163
  %t164 = add i32 %t57, 1
  %t165 = getelementptr double, ptr %vel, i32 %t164
  %t166 = load double, ptr %t165
  %t167 = load double, ptr %a6
  %t168 = fmul double %t167, %t156
  %t169 = fadd double %t168, 0xC02399999999999A
  %t170 = fmul double %t169, 0x3F70624DD2F1A9FC
  %t171 = fadd double %t166, %t170
  %t172 = add i32 %t57, 1
  %t173 = getelementptr double, ptr %vel, i32 %t172
  store double %t171, ptr %t173
  %t174 = add i32 %t57, 2
  %t175 = getelementptr double, ptr %vel, i32 %t174
  %t176 = load double, ptr %t175
  %t177 = load double, ptr %a7
  %t178 = fmul double %t177, %t156
  %t179 = fmul double %t178, 0x3F70624DD2F1A9FC
  %t180 = fadd double %t176, %t179
  %t181 = add i32 %t57, 2
  %t182 = getelementptr double, ptr %vel, i32 %t181
  store double %t180, ptr %t182
  %t183 = load i32, ptr %a1
  %t184 = add i32 %t183, 1
  store i32 %t184, ptr %a1
  br label %lc9
le11:
  store i32 0, ptr %a1
  br label %lc19
lc19:
  %t185 = load i32, ptr %a1
  %t186 = icmp slt i32 %t185, 500
  br i1 %t186, label %lb20, label %le21
lb20:
  store i32 0, ptr %a3
  br label %lc22
lc22:
  %t187 = load i32, ptr %a3
  %t188 = icmp slt i32 %t187, 3
  br i1 %t188, label %lb23, label %le24
lb23:
  %t189 = load i32, ptr %a1
  %t190 = mul i32 %t189, 3
  %t191 = load i32, ptr %a3
  %t192 = add i32 %t190, %t191
  %t193 = getelementptr double, ptr %pos, i32 %t192
  %t194 = load double, ptr %t193
  %t195 = getelementptr double, ptr %vel, i32 %t192
  %t196 = load double, ptr %t195
  %t197 = fmul double %t196, 0x3F70624DD2F1A9FC
  %t198 = fadd double %t194, %t197
  %t199 = getelementptr double, ptr %pos, i32 %t192
  store double %t198, ptr %t199
  %t200 = getelementptr double, ptr %pos, i32 %t192
  %t201 = load double, ptr %t200
  %t202 = fcmp olt double %t201, 0x0000000000000000
  br i1 %t202, label %then25, label %endif26
then25:
  %t203 = getelementptr double, ptr %pos, i32 %t192
  store double 0x0000000000000000, ptr %t203
  %t204 = getelementptr double, ptr %vel, i32 %t192
  %t205 = load double, ptr %t204
  %t206 = fmul double %t205, 0xBFD3333333333333
  %t207 = getelementptr double, ptr %vel, i32 %t192
  store double %t206, ptr %t207
  br label %endif26
endif26:
  %t208 = getelementptr double, ptr %pos, i32 %t192
  %t209 = load double, ptr %t208
  %t210 = fcmp ogt double %t209, 0x3FF0000000000000
  br i1 %t210, label %then27, label %endif28
then27:
  %t211 = getelementptr double, ptr %pos, i32 %t192
  store double 0x3FF0000000000000, ptr %t211
  %t212 = getelementptr double, ptr %vel, i32 %t192
  %t213 = load double, ptr %t212
  %t214 = fmul double %t213, 0xBFD3333333333333
  %t215 = getelementptr double, ptr %vel, i32 %t192
  store double %t214, ptr %t215
  br label %endif28
endif28:
  %t216 = load i32, ptr %a3
  %t217 = add i32 %t216, 1
  store i32 %t217, ptr %a3
  br label %lc22
le24:
  %t218 = load i32, ptr %a1
  %t219 = add i32 %t218, 1
  store i32 %t219, ptr %a1
  br label %lc19
le21:
  ret void
}

define double @rest_density(ptr %pos, ptr %rho) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  %a3 = alloca double
  %a4 = alloca double
  store i32 0, ptr %a1
  store i32 0, ptr %a2
  store double 0x0000000000000000, ptr %a3
  store double 0x0000000000000000, ptr %a4
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t1 = load i32, ptr %a1
  %t2 = icmp slt i32 %t1, 500
  br i1 %t2, label %lb2, label %le3
lb2:
  store double 0x0000000000000000, ptr %a3
  %t3 = load i32, ptr %a1
  %t4 = mul i32 %t3, 3
  store i32 0, ptr %a2
  br label %lc4
lc4:
  %t5 = load i32, ptr %a2
  %t6 = icmp slt i32 %t5, 500
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
  %t33 = fsub double 0x3F8D7DBF487FCB92, %t32
  %t34 = fcmp ogt double %t33, 0x0000000000000000
  br i1 %t34, label %then7, label %endif8
then7:
  %t35 = fmul double %t33, %t33
  %t36 = fmul double %t35, %t33
  %t37 = load double, ptr %a3
  %t38 = fadd double %t37, %t36
  store double %t38, ptr %a3
  br label %endif8
endif8:
  %t39 = load i32, ptr %a2
  %t40 = add i32 %t39, 1
  store i32 %t40, ptr %a2
  br label %lc4
le6:
  %t41 = load double, ptr %a3
  %t42 = fmul double %t41, 0x41572A56D33AF5E7
  %t43 = load double, ptr %a4
  %t44 = fadd double %t43, %t42
  store double %t44, ptr %a4
  %t45 = load i32, ptr %a1
  %t46 = add i32 %t45, 1
  store i32 %t46, ptr %a1
  br label %lc1
le3:
  %t47 = load double, ptr %a4
  %t48 = fdiv double %t47, 0x407F400000000000
  %t49 = fmul double %t48, 0x3FECCCCCCCCCCCCD
  ret double %t49
}

define void @draw(ptr %pos, ptr %rho, double %yaw, double %pitch, double %dist, double %rest) {
entry:
  %a1 = alloca i32
  call void @glClearColor(float 0x3F9EB851E0000000, float 0x3FA47AE140000000, float 0x3FB1EB8520000000, float 0x3FF0000000000000)
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
  call void @glColor3f(float 0x3FD6666660000000, float 0x3FD99999A0000000, float 0x3FE19999A0000000)
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
  call void @glPointSize(float 0x401C000000000000)
  call void @glBegin(i32 0)
  store i32 0, ptr %a1
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t5 = load i32, ptr %a1
  %t6 = icmp slt i32 %t5, 500
  br i1 %t6, label %lb2, label %le3
lb2:
  %t7 = load i32, ptr %a1
  %t8 = mul i32 %t7, 3
  %t9 = load i32, ptr %a1
  %t10 = getelementptr double, ptr %rho, i32 %t9
  %t11 = load double, ptr %t10
  %t12 = fmul double %rest, 0x3FF4CCCCCCCCCCCD
  %t13 = fdiv double %t11, %t12
  %t14 = fcmp ogt double %t13, 0x3FF0000000000000
  %t15 = select i1 %t14, double 0x3FF0000000000000, double %t13
  %t16 = fmul double 0x3FE0000000000000, %t15
  %t17 = fadd double 0x3FD0000000000000, %t16
  %t18 = fptrunc double %t17 to float
  %t19 = fmul double 0x3FD6666666666666, %t15
  %t20 = fadd double 0x3FE199999999999A, %t19
  %t21 = fptrunc double %t20 to float
  call void @glColor3f(float %t18, float %t21, float 0x3FF0000000000000)
  %t22 = getelementptr double, ptr %pos, i32 %t8
  %t23 = load double, ptr %t22
  %t24 = fptrunc double %t23 to float
  %t25 = add i32 %t8, 1
  %t26 = getelementptr double, ptr %pos, i32 %t25
  %t27 = load double, ptr %t26
  %t28 = fptrunc double %t27 to float
  %t29 = add i32 %t8, 2
  %t30 = getelementptr double, ptr %pos, i32 %t29
  %t31 = load double, ptr %t30
  %t32 = fptrunc double %t31 to float
  call void @glVertex3f(float %t24, float %t28, float %t32)
  %t33 = load i32, ptr %a1
  %t34 = add i32 %t33, 1
  store i32 %t34, ptr %a1
  br label %lc1
le3:
  call void @glEnd()
  ret void
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %a1 = alloca [1500 x double]
  %a2 = alloca [1500 x double]
  %a3 = alloca [500 x double]
  %a4 = alloca [500 x double]
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
  %a16 = alloca double
  store i32 1, ptr %a6
  store i32 0, ptr %a7
  store i32 0, ptr %a8
  store i32 0, ptr %a9
  store i32 0, ptr %a10
  store double 0x4039000000000000, ptr %a11
  store double 0x4034000000000000, ptr %a12
  store double 0x4004CCCCCCCCCCCD, ptr %a13
  store double 0x0000000000000000, ptr %a14
  %t1 = icmp sgt i32 %argc, 1
  br i1 %t1, label %then1, label %endif2
then1:
  %t2 = getelementptr ptr, ptr %argv, i32 1
  %t3 = load ptr, ptr %t2
  %t4 = call i32 @atoi(ptr %t3)
  store i32 %t4, ptr %a8
  br label %endif2
endif2:
  %t5 = call i32 @SDL_Init(i32 32)
  %t6 = call ptr @SDL_CreateWindow(ptr @.s1, i32 805240832, i32 805240832, i32 640, i32 480, i32 2)
  %t7 = call ptr @SDL_GL_CreateContext(ptr %t6)
  %t8 = icmp eq ptr %t7, null
  br i1 %t8, label %then3, label %endif4
then3:
  call void @SDL_Quit()
  ret i32 1
endif4:
  call void @init(ptr %a1, ptr %a2)
  %t9 = call double @rest_density(ptr %a1, ptr %a3)
  store double %t9, ptr %a14
  store i32 0, ptr %a15
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
  store i32 1, ptr %a10
  br label %endif18
endif18:
  %t21 = icmp eq i32 %t18, 21
  br i1 %t21, label %then19, label %endif20
then19:
  call void @init(ptr %a1, ptr %a2)
  br label %endif20
endif20:
  br label %endif14
endif14:
  %t22 = icmp eq i32 %t14, 1025
  br i1 %t22, label %then21, label %endif22
then21:
  store i32 1, ptr %a9
  br label %endif22
endif22:
  %t23 = icmp eq i32 %t14, 1026
  br i1 %t23, label %then23, label %endif24
then23:
  store i32 0, ptr %a9
  br label %endif24
endif24:
  %t24 = icmp eq i32 %t14, 1024
  %t25 = load i32, ptr %a9
  %t26 = icmp ne i32 %t25, 0
  %t27 = and i1 %t24, %t26
  br i1 %t27, label %then25, label %endif26
then25:
  %t28 = getelementptr i8, ptr %a5, i32 28
  %t29 = load i32, ptr %t28
  %t30 = sitofp i32 %t29 to double
  %t31 = fmul double %t30, 0x3FD999999999999A
  %t32 = load double, ptr %a11
  %t33 = fadd double %t32, %t31
  store double %t33, ptr %a11
  %t34 = getelementptr i8, ptr %a5, i32 32
  %t35 = load i32, ptr %t34
  %t36 = sitofp i32 %t35 to double
  %t37 = fmul double %t36, 0x3FD999999999999A
  %t38 = load double, ptr %a12
  %t39 = fadd double %t38, %t37
  store double %t39, ptr %a12
  br label %endif26
endif26:
  %t40 = icmp eq i32 %t14, 1027
  br i1 %t40, label %then27, label %endif28
then27:
  %t41 = getelementptr i8, ptr %a5, i32 20
  %t42 = load i32, ptr %t41
  %t43 = sitofp i32 %t42 to double
  %t44 = fsub double 0x0000000000000000, %t43
  %t45 = fmul double %t44, 0x3FC3333333333333
  %t46 = load double, ptr %a13
  %t47 = fadd double %t46, %t45
  store double %t47, ptr %a13
  %t48 = load double, ptr %a13
  %t49 = fcmp olt double %t48, 0x3FF3333333333333
  br i1 %t49, label %then29, label %endif30
then29:
  store double 0x3FF3333333333333, ptr %a13
  br label %endif30
endif30:
  br label %endif28
endif28:
  br label %wc8
we10:
  %t50 = load i32, ptr %a10
  %t51 = icmp ne i32 %t50, 0
  br i1 %t51, label %then31, label %endif32
then31:
  store i32 0, ptr %a15
  br label %lc33
lc33:
  %t52 = load i32, ptr %a15
  %t53 = icmp slt i32 %t52, 500
  br i1 %t53, label %lb34, label %le35
lb34:
  %t54 = load i32, ptr %a15
  %t55 = mul i32 %t54, 3
  %t56 = getelementptr double, ptr %a2, i32 %t55
  %t57 = load double, ptr %t56
  %t58 = fadd double %t57, 0x4004000000000000
  %t59 = load i32, ptr %a15
  %t60 = mul i32 %t59, 3
  %t61 = getelementptr double, ptr %a2, i32 %t60
  store double %t58, ptr %t61
  %t62 = load i32, ptr %a15
  %t63 = add i32 %t62, 1
  store i32 %t63, ptr %a15
  br label %lc33
le35:
  store i32 0, ptr %a10
  br label %endif32
endif32:
  %t64 = load double, ptr %a14
  call void @step(ptr %a1, ptr %a2, ptr %a3, ptr %a4, double %t64)
  %t65 = load double, ptr %a14
  call void @step(ptr %a1, ptr %a2, ptr %a3, ptr %a4, double %t65)
  %t66 = load double, ptr %a11
  %t67 = load double, ptr %a12
  %t68 = load double, ptr %a13
  %t69 = load double, ptr %a14
  call void @draw(ptr %a1, ptr %a3, double %t66, double %t67, double %t68, double %t69)
  call void @SDL_GL_SwapWindow(ptr %t6)
  call void @SDL_Delay(i32 16)
  %t70 = load i32, ptr %a7
  %t71 = add i32 %t70, 1
  store i32 %t71, ptr %a7
  %t72 = load i32, ptr %a8
  %t73 = icmp sgt i32 %t72, 0
  %t74 = load i32, ptr %a7
  %t75 = load i32, ptr %a8
  %t76 = icmp sge i32 %t74, %t75
  %t77 = and i1 %t73, %t76
  br i1 %t77, label %then36, label %endif37
then36:
  store i32 0, ptr %a6
  br label %endif37
endif37:
  br label %wc5
we7:
  store double 0x0000000000000000, ptr %a16
  store i32 0, ptr %a15
  br label %lc38
lc38:
  %t78 = load i32, ptr %a15
  %t79 = icmp slt i32 %t78, 500
  br i1 %t79, label %lb39, label %le40
lb39:
  %t80 = load i32, ptr %a15
  %t81 = mul i32 %t80, 3
  %t82 = add i32 %t81, 1
  %t83 = getelementptr double, ptr %a1, i32 %t82
  %t84 = load double, ptr %t83
  %t85 = load double, ptr %a16
  %t86 = fadd double %t85, %t84
  store double %t86, ptr %a16
  %t87 = load i32, ptr %a15
  %t88 = add i32 %t87, 1
  store i32 %t88, ptr %a15
  br label %lc38
le40:
  %t89 = load i32, ptr %a7
  %t90 = load double, ptr %a16
  %t91 = fdiv double %t90, 0x407F400000000000
  %t92 = call i32 (ptr, ...) @printf(ptr @.s2, i32 %t89, double %t91)
  call void @SDL_GL_DeleteContext(ptr %t7)
  call void @SDL_DestroyWindow(ptr %t6)
  call void @SDL_Quit()
  ret i32 0
}

