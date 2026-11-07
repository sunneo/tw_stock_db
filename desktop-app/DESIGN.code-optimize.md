# 程式優化：從程式看出題型 → 優化對照表 → 換成同功能更有效率的程式

使用者要求（2026-11-08）：「從程式看出題型 → 找到優化記憶體跟效率的題型 → 轉化成優化後的題型 → 修改成功能一樣但效率更好的程式」。

## 做法（`renderer/src/recipe/code_optimize_core.js`，工具 `optimize_code`，宿主 `_codeOptimize`）
1. **認題型（慢寫法）**：每條規則的 `detect(src)` 只在「有這個慢寫法、而且換掉安全」時回參數（例：list 只被拿來 `in`／`append`／`len` 才能換 set；佇列沒被索引才能換 deque；遞迴沒有副作用才能加 lru_cache）。認不出就不動。
2. **優化對照表（RULES）**：

| id | 慢寫法 | 換成 | 時間 | 記憶體 |
|---|---|---|---|---|
| list-as-set | list 做「出現過沒」 | set | O(n²)→O(n) | 多一份雜湊表 |
| queue-popleft | `list.pop(0)` 當佇列 | deque.popleft | O(n²)→O(n) | 同階 |
| recursion-memo | 同函式遞迴 ≥2 次、無副作用 | lru_cache | 指數→多項式 | 多一張快取 |
| str-join | 迴圈 `s += …` | list＋join | CPython 常已優化，實測沒變快、記憶體反而變大 → 通常被退回 | — |
| sorted-extreme | `sorted(a)[-1]`／`[0]` | max／min | O(n log n)→O(n) | 省一份 list |
| readonly-in-set | 迴圈裡對不改的 list 做 `in` | 先 set() | O(nm)→O(n+m) | 多一份雜湊表 |
| count-counter | 迴圈裡 `a.count(x)` | Counter | O(n²)→O(n) | 多一份計數表 |
| list-append | `lst = lst + [x]` | append | O(n²)→O(n) | 不再每次複製 |
| prefix-sum | 迴圈裡 `sum(a[l:r])` | 前綴和 | O(nq)→O(n+q) | 多一個陣列 |
| insert-front | `lst.insert(0, x)` | deque.appendleft | O(n²)→O(n) | 同階 |
| listcomp-genexp | `sum／min／max／any／all([… for …])` | 產生器運算式 | 同階（any／all 可提早停） | **實測 32MB→9MB** |
| keys-in | `k in d.keys()` | `k in d` | 少一層呼叫 | 不建視圖 |

3. **驗證才收**：記憶體也量（測試端實測峰值：listcomp-genexp 32→9MB）；改完峰值變大超過 1.5 倍＋5MB 也退回——例：`str-join` 在 CPython 上實測記憶體 10→24MB、時間沒變，**被退回，不硬換**（宿主端的判題器目前只回時間，沒有峰值記憶體，所以宿主只擋變慢；測試端執行器有量記憶體）。每條改寫後，要在 tests／hidden 上輸出與目前版本相同才收；有 `perf`（一組大輸入與正確輸出）會量時間，比原本慢超過 20% 就退回。沒給測資就完全不改。
4. **誠實**：輸出一致只在給的輸入上驗證，不是等價證明（報告裡寫出驗證了幾組、有沒有量時間）；`str-join` 這類 CPython 已優化的，實測可能沒變快，如實顯示倍數。

## 測試
`code_optimize.test.js`：9 條各自「認得、輸出一致、大輸入實測（queue ×61、list-append ×105、count ×20、遞迴 ×29…）、另一組大輸入一致」；不安全寫法（list 被索引、佇列被索引、遞迴有 print）不動；沒執行器不改；改壞要退回；報告寫出驗證範圍。真 Electron：`scripts/e2e/code_optimize.e2e.mjs`（pop(0)→deque，56ms→14ms）。

## 還沒做（下一步）
- 與題型家族（骨架／範式）接起來：認出「這是 two-sum 暴力」→ 換成雜湊範式（要保持輸出順序語意，需要逐題型的等價處理）。
- 宿主端的記憶體量測（判題器 IPC 還沒回峰值記憶體）。
- 更多規則：重複計算的不變量提到迴圈外、二維 DP 滾動陣列。
- 非 Python 語言。
