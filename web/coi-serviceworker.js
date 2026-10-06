/*! coi-serviceworker（自寫版，credentialless）：讓靜態網站（GitHub Pages 不能設自訂標頭）取得 cross-origin isolated，
 *  這樣瀏覽器才會開放 SharedArrayBuffer——離線模型（Whisper、離線圖像轉文字…）的 WebAssembly 多執行緒要靠它。
 *  做法：Service Worker 攔截這個站台的回應，補上 COOP: same-origin 與 COEP: credentialless。
 *  用 credentialless（不是 require-corp）：跨網域的圖片／腳本不需要對方送 CORP 標頭，只是請求不帶 cookie，對現有頁面的影響最小。
 *  取不到隔離（瀏覽器不支援 credentialless，例如 Safari）時不影響原本功能，只是離線模型的 CPU 路徑回到單執行緒。
 *  只會自己重新整理一次（sessionStorage 旗標），不會無限重新整理。
 */
if (typeof window === 'undefined') {
    // ---- Service Worker 端 ----
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
    self.addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'deregister') { self.registration.unregister().then(() => self.clients.matchAll()).then((cs) => cs.forEach((c) => c.navigate(c.url))); } });
    self.addEventListener('fetch', (e) => {
        const r = e.request;
        if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return; // 瀏覽器的已知問題
        e.respondWith(fetch(r).then((resp) => {
            if (resp.status === 0) return resp; // opaque（no-cors 的跨網域回應）：原樣交回，不能改標頭
            const h = new Headers(resp.headers);
            h.set('Cross-Origin-Embedder-Policy', 'credentialless');
            h.set('Cross-Origin-Opener-Policy', 'same-origin');
            return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
        }).catch((err) => { console.error('[coi-serviceworker]', err); throw err; }));
    });
} else {
    // ---- 頁面端 ----
    (() => {
        const FLAG = 'coiReloadedBySelf';
        const reloaded = (() => { try { return sessionStorage.getItem(FLAG); } catch (_) { return null; } })();
        try { sessionStorage.removeItem(FLAG); } catch (_) {}
        if (window.crossOriginIsolated !== false) return; // 已經隔離，或這個瀏覽器根本沒有這個概念
        if (!window.isSecureContext || !navigator.serviceWorker) return; // Service Worker 需要 https 或 localhost
        if (reloaded === 'true') { console.warn('[coi-serviceworker] 重新整理後仍然不是 cross-origin isolated（瀏覽器可能不支援 COEP credentialless）；離線模型的 CPU 路徑只會用單執行緒。'); return; }
        // 使用者可以用 ?nocoi 關掉（除錯用）
        if (/[?&]nocoi\b/.test(location.search)) return;
        navigator.serviceWorker.register(document.currentScript.src).then((reg) => {
            reg.addEventListener('updatefound', () => { try { sessionStorage.setItem(FLAG, 'true'); } catch (_) {} location.reload(); });
            if (reg.active && !navigator.serviceWorker.controller) { try { sessionStorage.setItem(FLAG, 'true'); } catch (_) {} location.reload(); }
        }, (err) => console.error('[coi-serviceworker] 註冊失敗：', err));
    })();
}
