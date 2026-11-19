; 音樂盒（SDL2 音訊＋影像＋鍵盤）：內建〈歡樂頌〉，即時合成，經 SDL_QueueAudio 送出（佇列模式）。空白＝暫停／繼續、↑↓＝速度、1 2 3＝波形、R＝從頭、Esc 離開。
; 第一個參數＝跑幾幀後離開（測試用）。（由 _gen/_gen_music_player.py 產生）
target triple = "x86_64-pc-linux-gnu"

declare i32 @SDL_SetRenderDrawColor(ptr, i8, i8, i8, i8)
declare i32 @SDL_RenderFillRect(ptr, ptr)
declare i32 @SDL_Init(i32)
declare void @SDL_Quit()
declare ptr @SDL_CreateWindow(ptr, i32, i32, i32, i32, i32)
declare ptr @SDL_CreateRenderer(ptr, i32, i32)
declare i32 @SDL_PollEvent(ptr)
declare i32 @SDL_RenderClear(ptr)
declare void @SDL_RenderPresent(ptr)
declare void @SDL_Delay(i32)
declare void @SDL_DestroyRenderer(ptr)
declare void @SDL_DestroyWindow(ptr)
declare i32 @SDL_OpenAudioDevice(ptr, i32, ptr, ptr, i32)
declare void @SDL_PauseAudioDevice(i32, i32)
declare i32 @SDL_QueueAudio(i32, ptr, i32)
declare i32 @SDL_GetQueuedAudioSize(i32)
declare void @SDL_CloseAudioDevice(i32)
declare double @sin(double)
declare double @pow(double, double)
declare double @floor(double)
declare i32 @atoi(ptr)
declare i32 @printf(ptr, ...)

@.s1 = private constant [8 x i8] c"PLAYING\00"
@.s2 = private constant [8 x i8] c"PAUSED \00"
@.s3 = private constant [9 x i8] c"SQUARE\20\20\00"
@.s4 = private constant [9 x i8] c"TRIANGLE\00"
@.s5 = private constant [9 x i8] c"SINE\20\20\20\20\00"
@.s6 = private constant [4 x i8] c"BPM\00"
@.s7 = private constant [24 x i8] c"SPACE PAUSE\20\201 2 3 WAVE\00"
@.s8 = private constant [14 x i8] c"UP DOWN TEMPO\00"
@.s9 = private constant [16 x i8] c"IR music player\00"
@.s10 = private constant [32 x i8] c"frames=%d samples=%d bpm=%d ok\0A\00"
@hud_font = private constant [1235 x i32] [i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 20, i32 20, i32 20, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 10, i32 20, i32 63, i32 20, i32 20, i32 126, i32 40, i32 40, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 28, i32 40, i32 40, i32 28, i32 10, i32 10, i32 60, i32 8, i32 8, i32 0, i32 0, i32 0, i32 48, i32 72, i32 50, i32 4, i32 24, i32 46, i32 10, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 32, i32 48, i32 74, i32 70, i32 98, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 16, i32 16, i32 16, i32 16, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 16, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 8, i32 42, i32 28, i32 28, i32 42, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 126, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 42, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 2, i32 4, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 6, i32 24, i32 6, i32 2, i32 38, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 12, i32 12, i32 20, i32 36, i32 36, i32 62, i32 4, i32 4, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 32, i32 32, i32 60, i32 6, i32 2, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 48, i32 32, i32 60, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 34, i32 28, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 38, i32 58, i32 2, i32 4, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 28, i32 96, i32 24, i32 6, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 0, i32 126, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 96, i32 28, i32 2, i32 28, i32 96, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 6, i32 4, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 66, i32 78, i32 82, i32 82, i32 78, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 8, i32 24, i32 20, i32 20, i32 36, i32 62, i32 34, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 60, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 50, i32 32, i32 32, i32 32, i32 32, i32 50, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 36, i32 34, i32 34, i32 34, i32 34, i32 36, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 32, i32 32, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 62, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 4, i32 4, i32 4, i32 4, i32 4, i32 36, i32 56, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 36, i32 40, i32 56, i32 40, i32 36, i32 38, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 102, i32 86, i32 90, i32 74, i32 66, i32 66, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 50, i32 50, i32 42, i32 42, i32 42, i32 38, i32 38, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 4, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 38, i32 56, i32 36, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 36, i32 32, i32 48, i32 12, i32 2, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 34, i32 34, i32 36, i32 20, i32 20, i32 24, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 74, i32 90, i32 58, i32 54, i32 54, i32 36, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 52, i32 20, i32 8, i32 24, i32 20, i32 34, i32 98, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 38, i32 20, i32 24, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 2, i32 4, i32 8, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 28, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 28, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 16, i32 16, i32 8, i32 8, i32 4, i32 4, i32 2, i32 0, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 24, i32 0, i32 0, i32 0, i32 0, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 2, i32 62, i32 34, i32 38, i32 58, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 48, i32 32, i32 32, i32 48, i32 30, i32 0, i32 0, i32 0, i32 0, i32 2, i32 2, i32 2, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 62, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 0, i32 14, i32 8, i32 8, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 4, i32 60, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 56, i32 0, i32 0, i32 32, i32 32, i32 32, i32 38, i32 44, i32 56, i32 44, i32 36, i32 34, i32 0, i32 0, i32 0, i32 0, i32 48, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 8, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 54, i32 42, i32 42, i32 42, i32 42, i32 42, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 2, i32 2, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 16, i32 16, i32 16, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 48, i32 12, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 16, i32 62, i32 16, i32 16, i32 16, i32 16, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 36, i32 20, i32 24, i32 24, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 42, i32 58, i32 58, i32 52, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 20, i32 24, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 20, i32 20, i32 24, i32 8, i32 24, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 8, i32 16, i32 16, i32 62, i32 0, i32 0, i32 0, i32 0, i32 12, i32 8, i32 8, i32 8, i32 48, i32 8, i32 8, i32 8, i32 8, i32 12, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 48, i32 8, i32 8, i32 8, i32 4, i32 8, i32 8, i32 8, i32 8, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 48, i32 78, i32 0, i32 0, i32 0, i32 0]
@notes = private constant [62 x i32] [i32 64, i32 64, i32 65, i32 67, i32 67, i32 65, i32 64, i32 62, i32 60, i32 60, i32 62, i32 64, i32 64, i32 62, i32 62, i32 64, i32 64, i32 65, i32 67, i32 67, i32 65, i32 64, i32 62, i32 60, i32 60, i32 62, i32 64, i32 62, i32 60, i32 60, i32 62, i32 62, i32 64, i32 60, i32 62, i32 64, i32 65, i32 64, i32 60, i32 62, i32 64, i32 65, i32 64, i32 62, i32 60, i32 62, i32 55, i32 64, i32 64, i32 65, i32 67, i32 67, i32 65, i32 64, i32 62, i32 60, i32 60, i32 62, i32 64, i32 62, i32 60, i32 60]
@durs = private constant [62 x i32] [i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 3, i32 1, i32 4, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 3, i32 1, i32 4, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 4, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 2, i32 3, i32 1, i32 4]

define void @hud_text(ptr %ren, i32 %x, i32 %y, ptr %s, i32 %n, i8 %r, i8 %g, i8 %b) {
entry:
  %rc = alloca [4 x i32], align 4
  %row = alloca i32
  %xi = alloca i32
  %st = alloca i32
  %w = mul i32 %n, 7
  %cr = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 %r, i8 %g, i8 %b, i8 -1)
  store i32 0, ptr %row
  br label %rowloop
rowloop:
  %rv = load i32, ptr %row
  %rdone = icmp eq i32 %rv, 13
  br i1 %rdone, label %exit, label %rowbody
rowbody:
  store i32 0, ptr %xi
  store i32 -1, ptr %st
  br label %col
col:
  %xv = load i32, ptr %xi
  %inside = icmp slt i32 %xv, %w
  %ci0 = udiv i32 %xv, 7
  %ci = select i1 %inside, i32 %ci0, i32 0
  %cm = urem i32 %xv, 7
  %cp = getelementptr i8, ptr %s, i32 %ci
  %cb = load i8, ptr %cp
  %cv = zext i8 %cb to i32
  %lo = icmp slt i32 %cv, 32
  %hi = icmp sgt i32 %cv, 126
  %bad = or i1 %lo, %hi
  %cv2 = select i1 %bad, i32 32, i32 %cv
  %gi = sub i32 %cv2, 32
  %gb = mul i32 %gi, 13
  %gidx = add i32 %gb, %rv
  %gp = getelementptr [1235 x i32], ptr @hud_font, i32 0, i32 %gidx
  %gv = load i32, ptr %gp
  %sh = sub i32 6, %cm
  %shv = lshr i32 %gv, %sh
  %bit = and i32 %shv, 1
  %bitb = icmp ne i32 %bit, 0
  %lit = and i1 %bitb, %inside
  %stv = load i32, ptr %st
  %sn = icmp slt i32 %stv, 0
  %begin = and i1 %lit, %sn
  %newst = select i1 %begin, i32 %xv, i32 %stv
  %nlit = xor i1 %lit, 1
  %nsn = xor i1 %sn, 1
  %endrun = and i1 %nlit, %nsn
  %stfin = select i1 %endrun, i32 -1, i32 %newst
  store i32 %stfin, ptr %st
  br i1 %endrun, label %draw, label %cont
draw:
  %dx = add i32 %x, %stv
  %dy = add i32 %y, %rv
  %dl = sub i32 %xv, %stv
  %p0 = getelementptr [4 x i32], ptr %rc, i32 0, i32 0
  %p1 = getelementptr [4 x i32], ptr %rc, i32 0, i32 1
  %p2 = getelementptr [4 x i32], ptr %rc, i32 0, i32 2
  %p3 = getelementptr [4 x i32], ptr %rc, i32 0, i32 3
  store i32 %dx, ptr %p0
  store i32 %dy, ptr %p1
  store i32 %dl, ptr %p2
  store i32 1, ptr %p3
  %fr = call i32 @SDL_RenderFillRect(ptr %ren, ptr %rc)
  br label %cont
cont:
  %x1 = add i32 %xv, 1
  store i32 %x1, ptr %xi
  %more = icmp slt i32 %xv, %w
  br i1 %more, label %col, label %rowend
rowend:
  %r1 = add i32 %rv, 1
  store i32 %r1, ptr %row
  br label %rowloop
exit:
  ret void
}


define void @hud_int(ptr %ren, i32 %x, i32 %y, i32 %v, i8 %r, i8 %g, i8 %b) {
entry:
  %buf = alloca [3 x i8], align 1
  %hq = udiv i32 %v, 100
  %hd = urem i32 %hq, 10
  %tq = udiv i32 %v, 10
  %td = urem i32 %tq, 10
  %od = urem i32 %v, 10
  %hge = icmp uge i32 %v, 100
  %tge = icmp uge i32 %v, 10
  %hc0 = add i32 %hd, 48
  %hc1 = select i1 %hge, i32 %hc0, i32 32
  %tc0 = add i32 %td, 48
  %tc1 = select i1 %tge, i32 %tc0, i32 32
  %oc0 = add i32 %od, 48
  %hc = trunc i32 %hc1 to i8
  %tc = trunc i32 %tc1 to i8
  %oc = trunc i32 %oc0 to i8
  %p0 = getelementptr [3 x i8], ptr %buf, i32 0, i32 0
  %p1 = getelementptr [3 x i8], ptr %buf, i32 0, i32 1
  %p2 = getelementptr [3 x i8], ptr %buf, i32 0, i32 2
  store i8 %hc, ptr %p0
  store i8 %tc, ptr %p1
  store i8 %oc, ptr %p2
  call void @hud_text(ptr %ren, i32 %x, i32 %y, ptr %buf, i32 3, i8 %r, i8 %g, i8 %b)
  ret void
}


define i32 @note_idx(i32 %hb, ptr %accp) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  store i32 0, ptr %a1
  store i32 0, ptr %a2
  br label %wc1
wc1:
  %t1 = load i32, ptr %a2
  %t2 = load i32, ptr %a1
  %t3 = getelementptr i32, ptr @durs, i32 %t2
  %t4 = load i32, ptr %t3
  %t5 = add i32 %t1, %t4
  %t6 = add i32 %hb, 1
  %t7 = icmp ult i32 %t5, %t6
  %t8 = load i32, ptr %a1
  %t9 = icmp slt i32 %t8, 61
  %t10 = and i1 %t7, %t9
  br i1 %t10, label %wb2, label %we3
wb2:
  %t11 = load i32, ptr %a1
  %t12 = getelementptr i32, ptr @durs, i32 %t11
  %t13 = load i32, ptr %t12
  %t14 = load i32, ptr %a2
  %t15 = add i32 %t14, %t13
  store i32 %t15, ptr %a2
  %t16 = load i32, ptr %a1
  %t17 = add i32 %t16, 1
  store i32 %t17, ptr %a1
  br label %wc1
we3:
  %t18 = load i32, ptr %a2
  %t19 = getelementptr i32, ptr %accp, i32 0
  store i32 %t18, ptr %t19
  %t20 = load i32, ptr %a1
  ret i32 %t20
}

define void @synth(ptr %buf, i32 %n, i32 %start, i32 %spb, i32 %wave) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  store i32 0, ptr %a1
  store i32 0, ptr %a1
  br label %lc1
lc1:
  %t1 = load i32, ptr %a1
  %t2 = icmp slt i32 %t1, %n
  br i1 %t2, label %lb2, label %le3
lb2:
  %t3 = load i32, ptr %a1
  %t4 = add i32 %start, %t3
  %t5 = mul i32 %spb, 132
  %t6 = srem i32 %t4, %t5
  %t7 = sdiv i32 %t6, %spb
  %t8 = call i32 @note_idx(i32 %t7, ptr %a2)
  %t9 = getelementptr i32, ptr %a2, i32 0
  %t10 = load i32, ptr %t9
  %t11 = mul i32 %t10, %spb
  %t12 = sub i32 %t6, %t11
  %t13 = getelementptr i32, ptr @durs, i32 %t8
  %t14 = load i32, ptr %t13
  %t15 = mul i32 %t14, %spb
  %t16 = getelementptr i32, ptr @notes, i32 %t8
  %t17 = load i32, ptr %t16
  %t18 = sub i32 %t17, 69
  %t19 = sitofp i32 %t18 to double
  %t20 = fdiv double %t19, 0x4028000000000000
  %t21 = call double @pow(double 0x4000000000000000, double %t20)
  %t22 = fmul double %t21, 0x407B800000000000
  %t23 = sitofp i32 %t12 to double
  %t24 = fmul double %t23, %t22
  %t25 = fdiv double %t24, 0x40D5888000000000
  %t26 = call double @floor(double %t25)
  %t27 = fsub double %t25, %t26
  %t28 = fcmp olt double %t27, 0x3FE0000000000000
  %t29 = select i1 %t28, double 0x3FF0000000000000, double 0xBFF0000000000000
  %t30 = fcmp olt double %t27, 0x3FE0000000000000
  %t31 = fmul double %t27, 0x4010000000000000
  %t32 = fsub double %t31, 0x3FF0000000000000
  %t33 = fmul double %t27, 0x4010000000000000
  %t34 = fsub double 0x4008000000000000, %t33
  %t35 = select i1 %t30, double %t32, double %t34
  %t36 = fmul double %t27, 0x401921FB53C8D4F1
  %t37 = call double @sin(double %t36)
  %t38 = icmp eq i32 %wave, 0
  %t39 = icmp eq i32 %wave, 1
  %t40 = select i1 %t39, double %t35, double %t37
  %t41 = select i1 %t38, double %t29, double %t40
  %t42 = sitofp i32 %t12 to double
  %t43 = fdiv double %t42, 0x4069000000000000
  %t44 = fcmp ogt double %t43, 0x3FF0000000000000
  %t45 = select i1 %t44, double 0x3FF0000000000000, double %t43
  %t46 = sub i32 %t15, %t12
  %t47 = sitofp i32 %t46 to double
  %t48 = fdiv double %t47, 0x4082C00000000000
  %t49 = fcmp ogt double %t48, 0x3FF0000000000000
  %t50 = select i1 %t49, double 0x3FF0000000000000, double %t48
  %t51 = fmul double %t41, %t45
  %t52 = fmul double %t51, %t50
  %t53 = fmul double %t52, 0x40B3880000000000
  %t54 = fptosi double %t53 to i32
  %t55 = and i32 %t54, 255
  %t56 = trunc i32 %t55 to i8
  %t57 = ashr i32 %t54, 8
  %t58 = and i32 %t57, 255
  %t59 = trunc i32 %t58 to i8
  %t60 = load i32, ptr %a1
  %t61 = mul i32 %t60, 2
  %t62 = getelementptr i8, ptr %buf, i32 %t61
  store i8 %t56, ptr %t62
  %t63 = add i32 %t61, 1
  %t64 = getelementptr i8, ptr %buf, i32 %t63
  store i8 %t59, ptr %t64
  %t65 = load i32, ptr %a1
  %t66 = add i32 %t65, 1
  store i32 %t66, ptr %a1
  br label %lc1
le3:
  ret void
}

define void @draw_ui(ptr %ren, i32 %midi, i32 %prog, i32 %wave, i32 %paused, i32 %bpm) {
entry:
  %a1 = alloca [4 x i32]
  %a2 = alloca i32
  %a3 = alloca i32
  %t1 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 18, i8 20, i8 28, i8 255)
  %t2 = call i32 @SDL_RenderClear(ptr %ren)
  %t3 = getelementptr i32, ptr %a1, i32 0
  store i32 0, ptr %t3
  %t4 = getelementptr i32, ptr %a1, i32 1
  store i32 0, ptr %t4
  %t5 = getelementptr i32, ptr %a1, i32 2
  store i32 640, ptr %t5
  %t6 = getelementptr i32, ptr %a1, i32 3
  store i32 12, ptr %t6
  %t7 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 40, i8 44, i8 60, i8 255)
  %t8 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  %t9 = getelementptr i32, ptr %a1, i32 0
  store i32 0, ptr %t9
  %t10 = getelementptr i32, ptr %a1, i32 1
  store i32 0, ptr %t10
  %t11 = getelementptr i32, ptr %a1, i32 2
  store i32 %prog, ptr %t11
  %t12 = getelementptr i32, ptr %a1, i32 3
  store i32 12, ptr %t12
  %t13 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 90, i8 200, i8 120, i8 255)
  %t14 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  store i32 0, ptr %a2
  store i32 0, ptr %a2
  br label %lc1
lc1:
  %t15 = load i32, ptr %a2
  %t16 = icmp slt i32 %t15, 24
  br i1 %t16, label %lb2, label %le3
lb2:
  %t17 = load i32, ptr %a2
  %t18 = srem i32 %t17, 12
  %t19 = icmp eq i32 %t18, 1
  %t20 = icmp eq i32 %t18, 3
  %t21 = or i1 %t19, %t20
  %t22 = icmp eq i32 %t18, 6
  %t23 = or i1 %t21, %t22
  %t24 = icmp eq i32 %t18, 8
  %t25 = or i1 %t23, %t24
  %t26 = icmp eq i32 %t18, 10
  %t27 = or i1 %t25, %t26
  %t28 = load i32, ptr %a2
  %t29 = add i32 %t28, 60
  %t30 = icmp eq i32 %t29, %midi
  %t31 = load i32, ptr %a2
  %t32 = mul i32 %t31, 26
  %t33 = add i32 %t32, 8
  %t34 = select i1 %t27, i32 40, i32 235
  %t35 = select i1 %t30, i32 255, i32 %t34
  %t36 = select i1 %t27, i32 40, i32 235
  %t37 = select i1 %t30, i32 200, i32 %t36
  %t38 = select i1 %t27, i32 50, i32 240
  %t39 = select i1 %t30, i32 60, i32 %t38
  %t40 = select i1 %t27, i32 90, i32 150
  %t41 = trunc i32 %t35 to i8
  %t42 = trunc i32 %t37 to i8
  %t43 = trunc i32 %t39 to i8
  %t44 = getelementptr i32, ptr %a1, i32 0
  store i32 %t33, ptr %t44
  %t45 = getelementptr i32, ptr %a1, i32 1
  store i32 40, ptr %t45
  %t46 = getelementptr i32, ptr %a1, i32 2
  store i32 24, ptr %t46
  %t47 = getelementptr i32, ptr %a1, i32 3
  store i32 %t40, ptr %t47
  %t48 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 %t41, i8 %t42, i8 %t43, i8 255)
  %t49 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  %t50 = load i32, ptr %a2
  %t51 = add i32 %t50, 1
  store i32 %t51, ptr %a2
  br label %lc1
le3:
  store i32 0, ptr %a3
  store i32 0, ptr %a3
  br label %lc4
lc4:
  %t52 = load i32, ptr %a3
  %t53 = icmp slt i32 %t52, 3
  br i1 %t53, label %lb5, label %le6
lb5:
  %t54 = load i32, ptr %a3
  %t55 = icmp eq i32 %t54, %wave
  %t56 = load i32, ptr %a3
  %t57 = mul i32 %t56, 40
  %t58 = add i32 %t57, 8
  %t59 = select i1 %t55, i32 120, i32 50
  %t60 = trunc i32 %t59 to i8
  %t61 = select i1 %t55, i32 220, i32 54
  %t62 = trunc i32 %t61 to i8
  %t63 = select i1 %t55, i32 255, i32 70
  %t64 = trunc i32 %t63 to i8
  %t65 = getelementptr i32, ptr %a1, i32 0
  store i32 %t58, ptr %t65
  %t66 = getelementptr i32, ptr %a1, i32 1
  store i32 220, ptr %t66
  %t67 = getelementptr i32, ptr %a1, i32 2
  store i32 32, ptr %t67
  %t68 = getelementptr i32, ptr %a1, i32 3
  store i32 12, ptr %t68
  %t69 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 %t60, i8 %t62, i8 %t64, i8 255)
  %t70 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  %t71 = load i32, ptr %a3
  %t72 = add i32 %t71, 1
  store i32 %t72, ptr %a3
  br label %lc4
le6:
  %t73 = icmp ne i32 %paused, 0
  br i1 %t73, label %then7, label %endif8
then7:
  %t74 = getelementptr i32, ptr %a1, i32 0
  store i32 560, ptr %t74
  %t75 = getelementptr i32, ptr %a1, i32 1
  store i32 215, ptr %t75
  %t76 = getelementptr i32, ptr %a1, i32 2
  store i32 12, ptr %t76
  %t77 = getelementptr i32, ptr %a1, i32 3
  store i32 24, ptr %t77
  %t78 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 255, i8 180, i8 60, i8 255)
  %t79 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  %t80 = getelementptr i32, ptr %a1, i32 0
  store i32 580, ptr %t80
  %t81 = getelementptr i32, ptr %a1, i32 1
  store i32 215, ptr %t81
  %t82 = getelementptr i32, ptr %a1, i32 2
  store i32 12, ptr %t82
  %t83 = getelementptr i32, ptr %a1, i32 3
  store i32 24, ptr %t83
  %t84 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 255, i8 180, i8 60, i8 255)
  %t85 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  br label %endif8
endif8:
  %t86 = icmp eq i32 %paused, 0
  br i1 %t86, label %then9, label %endif10
then9:
  call void @hud_text(ptr %ren, i32 8, i32 198, ptr @.s1, i32 7, i8 255, i8 210, i8 90)
  br label %endif10
endif10:
  %t87 = icmp ne i32 %paused, 0
  br i1 %t87, label %then11, label %endif12
then11:
  call void @hud_text(ptr %ren, i32 8, i32 198, ptr @.s2, i32 7, i8 255, i8 210, i8 90)
  br label %endif12
endif12:
  %t88 = icmp eq i32 %wave, 0
  br i1 %t88, label %then13, label %endif14
then13:
  call void @hud_text(ptr %ren, i32 64, i32 198, ptr @.s3, i32 8, i8 255, i8 210, i8 90)
  br label %endif14
endif14:
  %t89 = icmp eq i32 %wave, 1
  br i1 %t89, label %then15, label %endif16
then15:
  call void @hud_text(ptr %ren, i32 64, i32 198, ptr @.s4, i32 8, i8 255, i8 210, i8 90)
  br label %endif16
endif16:
  %t90 = icmp eq i32 %wave, 2
  br i1 %t90, label %then17, label %endif18
then17:
  call void @hud_text(ptr %ren, i32 64, i32 198, ptr @.s5, i32 8, i8 255, i8 210, i8 90)
  br label %endif18
endif18:
  call void @hud_int(ptr %ren, i32 127, i32 198, i32 %bpm, i8 255, i8 210, i8 90)
  call void @hud_text(ptr %ren, i32 155, i32 198, ptr @.s6, i32 3, i8 255, i8 210, i8 90)
  call void @hud_text(ptr %ren, i32 8, i32 244, ptr @.s7, i32 23, i8 220, i8 220, i8 220)
  call void @hud_text(ptr %ren, i32 8, i32 262, ptr @.s8, i32 13, i8 220, i8 220, i8 220)
  ret void
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %a1 = alloca [56 x i8]
  %a2 = alloca [32 x i8]
  %a3 = alloca [32 x i8]
  %a4 = alloca [2048 x i8]
  %a5 = alloca i32
  %a6 = alloca i32
  %a7 = alloca i32
  %a8 = alloca i32
  %a9 = alloca i32
  %a10 = alloca i32
  %a11 = alloca i32
  %a12 = alloca i32
  %a13 = alloca i32
  store i32 1, ptr %a5
  store i32 0, ptr %a6
  store i32 0, ptr %a7
  store i32 0, ptr %a8
  store i32 110, ptr %a9
  store i32 1, ptr %a10
  store i32 0, ptr %a11
  store i32 0, ptr %a12
  %t1 = icmp sgt i32 %argc, 1
  br i1 %t1, label %then1, label %endif2
then1:
  %t2 = getelementptr ptr, ptr %argv, i32 1
  %t3 = load ptr, ptr %t2
  %t4 = call i32 @atoi(ptr %t3)
  store i32 %t4, ptr %a7
  br label %endif2
endif2:
  %t5 = call i32 @SDL_Init(i32 48)
  %t6 = call ptr @SDL_CreateWindow(ptr @.s9, i32 805240832, i32 805240832, i32 640, i32 280, i32 0)
  %t7 = call ptr @SDL_CreateRenderer(ptr %t6, i32 -1, i32 1)
  %t8 = getelementptr i8, ptr %a2, i32 0
  store i64 0, ptr %t8
  %t9 = getelementptr i8, ptr %a2, i32 8
  store i64 0, ptr %t9
  %t10 = getelementptr i8, ptr %a2, i32 16
  store i64 0, ptr %t10
  %t11 = getelementptr i8, ptr %a2, i32 24
  store i64 0, ptr %t11
  store i32 22050, ptr %a2
  %t12 = getelementptr i8, ptr %a2, i32 4
  store i8 16, ptr %t12
  %t13 = getelementptr i8, ptr %a2, i32 5
  store i8 -128, ptr %t13
  %t14 = getelementptr i8, ptr %a2, i32 6
  store i8 1, ptr %t14
  %t15 = getelementptr i8, ptr %a2, i32 9
  store i8 2, ptr %t15
  %t16 = call i32 @SDL_OpenAudioDevice(ptr null, i32 0, ptr %a2, ptr %a3, i32 0)
  %t17 = icmp ne i32 %t16, 0
  br i1 %t17, label %then3, label %endif4
then3:
  call void @SDL_PauseAudioDevice(i32 %t16, i32 0)
  br label %endif4
endif4:
  br label %wc5
wc5:
  %t18 = load i32, ptr %a5
  %t19 = icmp ne i32 %t18, 0
  br i1 %t19, label %wb6, label %we7
wb6:
  br label %wc8
wc8:
  %t20 = call i32 @SDL_PollEvent(ptr %a1)
  %t21 = icmp ne i32 %t20, 0
  br i1 %t21, label %wb9, label %we10
wb9:
  %t22 = load i32, ptr %a1
  %t23 = icmp eq i32 %t22, 256
  br i1 %t23, label %then11, label %endif12
then11:
  store i32 0, ptr %a5
  br label %endif12
endif12:
  %t24 = icmp eq i32 %t22, 768
  br i1 %t24, label %then13, label %endif14
then13:
  %t25 = getelementptr i8, ptr %a1, i32 16
  %t26 = load i32, ptr %t25
  %t27 = icmp eq i32 %t26, 41
  br i1 %t27, label %then15, label %endif16
then15:
  store i32 0, ptr %a5
  br label %endif16
endif16:
  %t28 = icmp eq i32 %t26, 44
  br i1 %t28, label %then17, label %endif18
then17:
  %t29 = load i32, ptr %a8
  %t30 = sub i32 1, %t29
  store i32 %t30, ptr %a8
  br label %endif18
endif18:
  %t31 = icmp eq i32 %t26, 82
  %t32 = load i32, ptr %a9
  %t33 = icmp slt i32 %t32, 200
  %t34 = and i1 %t31, %t33
  br i1 %t34, label %then19, label %endif20
then19:
  %t35 = load i32, ptr %a9
  %t36 = add i32 %t35, 10
  store i32 %t36, ptr %a9
  br label %endif20
endif20:
  %t37 = icmp eq i32 %t26, 81
  %t38 = load i32, ptr %a9
  %t39 = icmp sgt i32 %t38, 50
  %t40 = and i1 %t37, %t39
  br i1 %t40, label %then21, label %endif22
then21:
  %t41 = load i32, ptr %a9
  %t42 = sub i32 %t41, 10
  store i32 %t42, ptr %a9
  br label %endif22
endif22:
  %t43 = icmp eq i32 %t26, 30
  br i1 %t43, label %then23, label %endif24
then23:
  store i32 0, ptr %a10
  br label %endif24
endif24:
  %t44 = icmp eq i32 %t26, 31
  br i1 %t44, label %then25, label %endif26
then25:
  store i32 1, ptr %a10
  br label %endif26
endif26:
  %t45 = icmp eq i32 %t26, 32
  br i1 %t45, label %then27, label %endif28
then27:
  store i32 2, ptr %a10
  br label %endif28
endif28:
  %t46 = icmp eq i32 %t26, 21
  br i1 %t46, label %then29, label %endif30
then29:
  store i32 0, ptr %a11
  br label %endif30
endif30:
  br label %endif14
endif14:
  br label %wc8
we10:
  %t47 = icmp ne i32 %t16, 0
  %t48 = load i32, ptr %a8
  %t49 = icmp eq i32 %t48, 0
  %t50 = and i1 %t47, %t49
  br i1 %t50, label %then31, label %endif32
then31:
  %t51 = call i32 @SDL_GetQueuedAudioSize(i32 %t16)
  %t52 = icmp slt i32 %t51, 8820
  br i1 %t52, label %then33, label %endif34
then33:
  %t53 = load i32, ptr %a9
  %t54 = sdiv i32 661500, %t53
  %t55 = load i32, ptr %a11
  %t56 = load i32, ptr %a10
  call void @synth(ptr %a4, i32 1024, i32 %t55, i32 %t54, i32 %t56)
  %t57 = call i32 @SDL_QueueAudio(i32 %t16, ptr %a4, i32 2048)
  %t58 = load i32, ptr %a11
  %t59 = add i32 %t58, 1024
  store i32 %t59, ptr %a11
  %t60 = load i32, ptr %a12
  %t61 = add i32 %t60, 1024
  store i32 %t61, ptr %a12
  br label %endif34
endif34:
  br label %endif32
endif32:
  %t62 = load i32, ptr %a9
  %t63 = sdiv i32 661500, %t62
  %t64 = load i32, ptr %a11
  %t65 = mul i32 %t63, 132
  %t66 = srem i32 %t64, %t65
  %t67 = sdiv i32 %t66, %t63
  %t68 = call i32 @note_idx(i32 %t67, ptr %a13)
  %t69 = mul i32 %t66, 640
  %t70 = mul i32 %t63, 132
  %t71 = sdiv i32 %t69, %t70
  %t72 = getelementptr i32, ptr @notes, i32 %t68
  %t73 = load i32, ptr %t72
  %t74 = load i32, ptr %a10
  %t75 = load i32, ptr %a8
  %t76 = load i32, ptr %a9
  call void @draw_ui(ptr %t7, i32 %t73, i32 %t71, i32 %t74, i32 %t75, i32 %t76)
  call void @SDL_RenderPresent(ptr %t7)
  call void @SDL_Delay(i32 16)
  %t77 = load i32, ptr %a6
  %t78 = add i32 %t77, 1
  store i32 %t78, ptr %a6
  %t79 = load i32, ptr %a7
  %t80 = icmp sgt i32 %t79, 0
  %t81 = load i32, ptr %a6
  %t82 = load i32, ptr %a7
  %t83 = icmp sge i32 %t81, %t82
  %t84 = and i1 %t80, %t83
  br i1 %t84, label %then35, label %endif36
then35:
  store i32 0, ptr %a5
  br label %endif36
endif36:
  br label %wc5
we7:
  %t85 = load i32, ptr %a6
  %t86 = load i32, ptr %a12
  %t87 = load i32, ptr %a9
  %t88 = call i32 (ptr, ...) @printf(ptr @.s10, i32 %t85, i32 %t86, i32 %t87)
  %t89 = icmp ne i32 %t16, 0
  br i1 %t89, label %then37, label %endif38
then37:
  call void @SDL_CloseAudioDevice(i32 %t16)
  br label %endif38
endif38:
  call void @SDL_DestroyRenderer(ptr %t7)
  call void @SDL_DestroyWindow(ptr %t6)
  call void @SDL_Quit()
  ret i32 0
}

