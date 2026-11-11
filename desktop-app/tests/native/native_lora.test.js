// LoRA 套用到原生推論：轉傳鏈單元測試（node 直接跑，不需要 Electron、不需要模型、不需要 onnxruntime）。
// 涵蓋：協定欄位驗證、nr-engine 的 lora 檔案／雜湊／槽版核對與 session 重建規則（用假的 onnxruntime）、主程序端 host → 真的 nr-child.js（假引擎）轉傳、
// main-ext.js 的 NRL（套用／清除／執行包太舊拒絕／子程序沒回報就失敗）、執行包版本選擇（新版優先、舊版退路、features）、
// 執行包升級沿用舊檔不重下載、清單重算工具、嵌入的清單與 nr-*.js 一致、渲染端套用器。
// 沒測到的（需要真模型與 onnxruntime-node 才能驗）：真的用 LoRA 槽版 ONNX 跑出不同於基底的輸出——見 DESIGN.TODO.native-runner.md「1.22.0-2」一節。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..', '..');
const proto = require(path.join(root, 'nr-protocol.js'));
const engine = require(path.join(root, 'nr-engine.js'));
const { createNativeRunnerHost } = require(path.join(root, 'nr-host.js'));
const mainExt = require(path.join(root, 'main-ext.js'));
const Apply = require(path.join(root, 'renderer/src/studio/lora_apply_core.js'));
const { refreeze } = require(path.join(root, 'scripts/native-runtime-refreeze-nr.js'));

let ok = 0; const bad = [];
const check = (name, c, x) => { if (c) ok++; else { bad.push(name); console.log('FAIL', name, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-lora-'));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
async function settle(p) { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } }

(async () => {
    // ---------- 1 協定 ----------
    const L = { id: 'a', path: '/x/lora.bin', sha256: 'a'.repeat(64), size: 10 };
    const run = (lora) => ({ type: 'run', id: '1', messages: [], max_tokens: 1, timeout_ms: 0, stream: false, lora });
    check('協定：FEATURES 含 lora', proto.FEATURES.indexOf('lora') >= 0);
    check('協定：沒有 lora 欄位仍合法（舊呼叫端）', proto.validate(run(undefined)).ok);
    check('協定：lora 欄位完整合法', proto.validate(run(L)).ok);
    check('協定：lora 缺 sha256 拒絕', !proto.validate(run({ id: 'a', path: 'p' })).ok);
    check('協定：lora sha256 格式不對拒絕', !proto.validate(run({ id: 'a', path: 'p', sha256: 'XYZ' })).ok);
    check('協定：lora 不是物件拒絕', !proto.validate(run('x')).ok);
    check('協定：lora.size 負數拒絕', !proto.validate(run(Object.assign({}, L, { size: -1 }))).ok);

    // ---------- 2 引擎：resolveLora ----------
    const modelDir = mk('model');
    const modelPath = path.join(modelDir, 'model_quantized.onnx');
    fs.writeFileSync(modelPath, 'x');
    fs.writeFileSync(path.join(modelDir, 'layout.json'), JSON.stringify({ rank: 16, total_bytes: 64, tensors: [] }));
    const loraBytes = crypto.randomBytes(64), loraFile = path.join(tmp, 'lora.bin');
    fs.writeFileSync(loraFile, loraBytes);
    const spec = { id: 'x1', path: loraFile, sha256: sha(loraBytes), size: 64 };
    const r1 = engine.resolveLora(spec, modelPath);
    check('resolveLora：通過時回 id／bytes／sha256', r1.id === 'x1' && Buffer.compare(Buffer.from(r1.bytes), loraBytes) === 0 && r1.sha256 === spec.sha256);
    const thr = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    check('resolveLora：sha256 不符明確失敗', /sha256 不符/.test(thr(() => engine.resolveLora(Object.assign({}, spec, { sha256: 'b'.repeat(64) }), modelPath))));
    check('resolveLora：大小不符明確失敗', /大小不符/.test(thr(() => engine.resolveLora(Object.assign({}, spec, { size: 65 }), modelPath))));
    check('resolveLora：缺 sha256 拒絕', /缺 sha256/.test(thr(() => engine.resolveLora({ id: 'x', path: loraFile }, modelPath))));
    check('resolveLora：檔案不存在說明路徑', /讀不到 LoRA 檔案/.test(thr(() => engine.resolveLora(Object.assign({}, spec, { path: path.join(tmp, 'nope.bin') }), modelPath))));
    const plainDir = mk('plain'); fs.writeFileSync(path.join(plainDir, 'm.onnx'), 'x');
    check('resolveLora：模型不是槽版（沒有 layout.json）明確失敗而非靜默忽略', /不是 LoRA 槽版/.test(thr(() => engine.resolveLora(spec, path.join(plainDir, 'm.onnx')))));
    fs.writeFileSync(path.join(modelDir, 'layout.json'), JSON.stringify({ rank: 16, total_bytes: 128 }));
    check('resolveLora：adapter 大小與槽不符明確失敗', /與模型的 LoRA 槽/.test(thr(() => engine.resolveLora(spec, modelPath))));
    fs.writeFileSync(path.join(modelDir, 'layout.json'), JSON.stringify({ rank: 16, total_bytes: 64 }));
    check('resolveLora：modelPath 為 null（假引擎）只驗檔案與雜湊', engine.resolveLora(spec, null).sha256 === spec.sha256);

    // ---------- 3 引擎：loadModel 與 session 重建（假 onnxruntime）----------
    const tokPath = path.join(tmp, 'tokenizer.json');
    fs.writeFileSync(tokPath, JSON.stringify({ model: { type: 'BPE', vocab: { a: 0 }, merges: [] }, added_tokens: [], pre_tokenizer: { pretokenizers: [{ type: 'Split', pattern: { Regex: '\\w+|\\s+|.' } }] } }));
    const creates = [];
    const fakeOrt = { InferenceSession: { create: async (p, so) => { creates.push({ p, so }); return { n: creates.length }; } } };
    const hooks = engine._testHooks(); hooks.setOrt(fakeOrt);
    await engine.loadModel(modelPath, tokPath, 2);
    check('loadModel：沒有 lora 時不帶 externalData（與以前完全一致）', creates.length === 1 && creates[0].so.externalData === undefined && creates[0].so.executionProviders[0] === 'cpu' && creates[0].so.intraOpNumThreads === 2, creates[0]);
    await engine.loadModel(modelPath, tokPath, 2);
    check('loadModel：沒有 lora 再呼叫沿用 session', creates.length === 1);
    await engine.loadModel(modelPath, tokPath, 2, r1);
    const ed = creates[1] && creates[1].so.externalData;
    check('loadModel：有 lora 時以 externalData（lora.bin）交給 session 並重建', creates.length === 2 && ed && ed[0].path === 'lora.bin' && ed[0].data === r1.bytes, creates[1]);
    await engine.loadModel(modelPath, tokPath, 2, r1);
    check('loadModel：同一個 adapter 不重建', creates.length === 2);
    const other = Object.assign({}, r1, { sha256: 'c'.repeat(64) });
    await engine.loadModel(modelPath, tokPath, 2, other);
    check('loadModel：同 id 不同內容（sha256 不同）會重建', creates.length === 3);
    await engine.loadModel(modelPath, tokPath, 2);
    check('loadModel：卸載（不給 lora）重建成不帶 externalData', creates.length === 4 && creates[3].so.externalData === undefined);
    hooks.reset();

    // ---------- 4 host → 真子程序（假引擎）轉傳 ----------
    const mkHost = () => createNativeRunnerHost({ childPath: path.join(root, 'nr-child.js'), progressFile: path.join(tmp, 'p-' + Math.random().toString(36).slice(2) + '.jsonl'), idleMs: 0, graceMs: 1000 });
    const h = mkHost();
    const base = await settle(h.run({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, fake: { reply: 'hello' } }));
    check('轉傳鏈：沒有 lora 時結果與以前相同（沒有 lora 欄位）', base.ok && base.v.text === 'hello' && !('lora_applied' in base.v), base);
    const withL = await settle(h.run({ messages: [], maxTokens: 10, fake: { reply: 'hello' }, lora: spec }));
    check('轉傳鏈：lora 經 host → 子程序，子程序讀檔核對後回報 lora_applied 與 sha256', withL.ok && withL.v.lora_applied === 'x1' && withL.v.lora_sha256 === spec.sha256, withL);
    const badSha = await settle(h.run({ messages: [], maxTokens: 10, fake: { reply: 'hello' }, lora: Object.assign({}, spec, { sha256: 'd'.repeat(64) }) }));
    check('轉傳鏈：雜湊不符子程序回 load_failed 並說明原因', !badSha.ok && badSha.code === 'load_failed' && /sha256 不符/.test(badSha.msg), badSha);
    const noFile = await settle(h.run({ messages: [], maxTokens: 10, fake: { reply: 'hello' }, lora: Object.assign({}, spec, { path: path.join(tmp, 'gone.bin') }) }));
    check('轉傳鏈：檔案不存在回 load_failed', !noFile.ok && noFile.code === 'load_failed' && /讀不到/.test(noFile.msg), noFile);
    const after = await settle(h.run({ messages: [], maxTokens: 10, fake: { reply: 'ok2' } }));
    check('轉傳鏈：失敗後子程序仍可用、不帶 lora 的下一次正常', after.ok && after.v.text === 'ok2' && !('lora_applied' in after.v), after);
    h.dispose('測試結束');

    // ---------- 5 NRL（main-ext 的 adapter 管理）----------
    const ud = mk('ud'), box = mk('ud', 'native-runner-box');
    let runtime = { ok: true, version: '1.22.0-1', latestVersion: '1.22.0-2', features: [] };
    let modelP = modelPath;
    const nrl = mainExt._NRL.create({ fs, path, crypto, userData: ud, box, getRuntime: () => runtime, getModelPath: () => modelP });
    const put = (id, buf) => { const d = path.join(box, 'lora-in', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'lora.bin'), buf); };
    put('ad1', loraBytes);
    let a = nrl.apply({ id: 'ad1', sha256: sha(loraBytes), size: 64 });
    check('NRL：舊執行包（沒有 lora 功能）明確回 runtime_outdated，並提示更新到哪一版', a.ok === false && a.code === 'runtime_outdated' && /1\.22\.0-1/.test(a.message) && /1\.22\.0-2/.test(a.message), a);
    check('NRL：被拒時沒有套用中的 adapter、run 前置不帶 lora', nrl._active() === null && nrl.forRun().lora === null);
    runtime = { ok: false, reason: '沒有執行包' };
    a = nrl.apply({ id: 'ad1', sha256: sha(loraBytes) });
    check('NRL：沒有執行包回 no_engine', a.code === 'no_engine', a);
    runtime = { ok: true, version: '1.22.0-2', latestVersion: '1.22.0-2', features: ['lora'] };
    a = nrl.apply({ id: '../evil', sha256: sha(loraBytes) });
    check('NRL：不合法 id 拒絕', a.code === 'bad_request', a);
    a = nrl.apply({ id: 'ad1', sha256: 'e'.repeat(64) });
    check('NRL：雜湊不符拒絕並清掉信箱檔', a.code === 'verify_failed' && !fs.existsSync(path.join(box, 'lora-in', 'ad1')), a);
    put('ad1', loraBytes);
    modelP = path.join(plainDir, 'm.onnx');
    a = nrl.apply({ id: 'ad1', sha256: sha(loraBytes) });
    check('NRL：模型不是槽版回 not_slot_model（不假裝成功）', a.code === 'not_slot_model', a);
    modelP = '';
    a = nrl.apply({ id: 'ad1', sha256: sha(loraBytes) });
    check('NRL：沒設定模型路徑回 no_model', a.code === 'no_model', a);
    modelP = modelPath;
    fs.writeFileSync(path.join(modelDir, 'layout.json'), JSON.stringify({ rank: 16, total_bytes: 128 }));
    a = nrl.apply({ id: 'ad1', sha256: sha(loraBytes) });
    check('NRL：槽大小不符回 slot_mismatch', a.code === 'slot_mismatch', a);
    fs.writeFileSync(path.join(modelDir, 'layout.json'), JSON.stringify({ rank: 16, total_bytes: 64 }));
    a = nrl.apply({ id: 'ad1', sha256: sha(loraBytes), size: 64 });
    const ap = nrl._active();
    check('NRL：通過後搬到 native-lora 並記為套用中', a.ok && a.applied && ap && fs.readFileSync(ap.path).equals(loraBytes) && ap.path.startsWith(path.join(ud, 'native-lora')) && !fs.existsSync(path.join(box, 'lora-in', 'ad1')), a);
    const fr = nrl.forRun();
    check('NRL：套用中時 run 前置帶 {id,path,sha256,size}', fr.ok && fr.lora.id === 'ad1' && fr.lora.sha256 === sha(loraBytes) && fr.lora.size === 64, fr);
    check('NRL：子程序回報同一個 adapter 才算成功', nrl.verifyDone({ lora_applied: 'ad1', lora_sha256: sha(loraBytes) }) === null);
    check('NRL：子程序沒回報（舊子程序默默忽略）視為失敗 lora_not_applied', (nrl.verifyDone({ text: 'x' }) || {}).code === 'lora_not_applied');
    check('NRL：回報的雜湊不同視為失敗', (nrl.verifyDone({ lora_applied: 'ad1', lora_sha256: 'f'.repeat(64) }) || {}).code === 'lora_not_applied');
    runtime = { ok: true, version: '1.22.0-1', latestVersion: '1.22.0-2', features: [] };
    check('NRL：套用後執行包被換成舊版，run 前置拒絕而不是默默不用', nrl.forRun().code === 'runtime_outdated');
    runtime = { ok: true, version: '1.22.0-2', latestVersion: '1.22.0-2', features: ['lora'] };
    const st = nrl.status();
    check('NRL：status 回報套用中與支援狀態', st.active.id === 'ad1' && st.supported && !st.needsRuntimeUpdate, st);
    const bytes2 = crypto.randomBytes(64); put('ad2', bytes2);
    nrl.apply({ id: 'ad2', sha256: sha(bytes2) });
    check('NRL：換 adapter 會刪掉前一個的檔案', nrl._active().id === 'ad2' && !fs.existsSync(path.join(ud, 'native-lora', 'ad1')));
    const cl = nrl.clear();
    check('NRL：clear 卸載並刪檔，之後 run 前置不帶 lora', cl.ok && cl.cleared === 'ad2' && nrl.forRun().lora === null && !fs.existsSync(path.join(ud, 'native-lora', 'ad2')));
    check('NRL：沒有 adapter 時 verifyDone 不檢查（沒有 lora 行為不變）', nrl.verifyDone({ text: 'x' }) === null);

    // ---------- 6 執行包版本選擇 ----------
    const ud2 = mk('ud2');
    const proto0 = fs.readFileSync(path.join(root, 'nr-protocol.js'));
    const oldProto = Buffer.from(proto0.toString('utf8').replace(/\nconst FEATURES = \['lora'\];/, '\nconst FEATURES_REMOVED = [];').replace('PROTOCOL_VERSION, FEATURES, MESSAGES', 'PROTOCOL_VERSION, MESSAGES'));
    const mkRuntime = (ver, protoBuf, features) => {
        const d = path.join(ud2, 'native-runtime', ver); fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'nr-protocol.js'), protoBuf);
        const man = { runtimeVersion: ver, ortVersion: '1.22.0', platform: process.platform, arch: process.arch, files: { 'nr-protocol.js': { size: protoBuf.length, md5: md5(protoBuf) } } };
        if (features) man.features = features;
        fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(man));
        return d;
    };
    check('版本選擇：什麼都沒有時回最新版的失敗原因', mainExt._findNativeRuntime(ud2).ok === false);
    mkRuntime('1.22.0-1', oldProto);
    let rt = mainExt._findNativeRuntime(ud2);
    check('版本選擇：只有舊版時可用、標 legacy、features 為空（不含 lora）', rt.ok && rt.legacy === true && rt.version === '1.22.0-1' && rt.features.length === 0 && rt.latestVersion === '1.22.0-2', rt);
    mkRuntime('1.22.0-2', proto0, ['lora']);
    rt = mainExt._findNativeRuntime(ud2);
    check('版本選擇：新舊並存時新版優先，features 含 lora', rt.ok && !rt.legacy && rt.version === '1.22.0-2' && rt.features.indexOf('lora') >= 0, rt);
    fs.appendFileSync(path.join(ud2, 'native-runtime', '1.22.0-2', 'nr-protocol.js'), '// 竄改');
    rt = mainExt._findNativeRuntime(ud2);
    check('版本選擇：新版 md5 核對失敗時退回舊版（不用半個）', rt.ok && rt.legacy && rt.version === '1.22.0-1', rt);

    // ---------- 7 升級安裝：沿用舊檔，不重新下載 ----------
    const NRI = mainExt._NRI;
    const seedRoot = mk('seed'), onnxBuf = crypto.randomBytes(3000);
    fs.mkdirSync(path.join(seedRoot, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(seedRoot, 'node_modules', 'x', 'big.bin'), onnxBuf);
    const newChild = Buffer.from('// new child\n');
    const ghDir = mk('gh'); fs.mkdirSync(path.join(ghDir, 'parts'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'parts', 'nr-child.js.001.part'), newChild);
    const man = { runtimeVersion: '1.22.0-2', features: ['lora'], ortVersion: '1.22.0', license: 'MIT', sources: { npm: { package: 'x', tarball: 'x', integrity: 'sha512-x' } }, files: [
        { path: 'node_modules/x/big.bin', platform: 'all', size: onnxBuf.length, sha256: sha(onnxBuf), parts: [{ name: 'node_modules__x__big.bin.001.part', size: onnxBuf.length, md5: md5(onnxBuf) }] },
        { path: 'nr-child.js', platform: 'all', size: newChild.length, sha256: sha(newChild), parts: [{ name: 'nr-child.js.001.part', size: newChild.length, md5: md5(newChild) }] },
    ] };
    const oldSrc = mk('oldsrc'); fs.writeFileSync(path.join(oldSrc, 'nr-child.js'), '// old child from installer\n');
    const fetched = [];
    const fetchBytes = async (loc) => { fetched.push(loc); if (/^gh:/.test(loc)) return fs.readFileSync(path.join(ghDir, loc.slice(3))); throw new Error('不該連到 ' + loc); };
    const dst = path.join(tmp, 'dst', '1.22.0-2');
    const inst = await NRI.installRuntime({ manifest: man, platformKey: 'win32-x64', runtimeDir: dst, npmLocation: 'npm:never', githubBase: 'gh:', fetchBytes, nrSourceDir: oldSrc, seedDirs: [seedRoot], timeoutMs: 1000, stats: {} });
    check('升級安裝：成功', inst.ok, inst);
    check('升級安裝：不連 npm（沒有下載 onnxruntime）', !fetched.some((x) => /npm/.test(x)), fetched);
    check('升級安裝：onnx 檔沿用舊版（來源 local）、nr 檔因安裝目錄是舊版而改用 GitHub 釘住的新版', inst.sourcesUsed['node_modules/x/big.bin'] === 'local' && inst.sourcesUsed['nr-child.js'] === 'github', inst.sourcesUsed);
    check('升級安裝：寫出的檔案內容正確、manifest 帶 features', fs.readFileSync(path.join(dst, 'nr-child.js')).equals(newChild) && fs.readFileSync(path.join(dst, 'node_modules', 'x', 'big.bin')).equals(onnxBuf) && JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8')).features[0] === 'lora');
    const tampered = Object.assign({}, man, { files: man.files.map((f) => f.path === 'nr-child.js' ? Object.assign({}, f, { sha256: 'a'.repeat(64) }) : f) });
    const inst2 = await NRI.installRuntime({ manifest: tampered, platformKey: 'win32-x64', runtimeDir: path.join(tmp, 'dst2'), npmLocation: 'npm:never', githubBase: 'gh:', fetchBytes, nrSourceDir: oldSrc, seedDirs: [seedRoot], timeoutMs: 1000, stats: {} });
    check('升級安裝：GitHub 來源內容與清單 sha256 不符時失敗，不寫入半個執行包', inst2.ok === false && !fs.existsSync(path.join(tmp, 'dst2')), inst2);

    // ---------- 8 清單重算工具與嵌入清單一致 ----------
    const out = path.join(tmp, 'refreeze');
    const rf = refreeze({ out, version: '1.22.0-2', features: ['lora'], writeMainExt: false });
    const nrFiles = ['nr-child.js', 'nr-engine.js', 'nr-host.js', 'nr-protocol.js', 'nr-gen-params.js', 'nr-template.js', 'nr-tokenizer.js'];
    check('清單重算：版本與 features 正確、每個 nr 檔的 sha256 等於目前檔案', rf.manifest.runtimeVersion === '1.22.0-2' && rf.manifest.features[0] === 'lora' && nrFiles.every((n) => rf.manifest.files.find((f) => f.path === n).sha256 === sha(fs.readFileSync(path.join(root, n)))), rf.manifest.runtimeVersion);
    check('清單重算：輸出的分割段 md5／大小與清單一致', rf.changed.every((n) => { const f = rf.manifest.files.find((x) => x.path === n), p = fs.readFileSync(path.join(out, 'parts', f.parts[0].name)); return md5(p) === f.parts[0].md5 && p.length === f.size; }));
    check('清單重算：onnxruntime 檔案沒有被動到', rf.manifest.files.filter((f) => !/^nr-/.test(f.path)).every((f, i) => JSON.stringify(f) === JSON.stringify(mainExt._NATIVE_RUNTIME_MANIFEST.files.find((x) => x.path === f.path))));
    const emb = mainExt._NATIVE_RUNTIME_MANIFEST;
    check('嵌入的清單：版本等於 main-ext 的目標版本、features 含 lora', emb.runtimeVersion === mainExt._NATIVE_RUNTIME_VERSION && (emb.features || []).indexOf('lora') >= 0, emb.runtimeVersion);
    check('嵌入的清單：每個 nr-*.js 的 sha256 等於目前檔案（改了 nr 檔要重跑 scripts/native-runtime-refreeze-nr.js --write-main-ext）', nrFiles.every((n) => emb.files.find((f) => f.path === n).sha256 === sha(fs.readFileSync(path.join(root, n)))));
    check('嵌入的清單：與重算結果逐位元組相同（沒有未同步的改動）', JSON.stringify(emb) === JSON.stringify(rf.manifest));

    // ---------- 9 渲染端套用器 ----------
    const calls = [], written = [];
    const mkApplier = (reply) => Apply.createLoraApplier({ call: async (op, p) => { calls.push({ op, p }); return reply(op, p); }, rawfs: { writeFile: async (p, o) => { written.push({ p, len: Buffer.from(o.base64, 'base64').length }); }, remove: async (p) => { written.push({ rm: p }); } }, box: '/ud/box', sep: '/', sha256Hex: (u8) => sha(Buffer.from(u8)), toBase64: (u8) => Buffer.from(u8).toString('base64') });
    let ap2 = mkApplier(() => ({ ok: true, note: '已套用' }));
    let r = await ap2.apply([{ id: 'My Adapter/1', bytes: new Uint8Array(loraBytes) }]);
    check('套用器：寫信箱檔、呼叫 lora_apply、id 轉成安全字元並帶雜湊前綴', r.ok && written[0].p.startsWith('/ud/box/lora-in/My_Adapter_1-') && written[0].len === 64 && calls[0].op === 'lora_apply' && calls[0].p.sha256 === sha(loraBytes) && Apply.safeId('My Adapter/1', sha(loraBytes)) === calls[0].p.id, { r, calls, written });
    r = await ap2.apply([{ id: 'a', bytes: new Uint8Array(loraBytes) }, { id: 'b', bytes: new Uint8Array(loraBytes) }]);
    check('套用器：多個 adapter 只套第一個並明說其餘未套用', r.ok && /未套用：b/.test(r.note), r);
    ap2 = mkApplier(() => ({ ok: false, code: 'runtime_outdated', message: '需要更新執行包' }));
    r = await ap2.apply([{ id: 'a', bytes: new Uint8Array(loraBytes) }]);
    check('套用器：執行包太舊回 ok:false 與 needsRuntimeUpdate，不假裝成功', r.ok === false && r.needsRuntimeUpdate === true && /更新執行包/.test(r.error), r);
    check('套用器：失敗時清掉信箱殘檔', written.some((w) => w.rm && /lora-in/.test(w.rm)));
    r = await ap2.apply([]);
    check('套用器：沒有 handle 回 ok:false', r.ok === false);
    r = await Apply.createLoraApplier({}).apply([{ id: 'a', bytes: new Uint8Array(1) }]);
    check('套用器：沒有橋接（網頁版）回 ok:false 並說明', r.ok === false && /桌面版/.test(r.error), r);

    console.log('native_lora.test.js：通過 ' + ok + ' 項' + (bad.length ? '，失敗 ' + bad.length + ' 項：' + bad.join('、') : ''));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('測試例外', e && e.stack || e); process.exit(2); });
