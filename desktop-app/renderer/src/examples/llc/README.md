# LLVM IR（llc）範例

這些是手寫的 LLVM IR（`.ll`，不透明指標寫法，LLVM 15 以上），呼叫 **SDL2、OpenGL、GTK3、OpenCL** 的 C API。**同一份 `.ll` 兩邊都能跑**：

## ① 在 run terminal（或 job_run）裡直接跑

    cd examples/llc
    lli game/sdl2_pong.ll          # 乒乓球（SDL2）：w/s、方向鍵、滑鼠；第一個參數＝跑幾幀後離開
    lli gui/gtk3_widgets.ll        # GTK3 widget；參數 3＝自己按 3 次按鈕後離開
    lli gui/sdl2_gl_triangle.ll    # SDL2＋OpenGL 三角形：滑鼠左鍵拖曳旋轉、滾輪縮放

IR 裡 `declare` 了 SDL2／OpenGL／GTK3／printf 的函式、又沒有自己定義，編譯器就把它們編成 wasm 匯入（模組 `env`），由 `uml/llvm_host.js` 用 JS 實作：
視窗、畫布、鍵盤、滑鼠經 GUI 橋接（跟 python 的 `gui`／`pygame`／`gl3d`、node 的 `gui` 同一套協定）；OpenGL 固定管線收成頂點批次，在 WebGL2 畫布上用 `flat` 程式畫；
會等事件的函式（`SDL_Delay`、`SDL_PollEvent`、`SDL_RenderPresent`、`gtk_main`）用 JSPI 暫停 wasm，不會卡住頁面（需要 Chrome／Edge 137 以上或桌面版）。
程式結束或 Ctrl+C 會收掉它開的視窗。

編譯器為此新增：`float`（f32）、`fpext`／`fptrunc`、可變參數呼叫（`call i32 (ptr, ...) @printf(...)`，額外引數放進 8 位元組對齊的緩衝區）、函式指標當值（只能傳給主機函式當回呼，不能在 wasm 裡間接呼叫）、`main(argc, argv)`。
**仍然不支援**：`phi`（用 alloca／load／store）、定義可變參數函式、wasm 內的間接呼叫。全域陣列的初始值支援整數與浮點的一維陣列（`[i32 1, i32 2]`）。
**音訊**：SDL 的音訊裝置對應頁面端的一個串流（`gui.audio` 的 `stream_*`，見 `DESIGN.pygame-opengl-standard.md`「音訊」）；裝置一開始是暫停的（SDL 的規則）、`SDL_PauseAudioDevice(dev, 0)` 才開始播；暫停時新資料先留著、繼續才排程（暫停中已排程的不會倒回）。callback 模式需要主機在 wasm 記憶體配置緩衝區，目前辦不到。簽名要跟 C 原型一致（`SDL_SetRenderDrawColor` 的 `Uint8` 是 `i8`；`snprintf` 的 `size_t` 可以是 `i32` 或 `i64`；GTK 的 `g_signal_connect_data` 回傳值宣告成 `i32`）；宣告了沒實作的函式，檢查階段會明確說「沒有實作」。

| 檔案 | 表現方式 | 實作範圍 |
|---|---|---|
| `game/sdl2_piano.ll` | SDL2 音訊＋影像＋鍵盤：8 鍵小鋼琴（A S D F G H J K），方波 PCM 經 `SDL_QueueAudio` | `SDL_OpenAudioDevice／QueueAudio／GetQueuedAudioSize／ClearQueuedAudio／PauseAudioDevice／CloseAudioDevice`、`SDL_OpenAudio／PauseAudio／CloseAudio`；**只支援佇列模式**（`SDL_AudioSpec` 的 callback 要是 NULL，否則回 0 並說明）；格式 U8、S8、U16LSB、S16LSB、S32LSB、F32LSB，1 或 2 聲道；第一個參數＝自動彈奏並跑幾幀 |
| `game/sdl2_pong.ll` | SDL2：視窗、渲染器、填色矩形、鍵盤、滑鼠、計時 | `SDL_Init／CreateWindow／CreateRenderer／SetRenderDrawColor／RenderClear／RenderFillRect／RenderDrawRect／RenderDrawLine／RenderDrawPoint／RenderPresent／PollEvent（QUIT、KEYDOWN／UP、MOUSEMOTION、MOUSEBUTTONDOWN／UP、MOUSEWHEEL）／Delay／GetTicks`；一幀最多 200 道繪圖指令（橋接上限） |
| `gui/gtk3_widgets.ll` | GTK3 widget：視窗、盒子、標籤、輸入框、勾選框、按鈕、進度條、訊號、計時器 | `gtk_init／window／box／label／entry／button／check_button／progress_bar／container_add／widget_show_all／main／main_quit／g_signal_connect_data（clicked、changed、toggled、destroy、delete-event）／g_timeout_add` |
| `gui/sdl2_gl_triangle.ll` | SDL2＋OpenGL 固定管線 | `SDL_GL_CreateContext／SwapWindow`、`glBegin／End／Vertex2f／3f／Color3f／4f`、矩陣（`glMatrixMode／LoadIdentity／Push／Pop／Translatef／Rotatef／Scalef／Ortho／Frustum／gluPerspective`）、`glClearColor／Clear／Enable(DEPTH_TEST)`；沒有光照、紋理、著色器 |
| `gpgpu/nbody3d.ll` | 照 Python 版（sdlmm/exams/nbody3d.c）：`lli nbody3d.ll [N=3072] [LOOP] [frames]`；O(N²) 引力、加法混色發光點精靈、HUD 點陣字（7×13）、滑桿；拖曳旋轉、滾輪縮放、空白暫停、R 重置、C 追蹤 | `glBlendFunc`、`glPointParameterfv`、`gluLookAt`、`gluPerspective`；**計算在 wasm 的 CPU 上**（GPU 按鈕要等 OpenCL 墊片） |
| `gpgpu/fluid3d.ll` | 照 Python 版（fluid3d.py）：1000 顆 SPH（H=0.1、ρ0=1000、K=200、μ=3、dt=0.003、反射牆），依速度上色的球形點精靈＋外框＋資訊列；拖曳旋轉、滾輪縮放、空白＝晃一下、P 暫停、R 重置 | `glPointSize`、`gluPerspective`、`glOrtho`；**計算在 wasm 的 CPU 上**（GPU 要等 OpenCL 墊片） |
| `gui/music_player.ll` | 音樂盒：內建〈歡樂頌〉即時合成（方波／三角／正弦），兩個八度的琴鍵與進度；空白暫停、↑↓速度、1 2 3 波形、R 從頭 | `SDL_QueueAudio` 佇列模式；`pow／floor／sin`；合成的音高用 FFT 驗證（E4 量到 330.8 Hz） |
| `gui/midi_player.ll` | MIDI 播放器：在 IR 裡解析標準 MIDI（SMF 0／1、變長時間、running status、tempo 表），12 聲部正弦合成，捲動的 piano roll | **檔案**：`lli gui/midi_player.ll gui/demo.mid`（用 `fopen／fread` 讀終端機沙盒，`/mnt/<名稱>` 也行）；參數 `-` 或不給＝內嵌示範曲；第二個參數＝跑幾幀後離開 |
| `gpgpu/opencl_vecadd.ll` | OpenCL：執行時編譯核心字串、buffer、NDRange、讀回驗證 | **CPU 後備**（`llvm_host.js` 的 OpenCL 墊片）：run terminal／job 內可跑，`lli opencl_vecadd.ll [N]` 印 `vadd OK`；真機器有驅動時同一份 IR 也能跑。限制見 `DESIGN.run-terminal.md` §21 |

## ② 在真機器上編成原生執行檔

    llc -filetype=obj -relocation-model=pic game/sdl2_pong.ll -o pong.o
    clang pong.o -o pong $(sdl2-config --libs)            # 或 gcc；GTK 用 pkg-config --libs gtk+-3.0；GL 加 -lGL；OpenCL 加 -lOpenCL

驗證現況：原生（llvmlite 編成物件檔、gcc 連結）pong、GTK3、GL 在 Xvfb 實跑通過（SDL2 在無頭環境要設 `SDL_IM_MODULE=none`，否則初始化輸入法就段錯誤，純 C 也一樣）；
wasm 版在真 Electron 驗證（`scripts/eval/llc_host.eval.js`）：pong 開視窗、注入鍵盤與滑鼠、截圖、跑完 150 幀；GTK3 的輸入／勾選／點擊讓標籤更新、關視窗後程式結束；GL 視窗與滑鼠事件、跑完 400 幀。
**沒驗證**：OpenGL 的畫面內容在 wasm 版（只確認沒有 trap 與 glerror）、真 GPU、網頁版、影片（沒有範例）、實際聽到聲音（驗證環境沒有音訊輸出裝置，只驗證到頁面的串流與排程）。

## 檔案系統（stdio）

`lli` 跑的程式可以用 `fopen／fclose／fread／fwrite／fgets／fputs／fgetc／fputc／fseek／ftell／rewind／feof／fflush／remove／rename／access`，接到**這個終端機的沙盒檔案系統**（相對路徑從目前目錄起算；`/mnt/<名稱>` 是即時的 File Access Point 檔案系統，程式結束時寫回）。
開啟時整個檔案讀進記憶體；寫入在 `fclose／fflush`／程式結束時才寫回。`size_t`、`long` 在 x86_64 的 IR 宣告成 `i64`、wasm32 宣告成 `i32`，兩種都收。
注意：`/mnt/<名稱>` 要先被指令提到過才會掛載（例如先 `ls /mnt/<名稱>`）；程式內自己組出的 `/mnt` 路徑不會觸發掛載。

## 範例的產生器

`_gen/_irb.py` 是一個極小的 IR 產生器（運算子重載的 `V`、變數、迴圈、if；不是編譯器），`_gen/_gen_*.py` 用它寫出上面的 `.ll`（輸出是普通的 `.ll`，原生與 wasm 都能用）。改範例請改產生器再重新產生。
（教訓：產生器曾在 `+=` 時多算了一個除法，原生編譯器最佳化掉了，但我們的 wasm 編譯器照單全收，除數是 0 就 trap——原生通過不代表 wasm 沒問題，所以每個範例兩邊都要驗。）
