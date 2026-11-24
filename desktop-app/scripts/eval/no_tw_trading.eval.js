// 桌面版（通用 FloatingAssistant）不能有台股量化技能：沒有 tw_trading 領域、設定裡沒有技能包叫 tw-trading。使用全新 --user-data-dir。
const fa = window.fa;
await new Promise((r) => setTimeout(r, 2500));
const domainKeys = Object.keys(fa.domains || {});
const bundles = ((fa.advancedSettings && fa.advancedSettings.skillBundles) || []).map((b) => (b.builtinId || '') + '|' + (b.name || ''));
const out = { domainCount: domainKeys.length, twDomain: domainKeys.filter((k) => /tw[_-]?trading/i.test(k)), twBundles: bundles.filter((b) => /tw[-_]?trading|台股量化/i.test(b)), skillDomains: domainKeys.filter((k) => k.indexOf('skill_') === 0), bundleCount: bundles.length };
out.ok = out.twDomain.length === 0 && out.twBundles.length === 0;
return out;
