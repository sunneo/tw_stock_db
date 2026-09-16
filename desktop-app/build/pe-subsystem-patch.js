// tw_stock_db客製: 2026-09-16使用者要求——Windows下`-p`完全看不到任何輸出
// （即使main.js那邊已經修好「console.log後馬上app.exit()把輸出截斷」的
// race，Windows下還是完全沒有反應，Linux AppImage版本則正常，見main.js
// 頂端`_resolveConsoleCompanionExePath`一帶的說明）——根因是electron-builder
// 打包出來的.exe，PE header裡的Subsystem欄位是Windows GUI（2），不是
// console/CUI（3）。GUI subsystem的行程在很多cmd.exe/PowerShell呼叫情境下
// 拿到的stdin/stdout/stderr handle並不可靠（已實測驗證，不是理論假設），
// console subsystem的行程則是Windows loader明確、單純支援的標準行為，
// 任何shell呼叫都能正確attach/繼承目前終端機的I/O。
//
// 這支模組只做一件事：把一份.exe（跟原本GUI版一模一樣的程式碼，只是複製
// 出來的另一份檔案）PE header裡的Subsystem欄位從2改成3，不動任何其他
// bytes、不重算PE checksum（一般使用者模式.exe執行不會強制驗證這個
// checksum，只有部分系統驅動/簽章驗證情境才會查，這裡不是那種情境）。
// 這是社群多個「Electron GUI app也想支援CLI模式」專案共用的既有作法，
// 不是這次發明的黑魔法——PE32/PE32+這兩種格式的Subsystem欄位剛好都位於
// Optional Header起點+68 bytes（PE32+把4-byte的BaseOfData欄位拿掉、
// ImageBase從4-byte變8-byte，兩者相抵，後面所有欄位的相對offset完全對齊），
// 所以不需要分別處理兩種格式。
"use strict";
const fs = require("fs");

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

/**
 * 把指定路徑的PE執行檔（.exe）之Subsystem欄位由GUI(2)改成console(3)。
 * 回傳true代表真的修改了，false代表跳過（不是預期中的GUI subsystem，
 * 為了安全不強行覆蓋）。任何格式不符預期的情況都丟錯，不悄悄放過。
 */
function patchExeToConsoleSubsystem(exePath) {
  const fd = fs.openSync(exePath, "r+");
  try {
    const dosHeader = Buffer.alloc(64);
    fs.readSync(fd, dosHeader, 0, 64, 0);
    if (dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`${exePath} 不是有效的PE執行檔（缺少MZ簽名）`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);

    const peSig = Buffer.alloc(4);
    fs.readSync(fd, peSig, 0, 4, peOffset);
    if (peSig.toString("ascii") !== "PE\0\0") {
      throw new Error(`${exePath} 在offset ${peOffset} 找不到PE簽名，可能不是有效的PE執行檔`);
    }

    // Optional Header緊接在4-byte PE簽名 + 20-byte COFF File Header之後；
    // Subsystem欄位固定位於Optional Header起點+68（PE32/PE32+皆同）。
    const optionalHeaderOffset = peOffset + 4 + 20;
    const magicBuf = Buffer.alloc(2);
    fs.readSync(fd, magicBuf, 0, 2, optionalHeaderOffset);
    const magic = magicBuf.readUInt16LE(0);
    if (magic !== 0x10b && magic !== 0x20b) {
      throw new Error(
        `${exePath} 的Optional Header Magic值(0x${magic.toString(16)})不是PE32(0x10b)或PE32+(0x20b)，為了避免損壞檔案，拒絕修改`
      );
    }

    const subsystemOffset = optionalHeaderOffset + 68;
    const subsystemBuf = Buffer.alloc(2);
    fs.readSync(fd, subsystemBuf, 0, 2, subsystemOffset);
    const currentSubsystem = subsystemBuf.readUInt16LE(0);
    if (currentSubsystem !== IMAGE_SUBSYSTEM_WINDOWS_GUI) {
      console.warn(
        `[pe-subsystem-patch] ${exePath} 目前Subsystem值是${currentSubsystem}（預期是${IMAGE_SUBSYSTEM_WINDOWS_GUI}=GUI），跳過修改，避免對非預期輸入做出錯誤假設`
      );
      return false;
    }
    const newBuf = Buffer.alloc(2);
    newBuf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_CUI, 0);
    fs.writeSync(fd, newBuf, 0, 2, subsystemOffset);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { patchExeToConsoleSubsystem, IMAGE_SUBSYSTEM_WINDOWS_GUI, IMAGE_SUBSYSTEM_WINDOWS_CUI };
