// tw_stock_db客製: 2026-09-16真機實測驗證過（不是理論假設）——Windows下
// `-p`需要一份PE header被patch成console subsystem的副本才能穩定接上終端機
// （見main.js頂端關於前導程式邏輯的完整說明，跟build/pe-subsystem-patch.js
// 的實作）。這支electron-builder的afterPack hook在GUI版.exe打包完成
// （Windows：`appOutDir`底下已經有`${productFilename}.exe`）後，複製一份、
// patch成console subsystem，取名`${productFilename}-cli.exe`放在同一個
// `appOutDir`——main.js執行時會依`process.execPath`的檔名判斷自己是哪一份
// （見那邊的前導程式邏輯），兩份exe放在同一個資料夾、共用同一份
// `resources/app.asar`，不用真的build兩次。
//
// 只在Windows平台需要這個機制——Linux/macOS的終端機沒有這個GUI/console
// subsystem的差異，`-p`已經能在同一個行程內正常輸出（AppImage版本實測
// 過），不用複製任何東西。
"use strict";
const path = require("path");
const fs = require("fs");
const { patchExeToConsoleSubsystem } = require("./pe-subsystem-patch.js");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const srcExe = path.join(context.appOutDir, exeName);
  if (!fs.existsSync(srcExe)) {
    console.warn(`[afterPack] 找不到${srcExe}，跳過console companion產生（-p在這個build裡可能無法正確顯示輸出）`);
    return;
  }

  const cliExeName = `${context.packager.appInfo.productFilename}-cli.exe`;
  const cliExe = path.join(context.appOutDir, cliExeName);
  fs.copyFileSync(srcExe, cliExe);
  try {
    const patched = patchExeToConsoleSubsystem(cliExe);
    if (patched) {
      console.log(`[afterPack] 已產生console模式companion: ${cliExe}`);
    } else {
      console.warn(`[afterPack] ${cliExe} 的Subsystem修改被跳過，-p可能無法正確顯示輸出`);
    }
  } catch (err) {
    console.error(`[afterPack] 修改${cliExe}的PE Subsystem失敗：${String((err && err.message) || err)}`);
    try { fs.unlinkSync(cliExe); } catch (_) {}
  }
};
