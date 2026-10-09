# 第三方元件與授權說明

這個專案的原始碼採用 [MIT License](LICENSE)：可以下載、修改、再發布（包含商業用途），只要保留著作權聲明與授權全文。

MIT 只涵蓋**這個專案自己的原始碼與文件**。以下元件不是由本專案撰寫，各自保有自己的授權；再發布時請一併遵守。授權資訊是整理時的了解，**一律以各專案官方聲明為準**。

## 隨原始碼一起放在這個儲存庫裡的

| 內容 | 位置 | 授權 |
|---|---|---|
| wasi-sh 的檔案系統契約測試（`fs-conformance.mjs`，只改了一行匯入） | `renderer/src/terminal/vendor/wasi-sh-fs-conformance.mjs` | ISC License，Copyright (c) 2025, Alexandre Gomes Gaigalas |

## 建置與封裝時用到的（開發相依）

| 元件 | 授權 |
|---|---|
| Electron（桌面版的執行環境；安裝檔會附上 Chromium 等元件的授權清單） | MIT（Chromium 等內含元件各有授權） |
| electron-builder | MIT |
| terser | BSD-2-Clause |

## 執行時才從網路載入的（不在這個儲存庫裡，也不隨原始碼散布）

網頁版與桌面版會在需要時從公開的內容傳遞網路或 GitHub 載入下列函式庫與模型。它們不是本專案的一部分；如果你自己把它們打包進發行檔，就要附上它們各自的授權全文。

| 元件 | 用途 | 授權（整理時的了解） |
|---|---|---|
| pptxgenjs、pdfmake、pdf-lib、marked、KaTeX、xterm.js、mermaid、js-yaml、three.js、mp4-muxer | 匯出、顯示、終端機、圖表、3D、影片封裝 | MIT |
| JSZip | 壓縮 | MIT 或 GPL-3.0（擇一） |
| DOMPurify | 內容淨化 | Apache-2.0 或 MPL-2.0（擇一） |
| Mediabunny | 影音封裝 | MPL-2.0 |
| sqlite-wasm（SQLite） | 網頁版資料庫 | Apache-2.0（SQLite 本身為公共領域） |
| web-tree-sitter | 程式碼語法樹 | MIT |
| wasi-sh、busybox（wasm 版） | 終端機的 shell 與指令 | wasi-sh 為 ISC；busybox 為 GPL-2.0 |
| yt-dlp | YouTube 下載 | Unlicense |
| kokoro-js、Kokoro-82M 模型 | 本機英文語音 | Apache-2.0 |
| transformers.js、Florence-2／SmolVLM／LLaVA 等離線模型 | 離線圖像與文字模型 | transformers.js 為 Apache-2.0；各模型授權不同，下載前請看模型頁面 |
| Whisper 模型 | 語音轉文字 | MIT |

## 範例與資料

- 台股行情資料（儲存庫其他資料夾裡的每日資料，來自 Yahoo Finance、證交所等來源）**不在 MIT 授權範圍內**，使用請遵守原始來源的條款。
- 簡報功能的預設樣板沒有附任何品牌圖片或標誌。
