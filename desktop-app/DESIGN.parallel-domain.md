# 平行運算與排程領域（parallel-domain）

立項：2026-11-11，使用者原話：「或用一個題目是利用平行運算能力，找到程式裡面適合平行的演算法，用類似 openmp 的 block schedule 跟 cyclic schedule 來加速影像壓縮、檔案壓縮、撰寫破壞的聲音跟影像壓縮演算法」，回覆「列為新領域」。

## 1. 目前做了什麼（2026-11-11 實測）

| 元件 | 檔案 | 狀態 | 量測 |
|---|---|---|---|
| 排程原語（純函式）：static 區塊、cyclic、chunked、dynamic、guided 的索引分配、負載、metrics、推薦、分布分類 | `renderer/src/algo/par_sched_core.js` | ✔ 單元測試通過 | `par_sched_core.test.js` 4212 項斷言；劃分性（每個索引恰好一次）300 組隨機測資 |
| 領域包骨架（4 個：分配、負載、動態／引導式、推薦） | `renderer/src/uml/domain_par_core.js` | ✔ 產生的 Python 真的跑、與 JS 參考逐行相同 | `domain_par_codegen.test.js` 646／646（8＋16＋6＋8 組槽位組合 × 17 組測資，python3.13 執行） |
| 真的平行執行：OpenMP 區塊 DCT＋量化（有損影像，JPEG 亮度表），排程 static、cyclic、chunk4、dynamic4、guided | `tests/parallel/block_dct_omp.c` | ✔ 六種排程與循序版逐位元相同（雜湊、非零係數數、重建誤差） | `par-demo.test.js`（gcc 11.4，OMP_NUM_THREADS=2） |
| 真的平行執行：多行程 zlib 分塊壓縮（無損檔案壓縮），排程 block、cyclic、dynamic | `tests/parallel/chunk_zlib_mp.py` | ✔ 四種排程 SHA-256 相同、解壓還原 | `par-demo.test.js`（python3.13） |

### 1.1 實測耗時（這台 2 核心，taskset 6-7，其他工作階段同時在跑，數字只供參考）
- OpenMP，4096×4096 灰階，2 執行緒：循序 0.968 秒；static 0.501；cyclic 0.509；dynamic,4 0.504。加速約 1.9 倍。
- Python 多行程，48 MiB、256 KiB 區塊、2 行程：循序 0.328 秒；block 0.312；cyclic 0.330；dynamic 0.257。**幾乎沒有加速**。原因是 zlib 本身很快、行程與結果傳遞的開銷相對大。之前版本因為把整份資料傳給每個行程，還比循序慢，已改成只傳自己的區塊。

### 1.2 這個領域的結論（做了之後才知道的）
- 影像區塊 DCT、檔案分塊壓縮：每個區塊互不相依，任何排程都結果相同，平行化沒有相依問題；差別只在負載均衡與開銷。
- 排程選擇：區塊（static）開銷最小，但區塊的工作量不均時（例如影像邊緣、壓縮率差很多的檔案區段）會不均衡；cyclic 與 dynamic 能平衡，代價是較多的分配與快取不友善。本領域的 `par-pick` 會在一組工作量上比較四種排程的 span，但「推薦結果與實測耗時是否一致」尚未驗證。

## 2. 誠實的缺口（沒做或沒驗證的）

1. **相依分析沒有實作。** 使用者要求「找到程式裡面適合平行的迴圈（相依分析：迴圈攜帶相依、歸約、前綴和）」。目前只有排程原語，沒有能讀迴圈、判斷相依的分析器。這是最大的缺口，之後要做。
2. **種子題（train／holdout）沒有跑。** `domain_par.test.js` 用 `domain_harness.js`，需要 `~/.cache/fa-ts` 的 Python tree-sitter 文法。這台機器沒有這個文法，lockfile 也沒有，而且規定不准下載。harness 找不到文法時會印「略過」並以 0 結束，**這是假通過，不算驗證**。要在有文法的機器（例如 Windows 管理機）上跑 `FA_PYTHON=python3.13 node renderer/src/uml/domain_par.test.js`。
3. **沒有登錄到嵌入清單。** `embed-code-ui.js`、`floating-assistant.js` 的 BEGIN／END 與 `_pyDomainsInit`、`run-core-tests.js` 都還沒加 par 包。依規定，共用檔由管理者統一嵌入，這個提交不做。
4. **應用題沒有進領域包。** 領域包目前只出排程原語的題（分配、負載、動態、推薦）。「用 OpenMP 加速影像壓縮」的完整題目（給敘述，要求寫出平行 C 程式，由判題器真的執行並與循序比對）還沒有。`tests/parallel` 的程式是人工寫的示範，不是 AI 生成的。
5. **有損聲音壓縮沒做。** 使用者列的「撰寫破壞的聲音壓縮」沒有實作。可平行的部分是 MDCT 按框（frame）獨立計算，但框之間的位元配置與霍夫曼表若共用狀態就有相依，需要設計。
6. **熵編碼的平行沒做。** 霍夫曼或算術編碼的位元輸出是迴圈攜帶相依（游標位置）。標準做法是兩趟：先平行算每塊的位元長度，再做前綴和得到寫入位移，最後平行寫入。目前只示範了「每塊獨立壓縮」，沒有這個兩趟寫法。
7. **LZ77 類的壓縮沒有平行化。** 字典視窗跨區塊相依，只能切成獨立區塊（會損失壓縮率），沒有實作這個取捨的量測。
8. **OpenMP 的 `pick` 推薦與實測沒對照。** 目前只量 span（工作量模型），沒有比對實際耗時。
9. **沒有判題器實測。** 示範程式沒有經過 `judge-runner.js`；`par-demo.test.js` 直接呼叫 gcc 與 python。

## 3. 接續點（給下一次工作）
1. 在有 tree-sitter 文法的機器跑 `domain_par.test.js`，記錄 train／holdout 數字。
2. 做相依分析的骨架（迴圈攜帶相依的判斷：讀寫同一陣列且索引有位移；歸約：累加到同一變數；前綴和：`a[i] = a[i-1] + x[i]`）。
3. 有損影像的完整題目（區塊 DCT＋量化，判題要求 PSNR 下限，與循序版逐位元相同）。
4. 聲音框的 MDCT 平行與熵編碼兩趟寫法。

## 4. 規則遵守
- 沒有推送、沒有跑 publish、沒有跑 embed／build 腳本。
- 測試一次跑一個，用 `nice -n 10 taskset -c 6-7` 開頭。
- 沒有下載任何東西（沒有執行 `npm ci`，因為 pure 模組與示範都不需要 node_modules）。
