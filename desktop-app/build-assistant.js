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
const crypto = require("crypto");
const { minify } = require("terser");

const SRC_PATH = path.join(__dirname, "renderer", "src", "floating-assistant.js");
const OUT_PATH = path.join(__dirname, "renderer", "floating-assistant.js");
const MIN_PATH = path.join(__dirname, "renderer", "floating-assistant.min.js");
const BOOTSTRAP_PATH = path.join(__dirname, "renderer", "bootstrap.js");
const INDEX_HTML_PATH = path.join(__dirname, "renderer", "index.html");
// tw_stock_db客製: 2026-09-26使用者要求的桌面版「檢查更新」／live update
// 功能，見main.js「Live Update」區塊的完整設計說明——這份manifest就是
// 使用者原話「本身也要預留一個manifest file代表自己當下的特性」指的那份
// 本機基準檔：每次建置時對這四個檔案（跟package.json/electron-builder
// 「files」清單裡實際會被打包、且允許被live-update覆蓋的renderer前端
// 檔案完全一致）算md5、寫成JSON，隨其餘建置產物一起commit——不是main.js
// 執行期現算，執行期只在需要「自我完整性檢查」時才對覆蓋目錄裡的檔案
// 現算md5，基準本身固定用這份建置時的快照。
const UPDATE_MANIFEST_PATH = path.join(__dirname, "renderer", "update-manifest.json");
const LIVE_PATCH_ALLOWED_FILES = [
  "renderer/index.html",
  "renderer/bootstrap.js",
  "renderer/floating-assistant.js",
  "renderer/floating-assistant.min.js",
];

async function main() {
  if (!fs.existsSync(SRC_PATH)) {
    throw new Error(`找不到原始碼：${SRC_PATH}`);
  }
  let code = fs.readFileSync(SRC_PATH, "utf8");

  // 2026-09-26使用者要求——AI功能清冊：features/ai-features.yaml是唯一維護
  // 入口，這裡先驗證（清冊格式＋跟原始碼比對有沒有寫錯/漏掉的工具與斜線
  // 指令）、重新產生features/FEATURES.md與ai-features.json，再把精簡版JSON
  // 內嵌進壓縮輸出（取代src裡的`/*__FA_AI_FEATURES__*/null`佔位符，src本身
  // 不會被改）。清冊有錯誤時直接中止建置，避免把過期/錯誤的功能說明發出去。
  const features = require("./scripts/ai-features.js");
  if (!features.check()) throw new Error("功能清冊檢查失敗，請先修正 features/ai-features.yaml（見上方錯誤）");
  const slimCatalog = features.build();
  const PLACEHOLDER = "/*__FA_AI_FEATURES__*/null";
  if (!code.includes(PLACEHOLDER)) throw new Error(`src裡找不到功能清冊佔位符 ${PLACEHOLDER}`);
  // 用function當replacement，避免JSON裡的$字元被當成replace的特殊樣式
  code = code.replace(PLACEHOLDER, () => JSON.stringify(slimCatalog));

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

  writeUpdateManifest();
}

// LIVE_PATCH_ALLOWED_FILES四個檔案裡，floating-assistant.js／
// floating-assistant.min.js是上面剛寫入的壓縮輸出（跟main.js「Live
// Update」比對用的內容完全一致）；bootstrap.js／index.html這支腳本完全
// 不會去改，直接讀目前commit在renderer/底下的原始內容算md5即可。
function writeUpdateManifest() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  const fileContents = {
    "renderer/index.html": fs.readFileSync(INDEX_HTML_PATH),
    "renderer/bootstrap.js": fs.readFileSync(BOOTSTRAP_PATH),
    "renderer/floating-assistant.js": fs.readFileSync(OUT_PATH),
    "renderer/floating-assistant.min.js": fs.readFileSync(MIN_PATH),
  };
  // files是純{相對路徑: md5 hex}的扁平字串map——刻意跟main.js
  // state.json的files欄位同一種形狀（不是{md5,...}物件），因為
  // computeEffectiveLocalManifest()會直接把這份baseline.files跟
  // state.files用物件展開語法({...baseline.files, ...state.files})
  // 疊加合併，兩邊形狀不一致的話合併結果會一部分是字串、一部分是物件，
  // 後續md5比對會整個失效。sizes另外開一個獨立map放，不混進files。
  const files = {};
  const sizes = {};
  for (const relPath of LIVE_PATCH_ALLOWED_FILES) {
    const buf = fileContents[relPath];
    files[relPath] = crypto.createHash("md5").update(buf).digest("hex");
    sizes[relPath] = buf.byteLength;
  }
  const manifest = {
    schema: 1,
    baseVersion: pkg.version,
    generatedAt: new Date().toISOString(),
    files,
    sizes,
  };
  fs.writeFileSync(UPDATE_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`[build-assistant] 已寫入 ${path.relative(__dirname, UPDATE_MANIFEST_PATH)}（live-update本機基準manifest）`);
}

main().catch((err) => {
  console.error("[build-assistant] 壓縮失敗：", err);
  process.exit(1);
});
