#!/usr/bin/env node
// tw_stock_db客製: 2026-09-24使用者要求——floating-assistant.js（2.1MB、
// 3萬多行）原本直接當原始碼被兩邊載入：桌面版renderer/index.html用
// <script src="floating-assistant.js">本機讀檔；網頁版web/index.html在
// 執行期用fetch()從GitHub raw抓desktop-app分支的這個檔案再包成Blob URL
// 執行（見web/index.html裡"floating-assistant.js?v=..."那段）——網頁版
// 每次頁面載入都要重新下載這2MB多的未壓縮原始碼。
//
// 使用者要求「原本的floating-assistant可以放src，而renderer用來給
// desktop跟web的則是要run過compress」——這裡刻意不改網頁版index.html
// 的任何程式碼（使用者原話「為了避免網頁端的原始碼要改」）：網頁版
// fetch的URL路徑（desktop-app分支的renderer/floating-assistant.js）
// 完全不變，只是這個路徑底下committed的「內容」從此變成這支腳本壓縮
// 過的輸出，不再是手動編輯的原始碼——真正可編輯的原始碼搬去
// renderer/src/floating-assistant.js，往後修改程式碼一律改那份，改完
// 跑這支腳本（或直接`npm start`，package.json的prestart已經接好會自動
// 先跑一次）重新產生renderer/floating-assistant.js／
// renderer/floating-assistant.min.js，記得把三個檔案（src原始碼＋兩份
// 壓縮輸出）都commit，不要只commit src那份。
//
// 兩份輸出（floating-assistant.js／floating-assistant.min.js）內容完全
// 一致：.js這個檔名是維持桌面版/網頁版既有load路徑不必更動的「相容檔名」，
// .min.js是使用者要求的、名符其實的壓縮產出檔名，兩者都保留、都commit。
//
// mangle刻意維持terser預設的「只mangle區域變數/函式內部名稱，不mangle
// 頂層(top-level)名稱」（不設mangle.toplevel:true）——這個檔案用plain
// <script>（非ES module）載入，`class FloatingAssistant`這個頂層名稱要
// 維持原樣讓bootstrap.js/index.html的`new FloatingAssistant(...)`呼叫
// 得到；drop_console刻意設false——這個app大量仰賴console.log/console.error
// 做真實診斷（使用者明確要求過「要真實診斷資訊」，見local-proxy相關的
// debug log機制），壓縮後不能把這些拿掉。

const fs = require("fs");
const path = require("path");
const { minify } = require("terser");

const SRC_PATH = path.join(__dirname, "renderer", "src", "floating-assistant.js");
const OUT_PATH = path.join(__dirname, "renderer", "floating-assistant.js");
const MIN_PATH = path.join(__dirname, "renderer", "floating-assistant.min.js");

async function main() {
  if (!fs.existsSync(SRC_PATH)) {
    throw new Error(`找不到原始碼：${SRC_PATH}`);
  }
  const code = fs.readFileSync(SRC_PATH, "utf8");
  const result = await minify(code, {
    compress: {
      drop_console: false,
      drop_debugger: true,
    },
    mangle: true, // 預設不含toplevel，頂層class/const名稱維持原樣（見上方說明）
    format: {
      comments: false,
    },
  });
  if (result.error) throw result.error;
  if (!result.code) throw new Error("terser回傳空的輸出，中止寫入，避免用空檔案覆蓋既有的renderer/floating-assistant.js");

  fs.writeFileSync(MIN_PATH, result.code, "utf8");
  fs.writeFileSync(OUT_PATH, result.code, "utf8");

  const origBytes = Buffer.byteLength(code, "utf8");
  const minBytes = Buffer.byteLength(result.code, "utf8");
  const savedPct = ((1 - minBytes / origBytes) * 100).toFixed(1);
  console.log(
    `[build-assistant] ${path.relative(__dirname, SRC_PATH)} ` +
    `${(origBytes / 1024 / 1024).toFixed(2)}MB -> ` +
    `${(minBytes / 1024 / 1024).toFixed(2)}MB（省${savedPct}%），已寫入：\n` +
    `  - ${path.relative(__dirname, OUT_PATH)}\n` +
    `  - ${path.relative(__dirname, MIN_PATH)}`
  );
}

main().catch((err) => {
  console.error("[build-assistant] 壓縮失敗：", err);
  process.exit(1);
});
