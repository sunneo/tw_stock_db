# 發版：版號只有一個維護處（`PATCH_VERSION`）

多個 session、多個人都會發熱更新（patch）。版號不能各自記在腦袋或對話裡，所以：

| 東西 | 在哪 | 角色 |
|---|---|---|
| **`desktop-app/PATCH_VERSION`** | 這個 repo（跟發版的那個 commit 一起提交） | **唯一維護處**：一行整數＝最後一次發出去的 patch 版號。git 歷史就是版號歷史 |
| `origin/desktop-app-patch` 的 `manifest.v2.json` | 遠端 | 實際發出去的（現在真正的最新） |
| 同一個分支的 `manifest.json` | 遠端 | 給舊版客戶端的互換版，**凍結在 188**，不要拿來算下一版 |
| 同一個 commit 的訊息 `desktop-app-patch: vNNN - …` | 遠端 | 另一個紀錄（曾經與 manifest 不一致，所以也看） |

## 工具：`scripts/release-version.js`
```bash
node scripts/release-version.js status   # 檔案版號、遠端三處版號、下一版；不一致會警告
node scripts/release-version.js next     # 只印下一版 = max(檔案, 遠端各處) + 1
node scripts/release-version.js claim    # 把 PATCH_VERSION 寫成下一版（或 claim N，N 必須剛好是下一版）
node scripts/release-version.js check    # 檔案版號 ≠ 遠端 → 以 1 結束（發完版後檢查有沒有漏提交）
```
`scripts/publish.sh` 已經用它：版號沒指定就取 `next`，提交前 `claim` 並把 `PATCH_VERSION` 放進同一個提交。

## 接手的人怎麼做
1. `node scripts/release-version.js status`：看下一版是多少、有沒有不一致（有就先弄清楚誰發了版沒更新檔案）。
2. 用 `scripts/publish.sh`（它會建置、提交、發 patch、驗證）；網頁版釘 SHA 的步驟見 `.claude/skills/publish-live-update-patch/SKILL.md`。
3. 發完 `node scripts/release-version.js check` 應該是「一致」。
4. **兩個 session 同時發版**：`claim` 與 patch 分支的 `--force-with-lease` 會讓後到的失敗，不會蓋掉前面的；失敗就重新 `status` 再發。

不要手工組 patch 或手寫版號：發版格式（v2 manifest、分檔）由 `publish.sh`／`publish-manifest.js` 維護。

## 發布前本機驗證（網頁版）
網頁版一發布就是給所有使用者用，所以改了網頁版會碰到的程式（`renderer/src/floating-assistant.js`、`web-lazy/`）時，**先在本機測，OK 才發布**。`scripts/web-local-serve.js` 起一個只綁 `127.0.0.1` 的唯讀伺服器，把網頁版的 `raw.githubusercontent.com/sunneo/tw_stock_db/<SHA>/desktop-app/…` 改寫成本機路徑，讓網頁版直接載到目前工作目錄的建置產物。

1. 先建置（伺服器只會警告、不會替你建）：
   ```bash
   node scripts/embed-code-ui.js && node build-assistant.js
   ```
2. 起伺服器（預設埠 18770，網頁版目錄預設 `D:\Downloads\videos-嗨投資\web`，可用 `--web` 或環境變數 `FA_WEB_DIR` 指定）：
   ```bash
   node scripts/web-local-serve.js
   ```
   啟動時會檢查建置產物是否比來源新；不是最新就印警告。`--dry-run` 只列出會改寫的網址、不起伺服器。
3. 命令列先確認改寫有效（不該再看到 `340d…` 這種釘住的 desktop-app 網址，且載入的都是本機路徑）：
   ```bash
   curl -s http://127.0.0.1:18770/web/aiweb/ | grep -c "raw.githubusercontent.com/sunneo/tw_stock_db/[0-9a-f]\{40\}/desktop-app"
   ```
   結果應該是 `0`。
4. 用 **Claude in Chrome**（不是內建瀏覽器）開 `http://127.0.0.1:18770/web/aiweb/` 與 `http://127.0.0.1:18770/web/`，檢查：
   - 頁面正常載入、沒有 console 錯誤；助理面板打得開。
   - 改動的功能照預期運作（例如 Pyodide 的 python 執行：有沒有 `Failed to fetch`；失敗時訊息有沒有列出試過的來源與 HTTP 狀態）。
   - 匯入一份含 `fa-local://` 的設定檔時，有提示「已略過 N 項桌面版專屬設定」，且網頁版不會因此打不通。
   - 網頁版其他外部資源（sql.js、模型、字型）照常載入（它們維持原網址，不經過本機伺服器）。
5. **OK 才** `scripts/publish.sh`。有任何一項不對，回頭改程式、重建、重測，不要先發布再修。

注意：本機伺服器只讀網頁版倉庫，不會修改它；網頁版的 SHA 釘住與發版要換成的 SHA 仍由發版流程處理（見上面的「接手的人怎麼做」與 `.claude/skills/publish-live-update-patch/SKILL.md`）。
