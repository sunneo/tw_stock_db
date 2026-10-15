// node renderer/src/catalog/stub_to_types.test.js —— 型別存根轉換（需要本機有 python 3.9+；沒有就略過）+ 存根型別套進單元
const C = require('./catalog_core.js'); const cp = require('child_process'); const path = require('path');
let ok = 0; const bad = []; let skipped = '';
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 存根型別名稱 → 型別（typeshed 常用的名稱）
const T = C.pyTypeToType;
check('typeshed numeric protocols', T('SupportsFloat') === 'number' && T('SupportsIndex') === 'int' && T('SupportsInt') === 'int' && T('SupportsAbs[float]') === 'number');
check('typeshed buffers and paths', T('ReadableBuffer') === 'bytes' && T('Buffer') === 'bytes' && T('StrPath') === 'path' && T('StrOrBytesPath') === 'path' && T('FileDescriptorOrPath') === 'path' && T('PathLike[str]') === 'path');
check('expanded alias unions', T('str | PathLike[str]') === 'path' && T('float | Decimal | Fraction') === 'number' && T('int | float') === 'number' && T('str | bytes') === 'union<text|bytes>');
check('stub generics', T('Iterable[float]') === 'list<number>' && T('Sequence[str] | None') === 'list<text>' && T('list[Any]') === 'list<any>' && T('Literal["a", "b"]') === 'enum<a|b>' && T('Callable[[float], float]') === 'callable');
check('union of number kinds collapses', T('float | Decimal | Fraction | int') === 'union<number|int>' || T('float | Decimal | Fraction | int') === 'number');

function findPython() { for (const c of ['python', 'python3', 'py']) { try { const r = cp.spawnSync(c, ['-c', 'import sys;assert sys.version_info>=(3,9);print(1)'], { encoding: 'utf8' }); if (r.status === 0) return c; } catch (_) { /* */ } } return null; }
const py = findPython();
function convert(stubs, target) {
    const code = 'import json,sys\nsys.path.insert(0,' + JSON.stringify(__dirname) + ')\nimport stub_to_types as s\n' + (target ? 's.TARGET.update(' + JSON.stringify(target) + ')\n' : '') + 'stubs=json.loads(sys.stdin.read())\nt,e=s.convert(stubs)\nprint(json.dumps({"t":t,"e":e}))';
    const r = cp.spawnSync(py, ['-I', '-c', code], { input: JSON.stringify(stubs), encoding: 'utf8', maxBuffer: 1 << 26 }); if (r.status !== 0) throw new Error(r.stderr.slice(-900)); return JSON.parse(r.stdout);
}
const STAT = `import sys
from _typeshed import SupportsRichComparisonT
from collections.abc import Callable, Hashable, Iterable, Sequence
from decimal import Decimal
from fractions import Fraction
from typing import Literal, SupportsFloat, TypeVar
from typing_extensions import TypeAlias

_Number: TypeAlias = float | Decimal | Fraction
_NumberT = TypeVar("_NumberT", float, Decimal, Fraction)
_HashableT = TypeVar("_HashableT", bound=Hashable)
_Unbound = TypeVar("_Unbound")

def mean(data: Iterable[_NumberT]) -> _NumberT: ...
def mode(data: Iterable[_HashableT]) -> _HashableT: ...
def ident(x: _Unbound) -> _Unbound: ...
def quantiles(data: Iterable[_NumberT], *, n: int = 4, method: Literal["inclusive", "exclusive"] = "exclusive") -> list[_NumberT]: ...
def _private(x: int) -> int: ...
if sys.version_info >= (3, 13):
    def kde(data: Sequence[float], h: float, kernel: str = "normal", *, cumulative: bool = False) -> Callable[[float], float]: ...
if sys.version_info >= (3, 8):
    def fmean(data: Iterable[SupportsFloat], weights: Iterable[SupportsFloat] | None = None) -> float: ...
else:
    def fmean(data) -> int: ...
def total(a: _Number, b: _Number = ...) -> _Number: ...
class Foo:
    def method(self, x: int) -> int: ...
`;
const OVL = `from typing import overload
@overload
def f(x: int) -> int: ...
@overload
def f(x: str, y: bool = False) -> str: ...
@overload
def f(x: int, z: float) -> float: ...
def g(a: int, b: str, /, c: float = 1.0, *args: int, d: bool, e: str = "x", **kw: str) -> None: ...
async def agen(x: int) -> str: ...
import sys
if sys.platform == "win32":
    def only_win(a: int) -> None: ...
else:
    def only_posix(a: str) -> None: ...
`;
const TS = `from typing_extensions import TypeAlias
from os import PathLike
StrPath: TypeAlias = str | PathLike[str]
StrOrBytesPath: TypeAlias = str | bytes | PathLike[str] | PathLike[bytes]
ReadableBuffer: TypeAlias = bytes
`;
const PATHS = `from _typeshed import StrOrBytesPath, StrPath
def exists(path: StrOrBytesPath | int) -> bool: ...
def join(a: StrPath, *paths: StrPath) -> str: ...
`;
if (!py) skipped = '（沒有 python，略過存根轉換）'; else {
    let r = convert({ statistics: STAT }, { py: [3, 12], platform: 'linux' }); const s = r.t.statistics;
    check('functions found, private and classes skipped', eq(Object.keys(s).sort(), ['fmean', 'ident', 'mean', 'mode', 'quantiles', 'total']), Object.keys(s));
    check('TypeVar with constraints becomes a union of them', s.mean.params[0].annotation === 'Iterable[float | Decimal | Fraction]' && s.mean.returns === 'float | Decimal | Fraction', s.mean);
    check('TypeVar with a bound becomes the bound; unbound becomes Any', s.mode.params[0].annotation === 'Iterable[Hashable]' && s.ident.params[0].annotation === 'Any' && s.ident.returns === 'Any', [s.mode, s.ident]);
    check('keyword-only and Literal and defaults', (() => { const q = s.quantiles.params; return q[1].name === 'n' && q[1].kind === 'KEYWORD_ONLY' && q[1].has_default === true && q[2].annotation === "Literal['inclusive', 'exclusive']"; })(), s.quantiles);
    check('version branch (3.12 does not have kde, picks the >=3.8 branch of fmean)', !s.kde && s.fmean.params.length === 2 && s.fmean.returns === 'float' && s.fmean.params[1].annotation === 'Iterable[SupportsFloat] | None', s.fmean);
    check('alias expansion inside a function', s.total.params[0].annotation === 'float | Decimal | Fraction' && s.total.params[1].has_default === true, s.total);
    r = convert({ statistics: STAT }, { py: [3, 13], platform: 'linux' }); check('same stub, target 3.13 has kde', !!r.t.statistics.kde && r.t.statistics.kde.params[1].name === 'h' && r.t.statistics.kde.returns === 'Callable[[float], float]');
    r = convert({ m: OVL }, { py: [3, 12], platform: 'linux' }); const o = r.t.m;
    check('overloads merged: union of annotations, union of returns, overload count', o.f.overloads === 3 && o.f.params.find((p) => p.name === 'x').annotation === 'int | str' && o.f.returns === 'int | str | float', o.f);
    check('overloads: parameters not in every overload are optional', o.f.params.find((p) => p.name === 'y').has_default === true && o.f.params.find((p) => p.name === 'z').has_default === true && o.f.params.find((p) => p.name === 'x').has_default === false);
    check('param kinds', eq(o.g.params.map((p) => p.kind), ['POSITIONAL_ONLY', 'POSITIONAL_ONLY', 'POSITIONAL_OR_KEYWORD', 'VAR_POSITIONAL', 'KEYWORD_ONLY', 'KEYWORD_ONLY', 'VAR_KEYWORD']), o.g.params.map((p) => p.kind));
    check('async def is included', !!o.agen && o.agen.returns === 'str');
    check('platform branch', !!o.only_posix && !o.only_win);
    r = convert({ m: OVL }, { py: [3, 12], platform: 'win32' }); check('platform win32 picks the other branch', !!r.t.m.only_win && !r.t.m.only_posix);
    r = convert({ _typeshed: TS, p: PATHS }); const pp = r.t.p;
    check('cross-file aliases (StrPath from _typeshed)', pp.exists.params[0].annotation === 'str | bytes | PathLike[str] | PathLike[bytes] | int' && pp.join.params[0].annotation === 'str | PathLike[str]', pp);
    r = convert({ genericpath: 'def exists(path: str | int) -> bool: ...\ndef getsize(filename: str) -> int: ...', posixpath: 'from genericpath import exists as exists, getsize as getsize\ndef join(a: str, *p: str) -> str: ...', 'os.path': 'import sys\nif sys.platform == "win32":\n    from ntpath import *\nelse:\n    from posixpath import *', plain: 'from genericpath import exists\n' });
    check('re-exports (from x import y as y, and import *) are followed', r.t['os.path'] && r.t['os.path'].exists && r.t['os.path'].join && r.t['os.path'].getsize && r.t.posixpath.exists.returns === 'bool', Object.keys(r.t['os.path'] || {}));
    check('a plain import is not a re-export', !r.t.plain, r.t.plain);
    r = convert({ rec: 'from typing_extensions import TypeAlias\n_C: TypeAlias = type | tuple[_C, ...]\ndef f(x: _C) -> int: ...' }); check('recursive aliases do not blow up and stay bounded', r.t.rec && r.t.rec.f.params[0].annotation.length < 600 && Object.keys(r.e).length === 0, r);
    r = convert({ ok: 'def a(x: int) -> int: ...', broken: 'def (((' }); check('a broken stub is reported and the rest still converts', r.t.ok && r.t.ok.a && r.e.broken, r);

    // --- 存根型別套進單元
    const table = { version: 1, modules: { statistics: { mean: { params: [{ name: 'data', annotation: 'Iterable[float | Decimal | Fraction]', kind: 'POSITIONAL_OR_KEYWORD', has_default: false }], returns: 'float | Decimal | Fraction', overloads: 1 }, quantiles: { params: [{ name: 'data', annotation: 'Iterable[float]' }, { name: 'n', annotation: 'int', has_default: true }, { name: 'method', annotation: "Literal['inclusive', 'exclusive']", has_default: true }], returns: 'list[float]' } } } };
    const proto = (name, params, extra) => Object.assign({ module: 'statistics', name, summary: 'x', params, sig_src: 'inspect', returns: null, effects: [], pure: true, stdlib: true, version: null, tests: [], has_doc: true }, extra || {});
    const pa = (n, d) => ({ name: n, kind: 'POSITIONAL_OR_KEYWORD', default: d === undefined ? null : d, annotation: null });
    let u = C.unitFromPyProto(proto('mean', [pa('data')]), { stubs: table });
    check('stub fills param and return types, marked stub', u.params[0].type === 'list<number>' && u.params[0].type_src === 'stub' && u.returns.type === 'number' && u.returns.type_src === 'stub', u);
    check('stub-typed pure function becomes trusted (typed return)', u.tier === 1);
    u = C.unitFromPyProto(proto('quantiles', [pa('data'), pa('n', '4'), pa('method', "'exclusive'")]), { stubs: table });
    check('stub beats the default/name guesses', u.params[1].type === 'int' && u.params[1].type_src === 'stub' && u.params[2].type === 'enum<inclusive|exclusive>' && u.params[2].type_src === 'stub', u.params);
    u = C.unitFromPyProto(proto('mean', [Object.assign(pa('data'), { annotation: 'list[int]' })]), { stubs: table }); check('real annotation beats the stub', u.params[0].type === 'list<int>' && u.params[0].type_src === 'annotation');
    u = C.unitFromPyProto(proto('nope', [pa('data')]), { stubs: table }); check('function not in the stub is unchanged', u.params[0].type === 'any' && u.params[0].type_src === 'none');
    u = C.unitFromPyProto(proto('mean', [pa('other')]), { stubs: table }); check('param name not in the stub is left alone', u.params[0].type_src === 'none');
    u = C.unitFromPyProto(proto('mean', [pa('data')], { returns: null }), { stubs: { modules: { statistics: { mean: { params: [{ name: 'data', annotation: 'float' }], returns: 'Callable[[float], float]' } } } } }); check('a function that returns a callable is never trusted (cannot be passed as JSON)', u.returns.type === 'callable' && u.tier === 0);
    u = C.unitFromPyProto(proto('exists', [pa('path')], { module: 'os.path' }), { stubs: { modules: { posixpath: { exists: { params: [{ name: 'path', annotation: 'StrOrBytesPath | int' }], returns: 'bool' } } } } }); check('os.path looks up posixpath in the stubs', u.returns.type === 'bool' && u.returns.type_src === 'stub');
    table.modules.statistics.mean.params[0].annotation = 'Any'; u = C.unitFromPyProto(proto('mean', [pa('data')]), { stubs: table }); check('stub saying Any stays untyped (not a false "typed")', u.params[0].type === 'any' && u.params[0].type_src === 'none');
    check('stub units validate', eq(C.validateUnit(C.unitFromPyProto(proto('mean', [pa('data')]), { stubs: table })), []));
}
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'stub_to_types: ' + ok + ' passed' + skipped); process.exit(bad.length ? 1 : 0);
