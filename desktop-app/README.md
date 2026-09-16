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

## CLI模式：`-p` 非互動執行

跟`claude -p "..."`類似，桌面版可以不開GUI視窗、直接從命令列丟一句prompt
進去執行、拿到結果就結束。

**Windows使用者請一律執行`FloatingAssistant.exe`**（一個獨立build出來的
launcher，跟真正的Electron app`FloatingAssistantApp.exe`放在同一個資料夾，
使用者只需要記得執行前者）——原因見下方「Windows平台限制」一節，這是實測
驗證過唯一可靠的做法。Linux/macOS沒有這個問題，直接執行原本那個檔案即可。

```bash
FloatingAssistant.exe -p "幫我查一下台積電最近的股價"          # Windows
./FloatingAssistant.AppImage -p "幫我查一下台積電最近的股價"  # Linux
FloatingAssistant.exe -p "/media-list-voices"                 # 支援slash command
FloatingAssistant.exe -p "..." --output-format json            # 結構化JSON
FloatingAssistant.exe -p "..." --output-format toon            # TOON（比JSON省token）
FloatingAssistant.exe -p "..." --output-format md               # 原始markdown，不轉成ASCII
```

**`FloatingAssistant.exe`不帶`-p`直接執行（雙擊或裸執行）等同於開GUI**——
它會spawn旁邊的`FloatingAssistantApp.exe`（detached）並立即結束自己，畫面
上只會看到黑底console視窗閃一下、GUI就開了。使用者全程只需要記得
`FloatingAssistant.exe`這一個檔名；`FloatingAssistantApp.exe`是真正的
Electron app本體，不需要直接執行它。

（開發模式對應`npm start -- -p "..."`或`electron . -p "..."`——dev模式直接
跑`electron .`，沒有經過launcher，Windows開發模式下`-p`可能仍然看不到
輸出，見下方已知限制。）

- **跟GUI共用workspace**：沿用既有的「依目前資料夾/使用者手動選過的資料夾」
  判斷邏輯（見下方「架構」章節），在同一個資料夾底下執行CLI模式看得到跟
  GUI一樣的對話紀錄/設定。
- **預設全部自動、不彈確認框**：`允許AI執行程式`的執行前確認、File Access
  Point權限對話框等，只要功能本身已經在Advance Settings開啟，CLI模式一律
  自動放行（隱藏視窗裡跳原生對話框使用者也看不到）——`execEnabled`這道
  安全邊界本身不受影響，沒開就是沒開。
- **GUI互動卡片（3D場景/Mermaid/繪圖/互動viewer/配音小幫手等）在CLI模式
  下不會呈現**，只會拿到AI回覆的文字結論——這類工具本來就需要真人在畫面
  上操作，CLI模式沒有畫面可以操作，屬於這個模式先天的能力邊界。
- 輸出預設是formatted過的純文字＋ASCII art（markdown表格會畫成方框表格，
  標題/粗體轉成終端機可讀的樣式）；`--output-format`可以改成`json`/
  `toon`/`md`三種其他格式。

### Windows平台限制：為什麼需要`FloatingAssistant.exe`這支獨立launcher

這一節記錄的是**在真實Windows機器上實際測試、逐步排除掉的三個方向**，不是
事前的理論分析——每個方向都真的build出來、真的在PowerShell/cmd裡執行過，
包括失敗的那三個，如實記錄下來避免之後又重踩同一個坑。

**根因**（用真實的GUI/console subsystem測試程式配合碼表量測過）：Windows
打包出來的Electron app預設是GUI subsystem（雙擊直接開視窗，這是為了不要
每次雙擊都閃一個黑底命令列視窗）；PowerShell對GUI subsystem`.exe`的
command invocation（`& '...'`或裸執行）**不會等待它執行完成**——量測結果：
對一個內部`sleep`3秒的GUI subsystem測試程式，PowerShell下一行指令在
0.005秒左右就先執行了，完全沒有等。這是根本問題：**GUI subsystem的行程被
PowerShell裸執行時，本身就拿不到一個可靠、能往下傳遞的console handle**——
不管接下來做什麼，只要還是從這個「起點」出發，都會卡在同一個地方：

1. ❌ **第一次嘗試**：GUI版.exe自己在`-p`時偵測到，spawn一份PE header被
   patch成console subsystem的副本、`stdio:'inherit'`。失敗——父行程本身
   沒有可靠console handle可以relay，Windows的預設行為是幫子行程另開一個
   全新、使用者看不到的console視窗，畫面上只會看到一個視窗閃一下就消失。
2. ❌ **第二次嘗試**：GUI版.exe自己在`-p`時透過`cmd.exe /c`重新執行「同一個」
   .exe。理論上`cmd.exe`是console subsystem、應該能正確relay——但實際
   在使用者機器上測試，還是出現同一種「跳出一個新console視窗、閃一下就
   消失」的失敗，根因跟第一次一樣：父行程（發起`cmd.exe /c`呼叫的那個
   GUI subsystem行程本身）就沒有東西可以往下relay，中間多繞一手`cmd.exe`
   並不會無中生有出一個可靠的console handle。
3. ❌ **第三次嘗試**：不複製額外的檔案，直接把electron-builder產生的**唯一
   那一份**.exe本身patch成console subsystem，沒帶`-p`時呼叫`FreeConsole()`
   把黑視窗關掉再照常開GUI——這次在`dist\win-unpacked\`資料夾內直接執行
   確認可以動（`-p`會印出正確結果），但透過electron-builder的「portable」
   （單一自解壓縮.exe）打包格式重新測試時失敗了：等了25秒仍然完全沒有
   輸出。根因研判是portable target的自解壓縮外殼本身也是一個GUI subsystem
   行程（NSIS-based），重新引入了跟第1、2次一樣的問題——這點沒有100%
   確認到底層細節（沒有繼續深究，因為使用者已經明確要求換方向），只知道
   這個格式測試失敗了。
4. ✅ **目前採用的做法（使用者明確指定：改用PyInstaller）**：完全不要讓
   Electron app自己處理任何console subsystem的事——`FloatingAssistantApp.exe`
   維持electron-builder預設的GUI subsystem、完全不patch，跟一般沒有CLI
   模式的Electron app一樣單純。另外用**PyInstaller**（真正的編譯器/
   linker，不是事後改PE header的byte patch）從`launcher/launcher.py`
   build出一支**真正**是console subsystem的`FloatingAssistant.exe`
   （`--onefile --console`），放在跟`FloatingAssistantApp.exe`同一個資料夾
   ——使用者的PowerShell/cmd**直接**執行這個launcher（不透過任何GUI
   subsystem的中間行程），它天生就有可靠的console，往下呼叫
   `FloatingAssistantApp.exe`（`-p`時inherit stdio、等待、回傳exit code；
   沒有`-p`時detached spawn、立刻結束）完全不會重蹈前三次失敗的問題，
   因為relay的來源這次真的有東西可以relay。

- 這個機制只在**打包後**的正式build生效（`build.ps1`會自動用PyInstaller
  build`launcher/launcher.py`並複製進`dist\win-unpacked\`）；**開發模式**
  （`npm start -- -p "..."`/`electron . -p "..."`）不會經過launcher，
  Windows開發模式下`-p`可能仍然看不到輸出，這是已知限制（開發模式主要給
  改程式碼的人用）。
- Linux（AppImage）/macOS的終端機沒有這個GUI/console subsystem的差異，
  `-p`本來就能在同一個行程內正常輸出（AppImage版本實測過），不需要任何
  launcher。
- 需要Windows機器上有**Python**（`build.ps1`會自動偵測、缺PyInstaller時
  自動`pip install pyinstaller`）——這是新增的build時依賴，只影響打包
  流程本身，跟打包完的.exe完全無關（PyInstaller把Python直譯器整個打包進
  `FloatingAssistant.exe`裡，使用者執行時不需要另外安裝Python）。
- **這不是單一檔案，是一個資料夾（`dist\win-unpacked\`）**：裡面有
  `FloatingAssistant.exe`（launcher）+ `FloatingAssistantApp.exe`（真正的
  Electron app）+ Electron/Chromium的DLL跟資源檔——這些檔案要維持在同一個
  資料夾底下、彼此相對位置不變，launcher才找得到app。**曾經嘗試過**把整個
  app資料夾用PyInstaller的`--add-data`打包進`FloatingAssistant.exe`裡做成
  真正的單一檔案（讓它在每次執行時自動解壓縮到暫存資料夾）——`-p`確實可以
  正常運作，但**GUI視窗會整個空白**（Chromium在暫存資料夾路徑下的
  disk cache/GPU cache建立失敗，`-p`用的隱藏視窗不需要真的畫面渲染所以
  沒事，但可見的GUI視窗因為render失敗變成空白），沒有繼續深究根因就先改
  回資料夾形式——這是目前唯一同時驗證過`-p`跟GUI都正常的組合。要發布給
  別人，把整個`win-unpacked`資料夾（可以重新命名）壓成zip即可。

## 打包

**Windows**（在Windows機器上，PowerShell）：
```powershell
.\build.ps1
```
一次跑完會在`dist\`產生**兩種輸出**（用electron-builder內建、成熟的
「nsis」target，不是自己土炮的機制）：

- **`FloatingAssistant Setup <版本>.exe`**——真正的Windows安裝程式：
  執行後跳安裝精靈（可以選安裝目錄）、完成後會在桌面跟「開始」功能表
  建立捷徑（指向`FloatingAssistantApp.exe`，雙擊開GUI跟平常一樣，不用
  透過launcher），也會在Windows的「新增或移除程式」正確登記、可以正常
  解除安裝。`-p`則是進到安裝目錄底下執行`FloatingAssistant.exe`（這個
  沒有捷徑——它是終端機工具，不是拿來雙擊的東西，習慣的話可以自己把
  安裝目錄加進PATH）。
- **`dist\win-unpacked\`**——跟之前一樣的免安裝資料夾版本，適合不想動
  系統安裝紀錄的情境，裡面執行`FloatingAssistant.exe`：雙擊開GUI、
  加`-p`用CLI模式都可以。

兩者背後是同一份`FloatingAssistantApp.exe`+`FloatingAssistant.exe`
（`build/afterPack.js`只會複製一次launcher，`nsis`/`dir`兩個target共用
同一次封裝，不會build兩次整個app）。

**已知缺口**：`build/icon.ico`/`build/icon.png`目前不存在於這個工作目錄
（跟這次改動無關的既有問題，見更早的commit紀錄），所以安裝出來的捷徑/
安裝程式目前用的是Electron的預設圖示，不是這個app自己的圖示——之後補上
圖示檔案即可，跟這次的installer/launcher機制完全無關。

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

### 內建金鑰（選填，給新使用者的免額度預設值）

`main.js`的`getSecrets()`優先順序是：環境變數（執行時）>
`secrets.json`（使用者透過🔑設定API金鑰對話框存的值）>
**打包時內建的預設金鑰**。這個優先順序保證使用者自己填過的金鑰永遠有效，
內建金鑰只在完全沒設定過的情況下當作退路，讓全新使用者不用先申請/填自己
的金鑰就能直接試用。

要內建金鑰，有兩種等效的方式：

**方式一：環境變數**（打包**之前**在建置機器的shell設定）：

```bash
export FA_BUILTIN_NVAPI_KEY="你的預設/免額度NVAPI_KEY"
export FA_BUILTIN_OPENROUTER_KEY="（選填）你的預設OPENROUTER_API_KEY"
./build.sh   # 或 Windows 上先 $env:FA_BUILTIN_NVAPI_KEY="..." 再 .\build.ps1
```

`build.sh`/`build.ps1`會在打包前把這兩個環境變數寫進`builtin-secrets.json`
（`.gitignore`排除、不進版控），跟著這次打包結果一起輸出到`dist/`。

**方式二：直接編輯檔案**（不依賴環境變數有沒有正確傳遞到build script——
2026-09-16曾有使用者實測回報，透過`cmd /c "set X=Y && ... && powershell
-File build.ps1"`這種巢狀shell一次性指令設定環境變數，在某台Windows機器上
沒有正確傳遞進去，根因未查出，但這是更直接、保證有效的替代路徑）：直接打開
這個資料夾底下的`builtin-secrets.json`（沒有的話先跑一次`./build.sh`或
`.\build.ps1`讓它產生一份空的），手動填入`NVAPI_KEY`/`OPENROUTER_API_KEY`
後存檔，之後執行`./build.sh`/`.\build.ps1`時**只要沒有設定上面那兩個環境
變數**，就不會覆寫這個檔案，你手動填的值會照樣打包進去。兩種方式可以互相
切換：只要某次build有設定環境變數，就會用環境變數的值重新產生檔案（環境
變數優先）；不設定的話才會保留現有檔案（不論是先前哪種方式產生的）。

沒設定環境變數、也沒有既有`builtin-secrets.json`檔案時（例如第一次打包），
會寫出一份空物件，等同完全沒有這個機制，不影響既有行為。

**⚠️ 這把金鑰本質上是公開的，不是真正的密鑰**：跟Cloudflare Worker「金鑰
只活在伺服器端、瀏覽器永遠看不到」的模型完全不同，這裡的`main.js`會整支
被`electron-builder`打包進使用者實際下載的`.exe`/`.AppImage`（`asar`可以
被解開，Node/Electron讀asar內容本身也是完全透明的）——只要有人拿到打包
出來的app，就等於拿到`builtin-secrets.json`裡的完整金鑰內容。**只適合
掛一把刻意設定低額度/免費層級、就算被公開抽取也能接受的金鑰，絕對不要
用綁定真實付費帳號或高額度配額的金鑰。**

## 內建bash/python執行環境

`floating-assistant.js`（web/桌面版共用同一份引擎）內建`bash_execute`（busybox
ash+coreutils編譯成wasm32-wasi，透過[wasi-sh](https://github.com/sunneo/wasi-sh)
fork）跟`python_execute`（[Pyodide](https://github.com/pyodide/pyodide)，
CPython編譯成wasm）兩個工具，讓AI能真的產生程式並在瀏覽器沙盒內執行，不是
只能描述「這段程式應該做什麼」。兩者都完全不會碰到使用者電腦真正的檔案
系統，也沒有對外網路連線能力。

輸出檔案的存放位置有三層優先順序（`output_ref`參數控制，見
`_persistExecutionOutputFiles`的說明）：`fap:<名稱>`存進File Access
Point（任何平台）→ 桌面版可給真實磁碟絕對路徑直接存 → 兩者都沒給就存進
persistentStorage。桌面版這兩個工具用到的wasm執行環境（busybox.wasm/
Pyodide）會經本地proxy帶入（`advancedSettings.assetBackupProxyUrl`，
bootstrap.js自動設定，跟`gitCorsProxyUrl`等三個既有proxy欄位同一套慣例）。

**⚠️ 需要Electron 44+（Chromium 137+）**：`busybox.wasm`用到WASM exception
handling（`exnref`）——這個特性Chrome到137版才穩定支援，桌面版原本鎖定的
Electron 31（Chromium ~126）會直接`WebAssembly.compile()`失敗。這是這次
新增bash_execute時才發現、也才把`package.json`的Electron依賴升級到44的
真正原因，不是隨意升級——升級後已經重跑過現有的桌面版整合測試
（`FA_DEBUG_*`系列），確認沒有引入其他回歸。

## 已知限制（如實告知）

- **本地proxy只解決CORS，不解決「目標API本身要不要收你的金鑰/請求」**——
  使用者還是要在Advance Settings填自己真實有效的API金鑰/URL；打包時如果
  建置者有設定`FA_BUILTIN_NVAPI_KEY`/`FA_BUILTIN_OPENROUTER_KEY`（見下面
  「內建金鑰」），沒填過自己金鑰的使用者會退回用那把內建金鑰，使用者自己
  填的值永遠優先覆蓋。
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
- **`electron-builder`打包Windows版時可能出現`Cannot create symbolic
  link`失敗**（發生在解壓縮`winCodeSign`——一個electron-builder內部共用
  setup會下載的macOS簽章工具包，即使只打包Windows版也會抓，這個包裡的
  `.dylib`檔本身就是用symlink打包的，是electron-builder本身已知的行為，
  不是這個專案的bug）——Windows預設不允許一般使用者帳號建立symbolic
  link，需要先在「設定 > 隱私權與安全性 > 開發人員專用」把「開發人員
  模式」打開，或改用系統管理員權限執行這個腳本。`build.ps1`已經設定
  `CSC_IDENTITY_AUTO_DISCOVERY=false`（這個app本來就沒有簽章，不需要
  electron-builder嘗試找簽章憑證），失敗時也會印出這個提示。
