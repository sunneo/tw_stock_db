# `/edit-svg`:用語言主導的向量概念畫家(物件、無邊界平面、AI 對話框在編輯器裡)

> 2026-10-23。概念同 `/webedit`(網頁編輯器),但文件是「一堆物件」。這是 Redmine 外掛版(`redmine_ai_chat/DESIGN.edit-svg.md`)的桌面版:**編輯器本體(物件模型、檢視器、外框、描圖、圖片來源)原樣移植**,只換掉主機轉接層。全部在 client 端,不開埠、不用伺服器。
> 共用的外框與物件模型在 `renderer/src/edit/`,`/edit-picture`(DESIGN.edit-picture.md)與 `/edit-3d-model`(DESIGN.edit-3d.md)用同一套。

## 想做到的事
使用者說「在中間畫一個紅色的圓」「在太陽的右邊加一朵雲」,AI 就**新增一個物件**;沒有畫布邊界,可以加在任何地方;中間的檢視器讓使用者看(捲軸、拖曳、縮放),⌖ 回到**第一個物件**的中心。貼一張圖進對話,AI 試著把它描成 SVG(程式描、視覺模型確認、最多三輪)。最後輸出成品圖(SVG／PNG)與整理好的 prompt。

## 怎麼開
- `/edit-svg`(列出起手式 blank、shapes、flow)、`/edit-svg <起手式>`、`/edit-svg <一句話或網址>`(開空白,編輯器自己的 AI 去做)。
- AI 工具 `edit_svg_open`(參數 starter／request／file_id／id;領域 `editors`;依任務補工具 `FA_TASK_TOOL_HINTS` 的 `edit_svg_open`)。`file_id` 是使用者附的圖片,開起來就當第一張要描的圖。
- 編輯器是對話裡的一則訊息 ```` ```fa-edit-svg {"id":…} ````(`FaEditHost._mountEditEditors` 掛成編輯器),**預設立刻彈出成視窗**(`FaWin`:拖曳、八個邊角改大小、☐ 最大化、⤓ 收回對話);專案在 IndexedDB(`tw_edit`,`FaEditStore`),重新整理後從訊息重建,停在對話內。

## 檔案(`renderer/src/edit/`,用 `scripts/embed-code-ui.js` 內嵌進 `floating-assistant.js`)
| 檔案 | 全域 | 內容 |
|---|---|---|
| `edit_objects_core.js` | `FaEditObjects` | 物件模型(純函式):封閉動作、相對位置 `place`、無邊界畫布 |
| `edit_viewport.js` | `FaEditViewport` | 無邊界檢視器:捲軸、拖曳、縮放、只畫看得見的區域、`setHome/goHome` |
| `edit_store.js` | `FaEditStore` | IndexedDB:專案(`project/<kind>/<id>`)與圖片(`img/<ref>` Blob,文件只記短代號) |
| `picture_source.js`、`edit_pictures.js` | `FaPictureSource`、`FaEditPictures` | 網址、「找一張…的圖」(Wikimedia Commons → Openverse)、「換一張」、授權與出處記在物件的 `credit`;存圖時最長邊縮到 1600 px |
| `edit_i18n.js` | `FaEditI18n` | 英文介面補字(`<html lang>` 不是 zh 才翻;使用者自己的文字不翻) |
| `edit_shell.js` | `FaEditShell` | 外框:標題列、物件欄(顯示／鎖定／上下移／複製／刪除／改名)、屬性面板、**底部常駐的 AI 對話框**(附圖、貼上、拖入)、記錄、復原／重做(40 步)、「整理成 prompt」、匯出選單 |
| `edit_svg_core.js`、`svg_trace.js`、`edit_svg_ui.js` | `FaEditSvg`、`FaSvgTrace`、`FaEditSvgUI` | SVG 文件核心、描圖、畫面 |
| `edit_host.js` | `FaEditHost` | **桌面版主機轉接層**(見下) |

## 物件模型
物件由下往上(`o1`、`o2`…),型別:`shape`(rect/ellipse/line/arrow/triangle/polygon/star/path/text)、`svg`(自由的 SVG 元素:AI 畫的、描圖的結果)、`image`(點陣圖,像素另存 `ref`,歷史記錄才不會爆)。**編輯動作是封閉集合**:set_title、set_canvas、add_object、update_object、remove_object、rename_object、move_object、set_visible、set_locked、duplicate_object、clear_objects、fit_canvas、place_object,加 svg 的 transform_object／patch_markup。模型只填 JSON,程式驗證、拒絕不合法的(program-first)。**相對位置** `place:{of:<id|名字|selection|canvas|view|content>, rel:right|left|above|below|inside|center, gap, align, at, dx, dy}` 由程式用邊界框算,不讓模型算座標。

## 描成 SVG(`FaEditHost._edVectorize`)
縮小 → median-cut 加 k-means 調色盤 → 3×3 多數決 → 像素邊緣輪廓追蹤 → Douglas-Peucker 簡化 → 每個顏色一條 path。`compare()` 在 48×48 比相似度。流程:視覺模型(`_interpretImageWithVisionModel`)先描述原圖 → 以 10／18／30 色最多三輪 → 每輪比相似度、再請視覺模型看結果並與原描述比對 → 取最好的一輪,模型替各區塊命名成物件。沒有視覺模型時只用數字確認。圖片物件的屬性面板有「✨ 把這張圖變成 SVG」。

## 桌面版主機轉接層(`edit_host.js`)與外掛版的差異
| 要的東西 | 外掛版 | 桌面版 |
|---|---|---|
| 模型 | `AiChatAskLlm`(線上優先、離線備援) | `_kiLlm`(同一個線上→離線備援) |
| 視覺模型 | `AiChatAskLlm` 帶圖 | `_interpretImageWithVisionModel` |
| 網路圖片 | 瀏覽器 CORS,不行才走伺服器中繼 `/ai_chat/picture_fetch`(`PublicFetch`) | `fetch`,不行就 `_terminalHttpFetch`(主行程轉送),**沒有伺服器中繼** |
| 視窗 | `AiChatWindow` | `FaWin` |
| 放進對話 | `AiChatFileSink` + 記錄回應 | `generateAndDeliverFile`(下載卡片)+ 圖片直接顯示 + prompt 區塊 |
| 掛載 | 伺服器白名單 `VIEWER_KINDS` | ```` ```fa-edit-svg ```` 程式碼區塊 |

## 驗證與限制
- `node scripts/edit-tests/edit_objects_core.test.js`(46)、`picture_source.test.js`(14)、`edit_svg_core.test.js`(23)、`svg_trace.test.js`(11)(都在 `node scripts/run-core-tests.js` 裡)。
- 真實 Electron(假的 LLM／VLM):`FA_DEBUG_EVAL_FILE=scripts/eval/edit.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)`(SVG 部分:開啟、掛載成視窗、用說的加物件、復原／重做、描圖三輪加取名、放進對話含 prompt、專案存起來後**從 IndexedDB 真的重新掛載一份**、斜線指令、工具、依任務補工具)。
- **沒驗證**:真實 LLM／VLM 的品質(只用假模型);真實 GPU;描圖對複雜照片只是近似(色塊風格,不是向量化插畫);拖曳物件、滾輪縮放只在外掛版的 Playwright 驗證過(桌面版是同一份程式,沒有再跑一次);Openverse(網路不穩)。
