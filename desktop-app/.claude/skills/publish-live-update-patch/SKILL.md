---
name: publish-live-update-patch
description: 修改desktop-app的renderer前端檔案（floating-assistant.js／bootstrap.js／index.html）後，如何建置、驗證、發佈成desktop-app-patch分支上的live-update patch，讓已經安裝的桌面版使用者按「🔄 檢查更新」就能拿到。當使用者要求「發patch」「發布更新」「push一個live update」「更新desktop-app-patch」，或你自己改完renderer/src/floating-assistant.js／renderer/bootstrap.js／renderer/index.html準備收尾時使用。
---

# 發佈desktop-app的Live Update Patch

這份技能只管「怎麼把renderer前端的改動送到已安裝使用者手上」。live-update機制本身的完整設計（manifest-diff比對、userData/live-patch覆蓋目錄、md5驗證）在`desktop-app/README.FloatingAssitant.md`的「🔄 Live Update」章節，第一次做這件事建議先讀那份，這裡只給**操作流程＋踩過的坑**。

## 什麼會被熱更新、什麼不會

只有這四個檔案（`main.js`裡`LIVE_PATCH_ALLOWED_FILES`、`build-assistant.js`裡同名常數，**兩處要保持同步**）：

- `renderer/index.html`
- `renderer/bootstrap.js`
- `renderer/floating-assistant.js`
- `renderer/floating-assistant.min.js`

`main.js`／`preload.js`／`package.json`這類主行程原始碼或安裝檔本身**不會**被這個機制更新（主行程程式早就載進記憶體在跑，寫檔案覆蓋也不會生效）。改到這些檔案時，desktop-app-patch分支照樣要重發（讓有安裝AppImage版本仲裁機制的使用者知道有更新可切換），但不要期待它們會被live-update熱套用——這種改動只能靠使用者重新安裝新的installer。

## 標準流程

1. **改原始碼**：`renderer/src/floating-assistant.js`（core引擎，真正的原始碼，2MB+未壓縮）或直接改`renderer/bootstrap.js`／`renderer/index.html`（這兩個沒有另外的src版本，直接編輯commit的檔案本身）。

2. **建置**：
   ```bash
   cd desktop-app
   node build-assistant.js
   ```
   這會用terser壓縮`renderer/src/floating-assistant.js`寫進`renderer/floating-assistant.js`＋`renderer/floating-assistant.min.js`（兩份內容一致），同時重新產生`renderer/update-manifest.json`（本機基準manifest，四個檔案各自的md5＋sizes）。**沒有跑這一步就直接發patch，md5會對不上，使用者端會抓到跟manifest宣告不符的內容而中止更新**——這是刻意設計的完整性防護，不是bug，但代表你一定要先跑這個。

3. **驗證語法**（terser壓縮會吃掉語法錯誤變成一堆亂碼，不會報錯——一定要在壓縮前後都check）：
   ```bash
   node --check renderer/src/floating-assistant.js
   node --check renderer/bootstrap.js
   ```

4. **commit＋push到desktop-app分支**（正常開發流程，四個renderer檔案＋update-manifest.json都要一起commit）：
   ```bash
   git add desktop-app/renderer/src/floating-assistant.js desktop-app/renderer/floating-assistant.js desktop-app/renderer/floating-assistant.min.js desktop-app/renderer/bootstrap.js desktop-app/renderer/index.html desktop-app/renderer/update-manifest.json
   git commit -m "..."
   git push -u origin desktop-app
   ```

5. **發佈到desktop-app-patch分支**——這個分支**永遠只有一個commit**（跟`festival-themes`分支同一種慣例），每次發佈都是「整個重建、force push蓋掉」，不是在舊commit上疊加。**不要用一般的checkout+commit+push流程去改這個分支**（那樣一不小心會把它當成一般分支長歷史，而且checkout desktop-app-patch會動到你當下desktop-app的工作目錄）——改用底下的git plumbing直接組出一個新commit、force push，完全不動到目前checkout的desktop-app工作目錄：

   ```bash
   # 1) 組出這次要發佈的內容（永遠是四個檔案的完整快照，不是只放「這次改的」）
   PATCH_DIR=/tmp/patch-content   # 用你自己的scratchpad路徑
   rm -rf "$PATCH_DIR"
   mkdir -p "$PATCH_DIR/renderer"
   cp desktop-app/renderer/index.html "$PATCH_DIR/renderer/"
   cp desktop-app/renderer/bootstrap.js "$PATCH_DIR/renderer/"
   cp desktop-app/renderer/floating-assistant.js "$PATCH_DIR/renderer/"
   cp desktop-app/renderer/floating-assistant.min.js "$PATCH_DIR/renderer/"

   # 2) manifest.json：files是{相對路徑: {md5}}物件（注意跟本機update-manifest.json
   #    的{相對路徑: "md5字串"}純字串格式不一樣！remote這邊每個值是物件、local那邊是
   #    字串，main.js兩邊各自處理，別搞混、別自己手打md5，直接從剛build出來的
   #    update-manifest.json轉過來最保險）。version只是顯示用的標籤（不影響比對邏輯，
   #    比對永遠是逐檔md5），建議每次遞增一個整數或用日期，notes寫清楚這次改了什麼、
   #    為什麼。
   node -e "
   const fs = require('fs');
   const local = JSON.parse(fs.readFileSync('desktop-app/renderer/update-manifest.json', 'utf8'));
   const manifest = {
     schema: 1,
     version: '3',   // 每次遞增
     publishedAt: new Date().toISOString(),
     notes: '這裡寫這次patch改了什麼',
     files: Object.fromEntries(Object.entries(local.files).map(([k, md5]) => [k, { md5 }])),
   };
   fs.writeFileSync('$PATCH_DIR/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
   "

   # 3) 純git plumbing組一個全新commit（不checkout、不動目前工作目錄），force push
   #    commit訊息用-F讀檔案、不要用-m內嵌多行字串——這個環境的Bash工具
   #    會把多行指令重新包一層eval，實測過多行的-m "..."字串會被壓扁/
   #    弄亂換行，導致commit-tree收到奇怪的參數組合直接報錯
   #    「fatal: must give exactly one tree」（tree hash本身是對的，
   #    問題出在-m那段字串被wrapper弄壞），所以commit訊息一律先寫進
   #    一個檔案再用-F帶進去，不要在同一行對TREE/COMMIT變數做長字串插值。
   cat > /tmp/patch-commit-msg.txt <<'MSG'
desktop-app-patch: v3 - <這次改了什麼>

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
MSG
   export GIT_DIR=$(git rev-parse --git-dir)   # repo根目錄的.git
   export GIT_WORK_TREE="$PATCH_DIR"
   export GIT_INDEX_FILE=/tmp/patch-index      # 用你自己的scratchpad路徑
   rm -f "$GIT_INDEX_FILE"
   (cd "$PATCH_DIR" && git add -A)
   TREE=$(cd "$PATCH_DIR" && git write-tree)
   echo "tree=[$TREE] len=${#TREE}"   # 務必檢查len=40，不是40代表變數被污染了
   COMMIT=$(cd "$PATCH_DIR" && git commit-tree "$TREE" -F /tmp/patch-commit-msg.txt)
   echo "commit=[$COMMIT] len=${#COMMIT}"
   unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
   git update-ref refs/heads/desktop-app-patch "$COMMIT"
   git push --force origin desktop-app-patch:desktop-app-patch
   ```

   `git push`如果印出`fatal: expected 'acknowledgments', received 'packfile'`＋`warning: push negotiation failed; proceeding anyway with push`，這是這個環境的git/proxy已知的無害警告——後面接著印出`(forced update)`或`[new branch]`就代表真的push成功了，不用理會那個warning。

6. **驗證真的發佈成功**：
   ```bash
   curl -sS "https://raw.githubusercontent.com/sunneo/tw_stock_db/desktop-app-patch/manifest.json?_cb=$(date +%s)"
   ```
   確認version／notes／files的md5是這次剛build出來的值（跟`desktop-app/renderer/update-manifest.json`裡的md5逐一比對）。**URL後面的`?_cb=...`不是裝飾——raw.githubusercontent.com前面的CDN（Fastly）在force push之後一小段時間內，不同節點仍可能回應舊的快取內容，同一個URL重複curl可能還是拿到舊manifest；查詢字串不同會被CDN當成不同的快取key，一定會打到origin**。main.js的`fetchUpdateResource()`（`fa:update:check`/`fa:update:apply`的下載入口）已經內建同樣的cache-buster，使用者端不用自己處理；但你自己手動驗證發佈結果時，記得query string也要跟著換（每次都用當下時間戳），不要一直重複打同一個URL卻懷疑「怎麼還是舊的」。

## 一定要做的驗證：不只是「壓縮完看起來沒錯」

**改動內容如果是要影響AI的實際行為（system prompt、工具描述、流程文字），文字本身沒有語法錯誤不代表意思夠清楚——一定要在真的push發佈前，實際跑起來測一次，看AI照著新文字實際會做出什麼行為，不要只憑自己讀起來覺得「應該夠清楚了」就收工。** 這份專案已經發生過兩次活生生的教訓：

- 把AI提示寫成「改用browser_control domain」，AI真的跑起來之後把「domain」誤解成又一種要用`skill_list`/檔案系統工具去「找」的skill包，滿電腦找不到就說要去marketplace安裝——事後才發現用詞在「同一段話裡反覆出現skill/SKILL.md」的語境下有歧義，模型會望文生義。**修法：不要只改一次就發佈，改完至少跟自己或使用者對一輪「如果我是AI，看到這段話會怎麼做」，越具體、越像「不要做X、要做Y」的對比講法越不容易被曲解。**
- 在JS的template literal（用反引號`` ` ``包起來的多行字串）裡面，為了markdown排版用了反引號包code span（例如`` `browser_control` ``）——反引號在JS字串裡沒有跳脫就會**提前結束整個字串字面值**，變成語法錯誤。`node --check`抓得到（見上面步驟3），但如果沒有先本機check、直接拿去build，terser可能給出誤導性的錯誤位置，甚至（依錯誤類型）建置腳本本身直接掛掉。**這個檔案的prompt文字一律不要用markdown反引號code span，用中文引號「」或什麼都不加，跟現有其他prompt的寫法一致。**

如果是改動AI行為的prompt文字，建議流程：改完先`node --check`，然後實際打包成一份patch發到desktop-app-patch，请使用者（或你自己，如果有辦法連上真正的Chrome擴充功能/桌面版）在真實對話裡試一次會觸發這段prompt的情境，看AI的實際反應符不符合預期，再回頭修一輪文字、重新發一次patch，不是憑一次修改就收工。

## 如果改動涉及main.js（live-update機制本身，不是內容patch）

main.js不能被live-update熱套用，改動main.js之後要驗證的重點完全不同：**開發模式（`electron .`／`npm start`）測不出asar相關的bug**，因為開發模式下`__dirname`直接指向真實磁碟資料夾，完全不會碰到app.asar這一層。任何main.js裡會讀`__dirname`底下檔案的邏輯（尤其複製/搬移整個資料夾），一定要用真正打包過的asar建置測試：

```bash
cd desktop-app
npx electron-builder --linux dir --x64   # 產生dist/linux-unpacked/，含真正的resources/app.asar
```

打包完用`dist/linux-unpacked/floating-assistant-desktop`（而不是`electron .`）實際啟動測試。這個坑已經踩過一次：`fs.cp()`／`fs.copyFile()`底層直接呼叫作業系統copy syscall，繞過Electron替Node `fs`模組動的asar讀取手腳，在asar內部路徑會丟`ENOENT`——開發模式完全測不出來，使用者在真正打包後的Windows版才踩到。改成只用`readdir`／`mkdir`／`readFile`／`writeFile`這幾個Electron asar shim有支援的「讀」API手刻遞迴複製（見`main.js`的`copyDirRecursive()`），不要再用`fs.cp`/`fs.copyFile`碰任何可能來自`__dirname`（打包後在asar內部）的路徑。

## 測試recipe（Playwright + xvfb，在無GUI容器裡也能跑）

```bash
# playwright-core通常沒裝在desktop-app的node_modules，但這個環境全域有裝
# （/opt/node22/lib/node_modules/playwright/node_modules/playwright-core）——
# 用symlink塞進一個有node_modules的scratch目錄，ESM import才解析得到：
mkdir -p /tmp/scratch/node_modules
ln -sf /opt/node22/lib/node_modules/playwright/node_modules/playwright-core /tmp/scratch/node_modules/playwright-core
```

```javascript
// /tmp/scratch/e2e.mjs
import { _electron as electron } from 'playwright-core';
const app = await electron.launch({
  executablePath: 'desktop-app/node_modules/electron/dist/electron',  // dev模式
  // 或 executablePath: 'desktop-app/dist/linux-unpacked/floating-assistant-desktop', // 真asar打包
  args: ['--no-sandbox', '.'],   // dev模式才需要'.'這個參數；打包後的執行檔不用
  cwd: 'desktop-app',
  timeout: 30000,
});
await new Promise(r => setTimeout(r, 3000));
const page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? await app.firstWindow();
await page.waitForFunction('window.__faBootstrapReady === true', { timeout: 20000 });
// page.evaluate(...) 操作DOM、page.screenshot({path:...})存圖
await app.close();
```

```bash
xvfb-run -a node /tmp/scratch/e2e.mjs
```

**測試「舊版app收到新patch」這種情境**（不是測「patch本身能不能發成功」，是測「已經安裝的舊版app點下去真的會被更新」）：不要直接改目前checkout的desktop-app工作目錄（那樣本機基準manifest會立刻等於最新patch，測不出「有落差」的情境）。用`git worktree add --detach <舊commit>`開一份獨立checkout當「舊版已安裝app」，把它的`node_modules`用symlink指到主目錄的（省下重新`npm install`），針對這份worktree跑e2e腳本，點「檢查更新」→「立即更新」，確認畫面/console log真的變成新內容、`state.json`/`live-patch/`目錄內容正確。測完記得`git worktree remove --force`清掉，不要留著。

## 常見錯誤排除

- **`git checkout <commit> -- <path>`不小心切到工作目錄一半、忘記切回來**：改完/測完一定要`git checkout HEAD -- <path>`把工作目錄切回去，`git status --short`確認乾淨，才能繼續在desktop-app分支上做事。
- **desktop-app-patch分支「愈用愈大」**：代表用了一般`git commit`疊加而不是本文件教的plumbing+force push流程，去`git log desktop-app-patch`檢查是不是變成多個commit，是的話照樣重新組一個乾淨的單一commit force push蓋掉。
- **使用者說「按了顯示已經是最新版本」**：先確認你真的執行過上面第5步的force push，不是只commit到desktop-app就以為結束了——這兩個分支是分開的兩次動作，desktop-app的push不會自動同步到desktop-app-patch。用`curl -sS ".../desktop-app-patch/manifest.json"`直接確認遠端內容，不要用猜的。
