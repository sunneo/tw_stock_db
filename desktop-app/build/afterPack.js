// tw_stock_db客製: 2026-09-16——把已經用PyInstaller build好的
// `launcher/dist/FloatingAssistant.exe`（真正的console subsystem
// launcher，見launcher/launcher.py的完整說明）複製進electron-builder的
// `appOutDir`裡，讓它跟`FloatingAssistantApp.exe`放在同一個資料夾——
// electron-builder的`dir`跟`nsis`兩個target在同一次呼叫下會共用同一個
// `appOutDir`（見build.ps1，只會真正pack一次），所以這裡複製一次，`dir`
// 輸出的資料夾跟`nsis`安裝出來的資料夾都會有這支launcher。
//
// build.ps1會在呼叫electron-builder**之前**先build好launcher.exe，這裡才
// 找得到來源檔案；如果順序顛倒（launcher還沒build），這裡會直接跳過並
// 印警告，不會讓整個electron-builder流程失敗（`dir`/`nsis`本身的封裝結果
// 仍然有效，只是缺少`-p`能力，使用者仍然可以拿到GUI app）。
//
// 只在Windows平台需要——Linux/macOS的`-p`已經能在同一個行程內正常輸出
// （AppImage版本實測過），不需要任何launcher。
"use strict";
const path = require("path");
const fs = require("fs");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const launcherSrc = path.join(__dirname, "..", "launcher", "dist", "FloatingAssistant.exe");
  if (!fs.existsSync(launcherSrc)) {
    console.warn(`[afterPack] 找不到${launcherSrc}——build.ps1應該要在呼叫electron-builder之前先build好launcher，跳過複製（-p將無法使用，GUI本身不受影響）`);
    return;
  }
  const dest = path.join(context.appOutDir, "FloatingAssistant.exe");
  fs.copyFileSync(launcherSrc, dest);
  console.log(`[afterPack] 已複製launcher: ${dest}`);
};
