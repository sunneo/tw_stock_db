'use strict';
// 網頁版冷載入：(1) 延遲載入執行層 FaLazy 的來源退路與預抓；(2) 網頁版 html 裡的 __faFetchFirst／__faLoadCore（jsDelivr→raw 退路、boot.json 預抓）。
// 用 vm 沙盒＋假的 fetch／XMLHttpRequest／document，不碰網路、不開瀏覽器。
// 用法：node scripts/web-cold-load.test.js   （第二部分需要網頁版倉庫；找不到就略過並印出）
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const bad = []; let ok = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(() => { ok++; }, (e) => { bad.push(name + ': ' + (e && e.message)); }); }

function makeSandbox(opts) {
    const warns = [];
    const appended = [];
    const sandbox = {
        console: { warn: (m) => warns.push(String(m)), log: () => {} },
        performance: { now: () => 0 },
        setTimeout: (f) => { f(); return 0; }, clearTimeout: () => {},
        document: { createElement: () => ({ remove() {} }), head: { appendChild: (s) => { appended.push(s); vm.runInContext(s.textContent, ctx); } } },
        window: {},
        Blob: function () {}, URL: { createObjectURL() { return 'blob:x'; }, revokeObjectURL() {} },
        fetch: opts.fetch || (async () => { throw new Error('no fetch'); }),
        XMLHttpRequest: opts.XHR || function () { this.status = 0; this.send = () => { this.status = 404; }; this.open = () => {}; },
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    return { ctx, warns, appended, sandbox };
}

const runtimeSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'lazy-runtime.js'), 'utf8');

(async () => {
    await check('FaLazy：預抓的區塊不發 XHR、直接執行', () => {
        const box = makeSandbox({});
        box.sandbox.window.__FA_PREFETCH = { demo: 'const __DEMO_VALUE = 42;' };
        box.sandbox.window.__FA_LAZY_BASES = ['https://a.test/c/', 'https://b.test/c/'];
        let xhrCalls = 0; box.sandbox.XMLHttpRequest = function () { xhrCalls++; };
        vm.runInContext(runtimeSrc + '\nFaLazy.register("demo", ["__DEMO_VALUE"]);', box.ctx);
        assert.strictEqual(vm.runInContext('__DEMO_VALUE', box.ctx), 42);
        assert.strictEqual(xhrCalls, 0);
    });

    await check('FaLazy：jsDelivr 同步失敗 → 退回 raw，並寫出來源與錯誤', () => {
        const hits = [];
        const box = makeSandbox({
            XHR: function () { this.open = (m, url) => { this.url = url; hits.push(url); }; this.send = () => { this.status = this.url.indexOf('cdn.jsdelivr') >= 0 ? 0 : 200; this.responseText = 'const __FB_VALUE = 7;'; }; },
        });
        box.sandbox.window.__FA_LAZY_BASES = ['https://cdn.jsdelivr.test/c/', 'https://raw.test/c/'];
        vm.runInContext(runtimeSrc + '\nFaLazy.register("fb", ["__FB_VALUE"]);', box.ctx);
        assert.strictEqual(vm.runInContext('__FB_VALUE', box.ctx), 7);
        assert.ok(hits[0].indexOf('cdn.jsdelivr.test') >= 0 && hits[hits.length - 1].indexOf('raw.test') >= 0, '應先試 jsDelivr 再試 raw：' + hits.join(' '));
        assert.ok(box.warns.some((w) => w.indexOf('cdn.jsdelivr.test') >= 0 && w.indexOf('改用下一個來源') >= 0), 'console.warn 應寫出 jsDelivr 失敗：' + box.warns.join(' | '));
    });

    await check('FaLazy：只設舊的 __FA_LAZY_BASE 時維持單一來源', () => {
        const box = makeSandbox({ XHR: function () { this.open = (m, url) => { this.url = url; }; this.send = () => { this.status = 200; this.responseText = 'const __OLD_VALUE = 1;'; }; } });
        box.sandbox.window.__FA_LAZY_BASE = 'https://only.test/c/';
        vm.runInContext(runtimeSrc + '\nFaLazy.register("old", ["__OLD_VALUE"]);', box.ctx);
        assert.strictEqual(vm.runInContext('__OLD_VALUE', box.ctx), 1);
    });

    await check('FaLazy：ensure 非同步來源失敗會換下一個來源', async () => {
        const seen = [];
        const box = makeSandbox({
            fetch: async (url) => { seen.push(url); if (url.indexOf('bad.test') >= 0) return { ok: false, status: 503 }; return { ok: true, text: async () => 'const __ASYNC_VALUE = 9;' }; },
        });
        box.sandbox.window.__FA_LAZY_BASES = ['https://bad.test/c/', 'https://good.test/c/'];
        vm.runInContext(runtimeSrc + '\nFaLazy.register("as", ["__ASYNC_VALUE"]);', box.ctx);
        await vm.runInContext('FaLazy.ensure("as")', box.ctx);
        assert.strictEqual(vm.runInContext('__ASYNC_VALUE', box.ctx), 9);
        assert.ok(seen.some((u) => u.indexOf('good.test') >= 0));
    });

    // 第二部分：網頁版 html 裡的載入器（取出 <script> 區塊，在沙盒執行）
    const webDirs = [process.env.FA_WEB_DIR, path.join(ROOT, '..', '..', 'videos-嗨投資', 'web'), path.join(ROOT, '..', 'web')].filter(Boolean);
    const webDir = webDirs.find((d) => fs.existsSync(path.join(d, 'index.html')));
    if (!webDir) {
        console.log('略過網頁版 html 測試：找不到網頁版倉庫（可用環境變數 FA_WEB_DIR 指定）');
    } else {
        const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
        const m = html.match(/<script>\s*\(function \(\) \{\s*var SHA[\s\S]*?window\.__faLoadCore = [\s\S]*?\}\)\(\);\s*<\/script>/);
        await check('網頁版：__faLoadCore 從 jsDelivr 抓核心與開機區塊；boot.json 的區塊預抓進 __FA_PREFETCH', async () => {
            assert.ok(m, '找不到 __faLoadCore 的 script 區塊');
            const fetched = [];
            const box = makeSandbox({
                fetch: async (url) => {
                    fetched.push(url);
                    if (url.endsWith('boot.json')) return { ok: true, text: async () => '["alpha"]' };
                    if (url.endsWith('core.js')) return { ok: true, text: async () => 'CORE_TEXT' };
                    if (url.endsWith('chunks/alpha.js')) return { ok: true, text: async () => 'ALPHA_TEXT' };
                    return { ok: false, status: 404 };
                },
            });
            vm.runInContext(m[0].replace(/^<script>/, '').replace(/<\/script>$/, ''), box.ctx);
            const text = await vm.runInContext('window.__faLoadCore()', box.ctx);
            assert.strictEqual(text, 'CORE_TEXT');
            assert.strictEqual(box.sandbox.window.__FA_PREFETCH.alpha, 'ALPHA_TEXT');
            assert.ok(fetched.every((u) => u.indexOf('cdn.jsdelivr.net') >= 0), '正常時全部應走 jsDelivr：' + fetched.join(' '));
        });
        await check('網頁版：jsDelivr 失敗（逾時或非 200）→ 退回 raw，並 console.warn', async () => {
            assert.ok(m, '找不到 __faLoadCore 的 script 區塊');
            const fetched = [];
            const box = makeSandbox({
                fetch: async (url) => {
                    fetched.push(url);
                    if (url.indexOf('cdn.jsdelivr.net') >= 0) return { ok: false, status: 500 };
                    if (url.endsWith('boot.json')) return { ok: false, status: 404 };
                    if (url.endsWith('core.js')) return { ok: true, text: async () => 'CORE_RAW' };
                    return { ok: false, status: 404 };
                },
            });
            vm.runInContext(m[0].replace(/^<script>/, '').replace(/<\/script>$/, ''), box.ctx);
            const text = await vm.runInContext('window.__faLoadCore()', box.ctx);
            assert.strictEqual(text, 'CORE_RAW');
            assert.ok(fetched.some((u) => u.indexOf('raw.githubusercontent.com') >= 0 && u.endsWith('core.js')), '應退回 raw');
            assert.ok(box.warns.some((w) => w.indexOf('core.js') >= 0 && w.indexOf('cdn.jsdelivr.net') >= 0), 'console.warn 應寫出 core.js 從 jsDelivr 失敗');
        });
    }

    await check('預熱網址：core、boot.json 與 manifest 每個分塊，全部釘在同一個 SHA 的 jsDelivr 網址', () => {
        const { warmUrls } = require('./web-warm-urls.js');
        const sha = 'a575ce383e47b7312a84736e86eb53a3e59b3d9f';
        const urls = warmUrls(sha, { chunks: { yk: {}, codeui: {} } }, []);
        assert.deepStrictEqual(urls, [
            'https://cdn.jsdelivr.net/gh/sunneo/tw_stock_db@' + sha + '/desktop-app/web-lazy/core.js',
            'https://cdn.jsdelivr.net/gh/sunneo/tw_stock_db@' + sha + '/desktop-app/web-lazy/boot.json',
            'https://cdn.jsdelivr.net/gh/sunneo/tw_stock_db@' + sha + '/desktop-app/web-lazy/chunks/yk.js',
            'https://cdn.jsdelivr.net/gh/sunneo/tw_stock_db@' + sha + '/desktop-app/web-lazy/chunks/codeui.js',
        ]);
    });
    await check('預熱網址：分支名或短 SHA 直接拒絕（不預熱錯誤的 commit）', () => {
        const { warmUrls } = require('./web-warm-urls.js');
        assert.throws(() => warmUrls('main', { chunks: {} }, []));
        assert.throws(() => warmUrls('a575ce38', { chunks: {} }, []));
    });

    console.log('web-cold-load.test：通過 ' + ok + ' 項' + (bad.length ? '，失敗 ' + bad.length + ' 項' : ''));
    for (const b of bad) console.log('  ✗ ' + b);
    process.exit(bad.length ? 1 : 0);
})();
