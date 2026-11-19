; 3D SPH 流體（CPU，double，O(N²)）＋ OpenGL 點精靈（SDL2）。滑鼠左鍵拖曳旋轉、滾輪縮放、空白＝晃一下水、R 重置、Esc 離開。
; 第一個參數＝跑幾幀後離開（測試用）。（OpenCL 版：密度與力用 OpenCL 核心（float32），由 _gen/_gen_fluid3d_cl.py 產生）
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

@.s1 = private constant [44 x i8] c"%d particles | source: CPU (wasm) | step %d\00"
@.s2 = private constant [72 x i8] c"%d particles | source: CPU, GPU unavailable (no WebGL2 float) | step %d\00"
@.s3 = private constant [53 x i8] c"%d particles | source: GPU (OpenCL WebGL2) | step %d\00"
@.s4 = private constant [53 x i8] c"%d particles | source: GPU (OpenCL WebGPU) | step %d\00"
@.s5 = private constant [63 x i8] c"%d particles | source: GPU (OpenCL JS shim, not GPU) | step %d\00"
@.s6 = private constant [62 x i8] c"%d particles | source: GPU (OpenCL, not dispatched) | step %d\00"
@.s7 = private constant [57 x i8] c"[drag]rotate [wheel]zoom [space]splash [P]pause [R]reset\00"
@.s8 = private constant [4 x i8] c"CPU\00"
@.s9 = private constant [4 x i8] c"GPU\00"
@.s10 = private constant [22 x i8] c"IR fluid3d (SPH, CPU)\00"
@.s11 = private constant [28 x i8] c"frames=%d n=%d y_mean=%.3f\0A\00"
@sph_src = private constant [3646 x i8] c"__kernel void krho(__global const float* x, __global const float* y, __global const float* z, __global float* rho, int n, float h2, float c0) {\0A  int i = get_global_id(0);\0A  float xi = x[i]; float yi = y[i]; float zi = z[i];\0A  float s = 0.0f;\0A  for (int j = 0; j < n; j++) {\0A    float dx = xi - x[j]; float dy = yi - y[j]; float dz = zi - z[j];\0A    float mm = h2 - (dx * dx + dy * dy + dz * dz);\0A    if (mm > 0.0f) {\0A      s += mm * mm * mm;\0A    }\0A  }\0A  rho[i] = s * c0;\0A}\0A\0A__kernel void kfx(__global const float* x, __global const float* y, __global const float* z, __global const float* vx, __global const float* vy, __global const float* vz, __global const float* rho, __global float* ax, int n, float h2, float h, float K, float rho0, float cs, float cv, float g) {\0A  int i = get_global_id(0);\0A  float xi = x[i]; float yi = y[i]; float zi = z[i]; float vxi = vx[i];\0A  float rhoi = rho[i];\0A  float pi = (rhoi - rho0) * K;\0A  if (pi < 0.0f) { pi = 0.0f; }\0A  float f = 0.0f;\0A  for (int j = 0; j < n; j++) {\0A    float dx = xi - x[j]; float dy = yi - y[j]; float dz = zi - z[j];\0A    float r2 = dx * dx + dy * dy + dz * dz;\0A    if (r2 < h2) {\0A      if (r2 > 0.000000000001f) {\0A        float r = sqrt(r2);\0A        float w = h - r;\0A        float rhoj = rho[j];\0A        float pj = (rhoj - rho0) * K;\0A        if (pj < 0.0f) { pj = 0.0f; }\0A        float cp = ((pi + pj) / (rhoj * 2.0f)) * (w * w / r) * cs;\0A        float cvv = (w / rhoj) * cv;\0A        f += dx * cp + (vx[j] - vxi) * cvv;\0A      }\0A    }\0A  }\0A  ax[i] = f * (1.0f / rhoi);\0A}\0A\0A__kernel void kfy(__global const float* x, __global const float* y, __global const float* z, __global const float* vx, __global const float* vy, __global const float* vz, __global const float* rho, __global float* ay, int n, float h2, float h, float K, float rho0, float cs, float cv, float g) {\0A  int i = get_global_id(0);\0A  float xi = x[i]; float yi = y[i]; float zi = z[i]; float vyi = vy[i];\0A  float rhoi = rho[i];\0A  float pi = (rhoi - rho0) * K;\0A  if (pi < 0.0f) { pi = 0.0f; }\0A  float f = 0.0f;\0A  for (int j = 0; j < n; j++) {\0A    float dx = xi - x[j]; float dy = yi - y[j]; float dz = zi - z[j];\0A    float r2 = dx * dx + dy * dy + dz * dz;\0A    if (r2 < h2) {\0A      if (r2 > 0.000000000001f) {\0A        float r = sqrt(r2);\0A        float w = h - r;\0A        float rhoj = rho[j];\0A        float pj = (rhoj - rho0) * K;\0A        if (pj < 0.0f) { pj = 0.0f; }\0A        float cp = ((pi + pj) / (rhoj * 2.0f)) * (w * w / r) * cs;\0A        float cvv = (w / rhoj) * cv;\0A        f += dy * cp + (vy[j] - vyi) * cvv;\0A      }\0A    }\0A  }\0A  ay[i] = f * (1.0f / rhoi) + g;\0A}\0A\0A__kernel void kfz(__global const float* x, __global const float* y, __global const float* z, __global const float* vx, __global const float* vy, __global const float* vz, __global const float* rho, __global float* az, int n, float h2, float h, float K, float rho0, float cs, float cv, float g) {\0A  int i = get_global_id(0);\0A  float xi = x[i]; float yi = y[i]; float zi = z[i]; float vzi = vz[i];\0A  float rhoi = rho[i];\0A  float pi = (rhoi - rho0) * K;\0A  if (pi < 0.0f) { pi = 0.0f; }\0A  float f = 0.0f;\0A  for (int j = 0; j < n; j++) {\0A    float dx = xi - x[j]; float dy = yi - y[j]; float dz = zi - z[j];\0A    float r2 = dx * dx + dy * dy + dz * dz;\0A    if (r2 < h2) {\0A      if (r2 > 0.000000000001f) {\0A        float r = sqrt(r2);\0A        float w = h - r;\0A        float rhoj = rho[j];\0A        float pj = (rhoj - rho0) * K;\0A        if (pj < 0.0f) { pj = 0.0f; }\0A        float cp = ((pi + pj) / (rhoj * 2.0f)) * (w * w / r) * cs;\0A        float cvv = (w / rhoj) * cv;\0A        f += dz * cp + (vz[j] - vzi) * cvv;\0A      }\0A    }\0A  }\0A  az[i] = f * (1.0f / rhoi);\0A}\0A\00"
@sph_n_krho = private constant [5 x i8] c"krho\00"
@sph_n_kfx = private constant [4 x i8] c"kfx\00"
@sph_n_kfy = private constant [4 x i8] c"kfy\00"
@sph_n_kfz = private constant [4 x i8] c"kfz\00"
@sph_h = global [20 x ptr] zeroinitializer
@sph_st = global [2 x i32] zeroinitializer
@cl_mode = global i32 1
@cl_fb = global i32 0
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

define void @sph_setup(i32 %n) {
entry:
  %plat = alloca ptr
  %dev = alloca ptr
  %rc = alloca i32
  %srcp = alloca ptr
  store ptr @sph_src, ptr %srcp
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
  %hctx = getelementptr ptr, ptr @sph_h, i32 0
  store ptr %c, ptr %hctx
  %q = call ptr @clCreateCommandQueue(ptr %c, ptr %d, i64 0, ptr %rc)
  %hq = getelementptr ptr, ptr @sph_h, i32 1
  store ptr %q, ptr %hq
  %prog = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %rc)
  %hprog = getelementptr ptr, ptr @sph_h, i32 2
  store ptr %prog, ptr %hprog
  %rb = call i32 @clBuildProgram(ptr %prog, i32 1, ptr %dev, ptr null, ptr null, ptr null)
  %n64 = sext i32 %n to i64
  %bytes = mul i64 %n64, 4
  %kkrho = call ptr @clCreateKernel(ptr %prog, ptr @sph_n_krho, ptr %rc)
  %hkrho = getelementptr ptr, ptr @sph_h, i32 3
  store ptr %kkrho, ptr %hkrho
  %kkfx = call ptr @clCreateKernel(ptr %prog, ptr @sph_n_kfx, ptr %rc)
  %hkfx = getelementptr ptr, ptr @sph_h, i32 4
  store ptr %kkfx, ptr %hkfx
  %kkfy = call ptr @clCreateKernel(ptr %prog, ptr @sph_n_kfy, ptr %rc)
  %hkfy = getelementptr ptr, ptr @sph_h, i32 5
  store ptr %kkfy, ptr %hkfy
  %kkfz = call ptr @clCreateKernel(ptr %prog, ptr @sph_n_kfz, ptr %rc)
  %hkfz = getelementptr ptr, ptr @sph_h, i32 6
  store ptr %kkfz, ptr %hkfz
  %bx = call ptr @clCreateBuffer(ptr %c, i64 4, i64 %bytes, ptr null, ptr %rc)
  %hbx = getelementptr ptr, ptr @sph_h, i32 7
  store ptr %bx, ptr %hbx
  %by = call ptr @clCreateBuffer(ptr %c, i64 4, i64 %bytes, ptr null, ptr %rc)
  %hby = getelementptr ptr, ptr @sph_h, i32 8
  store ptr %by, ptr %hby
  %bz = call ptr @clCreateBuffer(ptr %c, i64 4, i64 %bytes, ptr null, ptr %rc)
  %hbz = getelementptr ptr, ptr @sph_h, i32 9
  store ptr %bz, ptr %hbz
  %bvx = call ptr @clCreateBuffer(ptr %c, i64 4, i64 %bytes, ptr null, ptr %rc)
  %hbvx = getelementptr ptr, ptr @sph_h, i32 10
  store ptr %bvx, ptr %hbvx
  %bvy = call ptr @clCreateBuffer(ptr %c, i64 4, i64 %bytes, ptr null, ptr %rc)
  %hbvy = getelementptr ptr, ptr @sph_h, i32 11
  store ptr %bvy, ptr %hbvy
  %bvz = call ptr @clCreateBuffer(ptr %c, i64 4, i64 %bytes, ptr null, ptr %rc)
  %hbvz = getelementptr ptr, ptr @sph_h, i32 12
  store ptr %bvz, ptr %hbvz
  %brho = call ptr @clCreateBuffer(ptr %c, i64 1, i64 %bytes, ptr null, ptr %rc)
  %hbrho = getelementptr ptr, ptr @sph_h, i32 13
  store ptr %brho, ptr %hbrho
  %bax = call ptr @clCreateBuffer(ptr %c, i64 2, i64 %bytes, ptr null, ptr %rc)
  %hbax = getelementptr ptr, ptr @sph_h, i32 14
  store ptr %bax, ptr %hbax
  %bay = call ptr @clCreateBuffer(ptr %c, i64 2, i64 %bytes, ptr null, ptr %rc)
  %hbay = getelementptr ptr, ptr @sph_h, i32 15
  store ptr %bay, ptr %hbay
  %baz = call ptr @clCreateBuffer(ptr %c, i64 2, i64 %bytes, ptr null, ptr %rc)
  %hbaz = getelementptr ptr, ptr @sph_h, i32 16
  store ptr %baz, ptr %hbaz
  %sf = getelementptr [2 x i32], ptr @sph_st, i32 0, i32 0
  store i32 1, ptr %sf
  ret void
}

define void @sph_gpu(ptr %sx, ptr %sy, ptr %sz, ptr %svx, ptr %svy, ptr %svz, ptr %srho, ptr %sax, ptr %say, ptr %saz, i32 %n, float %h2, float %h, float %c0, float %K, float %rho0, float %cs, float %cv, float %g) {
entry:
  %gs = alloca i64
  %nn = alloca i32
  %pf = alloca [8 x float]
  %n64 = sext i32 %n to i64
  %bytes = mul i64 %n64, 4
  store i64 %n64, ptr %gs
  store i32 %n, ptr %nn
  %sf = getelementptr [2 x i32], ptr @sph_st, i32 0, i32 0
  %rdy = load i32, ptr %sf
  %z0 = icmp eq i32 %rdy, 0
  br i1 %z0, label %setup, label %run
setup:
  call void @sph_setup(i32 %n)
  br label %run
run:
  %p_h2 = getelementptr [8 x float], ptr %pf, i32 0, i32 0
  store float %h2, ptr %p_h2
  %p_h = getelementptr [8 x float], ptr %pf, i32 0, i32 1
  store float %h, ptr %p_h
  %p_c0 = getelementptr [8 x float], ptr %pf, i32 0, i32 2
  store float %c0, ptr %p_c0
  %p_K = getelementptr [8 x float], ptr %pf, i32 0, i32 3
  store float %K, ptr %p_K
  %p_rho0 = getelementptr [8 x float], ptr %pf, i32 0, i32 4
  store float %rho0, ptr %p_rho0
  %p_cs = getelementptr [8 x float], ptr %pf, i32 0, i32 5
  store float %cs, ptr %p_cs
  %p_cv = getelementptr [8 x float], ptr %pf, i32 0, i32 6
  store float %cv, ptr %p_cv
  %p_g = getelementptr [8 x float], ptr %pf, i32 0, i32 7
  store float %g, ptr %p_g
  %hq = getelementptr ptr, ptr @sph_h, i32 1
  %q = load ptr, ptr %hq
  %hw_bx = getelementptr ptr, ptr @sph_h, i32 7
  %bw_bx = load ptr, ptr %hw_bx
  %ew_bx = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %bw_bx, i32 1, i64 0, i64 %bytes, ptr %sx, i32 0, ptr null, ptr null)
  %hw_by = getelementptr ptr, ptr @sph_h, i32 8
  %bw_by = load ptr, ptr %hw_by
  %ew_by = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %bw_by, i32 1, i64 0, i64 %bytes, ptr %sy, i32 0, ptr null, ptr null)
  %hw_bz = getelementptr ptr, ptr @sph_h, i32 9
  %bw_bz = load ptr, ptr %hw_bz
  %ew_bz = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %bw_bz, i32 1, i64 0, i64 %bytes, ptr %sz, i32 0, ptr null, ptr null)
  %hw_bvx = getelementptr ptr, ptr @sph_h, i32 10
  %bw_bvx = load ptr, ptr %hw_bvx
  %ew_bvx = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %bw_bvx, i32 1, i64 0, i64 %bytes, ptr %svx, i32 0, ptr null, ptr null)
  %hw_bvy = getelementptr ptr, ptr @sph_h, i32 11
  %bw_bvy = load ptr, ptr %hw_bvy
  %ew_bvy = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %bw_bvy, i32 1, i64 0, i64 %bytes, ptr %svy, i32 0, ptr null, ptr null)
  %hw_bvz = getelementptr ptr, ptr @sph_h, i32 12
  %bw_bvz = load ptr, ptr %hw_bvz
  %ew_bvz = call i32 @clEnqueueWriteBuffer(ptr %q, ptr %bw_bvz, i32 1, i64 0, i64 %bytes, ptr %svz, i32 0, ptr null, ptr null)
  %hk_krho = getelementptr ptr, ptr @sph_h, i32 3
  %kk_krho = load ptr, ptr %hk_krho
  %hb_krho_0 = getelementptr ptr, ptr @sph_h, i32 7
  %ar_krho_0 = call i32 @clSetKernelArg(ptr %kk_krho, i32 0, i64 8, ptr %hb_krho_0)
  %hb_krho_1 = getelementptr ptr, ptr @sph_h, i32 8
  %ar_krho_1 = call i32 @clSetKernelArg(ptr %kk_krho, i32 1, i64 8, ptr %hb_krho_1)
  %hb_krho_2 = getelementptr ptr, ptr @sph_h, i32 9
  %ar_krho_2 = call i32 @clSetKernelArg(ptr %kk_krho, i32 2, i64 8, ptr %hb_krho_2)
  %hb_krho_3 = getelementptr ptr, ptr @sph_h, i32 13
  %ar_krho_3 = call i32 @clSetKernelArg(ptr %kk_krho, i32 3, i64 8, ptr %hb_krho_3)
  %ar_krho_4 = call i32 @clSetKernelArg(ptr %kk_krho, i32 4, i64 4, ptr %nn)
  %ar_krho_5 = call i32 @clSetKernelArg(ptr %kk_krho, i32 5, i64 4, ptr %p_h2)
  %ar_krho_6 = call i32 @clSetKernelArg(ptr %kk_krho, i32 6, i64 4, ptr %p_c0)
  %en_krho = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %kk_krho, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %hk_kfx = getelementptr ptr, ptr @sph_h, i32 4
  %kk_kfx = load ptr, ptr %hk_kfx
  %hb_kfx_0 = getelementptr ptr, ptr @sph_h, i32 7
  %ar_kfx_0 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 0, i64 8, ptr %hb_kfx_0)
  %hb_kfx_1 = getelementptr ptr, ptr @sph_h, i32 8
  %ar_kfx_1 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 1, i64 8, ptr %hb_kfx_1)
  %hb_kfx_2 = getelementptr ptr, ptr @sph_h, i32 9
  %ar_kfx_2 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 2, i64 8, ptr %hb_kfx_2)
  %hb_kfx_3 = getelementptr ptr, ptr @sph_h, i32 10
  %ar_kfx_3 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 3, i64 8, ptr %hb_kfx_3)
  %hb_kfx_4 = getelementptr ptr, ptr @sph_h, i32 11
  %ar_kfx_4 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 4, i64 8, ptr %hb_kfx_4)
  %hb_kfx_5 = getelementptr ptr, ptr @sph_h, i32 12
  %ar_kfx_5 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 5, i64 8, ptr %hb_kfx_5)
  %hb_kfx_6 = getelementptr ptr, ptr @sph_h, i32 13
  %ar_kfx_6 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 6, i64 8, ptr %hb_kfx_6)
  %hb_kfx_7 = getelementptr ptr, ptr @sph_h, i32 14
  %ar_kfx_7 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 7, i64 8, ptr %hb_kfx_7)
  %ar_kfx_8 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 8, i64 4, ptr %nn)
  %ar_kfx_9 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 9, i64 4, ptr %p_h2)
  %ar_kfx_10 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 10, i64 4, ptr %p_h)
  %ar_kfx_11 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 11, i64 4, ptr %p_K)
  %ar_kfx_12 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 12, i64 4, ptr %p_rho0)
  %ar_kfx_13 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 13, i64 4, ptr %p_cs)
  %ar_kfx_14 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 14, i64 4, ptr %p_cv)
  %ar_kfx_15 = call i32 @clSetKernelArg(ptr %kk_kfx, i32 15, i64 4, ptr %p_g)
  %en_kfx = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %kk_kfx, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %hk_kfy = getelementptr ptr, ptr @sph_h, i32 5
  %kk_kfy = load ptr, ptr %hk_kfy
  %hb_kfy_0 = getelementptr ptr, ptr @sph_h, i32 7
  %ar_kfy_0 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 0, i64 8, ptr %hb_kfy_0)
  %hb_kfy_1 = getelementptr ptr, ptr @sph_h, i32 8
  %ar_kfy_1 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 1, i64 8, ptr %hb_kfy_1)
  %hb_kfy_2 = getelementptr ptr, ptr @sph_h, i32 9
  %ar_kfy_2 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 2, i64 8, ptr %hb_kfy_2)
  %hb_kfy_3 = getelementptr ptr, ptr @sph_h, i32 10
  %ar_kfy_3 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 3, i64 8, ptr %hb_kfy_3)
  %hb_kfy_4 = getelementptr ptr, ptr @sph_h, i32 11
  %ar_kfy_4 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 4, i64 8, ptr %hb_kfy_4)
  %hb_kfy_5 = getelementptr ptr, ptr @sph_h, i32 12
  %ar_kfy_5 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 5, i64 8, ptr %hb_kfy_5)
  %hb_kfy_6 = getelementptr ptr, ptr @sph_h, i32 13
  %ar_kfy_6 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 6, i64 8, ptr %hb_kfy_6)
  %hb_kfy_7 = getelementptr ptr, ptr @sph_h, i32 15
  %ar_kfy_7 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 7, i64 8, ptr %hb_kfy_7)
  %ar_kfy_8 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 8, i64 4, ptr %nn)
  %ar_kfy_9 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 9, i64 4, ptr %p_h2)
  %ar_kfy_10 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 10, i64 4, ptr %p_h)
  %ar_kfy_11 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 11, i64 4, ptr %p_K)
  %ar_kfy_12 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 12, i64 4, ptr %p_rho0)
  %ar_kfy_13 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 13, i64 4, ptr %p_cs)
  %ar_kfy_14 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 14, i64 4, ptr %p_cv)
  %ar_kfy_15 = call i32 @clSetKernelArg(ptr %kk_kfy, i32 15, i64 4, ptr %p_g)
  %en_kfy = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %kk_kfy, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %hk_kfz = getelementptr ptr, ptr @sph_h, i32 6
  %kk_kfz = load ptr, ptr %hk_kfz
  %hb_kfz_0 = getelementptr ptr, ptr @sph_h, i32 7
  %ar_kfz_0 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 0, i64 8, ptr %hb_kfz_0)
  %hb_kfz_1 = getelementptr ptr, ptr @sph_h, i32 8
  %ar_kfz_1 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 1, i64 8, ptr %hb_kfz_1)
  %hb_kfz_2 = getelementptr ptr, ptr @sph_h, i32 9
  %ar_kfz_2 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 2, i64 8, ptr %hb_kfz_2)
  %hb_kfz_3 = getelementptr ptr, ptr @sph_h, i32 10
  %ar_kfz_3 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 3, i64 8, ptr %hb_kfz_3)
  %hb_kfz_4 = getelementptr ptr, ptr @sph_h, i32 11
  %ar_kfz_4 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 4, i64 8, ptr %hb_kfz_4)
  %hb_kfz_5 = getelementptr ptr, ptr @sph_h, i32 12
  %ar_kfz_5 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 5, i64 8, ptr %hb_kfz_5)
  %hb_kfz_6 = getelementptr ptr, ptr @sph_h, i32 13
  %ar_kfz_6 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 6, i64 8, ptr %hb_kfz_6)
  %hb_kfz_7 = getelementptr ptr, ptr @sph_h, i32 16
  %ar_kfz_7 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 7, i64 8, ptr %hb_kfz_7)
  %ar_kfz_8 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 8, i64 4, ptr %nn)
  %ar_kfz_9 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 9, i64 4, ptr %p_h2)
  %ar_kfz_10 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 10, i64 4, ptr %p_h)
  %ar_kfz_11 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 11, i64 4, ptr %p_K)
  %ar_kfz_12 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 12, i64 4, ptr %p_rho0)
  %ar_kfz_13 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 13, i64 4, ptr %p_cs)
  %ar_kfz_14 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 14, i64 4, ptr %p_cv)
  %ar_kfz_15 = call i32 @clSetKernelArg(ptr %kk_kfz, i32 15, i64 4, ptr %p_g)
  %en_kfz = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %kk_kfz, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %hr_brho = getelementptr ptr, ptr @sph_h, i32 13
  %br_brho = load ptr, ptr %hr_brho
  %rr_brho = call i32 @clEnqueueReadBuffer(ptr %q, ptr %br_brho, i32 1, i64 0, i64 %bytes, ptr %srho, i32 0, ptr null, ptr null)
  %hr_bax = getelementptr ptr, ptr @sph_h, i32 14
  %br_bax = load ptr, ptr %hr_bax
  %rr_bax = call i32 @clEnqueueReadBuffer(ptr %q, ptr %br_bax, i32 1, i64 0, i64 %bytes, ptr %sax, i32 0, ptr null, ptr null)
  %hr_bay = getelementptr ptr, ptr @sph_h, i32 15
  %br_bay = load ptr, ptr %hr_bay
  %rr_bay = call i32 @clEnqueueReadBuffer(ptr %q, ptr %br_bay, i32 1, i64 0, i64 %bytes, ptr %say, i32 0, ptr null, ptr null)
  %hr_baz = getelementptr ptr, ptr @sph_h, i32 16
  %br_baz = load ptr, ptr %hr_baz
  %rr_baz = call i32 @clEnqueueReadBuffer(ptr %q, ptr %br_baz, i32 1, i64 0, i64 %bytes, ptr %saz, i32 0, ptr null, ptr null)
  call i32 @clFinish(ptr %q)
  ret void
}

define i32 @cl_mode() {
entry:
  %mv = load i32, ptr @cl_mode
  ret i32 %mv
}

define i32 @cl_fb() {
entry:
  %fv = load i32, ptr @cl_fb
  ret i32 %fv
}

define void @cl_set_mode(i32 %m) {
entry:
  store i32 %m, ptr @cl_mode
  store i32 0, ptr @cl_fb
  ret void
}

define void @cl_check() {
entry:
  %be = call i32 @fa_cl_backend()
  %isjs = icmp eq i32 %be, 2
  br i1 %isjs, label %fb, label %ok
fb:
  store i32 0, ptr @cl_mode
  store i32 1, ptr @cl_fb
  br label %ok
ok:
  ret void
}



define void @step(ptr %pos, ptr %vel, ptr %rho, ptr %prs, ptr %acc) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  %a3 = alloca i32
  %a4 = alloca double
  %a5 = alloca [1000 x float]
  %a6 = alloca [1000 x float]
  %a7 = alloca [1000 x float]
  %a8 = alloca [1000 x float]
  %a9 = alloca [1000 x float]
  %a10 = alloca [1000 x float]
  %a11 = alloca [1000 x float]
  %a12 = alloca [1000 x float]
  %a13 = alloca [1000 x float]
  %a14 = alloca [1000 x float]
  %a15 = alloca double
  %a16 = alloca double
  %a17 = alloca double
  store i32 0, ptr %a1
  store i32 0, ptr %a2
  store i32 0, ptr %a3
  store double 0x0000000000000000, ptr %a4
  %t1 = call i32 @cl_mode()
  %t2 = icmp ne i32 %t1, 0
  br i1 %t2, label %then1, label %endif2
then1:
  store i32 0, ptr %a1
  br label %lc3
lc3:
  %t3 = load i32, ptr %a1
  %t4 = icmp slt i32 %t3, 1000
  br i1 %t4, label %lb4, label %le5
lb4:
  %t5 = load i32, ptr %a1
  %t6 = mul i32 %t5, 3
  %t7 = getelementptr double, ptr %pos, i32 %t6
  %t8 = load double, ptr %t7
  %t9 = fptrunc double %t8 to float
  %t10 = load i32, ptr %a1
  %t11 = getelementptr float, ptr %a5, i32 %t10
  store float %t9, ptr %t11
  %t12 = add i32 %t6, 1
  %t13 = getelementptr double, ptr %pos, i32 %t12
  %t14 = load double, ptr %t13
  %t15 = fptrunc double %t14 to float
  %t16 = load i32, ptr %a1
  %t17 = getelementptr float, ptr %a6, i32 %t16
  store float %t15, ptr %t17
  %t18 = add i32 %t6, 2
  %t19 = getelementptr double, ptr %pos, i32 %t18
  %t20 = load double, ptr %t19
  %t21 = fptrunc double %t20 to float
  %t22 = load i32, ptr %a1
  %t23 = getelementptr float, ptr %a7, i32 %t22
  store float %t21, ptr %t23
  %t24 = getelementptr double, ptr %vel, i32 %t6
  %t25 = load double, ptr %t24
  %t26 = fptrunc double %t25 to float
  %t27 = load i32, ptr %a1
  %t28 = getelementptr float, ptr %a8, i32 %t27
  store float %t26, ptr %t28
  %t29 = add i32 %t6, 1
  %t30 = getelementptr double, ptr %vel, i32 %t29
  %t31 = load double, ptr %t30
  %t32 = fptrunc double %t31 to float
  %t33 = load i32, ptr %a1
  %t34 = getelementptr float, ptr %a9, i32 %t33
  store float %t32, ptr %t34
  %t35 = add i32 %t6, 2
  %t36 = getelementptr double, ptr %vel, i32 %t35
  %t37 = load double, ptr %t36
  %t38 = fptrunc double %t37 to float
  %t39 = load i32, ptr %a1
  %t40 = getelementptr float, ptr %a10, i32 %t39
  store float %t38, ptr %t40
  %t41 = load i32, ptr %a1
  %t42 = add i32 %t41, 1
  store i32 %t42, ptr %a1
  br label %lc3
le5:
  call void @sph_gpu(ptr %a5, ptr %a6, ptr %a7, ptr %a8, ptr %a9, ptr %a10, ptr %a11, ptr %a12, ptr %a13, ptr %a14, i32 1000, float 0x3F847AE140000000, float 0x3FB99999A0000000, float 0x41A7586A60000000, float 0x4069000000000000, float 0x408F400000000000, float 0x413B521D20000000, float 0x41547D95E0000000, float 0xC0239999A0000000)
  store i32 0, ptr %a1
  br label %lc6
lc6:
  %t43 = load i32, ptr %a1
  %t44 = icmp slt i32 %t43, 1000
  br i1 %t44, label %lb7, label %le8
lb7:
  %t45 = load i32, ptr %a1
  %t46 = mul i32 %t45, 3
  %t47 = load i32, ptr %a1
  %t48 = getelementptr float, ptr %a11, i32 %t47
  %t49 = load float, ptr %t48
  %t50 = fpext float %t49 to double
  %t51 = load i32, ptr %a1
  %t52 = getelementptr double, ptr %rho, i32 %t51
  store double %t50, ptr %t52
  %t53 = load i32, ptr %a1
  %t54 = getelementptr float, ptr %a12, i32 %t53
  %t55 = load float, ptr %t54
  %t56 = fpext float %t55 to double
  %t57 = getelementptr double, ptr %acc, i32 %t46
  store double %t56, ptr %t57
  %t58 = load i32, ptr %a1
  %t59 = getelementptr float, ptr %a13, i32 %t58
  %t60 = load float, ptr %t59
  %t61 = fpext float %t60 to double
  %t62 = add i32 %t46, 1
  %t63 = getelementptr double, ptr %acc, i32 %t62
  store double %t61, ptr %t63
  %t64 = load i32, ptr %a1
  %t65 = getelementptr float, ptr %a14, i32 %t64
  %t66 = load float, ptr %t65
  %t67 = fpext float %t66 to double
  %t68 = add i32 %t46, 2
  %t69 = getelementptr double, ptr %acc, i32 %t68
  store double %t67, ptr %t69
  %t70 = load i32, ptr %a1
  %t71 = add i32 %t70, 1
  store i32 %t71, ptr %a1
  br label %lc6
le8:
  call void @cl_check()
  br label %endif2
endif2:
  %t72 = icmp eq i32 %t1, 0
  br i1 %t72, label %then9, label %endif10
then9:
  store i32 0, ptr %a1
  br label %lc11
lc11:
  %t73 = load i32, ptr %a1
  %t74 = icmp slt i32 %t73, 1000
  br i1 %t74, label %lb12, label %le13
lb12:
  store double 0x0000000000000000, ptr %a4
  %t75 = load i32, ptr %a1
  %t76 = mul i32 %t75, 3
  store i32 0, ptr %a2
  br label %lc14
lc14:
  %t77 = load i32, ptr %a2
  %t78 = icmp slt i32 %t77, 1000
  br i1 %t78, label %lb15, label %le16
lb15:
  %t79 = load i32, ptr %a2
  %t80 = mul i32 %t79, 3
  %t81 = getelementptr double, ptr %pos, i32 %t76
  %t82 = load double, ptr %t81
  %t83 = getelementptr double, ptr %pos, i32 %t80
  %t84 = load double, ptr %t83
  %t85 = fsub double %t82, %t84
  %t86 = add i32 %t76, 1
  %t87 = getelementptr double, ptr %pos, i32 %t86
  %t88 = load double, ptr %t87
  %t89 = add i32 %t80, 1
  %t90 = getelementptr double, ptr %pos, i32 %t89
  %t91 = load double, ptr %t90
  %t92 = fsub double %t88, %t91
  %t93 = add i32 %t76, 2
  %t94 = getelementptr double, ptr %pos, i32 %t93
  %t95 = load double, ptr %t94
  %t96 = add i32 %t80, 2
  %t97 = getelementptr double, ptr %pos, i32 %t96
  %t98 = load double, ptr %t97
  %t99 = fsub double %t95, %t98
  %t100 = fmul double %t85, %t85
  %t101 = fmul double %t92, %t92
  %t102 = fadd double %t100, %t101
  %t103 = fmul double %t99, %t99
  %t104 = fadd double %t102, %t103
  %t105 = fsub double 0x3F847AE147AE147C, %t104
  %t106 = fcmp ogt double %t105, 0x0000000000000000
  br i1 %t106, label %then17, label %endif18
then17:
  %t107 = fmul double %t105, %t105
  %t108 = fmul double %t107, %t105
  %t109 = load double, ptr %a4
  %t110 = fadd double %t109, %t108
  store double %t110, ptr %a4
  br label %endif18
endif18:
  %t111 = load i32, ptr %a2
  %t112 = add i32 %t111, 1
  store i32 %t112, ptr %a2
  br label %lc14
le16:
  %t113 = load double, ptr %a4
  %t114 = fmul double %t113, 0x41A7586A5FC3E4E0
  %t115 = load i32, ptr %a1
  %t116 = getelementptr double, ptr %rho, i32 %t115
  store double %t114, ptr %t116
  %t117 = load i32, ptr %a1
  %t118 = getelementptr double, ptr %rho, i32 %t117
  %t119 = load double, ptr %t118
  %t120 = fsub double %t119, 0x408F400000000000
  %t121 = fmul double %t120, 0x4069000000000000
  %t122 = fcmp ogt double %t121, 0x0000000000000000
  %t123 = select i1 %t122, double %t121, double 0x0000000000000000
  %t124 = load i32, ptr %a1
  %t125 = getelementptr double, ptr %prs, i32 %t124
  store double %t123, ptr %t125
  %t126 = load i32, ptr %a1
  %t127 = add i32 %t126, 1
  store i32 %t127, ptr %a1
  br label %lc11
le13:
  store double 0x0000000000000000, ptr %a15
  store double 0x0000000000000000, ptr %a16
  store double 0x0000000000000000, ptr %a17
  store i32 0, ptr %a1
  br label %lc19
lc19:
  %t128 = load i32, ptr %a1
  %t129 = icmp slt i32 %t128, 1000
  br i1 %t129, label %lb20, label %le21
lb20:
  store double 0x0000000000000000, ptr %a15
  store double 0x0000000000000000, ptr %a16
  store double 0x0000000000000000, ptr %a17
  %t130 = load i32, ptr %a1
  %t131 = mul i32 %t130, 3
  store i32 0, ptr %a2
  br label %lc22
lc22:
  %t132 = load i32, ptr %a2
  %t133 = icmp slt i32 %t132, 1000
  br i1 %t133, label %lb23, label %le24
lb23:
  %t134 = load i32, ptr %a2
  %t135 = mul i32 %t134, 3
  %t136 = getelementptr double, ptr %pos, i32 %t131
  %t137 = load double, ptr %t136
  %t138 = getelementptr double, ptr %pos, i32 %t135
  %t139 = load double, ptr %t138
  %t140 = fsub double %t137, %t139
  %t141 = add i32 %t131, 1
  %t142 = getelementptr double, ptr %pos, i32 %t141
  %t143 = load double, ptr %t142
  %t144 = add i32 %t135, 1
  %t145 = getelementptr double, ptr %pos, i32 %t144
  %t146 = load double, ptr %t145
  %t147 = fsub double %t143, %t146
  %t148 = add i32 %t131, 2
  %t149 = getelementptr double, ptr %pos, i32 %t148
  %t150 = load double, ptr %t149
  %t151 = add i32 %t135, 2
  %t152 = getelementptr double, ptr %pos, i32 %t151
  %t153 = load double, ptr %t152
  %t154 = fsub double %t150, %t153
  %t155 = fmul double %t140, %t140
  %t156 = fmul double %t147, %t147
  %t157 = fadd double %t155, %t156
  %t158 = fmul double %t154, %t154
  %t159 = fadd double %t157, %t158
  %t160 = fcmp olt double %t159, 0x3F847AE147AE147C
  %t161 = fcmp ogt double %t159, 0x3D719799812DEA11
  %t162 = and i1 %t160, %t161
  br i1 %t162, label %then25, label %endif26
then25:
  %t163 = call double @sqrt(double %t159)
  %t164 = fsub double 0x3FB999999999999A, %t163
  %t165 = load i32, ptr %a1
  %t166 = getelementptr double, ptr %prs, i32 %t165
  %t167 = load double, ptr %t166
  %t168 = load i32, ptr %a2
  %t169 = getelementptr double, ptr %prs, i32 %t168
  %t170 = load double, ptr %t169
  %t171 = fadd double %t167, %t170
  %t172 = load i32, ptr %a2
  %t173 = getelementptr double, ptr %rho, i32 %t172
  %t174 = load double, ptr %t173
  %t175 = fmul double %t174, 0x4000000000000000
  %t176 = fdiv double %t171, %t175
  %t177 = fmul double %t164, %t164
  %t178 = fdiv double %t177, %t163
  %t179 = fmul double %t176, %t178
  %t180 = fmul double %t179, 0x413B521D1C1ACAE7
  %t181 = fmul double %t140, %t180
  %t182 = load double, ptr %a15
  %t183 = fadd double %t182, %t181
  store double %t183, ptr %a15
  %t184 = fmul double %t147, %t180
  %t185 = load double, ptr %a16
  %t186 = fadd double %t185, %t184
  store double %t186, ptr %a16
  %t187 = fmul double %t154, %t180
  %t188 = load double, ptr %a17
  %t189 = fadd double %t188, %t187
  store double %t189, ptr %a17
  %t190 = load i32, ptr %a2
  %t191 = getelementptr double, ptr %rho, i32 %t190
  %t192 = load double, ptr %t191
  %t193 = fdiv double %t164, %t192
  %t194 = fmul double %t193, 0x41547D95D514182D
  %t195 = getelementptr double, ptr %vel, i32 %t135
  %t196 = load double, ptr %t195
  %t197 = getelementptr double, ptr %vel, i32 %t131
  %t198 = load double, ptr %t197
  %t199 = fsub double %t196, %t198
  %t200 = fmul double %t199, %t194
  %t201 = load double, ptr %a15
  %t202 = fadd double %t201, %t200
  store double %t202, ptr %a15
  %t203 = add i32 %t135, 1
  %t204 = getelementptr double, ptr %vel, i32 %t203
  %t205 = load double, ptr %t204
  %t206 = add i32 %t131, 1
  %t207 = getelementptr double, ptr %vel, i32 %t206
  %t208 = load double, ptr %t207
  %t209 = fsub double %t205, %t208
  %t210 = fmul double %t209, %t194
  %t211 = load double, ptr %a16
  %t212 = fadd double %t211, %t210
  store double %t212, ptr %a16
  %t213 = add i32 %t135, 2
  %t214 = getelementptr double, ptr %vel, i32 %t213
  %t215 = load double, ptr %t214
  %t216 = add i32 %t131, 2
  %t217 = getelementptr double, ptr %vel, i32 %t216
  %t218 = load double, ptr %t217
  %t219 = fsub double %t215, %t218
  %t220 = fmul double %t219, %t194
  %t221 = load double, ptr %a17
  %t222 = fadd double %t221, %t220
  store double %t222, ptr %a17
  br label %endif26
endif26:
  %t223 = load i32, ptr %a2
  %t224 = add i32 %t223, 1
  store i32 %t224, ptr %a2
  br label %lc22
le24:
  %t225 = load i32, ptr %a1
  %t226 = getelementptr double, ptr %rho, i32 %t225
  %t227 = load double, ptr %t226
  %t228 = fdiv double 0x3FF0000000000000, %t227
  %t229 = load double, ptr %a15
  %t230 = fmul double %t229, %t228
  %t231 = getelementptr double, ptr %acc, i32 %t131
  store double %t230, ptr %t231
  %t232 = load double, ptr %a16
  %t233 = fmul double %t232, %t228
  %t234 = fadd double %t233, 0xC02399999999999A
  %t235 = add i32 %t131, 1
  %t236 = getelementptr double, ptr %acc, i32 %t235
  store double %t234, ptr %t236
  %t237 = load double, ptr %a17
  %t238 = fmul double %t237, %t228
  %t239 = add i32 %t131, 2
  %t240 = getelementptr double, ptr %acc, i32 %t239
  store double %t238, ptr %t240
  %t241 = load i32, ptr %a1
  %t242 = add i32 %t241, 1
  store i32 %t242, ptr %a1
  br label %lc19
le21:
  br label %endif10
endif10:
  store i32 0, ptr %a1
  br label %lc27
lc27:
  %t243 = load i32, ptr %a1
  %t244 = icmp slt i32 %t243, 1000
  br i1 %t244, label %lb28, label %le29
lb28:
  store i32 0, ptr %a3
  br label %lc30
lc30:
  %t245 = load i32, ptr %a3
  %t246 = icmp slt i32 %t245, 3
  br i1 %t246, label %lb31, label %le32
lb31:
  %t247 = load i32, ptr %a1
  %t248 = mul i32 %t247, 3
  %t249 = load i32, ptr %a3
  %t250 = add i32 %t248, %t249
  %t251 = getelementptr double, ptr %vel, i32 %t250
  %t252 = load double, ptr %t251
  %t253 = getelementptr double, ptr %acc, i32 %t250
  %t254 = load double, ptr %t253
  %t255 = fmul double %t254, 0x3F689374BC6A7EFA
  %t256 = fadd double %t252, %t255
  %t257 = getelementptr double, ptr %vel, i32 %t250
  store double %t256, ptr %t257
  %t258 = getelementptr double, ptr %pos, i32 %t250
  %t259 = load double, ptr %t258
  %t260 = getelementptr double, ptr %vel, i32 %t250
  %t261 = load double, ptr %t260
  %t262 = fmul double %t261, 0x3F689374BC6A7EFA
  %t263 = fadd double %t259, %t262
  %t264 = getelementptr double, ptr %pos, i32 %t250
  store double %t263, ptr %t264
  %t265 = getelementptr double, ptr %pos, i32 %t250
  %t266 = load double, ptr %t265
  %t267 = fcmp olt double %t266, 0x3F947AE147AE147B
  br i1 %t267, label %then33, label %endif34
then33:
  %t268 = getelementptr double, ptr %pos, i32 %t250
  store double 0x3F947AE147AE147B, ptr %t268
  %t269 = getelementptr double, ptr %vel, i32 %t250
  %t270 = load double, ptr %t269
  %t271 = fmul double %t270, 0xBFD3333333333333
  %t272 = getelementptr double, ptr %vel, i32 %t250
  store double %t271, ptr %t272
  br label %endif34
endif34:
  %t273 = getelementptr double, ptr %pos, i32 %t250
  %t274 = load double, ptr %t273
  %t275 = fcmp ogt double %t274, 0x3FEF5C28F5C28F5C
  br i1 %t275, label %then35, label %endif36
then35:
  %t276 = getelementptr double, ptr %pos, i32 %t250
  store double 0x3FEF5C28F5C28F5C, ptr %t276
  %t277 = getelementptr double, ptr %vel, i32 %t250
  %t278 = load double, ptr %t277
  %t279 = fmul double %t278, 0xBFD3333333333333
  %t280 = getelementptr double, ptr %vel, i32 %t250
  store double %t279, ptr %t280
  br label %endif36
endif36:
  %t281 = load i32, ptr %a3
  %t282 = add i32 %t281, 1
  store i32 %t282, ptr %a3
  br label %lc30
le32:
  %t283 = load i32, ptr %a1
  %t284 = add i32 %t283, 1
  store i32 %t284, ptr %a1
  br label %lc27
le29:
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
  %t56 = call i32 @cl_mode()
  %t57 = call i32 @cl_fb()
  %t58 = icmp eq i32 %t56, 0
  br i1 %t58, label %then4, label %endif5
then4:
  %t59 = icmp eq i32 %t57, 0
  br i1 %t59, label %then6, label %endif7
then6:
  %t60 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a2, i64 160, ptr @.s1, i32 1000, i32 %step_no)
  br label %endif7
endif7:
  %t61 = icmp ne i32 %t57, 0
  br i1 %t61, label %then8, label %endif9
then8:
  %t62 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a2, i64 160, ptr @.s2, i32 1000, i32 %step_no)
  br label %endif9
endif9:
  br label %endif5
endif5:
  %t63 = icmp ne i32 %t56, 0
  br i1 %t63, label %then10, label %endif11
then10:
  %t64 = call i32 @fa_cl_backend()
  %t65 = icmp eq i32 %t64, 1
  br i1 %t65, label %then12, label %endif13
then12:
  %t66 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a2, i64 160, ptr @.s3, i32 1000, i32 %step_no)
  br label %endif13
endif13:
  %t67 = icmp eq i32 %t64, 3
  br i1 %t67, label %then14, label %endif15
then14:
  %t68 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a2, i64 160, ptr @.s4, i32 1000, i32 %step_no)
  br label %endif15
endif15:
  %t69 = icmp eq i32 %t64, 2
  br i1 %t69, label %then16, label %endif17
then16:
  %t70 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a2, i64 160, ptr @.s5, i32 1000, i32 %step_no)
  br label %endif17
endif17:
  %t71 = icmp eq i32 %t64, 0
  br i1 %t71, label %then18, label %endif19
then18:
  %t72 = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %a2, i64 160, ptr @.s6, i32 1000, i32 %step_no)
  br label %endif19
endif19:
  br label %endif11
endif11:
  call void @text(ptr %a2, i32 5, i32 5)
  call void @text(ptr @.s7, i32 5, i32 25)
  call void @glEnd()
  %t73 = call i32 @cl_mode()
  call void @glBegin(i32 7)
  %t74 = icmp eq i32 %t73, 0
  %t75 = icmp ne i32 %t73, 0
  %t76 = select i1 %t74, float 0x3FBEB851E0000000, float 0x3FC851EB80000000
  %t77 = select i1 %t74, float 0x3FDEB851E0000000, float 0x3FC851EB80000000
  %t78 = select i1 %t74, float 0x3FBEB851E0000000, float 0x3FC851EB80000000
  call void @glColor3f(float %t76, float %t77, float %t78)
  call void @glVertex2f(float 0x407D600000000000, float 0x407B800000000000)
  call void @glVertex2f(float 0x4080400000000000, float 0x407B800000000000)
  call void @glVertex2f(float 0x4080400000000000, float 0x407CC00000000000)
  call void @glVertex2f(float 0x407D600000000000, float 0x407CC00000000000)
  %t79 = select i1 %t75, float 0x3FBEB851E0000000, float 0x3FC851EB80000000
  %t80 = select i1 %t75, float 0x3FDEB851E0000000, float 0x3FC851EB80000000
  %t81 = select i1 %t75, float 0x3FBEB851E0000000, float 0x3FC851EB80000000
  call void @glColor3f(float %t79, float %t80, float %t81)
  call void @glVertex2f(float 0x4080900000000000, float 0x407B800000000000)
  call void @glVertex2f(float 0x4082200000000000, float 0x407B800000000000)
  call void @glVertex2f(float 0x4082200000000000, float 0x407CC00000000000)
  call void @glVertex2f(float 0x4080900000000000, float 0x407CC00000000000)
  call void @glEnd()
  call void @glBegin(i32 0)
  call void @glColor3f(float 0x3FF0000000000000, float 0x3FF0000000000000, float 0x3FF0000000000000)
  call void @text(ptr @.s8, i32 482, i32 444)
  call void @text(ptr @.s9, i32 542, i32 444)
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
  %t6 = call ptr @SDL_CreateWindow(ptr @.s10, i32 805240832, i32 805240832, i32 640, i32 480, i32 2)
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
  %t25 = getelementptr i8, ptr %a6, i32 20
  %t26 = load i32, ptr %t25
  %t27 = getelementptr i8, ptr %a6, i32 24
  %t28 = load i32, ptr %t27
  %t29 = icmp sge i32 %t26, 470
  %t30 = icmp slt i32 %t26, 520
  %t31 = and i1 %t29, %t30
  %t32 = icmp sge i32 %t28, 440
  %t33 = and i1 %t31, %t32
  %t34 = icmp slt i32 %t28, 460
  %t35 = and i1 %t33, %t34
  br i1 %t35, label %then25, label %endif26
then25:
  call void @cl_set_mode(i32 0)
  br label %endif26
endif26:
  %t36 = icmp sge i32 %t26, 530
  %t37 = icmp slt i32 %t26, 580
  %t38 = and i1 %t36, %t37
  %t39 = icmp sge i32 %t28, 440
  %t40 = and i1 %t38, %t39
  %t41 = icmp slt i32 %t28, 460
  %t42 = and i1 %t40, %t41
  br i1 %t42, label %then27, label %endif28
then27:
  call void @cl_set_mode(i32 1)
  br label %endif28
endif28:
  %t43 = icmp sge i32 %t26, 470
  %t44 = icmp slt i32 %t26, 520
  %t45 = and i1 %t43, %t44
  %t46 = icmp sge i32 %t28, 440
  %t47 = and i1 %t45, %t46
  %t48 = icmp slt i32 %t28, 460
  %t49 = and i1 %t47, %t48
  %t50 = icmp sge i32 %t26, 530
  %t51 = icmp slt i32 %t26, 580
  %t52 = and i1 %t50, %t51
  %t53 = icmp sge i32 %t28, 440
  %t54 = and i1 %t52, %t53
  %t55 = icmp slt i32 %t28, 460
  %t56 = and i1 %t54, %t55
  %t57 = or i1 %t49, %t56
  %t58 = icmp eq i1 %t57, false
  br i1 %t58, label %then29, label %endif30
then29:
  store i32 1, ptr %a10
  br label %endif30
endif30:
  br label %endif24
endif24:
  %t59 = icmp eq i32 %t13, 1026
  br i1 %t59, label %then31, label %endif32
then31:
  store i32 0, ptr %a10
  br label %endif32
endif32:
  %t60 = icmp eq i32 %t13, 1024
  %t61 = load i32, ptr %a10
  %t62 = icmp ne i32 %t61, 0
  %t63 = and i1 %t60, %t62
  br i1 %t63, label %then33, label %endif34
then33:
  %t64 = getelementptr i8, ptr %a6, i32 28
  %t65 = load i32, ptr %t64
  %t66 = sitofp i32 %t65 to double
  %t67 = fmul double %t66, 0x3FD999999999999A
  %t68 = load double, ptr %a12
  %t69 = fadd double %t68, %t67
  store double %t69, ptr %a12
  %t70 = getelementptr i8, ptr %a6, i32 32
  %t71 = load i32, ptr %t70
  %t72 = sitofp i32 %t71 to double
  %t73 = fmul double %t72, 0x3FD999999999999A
  %t74 = load double, ptr %a13
  %t75 = fadd double %t74, %t73
  store double %t75, ptr %a13
  br label %endif34
endif34:
  %t76 = icmp eq i32 %t13, 1027
  br i1 %t76, label %then35, label %endif36
then35:
  %t77 = getelementptr i8, ptr %a6, i32 20
  %t78 = load i32, ptr %t77
  %t79 = sitofp i32 %t78 to double
  %t80 = fsub double 0x0000000000000000, %t79
  %t81 = fmul double %t80, 0x3FC3333333333333
  %t82 = load double, ptr %a14
  %t83 = fadd double %t82, %t81
  store double %t83, ptr %a14
  %t84 = load double, ptr %a14
  %t85 = fcmp olt double %t84, 0x3FE999999999999A
  br i1 %t85, label %then37, label %endif38
then37:
  store double 0x3FE999999999999A, ptr %a14
  br label %endif38
endif38:
  br label %endif36
endif36:
  br label %wc8
we10:
  %t86 = load i32, ptr %a11
  %t87 = icmp ne i32 %t86, 0
  br i1 %t87, label %then39, label %endif40
then39:
  store i32 0, ptr %a17
  br label %lc41
lc41:
  %t88 = load i32, ptr %a17
  %t89 = icmp slt i32 %t88, 1000
  br i1 %t89, label %lb42, label %le43
lb42:
  %t90 = load i32, ptr %a17
  %t91 = mul i32 %t90, 3
  %t92 = getelementptr double, ptr %a2, i32 %t91
  %t93 = load double, ptr %t92
  %t94 = fadd double %t93, 0x4004000000000000
  %t95 = load i32, ptr %a17
  %t96 = mul i32 %t95, 3
  %t97 = getelementptr double, ptr %a2, i32 %t96
  store double %t94, ptr %t97
  %t98 = load i32, ptr %a17
  %t99 = add i32 %t98, 1
  store i32 %t99, ptr %a17
  br label %lc41
le43:
  store i32 0, ptr %a11
  br label %endif40
endif40:
  %t100 = load i32, ptr %a15
  %t101 = icmp eq i32 %t100, 0
  br i1 %t101, label %then44, label %endif45
then44:
  call void @step(ptr %a1, ptr %a2, ptr %a3, ptr %a4, ptr %a5)
  %t102 = load i32, ptr %a16
  %t103 = add i32 %t102, 1
  store i32 %t103, ptr %a16
  br label %endif45
endif45:
  %t104 = load double, ptr %a12
  %t105 = load double, ptr %a13
  %t106 = load double, ptr %a14
  %t107 = load i32, ptr %a16
  call void @draw(ptr %a1, ptr %a2, double %t104, double %t105, double %t106, i32 %t107)
  call void @SDL_GL_SwapWindow(ptr %t6)
  call void @SDL_Delay(i32 16)
  %t108 = load i32, ptr %a8
  %t109 = add i32 %t108, 1
  store i32 %t109, ptr %a8
  %t110 = load i32, ptr %a9
  %t111 = icmp sgt i32 %t110, 0
  %t112 = load i32, ptr %a8
  %t113 = load i32, ptr %a9
  %t114 = icmp sge i32 %t112, %t113
  %t115 = and i1 %t111, %t114
  br i1 %t115, label %then46, label %endif47
then46:
  store i32 0, ptr %a7
  br label %endif47
endif47:
  br label %wc5
we7:
  store double 0x0000000000000000, ptr %a18
  store i32 0, ptr %a17
  br label %lc48
lc48:
  %t116 = load i32, ptr %a17
  %t117 = icmp slt i32 %t116, 1000
  br i1 %t117, label %lb49, label %le50
lb49:
  %t118 = load i32, ptr %a17
  %t119 = mul i32 %t118, 3
  %t120 = add i32 %t119, 1
  %t121 = getelementptr double, ptr %a1, i32 %t120
  %t122 = load double, ptr %t121
  %t123 = load double, ptr %a18
  %t124 = fadd double %t123, %t122
  store double %t124, ptr %a18
  %t125 = load i32, ptr %a17
  %t126 = add i32 %t125, 1
  store i32 %t126, ptr %a17
  br label %lc48
le50:
  %t127 = load i32, ptr %a8
  %t128 = load double, ptr %a18
  %t129 = fdiv double %t128, 0x408F400000000000
  %t130 = call i32 (ptr, ...) @printf(ptr @.s11, i32 %t127, i32 1000, double %t129)
  call void @SDL_GL_DeleteContext(ptr %t7)
  call void @SDL_DestroyWindow(ptr %t6)
  call void @SDL_Quit()
  ret i32 0
}

