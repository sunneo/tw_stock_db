; OpenCL 向量相加（GPGPU）：c[i] = a[i] + b[i]，N 個 float（預設 1048576，可由第一個參數指定），用 OpenCL C 核心字串在執行時編譯。
; 流程：平台 → 裝置（GPU 優先、沒有就 CPU）→ context → queue → program（編譯核心）→ kernel → buffer → 執行 → 讀回 → 驗證。
; 在 run terminal／job 的模擬環境：OpenCL 由 renderer/src/uml/llvm_host.js 的 CPU 後備提供（核心字串用 JS 執行，不需要 GPU 或驅動）。
; 真機器（有 OpenCL 驅動）：clang／lli 照常連結 libOpenCL，同一份 IR 直接跑。建置：見 ../README.md。
; 注意：本墊片的核心只支援簡單子集（見 DESIGN.run-terminal.md §21）；這個範例的核心（get_global_id＋算術＋if）在子集內。
target triple = "x86_64-pc-linux-gnu"

@src = private constant [136 x i8] c"__kernel void vadd(__global const float*a,__global const float*b,__global float*c,int n){int i=get_global_id(0);if(i<n)c[i]=a[i]+b[i];}\00"
@name = private constant [5 x i8] c"vadd\00"
@ok = private constant [20 x i8] c"vadd OK, n=%d c=%f\0A\00"
@bad = private constant [26 x i8] c"vadd MISMATCH at %d: %f\0A\00\00"
@err = private constant [22 x i8] c"OpenCL error %d at %d\00"
@errnl = private constant [2 x i8] c"\0A\00"

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
declare i32 @clFinish(ptr)
declare ptr @malloc(i32)
declare i32 @atoi(ptr)
declare i32 @printf(ptr, ...)

define i32 @fail(i32 %code, i32 %where) {
  call i32 (ptr, ...) @printf(ptr @err, i32 %code, i32 %where)
  call i32 (ptr, ...) @printf(ptr @errnl)
  ret i32 1
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %plat = alloca ptr
  %dev = alloca ptr
  %rc = alloca i32
  %n = alloca i32
  %gsz = alloca i64
  %srcp = alloca ptr
  %dbuf = alloca ptr
  %da = alloca ptr
  %db = alloca ptr
  %dc = alloca ptr
  %iv = alloca i32
  %jv = alloca i32
  store i32 1048576, ptr %n
  %many = icmp sgt i32 %argc, 1
  br i1 %many, label %getn, label %platform
getn:
  %ap = getelementptr ptr, ptr %argv, i32 1
  %a1 = load ptr, ptr %ap
  %v = call i32 @atoi(ptr %a1)
  store i32 %v, ptr %n
  br label %platform
platform:
  %r1 = call i32 @clGetPlatformIDs(i32 1, ptr %plat, ptr null)
  %e1 = icmp ne i32 %r1, 0
  br i1 %e1, label %f1, label %device
f1:
  %x1 = call i32 @fail(i32 %r1, i32 1)
  ret i32 %x1
device:
  %p = load ptr, ptr %plat
  %r2 = call i32 @clGetDeviceIDs(ptr %p, i64 4, i32 1, ptr %dev, ptr null)      ; CL_DEVICE_TYPE_GPU
  %e2 = icmp ne i32 %r2, 0
  br i1 %e2, label %cpu, label %ctx
cpu:
  %r2b = call i32 @clGetDeviceIDs(ptr %p, i64 2, i32 1, ptr %dev, ptr null)     ; 退回 CL_DEVICE_TYPE_CPU
  %e2b = icmp ne i32 %r2b, 0
  br i1 %e2b, label %f2, label %ctx
f2:
  %x2 = call i32 @fail(i32 %r2b, i32 2)
  ret i32 %x2
ctx:
  %c = call ptr @clCreateContext(ptr null, i32 1, ptr %dev, ptr null, ptr null, ptr %rc)
  %d = load ptr, ptr %dev
  %q = call ptr @clCreateCommandQueue(ptr %c, ptr %d, i64 0, ptr %rc)
  store ptr @src, ptr %srcp
  %prog = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %rc)
  %r3 = call i32 @clBuildProgram(ptr %prog, i32 1, ptr %dev, ptr null, ptr null, ptr null)
  %e3 = icmp ne i32 %r3, 0
  br i1 %e3, label %f3, label %kern
f3:
  %x3 = call i32 @fail(i32 %r3, i32 3)
  ret i32 %x3
kern:
  %k = call ptr @clCreateKernel(ptr %prog, ptr @name, ptr %rc)
  %nn = load i32, ptr %n
  %n64 = sext i32 %nn to i64
  %bytes = mul i64 %n64, 4
  %b32 = trunc i64 %bytes to i32
  %ha = call ptr @malloc(i32 %b32)
  %hb = call ptr @malloc(i32 %b32)
  %hc = call ptr @malloc(i32 %b32)
  store i32 0, ptr %iv
  br label %fill
fill:
  %i = load i32, ptr %iv
  %more = icmp slt i32 %i, %nn
  br i1 %more, label %fillbody, label %bufs
fillbody:
  %fi = sitofp i32 %i to float
  %pa = getelementptr float, ptr %ha, i32 %i
  %pb = getelementptr float, ptr %hb, i32 %i
  store float %fi, ptr %pa
  %fb = fmul float %fi, 0x4000000000000000
  store float %fb, ptr %pb
  %i1 = add i32 %i, 1
  store i32 %i1, ptr %iv
  br label %fill
bufs:
  %ba = call ptr @clCreateBuffer(ptr %c, i64 36, i64 %bytes, ptr %ha, ptr %rc)    ; READ_ONLY|COPY_HOST_PTR
  %bb = call ptr @clCreateBuffer(ptr %c, i64 36, i64 %bytes, ptr %hb, ptr %rc)
  %bc = call ptr @clCreateBuffer(ptr %c, i64 2, i64 %bytes, ptr null, ptr %rc)    ; WRITE_ONLY
  store ptr %ba, ptr %da
  store ptr %bb, ptr %db
  store ptr %bc, ptr %dc
  call i32 @clSetKernelArg(ptr %k, i32 0, i64 8, ptr %da)
  call i32 @clSetKernelArg(ptr %k, i32 1, i64 8, ptr %db)
  call i32 @clSetKernelArg(ptr %k, i32 2, i64 8, ptr %dc)
  call i32 @clSetKernelArg(ptr %k, i32 3, i64 4, ptr %n)
  store i64 %n64, ptr %gsz
  %r4 = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %k, i32 1, ptr null, ptr %gsz, ptr null, i32 0, ptr null, ptr null)
  %e4 = icmp ne i32 %r4, 0
  br i1 %e4, label %f4, label %readback
f4:
  %x4 = call i32 @fail(i32 %r4, i32 4)
  ret i32 %x4
readback:
  %r5 = call i32 @clEnqueueReadBuffer(ptr %q, ptr %bc, i32 1, i64 0, i64 %bytes, ptr %hc, i32 0, ptr null, ptr null)
  call i32 @clFinish(ptr %q)
  store i32 0, ptr %jv
  br label %check
check:
  %j = load i32, ptr %jv
  %jm = icmp slt i32 %j, %nn
  br i1 %jm, label %checkbody, label %good
checkbody:
  %pc = getelementptr float, ptr %hc, i32 %j
  %got = load float, ptr %pc
  %fj = sitofp i32 %j to float
  %want = fmul float %fj, 0x4008000000000000
  %same = fcmp oeq float %got, %want
  %j1 = add i32 %j, 1
  store i32 %j1, ptr %jv
  br i1 %same, label %check, label %mismatch
mismatch:
  %gd = fpext float %got to double
  call i32 (ptr, ...) @printf(ptr @bad, i32 %j, double %gd)
  ret i32 2
good:
  %last = sub i32 %nn, 1
  %pl = getelementptr float, ptr %hc, i32 %last
  %lv = load float, ptr %pl
  %lvd = fpext float %lv to double
  call i32 (ptr, ...) @printf(ptr @ok, i32 %nn, double %lvd)
  ret i32 0
}
