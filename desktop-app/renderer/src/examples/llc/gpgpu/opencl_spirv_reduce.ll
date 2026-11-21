; OpenCL 局部記憶體歸約，核心是 SPIR-V（clCreateProgramWithIL）：不經 OpenCL C 前端，建置時間只剩二進位解碼加轉 JS。
; 核心的 SPIR-V 由 scripts/gen-spv-ll.js 從 renderer/src/gpu/spv_fixtures.js 的組合語言組成（形狀仿 clang＋llvm-spirv 的輸出）；與 opencl_icd_reduce.ll 同一個核心。
; "fa-opencl: icd" 註解讓 cl* 呼叫改走 ICD 載入器（IL 程式只有載入器模式支援）。真機器要有支援 OpenCL 2.1+（clCreateProgramWithIL）的驅動。
; fa-opencl: icd
target triple = "x86_64-pc-linux-gnu"

@il = private constant [1464 x i8] c"\03\02#\07\00\00\01\00\00\00\00\00@\00\00\00\00\00\00\00\11\00\02\00\04\00\00\00\11\00\02\00\05\00\00\00\11\00\02\00\06\00\00\00\11\00\02\00\0B\00\00\00\11\00\02\00'\00\00\00\11\00\02\00\16\00\00\00\11\00\02\00\07\00\00\00\11\00\02\00\0A\00\00\00\11\00\02\00\0D\00\00\00\11\00\02\00\0E\00\00\00\11\00\02\00\11\00\00\00\11\00\02\00\14\00\00\00\11\00\02\00\0C\00\00\00\0B\00\05\00\01\00\00\00OpenCL.std\00\00\0E\00\03\00\02\00\00\00\02\00\00\00\0F\00\04\00\06\00\00\00\02\00\00\00red\00G\00\04\00\03\00\00\00\0B\00\00\00\1C\00\00\00G\00\04\00\04\00\00\00\0B\00\00\00\1B\00\00\00G\00\04\00\05\00\00\00\0B\00\00\00\1A\00\00\00\13\00\02\00\06\00\00\00\14\00\02\00\07\00\00\00\15\00\04\00\08\00\00\00\08\00\00\00\00\00\00\00\15\00\04\00\09\00\00\00\10\00\00\00\00\00\00\00\15\00\04\00\0A\00\00\00 \00\00\00\00\00\00\00\15\00\04\00\0B\00\00\00@\00\00\00\00\00\00\00\16\00\03\00\0C\00\00\00 \00\00\00\16\00\03\00\0D\00\00\00@\00\00\00\17\00\04\00\0E\00\00\00\0C\00\00\00\02\00\00\00\17\00\04\00\0F\00\00\00\0C\00\00\00\04\00\00\00\17\00\04\00\10\00\00\00\0A\00\00\00\04\00\00\00\17\00\04\00\11\00\00\00\0B\00\00\00\03\00\00\00 \00\04\00\12\00\00\00\01\00\00\00\11\00\00\00 \00\04\00\13\00\00\00\05\00\00\00\0C\00\00\00 \00\04\00\14\00\00\00\05\00\00\00\0A\00\00\00 \00\04\00\15\00\00\00\04\00\00\00\0C\00\00\00+\00\04\00\0A\00\00\00\16\00\00\00\00\00\00\00+\00\04\00\0A\00\00\00\17\00\00\00\01\00\00\00+\00\04\00\0A\00\00\00\18\00\00\00\02\00\00\00+\00\04\00\0A\00\00\00\19\00\00\00 \00\00\00+\00\04\00\0A\00\00\00\1A\00\00\00\02\00\00\00+\00\04\00\0A\00\00\00\1B\00\00\00\10\01\00\00;\00\04\00\12\00\00\00\03\00\00\00\01\00\00\00;\00\04\00\12\00\00\00\04\00\00\00\01\00\00\00;\00\04\00\12\00\00\00\05\00\00\00\01\00\00\00!\00\06\00\1C\00\00\00\06\00\00\00\13\00\00\00\13\00\00\00\15\00\00\006\00\05\00\06\00\00\00\02\00\00\00\00\00\00\00\1C\00\00\007\00\03\00\13\00\00\00\1D\00\00\007\00\03\00\13\00\00\00\1E\00\00\007\00\03\00\15\00\00\00\1F\00\00\00\F8\00\02\00 \00\00\00=\00\06\00\11\00\00\00!\00\00\00\04\00\00\00\02\00\00\00 \00\00\00Q\00\05\00\0B\00\00\00\22\00\00\00!\00\00\00\00\00\00\00=\00\06\00\11\00\00\00#\00\00\00\03\00\00\00\02\00\00\00 \00\00\00Q\00\05\00\0B\00\00\00$\00\00\00#\00\00\00\00\00\00\00F\00\05\00\13\00\00\00%\00\00\00\1D\00\00\00$\00\00\00=\00\06\00\0C\00\00\00&\00\00\00%\00\00\00\02\00\00\00\04\00\00\00F\00\05\00\15\00\00\00'\00\00\00\1F\00\00\00\22\00\00\00>\00\05\00'\00\00\00&\00\00\00\02\00\00\00\04\00\00\00\E0\00\04\00\1A\00\00\00\1A\00\00\00\1B\00\00\00q\00\04\00\0A\00\00\00(\00\00\00\22\00\00\00\F9\00\02\00)\00\00\00\F8\00\02\00)\00\00\00\F5\00\07\00\0A\00\00\00*\00\00\00\19\00\00\00 \00\00\00+\00\00\00,\00\00\00\AC\00\05\00\07\00\00\00-\00\00\00*\00\00\00\16\00\00\00\F6\00\04\00.\00\00\00,\00\00\00\00\00\00\00\FA\00\04\00-\00\00\00/\00\00\00.\00\00\00\F8\00\02\00/\00\00\00\B0\00\05\00\07\00\00\000\00\00\00(\00\00\00*\00\00\00\F7\00\03\001\00\00\00\00\00\00\00\FA\00\04\000\00\00\002\00\00\001\00\00\00\F8\00\02\002\00\00\00q\00\04\00\0B\00\00\003\00\00\00*\00\00\00\80\00\05\00\0B\00\00\004\00\00\00\22\00\00\003\00\00\00F\00\05\00\15\00\00\005\00\00\00\1F\00\00\004\00\00\00=\00\06\00\0C\00\00\006\00\00\005\00\00\00\02\00\00\00\04\00\00\00=\00\06\00\0C\00\00\007\00\00\00'\00\00\00\02\00\00\00\04\00\00\00\81\00\05\00\0C\00\00\008\00\00\007\00\00\006\00\00\00>\00\05\00'\00\00\008\00\00\00\02\00\00\00\04\00\00\00\F9\00\02\001\00\00\00\F8\00\02\001\00\00\00\E0\00\04\00\1A\00\00\00\1A\00\00\00\1B\00\00\00\F9\00\02\00,\00\00\00\F8\00\02\00,\00\00\00\C2\00\05\00\0A\00\00\00+\00\00\00*\00\00\00\17\00\00\00\F9\00\02\00)\00\00\00\F8\00\02\00.\00\00\00\AA\00\05\00\07\00\00\009\00\00\00(\00\00\00\16\00\00\00\F7\00\03\00:\00\00\00\00\00\00\00\FA\00\04\009\00\00\00;\00\00\00:\00\00\00\F8\00\02\00;\00\00\00=\00\06\00\0C\00\00\00<\00\00\00\1F\00\00\00\02\00\00\00\04\00\00\00=\00\06\00\11\00\00\00=\00\00\00\05\00\00\00\02\00\00\00 \00\00\00Q\00\05\00\0B\00\00\00>\00\00\00=\00\00\00\00\00\00\00F\00\05\00\13\00\00\00?\00\00\00\1E\00\00\00>\00\00\00>\00\05\00?\00\00\00<\00\00\00\02\00\00\00\04\00\00\00\F9\00\02\00:\00\00\00\F8\00\02\00:\00\00\00\FD\00\01\008\00\01\00"
@name = private constant [4 x i8] c"red\00"
@okf = private constant [17 x i8] c"red OK sum=%.1f\0A\00"
@badf = private constant [30 x i8] c"red MISMATCH sum=%.1f err=%d\0A\00"

declare i32 @clGetPlatformIDs(i32, ptr, ptr)
declare i32 @clGetDeviceIDs(ptr, i64, i32, ptr, ptr)
declare ptr @clCreateContext(ptr, i32, ptr, ptr, ptr, ptr)
declare ptr @clCreateCommandQueue(ptr, ptr, i64, ptr)
declare ptr @clCreateProgramWithIL(ptr, ptr, i64, ptr)
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
  %prog = call ptr @clCreateProgramWithIL(ptr %c, ptr @il, i64 1464, ptr %rc)
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
