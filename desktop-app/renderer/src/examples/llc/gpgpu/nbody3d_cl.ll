; 3D N-body（照 examples/python/gpgpu/nbody3d.py，即 sdlmm/exams/nbody3d.c 的移植）：float32 物理、發光點精靈（加法混合）、攝影機追蹤、覆蓋層與滑桿。
; 用法：lli nbody3d.ll [N] [LOOP] [frames]。滑鼠拖曳／方向鍵旋轉、＋－縮放、C 追蹤、R 隨機係數、H 覆蓋層。（OpenCL 版：整個物理步在裝置上，由 _gen/_gen_nbody3d_cl.py 產生）
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
declare i32 @clGetPlatformIDs(i32, ptr, ptr)
declare i32 @clGetDeviceIDs(ptr, i64, i32, ptr, ptr)
declare ptr @clCreateContext(ptr, i32, ptr, ptr, ptr, ptr)
declare ptr @clCreateCommandQueue(ptr, ptr, i64, ptr)
declare ptr @clCreateProgramWithSource(ptr, i32, ptr, ptr, ptr)
declare i32 @clBuildProgram(ptr, i32, ptr, ptr, ptr, ptr)
declare ptr @clCreateKernel(ptr, ptr, ptr)
declare ptr @clCreateBuffer(ptr, i64, i64, ptr, ptr)
declare i32 @clSetKernelArg(ptr, i32, i64, ptr)
declare i32 @clEnqueueNDRangeKernel(ptr, ptr, i32, ptr, ptr, ptr, i32, ptr, ptr)
declare i32 @clEnqueueReadBuffer(ptr, ptr, i32, i64, i64, ptr, i32, ptr, ptr)
declare i32 @clEnqueueWriteBuffer(ptr, ptr, i32, i64, i64, ptr, i32, ptr, ptr)
declare i32 @clFinish(ptr)
declare i32 @fa_cl_backend()

@.s1 = private constant [3 x i8] c"on\00"
@.s2 = private constant [4 x i8] c"off\00"
@.s3 = private constant [36 x i8] c"[%-3d/%-3d] step: %.3f s  bodies:%d\00"
@.s4 = private constant [24 x i8] c"simulate factor: %-3.5f\00"
@.s5 = private constant [21 x i8] c"random factor: %s[r]\00"
@.s6 = private constant [22 x i8] c"particle size: %-3.1f\00"
@.s7 = private constant [32 x i8] c"cam dist:%.1f angle:(%.2f,%.2f)\00"
@.s8 = private constant [23 x i8] c"camera tracking: %s[C]\00"
@.s9 = private constant [16 x i8] c"compute source:\00"
@.s10 = private constant [22 x i8] c"CPU: wasm integration\00"
@.s11 = private constant [37 x i8] c"GPU: OpenCL kernels (WebGL2 backend)\00"
@.s12 = private constant [30 x i8] c"GPU: OpenCL JS shim (not GPU)\00"
@.s13 = private constant [31 x i8] c"GPU: OpenCL not dispatched yet\00"
@.s14 = private constant [33 x i8] c"MAX_X:%.1f MAX_Y:%.1f MAX_Z:%.1f\00"
@.s15 = private constant [33 x i8] c"MAX_Vel:%.1f Grav:%.1f Soft:%.1f\00"
@.s16 = private constant [48 x i8] c"[h]help [+/-]zoom [arrows/mouse]rotate [C]track\00"
@.s17 = private constant [4 x i8] c"CPU\00"
@.s18 = private constant [4 x i8] c"GPU\00"
@.s19 = private constant [22 x i8] c"[3D] NBody-Simulation\00"
@.s20 = private constant [7 x i8] c"%d %f\0A\00"
@.s21 = private constant [45 x i8] c"frames=%d bodies=%d cx=%.1f cy=%.1f cz=%.1f\0A\00"
@font = private constant [1235 x i32] [i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 20, i32 20, i32 20, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 10, i32 20, i32 63, i32 20, i32 20, i32 126, i32 40, i32 40, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 28, i32 40, i32 40, i32 28, i32 10, i32 10, i32 60, i32 8, i32 8, i32 0, i32 0, i32 0, i32 48, i32 72, i32 50, i32 4, i32 24, i32 46, i32 10, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 32, i32 48, i32 74, i32 70, i32 98, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 16, i32 16, i32 16, i32 16, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 16, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 8, i32 42, i32 28, i32 28, i32 42, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 126, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 42, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 2, i32 4, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 6, i32 24, i32 6, i32 2, i32 38, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 12, i32 12, i32 20, i32 36, i32 36, i32 62, i32 4, i32 4, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 32, i32 32, i32 60, i32 6, i32 2, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 48, i32 32, i32 60, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 34, i32 28, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 38, i32 58, i32 2, i32 4, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 28, i32 96, i32 24, i32 6, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 0, i32 126, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 96, i32 28, i32 2, i32 28, i32 96, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 6, i32 4, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 66, i32 78, i32 82, i32 82, i32 78, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 8, i32 24, i32 20, i32 20, i32 36, i32 62, i32 34, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 60, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 50, i32 32, i32 32, i32 32, i32 32, i32 50, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 36, i32 34, i32 34, i32 34, i32 34, i32 36, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 32, i32 32, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 62, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 4, i32 4, i32 4, i32 4, i32 4, i32 36, i32 56, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 36, i32 40, i32 56, i32 40, i32 36, i32 38, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 102, i32 86, i32 90, i32 74, i32 66, i32 66, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 50, i32 50, i32 42, i32 42, i32 42, i32 38, i32 38, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 4, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 38, i32 56, i32 36, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 36, i32 32, i32 48, i32 12, i32 2, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 34, i32 34, i32 36, i32 20, i32 20, i32 24, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 74, i32 90, i32 58, i32 54, i32 54, i32 36, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 52, i32 20, i32 8, i32 24, i32 20, i32 34, i32 98, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 38, i32 20, i32 24, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 2, i32 4, i32 8, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 28, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 28, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 16, i32 16, i32 8, i32 8, i32 4, i32 4, i32 2, i32 0, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 24, i32 0, i32 0, i32 0, i32 0, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 2, i32 62, i32 34, i32 38, i32 58, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 48, i32 32, i32 32, i32 48, i32 30, i32 0, i32 0, i32 0, i32 0, i32 2, i32 2, i32 2, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 62, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 0, i32 14, i32 8, i32 8, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 4, i32 60, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 56, i32 0, i32 0, i32 32, i32 32, i32 32, i32 38, i32 44, i32 56, i32 44, i32 36, i32 34, i32 0, i32 0, i32 0, i32 0, i32 48, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 8, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 54, i32 42, i32 42, i32 42, i32 42, i32 42, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 2, i32 2, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 16, i32 16, i32 16, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 48, i32 12, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 16, i32 62, i32 16, i32 16, i32 16, i32 16, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 36, i32 20, i32 24, i32 24, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 42, i32 58, i32 58, i32 52, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 20, i32 24, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 20, i32 20, i32 24, i32 8, i32 24, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 8, i32 16, i32 16, i32 62, i32 0, i32 0, i32 0, i32 0, i32 12, i32 8, i32 8, i32 8, i32 48, i32 8, i32 8, i32 8, i32 8, i32 12, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 48, i32 8, i32 8, i32 8, i32 4, i32 8, i32 8, i32 8, i32 8, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 48, i32 78, i32 0, i32 0, i32 0, i32 0]
@colr = private constant [10 x float] [float 0x0000000000000000, float 0x3FD0101020000000, float 0x3FE0101020000000, float 0x3FE8181820000000, float 0x3FF0000000000000, float 0x0000000000000000, float 0x0000000000000000, float 0x3FD8181820000000, float 0x3FE4141420000000, float 0x3FEC1C1C20000000]
@colg = private constant [10 x float] [float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FEC1C1C20000000, float 0x3FE8181820000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000]
@colb = private constant [10 x float] [float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FEC1C1C20000000, float 0x3FE8181820000000, float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000]
@cl_src = private constant [3523 x i8] c"__kernel void accx(__global const float* x, __global const float* y, __global const float* z, __global const float* ms, __global float* ax, int n, float G, float e2) {\0A  int i = get_global_id(0);\0A  float xi = x[i]; float yi = y[i]; float zi = z[i];\0A  float a = 0.0f;\0A  for (int j = 0; j < n; j++) {\0A    if (j != i) {\0A      float dx = x[j] - xi; float dy = y[j] - yi; float dz = z[j] - zi;\0A      float inv = 1.0f / sqrt(dx * dx + dy * dy + dz * dz + e2);\0A      float s = G * ms[j] * inv * inv * inv;\0A      a += s * dx;\0A    }\0A  }\0A  ax[i] = a;\0A}\0A\0A__kernel void accy(__global const float* x, __global const float* y, __global const float* z, __global const float* ms, __global float* ay, int n, float G, float e2) {\0A  int i = get_global_id(0);\0A  float xi = x[i]; float yi = y[i]; float zi = z[i];\0A  float a = 0.0f;\0A  for (int j = 0; j < n; j++) {\0A    if (j != i) {\0A      float dx = x[j] - xi; float dy = y[j] - yi; float dz = z[j] - zi;\0A      float inv = 1.0f / sqrt(dx * dx + dy * dy + dz * dz + e2);\0A      float s = G * ms[j] * inv * inv * inv;\0A      a += s * dy;\0A    }\0A  }\0A  ay[i] = a;\0A}\0A\0A__kernel void accz(__global const float* x, __global const float* y, __global const float* z, __global const float* ms, __global float* az, int n, float G, float e2) {\0A  int i = get_global_id(0);\0A  float xi = x[i]; float yi = y[i]; float zi = z[i];\0A  float a = 0.0f;\0A  for (int j = 0; j < n; j++) {\0A    if (j != i) {\0A      float dx = x[j] - xi; float dy = y[j] - yi; float dz = z[j] - zi;\0A      float inv = 1.0f / sqrt(dx * dx + dy * dy + dz * dz + e2);\0A      float s = G * ms[j] * inv * inv * inv;\0A      a += s * dz;\0A    }\0A  }\0A  az[i] = a;\0A}\0A\0A__kernel void accpot(__global const float* x, __global const float* y, __global const float* z, __global const float* ms, __global float* pot, int n, float G, float e2) {\0A  int i = get_global_id(0);\0A  float xi = x[i]; float yi = y[i]; float zi = z[i];\0A  float p = 0.0f;\0A  for (int j = 0; j < n; j++) {\0A    if (j != i) {\0A      float dx = x[j] - xi; float dy = y[j] - yi; float dz = z[j] - zi;\0A      float inv = 1.0f / sqrt(dx * dx + dy * dy + dz * dz + e2);\0A      p += ms[j] * inv;\0A    }\0A  }\0A  pot[i] = p;\0A}\0A\0A__kernel void kvx(__global const float* vx, __global const float* ax, __global float* ovx, int n, float dt) {\0A  int i = get_global_id(0);\0A  ovx[i] = vx[i] + ax[i] * dt;\0A}\0A\0A__kernel void kvy(__global const float* vy, __global const float* ay, __global float* ovy, int n, float dt) {\0A  int i = get_global_id(0);\0A  ovy[i] = vy[i] + ay[i] * dt;\0A}\0A\0A__kernel void kvz(__global const float* vz, __global const float* az, __global float* ovz, int n, float dt) {\0A  int i = get_global_id(0);\0A  ovz[i] = vz[i] + az[i] * dt;\0A}\0A\0A__kernel void kpx(__global const float* x, __global const float* vx, __global float* ox, int n, float dt, float vmax) {\0A  int i = get_global_id(0);\0A  float cv = vx[i];\0A  if (cv > vmax) { cv = (cv + vmax) * 0.5f; }\0A  if (cv < 1.0f) { cv = (cv + 1.0f) * 0.5f; }\0A  ox[i] = x[i] + cv * dt;\0A}\0A\0A__kernel void kpy(__global const float* y, __global const float* vy, __global float* oy, int n, float dt, float vmax) {\0A  int i = get_global_id(0);\0A  float cv = vy[i];\0A  if (cv > vmax) { cv = (cv + vmax) * 0.5f; }\0A  if (cv < 1.0f) { cv = (cv + 1.0f) * 0.5f; }\0A  oy[i] = y[i] + cv * dt;\0A}\0A\0A__kernel void kpz(__global const float* z, __global const float* vz, __global float* oz, int n, float dt, float vmax) {\0A  int i = get_global_id(0);\0A  float cv = vz[i];\0A  if (cv > vmax) { cv = (cv + vmax) * 0.5f; }\0A  if (cv < 1.0f) { cv = (cv + 1.0f) * 0.5f; }\0A  oz[i] = z[i] + cv * dt;\0A}\0A\00"
@cl_n_accx = private constant [5 x i8] c"accx\00"
@cl_n_accy = private constant [5 x i8] c"accy\00"
@cl_n_accz = private constant [5 x i8] c"accz\00"
@cl_n_accpot = private constant [7 x i8] c"accpot\00"
@cl_n_kvx = private constant [4 x i8] c"kvx\00"
@cl_n_kvy = private constant [4 x i8] c"kvy\00"
@cl_n_kvz = private constant [4 x i8] c"kvz\00"
@cl_n_kpx = private constant [4 x i8] c"kpx\00"
@cl_n_kpy = private constant [4 x i8] c"kpy\00"
@cl_n_kpz = private constant [4 x i8] c"kpz\00"
@cl_h = global [40 x ptr] zeroinitializer
@cl_st = global [4 x i32] zeroinitializer
@cl_mode = global i32 0

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

define void @accel_setup(i32 %n) {
entry:
  %plat = alloca ptr
  %dev = alloca ptr
  %rc = alloca i32
  %srcp = alloca ptr
  %n64 = sext i32 %n to i64
  %bytes = mul i64 %n64, 4
  store ptr @cl_src, ptr %srcp
  %r1 = call i32 @clGetPlatformIDs(i32 1, ptr %plat, ptr null)
  %p = load ptr, ptr %plat
  %r2 = call i32 @clGetDeviceIDs(ptr %p, i64 4, i32 1, ptr %dev, ptr null)
  %e2 = icmp ne i32 %r2, 0
  br i1 %e2, label %cpu, label %ctx
cpu:
  %r3 = call i32 @clGetDeviceIDs(ptr %p, i64 2, i32 1, ptr %dev, ptr null)
  br label %ctx
ctx:
  %d = load ptr, ptr %dev
  %c = call ptr @clCreateContext(ptr null, i32 1, ptr %dev, ptr null, ptr null, ptr %rc)
  %hctx = getelementptr ptr, ptr @cl_h, i32 0
  store ptr %c, ptr %hctx
  %q = call ptr @clCreateCommandQueue(ptr %c, ptr %d, i64 0, ptr %rc)
  %hq = getelementptr ptr, ptr @cl_h, i32 1
  store ptr %q, ptr %hq
  %prog = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %rc)
  %hprog = getelementptr ptr, ptr @cl_h, i32 2
  store ptr %prog, ptr %hprog
  %rb = call i32 @clBuildProgram(ptr %prog, i32 1, ptr %dev, ptr null, ptr null, ptr null)
  %k_accx = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_accx, ptr %rc)
  %hk_accx = getelementptr ptr, ptr @cl_h, i32 3
  store ptr %k_accx, ptr %hk_accx
  %k_accy = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_accy, ptr %rc)
  %hk_accy = getelementptr ptr, ptr @cl_h, i32 4
  store ptr %k_accy, ptr %hk_accy
  %k_accz = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_accz, ptr %rc)
  %hk_accz = getelementptr ptr, ptr @cl_h, i32 5
  store ptr %k_accz, ptr %hk_accz
  %k_accpot = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_accpot, ptr %rc)
  %hk_accpot = getelementptr ptr, ptr @cl_h, i32 6
  store ptr %k_accpot, ptr %hk_accpot
  %k_kvx = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_kvx, ptr %rc)
  %hk_kvx = getelementptr ptr, ptr @cl_h, i32 7
  store ptr %k_kvx, ptr %hk_kvx
  %k_kvy = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_kvy, ptr %rc)
  %hk_kvy = getelementptr ptr, ptr @cl_h, i32 8
  store ptr %k_kvy, ptr %hk_kvy
  %k_kvz = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_kvz, ptr %rc)
  %hk_kvz = getelementptr ptr, ptr @cl_h, i32 9
  store ptr %k_kvz, ptr %hk_kvz
  %k_kpx = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_kpx, ptr %rc)
  %hk_kpx = getelementptr ptr, ptr @cl_h, i32 10
  store ptr %k_kpx, ptr %hk_kpx
  %k_kpy = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_kpy, ptr %rc)
  %hk_kpy = getelementptr ptr, ptr @cl_h, i32 11
  store ptr %k_kpy, ptr %hk_kpy
  %k_kpz = call ptr @clCreateKernel(ptr %prog, ptr @cl_n_kpz, ptr %rc)
  %hk_kpz = getelementptr ptr, ptr @cl_h, i32 12
  store ptr %k_kpz, ptr %hk_kpz
  %b_ms = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_ms = getelementptr ptr, ptr @cl_h, i32 13
  store ptr %b_ms, ptr %hb_ms
  %b_ax = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_ax = getelementptr ptr, ptr @cl_h, i32 14
  store ptr %b_ax, ptr %hb_ax
  %b_ay = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_ay = getelementptr ptr, ptr @cl_h, i32 15
  store ptr %b_ay, ptr %hb_ay
  %b_az = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_az = getelementptr ptr, ptr @cl_h, i32 16
  store ptr %b_az, ptr %hb_az
  %b_pot = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_pot = getelementptr ptr, ptr @cl_h, i32 17
  store ptr %b_pot, ptr %hb_pot
  %b_x0 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_x0 = getelementptr ptr, ptr @cl_h, i32 18
  store ptr %b_x0, ptr %hb_x0
  %b_x1 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_x1 = getelementptr ptr, ptr @cl_h, i32 19
  store ptr %b_x1, ptr %hb_x1
  %b_y0 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_y0 = getelementptr ptr, ptr @cl_h, i32 20
  store ptr %b_y0, ptr %hb_y0
  %b_y1 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_y1 = getelementptr ptr, ptr @cl_h, i32 21
  store ptr %b_y1, ptr %hb_y1
  %b_z0 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_z0 = getelementptr ptr, ptr @cl_h, i32 22
  store ptr %b_z0, ptr %hb_z0
  %b_z1 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_z1 = getelementptr ptr, ptr @cl_h, i32 23
  store ptr %b_z1, ptr %hb_z1
  %b_vx0 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_vx0 = getelementptr ptr, ptr @cl_h, i32 24
  store ptr %b_vx0, ptr %hb_vx0
  %b_vx1 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_vx1 = getelementptr ptr, ptr @cl_h, i32 25
  store ptr %b_vx1, ptr %hb_vx1
  %b_vy0 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_vy0 = getelementptr ptr, ptr @cl_h, i32 26
  store ptr %b_vy0, ptr %hb_vy0
  %b_vy1 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_vy1 = getelementptr ptr, ptr @cl_h, i32 27
  store ptr %b_vy1, ptr %hb_vy1
  %b_vz0 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_vz0 = getelementptr ptr, ptr @cl_h, i32 28
  store ptr %b_vz0, ptr %hb_vz0
  %b_vz1 = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hb_vz1 = getelementptr ptr, ptr @cl_h, i32 29
  store ptr %b_vz1, ptr %hb_vz1
  %sf = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 0
  store i32 1, ptr %sf
  %sn = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 1
  store i32 %n, ptr %sn
  %sp = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 2
  store i32 0, ptr %sp
  ret void
}

define void @cl_reset() {
entry:
  %sr = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 3
  store i32 1, ptr %sr
  ret void
}

define void @accel_cl(ptr %x, ptr %y, ptr %z, ptr %ms, ptr %vx, ptr %vy, ptr %vz, ptr %pot, float %G, float %e2, float %dt, float %vmax, i32 %n) {
entry:
  %g = alloca float
  %ee = alloca float
  %dtv = alloca float
  %vmv = alloca float
  %nn = alloca i32
  %gs = alloca i64
  %n64 = sext i32 %n to i64
  %bytes = mul i64 %n64, 4
  %sf = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 0
  %rdy = load i32, ptr %sf
  %z0 = icmp eq i32 %rdy, 0
  br i1 %z0, label %setup, label %run
setup:
  call void @accel_setup(i32 %n)
  br label %run
run:
  store float %G, ptr %g
  store float %e2, ptr %ee
  store float %dt, ptr %dtv
  store float %vmax, ptr %vmv
  store i32 %n, ptr %nn
  store i64 %n64, ptr %gs
  %hq = getelementptr ptr, ptr @cl_h, i32 1
  %q = load ptr, ptr %hq
  %spp = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 2
  %p = load i32, ptr %spp
  %nx = sub i32 1, %p
  %srs = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 3
  %rs = load i32, ptr %srs
  %needup = icmp ne i32 %rs, 0
  br i1 %needup, label %upload, label %compute
upload:
  %di1 = add i32 %p, 18
  %ds2 = getelementptr ptr, ptr @cl_h, i32 %di1
  %h3 = load ptr, ptr %ds2
  %uw_x = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %h3, i32 1, i64 0, i64 %bytes, ptr %x, i32 0, ptr null, ptr null)
  %di4 = add i32 %p, 20
  %ds5 = getelementptr ptr, ptr @cl_h, i32 %di4
  %h6 = load ptr, ptr %ds5
  %uw_y = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %h6, i32 1, i64 0, i64 %bytes, ptr %y, i32 0, ptr null, ptr null)
  %di7 = add i32 %p, 22
  %ds8 = getelementptr ptr, ptr @cl_h, i32 %di7
  %h9 = load ptr, ptr %ds8
  %uw_z = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %h9, i32 1, i64 0, i64 %bytes, ptr %z, i32 0, ptr null, ptr null)
  %di10 = add i32 %p, 24
  %ds11 = getelementptr ptr, ptr @cl_h, i32 %di10
  %h12 = load ptr, ptr %ds11
  %uw_vx = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %h12, i32 1, i64 0, i64 %bytes, ptr %vx, i32 0, ptr null, ptr null)
  %di13 = add i32 %p, 26
  %ds14 = getelementptr ptr, ptr @cl_h, i32 %di13
  %h15 = load ptr, ptr %ds14
  %uw_vy = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %h15, i32 1, i64 0, i64 %bytes, ptr %vy, i32 0, ptr null, ptr null)
  %di16 = add i32 %p, 28
  %ds17 = getelementptr ptr, ptr @cl_h, i32 %di16
  %h18 = load ptr, ptr %ds17
  %uw_vz = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %h18, i32 1, i64 0, i64 %bytes, ptr %vz, i32 0, ptr null, ptr null)
  %sl19 = getelementptr ptr, ptr @cl_h, i32 13
  %h20 = load ptr, ptr %sl19
  %uw_ms = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %h20, i32 1, i64 0, i64 %bytes, ptr %ms, i32 0, ptr null, ptr null)
  store i32 0, ptr %srs
  br label %compute
compute:
  %sl21 = getelementptr ptr, ptr @cl_h, i32 3
  %h22 = load ptr, ptr %sl21
  %di23 = add i32 %p, 18
  %ds24 = getelementptr ptr, ptr @cl_h, i32 %di23
  %ka_accx = call i32 @clSetKernelArg(ptr %h22, i32 0, i64 8, ptr %ds24)
  %di25 = add i32 %p, 20
  %ds26 = getelementptr ptr, ptr @cl_h, i32 %di25
  %kb_accx = call i32 @clSetKernelArg(ptr %h22, i32 1, i64 8, ptr %ds26)
  %di27 = add i32 %p, 22
  %ds28 = getelementptr ptr, ptr @cl_h, i32 %di27
  %kc_accx = call i32 @clSetKernelArg(ptr %h22, i32 2, i64 8, ptr %ds28)
  %sl29 = getelementptr ptr, ptr @cl_h, i32 13
  %kd_accx = call i32 @clSetKernelArg(ptr %h22, i32 3, i64 8, ptr %sl29)
  %sl30 = getelementptr ptr, ptr @cl_h, i32 14
  %ke_accx = call i32 @clSetKernelArg(ptr %h22, i32 4, i64 8, ptr %sl30)
  %kf_accx = call i32 @clSetKernelArg(ptr %h22, i32 5, i64 4, ptr %nn)
  %kg_accx = call i32 @clSetKernelArg(ptr %h22, i32 6, i64 4, ptr %g)
  %kh_accx = call i32 @clSetKernelArg(ptr %h22, i32 7, i64 4, ptr %ee)
  %en_accx = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h22, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl31 = getelementptr ptr, ptr @cl_h, i32 4
  %h32 = load ptr, ptr %sl31
  %di33 = add i32 %p, 18
  %ds34 = getelementptr ptr, ptr @cl_h, i32 %di33
  %ka_accy = call i32 @clSetKernelArg(ptr %h32, i32 0, i64 8, ptr %ds34)
  %di35 = add i32 %p, 20
  %ds36 = getelementptr ptr, ptr @cl_h, i32 %di35
  %kb_accy = call i32 @clSetKernelArg(ptr %h32, i32 1, i64 8, ptr %ds36)
  %di37 = add i32 %p, 22
  %ds38 = getelementptr ptr, ptr @cl_h, i32 %di37
  %kc_accy = call i32 @clSetKernelArg(ptr %h32, i32 2, i64 8, ptr %ds38)
  %sl39 = getelementptr ptr, ptr @cl_h, i32 13
  %kd_accy = call i32 @clSetKernelArg(ptr %h32, i32 3, i64 8, ptr %sl39)
  %sl40 = getelementptr ptr, ptr @cl_h, i32 15
  %ke_accy = call i32 @clSetKernelArg(ptr %h32, i32 4, i64 8, ptr %sl40)
  %kf_accy = call i32 @clSetKernelArg(ptr %h32, i32 5, i64 4, ptr %nn)
  %kg_accy = call i32 @clSetKernelArg(ptr %h32, i32 6, i64 4, ptr %g)
  %kh_accy = call i32 @clSetKernelArg(ptr %h32, i32 7, i64 4, ptr %ee)
  %en_accy = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h32, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl41 = getelementptr ptr, ptr @cl_h, i32 5
  %h42 = load ptr, ptr %sl41
  %di43 = add i32 %p, 18
  %ds44 = getelementptr ptr, ptr @cl_h, i32 %di43
  %ka_accz = call i32 @clSetKernelArg(ptr %h42, i32 0, i64 8, ptr %ds44)
  %di45 = add i32 %p, 20
  %ds46 = getelementptr ptr, ptr @cl_h, i32 %di45
  %kb_accz = call i32 @clSetKernelArg(ptr %h42, i32 1, i64 8, ptr %ds46)
  %di47 = add i32 %p, 22
  %ds48 = getelementptr ptr, ptr @cl_h, i32 %di47
  %kc_accz = call i32 @clSetKernelArg(ptr %h42, i32 2, i64 8, ptr %ds48)
  %sl49 = getelementptr ptr, ptr @cl_h, i32 13
  %kd_accz = call i32 @clSetKernelArg(ptr %h42, i32 3, i64 8, ptr %sl49)
  %sl50 = getelementptr ptr, ptr @cl_h, i32 16
  %ke_accz = call i32 @clSetKernelArg(ptr %h42, i32 4, i64 8, ptr %sl50)
  %kf_accz = call i32 @clSetKernelArg(ptr %h42, i32 5, i64 4, ptr %nn)
  %kg_accz = call i32 @clSetKernelArg(ptr %h42, i32 6, i64 4, ptr %g)
  %kh_accz = call i32 @clSetKernelArg(ptr %h42, i32 7, i64 4, ptr %ee)
  %en_accz = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h42, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl51 = getelementptr ptr, ptr @cl_h, i32 6
  %h52 = load ptr, ptr %sl51
  %di53 = add i32 %p, 18
  %ds54 = getelementptr ptr, ptr @cl_h, i32 %di53
  %ka_accpot = call i32 @clSetKernelArg(ptr %h52, i32 0, i64 8, ptr %ds54)
  %di55 = add i32 %p, 20
  %ds56 = getelementptr ptr, ptr @cl_h, i32 %di55
  %kb_accpot = call i32 @clSetKernelArg(ptr %h52, i32 1, i64 8, ptr %ds56)
  %di57 = add i32 %p, 22
  %ds58 = getelementptr ptr, ptr @cl_h, i32 %di57
  %kc_accpot = call i32 @clSetKernelArg(ptr %h52, i32 2, i64 8, ptr %ds58)
  %sl59 = getelementptr ptr, ptr @cl_h, i32 13
  %kd_accpot = call i32 @clSetKernelArg(ptr %h52, i32 3, i64 8, ptr %sl59)
  %sl60 = getelementptr ptr, ptr @cl_h, i32 17
  %ke_accpot = call i32 @clSetKernelArg(ptr %h52, i32 4, i64 8, ptr %sl60)
  %kf_accpot = call i32 @clSetKernelArg(ptr %h52, i32 5, i64 4, ptr %nn)
  %kg_accpot = call i32 @clSetKernelArg(ptr %h52, i32 6, i64 4, ptr %g)
  %kh_accpot = call i32 @clSetKernelArg(ptr %h52, i32 7, i64 4, ptr %ee)
  %en_accpot = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h52, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl61 = getelementptr ptr, ptr @cl_h, i32 7
  %h62 = load ptr, ptr %sl61
  %di63 = add i32 %p, 24
  %ds64 = getelementptr ptr, ptr @cl_h, i32 %di63
  %va_x = call i32 @clSetKernelArg(ptr %h62, i32 0, i64 8, ptr %ds64)
  %sl65 = getelementptr ptr, ptr @cl_h, i32 14
  %vb_x = call i32 @clSetKernelArg(ptr %h62, i32 1, i64 8, ptr %sl65)
  %di66 = add i32 %nx, 24
  %ds67 = getelementptr ptr, ptr @cl_h, i32 %di66
  %vc_x = call i32 @clSetKernelArg(ptr %h62, i32 2, i64 8, ptr %ds67)
  %vd_x = call i32 @clSetKernelArg(ptr %h62, i32 3, i64 4, ptr %nn)
  %ve_x = call i32 @clSetKernelArg(ptr %h62, i32 4, i64 4, ptr %dtv)
  %vn_x = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h62, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl68 = getelementptr ptr, ptr @cl_h, i32 8
  %h69 = load ptr, ptr %sl68
  %di70 = add i32 %p, 26
  %ds71 = getelementptr ptr, ptr @cl_h, i32 %di70
  %va_y = call i32 @clSetKernelArg(ptr %h69, i32 0, i64 8, ptr %ds71)
  %sl72 = getelementptr ptr, ptr @cl_h, i32 15
  %vb_y = call i32 @clSetKernelArg(ptr %h69, i32 1, i64 8, ptr %sl72)
  %di73 = add i32 %nx, 26
  %ds74 = getelementptr ptr, ptr @cl_h, i32 %di73
  %vc_y = call i32 @clSetKernelArg(ptr %h69, i32 2, i64 8, ptr %ds74)
  %vd_y = call i32 @clSetKernelArg(ptr %h69, i32 3, i64 4, ptr %nn)
  %ve_y = call i32 @clSetKernelArg(ptr %h69, i32 4, i64 4, ptr %dtv)
  %vn_y = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h69, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl75 = getelementptr ptr, ptr @cl_h, i32 9
  %h76 = load ptr, ptr %sl75
  %di77 = add i32 %p, 28
  %ds78 = getelementptr ptr, ptr @cl_h, i32 %di77
  %va_z = call i32 @clSetKernelArg(ptr %h76, i32 0, i64 8, ptr %ds78)
  %sl79 = getelementptr ptr, ptr @cl_h, i32 16
  %vb_z = call i32 @clSetKernelArg(ptr %h76, i32 1, i64 8, ptr %sl79)
  %di80 = add i32 %nx, 28
  %ds81 = getelementptr ptr, ptr @cl_h, i32 %di80
  %vc_z = call i32 @clSetKernelArg(ptr %h76, i32 2, i64 8, ptr %ds81)
  %vd_z = call i32 @clSetKernelArg(ptr %h76, i32 3, i64 4, ptr %nn)
  %ve_z = call i32 @clSetKernelArg(ptr %h76, i32 4, i64 4, ptr %dtv)
  %vn_z = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h76, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl82 = getelementptr ptr, ptr @cl_h, i32 10
  %h83 = load ptr, ptr %sl82
  %di84 = add i32 %p, 18
  %ds85 = getelementptr ptr, ptr @cl_h, i32 %di84
  %pa_x = call i32 @clSetKernelArg(ptr %h83, i32 0, i64 8, ptr %ds85)
  %di86 = add i32 %nx, 24
  %ds87 = getelementptr ptr, ptr @cl_h, i32 %di86
  %pb_x = call i32 @clSetKernelArg(ptr %h83, i32 1, i64 8, ptr %ds87)
  %di88 = add i32 %nx, 18
  %ds89 = getelementptr ptr, ptr @cl_h, i32 %di88
  %pc_x = call i32 @clSetKernelArg(ptr %h83, i32 2, i64 8, ptr %ds89)
  %pd_x = call i32 @clSetKernelArg(ptr %h83, i32 3, i64 4, ptr %nn)
  %pe_x = call i32 @clSetKernelArg(ptr %h83, i32 4, i64 4, ptr %dtv)
  %pf_x = call i32 @clSetKernelArg(ptr %h83, i32 5, i64 4, ptr %vmv)
  %pn_x = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h83, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl90 = getelementptr ptr, ptr @cl_h, i32 11
  %h91 = load ptr, ptr %sl90
  %di92 = add i32 %p, 20
  %ds93 = getelementptr ptr, ptr @cl_h, i32 %di92
  %pa_y = call i32 @clSetKernelArg(ptr %h91, i32 0, i64 8, ptr %ds93)
  %di94 = add i32 %nx, 26
  %ds95 = getelementptr ptr, ptr @cl_h, i32 %di94
  %pb_y = call i32 @clSetKernelArg(ptr %h91, i32 1, i64 8, ptr %ds95)
  %di96 = add i32 %nx, 20
  %ds97 = getelementptr ptr, ptr @cl_h, i32 %di96
  %pc_y = call i32 @clSetKernelArg(ptr %h91, i32 2, i64 8, ptr %ds97)
  %pd_y = call i32 @clSetKernelArg(ptr %h91, i32 3, i64 4, ptr %nn)
  %pe_y = call i32 @clSetKernelArg(ptr %h91, i32 4, i64 4, ptr %dtv)
  %pf_y = call i32 @clSetKernelArg(ptr %h91, i32 5, i64 4, ptr %vmv)
  %pn_y = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h91, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl98 = getelementptr ptr, ptr @cl_h, i32 12
  %h99 = load ptr, ptr %sl98
  %di100 = add i32 %p, 22
  %ds101 = getelementptr ptr, ptr @cl_h, i32 %di100
  %pa_z = call i32 @clSetKernelArg(ptr %h99, i32 0, i64 8, ptr %ds101)
  %di102 = add i32 %nx, 28
  %ds103 = getelementptr ptr, ptr @cl_h, i32 %di102
  %pb_z = call i32 @clSetKernelArg(ptr %h99, i32 1, i64 8, ptr %ds103)
  %di104 = add i32 %nx, 22
  %ds105 = getelementptr ptr, ptr @cl_h, i32 %di104
  %pc_z = call i32 @clSetKernelArg(ptr %h99, i32 2, i64 8, ptr %ds105)
  %pd_z = call i32 @clSetKernelArg(ptr %h99, i32 3, i64 4, ptr %nn)
  %pe_z = call i32 @clSetKernelArg(ptr %h99, i32 4, i64 4, ptr %dtv)
  %pf_z = call i32 @clSetKernelArg(ptr %h99, i32 5, i64 4, ptr %vmv)
  %pn_z = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %h99, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %sl106 = getelementptr ptr, ptr @cl_h, i32 17
  %h107 = load ptr, ptr %sl106
  %rp = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h107, i32 1, i64 0, i64 %bytes, ptr %pot, i32 0, ptr null, ptr null)
  %di108 = add i32 %nx, 18
  %ds109 = getelementptr ptr, ptr @cl_h, i32 %di108
  %h110 = load ptr, ptr %ds109
  %rr_x = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h110, i32 1, i64 0, i64 %bytes, ptr %x, i32 0, ptr null, ptr null)
  %di111 = add i32 %nx, 20
  %ds112 = getelementptr ptr, ptr @cl_h, i32 %di111
  %h113 = load ptr, ptr %ds112
  %rr_y = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h113, i32 1, i64 0, i64 %bytes, ptr %y, i32 0, ptr null, ptr null)
  %di114 = add i32 %nx, 22
  %ds115 = getelementptr ptr, ptr @cl_h, i32 %di114
  %h116 = load ptr, ptr %ds115
  %rr_z = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h116, i32 1, i64 0, i64 %bytes, ptr %z, i32 0, ptr null, ptr null)
  %fin = call i32 @clFinish(ptr %q)
  store i32 %nx, ptr %spp
  ret void
}

define i32 @cl_mode() {
entry:
  %mv = load i32, ptr @cl_mode
  ret i32 %mv
}

define void @cl_pull(ptr %x, ptr %y, ptr %z, ptr %vx, ptr %vy, ptr %vz) {
entry:
  %sf = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 0
  %rdy = load i32, ptr %sf
  %ok = icmp ne i32 %rdy, 0
  br i1 %ok, label %go, label %done
go:
  %sn = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 1
  %nv = load i32, ptr %sn
  %n64 = sext i32 %nv to i64
  %bytes = mul i64 %n64, 4
  %spp = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 2
  %p = load i32, ptr %spp
  %hq = getelementptr ptr, ptr @cl_h, i32 1
  %q = load ptr, ptr %hq
  %di117 = add i32 %p, 18
  %ds118 = getelementptr ptr, ptr @cl_h, i32 %di117
  %h119 = load ptr, ptr %ds118
  %pr_x = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h119, i32 1, i64 0, i64 %bytes, ptr %x, i32 0, ptr null, ptr null)
  %di120 = add i32 %p, 20
  %ds121 = getelementptr ptr, ptr @cl_h, i32 %di120
  %h122 = load ptr, ptr %ds121
  %pr_y = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h122, i32 1, i64 0, i64 %bytes, ptr %y, i32 0, ptr null, ptr null)
  %di123 = add i32 %p, 22
  %ds124 = getelementptr ptr, ptr @cl_h, i32 %di123
  %h125 = load ptr, ptr %ds124
  %pr_z = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h125, i32 1, i64 0, i64 %bytes, ptr %z, i32 0, ptr null, ptr null)
  %di126 = add i32 %p, 24
  %ds127 = getelementptr ptr, ptr @cl_h, i32 %di126
  %h128 = load ptr, ptr %ds127
  %pr_vx = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h128, i32 1, i64 0, i64 %bytes, ptr %vx, i32 0, ptr null, ptr null)
  %di129 = add i32 %p, 26
  %ds130 = getelementptr ptr, ptr @cl_h, i32 %di129
  %h131 = load ptr, ptr %ds130
  %pr_vy = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h131, i32 1, i64 0, i64 %bytes, ptr %vy, i32 0, ptr null, ptr null)
  %di132 = add i32 %p, 28
  %ds133 = getelementptr ptr, ptr @cl_h, i32 %di132
  %h134 = load ptr, ptr %ds133
  %pr_vz = call i32 @clEnqueueReadBuffer(ptr %q, ptr %h134, i32 1, i64 0, i64 %bytes, ptr %vz, i32 0, ptr null, ptr null)
  %pfin = call i32 @clFinish(ptr %q)
  br label %done
done:
  ret void
}

define void @cl_set_mode(i32 %m, ptr %x, ptr %y, ptr %z, ptr %vx, ptr %vy, ptr %vz) {
entry:
  %old = load i32, ptr @cl_mode
  %same = icmp eq i32 %old, %m
  br i1 %same, label %fin, label %chg
chg:
  %isgpu = icmp ne i32 %m, 0
  br i1 %isgpu, label %togpu, label %tocpu
togpu:
  %sr = getelementptr [4 x i32], ptr @cl_st, i32 0, i32 3
  store i32 1, ptr %sr
  br label %setm
tocpu:
  call void @cl_pull(ptr %x, ptr %y, ptr %z, ptr %vx, ptr %vy, ptr %vz)
  br label %setm
setm:
  store i32 %m, ptr @cl_mode
  br label %fin
fin:
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
  %t10 = call i32 @cl_mode()
  %t11 = icmp ne i32 %t10, 0
  br i1 %t11, label %then1, label %endif2
then1:
  %t12 = getelementptr float, ptr %par, i32 3
  %t13 = load float, ptr %t12
  call void @accel_cl(ptr %x, ptr %y, ptr %z, ptr %ms, ptr %vx, ptr %vy, ptr %vz, ptr %pot, float %t7, float %t5, float %t9, float %t13, i32 %n)
  br label %endif2
endif2:
  %t14 = icmp eq i32 %t10, 0
  br i1 %t14, label %then3, label %endif4
then3:
  store i32 0, ptr %a1
  br label %lc5
lc5:
  %t15 = load i32, ptr %a1
  %t16 = icmp slt i32 %t15, %n
  br i1 %t16, label %lb6, label %le7
lb6:
  store float 0x0000000000000000, ptr %a3
  store float 0x0000000000000000, ptr %a4
  store float 0x0000000000000000, ptr %a5
  store float 0x0000000000000000, ptr %a6
  %t17 = load i32, ptr %a1
  %t18 = getelementptr float, ptr %x, i32 %t17
  %t19 = load float, ptr %t18
  %t20 = load i32, ptr %a1
  %t21 = getelementptr float, ptr %y, i32 %t20
  %t22 = load float, ptr %t21
  %t23 = load i32, ptr %a1
  %t24 = getelementptr float, ptr %z, i32 %t23
  %t25 = load float, ptr %t24
  store i32 0, ptr %a2
  br label %lc8
lc8:
  %t26 = load i32, ptr %a2
  %t27 = icmp slt i32 %t26, %n
  br i1 %t27, label %lb9, label %le10
lb9:
  %t28 = load i32, ptr %a1
  %t29 = load i32, ptr %a2
  %t30 = icmp ne i32 %t28, %t29
  br i1 %t30, label %then11, label %endif12
then11:
  %t31 = load i32, ptr %a2
  %t32 = getelementptr float, ptr %x, i32 %t31
  %t33 = load float, ptr %t32
  %t34 = fsub float %t33, %t19
  %t35 = load i32, ptr %a2
  %t36 = getelementptr float, ptr %y, i32 %t35
  %t37 = load float, ptr %t36
  %t38 = fsub float %t37, %t22
  %t39 = load i32, ptr %a2
  %t40 = getelementptr float, ptr %z, i32 %t39
  %t41 = load float, ptr %t40
  %t42 = fsub float %t41, %t25
  %t43 = fmul float %t34, %t34
  %t44 = fmul float %t38, %t38
  %t45 = fadd float %t43, %t44
  %t46 = fmul float %t42, %t42
  %t47 = fadd float %t45, %t46
  %t48 = fadd float %t47, %t5
  %t49 = call float @sqrtf(float %t48)
  %t50 = fdiv float 0x3FF0000000000000, %t49
  %t51 = load i32, ptr %a2
  %t52 = getelementptr float, ptr %ms, i32 %t51
  %t53 = load float, ptr %t52
  %t54 = fmul float %t7, %t53
  %t55 = fmul float %t54, %t50
  %t56 = fmul float %t55, %t50
  %t57 = fmul float %t56, %t50
  %t58 = fmul float %t57, %t34
  %t59 = load float, ptr %a3
  %t60 = fadd float %t59, %t58
  store float %t60, ptr %a3
  %t61 = fmul float %t57, %t38
  %t62 = load float, ptr %a4
  %t63 = fadd float %t62, %t61
  store float %t63, ptr %a4
  %t64 = fmul float %t57, %t42
  %t65 = load float, ptr %a5
  %t66 = fadd float %t65, %t64
  store float %t66, ptr %a5
  %t67 = load i32, ptr %a2
  %t68 = getelementptr float, ptr %ms, i32 %t67
  %t69 = load float, ptr %t68
  %t70 = fmul float %t69, %t50
  %t71 = load float, ptr %a6
  %t72 = fadd float %t71, %t70
  store float %t72, ptr %a6
  br label %endif12
endif12:
  %t73 = load i32, ptr %a2
  %t74 = add i32 %t73, 1
  store i32 %t74, ptr %a2
  br label %lc8
le10:
  %t75 = load float, ptr %a3
  %t76 = load i32, ptr %a1
  %t77 = getelementptr float, ptr %a7, i32 %t76
  store float %t75, ptr %t77
  %t78 = load float, ptr %a4
  %t79 = load i32, ptr %a1
  %t80 = getelementptr float, ptr %a8, i32 %t79
  store float %t78, ptr %t80
  %t81 = load float, ptr %a5
  %t82 = load i32, ptr %a1
  %t83 = getelementptr float, ptr %a9, i32 %t82
  store float %t81, ptr %t83
  %t84 = load float, ptr %a6
  %t85 = load i32, ptr %a1
  %t86 = getelementptr float, ptr %pot, i32 %t85
  store float %t84, ptr %t86
  %t87 = load i32, ptr %a1
  %t88 = add i32 %t87, 1
  store i32 %t88, ptr %a1
  br label %lc5
le7:
  store i32 0, ptr %a1
  br label %lc13
lc13:
  %t89 = load i32, ptr %a1
  %t90 = icmp slt i32 %t89, %n
  br i1 %t90, label %lb14, label %le15
lb14:
  %t91 = load i32, ptr %a1
  %t92 = getelementptr float, ptr %vx, i32 %t91
  %t93 = load float, ptr %t92
  %t94 = getelementptr float, ptr %a7, i32 %t91
  %t95 = load float, ptr %t94
  %t96 = fmul float %t95, %t9
  %t97 = fadd float %t93, %t96
  %t98 = getelementptr float, ptr %vx, i32 %t91
  store float %t97, ptr %t98
  %t99 = getelementptr float, ptr %vy, i32 %t91
  %t100 = load float, ptr %t99
  %t101 = getelementptr float, ptr %a8, i32 %t91
  %t102 = load float, ptr %t101
  %t103 = fmul float %t102, %t9
  %t104 = fadd float %t100, %t103
  %t105 = getelementptr float, ptr %vy, i32 %t91
  store float %t104, ptr %t105
  %t106 = getelementptr float, ptr %vz, i32 %t91
  %t107 = load float, ptr %t106
  %t108 = getelementptr float, ptr %a9, i32 %t91
  %t109 = load float, ptr %t108
  %t110 = fmul float %t109, %t9
  %t111 = fadd float %t107, %t110
  %t112 = getelementptr float, ptr %vz, i32 %t91
  store float %t111, ptr %t112
  %t113 = getelementptr float, ptr %x, i32 %t91
  %t114 = load float, ptr %t113
  %t115 = getelementptr float, ptr %vx, i32 %t91
  %t116 = load float, ptr %t115
  %t117 = getelementptr float, ptr %par, i32 3
  %t118 = load float, ptr %t117
  %t119 = call float @clampf(float %t116, float 0x3FF0000000000000, float %t118)
  %t120 = fmul float %t119, %t9
  %t121 = fadd float %t114, %t120
  %t122 = getelementptr float, ptr %x, i32 %t91
  store float %t121, ptr %t122
  %t123 = getelementptr float, ptr %y, i32 %t91
  %t124 = load float, ptr %t123
  %t125 = getelementptr float, ptr %vy, i32 %t91
  %t126 = load float, ptr %t125
  %t127 = getelementptr float, ptr %par, i32 3
  %t128 = load float, ptr %t127
  %t129 = call float @clampf(float %t126, float 0x3FF0000000000000, float %t128)
  %t130 = fmul float %t129, %t9
  %t131 = fadd float %t124, %t130
  %t132 = getelementptr float, ptr %y, i32 %t91
  store float %t131, ptr %t132
  %t133 = getelementptr float, ptr %z, i32 %t91
  %t134 = load float, ptr %t133
  %t135 = getelementptr float, ptr %vz, i32 %t91
  %t136 = load float, ptr %t135
  %t137 = getelementptr float, ptr %par, i32 3
  %t138 = load float, ptr %t137
  %t139 = call float @clampf(float %t136, float 0x3FF0000000000000, float %t138)
  %t140 = fmul float %t139, %t9
  %t141 = fadd float %t134, %t140
  %t142 = getelementptr float, ptr %z, i32 %t91
  store float %t141, ptr %t142
  %t143 = load i32, ptr %a1
  %t144 = add i32 %t143, 1
  store i32 %t144, ptr %a1
  br label %lc13
le15:
  br label %endif4
endif4:
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
  %t23 = call i32 @cl_mode()
  %t24 = icmp eq i32 %t23, 0
  br i1 %t24, label %then1, label %endif2
then1:
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  %t25 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s10)
  call void @text(ptr %a1, i32 5, i32 145)
  br label %endif2
endif2:
  %t26 = icmp ne i32 %t23, 0
  br i1 %t26, label %then3, label %endif4
then3:
  %t27 = call i32 @fa_cl_backend()
  %t28 = icmp eq i32 %t27, 1
  br i1 %t28, label %then5, label %endif6
then5:
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FE99999A0000000, float 0x3FD99999A0000000)
  %t29 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s11)
  call void @text(ptr %a1, i32 5, i32 145)
  br label %endif6
endif6:
  %t30 = icmp eq i32 %t27, 2
  br i1 %t30, label %then7, label %endif8
then7:
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FE99999A0000000, float 0x3FD99999A0000000)
  %t31 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s12)
  call void @text(ptr %a1, i32 5, i32 145)
  br label %endif8
endif8:
  %t32 = icmp eq i32 %t27, 0
  br i1 %t32, label %then9, label %endif10
then9:
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FE99999A0000000, float 0x3FD99999A0000000)
  %t33 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s13)
  call void @text(ptr %a1, i32 5, i32 145)
  br label %endif10
endif10:
  br label %endif4
endif4:
  %t34 = getelementptr float, ptr %par, i32 0
  %t35 = load float, ptr %t34
  %t36 = fpext float %t35 to double
  %t37 = getelementptr float, ptr %par, i32 1
  %t38 = load float, ptr %t37
  %t39 = fpext float %t38 to double
  %t40 = getelementptr float, ptr %par, i32 2
  %t41 = load float, ptr %t40
  %t42 = fpext float %t41 to double
  call void @glColor3f(float 0x3FE5581060000000, float 0x3FE5581060000000, float 0x3FE5581060000000)
  %t43 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s14, double %t36, double %t39, double %t42)
  call void @text(ptr %a1, i32 5, i32 165)
  %t44 = getelementptr float, ptr %par, i32 3
  %t45 = load float, ptr %t44
  %t46 = fpext float %t45 to double
  %t47 = getelementptr float, ptr %par, i32 4
  %t48 = load float, ptr %t47
  %t49 = fpext float %t48 to double
  %t50 = getelementptr float, ptr %par, i32 5
  %t51 = load float, ptr %t50
  %t52 = fpext float %t51 to double
  call void @glColor3f(float 0x3FE5581060000000, float 0x3FE5581060000000, float 0x3FE5581060000000)
  %t53 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s15, double %t46, double %t49, double %t52)
  call void @text(ptr %a1, i32 5, i32 185)
  call void @glColor3f(float 0x3FE5581060000000, float 0x3FE5581060000000, float 0x3FE5581060000000)
  %t54 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a1, i64 128, ptr @.s16)
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
  %t55 = getelementptr float, ptr %par, i32 6
  %t56 = load float, ptr %t55
  %t57 = fdiv float %t56, 0x4000000000000000
  %t58 = fmul float %t57, 0x4079000000000000
  call void @glColor3f(float 0x3FEFAE1480000000, float 0x3FEFAE1480000000, float 0x0000000000000000)
  %t59 = fmul float %t58, 0x0000000000000000
  %t60 = fadd float 0x4074000000000000, %t59
  call void @glVertex2f(float %t60, float 0x4039000000000000)
  %t61 = fmul float %t58, 0x3FF0000000000000
  %t62 = fadd float 0x4074000000000000, %t61
  call void @glVertex2f(float %t62, float 0x4039000000000000)
  %t63 = fmul float %t58, 0x3FF0000000000000
  %t64 = fadd float 0x4074000000000000, %t63
  call void @glVertex2f(float %t64, float 0x4044000000000000)
  %t65 = fmul float %t58, 0x0000000000000000
  %t66 = fadd float 0x4074000000000000, %t65
  call void @glVertex2f(float %t66, float 0x4044000000000000)
  %t67 = getelementptr float, ptr %par, i32 7
  %t68 = load float, ptr %t67
  %t69 = fsub float %t68, 0x4014000000000000
  %t70 = fdiv float %t69, 0x4068600000000000
  %t71 = fmul float %t70, 0x4079000000000000
  call void @glColor3f(float 0x0000000000000000, float 0x3FF0000000000000, float 0x0000000000000000)
  %t72 = fmul float %t71, 0x0000000000000000
  %t73 = fadd float 0x4074000000000000, %t72
  call void @glVertex2f(float %t73, float 0x4050400000000000)
  %t74 = fmul float %t71, 0x3FF0000000000000
  %t75 = fadd float 0x4074000000000000, %t74
  call void @glVertex2f(float %t75, float 0x4050400000000000)
  %t76 = fmul float %t71, 0x3FF0000000000000
  %t77 = fadd float 0x4074000000000000, %t76
  call void @glVertex2f(float %t77, float 0x4054000000000000)
  %t78 = fmul float %t71, 0x0000000000000000
  %t79 = fadd float 0x4074000000000000, %t78
  call void @glVertex2f(float %t79, float 0x4054000000000000)
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
  call void @text(ptr @.s17, i32 152, i32 125)
  call void @text(ptr @.s18, i32 212, i32 125)
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
  %t19 = call ptr @SDL_CreateWindow(ptr @.s19, i32 805240832, i32 805240832, i32 800, i32 560, i32 2)
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
  call void @cl_reset()
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
  call void @cl_set_mode(i32 1, ptr %a1, ptr %a2, ptr %a3, ptr %a4, ptr %a5, ptr %a6)
  br label %endif58
endif58:
  %t183 = icmp sge i32 %t100, 140
  %t184 = icmp sle i32 %t100, 190
  %t185 = and i1 %t183, %t184
  %t186 = icmp sge i32 %t102, 122
  %t187 = and i1 %t185, %t186
  %t188 = icmp sle i32 %t102, 142
  %t189 = and i1 %t187, %t188
  br i1 %t189, label %then59, label %endif60
then59:
  call void @cl_set_mode(i32 0, ptr %a1, ptr %a2, ptr %a3, ptr %a4, ptr %a5, ptr %a6)
  br label %endif60
endif60:
  br label %endif56
endif56:
  %t190 = load i32, ptr %a23
  %t191 = icmp ne i32 %t190, 0
  %t192 = icmp sge i32 %t100, 140
  %t193 = icmp sle i32 %t100, 190
  %t194 = and i1 %t192, %t193
  %t195 = icmp sge i32 %t102, 122
  %t196 = and i1 %t194, %t195
  %t197 = icmp sle i32 %t102, 142
  %t198 = and i1 %t196, %t197
  %t199 = icmp sge i32 %t100, 200
  %t200 = icmp sle i32 %t100, 250
  %t201 = and i1 %t199, %t200
  %t202 = icmp sge i32 %t102, 122
  %t203 = and i1 %t201, %t202
  %t204 = icmp sle i32 %t102, 142
  %t205 = and i1 %t203, %t204
  %t206 = or i1 %t198, %t205
  %t207 = and i1 %t191, %t206
  %t208 = icmp eq i1 %t207, false
  br i1 %t208, label %then61, label %endif62
then61:
  store i32 2, ptr %a24
  store i32 %t100, ptr %a32
  store i32 %t102, ptr %a33
  br label %endif62
endif62:
  br label %endif54
endif54:
  br label %endif46
endif46:
  %t209 = icmp eq i32 %t51, 1026
  br i1 %t209, label %then63, label %endif64
then63:
  store i32 0, ptr %a24
  br label %endif64
endif64:
  %t210 = icmp eq i32 %t51, 1024
  br i1 %t210, label %then65, label %endif66
then65:
  %t211 = load i32, ptr %a24
  %t212 = icmp eq i32 %t211, 1
  br i1 %t212, label %then67, label %endif68
then67:
  %t213 = icmp sgt i32 %t102, 25
  %t214 = icmp slt i32 %t102, 40
  %t215 = and i1 %t213, %t214
  %t216 = icmp sge i32 %t100, 320
  %t217 = and i1 %t215, %t216
  %t218 = icmp sle i32 %t100, 720
  %t219 = and i1 %t217, %t218
  br i1 %t219, label %then69, label %endif70
then69:
  %t220 = sub i32 %t100, 320
  %t221 = sitofp i32 %t220 to float
  %t222 = fmul float %t221, 0x4000000000000000
  %t223 = fdiv float %t222, 0x4079000000000000
  %t224 = getelementptr float, ptr %a9, i32 6
  store float %t223, ptr %t224
  br label %endif70
endif70:
  %t225 = icmp sgt i32 %t102, 65
  %t226 = icmp slt i32 %t102, 80
  %t227 = and i1 %t225, %t226
  %t228 = icmp sge i32 %t100, 320
  %t229 = and i1 %t227, %t228
  %t230 = icmp sle i32 %t100, 720
  %t231 = and i1 %t229, %t230
  br i1 %t231, label %then71, label %endif72
then71:
  %t232 = sub i32 %t100, 320
  %t233 = sitofp i32 %t232 to float
  %t234 = fmul float 0x4068600000000000, %t233
  %t235 = fdiv float %t234, 0x4079000000000000
  %t236 = fadd float 0x4014000000000000, %t235
  %t237 = getelementptr float, ptr %a9, i32 7
  store float %t236, ptr %t237
  br label %endif72
endif72:
  br label %endif68
endif68:
  %t238 = load i32, ptr %a24
  %t239 = icmp eq i32 %t238, 2
  %t240 = getelementptr i8, ptr %a13, i32 16
  %t241 = load i32, ptr %t240
  %t242 = and i32 %t241, 1
  %t243 = icmp ne i32 %t242, 0
  %t244 = and i1 %t239, %t243
  br i1 %t244, label %then73, label %endif74
then73:
  %t245 = load i32, ptr %a32
  %t246 = sub i32 %t100, %t245
  %t247 = sitofp i32 %t246 to float
  %t248 = fmul float %t247, 0x3F747AE140000000
  %t249 = load float, ptr %a28
  %t250 = fadd float %t249, %t248
  store float %t250, ptr %a28
  %t251 = load i32, ptr %a33
  %t252 = sub i32 %t102, %t251
  %t253 = sitofp i32 %t252 to float
  %t254 = fmul float %t253, 0x3F747AE140000000
  %t255 = load float, ptr %a27
  %t256 = fsub float %t255, %t254
  store float %t256, ptr %a27
  %t257 = load float, ptr %a27
  %t258 = fcmp ogt float %t257, 0x3FF8000000000000
  br i1 %t258, label %then75, label %endif76
then75:
  store float 0x3FF8000000000000, ptr %a27
  br label %endif76
endif76:
  %t259 = load float, ptr %a27
  %t260 = fcmp olt float %t259, 0xBFF8000000000000
  br i1 %t260, label %then77, label %endif78
then77:
  store float 0xBFF8000000000000, ptr %a27
  br label %endif78
endif78:
  store i32 %t100, ptr %a32
  store i32 %t102, ptr %a33
  store i32 0, ptr %a22
  br label %endif74
endif74:
  br label %endif66
endif66:
  br label %wc16
we18:
  %t261 = load i32, ptr %a22
  %t262 = icmp ne i32 %t261, 0
  br i1 %t262, label %then79, label %endif80
then79:
  %t263 = load float, ptr %a30
  %t264 = load float, ptr %a27
  %t265 = fsub float %t263, %t264
  %t266 = fmul float %t265, 0x3FB99999A0000000
  %t267 = load float, ptr %a27
  %t268 = fadd float %t267, %t266
  store float %t268, ptr %a27
  %t269 = load float, ptr %a31
  %t270 = load float, ptr %a28
  %t271 = fsub float %t269, %t270
  %t272 = fmul float %t271, 0x3FB99999A0000000
  %t273 = load float, ptr %a28
  %t274 = fadd float %t273, %t272
  store float %t274, ptr %a28
  %t275 = load float, ptr %a29
  %t276 = load float, ptr %a26
  %t277 = fsub float %t275, %t276
  %t278 = fmul float %t277, 0x3FB99999A0000000
  %t279 = load float, ptr %a26
  %t280 = fadd float %t279, %t278
  store float %t280, ptr %a26
  br label %endif80
endif80:
  %t281 = load i32, ptr %a22
  %t282 = icmp eq i32 %t281, 0
  br i1 %t282, label %then81, label %endif82
then81:
  %t283 = load float, ptr %a27
  store float %t283, ptr %a30
  %t284 = load float, ptr %a28
  store float %t284, ptr %a31
  %t285 = load float, ptr %a26
  store float %t285, ptr %a29
  br label %endif82
endif82:
  %t286 = call i32 @SDL_GetTicks()
  call void @step(ptr %a1, ptr %a2, ptr %a3, ptr %a4, ptr %a5, ptr %a6, ptr %a7, ptr %a8, ptr %a9, i32 %t17)
  call void @cluster(ptr %a1, ptr %a2, ptr %a3, ptr %a7, ptr %a8, i32 %t17, ptr %a12)
  %t287 = call i32 @SDL_GetTicks()
  %t288 = sub i32 %t287, %t286
  %t289 = sitofp i32 %t288 to float
  store float %t289, ptr %a34
  %t290 = load i32, ptr %a20
  %t291 = add i32 %t290, 1
  store i32 %t291, ptr %a20
  %t292 = load i32, ptr %a20
  %t293 = load i32, ptr %a16
  %t294 = icmp sge i32 %t292, %t293
  br i1 %t294, label %then83, label %endif84
then83:
  %t295 = call i32 @SDL_GetTicks()
  %t296 = load i32, ptr %a36
  %t297 = sub i32 %t295, %t296
  %t298 = sitofp i32 %t297 to double
  %t299 = fdiv double %t298, 0x408F400000000000
  %t300 = call i32 (ptr, ...) @printf(ptr @.s20, i32 %t17, double %t299)
  %t301 = call i32 @SDL_GetTicks()
  store i32 %t301, ptr %a36
  %t302 = load i32, ptr %a21
  %t303 = icmp ne i32 %t302, 0
  br i1 %t303, label %then85, label %endif86
then85:
  %t304 = call float @urand(ptr %a14, float 0x0000000000000000, float 0x3FF0000000000000)
  %t305 = getelementptr float, ptr %a9, i32 6
  store float %t304, ptr %t305
  br label %endif86
endif86:
  call void @randomize(ptr %a9, ptr %a14)
  call void @init_bodies(ptr %a1, ptr %a2, ptr %a3, ptr %a4, ptr %a5, ptr %a6, ptr %a7, ptr %a9, ptr %a14, i32 %t17)
  call void @cl_reset()
  store i32 0, ptr %a20
  %t306 = load i32, ptr %a22
  %t307 = icmp ne i32 %t306, 0
  br i1 %t307, label %then87, label %endif88
then87:
  %t308 = getelementptr float, ptr %a9, i32 0
  %t309 = load float, ptr %t308
  %t310 = fmul float %t309, 0x3FE0000000000000
  %t311 = getelementptr float, ptr %a11, i32 0
  store float %t310, ptr %t311
  %t312 = getelementptr float, ptr %a9, i32 1
  %t313 = load float, ptr %t312
  %t314 = fmul float %t313, 0x3FE0000000000000
  %t315 = getelementptr float, ptr %a11, i32 1
  store float %t314, ptr %t315
  %t316 = getelementptr float, ptr %a9, i32 2
  %t317 = load float, ptr %t316
  %t318 = fmul float %t317, 0x3FE0000000000000
  %t319 = getelementptr float, ptr %a11, i32 2
  store float %t318, ptr %t319
  br label %endif88
endif88:
  br label %endif84
endif84:
  %t320 = load i32, ptr %a22
  %t321 = icmp ne i32 %t320, 0
  br i1 %t321, label %then89, label %endif90
then89:
  %t322 = getelementptr float, ptr %a11, i32 0
  %t323 = load float, ptr %t322
  %t324 = getelementptr float, ptr %a10, i32 0
  store float %t323, ptr %t324
  %t325 = getelementptr float, ptr %a11, i32 1
  %t326 = load float, ptr %t325
  %t327 = getelementptr float, ptr %a10, i32 1
  store float %t326, ptr %t327
  %t328 = getelementptr float, ptr %a11, i32 2
  %t329 = load float, ptr %t328
  %t330 = getelementptr float, ptr %a10, i32 2
  store float %t329, ptr %t330
  br label %endif90
endif90:
  %t331 = load i32, ptr %a22
  %t332 = icmp eq i32 %t331, 0
  br i1 %t332, label %then91, label %endif92
then91:
  %t333 = getelementptr float, ptr %a9, i32 0
  %t334 = load float, ptr %t333
  %t335 = fmul float %t334, 0x3FE0000000000000
  %t336 = getelementptr float, ptr %a10, i32 0
  store float %t335, ptr %t336
  %t337 = getelementptr float, ptr %a9, i32 1
  %t338 = load float, ptr %t337
  %t339 = fmul float %t338, 0x3FE0000000000000
  %t340 = getelementptr float, ptr %a10, i32 1
  store float %t339, ptr %t340
  %t341 = getelementptr float, ptr %a9, i32 2
  %t342 = load float, ptr %t341
  %t343 = fmul float %t342, 0x3FE0000000000000
  %t344 = getelementptr float, ptr %a10, i32 2
  store float %t343, ptr %t344
  br label %endif92
endif92:
  %t345 = load float, ptr %a26
  %t346 = load float, ptr %a27
  %t347 = load float, ptr %a28
  %t348 = getelementptr float, ptr %a9, i32 7
  %t349 = load float, ptr %t348
  call void @draw_scene(ptr %a1, ptr %a2, ptr %a3, i32 %t17, ptr %a10, float %t345, float %t346, float %t347, float %t349)
  %t350 = load i32, ptr %a23
  %t351 = icmp ne i32 %t350, 0
  br i1 %t351, label %then93, label %endif94
then93:
  %t352 = load i32, ptr %a20
  %t353 = load i32, ptr %a16
  %t354 = load float, ptr %a34
  %t355 = load i32, ptr %a21
  %t356 = load float, ptr %a26
  %t357 = load float, ptr %a27
  %t358 = load float, ptr %a28
  %t359 = load i32, ptr %a22
  %t360 = load i32, ptr %a25
  call void @draw_hud(i32 %t17, i32 %t352, i32 %t353, float %t354, ptr %a9, i32 %t355, float %t356, float %t357, float %t358, i32 %t359, i32 %t360)
  br label %endif94
endif94:
  call void @SDL_GL_SwapWindow(ptr %t19)
  call void @SDL_Delay(i32 1)
  %t361 = load i32, ptr %a19
  %t362 = add i32 %t361, 1
  store i32 %t362, ptr %a19
  %t363 = load i32, ptr %a17
  %t364 = icmp sgt i32 %t363, 0
  %t365 = load i32, ptr %a19
  %t366 = load i32, ptr %a17
  %t367 = icmp sge i32 %t365, %t366
  %t368 = and i1 %t364, %t367
  br i1 %t368, label %then95, label %endif96
then95:
  store i32 0, ptr %a18
  br label %endif96
endif96:
  br label %wc13
we15:
  %t369 = load i32, ptr %a19
  %t370 = getelementptr float, ptr %a12, i32 0
  %t371 = load float, ptr %t370
  %t372 = fpext float %t371 to double
  %t373 = getelementptr float, ptr %a12, i32 1
  %t374 = load float, ptr %t373
  %t375 = fpext float %t374 to double
  %t376 = getelementptr float, ptr %a12, i32 2
  %t377 = load float, ptr %t376
  %t378 = fpext float %t377 to double
  %t379 = call i32 (ptr, ...) @printf(ptr @.s21, i32 %t369, i32 %t17, double %t372, double %t375, double %t378)
  call void @SDL_GL_DeleteContext(ptr %t20)
  call void @SDL_DestroyWindow(ptr %t19)
  call void @SDL_Quit()
  ret i32 0
}

