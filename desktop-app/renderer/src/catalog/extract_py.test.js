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
u = C.unitFromPyProto(P({ params: [{ name: 'key', kind: 'KEYWORD_ONLY', default: 'None', annotation: 'Callable' }] })); check('an OPTIONAL callable param does not block trust (just do not pass it)', u.params[0].type === 'callable' && u.params[0].required === false && u.tier === 1, u.tier);
u = C.unitFromPyProto(P({ params: [{ name: 'key', kind: 'POSITIONAL_OR_KEYWORD', default: null, annotation: 'Callable' }] })); check('a REQUIRED callable param cannot be passed as JSON → tier 0', u.params[0].required === true && u.tier === 0);
u = C.unitFromPyProto(P({ params: [{ name: 'x', kind: 'POSITIONAL_OR_KEYWORD', default: null, annotation: 'int' }, { name: 'opt', kind: 'KEYWORD_ONLY', default: 'None', annotation: null }] })); check('an optional untyped param does not block trust either', u.params[1].type === 'any' && u.tier === 1, u.tier);
u = C.unitFromPyProto(P({ params: [{ name: 'x', kind: 'POSITIONAL_OR_KEYWORD', default: null, annotation: null }] })); check('but a required untyped one does', u.tier === 0);
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

// --- 第三方模組：靜態判斷純函式、匯入保護、版本
if (py) {
    const os = require('os'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa_ex_')); const w = (n, s) => fs.writeFileSync(path.join(dir, n), s);
    w('fa_pure_mod.py', 'def add(a: int, b: int) -> int:\n    """Add two numbers."""\n    return a + b\n\ndef greet(name, punct="!"):\n    return "hi " + name + punct\n');
    w('fa_io_mod.py', 'import os\n\ndef cwd():\n    return os.getcwd()\n');
    w('fa_open_mod.py', 'def read(p):\n    return open(p).read()\n');
    w('fa_net_import.py', 'import socket\ns = socket.socket()\ns.connect(("127.0.0.1", 9))\ndef f():\n    return 1\n');
    w('fa_exec_mod.py', 'def run(code):\n    return eval(code)\n');
    const code = fs.readFileSync(path.join(__dirname, 'extract_py.py'), 'utf8').replace('__FA_REQ__', () => JSON.stringify(JSON.stringify({ modules: ['fa_pure_mod', 'fa_io_mod', 'fa_open_mod', 'fa_net_import', 'fa_exec_mod'], packages: ['pip', 'no_such_pkg_zz'], sys_path: [dir], max_per_module: 50, doctest: true })));
    const r = cp.spawnSync(py, ['-I', '-c', code], { encoding: 'utf8', maxBuffer: 1 << 26 }); const line = (r.stdout || '').split('\n').find((l) => l.startsWith('FA_EXTRACT_RESULT:')); check('third-party extraction runs', !!line, r.stderr.slice(0, 300));
    if (line) {
        const res = JSON.parse(line.slice('FA_EXTRACT_RESULT:'.length)); const by = (m, n) => res.protos.find((p) => p.module === m && p.name === n);
        check('a module with no risky imports/calls is statically pure (marked static, not allowlist)', by('fa_pure_mod', 'add').pure === true && by('fa_pure_mod', 'add').pure_src === 'static' && by('fa_pure_mod', 'greet').pure === true && by('fa_pure_mod', 'add').stdlib === false, by('fa_pure_mod', 'add'));
        check('os.getcwd is a file-system read (function-level, not the whole os module), with evidence', by('fa_io_mod', 'cwd').pure === false && eq(by('fa_io_mod', 'cwd').effects, ['fs.read']) && by('fa_io_mod', 'cwd').effects_src === 'static' && by('fa_io_mod', 'cwd').effect_evidence[0] === 'os.getcwd', by('fa_io_mod', 'cwd'));
        check('open() is a read; eval() is unknown (cannot reason about it)', eq(by('fa_open_mod', 'read').effects, ['fs.read']) && eq(by('fa_exec_mod', 'run').effects, ['unknown']) && by('fa_exec_mod', 'run').pure === false);
        check('annotations come through for third-party code', by('fa_pure_mod', 'add').params[0].annotation === 'int' && by('fa_pure_mod', 'add').returns === 'int');
        const u = C.unitFromPyProto(by('fa_pure_mod', 'add'), { installed: ['fa_pure_mod'] }); check('statically-pure unit is NOT trusted until probed (even though fully typed)', u.pure === true && u.pure_src === 'static' && u.tier === 0 && u.avail.state === 'installed', [u.tier, u.pure_src]);
        check('a network call at import time is blocked and reported, the extractor continues', res.errors.some((e) => e.module === 'fa_net_import' && /blocked-at-import|socket/.test(e.error)) && !!by('fa_pure_mod', 'add'), res.errors);
        check('package versions: installed one has a version, missing one is null', typeof res.pkg_versions.pip === 'string' && res.pkg_versions.no_such_pkg_zz === null, res.pkg_versions);
    }
    // --- 函式層級副作用分析
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fa_fx_')); const w2 = (n, s) => fs.writeFileSync(path.join(d2, n), s);
    w2('fa_mystery.py', 'def go():\n    return 1\n');
    w2('requests.py', 'def get(url):\n    return url\n'); // 假的第三方模組（沒有被分析，所以呼叫它的函式是 unknown）
    w2('fa_helper.py', 'import os\n\ndef wipe(p):\n    os.remove(p)\n\ndef pure_helper(x):\n    return x * 2\n');
    w2('fa_fx.py', [
        'import os, sys, json, time, random, subprocess, socket, logging',
        'import fa_helper',
        'from pathlib import Path',
        'from fa_helper import wipe',
        'import requests',
        'import fa_mystery',
        '_cache = {}',
        '_count = 0',
        'def pure_math(a, b):\n    return json.dumps({"s": a + b})',
        'def read_file(p):\n    with open(p) as f:\n        return f.read()',
        'def read_bin(p):\n    return open(p, "rb").read()',
        'def write_file(p, s):\n    with open(p, "w") as f:\n        f.write(s)',
        'def append_file(p, s):\n    open(p, mode="a").write(s)',
        'def rw_file(p):\n    return open(p, "r+")',
        'def dyn_mode(p, m):\n    return open(p, m)',
        'def uses_env():\n    return os.getenv("HOME")',
        'def lists_dir(p):\n    return os.listdir(p)',
        'def removes(p):\n    os.remove(p)',
        'def runs(cmd):\n    return subprocess.run(cmd)',
        'def sleeps():\n    time.sleep(1)',
        'def rands():\n    return random.random()',
        'def logs(m):\n    logging.info(m)',
        'def prints(m):\n    print(m)',
        'def calls_pure_helper(x):\n    return pure_math(x, 1)',
        'def calls_reader(p):\n    return read_file(p)',
        'def chain2(p):\n    return calls_reader(p)',
        'def recursive(n):\n    if n:\n        return recursive(n - 1)\n    return write_file("x", "y")',
        'def sets_global():\n    global _count\n    _count += 1',
        'def mutates_global(k):\n    _cache.append(k)',
        'def reads_global(k):\n    return _cache.get(k)',
        'def calls_param(cb, x):\n    return cb(x)',
        'def file_like(fp, data):\n    fp.write(data)\n    return fp.read()',
        'def sock(host):\n    s = socket.socket()\n    s.connect((host, 80))',
        'def method_net(client):\n    return client.sendall(b"x")',
        'def pathlib_pure(p):\n    return Path(p).name',
        'def pathlib_read(p):\n    return Path(p).read_text()',
        'def http_get(url):\n    return requests.get(url)',
        'def mystery_lib():\n    return fa_mystery.go()',
        'def other_module_effect(p):\n    return fa_helper.wipe(p)',
        'def other_module_pure(x):\n    return fa_helper.pure_helper(x)',
        'def from_import_effect(p):\n    return wipe(p)',
        'def evals(s):\n    return eval(s)',
        'def sys_exit():\n    sys.exit(1)',
        'def sys_pure(x):\n    return sys.getsizeof(x)',
        'def sets_module_attr():\n    sys.stdout = None',
        'def local_import(p):\n    import shutil\n    shutil.rmtree(p)',
        'class Box:\n    def __init__(self, p):\n        self.data = open(p).read()\n    def get(self):\n        return self.data',
        'def make_box(p):\n    return Box(p)',
        'def unclassified_os():\n    return os.get_blocking(0)',
        'def nested():\n    def inner(p):\n        os.remove(p)\n    return inner',
    ].join('\n') + '\n');
    const code2 = fs.readFileSync(path.join(__dirname, 'extract_py.py'), 'utf8').replace('__FA_REQ__', () => JSON.stringify(JSON.stringify({ modules: ['fa_helper', 'fa_fx'], sys_path: [d2], max_per_module: 200, doctest: false })));
    const r2 = cp.spawnSync(py, ['-I', '-c', code2], { encoding: 'utf8', maxBuffer: 1 << 26 }); const line2 = (r2.stdout || '').split('\n').find((l) => l.startsWith('FA_EXTRACT_RESULT:')); check('effect fixture extracts (requests is not installed, that is fine)', !!line2 && r2.status === 0, r2.stderr.slice(0, 300));
    if (line2) {
        const res2 = JSON.parse(line2.slice('FA_EXTRACT_RESULT:'.length)); const f = (n) => res2.protos.find((p) => p.module === 'fa_fx' && p.name === n); const E = (n) => (f(n) ? f(n).effects : null);
        check('pure code: no effects, pure, static', eq(E('pure_math'), []) && f('pure_math').pure === true && f('pure_math').pure_src === 'static');
        check('open(): default and "rb" are reads; "w" and "a" are writes; "r+" is both; a variable mode is both', eq(E('read_file'), ['fs.read']) && eq(E('read_bin'), ['fs.read']) && eq(E('write_file'), ['fs.write']) && eq(E('append_file'), ['fs.write']) && eq(E('rw_file'), ['fs.read', 'fs.write']) && eq(E('dyn_mode'), ['fs.read', 'fs.write']), ['read_file', 'read_bin', 'write_file', 'append_file', 'rw_file', 'dyn_mode'].map(E));
        check('os functions by name: getenv=env, listdir=read, remove=write', eq(E('uses_env'), ['env']) && eq(E('lists_dir'), ['fs.read']) && eq(E('removes'), ['fs.write']));
        check('subprocess=proc, sleep=time, random=random, logging and print=ui', eq(E('runs'), ['proc']) && eq(E('sleeps'), ['time']) && eq(E('rands'), ['random']) && eq(E('logs'), ['ui']) && eq(E('prints'), ['ui']));
        check('calls inside the module are followed (pure→pure, reader→reader, 2 hops)', eq(E('calls_pure_helper'), []) && eq(E('calls_reader'), ['fs.read']) && eq(E('chain2'), ['fs.read']) && f('chain2').effect_evidence.some((x) => /calls/.test(x)), f('chain2'));
        check('recursion terminates and picks up the effect', eq(E('recursive'), ['fs.write']));
        check('global statement and mutating a module-level container are state writes; reading one is not', eq(E('sets_global'), ['state.write']) && eq(E('mutates_global'), ['state.write']) && eq(E('reads_global'), []));
        check('calling a parameter (callback) and using a file-like argument are not environment effects', eq(E('calls_param'), []) && f('calls_param').pure === true && eq(E('file_like'), []));
        check('method names that only mean I/O count even on unknown receivers (connect/sendall)', eq(E('sock'), ['net']) && eq(E('method_net'), ['net']));
        check('pathlib: constructing a Path and .name are pure, .read_text is a read', eq(E('pathlib_pure'), []) && eq(E('pathlib_read'), ['fs.read']));
        check('a well-known network library is net; an unknown third-party library is unknown (conservative)', eq(E('http_get'), ['net']) && f('http_get').effect_evidence[0] === 'requests.get' && eq(E('mystery_lib'), ['unknown']) && f('mystery_lib').effect_evidence.some((x) => /unresolved fa_mystery/.test(x)), [f('http_get'), f('mystery_lib')]);
        check('cross-module: a helper analysed earlier in the same run gives its effects (and its pure functions stay pure)', eq(E('other_module_effect'), ['fs.write']) && eq(E('other_module_pure'), []) && eq(E('from_import_effect'), ['fs.write']), [E('other_module_effect'), E('other_module_pure'), E('from_import_effect')]);
        check('eval is unknown', eq(E('evals'), ['unknown']));
        check('sys.exit is env; sys.getsizeof is pure; assigning sys.stdout is a state write', eq(E('sys_exit'), ['env']) && eq(E('sys_pure'), []) && eq(E('sets_module_attr'), ['state.write']));
        check('imports inside a function are resolved (shutil.rmtree touches the file system)', E('local_import').includes('fs.write') && E('local_import').every((x) => x.startsWith('fs.')), E('local_import'));
        check('constructing a class takes the effects of its methods', eq(E('make_box'), ['fs.read']), f('make_box'));
        check('unclassified os function is unknown, not silently pure', eq(E('unclassified_os'), ['unknown']));
        check('nested function bodies count', eq(E('nested'), ['fs.write']));
        check('the helper module was analysed on its own', res2.protos.find((p) => p.module === 'fa_helper' && p.name === 'wipe').effects[0] === 'fs.write' && res2.protos.find((p) => p.module === 'fa_helper' && p.name === 'pure_helper').pure === true);
        const un = res2.protos.filter((p) => p.module === 'fa_fx').map((p) => C.unitFromPyProto(p, { installed: ['fa_fx'] })); check('units from effect analysis validate', un.every((x) => C.validateUnit(x).length === 0), un.filter((x) => C.validateUnit(x).length).map((x) => [x.id, C.validateUnit(x)[0]]));
        const ur = un.find((x) => x.name === 'fa_fx.read_file'); check('an analysed impure unit keeps its evidence and source', eq(ur.effects, ['fs.read']) && ur.effects_src === 'static' && ur.effect_evidence[0] === 'open()', ur);
    }
    fs.rmSync(d2, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'extract_py: ' + ok + ' passed' + skipped); process.exit(bad.length ? 1 : 0);
