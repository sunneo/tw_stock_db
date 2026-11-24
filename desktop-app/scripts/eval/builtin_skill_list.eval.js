// 真 Electron：內建技能清單與領域裡沒有台股專屬技能（使用者 2026-11-24：台股技能只在台股網頁）。
const fa = window.fa; const R = {};
const bundles = (fa.advancedSettings && fa.advancedSettings.skillBundles) || [];
R.bundleNames = bundles.map((b) => b.name);
R.hasTwBundle = bundles.some((b) => /tw[-_]trading/.test(JSON.stringify([b.name, b.builtinId])));
R.domainKeys = Object.keys(fa.domains || {}).filter((k) => /tw[-_]trading/.test(k));
R.hasSkillCreator = bundles.some((b) => b.builtinId === 'builtin-skill-creator');
return R;
