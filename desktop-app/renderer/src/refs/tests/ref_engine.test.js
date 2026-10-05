// 知識引擎（FaRef）的一致性測試：類型註冊、schema 驗證、遞迴展開、全庫驗證、知識包（匯出／檢查／合併）。
// 純 Node，不依賴助理：任何要用這個引擎的專案（網頁版、redmine 的 AI 聊天）搬過去之後都跑這支，確認行為一致。用法：node renderer/src/refs/tests/ref_engine.test.js
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..', '..', '..');
const src = fs.readFileSync(path.join(R, 'renderer/src/refs/ref_engine.js'), 'utf8');
const FaRef = new Function('"use strict";' + String.fromCharCode(10) + src + String.fromCharCode(10) + 'return { create, PACK_FORMAT, exportPack, inspectPack, mergePack };')();
const data = require(path.join(R, 'scripts/refs-dsl.js')).build(path.join(R, 'renderer/src/refs'));
let ok = 0, bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

// 沒有任何使用者資料：舊功能照常
let r = FaRef.create(data, { errors: {}, commands: {}, options: {}, pragmas: [], clauses: [], generic: [], buildRules: [] });
check('legacy lookup still works', r.lookupError('EACCES').ok);
check('legacy diag still works', r.diagnoseLog('main.c:3:10: fatal error: foo.h: No such file or directory\nmake: *** [Makefile:5: x] Error 1').ok);
check('no types by default api', Array.isArray(r.types()));

// 註冊類型（使用者）
const PART = { kind: 'toy_part', label: '玩具部位', version: 1, schema: {
    in: { type: 'ref', kind: 'toy_part' },
    base: { type: 'ref', kind: 'toy_part', extends: true },
    box: { type: 'list', of: 'number', length: 4, required: true },
    count: { type: 'integer', range: [1, 8] },
    shape: { type: 'enum', values: ['ellipse', 'bar', 'blob'] },
    size: { type: 'range', range: [0, 1] },
    aliases: { type: 'list', of: 'string' },
    children: { type: 'list', of: { type: 'ref', kind: 'toy_part' } },
    depth: { type: 'object', fields: { kind: { type: 'enum', values: ['bump', 'sunken', 'flat'] }, amp: { type: 'number', range: [0, 1] } } },
    pattern: { type: 'regex' },
} };
check('valid type def', r.validateTypeDef(PART).ok);
check('bad type def: kind', !r.validateTypeDef(Object.assign({}, PART, { kind: 'Bad Kind' })).ok);
check('bad type def: enum without values', !r.validateTypeDef({ kind: 'xx_y', version: 1, schema: { a: { type: 'enum' } } }).ok);
check('bad type def: unknown type', !r.validateTypeDef({ kind: 'xx_y', version: 1, schema: { a: { type: 'weird' } } }).ok);
check('bad type def: version', !r.validateTypeDef(Object.assign({}, PART, { version: 0 })).ok);

const E = (key, customize, extra) => Object.assign({ kind: 'toy_part', key, text: key + ' 的說明', tags: ['toy'], src: 'user', tv: 1, customize }, extra || {});
const user = { types: { toy_part: PART }, typed: [
    E('eye', { box: [0.1, 0.3, 0.9, 0.5], count: 2, shape: 'ellipse', size: [0.01, 0.06], aliases: ['眼睛'], depth: { kind: 'sunken', amp: 0.3 } }),
    E('eyeball', { box: [0.3, 0.3, 0.7, 0.7], shape: 'ellipse', in: 'eye' }),
    E('face', { box: [0, 0, 1, 1], shape: 'blob', children: ['eye', { ref: 'eye', as: 'right', set: { box: [0.55, 0.3, 0.9, 0.5] } }] }),
    E('anime-eye', { base: 'eye', shape: 'blob', box: [0.1, 0.28, 0.9, 0.55], depth: { amp: 0.5 } }),
    E('loop-a', { box: [0, 0, 1, 1], in: 'loop-b' }),
    E('loop-b', { box: [0, 0, 1, 1], in: 'loop-a' }),
    E('dangling', { box: [0, 0, 1, 1], in: 'no-such-part' }),
] };
r = FaRef.create(data, Object.assign({ errors: {}, commands: {}, options: {}, pragmas: [], clauses: [], generic: [], buildRules: [] }, user));
check('type registered', !!r.getType('toy_part') && r.types().some((t) => t.kind === 'toy_part' && t.source === 'user'));

// 驗證
check('entry valid', r.validateEntry(r.findTyped('toy_part', 'eye'), { requireSource: true }).ok);
const bad1 = r.validateEntry(E('x', { box: [0, 0, 1], count: 99, shape: 'cube', size: [0.5, 0.1], pattern: '(' }), { requireSource: true });
check('invalid: collects every error', !bad1.ok && bad1.errors.length >= 5, bad1.errors.map((e) => e.path + ':' + e.msg));
check('missing required', r.validateEntry(E('y', { count: 1 })).errors.some((e) => e.path === 'box' && /必填/.test(e.msg)));
check('dangling ref reported', r.validateEntry(E('z', { box: [0, 0, 1, 1], in: 'nope' })).errors.some((e) => /不存在/.test(e.msg)));
check('dangling ref ignored with noRefs', r.validateEntry(E('z', { box: [0, 0, 1, 1], in: 'nope' }), { noRefs: true }).ok);
check('unregistered kind', !r.validateEntry({ kind: 'nokind', key: 'a', text: 't', customize: {} }).ok);
check('unknown field keeps (warning only)', (() => { const v = r.validateEntry(E('w', { box: [0, 0, 1, 1], future: 1 })); return v.ok; })());
check('no source rejected when required', !r.validateEntry(E('s', { box: [0, 0, 1, 1] }, { src: '' }), { requireSource: true }).ok);
check('tv mismatch is a warning', r.validateEntry(E('t2', { box: [0, 0, 1, 1] }, { tv: 0 })).warnings.some((w) => w.path === 'tv'));

// 展開：遞迴引用、參數覆寫
const rf = r.resolve('toy_part', 'face');
check('resolve ok', rf.ok, rf.errors);
check('resolve: children expanded recursively', rf.value.children.length === 2 && rf.value.children[0].box[0] === 0.1 && rf.value.children[0]._ref.key === 'eye');
check('resolve: as + set override', rf.value.children[1]._ref.as === 'right' && rf.value.children[1].box[0] === 0.55 && rf.value.children[1].count === 2);
// 繼承：anime-eye 繼承 eye，自己的欄位覆蓋
const ra = r.resolve('toy_part', 'anime-eye');
check('extends: parent merged', ra.ok && ra.value.count === 2 && ra.value.aliases[0] === '眼睛', ra);
check('extends: child overrides', ra.value.shape === 'blob' && ra.value.box[3] === 0.55 && ra.value.depth.amp === 0.5 && ra.value.depth.kind === 'sunken');
check('extends: marks parents', Array.isArray(ra.value._extends) && ra.value._extends[0] === 'eye');
// 引用（in）展開
const rb = r.resolve('toy_part', 'eyeball');
check('ref field expanded', rb.ok && rb.value.in._ref.key === 'eye' && rb.value.in.count === 2);
// 循環與缺漏
const rl = r.resolve('toy_part', 'loop-a');
check('cycle detected', !rl.ok && rl.errors.some((e) => /循環引用/.test(e.msg)), rl.errors);
const rd = r.resolve('toy_part', 'dangling');
check('missing ref in resolve', !rd.ok && rd.errors.some((e) => /不存在/.test(e.msg)));
check('missing entry', !r.resolve('toy_part', 'ghost').ok);
// 深度上限
const chain = { types: { toy_part: PART }, typed: [] };
for (let i = 0; i < 12; i++) chain.typed.push(E('n' + i, { box: [0, 0, 1, 1], in: i < 11 ? 'n' + (i + 1) : undefined }));
const rc = FaRef.create(data, Object.assign({ errors: {}, commands: {}, options: {}, pragmas: [], clauses: [], generic: [], buildRules: [] }, chain));
check('depth limit', !rc.resolve('toy_part', 'n0', { depth: 5 }).ok && rc.resolve('toy_part', 'n0', { depth: 20 }).ok);

// 全庫驗證
const va = r.validateAll();
check('validateAll finds the 2 loop + 1 dangling', !va.ok && va.problems.filter((p) => /循環引用/.test(p.msg)).length >= 1 && va.problems.some((p) => p.where === 'toy_part:dangling'), va.problems.map((p) => p.where + ' ' + p.msg));
check('validateAll counts', va.types >= 1 && va.entries >= 7);

// 檢索：離線訓練器／RAG 能查到
const lk = r.lookup('眼睛');
check('lookup finds typed entries by alias', lk.results.some((x) => x.kind === 'typed' && x.typed.key === 'eye'), lk.results.map((x) => x.kind));
check('lookup by key', r.lookup('face').results.some((x) => x.kind === 'typed' && x.typed.key === 'face'));

// 使用者覆蓋內建（同 kind／key）
const data2 = Object.assign({}, data, { types: [PART], typed: [E('eye', { box: [0, 0, 1, 1], shape: 'bar' }, { src: 'builtin' })] });
const r2 = FaRef.create(data2, { errors: {}, commands: {}, options: {}, pragmas: [], clauses: [], generic: [], buildRules: [], typed: [E('eye', { box: [0.2, 0.2, 0.8, 0.8], shape: 'blob' })] });
check('user entry overrides builtin', r2.findTyped('toy_part', 'eye').customize.shape === 'blob' && r2.findTyped('toy_part', 'eye').source === 'user');
check('builtin visible when no override', FaRef.create(data2, {}).findTyped('toy_part', 'eye').customize.shape === 'bar');

// 匯出（給升級成內建）
const ex = r.exportBuiltin(user);
check('export includes types/typed json', JSON.parse(ex.types_json).some((t) => t.kind === 'toy_part') && JSON.parse(ex.typed_json).length === 7);

// 舊資料（沒有 types／typed 欄位）不受影響
const old = FaRef.create(data, { errors: {}, commands: {}, options: {}, pragmas: [], clauses: [], generic: [{ kind: 'semantics', key: 'KeyOne', text: 'TextOne', tags: [], src: 'user' }], buildRules: [] });
check('old store shape fine', old.types().length >= 0 && old.lookup('KeyOne').ok && old.validateAll().ok);

// ---- 知識包：匯出、檢查、合併 ----
const U0 = () => ({ errors: {}, commands: {}, options: {}, pragmas: [], clauses: [], generic: [], buildRules: [], _format: { name: 'fa-ref-user-defs', version: 1 }, types: {}, typed: [] });
const mine = U0();
mine.types.toy_part = { label: '玩具', description: 'x', version: 1, schema: { box: { type: 'list', of: 'number', length: 4, required: true } }, src: 'user' };
mine.typed.push({ kind: 'toy_part', key: 'wheel', text: '輪子', tags: [], src: 'user', tv: 1, customize: { box: [0, 0, 1, 1] } });
mine.typed.push({ kind: 'color_family', key: 'learned-x', text: '學到的', tags: [], src: 'user', tv: 1, customize: { L: [10, 50], a: [0, 20], b: [0, 20], group: 'other' } });
const pk = FaRef.exportPack(mine, 1);
check('exportPack format & counts', pk && pk.format === 'fa-knowledge-types' && pk.types.length === 1 && pk.typed.length === 2 && pk.types[0].kind === 'toy_part', pk);
check('exportPack empty → null', FaRef.exportPack(U0(), 1) === null);
let ins = FaRef.inspectPack(data, U0(), pk, 1);
check('inspectPack accepts a valid pack', ins.ok && ins.knowledge && ins.knowledge.types.length === 1 && ins.knowledge.typed.length === 2 && ins.warnings.length === 0, ins);
check('inspectPack by_kind', ins.knowledge.by_kind.toy_part === 1 && ins.knowledge.by_kind.color_family === 1, ins.knowledge.by_kind);
const badPack = JSON.parse(JSON.stringify(pk)); badPack.typed.push({ kind: 'toy_part', key: 'broken', text: '', customize: { box: [1, 2] } }, { kind: 'no_such_type', key: 'z', customize: {} }, { kind: 'toy_part', key: 'ghost', customize: { box: [0, 0, 1, 1], in: 'nonexistent' } });
ins = FaRef.inspectPack(data, U0(), badPack, 1);
check('inspectPack rejects invalid entries (length, unknown type, missing ref) and keeps the good ones', ins.knowledge.typed.length === 2 && ins.knowledge.rejected === 3 && ins.warnings.length === 3, ins.warnings);
check('inspectPack: newer pack version is skipped with a warning', (() => { const r = FaRef.inspectPack(data, U0(), Object.assign({}, pk, { version: 9 }), 1); return r.knowledge === null && /比這個程式認得的/.test(r.warnings[0]); })());
check('inspectPack: unknown format is skipped', FaRef.inspectPack(data, U0(), { format: 'other' }, 1).knowledge === null);
check('inspectPack: no pack is fine', FaRef.inspectPack(data, U0(), undefined, 1).knowledge === null);
const target = U0(); ins = FaRef.inspectPack(data, target, pk, 1);
let mg = FaRef.mergePack(target, ins.knowledge, { when: 1 });
check('mergePack adds types and entries', mg.types === 1 && mg.entries === 2 && target.types.toy_part && target.typed.length === 2 && target.typed[0].by === 'import', mg);
mg = FaRef.mergePack(target, ins.knowledge, { when: 2 });
check('mergePack is idempotent (same content → nothing new, no conflicts)', mg.types === 0 && mg.entries === 0 && mg.conflicts.length === 0, mg);
const changed = JSON.parse(JSON.stringify(pk)); changed.typed[0].customize.box = [0, 0, 2, 2];
mg = FaRef.mergePack(target, FaRef.inspectPack(data, target, changed, 1).knowledge, {});
check('mergePack keeps yours on conflict', mg.entries === 0 && mg.kept_yours === 1 && /保留你的/.test(mg.conflicts[0]) && target.typed.find((e) => e.key === 'wheel').customize.box[2] === 1, mg);
mg = FaRef.mergePack(target, FaRef.inspectPack(data, target, changed, 1).knowledge, { overwrite: true });
check('mergePack overwrite replaces', mg.entries === 1 && target.typed.find((e) => e.key === 'wheel').customize.box[2] === 2, mg);
const older = JSON.parse(JSON.stringify(pk)); target.types.toy_part.version = 3;
mg = FaRef.mergePack(target, FaRef.inspectPack(data, target, older, 1).knowledge, { overwrite: true });
check('mergePack never downgrades a type version', mg.types === 0 && /比較新/.test(mg.conflicts[0]) && target.types.toy_part.version === 3, mg);
// 往返：匯出 → 另一個使用者合併 → 解得出來
const other = U0(); FaRef.mergePack(other, FaRef.inspectPack(data, other, pk, 1).knowledge, {});
const eng2 = FaRef.create(data, other); check('round trip: imported entry resolves in the other user store', eng2.resolve('toy_part', 'wheel').ok && eng2.validateAll().ok, eng2.validateAll().problems);
// 內建種子完整性（人臉、五官、骨架、動作）
const builtin = FaRef.create(data, U0()); const vaB = builtin.validateAll();
check("builtin seeds validate", vaB.ok, vaB.problems); check('builtin has the core types', ['machine', 'color_family', 'joint', 'skeleton', 'motion', 'gesture', 'sound', 'visual_part', 'visual_example', 'text_lexicon', 'glyph_code'].every((k) => builtin.getType(k)), builtin.types().map((x) => x.kind));
check('builtin skeletons and motions exist', !!builtin.findTyped('skeleton', 'head-rig') && !!builtin.findTyped('skeleton', 'humanoid-rig') && builtin.listTyped('motion').length >= 7);

// ---- 資料格式版本與遷移（純函式）----
const v0 = { errors: { linux_errno: [{ code: 99, name: 'EX', msg: 'm' }] }, commands: {}, options: {}, pragmas: [], clauses: [], generic: [{ kind: 'x', key: 'k', text: 't' }], buildRules: [] };
const rawV0 = { text: JSON.stringify(v0), data: v0 };
let fi = FaRef.formatInfo(rawV0);
check('formatInfo: no _format → v0, outdated', fi.version === 0 && fi.status === 'outdated' && fi.counts.errors === 1 && fi.counts.generic === 1, fi);
check('formatInfo: empty store', FaRef.formatInfo({ text: null, data: null }).status === 'empty');
check('formatInfo: read error', FaRef.formatInfo({ error: 'boom' }).status === 'error');
check('formatInfo: newer than supported → newer', FaRef.formatInfo({ text: '{}', data: { _format: { version: FaRef.FORMAT.current + 1 } } }).status === 'newer');
let plan = FaRef.migrationPlan(rawV0);
check('migrationPlan v0→v1: ok, adds types/typed, keeps every old field byte-for-byte', plan.ok && plan.to === 1 && plan.result._format.version === 1 && Array.isArray(plan.result.typed) && JSON.stringify(plan.result.errors) === JSON.stringify(v0.errors) && JSON.stringify(plan.result.generic) === JSON.stringify(v0.generic), plan);
check('migrationPlan: input is not modified (dry run)', !('_format' in v0) && !('types' in v0));
check('migrationPlan: already current → nothing to do', FaRef.migrationPlan({ text: '{}', data: plan.result }).nothing === true);
check('migrationPlan: newer data is refused (read-only)', /唯讀/.test(FaRef.migrationPlan({ text: '{}', data: { _format: { version: 9 } } }).error || ''));
check('migrationPlan: target newer than the program is refused', /請更新程式/.test(FaRef.migrationPlan(rawV0, 9).error || ''));
check('applyStep: unknown op throws', (() => { try { FaRef.applyStep({}, { op: 'explode' }); return false; } catch (e) { return /不認得/.test(e.message); } })());
check('applyStep: rename/move/drop/default semantic', (() => { const d = { a: { b: 1 }, c: 2 }; FaRef.applyStep(d, { op: 'rename', path: 'c', to: 'd' }); FaRef.applyStep(d, { op: 'move', path: 'a.b', to: 'e.f' }); FaRef.applyStep(d, { op: 'default', path: 'g', value: [1] }); FaRef.applyStep(d, { op: 'default', path: 'g', value: [2] }); FaRef.applyStep(d, { op: 'drop', path: 'a' }); return d.d === 2 && d.c === undefined && d.e.f === 1 && JSON.stringify(d.g) === '[1]' && d.a === undefined; })());
check('every migration step chains (from → to, no gaps up to current)', (() => { let v = 0; while (v < FaRef.FORMAT.current) { const m = FaRef.MIGRATIONS.find((x) => x.from === v); if (!m) return false; v = m.to; } return true; })());
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
