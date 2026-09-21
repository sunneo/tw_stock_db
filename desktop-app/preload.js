// contextBridge——renderer（含floating-assistant.js自己動態載入的任何
// 第三方CDN函式庫）只看得到`window.desktopAPI`這個窄接口，完全碰不到
// Node的require/process/fs等原始能力，真正的檔案/程式執行動作都在
// main.js的ipcMain handler裡做、且都會先做root範圍檢查。
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  // preload script本身一直都有Node的`process`可用（跟renderer的
  // contextIsolation無關，只有preload/main才看得到），這裡直接同步暴露
  // 平台資訊——2026-09-15使用者要求desktop_ops domain要知道自己現在跑在
  // Windows還是Linux(/macOS)，才能決定要用`dir`還是`ls`、要不要提供
  // tmux（POSIX限定工具）等。純靜態資訊，不用IPC往返。
  platform: {
    name: process.platform,
    isWindows: process.platform === "win32",
    isLinux: process.platform === "linux",
    isMac: process.platform === "darwin",
  },
  roots: {
    list: () => ipcRenderer.invoke("fa:roots:list"),
    add: (label) => ipcRenderer.invoke("fa:roots:add", { label }),
    addByPath: (folderPath, label) => ipcRenderer.invoke("fa:roots:addByPath", { folderPath, label }),
    rename: (id, label) => ipcRenderer.invoke("fa:roots:rename", { id, label }),
    remove: (id) => ipcRenderer.invoke("fa:roots:remove", { id }),
    // dialog.showOpenDialog在這台機器不會顯示（見main.js showFolderBrowserWindow
    // 說明），這個是自己刻的資料夾瀏覽器視窗，回傳選中的絕對路徑字串或null。
    browse: (startPath) => ipcRenderer.invoke("fa:roots:browse", { startPath }),
  },
  // window.prompt()在這個Electron build完全不會顯示（Electron本身從未實作這個
  // API，不是這個app的bug），confirm()同樣不可靠——見bootstrap.js對
  // window.prompt/confirm/alert的全域覆蓋，這三個用ipcRenderer.sendSync()
  // （renderer執行緒真的會被阻塞到main行程把event.returnValue設好為止，即使
  // main行程那端的handler內部是async、中間await了使用者在彈出視窗裡的操作）
  // 讓呼叫端維持跟原生prompt()/confirm()/alert()一樣的同步呼叫語意，
  // floating-assistant.js核心完全不用改。
  dialogs: {
    prompt: (message, defaultValue) => ipcRenderer.sendSync("fa:sync-prompt", { message, defaultValue }),
    confirm: (message) => ipcRenderer.sendSync("fa:sync-confirm", { message }),
    alert: (message) => ipcRenderer.sendSync("fa:sync-alert", { message }),
  },
  fs: {
    stat: (rootId, relPath) => ipcRenderer.invoke("fa:fs:stat", { rootId, relPath }),
    readdir: (rootId, relPath) => ipcRenderer.invoke("fa:fs:readdir", { rootId, relPath }),
    mkdir: (rootId, relPath) => ipcRenderer.invoke("fa:fs:mkdir", { rootId, relPath }),
    readFile: (rootId, relPath, encoding) => ipcRenderer.invoke("fa:fs:readFile", { rootId, relPath, encoding }),
    writeFile: (rootId, relPath, payload) => ipcRenderer.invoke("fa:fs:writeFile", { rootId, relPath, ...payload }),
    remove: (rootId, relPath, recursive) => ipcRenderer.invoke("fa:fs:remove", { rootId, relPath, recursive }),
  },
  // 2026-09-15使用者明確要求「桌面版不應該有任何限制」——這組跟上面的
  // `fs`（root-scoped，先授權才能碰）並存，直接吃絕對路徑，main.js的
  // fa:rawfs:*完全不做root範圍檢查，唯一邊界是OS本身的檔案權限。
  rawfs: {
    stat: (path) => ipcRenderer.invoke("fa:rawfs:stat", { path }),
    readdir: (path) => ipcRenderer.invoke("fa:rawfs:readdir", { path }),
    mkdir: (path) => ipcRenderer.invoke("fa:rawfs:mkdir", { path }),
    readFile: (path, encoding) => ipcRenderer.invoke("fa:rawfs:readFile", { path, encoding }),
    writeFile: (path, payload) => ipcRenderer.invoke("fa:rawfs:writeFile", { path, ...payload }),
    remove: (path, recursive) => ipcRenderer.invoke("fa:rawfs:remove", { path, recursive }),
    find: (path, pattern, maxDepth, maxResults) => ipcRenderer.invoke("fa:rawfs:find", { path, pattern, maxDepth, maxResults }),
  },
  exec: {
    getSettings: () => ipcRenderer.invoke("fa:exec:getSettings"),
    setSettings: (patch) => ipcRenderer.invoke("fa:exec:setSettings", patch),
    run: (opts) => ipcRenderer.invoke("fa:exec:run", opts),
  },
  // coding domain專用（TODO.md Phase 4）：語意跟rawfs的byte級檔案操作不同
  // （dry-run、hunk診斷、repo層級操作），獨立命名空間。
  codingWorkspace: {
    open: (sourceAbs, opts) => ipcRenderer.invoke("fa:codingws:open", { sourceAbs, ...(opts || {}) }),
    status: (workspaceAbs) => ipcRenderer.invoke("fa:codingws:status", { workspaceAbs }),
    deploy: (workspaceAbs, opts) => ipcRenderer.invoke("fa:codingws:deploy", { workspaceAbs, ...(opts || {}) }),
    discard: (workspaceAbs) => ipcRenderer.invoke("fa:codingws:discard", { workspaceAbs }),
  },
  browserControl: {
    call: (cmd, args, timeoutMs) => ipcRenderer.invoke("fa:bc:call", { cmd, args, timeoutMs }),
    status: () => ipcRenderer.invoke("fa:bc:status"),
    regenerateToken: () => ipcRenderer.invoke("fa:bc:regenerateToken"),
  },
  git: {
    applyPatch: (cwdAbs, patch, opts) => ipcRenderer.invoke("fa:git:applyPatch", { cwdAbs, patch, ...(opts || {}) }),
    inspect: (cwdAbs, mode, opts) => ipcRenderer.invoke("fa:git:inspect", { cwdAbs, mode, ...(opts || {}) }),
  },
  // 2026-09-15使用者明確要求「執行指令也要有有bash, tmux的能力」——POSIX
  // 限定（見main.js requireTmuxAvailable），Windows呼叫會得到明確的錯誤
  // 訊息而不是靜默失敗。
  tmux: {
    start: (name, command, cwd) => ipcRenderer.invoke("fa:tmux:start", { name, command, cwd }),
    sendKeys: (name, keys, enter) => ipcRenderer.invoke("fa:tmux:sendKeys", { name, keys, enter }),
    capture: (name, lines) => ipcRenderer.invoke("fa:tmux:capture", { name, lines }),
    list: () => ipcRenderer.invoke("fa:tmux:list"),
    kill: (name) => ipcRenderer.invoke("fa:tmux:kill", { name }),
  },
  config: {
    getLocalProxyPort: () => ipcRenderer.invoke("fa:config:getLocalProxyPort"),
    getLocalProxyBase: () => ipcRenderer.invoke("fa:config:getLocalProxyBase"),
    getProxyMode: () => ipcRenderer.invoke("fa:config:getProxyMode"),
  },
  // status()只回報有沒有設定（布林值），set()是renderer唯一能把金鑰值送進
  // 主行程的方向——真正的NVAPI_KEY/OPENROUTER_API_KEY內容不會被讀回
  // renderer，見main.js的fa:secrets:*說明。
  secrets: {
    status: () => ipcRenderer.invoke("fa:secrets:status"),
    set: (patch) => ipcRenderer.invoke("fa:secrets:set", patch),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("fa:shell:openExternal", url),
  },
  // tw_stock_db客製: 2026-09-16使用者要求桌面版「在不同資料夾執行」時
  // 各自獨立的對話+設定——見main.js fa:workspace:*系列handler的說明。
  // init()只在app啟動、bootstrap.js建構FloatingAssistant之前呼叫一次；
  // persist()是bootstrap.js的window.localStorage代理每次setItem/
  // removeItem/clear都會呼叫的寫入端；switch()是Advance Settings「切換
  // 工作區資料夾」那顆按鈕觸發的動作。全部走一般的invoke（非同步）——
  // 跟window.prompt/confirm/alert那組不一樣，這裡完全不需要
  // sendSync/event.returnValue那套同步阻塞機制：初始載入bootstrap.js的
  // main() IIFE本來就是async、建構FloatingAssistant之前已經在await別的
  // IPC了，之後的讀取（localStorage.getItem）全部從renderer自己維護的
  // 記憶體快照回答，不需要每次都往main行程跑一趟，見bootstrap.js的
  // 說明。
  workspace: {
    init: () => ipcRenderer.invoke("fa:workspace:init"),
    get: () => ipcRenderer.invoke("fa:workspace:get"),
    persist: (data) => ipcRenderer.invoke("fa:workspace:persist", { data }),
    switchTo: (newFolder, copiedData) => ipcRenderer.invoke("fa:workspace:switch", { newFolder, copiedData }),
  },
});
