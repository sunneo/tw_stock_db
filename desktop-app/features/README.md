# AI 功能清冊流程

`features/ai-features.yaml` 是助理所有功能的**唯一資料來源**：分類、功能、說明、怎麼用、範例。
這份資料同時用在三個地方，所以改功能時只維護這一份：

| 用途 | 怎麼來 |
| --- | --- |
| 前端 `/suggest`、`/ai-features`、`feature_guide` 功能說明子代理人 | `build-assistant.js` 建置時把精簡版內嵌進 `renderer/floating-assistant.js`，網頁版、桌面版、aiweb 拿到的一樣 |
| commit message 的 `Features:` 區塊 | `node scripts/ai-features.js commit-msg` 或 git hook 自動附加 |
| 給人看的 `FEATURES.md` | `node scripts/ai-features.js build` 自動產生，不要手改 |

## 新增或修改一個 AI 功能

1. 實作功能（工具、斜線指令、子代理人領域）。
2. 在 `ai-features.yaml` 新增或修改對應的功能項目（`id`、`name`、`summary`、`how`、`platforms`、`samples`）。
3. 記錄這次改動（自動更新 `updated` 與 `history`）：

   ```bash
   node scripts/ai-features.js record <功能id...> -m "這次改了什麼"
   ```

4. 建置：`npm run build:assistant`（或直接 `npm start`，會自動先建置）。建置時會先執行 `check`：
   - 清冊格式錯誤、或寫了原始碼裡不存在的工具／斜線指令／領域 → **建置失敗**
   - 原始碼有、清冊沒列的工具或斜線指令 → 列出警告，提醒你要不要補上
5. commit。commit message 的功能區塊有兩種產生方式：
   - 手動：`node scripts/ai-features.js commit-msg <功能id...> -m "說明"`，把輸出貼進 commit message
   - 自動：啟用 hook 後，`git add` 清冊再 commit，會自動把新增的 `history` 紀錄附加在 commit message 結尾

   ```bash
   git config core.hooksPath desktop-app/scripts/git-hooks
   ```

   （這會改變你的 git hooks 路徑，需要時再啟用。）

commit message 範例：

```
新增影片轉動畫功能

Features:
  - media/media-to-animation（影片轉 2D 動畫）：支援 fps、frames、loop 參數
```

## 清冊欄位

見 `ai-features.yaml` 檔頭的說明。`platforms` 用 `web`（網頁版）、`desktop`（桌面版）。
桌面版限定的功能在網頁版仍然會列出，但會標示「僅桌面版」，功能說明子代理人也會據此告訴使用者。

## 指令一覽

```bash
node scripts/ai-features.js check                          # 驗證清冊並跟原始碼比對
node scripts/ai-features.js build                          # 產生 FEATURES.md 與 ai-features.json
node scripts/ai-features.js commit-msg <id...> [-m 說明]   # 印出 commit message 功能區塊
node scripts/ai-features.js record <id...> -m 說明         # 更新 updated 與 history
node scripts/ai-features.js staged-msg                     # 比對已 git add 的清冊與 HEAD，印出新增的紀錄
```

`js-yaml` 不是 `package.json` 直接宣告的依賴（`node_modules` 裡本來就有），只在開發／建置時使用，不會打包進安裝檔。
