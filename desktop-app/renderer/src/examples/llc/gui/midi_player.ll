; MIDI 播放器（SDL2 音訊＋影像＋鍵盤＋檔案）：在 IR 裡解析標準 MIDI 檔（SMF 格式 0／1、變長時間、running status、tempo 表），即時合成（最多 12 聲部的正弦）
; 經 SDL_QueueAudio 送出，視窗畫捲動的 piano roll。第一個參數＝.mid 檔（fopen 讀沙盒或 /mnt/<名稱>）；沒給就播內嵌示範曲。空白＝暫停、R＝從頭、Esc 離開；第二個參數＝跑幾幀後離開（測試用）。
; （由 _gen/_gen_midi_player.py 產生）
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
declare ptr @fopen(ptr, ptr)
declare i64 @fread(ptr, i64, i64, ptr)
declare i32 @fclose(ptr)
declare double @sin(double)
declare double @pow(double, double)
declare i32 @atoi(ptr)
declare i32 @printf(ptr, ...)

@.s1 = private constant [8 x i8] c"PLAYING\00"
@.s2 = private constant [8 x i8] c"PAUSED \00"
@.s3 = private constant [6 x i8] c"NOTES\00"
@.s4 = private constant [33 x i8] c"SPACE PAUSE\20\20R RESTART\20\20ESC QUIT\00"
@.s5 = private constant [13 x i8] c"SOURCE: FILE\00"
@.s6 = private constant [13 x i8] c"SOURCE: DEMO\00"
@.s7 = private constant [3 x i8] c"rb\00"
@.s8 = private constant [16 x i8] c"cannot open %s\0A\00"
@.s9 = private constant [17 x i8] c"not a MIDI file\0A\00"
@.s10 = private constant [15 x i8] c"IR MIDI player\00"
@.s11 = private constant [51 x i8] c"notes=%d tempos=%d div=%d seconds=%d played=%d ok\0A\00"
@hud_font = private constant [1235 x i32] [i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 20, i32 20, i32 20, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 10, i32 20, i32 63, i32 20, i32 20, i32 126, i32 40, i32 40, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 28, i32 40, i32 40, i32 28, i32 10, i32 10, i32 60, i32 8, i32 8, i32 0, i32 0, i32 0, i32 48, i32 72, i32 50, i32 4, i32 24, i32 46, i32 10, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 32, i32 48, i32 74, i32 70, i32 98, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 16, i32 16, i32 16, i32 16, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 16, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 8, i32 42, i32 28, i32 28, i32 42, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 126, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 42, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 2, i32 4, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 6, i32 24, i32 6, i32 2, i32 38, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 12, i32 12, i32 20, i32 36, i32 36, i32 62, i32 4, i32 4, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 32, i32 32, i32 60, i32 6, i32 2, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 48, i32 32, i32 60, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 4, i32 4, i32 8, i32 8, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 34, i32 28, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 38, i32 58, i32 2, i32 4, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 8, i32 8, i32 0, i32 0, i32 8, i32 8, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 2, i32 28, i32 96, i32 24, i32 6, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 0, i32 126, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 96, i32 28, i32 2, i32 28, i32 96, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 6, i32 4, i32 8, i32 8, i32 8, i32 0, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 66, i32 78, i32 82, i32 82, i32 78, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 8, i32 24, i32 20, i32 20, i32 36, i32 62, i32 34, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 60, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 50, i32 32, i32 32, i32 32, i32 32, i32 50, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 56, i32 36, i32 34, i32 34, i32 34, i32 34, i32 36, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 32, i32 32, i32 62, i32 32, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 32, i32 32, i32 38, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 62, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 4, i32 4, i32 4, i32 4, i32 4, i32 36, i32 56, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 36, i32 40, i32 56, i32 40, i32 36, i32 38, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 102, i32 86, i32 90, i32 74, i32 66, i32 66, i32 66, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 50, i32 50, i32 42, i32 42, i32 42, i32 38, i32 38, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 34, i32 34, i32 38, i32 28, i32 4, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 38, i32 56, i32 36, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 36, i32 32, i32 48, i32 12, i32 2, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 126, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 34, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 34, i32 34, i32 36, i32 20, i32 20, i32 24, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 74, i32 90, i32 58, i32 54, i32 54, i32 36, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 52, i32 20, i32 8, i32 24, i32 20, i32 34, i32 98, i32 0, i32 0, i32 0, i32 0, i32 0, i32 98, i32 38, i32 20, i32 24, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 2, i32 4, i32 8, i32 8, i32 16, i32 32, i32 62, i32 0, i32 0, i32 0, i32 0, i32 28, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 28, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 16, i32 16, i32 8, i32 8, i32 4, i32 4, i32 2, i32 0, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 24, i32 0, i32 0, i32 0, i32 0, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 2, i32 62, i32 34, i32 38, i32 58, i32 0, i32 0, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 48, i32 32, i32 32, i32 48, i32 30, i32 0, i32 0, i32 0, i32 0, i32 2, i32 2, i32 2, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 34, i32 62, i32 32, i32 32, i32 30, i32 0, i32 0, i32 0, i32 0, i32 14, i32 8, i32 8, i32 62, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 4, i32 60, i32 0, i32 0, i32 32, i32 32, i32 32, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 56, i32 8, i32 8, i32 8, i32 8, i32 62, i32 0, i32 0, i32 0, i32 0, i32 8, i32 0, i32 0, i32 24, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 56, i32 0, i32 0, i32 32, i32 32, i32 32, i32 38, i32 44, i32 56, i32 44, i32 36, i32 34, i32 0, i32 0, i32 0, i32 0, i32 48, i32 16, i32 16, i32 16, i32 16, i32 16, i32 16, i32 8, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 54, i32 42, i32 42, i32 42, i32 42, i32 42, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 38, i32 34, i32 34, i32 34, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 38, i32 34, i32 34, i32 38, i32 28, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 60, i32 34, i32 34, i32 34, i32 34, i32 60, i32 32, i32 32, i32 0, i32 0, i32 0, i32 0, i32 0, i32 26, i32 38, i32 34, i32 34, i32 38, i32 26, i32 2, i32 2, i32 0, i32 0, i32 0, i32 0, i32 0, i32 30, i32 16, i32 16, i32 16, i32 16, i32 16, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 28, i32 32, i32 48, i32 12, i32 6, i32 60, i32 0, i32 0, i32 0, i32 0, i32 0, i32 16, i32 16, i32 62, i32 16, i32 16, i32 16, i32 16, i32 14, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 34, i32 34, i32 38, i32 26, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 36, i32 20, i32 24, i32 24, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 65, i32 66, i32 42, i32 58, i32 58, i32 52, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 20, i32 24, i32 24, i32 20, i32 34, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 34, i32 34, i32 20, i32 20, i32 24, i32 8, i32 24, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 62, i32 4, i32 8, i32 16, i32 16, i32 62, i32 0, i32 0, i32 0, i32 0, i32 12, i32 8, i32 8, i32 8, i32 48, i32 8, i32 8, i32 8, i32 8, i32 12, i32 0, i32 0, i32 0, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 8, i32 0, i32 0, i32 48, i32 8, i32 8, i32 8, i32 4, i32 8, i32 8, i32 8, i32 8, i32 48, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 48, i32 78, i32 0, i32 0, i32 0, i32 0]
@demo = private constant [501 x i8] c"MThd\00\00\00\06\00\01\00\03\01\E0MTrk\00\00\00\13\00\FFQ\03\07\A1 \00\FFX\04\04\02\18\08\00\FF/\00MTrk\00\00\011\00\90@Z\83B@\00\1EL\00\00@Z\83B@\00\1EL\00\00AZ\83BA\00\1EM\00\00CZ\83BC\00\1EO\00\00CZ\83BC\00\1EO\00\00AZ\83BA\00\1EM\00\00@Z\83B@\00\1EL\00\00>Z\83B>\00\1EJ\00\00<Z\83B<\00\1EH\00\00<Z\83B<\00\1EH\00\00>Z\83B>\00\1EJ\00\00@Z\83B@\00\1EL\00\00@Z\852@\00\1EL\00\00>Z\81R>\00\1EJ\00\00>Z\87\22>\00\1EJ\00\00@Z\83B@\00\1EL\00\00@Z\83B@\00\1EL\00\00AZ\83BA\00\1EM\00\00CZ\83BC\00\1EO\00\00CZ\83BC\00\1EO\00\00AZ\83BA\00\1EM\00\00@Z\83B@\00\1EL\00\00>Z\83B>\00\1EJ\00\00<Z\83B<\00\1EH\00\00<Z\83B<\00\1EH\00\00>Z\83B>\00\1EJ\00\00@Z\83B@\00\1EL\00\00>Z\852>\00\1EJ\00\00<Z\81R<\00\1EH\00\00<Z\87\22<\00\1EH\00\00\FF/\00MTrk\00\00\00\8B\00\910F\8F\00\810\00\00\917F\8F\00\817\00\00\910F\8F\00\810\00\00\917F\8F\00\817\00\00\910F\8F\00\810\00\00\917F\8F\00\817\00\00\910F\8F\00\810\00\00\917F\8F\00\817\00\00\910F\8F\00\810\00\00\917F\8F\00\817\00\00\910F\8F\00\810\00\00\917F\8F\00\817\00\00\910F\8F\00\810\00\00\917F\8F\00\817\00\00\910F\8F\00\810\00\00\FF/\00"

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


define i32 @rd16(ptr %d, i32 %i) {
entry:
  %t1 = getelementptr i8, ptr %d, i32 %i
  %t2 = load i8, ptr %t1
  %t3 = sext i8 %t2 to i32
  %t4 = and i32 %t3, 255
  %t5 = shl i32 %t4, 8
  %t6 = add i32 %i, 1
  %t7 = getelementptr i8, ptr %d, i32 %t6
  %t8 = load i8, ptr %t7
  %t9 = sext i8 %t8 to i32
  %t10 = and i32 %t9, 255
  %t11 = or i32 %t5, %t10
  ret i32 %t11
}

define i32 @rd32(ptr %d, i32 %i) {
entry:
  %t1 = getelementptr i8, ptr %d, i32 %i
  %t2 = load i8, ptr %t1
  %t3 = sext i8 %t2 to i32
  %t4 = and i32 %t3, 255
  %t5 = shl i32 %t4, 24
  %t6 = add i32 %i, 1
  %t7 = getelementptr i8, ptr %d, i32 %t6
  %t8 = load i8, ptr %t7
  %t9 = sext i8 %t8 to i32
  %t10 = and i32 %t9, 255
  %t11 = shl i32 %t10, 16
  %t12 = or i32 %t5, %t11
  %t13 = add i32 %i, 2
  %t14 = getelementptr i8, ptr %d, i32 %t13
  %t15 = load i8, ptr %t14
  %t16 = sext i8 %t15 to i32
  %t17 = and i32 %t16, 255
  %t18 = shl i32 %t17, 8
  %t19 = or i32 %t12, %t18
  %t20 = add i32 %i, 3
  %t21 = getelementptr i8, ptr %d, i32 %t20
  %t22 = load i8, ptr %t21
  %t23 = sext i8 %t22 to i32
  %t24 = and i32 %t23, 255
  %t25 = or i32 %t19, %t24
  ret i32 %t25
}

define i32 @vlq(ptr %d, ptr %posp) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  store i32 0, ptr %a1
  store i32 1, ptr %a2
  br label %wc1
wc1:
  %t1 = load i32, ptr %a2
  %t2 = icmp ne i32 %t1, 0
  br i1 %t2, label %wb2, label %we3
wb2:
  %t3 = getelementptr i32, ptr %posp, i32 0
  %t4 = load i32, ptr %t3
  %t5 = getelementptr i8, ptr %d, i32 %t4
  %t6 = load i8, ptr %t5
  %t7 = sext i8 %t6 to i32
  %t8 = and i32 %t7, 255
  %t9 = getelementptr i32, ptr %posp, i32 0
  %t10 = load i32, ptr %t9
  %t11 = add i32 %t10, 1
  %t12 = getelementptr i32, ptr %posp, i32 0
  store i32 %t11, ptr %t12
  %t13 = load i32, ptr %a1
  %t14 = shl i32 %t13, 7
  %t15 = and i32 %t8, 127
  %t16 = or i32 %t14, %t15
  store i32 %t16, ptr %a1
  %t17 = and i32 %t8, 128
  %t18 = icmp eq i32 %t17, 0
  br i1 %t18, label %then4, label %endif5
then4:
  store i32 0, ptr %a2
  br label %endif5
endif5:
  br label %wc1
we3:
  %t19 = load i32, ptr %a1
  ret i32 %t19
}

define i32 @parse(ptr %d, i32 %len, ptr %ns, ptr %ne, ptr %nk, ptr %nv, ptr %tt, ptr %tm, ptr %info) {
entry:
  %a1 = alloca i32
  %a2 = alloca i32
  %a3 = alloca i32
  %a4 = alloca i32
  %a5 = alloca i32
  %a6 = alloca [2048 x i32]
  %a7 = alloca i32
  %a8 = alloca i32
  %a9 = alloca i32
  %a10 = alloca i32
  %a11 = alloca i32
  %a12 = alloca i32
  %a13 = alloca i32
  %a14 = alloca i32
  store i32 0, ptr %a1
  store i32 0, ptr %a2
  store i32 0, ptr %a3
  store i32 0, ptr %a4
  store i32 0, ptr %a5
  %t1 = call i32 @rd32(ptr %d, i32 0)
  %t2 = icmp ne i32 %t1, 1297377380
  br i1 %t2, label %then1, label %endif2
then1:
  ret i32 -1
endif2:
  %t3 = call i32 @rd16(ptr %d, i32 12)
  %t4 = getelementptr i32, ptr %info, i32 0
  store i32 %t3, ptr %t4
  %t5 = call i32 @rd16(ptr %d, i32 10)
  store i32 %t5, ptr %a5
  store i32 14, ptr %a3
  store i32 0, ptr %a8
  store i32 0, ptr %a9
  store i32 0, ptr %a10
  store i32 0, ptr %a11
  store i32 0, ptr %a12
  store i32 0, ptr %a13
  store i32 0, ptr %a4
  br label %lc3
lc3:
  %t6 = load i32, ptr %a4
  %t7 = load i32, ptr %a5
  %t8 = icmp slt i32 %t6, %t7
  br i1 %t8, label %lb4, label %le5
lb4:
  %t9 = load i32, ptr %a3
  %t10 = add i32 %t9, 8
  %t11 = icmp sgt i32 %t10, %len
  %t12 = load i32, ptr %a3
  %t13 = call i32 @rd32(ptr %d, i32 %t12)
  %t14 = icmp ne i32 %t13, 1297379947
  %t15 = or i1 %t11, %t14
  br i1 %t15, label %then6, label %endif7
then6:
  %t16 = load i32, ptr %a1
  ret i32 %t16
endif7:
  %t17 = load i32, ptr %a3
  %t18 = add i32 %t17, 4
  %t19 = call i32 @rd32(ptr %d, i32 %t18)
  %t20 = load i32, ptr %a3
  %t21 = add i32 %t20, 8
  store i32 %t21, ptr %a3
  %t22 = load i32, ptr %a3
  %t23 = add i32 %t22, %t19
  store i32 %t23, ptr %a10
  %t24 = load i32, ptr %a10
  %t25 = icmp sgt i32 %t24, %len
  br i1 %t25, label %then8, label %endif9
then8:
  store i32 %len, ptr %a10
  br label %endif9
endif9:
  store i32 0, ptr %a8
  store i32 0, ptr %a9
  store i32 0, ptr %a13
  br label %lc10
lc10:
  %t26 = load i32, ptr %a13
  %t27 = icmp slt i32 %t26, 2048
  br i1 %t27, label %lb11, label %le12
lb11:
  %t28 = load i32, ptr %a13
  %t29 = getelementptr i32, ptr %a6, i32 %t28
  store i32 -1, ptr %t29
  %t30 = load i32, ptr %a13
  %t31 = add i32 %t30, 1
  store i32 %t31, ptr %a13
  br label %lc10
le12:
  br label %wc13
wc13:
  %t32 = load i32, ptr %a3
  %t33 = load i32, ptr %a10
  %t34 = icmp slt i32 %t32, %t33
  br i1 %t34, label %wb14, label %we15
wb14:
  %t35 = load i32, ptr %a3
  %t36 = getelementptr i32, ptr %a7, i32 0
  store i32 %t35, ptr %t36
  %t37 = call i32 @vlq(ptr %d, ptr %a7)
  %t38 = load i32, ptr %a8
  %t39 = add i32 %t38, %t37
  store i32 %t39, ptr %a8
  %t40 = getelementptr i32, ptr %a7, i32 0
  %t41 = load i32, ptr %t40
  store i32 %t41, ptr %a3
  %t42 = load i32, ptr %a3
  %t43 = getelementptr i8, ptr %d, i32 %t42
  %t44 = load i8, ptr %t43
  %t45 = sext i8 %t44 to i32
  %t46 = and i32 %t45, 255
  %t47 = icmp sge i32 %t46, 128
  br i1 %t47, label %then16, label %endif17
then16:
  store i32 %t46, ptr %a9
  %t48 = load i32, ptr %a3
  %t49 = add i32 %t48, 1
  store i32 %t49, ptr %a3
  br label %endif17
endif17:
  %t50 = load i32, ptr %a9
  %t51 = icmp eq i32 %t50, 255
  br i1 %t51, label %then18, label %endif19
then18:
  %t52 = load i32, ptr %a3
  %t53 = getelementptr i8, ptr %d, i32 %t52
  %t54 = load i8, ptr %t53
  %t55 = sext i8 %t54 to i32
  %t56 = and i32 %t55, 255
  store i32 %t56, ptr %a11
  %t57 = load i32, ptr %a3
  %t58 = add i32 %t57, 1
  store i32 %t58, ptr %a3
  %t59 = load i32, ptr %a3
  %t60 = getelementptr i32, ptr %a7, i32 0
  store i32 %t59, ptr %t60
  %t61 = call i32 @vlq(ptr %d, ptr %a7)
  store i32 %t61, ptr %a12
  %t62 = getelementptr i32, ptr %a7, i32 0
  %t63 = load i32, ptr %t62
  store i32 %t63, ptr %a3
  %t64 = load i32, ptr %a11
  %t65 = icmp eq i32 %t64, 81
  %t66 = load i32, ptr %a12
  %t67 = icmp sge i32 %t66, 3
  %t68 = and i1 %t65, %t67
  %t69 = load i32, ptr %a2
  %t70 = icmp slt i32 %t69, 64
  %t71 = and i1 %t68, %t70
  br i1 %t71, label %then20, label %endif21
then20:
  %t72 = load i32, ptr %a8
  %t73 = load i32, ptr %a2
  %t74 = getelementptr i32, ptr %tt, i32 %t73
  store i32 %t72, ptr %t74
  %t75 = load i32, ptr %a3
  %t76 = getelementptr i8, ptr %d, i32 %t75
  %t77 = load i8, ptr %t76
  %t78 = sext i8 %t77 to i32
  %t79 = and i32 %t78, 255
  %t80 = shl i32 %t79, 16
  %t81 = load i32, ptr %a3
  %t82 = add i32 %t81, 1
  %t83 = getelementptr i8, ptr %d, i32 %t82
  %t84 = load i8, ptr %t83
  %t85 = sext i8 %t84 to i32
  %t86 = and i32 %t85, 255
  %t87 = shl i32 %t86, 8
  %t88 = or i32 %t80, %t87
  %t89 = load i32, ptr %a3
  %t90 = add i32 %t89, 2
  %t91 = getelementptr i8, ptr %d, i32 %t90
  %t92 = load i8, ptr %t91
  %t93 = sext i8 %t92 to i32
  %t94 = and i32 %t93, 255
  %t95 = or i32 %t88, %t94
  %t96 = load i32, ptr %a2
  %t97 = getelementptr i32, ptr %tm, i32 %t96
  store i32 %t95, ptr %t97
  %t98 = load i32, ptr %a2
  %t99 = add i32 %t98, 1
  store i32 %t99, ptr %a2
  br label %endif21
endif21:
  %t100 = load i32, ptr %a12
  %t101 = load i32, ptr %a3
  %t102 = add i32 %t101, %t100
  store i32 %t102, ptr %a3
  %t103 = load i32, ptr %a11
  %t104 = icmp eq i32 %t103, 47
  br i1 %t104, label %then22, label %endif23
then22:
  br label %we15
endif23:
  br label %endif19
endif19:
  %t105 = icmp eq i32 %t50, 240
  %t106 = icmp eq i32 %t50, 247
  %t107 = or i1 %t105, %t106
  br i1 %t107, label %then24, label %endif25
then24:
  %t108 = load i32, ptr %a3
  %t109 = getelementptr i32, ptr %a7, i32 0
  store i32 %t108, ptr %t109
  %t110 = call i32 @vlq(ptr %d, ptr %a7)
  store i32 %t110, ptr %a12
  %t111 = getelementptr i32, ptr %a7, i32 0
  %t112 = load i32, ptr %t111
  %t113 = load i32, ptr %a12
  %t114 = add i32 %t112, %t113
  store i32 %t114, ptr %a3
  br label %endif25
endif25:
  %t115 = icmp slt i32 %t50, 240
  br i1 %t115, label %then26, label %endif27
then26:
  %t116 = and i32 %t50, 240
  %t117 = and i32 %t50, 15
  %t118 = icmp eq i32 %t116, 192
  %t119 = icmp eq i32 %t116, 208
  %t120 = or i1 %t118, %t119
  %t121 = load i32, ptr %a3
  %t122 = getelementptr i8, ptr %d, i32 %t121
  %t123 = load i8, ptr %t122
  %t124 = sext i8 %t123 to i32
  %t125 = and i32 %t124, 255
  %t126 = load i32, ptr %a3
  %t127 = add i32 %t126, 1
  %t128 = getelementptr i8, ptr %d, i32 %t127
  %t129 = load i8, ptr %t128
  %t130 = sext i8 %t129 to i32
  %t131 = and i32 %t130, 255
  %t132 = select i1 %t120, i32 0, i32 %t131
  %t133 = select i1 %t120, i32 1, i32 2
  %t134 = load i32, ptr %a3
  %t135 = add i32 %t134, %t133
  store i32 %t135, ptr %a3
  %t136 = icmp eq i32 %t116, 144
  %t137 = icmp ne i32 %t132, 0
  %t138 = and i1 %t136, %t137
  %t139 = icmp eq i32 %t116, 128
  %t140 = icmp eq i32 %t116, 144
  %t141 = icmp eq i32 %t132, 0
  %t142 = and i1 %t140, %t141
  %t143 = or i1 %t139, %t142
  %t144 = mul i32 %t117, 128
  %t145 = add i32 %t144, %t125
  %t146 = icmp ne i32 %t117, 9
  %t147 = and i1 %t138, %t146
  br i1 %t147, label %then28, label %endif29
then28:
  %t148 = load i32, ptr %a8
  %t149 = getelementptr i32, ptr %a6, i32 %t145
  store i32 %t148, ptr %t149
  br label %endif29
endif29:
  %t150 = icmp ne i32 %t117, 9
  %t151 = and i1 %t143, %t150
  %t152 = getelementptr i32, ptr %a6, i32 %t145
  %t153 = load i32, ptr %t152
  %t154 = icmp sge i32 %t153, 0
  %t155 = and i1 %t151, %t154
  %t156 = load i32, ptr %a1
  %t157 = icmp slt i32 %t156, 2048
  %t158 = and i1 %t155, %t157
  br i1 %t158, label %then30, label %endif31
then30:
  %t159 = getelementptr i32, ptr %a6, i32 %t145
  %t160 = load i32, ptr %t159
  %t161 = load i32, ptr %a1
  %t162 = getelementptr i32, ptr %ns, i32 %t161
  store i32 %t160, ptr %t162
  %t163 = load i32, ptr %a8
  %t164 = load i32, ptr %a1
  %t165 = getelementptr i32, ptr %ne, i32 %t164
  store i32 %t163, ptr %t165
  %t166 = load i32, ptr %a1
  %t167 = getelementptr i32, ptr %nk, i32 %t166
  store i32 %t125, ptr %t167
  %t168 = load i32, ptr %a1
  %t169 = getelementptr i32, ptr %nv, i32 %t168
  store i32 90, ptr %t169
  %t170 = load i32, ptr %a1
  %t171 = add i32 %t170, 1
  store i32 %t171, ptr %a1
  %t172 = getelementptr i32, ptr %a6, i32 %t145
  store i32 -1, ptr %t172
  br label %endif31
endif31:
  br label %endif27
endif27:
  br label %wc13
we15:
  %t173 = load i32, ptr %a10
  store i32 %t173, ptr %a3
  %t174 = load i32, ptr %a4
  %t175 = add i32 %t174, 1
  store i32 %t175, ptr %a4
  br label %lc3
le5:
  %t176 = load i32, ptr %a2
  %t177 = getelementptr i32, ptr %info, i32 1
  store i32 %t176, ptr %t177
  %t178 = load i32, ptr %a1
  ret i32 %t178
}

define i32 @t2s(i32 %tick, ptr %tt, ptr %tm, i32 %nt, i32 %div) {
entry:
  %a1 = alloca double
  %a2 = alloca i32
  %a3 = alloca i32
  %a4 = alloca i32
  store double 0x0000000000000000, ptr %a1
  store i32 0, ptr %a2
  store i32 500000, ptr %a3
  store i32 0, ptr %a4
  store i32 0, ptr %a4
  br label %lc1
lc1:
  %t1 = load i32, ptr %a4
  %t2 = icmp slt i32 %t1, %nt
  br i1 %t2, label %lb2, label %le3
lb2:
  %t3 = load i32, ptr %a4
  %t4 = getelementptr i32, ptr %tt, i32 %t3
  %t5 = load i32, ptr %t4
  %t6 = icmp slt i32 %t5, %tick
  br i1 %t6, label %then4, label %endif5
then4:
  %t7 = load i32, ptr %a4
  %t8 = getelementptr i32, ptr %tt, i32 %t7
  %t9 = load i32, ptr %t8
  %t10 = load i32, ptr %a2
  %t11 = sub i32 %t9, %t10
  %t12 = sitofp i32 %t11 to double
  %t13 = load i32, ptr %a3
  %t14 = sitofp i32 %t13 to double
  %t15 = fmul double %t12, %t14
  %t16 = sitofp i32 %div to double
  %t17 = fmul double %t16, 0x412E848000000000
  %t18 = fdiv double %t15, %t17
  %t19 = load double, ptr %a1
  %t20 = fadd double %t19, %t18
  store double %t20, ptr %a1
  %t21 = load i32, ptr %a4
  %t22 = getelementptr i32, ptr %tt, i32 %t21
  %t23 = load i32, ptr %t22
  store i32 %t23, ptr %a2
  %t24 = load i32, ptr %a4
  %t25 = getelementptr i32, ptr %tm, i32 %t24
  %t26 = load i32, ptr %t25
  store i32 %t26, ptr %a3
  br label %endif5
endif5:
  %t27 = load i32, ptr %a4
  %t28 = add i32 %t27, 1
  store i32 %t28, ptr %a4
  br label %lc1
le3:
  %t29 = load i32, ptr %a2
  %t30 = sub i32 %tick, %t29
  %t31 = sitofp i32 %t30 to double
  %t32 = load i32, ptr %a3
  %t33 = sitofp i32 %t32 to double
  %t34 = fmul double %t31, %t33
  %t35 = sitofp i32 %div to double
  %t36 = fmul double %t35, 0x412E848000000000
  %t37 = fdiv double %t34, %t36
  %t38 = load double, ptr %a1
  %t39 = fadd double %t38, %t37
  store double %t39, ptr %a1
  %t40 = load double, ptr %a1
  %t41 = fmul double %t40, 0x40D5888000000000
  %t42 = fptosi double %t41 to i32
  ret i32 %t42
}

define void @synth(ptr %buf, i32 %n, i32 %start, ptr %ss, ptr %se, ptr %nk, i32 %cnt) {
entry:
  %a1 = alloca [12 x i32]
  %a2 = alloca [12 x i32]
  %a3 = alloca [12 x double]
  %a4 = alloca i32
  %a5 = alloca i32
  %a6 = alloca i32
  %a7 = alloca i32
  %a8 = alloca double
  store i32 0, ptr %a4
  store i32 0, ptr %a5
  store i32 0, ptr %a6
  store i32 0, ptr %a7
  store i32 0, ptr %a5
  br label %lc1
lc1:
  %t1 = load i32, ptr %a5
  %t2 = icmp slt i32 %t1, %cnt
  br i1 %t2, label %lb2, label %le3
lb2:
  %t3 = load i32, ptr %a5
  %t4 = getelementptr i32, ptr %ss, i32 %t3
  %t5 = load i32, ptr %t4
  %t6 = add i32 %start, %n
  %t7 = icmp slt i32 %t5, %t6
  %t8 = load i32, ptr %a5
  %t9 = getelementptr i32, ptr %se, i32 %t8
  %t10 = load i32, ptr %t9
  %t11 = icmp sgt i32 %t10, %start
  %t12 = and i1 %t7, %t11
  %t13 = load i32, ptr %a4
  %t14 = icmp slt i32 %t13, 12
  %t15 = and i1 %t12, %t14
  br i1 %t15, label %then4, label %endif5
then4:
  %t16 = load i32, ptr %a5
  %t17 = getelementptr i32, ptr %ss, i32 %t16
  %t18 = load i32, ptr %t17
  %t19 = load i32, ptr %a4
  %t20 = getelementptr i32, ptr %a1, i32 %t19
  store i32 %t18, ptr %t20
  %t21 = load i32, ptr %a5
  %t22 = getelementptr i32, ptr %se, i32 %t21
  %t23 = load i32, ptr %t22
  %t24 = load i32, ptr %a4
  %t25 = getelementptr i32, ptr %a2, i32 %t24
  store i32 %t23, ptr %t25
  %t26 = load i32, ptr %a5
  %t27 = getelementptr i32, ptr %nk, i32 %t26
  %t28 = load i32, ptr %t27
  %t29 = sub i32 %t28, 69
  %t30 = sitofp i32 %t29 to double
  %t31 = fdiv double %t30, 0x4028000000000000
  %t32 = call double @pow(double 0x4000000000000000, double %t31)
  %t33 = fmul double %t32, 0x407B800000000000
  %t34 = load i32, ptr %a4
  %t35 = getelementptr double, ptr %a3, i32 %t34
  store double %t33, ptr %t35
  %t36 = load i32, ptr %a4
  %t37 = add i32 %t36, 1
  store i32 %t37, ptr %a4
  br label %endif5
endif5:
  %t38 = load i32, ptr %a5
  %t39 = add i32 %t38, 1
  store i32 %t39, ptr %a5
  br label %lc1
le3:
  store double 0x0000000000000000, ptr %a8
  store i32 0, ptr %a6
  br label %lc6
lc6:
  %t40 = load i32, ptr %a6
  %t41 = icmp slt i32 %t40, %n
  br i1 %t41, label %lb7, label %le8
lb7:
  store double 0x0000000000000000, ptr %a8
  %t42 = load i32, ptr %a6
  %t43 = add i32 %start, %t42
  store i32 0, ptr %a7
  br label %lc9
lc9:
  %t44 = load i32, ptr %a7
  %t45 = load i32, ptr %a4
  %t46 = icmp slt i32 %t44, %t45
  br i1 %t46, label %lb10, label %le11
lb10:
  %t47 = load i32, ptr %a7
  %t48 = getelementptr i32, ptr %a1, i32 %t47
  %t49 = load i32, ptr %t48
  %t50 = icmp sge i32 %t43, %t49
  %t51 = load i32, ptr %a7
  %t52 = getelementptr i32, ptr %a2, i32 %t51
  %t53 = load i32, ptr %t52
  %t54 = icmp slt i32 %t43, %t53
  %t55 = and i1 %t50, %t54
  br i1 %t55, label %then12, label %endif13
then12:
  %t56 = load i32, ptr %a7
  %t57 = getelementptr i32, ptr %a1, i32 %t56
  %t58 = load i32, ptr %t57
  %t59 = sub i32 %t43, %t58
  %t60 = sitofp i32 %t59 to double
  %t61 = fdiv double %t60, 0x4062C00000000000
  %t62 = fcmp ogt double %t61, 0x3FF0000000000000
  %t63 = select i1 %t62, double 0x3FF0000000000000, double %t61
  %t64 = load i32, ptr %a7
  %t65 = getelementptr i32, ptr %a2, i32 %t64
  %t66 = load i32, ptr %t65
  %t67 = sub i32 %t66, %t43
  %t68 = sitofp i32 %t67 to double
  %t69 = fdiv double %t68, 0x407F400000000000
  %t70 = fcmp ogt double %t69, 0x3FF0000000000000
  %t71 = select i1 %t70, double 0x3FF0000000000000, double %t69
  %t72 = load i32, ptr %a7
  %t73 = getelementptr double, ptr %a3, i32 %t72
  %t74 = load double, ptr %t73
  %t75 = fmul double %t60, %t74
  %t76 = fmul double %t75, 0x401921FB53C8D4F1
  %t77 = fdiv double %t76, 0x40D5888000000000
  %t78 = call double @sin(double %t77)
  %t79 = fmul double %t78, %t63
  %t80 = fmul double %t79, %t71
  %t81 = fmul double %t80, 0x40A1300000000000
  %t82 = load double, ptr %a8
  %t83 = fadd double %t82, %t81
  store double %t83, ptr %a8
  br label %endif13
endif13:
  %t84 = load i32, ptr %a7
  %t85 = add i32 %t84, 1
  store i32 %t85, ptr %a7
  br label %lc9
le11:
  %t86 = load double, ptr %a8
  %t87 = fptosi double %t86 to i32
  %t88 = icmp sgt i32 %t87, 30000
  %t89 = icmp slt i32 %t87, -30000
  %t90 = select i1 %t89, i32 -30000, i32 %t87
  %t91 = select i1 %t88, i32 30000, i32 %t90
  %t92 = and i32 %t91, 255
  %t93 = trunc i32 %t92 to i8
  %t94 = load i32, ptr %a6
  %t95 = mul i32 %t94, 2
  %t96 = getelementptr i8, ptr %buf, i32 %t95
  store i8 %t93, ptr %t96
  %t97 = ashr i32 %t91, 8
  %t98 = and i32 %t97, 255
  %t99 = trunc i32 %t98 to i8
  %t100 = load i32, ptr %a6
  %t101 = mul i32 %t100, 2
  %t102 = add i32 %t101, 1
  %t103 = getelementptr i8, ptr %buf, i32 %t102
  store i8 %t99, ptr %t103
  %t104 = load i32, ptr %a6
  %t105 = add i32 %t104, 1
  store i32 %t105, ptr %a6
  br label %lc6
le8:
  ret void
}

define void @draw_ui(ptr %ren, i32 %cur, ptr %ss, ptr %se, ptr %nk, i32 %cnt, i32 %total, i32 %paused, i32 %srcfile) {
entry:
  %a1 = alloca [4 x i32]
  %a2 = alloca i32
  %a3 = alloca i32
  %t1 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 16, i8 18, i8 26, i8 255)
  %t2 = call i32 @SDL_RenderClear(ptr %ren)
  store i32 0, ptr %a2
  store i32 0, ptr %a3
  store i32 0, ptr %a3
  br label %lc1
lc1:
  %t3 = load i32, ptr %a3
  %t4 = icmp slt i32 %t3, %cnt
  br i1 %t4, label %lb2, label %le3
lb2:
  %t5 = load i32, ptr %a3
  %t6 = getelementptr i32, ptr %ss, i32 %t5
  %t7 = load i32, ptr %t6
  %t8 = sub i32 %t7, %cur
  %t9 = mul i32 %t8, 60
  %t10 = sdiv i32 %t9, 22050
  %t11 = add i32 %t10, 100
  %t12 = load i32, ptr %a3
  %t13 = getelementptr i32, ptr %se, i32 %t12
  %t14 = load i32, ptr %t13
  %t15 = sub i32 %t14, %cur
  %t16 = mul i32 %t15, 60
  %t17 = sdiv i32 %t16, 22050
  %t18 = add i32 %t17, 100
  %t19 = icmp sgt i32 %t18, 0
  %t20 = icmp slt i32 %t11, 640
  %t21 = and i1 %t19, %t20
  %t22 = load i32, ptr %a2
  %t23 = icmp slt i32 %t22, 190
  %t24 = and i1 %t21, %t23
  br i1 %t24, label %then4, label %endif5
then4:
  %t25 = load i32, ptr %a3
  %t26 = getelementptr i32, ptr %nk, i32 %t25
  %t27 = load i32, ptr %t26
  %t28 = sub i32 96, %t27
  %t29 = mul i32 %t28, 4
  %t30 = add i32 %t29, 6
  %t31 = load i32, ptr %a3
  %t32 = getelementptr i32, ptr %ss, i32 %t31
  %t33 = load i32, ptr %t32
  %t34 = icmp sle i32 %t33, %cur
  %t35 = load i32, ptr %a3
  %t36 = getelementptr i32, ptr %se, i32 %t35
  %t37 = load i32, ptr %t36
  %t38 = icmp sgt i32 %t37, %cur
  %t39 = and i1 %t34, %t38
  %t40 = sub i32 %t18, %t11
  %t41 = icmp sgt i32 %t40, 2
  %t42 = sub i32 %t18, %t11
  %t43 = select i1 %t41, i32 %t42, i32 2
  %t44 = select i1 %t39, i32 255, i32 80
  %t45 = trunc i32 %t44 to i8
  %t46 = select i1 %t39, i32 210, i32 170
  %t47 = trunc i32 %t46 to i8
  %t48 = select i1 %t39, i32 80, i32 230
  %t49 = trunc i32 %t48 to i8
  %t50 = getelementptr i32, ptr %a1, i32 0
  store i32 %t11, ptr %t50
  %t51 = getelementptr i32, ptr %a1, i32 1
  store i32 %t30, ptr %t51
  %t52 = getelementptr i32, ptr %a1, i32 2
  store i32 %t43, ptr %t52
  %t53 = getelementptr i32, ptr %a1, i32 3
  store i32 3, ptr %t53
  %t54 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 %t45, i8 %t47, i8 %t49, i8 255)
  %t55 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  %t56 = load i32, ptr %a2
  %t57 = add i32 %t56, 1
  store i32 %t57, ptr %a2
  br label %endif5
endif5:
  %t58 = load i32, ptr %a3
  %t59 = add i32 %t58, 1
  store i32 %t59, ptr %a3
  br label %lc1
le3:
  %t60 = getelementptr i32, ptr %a1, i32 0
  store i32 100, ptr %t60
  %t61 = getelementptr i32, ptr %a1, i32 1
  store i32 0, ptr %t61
  %t62 = getelementptr i32, ptr %a1, i32 2
  store i32 1, ptr %t62
  %t63 = getelementptr i32, ptr %a1, i32 3
  store i32 250, ptr %t63
  %t64 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 255, i8 255, i8 255, i8 255)
  %t65 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  %t66 = mul i32 %cur, 640
  %t67 = add i32 %total, 1
  %t68 = sdiv i32 %t66, %t67
  %t69 = getelementptr i32, ptr %a1, i32 0
  store i32 0, ptr %t69
  %t70 = getelementptr i32, ptr %a1, i32 1
  store i32 246, ptr %t70
  %t71 = getelementptr i32, ptr %a1, i32 2
  store i32 %t68, ptr %t71
  %t72 = getelementptr i32, ptr %a1, i32 3
  store i32 4, ptr %t72
  %t73 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 90, i8 200, i8 120, i8 255)
  %t74 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  %t75 = icmp ne i32 %paused, 0
  br i1 %t75, label %then6, label %endif7
then6:
  %t76 = getelementptr i32, ptr %a1, i32 0
  store i32 590, ptr %t76
  %t77 = getelementptr i32, ptr %a1, i32 1
  store i32 10, ptr %t77
  %t78 = getelementptr i32, ptr %a1, i32 2
  store i32 8, ptr %t78
  %t79 = getelementptr i32, ptr %a1, i32 3
  store i32 20, ptr %t79
  %t80 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 255, i8 180, i8 60, i8 255)
  %t81 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  %t82 = getelementptr i32, ptr %a1, i32 0
  store i32 606, ptr %t82
  %t83 = getelementptr i32, ptr %a1, i32 1
  store i32 10, ptr %t83
  %t84 = getelementptr i32, ptr %a1, i32 2
  store i32 8, ptr %t84
  %t85 = getelementptr i32, ptr %a1, i32 3
  store i32 20, ptr %t85
  %t86 = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 255, i8 180, i8 60, i8 255)
  %t87 = call i32 @SDL_RenderFillRect(ptr %ren, ptr %a1)
  br label %endif7
endif7:
  %t88 = icmp eq i32 %paused, 0
  br i1 %t88, label %then8, label %endif9
then8:
  call void @hud_text(ptr %ren, i32 8, i32 262, ptr @.s1, i32 7, i8 255, i8 210, i8 90)
  br label %endif9
endif9:
  %t89 = icmp ne i32 %paused, 0
  br i1 %t89, label %then10, label %endif11
then10:
  call void @hud_text(ptr %ren, i32 8, i32 262, ptr @.s2, i32 7, i8 255, i8 210, i8 90)
  br label %endif11
endif11:
  call void @hud_text(ptr %ren, i32 64, i32 262, ptr @.s3, i32 5, i8 255, i8 210, i8 90)
  call void @hud_int(ptr %ren, i32 106, i32 262, i32 %cnt, i8 255, i8 210, i8 90)
  call void @hud_text(ptr %ren, i32 8, i32 280, ptr @.s4, i32 32, i8 220, i8 220, i8 220)
  %t90 = icmp ne i32 %srcfile, 0
  br i1 %t90, label %then12, label %endif13
then12:
  call void @hud_text(ptr %ren, i32 8, i32 298, ptr @.s5, i32 12, i8 220, i8 220, i8 220)
  br label %endif13
endif13:
  %t91 = icmp eq i32 %srcfile, 0
  br i1 %t91, label %then14, label %endif15
then14:
  call void @hud_text(ptr %ren, i32 8, i32 298, ptr @.s6, i32 12, i8 220, i8 220, i8 220)
  br label %endif15
endif15:
  ret void
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  %a1 = alloca [24576 x i8]
  %a2 = alloca [56 x i8]
  %a3 = alloca [32 x i8]
  %a4 = alloca [32 x i8]
  %a5 = alloca [2048 x i8]
  %a6 = alloca [2048 x i32]
  %a7 = alloca [2048 x i32]
  %a8 = alloca [2048 x i32]
  %a9 = alloca [2048 x i32]
  %a10 = alloca [2048 x i32]
  %a11 = alloca [2048 x i32]
  %a12 = alloca [64 x i32]
  %a13 = alloca [64 x i32]
  %a14 = alloca [4 x i32]
  %a15 = alloca i32
  %a16 = alloca i32
  %a17 = alloca i32
  %a18 = alloca i32
  %a19 = alloca i32
  %a20 = alloca i32
  %a21 = alloca i32
  %a22 = alloca ptr
  %a23 = alloca i32
  %a24 = alloca i32
  %a25 = alloca i32
  %a26 = alloca i32
  store i32 1, ptr %a15
  store i32 0, ptr %a16
  store i32 0, ptr %a17
  store i32 0, ptr %a18
  store i32 0, ptr %a19
  store i32 0, ptr %a20
  store i32 0, ptr %a21
  %t1 = icmp sgt i32 %argc, 2
  br i1 %t1, label %then1, label %endif2
then1:
  %t2 = getelementptr ptr, ptr %argv, i32 2
  %t3 = load ptr, ptr %t2
  %t4 = call i32 @atoi(ptr %t3)
  store i32 %t4, ptr %a17
  br label %endif2
endif2:
  store ptr null, ptr %a22
  %t5 = icmp sgt i32 %argc, 1
  br i1 %t5, label %then3, label %endif4
then3:
  %t6 = getelementptr ptr, ptr %argv, i32 1
  %t7 = load ptr, ptr %t6
  store ptr %t7, ptr %a22
  br label %endif4
endif4:
  store i32 0, ptr %a23
  %t8 = icmp sgt i32 %argc, 1
  br i1 %t8, label %then5, label %endif6
then5:
  %t9 = getelementptr ptr, ptr %argv, i32 1
  %t10 = load ptr, ptr %t9
  %t11 = getelementptr i8, ptr %t10, i32 0
  %t12 = load i8, ptr %t11
  %t13 = sext i8 %t12 to i32
  %t14 = and i32 %t13, 255
  %t15 = icmp ne i32 %t14, 45
  br i1 %t15, label %then7, label %endif8
then7:
  store i32 1, ptr %a23
  br label %endif8
endif8:
  br label %endif6
endif6:
  %t16 = load i32, ptr %a23
  %t17 = icmp ne i32 %t16, 0
  br i1 %t17, label %then9, label %endif10
then9:
  %t18 = load ptr, ptr %a22
  %t19 = call ptr @fopen(ptr %t18, ptr @.s7)
  %t20 = icmp ne ptr %t19, null
  br i1 %t20, label %then11, label %endif12
then11:
  %t21 = call i64 @fread(ptr %a1, i64 1, i64 24576, ptr %t19)
  %t22 = trunc i64 %t21 to i32
  store i32 %t22, ptr %a21
  %t23 = call i32 @fclose(ptr %t19)
  br label %endif12
endif12:
  %t24 = icmp eq ptr %t19, null
  br i1 %t24, label %then13, label %endif14
then13:
  %t25 = load ptr, ptr %a22
  %t26 = call i32 (ptr, ...) @printf(ptr @.s8, ptr %t25)
  ret i32 1
endif14:
  br label %endif10
endif10:
  %t27 = load i32, ptr %a21
  %t28 = icmp eq i32 %t27, 0
  br i1 %t28, label %then15, label %endif16
then15:
  store i32 0, ptr %a24
  store i32 0, ptr %a24
  br label %lc17
lc17:
  %t29 = load i32, ptr %a24
  %t30 = icmp slt i32 %t29, 501
  br i1 %t30, label %lb18, label %le19
lb18:
  %t31 = load i32, ptr %a24
  %t32 = getelementptr i8, ptr @demo, i32 %t31
  %t33 = load i8, ptr %t32
  %t34 = load i32, ptr %a24
  %t35 = getelementptr i8, ptr %a1, i32 %t34
  store i8 %t33, ptr %t35
  %t36 = load i32, ptr %a24
  %t37 = add i32 %t36, 1
  store i32 %t37, ptr %a24
  br label %lc17
le19:
  store i32 501, ptr %a21
  br label %endif16
endif16:
  %t38 = load i32, ptr %a21
  %t39 = call i32 @parse(ptr %a1, i32 %t38, ptr %a6, ptr %a7, ptr %a8, ptr %a9, ptr %a12, ptr %a13, ptr %a14)
  %t40 = icmp slt i32 %t39, 0
  br i1 %t40, label %then20, label %endif21
then20:
  %t41 = call i32 (ptr, ...) @printf(ptr @.s9)
  ret i32 1
endif21:
  store i32 0, ptr %a25
  store i32 0, ptr %a26
  store i32 0, ptr %a26
  br label %lc22
lc22:
  %t42 = load i32, ptr %a26
  %t43 = icmp slt i32 %t42, %t39
  br i1 %t43, label %lb23, label %le24
lb23:
  %t44 = load i32, ptr %a26
  %t45 = getelementptr i32, ptr %a6, i32 %t44
  %t46 = load i32, ptr %t45
  %t47 = getelementptr i32, ptr %a14, i32 1
  %t48 = load i32, ptr %t47
  %t49 = getelementptr i32, ptr %a14, i32 0
  %t50 = load i32, ptr %t49
  %t51 = call i32 @t2s(i32 %t46, ptr %a12, ptr %a13, i32 %t48, i32 %t50)
  %t52 = load i32, ptr %a26
  %t53 = getelementptr i32, ptr %a10, i32 %t52
  store i32 %t51, ptr %t53
  %t54 = load i32, ptr %a26
  %t55 = getelementptr i32, ptr %a7, i32 %t54
  %t56 = load i32, ptr %t55
  %t57 = getelementptr i32, ptr %a14, i32 1
  %t58 = load i32, ptr %t57
  %t59 = getelementptr i32, ptr %a14, i32 0
  %t60 = load i32, ptr %t59
  %t61 = call i32 @t2s(i32 %t56, ptr %a12, ptr %a13, i32 %t58, i32 %t60)
  %t62 = load i32, ptr %a26
  %t63 = getelementptr i32, ptr %a11, i32 %t62
  store i32 %t61, ptr %t63
  %t64 = load i32, ptr %a26
  %t65 = getelementptr i32, ptr %a11, i32 %t64
  %t66 = load i32, ptr %t65
  %t67 = load i32, ptr %a25
  %t68 = icmp sgt i32 %t66, %t67
  br i1 %t68, label %then25, label %endif26
then25:
  %t69 = load i32, ptr %a26
  %t70 = getelementptr i32, ptr %a11, i32 %t69
  %t71 = load i32, ptr %t70
  store i32 %t71, ptr %a25
  br label %endif26
endif26:
  %t72 = load i32, ptr %a26
  %t73 = add i32 %t72, 1
  store i32 %t73, ptr %a26
  br label %lc22
le24:
  %t74 = call i32 @SDL_Init(i32 48)
  %t75 = call ptr @SDL_CreateWindow(ptr @.s10, i32 805240832, i32 805240832, i32 640, i32 320, i32 0)
  %t76 = call ptr @SDL_CreateRenderer(ptr %t75, i32 -1, i32 1)
  %t77 = getelementptr i8, ptr %a3, i32 0
  store i64 0, ptr %t77
  %t78 = getelementptr i8, ptr %a3, i32 8
  store i64 0, ptr %t78
  %t79 = getelementptr i8, ptr %a3, i32 16
  store i64 0, ptr %t79
  %t80 = getelementptr i8, ptr %a3, i32 24
  store i64 0, ptr %t80
  store i32 22050, ptr %a3
  %t81 = getelementptr i8, ptr %a3, i32 4
  store i8 16, ptr %t81
  %t82 = getelementptr i8, ptr %a3, i32 5
  store i8 -128, ptr %t82
  %t83 = getelementptr i8, ptr %a3, i32 6
  store i8 1, ptr %t83
  %t84 = getelementptr i8, ptr %a3, i32 9
  store i8 2, ptr %t84
  %t85 = call i32 @SDL_OpenAudioDevice(ptr null, i32 0, ptr %a3, ptr %a4, i32 0)
  %t86 = icmp ne i32 %t85, 0
  br i1 %t86, label %then27, label %endif28
then27:
  call void @SDL_PauseAudioDevice(i32 %t85, i32 0)
  br label %endif28
endif28:
  br label %wc29
wc29:
  %t87 = load i32, ptr %a15
  %t88 = icmp ne i32 %t87, 0
  br i1 %t88, label %wb30, label %we31
wb30:
  br label %wc32
wc32:
  %t89 = call i32 @SDL_PollEvent(ptr %a2)
  %t90 = icmp ne i32 %t89, 0
  br i1 %t90, label %wb33, label %we34
wb33:
  %t91 = load i32, ptr %a2
  %t92 = icmp eq i32 %t91, 256
  br i1 %t92, label %then35, label %endif36
then35:
  store i32 0, ptr %a15
  br label %endif36
endif36:
  %t93 = icmp eq i32 %t91, 768
  br i1 %t93, label %then37, label %endif38
then37:
  %t94 = getelementptr i8, ptr %a2, i32 16
  %t95 = load i32, ptr %t94
  %t96 = icmp eq i32 %t95, 41
  br i1 %t96, label %then39, label %endif40
then39:
  store i32 0, ptr %a15
  br label %endif40
endif40:
  %t97 = icmp eq i32 %t95, 44
  br i1 %t97, label %then41, label %endif42
then41:
  %t98 = load i32, ptr %a18
  %t99 = sub i32 1, %t98
  store i32 %t99, ptr %a18
  br label %endif42
endif42:
  %t100 = icmp eq i32 %t95, 21
  br i1 %t100, label %then43, label %endif44
then43:
  store i32 0, ptr %a19
  br label %endif44
endif44:
  br label %endif38
endif38:
  br label %wc32
we34:
  %t101 = icmp ne i32 %t85, 0
  %t102 = load i32, ptr %a18
  %t103 = icmp eq i32 %t102, 0
  %t104 = and i1 %t101, %t103
  br i1 %t104, label %then45, label %endif46
then45:
  %t105 = call i32 @SDL_GetQueuedAudioSize(i32 %t85)
  %t106 = icmp slt i32 %t105, 8820
  br i1 %t106, label %then47, label %endif48
then47:
  %t107 = load i32, ptr %a19
  call void @synth(ptr %a5, i32 1024, i32 %t107, ptr %a10, ptr %a11, ptr %a8, i32 %t39)
  %t108 = call i32 @SDL_QueueAudio(i32 %t85, ptr %a5, i32 2048)
  %t109 = load i32, ptr %a19
  %t110 = add i32 %t109, 1024
  store i32 %t110, ptr %a19
  %t111 = load i32, ptr %a20
  %t112 = add i32 %t111, 1024
  store i32 %t112, ptr %a20
  %t113 = load i32, ptr %a19
  %t114 = load i32, ptr %a25
  %t115 = add i32 %t114, 22050
  %t116 = icmp sgt i32 %t113, %t115
  br i1 %t116, label %then49, label %endif50
then49:
  store i32 0, ptr %a19
  br label %endif50
endif50:
  br label %endif48
endif48:
  br label %endif46
endif46:
  %t117 = load i32, ptr %a19
  %t118 = load i32, ptr %a25
  %t119 = load i32, ptr %a18
  %t120 = load i32, ptr %a23
  call void @draw_ui(ptr %t76, i32 %t117, ptr %a10, ptr %a11, ptr %a8, i32 %t39, i32 %t118, i32 %t119, i32 %t120)
  call void @SDL_RenderPresent(ptr %t76)
  call void @SDL_Delay(i32 16)
  %t121 = load i32, ptr %a16
  %t122 = add i32 %t121, 1
  store i32 %t122, ptr %a16
  %t123 = load i32, ptr %a17
  %t124 = icmp sgt i32 %t123, 0
  %t125 = load i32, ptr %a16
  %t126 = load i32, ptr %a17
  %t127 = icmp sge i32 %t125, %t126
  %t128 = and i1 %t124, %t127
  br i1 %t128, label %then51, label %endif52
then51:
  store i32 0, ptr %a15
  br label %endif52
endif52:
  br label %wc29
we31:
  %t129 = getelementptr i32, ptr %a14, i32 1
  %t130 = load i32, ptr %t129
  %t131 = getelementptr i32, ptr %a14, i32 0
  %t132 = load i32, ptr %t131
  %t133 = load i32, ptr %a25
  %t134 = sdiv i32 %t133, 22050
  %t135 = load i32, ptr %a20
  %t136 = call i32 (ptr, ...) @printf(ptr @.s11, i32 %t39, i32 %t130, i32 %t132, i32 %t134, i32 %t135)
  %t137 = icmp ne i32 %t85, 0
  br i1 %t137, label %then53, label %endif54
then53:
  call void @SDL_CloseAudioDevice(i32 %t85)
  br label %endif54
endif54:
  call void @SDL_DestroyRenderer(ptr %t76)
  call void @SDL_DestroyWindow(ptr %t75)
  call void @SDL_Quit()
  ret i32 0
}

