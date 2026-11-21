; OpenCL 局部記憶體歸約（ICD 模式）：核心用 __local 與 barrier 做樹狀歸約，4 個工作群各算 64 個 float 的和，主機再加總。
; 第一行註解 "fa-opencl: icd" 讓 run terminal 把這份 IR 的 cl* 呼叫交給 ICD 載入器（OpenCL C 前端 clc）——預設的墊片不支援 __local 與 barrier。
; 真機器（有 OpenCL 驅動）：clang／lli 照常連結 libOpenCL，同一份 IR 直接跑。
; fa-opencl: icd
target triple = "x86_64-pc-linux-gnu"

@src = private constant [306 x i8] c"__kernel void red(__global const float* x, __global float* out, __local float* t) { int l = get_local_id(0); t[l] = x[get_global_id(0)]; barrier(CLK_LOCAL_MEM_FENCE); for (int s = 32; s > 0; s >>= 1) { if (l < s) t[l] += t[l + s]; barrier(CLK_LOCAL_MEM_FENCE); } if (l == 0) out[get_group_id(0)] = t[0]; }\00"
@name = private constant [4 x i8] c"red\00"
@okf = private constant [17 x i8] c"red OK sum=%.1f\0A\00"
@badf = private constant [30 x i8] c"red MISMATCH sum=%.1f err=%d\0A\00"

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
declare ptr @malloc(i32)
declare i32 @printf(ptr, ...)

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %plat = alloca ptr
  %dev = alloca ptr
  %rc = alloca i32
  %srcp = alloca ptr
  %bx = alloca ptr
  %bo = alloca ptr
  %gws = alloca i32
  %lws = alloca i32
  %iv = alloca i32
  %err = alloca i32
  store i32 0, ptr %err
  %e1 = call i32 @clGetPlatformIDs(i32 1, ptr %plat, ptr null)
  %p = load ptr, ptr %plat
  %e2 = call i32 @clGetDeviceIDs(ptr %p, i64 2, i32 1, ptr %dev, ptr null)      ; CL_DEVICE_TYPE_CPU
  %c = call ptr @clCreateContext(ptr null, i32 1, ptr %dev, ptr null, ptr null, ptr %rc)
  %d = load ptr, ptr %dev
  %q = call ptr @clCreateCommandQueue(ptr %c, ptr %d, i64 0, ptr %rc)
  store ptr @src, ptr %srcp
  %prog = call ptr @clCreateProgramWithSource(ptr %c, i32 1, ptr %srcp, ptr null, ptr %rc)
  %e3 = call i32 @clBuildProgram(ptr %prog, i32 1, ptr %dev, ptr null, ptr null, ptr null)
  %k = call ptr @clCreateKernel(ptr %prog, ptr @name, ptr %rc)
  %hx = call ptr @malloc(i32 1024)
  %ho = call ptr @malloc(i32 16)
  store i32 0, ptr %iv
  br label %fill
fill:
  %i = load i32, ptr %iv
  %more = icmp slt i32 %i, 256
  br i1 %more, label %fillbody, label %run
fillbody:
  %fi = sitofp i32 %i to float
  %px = getelementptr float, ptr %hx, i32 %i
  store float %fi, ptr %px
  %i1 = add i32 %i, 1
  store i32 %i1, ptr %iv
  br label %fill
run:
  %b1 = call ptr @clCreateBuffer(ptr %c, i64 36, i64 1024, ptr %hx, ptr %rc)    ; READ_ONLY|COPY_HOST_PTR
  %b2 = call ptr @clCreateBuffer(ptr %c, i64 2, i64 16, ptr null, ptr %rc)      ; WRITE_ONLY
  store ptr %b1, ptr %bx
  store ptr %b2, ptr %bo
  %a0 = call i32 @clSetKernelArg(ptr %k, i32 0, i64 4, ptr %bx)
  %a1 = call i32 @clSetKernelArg(ptr %k, i32 1, i64 4, ptr %bo)
  %a2 = call i32 @clSetKernelArg(ptr %k, i32 2, i64 256, ptr null)              ; __local float[64]
  store i32 256, ptr %gws
  store i32 64, ptr %lws
  %e4 = call i32 @clEnqueueNDRangeKernel(ptr %q, ptr %k, i32 1, ptr null, ptr %gws, ptr %lws, i32 0, ptr null, ptr null)
  %e5 = call i32 @clEnqueueReadBuffer(ptr %q, ptr %b2, i32 1, i64 0, i64 16, ptr %ho, i32 0, ptr null, ptr null)
  %o0 = load float, ptr %ho
  %p1 = getelementptr float, ptr %ho, i32 1
  %o1 = load float, ptr %p1
  %p2 = getelementptr float, ptr %ho, i32 2
  %o2 = load float, ptr %p2
  %p3 = getelementptr float, ptr %ho, i32 3
  %o3 = load float, ptr %p3
  %s01 = fadd float %o0, %o1
  %s23 = fadd float %o2, %o3
  %sum = fadd float %s01, %s23
  %ea = or i32 %e1, %e2
  %eb = or i32 %e3, %e4
  %ec = or i32 %e5, %a0
  %ed = or i32 %a1, %a2
  %ee = or i32 %ea, %eb
  %ef = or i32 %ec, %ed
  %eg = or i32 %ee, %ef
  %good = fcmp oeq float %sum, 3.264000e+04
  %sd = fpext float %sum to double
  br i1 %good, label %ok, label %bad
ok:
  %r1 = call i32 (ptr, ...) @printf(ptr @okf, double %sd)
  ret i32 %eg
bad:
  %r2 = call i32 (ptr, ...) @printf(ptr @badf, double %sd, i32 %eg)
  ret i32 1
}
