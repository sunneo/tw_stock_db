#!/usr/bin/env node
'use strict';
// 訓練工作室的 repo 內建化腳本（設計 DESIGN.TODO.offline-training-studio.md §7、§16.6）。目前涵蓋 blockly／matrix 兩種領域資產；其他 kind 的 train 仍走各自核心。
//   node scripts/training-studio.js pack <規格.json> [--out builtin-training] [--fatrain]      驗證規格（內建化：授權與來源不可缺）→ 打成資產資料夾 builtin-training/<kind>/<name>/（owner:builtin）
//   node scripts/training-studio.js import-asset <檔.fatrain> [--out ...] [--replace]         使用者資產升級為內建：核對雜湊→驗證規格→owner 改 builtin（保留 parent 與作者）→放進 builtin-training/
//   node scripts/training-studio.js verify [<kind>/<name>|all] [--deep]                       核對 sha256／manifest／規格雜湊／授權來源／train-holdout 不混／可重現；--deep 再重跑評量
//   node scripts/training-studio.js embed                                                     把所有內建領域規格寫成 renderer/src/studio/builtin_domains_data.js（隨程式嵌入；執行期預設啟用）
//   node scripts/training-studio.js list                                                      列出 builtin-training/ 內容
// 只動 builtin-training/ 與 builtin_domains_data.js；不發布、不推送。commit 流程：pack → verify → embed → git status 只有預期檔案 → commit；改到 floating-assistant.js 時走 publish-live-update-patch。
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..');
const S = path.join(root, 'renderer/src/studio');
const Asset = require(path.join(S, 'asset_core.js')), Fatrain = require(path.join(S, 'fatrain_core.js')), Spec = require(path.join(S, 'domain_spec_core.js')), Expr = require(path.join(S, 'dsl_expr_core.js'));
const KINDS = ['blockly', 'matrix'];
const args = process.argv.slice(2); const cmd = args[0]; const flag = (n) => args.includes('--' + n); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = path.resolve(root, opt('out', 'builtin-training'));
const PY = process.env.FA_PYTHON || 'python';
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const info = (m) => console.log(m);
const dec = (u) => new TextDecoder('utf-8').decode(u);

function runRef(src, input) { const r = cp.spawnSync(PY, ['-I', '-c', src], { input, encoding: 'utf8', timeout: 30000 }); return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, error: r.stderr || r.error && r.error.message }; }
async function buildAsset(spec, o) {
    o = o || {}; const n = Spec.normalize(spec); let tasks = [];
    if (n.kind === 'matrix') tasks = (await Spec.buildTasks(n, {})).tasks;
    else { const bt = await Spec.buildTasks(n, { runRef: async (s, i) => runRef(s, i), tests: 4, hidden: 2 }); if (bt.problems.length) fail('家族沒能算出測資：' + bt.problems.map((p) => p.family + '：' + p.error).join('；') + '（需要 python：' + PY + '）'); tasks = bt.tasks; }
    const files = Spec.toFiles(n, tasks); const sm = Spec.summary(n);
    const manifest = Asset.createManifest({ kind: n.kind, name: n.id, files, counts: { train: sm.train, holdout: sm.holdout, algos: sm.algos, skeletons: sm.skeletons, ops: sm.ops, families: sm.families, tasks_materialized: tasks.length }, owner: 'builtin', parent: o.parent || null, created: o.created || new Date().toISOString(),
        extra: { domain: { id: n.id, spec_version: n.version, spec_sha256: Spec.hash(n), license: n.meta.license, source: n.meta.source, author: n.meta.author || null, imported_from: o.importedFrom || null } } });
    return { manifest, files };
}
function writeFolder(asset) {
    const dir = path.join(OUT, asset.manifest.kind, asset.manifest.name); fs.rmSync(dir, { recursive: true, force: true });
    for (const p of Object.keys(asset.files)) { const f = path.join(dir, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(asset.files[p])); }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(asset.manifest, null, 1) + '\n'); return dir;
}
function readFolder(dir) {
    const mf = path.join(dir, 'manifest.json'); if (!fs.existsSync(mf)) return null; const manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); const files = {};
    const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (r !== 'manifest.json') files[r] = new Uint8Array(fs.readFileSync(path.join(d, e.name))); } };
    walk(dir, ''); return { manifest, files, dir };
}
function listFolders() { const out = []; for (const k of KINDS) { const d = path.join(OUT, k); if (!fs.existsSync(d)) continue; for (const n of fs.readdirSync(d)) if (fs.existsSync(path.join(d, n, 'manifest.json'))) out.push({ kind: k, name: n, dir: path.join(d, n) }); } return out; }

// ---- 驗證一個資產資料夾；回問題清單 ----
async function verifyOne(it, deep) {
    const probs = []; const a = readFolder(it.dir); if (!a) return ['沒有 manifest.json'];
    const m = a.manifest; const vm = Asset.validateManifest(m); if (!vm.ok) probs.push(...vm.errors);
    if (m.owner !== 'builtin') probs.push('owner 應為 builtin（現在是 ' + m.owner + '）');
    if (m.kind !== it.kind || m.name !== it.name) probs.push('資料夾位置與 manifest 的 kind／name 不一致');
    const vf = Asset.verifyFiles ? Asset.verifyFiles(m, a.files) : { ok: true }; if (vf && vf.ok === false) probs.push('檔案雜湊核對不過：' + (vf.message || (vf.errors || []).join('；')));
    const f = Spec.fromFiles(a.files); if (!f.ok) return probs.concat(f.error);
    const v = Spec.validate(f.spec, { builtin: true }); if (!v.ok) probs.push(...v.errors.map((e) => '規格：' + e));
    const dm = (m.extra && m.extra.domain) || {};
    if (!dm.license || !dm.source) probs.push('manifest.extra.domain 缺授權或來源（license／source）');
    if (dm.spec_sha256 !== Spec.hash(Spec.normalize(f.spec))) probs.push('manifest 記的規格雜湊與 data/domain-spec.json 不符');
    if (f.spec.id !== m.name) probs.push('規格 id 與資產名稱不一致');
    // 題目檔：holdout 題不能出現在 train 的敘述裡；tasks.jsonl 必須與規格可重現（matrix：逐字相同）
    const rows = a.files['data/tasks.jsonl'] ? dec(a.files['data/tasks.jsonl']).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase(); const ho = new Set(rows.filter((r) => r.split === 'holdout').map((r) => norm(r.statement)));
    rows.filter((r) => r.split !== 'holdout').forEach((r) => { if (ho.has(norm(r.statement))) probs.push('holdout 敘述混進 train：' + r.id); });
    if (f.spec.kind === 'matrix') { const re = Spec.toFiles(f.spec, (await Spec.buildTasks(Spec.normalize(f.spec), {})).tasks); if (dec(re['data/tasks.jsonl']) !== dec(a.files['data/tasks.jsonl'] || new Uint8Array())) probs.push('data/tasks.jsonl 與規格重新展開的結果不同（不可重現）'); }
    else if (deep) { const bt = await Spec.buildTasks(Spec.normalize(f.spec), { runRef: async (s, i) => runRef(s, i), tests: 4, hidden: 2 }); if (bt.problems.length) probs.push('重新展開家族失敗：' + bt.problems.map((p) => p.error).join('；')); else { const re = Spec.toFiles(f.spec, bt.tasks); if (dec(re['data/tasks.jsonl']) !== dec(a.files['data/tasks.jsonl'])) probs.push('data/tasks.jsonl 與重新展開（含參考解）的結果不同'); } }
    if (deep && f.spec.kind === 'matrix') { // 離線評量：不用判題器，用同一份運算式重算
        const EV = require(path.join(S, 'domain_eval_core.js')), RT = require(path.join(S, 'domain_runtime_core.js')), SYN = require(path.join(root, 'renderer/src/algo/matrix_synth_core.js'));
        const rt = RT.createRuntime({ Synth: SYN, Spec, Expr }); const res = await EV.runDomain(f.spec, { runtime: rt, Synth: SYN, Expr, cache: {} }); rt.remove(f.spec.id);
        for (const [g, r] of Object.entries(res.groups)) { if (r.unavailable) { if (!/不搶內建題/.test(g)) probs.push(g + ' 沒跑成：' + r.unavailable); continue; } info('    ' + g + '：' + r.pass + '／' + r.n); if (/train$/.test(g) && r.pass < r.n) probs.push(g + ' 沒全過（' + r.pass + '／' + r.n + '）'); }
    }
    return probs;
}

(async () => {
    if (cmd === 'pack') {
        const file = args[1]; if (!file || file.startsWith('--')) fail('用法：pack <規格.json>'); let spec; try { spec = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { fail('讀不到規格：' + e.message); }
        const v = Spec.validate(spec, { builtin: true }); v.warnings.forEach((w) => info('提醒：' + w)); if (!v.ok) fail('規格沒通過驗證（內建化要求授權與來源）：\n  ' + v.errors.join('\n  '));
        const asset = await buildAsset(spec); const dir = writeFolder(asset); info('✓ 已打包 ' + path.relative(root, dir) + '（' + Object.keys(asset.files).length + ' 個檔案，train ' + asset.manifest.counts.train + '／holdout ' + asset.manifest.counts.holdout + '）');
        if (flag('fatrain')) { const e = Fatrain.exportAsset(asset, {}); if (!e.ok) fail(e.error); fs.writeFileSync(path.join(OUT, e.name), Buffer.from(e.bytes)); info('✓ 另存 ' + path.join(path.relative(root, OUT), e.name)); }
        const p = await verifyOne({ kind: asset.manifest.kind, name: asset.manifest.name, dir }, false); if (p.length) fail('打包後自我核對沒過：\n  ' + p.join('\n  ')); info('✓ 自我核對通過'); return;
    }
    if (cmd === 'import-asset') {
        const file = args[1]; if (!file || file.startsWith('--')) fail('用法：import-asset <檔.fatrain>'); const bytes = new Uint8Array(fs.readFileSync(path.resolve(file)));
        const r = Fatrain.readAsset(bytes, {}); if (!r.ok) fail('讀取 .fatrain 失敗（雜湊或格式不對，不收）：' + r.errors.join('；'));
        const inc = r.asset; if (KINDS.indexOf(inc.manifest.kind) < 0) fail('這支腳本的 import-asset 目前只收 ' + KINDS.join('／') + '（收到 ' + inc.manifest.kind + '）；其他 kind 的內建化見設計 §7');
        const f = Spec.fromFiles(inc.files); if (!f.ok) fail(f.error); const v = Spec.validate(f.spec, { builtin: true }); if (!v.ok) fail('驗證不過，不收（內建化要求授權與來源、train／holdout 不混）：\n  ' + v.errors.join('\n  '));
        const dir0 = path.join(OUT, f.spec.kind, f.spec.id); if (fs.existsSync(dir0) && !flag('replace')) fail('builtin-training 已有 ' + f.spec.kind + '/' + f.spec.id + '（要取代請加 --replace）');
        const asset = await buildAsset(f.spec, { parent: inc.manifest.parent || inc.manifest.name, created: inc.manifest.created, importedFrom: inc.manifest.name + '@' + (inc.manifest.sha256 && Asset.manifestHash ? Asset.manifestHash(inc.manifest).slice(0, 12) : '') });
        const dir = writeFolder(asset); const p = await verifyOne({ kind: f.spec.kind, name: f.spec.id, dir }, false); if (p.length) { fs.rmSync(dir, { recursive: true, force: true }); fail('納入後核對沒過，已回復：\n  ' + p.join('\n  ')); }
        info('✓ 已納入 ' + path.relative(root, dir) + '（owner builtin；作者 ' + (f.spec.meta.author || '未填') + '；授權 ' + f.spec.meta.license + '；來源 ' + f.spec.meta.source + '）'); return;
    }
    if (cmd === 'verify') {
        const want = args[1] && !args[1].startsWith('--') && args[1] !== 'all' ? args[1] : null; const items = listFolders().filter((x) => !want || x.kind + '/' + x.name === want);
        if (!items.length) fail(want ? '找不到 ' + want : 'builtin-training/ 還沒有任何領域資產'); let bad = 0;
        for (const it of items) { const p = await verifyOne(it, flag('deep')); if (p.length) { bad++; console.error('✗ ' + it.kind + '/' + it.name + '\n  ' + p.join('\n  ')); } else info('✓ ' + it.kind + '/' + it.name); }
        process.exit(bad ? 1 : 0);
    }
    if (cmd === 'embed') {
        const items = listFolders(); const specs = [];
        for (const it of items) { const p = await verifyOne(it, false); if (p.length) fail('不嵌入沒通過核對的資產 ' + it.kind + '/' + it.name + '：\n  ' + p.join('\n  ')); const a = readFolder(it.dir); const f = Spec.fromFiles(a.files); specs.push({ ref: it.kind + '/' + it.name, version: a.manifest.version, spec_sha256: a.manifest.extra.domain.spec_sha256, spec: Spec.normalize(f.spec) }); }
        specs.sort((a, b) => (a.ref < b.ref ? -1 : 1));
        const src = '/* 內建領域規格（由 scripts/training-studio.js embed 產生，勿手改；來源 builtin-training/）。工作室啟動時經 domain_runtime_core 載入離線 AI（預設啟用，使用者可停用）。 */\n(function (root, factory) {\n    if (typeof module === \'object\' && module.exports) module.exports = factory();\n    else root.FaStudioBuiltinDomains = factory();\n})(typeof self !== \'undefined\' ? self : this, function () {\n    \'use strict\';\n    return { specs: ' + JSON.stringify(specs) + ' };\n});\n';
        const target = path.join(S, 'builtin_domains_data.js'); fs.writeFileSync(target, src); info('✓ 已寫 ' + path.relative(root, target) + '（' + specs.length + ' 個領域）'); return;
    }
    if (cmd === 'list') { const items = listFolders(); if (!items.length) info('builtin-training/ 還沒有領域資產'); for (const it of items) { const m = readFolder(it.dir).manifest; info(it.kind + '/' + it.name + '　train ' + m.counts.train + '／holdout ' + m.counts.holdout + '　授權 ' + (m.extra && m.extra.domain.license) + '　來源 ' + (m.extra && m.extra.domain.source)); } return; }
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(cmd ? 1 : 0);
})().catch((e) => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
