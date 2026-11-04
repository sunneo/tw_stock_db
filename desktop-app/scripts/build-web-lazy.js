#!/usr/bin/env node
// 網頁版延遲載入建置：把「純定義」的嵌入區塊（頂層只有 const／let／function／class 宣告）從核心搬成獨立檔。
//   web-lazy/core.js            核心（含 FaLazy 執行層與每個區塊的登記）
//   web-lazy/chunks/<名稱>.js    各區塊（第一次碰到區塊宣告的名稱時才載入）
//   web-lazy/manifest.json       區塊清單（名稱、宣告的名稱、大小、檢查碼），publish.sh 用來逐一驗證
// 桌面版繼續用 renderer/floating-assistant.js 整份檔案（舊版 main.js 的熱更新白名單只認這幾個檔案，分檔到不了舊版）。
// 由 build-assistant.js 呼叫；也可單獨執行：node scripts/build-web-lazy.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const acorn = require('acorn');
const { minify } = require('terser');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web-lazy');
const MIN_CHARS = 3 * 1024;                  // 小於這個大小的區塊不值得多一次請求
// 開頁（核心載入與 new FloatingAssistant）就一定會碰到的區塊：分出去只會變成開頁時一串同步請求，留在核心。清單用 scripts/lazy-test/harness.html 的 __FA_LAZY_TRACE 量得。
const EXCLUDE = new Set('EDTEXT,EDOBJ,EDSHELL,ED3DUI,ED3D,MESHGEN,ED3DP,EDSTORE,ZHTTS,KIHOST,AGM,VLM,DESIGN,RECIPE,UML,GLUE,DOCGEN,TTSPRON,IMGROUTE,IDRSKILL,GUIBRIDGE,GUIRENDER,GUIZENITY,GUIHOST,GUIPYWORKER,GUIPYASYNC,GUIJSPROGRAM,READLEDGER,CHATTREE,TOPICLOCAL,SUBCHATHANDOFF,COLUB,CATALOG,CATMX,UMLB,WIN,TOOLBUDGET'.split(','));

function analyze(code) {
    const re = /\/\* ([A-Z0-9]+)-BEGIN \*\/([\s\S]*?)\/\* \1-END \*\//g;
    const out = [];
    let b;
    while ((b = re.exec(code))) {
        const body = b[2];
        let ast;
        try { ast = acorn.parse(body, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); } catch (e) { continue; }
        const names = [];
        let pure = true;
        for (const n of ast.body) {
            if (n.type === 'VariableDeclaration') n.declarations.forEach(d => d.id.type === 'Identifier' ? names.push(d.id.name) : (pure = false));
            else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') names.push(n.id.name);
            else pure = false;
        }
        out.push({ name: b[1], start: b.index, end: b.index + b[0].length, body, names, pure: pure && names.length > 0 });
    }
    return out;
}

async function build(code, minifyOpts) {
    const all = analyze(code);
    const picked = all.filter(x => x.pure && x.body.length >= MIN_CHARS && !EXCLUDE.has(x.name));
    // 名稱不得重複宣告（兩個區塊宣告同一名稱，載入順序就會影響結果）
    const seen = new Map();
    for (const x of picked) for (const n of x.names) { if (seen.has(n)) throw new Error('區塊 ' + x.name + ' 與 ' + seen.get(n) + ' 都宣告了 ' + n); seen.set(n, x.name); }
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, 'chunks'), { recursive: true });
    const manifest = { schema: 1, chunks: {} };
    let core = '';
    let pos = 0;
    for (const x of picked) {
        core += code.slice(pos, x.start);
        pos = x.end;
        const r = await minify(x.body, { compress: { drop_console: false, drop_debugger: true }, mangle: true, format: { comments: false } });
        if (r.error || !r.code) throw new Error('壓縮區塊失敗 ' + x.name);
        const file = x.name.toLowerCase() + '.js';
        fs.writeFileSync(path.join(OUT, 'chunks', file), r.code, 'utf8');
        manifest.chunks[x.name.toLowerCase()] = { file: 'chunks/' + file, names: x.names, size: Buffer.byteLength(r.code), md5: crypto.createHash('md5').update(r.code).digest('hex') };
    }
    core += code.slice(pos);
    const runtime = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'lazy-runtime.js'), 'utf8');
    const reg = Object.keys(manifest.chunks).map(k => 'FaLazy.register(' + JSON.stringify(k) + ',' + JSON.stringify(manifest.chunks[k].names) + ');').join('\n');
    const r = await minify(runtime + '\n' + reg + '\n' + core, minifyOpts);
    if (r.error || !r.code) throw new Error('壓縮核心失敗');
    fs.writeFileSync(path.join(OUT, 'core.js'), r.code, 'utf8');
    manifest.core = { size: Buffer.byteLength(r.code), md5: crypto.createHash('md5').update(r.code).digest('hex') };
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n', 'utf8');
    const tot = Object.values(manifest.chunks).reduce((a, c) => a + c.size, 0);
    console.log('[build-web-lazy] core.js ' + (manifest.core.size / 1024).toFixed(0) + 'K；' + picked.length + ' 個區塊共 ' + (tot / 1024).toFixed(0) + 'K 搬成獨立檔');
    return manifest;
}

module.exports = { build, analyze };

if (require.main === module) {
    (async () => {
        let code = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'floating-assistant.js'), 'utf8');
        const features = require('./ai-features.js');
        code = code.replace('/*__FA_AI_FEATURES__*/null', () => JSON.stringify(features.build()));
        await build(code, { compress: { drop_console: false, drop_debugger: true }, mangle: true, format: { comments: false } });
    })().catch(e => { console.error(e); process.exit(1); });
}
