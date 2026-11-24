// 內建技能清單與設定清理檢查（單元測試層級）：
// 1) _ensureBuiltinSkillBundles 會把「目前 BUILTIN_SKILLS 已經沒有」的舊內建項目從設定清掉，使用者自建的技能與仍在清單的內建項目保留；
// 2) renderer 原始碼不得出現台股網頁專屬技能的任何痕跡（使用者 2026-11-24：「通用的floating-assistant連出現這個skill都不該出現」）。
// 用法：node scripts/builtin-skill-orphans.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');

const startMarker = 'const BUILTIN_SKILLS = [\n';
const s = src.indexOf(startMarker);
const e = src.indexOf('\n];\n', s);
assert.ok(s >= 0 && e > s, '找不到 BUILTIN_SKILLS');
const arr = new Function('FA_IDR_SKILL_FILES', '"use strict";return [' + src.slice(s + startMarker.length, e) + '\n];')({});
assert.ok(arr.some((x) => x.id === 'builtin-skill-creator'), 'skill-creator 遺失');

const mStart = src.indexOf('    _ensureBuiltinSkillBundles() {');
const mEnd = src.indexOf('\n    }\n', mStart);
assert.ok(mStart > 0 && mEnd > mStart, '找不到 _ensureBuiltinSkillBundles');
const fn = new Function('BUILTIN_SKILLS', 'crypto', 'FA_IDR_SKILL_FILES', '"use strict";return {' + src.slice(mStart, mEnd + 6).replace('_ensureBuiltinSkillBundles()', 'ensure()') + '};')(arr, { randomUUID: () => 'x' + Math.random() }, {});
function run(initial) {
    const self = { advancedSettings: { skillBundles: initial }, _saveAdvancedSettings() {} };
    fn.ensure.call(self);
    return self.advancedSettings.skillBundles;
}
const out = run([{ builtinId: 'builtin-skill-retired-example', builtin: true, name: 'old' }, { id: 'u1', name: '使用者自己的技能' }]);
assert.ok(!out.some((b) => b.builtinId === 'builtin-skill-retired-example'), '已退役的內建項目要清掉');
assert.ok(out.some((b) => b.id === 'u1'), '使用者自建的技能要保留');
assert.ok(out.some((b) => b.builtinId === 'builtin-skill-creator'), '仍在清單的內建項目要有');

// 2) 通用原始碼沒有台股網頁專屬技能的痕跡
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]); }
for (const f of walk(path.join(root, 'renderer/src'))) {
    if (!/\.(js|html|css|json|md)$/.test(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/tw[-_]trading/.test(t), '通用程式不該出現台股專屬技能：' + f);
}
console.log('ok - 退役內建項目會清掉；renderer 原始碼沒有台股專屬技能痕跡');
console.log('1 項通過');
