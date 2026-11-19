; 超過 wasm 記憶體的陣列：16 MB 放在 swap（IndexedDB），程式只有一塊 64 KB 的緩衝區。
; 由 _gen/_gen_swap_big.py 產生，請改產生器再重產。（第一版 IR 不支援 phi，用 alloca／load／store。）
@buf = global [16384 x i32] zeroinitializer
@fmt = private constant [29 x i8] c"swap err=%d chunks=%d rr=%d\0A\00"

declare i32 @fa_swap_open(i64, i64)
declare i32 @fa_swap_read(i32, i64, ptr, i64)
declare i32 @fa_swap_write(i32, i64, ptr, i64)
declare void @fa_swap_close(i32)
declare i32 @printf(ptr, ...)

; buf[i] = c * 16384 + i
define void @fill(i32 %c) {
entry:
  %i = alloca i32
  store i32 0, ptr %i
  br label %loop
loop:
  %iv = load i32, ptr %i
  %base = mul i32 %c, 16384
  %v = add i32 %base, %iv
  %p = getelementptr [16384 x i32], ptr @buf, i32 0, i32 %iv
  store i32 %v, ptr %p
  %ni = add i32 %iv, 1
  store i32 %ni, ptr %i
  %done = icmp eq i32 %ni, 16384
  br i1 %done, label %exit, label %loop
exit:
  ret void
}

define i32 @main() {
entry:
  %h = call i32 @fa_swap_open(i64 16777216, i64 65536)
  %c = alloca i32
  %d = alloca i32
  %err = alloca i32
  %rr = alloca i32
  store i32 0, ptr %c
  store i32 0, ptr %err
  store i32 0, ptr %rr
  %okh = icmp ne i32 %h, 0
  br i1 %okh, label %wbody, label %fail
fail:
  ret i32 1
wbody:
  %cv = load i32, ptr %c
  call void @fill(i32 %cv)
  %c64 = zext i32 %cv to i64
  %off = mul i64 %c64, 65536
  %w = call i32 @fa_swap_write(i32 %h, i64 %off, ptr @buf, i64 65536)
  %nc = add i32 %cv, 1
  store i32 %nc, ptr %c
  %wd = icmp eq i32 %nc, 256
  br i1 %wd, label %rinit, label %wbody
rinit:
  store i32 0, ptr %d
  br label %rbody
rbody:
  %dv = load i32, ptr %d
  %d64 = zext i32 %dv to i64
  %roff = mul i64 %d64, 65536
  %rs = call i32 @fa_swap_read(i32 %h, i64 %roff, ptr @buf, i64 65536)
  %rrv = load i32, ptr %rr
  %rr2 = or i32 %rrv, %rs
  store i32 %rr2, ptr %rr
  %base = mul i32 %dv, 16384
  %p0 = getelementptr [16384 x i32], ptr @buf, i32 0, i32 0
  %b0 = load i32, ptr %p0
  %e0 = icmp ne i32 %b0, %base
  %pl = getelementptr [16384 x i32], ptr @buf, i32 0, i32 16383
  %bl = load i32, ptr %pl
  %exp1 = add i32 %base, 16383
  %e1 = icmp ne i32 %bl, %exp1
  %e0i = zext i1 %e0 to i32
  %e1i = zext i1 %e1 to i32
  %errv = load i32, ptr %err
  %s1 = add i32 %errv, %e0i
  %err2 = add i32 %s1, %e1i
  store i32 %err2, ptr %err
  %nd = add i32 %dv, 1
  store i32 %nd, ptr %d
  %rd = icmp eq i32 %nd, 256
  br i1 %rd, label %done, label %rbody
done:
  call void @fa_swap_close(i32 %h)
  %ef = load i32, ptr %err
  %rf = load i32, ptr %rr
  %pf = call i32 (ptr, ...) @printf(ptr @fmt, i32 %ef, i32 256, i32 %rf)
  ret i32 0
}
