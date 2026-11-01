# 設計：floating-assistant.js 延遲載入（量測與基準，2026-11-01）

由 `node scripts/size-report.js` 產生（再跑一次即可更新）。

## 改前基準
- 原始碼 `renderer/src/floating-assistant.js`：12290K 字元；嵌入區塊 155 個共 7839K（63.8%）；核心（非嵌入）4451K。
- 壓縮後 `renderer/floating-assistant.min.js`：9610K；用 gzip 傳輸約 3080K；`bootstrap.js` 197K。
- 單純編譯（V8 解析，不含執行）約 300 毫秒（node，三次量測 296–313）。實際執行頂層程式的時間之後在內建瀏覽器補量。

## 分類（誰會用到）
- 純資料，第一次用才需要：`FA_BEHAVIOR_DATA` 968K、`FA_DECK_SRC` 783K、`FA_REF_DATA` 345K、`FA_EXPORT_SRC` 200K、`FA_PYBRIDGE_FILES` 139K、`FA_IDR_SKILL_FILES` 86K、各種 `*_HTML`、`FA_IMG3D_WORKER_SRC` 65K。
- 功能模組，只有斜線指令、編輯器或面板才用：GAME 468K、VIDEOEDIT 295K、REMOTE 287K、EDITHOST 216K、DECKHOST 169K、KIHOST 109K、ED3D 86K、其餘。
- 核心非嵌入的 4451K 仍然很大，要在第二階段另外盤點（聊天主程式與零碎工具）。

總字元 12290K；嵌入區塊 155 個共 7839K（63.8%）；核心（非嵌入）4451K

## 嵌入區塊（前 40）
| 區塊 | 大小 | 行 |
|---|---|---|
| BEHAVIOR | 968K | 4977 |
| DECKSRC | 782K | 50846 |
| GAME | 468K | 35738 |
| REF | 417K | 6152 |
| VIDEOEDIT | 295K | 38976 |
| REMOTE | 287K | 48095 |
| EDITHOST | 216K | 34027 |
| EXPSRC | 200K | 42161 |
| DECKHOST | 169K | 50849 |
| BEH2 | 145K | 4980 |
| PYBRIDGE | 139K | 4475 |
| KIHOST | 109K | 52250 |
| ED3D | 86K | 32973 |
| IDRSKILL | 86K | 4478 |
| CODEUI | 81K | 4472 |
| LLVM | 73K | 15878 |
| WKS | 72K | 16796 |
| DECKEDIT | 67K | 38142 |
| COMPUTER | 67K | 41381 |
| IMG3DWORKER | 65K | 32854 |
| IMG3D | 65K | 31979 |
| UML | 62K | 8999 |
| KUI | 58K | 20140 |
| DESIGN | 58K | 10162 |
| CI | 56K | 24235 |
| DOCGEN | 54K | 18766 |
| EDDOCX | 53K | 29065 |
| EDSHELL | 51K | 26494 |
| DQ | 49K | 15428 |
| EDSHEET | 48K | 28551 |
| AIDOCVIEW | 47K | 4481 |
| NLU | 47K | 23009 |
| ED3DUI | 46K | 33703 |
| GRAM | 46K | 11450 |
| VLM | 45K | 7188 |
| IMGPROC | 44K | 25409 |
| EDTEXT | 41K | 27967 |
| DATACORE | 40K | 21458 |
| SQLWE | 40K | 42387 |
| SQLBU | 40K | 23975 |

## 大型資料常數（前 25）
| 常數 | 大小 |
|---|---|
| FA_BEHAVIOR_DATA | 968K |
| FA_DECK_SRC | 783K |
| FA_REF_DATA | 345K |
| FA_EXPORT_SRC | 200K |
| FA_PYBRIDGE_FILES | 139K |
| FA_IDR_SKILL_FILES | 86K |
| FA_CODEUI_HTML | 81K |
| FA_IMG3D_WORKER_SRC | 65K |
| FA_AIDOC_VIEWER_HTML | 48K |
| FA_REPOWIKI_HTML | 37K |
| FA_PROG_KNOWLEDGE | 36K |
| FA_PY_RUN_POSTLUDE | 33K |
| FA_UMLVIEW_HTML | 26K |
| FA_CODE_VERB_ZH | 23K |
| FA_CATALOG_EXTRACT_PY | 20K |
| FA_OT_TERMINAL | 20K |
| FA_MOSS_WORKER_SRC | 20K |
| FA_PDF_MISSING_PUNCT | 18K |
| FA_ASSET_URLS | 16K |
| FA_PROGRAMMING_PLAYBOOKS | 14K |
| FA_VFR_OPENERS | 14K |
| FA_TASK_TOOL_HINTS | 11K |
| FA_CATALOG_EVAL_SET_JSON | 10K |
| FA_CATALOG_INTENTS_JSON | 7K |
| FA_PRESET_MODEL_STATE | 7K |

## 網頁版延遲載入的做法與驗證（2026-11-01）
- 桌面版繼續用整份 `renderer/floating-assistant.js`：舊版已安裝的主程式熱更新白名單是寫死的，新增的分檔到不了舊版，所以桌面版不拆、也不需要把區塊檔放進熱更新清單。
- 網頁版改載入 `web-lazy/core.js`（核心）＋ `web-lazy/chunks/*.js`（120 個區塊，第一次碰到才用同步請求載入，或由 `FaLazy.ensure` 預先非同步載入）。網址跟核心一樣釘在同一個完整提交 SHA；`web/index.html` 與 `web/aiweb/index.html` 都在載入核心前設定 `window.__FA_LAZY_BASE`。
- `scripts/web-lazy-check.js` 檢查區塊檔與 manifest 一致，`--remote <SHA>` 逐檔驗證遠端回應 200 與檢查碼；`scripts/publish.sh` 已接上。
- 本機驗證（內建瀏覽器，真正網頁版複本與 aiweb 複本）：開頁主控台零錯誤；約 50 個斜線指令與各編輯器入口逐一觸發，對應區塊皆載入成功；120 個區塊全部手動載入皆無錯誤；`_codeHtml`、`_codeAiPack`、行為說明、簡報與匯出資料在沒有預先載入時直接呼叫皆可用。`_behTables` 的 `t[n].push is not a function` 整份檔案也一樣（既有現象）。
- 還原先前對話的網頁（例如 aiweb）開頁就會載入對話裡出現過的小工具所需的區塊（資料檢視、學習單、知識庫等，約 13 個、340K），這是預期行為。
