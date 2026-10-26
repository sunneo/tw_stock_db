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
