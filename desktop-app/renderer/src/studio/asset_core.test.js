// node renderer/src/studio/asset_core.test.js
const A = require('./asset_core.js'); const crypto = require('crypto');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); } };
const u = (s) => new TextEncoder().encode(s); const ref = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');

// sha256：與 Node crypto 對照（空、短、55/56/63/64/65 位元組邊界、大檔、中文）
for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100003]) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 255; check('sha256 長度 ' + n, A.sha256Hex(b) === ref(b)); }
check('sha256 字串（中文）', A.sha256Hex('訓練資產') === ref(u('訓練資產')));
check('sha256 abc 已知值', A.sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

const CP = { base: 'Qwen3-0.6B', rank: 8, alpha: 16, prompt_format_version: 3, tool_catalog_sha256: 'x'.repeat(64) };
const files = { 'data/a.jsonl': u('{"x":1}\n'), 'weights/w.bin': u('WWWW'), 'log.jsonl': u('') };
const m = A.createManifest({ kind: 'lora', name: 'my-lora', files, base: 'Qwen3-0.6B', compat: CP, created: '2026-11-11T00:00:00Z' });
check('createManifest 欄位', m.format === 'fa-training-asset' && m.version === A.VERSION && m.owner === 'user' && m.parent === null && m.compat.data_sha256.length === 64);
check('manifest 通過驗證', A.validateManifest(m).ok, A.validateManifest(m));
check('data_sha256 只跟 data/ 有關', A.dataHash(Object.assign({}, files, { 'weights/w.bin': u('ZZZZ') })) === m.compat.data_sha256);
check('data 改了 data_sha256 就變', A.dataHash(Object.assign({}, files, { 'data/a.jsonl': u('{"x":2}\n') })) !== m.compat.data_sha256);
check('kind 不合法拒絕', (() => { try { A.createManifest({ kind: 'foo', name: 'a', files: {} }); return false; } catch (e) { return /kind/.test(e.message); } })());
check('名稱含 .. 拒絕', (() => { try { A.createManifest({ kind: 'lora', name: '../x', files: {} }); return false; } catch (e) { return /名稱/.test(e.message); } })());
check('路徑跳脫拒絕', (() => { try { A.createManifest({ kind: 'lora', name: 'a', files: { '../evil': u('x') } }); return false; } catch (e) { return /路徑/.test(e.message); } })());
check('絕對路徑／反斜線不安全', !A.safePath('/etc/passwd') && !A.safePath('a\\b') && !A.safePath('C:/x') && A.safePath('a/b.c'));

// 驗證負向
check('validate: 錯的 format', !A.validateManifest(Object.assign({}, m, { format: 'x' })).ok);
check('validate: 版本較新', /更新/.test(A.validateManifest(Object.assign({}, m, { version: 99 })).errors.join()));
check('validate: sha256 值格式不對', !A.validateManifest(Object.assign({}, m, { sha256: { 'a': 'zz' } })).ok);
check('validate: 非物件', !A.validateManifest(null).ok);

// 核對
check('verify 正常', A.verifyFiles(m, files).ok);
const vt = A.verifyFiles(m, Object.assign({}, files, { 'weights/w.bin': u('WWWX') }));
check('verify 竄改被拒', !vt.ok && vt.mismatched.join() === 'weights/w.bin' && /sha256/.test(vt.message), vt);
const vm = A.verifyFiles(m, { 'data/a.jsonl': files['data/a.jsonl'] }); check('verify 缺檔', !vm.ok && vm.missing.length === 2);
const ex = Object.assign({}, files, { 'evil.sh': u('x') });
check('verify 多出檔被拒；allowExtra 放行', !A.verifyFiles(m, ex).ok && A.verifyFiles(m, ex).extra[0] === 'evil.sh' && A.verifyFiles(m, ex, { allowExtra: true }).ok);

// 遷移
const old1 = { format: 'fa-training-asset', version: 1, kind: 'lora', name: 'old', base: 'Qwen3-0.6B', rank: 8, prompt_format_version: 2, hashes: { 'data/a.jsonl': ref(files['data/a.jsonl']) } };
const g1 = A.migrateManifest(old1);
check('遷移 v1→現行', g1.ok && g1.migrated && g1.from === 1 && g1.manifest.version === A.VERSION && g1.manifest.sha256['data/a.jsonl'] && !g1.manifest.hashes, g1);
check('遷移後 compat 搬入、owner／counts／eval 補上', g1.manifest.compat.base === 'Qwen3-0.6B' && g1.manifest.compat.rank === 8 && g1.manifest.compat.prompt_format_version === 2 && g1.manifest.owner === 'user' && g1.manifest.counts && g1.manifest.eval === null && g1.manifest.parent === null);
check('遷移不改動輸入', old1.version === 1 && old1.hashes && !old1.compat);
const g0 = A.migrateManifest({ format: 'fa-training-asset', kind: 'trainer', name: 'zero', files: { 'data/x': ref(u('1')) } });
check('遷移 v0（無版本號）', g0.ok && g0.from === 0 && g0.manifest.sha256['data/x'] && g0.manifest.version === A.VERSION, g0);
const gc = A.migrateManifest(m); check('現行版本不需遷移', gc.ok && !gc.migrated);
check('遷移拒絕：太新', /更新/.test(A.migrateManifest(Object.assign({}, m, { version: 9 })).error));
check('遷移拒絕：不是資產', /不是訓練資產/.test(A.migrateManifest({ format: 'other' }).error));
check('遷移拒絕：訓練器 bundle 要用轉接器', /trainer_adapter/.test(A.migrateManifest({ format: 'fa-offline-trainer', version: 2 }).error));
check('遷移拒絕：kind 缺少', !A.migrateManifest({ format: 'fa-training-asset', version: 1, name: 'x', hashes: {} }).ok);

// 相容性
const mk = (name, cp, f) => A.createManifest({ kind: 'lora', name, files: f || files, compat: cp });
check('相容：同一份', A.checkCompat(m, m).ok && A.checkCompat(m, m).suggest === null);
const r1 = A.checkCompat(m, mk('b', Object.assign({}, CP, { base: 'Llama' })));
check('不符：base 不同 → 拒絕並建議 fork，原因具體', !r1.ok && r1.suggest === 'fork' && r1.reasons.some((r) => r.field === 'base' && r.expected === 'Qwen3-0.6B' && r.actual === 'Llama') && /fork/.test(r1.message), r1);
const r2 = A.checkCompat(m, mk('c', Object.assign({}, CP, { rank: 16 })));
check('不符：rank 不同', !r2.ok && r2.reasons.length === 1 && r2.reasons[0].field === 'rank' && /rank/.test(r2.message));
const r3 = A.checkCompat(m, mk('d', Object.assign({}, CP, { prompt_format_version: 4 })));
check('不符：提示格式版本不同', !r3.ok && r3.reasons[0].field === 'prompt_format_version');
const f4 = Object.assign({}, files, { 'data/a.jsonl': u('other') }); const m4 = mk('e', CP, f4);
check('不符：資料雜湊不同（續訓）', !A.checkCompat(m, m4).ok && A.checkCompat(m, m4).reasons[0].field === 'data_sha256');
check('合併匯入不比資料雜湊', A.checkCompat(m, m4, { checkData: false }).ok);
check('不符：kind 不同', !A.checkCompat(m, A.createManifest({ kind: 'trainer', name: 'f', files, compat: m.compat })).ok);
check('不符：一邊未記錄', !A.checkCompat({ compat: { rank: 8 } }, { compat: {} }).ok);
check('多個不符一次列出', A.checkCompat(m, mk('g', { base: 'X', rank: 1, alpha: 1, prompt_format_version: 1, tool_catalog_sha256: 'y' })).reasons.length >= 5);

// fork
const fk = A.forkManifest(m, { name: 'my-lora-v2' });
check('fork：parent 記來源、名稱新、通過驗證', fk.name === 'my-lora-v2' && fk.parent.name === 'my-lora' && fk.parent.kind === 'lora' && fk.parent.manifest_sha256 === A.manifestHash(m) && A.validateManifest(fk).ok);
check('fork 不改原 manifest', m.parent === null && m.name === 'my-lora');
check('fork 名稱不合法', (() => { try { A.forkManifest(m, { name: 'a/b' }); return false; } catch (e) { return true; } })());
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
