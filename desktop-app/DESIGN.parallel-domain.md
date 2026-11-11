# 平行運算與排程領域（parallel-domain）

立項：2026-11-11，使用者原話：「或用一個題目是利用平行運算能力，找到程式裡面適合平行的演算法，用類似 openmp 的 block schedule 跟 cyclic schedule 來加速影像壓縮、檔案壓縮、撰寫破壞的聲音跟影像壓縮演算法」，回覆「列為新領域」。

## 1. 目前做了什麼（2026-11-11 實測）

| 元件 | 檔案 | 狀態 | 量測 |
|---|---|---|---|
| 排程原語（純函式）：static 區塊、cyclic、chunked、dynamic、guided 的索引分配、負載、metrics、推薦、分布分類 | `renderer/src/algo/par_sched_core.js` | ✔ 單元測試通過 | `par_sched_core.test.js` 4212 項斷言；劃分性（每個索引恰好一次）300 組隨機測資 |
| 領域包 par：排程原語 4 個骨架（分配、負載、動態／引導式、推薦） | `renderer/src/uml/domain_par_core.js` | ✔ 種子題真跑：train 22/22、反序 22/22；holdout 3/5 | `domain_par.test.js`；程式產生器與 JS 參考逐行相同 646／646（`domain_par_codegen.test.js`） |
| 領域包 par2：兩趟前綴和／位元位移（`par.scan2`）、框式量化 block／cyclic／dynamic（`par.frame`）、攜帶相依的波前（`par.wave`） | `renderer/src/uml/domain_par2_core.js` | ✔ 種子題真跑：train 12/12、反序 12/12；holdout 2/3 | `domain_par2.test.js` |
| 真的平行執行：OpenMP 區塊 DCT＋量化（有損影像，JPEG 亮度表），排程 static、cyclic、chunk4、dynamic4、guided | `tests/parallel/block_dct_omp.c` | ✔ 六種排程與循序版逐位元相同（雜湊、非零係數數、重建誤差） | `par-demo.test.js`（gcc 11.4，OMP_NUM_THREADS=2） |
| 真的平行執行：多行程 zlib 分塊壓縮（無損檔案壓縮），排程 block、cyclic、dynamic | `tests/parallel/chunk_zlib_mp.py` | ✔ 四種排程 SHA-256 相同、解壓還原 | `par-demo.test.js`（python3.13） |

### 1.1 實測耗時（這台 2 核心，taskset 6-7，其他工作階段同時在跑，數字只供參考）
- OpenMP，4096×4096 灰階，2 執行緒：循序 0.968 秒；static 0.501；cyclic 0.509；dynamic,4 0.504。加速約 1.9 倍。
- Python 多行程，48 MiB、256 KiB 區塊、2 行程：循序 0.328 秒；block 0.312；cyclic 0.330；dynamic 0.257。**幾乎沒有加速**。原因是 zlib 本身很快、行程與結果傳遞的開銷相對大。之前版本因為把整份資料傳給每個行程，還比循序慢，已改成只傳自己的區塊。

### 1.2 這個領域的結論（做了之後才知道的）
- 影像區塊 DCT、檔案分塊壓縮：每個區塊互不相依，任何排程都結果相同，平行化沒有相依問題；差別只在負載均衡與開銷。
- 排程選擇：區塊（static）開銷最小，但區塊的工作量不均時（例如影像邊緣、壓縮率差很多的檔案區段）會不均衡；cyclic 與 dynamic 能平衡，代價是較多的分配與快取不友善。本領域的 `par-pick` 會在一組工作量上比較四種排程的 span，但「推薦結果與實測耗時是否一致」尚未驗證。

## 2. 種子題（判題器真跑；harness 找不到文法會失敗，不再假通過）

文法：`renderer/vendor/tree-sitter/tree-sitter-python.wasm`（git 追蹤）。harness 的文法目錄順序：`FA_TS_DIR`、`~/.cache/fa-ts`（若有）、vendor。
每題：原敘述＋改寫（變數名換掉）＋選項反序；train 題必須全過，holdout 題只量測。骨架的槽位由沙盒窮舉，讀取器只負責選骨架。

| 檔案 | train（原敘述／改寫，各 1 題×2 措辭） | 反序 | holdout | 未解 holdout 與原因 |
|---|---|---|---|---|
| `domain_par.test.js` | 22/22（11 題） | 22/22 | 3/5 | `ho-load-block`（「各執行緒的總耗時」，讀不出配方）、`ho-dyn-chunks`（「領取了幾塊」，讀不出配方） |
| `domain_par2.test.js` | 12/12（6 題） | 12/12 | 2/3 | `ho-frame-dyn`：「取樣值」在讀取器被當成小數（`FLOAT_WORDS` 含「取樣值」），輸出多出 `.0`；train 題改寫為「整數取樣值」才過。這是讀取器的真缺口，不是骨架問題 |

本輪的修正（誠實記錄）：
- `domain_par_core.js` 的觸發詞放寬到 train 題的措辭（「比較…排程」「最忙…負載最小」「每個執行緒…負載」「span」）。holdout 題沒有為它調整。
- `domain_par2_core.js` 的 `par.frame` 原本 train 題寫「取樣值」，被讀成小數而全部失敗；改成「整數取樣值」屬於措辭修正，讀取器本身沒改。

## 3. 真的平行執行（gcc -fopenmp、多行程）

| 程式 | 內容 | 結果 |
|---|---|---|
| `tests/parallel/block_dct_omp.c` | 有損影像：8×8 DCT＋JPEG 亮度量化，OpenMP 的 static、cyclic、chunk4、dynamic4、guided | 五種排程與循序版逐位元相同（雜湊、非零係數數、重建誤差） |
| `tests/parallel/chunk_zlib_mp.py` | 無損檔案：分塊 zlib，多行程的 block、cyclic、dynamic | 三種排程的 SHA-256 與循序版相同，且能解壓還原 |
| `tests/parallel/par-demo.test.js` | 上面兩個的對照 | 8 組通過 |

實測耗時（2 核心，taskset 6-7，其他工作階段同時在跑，只供參考）：
- OpenMP，4096×4096，2 執行緒：循序 0.968 秒；static 0.501；cyclic 0.509；dynamic,4 0.504。加速約 1.9 倍。
- Python 多行程，48 MiB、256 KiB 區塊、2 行程：循序 0.328 秒；block 0.312；cyclic 0.330；dynamic 0.257。**幾乎沒有加速**。原因是 zlib 很快、行程與結果傳遞的開銷相對大。

## 4. 誠實的缺口

1. **相依分析只做了攜帶相依的距離型（`par.wave`）。** 歸約（累加到同一變數的平行化）沒有骨架；讀取迴圈本身（從一段程式碼判斷相依）沒有做，目前是題目直接給出距離 d。
2. **「有損聲音」沒有做。** 框式量化（`par.frame`）是通用的取樣量化，不是 MDCT／心理聲學。聲音的 MDCT 按框獨立計算、位元配置與霍夫曼表共用狀態的相依，還沒設計。
3. **有損影像的完整題沒有進領域包。** DCT 的平行版只在 C 示範裡（`block_dct_omp.c`），沒有由判題器執行的種子題。
4. **熵編碼兩趟只有位元位移（`par.scan2` 的 `excl`）。** 真正的位元打包（寫入位元、寫出位元流）沒有做。
5. **讀取器的缺口：** 「取樣值」「像素值」等詞被當成小數（`FLOAT_WORDS`），`ho-frame-dyn` 因此失敗；「各執行緒的總耗時」「領取了幾塊」讀不出配方（`ho-load-block`、`ho-dyn-chunks`）。
6. **沒有登錄到嵌入清單。** 共用檔由管理者統一處理（見下方登錄清單）。
7. **Python 多行程沒有加速**（見第 3 節）；判題器不跑 OpenMP，示範程式直接用 gcc 與 python 執行。

## 5. 登錄清單（管理者統一處理，本提交不改共用檔）

- `scripts/embed-code-ui.js`：加入 `renderer/src/uml/domain_par_core.js`、`renderer/src/uml/domain_par2_core.js`
- `renderer/src/floating-assistant.js`：PAR／PAR2 的 BEGIN／END 標記與 `_pyDomainsInit` 清單
- `scripts/run-core-tests.js`：`renderer/src/uml/domain_par.test.js`、`renderer/src/uml/domain_par2.test.js`、`renderer/src/algo/par_sched_core.test.js`、`renderer/src/uml/domain_par_codegen.test.js`；`tests/parallel/par-demo.test.js`（需 gcc 與 python3）
- `renderer/src/algo/par_sched_core.js` 目前只被測試使用；是否要嵌入，由管理者決定。

## 6. 規則遵守
- 沒有推送、沒有跑 publish、沒有跑 embed／build 腳本。
- 測試一次跑一個，用 `nice -n 10 taskset -c 6-7` 開頭。
- 沒有下載任何東西（沒有執行 `npm ci`）。
