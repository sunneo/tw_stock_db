# pygame 與 OpenGL：以 pip 的真套件為標準，只接後端（2026-11-19）

> 這份同時是給 Redmine 端的交接：照這個做法，兩邊只會有同一份 Python 原始碼，不再各自移植。

## 原則
- **pygame ＝ pip 的 pygame-ce**（Pyodide 內建），API 完全是真的；**OpenGL ＝ pip 的 PyOpenGL**。我們不重新實作它們的任何 API，只提供底下的「後端」：視窗在哪、事件從哪來、GL 呼叫去哪。
- **不能再出貨名為 `pygame.py`、`OpenGL/`（`GL.py`、`GLU.py`、`GLUT.py`）的墊片**：它們會遮住真套件（Redmine 的 log：`'pygame' is not a package`），而且 API 一定會跟 pip 的分叉（以 pygame-ce 為尺，舊墊片的 `Surface` 缺約 50／56 個方法、沒有 `Color`／`Vector2`）。
- 範例必須是標準的 pygame／PyOpenGL 寫法；舊墊片的非標準擴充（例如 `pygame.mixer.Sound(frequency=…, ms=…)`）要改成標準寫法。
- `gl3d` 是我們自己的小工具庫，**建在 PyOpenGL 之上**（用 `OpenGL.GL` 的函式畫），不是另一套協定。

## 要放進兩邊共用的 Python（桌面版：`renderer/src/pybridge/`）
| 檔案 | 作用 |
|---|---|
| `fa_pygame.py` | 真 pygame-ce 的後端（見下） |
| `fa_opengl_platform.py` | PyOpenGL 的平台外掛＋WebGL2 後端＋固定管線模擬器（見下） |
| `gl3d.py` | 建在 PyOpenGL 上：`Camera`、矩陣、幾何、`FrameBuilder`、`View`（`View.show` 用 PyOpenGL 執行一幀再把 PNG 送進視窗） |
| `fa_bridge.py` 的 `install_hooks()` | 程式啟動時呼叫 `fa_opengl_platform.register()` 與 `fa_pygame.install()` |
| （刪除）`pygame.py`、`OpenGL/` | 不再出貨 |

JS 端兩處（Worker 路徑）：`gui/py_async.js`（`import pygame`／`OpenGL`／`gl3d`／`fa_swap` 走 Worker）、`gui/py_worker.js`（程式 import `OpenGL` 或 `gl3d` 時用 micropip 裝 PyOpenGL）。**橋接協定不用改**（畫面走既有的 `image`＋`draw`；`glbuf`／`glprog`／`glframe` 已不被 Python 使用，可留可刪）。

## pygame 後端（`fa_pygame.py`）
Worker 的 Pyodide 裡真的 pygame-ce 用 SDL 的 emscripten 驅動，會去找網頁環境而當掉，所以：
1. 先補最小的替身：`globalThis.screen`、`document`（`createElement` 回 OffscreenCanvas）、給 OffscreenCanvas 加 `style` 與 `getBoundingClientRect`，再 `pyodide_js.canvas.setCanvas2D(canvas)`。這之後 `pygame.init()`、`display.set_mode`、`convert()`／`convert_alpha()`、畫圖、`flip` 全是真的（實測：`init` 回 `(3, 2)`，driver＝emscripten）。
2. `display.flip／update` 之後把螢幕 Surface 編成 PNG（太大才退 JPEG），經橋接 `image`＋`draw` 送到視窗畫布；畫面沒變就不送。
3. 視窗事件（鍵盤、滑鼠、滾輪、關閉、縮放）在 `event.get／poll／wait／pump／peek` 前轉成真的 pygame 事件，用 `event.post` 放進真的佇列；`key.get_pressed／get_mods`、`mouse.get_pos／get_pressed／get_rel` 換成讀我們追蹤的狀態（SDL 的實體狀態不會被 `post` 更新）；`event.wait` 改成輪詢橋接。
4. `mixer`：Worker 沒有 `AudioContext`（`mixer.init` 會丟錯），所以 `mixer` 換成接到 `fa_audio`（見「音訊」）的實作：`Sound`（`file`／`buffer`／`array`）、`Channel`、`find_channel`、`set_num_channels`、`music`；頁面沒有音訊時退回一聲短嗶。
5. `set_mode(…, OPENGL)`：真的 SDL 那邊開一般的 2D 螢幕 Surface，GL 畫在我們自己的 WebGL2 上下文（`fa_opengl_platform.create_context`），`flip` 時擷取 WebGL2 畫面。
實測幀率（真 Electron）：480×400 約 97 fps、640×480 約 87 fps（含逐幀編碼與橋接）。

## PyOpenGL 後端（`fa_opengl_platform.py`）
- 平台外掛：`plugins.PlatformPlugin("fa", "fa_opengl_platform.FaPlatform")` 加 `PYOPENGL_PLATFORM=fa`，**必須在 import `OpenGL.platform` 之前**登記；`FaPlatform` 用模組的 `__getattr__` 延遲建立（太早 import `baseplatform` 會觸發 PyOpenGL 自己的平台選擇，選到 GLX）。函式不是 ctypes 原型，是 `_FaFunction`（PyOpenGL 的陣列型別照 `from_param` 轉成指標，ctypes 純量原樣傳）。沒有實作的函式是 PyOpenGL 自己的 `NullFunctionError`。
- 後端是 Worker 裡 OffscreenCanvas 的 **真 WebGL2**：現代 API（著色器、緩衝區、頂點屬性、uniform、紋理、狀態、draw、VAO、instancing）一對一轉發，GL 的整數名字對 WebGL 物件的表在驅動裡；**固定管線**（`glBegin／End`、`glVertexPointer`、矩陣堆疊、光照與材質、display list、`glPolygonMode`、QUADS／FAN／STRIP 拆三角形）WebGL2 沒有，由一支動態著色器模擬。GLU：`gluPerspective／LookAt／Ortho2D／Sphere`。
- 每幀用 `OffscreenCanvas.convertToBlob` 擷取成 PNG（Worker 在 JSPI 裡，可以同步等 Promise），走既有的 `image`＋`draw`。
- PyOpenGL 不是 Pyodide 內建：Worker 在程式 import `OpenGL` 或 `gl3d` 時用 micropip 從 PyPI 裝（純 Python，**要有網路**；離線要自備 wheel）。

## 音訊（`fa_audio.py`、`gui/audio_host.js`）
- 為什麼要新增：pygame 的 mixer 走 SDL 音訊，需要 `AudioContext`，Worker 沒有、頁面有；原有的 `gui.tone`（單一短嗶、立刻返回、不能混音）只夠做簡單的音樂盒（`music_player.py`、`midi_tool.py` 就是用它，不經過 pygame）。
- 橋接新增一個操作 **`gui.audio`**（不屬於哪個視窗；`_pyBridgeGui` 在查視窗之前就先處理）：`cmd` ＝ `load`（16 位元有號 PCM 的 base64＋rate＋channels，或整個聲音檔 `encoded` 交給瀏覽器解碼）、`unload`、`play`（`loops`、`volume`、`fade_ms`、`maxtime_ms`、`ch`、`music`）、`stop`、`volume`、`busy`、`pause`／`resume`、`channels`、`info`。頁面端 `AiChatAudioHost` 用 Web Audio 播：預設 8 個聲道（至多 32）、一個獨立的音樂聲道、同名聲音取代、限制 8 MB PCM／12 MB 檔案、64 個聲音、總計 64 MB。
- 程式結束、Ctrl+C、`job_stop` 時，頁面收掉這支程式（session）播的聲音。瀏覽器的自動播放政策：沒有使用者操作過頁面時 `AudioContext` 可能是 suspended，`play` 會嘗試 resume 並回報 `suspended`。
- Python：`fa_audio`（`load_pcm`／`load_file`／`play`／`stop`／`set_volume`／`busy`／`count`／`channels`…）；`pygame.mixer` 接在它上面。node：全域 `audio`（`load`／`loadFile`／`play`／`stop`／`busy`／`volume`／`master`）。
- 限制：`mixer.music.pause／unpause` 暫停的是整個音訊情境（Web Audio 的來源不能個別暫停）；沒有 `set_pos`／`get_pos`；不做 3D 空間音效與串流（整個檔案先解碼進記憶體）；LLVM IR 的 SDL 音訊（`SDL_OpenAudioDevice`）還沒接。

## 驗證
- 單元（對假橋接、假 WebGL2 後端）：`fa_pygame_test.py`（真 pygame-ce、SDL dummy）、`fa_opengl_test.py`（真 PyOpenGL）、`gui/gl3d_test.py`；沒裝 pip 套件時各自「略過」。
- 音訊：`gui/audio_host.test.js`（假的 AudioContext）；真 Electron `scripts/eval/audio_real.eval.js`（`fa_audio`、`pygame.mixer` 多聲道與 busy、程式結束收聲音、node 的 `audio`）。
- 真 Electron：`scripts/eval/pygame_real.eval.js`（最小程式＋打磚塊＋其餘 5 款遊戲）、`opengl_real.eval.js`（**Redmine 的 `opengl_cube.py` 原封不動**：視窗 800×600、有光照的彩色方塊與球、鍵盤事件進得去）、`gl3d_real.eval.js`（`gl_scene`、`nbody3d`、`fluid3d`）。
- 無頭測試台 `examples/python/_harness.py` 改用真 pygame-ce（`pip install pygame-ce`）。

## 限制（沒做／沒驗證）
- 固定管線沒有：霧、alpha test、`glTexEnv`、`glLightf` 的衰減與聚光燈、`glCopyPixels`、GLUT；現代 API 沒有：framebuffer、`glGetActiveUniform` 之類的查詢（呼叫會是 `NullFunctionError`）。
- pygame：沒有真音訊；`SCALED`／`FULLSCREEN` 旗標被忽略；多視窗（`pygame._sdl2`）、`pygame.camera`、`pygame.midi` 沒驗證。
- 一幀的 PNG 超過 1 MB（橋接的圖片上限）會報錯（JPEG 後備只對 pygame 的 2D 畫面）。
- 網頁版沒有真瀏覽器驗證；真 GPU 沒驗證（驗證用的是 xvfb＋SwiftShader）。

## 教訓（避免再犯）
- **畫面驗證要看像素，不能只看位元組數**：全黑的 PNG 也只有幾 KB。`gl3d_real.eval.js` 現在會解開截圖數「跟背景不同的像素」。
- **PyOpenGL 傳給驅動的名字是以 NUL 結尾的緩衝區**（`glGetUniformLocation`、`glGetAttribLocation`、`glBindAttribLocation`），沒去掉結尾的 `\x00` 會讓所有 uniform／attribute 找不到、什麼都畫不出來；假後端測試不會暴露，所以 `fa_opengl_test.py` 檢查驅動收到的名字不含 NUL。
- OpenGL 畫面也有 JPEG 後備（PNG 超過橋接的 1 MB 時），`fa_opengl_platform.frame_image()`。
