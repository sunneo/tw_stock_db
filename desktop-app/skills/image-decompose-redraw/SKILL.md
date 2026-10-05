---
name: image-decompose-redraw
description: 把一張 2D 點陣圖分解成三角網格與區域、猜出前後景深、用距離變換「充氣」成 2.5D 幾何體，再把原圖顏色重新取樣貼回去，輸出向量 SVG、帶 UV 的 3D 網格（JSON／OBJ）。目前實作的是「Without Vision Model」純幾何軌道（不需要視覺模型）。當使用者要把圖片向量化重繪、做 2.5D／視差動畫、拆圖層、或把平面圖變成可轉動的立體網格時使用。
---

# Image-Decompose-Redraw

把 2D 圖分解並向量重繪。設計成兩條軌道：

| 軌道 | 狀態 | 做法 |
|---|---|---|
| **Without Vision Model（純幾何 2.5D）** | ✅ 已實作（本資料夾） | 四叉樹三角網格 → 區域聚類＋圖地線索猜景深 → 距離變換充氣 → UV 重新取樣 |
| With Vision AI | ✅ 已實作（`vision.py`） | 視覺模型看原圖＋標籤圖，回傳每個區域的名稱與景深順序，覆蓋純幾何猜的結果；沒有可用的模型就退回純幾何 |

只依賴 `numpy` 與 `Pillow`（網頁版 Pyodide 也有），不需要 scipy／OpenCV。

## 在 Floating AI Assistant 裡

已接進助理的內建技能清單（`skill_builtin-skill-image-decompose-redraw`，`BUILTIN_SKILLS`），工具是 `image_decompose_redraw`：`{image: 📎上傳的 file_id 或檔名, vision: off|auto|on, preview, max_side, max_leaves, welded, output_ref}`。腳本由 `scripts/embed-code-ui.js` 嵌進 `FA_IDR_SKILL_FILES`，每次呼叫寫進 python_execute 的 `/work/idr/`（網頁版與桌面版都用 Pyodide，自動載入 numpy 與 pillow），輸出預設存進 persistentStorage 並出現下載卡片，`output_ref:"fap:<名稱>"` 可存進授權的資料夾。改了 `skills/image-decompose-redraw/` 之後要重新 `node scripts/embed-code-ui.js` 與 `node build-assistant.js`。

## 用法

```bash
python scripts/run_geometric.py 輸入圖.png --out 輸出資料夾 --preview
```

```python
import sys; sys.path.insert(0, "scripts")
from idr import Params, decompose, save_all
res = decompose("輸入圖.png", Params(max_side=384))
print(res.stats)            # 區域數、三角形數、耗時…
save_all(res, "輸出資料夾", "name")   # SVG、mesh.json、OBJ＋MTL、貼圖 PNG
```

輸出：`.svg`（依景深由遠到近）、`.mesh.json`（頂點 xyz、UV、頂點顏色、面、區域與 z_index）、`.obj`＋`mesh.mtl`＋`.texture.png`、`.preview.png`（正面與左右各轉 15°）。

## 流程與檔案對照（數學都寫在各檔案開頭的註解）

| 步驟 | 檔案 | 重點 |
|---|---|---|
| 1. Top-Down 切割 | `quadtree.py`、`mesh.py` | 以積分圖算方差、依「方差×面積」最大的先切（有限預算花在細節多的地方）；大格子邊上的 T 字接點補成邊界頂點，扇形連中心 → 沒有裂縫的三角網格 |
| 2. 拓撲連接與景深猜測 | `regions.py` | 相鄰葉子「邊界色差小且合併後平均色仍接近」就合併；對每一對相鄰區域用圖地線索（包圍、面積、凸性、影像邊界接觸、垂直位置）算「誰在前」，再解最小平方得全域一致的深度 |
| 3. 幾何充氣與頂點對應 | `edt.py`、`inflate.py` | 在像素角點格子上做精確距離變換，z = 景深基底 + A·d_ref·√(1−(1−t)²)；(x,y) 不動，每個 3D 頂點記著 `src_vertex` |
| 4. 重新取樣貼圖 | `resample.py` | UV = (x/W, y/H) 只看原位置；逆向映射＋重心座標雙線性取樣；頂點顏色用區域感知的正規化卷積，不會把鄰居顏色滲進來；`render_view` 可轉動視角做視差與自我檢查 |

## 參數（`Params`）

`max_side`（工作解析度，預設 384）、`max_leaves`（格子預算，決定三角形數）、`var_thresh`（Lab 方差門檻）、`min_size`、`tau_edge`／`tau_color`（聚類門檻）、`depth_weights`（景深線索權重：enclosure、area、convexity、border、vertical）、`amplitude`、`bevel`、`depth_range`、`separate_regions`（True＝各區域有自己的 3D 頂點、真的有景深落差；False＝單片連續網格，2D↔3D 完全一對一）。

## 驗證

`python tests/test_geometric.py`：距離變換對暴力解、四叉樹鋪滿、網格無裂縫、三角形面積為正、合成圖上的景深順序（窗戶在建築前、建築在天空前、球在建築前）、沒有沿輪廓的細長假區域、充氣不改 (x,y)、邊界頂點不充氣、welded 模式一對一、正面視角重畫的覆蓋率與 PSNR、轉動視角有視差並露出空洞（不編造內容）。

## 限制（誠實說明）

- 景深是**猜測**：對「物體放在背景上」的圖很準；複雜重疊（手臂擋在身體前）可能猜錯。純幾何沒有語意，不知道什麼是「人」或「地面」。
- 區域邊界的精度大約是 `min_size` 像素（四叉樹是軸對齊的格子，斜線與曲線邊緣會呈階梯狀）；要更準就調小 `min_size`、調大 `max_leaves`。
- 漸層會被 `tau_color` 切成幾條色帶（防止漸層一路合併成漂移的一大塊）；色帶之間的景深順序沒有意義。
- 轉動視角時被擋住的地方是空洞（alpha=0），本模組不補內容。
- 純 Python 實作，長邊 384 的圖約 1 秒內完成；解析度或格子預算大很多時會明顯變慢。
- 測試只用合成圖與一張介面截圖驗證，沒有在大量真實照片上評估過。

## With Vision AI 軌道（`vision.py`）

```python
res = decompose("輸入圖.png", Params(), vision="auto")   # off（預設）／auto／on
print(res.stats["depth_source"])        # "vision" 或 "geometry"；退回時 stats["vision_fallback"] 說明原因
```
命令列：`--vision auto`。流程：把原圖與「區域標籤圖」（每區塗平均色、畫邊界、重心標編號）兩張 PNG 加上區域表交給模型，模型回
`{"regions":[{"id":3,"label":"天空","depth":0}]}`（depth 越小越遠）；被提到的區域覆蓋 `z_norm`／`z_index`，沒被提到的保留純幾何的結果，然後
`pipeline.rebuild_3d` 重新充氣、取 UV 與頂點顏色（其餘步驟不用改）。`auto`：失敗就退回純幾何；`on`：失敗就報錯。

**模型從哪來（API 轉接）**：腳本只用標準的 `anthropic`（優先）或 `openai`（環境變數 `IDR_VISION_CLIENT` 可指定）寫法呼叫，帶 image block／image_url。
在 Floating AI Assistant 執行技能包時，Python API 轉接層會自動轉給助理已設定、而且支援讀圖的 LLM Model（依 Model 的 vision 能力標記挑，金鑰、
網址、model 名稱都不用管）；全部 Model 都不支援讀圖時丟 `NotSupportedError`，`auto` 就退回純幾何。不在助理裡執行時會用真正的 SDK，需要自己的金鑰。
**純幾何軌道完全不呼叫模型，不需要轉接。**

驗證：`python tests/test_vision.py`——換掉 `ask` 的覆蓋與重建、JSON 容錯解析、經轉接層（假的主機端）的 anthropic 與 openai 兩種寫法都送出兩張 PNG、沒有讀圖模型時退回幾何、`on` 時報錯。
限制：只用假的主機端驗證，沒有用真的視覺模型評估過它判斷景深的品質；模型只看得到最大的 60 個區域的編號，其餘區域保留純幾何的結果。
