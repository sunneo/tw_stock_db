# 圖片轉 3D（離線模型）：UniK3D 的 ONNX 與混合方案評估

> 2026-10-29，只做評估，沒有寫程式。要使用者 2026-10-29 補充：入口改成斜線指令 `/image-to-3d`（不是 `/media-image-to-3d`）。查證來源在文末；**我實際查到的**與**我沒驗證的**分開寫。

## 結論（先說）
1. **UniK3D 有官方的 ONNX 匯出程式，但有三個硬傷**：授權是 CC BY-NC 4.0（非商業）；解析度在匯出時就固定（462×630）；沒有現成的 ONNX 檔可下載（要自己匯出）。**在瀏覽器裡能不能跑，我沒驗證。** 這個專案是公開產品，所以「把它內建、替使用者下載」目前不可行，除非你接受非商業授權的限制。
2. **預設引擎建議用 Depth Anything V2 Small**：Apache-2.0（Small 這一個規格；Base／Large 是非商業）、已有 onnx-community 的 ONNX、Transformers.js 現成支援，而且本專案已經有 Transformers.js 的工作執行緒、WebGPU 降級 CPU、模型下載進度那一整套（`renderer/src/vlm/vlm_core.js`），新增一種模型只是加一個登錄項目。缺點：輸出是相對深度（沒有公尺單位）。
3. **你貼的混合架構，離線那一層（Base Layer）可行，雲端精煉那一層跟「離線」需求衝突**，建議不做或另案。
4. 輸出一律是「正面看得到的表面」做成的浮雕式網格，再補背面變成封閉體；**這不是真正的 3D 重建**（背面是猜的），要跟使用者講清楚。

## 一、UniK3D 的 ONNX（要求的那條路）
**查到的事實**
- 匯出程式存在（官方示範站的 `unik3d/models/export.py`）：`torch.onnx.export`，opset 14；預設包成 `UniK3DONNX`（輸入 `rgbs`，輸出 `pts_3d` 與 `confidence`），另有帶相機光線的版本 `UniK3DONNXcam`。
- 規格：`vits`／`vitb`／`vitl` 三種；輸入 `(B,3,H,W)`，預設 462×630（14 的倍數）；**只有批次軸是動態的，程式自己寫「不支援動態形狀」**；為了能匯出，要關掉 DINO 的高效注意力。
- 權重大小（Hugging Face）：`vits` 的 `model.safetensors` 142 MB，`vitl` 1.44 GB。ONNX 檔大小應該接近，**但我沒實際匯出過，不確定**。
- 輸出是相機座標下每個像素的 3D 點（有公制尺度、支援魚眼與全景），不是網格；要自己轉成網格。
- 官方只測過 Linux＋CUDA 11.8；沒有速度數字。
- 授權：GitHub 說明寫 Creative Commons BY-NC 4.0。Hugging Face 權重頁面這次沒看到授權標示（**未確認**）。

**判斷**
- 只有 `vits`（約 142 MB 級）有機會放進瀏覽器；`vitl` 約 1.4 GB 不實際。
- 固定 462×630 表示直式、橫式圖要補邊或分別匯出，輸出再裁回來。
- 跟 Depth Anything 比：好處是公制尺度與真正的 3D 點；代價是較大、授權較嚴、沒有現成 ONNX、要自己維護匯出流程。
- 進瀏覽器之前必須先驗證（未做）：① 在有 GPU 的 Linux 機器跑 `export.py --backbone vits` 能不能成功；② 匯出檔在 ONNX Runtime Web（WebGPU 與 WASM）每個運算子是否支援、載入是否過大；③ 一張圖的實際耗時（CPU／WebGPU）；④ 權重授權（Hugging Face 模型卡）。

## 二、你貼的混合架構逐項評估
| 項目 | 評估 |
|---|---|
| 分割（SAM／MobileSAM／SAM2 tiny，ONNX Runtime Web） | **可行**，瀏覽器內跑的範例很多（我查到 WebSAM 這類專案與 SAM2.1 tiny 的 ONNX 匯出）。你寫的 37 MB 比較像 MobileSAM；SAM2 tiny 我沒查到確切大小。授權我印象是 Apache-2.0，**這次沒查證**。若只要去背，本專案「找圖→3D」那條路已經有切掉背景的步驟，可先沿用。 |
| 單視角深度（Depth Anything V2 Small） | **可行且最省事**（見結論 2）。你寫的 24 MB 級大致吻合（約 2500 萬參數）；輸出是相對深度。 |
| MediaPipe 自拍分割 | 只適合人像，通用物件用不上。 |
| 稜柱擠出＋補洞，做成閉合低模 | **可行，純 JS 就夠**：深度圖→前表面網格→背面用鏡射或平底→邊緣縫合。要先決定背面的做法（猜出來的）。本專案的 3D 編輯器已經吃「自訂形狀」（`polygon` 物件的頂點與面）和既有的 2.5D 網格轉換，輸出直接餵進去即可。 |
| `wasm-marching-cubes`、`wasm-poisson` | **我不確定這兩個套件存在**，不要照名字去裝。Marching Cubes 自己寫一版純 JS 不難；`meshoptimizer`、`gltf-transform`、`draco3d` 確定存在。 |
| 輸出 .glb | 本專案 3D 編輯器目前**不支援匯入 glb**（設計文件寫「glb 沒做」），支援 STL／OBJ／3MF／FBX。第一版輸出 OBJ 或直接轉 `polygon` 物件，glb 另外加。 |
| 雲端精煉（Zero123++／LGM／TripoSR→高模） | **與「離線」需求衝突**，而且要 GPU 服務與費用。建議不放進這次範圍。 |
| 「全 CPU 離線」的 ONNX 版 Zero123++ 5～30 分鐘 | 我沒驗證這個數字；以現有 VLM 在本專案 CPU 的實測（幾十秒到兩分多鐘）來看，只能當作「理論上可能」。不建議。 |

## 三、建議的做法（分階段）
- **階段一（預設，離線）**：新增「深度」類模型登錄（Depth Anything V2 Small）→ 可選去背（沿用現有或加 MobileSAM）→ 深度轉網格→補背面成封閉體→輸出 OBJ／`polygon` 物件，可直接在 `/edit-3d-model` 打開。入口：斜線指令 `/image-to-3d`（使用者指定的名字）與同名工具 `image_to_3d`；歸在哪個領域要看現有領域分配再定。
- **階段二（選用）**：UniK3D `vits` 當「公制／高品質」引擎，**使用者自備匯出的 ONNX 檔**（設定裡指定路徑），我們不下載、不內建，避開非商業授權的散布問題。先完成第一節四項驗證再決定做不做。
- **不做**：雲端精煉。

## 對 `image-decompose-redraw` 的影響（使用者 2026-10-29 的方向）
- 使用者的說法：**如果 UniK3D 可行**，`image-decompose-redraw` 就改成專攻「圖片轉 SVG」與「多圖層」，3D 的部分改由 `/image-to-3d` 負責。
- 現況：這個技能目前的管線是「四叉樹三角網格＋距離變換充氣成 2.5D」，3D 化是它的一個結果；`DESIGN.subject-research.md` 的 3D-3（找圖→3D）也靠它。
- 所以改法是**拆開**：技能只留分解（區域、圖層、SVG、前後景深排序）；2.5D 充氣那一段拿掉，3D-3 改呼叫 `/image-to-3d` 的同一條管線。拆之前必須先確認 `/image-to-3d` 的輸出品質不輸現在的充氣結果（同一批圖並排比較），否則 3D-3 會退步。
- **觸發條件要講清楚**：這個拆分以 UniK3D 實際驗證可行為前提（第一節四項驗證）。如果最後只能用 Depth Anything（階段一），`/image-to-3d` 仍然照做，但是否拿掉技能裡的充氣另外再決定，不要先拆。

## 需要你決定
1. UniK3D 的非商業授權你能接受嗎？（不能 → 階段二取消，只做階段一。）
2. 階段一輸出的背面要「鏡射成對稱」還是「做成平底的浮雕」？（建議平底浮雕：誠實，不假裝知道背面。）

## 來源
- UniK3D 專案：<https://github.com/lpiccinelli-eth/UniK3D>（授權、模型規格、環境）；論文 <https://arxiv.org/abs/2503.16591>
- 匯出程式：<https://huggingface.co/spaces/lpiccinelli/UniK3D-demo/blob/main/unik3d/models/export.py>
- 權重大小：<https://huggingface.co/lpiccinelli/unik3d-vits/tree/main>、<https://huggingface.co/lpiccinelli/unik3d-vitl/tree/main>
- Depth Anything V2（授權：Small 為 Apache-2.0，其餘非商業）：<https://github.com/DepthAnything/Depth-Anything-V2>；ONNX：<https://huggingface.co/onnx-community/depth-anything-v2-small>
- SAM2 tiny 的 ONNX 匯出範例：<https://huggingface.co/ipsilondev/sam2.1-hiera-tiny-ONNX>
