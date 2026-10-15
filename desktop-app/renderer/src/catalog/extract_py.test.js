// node renderer/src/catalog/extract_py.test.js —— Python 原型 → 單元的轉換；有 python 時，另外真的跑一次抽取腳本（沒有 python 就略過那一段）
const C = require('./catalog_core.js'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');
let ok = 0; const bad = []; let skipped = '';
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 註解 → 型別
const T = C.pyTypeToType;
check('simple types', T('str') === 'text' && T('int') === 'int' && T('float') === 'number' && T('bool') === 'bool' && T('bytes') === 'bytes' && T('None') === 'null');
check('containers', T('list[str]') === 'list<text>' && T('List[int]') === 'list<int>' && T('Sequence[float]') === 'list<number>' && T('Iterable[Any]') === 'list<any>' && T('tuple[int, str]') === 'list<any>' && T('set[str]') === 'list<text>');
check('dict is dict', T('dict[str, Any]') === 'dict' && T('Mapping[str, int]') === 'dict' && T('Dict') === 'dict');
check('optional and unions', T('Optional[int]') === 'int' && T('int | None') === 'int' && T('Union[int, str]') === 'union<int|text>' && T('str | int | None') === 'union<text|int>' && T('Union[str, None]') === 'text');
check('nested generics', T('list[list[str]]') === 'list<list<text>>' && T('Optional[list[int]]') === 'list<int>' && T('dict[str, list[int]] | None') === 'dict');
check('path-like and typing prefix', T('Path') === 'path' && T('os.PathLike') === 'path' && T('typing.List[str]') === 'list<text>' && T("<class 'int'>") === 'int');
check('callable stays callable', T('Callable[[int], str]') === 'callable' && T('callable') === 'callable');
check('literal becomes enum', T("Literal['a', 'b']") === 'enum<a|b>');
check('unknown annotations are not guessed', T('MyWeirdClass') === null && T('Foo[Bar]') === null && T(null) === null && T(undefined) === null && T('') === null);
check('every produced type parses', ['str', 'list[list[str]]', 'Union[int, str]', "Literal['x']", 'Optional[list[int]]', 'Mapping[str, int]'].every((a) => { try { C.parseType(T(a)); return true; } catch (_) { return false; } }));

// --- 原型 → 單元
const P = (o) => Object.assign({ module: 'statistics', name: 'mean', summary: 'Return the mean of data. More.', params: [{ name: 'data', kind: 'POSITIONAL_OR_KEYWORD', default: null, annotation: null }], sig_src: 'inspect', returns: null, effects: [], pure: true, stdlib: true, version: null, tests: [{ expr: 'mean([1, 2])', expect: '1.5', src: 'doctest' }], has_doc: true }, o || {});
let u = C.unitFromPyProto(P());
check('unit identity, launch path', u.id === 'py:statistics.mean' && u.runtime === 'python' && u.name === 'statistics.mean' && eq(u.call, { runtime: 'python', import: 'statistics', qualname: 'mean', via: 'pyodide' }), u);
check('unannotated, unknown-name param is untyped → tier 0', u.params[0].type === 'any' && u.params[0].type_src === 'none' && u.tier === 0);
check('unit validates', eq(C.validateUnit(u), []), C.validateUnit(u));
check('pure unit has no effects', u.pure === true && eq(u.effects, []) && u.avail.state === 'builtin');
check('tests carried over', u.tests.length === 1 && u.tests[0].expr === 'mean([1, 2])');
u = C.unitFromPyProto(P({ params: [{ name: 'path', kind: 'POSITIONAL_OR_KEYWORD', default: null, annotation: null }, { name: 'n', kind: 'KEYWORD_ONLY', default: '3', annotation: null }, { name: 'flag', kind: 'POSITIONAL_OR_KEYWORD', default: 'False', annotation: null }, { name: 'label', kind: 'POSITIONAL_OR_KEYWORD', default: "'x'", annotation: null }] }));
check('param types: name, then default', eq(u.params.map((p) => p.type + ':' + p.type_src), ['path:name', 'int:default', 'bool:default', 'text:default']), u.params);
check('required / kind', eq(u.params.map((p) => p.required), [true, false, false, false]) && eq(u.params.map((p) => p.kind), ['named', 'keyword', 'named', 'named']) && u.params[1].default === '3');
check('fully typed + test → tier 1', u.tier === 1, u.tier);
u = C.unitFromPyProto(P({ params: [{ name: 'x', kind: 'POSITIONAL_ONLY', default: null, annotation: 'int' }], tests: [], returns: 'float' })); check('annotation wins; typed return gives tier 1 without tests', u.params[0].type === 'int' && u.params[0].type_src === 'annotation' && u.params[0].kind === 'positional' && u.returns.type === 'number' && u.returns.type_src === 'annotation' && u.tier === 1);
u = C.unitFromPyProto(P({ params: [{ name: 'x', kind: 'POSITIONAL_ONLY', default: null, annotation: 'int' }], tests: [], returns: null })); check('typed params but nothing to verify against → tier 0', u.tier === 0);
u = C.unitFromPyProto(P({ params: [{ name: 'key', kind: 'KEYWORD_ONLY', default: 'None', annotation: 'Callable' }] })); check('callable params cannot be passed as JSON → tier 0', u.params[0].type === 'callable' && u.tier === 0);
u = C.unitFromPyProto(P({ params: [{ name: 'a', kind: 'VAR_POSITIONAL', default: null, annotation: null }, { name: 'k', kind: 'VAR_KEYWORD', default: null, annotation: null }, { name: 'x', kind: 'POSITIONAL_OR_KEYWORD', default: null, annotation: 'int' }] })); check('*args/**kwargs are left out', eq(u.params.map((p) => p.name), ['x']));
u = C.unitFromPyProto(P({ params: null, sig_src: null })); check('no signature → tier 0, still valid', u.tier === 0 && u.sig_src === 'none' && eq(C.validateUnit(u), []));
u = C.unitFromPyProto(P({ effects: ['fs.read'], pure: false })); check('effects kept, not pure', eq(u.effects, ['fs.read']) && u.pure === false && eq(C.validateUnit(u), []));
u = C.unitFromPyProto(P({ effects: ['unknown'], pure: false })); check('unknown effects → tier 0', u.effects[0] === 'unknown' && u.tier === 0);
u = C.unitFromPyProto(P({ effects: [], pure: false })); check('not pure and no effect info becomes unknown (conservative)', eq(u.effects, ['unknown']));
u = C.unitFromPyProto(P({ module: 'numpy.linalg', name: 'norm', stdlib: false }), { installed: ['numpy'] }); check('non-stdlib: installed vs needs-network', u.avail.state === 'installed');
u = C.unitFromPyProto(P({ module: 'requests', name: 'get', stdlib: false }), { installed: [] }); check('not installed → needs-network → tier 0', u.avail.state === 'needs-network' && u.tier === 0);
check('catalog accepts extra units and counts them', (() => { const cat = C.buildCatalog({}, {}, { extraUnits: [C.unitFromPyProto(P())] }); return cat.units.length === 1 && cat.stats.units === 1 && cat.stats.invalid === 0; })());

// --- 真的跑抽取腳本（需要本機有 python）
function findPython() { for (const c of ['python', 'python3', 'py']) { try { const r = cp.spawnSync(c, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' }); if (r.status === 0 && /3/.test(r.stdout)) return c; } catch (_) { /* */ } } return null; }
const py = findPython();
if (!py) skipped = '（沒有 python，略過真實抽取）'; else {
    const src = fs.readFileSync(path.join(__dirname, 'extract_py.py'), 'utf8'); const req = { modules: ['statistics', 'json', 'math', 'os.path', 'datetime', 'shutil', 'no_such_module_zz'], max_per_module: 400, doctest: true };
    const code = src.replace('__FA_REQ__', JSON.stringify(JSON.stringify(req)));
    const r = cp.spawnSync(py, ['-I', '-c', code], { encoding: 'utf8', maxBuffer: 1 << 26 }); check('extractor runs', r.status === 0, r.stderr.slice(0, 300));
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('FA_EXTRACT_RESULT:')); check('extractor prints one result line', !!line);
    if (line) {
        const res = JSON.parse(line.slice('FA_EXTRACT_RESULT:'.length));
        check('missing module is reported, others continue', res.errors.length === 1 && res.errors[0].module === 'no_such_module_zz' && Object.keys(res.modules).length === 6, [res.errors, Object.keys(res.modules)]);
        const by = (m, n) => res.protos.find((p) => p.module === m && p.name === n);
        const mean = by('statistics', 'mean'); check('statistics.mean: signature, pure, doctest', mean && mean.params.length === 1 && mean.params[0].name === 'data' && mean.pure === true && mean.tests.length >= 1 && mean.stdlib === true, mean);
        check('os.path.exists reads the file system, getsize too, join is pure', by('os.path', 'exists').effects[0] === 'fs.read' && by('os.path', 'getsize').effects[0] === 'fs.read' && by('os.path', 'join').pure === true);
        check('shutil is not pure and not unknown', by('shutil', 'copy').pure === false && by('shutil', 'copy').effects.includes('fs.write'));
        check('keyword-only and defaults are recorded', (() => { const l = by('json', 'loads'); const k = l.params.find((p) => p.name === 'object_hook'); return k && k.kind === 'KEYWORD_ONLY' && k.default === 'None'; })());
        check('positional-only is recorded', by('math', 'sqrt').params[0].kind === 'POSITIONAL_ONLY');
        check('classes are not extracted as functions', !by('datetime', 'datetime') && !by('datetime', 'date'));
        const units = res.protos.map((p) => C.unitFromPyProto(p)); const bad2 = units.filter((x) => C.validateUnit(x).length);
        check('every extracted proto becomes a valid unit', bad2.length === 0, bad2.slice(0, 3).map((x) => [x.id, C.validateUnit(x)[0]]));
        const sigPct = res.protos.filter((p) => p.params !== null).length / res.protos.length; check('signature coverage on stdlib is high', sigPct > 0.9, sigPct);
        check('no unit is trusted just from a stdlib signature with no types and no tests', units.filter((x) => x.tier === 1).every((x) => x.tests.length > 0 || x.returns.type_src === 'annotation'));
    }
}
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'extract_py: ' + ok + ' passed' + skipped); process.exit(bad.length ? 1 : 0);
