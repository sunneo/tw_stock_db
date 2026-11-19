; SDL2 音訊＋影像＋鍵盤：8 鍵小鋼琴。A S D F G H J K 彈 C4~C5，視窗亮起對應的琴鍵，Esc 離開。
; 聲音：用方波合成 16 位元單聲道 PCM（22050 Hz、150 ms），經 SDL_QueueAudio 送出（佇列模式：SDL_AudioSpec 的 callback 是 NULL）。
; 命令列第一個參數 N＝自動彈奏並在 N 幀後結束（測試用：每 20 幀換下一個音）。
; SDL_AudioSpec 的欄位偏移：freq 0、format 4（AUDIO_S16LSB＝0x8010）、channels 6、samples 8、callback 16。
; SDL_Event：type +0、鍵盤 scancode +16。
target triple = "x86_64-pc-linux-gnu"

@title = private constant [14 x i8] c"IR SDL piano\00\00"
@fmt_end = private constant [23 x i8] c"notes=%d queued=%d ok\0A\00"
@fmt_noaudio = private constant [18 x i8] c"no audio device\0A\00\00"
@freqs = private constant [8 x i32] [i32 262, i32 294, i32 330, i32 349, i32 392, i32 440, i32 494, i32 523]
@scs = private constant [8 x i32] [i32 4, i32 22, i32 7, i32 9, i32 10, i32 11, i32 13, i32 14]

declare i32 @SDL_Init(i32)
declare void @SDL_Quit()
declare ptr @SDL_CreateWindow(ptr, i32, i32, i32, i32, i32)
declare ptr @SDL_CreateRenderer(ptr, i32, i32)
declare i32 @SDL_PollEvent(ptr)
declare i32 @SDL_SetRenderDrawColor(ptr, i8, i8, i8, i8)
declare i32 @SDL_RenderClear(ptr)
declare i32 @SDL_RenderFillRect(ptr, ptr)
declare void @SDL_RenderPresent(ptr)
declare void @SDL_Delay(i32)
declare void @SDL_DestroyRenderer(ptr)
declare void @SDL_DestroyWindow(ptr)
declare i32 @SDL_OpenAudioDevice(ptr, i32, ptr, ptr, i32)
declare void @SDL_PauseAudioDevice(i32, i32)
declare i32 @SDL_QueueAudio(i32, ptr, i32)
declare i32 @SDL_GetQueuedAudioSize(i32)
declare void @SDL_CloseAudioDevice(i32)
declare i32 @atoi(ptr)
declare i32 @printf(ptr, ...)

; 合成並送出一個音：freq Hz、ms 毫秒的方波（振幅 6000）
define void @beep(i32 %dev, i32 %freq, i32 %ms) {
entry:
  %buf = alloca [8820 x i8]
  %iv = alloca i32
  %n0 = mul i32 22050, %ms
  %n1 = udiv i32 %n0, 1000
  %big = icmp ugt i32 %n1, 4410
  %n = select i1 %big, i32 4410, i32 %n1
  %p0 = udiv i32 22050, %freq
  %half0 = udiv i32 %p0, 2
  %hz = icmp eq i32 %half0, 0
  %half = select i1 %hz, i32 1, i32 %half0
  store i32 0, ptr %iv
  br label %loop
loop:
  %i = load i32, ptr %iv
  %more = icmp ult i32 %i, %n
  br i1 %more, label %body, label %done
body:
  %idx = udiv i32 %i, %half
  %bit = and i32 %idx, 1
  %up = icmp eq i32 %bit, 0
  %v = select i1 %up, i32 6000, i32 -6000
  %lo32 = and i32 %v, 255
  %hi0 = ashr i32 %v, 8
  %hi32 = and i32 %hi0, 255
  %lo = trunc i32 %lo32 to i8
  %hi = trunc i32 %hi32 to i8
  %o = mul i32 %i, 2
  %plo = getelementptr i8, ptr %buf, i32 %o
  %o1 = add i32 %o, 1
  %phi = getelementptr i8, ptr %buf, i32 %o1
  store i8 %lo, ptr %plo
  store i8 %hi, ptr %phi
  %i1 = add i32 %i, 1
  store i32 %i1, ptr %iv
  br label %loop
done:
  %bytes = mul i32 %n, 2
  call i32 @SDL_QueueAudio(i32 %dev, ptr %buf, i32 %bytes)
  ret void
}

; scancode → 音的編號（0..7），不是琴鍵回 -1
define i32 @note_of(i32 %sc) {
entry:
  %jv = alloca i32
  store i32 0, ptr %jv
  br label %loop
loop:
  %j = load i32, ptr %jv
  %more = icmp slt i32 %j, 8
  br i1 %more, label %body, label %none
body:
  %p = getelementptr [8 x i32], ptr @scs, i32 0, i32 %j
  %s = load i32, ptr %p
  %hit = icmp eq i32 %s, %sc
  %j1 = add i32 %j, 1
  store i32 %j1, ptr %jv
  br i1 %hit, label %found, label %loop
found:
  %r = sub i32 %j1, 1
  ret i32 %r
none:
  ret i32 -1
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %ev = alloca [56 x i8], align 8
  %spec = alloca [32 x i8], align 8
  %obt = alloca [32 x i8], align 8
  %rc = alloca [4 x i32], align 4
  %running = alloca i32
  %frames = alloca i32
  %max = alloca i32
  %cur = alloca i32
  %notes = alloca i32
  %kv = alloca i32
  store i32 1, ptr %running
  store i32 0, ptr %frames
  store i32 0, ptr %max
  store i32 -1, ptr %cur
  store i32 0, ptr %notes
  %many = icmp sgt i32 %argc, 1
  br i1 %many, label %getmax, label %init
getmax:
  %a1p = getelementptr ptr, ptr %argv, i32 1
  %a1 = load ptr, ptr %a1p
  %n = call i32 @atoi(ptr %a1)
  store i32 %n, ptr %max
  br label %init
init:
  call i32 @SDL_Init(i32 48)                ; SDL_INIT_VIDEO | SDL_INIT_AUDIO
  %win = call ptr @SDL_CreateWindow(ptr @title, i32 805240832, i32 805240832, i32 640, i32 200, i32 0)
  %ren = call ptr @SDL_CreateRenderer(ptr %win, i32 -1, i32 1)
  ; SDL_AudioSpec：全部清 0（callback＝NULL）再填欄位
  store i64 0, ptr %spec
  %s8 = getelementptr i8, ptr %spec, i32 8
  store i64 0, ptr %s8
  %s16 = getelementptr i8, ptr %spec, i32 16
  store i64 0, ptr %s16
  %s24 = getelementptr i8, ptr %spec, i32 24
  store i64 0, ptr %s24
  store i32 22050, ptr %spec                ; freq
  %fmt0 = getelementptr i8, ptr %spec, i32 4
  store i8 16, ptr %fmt0                    ; AUDIO_S16LSB = 0x8010
  %fmt1 = getelementptr i8, ptr %spec, i32 5
  store i8 -128, ptr %fmt1
  %chp = getelementptr i8, ptr %spec, i32 6
  store i8 1, ptr %chp                      ; 單聲道
  %smp1 = getelementptr i8, ptr %spec, i32 9
  store i8 2, ptr %smp1                     ; samples = 512
  %dev = call i32 @SDL_OpenAudioDevice(ptr null, i32 0, ptr %spec, ptr %obt, i32 0)
  %nodev = icmp eq i32 %dev, 0
  br i1 %nodev, label %noaudio, label %startaudio
noaudio:
  call i32 (ptr, ...) @printf(ptr @fmt_noaudio)
  br label %frame
startaudio:
  call void @SDL_PauseAudioDevice(i32 %dev, i32 0)   ; 裝置一開始是暫停的
  br label %frame
frame:
  br label %events
events:
  %got = call i32 @SDL_PollEvent(ptr %ev)
  %has = icmp ne i32 %got, 0
  br i1 %has, label %handle, label %auto
handle:
  %type = load i32, ptr %ev
  %isq = icmp eq i32 %type, 256
  br i1 %isq, label %quit, label %chkkey
quit:
  store i32 0, ptr %running
  br label %events
chkkey:
  %iskey = icmp eq i32 %type, 768
  br i1 %iskey, label %key, label %events
key:
  %scp = getelementptr i8, ptr %ev, i32 16
  %sc = load i32, ptr %scp
  %isesc = icmp eq i32 %sc, 41
  br i1 %isesc, label %quit, label %play
play:
  %j = call i32 @note_of(i32 %sc)
  %ok = icmp sge i32 %j, 0
  br i1 %ok, label %sound, label %events
sound:
  %fp = getelementptr [8 x i32], ptr @freqs, i32 0, i32 %j
  %fq = load i32, ptr %fp
  call void @beep(i32 %dev, i32 %fq, i32 150)
  store i32 %j, ptr %cur
  %nn = load i32, ptr %notes
  %nn1 = add i32 %nn, 1
  store i32 %nn1, ptr %notes
  br label %events
auto:
  ; 自動模式：每 20 幀彈下一個音
  %mx = load i32, ptr %max
  %isauto = icmp sgt i32 %mx, 0
  %fr = load i32, ptr %frames
  %r20 = urem i32 %fr, 20
  %on20 = icmp eq i32 %r20, 0
  %doauto = and i1 %isauto, %on20
  br i1 %doauto, label %autonote, label %draw
autonote:
  %d20 = udiv i32 %fr, 20
  %aj = urem i32 %d20, 8
  %afp = getelementptr [8 x i32], ptr @freqs, i32 0, i32 %aj
  %afq = load i32, ptr %afp
  call void @beep(i32 %dev, i32 %afq, i32 150)
  store i32 %aj, ptr %cur
  %an = load i32, ptr %notes
  %an1 = add i32 %an, 1
  store i32 %an1, ptr %notes
  br label %draw
draw:
  call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 20, i8 22, i8 30, i8 255)
  call i32 @SDL_RenderClear(ptr %ren)
  store i32 0, ptr %kv
  br label %keys
keys:
  %k = load i32, ptr %kv
  %kmore = icmp slt i32 %k, 8
  br i1 %kmore, label %keybody, label %present
keybody:
  %c = load i32, ptr %cur
  %lit = icmp eq i32 %c, %k
  %kx = mul i32 %k, 80
  %kx2 = add i32 %kx, 4
  %rx = getelementptr [4 x i32], ptr %rc, i32 0, i32 0
  %ry = getelementptr [4 x i32], ptr %rc, i32 0, i32 1
  %rw = getelementptr [4 x i32], ptr %rc, i32 0, i32 2
  %rh = getelementptr [4 x i32], ptr %rc, i32 0, i32 3
  store i32 %kx2, ptr %rx
  store i32 10, ptr %ry
  store i32 72, ptr %rw
  store i32 180, ptr %rh
  %kb = mul i32 %k, 28
  %kb2 = add i32 %kb, 40
  %kc = trunc i32 %kb2 to i8
  %rcol = select i1 %lit, i8 -1, i8 70
  %gcol = select i1 %lit, i8 -56, i8 74
  call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 %rcol, i8 %gcol, i8 %kc, i8 255)
  call i32 @SDL_RenderFillRect(ptr %ren, ptr %rc)
  %k1 = add i32 %k, 1
  store i32 %k1, ptr %kv
  br label %keys
present:
  call void @SDL_RenderPresent(ptr %ren)
  call void @SDL_Delay(i32 16)
  %f = load i32, ptr %frames
  %f1 = add i32 %f, 1
  store i32 %f1, ptr %frames
  %mx2 = load i32, ptr %max
  %hasmax = icmp sgt i32 %mx2, 0
  %reached = icmp sge i32 %f1, %mx2
  %stop = and i1 %hasmax, %reached
  br i1 %stop, label %done, label %chkrun
chkrun:
  %run = load i32, ptr %running
  %cont = icmp ne i32 %run, 0
  br i1 %cont, label %events, label %done
done:
  %q = call i32 @SDL_GetQueuedAudioSize(i32 %dev)
  %nt = load i32, ptr %notes
  call i32 (ptr, ...) @printf(ptr @fmt_end, i32 %nt, i32 %q)
  call void @SDL_CloseAudioDevice(i32 %dev)
  call void @SDL_DestroyRenderer(ptr %ren)
  call void @SDL_DestroyWindow(ptr %win)
  call void @SDL_Quit()
  ret i32 0
}
