// 用法：node scripts/eval/run_eval.js scripts/eval/no_update_dialog.eval.js。證明測試實例啟動後不會跳出「發現新版本」對話框（等 12 秒讓啟動時的檢查更新跑完）。
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(12000);
const text = document.body.innerText || '';
return { update_dialog_shown: /立即更新/.test(text), update_button_label_new_version: /發現新版本/.test(text), scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)) };
