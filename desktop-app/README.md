# FloatingAssistant 桌面版

`floating-assistant.js`（原本是網頁用的AI聊天widget，host-agnostic，
`tw_stock_db`/`piano-web`共用）的Electron單機封裝。**不改動
floating-assistant.js核心任何一行**——所有桌面版專屬的行為都從
`renderer/bootstrap.js`這支host腳本掛進去，延續這個引擎一貫的「引擎共用、
host自己注入內容」設計慣例（跟`tw_stock_db`的`index.html`、`piano-web`的
`js/multitrack.js`是同一種模式）。

## 這個封裝解決的三個問題

1. **檔案存取從「每次都要重新授權」改成「一次授權、直接存取」**：網頁版
   用瀏覽器的File System Access API，`requestPermission()`要求「剛剛發生
   的真人點擊」，太久沒用還會被瀏覽器重置授權。桌面版整個換成走Electron
   原生資料夾選擇對話框＋IPC直接呼叫Node `fs`，選過的資料夾就是永久授權，
   不會被要求重新確認。
2. **多一個「執行本機程式」的subagent能力**（`run_command`）：網頁版完全
   沒有、也不可能有這個能力（瀏覽器沙盒不允許）；桌面版新增一個domain
   `desktop_ops`，把這個工具跟既有的`fap_*`檔案讀寫工具放在一起，AI可以
   直接寫檔案、也可以執行程式（跑腳本/編譯/測試等）。
3. **不依賴Cloudflare（或任何雲端服務）**：網頁版的git_operations／
   browser_search／TTS API等功能都需要一個Cloudflare Worker做CORS繞道，
   桌面版內建一個本機HTTP代理（`local-proxy.js`，純Node `http`模組，沒有
   額外依賴）取代它——完全離線可用（除了實際打AI API/git remote那幾個
   對外連線本身）。使用者仍然可以在Advance Settings把這幾個proxy網址改回
   指向真正的Cloudflare Worker，這條路完全沒被拿掉，只是不再是必要條件。

## 架構

```
desktop-app/
  main.js            Electron主行程：BrowserWindow、IPC handler（fs/exec/
                      roots）、啟動本地proxy
  preload.js         contextBridge——renderer只看得到window.desktopAPI這個
                      窄接口，完全碰不到Node API本身
  local-proxy.js      本機HTTP代理（取代Cloudflare Worker），監聽
                      127.0.0.1，轉發請求、補CORS header
  renderer/
    index.html         桌面版的host頁面（頂部列 + AI視窗鋪滿其餘空間）
    bootstrap.js        把FloatingAssistant接上桌面版能力的host腳本（見下）
    floating-assistant.js  build腳本從 ../web/floating-assistant.js 同步過來
                            的副本（不進版控，見.gitignore，每次build都重抓
                            最新版，避免跟canonical來源不同步）
  build.ps1 / build.sh   打包腳本（見下）
```

### 安全模型

- **`contextIsolation: true` + `nodeIntegration: false`**：renderer（含
  floating-assistant.js自己會動態載入的任何第三方CDN函式庫，例如
  isomorphic-git/three.js/jszip）完全碰不到Node
  API，只能透過`preload.js`用`contextBridge`刻意暴露出去的窄接口
  （`window.desktopAPI.*`）跟主行程溝通。即使renderer被XSS或載到惡意CDN
  內容，也不能繞過這層直接讀寫檔案/執行程式。
- **「直接存取」不等於「無限制存取整台電腦」**：每個檔案IPC handler都在
  `main.js`裡用`resolveWithinRoot()`先確認目標路徑真的落在使用者自己用
  原生資料夾選擇對話框授權過的某個root目錄底下，才會真的碰磁碟——這層
  檢查刻意放在主行程（不是renderer），因為renderer的JS理論上可能被繞過，
  只有主行程真正管得住系統呼叫。
- **執行程式是最危險的能力，預設關閉、預設每次都要求真人確認**：使用者
  要在應用程式頂部列勾選「允許AI執行程式」這個工具才會生效；預設每次
  呼叫都會跳原生對話框顯示完整指令+工作目錄，使用者按「執行」才會真的
  跑（可以在頂部列關掉這個確認，但那是使用者自己的選擇，不是預設姿態）。
  一律用`execFile`（陣列參數，不經過shell）而非`exec`/`shell:true`，
  避免shell注入；有輸出大小上限（2MB）跟逾時（2分鐘）。

### 檔案存取override是怎麼做到「不改核心」的

`floating-assistant.js`的整個File Access Point系統，只透過**5個方法**
（`add`/`getAll`/`get`/`rename`/`delete`）碰`this.fileAccessPoints`這個
`FileAccessPointStore`實例，`FileAccessPointStore`存的`handle`則是一個
duck-typed物件（`queryPermission`/`requestPermission`/`getDirectoryHandle`/
`getFileHandle`/`removeEntry`/`entries()`/`.name`）——這剛好完全對應瀏覽器
`FileSystemDirectoryHandle`的介面，但**沒有任何一處程式碼真的檢查它是不是
瀏覽器原生物件**。`bootstrap.js`因此可以：

1. 建一個`ElectronDirectHandle`／`ElectronDirectFileHandle`class，實作
   一模一樣的介面，但底層改成呼叫`window.desktopAPI.fs.*`（IPC）操作真實
   磁碟；`queryPermission`/`requestPermission`永遠回傳`'granted'`。
2. 建一個`ElectronFapStore`class，實作一模一樣的5個方法，底層改成呼叫
   `window.desktopAPI.roots.*`（存在Electron的`userData`目錄下一個JSON
   檔，不是IndexedDB）。
3. 在`new FloatingAssistant(...)`之後直接
   `fa.fileAccessPoints = new ElectronFapStore()`——完成override。
4. 順便polyfill`window.showDirectoryPicker`（瀏覽器版「+新增資料夾」按鈕
   呼叫的那個API），讓**既有的按鈕/UI流程完全不用改**就能正常運作。

`git_operations`（`FapGitFs`）也是同一個道理：它只透過傳進建構子的
`rootDirHandle`呼叫`getDirectoryHandle`/`getFileHandle`/`entries()`/
`removeEntry`，所以`ElectronDirectHandle`一接上，`git_clone`/`git_pull`/
`git_status`/`git_log`/`git_commit`/`git_push`全部原封不動能用——唯一還
需要處理的是isomorphic-git的HTTP transport在renderer裡還是用`fetch()`，
仍然會撞到瀏覽器CORS限制，所以`bootstrap.js`把`gitCorsProxyUrl`指向本地
代理（見下）。

### 為什麼不用把Cloudflare Worker整支搬進本地跑，只做一個通用轉發？

Cloudflare Worker（`tw_stock_db_code`私有repo的`code/cloudflare-worker/worker.js`）
的每個路由，本質上都是「幫瀏覽器把一個跨網域請求轉發出去、把回應加上
`Access-Control-Allow-Origin`」，唯一的例外是`/nvidia`、`/openrouter`兩條
路由會把一把「多人共用的假金鑰」換成伺服器端的真金鑰——那是`tw_stock_db`
網站給不特定訪客共用一把金鑰的設計，桌面版是單人使用，使用者直接在
Advance Settings填自己的真實API金鑰即可，不需要這層替換。所以
`local-proxy.js`只需要實作一個**通用**的`/proxy/<url>`（外加`/git-proxy/<url>`
別名，跟`_resolveGitCorsProxyUrl()`既有的`corsProxy+'/git-proxy'`慣例對齊，
不用改`floating-assistant.js`一行）轉發+補CORS header就完全足夠，不用照抄
Worker每一條路由的個別邏輯。

## 開發時執行（不打包）

```bash
cd desktop-app
npm install
node -e "require('fs').copyFileSync('../web/floating-assistant.js','renderer/floating-assistant.js')"
npm start
```

或直接跑 `build.ps1 -SkipInstall`／`SKIP_INSTALL=1 ./build.sh`
（跳過npm install，只做同步floating-assistant.js的步驟），再手動
`npm start`。

## 打包成單一執行檔

**Windows**（在Windows機器上，PowerShell）：
```powershell
.\build.ps1
```
輸出在`dist\`目錄，是單一`.exe`（electron-builder的`portable`
target——雙擊直接跑，不用安裝、不會在系統裡留下安裝紀錄）。

**Linux**（AppImage）：
```bash
./build.sh
```
輸出在`dist/`目錄，是單一`.AppImage`檔（`chmod +x`後直接執行）。

兩個腳本都會先把`../web/floating-assistant.js`同步進
`renderer/floating-assistant.js`——**這是canonical來源在`web/`目錄，這裡
永遠是build時才產生的副本**，改AI引擎本身的功能一律去改
`web/floating-assistant.js`，不要直接改這個資料夾底下的副本（下次build
會被覆蓋）。

跨平台編譯（例如在Linux上打包Windows版）electron-builder需要系統裝好
`wine`，容易踩雷，建議直接在對應的作業系統上各自打包。

## 已知限制（如實告知）

- **本地proxy只解決CORS，不解決「目標API本身要不要收你的金鑰/請求」**——
  使用者還是要在Advance Settings填自己真實有效的API金鑰/URL，這個app不
  提供任何金鑰。
- **`run_command`沒有沙盒**——它就是真的在使用者帳號權限下執行程式，跟
  使用者自己開終端機打指令的風險等級一樣；預設的「每次確認」只是降低
  「AI自己想執行就執行」的機率，不是安全沙盒，使用者拒絕/關閉確認之後
  要對自己允許AI執行的每一個指令負責。
- **`resolveWithinRoot()`的路徑範圍檢查防的是「AI/renderer產生的路徑
  意外或惡意跳出授權資料夾」，防不住`run_command`執行的程式本身在跑
  起來之後做什麼**——一旦程式開始跑，它擁有跟使用者本人一樣的系統權限，
  不受這個app的root範圍限制（這是作業系統層級的行程權限模型，這個app
  沒有、也不打算做真正的程式沙盒）。
- 目前沒有self-update機制、沒有code signing（Windows/macOS可能會顯示
  「未知發布者」警告）——這些留給之後真的要對外發布時再處理，這次範圍
  只到「本機打包成可執行的單一檔案」。
- `main.js`裡的本機代理埠號預設`47891`，被佔用時會自動往上找（最多試
  20個），實際埠號透過IPC回報給renderer，不需要使用者自己處理。
- **不要對這個資料夾跑`npm audit fix --force`**——實測過會把
  `electron`/`electron-builder`跳到需要Node.js `>=22.12.0`的版本
  （`electron@44.x`/`electron-builder@26.15.x`），如果本機Node版本較舊
  （例如16.x），`npm install`會在`electron-winstaller`等套件的安裝腳本
  卡死失敗（`vendor/7z-*.exe`不存在之類的ENOENT），而且這通常不是單一
  套件壞掉、是整條依賴鏈的安裝腳本在不相容的Node版本下沒能正常跑完。
  `npm audit`目前在這個範圍報的高風險項目集中在`electron-updater`的
  自動更新流程與`dmg-builder`/`tar`的封存檔解壓縮路徑——這個專案沒有設定
  `publish`/autoUpdater、也不會解壓縮任何不受信任的封存檔，這些CVE的
  實際曝險對這個專案很低，維持現有版本是刻意的選擇，不是忘了處理。真的
  想升級到最新版，請先把本機Node.js升級到22以上再試，不要用`--force`
  硬升版本卻維持舊Node。
