# 簡報的素材：使用者提供、或全程交給 AI 做（人物精靈圖、物件、地圖）

接續 [DESIGN.deck-rpg.md](DESIGN.deck-rpg.md)。RPG 場景已經能用程式畫的人物與地圖，也能用使用者給的精靈圖（`sheet`）與頭像（`portrait`）。
這份設計的是「素材從哪來」：

1. **使用者給素材並描述用途**（已有雛形：`assets[].use`）→ 補成完整的**素材目錄**。
2. **全程交給 AI 做**：
   - **人物**：3D 建模 → 2D 截圖 → 點陣化 → 走路的幾個動作畫格 → 精靈圖＋頭像；風格有**真實／動漫／可愛卡通**。
   - **物件、地磚、道具**：點陣圖物件設計工具（封閉的小指令，每一步由程式檢查），或沿用 3D 場景的基本幾何描述轉成點陣。
3. **走路路徑**：已經有（A*）；這裡補「人物彼此避開」。

全程要走 CoLU：程式讀需求、封閉選單只在歧義時問、程式有預設、程式檢查；弱模型不用自己寫腳本。

## 現況（查過程式碼）
- 3D 場景（`render_3d_scene`／`viewer3d.js`）：宣告式 YAML，基本幾何（box sphere cylinder cone plane torus polygon particles line）＋ 三種內建動畫（spin bounce orbit）。**沒有骨架與姿勢**，
  所以不能直接擺出走路的 4 個姿勢；但**靜態物件**（樹、桌子、房子）可以直接用它的描述。
- 圖像處理（`imgproc_core.js`，純 JS）：面積平均縮小、中位切割減色、馬賽克、模糊、旋轉、翻轉…，可在 Node 單元測試。→ 點陣化的材料現成。
- **有純 CPU 的相容層**：`viewer3d.js` 在沒有 WebGL 時退回軟體光柵化後備（`tryCreateWebGLRenderer` 失敗 → `rasterFrame`），`snapshotToDataUri` 就是離屏的「3D→2D 截圖」；桌面版自己也有一份。
  它的能力與限制：平面光照（一盞方向光、朗伯）、背面剔除、由後往前排序（**沒有逐像素深度**）、不能透明背景、沒有輪廓或色階；而且透過 three.js 的物件（Vector3、camera.project）與 2D canvas 的路徑填色來畫，所以**需要 DOM canvas 與 three.js**，不能在 Node 單元測試。
- 這台機器的 GPU 在無頭環境不穩定（評測時出現過 GPU 錯誤）→ 不能依賴 WebGL 做「截圖」；有 CPU 後備就不需要。

## 決定一：不用 WebGL；靜態物件重用現有 CPU 後備，人物用一個小的「緩衝式」軟體光柵化
現有的 CPU 後備（見上）**證明不需要 GPU**，所以不做 WebGL 路線。但人物精靈圖不直接拿它來畫，原因：
1. 人物是**一堆會彼此遮擋的肢體**，由後往前排序（沒有逐像素深度）會在手臂、軀幹交疊處出錯；精靈圖要的是乾淨的輪廓。
2. 精靈圖要**透明背景、色階、輪廓、共用調色盤**，現有後備都沒有；要加就得改成逐像素緩衝——等於重寫。
3. 它綁 three.js 與 DOM canvas，**Node 單元測試跑不了**；我們需要「同樣輸入永遠同樣的圖」和快速的自動檢查（輪廓、錨點、畫格差異）。

所以分兩條，共用同一套基本幾何與同樣的簡單光照模型（兩邊長得像、可以互相取代）：
- **靜態物件**（樹、桌子、房子、岩石）：直接重用 `render_3d_scene` 的 YAML ＋ `snapshotToDataUri` ＋ `imgproc` 點陣化，**幾乎零新渲染程式碼**，可以最先做。
- **人物**：新的 `sprite_raster.js`——純陣列（RGBA、深度、法線緩衝）、逐像素深度測試、透明背景、4 倍超取樣、風格（色階／輪廓）、確定性；輸入是三角形清單（不碰 three.js、不碰 canvas）。
  為了不重複造輪子，另外提供一個轉接：在 Electron 裡把 three.js 的 mesh（`extractWorldTriangles`）轉成同樣的三角形清單，所以人物與物件可以放在同一個場景裡渲染。
- 之後若要更高畫質的「真實」風格，再加 three.js（WebGL）後端——介面不變，有 WebGL 才啟用，沒有就用 CPU。

## 管線（每一步都是純函式，輸入輸出都可檢查）
```
需求（一句話／人物描述）
  │  ① 人物規格 character_spec（封閉字彙；程式從文字推，歧義才問）
  ▼
  ② rig_build        規格 → 骨架＋基本幾何（頭、軀幹、四肢、髮型、鬍子、衣服、配件）；體型與頭身比隨風格而變
  ③ rig_pose         骨架＋動作（idle／walk 4 相位）＋面向（下／左／右／上）→ 每個部件的世界變換
  ④ soft_render      Z 緩衝光柵化（4 倍超取樣）→ 顏色、深度、法線三張緩衝
  ⑤ style_pass       風格：real 平滑光照＋高光；anime 賽璐珞 3 階＋深色輪廓（深度／法線邊緣）；cute 圓潤、2 階、粗輪廓
  ⑥ pixelate         面積平均縮小到畫格大小 → 整張精靈圖共用一個調色盤（中位切割，16 色）→ 1 像素輪廓；背景透明
  ⑦ sheet_pack       4 個面向 × 4 個走路畫格，腳底對齊同一點 → 精靈圖＋ `sheet: {cols, rows, dirs, idle, fps}`
  ⑧ portrait         同一個模型近拍（頭肩）→ 比較大的頭像（同風格、較多色）
  ⑨ catalog_add      進素材目錄，帶 `use` 描述、規格（可以再改一改重做）、風格
```
程式檢查（不靠模型自述）：每格都有輪廓、腳底錨點一致、走路各畫格之間真的有差異（不是 4 張一樣的圖）、調色盤 ≤ 設定、背景透明、四個面向的輪廓大小接近；
任何一項不過就用預設重做一次，還不過就退回目前已有的程式畫的人物（`actor:`），並如實說明。預算：一個人物 < 5 秒（4×4×超取樣 4 的低解析度，純 JS 足夠）。

## 人物規格（封閉字彙，CoLU 的「填空」）
```yaml
character:
  id: liu_bei
  name: 劉備
  build: average            # slim | average | stocky | tall | child
  skin: fair                # fair | tan | dark | red（跟現有 look 同一組）
  hair: { style: topknot, color: black }       # topknot long short bun wild bald
  beard: none               # none short long bushy
  outfit: { type: robe_long, color: blue, trim: gold }   # robe_long robe_short armor tunic
  gear: []                  # hat headband sword staff fan
  style: cute               # real | anime | cute
  frame: [32, 48]           # 畫格大小；頭像另算
  palette: 16
```
規格從文字推：認得的歷史人物有預設（劉備、關羽、張飛、母親…，跟現在的外觀預設一致，這樣程式畫的版本與 3D 版本是同一個人）；
文字裡的特徵詞對到欄位（「長鬍子的老人」→ beard long、hair white、build average）；對不到就用預設並列在「程式先猜了什麼」，使用者可以改，不改也能繼續。
動作：`idle`、`walk`（4 相位：左腳前→經過→右腳前→經過，手臂反向擺）；之後可加 `talk`、`bow`、`jump`、`attack`——都是同一套骨架的角度表，不是新的程式。

## 決定二：物件與地磚——兩條路，都不要求模型寫程式
**A. 點陣圖物件設計工具**（弱模型走這條）：一個小畫布加調色盤，指令是封閉的 JSON 清單（≤ 200 條），程式驗證後執行並回傳預覽：
`rect ellipse line fill mirror outline shade(光源方向) stamp(複製已畫好的部件)`，外加現成的**樣板產生器**（樹、房子、岩石、寶箱、門、告示牌、花、井…，參數是封閉選項：大小、主色、屋頂色）。
每一步程式檢查：座標在畫布內、顏色在調色盤內、不是空白、顏色數 ≤ N、（要求對稱時）真的對稱。模型看得到預覽圖（有視覺能力時）或程式算的摘要（輪廓框、顏色分布）。
**B. 3D 基本幾何轉點陣**：沿用 `render_3d_scene` 的 YAML（box／sphere／cylinder／cone／plane／torus）→ 同一個軟體渲染器 → 同一套 style_pass 與 pixelate → 單張或四個面向。AI 本來就會寫這種描述，格式不用學新的。

## 素材目錄（使用者給的與 AI 做的放同一處）
```yaml
asset:
  id: a_liu_walk
  kind: sprite          # sprite（走路精靈圖）| portrait（頭像）| object | tile | map | background
  name: 劉備走路
  use: 劉備走路，4 個方向各 4 格，可愛風   # 用途描述：使用者寫，或程式從規格產生，或離線圖像模型看圖產生後請使用者確認
  tags: [劉備, 走路, 可愛]
  src: …                 # 圖片代號（@imgN／檔案 id）
  sheet: { cols: 4, rows: 4, dirs: "down,left,right,up", idle: 1, fps: 6 }
  made: { by: ai-3d | ai-pixel | user, style: cute, spec: { … } }   # AI 做的帶規格：改一個欄位就能重做
```
- 工具（都帶封閉選項與預設）：`asset_add`（上傳＋描述用途）、`asset_list`、`asset_find(需求)`、`asset_describe`（沒寫用途時，離線圖像模型看圖給一句描述，請使用者確認）、
  `asset_make_character`、`asset_make_object`、`asset_pixel_design`。
- 規劃器（`rpg_plan.js`）從素材目錄取 `assets`：先用描述比對（人物名＋走路／頭像／地圖…，已有），描述比不到時用語意排序（見下），多個都符合才問。
- 存放：沿用桌面版的檔案快取與 persistentStorage（使用者的資料夾，不進 repo）；AI 做的素材**預設存進目錄**，使用者可以刪、改、匯出。

## 決定三：語意比對的降級順序（素材與工具都用）
字詞比對（永遠可用）→ 使用者設定的 embedding 模型 → 離線 WASM 小模型（只要中英文）→ 每一級有期限（含載入 30 秒），答不出來**交給 LLM**。
離線模型要先量：候選（中英雙語的小型句向量模型，q8 約 100 MB 上下）在這台機器 CPU 上的載入與推論時間、對「素材描述／工具說明」的召回率；沒量過不接。

## 走路：繞開彼此
目前 A* 只避開地圖物件。補：同一拍有多個人移動時，後面的人把前面的人的**目標格與路線格**當臨時障礙（`findPath` 已有 `extraBlocked`）；
兩人面對面說話時各站一格不重疊（已有：走到對方旁邊的空格）。

## 決定四：不同人物不同聲音＝「嘴音」（用 sfx 做）
簡報的音效是程式合成（`deck_sfx.js`：`render(name, sampleRate, opts)`），播放與匯出 MP4 共用同一份 cue 清單（`Core.sfxCues`），所以人物的聲音**不需要聲音檔，也不需要另一個 TTS 聲音**。
- **做法**：新增音效 `blip`（一個很短的音），參數就是人物的聲音設定；對話框（`box`／`subtitle`）每打出一個字就一個 cue——跳過空白，標點處停一拍；
  音高在基準上依字元碼小幅跳動（確定性，同一句永遠一樣），聽起來像在「說話」。cue 的時間跟對話框打字進度同步（沿用 `typedCount`：打字花一句長度的 80%）。
- **聲音設定**（封閉預設，也可以寫數字）：`voice: calm | deep | rough | elder | old_woman | young | child | narrator`，或 `{pitch 80..600 Hz, wave sine|tri|square, rate 0.5..2, jitter 0..1, vibrato 0..1}`。
  預設對照（規劃器依人物給）：劉備 calm（中音、三角波、平穩）、關羽 deep（低、方波、慢）、張飛 rough（低、方波加雜音、快、跳動大）、母親 old_woman（高、三角波、帶顫音）、孩子 child（高、正弦、快）。
- **欄位**：collage 項目的 `voice`；音效 cue 多帶一個參數物件（`render` 已經收 `opts`，播放器的快取鍵要把參數算進去）。
- **音量的搭配**：說話者變亮時嘴音完整音量，旁白（TTS）出聲時嘴音壓低——避免互相蓋。
- **與旁白（TTS）的關係——要決定，也是動工前必須先查清楚的事**：目前旁白是**整頁一段** TTS（`synthesize(slide.narration, voice, speed, lang)`），`timingFor` 依音檔長度與字數比例分配每一句。
  - 選項 A（簡單、先做）：旁白照念（也念「劉備說：…」），嘴音疊在上面。最容易、不改語音流程，缺點是對白被念兩次（旁白一次、嘴音當伴奏）。
  - **選項 B（建議）**：對白句標成「嘴音句」（`slide.blipSentences: [2,3,…]`，規劃器依 `say` 自動決定）：TTS 只念敘述句，嘴音句不出 TTS、長度由字數與嘴音節奏決定。
    時間軸上仍然一句一拍，所有 `sentence: N` 的對齊都不變。代價：旁白要改成**分段合成**（念出的句子合成、嘴音句換成靜音空檔，再接起來；匯出 MP4 時混音同理）。
    能不能分段取決於 `synthesize`、語音快取（以文字＋聲音＋語速為雜湊）、`timingFor` 的接法——**要先讀這三處、量一次再決定**。
- **驗收**：同一句對白，不同人物的音高、音色、節奏聽得出差別（用頻譜測：基頻落在設定範圍、方波的諧波比正弦多、vibrato 有調變）；cue 時間與打字進度一致；匯出的 MP4 與播放一樣；`voice` 驗證與說明。
- **風險**：嘴音聽久了可能煩（所以有音量、節奏、可關閉：`voice: none`）；不是真人聲，只是像 RPG 的說話音，要在說明裡講清楚。

## 實作狀態（2026-10）
- **階段 0 完成，且超出選項 A**：使用者要求「旁白可有可無，人物用自己的聲音」，所以做成「對白有自己的時間軸」（`say.at` 錨點、`line` 串接、頁長延伸），人物只用嘴音（`blip`），不再被旁白念第二次；選項 B 的「旁白分段合成」不需要了。
- **階段 1a 完成**：`sprite_pixel.js`（純函式、Node 測試）＋ host `_deckMakeObjectSprite` ＋ 工具 `make_object_sprite`。流程：內建 3D 樣板（`objectYaml`／`objectParts`：tree pine house table chest rock well，顏色／屋頂／牆是封閉選項）→ 零件 → `sprite_raster.js`（自己的 z-buffer 光柵，直接輸出透明度；一開始用既有 CPU 後備＋雙背景去背，後來換掉，原因見階段 1）→ `pixelate`（裁到內容、面積平均縮小、gamma 提亮、中位切割 16 色、1 像素外框、腳底貼畫格底部，預設 32×48，房子 64×48）→ 程式檢查 → PNG 匯入成 `@imgN`；collage 項目寫 `{src, tx, ty, tw, pixel: true}`。
  真實 Electron 驗證過：七種物件都畫得出來、透明背景、顏色數在範圍內，放進村莊地圖看得出來（`scripts/eval/deck-sprite.eval.js`）。不需要網路。
  **限制**：精靈的像素比地圖磚細（地圖是 16×9 格的大塊像素），並排時風格有點不一致。
- **階段 1 完成（人物精靈圖）**：`char_model.js`（外觀 look＋風格＋方向＋走路相位 → 約 20 個零件：盒子、球、圓柱、圓錐；詞彙跟 `actor:` 一樣，所以劉備、關羽…的預設與自訂 look 都能做）→ `sprite_raster.js`（**自己的 z-buffer 軟體光柵**，純函式：每個像素有深度緩衝、依插值法向量算 Lambert，直接輸出透明度）→ `sprite_pixel.pixelateMany`（16 格共用同一個裁切、縮放與調色盤，不然走路會抖、會變色）→ `packSheet`（4 欄 × 4 列：列＝下 左 右 上，欄＝走路循環，欄 1 是站姿＝idle）。工具 `make_character_sprite {preset|look, style, name}`。
  三種風格：`real`（寫實比例、24 色、輪廓取鄰色的暗色）、`anime`（修長、大眼睛加高光、賽璐珞——亮度只分 3 階）、`cute`（大頭、圓眼睛加腮紅、12 色）。
  **跟原設計不同的地方**：原計畫「重用既有 CPU 後備 ＋ 雙背景去背」，實測既有後備沒有 z-buffer（依三角形平均深度排序），頭髮球蓋在頭上這類交疊會出現雜訊，所以改成自己的小光柵（也就是決定一裡原本寫的「人物用一個小的緩衝式軟體光柵化」）；順便讓人物與物件（`make_object_sprite` 也改用它）都**不需要 three.js、沒有網路相依**。雙背景去背（`matte`）留在 `sprite_pixel.js` 裡備用。
  **限制**：32×48 的臉只有幾個像素（眼睛 1～2 像素）；只有 4 個方向（沒有斜向，8 方向還沒做）；走路是 4 相位的基本款；頭像（`portrait`）還不是從 3D 轉出來的；人形骨架而已（沒有動物、怪物）；沒有給使用者「用口語描述外觀」的轉換（只有 look 的封閉詞彙與預設）。
- **點陣圖物件設計工具完成**：`pixel_art.js` ＋ 工具 `pixel_art`。模型寫「調色盤（一個字元→一個顏色）＋一列一列的字母＋少數繪圖指令（rect line circle ellipse fill dot erase）＋ `mirror`（只畫一半）＋ `shade`（自動亮部暗部）＋ `outline`」，或選內建範例（heart sword potion coin key flower mushroom gem chest）加 `recolor`；
  程式逐欄驗證（錯誤指到「rows[1] column 2: "z" 不在調色盤」「ops[0].x 要在 0..7」），畫出來、檢查（空白、像素太少），並把結果用**文字預覽**（每個像素一個字元）回給模型自己看。每邊 4..64 像素、最多 40 個指令、32 色。
  **限制**：沒有真的讓模型迭代修圖的實測（評測只驗證工具本身與錯誤訊息）；沒有圖層、動畫畫格；地磚的可拼接（tileable）沒有檢查。
- **2.5D 第一層完成**：見 DESIGN.deck-rpg.md（`depth: y`、`tz`、影子、`parallax`）。
- **three.js 自己 pin**（使用者 2026-10-19 要求）：桌面版 `renderer/vendor/three/`（r128 的 three.min.js、OrbitControls、STL／OBJ／3MF／FBX loader、fflate，原封不動，附 SHA256SUMS.txt 與授權），FA_ASSET_URLS 的 three* 預設改成相對路徑、用到才載入；任何一個載入失敗（網頁版、熱更新蓋掉的 index.html 旁邊沒有 vendor、檔案被刪）就退回原本的 CDN（`FA_ASSET_CDN`／`_faAssetFallback`）。簡報的 viewer3d／deck_stage3d 透過 `window.AiChatLoadScript` 共用同一個載入器。
  **網頁版**：要放進 `vendor-assets` 分支（單一 commit、force push）並在 `web/index.html` 的 `setAssetUrls` 加上 three 的網址——**還沒做**（要 force push，等使用者決定）。

## 分階段（每階段都有可驗收的東西）
| 階段 | 內容 | 驗收 |
|---|---|---|
| 0（已完成） | 人物嘴音：`blip` 音效＋ `voice` 欄位＋預設對照＋嘴音 cue 與打字同步（選項 A，旁白照念）；先查選項 B 的可行性 | Node 單元測試（cue 時間、頻譜差異）；播放與匯出一致；列出選項 B 需要改哪幾處 |
| 1a（已完成） | 靜態物件：現有 CPU 後備截圖 ＋ 點陣化（樹、桌子、房子 → 精靈） | 用 `render_3d_scene` 的 YAML 做出一棵樹的點陣圖，進素材目錄 |
| 1（已完成） | `sprite_raster.js` ＋人物骨架（cute 風格）＋ pixelate ＋ 精靈圖打包＋程式檢查 | Node 單元測試；Electron 畫出劉備／關羽／張飛的精靈圖 PNG，肉眼看得出三個人、4 個面向、走路有動 |
| 2 | anime 與 real 風格、頭像近拍、調色盤共用、輪廓 | 同一個規格三種風格的 PNG 並排；檢查項全過 |
| 3 | 素材目錄＋CoLU 工具＋規劃器接上（含用途描述自動補） | 「做劉備走路」一句話 → 素材進目錄 → 故事規劃自動用上；失敗退回程式畫的人物 |
| 4（已完成） | 點陣圖物件設計工具＋樣板產生器；3D 基本幾何轉點陣 | 每個樣板與指令都有測試；弱模型（假 LLM 只選選項）能做出一棵樹與一間房子 |
| 5 | 離線語意比對（先量測再決定）＋人物彼此避開 | 量測數字；有期限的降級測試 |

## 風險與誠實的限制
- **畫質**：32×48 的人物很小，「真實」風格只能是「有光影、較多色」的點陣，不會像照片；動漫與可愛會比較好看。要更高畫質需要加 three.js 後端與較大的畫格。
- **骨架只有人形**：動物、機器人、怪物要另外的骨架；先做人形（故事裡最常用）。
- **走路畫格的品質**：4 相位的走路在小畫格看起來是「基本款」，不是專業動畫師的手繪；可以調角度表，但不會自動變好看。
- **模型生成規格的準確度**：弱模型把一句話對到規格欄位會出錯；所以欄位是封閉選單、有預設、使用者可改，檢查由程式做。
- **授權**：預設人物是歷史人物的通用形象；不做有版權的角色。使用者上傳的素材由使用者負責授權。
- **沒量過**：軟體渲染在這個解析度的速度與外觀、離線 embedding 的耗時與召回率、離線圖像模型替素材寫用途描述的準確度。

## 需要決定
1. 渲染：同意**不用 WebGL**——物件重用現有 CPU 後備、人物用新的小光柵化（決定一）嗎？
2. 預設畫格大小：32×48（建議，RPG 風格）、48×64（較細）？頭像 192×192？
3. 人物聲音：旁白先用**選項 A**（嘴音疊在 TTS 上）還是直接做**選項 B**（對白只用嘴音，要先查旁白能不能分段合成）？
4. 先做哪一段：我建議**階段 0**（嘴音，最小、立刻聽得到）與**階段 1a**（物件，零新渲染程式碼），再做階段 1（人物精靈圖）。
