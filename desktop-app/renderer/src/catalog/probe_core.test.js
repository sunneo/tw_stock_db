// node renderer/src/catalog/probe_core.test.js —— 探測執行：輸入產生、結果套回單元；有 python 時真的跑一次探測腳本
const C = require('./catalog_core.js'); const P = require('./probe_core.js'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');
let ok = 0; const bad = []; let skipped = '';
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 候選輸入
const cd = P.candidates;
check('candidates: scalars', eq(cd('bool'), [true, false]) && cd('int').length >= 3 && cd('number').every((x) => typeof x === 'number') && cd('text').includes('abc') && cd('null')[0] === null);
check('candidates: name hints', cd('int', 'n').every((x) => x > 0) && cd('text', 'fmt')[0].includes('%'));
check('candidates: bytes are tagged for JSON', cd('bytes')[0].$bytes === 'YWJj');
check('candidates: list<number> has several equally long lists first', cd('list<number>')[0].length === 4 && cd('list<number>')[1].length === 4);
check('candidates: enum gives its values; union interleaves', eq(cd('enum<a|b>'), ['a', 'b']) && cd('union<int|text>').includes(0) && cd('union<int|text>').includes('abc'));
check('candidates: nothing reliable for any/callable/file ids', cd('any').length === 0 && cd('callable').length === 0 && cd('file_id').length === 0 && cd('yaml').length === 0);

// --- 案例
const U = (name, params, extra) => Object.assign({ id: 'py:m.' + name, runtime: 'python', name: 'm.' + name, summary: '', params: params.map(([n, t, req, kind]) => ({ name: n, kind: kind || 'named', type: t, type_src: 'stub', required: req !== false })), returns: { type: 'any', type_src: 'none' }, effects: [], pure: true, avail: { state: 'builtin', needs: [] }, domains: [], tests: [], tier: 0, call: { import: 'm', qualname: name } }, extra || {});
let bc = P.buildCases(U('f', [['data', 'list<number>'], ['n', 'int', false]])); check('cases: required first, then one per optional', bc.cases.length >= 3 && bc.cases[0].kwargs.n === undefined && bc.cases.some((c) => c.kwargs.n !== undefined), bc);
bc = P.buildCases(U('f', [['x', 'number', true, 'positional'], ['y', 'number', true, 'positional']])); check('cases: positional-only go into args in order', bc.cases[0].args.length === 2 && Object.keys(bc.cases[0].kwargs).length === 0 && !eq(bc.cases[0].args, bc.cases[1].args), bc.cases);
bc = P.buildCases(U('f', [['x', 'list<number>'], ['y', 'list<number>']])); check('cases: same-typed lists stay the same length in every case', bc.cases.every((c) => c.kwargs.x.length === c.kwargs.y.length), bc.cases);
bc = P.buildCases(U('f', [['x', 'any']])); check('skip: required param without a generator', !!bc.skip && /x/.test(bc.skip), bc);
bc = P.buildCases(U('f', [['key', 'callable']])); check('skip: callable', /函式/.test(bc.skip || ''), bc);
bc = P.buildCases(U('f', [['x', 'int'], ['cb', 'callable', false]])); check('optional callable is simply not passed', !!bc.cases && bc.cases.every((c) => !('cb' in c.kwargs)), bc);
bc = P.buildCases(U('f', [])); check('no params gives one empty case', bc.cases.length === 1 && eq(bc.cases[0], { args: [], kwargs: {} }), bc);
check('cases are deterministic and unique', (() => { const a = P.buildCases(U('f', [['a', 'int'], ['b', 'text']])), b = P.buildCases(U('f', [['a', 'int'], ['b', 'text']])); return eq(a, b) && new Set(a.cases.map((c) => JSON.stringify(c))).size === a.cases.length; })());
check('cases are capped', P.buildCases(U('f', [['a', 'int'], ['b', 'int', false], ['c', 'int', false], ['d', 'int', false], ['e', 'int', false], ['f', 'int', false], ['g', 'int', false]]), { maxCases: 4 }).cases.length <= 4);

// --- 結果套回單元（用假的探測結果）
const R = (o) => Object.assign({ ok: true, type: 'number', repr: '2.5', det: true, jsonable: true, json: 2.5 }, o || {});
const mkU = (extra) => U('f', [['data', 'list<number>']], Object.assign({ returns: { type: 'any', type_src: 'none' }, tier: 0 }, extra || {}));
const cases3 = [{ args: [], kwargs: { data: [1, 2] } }, { args: [], kwargs: { data: [3, 4] } }, { args: [], kwargs: { data: [5, 6] } }];
let u = P.applyProbe(mkU(), { id: 'x', cases: [R(), R({ type: 'int', json: 3 }), R({ json: 1.5 })] }, cases3);
check('unknown return type is filled from observation (number absorbs int), marked probe + verified', u.returns.type === 'number' && u.returns.type_src === 'probe' && u.returns.verified === true && u.verified === true, u.returns);
check('probe tests are added (kwargs, expected value, src)', u.tests.length === 3 && u.tests[0].src === 'probe' && eq(u.tests[0].kwargs, { data: [1, 2] }) && u.tests[0].expect === 2.5, u.tests);
check('parameters used by successful cases are marked verified', u.params[0].verified === true);
check('a unit with typed params, probed return, and tests becomes trusted', u.tier === 1, u.tier);
check('probe summary recorded', u.probe.cases === 3 && u.probe.ok === 3 && u.probe.observed === 'number');
u = P.applyProbe(mkU({ returns: { type: 'text', type_src: 'stub' } }), { id: 'x', cases: [R(), R()] }, cases3); check('declared type contradicted by observation → conflict, not trusted', u.type_conflict && u.type_conflict.declared === 'text' && u.type_conflict.observed === 'number' && u.tier === 0 && u.verified === false, [u.type_conflict, u.tier]);
u = P.applyProbe(mkU({ returns: { type: 'number', type_src: 'stub' } }), { id: 'x', cases: [R({ type: 'int', json: 3 }), R()] }, cases3); check('declared type confirmed (int fits number) → verified, source unchanged', u.returns.verified === true && u.returns.type_src === 'stub' && !u.type_conflict && u.tier === 1);
u = P.applyProbe(mkU({ returns: { type: 'number', type_src: 'stub' }, tier: 1 }), { id: 'x', cases: [{ ok: false, exc: 'ValueError', msg: 'math domain error' }, { ok: false, exc: 'TypeError', msg: 'bad' }] }, cases3); check('every case failed → not trusted, failures recorded', u.tier === 0 && u.probe.ok === 0 && u.probe.rejected === 2 && u.probe.errors.length === 2 && u.verified === undefined, u.probe);
u = P.applyProbe(mkU(), { id: 'x', cases: [R({ det: false }), R()] }, cases3); check('nondeterministic results are flagged and not used as tests', u.nondeterministic === true && u.verified === false && u.tests.length === 1 && u.tests[0].kwargs.data[0] === 3, [u.tests, u.verified]);
u = P.applyProbe(mkU(), { id: 'x', cases: [R({ jsonable: false }), R({ ok: true, jsonable: true, json: undefined, type: 'null', repr: 'None' })] }, cases3); check('non-JSON results are not tests; None is', u.tests.length === 1 && u.tests[0].expect === null, u.tests);
u = P.applyProbe(mkU(), { id: 'x', cases: [{ ok: false, exc: 'Blocked', blocked: true, msg: 'blocked:open' }, R()] }, cases3); check('blocked calls are counted', u.probe.blocked === 1 && u.probe.ok === 1);
u = P.applyProbe(mkU(), { id: 'x', cases: [], import_error: 'ModuleNotFoundError: x' }, []); check('import error → no trust', u.probe.import_error && u.tier === 0 && u.probe.ok === 0);
u = P.applyProbe(mkU(), { id: 'x', cases: [R({ type: 'text', json: 'a' }), R()] }, cases3); check('mixed observed types do not become a guessed return type', u.returns.type === 'any' && u.verified === true, u.returns);
u = P.applyProbe(mkU({ tests: [1, 2, 3, 4].map((i) => ({ expr: 'x' + i, expect: '1', src: 'doctest' })) }), { id: 'x', cases: [R(), R(), R()] }, cases3); check('test list is capped at 5', u.tests.length === 5);
check('applied units still validate', eq(C.validateUnit(P.applyProbe(mkU(), { id: 'x', cases: [R()] }, cases3)), []), C.validateUnit(P.applyProbe(mkU(), { id: 'x', cases: [R()] }, cases3)));
const st = P.probeStats([P.applyProbe(mkU(), { id: 'a', cases: [R()] }, cases3), P.applyProbe(mkU(), { id: 'b', cases: [{ ok: false, exc: 'TypeError' }] }, cases3), mkU()]);
check('stats', st.probed === 2 && st.any_ok === 1 && st.all_failed === 1 && st.verified === 1 && st.tier1 === 1, st);

u = P.applyProbe(U('prod', [['seq', 'list<number>']], { returns: { type: 'any', type_src: 'none' }, tier: 0 }), { id: 'x', cases: [R({ type: 'int', json: 24 })] }, [{ args: [], kwargs: { seq: [1, 2, 3, 4] } }]); check('an int seen from number-like inputs is widened to number (may return float for float inputs)', u.returns.type === 'number' && u.returns.widened === true, u.returns);
u = P.applyProbe(U('count', [['s', 'text']], { returns: { type: 'any', type_src: 'none' }, tier: 0 }), { id: 'x', cases: [R({ type: 'int', json: 3 })] }, [{ args: [], kwargs: { s: 'abc' } }]); check('an int from non-numeric inputs stays int', u.returns.type === 'int' && !u.returns.widened, u.returns);
// --- 靜態純函式：探測驗證過才信任；被擋下的事件學成副作用
const sp = (extra) => U('sp', [['a', 'int']], Object.assign({ pure_src: 'static', returns: { type: 'int', type_src: 'annotation' }, tier: 0, avail: { state: 'installed', needs: [] } }, extra || {}));
let us = P.applyProbe(sp(), { id: 'x', cases: [R({ type: 'int', json: 3 })] }, [{ args: [], kwargs: { a: 1 } }]); check('static-pure + verified by probe → trusted', us.verified === true && us.tier === 1, [us.tier, us.verified]);
us = P.applyProbe(sp(), { id: 'x', cases: [{ ok: false, exc: 'TypeError', msg: 'x' }] }, [{ args: [], kwargs: { a: 1 } }]); check('static-pure but every probe failed → not trusted', us.tier === 0);
us = sp(); P.retier(us); check('static-pure without a probe is never trusted', us.tier === 0);
us = P.applyProbe(sp(), { id: 'x', cases: [{ ok: false, exc: 'Blocked', blocked: true, msg: 'blocked:socket.connect' }, R({ type: 'int', json: 3 })] }, [{ args: [], kwargs: { a: 1 } }, { args: [], kwargs: { a: 2 } }]); check('a blocked network call teaches the unit it has the net effect (and it is no longer pure)', eq(us.effects, ['net']) && us.pure === false && eq(us.learned_effects, ['net']) && us.effects_src === 'probe', [us.effects, us.pure]);
us = P.applyProbe(sp({ effects: ['unknown'], pure: false }), { id: 'x', cases: [{ ok: false, exc: 'Blocked', blocked: true, msg: 'blocked:open' }] }, [{ args: [], kwargs: { a: 1 } }]); check('learned effects replace "unknown"', eq(us.effects, ['fs.read', 'fs.write']), us.effects);
us = P.applyProbe(sp({ effects: ['fs.read'], pure: false }), { id: 'x', cases: [{ ok: false, exc: 'Blocked', blocked: true, msg: 'blocked:socket.connect' }] }, [{ args: [], kwargs: { a: 1 } }]); check('learning only adds effects, never removes known ones', eq(us.effects, ['fs.read', 'net']), us.effects);
check('event → effect map', eq(P.eventEffects('subprocess.Popen'), ['proc']) && eq(P.eventEffects('os.remove'), ['fs.write']) && eq(P.eventEffects('webbrowser.open'), ['proc', 'ui']) && eq(P.eventEffects('nothing'), []));

// --- 真的跑探測腳本
function findPython() { for (const c of ['python', 'python3', 'py']) { try { const r = cp.spawnSync(c, ['-c', 'import sys;assert sys.version_info>=(3,9);print(1)'], { encoding: 'utf8' }); if (r.status === 0) return c; } catch (_) { /* */ } } return null; }
const py = findPython();
function runPy(file, placeholder, req) { const src = fs.readFileSync(path.join(__dirname, file), 'utf8'); const code = src.replace(placeholder, () => JSON.stringify(JSON.stringify(req))); const r = cp.spawnSync(py, ['-I', '-c', code], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 60000 }); return r; }
if (!py) skipped = '（沒有 python，略過真實探測）'; else {
    // 1) 抽取 + 存根 → 單元（只取幾個純函式）
    const ex = runPy('extract_py.py', '__FA_REQ__', { modules: ['statistics', 'math', 'json'], max_per_module: 400, doctest: true }); const exLine = ex.stdout.split('\n').find((l) => l.startsWith('FA_EXTRACT_RESULT:')); check('extractor ran', !!exLine, ex.stderr.slice(0, 200));
    const stubFile = path.join(__dirname, 'data', 'stdlib_types.json'); const stubs = fs.existsSync(stubFile) ? JSON.parse(fs.readFileSync(stubFile, 'utf8')) : null;
    const protos = JSON.parse(exLine.slice('FA_EXTRACT_RESULT:'.length)).protos; const want = new Set(['statistics.mean', 'statistics.median', 'statistics.stdev', 'math.sqrt', 'math.comb', 'math.isclose', 'json.dumps', 'json.loads']);
    const units = protos.filter((p) => want.has(p.module + '.' + p.name)).map((p) => C.unitFromPyProto(p, { stubs })); check('picked the pure units', units.length === want.size, units.map((x) => x.id));
    const jobs = [], caseMap = new Map(); for (const un of units) { const bc2 = P.buildCases(un); if (bc2.cases) { jobs.push({ id: un.id, module: un.call.import, name: un.call.qualname, cases: bc2.cases }); caseMap.set(un.id, bc2.cases); } }
    // 2) 危險的、會出錯的、不確定的呼叫（探測腳本自己的保護）
    jobs.push({ id: 'evil:open', module: 'builtins', name: 'open', cases: [{ args: ['/tmp/should_not_exist_fa_probe.txt', 'w'], kwargs: {} }] });
    jobs.push({ id: 'evil:system', module: 'os', name: 'system', cases: [{ args: ['echo hacked'], kwargs: {} }] });
    jobs.push({ id: 'evil:exit', module: 'sys', name: 'exit', cases: [{ args: [3], kwargs: {} }] });
    jobs.push({ id: 'rand', module: 'random', name: 'random', cases: [{ args: [], kwargs: {} }] });
    jobs.push({ id: 'missing', module: 'no_such_module_zz', name: 'f', cases: [{ args: [], kwargs: {} }] });
    jobs.push({ id: 'bytes', module: 'len', name: 'x', cases: [] });
    const r = runPy('probe_py.py', '__FA_PROBE_REQ__', { jobs, max_repr: 200 }); check('probe script ran to the end (SystemExit did not kill it)', r.status === 0 && r.stdout.includes('FA_PROBE_RESULT:'), r.stderr.slice(0, 300));
    const pr = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('FA_PROBE_RESULT:')).slice('FA_PROBE_RESULT:'.length)); const J = (id) => pr.jobs.find((j) => j.id === id);
    check('audit hook available', pr.audit === true);
    check('open() is blocked and the file was not created', J('evil:open').cases[0].blocked === true && !fs.existsSync('/tmp/should_not_exist_fa_probe.txt') && !fs.existsSync('C:/tmp/should_not_exist_fa_probe.txt'), J('evil:open'));
    check('os.system is blocked', J('evil:system').cases[0].blocked === true, J('evil:system'));
    check('SystemExit becomes a recorded failure', J('evil:exit').cases[0].ok === false && J('evil:exit').cases[0].exc === 'SystemExit', J('evil:exit'));
    check('random.random is flagged nondeterministic', J('rand').cases[0].ok === true && J('rand').cases[0].det === false, J('rand'));
    check('missing module is an import error, others continue', /ModuleNotFoundError/.test(J('missing').import_error || '') && J('py:statistics.mean') !== undefined);
    // 3) 套回單元
    const byId = new Map(units.map((x) => [x.id, x])); for (const j of pr.jobs) if (byId.has(j.id)) P.applyProbe(byId.get(j.id), j, caseMap.get(j.id));
    const mean = byId.get('py:statistics.mean'); check('statistics.mean: verified, number, probe tests, trusted', mean.verified === true && mean.returns.type === 'number' && mean.tests.some((t) => t.src === 'probe') && mean.tier === 1, [mean.probe, mean.returns, mean.tier]);
    const probeTest = mean.tests.find((t) => t.src === 'probe'); const check2 = runPy('probe_py.py', '__FA_PROBE_REQ__', { jobs: [{ id: 'replay', module: 'statistics', name: 'mean', cases: [{ args: probeTest.args, kwargs: probeTest.kwargs }] }] }); const rep = JSON.parse(check2.stdout.split('\n').find((l) => l.startsWith('FA_PROBE_RESULT:')).slice('FA_PROBE_RESULT:'.length)); check('a probe test replays to the same value', rep.jobs[0].cases[0].json === probeTest.expect, [probeTest, rep.jobs[0].cases[0]]);
    const sq = byId.get('py:math.sqrt'); check('math.sqrt: some cases ok', sq.probe.ok >= 1 && sq.returns.type === 'number', sq.probe);
    const loads = byId.get('py:json.loads'); check('json.loads: generic text is not valid JSON, so it stays unverified (honest) and the failures count as rejected inputs, not breakage', loads.probe.ok === 0 && loads.probe.rejected === loads.probe.cases && loads.tier === 0, loads.probe);
    check('a failed-everything unit is not given test cases', loads.tests.every((x) => x.src !== 'probe'));
    jobs.length = 0; jobs.push({ id: 'math.log', module: 'math', name: 'log', cases: [{ args: [], kwargs: { x: 8.0, base: 2.0 } }] }, { id: 'hash', module: 'hashlib', name: 'md5', cases: [{ args: [{ $bytes: 'YWJj' }], kwargs: {} }] });
    const r3 = runPy('probe_py.py', '__FA_PROBE_REQ__', { jobs, max_repr: 200 }); const pr3 = JSON.parse(r3.stdout.split('\n').find((l) => l.startsWith('FA_PROBE_RESULT:')).slice('FA_PROBE_RESULT:'.length)); const lg = pr3.jobs[0].cases[0];
    check('keyword call on a positional-only function retries positionally and says so', lg.ok === true && lg.positional === true && lg.json === 3, lg);
    check('object addresses in repr do not make a result look nondeterministic', pr3.jobs[1].cases[0].ok === true && pr3.jobs[1].cases[0].det === true && !/0x/.test(pr3.jobs[1].cases[0].repr), pr3.jobs[1].cases[0]);
    const ul = U('log', [['x', 'number', true, 'named'], ['base', 'number', false, 'named']]); P.applyProbe(ul, pr3.jobs[0], [{ args: [], kwargs: { x: 8.0, base: 2.0 } }]); check('applyProbe turns such params positional and records a positional test', ul.params[0].kind === 'positional' && ul.tests[0].args.length === 2 && Object.keys(ul.tests[0].kwargs).length === 0, [ul.params, ul.tests]);
    const slow = runPy('probe_py.py', '__FA_PROBE_REQ__', { jobs: [{ id: 's', module: 'time', name: 'sleep', cases: [{ args: [0.01], kwargs: {} }] }] }); check('slow-call plumbing works (time.sleep is not blocked; real timeouts are the hosts job)', slow.status === 0);
    check('every probed unit still validates', units.every((x) => C.validateUnit(x).length === 0), units.filter((x) => C.validateUnit(x).length).map((x) => [x.id, C.validateUnit(x)[0]]));
    console.log('  真實探測：', P.probeStats(units));
}
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'probe_core: ' + ok + ' passed' + skipped); process.exit(bad.length ? 1 : 0);
