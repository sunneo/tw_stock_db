# 電腦操作（computer use，桌面版限定）

> 對應 `DESIGN.TODO.four-directions.md` §3。**預設關閉**；只有桌面版（Electron，Windows／Linux）有。
> 弱模型（Florence-2 base、LLaVA-Interleave Qwen 0.5B）只負責「看」與回答很小的封閉問題；座標、比例、格子、驗證、安全全部由程式負責。

## 1. 一句話架構

```
AI 工具 computer_*（renderer，computer_host.js）        使用者 /computer（斜線指令）
        │ 只能經過 window.desktopAPI.computer.*（preload）           │
        ▼                                                              ▼
 主行程 computer-use-ipc.js ── 原生核准視窗／範圍選擇視窗／全域中止鍵／機密 ──→ 使用者
        │
 computer-use.js（門面：plan → 核准 → execute；每一步執行前重新驗證）
        │                │                         │
 computer-use-safety.js  平台後端                   遠端畫面
 （範圍、拒絕清單、密碼欄、   Linux：computer-use-linux(.js/-parse.js)  rfb-client.js（RFB/VNC，內建）
  速率、中止、預覽文字）       Windows：computer-use-windows.js         computer-remote.js（探測 RFB/RDP/NX/SPICE、
                              ＋ computer-use-win-cs.js（C#）            canvas 視窗偵測、remoteTarget）
 元件（物件）發現：AT-SPI（computer-use-atspi.js）、UI Automation（computer-use-uia.js）、X11／Win32 視窗樹
 共用：computer-png.js（PNG、裁切、差異、格線）、computer-use-elements.js（element 格式、搜尋、座標換算）、computer-ws.js（WebSocket）
```

視覺慢路徑與工具層（renderer，`renderer/src/computer/`）：`computer_core.js`（詞彙、動作整理、座標、答案解析、評分）、`computer_vision.js`（切磚、定位、驗證、探索）、`computer_host.js`（19 個 `computer_*` 工具＋`/computer`）。接線與要貼的片段見 `renderer/src/computer/INTEGRATION.md`。

## 2. 座標空間（重要）

所有回給 AI 的座標都是**螢幕座標：實體像素，左上角 (0,0)**（Windows 多螢幕可為負；程式啟動時宣告 per-monitor DPI aware，所以是實體像素）。截圖另外帶：

- `origin`：影像左上角在螢幕上的座標；`scale`：影像像素／螢幕像素（縮圖時 <1）。
- 影像上的框換回螢幕：`screenX = origin.x + imageX / scale.x`（`computer-use-elements.js` 與 `computer_core.js` 各有一份同樣的換算，測試比對兩邊一致）。
- 視窗有兩個矩形：`rect`＝客戶區（內容）、`frame`＝含標題列與邊框的外框；範圍檢查用 `frame`。X11 的客戶區座標取自 `xwininfo`／`xwininfo -root -tree` 的**絕對座標**（`wmctrl -G`／`xdotool getwindowgeometry` 在有重新父化的視窗管理員下會偏掉，實測差 5～29px，所以不用）。
- Wayland 原生視窗拿不到螢幕座標：`capabilities().features.a11y.coords` 會寫 `window-relative`。

## 3. 動作層

| 操作 | Linux（X11／XWayland） | Windows |
|---|---|---|
| 視窗清單（id、pid、行程、標題、類別、rect／frame、狀態、工作區、z） | `wmctrl -lGpx`＋`xwininfo -root -tree`＋`xprop`（state、frame extents、堆疊順序、作用中視窗） | `EnumWindows`＋DWM 外框＋`IsIconic/IsZoomed`＋虛擬桌面 COM；z＝列舉順序 |
| 聚焦／移動／縮放／最小化／最大化／還原／關閉 | `wmctrl -i -a/-e/-b/-c`、`xdotool windowminimize` | `SetForegroundWindow`（含 Alt 輕點繞過前景鎖）、`MoveWindow`（用 DWM 外框換算）、`ShowWindow`、`PostMessage WM_CLOSE` |
| 滑鼠 move／click／double／right／middle／drag／scroll | `xdotool`（刻意不用 `mousemove --sync`：游標已在該點時會卡死，實測踩過） | `SetCursorPos`＋`SendInput` |
| 鍵盤：組合鍵、Unicode 文字 | `xdotool key`／`xdotool type`（中文、Latin-1 實測可）；`mode:paste` 走剪貼簿 | `SendInput`（VK 對照）／`KEYEVENTF_UNICODE` |
| 剪貼簿 | `xclip`／`xsel`／`wl-clipboard` | `Get/Set-Clipboard` |
| 截圖 | `scrot`／`import`／`maim`／`xwd`（自己解碼 XWD）／`xfce4-screenshooter`／`gnome-screenshot`／`spectacle`／`grim`（挑有的）；一律抓全螢幕再自己裁切（工具間行為一致） | GDI `CopyFromScreen`（可選 `PrintWindow` 抓被蓋住的視窗） |
| 游標形狀 | python3 ctypes＋libXfixes（`XFixesGetCursorImage`：名稱如 `left_ptr`／`xterm`／`left_side`） | `GetCursorInfo` 比對 IDC_* |
| 等待 | `wait`（等視窗出現／畫面變化／畫面穩定）、`sample`（連拍判動畫） | 同 |

- **Windows 的 nircmd**：PATH 上有 `nircmd.exe`、而且所有螢幕縮放都是 100% 時才用它做滑鼠／按鍵／視窗動作（nircmd 不是 DPI aware）；視窗清單、Unicode 輸入、UI Automation 一律走 PowerShell。
- **PowerShell**：C# 原始碼（`computer-use-win-cs.js`）第一次用 `Add-Type` 編成 `%TEMP%\fa-computer-use\fa-cu-<雜湊>.dll`，之後每個動作只是一小段腳本，用 `powershell -NoProfile -NonInteractive -STA -EncodedCommand` 執行；編譯那段太長（>命令列上限）自動改暫存 `.ps1`＋`-File`。參數一律是 base64 JSON（沒有字串拼接，沒有注入面）；輸出是純 ASCII JSON（非 ASCII 全 `\uXXXX`，不受字碼頁影響）。
- **`capabilities()`** 精確說明這個 session 什麼能用、為什麼不能：缺的工具（附安裝指令）、Wayland 限制、GNOME 要 Window Calls 擴充、KDE 要 kdotool、ydotool 要 ydotoold＋`/dev/uinput`、portal RemoteDesktop 存在但需互動授權（未實作）。缺工具時所有操作回 `{ok:false, error, why}`，不丟例外。

### Wayland／KDE／GNOME（全部「未實測」）
依各工具文件寫的：KDE 用 `kdotool`；GNOME 用 `gdbus`（Window Calls 擴充 `org.gnome.Shell.Extensions.Windows`，或 `Shell.Eval`——新版 GNOME 已停用）；輸入用 `ydotool`（絕對座標在多螢幕／加速度下可能偏，要先 `calibrate`）、`wtype`（只有 wlroots 類合成器）；截圖 `grim`／`spectacle`／`gnome-screenshot`。XWayland 下 X 工具只對 XWayland 用戶端有效。這些路徑只有解析器與指令組裝的 fixture 測試。

## 4. 物件（控制項）發現——Spy++／winapi

統一的 element 格式（`computer-use-elements.js` 開頭有完整說明）：`id`（同一次快照內穩定、可重新解析）、`source`（atspi／uia／win32／x11／rfb／vlm）、`role`（封閉詞彙，見 §8）、`name`、`description`、`value`、`text`、`automationId`、`className`、`rect`（螢幕座標）、`enabled`、`visible`、`focused`、`selected`、`checked`、`isPassword`、`states`、`actions`（`invoke｜toggle｜select｜set_value｜focus`）、`window`、`app`、`pid`、`confidence`（vlm／rfb）。

- **Linux AT-SPI**：`python3 -c`（`gi.repository.Atspi`）helper，請求用 stdin JSON：`apps／tree／find／at（elementAt）／focused／act`。id＝`atspi:<pid>:<child 索引路徑>:<role|name 指紋>`；重新解析先走路徑、指紋對不上就在子樹依指紋重找（最近矩形優先）。GTK／Qt／Java 直接可用；**Electron／Chromium 需要 a11y 匯流排開啟**（`--force-renderer-accessibility` 單獨不夠，實測還要 `org.a11y.Status.IsEnabled=true`，像螢幕閱讀器那樣）。
- **Windows UI Automation**：C# `FaUia`（ControlView／RawView walker）輸出 ControlType、Name、AutomationId、ClassName、BoundingRectangle、IsEnabled、IsOffscreen、IsPassword、支援的模式（Value／Invoke／Toggle／SelectionItem／ExpandCollapse）與值；id＝`uia:<hwnd>:<路徑>:<指紋>`；另有 Win32 子視窗樹（hwnd、類別、文字、矩形）。
- **退路**：沒有 a11y 資訊時 `ui_tree` 退到 X11 視窗樹（`xwininfo -root -tree`）／Win32 子視窗樹（只有視窗層級），並說明「改用視覺模型」。
- **動作優先走無障礙 API**（invoke／toggle／select／focus／set_value），失敗時 invoke／toggle／select 退回點元件中心（**重新過一次範圍／被蓋住檢查**；`set_value` 不退回座標）。元件快照記下當時視窗外框，視窗關了或移動了就拒絕用舊座標（`elementStale`）。

## 5. 視覺慢路徑（`computer_vision.js`，程式負責幾何與驗證）

1. **切磚** `tileScan`：截圖切成每格約 256px，每格只問一題封閉問題（`button／textbox／checkbox／menu／tab／sash／icon／…／none`，一個字就能答），答案用同義詞表解析成封閉詞彙，不認得就是 `null`（不亂猜）。位置由格子座標決定。
2. **定位** `locate`：「有沒有 X？」逐格 yes/no，有的格再切 3×3 縮小範圍。
3. **驗證** `verify`（探索 → 移動滑鼠 → 重拍 → 比對）：對最可疑的候選送出 `hover_probe` 步驟（只移動、不點擊；整批一次核准）：主行程把滑鼠停靠在旁邊、拍一張、移到目標、再拍一張，回報**游標形狀變化**（手＝可點擊、I 字＝可輸入、`left_side`／`sb_h_double_arrow`＝調整大小／sash）與**周圍區域變化**（hover 效果）。沒有任何反應的候選降信心。RFB 目標用 Cursor 偽編碼讀游標形狀。
4. **動畫**：`sample` 對同一區塊連拍，持續在變＝動畫，建議改用連續觀察而非單張截圖。
5. **校準** `calibrate`：移動到已知點、讀回實際位置（X11 讀 `getmouselocation`；沒有就用「有／無游標」兩張截圖比對），線性擬合座標比例與偏移並量移動延遲；比例明顯不是 1 時之後的點擊自動補償（ydotool 絕對座標那類情況）。
6. 找到的候選都用同一個 element 格式（`source:'vlm'`，`states:['unverified']`，`confidence` 低），驗證後 `verified` 記錄游標形狀與變化。

## 6. 目標是畫布：遠端桌面、VNC、KVM、瀏覽器 canvas

- **偵測**：行程名稱（mstsc、xfreerdp、wlfreerdp、remmina、vncviewer、tigervnc、vinagre、virt-viewer、virt-manager、qemu、nxplayer、spicy…）、視窗類別、瀏覽器標題（noVNC、Guacamole、Proxmox Console…）→ `list_windows` 的 `canvas` 欄位；這種視窗沒有元件可讀，`ui_tree` 會直接建議走視覺模型或 `remote_connect`。
- **協定探測** `remote_probe(host:port | ws://…)`：伺服器先開口的（RFB 橫幅、SSH、NX）、否則送 RDP X.224 Connection Request（全部協定＋只要 Standard 各一次，回報選了 TLS／CredSSP(NLA)／Standard、失敗碼）、SPICE link、TLS 包裝、HTTP（noVNC／Guacamole／Proxmox 頁面特徵）、WebSocket（noVNC／websockify 第一個訊息是 RFB 橫幅）。
- **RFB（真的有實作）**：`rfb-client.js`，純 Node。握手 3.3／3.7／3.8、安全類型 None 與 **VNC 驗證（自己實作 DES，因為 BoringSSL／OpenSSL3 不一定有）**、SetPixelFormat（協商成 RGB888）、SetEncodings、增量 FramebufferUpdateRequest、解碼 **Raw／CopyRect／RRE／Hextile／ZRLE（持續狀態的純 JS inflate，因為所有 ZRLE 矩形共用同一條 zlib 串流）／Cursor／DesktopSize／ExtendedDesktopSize**、輸入 PointerEvent／KeyEvent（Unicode keysym）／ClientCutText、TCP 與 WebSocket 傳輸（自己寫的最小 RFC 6455 用戶端）。**不支援**：Tight、TLS／VeNCrypt／RA2／ARD 等加密安全類型——伺服器只提供這些時明確報錯並說怎麼改。
  - RFB 沒有繪圖物件：`remote_objects`（`ui_tree` 帶 `target`）從**損壞矩形、CopyRect 搬移、游標形狀與位置**推出候選區（合併相鄰矩形、整張重送不算、持續更新的區塊標 `animated`），交給視覺模型命名。畫面緩衝解碼後可截圖／裁切，輸入走協定——**完全不需要任何 OS 工具**。
  - 機密：`remote_connect` 只帶 `secretName`；密碼存在主行程的 `userData/secrets.json`（欄位 `COMPUTER_REMOTE_SECRETS`，權限 600），或環境變數 `FA_VNC_PASSWORD_<名稱大寫>`；renderer 只能設定／刪除／列名稱，**不能讀回**；不進日誌、不進錯誤訊息。
- **RDP／NX／SPICE（老實說）**：只做到**辨識協定與安全等級**（例如「RDP 選了 NLA」「也接受舊式 Standard Security（RC4）」）。完整 RDP 繪圖指令（RDP5/6 orders、glyph）沒有函式庫可用，沒有實作：回報「協定可辨識，但需要完整 RDP 客戶端才能取得繪製物件；改走 VLM 慢路徑」。有 `xfreerdp`／`wlfreerdp` 時 `computer-remote.js` 能組出命令（密碼走 stdin 不進 argv）開一個視窗當畫布，**這段沒有實跑**。
- **`remoteTarget`**：`{kind:'window'|'rfb'|'rdp'|'nx'|'spice'|'canvas', capabilities:{objects:'protocol'|'a11y'|'vlm', input:'os'|'protocol'}}`，RFB＝`protocol／protocol`，畫布視窗＝`vlm／os`。工具以 `target:"rfb:1"` 指向遠端連線，其餘參數相同。

## 7. 安全模型（`computer-use-safety.js` ＋ `computer-use-ipc.js`）

1. **預設關閉**：`desktop-settings.json` 的 `computerUseEnabled`。**啟用、自動核准、指定範圍**這三件提高權限的事，一律在**主行程的原生視窗**由使用者確認（renderer 無法自己核准自己）；沒有任何 `computer_*` 工具能做這三件事。重新啟動後旗標保留，**範圍與自動核准不保留**。
2. **預覽與核准**：每一批動作先 `plan`（驗證＋預覽文字：做什麼、在哪裡、哪個視窗、警告），使用者在原生視窗核准才 `execute`；沒有核准函式＝一律拒絕（fail-closed）。計畫單次使用、2 分鐘過期。使用者本次工作階段打開「自動」後，已驗證的點擊／按鍵不再逐批問；**看不出焦點是不是密碼欄的打字（無 a11y 資訊、遠端畫面、連線）自動模式下仍然要問**；同一批裡前面的步驟會改變焦點時，打字前才檢查焦點，看不出來就當場問。核准視窗搶走焦點後，會把焦點還給核准前的視窗。
3. **範圍**：只能對使用者勾選的視窗（或「整個螢幕」）。座標必須落在該視窗**現在的**外框內，**而且那一點最上面的視窗就是它**（被別的視窗蓋住就拒絕；同一批裡 `window_focus` 會在計畫階段模擬「拉到最上面」）。每一步執行前**重新驗證**（視窗可能已移動、被蓋住、焦點變了）。截圖／元件樹／搜尋同樣受範圍限制；整個螢幕截圖要範圍是「整個螢幕」。已知限制：彈出選單（override-redirect 視窗）不在視窗清單裡，無法判斷它蓋住了點擊位置。
4. **絕不在密碼欄打字**：AT-SPI `password text`／UIA `IsPassword`（`element_set_value` 也擋；貼上 `ctrl+v`／`shift+insert` 同樣算打字）。a11y 回報的焦點元件必須屬於作用中視窗的行程才採信。
5. **拒絕清單**（標題／類別／行程）：系統設定、驗證／提權（polkit、UAC、sudo…）、密碼／憑證管理員、付款／金融；使用者可用 `/computer deny <regex>` 追加（只會更嚴格）。**助理自己的視窗**永遠不碰（pid 比對＋標題比對）——否則 AI 可以自己按核准鈕。被擋的視窗在清單裡標題會被遮蔽、不能放進範圍。危險按鍵不送：Ctrl+Alt+Del／Backspace／F1-12、Super／Win、Alt+Tab／F2、Ctrl+Alt+T／L…
6. **速率與上限**：每批最多 25 步、每分鐘 90 個動作、動作最小間隔 40ms、單次打字 400 字、整個工作階段 1000 個動作、連續失敗 5 次自動中止。
7. **中止**：全域快捷鍵 `Ctrl+Alt+Shift+Esc`（只在動作執行期間註冊，不長期佔用按鍵）、renderer 按 Esc、提示列按鈕、`computer_abort`、`/computer abort`。中止＝停止整批、放開按住的滑鼠鍵與修飾鍵、之後一律拒絕直到使用者 `/computer resume`（或重新啟用）。

## 8. 封閉詞彙

- **動作（op，24 個）**：`move click double_click right_click middle_click drag scroll hover_probe type key window_focus window_move window_resize window_minimize window_maximize window_restore window_close element_invoke element_set_value element_toggle element_select element_focus clipboard_set wait`（renderer `computer_core.js` 與主行程 `computer-use-safety.js` 各有一份，測試比對一致）。
- **視窗動作**：`focus move resize minimize maximize restore close`；**元件動作**：`invoke set_value toggle select focus`；**按鈕**：`left right middle`。
- **角色（element.role）**：`button checkbox radio textbox password label link image menu menuitem menubar tab tablist list listitem tree treeitem table row cell combobox slider spinbutton scrollbar progressbar toolbar statusbar titlebar window dialog pane group separator tooltip document heading canvas app unknown`。
- **遠端目標種類**：`window rfb rdp nx spice canvas`；**objects 來源**：`protocol a11y vlm`；**input 路徑**：`os protocol`。
- **視覺模型答案詞彙**：`button textbox checkbox radio menu tab toolbar titlebar scrollbar sash icon link image text list slider dialog none`。
- **游標語意**：`clickable text sash-horizontal sash-vertical resize-corner move busy crosshair help forbidden default custom other`。

## 9. 工具、指令、IPC

- 工具（19 個，全是 `computer_` 開頭）：`capabilities list_windows window_action ui_tree find_element element_action screenshot describe click type key scroll drag actions wait remote_probe remote_connect remote_disconnect abort`。
- 斜線指令：`/computer [status|enable|disable|scope|auto|abort|resume|windows|probe|connect|disconnect|secret|deny|calibrate|help]`。
- IPC（`fa:computer:*`，preload 暴露成 `desktopAPI.computer.*`）：`status capabilities setEnabled setAuto pickScope setScope abort resume addDeny listWindows screenshot cropShot diffShots uiTree findElements elementAt elementInfo wait sample calibrate plan execute run remoteProbe remoteConnect remoteDisconnect remoteList remoteObjects setRemoteSecret deleteRemoteSecret listRemoteSecrets`；事件 `fa:computer:event`（`run-start／run-end／abort／state`）。

## 10. 平台矩陣：這台機器實測過的 vs 未實測

實測環境：Linux（Ubuntu 系）、自己起的 **Xvfb**（絕不碰真實畫面）＋ dbus ＋ AT-SPI ＋ xfwm4（XFCE 的視窗管理員）、Node 20、Electron 44。

| 項目 | 狀態 | 怎麼驗證的 |
|---|---|---|
| X11 視窗清單／聚焦／移動／縮放、真實 xterm 點擊與打字（含中文） | ✅ 實測 | `x11.itest.js`（檔案內容驗證打字真的送到） |
| X11 範圍／被蓋住／拒絕清單／中止／速率／核准流程 | ✅ 實測 | `x11.itest.js` |
| X11 最小化／最大化／還原／關閉（用視窗狀態驗證）、`drag`（拖曳選取＋middle_click 貼上）、`double_click`（選字）、`right_click`、`scroll`（xterm 捲動緩衝）、`clipboard_set`（xsel 讀回） | ✅ 實測 | `x11.itest.js` |
| 截圖（scrot）、裁切、縮放比、格線、`cropShot` | ✅ 實測 | `x11.itest.js`、`vnc.itest.js`（與 xwd 逐點比對） |
| AT-SPI：GTK（zenity）樹、find、elementAt、focused、set_value、invoke、密碼欄角色 | ✅ 實測 | `x11.itest.js` |
| AT-SPI：Electron（Chromium）元件樹 | ✅ 實測 | `electron.itest.js`（要開 a11y 匯流排） |
| 游標形狀（text／default／sash）與探索 | ✅ 實測 | `x11.itest.js`、`vnc.itest.js` |
| RFB 用戶端 vs 真 TigerVNC `Xvnc`（None 與 VNC 驗證 DES）、x11vnc、websockify | ✅ 實測 | `vnc.itest.js`（打字進 xterm、畫面與 xwd／scrot 比對、損壞矩形、Cursor、剪貼簿） |
| RFB 各編碼 Raw／RRE／Hextile／ZRLE／CopyRect／DesktopSize | ✅ 假伺服器逐像素；真實伺服器實際用到 RRE＋ZRLE（Hextile 只有假伺服器） | `rfb_client.test.js`、`vnc.itest.js` |
| 協定探測：RFB（真伺服器）、RFB over WebSocket（真 websockify） | ✅ 實測 | `vnc.itest.js` |
| 協定探測：RDP、SPICE、NX、SSH、HTTP/noVNC | ⚠️ 只有假伺服器／封包 fixture | `remote.test.js` |
| 真 Electron 跑真 main.js＋preload（套 `main-wiring.patch`）：IPC、原生核准視窗（由測試扮演使用者用 AT-SPI 按鈕）、全域中止鍵、機密 | ✅ 實測 | `electron.itest.js` |
| 視覺慢路徑（切磚／定位／驗證）邏輯 | ✅ 用**假視覺模型**測；**沒有真的跑 Florence-2／LLaVA** | `computer_vision.test.js` |
| Windows 全部（PowerShell 腳本、C#、UIA、nircmd、DPI、多螢幕） | ❌ **未實測**（沒有 Windows）。腳本產生／解析有 fixture 測試；C# 用 mono `mcs -langversion:5` 編譯檢查通過、`FaJson`／指紋演算法在 mono 上實跑與 JS 一致 | `windows.test.js` |
| Wayland、KDE（kdotool）、GNOME（gdbus）、ydotool、wtype、grim、portal | ❌ **未實測**，只有解析器／能力矩陣 fixture | `linux_parse` 相關測試、`x11.itest.js` 的 capabilities |
| 多螢幕／HiDPI 縮放 >1 的座標換算 | ❌ 未實測（`xrandr` 解析有 fixture；校準在縮放 1 的環境驗證） | — |
| RDP 實際連線、xfreerdp 開視窗、NX／SPICE 畫面 | ❌ 未實作／未實測（見 §6） | — |

## 11. 已知限制

- 彈出選單（override-redirect）不在視窗清單，被蓋住檢查看不到它。
- `xdotool type` 用暫時重新對應按鍵輸入 Unicode；少數應用程式（部分遠端桌面）收不到，改用 `mode:'paste'`。
- Wayland 原生視窗：沒有螢幕座標、不允許其他程式送輸入事件（要 ydotool／portal）。
- RFB：不支援 Tight 與加密安全類型；只支援 8 bit 通道的 true color 協商。
- 視窗截圖是「螢幕上看到的」，被蓋住的部分是別的視窗的內容（Windows 可用 `occluded` 走 `PrintWindow`，未實測）。
- 弱視覺模型會漏看、幻覺；所以只問封閉問題，位置只有格子精度，點擊前要驗證。
- 動作批次的 `plan` 是預覽時的快照，執行時每一步會再檢查，但仍可能有極短的競爭窗口（視窗在檢查與送出事件之間被移動）。

## 12. 測試怎麼跑

- 純邏輯（已加進 `scripts/run-core-tests.js`）：`node scripts/computer-tests/{png,safety,rfb_codec,rfb_client,remote,windows,ipc,computer_core,computer_vision,computer_host}.test.js`。
- 真實整合（需要 Xvfb／xdotool／wmctrl／xterm／xfwm4／zenity／Xvnc／x11vnc／websockify／electron；缺工具自動略過；**絕不使用 `DISPLAY` 指向的真實畫面**）：`node scripts/computer-tests/x11.itest.js`、`vnc.itest.js`、`electron.itest.js`（約 30～150 秒）。共用的 `xenv.js` 自選沒人用的顯示編號、明確組子行程環境。
