// node scripts/apply-llvm-icd-wiring.js [floating-assistant.js 的路徑]
// 把「.ll 的 OpenCL 呼叫接 ICD 載入器」（DESIGN.pyopencl.md §12）套進 renderer/src/floating-assistant.js 的兩個手寫位置。可重複執行（已套用就略過）。
//   (1) _terminalTryLliHost：把這次 GPU 偵測的結果掛在 H.kirSetup，讓 ICD 載入器重用同一個裝置層（不重複建立 WebGL／WebGPU）。
//   (2) _terminalTryLliHostRun：IR 有 "; fa-opencl: icd" 註解就啟用 ICD 模式（要在 FaLlvm.parse 之前，新的 cl* 簽名才登記得到）。
// 之後：node scripts/embed-code-ui.js（把 uml/llvm_cl_icd.js 嵌進 FA_KIR_SRC）、node build-assistant.js、發布走原本的流程。
const fs = require('fs'), path = require('path');
const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'));
let s = fs.readFileSync(file, 'utf8'); let applied = 0;
function rep(name, anchor, replacement, marker) {
    if (s.includes(marker)) { console.log('略過（已套用）：' + name); return; }
    const n = s.split(anchor).length - 1; if (n !== 1) { console.error('找不到唯一的錨點：' + name + '（出現 ' + n + ' 次）'); process.exit(1); }
    s = s.replace(anchor, () => replacement); applied++; console.log('已套用：' + name);
}
rep('(1) H.kirSetup', "        try {\n            const res = await this._terminalTryLliHostRun(session, argsText, guiTimeoutSec, H);", "        H.kirSetup = kirSetup;   // ICD 模式重用這次的 GPU 偵測結果（_terminalTryLliHostRun）\n        try {\n            const res = await this._terminalTryLliHostRun(session, argsText, guiTimeoutSec, H);", 'H.kirSetup = kirSetup;');
rep('(2) ICD 模式', "        const p = FaLlvm.parse(text); if (p.errors.length) return false;   // 語法錯誤交給原本的 lli 報行號", `        // IR 的註解 "; fa-opencl: icd"：cl* 呼叫改接 ICD 載入器（完整的 OpenCL C、圖像、Pipe、GPU／CPU 路由；DESIGN.pyopencl.md §12）。要在 parse 之前，新的簽名才登記得到
        try {
            const KM = this._kirLoad();
            if (KM && KM.FaLlvmClIcd && KM.FaClHostPage && H.useClIcd && KM.FaLlvmClIcd.wantsIcd(text)) {
                const jspi = typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
                const page = await KM.FaClHostPage.create({ mods: KM, nav: navigator, makeCanvas: () => { const cv = document.createElement('canvas'); cv.width = 4; cv.height = 4; return cv; }, jspi, setup: H.kirSetup });
                H.useClIcd({ mod: KM.FaLlvmClIcd, ops: KM.FaClHostOps.create(page.loader) }, FaLlvm);
                session.term.write('\\x1b[2m[OpenCL：ICD 載入器（' + page.describe() + '）]\\x1b[0m\\r\\n');
            }
        } catch (e) { session.term.write('\\x1b[33m[OpenCL ICD 模式啟用失敗，改用預設墊片：' + String((e && e.message) || e).slice(0, 200) + ']\\x1b[0m\\r\\n'); }
        const p = FaLlvm.parse(text); if (p.errors.length) return false;   // 語法錯誤交給原本的 lli 報行號`, 'FaLlvmClIcd.wantsIcd(text)');
if (applied) fs.writeFileSync(file, s);
console.log(applied ? '完成：套用了 ' + applied + ' 處' : '沒有需要套用的');
