# LLVM IR（llc）範例

這些是手寫的 LLVM IR（`.ll`，不透明指標寫法，LLVM 15 以上），呼叫 **SDL2、OpenGL、GTK3、OpenCL** 的 C API。
終端機內建的 `lli／llc／wasmrun` 是編成 WebAssembly，只有 WASI（標準輸入輸出），沒有視窗、畫布、滑鼠、聲音，所以這些範例**不能在 run terminal 裡直接跑**；
`llcheck 檔.ll` 可以先檢查語法與型別（外部函式留給連結）。在有 clang 與函式庫的真機器上：

    llc -filetype=obj -relocation-model=pic game/sdl2_pong.ll -o pong.o
    clang pong.o -o pong $(sdl2-config --libs)            # 或 gcc

| 檔案 | 表現方式 | 連結旗標 | 備註 |
|---|---|---|---|
| `game/sdl2_pong.ll` | SDL2：視窗、渲染器、鍵盤、滑鼠 | `sdl2-config --libs` | 第一個參數＝跑幾幀後離開 |
| `gui/gtk3_widgets.ll` | GTK3 widget：標籤、輸入框、勾選框、按鈕、訊號 | `pkg-config --libs gtk+-3.0` | 第一個參數 N＝自動按 N 次後離開 |
| `gui/sdl2_gl_triangle.ll` | SDL2＋OpenGL 固定管線：滑鼠拖曳旋轉、滾輪縮放 | `sdl2-config --libs` 加 `-lGL` | 需要有 OpenGL 的顯示環境 |
| `gpgpu/opencl_vecadd.ll` | OpenCL：執行時編譯核心字串、buffer、NDRange | `-lOpenCL` | 第一個參數＝元素個數 |

驗證現況（開發機：llvmlite 把 `.ll` 編成物件檔，gcc 連結）：pong、GTK3、GL 三個在 Xvfb 實跑通過；OpenCL 只驗證到編譯與連結（機器沒有 OpenCL 廠商驅動，執行時回報找不到平台）。
音訊、影片沒有範例：SDL2 的聲音要 `SDL_AudioSpec` 與回呼函式，影片要解碼函式庫，之後再補。

**Xvfb 注意**：這類無頭環境上 SDL2 會在初始化輸入法時段錯誤（與程式無關，純 C 一樣），設 `SDL_IM_MODULE=none` 就正常。
