// contextBridge——renderer（含floating-assistant.js自己動態載入的任何
// 第三方CDN函式庫）只看得到`window.desktopAPI`這個窄接口，完全碰不到
// Node的require/process/fs等原始能力，真正的檔案/程式執行動作都在
// main.js的ipcMain handler裡做、且都會先做root範圍檢查。
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  roots: {
    list: () => ipcRenderer.invoke("fa:roots:list"),
    add: (label) => ipcRenderer.invoke("fa:roots:add", { label }),
    rename: (id, label) => ipcRenderer.invoke("fa:roots:rename", { id, label }),
    remove: (id) => ipcRenderer.invoke("fa:roots:remove", { id }),
  },
  fs: {
    stat: (rootId, relPath) => ipcRenderer.invoke("fa:fs:stat", { rootId, relPath }),
    readdir: (rootId, relPath) => ipcRenderer.invoke("fa:fs:readdir", { rootId, relPath }),
    mkdir: (rootId, relPath) => ipcRenderer.invoke("fa:fs:mkdir", { rootId, relPath }),
    readFile: (rootId, relPath, encoding) => ipcRenderer.invoke("fa:fs:readFile", { rootId, relPath, encoding }),
    writeFile: (rootId, relPath, payload) => ipcRenderer.invoke("fa:fs:writeFile", { rootId, relPath, ...payload }),
    remove: (rootId, relPath, recursive) => ipcRenderer.invoke("fa:fs:remove", { rootId, relPath, recursive }),
  },
  exec: {
    getSettings: () => ipcRenderer.invoke("fa:exec:getSettings"),
    setSettings: (patch) => ipcRenderer.invoke("fa:exec:setSettings", patch),
    run: (opts) => ipcRenderer.invoke("fa:exec:run", opts),
  },
  config: {
    getLocalProxyPort: () => ipcRenderer.invoke("fa:config:getLocalProxyPort"),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("fa:shell:openExternal", url),
  },
});
