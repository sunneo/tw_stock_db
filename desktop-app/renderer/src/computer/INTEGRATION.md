# computer use 接線說明（給整合者貼上用）

設計、安全模型、測試狀態見 `DESIGN.computer-use.md`。這份只講「要貼哪裡、貼什麼」。
下面標了 `<!-- BLOCK:… -->` 的程式碼區塊會被 `scripts/computer-tests/integration_doc.test.js` 取出來驗證（領域形狀、工具名稱都存在、regex 正反例、YAML 可解析），所以貼的就是測過的版本。

## 1. 主行程接線（main.js／main-ext.js／preload.js／package.json）

這四個檔案我沒有改（它們的擁有者是別的使用者，沒有寫入權限）。改動做成一份補丁：

```
cd desktop-app
patch -p1 < renderer/src/computer/main-wiring.patch      # 已用 patch --dry-run 驗證可乾淨套用，套用後四個檔案語法檢查通過
```

補丁內容（都是新增，不改既有行為）：

- `main.js`
  - `LIVE_PATCH_MAIN_FILES` 加入 15 個新檔（`computer-png.js`、`computer-use-elements.js`、`computer-use-safety.js`、`computer-use-linux-parse.js`、`computer-use-linux.js`、`computer-use-atspi.js`、`computer-use-win-cs.js`、`computer-use-windows.js`、`computer-use-uia.js`、`computer-ws.js`、`rfb-codec.js`、`rfb-client.js`、`computer-remote.js`、`computer-use.js`、`computer-use-ipc.js`）。
  - `require("./main-ext.js").register(ipcMain, { … })` 多傳 `getMainWindow`、`getDesktopSettings`、`patchDesktopSettings`、`userDataDir`、`secretsFile`。
- `main-ext.js`：`register()` 結尾（`return` 之前）`try { require("./computer-use-ipc.js").register(ipcMain, ctx); } catch …`——載入失敗不影響其他功能。
- `preload.js`：`desktopAPI.computer.*`（見 §3）。
- `package.json`：`build.files` 加入同樣 15 個檔案（否則打包後 `require` 不到）。

另外 **`build-assistant.js` 第 65 行附近**（`"fsx-sync.js",` 那份給 live-update manifest 用的主行程檔案清單）也要加同樣 15 個檔名——這個檔案你在編輯，所以我沒碰。

驗證：`node scripts/computer-tests/electron.itest.js` 會用真的 Electron 跑（已接線就直接用，沒接線就先套補丁到暫存副本），19 項端到端檢查。

## 2. renderer 接線（floating-assistant.js、scripts/embed-code-ui.js）

三個檔案（都在 `renderer/src/computer/`），嵌入順序：**`computer_core.js` → `computer_vision.js` → `computer_host.js`**。core 與 vision 是 UMD（跟 `vlm_core.js` 一樣用 `holder` 包法嵌成 `const FaComputerCore`／`const FaComputerVision`）；host 是 `const FaComputerHost = (function(){…})()`（跟 `edit_host.js` 一樣原樣貼）。已用 `new Function` 模擬 embed 的包法驗證：三者可在「沒有 module／require」的全域裡一起運作。

`floating-assistant.js` 要有的標記（放在 `/* EDITHOST-BEGIN */` 之前或之後都可以，只要在 `Object.assign(FloatingAssistant.prototype, …)` 之前、而且 core→vision→host 的順序不變）：

```
/* COMPUTERCORE-BEGIN */
/* COMPUTERCORE-END */
/* COMPUTERVISION-BEGIN */
/* COMPUTERVISION-END */
/* COMPUTERHOST-BEGIN */
/* COMPUTERHOST-END */
```

`scripts/embed-code-ui.js` 要加的函式（仿 `embedEdit`；你不讓我跑它，所以只給片段）：

<!-- BLOCK:embed -->
```js
// computer use（桌面版）：純邏輯 core、視覺慢路徑 vision（UMD）與主機轉接層 host，見 DESIGN.computer-use.md
const COMPUTER_MODULES = [['computer_core', 'COMPUTERCORE', 'FaComputerCore'], ['computer_vision', 'COMPUTERVISION', 'FaComputerVision']];
function embedComputer() {
    const dir = path.join(root, 'renderer/src/computer'); if (!fs.existsSync(path.join(dir, 'computer_host.js'))) return;
    for (const [fn, mark, name] of COMPUTER_MODULES) {
        const core = fs.readFileSync(path.join(dir, fn + '.js'), 'utf8').replace(/\r\n/g, '\n');
        const a = src.indexOf('/* ' + mark + '-BEGIN */'), b = src.indexOf('/* ' + mark + '-END */'); if (a < 0 || b < 0) throw new Error('找不到 ' + mark + ' 標記');
        src = src.slice(0, a) + '/* ' + mark + '-BEGIN */\nconst ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();\n' + src.slice(b);
        console.log('已更新 ' + name + '（' + core.length + ' 字元）');
    }
    const host = fs.readFileSync(path.join(dir, 'computer_host.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* COMPUTERHOST-BEGIN */'), b = src.indexOf('/* COMPUTERHOST-END */'); if (a < 0 || b < 0) throw new Error('找不到 COMPUTERHOST 標記');
    src = src.slice(0, a) + '/* COMPUTERHOST-BEGIN */\n' + host + '\n' + src.slice(b);
    console.log('已更新 FaComputerHost（' + host.length + ' 字元）');
}
embedComputer();
```

接上 prototype 與註冊（兩個建構子位置都跟 `_registerEditCommands()`／`_registerEditTools(registerOptional)` 並排；`Object.assign` 那一行你已經加了）：

```js
Object.assign(FloatingAssistant.prototype, FaComputerHost.methods);   // 放在 FaEditHost 那一行旁邊
this._registerComputerCommands();                 // 緊接 this._registerEditCommands();
this._registerComputerTools(registerOptional);    // 緊接 this._registerEditTools(registerOptional);
```

網頁版：`_registerComputerTools` 偵測沒有 `window.desktopAPI.computer` 就整個不註冊（`/computer` 在網頁版回「只有桌面版」）。`computer_host.js` 結尾有 `if (typeof module…) module.exports = FaComputerHost;`，在瀏覽器裡是 no-op。

## 3. IPC 與 `desktopAPI.computer`

channel 都是 `fa:computer:<名稱>`（`invoke`）；事件 `fa:computer:event`（`run-start`／`run-end`／`abort`／`state`）。

| `desktopAPI.computer.*` | 說明 | 需要原生視窗確認 |
|---|---|---|
| `status() capabilities()` | 狀態（預設關閉）／這台機器能做什麼與不能的原因 | |
| `setEnabled(on)` | 啟用（寫 `computerUseEnabled`）／停用 | 啟用要 |
| `setAuto(on)` | 本次工作階段自動核准 | 開啟要 |
| `pickScope()` `setScope({windowIds｜mode:'screen'})` | 範圍（視窗勾選視窗／指定） | 要 |
| `abort(reason)` `resume()` `addDeny(regex)` | 中止／恢復／追加拒絕規則 | |
| `listWindows({all})` `screenshot(o)` `cropShot(shotId, rect, o)` `diffShots(a,b,o)` | 視窗／截圖（限範圍） | |
| `uiTree(o)` `findElements(o)` `elementAt({x,y})` `elementInfo(id)` | 元件（AT-SPI／UIA／X11／Win32／RFB） | |
| `wait(o)` `sample(o)` `calibrate(o)` | 等待／連拍判動畫／座標校準 | |
| `plan(steps)` `execute(planId, o)` `run(steps, o)` | 動作批次（預覽→核准→執行） | 每批要（自動模式下已驗證的不用） |
| `remoteProbe(target)` `remoteConnect(o)` `remoteDisconnect(id)` `remoteList()` `remoteObjects(id,o)` | 遠端畫面（RFB 內建） | 連線要 |
| `setRemoteSecret(name,pw)` `deleteRemoteSecret(name)` `listRemoteSecrets()` | VNC 密碼（只存主行程、不回傳） | |
| `onEvent(cb)` | 事件（回傳取消訂閱函式） | |

## 4. 領域、任務提示、功能清冊（貼上用）

### 4.1 `computer_use` 領域（貼進 floating-assistant.js 的領域表，放在 `editors` 旁邊）

<!-- BLOCK:domain -->
```js
    computer_use: {
        enabled: true,
        label: '電腦操作（桌面版：看畫面、讀控制項、點擊與打字、視窗管理、遠端桌面；預設關閉，使用者核准每一批動作）',
        toolNames: ['computer_capabilities', 'computer_list_windows', 'computer_window_action', 'computer_ui_tree', 'computer_find_element', 'computer_element_action', 'computer_screenshot', 'computer_describe', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_drag', 'computer_actions', 'computer_wait', 'computer_remote_probe', 'computer_remote_connect', 'computer_remote_disconnect', 'computer_abort'],
        systemPrompt: '你負責幫使用者操作「這台電腦」（桌面版限定）。這個功能預設關閉，而且**啟用、指定範圍、自動核准都只有使用者能做**（他輸入 /computer enable、/computer scope），你不能代替他做、也不要叫他把範圍設成整個螢幕。固定流程：\n1. 先呼叫 computer_capabilities：沒啟用或沒指定範圍，就用一兩句話請使用者輸入 /computer enable 與 /computer scope，然後停下來，不要重試。\n2. computer_list_windows 找到目標視窗（看 in_scope；protected 是系統設定／驗證／密碼／付款視窗，絕對不碰；canvas 是遠端畫面的畫布）。\n3. **優先用無障礙元件**：computer_ui_tree／computer_find_element 找到元件，用 computer_element_action（invoke、toggle、select、set_value）操作，不用座標最穩。\n4. 沒有元件資訊（網頁畫布、遠端桌面、遊戲、舊程式）才用視覺：computer_screenshot（可加格線）→ computer_describe（mode:tiles／locate／explore，verify:true 會移動滑鼠看游標形狀與周圍變化來驗證；位置只有格子精度，點擊前一定要驗證）。截圖座標換回螢幕座標：screenX = origin.x + imageX / scale.x。\n5. 動作用 computer_actions 一次送一批（使用者只核准一次預覽）：click／type／key／scroll／drag／window_*／element_*。每一批使用者都會在原生視窗看到預覽，被拒絕就如實回報原因，不要換個方式繞過。\n6. 做完用 computer_screenshot 或 computer_wait 確認結果，不要盲目 sleep。\n7. 絕不在密碼欄打字，使用者要你輸入密碼就說你不能；不碰系統設定、付款、驗證視窗；一批最多 25 步。\n8. 遠端桌面：先 computer_remote_probe（RFB／RDP／NX／SPICE）；RFB 可以 computer_remote_connect（密碼只用 secret_name，不要把密碼放進對話），之後所有工具帶 target:"rfb:1"；RDP／NX／SPICE 只能辨識，要走視覺慢路徑。\n9. 使用者說停、覺得不對勁，立刻呼叫 computer_abort。',
        dynamicNote: '路由建議：使用者要你操作這台電腦的畫面（點擊、打字、按鍵、開關視窗、截圖看螢幕、讀視窗裡的按鈕與欄位、操作遠端桌面／VNC／虛擬機畫面）時委派這個領域。網頁自動化（瀏覽器分頁內的元素）走瀏覽器控制，不是這個。',
    },
```

### 4.2 `FA_TASK_TOOL_HINTS` 條目（貼在 `TASK-HINTS` 區塊的 push 序列裡，`_faTaskToolHints` 函式之前）

<!-- BLOCK:hint -->
```js
FA_TASK_TOOL_HINTS.push({
    id: 'computer_use',
    re: /(操作|控制|遙控|接管)[^，。\n]{0,6}(這台|我的|本機)?(電腦|桌面|視窗|螢幕|滑鼠)|(幫我|替我|請你?)[^，。\n]{0,6}(點擊|點一下|按下|打字|輸入|開啟|關閉|切換)[^，。\n]{0,10}(視窗|按鈕|畫面|桌面|螢幕|欄位)|computer[\s_-]?use|(截|擷取|拍)[^，。\n]{0,4}(螢幕|桌面|視窗畫面)|看(一下)?(我的)?(螢幕|畫面)|\bvnc\b|遠端桌面|remote\s*desktop|\brdp\b|virt-?manager|qemu\s*(視窗|畫面|主控台)|spy\+\+|控制項(樹|清單)|ui\s*automation|at-?spi|xdotool|nircmd/i,
    neg: /(怎麼|如何|為什麼|為何|是什麼|能不能|可不可以|可以嗎|有沒有|支援|設定|教我|原理)[\s\S]{0,12}(滑鼠|桌面|vnc|rdp|電腦操作)|瀏覽器分頁|chrome\s*(擴充|extension)|selenium|puppeteer|playwright|wake\s*on\s*lan|windows\s*server|網頁自動化/i,
    tools: ['computer_capabilities', 'computer_list_windows', 'computer_window_action', 'computer_ui_tree', 'computer_find_element', 'computer_element_action', 'computer_screenshot', 'computer_describe', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_drag', 'computer_actions', 'computer_wait', 'computer_remote_probe', 'computer_remote_connect', 'computer_remote_disconnect', 'computer_abort'],
    note: '【這個需求有專用工具：computer_*（電腦操作，桌面版限定）】使用者要你操作這台電腦。先 computer_capabilities：沒啟用或沒指定範圍，請使用者輸入 /computer enable 與 /computer scope（只有他能做），然後停下來。接著 computer_list_windows → 優先用 computer_ui_tree／computer_find_element＋computer_element_action（無障礙元件，不用座標）；沒有元件資訊才用 computer_screenshot＋computer_describe（視覺，點擊前要 verify）；動作用 computer_actions 一次一批，使用者會逐批核准；做完截圖確認。絕不在密碼欄打字、不碰系統設定／付款／驗證視窗；被拒絕就如實回報，不要繞過；使用者說停就 computer_abort。不要說自己沒有操作電腦的工具。',
});
```

### 4.3 `features/ai-features.yaml`（貼在 `files` 類別的 `desktop-ops` 之後）

<!-- BLOCK:yaml -->
```yaml
      - id: computer-use
        name: 電腦操作（看畫面、讀控制項、點擊打字、視窗管理、遠端桌面）
        summary: 桌面版限定、預設關閉：讓 AI 操作你指定的視窗——讀控制項樹（Linux AT-SPI／Windows UI Automation）、點擊與打字、視窗管理、截圖；沒有控制項資訊時用視覺模型（切格子問封閉問題、移動滑鼠看游標形狀驗證）；也能用內建 VNC（RFB）用戶端操作遠端畫面，並辨識 RDP／NX／SPICE。每一批動作先預覽、你在原生視窗核准才執行，隨時可用 Esc／Ctrl+Alt+Shift+Esc 中止；不會在密碼欄打字、不碰系統設定／付款／驗證視窗。
        how: { slash: ["/computer"], domain: computer_use, tools: [computer_capabilities, computer_list_windows, computer_window_action, computer_ui_tree, computer_find_element, computer_element_action, computer_screenshot, computer_describe, computer_click, computer_type, computer_key, computer_scroll, computer_drag, computer_actions, computer_wait, computer_remote_probe, computer_remote_connect, computer_remote_disconnect, computer_abort] }
        platforms: [desktop]
        samples: ["/computer enable", "/computer scope", "把記事本的視窗移到左邊並輸入 hello", "點一下那個『確定』按鈕", "/computer probe 192.168.1.20:5901", "看一下我現在螢幕上有什麼"]
        updated: 2026-10-25
```

## 5. 檔案一覽

- 主行程（根目錄，CommonJS，15 個）：`computer-png.js`、`computer-use-elements.js`、`computer-use-safety.js`、`computer-use-linux-parse.js`、`computer-use-linux.js`、`computer-use-atspi.js`、`computer-use-win-cs.js`、`computer-use-windows.js`、`computer-use-uia.js`、`computer-ws.js`、`rfb-codec.js`、`rfb-client.js`、`computer-remote.js`、`computer-use.js`、`computer-use-ipc.js`。
- renderer：`renderer/src/computer/computer_core.js`、`computer_vision.js`、`computer_host.js`、`main-wiring.patch`、本檔。
- 測試：`scripts/computer-tests/`（`*.test.js` 純邏輯，已加進 `scripts/run-core-tests.js`；`*.itest.js` 真實整合，需 Xvfb／Xvnc／Electron，缺工具自動略過）。
- 文件：`DESIGN.computer-use.md`。
