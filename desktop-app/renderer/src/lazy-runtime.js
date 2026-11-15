/* FaLazy：網頁版延遲載入執行層（只放進 web-lazy/core.js，桌面版整份檔案不含這段）。
 * 建置時（scripts/build-web-lazy.js）把純定義的嵌入區塊搬成獨立檔，核心裡每個區塊宣告的頂層名稱換成全域取值函式：
 * 第一次碰到名稱時同步載入該區塊（同步 XMLHttpRequest），之後該名稱就是區塊自己宣告的全域綁定。
 * 所以沒有任何同步使用處需要改寫；ensure() 只是讓入口可以先非同步預載，避免同步載入卡住畫面。
 *
 * 2026-11-15 冷載入優化：
 * - 來源有多個（window.__FA_LAZY_BASES，依序嘗試：jsDelivr 釘 SHA → raw.githubusercontent.com）；
 *   每個來源失敗都會 console.warn 寫出來源、錯誤與耗時，再換下一個來源。舊版頁面只設 __FA_LAZY_BASE 時維持單一來源。
 * - 頁面可以在核心執行前用 window.__FA_PREFETCH（區塊名稱 → 已抓好的原始碼文字）先把開機要用的區塊平行抓好，
 *   loadSync() 優先讀這裡，不再逐個同步 XHR（冷快取時每個同步請求都是一次網路往返）。沒有預抓的名稱照舊同步載入。 */
const FaLazy = (function () {
    const chunks = Object.create(null);
    const CACHE = 'fa-lazy-v1';
    function bases() {
        const list = (typeof window !== 'undefined' && window.__FA_LAZY_BASES) || null;
        if (list && list.length) return list;
        return [(typeof window !== 'undefined' && window.__FA_LAZY_BASE) || ''];
    }
    function urlOf(name, base) { return base + name + '.js'; }
    function note(msg) { try { console.warn('[FaLazy] ' + msg); } catch (e) { /* console 不可用就算了 */ } }
    function prefetched(name) {
        const m = (typeof window !== 'undefined' && window.__FA_PREFETCH) || null;
        return m && typeof m[name] === 'string' ? m[name] : null;
    }
    function run(name, text) {
        const c = chunks[name];
        if (c.loaded) return;
        const s = document.createElement('script');
        s.textContent = text + '\n//# sourceURL=fa-lazy-' + name + '.js';
        document.head.appendChild(s);
        s.remove();
        c.loaded = true;
    }
    function describe(name, how, status, t0, extra, url) {
        return new Error('延遲載入「' + name + '」失敗（' + how + '）：' + url + ' ' + status + '，耗時 ' + Math.round(performance.now() - t0) + ' 毫秒' + (extra ? '，' + extra : ''));
    }
    function loadSync(name) {
        const c = chunks[name];
        if (!c) throw new Error('FaLazy：沒有登記過區塊 ' + name);
        if (c.loaded) return;
        if (typeof window !== 'undefined' && window.__FA_LAZY_TRACE) (window.__faLazyTrace = window.__faLazyTrace || []).push({ name, stack: String(new Error().stack).split(/\n/).slice(2, 7).join(' | ') });
        if (c.running) throw new ReferenceError('FaLazy：區塊 ' + name + ' 載入執行到一半又被要求（循環相依）');
        const pre = prefetched(name);
        if (pre !== null) {
            c.running = true;
            try { run(name, pre); } finally { c.running = false; }
            c.how = 'prefetch';
            return;
        }
        let lastErr = null;
        const list = bases();
        for (let round = 0; round < 3 && !c.loaded; round++) {
            for (const base of list) {
                if (c.loaded) break;
                const t0 = performance.now();
                const url = urlOf(name, base);
                try {
                    const x = new XMLHttpRequest();
                    x.open('GET', url, false);
                    x.send(null);
                    if (x.status < 200 || x.status >= 300) throw describe(name, '同步', 'HTTP ' + x.status, t0, '', url);
                    c.running = true;
                    try { run(name, x.responseText); } finally { c.running = false; }
                    c.how = 'sync';
                } catch (e) {
                    lastErr = e;
                    if (c.loaded) break;
                    note('區塊 ' + name + ' 從 ' + base + ' 同步載入失敗（第 ' + (round + 1) + ' 輪）：' + (e && e.message ? e.message : e) + '，耗時 ' + Math.round(performance.now() - t0) + ' 毫秒，改用下一個來源');
                }
            }
        }
        if (!c.loaded) throw lastErr || new Error('FaLazy：區塊 ' + name + ' 載入失敗');
    }
    async function fetchText(name) {
        let cache = null;
        try { if (typeof caches !== 'undefined') cache = await caches.open(CACHE); } catch (e) { cache = null; }
        const list = bases();
        for (const base of list) {
            const url = urlOf(name, base);
            if (cache) { try { const hit = await cache.match(url); if (hit) return await hit.text(); } catch (e) { /* 當作沒快取 */ } }
        }
        let lastErr = null;
        for (let i = 0; i < 4; i++) {
            for (const base of list) {
                const t0 = performance.now();
                const url = urlOf(name, base);
                try {
                    const r = await fetch(url);
                    if (!r.ok) throw describe(name, '非同步第 ' + (i + 1) + ' 次', 'HTTP ' + r.status, t0, '', url);
                    const text = await r.text();
                    if (cache) { try { await cache.put(url, new Response(text, { headers: { 'Content-Type': 'application/javascript' } })); } catch (e) { /* 快取失敗不影響使用 */ } }
                    return text;
                } catch (e) { lastErr = e; note('區塊 ' + name + ' 從 ' + base + ' 非同步載入失敗：' + (e && e.message ? e.message : e)); }
            }
            await new Promise(res => setTimeout(res, 400 * (i + 1)));
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
