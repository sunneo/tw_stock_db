'use strict';
// 領域包種子題的 train／holdout 題數：題目只寫在 renderer/src/uml/domain_*.test.js（打包後不含測試檔），
// 所以在建置（embed）時用「假的 domain_harness」載入每個測試檔，攔截它交給 H.main 的 {packs, seeds}，算出題數，嵌進程式給訓練工作室顯示。
// 回傳 { [領域包 id]: { total, train, holdout, file } }。不跑任何題、不用 Python、不碰網路。
const fs = require('fs'), path = require('path'), Module = require('module');
function seedCounts(root) {
    const dir = path.join(root, 'renderer/src/uml'); const harness = path.join(dir, 'domain_harness.js');
    const PAR = require(path.join(dir, 'py_paradigms_core.js'));
    const out = {}; const orig = Module._load;
    let cur = null;
    const stub = { rnd: (a) => a, pick: (arr) => arr[0], main: (o) => { cur = o; }, run: (o) => { cur = o; } };
    Module._load = function (req, parent, isMain) {
        if (parent && /domain_[^\\/]+\.test\.js$/.test(parent.filename || '') && /domain_harness(\.js)?$/.test(req)) return stub;
        return orig.apply(this, arguments);
    };
    try {
        for (const f of fs.readdirSync(dir).filter((x) => /^domain_.+\.test\.js$/.test(x)).sort()) {
            cur = null;
            const p = path.join(dir, f); delete require.cache[p];
            const srcText = fs.readFileSync(p, 'utf8');
            if (!/domain_harness/.test(srcText)) { // 自己跑的測試檔（不經 harness）：只靜態數 SEEDS 陣列裡 `{ id: '` 開頭的列，絕不執行（會叫 Python）
                const m = /const SEEDS = \[/.exec(srcText); const body = m ? srcText.slice(m.index) : ''; const n = (body.match(/^\s*\{ id: '/gm) || []).length; const ho = (body.match(/split: 'holdout'/g) || []).length;
                const idm = /require\('\.\/domain_(?!registry)([a-z0-9]+)_core\.js'\)/.exec(srcText); if (n && idm) out[idm[1]] = { total: n, train: n - ho, holdout: ho, file: 'renderer/src/uml/' + f, counted: 'static' };
                continue;
            }
            try { require(p); } catch (e) { out['?' + f] = { error: String((e && e.message) || e), file: 'renderer/src/uml/' + f }; continue; }
            if (!cur || !Array.isArray(cur.seeds) || !Array.isArray(cur.packs)) continue;
            const ids = cur.packs.map((pk) => { try { return pk.make(PAR).id; } catch (_) { return null; } }).filter(Boolean);
            const hold = cur.seeds.filter((s) => s.split === 'holdout').length;
            for (const id of ids) out[id] = { total: cur.seeds.length, train: cur.seeds.length - hold, holdout: hold, file: 'renderer/src/uml/' + f, shared_with: ids.length > 1 ? ids : undefined };
        }
    } finally { Module._load = orig; }
    void harness; return out;
}
module.exports = { seedCounts };
if (require.main === module) console.log(JSON.stringify(seedCounts(path.join(__dirname, '..')), null, 1));

// LoRA 訓練資料現況（倉庫的 lora-train/data 與 lora-train/gen；打包後沒有這個目錄，所以建置時算好嵌入）
function loraDatasets(root) {
    const d = path.join(root, 'lora-train/data'), g = path.join(root, 'lora-train/gen'); const sz = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : (typeof v === 'number' ? v : 0)));
    const datasets = []; if (fs.existsSync(d)) for (const f of fs.readdirSync(d).filter((x) => /\.json$/.test(x)).sort()) {
        const o = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); let rows = 0, how = '';
        if (o && o.rows !== undefined) { rows = sz(o.rows); how = 'rows'; } else if (o && typeof o.total === 'number') { rows = o.total; how = 'total'; } else { rows = Object.keys(o).reduce((n, k) => n + sz(o[k]), 0); how = '各表筆數加總'; }
        datasets.push({ name: f.replace(/\.json$/, ''), rows, counted_by: how, file: 'lora-train/data/' + f, bytes: fs.statSync(path.join(d, f)).size });
    }
    const generators = fs.existsSync(g) ? fs.readdirSync(g).filter((x) => /\.js$/.test(x)).sort() : [];
    return { datasets, generators: generators.map((x) => 'lora-train/gen/' + x) };
}
module.exports.loraDatasets = loraDatasets;
