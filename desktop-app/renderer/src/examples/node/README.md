# Node 範例（run terminal 預設資料夾 `/work/examples/node/`）

    cd examples/node/game
    node snake.js

`node 檔.js` 在沙盒 iframe 裡跑（沒有檔案系統、沒有網路），程式碼外面包了 `async function`，所以頂層可以直接 `await`。可用的全域物件：

- `console.log／error`
- `gui`：`gui.open(標題, 寬)` → 視窗，有 `label／button／entry／row／column／table／editor／canvas`、`wait(秒)`、`draw(canvas, ops)`、`set(節點, props)`、`poll()`、`close()`。canvas 的事件 `frame`（fps>0）、`key`、`mouse`、`wheel`；每幀最多 200 道繪圖指令。
- `swap`：**IndexedDB 當交換區**。`swap.array(長度, 'f32'|'f64'|'i32'|'u32'|'u8'|'i16'|'u16'|'i8')` 是任意長度的型別陣列，分頁存放：記憶體只留最近用的頁（`swap.hotMB(n)`，預設 16 MB），其餘在 IndexedDB。全部非同步：`await a.set(起點, 型別陣列)`、`await a.get(起點, 個數)`、`await a.map((區塊, 起點) => …)`、`a.fill(v)`、`a.free()`、`await swap.stats()`。沒寫過的頁讀出來是 0；程式結束（或被 Ctrl+C 殺掉）頁面一律丟掉。

| 資料夾 | 內容 |
|---|---|
| `gui/swap_demo.js` | 視窗輸入陣列大小與熱區，逐塊寫入、求和、顯示 swap 讀寫次數 |
| `game/snake.js` | 貪食蛇（canvas＋鍵盤） |
| `game/life_swap.js` | 1024×1024 生命遊戲，棋盤放在 swap（熱區 1 MB），畫面顯示 64×40 視窗 |

GPGPU：沙盒 iframe 裡的 WebGPU 沒有驗證過，所以 node 這邊沒有 GPGPU 範例；要 GPU 請用 `examples/python/gpgpu/`。
