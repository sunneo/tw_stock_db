/* FaLazy：網頁版延遲載入執行層（只放進 web-lazy/core.js，桌面版整份檔案不含這段）。
 * 建置時（scripts/build-web-lazy.js）把純定義的嵌入區塊搬成獨立檔，核心裡每個區塊宣告的頂層名稱換成全域取值函式：
 * 第一次碰到名稱時同步載入該區塊（同步 XMLHttpRequest），之後該名稱就是區塊自己宣告的全域綁定。
 * 所以沒有任何同步使用處需要改寫；ensure() 只是讓入口可以先非同步預載，避免同步載入卡住畫面。 */
const FaLazy = (function () {
    const chunks = Object.create(null);
    const CACHE = 'fa-lazy-v1';
    function baseUrl() { return (typeof window !== 'undefined' && window.__FA_LAZY_BASE) || ''; }
    function urlOf(name) { return baseUrl() + name + '.js'; }
    function run(name, text) {
        const c = chunks[name];
        if (c.loaded) return;
        const s = document.createElement('script');
        s.textContent = text + '\n//# sourceURL=fa-lazy-' + name + '.js';
        document.head.appendChild(s);
        s.remove();
        c.loaded = true;
    }
    function describe(name, how, status, t0, extra) {
        return new Error('延遲載入「' + name + '」失敗（' + how + '）：' + urlOf(name) + ' ' + status + '，耗時 ' + Math.round(performance.now() - t0) + ' 毫秒' + (extra ? '，' + extra : ''));
    }
    function loadSync(name) {
        const c = chunks[name];
        if (!c) throw new Error('FaLazy：沒有登記過區塊 ' + name);
        if (c.loaded) return;
        if (typeof window !== 'undefined' && window.__FA_LAZY_TRACE) (window.__faLazyTrace = window.__faLazyTrace || []).push({ name, stack: String(new Error().stack).split(/\n/).slice(2, 7).join(' | ') });
        if (c.running) throw new ReferenceError('FaLazy：區塊 ' + name + ' 載入執行到一半又被要求（循環相依）');
        let lastErr = null;
        for (let i = 0; i < 3 && !c.loaded; i++) {
            const t0 = performance.now();
            try {
                const x = new XMLHttpRequest();
                x.open('GET', urlOf(name), false);
                x.send(null);
                if (x.status < 200 || x.status >= 300) throw describe(name, '同步', 'HTTP ' + x.status, t0);
                c.running = true;
                try { run(name, x.responseText); } finally { c.running = false; }
                c.how = 'sync';
            } catch (e) { lastErr = e; if (c.loaded) break; }
        }
        if (!c.loaded) throw lastErr || new Error('FaLazy：區塊 ' + name + ' 載入失敗');
    }
    async function fetchText(name) {
        const url = urlOf(name);
        let cache = null;
        try { if (typeof caches !== 'undefined') cache = await caches.open(CACHE); } catch (e) { cache = null; }
        if (cache) { try { const hit = await cache.match(url); if (hit) return await hit.text(); } catch (e) { /* 當作沒快取 */ } }
        let lastErr = null;
        for (let i = 0; i < 4; i++) {
            const t0 = performance.now();
            try {
                const r = await fetch(url);
                if (!r.ok) throw describe(name, '非同步第 ' + (i + 1) + ' 次', 'HTTP ' + r.status, t0);
                const text = await r.text();
                if (cache) { try { await cache.put(url, new Response(text, { headers: { 'Content-Type': 'application/javascript' } })); } catch (e) { /* 快取失敗不影響使用 */ } }
                return text;
            } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 400 * (i + 1))); }
        }
        throw lastErr;
    }
    function ensure(name) {
        const c = chunks[name];
        if (!c) return Promise.reject(new Error('FaLazy：沒有登記過區塊 ' + name));
        if (c.loaded) return Promise.resolve();
        if (!c.promise) {
            c.promise = fetchText(name).then(text => { run(name, text); c.how = c.how || 'async'; }).catch(e => { c.promise = null; throw e; });
        }
        return c.promise;
    }
    // 登記一個區塊與它宣告的所有頂層名稱：名稱換成全域取值函式，第一次碰到就載入
    function register(name, names) {
        chunks[name] = { names, loaded: false, running: false, promise: null, how: '' };
        for (const n of names) {
            Object.defineProperty(globalThis, n, {
                configurable: true,
                get() { loadSync(name); return (0, eval)(n); }
            });
        }
    }
    function status() { return Object.keys(chunks).map(k => ({ name: k, loaded: chunks[k].loaded, how: chunks[k].how })); }
    return { register, ensure, loadSync, status };
})();
