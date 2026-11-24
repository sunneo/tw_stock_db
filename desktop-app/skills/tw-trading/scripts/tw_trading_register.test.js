// 台股技能不內建檢查（單元測試層級，不啟動瀏覽器、不啟動桌面版）：
// 使用者 2026-11-24：「不是啟用 不要內建，只有台股頁面ai內建」。
// 1) 共用的 BUILTIN_SKILLS 不得有台股技能（桌面版與一般 AI 都不會有、Configure 清單也不會出現）；
// 2) 舊版（v568）已裝進設定的那一筆，_ensureBuiltinSkillBundles 要清掉，其他內建技能不受影響；
// 3) 技能全文 skills/tw-trading/SKILL.md 仍在（台股網頁用 register_domain 載入它）。
// 用法：node skills/tw-trading/scripts/tw_trading_register.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', '..'); // desktop-app
const src = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');

const startMarker = 'const BUILTIN_SKILLS = [\n';
const s = src.indexOf(startMarker);
assert.ok(s >= 0, '找不到 BUILTIN_SKILLS');
const e = src.indexOf('\n];\n', s);
assert.ok(e > s, '找不到 BUILTIN_SKILLS 結束');
const literal = '[' + src.slice(s + startMarker.length, e) + '\n]';
const arr = new Function('FA_IDR_SKILL_FILES', '"use strict";return ' + literal + ';')({});

// 1) 共用清單沒有台股技能
assert.ok(!arr.some((x) => x && (x.id === 'builtin-skill-tw-trading' || x.name === 'tw-trading-market-tools')), '共用 BUILTIN_SKILLS 不該有台股技能');
assert.ok(arr.some((x) => x && x.id === 'builtin-skill-creator'), 'skill-creator 遺失');
assert.ok(arr.some((x) => x && x.id === 'builtin-skill-media-presentation'), 'media-presentation 遺失');

// 2) 舊版已裝的要被清掉
const mStart = src.indexOf('    _ensureBuiltinSkillBundles() {');
const mEnd = src.indexOf('\n    }\n', mStart);
assert.ok(mStart > 0 && mEnd > mStart, '找不到 _ensureBuiltinSkillBundles');
const body = src.slice(mStart, mEnd + 6).replace('_ensureBuiltinSkillBundles()', 'ensure()');
const fn = new Function('BUILTIN_SKILLS', 'crypto', 'FA_IDR_SKILL_FILES', '"use strict";return {' + body + '};')(arr, { randomUUID: () => 'x' + Math.random() }, {});
function run(initial) {
    const self = { advancedSettings: { skillBundles: initial }, _saveAdvancedSettings() {} };
    fn.ensure.call(self);
    return self.advancedSettings.skillBundles.map((b) => b.builtinId);
}
const fresh = run([]);
assert.ok(!fresh.includes('builtin-skill-tw-trading'), '全新安裝不該有台股技能');
assert.ok(fresh.includes('builtin-skill-creator'), '全新安裝仍有 skill-creator');
const upgraded = run([{ builtinId: 'builtin-skill-tw-trading', name: 'tw-trading-market-tools', personaPrompt: 'x', builtinToolNames: [] }, { id: 'u1', name: '使用者自己的技能' }]);
assert.ok(!upgraded.includes('builtin-skill-tw-trading'), 'v568 已裝的台股技能要被移除');
assert.strictEqual(upgraded.filter((x) => x === undefined).length, 1, '使用者自建的技能要保留');

// 3) 技能全文仍在
const skillMd = fs.readFileSync(path.join(root, 'skills/tw-trading/SKILL.md'), 'utf8');
assert.ok(/name: tw-trading-market-tools/.test(skillMd), 'SKILL.md 遺失或名稱不對');

console.log('ok - 共用內建技能沒有台股技能；舊版已裝的會被清掉；SKILL.md 仍在');
console.log('1 項通過');
