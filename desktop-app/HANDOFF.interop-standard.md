# HANDOFF：OpenCL 與 OpenGL 的標準互通（cl_khr_gl_sharing）與執行期優化（2026-11-20，交給其他遠端帳號）

## 1. 開場提示（接手者收到的話）

讀完本文件（含使用者原話），接手第 3 節的階段 A 到 F，依序做、每階段通過節點測試就 commit（沒有 GPU，見 1.5）。不要寫評估文件；遇到歧義自決。發布（`scripts/publish.sh`）只有管理者做，你只提交。回報第一行寫 commit hash 與通過項數。

## 1.5 遠端沒有 GPU：只寫程式（2026-11-20 使用者指示）

使用者原話：「遠端不會有gpu, 我要讓他純寫程式」。

- 接手者只寫程式與跑節點單元測試（假裝置、JS 後端、解析 `.ll`、像素用軟體或假 GL 檢查）。**不要啟動真 Electron、不要量真 GPU 毫秒、不要跑 `scripts/eval/*.eval.js`。**
- 需要真 GPU 才能驗的項目（C 的像素與計數器量測、F 的各後端對照、任何毫秒數字）：把評測腳本寫好並提交，在提交說明與 README 寫「待真機驗證」，**不得寫成已驗證**。真機驗證由管理者（有 GPU 的這台）執行後補結果。
- 「已知待真機驗證」清單請另列在 `DESIGN.TODO.md` 的獨立小節，不混進一般待辦。
- 目前已知待真機驗證：`kir_webgl2.js` 未提交的兩個修正（輸入用自己的寬度讀取、固定位置寫入只寫該位置），要重跑 `scripts/eval/kir_conformance.eval.js`（現況 WebGL2 123/137）。

## 2. 使用者的原則（逐字，2026-11-20）

- 「擴充只應該存在框架的implement」
- 「我要求的就是照著標準。你繞過缺口出的東西根本....」
- 「他只應該成為runtime opt」
- 「例如使用者用標準寫，執行期看到pattern，類似dynarec一樣做出abi/記憶體層級的改寫」
- 「本來就是只該修框架  應用程式只應該去對『我有沒有跟python, c的寫一致』…example本身就只是提供當參考，給使用者用來抄用來驗證的」
- 「放進examples也無所謂  用README讓使用者知道就好」（驗證程式可以放進 examples，用 README 說明）
- 「用nbody來測不會太費時?不考慮做一個更容易驗的程式?」「如果是核對opengl, opencl interop, 也可以有一個interop的更簡易的驗證程式吧」

白話：使用者寫標準的 OpenCL 與 OpenGL，加速只能是框架在執行期偵測模式後自己做；不准有使用者要呼叫的自創函式；範例是標準寫法的參考，不為框架優化而改寫。

## 3. 階段（依序）

- **A. 標準 GL 頂點緩衝區**：`renderer/src/uml/llvm_host.js` 的 GL 墊片目前只有立即模式（`glBegin`／`glVertex3f`），補 `glGenBuffers`、`glDeleteBuffers`、`glBindBuffer(GL_ARRAY_BUFFER)`、`glBufferData`、`glBufferSubData`、`glEnableClientState(GL_VERTEX_ARRAY)`／`glDisableClientState`、`glVertexPointer`、`glDrawArrays`（`GL_POINTS`、`GL_LINES`、`GL_TRIANGLES`）。對應 GUI 現有的 glbuf／glprog／glframe 路徑（先讀墊片現有做法）。測試：手寫標準 `.ll`（VBO 畫三角形與一排點），像素檢查。
- **B. 標準 `cl_khr_gl_sharing`**：`clCreateFromGLBuffer`、`clEnqueueAcquireGLObjects`、`clEnqueueReleaseGLObjects`、`clGetGLObjectInfo`（`clCreateFromGLTexture` 之後）。CL 記憶體物件別名到 GL 緩衝區；先做「正確但慢」的基準（Release 時把 CL 內容寫進 GL 緩衝區）。測試：標準互通 `.ll`（核心寫進共享 VBO、GL 畫），像素與基準相同。
- **C. 執行期優化（框架內部）**：偵測到「`glDrawArrays(GL_POINTS)` 使用的緩衝區是 CL 共享物件、且最後由 WebGPU 後端的核心寫入」，跳過讀回，改走已有的 `drawPoints`＋`extern`（取用墊片已追蹤的 modelview／projection、點大小、顏色）。條件不吻合（光照、紋理、其他屬性、非 WebGPU 後端）退回 B 的複製路徑。像素與 B 一致（容差寫明）；用宿主計數器量到 readBuffer／mapAsync 為 0；量每幀毫秒。
- **D. 移除自創介面**：`fa_cl_points` 不得出現在任何 `.ll`、範例、README 的公開介面（宿主匯入表不匯出，或改純內部）。範例已在 `d6ca8aaca` 還原成標準寫法（`6c01f6430` 的內容），不要再改。
- **E. 標準互通範例**：`examples/llc/gpgpu/` 新增用 A、B 的標準呼叫寫的範例（核心寫進共享 VBO、`glDrawArrays` 畫）加 README，給使用者抄用與驗證。
- **F. 一致性套件**：標準核心（逐元素、邊界 N＝1／63／64／65／255／256／257／1000、迴圈歸約、小型全對全含分塊與未分塊、有解析解的簡諧振子逐步積分、f32x4／多輸出），各後端（WebGPU 分塊、WebGPU 未分塊、WebGL2）對 KIR 的 JS 後端；放 `examples/llc/conformance/` 加繁體中文 README；真 Electron 一個頁面、一分鐘內；誤差超標修框架，不放寬容差。
- 標準的 `nbody3d_cl`（每幀 `clEnqueueReadBuffer` 再 `glVertex3f` 迴圈）框架層只能讓讀回更便宜（重用 staging buffer、`mapAsync` 批次化、讀回與計算重疊）；辨識編譯後 wasm 迴圈 pattern 太重，先不做。

## 4. 現況（已提交）

- 已發布到 v493（見 `DESIGN.TODO.md` 發布列）；v492 起 OpenCL 走 WebGPU 優先（`renderer/src/gpu/kir_webgpu.js`、`kir_host_hooks.js`），退路 WebGL2、JS 墊片。這台 Kepler 真機數字：WebGPU 分塊 nbody 每步約 10 ms（WebGL2 54 ms）。
- 本地未發布的提交（在 v493 之後）：`4576c38b9` ＋ `09d92352b`（GL 畫布新指令 `["extern", 名字]`、`host.setExtern`，測試 340／153／55）；`f4e472edb`（`kir_webgpu.drawPoints`，位置緩衝區直接當頂點）；`fc4947b28`（宿主函式 `fa_cl_points`，**屬於要降為內部的自創介面**）；`ef047707f`、`94f884494`、`0c7fdba99`（接 nbody、量測、文件）；`d6ca8aaca`（範例還原）；`9a27b09d7`（工作現況快照：`kir_gen`／`kir_webgl2`／`kir_webgpu`／`llvm_host`／評測的未完成修改）。
- 真機量測（nbody 3072 顆，這台 NVIDIA，每步毫秒）：點精靈不讀回 16.7；WebGPU 讀回加 GL 點 31.0；WebGL2 74.6；CPU 978。像素與讀回版平均通道差 0.060。注意：叢集中心每 30 幀才更新時結尾輸出與 CPU 版不同（97.5 對 97.0），已決定「結尾一致就好、模擬逐步一致」：結尾輸出要在最後做完整讀回，模擬逐步位置速度與 CPU 在容差內。
- 這些文件有詳細過程：`DESIGN.webgpu-cuda.md` §13 階段 7 到 10、`HANDOFF.llc-opencl.md`、`DESIGN.run-terminal.md` §21。

## 5. 工作風格

- 繁體中文；回報誠實：驗證過的與轉述的分開；沒在真 GPU 驗證的不能寫成已驗證。
- 只修框架（`renderer/src/uml/`、`renderer/src/gpu/`、`renderer/src/gui/`、`renderer/src/pybridge/`），範例只加新的標準範例與 README，不改既有參考範例。
- 只 `git add` 自己的檔；建置輸出（`renderer/floating-assistant.js`、`.min.js`、`web-lazy/`、`update-manifest.json`、`renderer/src/floating-assistant.js` 內嵌區塊）由管理者重產，不要 add；改了內嵌模組要在 `scripts/embed-code-ui.js` 登記。
- 真 GPU 量測守則：一頁一形狀、先估時間、單次派發小（<100 ms，否則 Windows 會重置驅動）、監聽 `device.lost`、用 `requestExclusiveGpu`；真 Electron 評測指令見 `HANDOFF.llc-opencl.md` 第 4 節；每項評測最多跑兩次；測完只停自己啟動的程序。
- 評測 Electron 共用通訊埠，一次只跑一個。
- 手寫修補腳本用 Write 工具寫成檔再執行（heredoc 會吃掉反斜線）。

## 6. 陷阱

- 兩個工作階段同時改同一批檔案會互相覆蓋（本次 `gui_bridge.js`、`gui_render.js` 發生過重複實作，後來移除一份）；一次只有一個寫入者。
- `scripts/eval/*.eval.js` 是在頁面內執行的片段（有頂層 `await`、`return`），`node --check` 會報錯，那不是真的語法錯誤。
- `kir_host_hooks` 在沒有 JSPI 的環境（node 16）不啟用 WebGPU 路徑；單元測試用假裝置，真 Electron 才涵蓋 JSPI。
- 宿主在第一次端到端評測發現：`llvm_host` 只在有同步 `kirRun` 時翻譯核心，WebGPU 路徑沒有，核心全退回 CPU；已修（翻譯條件看 `kirRun` 或 `kirDev`）。
