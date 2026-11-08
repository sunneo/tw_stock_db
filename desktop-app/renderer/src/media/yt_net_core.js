/* YouTube 下載的網路層判斷核心（UMD，純函式，不碰網路／DOM）。
 * 2026-11-08 使用者回報：「PO Token產生失敗：抓YouTube首頁失敗：HTTP 502」→ yt-dlp「The page needs to be reloaded」。
 * 實證（本機代理 local-proxy.js 對同一支影片＋另外三支各連打三次，全部 200、頁面完整、含 ytInitialData）：
 *   代理本身與頁面內容沒問題；502 是代理在「連不上上游」時自己回的（帶 x-fa-error: connect，本文是 Node 的真正錯誤），
 *   屬於暫時性網路失敗。原本的程式只印「HTTP 502」，把真正原因（本文）丟掉，而且一次失敗就放棄。
 * 這裡集中三件事，讓橋接、PO Token、yt-dlp 解析三處共用同一套規則（測試也只測這一份）：
 *   - isTransientHttp   ：哪些回應算暫時性（代理自己回的 502／504、閘道類 502／503／504、429）
 *   - backoffMs         ：全新重試的退避時間
 *   - describeFailure   ：把「狀態碼、x-fa-error、本文錯誤、耗時、第幾次」整理成具體訊息（不只給籠統警告）
 *   - diagnoseHtml      ：抓到的網頁是真頁面、同意頁、機器人檢查頁、還是不完整
 *   - classifyYtDlpError：yt-dlp 的錯誤字串屬於哪一類，可不可以全新重來；不可重來的給誠實說明 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaYtNet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_ATTEMPTS = 3;
    const BACKOFF = [600, 1800, 4000];

    function backoffMs(attempt) { return BACKOFF[Math.min(Math.max(0, attempt | 0), BACKOFF.length - 1)]; }

    // status：HTTP 狀態碼；xFaError：本機代理的 x-fa-error 標頭（connect／timeout／tls），沒有就空字串
    function isTransientHttp(status, xFaError) {
        const s = Number(status) || 0;
        if (xFaError === 'tls') return false; // 憑證問題重試也一樣
        if (xFaError === 'connect' || xFaError === 'timeout') return true;
        return s === 502 || s === 503 || s === 504 || s === 429;
    }

    // 代理回的錯誤本文是 {"error":"..."}；其他情況回前 120 字
    function proxyErrorText(bodyText) {
        const t = String(bodyText || '').trim();
        if (!t) return '';
        try { const j = JSON.parse(t); if (j && j.error) return String(j.error).slice(0, 200); } catch (_) { /* 不是 JSON */ }
        return t.replace(/\s+/g, ' ').slice(0, 120);
    }

    // { step, status, xFaError, bodyText, elapsedMs, attempt, attempts } → 具體訊息
    function describeFailure(o) {
        o = o || {};
        const parts = [];
        parts.push(`${o.step || '請求'}失敗：HTTP ${o.status != null ? o.status : '?'}`);
        if (o.xFaError) parts.push(`本機代理判定：${{ connect: '連不上YouTube（連線錯誤）', timeout: '逾時', tls: '憑證／加密連線錯誤' }[o.xFaError] || o.xFaError}`);
        const pe = proxyErrorText(o.bodyText);
        if (pe) parts.push(`原因：${pe}`);
        if (o.elapsedMs != null) parts.push(`耗時${(o.elapsedMs / 1000).toFixed(1)}秒`);
        if (o.attempts) parts.push(`已試${o.attempt || o.attempts}/${o.attempts}次`);
        return parts.join('；');
    }

    // 抓到的網頁內容是什麼：ok／consent／bot／incomplete／empty
    function diagnoseHtml(html) {
        const h = String(html || '');
        if (!h.trim()) return { kind: 'empty', detail: '回應是空的' };
        const hasData = /ytInitialData\s*=|ytInitialPlayerResponse\s*=/.test(h);
        if (/consent\.youtube\.com|<form[^>]+action="https:\/\/consent\./i.test(h) && !hasData) return { kind: 'consent', detail: '拿到的是同意頁（cookie 同意），不是影片頁' };
        if (/unusual traffic|\/sorry\/|g-recaptcha|Sign in to confirm you.{0,3}re not a bot/i.test(h) && !hasData) return { kind: 'bot', detail: '拿到的是機器人檢查頁' };
        if (!hasData) return { kind: 'incomplete', detail: `網頁內容不完整（${h.length}字元，找不到 ytInitialData）` };
        if (!/<\/html>\s*$/i.test(h)) return { kind: 'incomplete', detail: `網頁結尾被截斷（${h.length}字元）` };
        return { kind: 'ok', detail: '' };
    }

    // yt-dlp 錯誤字串 → { kind, retryable, hint }
    function classifyYtDlpError(err) {
        const e = String(err || '');
        if (/Sign in to confirm|not a bot|confirm you.{0,3}re not a robot/i.test(e)) {
            return { kind: 'bot', retryable: false, hint: 'YouTube 要求登入或機器人驗證。這是 YouTube 對這類請求的限制，本程式不會繞過驗證；替代方案：改用「瀏覽器控制」讓真人的瀏覽器下載，或自行提供 cookie 檔。' };
        }
        if (/Video unavailable|This video is (private|not available)|has been removed|copyright|terminated/i.test(e)) {
            return { kind: 'unavailable', retryable: false, hint: '影片本身不可用（私人、已移除或地區限制），重試不會改變。' };
        }
        if (/LOGIN_REQUIRED|Sign in to/i.test(e)) {
            return { kind: 'login', retryable: false, hint: 'YouTube 要求登入才能播放，沒有可合法取得的替代做法。' };
        }
        if (/page needs to be reloaded|Incomplete data received|unable to extract|HTTP Error 5\d\d|Unable to download|timed out|Connection (reset|aborted|refused)|連線失敗|HTTP 50[234]/i.test(e)) {
            return { kind: 'transient', retryable: true, hint: '' };
        }
        return { kind: 'other', retryable: false, hint: '' };
    }

    return { MAX_ATTEMPTS, backoffMs, isTransientHttp, proxyErrorText, describeFailure, diagnoseHtml, classifyYtDlpError };
});
