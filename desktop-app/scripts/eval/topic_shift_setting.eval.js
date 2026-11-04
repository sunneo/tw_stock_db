// 話題更動檢查設定（advancedSettings.topicShiftCheck）的預設、正規化、匯出匯入（真實 Electron）。
// 檢查：預設為 false；舊設定檔（沒有此欄位）載入後為 false；只接受布林 true；匯出再匯入後保留 true。
// 用法：node scripts/eval/run_eval.js scripts/eval/topic_shift_setting.eval.js
const fa = window.fa;
const R = { checks: {} };

// 1. 預設值
R.checks.defaultIsFalse = fa._createDefaultAdvancedSettings().topicShiftCheck === false;

// 2. 舊設定檔（沒有此欄位）→ false
R.checks.legacyMissingIsFalse = fa._normalizeAdvancedSettings({}).topicShiftCheck === false;

// 3. 只接受布林 true：字串或其他值都當成 false
R.checks.trueStaysTrue = fa._normalizeAdvancedSettings({ topicShiftCheck: true }).topicShiftCheck === true;
R.checks.stringYesBecomesFalse = fa._normalizeAdvancedSettings({ topicShiftCheck: 'yes' }).topicShiftCheck === false;
R.checks.oneBecomesFalse = fa._normalizeAdvancedSettings({ topicShiftCheck: 1 }).topicShiftCheck === false;

// 4. 匯出（與 export 相同的 JSON.parse(JSON.stringify(...)) 方式）再匯入，true 要保留
fa.advancedSettings.topicShiftCheck = true;
const exported = JSON.parse(JSON.stringify(fa.advancedSettings));
R.checks.exportCarriesField = exported.topicShiftCheck === true;
R.checks.importKeepsTrue = fa._normalizeAdvancedSettings(exported).topicShiftCheck === true;

// 還原
fa.advancedSettings.topicShiftCheck = false;

R.allPass = Object.values(R.checks).every((v) => v === true);
return R;
