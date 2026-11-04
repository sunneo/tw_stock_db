// 話題更動檢查核取方塊（Configure → LLM 基礎設定）（真實 Electron）。
// 開 Configure 面板 → 找到 #ai-topic-shift-chk → 預設未勾 → 點擊後設定值變 true → 再點回 false。
// 用法：node scripts/eval/run_eval.js scripts/eval/topic_shift_ui.eval.js
const fa = window.fa;
const R = { checks: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fa._openAdvancedModal();
await sleep(400);
const chk = document.getElementById('ai-topic-shift-chk');
R.checks.checkboxExists = !!chk;
R.checks.labelText = chk ? (chk.parentElement.querySelector('label') || {}).textContent : null;
R.checks.defaultUnchecked = !!chk && chk.checked === false;
R.checks.settingDefaultFalse = fa.advancedSettings.topicShiftCheck === false;

chk.click();
await sleep(150);
R.checks.clickOnSetsTrue = fa.advancedSettings.topicShiftCheck === true;
R.checks.clickOnChecked = document.getElementById('ai-topic-shift-chk').checked === true;

chk.click();
await sleep(150);
R.checks.clickOffSetsFalse = fa.advancedSettings.topicShiftCheck === false;

R.allPass = Object.values(R.checks).every((v) => v === true || (typeof v === 'string' && v.length > 0));
fa._closeAdvancedModal();
return R;
