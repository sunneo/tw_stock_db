"use strict";
const fs = require("fs");

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

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
      throw new Error(`${exePath} 找不到PE簽名`);
    }
    const optionalHeaderOffset = peOffset + 4 + 20;
    const magicBuf = Buffer.alloc(2);
    fs.readSync(fd, magicBuf, 0, 2, optionalHeaderOffset);
    const magic = magicBuf.readUInt16LE(0);
    if (magic !== 0x10b && magic !== 0x20b) {
      throw new Error(`${exePath} Optional Header Magic值不是PE32/PE32+`);
    }
    const subsystemOffset = optionalHeaderOffset + 68;
    const subsystemBuf = Buffer.alloc(2);
    fs.readSync(fd, subsystemBuf, 0, 2, subsystemOffset);
    const currentSubsystem = subsystemBuf.readUInt16LE(0);
    if (currentSubsystem !== IMAGE_SUBSYSTEM_WINDOWS_GUI) {
      console.warn(`[pe-subsystem-patch] ${exePath} 目前Subsystem值是${currentSubsystem}，跳過`);
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

if (require.main === module) {
  const src = process.argv[2];
  const dst = process.argv[3];
  fs.copyFileSync(src, dst);
  const patched = patchExeToConsoleSubsystem(dst);
  console.log(patched ? `OK: patched ${dst} to console subsystem` : `SKIPPED: ${dst} was not GUI subsystem`);
}
