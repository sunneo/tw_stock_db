// node renderer/src/catalog/onboard_core.test.js
const C = require('./catalog_core.js'); const O = require('./onboard_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 請求驗證
let v = O.validateRequest({ modules: ['statistics', 'json'] }); check('plain stdlib request is fine, no install, no confirmation', v.ok && !v.install && v.needConfirm.length === 0 && v.probe === true && eq(v.modules, ['statistics', 'json']), v);
v = O.validateRequest({ modules: 'statistics, json  math' }); check('string lists are split and de-duplicated', eq(v.modules, ['statistics', 'json', 'math']) && eq(O.validateRequest({ modules: ['a', 'a'] }).modules, ['a']));
v = O.validateRequest({ modules: [] }); check('empty modules rejected', !v.ok && /modules/.test(v.errors[0]));
v = O.validateRequest({ modules: Array.from({ length: 21 }, (_, i) => 'm' + i) }); check('too many modules rejected', !v.ok && /最多 20/.test(v.errors[0]));
for (const bad1 of ['os;rm', '../x', 'a b', 'import os', '1abc', 'a..b', '']) { const r = O.validateRequest({ modules: [bad1 || ' '] }); if (bad1) check('bad module name rejected: ' + bad1, !r.ok); }
for (const m of ['antigravity', 'tkinter', 'webbrowser', 'turtle', 'http.server', 'pip', 'idlelib.idle']) check('dangerous-to-import module denied: ' + m, !O.validateRequest({ modules: [m] }).ok);
v = O.validateRequest({ modules: ['yaml'], packages: ['pyyaml'] }); check('packages need confirmation by default', v.ok && v.install && eq(v.needConfirm, ['pyyaml']), v);
v = O.validateRequest({ modules: ['yaml'], packages: ['pyyaml==6.0.1'] }); check('pinned versions are accepted', v.ok && eq(v.needConfirm, ['pyyaml==6.0.1']));
for (const p of ['git+https://github.com/x/y.git', 'https://evil.example/x.whl', 'file:///etc/passwd', '../local', 'a b', '-rrequirements.txt', 'pkg@1.0', 'x:y', '/abs/path']) check('package source rejected: ' + p, !O.validateRequest({ modules: ['a'], packages: [p] }).ok, O.validateRequest({ modules: ['a'], packages: [p] }).errors);
check('git gets a specific explanation', /git/.test(O.validateRequest({ modules: ['a'], packages: ['git+https://x/y'] }).errors[0]));
v = O.validateRequest({ modules: ['yaml'], packages: Array.from({ length: 6 }, (_, i) => 'p' + i) }); check('too many packages rejected', !v.ok);
v = O.validateRequest({ modules: ['yaml'], packages: ['PyYAML', 'six'] }, { allowlist: ['pyyaml'] }); check('allowlist skips confirmation (case and _/-/. insensitive)', eq(v.needConfirm, ['six']), v.needConfirm);
v = O.validateRequest({ modules: ['a'], packages: ['my_pkg.name'] }, { allowlist: ['my-pkg-name'] }); check('allowlist normalizes separators', v.needConfirm.length === 0);
check('probe can be turned off', O.validateRequest({ modules: ['a'], probe: false }).probe === false);
check('confirm text names every package, the modules, and warns about running code', (() => { const r = O.validateRequest({ modules: ['yaml'], packages: ['pyyaml'] }); const t = O.confirmText(r); return /pyyaml/.test(t) && /yaml/.test(t) && /執行/.test(t) && /PyPI/.test(t); })());

// --- 單元（假資料）
const U = (name, o) => Object.assign({ id: 'py:m.' + name, runtime: 'python', name: 'm.' + name, summary: name + ' does a thing', params: [{ name: 'x', kind: 'named', type: 'number', type_src: 'stub', required: true }], returns: { type: 'number', type_src: 'stub' }, effects: [], pure: true, avail: { state: 'builtin', needs: [] }, domains: [], tests: [{ expr: '1', expect: '1', src: 'doctest' }], tier: 1, call: { runtime: 'python', import: 'm', qualname: name, via: 'pyodide' }, sig_src: 'inspect' }, o || {});
const units = [U('good'), U('nosig', { tier: 0, sig_src: 'none', params: [] }), U('untyped', { tier: 0, params: [{ name: 'x', kind: 'named', type: 'any', type_src: 'none', required: true }] }), U('eff', { tier: 0, effects: ['unknown'], pure: false }), U('cb', { tier: 0, params: [{ name: 'f', kind: 'named', type: 'callable', type_src: 'stub', required: true }] }),
    U('net', { tier: 0, avail: { state: 'needs-network', needs: [] } }), U('conf', { tier: 0, type_conflict: { declared: 'text', observed: 'number' } }), U('fail', { tier: 0, probe: { ok: 0, cases: 3 } }), U('notest', { tier: 0, tests: [], returns: { type: 'any', type_src: 'none' } })];
const h = O.heldReasons(units); check('every held reason is attributed once', h.counts.no_signature === 1 && h.counts.untyped_params === 1 && h.counts.effects_unknown === 1 && h.counts.has_callable === 1 && h.counts.unavailable === 1 && h.counts.type_conflict === 1 && h.counts.probe_failed === 1 && h.counts.no_tests_or_return === 1 && h.counts.other === 0, h.counts);
check('held examples are names', h.examples.has_callable[0] === 'm.cb');
const sm = O.summarize(units, { python: '3.14.2' }); check('summary: counts, percentages, examples, only non-zero reasons, extras', sm.units === 9 && sm.trusted === 1 && sm.trusted_pct === 11.1 && sm.trusted_examples[0].startsWith('m.good(x:number)') && !('other' in sm.held_reasons) && sm.python === '3.14.2', sm);
const ux = [U('a', { tier: 1, effects: ['fs.read'], pure: false, effects_src: 'static' }), U('b', { tier: 0, effects: ['unknown'], pure: false, effect_evidence: ['unresolved foo.bar', 'open()'] }), U('c', { tier: 0, effects: ['unknown'], pure: false, effect_evidence: ['unresolved foo.bar', 'unclassified os.get_blocking'] }), U('d', { tier: 1, verified: true })];
const sx = O.summarize(ux); check('summary: static-effect trusted count, verified-pure count, and the most common unresolved callees', sx.trusted_effects_static === 1 && sx.trusted_pure_verified === 1 && eq(sx.unresolved_top, ['unresolved foo.bar ×2', 'unclassified os.get_blocking ×1']), sx);
check('summary is compact', JSON.stringify(O.summarize(Array.from({ length: 500 }, (_, i) => U('f' + i)))).length < 4000);

// --- 持久化與合併
let store = O.mergeStore(null, [U('a'), U('b')], { python: '3.14.2', modules: ['m'], versions: { pkg: '1.0' } }); check('merge into empty store', store.units.length === 2 && store.records.length === 1 && store.python === '3.14.2');
store = O.mergeStore(store, [U('a', { summary: 'new' }), U('c')], { python: '3.14.2', modules: ['m'], versions: { pkg: '1.1' } }); check('re-extracting a module replaces its old units (no ghosts of removed functions)', eq(store.units.map((u) => u.name).sort(), ['m.a', 'm.c']) && store.units.find((u) => u.name === 'm.a').summary === 'new' && store.records.length === 2, store.units.map((u) => u.name));
const other = U('z', { id: 'py:other.z', call: { runtime: 'python', import: 'other', qualname: 'z' } }); store = O.mergeStore(store, [other], { python: '3.14.2', modules: ['other'], versions: {} }); check('other modules are kept', store.units.length === 3);
let big = O.emptyStore(); for (let i = 0; i < 60; i++) big = O.mergeStore(big, [], { python: '3.14', modules: ['x' + i], versions: {} }); check('records are capped', big.records.length === 50);
check('merge does not mutate its input', (() => { const s0 = O.mergeStore(null, [U('a')], { python: '3.14', modules: ['m'] }); const s1 = O.mergeStore(s0, [U('b')], { python: '3.14', modules: ['m'] }); return s0.units.length === 1 && s1.units.length === 1 && s0.records.length === 1; })());
check('store survives JSON', O.mergeStore(JSON.parse(JSON.stringify(store)), [U('d')], null).units.length === 2);
check('staleness by package version and by Python minor version', eq(O.staleUnits(store, { packages: { pkg: '2.0' }, python: '3.14.2' }), ['py:m.a', 'py:m.c']) && eq(O.staleUnits(store, { packages: { pkg: '1.1' }, python: '3.14.9' }), []) && O.staleUnits(store, { python: '3.12.1' }).length === 3);
const rec = O.makeRecord({ modules: ['m'], packages: ['pkg'], install: true, probe: true }, { python: '3.14.2', pkg_versions: { pkg: '1.0' } }, units, '2026-01-01T00:00:00Z'); check('record', rec.source === 'pypi' && rec.units === 9 && rec.trusted === 1 && rec.versions.pkg === '1.0' && rec.when === '2026-01-01T00:00:00Z');

// --- 查詢
const q = [U('mean', { summary: 'arithmetic mean of numbers', params: [{ name: 'data', kind: 'named', type: 'list<number>', type_src: 'stub', required: true }] }), U('sqrt', { summary: 'square root' }), U('read', { tier: 0, summary: 'read a file', params: [{ name: 'path', kind: 'named', type: 'path', type_src: 'name', required: true }], returns: { type: 'text', type_src: 'stub' } })];
let r = O.search(q, 'mean'); check('search by name', r.length >= 1 && r[0].id === 'py:m.mean' && /list<number>/.test(r[0].signature) && r[0].trusted === true, r);
check('search by summary words', O.search(q, 'square root')[0].id === 'py:m.sqrt');
check('only trusted', O.search(q, 'read', { onlyTrusted: true }).length === 0 && O.search(q, 'read').length === 1);
check('filter by what it takes / returns', eq(O.search(q, '', { takes: 'path' }).map((x) => x.id), ['py:m.read']) && eq(O.search(q, '', { returns: 'text' }).map((x) => x.id), ['py:m.read']) && O.search(q, '', { takes: 'bogus<' }).length === 3);
check('limit and ordering are stable', O.search(q, '', { limit: 2 }).length === 2 && eq(O.search(q, '').map((x) => x.id), O.search(q, '').map((x) => x.id)));
check('brief has the call path', O.brief(q[0]).call.import === 'm');
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'onboard_core: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
