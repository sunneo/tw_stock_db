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
**仍然不支援**：`phi`（用 alloca／load／store）、定義可變參數函式、wasm 內的間接呼叫。簽名要跟 C 原型一致（`SDL_SetRenderDrawColor` 的 `Uint8` 是 `i8`；`snprintf` 的 `size_t` 可以是 `i32` 或 `i64`；GTK 的 `g_signal_connect_data` 回傳值宣告成 `i32`）；宣告了沒實作的函式，檢查階段會明確說「沒有實作」。

| 檔案 | 表現方式 | 實作範圍 |
|---|---|---|
| `game/sdl2_pong.ll` | SDL2：視窗、渲染器、填色矩形、鍵盤、滑鼠、計時 | `SDL_Init／CreateWindow／CreateRenderer／SetRenderDrawColor／RenderClear／RenderFillRect／RenderDrawRect／RenderDrawLine／RenderDrawPoint／RenderPresent／PollEvent（QUIT、KEYDOWN／UP、MOUSEMOTION、MOUSEBUTTONDOWN／UP、MOUSEWHEEL）／Delay／GetTicks`；一幀最多 200 道繪圖指令（橋接上限） |
| `gui/gtk3_widgets.ll` | GTK3 widget：視窗、盒子、標籤、輸入框、勾選框、按鈕、進度條、訊號、計時器 | `gtk_init／window／box／label／entry／button／check_button／progress_bar／container_add／widget_show_all／main／main_quit／g_signal_connect_data（clicked、changed、toggled、destroy、delete-event）／g_timeout_add` |
| `gui/sdl2_gl_triangle.ll` | SDL2＋OpenGL 固定管線 | `SDL_GL_CreateContext／SwapWindow`、`glBegin／End／Vertex2f／3f／Color3f／4f`、矩陣（`glMatrixMode／LoadIdentity／Push／Pop／Translatef／Rotatef／Scalef／Ortho／Frustum／gluPerspective`）、`glClearColor／Clear／Enable(DEPTH_TEST)`；沒有光照、紋理、著色器 |
| `gpgpu/opencl_vecadd.ll` | OpenCL：執行時編譯核心字串、buffer、NDRange | 沒有 OpenCL 層——只能在有驅動的真機器上跑（下一步：接 cudaweb） |

## ② 在真機器上編成原生執行檔

    llc -filetype=obj -relocation-model=pic game/sdl2_pong.ll -o pong.o
    clang pong.o -o pong $(sdl2-config --libs)            # 或 gcc；GTK 用 pkg-config --libs gtk+-3.0；GL 加 -lGL；OpenCL 加 -lOpenCL

驗證現況：原生（llvmlite 編成物件檔、gcc 連結）pong、GTK3、GL 在 Xvfb 實跑通過（SDL2 在無頭環境要設 `SDL_IM_MODULE=none`，否則初始化輸入法就段錯誤，純 C 也一樣）；
wasm 版在真 Electron 驗證（`scripts/eval/llc_host.eval.js`）：pong 開視窗、注入鍵盤與滑鼠、截圖、跑完 150 幀；GTK3 的輸入／勾選／點擊讓標籤更新、關視窗後程式結束；GL 視窗與滑鼠事件、跑完 400 幀。
**沒驗證**：OpenGL 的畫面內容（WebGL2 畫布無法截圖，只確認沒有 trap 與 glerror）、真 GPU、網頁版、音訊與影片（沒有範例）。
