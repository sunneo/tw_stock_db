# tw_stock.db 完整快照（切割檔）

本分支（db-snapshot）的完整切割檔只保留**最新一份**，每月由排程腳本 force push 覆蓋，歷史不保留。

最後更新：2026-09　原始大小：557,060,096 bytes　共 12 個 part（每份 <= 48MB）

## 為什麼切成 part 檔，不用 Git LFS

tw_stock.db 超過 GitHub 100MB 單檔上限，但 Git LFS 免費額度只有每月 1GB 儲存 + 1GB 頻寬，若每月都整包用 LFS 推送很快會超額。切成每份 48MB 以內的 part 檔（低於 GitHub 50MB 大檔案警告門檻）後，用一般 git commit 就能推送，沒有額外的 LFS 額度限制。

## 如何合併回 tw_stock.db

**方法一（推薦，跨平台）**：用附帶的 `merge_db.py`（純 Python 標準函式庫，不需要額外安裝套件），會順便驗證 sha256 checksum：

```bash
python merge_db.py
```

**方法二（Linux / macOS）**：

```bash
cat tw_stock.db.part000 tw_stock.db.part001 tw_stock.db.part002 tw_stock.db.part003 tw_stock.db.part004 tw_stock.db.part005 tw_stock.db.part006 tw_stock.db.part007 tw_stock.db.part008 tw_stock.db.part009 tw_stock.db.part010 tw_stock.db.part011 > tw_stock.db
```

**方法三（Windows cmd，注意 part 檔名順序要正確，用 + 串接）**：

```cmd
copy /b tw_stock.db.part000+tw_stock.db.part001+tw_stock.db.part002+tw_stock.db.part003+tw_stock.db.part004+tw_stock.db.part005+tw_stock.db.part006+tw_stock.db.part007+tw_stock.db.part008+tw_stock.db.part009+tw_stock.db.part010+tw_stock.db.part011 tw_stock.db
```

合併後檔案的 sha256 應為：`77dba6658b8702fcef7cd5fb12483812ca7da8665f3efbf485ba577c5a854c81`（`tw_stock.db.manifest.json` 裡也有記錄，`merge_db.py` 會自動核對）。

逐日增量資料與完整說明請見 main 分支的 SKILL.md。

## 網頁優化用的小型快照（`db/` 目錄）

純 JS 網頁版（`web/index.html`）不會下載上面這份完整切割檔——下載/組裝300MB+ 太慢。網頁改用 `db/` 目錄下的小型快照按需下載，這些檔案**跟這份完整切割檔分開 commit**（每個月份各自一個 commit，見 sync_monthly_snapshots()），不會因為每月的完整快照 force push 而被覆蓋掉：

- `db/core.db`：股票基本清單/類股，全量但很小，每次都重新產生。
- `db/monthly/<yyyy>/<mm>.db`：每個月的 daily_prices/technical_indicators/market_index，過去月份封存後不再變動，只有目前最新月份每次重新產生（約 10~15MB/月，遠低於 50MB，不需要切 part）。
- `db/monthly/manifest.json`：記錄每個檔案的 sha256/大小，供網頁下載後驗證，並讓網頁知道有哪些月份可以按需下載。

網頁預設只抓 core.db + 最近幾個月，使用者把K線圖往回拉（zoom out）超出目前已載入的範圍時，才會按需抓更早的月份，並搭配 main 分支的逐日增量 CSV 補齊「目前月份快照之後」的最新幾天。

## 盤後籌碼資料（`db/monthly-chip/` 目錄，跟上面的 `db/monthly/` 分開）

三大法人個股別買賣超/股權分布/強制集保股數，見 chip_snapshot.py：

- `db/monthly-chip/<yyyy>/<mm>.db`：跟 `db/monthly` 一樣按月封存，但獨立成單獨的檔案/分類，因為網頁只有使用者主動展開某檔股票的「盤後資訊」面板時才需要下載，不該跟著每次瀏覽K線圖都要用到的價量資料一起載入，手機版尤其要避免這種用不到卻預先下載的流量。
- `db/monthly-chip/manifest.json`：跟 `db/monthly/manifest.json` 分開的獨立 manifest，同理，網頁不需要在一般瀏覽流程時載入它。
