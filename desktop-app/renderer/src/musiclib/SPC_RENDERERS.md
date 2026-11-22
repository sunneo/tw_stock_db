# SPC 渲染器說明

晶片播放的 `spc` 後端（`musiclib_chip_spc.js`）只依賴一個介面：`createCore(...)` 回傳的物件（`renderStereo`、`snapshot`、`restore`）。目前有兩種渲染器可以放在這個介面後面：

| 渲染器 | 檔案 | 狀態 |
|---|---|---|
| 自寫 JS 核心（SPC700＋S-DSP） | `musiclib_spc_core.js` | 已實作、單元測試通過（`musiclib_spc_core_test.js`） |
| snes_spc（wasm） | `musiclib_spc_wasm_adapter.js` | 只有轉接層與介面；**尚未編出 .wasm**（本機沒有 emscripten 或 clang，且沒有可用的 wasm 工具鏈） |

## 自寫核心的規格來源（沒有抄任何程式碼）

- fullsnes（Martin Korth）SNES 硬體文件：SPC700 指令表與旗標、定址模式、計時器、$F0–$FF 的 I/O、S-DSP 暫存器、BRR 格式、ADSR／GAIN 速率表、音高調變、噪音、回音與 FIR。
- anomie 的 SNES 文件：指令週期與 S-DSP 取樣時序（每 32 個 SPC 時脈產生一個 32 kHz 取樣）。
- IPL 啟動程式（64 位元組）：與公開文件的反組譯一致，測試會驗證 AA／BB 握手。

## 已知近似

1. 高斯插值表用公式產生（σ = 0.6、四點、歸一化），不是硬體的 512 項逐點表。
2. BRR 範圍 13–15（非法值）輸出為近似；DAS 進位與 DIV 溢位結果為近似。
3. KON 立即生效（硬體約延遲 5 個取樣）。SPC 檔不含 DSP 內部包絡狀態：載入時 KON 位元或 ENVX > 0 的聲道會重新起音。
4. 主 CPU 的通訊埠沒有另一端：輸入埠讀回 SPC 檔內的值。
5. SLEEP／STOP 會停住 CPU，DSP 仍照常產生取樣。

## 接上 snes_spc（wasm）要做的事

1. 用 emscripten 編 snes_spc 成 `.wasm`，匯出 `load`、`render`、`snapshot`、`restore` 四個函式（介面見 `musiclib_spc_wasm_adapter.js` 檔頭）。
2. 把模組傳給 `createWasmCore(mod, spc)`；`available(mod)` 會說明缺什麼。
3. 在 `musiclib_chip_spc.js` 的 `makeStream` 把 `CORE.fromSpc(spc)` 換成 wasm 核心。後端 id 仍是 `spc`，曲庫與播放器不用改。
4. 用同一組 `musiclib_chip_spc_test.js` 比對兩種渲染器的過零數與包絡，差異寫進報告。
