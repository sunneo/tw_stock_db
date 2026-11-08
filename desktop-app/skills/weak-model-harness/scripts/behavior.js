/* 程式行為分析（tree-sitter 語法樹為基礎的 FaBeh2，見 vendor/behavior_engine.js）。
 * 剖析器（web-tree-sitter 與各語言 wasm）第一次從 CDN 下載並快取到 $FA_TS_DIR（預設系統暫存資料夾 fa-ts-cache）；沒網路又沒快取就回明確錯誤，不猜。
 */
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const https = require('https');
const tryReq = (p) => { try { return require(p); } catch (_) { return null; } };
const TA = tryReq('../../../renderer/src/behavior/ts_assets_core.js');   // 文法來源表（在倉庫裡才有；單獨打包的技能沒有就只走 jsdelivr）
const B = tryReq('./vendor/behavior_engine.js');
if (!B) throw new Error('找不到 vendor/behavior_engine.js，先執行 node scripts/pack.js');
const cacheDir = () => process.env.FA_TS_DIR || path.join(os.tmpdir(), 'fa-ts-cache');
const TSV = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.20.8/', WV = 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.11/out/';
const WV_OVERRIDE = { ruby: 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.6/out/' };   // ruby 較新的 grammar 在 0.20.8 上會當掉
function get(url) {
    return new Promise((res, rej) => {
        https.get(url, (r) => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(new URL(r.headers.location, url).href).then(res, rej);
            if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode + ' ' + url));
            const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res(Buffer.concat(c)));
        }).on('error', rej);
    });
}
async function cached(name, url) { const f = path.join(cacheDir(), name); if (!fs.existsSync(f)) { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(f, await get(url)); } return f; }
const host = {
    async loadTreeSitter() {
        const js = await cached('tree-sitter.js', TSV + 'tree-sitter.js'); const wasm = await cached('tree-sitter.wasm', TSV + 'tree-sitter.wasm');
        const Parser = require(js); await Parser.init({ locateFile: () => wasm }); return Parser;
    },
    // 取得順序：本機快取 → 專案內建（renderer/vendor/tree-sitter，只有 Python）→ 釘住 commit 的分支（核對位元組數與 MD5）→ jsdelivr。FaTsAssets 找不到（單獨打包的技能）就維持只走 jsdelivr
    async loadLanguageWasm(name) {
        if (TA && TA.has(name)) {
            const f = path.join(cacheDir(), 'tree-sitter-' + name + '@' + TA.COMMIT.slice(0, 8) + '.wasm');
            try { if (fs.existsSync(f)) { const b = fs.readFileSync(f); if (TA.verify(name, b).ok) return new Uint8Array(b); } } catch (_) { /* 快取壞了就重取 */ }
            if (TA.sources(name)[0].kind === 'bundled') { try { const vb = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'renderer', 'vendor', 'tree-sitter', TA.sources(name)[0].file)); if (TA.verify(name, vb).ok) return new Uint8Array(vb); } catch (_) { /* 沒有內建就往下 */ } }
            try { const b = await get(TA.RAW + TA.file(name)); if (TA.verify(name, b).ok) { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(f, b); return new Uint8Array(b); } } catch (_) { /* 分支不通或核對不過 → 退到 jsdelivr，不存壞檔 */ }
        }
        const base = WV_OVERRIDE[name] || WV;
        return new Uint8Array(fs.readFileSync(await cached('tree-sitter-' + name + (WV_OVERRIDE[name] ? '-v06' : '') + '.wasm', base + 'tree-sitter-' + name + '.wasm')));
    }
};
let engine = null;
function getEngine() {
    if (!engine) { const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor', 'behavior_data.json'), 'utf8')); engine = B.create({ patterns: data.patterns, api: data.api }, host, { categories: {}, api: {}, idioms: {}, notes: {}, mnemonics: {} }); }
    return engine;
}
// 回傳 { ok, language, functions:[{name, behaviors, branches, loops, comment}], markdown } 或 { ok:false, error }
async function explainFile(file) {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: '讀不到檔案：' + file }; }
    try {
        const r = await getEngine().explain(path.basename(file), text, { notes: {} });
        return { ok: true, language: r.meta && r.meta.language, unclassified: (r.meta && r.meta.unclassified) || [], functions: r.functions.map((f) => ({ name: f.name, behaviors: f.behaviors, branches: f.branch_count, loops: f.loop_count, comment: f.leading_comment_text || '' })), markdown: r.markdown };
    } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 300) + '（第一次需要網路下載語法樹，之後會用快取）' }; }
}
module.exports = { explainFile, getEngine, host };
