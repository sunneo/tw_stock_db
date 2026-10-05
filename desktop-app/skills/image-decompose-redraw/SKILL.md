---
name: image-decompose-redraw
description: 把一張 2D 點陣圖分解成三角網格與區域、猜出前後景深、用距離變換「充氣」成 2.5D 幾何體，再把原圖顏色重新取樣貼回去，輸出向量 SVG、帶 UV 的 3D 網格（JSON／OBJ）。目前實作的是「Without Vision Model」純幾何軌道（不需要視覺模型）。當使用者要把圖片向量化重繪、做 2.5D／視差動畫、拆圖層、或把平面圖變成可轉動的立體網格時使用。
---

# Image-Decompose-Redraw

把 2D 圖分解並向量重繪。設計成兩條軌道：

| 軌道 | 狀態 | 做法 |
|---|---|---|
| **Without Vision Model（純幾何 2.5D）** | ✅ 已實作（本資料夾） | 四叉樹三角網格 → 區域聚類＋圖地線索猜景深 → 距離變換充氣 → UV 重新取樣 |
| With Vision AI | ⏳ 尚未實作 | 視覺模型辨識物件與前後關係，覆蓋純幾何猜的景深順序（介面見下） |

只依賴 `numpy` 與 `Pillow`（網頁版 Pyodide 也有），不需要 scipy／OpenCV。

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

## With Vision AI 軌道的接入點（規劃，未實作）

視覺模型要做的事是產生「區域 → 景深順序」，直接覆蓋 `regions.Regions.z_norm`／`z_index`，後面的充氣、UV 重新取樣、輸出完全不用改。建議的資料格式：`[{"region": id 或 bbox/點座標, "z_index": n, "label": "…"}]`；區域 id 對應 `res.regions.label` 的標籤圖，視覺模型看到的是同一張標籤圖的著色版，這樣兩條軌道共用同一組幾何。
