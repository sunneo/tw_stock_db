; OpenCL 與 OpenGL 的標準互通（cl_khr_gl_sharing）：OpenCL 核心每幀把點的位置寫進一個「與 OpenGL 共享」的頂點緩衝區，
; OpenGL 用 glDrawArrays(GL_POINTS) 直接畫它。全部都是標準呼叫，沒有任何框架專屬函式：
;   glGenBuffers／glBindBuffer／glBufferData → clCreateFromGLBuffer → 每幀 clEnqueueAcquireGLObjects／NDRange／clEnqueueReleaseGLObjects → glVertexPointer／glDrawArrays
; 這份檔案是給你抄用與驗證的參考：照標準寫就對，加速由執行期（框架）自己偵測模式去做，你不用改寫。
; 用法：lli interop_cl_gl.ll [點數=4096] [跑幾幀後結束=0（不結束）]    Esc 或關視窗離開
; 驗證輸出：結束時印 "interop OK frames=<幀數> n=<點數> checksum=<小數>"；checksum 是最後一幀位置讀回的總和（標準的 clEnqueueReadBuffer，只做一次，不影響每幀的路徑）。
target triple = "x86_64-pc-linux-gnu"

@title = private constant [22 x i8] c"OpenCL-OpenGL interop\00"
@kname = private constant [5 x i8] c"wave\00"
@src = private constant [290 x i8] c"__kernel void wave(__global float* v, float t, int n) {\0A  int i = get_global_id(0);\0A  if (i < n * 3) {\0A    int p = i / 3;\0A    int c = i - p * 3;\0A    float a = p * 0.0613f;\0A    float w = c == 0 ? a * 3.0f + t : (c == 1 ? a * 2.0f + t * 1.3f : a + t * 0.7f);\0A    v[i] = 0.8f * sin(w);\0A  }\0A}\0A\00"
@fmt_ok = private constant [47 x i8] c"interop OK frames=%d n=%d checksum=%.3f\0A\00\00\00\00\00\00\00"
@fmt_bad = private constant [38 x i8] c"interop FAILED (code %d)\0A\00\00\00\00\00\00\00\00\00\00\00\00\00"

declare i32 @printf(ptr, ...)
declare i32 @atoi(ptr)
declare i32 @SDL_Init(i32)
declare void @SDL_Quit()
declare ptr @SDL_CreateWindow(ptr, i32, i32, i32, i32, i32)
declare ptr @SDL_GL_CreateContext(ptr)
declare void @SDL_GL_SwapWindow(ptr)
declare void @SDL_GL_DeleteContext(ptr)
declare void @SDL_DestroyWindow(ptr)
declare i32 @SDL_PollEvent(ptr)
declare void @SDL_Delay(i32)
declare void @glClearColor(float, float, float, float)
declare void @glClear(i32)
declare void @glEnable(i32)
declare void @glBlendFunc(i32, i32)
declare void @glPointSize(float)
declare void @glColor3f(float, float, float)
declare void @glGenBuffers(i32, ptr)
declare void @glBindBuffer(i32, i32)
declare void @glBufferData(i32, i64, ptr, i32)
declare void @glEnableClientState(i32)
declare void @glVertexPointer(i32, i32, i32, ptr)
declare void @glDrawArrays(i32, i32, i32)
declare i32 @clGetPlatformIDs(i32, ptr, ptr)
declare i32 @clGetDeviceIDs(ptr, i64, i32, ptr, ptr)
declare ptr @clCreateContext(ptr, i32, ptr, ptr, ptr, ptr)
declare ptr @clCreateCommandQueue(ptr, ptr, i64, ptr)
declare ptr @clCreateFromGLBuffer(ptr, i64, i32, ptr)
declare ptr @clCreateProgramWithSource(ptr, i32, ptr, ptr, ptr)
declare i32 @clBuildProgram(ptr, i32, ptr, ptr, ptr, ptr)
declare ptr @clCreateKernel(ptr, ptr, ptr)
declare i32 @clSetKernelArg(ptr, i32, i64, ptr)
declare i32 @clEnqueueAcquireGLObjects(ptr, i32, ptr, i32, ptr, ptr)
declare i32 @clEnqueueReleaseGLObjects(ptr, i32, ptr, i32, ptr, ptr)
declare i32 @clEnqueueNDRangeKernel(ptr, ptr, i32, ptr, ptr, ptr, i32, ptr, ptr)
declare i32 @clEnqueueReadBuffer(ptr, ptr, i32, i64, i64, ptr, i32, ptr, ptr)
declare i32 @clFinish(ptr)
declare ptr @malloc(i32)

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %ev = alloca [56 x i8], align 8
  %n = alloca i32
  %max = alloca i32
  %frames = alloca i32
  %running = alloca i32
  %t = alloca float
  %vbo = alloca i32
  %plat = alloca ptr
  %dev = alloca ptr
  %err = alloca i32
  %memslot = alloca ptr
  %gs = alloca i64
  %nbytes = alloca i64
  store i32 4096, ptr %n
  store i32 0, ptr %max
  store i32 0, ptr %frames
  store i32 1, ptr %running
  store float 0.0, ptr %t
  %a1ok = icmp sgt i32 %argc, 1
  br i1 %a1ok, label %arg1, label %init
arg1:
  %ap1 = getelementptr ptr, ptr %argv, i32 1
  %s1 = load ptr, ptr %ap1
  %v1 = call i32 @atoi(ptr %s1)
  %v1ok = icmp sgt i32 %v1, 0
  %v1c = select i1 %v1ok, i32 %v1, i32 4096
  store i32 %v1c, ptr %n
  %a2ok = icmp sgt i32 %argc, 2
  br i1 %a2ok, label %arg2, label %init
arg2:
  %ap2 = getelementptr ptr, ptr %argv, i32 2
  %s2 = load ptr, ptr %ap2
  %v2 = call i32 @atoi(ptr %s2)
  store i32 %v2, ptr %max
  br label %init
init:
  call i32 @SDL_Init(i32 32)
  %win = call ptr @SDL_CreateWindow(ptr @title, i32 805240832, i32 805240832, i32 640, i32 480, i32 2)
  %ctx = call ptr @SDL_GL_CreateContext(ptr %win)
  %nv = load i32, ptr %n
  %nv64 = zext i32 %nv to i64
  %bytes = mul i64 %nv64, 12
  store i64 %bytes, ptr %nbytes
  ; ---- 標準 OpenGL：建立頂點緩衝區（內容由 OpenCL 填，所以資料指標給 NULL）
  call void @glGenBuffers(i32 1, ptr %vbo)
  %vb = load i32, ptr %vbo
  call void @glBindBuffer(i32 34962, i32 %vb)            ; GL_ARRAY_BUFFER
  call void @glBufferData(i32 34962, i64 %bytes, ptr null, i32 35048)   ; GL_DYNAMIC_DRAW
  ; ---- 標準 OpenCL：平台、裝置、上下文、佇列，並把 GL 緩衝區包成 CL 記憶體物件
  %r0 = call i32 @clGetPlatformIDs(i32 1, ptr %plat, ptr null)
  %pl = load ptr, ptr %plat
  %r1 = call i32 @clGetDeviceIDs(ptr %pl, i64 4294967295, i32 1, ptr %dev, ptr null)
  %c = call ptr @clCreateContext(ptr null, i32 1, ptr %dev, ptr null, ptr null, ptr %err)
  %d = load ptr, ptr %dev
  %q = call ptr @clCreateCommandQueue(ptr %c, ptr %d, i64 0, ptr %err)
  %mem = call ptr @clCreateFromGLBuffer(ptr %c, i64 1, i32 %vb, ptr %err)   ; CL_MEM_READ_WRITE
  store ptr %mem, ptr %memslot
  %e1 = load i32, ptr %err
  %srcp = alloca ptr
  store ptr @src, ptr %srcp
  %p = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %err)
  %bs = call i32 @clBuildProgram(ptr %p, i32 0, ptr null, ptr null, ptr null, ptr null)
  %k = call ptr @clCreateKernel(ptr %p, ptr @kname, ptr %err)
  %e2 = load i32, ptr %err
  %a0 = call i32 @clSetKernelArg(ptr %k, i32 0, i64 4, ptr %memslot)
  %nslot = alloca i32
  store i32 %nv, ptr %nslot
  %a2 = call i32 @clSetKernelArg(ptr %k, i32 2, i64 4, ptr %nslot)
  %n3 = mul i32 %nv, 3
  %n3l = zext i32 %n3 to i64
  store i64 %n3l, ptr %gs
  %bad0 = or i32 %e1, %e2
  %bad1 = or i32 %bad0, %bs
  %bad2 = or i32 %bad1, %a0
  %bad3 = or i32 %bad2, %a2
  %bad4 = or i32 %bad3, %r0
  %bad5 = or i32 %bad4, %r1
  %isbad = icmp ne i32 %bad5, 0
  br i1 %isbad, label %fail, label %events
events:
  %got = call i32 @SDL_PollEvent(ptr %ev)
  %has = icmp ne i32 %got, 0
  br i1 %has, label %handle, label %frame
handle:
  %type = load i32, ptr %ev
  %isq = icmp eq i32 %type, 256
  br i1 %isq, label %quit, label %c1
quit:
  store i32 0, ptr %running
  br label %events
c1:
  %iskey = icmp eq i32 %type, 768
  br i1 %iskey, label %key, label %events
key:
  %scp = getelementptr i8, ptr %ev, i32 16
  %sc = load i32, ptr %scp
  %esc = icmp eq i32 %sc, 41
  br i1 %esc, label %quit, label %events
frame:
  ; ---- 每幀：Acquire → 核心寫位置 → Release（標準寫法）
  %tv = load float, ptr %t
  %tslot = alloca float
  store float %tv, ptr %tslot
  %sa1 = call i32 @clSetKernelArg(ptr %k, i32 1, i64 4, ptr %tslot)
  %acq = call i32 @clEnqueueAcquireGLObjects(ptr %q, i32 1, ptr %memslot, i32 0, ptr null, ptr null)
  %nd = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %k, i32 1, ptr null, ptr %gs, ptr null, i32 0, ptr null, ptr null)
  %rel = call i32 @clEnqueueReleaseGLObjects(ptr %q, i32 1, ptr %memslot, i32 0, ptr null, ptr null)
  %fin = call i32 @clFinish(ptr %q)
  %t2 = fadd float %tv, 0x3F947AE140000000
  store float %t2, ptr %t
  ; ---- 標準 OpenGL：用共享的緩衝區畫點（加法混合的發光點）
  call void @glClearColor(float 0.02, float 0.03, float 0.06, float 1.0)
  call void @glClear(i32 16384)
  call void @glEnable(i32 3042)                          ; GL_BLEND
  call void @glBlendFunc(i32 770, i32 1)                 ; GL_SRC_ALPHA, GL_ONE
  call void @glPointSize(float 6.0)
  call void @glColor3f(float 0.4, float 0.7, float 1.0)
  call void @glBindBuffer(i32 34962, i32 %vb)
  call void @glEnableClientState(i32 32884)              ; GL_VERTEX_ARRAY
  call void @glVertexPointer(i32 3, i32 5126, i32 0, ptr null)   ; 3 個 GL_FLOAT，緊密排列，從緩衝區開頭
  call void @glDrawArrays(i32 0, i32 0, i32 %nv)         ; GL_POINTS
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
  ; ---- 驗證用：把共享緩衝區讀回主機算總和（標準的 clEnqueueReadBuffer，結束時只做一次）
  %bytes32 = trunc i64 %bytes to i32
  %host = call ptr @malloc(i32 %bytes32)
  %rd = call i32 @clEnqueueReadBuffer(ptr %q, ptr %mem, i32 1, i64 0, i64 %bytes, ptr %host, i32 0, ptr null, ptr null)
  %sum = alloca double
  %idx = alloca i32
  store double 0.0, ptr %sum
  store i32 0, ptr %idx
  br label %sumloop
sumloop:
  %ii = load i32, ptr %idx
  %more = icmp slt i32 %ii, %n3
  br i1 %more, label %sumbody, label %sumdone
sumbody:
  %fp = getelementptr float, ptr %host, i32 %ii
  %fv = load float, ptr %fp
  %fd = fpext float %fv to double
  %sv = load double, ptr %sum
  %sn = fadd double %sv, %fd
  store double %sn, ptr %sum
  %ii1 = add i32 %ii, 1
  store i32 %ii1, ptr %idx
  br label %sumloop
sumdone:
  %total = load double, ptr %sum
  %fr = load i32, ptr %frames
  call i32 (ptr, ...) @printf(ptr @fmt_ok, i32 %fr, i32 %nv, double %total)
  call void @SDL_GL_DeleteContext(ptr %ctx)
  call void @SDL_DestroyWindow(ptr %win)
  call void @SDL_Quit()
  ret i32 0
fail:
  call i32 (ptr, ...) @printf(ptr @fmt_bad, i32 %bad5)
  ret i32 1
}
