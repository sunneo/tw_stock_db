# 題型拆解與各層接法（2026-11-12）

使用者的要求（2026-11-12）：「請以『題型』拆解，找到怎麼接我們訓練好的演算法」；「不是無限擴張無限長出演算法！」。
本文件把題型收斂成**固定的 12 類**，每類只對應既有的層；新題先歸類，能歸入就只補範例與觸發詞，不新增演算法。

標記：【查證】＝調查時讀到的文件或程式數字；【推測】＝判斷，尚未驗證。類別名稱與編號是調查者所定【推測】；證據欄是查到的。
資料來源是唯讀調查（讀各分支的 DESIGN 與核心檔），媒體、平行、中間語言三條線只讀了索引與範圍表；中間語言的 holdout 題型清單沒有查到。

## 1. 十二類固定題型

| # | 題型類別 | 現在承接的層與資產 | 證據 |
|---|---|---|---|
| T1 | 二進位固定位移欄位讀取 | blockly 範式 `bin.field-read` | `domain_fieldcount_core.js`；holdout v3 讀欄位 15/15（由未解清單推得） |
| T2 | 位元組／標記計數 | blockly 範式 `bin.count-mark`、`bin.count-byte` | 同上；v3 計數 10/12，未解 2 題缺「出現幾次」措辭 |
| T3 | 容器／壓縮格式解碼與編碼 | blockly 領域包：inflate、lzma、tarx、png、gif、jpeg、bmpx、pcx、binfmt | `uml/domain_*_core.js`；holdout v1 0/27、v2 12/27（已被看過）、v3 25/27 |
| T4 | 媒體位元與變換 | blockly 領域包：avbits、h264dec、avimage、avaudio | avbits holdout 6/7、avimage 5/7；Huffman、算術編碼、心理聲學未做 |
| T5 | 平行排程、歸約、競爭、波前 | blockly 領域包：par、par2、par3 | par holdout 3/5、par2 2/3、par3 3/4 |
| T6 | 資料結構、圖、演算法 | blockly 領域包（ds、graph2/3、algo2、dsp）；矩陣家族 graph、grid、dfa、recurrence | 矩陣範本約 25 個 |
| T7 | OS、同步、Linux 工具文字 | blockly 領域包（os、sync、fs、linux*）；矩陣 os-cache、os-petri、os-sched | 同上 |
| T8 | 多語言轉換 | 中間語言層（不是題型範式） | 手寫樣本非原生區塊佔比 c 0%、C# 8%、Ruby 0%、Perl 18%、nodejs 6% |
| T9 | 拆題、工具呼叫、選單、規劃 | LoRA 四顆：decompose、toolcall、colu、plan | `lora_route_core.js` 的 `taskDomain` 只認這四個 |
| T10 | 矩陣可表達的計算 | 矩陣家族與矩陣 VM（計數器、堆疊、佇列、陣列） | 矩陣 §13.6 |
| T11 | 其他讀不懂、有範例的題 | 都沒有；`routeOf` 目前送 LoRA | 未解題矩陣覆蓋 0/21 |
| T12 | 動態霍夫曼、Petri、JPEG 熵編碼、range coder | 矩陣 `FaMatrixSynth` 無範本 | 矩陣文件未做項 |

可合併的重複【推測】：T1＋T2 是同一類「原始位元組上的固定規則」；T3＋T4 都是「格式解析與編碼」；T6＋T7 與矩陣家族 graph、grid、os-* 重疊，三處各一套範本；T5 的 `par.sched-*` 與 `domain_par_core` 重複，同題在多個包都能觸發。

## 2. 未覆蓋題型：歸入既有類別，或標「不做」

讀得懂、沒有範式（只補範例與觸發詞，不開新演算法）：
- T1／T2 措辭變體：「標記在這裡出現幾次」（如 `v3-tar-ustar2`、`v3-gif-gce2`）→ 既有 `bin.count-mark` 補觸發詞；驗證用新的 holdout v4，一次性量測，不改 v3。
- T1 與解碼題衝突：`png-depth`、`gif-w` 被 `bin.field-read` 搶走 → veto 詞或排序規則；驗證要全部領域包 train 與反序零回歸。
- 計數的「成員數」型 → 歸 T2，擴為 `bin.count-*` 的槽位。
- par 措辭缺口（`ho-load-block`、`ho-dyn-chunks`、`ho-frame-dyn`、`ho-pack-bits`）→ 既有 par 骨架補觸發詞。

讀不懂：
- 矩陣整題混用沒解的 13 題（Floyd、匹配、分配、第 k 短、同步偵測、tar 列表、環境變數預設值、cut 半形）→ 歸 T6／T7，由 Claude 補 4 至 5 個範例教 blockly；教不會的標「不做」。驗證：隱藏測資獨立判 AC，且非多候選。
- T12（動態霍夫曼、Petri、JPEG 熵、range）→ 標「暫不做」。沒有 holdout；先寫至少 10 題 holdout，量到大於 0 再說。
- 心理聲學、Huffman／算術編碼（媒體）→ 標「不做」。文件自己列為未做。
- 完整 LZMA、FGK → 標「不做」。

## 3. 路由規則（只在 12 類上接既有的層）

已存在的接點【查證】：`routeOf`（`matrix_spec_core.js`）、`tryMatrix`（`matrix_hybrid_core.js`，blockly 整條失敗後以可見測資合成，隱藏測資判 AC 才採用）、`routeTurn`（`lora_route_core.js`）、teach_queue 失敗路徑寫入。

1. 先用題型判斷（T1 至 T12 的觸發詞）；命中 blockly 領域包就走 blockly（已存在）。
2. blockly 失敗：只有 T6、T7、T10 才試矩陣；矩陣覆蓋 0/21，其他類別一律不試（已存在）。
3. 矩陣沒有通過：屬於 T9 就走對應的 LoRA；否則回基底（已存在）。
4. 都失敗：寫入 teach_queue，欄位為題型類別（T 編號）、代表題、需要補的範例數、驗證方式。**待做**：類別欄位與「歸入既有類別」判斷；目前 `routeOf` 沒有 T 編號。
5. **待做**：把 `taskDomain` 的任務類型與 blockly 觸發詞對齊成同一份 T 表；目前各層各有一套【推測】。

## 4. 停止新增演算法的收斂條件【推測，建議】

- 新題先過 T1 至 T12 歸類；能歸入就只補範例與觸發詞，不加範式。
- 只有同一個 T 類連續兩個乾淨 holdout 低於門檻，才允許新增一個範式；新增後該類總範式數不得超過 3。
- 乾淨 holdout 連續兩批在 T1 至 T10 都達 90% 以上，就凍結演算法層，只收範例。
- 每次調整觸發詞後，之前量過的 holdout 一律標為「已被看過」。
- 範圍外的擴充（例如媒體編解碼在熵編碼之後的擴充）不再新增；已列「不做」的項目要有明確原因。
