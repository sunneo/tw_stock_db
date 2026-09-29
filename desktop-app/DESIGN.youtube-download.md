# YouTube 下載（瀏覽器端跑 yt-dlp）— 設計與跟版指引

這份文件回答一件事：**上游 yt-dlp 改版時，我們要看哪裡、改哪條管線。**
功能本身是「在瀏覽器裡用 Pyodide 跑真正的 yt-dlp」，不是把 yt-dlp 改寫成 JavaScript——這樣上游修了什麼，我們升版就拿到，不用自己追。代價是：yt-dlp 假設自己跑在有 socket、有子程序的電腦上，瀏覽器沒有，所以我們在中間搭了幾座「橋」。**橋就是跟上游耦合的地方，也是升版時會壞的地方。**

## 1. 管線總覽

```
使用者 /media-youtube-download <連結>
   │
   ▼
_youtubeDownloadBatch ──► _youtubeDownloadOne（Python 在 Pyodide 裡跑 yt-dlp）
                               │
      ┌────────────────────────┼─────────────────────────────┐
      ▼                        ▼                             ▼
 [HTTP橋接]              [subprocess墊片]             [JS簽章橋接]
 yt-dlp 發請求 →          yt-dlp 想呼叫外部程式 →         yt-dlp 想叫 deno 解簽章 →
 JS fetch()               我們的墊片回應                  我們用 meriyah/astring 在瀏覽器裡解
 (proxy 或擴充功能)
                               │
                               ▼
                    [格式選擇] yt-dlp 依 FA_YTDLP_CONTRACT.formatSelector 選格式
                               │
                               ▼
        _downloadBinaryWithProgress（range 分段下載）→ _remuxVideoAudio（影音合併）
```

## 2. 版本釘住

- 釘住的版本寫在 `FA_YTDLP_CONTRACT.version`（`renderer/src/floating-assistant.js`），安裝時用 `micropip.install('yt-dlp==<版本>')`，**不會**自動跟上游最新版。
- 為什麼釘：不釘的話，上游一改我們就在使用者面前悄悄壞掉，而且不知道是哪一天、哪條管線壞的。
- 試用新版本（不改程式碼）：在 app 執行 `/media-youtube-selfcheck <版本>`（寫入 `localStorage.fa_ytdlp_version_override`），重新整理頁面後生效；`/media-youtube-selfcheck reset` 清除。
- 同一個常數物件還集中放了「橋接與上游耦合的其他細節」：`meriyah` / `astring` 版本、`formatSelector`、`jscStdinRegex`。橋接程式碼和自檢都讀它，不會兩邊各寫一份而不一致。

## 3. 契約自檢

`PYODIDE_YTDLP_CONTRACT_SRC` 是一段 Python，用 yt-dlp 自己的 API 逐條檢查「我們依賴的上游細節是否還成立」，不需要網路。
- **在 app 裡**：yt-dlp 載入完成後背景自動跑一次（失敗只印 `console.warn`，不擋下載）；`/media-youtube-selfcheck` 可隨時手動跑並顯示結果；下載失敗的錯誤訊息會附上「自檢有 N 項失敗」的提示。
- **在本機（升版前預跑）**：`node scripts/yt-dlp-contract-precheck.js [版本]`——下載該版本 wheel、解開、跑同一份自檢，幾秒鐘知道升到那個版本會壞什麼。需要本機有 python + pip。
- 已用「人為破壞」驗證過：把 `Popen.communicate_or_kill` 改名、meriyah 升大版、stdin 範本改尾巴，自檢都會指到正確的管線。

## 4. 耦合點與改寫指引（自檢項目 → 管線 → 要改哪裡）

| 自檢項目 | 管線 | 我們的程式碼 | 上游對應位置 | 壞掉時怎麼辦 |
|---|---|---|---|---|
| A1 版本 | — | `FA_YTDLP_CONTRACT.version` | — | 只是提醒：目前不是釘住的版本（試用中） |
| B1 networking 公開 API | HTTP 橋接 | `PYODIDE_YTDLP_BRIDGE_SRC`（`@register_rh` 的 `FaYtFetchRH`） | `yt_dlp/networking/common.py`（`RequestHandler`、`Response`、`Features`） | 改 `FaYtFetchRH` 的方法簽章／`_send`／`_check_extensions` 去對齊新 API |
| B2 fafetch 已註冊 | HTTP 橋接 | 同上＋`_ensureYtDlpLoaded` | 上游 request director 的註冊機制 | 只能在瀏覽器跑；失敗代表橋接根本沒生效，yt-dlp 會退回沒有網路能力的 urllib |
| C1 `utils.Popen` 介面 | subprocess 墊片 | `PYODIDE_SUBPROCESS_SHIM_SRC`（`_FaPopen`） | `yt_dlp/utils/_utils.py` 的 `Popen` | 補齊缺少的方法（`communicate_or_kill`、`kill`、`__enter__/__exit__`…） |
| C2 deno 偵測 | subprocess 墊片＋JS 橋接 | `PYODIDE_YTDLP_JSC_BRIDGE_SRC` 的 `--version` 假回應 `_FA_JSC_VERSION_OUTPUT` | `yt_dlp/utils/_jsruntime.py`（`DenoJsRuntime`：`^deno (\S+)`、`MIN_SUPPORTED_VERSION`） | 更新假版本字串（要高於最低版本）；只能在瀏覽器跑 |
| D1 vendor 腳本可讀 | JS 簽章橋接 | `_buildYtDlpJscFn` | `yt_dlp/extractor/youtube/jsc/_builtin/vendor/`（`load_script`、`VERSION`） | 找新的路徑／檔名，改 `_buildYtDlpJscFn` 讀 core 腳本的位置 |
| D2 core 開頭 `var jsc =` | JS 簽章橋接 | `_buildYtDlpJscFn`（`new Function(... + 'return jsc;')`） | `vendor/yt.solver.core.js` | core 改成別的匯出形式：改 `_buildYtDlpJscFn` 取得 `jsc` 的方式 |
| D3 meriyah/astring 版本 | JS 簽章橋接 | `FA_YTDLP_CONTRACT.meriyah` / `.astring`、`_ensureYtDlpJscLibsLoaded` | `vendor/yt.solver.deno.lib.js` 裡的 `npm:meriyah@x.y.z` | 改 `FA_YTDLP_CONTRACT` 兩個版本號，確認 jsDelivr 的 `+esm` 版本可用 |
| D4 stdin 範本 | JS 簽章橋接 | `FA_YTDLP_CONTRACT.jscStdinRegex`、shim 的 `_fa_extract_jsc_request` | `jsc/_builtin/ejs.py` 的 `_construct_stdin` | 範本結尾變了：改 `jscStdinRegex`（目前結尾是 `jsc({...})));`，**三個**右括號） |
| D5 npm 快取探測 | JS 簽章橋接 | shim 對「非 jsc 請求的 deno 呼叫」回 exit 0 | `jsc/_builtin/deno.py` 的 `_npm_packages_cached`（把 lib 腳本當 stdin 丟給 deno） | 探測方式變了：確認墊片仍對它回成功且 stderr 為空 |
| D6 最低 deno 版本 | JS 簽章橋接 | `_FA_JSC_VERSION_OUTPUT`（宣稱 deno 2.3.0） | `DenoJsRuntime.MIN_SUPPORTED_VERSION` | 假版本要不低於最低版本 |
| D7 EJS 基底類別 | JS 簽章橋接 | 整個 JS 簽章橋接的攔截假設 | `jsc/_builtin/ejs.py` 的 `EJSBaseJCP` | 介面被重構：重新讀 EJS 流程，重畫攔截點 |
| D8 `js_runtimes` 參數 | JS 簽章橋接 | `_youtubeDownloadOne` 的 `ydl_opts` | `YoutubeDL._js_runtimes` | 參數改名：更新 `ydl_opts` |
| D9 core+meriyah/astring 可執行 | JS 簽章橋接 | `_ensureYtDlpJscLibsLoaded`、`_buildYtDlpJscFn` | jsDelivr 的 meriyah/astring ESM | CDN 或打包方式變了：換來源；只能在瀏覽器跑 |
| E1–E3 格式選擇與結果 | 格式選擇／解析 | `FA_YTDLP_CONTRACT.formatSelector`、`_youtubeDownloadOne` 讀 `requested_formats` | `YoutubeDL.build_format_selector`、`process_video_result` | 選擇器語法或結果欄位變了：改 `formatSelector` 與 `_youtubeDownloadOne` 解析 `parts` 的地方 |
| F1 extractor-args 鍵名 | extractor-args | `_youtubeDownloadOne` 組 `extractor_args`（目前只有 PO Token 會用到） | `yt_dlp/extractor/youtube/` 裡的 `player_client`、`po_token` | 鍵名改了：更新 `extractor_args` |
| G1 logger 介面 | logger | `_youtubeDownloadOne` 的 `_FaYtDlpLogger`（verbose 輸出靠它） | `YoutubeDL.write_debug` | 補齊 logger 方法 |

## 5. 升版標準流程

1. `node scripts/yt-dlp-contract-precheck.js <新版本>`：本機預跑，看哪些項目 ❌。
2. 全部 ✅：直接第 4 步。有 ❌：照上表改對應管線（改完再跑一次預跑，直到全 ✅）。
3. 在 app 執行 `/media-youtube-selfcheck <新版本>` → 重新整理 → `/media-youtube-selfcheck`，確認瀏覽器才能跑的 B2、C2、D9 也通過。
4. 用 `/media-youtube-download-verbose` 實際下載一支影片（建議挑有分開影音格式的），確認完整流程：解析 → 下載 → 合併 → 交付。
5. 把 `FA_YTDLP_CONTRACT.version`（必要時連 `meriyah` / `astring`）改成新版本，更新本文件第 4 節有變動的列，重新 build、commit、推送。
6. 網頁版載入的是「釘住 commit SHA」的網址，發版時記得更新 `web/index.html` 與 `web/aiweb/index.html` 裡的完整 SHA（見 `web/` 檔案內說明）。

## 6. 不在契約內、但同樣會影響下載的外部依賴

- **Cloudflare Worker `/proxy/`**（`tw_stock_db_code/code/cloudflare-worker/worker.js`）：必須放行 POST 並轉發標頭與 body（YouTube 的 player API 是 POST）。網頁版走這條路時，出口 IP 是資料中心 IP。
- **瀏覽器擴充功能 v1.1.0 的 `http_fetch`**：讓網頁版的 YouTube 請求改走使用者自己的網路（限 YouTube 相關網域、不帶 cookie），沒安裝就退回 proxy。
- **Pyodide、micropip 與 jsDelivr CDN**：Python 環境、yt-dlp wheel、meriyah/astring 都從 CDN 來。
- **Mediabunny**：影音合併（不重新編碼）。

## 7. 歷史踩雷（給之後維護的人）

- **POST body 被轉成 `"b'{...}'"` 字串**：Python `bytes` 直接傳給 JS 函式，Pyodide 不會轉成 `Uint8Array`，`fetch()` 會呼叫 `toString()`。所有 POST 都壞，症狀卻像「YouTube 要求登入」。修法：Python 端 `to_js`＋JS 端 `PyProxy.toJs()` 雙保險。教訓：先看 YouTube 回的錯誤訊息原文，別急著假設是反機器人。
- **JS 簽章請求的正規表示式少一個右括號**：`jsc({...})));` 有三個右括號，我們寫兩個，比對從來沒成功。契約自檢 D4 抓出來的。
- **npm 快取探測**：yt-dlp 會先用 lib 腳本當 stdin 呼叫一次 deno 確認能用，這次不是解謎請求。墊片必須回 exit 0 且不輸出到 stderr，否則整個 deno 提供者被判定不可用，簽章／n 參數都解不出來。
- **單一連線整檔下載被限速**（約 60 KB/s）：改用 `range=` 分 10 MB 一段（網址參數），跟 yt-dlp 自己的做法一致。
- **進度畫面看起來卡住**：不只是節流沒補畫；同步的重 CPU 工作會擋住重繪，所以階段切換要強制重繪並讓出畫面一次。
- **網頁版載到舊版**：`raw.githubusercontent.com` 對分支網址有 CDN 快取，`?v=` 擋不住，改用完整 commit SHA 釘住網址。
- **PO Token / BotGuard**：程式碼仍會在每次下載時先嘗試產生（`_youtubeGeneratePoToken`，畫面上的「產生 PO Token 中」），目前結果是 integrity token 為空、拿不到完整 token；但下載**不依賴它**——在使用者網路或經 proxy 時，visionos 等 client 都能直接取得格式。`extractor_args` 的 `po_token` 鍵名仍在自檢 F1 追蹤。之後若要移除或維護這段，先確認上游對這個機制的方向再動。
