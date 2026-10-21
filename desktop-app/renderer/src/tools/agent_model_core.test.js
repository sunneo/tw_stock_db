// node renderer/src/tools/agent_model_core.test.js -- Agent Model Configure：階段圖、特性估計、自動決定、內建預設、開關不動設定、重置、解析順序、備援順序、AI 回覆檢查。
const A = require('./agent_model_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const rows = [
  { id: 'r1', modelName: 'nvidia/nemotron-3.5-lightning-30b-a3b', contextWindowTokens: 32000 },
  { id: 'r2', modelName: 'nvidia/nemotron-3-ultra-550b-a55b', contextWindowTokens: 128000, coluProfile: { advice: 'self' } },
  { id: 'r3', modelName: 'nvidia/nemotron-3.5-super-vl-120b-a12b', contextWindowTokens: 256000, abilityTags: { vision: true, toolCall: true } },
  { id: 'r4', modelName: 'openai/gpt-oss-20b', contextWindowTokens: 128000 },
  { id: 'r5', modelName: 'text-embedding-3', isEmbeddingModel: true },
  { id: 'r6', modelName: 'tiny/no-tools-8b', abilityTags: { toolCall: false } },
];
const cards = { 'openai/gpt-oss-20b': { test1Score: 95, test2Score: 90, test3avgScore: 70, overallScore: 78 }, 'nvidia/nemotron-3-ultra-550b-a55b': { test1Score: 30, test2Score: 95, test3avgScore: 92, overallScore: 93 } };

// ---------- 階段圖 ----------
check('every mode has a graph made of known stages; edges only connect stages of that mode', Object.keys(A.MODES).every((m) => A.MODES[m].stages.every((s) => A.STAGES[s]) && A.MODES[m].edges.every((e) => A.MODES[m].stages.indexOf(e[0]) >= 0 && A.MODES[m].stages.indexOf(e[1]) >= 0)));
check('different modes have different stages (off has only the orchestrator; hierarchical has the category router)', A.MODES.off.stages.join() === 'orchestrator' && A.MODES.hierarchical.stages.indexOf('category_router') >= 0 && A.MODES.router.stages.indexOf('category_router') < 0);

// ---------- 特性估計 ----------
const p1 = A.profile(rows[0], null), p2 = A.profile(rows[1], cards[rows[1].modelName]), p3 = A.profile(rows[3], cards[rows[3].modelName]);
check('profile: measured scores win over name guesses (ultra-550b measured slow 0.3, accurate 0.93)', Math.abs(p2.speed - 0.3) < 1e-9 && Math.abs(p2.accuracy - 0.93) < 1e-9 && p2.notes.some((n) => /實測/.test(n)), p2);
check('profile: no data -> estimates from the name (lightning-30b-a3b is fast, small active size)', p1.speed >= 0.85 && p1.notes.some((n) => /估計/.test(n)), p1);
check('profile: context from the configured window (8k=0, 128k=1); unknown is a neutral guess', A.profile({ modelName: 'x', contextWindowTokens: 8000 }, null).context === 0 && A.profile({ modelName: 'x', contextWindowTokens: 128000 }, null).context === 1 && A.profile({ modelName: 'x' }, null).context === 0.4);
check('profile: a model without native tool calls has tools 0.1', A.profile(rows[5], null).tools === 0.1);
check('profile: every value is in 0..1', [p1, p2, p3, A.profile({}, null)].every((p) => ['speed', 'context', 'tools', 'accuracy'].every((k) => p[k] >= 0 && p[k] <= 1)));

// ---------- 自動決定 ----------
const D = A.autoDecide(rows, cards, { top: 2 }); const ids = (m, s) => D.assign[m][s].prefs;
check('autoDecide: orchestrator prefers the fast ones, reducer prefers the careful one (the measured ultra)', ids('router', 'orchestrator')[0] === 'r4' || ids('router', 'orchestrator')[0] === 'r1', ids('router', 'orchestrator'));
check('autoDecide: reducer picks the most accurate measured model first', ids('router', 'reducer')[0] === 'r2', ids('router', 'reducer'));
check('autoDecide: the embedding model and the no-tools model are not used for tool stages', Object.keys(D.assign).every((m) => Object.keys(D.assign[m]).every((s) => D.assign[m][s].prefs.indexOf('r5') < 0 && (s !== 'domain_agent' || D.assign[m][s].prefs.indexOf('r6') < 0))));
check('autoDecide: gives a reason for each choice and only covers stages of that mode', D.assign.off.orchestrator.why.length === 2 && !D.assign.off.router && !!D.assign.hierarchical.category_router);
check('autoDecide: modes differ (off cares about tools/accuracy, full about context) -> not all identical', JSON.stringify(D.assign.off.orchestrator.prefs) !== JSON.stringify(D.assign.router.orchestrator.prefs) || JSON.stringify(D.assign.full.orchestrator.prefs) !== JSON.stringify(D.assign.router.orchestrator.prefs), [D.assign.off.orchestrator.prefs, D.assign.router.orchestrator.prefs, D.assign.full.orchestrator.prefs]);
check('autoDecide: distinct models only (two rows of the same model count once)', A.autoDecide(rows.concat([{ id: 'r7', modelName: 'openai/gpt-oss-20b' }]), cards, { top: 6 }).assign.router.reducer.prefs.filter((id) => id === 'r4' || id === 'r7').length === 1);
check('autoDecide never throws on empty input', (() => { try { A.autoDecide([], {}); A.autoDecide(null, null); return true; } catch (e) { return false; } })());

// ---------- 內建預設 ----------
check('builtin: patterns resolve to existing rows in preference order (reducer: ultra first)', A.builtinFor(rows, 'reducer')[0] === 'r2' && A.builtinFor(rows, 'orchestrator')[0] === 'r1', [A.builtinFor(rows, 'reducer'), A.builtinFor(rows, 'orchestrator')]);
check('builtin: a stage with no matching model gives nothing (no invented model)', A.builtinFor([{ id: 'z', modelName: 'weird-model' }], 'reducer').length === 0);

// ---------- 開關不動設定；解析順序 ----------
let cfg = A.defaults(); check('default: disabled, nothing applies', cfg.enabled === false && A.resolve(cfg, 'router', 'orchestrator', rows).source === 'off');
A.setPrefs(cfg, 'router', 'orchestrator', ['r4', 'r1']);
check('disabled: saved prefs stay but are not applied', A.resolve(cfg, 'router', 'orchestrator', rows).source === 'off' && cfg.modes.router.stages.orchestrator.prefs.join() === 'r4,r1');
cfg.enabled = true;
check('enabled: custom prefs apply (only rows that still exist)', A.resolve(cfg, 'router', 'orchestrator', rows).ids.join() === 'r4,r1' && A.resolve(cfg, 'router', 'orchestrator', rows).source === 'custom');
check('enabled: the built-in preset fills the stages with no custom prefs', A.resolve(cfg, 'router', 'reducer', rows).source === 'builtin' && A.resolve(cfg, 'router', 'reducer', rows).ids[0] === 'r2');
check('enabled: another mode is unaffected by this mode\'s custom prefs', A.resolve(cfg, 'full', 'orchestrator', rows).source === 'builtin');
cfg.useBuiltin = false; check('useBuiltin off: stages without custom prefs apply nothing', A.resolve(cfg, 'router', 'reducer', rows).source === 'none'); cfg.useBuiltin = true;
check('a deleted row is skipped; all gone -> falls back to builtin', A.resolve(cfg, 'router', 'orchestrator', rows.filter((r) => r.id !== 'r4')).ids.join() === 'r1' && A.resolve(cfg, 'router', 'orchestrator', [rows[2]]).source !== 'custom');
A.setModeEnabled(cfg, 'router', false); check('per-mode switch: off applies nothing for that mode, keeps its prefs', A.resolve(cfg, 'router', 'orchestrator', rows).source === 'off' && cfg.modes.router.stages.orchestrator.prefs.length === 2); A.setModeEnabled(cfg, 'router', true);
check('toggling enabled twice leaves the stored prefs identical', (() => { const before = JSON.stringify(cfg.modes); cfg.enabled = false; cfg.enabled = true; return JSON.stringify(cfg.modes) === before; })());

// ---------- 重置 ----------
const r0 = A.reset(cfg); check('reset: custom prefs and per-mode flags are cleared; the global switch is the user\'s choice and stays', r0.enabled === true && Object.keys(r0.modes).length === 0 && r0.useBuiltin === true && A.resolve(r0, 'router', 'orchestrator', rows).source === 'builtin');
check('reset of a disabled config stays disabled', A.reset(A.defaults()).enabled === false);

// ---------- 正規化 ----------
const n = A.normalize({ enabled: 'yes', modes: { router: { enabled: false, stages: { orchestrator: { prefs: ['a', 'a', 'b', 7] }, bogus: { prefs: ['x'] } } }, nope: {} } });
check('normalize: only known modes/stages, de-duplicated ids, enabled must be exactly true', n.enabled === false && n.modes.router.enabled === false && n.modes.router.stages.orchestrator.prefs.join() === 'a,b,7' && !n.modes.router.stages.bogus && !n.modes.nope);
check('normalize never throws on garbage', (() => { try { A.normalize(null); A.normalize('x'); A.normalize({ modes: 5 }); return true; } catch (e) { return false; } })());
check('setPrefs rejects a stage the mode does not have', (() => { const c = A.defaults(); A.setPrefs(c, 'off', 'router', ['r1']); return !c.modes.off; })());

// ---------- 備援順序：偏好排前面，其餘照原順序 ----------
const groups = [{ key: 'g1', rows: [rows[0]] }, { key: 'g2', rows: [rows[1]] }, { key: 'g3', rows: [rows[3], { id: 'r7' }] }];
check('orderGroups: preferred rows\' groups first in preference order, the rest keep their order (fallback never loses a model)', A.orderGroups(groups, ['r4', 'r2']).map((g) => g.key).join() === 'g3,g2,g1' && A.orderGroups(groups, ['r1']).map((g) => g.key).join() === 'g1,g2,g3' && A.orderGroups(groups, []).length === 3 && A.orderGroups(groups, ['nope']).length === 3);

// ---------- 讓 AI 決定：封閉的 JSON ----------
const P = A.aiPrompt(rows, cards); check('aiPrompt: letters for models, stats, stage needs; embedding models are not offered', /A\. nvidia/.test(P.user) && /謹慎/.test(P.user) && /domain_agent/.test(P.user) && !/embedding/.test(P.user) && Object.keys(P.map).length === 5, Object.keys(P.map));
const R = A.parseAi('好：{"orchestrator":["A","d"],"router":["Z","A"],"reducer":["B","B","C","D"],"domain_agent":"x"}', P.map);
check('parseAi: letters map to ids; unknown letters are dropped and counted; max 3 per stage; non-arrays ignored', R.ok && R.assign.orchestrator.join() === 'r1,r4' && R.assign.router.join() === 'r1' && R.dropped === 1 && R.assign.reducer.length === 3 && R.assign.domain_agent.length === 0, R);
check('parseAi: garbage -> not ok', A.parseAi('我覺得 A 最好', P.map).ok === false && A.parseAi('', P.map).ok === false);
const c3 = A.applyAssign(A.defaults(), D.assign); check('applyAssign: writes the per-mode result; onlyEmpty keeps what is already customised', Object.keys(c3.modes).length === 5 && (() => { const c = A.defaults(); A.setPrefs(c, 'router', 'reducer', ['r3']); A.applyAssign(c, D.assign, { onlyEmpty: true }); return c.modes.router.stages.reducer.prefs.join() === 'r3' && !!c.modes.router.stages.orchestrator; })());
console.log((bad.length ? 'FAIL' : 'PASS') + ' Agent Model Configure（階段圖、特性估計、自動決定、內建預設、開關不動設定、重置、解析與備援順序、AI 回覆檢查）：' + ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
