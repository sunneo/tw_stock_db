// tw_stock_db客製: 2026-09-16使用者要求——「讓使用者只看到一個程式，
// 執行時就自己切」：使用者永遠只需要打包好的那一個GUI版.exe（雙擊照常開
// 視窗），但`-p`需要的是console subsystem版本才能穩定接上終端機輸出（見
// pe-subsystem-patch.js/main.js的說明）。這支electron-builder的afterPack
// hook在GUI版.exe打包完成（Windows：`appOutDir`底下已經有
// `${productFilename}.exe`）、但portable target還沒把整個資料夾包裝成
// 最終單檔.exe之前，複製一份GUI版.exe、把複製那份的PE Subsystem改成
// console，取名`${productFilename}-cli.exe`放在同一個`appOutDir`——因為
// portable target會把`appOutDir`底下「所有」檔案一起打包進最終那個
// 自解壓縮的單檔.exe，這份console版副本會跟著GUI版一起被打包進去、執行時
// 解壓縮到同一個暫存資料夾，main.js在偵測到`-p`時就能在執行當下找到它、
// spawn它、把輸出/exit code轉發回來，使用者全程只需要執行那一個他熟悉的
// .exe檔案。
//
// 只在Windows平台需要這個機制——Linux/macOS的終端機不會有這個GUI/console
// subsystem的差異，`-p`已經能正常在同一個行程內輸出（AppImage版本實測
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
    // 修改失敗就直接把這份沒改成功的副本刪掉——main.js找不到它時會優雅地
    // 退回原本行程內執行（README已知限制），總比留一份「檔名看起來是console
    // 版、實際還是GUI subsystem」的誤導性副本好。
    try { fs.unlinkSync(cliExe); } catch (_) {}
  }
};
