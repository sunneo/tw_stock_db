# 可註冊的知識類型（Knowledge Types）設計文件

> 狀態：設計草案（2026-10-05），尚未實作。目標：讓離線訓練器的通用知識能表達「有結構的知識」（臉的部位、骨骼、關節運動、聲音、手勢…），而不是每多一種就在引擎裡硬寫一個新種類。

## 1. 要解決的事

現有的通用知識是 `{kind, key, text, tags, src}`：`text` 給人讀、給檢索用，程式讀不到裡面的數字與關係。圖片分解想要「臉由眼鼻嘴組成、眼睛通常在臉的上半部、眼窩往內凹」這類知識，後面還有骨骼、關節運動、聲音、手勢。這些都有共同的需求：

- 能**切割**：一個大概念拆成小條目，各自維護。
- 能**重用**：同一個「眼」被「人臉」「動物臉」共用，只改差異。
- 能**遞迴定義**：臉引用眼，眼引用眼球與眼瞼。
- 能用**狀態機**描述：手勢的「準備—出手—收回」、眨眼的「睜—閉—睜」。
- 能被**訓練**：使用者或 AI 修正後，改的是條目的參數，下次直接生效。

不為每一種新知識新增一個種類，而是讓**類型本身可以註冊**。

## 2. 條目與類型

條目（entry）維持原本的欄位，多一個選填的 `customize`：

```json
{ "kind": "visual_part", "key": "human-eye", "text": "人類的眼睛：臉的上半部、左右對稱的兩個小橢圓…",
  "tags": ["face", "eye"], "src": "user", "customize": { … 由該類型的 schema 決定 … } }
```

- `text`：給人讀、給語意檢索（RAG、離線訓練器）。**不放結構化資料**。
- `src`：出處。沒有來源的內容不收（沿用現有規則）。
- `customize`：結構化資料，結構由 `kind` 對應的**已註冊類型**規定。沒有 `customize` 的舊條目照常運作（向下相容）。

類型（type）用註冊的：

```json
{ "kind": "visual_part", "label": "視覺部位", "description": "…",
  "schema": { "in": {"type": "ref", "kind": "visual_part"}, "box": {"type": "list", "of": "number", "length": 4}, … },
  "version": 1 }
```

- 內建類型隨程式出廠（`renderer/src/refs/types_*.json`），使用者與 AI 可以在執行期註冊新類型（`ref_register_type`，像 `ref_define` 一樣要附來源）。
- 同一個 `kind` 重新註冊就是升版（`version` 增加，舊條目依舊驗證，不相容的欄位列出警告）。

## 3. schema 語言（小而夠用）

欄位型別：`string`、`number`、`integer`、`boolean`、`enum`（`values`）、`range`（`[lo, hi]`）、`list`（`of`、`length`、`min`、`max`）、`object`（`fields`）、`map`（`of`）、`color`（引用色彩族）、`ref`（引用另一個條目：`kind`，可選 `field`）、`any`。每個欄位可有 `required`、`default`、`doc`。

驗證只做結構（型別、範圍、必填、引用的條目存在），不執行任何程式碼。

## 4. 引用、重用、遞迴

- `ref` 欄位指向另一個條目的 key，可以跨類型（例如動作的軌跡引用骨骼的關節）。
- **展開**（expand）：把一個條目的 `ref` 遞迴換成被引用條目的內容，帶深度上限（預設 8）、循環偵測、記憶化；`extends`（繼承）欄位先合併父條目再套用自己的差異。
- 參數：引用可以帶參數覆寫（例如 `{ "ref": "human-eye", "as": "left", "set": { "box": [0.12, 0.28, 0.46, 0.48] } }`），同一個「眼」重用成左右眼。
- 通用操作（所有類型共用，與領域無關）：`ref_types`（列出已註冊類型）、`ref_register_type`、`ref_define`（帶 `customize`，依類型驗證）、`ref_expand`、`ref_validate`（全庫檢查：引用是否存在、有無循環、型別是否對得上）。

## 5. 狀態機是一個註冊的類型

`machine` 類型：`{ states: {名稱: {on: {事件: {to, do?}}}}, start, end? }`，`do` 引用基本動作或其他 `machine`。離線訓練器內建一個純資料的直譯器（不跑程式碼）：給事件序列，回傳狀態軌跡。手勢、眨眼、說話口型、錯誤處理流程都可以用它描述，也能互相引用（遞迴）。

## 6. 基本動作與直譯器由使用者（消費端）提供

知識庫只描述「怎麼組合」，不知道什麼叫「顏色落在膚色範圍」。**基本動作（primitive）由消費端註冊實作**：

```js
FaRef.registerPrimitive('color_in', fn)   // 或 Python 端：skill 自己實作同名動作
```

類型可以宣告自己需要的基本動作，驗證時若消費端沒有實作會列出缺少的動作。這樣知識庫保持通用，技能保持可替換，離線與 AI 兩條路共用同一份知識。

## 7. 範例：同一套機制，不同的類型

| 類型 | customize 的重點 | 引用 |
|---|---|---|
| `visual_part` | `in`（容器）、`box`（容器內的典型位置）、`count`／`symmetric`、`size`、`shape`、`color`、`depth`（凸／凹與振幅） | `in` → `visual_part`；`attach` → `joint` |
| `skeleton` | `joints: [{id, parent, offset, limits}]` 的樹 | `parent` → 同骨架的關節 |
| `joint` | 單一關節的名稱、旋轉／位移範圍、預設姿勢 | 可被 `skeleton`、`motion`、`visual_part` 引用 |
| `motion` | `tracks: [{joint, keys: [{t, rot}], ease}]`、`loop`、`duration` | `joint` → `joint`；可含 `machine` |
| `machine` | 狀態、事件、轉移 | 引用基本動作或其他 `machine` |
| `sound` | 取樣率範圍、頻譜特徵、包絡、事件標記 | 可被 `motion`（口型）引用 |
| `gesture` | 由 `machine` 描述的姿勢序列、各階段的關節條件 | → `joint`、`machine` |

**骨骼與關節運動**：`visual_part` 用 `attach` 綁到關節，`motion` 用軌跡驅動關節，就能做蒙皮動畫（頭轉動、眨眼、張嘴）。**重要的限制**：知識庫與離線訓練器可以儲存、檢索、展開、驗證這些定義；但「真的播放蒙皮動畫」需要檢視器支援（目前助理的 3D 檢視器只有旋轉、彈跳、軌道這類整體動畫），那是另一個獨立的檢視器功能，不在這份設計裡。

## 8. 圖片分解怎麼使用

1. 技能執行前，把已註冊的 `visual_part`（內建＋使用者／AI 補的）展開成一份 `parts.json` 交給腳本。
2. 腳本實作基本動作（顏色在範圍內、在容器相對位置、左右對稱配對、局部深度），依展開後的結構偵測部位，把凸凹的深度加到模型上，輸出每個部位的位置與信心（沒有偵測到、只靠位置先驗的部位明確標示）。
3. 使用者或 AI 修正（例如「這裡才是眼睛」）→ 存成使用者條目（同 key 覆寫內建、加 `src: "user"`）→ 下次直接生效；離線訓練器與 RAG 也查得到。
4. 離線路由：「把這張圖做成 2.5D」→ 呼叫 `image_decompose_redraw`（純幾何＋已註冊的部位知識），不需要 AI。

## 9. 膚色與動物的處理（避免誤解）

「各種族」不做成人種分類。部位偵測用的是**顏色族群**（皮膚色範圍：淺、中、深、動畫風格…；毛色範圍：淺、棕、深、橘、灰…），涵蓋各種膚色與動物毛色，用顏色與形狀特徵比對，不依賴任何人種標籤。信心低時如實標示，不硬套。

## 10. 與現有格式的相容性

分兩個層次：**不壞掉**（必做）、**逐步收斂**（選做，可以慢慢來）。

### 10.1 不壞掉（零風險）

- 既有 `generic`、`build_error_rule`、`error_code`、`command`、`pragma`…的資料、DSL 檔、`ref_define` 的參數、診斷引擎與離線路由**完全不動**；沒有 `customize` 的條目行為不變。
- 註冊表只是疊在上面的一層：新增類型與條目走新路徑，舊的走舊路徑。
- `ref_define` 新增「kind 若是已註冊類型就依 schema 驗證 `customize`」這一條，其餘分支不變。
- `exportBuiltin`／`promote-runtime-defs` 多輸出 `types_promoted.json` 與帶 `customize` 的條目，沿用「執行期補的定義升級成內建」流程。

### 10.2 逐步收斂：舊種類也能當成註冊的類型（轉接層，不搬資料）

既有的種類大多是結構化的，可以用註冊的 schema 描述，讓 `ref_types`、`ref_validate`、`ref_expand` 對舊資料也有效。做法是**轉接層（adapter）**：舊種類註冊成 `legacy: true` 的類型，附一個讀取轉接器，直接從現有儲存讀出條目，不複製、不改寫資料；寫入仍走原本的 `ref_define`。

| 舊種類 | 對應的 schema 重點 | 備註 |
|---|---|---|
| `error_code` | `system`、`code`、`name`、`msg`、`note` | 平面欄位，最簡單 |
| `build_error_rule` | `id`、`system`、`level`、`re`（型別 `regex`）、`start`／`span`、`what`、`causes[]`、`fixes[]`、`see` | 要新增 `regex` 型別（驗證能編譯、具名群組不重複） |
| `command` | `name`、`aliases[]`、`synopsis`、`options[{flag,arg,desc}]`、`subs`、`lists` | 現有的 `inherit`（命令繼承）就是 `extends`，剛好對上 |
| `pragma`／`clause` | `key`、`desc` | 簡單 |
| `semantics`／`grammar_pattern`／`assembly`／`build_system`／`tokenizer` | 現在就是 `{key, text, tags, src}`，`customize` 留空 | 已經相容，只需要登記類型名稱 |

- **效能與正確性界線**：診斷引擎（`diagnoseLog`）、命令解析、錯誤碼索引的熱路徑繼續用自己的原生索引，**不經過**通用的展開與直譯；註冊表在它們上面只提供「列出、驗證、檢視、跨類型引用」，不取代它們。
- **跨類型引用才是收斂的好處**：例如一條 `build_error_rule` 可以引用 `error_code`（「這個錯誤碼的意義」）或 `command`（「這是哪個命令的選項」），現在這些關聯只存在於說明文字裡。
- **驗證方式（黃金測試）**：每個舊種類註冊成類型後，用註冊表匯出的 DSL／JSON 必須跟現有 `exportBuiltin` 的輸出逐字相同；現有的 35 項診斷測試、命令與錯誤碼查詢測試全部要維持通過。任何不一樣就是轉接器的 bug，不能靠改舊資料來「解決」。
- **不強迫搬遷**：舊種類永遠可以停在 `legacy` 狀態；只有當它真的需要跨類型引用或繼承時才補完 schema。

### 10.3 有機會做不到的地方（先講清楚）

- `build_error_rule` 的 `re`、`span` 有自己的語意（具名群組自動解碼 errno、區塊範圍），schema 只能驗證格式，不能驗證「規則會不會比對得到」；這個仍由 `ref_define` 的範例驗證負責。
- 命令的選項繼承有現有的合併規則（子命令覆寫、別名），要在轉接器裡原樣保留，不能用通用的 `extends` 重新詮釋，否則結果會變。
- 資料大小：條目與類型存在現有的使用者定義儲存裡，不新增儲存。

## 11. 分階段

1. **核心**：類型註冊表、`customize` 的 schema 驗證、`ref_define` 帶 `customize`、`ref_types`／`ref_register_type`／`ref_expand`／`ref_validate`；單元測試。
1.5. **舊種類轉接層**：把 `error_code`、`build_error_rule`、`command`、`pragma` 註冊成 `legacy` 類型（只讀轉接器），黃金測試確認匯出逐字相同、既有測試全過。
2. **類型與種子**：`visual_part`、`skeleton`、`joint`、`machine` 內建類型；人臉、頭髮、五官、動物臉的種子條目。
3. **消費端**：image-decompose-redraw 的部位偵測與局部深度（Python），工具把展開後的 `parts.json` 傳進去；離線路由。
4. **回饋**：修正→使用者條目→重新套用；RAG 檢索。
5. **（獨立）** 蒙皮動畫檢視器、`motion`／`gesture` 的播放。

## 12. 還沒決定的事

- schema 語言要不要直接相容 JSON Schema 的子集（好處是現成的工具與文件，壞處是對 `ref`／`extends` 要另外擴充）。
- 條目 key 的命名空間（全域唯一，或「類型＋key」唯一）。
- 展開結果要不要快取到使用者儲存（大型骨架可能有幾百個關節）。
- 基本動作的版本與相容性（消費端升級後舊知識是否還能用）。
