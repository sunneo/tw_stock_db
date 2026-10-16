// node renderer/src/catalog/feedback_core.test.js
const F = require('./feedback_core.js'); const D = require('./discover_core.js'); const T = require('./rank_train.js'); const Card = require('./card_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };
const j = (...l) => l.join('\n');

// ---- 假的計畫（跟 discover_core.run 的輸出同形）----
const card = Card.cardFromReadme(j('# face-smooth', '', 'Smooth skin and beautify faces in photos in the browser with WebGL.', '', '```sh', 'npm install face-smooth', '```', '', '```js', 'faceSmooth.apply(canvas, 0.6)', '```'), { name: 'face-smooth' });
const altCard = Card.cardFromReadme(j('# face-game', '', 'A face filter game.'), { name: 'face-game' });
const feat = (v) => Object.fromEntries(D.FEATURES.map((n, i) => [n, v + i * 0.01]));
const plan = { ok: true, plan_id: 'plan_x', runtime: 'browser', candidates: [{ gap: 'need/1', name: 'face-smooth', url: 'https://github.com/a/face-smooth', score: 1.1, need: '美顏濾鏡', kind: 'project', card, features: feat(0.9), alternatives: [{ name: 'face-game', url: 'https://github.com/a/face-game', score: 0.4, card: altCard, features: feat(0.3) }] }] };

// ---- 壓縮 ----
const cc = F.compactCard(card);
check('compactCard keeps what training and review need, and is small', cc.language === 'js' && cc.installs[0] === 'npm install face-smooth' && cc.head.length > 0 && cc.head.length <= 600 && JSON.stringify(cc).length < 4000 && !('trace' in cc), JSON.stringify(cc).length);

// ---- 從計畫產生回饋 ----
const adopt = F.fromPlan(plan, 'need/1', 'adopt');
check('adopt: label 1, user source, features and compact card kept, alternatives attached', adopt.label === 1 && adopt.source === 'user_adopt' && adopt.features.rel_all > 0.8 && adopt.card.head && adopt.alts.length === 1 && adopt.alts[0].features && adopt.gap_id === 'need/1' && adopt.need === '美顏濾鏡', adopt);
const reject = F.fromPlan(plan, 'need/1', 'reject', { reason: '太重了' });
check('reject: label 0, no alternatives attached', reject.label === 0 && reject.source === 'user_reject' && reject.alts.length === 0 && reject.detail === '太重了');
const altReject = F.fromPlan(plan, 'need/1', 'reject', { url: 'https://github.com/a/face-game' });
check('judging an alternative uses that alternative\'s own card and features', altReject.name === 'face-game' && altReject.features.rel_all < 0.5 && altReject.card.head.includes('face filter'), altReject);
const runOk = F.fromPlan(plan, 'need/1', 'run_ok');
const runFail = F.fromPlan(plan, 'need/1', 'run_fail', { error: 'TypeError: booth.start is not a function', classify: D.classifyError });
check('run results: ok → 1, fail → 0 with the error kind', runOk.label === 1 && runOk.source === 'run_ok' && runFail.label === 0 && runFail.fail_kind === 'wrong_api', runFail);
check('errors out on bad input', (() => { try { F.fromPlan(plan, 'nope', 'adopt'); return false; } catch (e) { return /沒有缺口/.test(e.message); } })() && (() => { try { F.fromPlan(plan, 'need/1', 'maybe'); return false; } catch (e) { return /verdict/.test(e.message); } })() && (() => { try { F.fromPlan(plan, 'need/1', 'adopt', { url: 'https://x' }); return false; } catch (e) { return /沒有/.test(e.message); } })());

// ---- 追加：同一筆的結論後來的覆蓋先前的 ----
let store = F.append(F.emptyStore(), [adopt]);
check('append: stored', store.records.length === 1);
const flipped = F.makeRecord({ plan_id: 'plan_x', gap_id: 'need/1', need: 'x', url: adopt.url, name: 'n', card, features: adopt.features, label: 0, source: 'user_adopt' }); // 同一個 key
store = F.append(store, [flipped]); check('append: same plan/gap/url/source replaces instead of duplicating', store.records.length === 1 && store.records[0].label === 0);
store = F.append(store, [reject]); check('append: a different source for the same candidate is kept (latest conclusion wins when training)', store.records.length === 2);
const big = []; for (let i = 0; i < F.MAX_RECORDS + 50; i++) big.push(F.makeRecord({ plan_id: 'p' + i, gap_id: 'g', url: 'u' + i, label: 1, source: 'user_adopt' }));
check('append: capped, oldest dropped', F.append(F.emptyStore(), big).records.length === F.MAX_RECORDS && F.append(F.emptyStore(), big).records[0].url === 'u50');

// ---- 權重 ----
check('weights: user 1, run ok 0.6, alternatives 0.3', F.weightOf(adopt) === 1 && F.weightOf(runOk) === 0.6 && F.SOURCE_WEIGHT.alt === 0.3);
check('weights: environment failures are not the project\'s fault', ['permission', 'network', 'resource', 'timeout'].every((k) => F.weightOf({ source: 'run_fail', fail_kind: k }) === 0) && F.weightOf({ source: 'run_fail', fail_kind: 'wrong_api' }) > 0);

// ---- 轉成訓練資料 ----
let s2 = F.append(F.emptyStore(), [F.fromPlan(plan, 'need/1', 'adopt')]);
let rows = F.toRows(s2); check('toRows: adopted candidate is a positive, the shown alternative a light negative', rows.length === 2 && rows.find((r) => r.y === 1).w === 1 && rows.find((r) => r.y === 0).w === 0.3 && rows[0].group === 'plan_x/need/1' && rows[0].x.rel_all > 0, rows);
s2 = F.append(s2, [F.fromPlan(plan, 'need/1', 'reject', { url: 'https://github.com/a/face-game' })]);
rows = F.toRows(s2); check('toRows: an explicit verdict replaces the implicit "alternative" negative (no duplicate rows)', rows.filter((r) => r.id.endsWith('face-game')).length === 1 && rows.find((r) => r.id.endsWith('face-game')).w === 1, rows.map((r) => r.id + ':' + r.y + ':' + r.w));
s2 = F.append(s2, [F.fromPlan(plan, 'need/1', 'run_fail', { error: 'NotAllowedError: Permission denied', classify: D.classifyError })]);
check('toRows: a permission failure adds no training row', F.toRows(s2).length === rows.length);
check('toRows: records without features are skipped', F.toRows(F.append(F.emptyStore(), [F.makeRecord({ gap_id: 'g', url: 'u', label: 1, source: 'user_adopt' })])).length === 0);
check('toRows: latest verdict on the same candidate wins', (() => { const a = F.makeRecord({ plan_id: 'p', gap_id: 'g', url: 'u', label: 1, source: 'user_adopt', features: feat(1) }, '2026-01-01T00:00:00Z'); const b = F.makeRecord({ plan_id: 'p', gap_id: 'g', url: 'u', label: 0, source: 'user_reject', features: feat(1) }, '2026-01-02T00:00:00Z'); const r = F.toRows(F.append(F.emptyStore(), [a, b])); return r.length === 1 && r[0].y === 0; })());

// ---- 統計與『可以訓練了嗎』----
const st0 = F.stats(s2); check('stats: counts and not ready yet, with what is missing', st0.records >= 3 && st0.ready_to_train === false && st0.missing.length >= 2 && st0.groups === 1, st0);
let many = F.emptyStore(); const recs = []; for (let g = 0; g < 12; g++) for (let i = 0; i < 4; i++) { const good = i === 0; recs.push(F.makeRecord({ plan_id: 'p' + g, gap_id: 'g', need: 'n', url: 'u' + g + '-' + i, label: good ? 1 : 0, source: good ? 'user_adopt' : 'user_reject', features: Object.assign(feat(0), { rel_all: good ? 0.8 + (g % 3) * 0.05 : 0.2 + (i * 0.07), api_hit: good ? 1 : 0 }) })); } many = F.append(many, recs);
const st1 = F.stats(many); check('stats: ready when there are enough groups and examples', st1.ready_to_train === true && st1.groups === 12 && st1.positives === 12 && st1.negatives === 36 && st1.missing.length === 0, st1);

// ---- 權重訓練 + 報告 ----
const rep = T.trainReport(F.toRows(many), { use: ['rel_all', 'api_hit'] });
check('trainReport: cross-validates with feedback rows and returns a usable model', rep.groups === 12 && rep.tries.length === 3 && rep.best.top1 === '12/12' && Array.isArray(rep.model.w) && T.predict(rep.model, { rel_all: 0.9, api_hit: 1 }) > 0.5 && T.predict(rep.model, { rel_all: 0.2, api_hit: 0 }) < 0.5, rep.best);
check('weighted rows: a heavy conflicting example moves the model more than a light one', (() => { const base = []; for (let i = 0; i < 20; i++) base.push({ group: 'g' + i, y: i % 2, x: { a: i % 2 }, w: 1 }); const heavy = base.concat([{ group: 'z', y: 0, x: { a: 1 }, w: 10 }]), light = base.concat([{ group: 'z', y: 0, x: { a: 1 }, w: 0.1 }]); return T.predict(T.fit(heavy, { use: ['a'] }), { a: 1 }) < T.predict(T.fit(light, { use: ['a'] }), { a: 1 }); })());

console.log('feedback_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED' : '')); bad.forEach((x) => console.log('FAIL', x)); process.exit(bad.length ? 1 : 0);
