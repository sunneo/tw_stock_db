// node renderer/src/media/yt_net_core.test.js
const N = require('./yt_net_core.js');
let pass = 0, fail = 0;
const t = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log('✗', name, extra === undefined ? '' : JSON.stringify(extra)); } };

// 502：代理自己回的（連不上）與純 502
t('502 連線錯誤算暫時性', N.isTransientHttp(502, 'connect') === true);
t('502 沒標頭也算暫時性', N.isTransientHttp(502, '') === true);
t('504 逾時算暫時性', N.isTransientHttp(504, 'timeout') === true);
t('憑證錯誤不重試', N.isTransientHttp(502, 'tls') === false);
t('403 不重試', N.isTransientHttp(403, '') === false);
t('200 不重試', N.isTransientHttp(200, '') === false);
t('429 重試', N.isTransientHttp(429, '') === true);

// 退避單調且有上限
t('退避遞增', N.backoffMs(0) < N.backoffMs(1) && N.backoffMs(1) < N.backoffMs(2));
t('退避有上限', N.backoffMs(99) === N.backoffMs(2));

// 失敗訊息要有具體事實
const m = N.describeFailure({ step: '抓YouTube首頁', status: 502, xFaError: 'connect', bodyText: '{"error":"getaddrinfo ENOTFOUND www.youtube.com"}', elapsedMs: 1234, attempt: 3, attempts: 3 });
t('訊息含狀態碼', /HTTP 502/.test(m), m);
t('訊息含步驟', /抓YouTube首頁/.test(m), m);
t('訊息含代理判定', /連不上YouTube/.test(m), m);
t('訊息含真正原因', /ENOTFOUND/.test(m), m);
t('訊息含耗時', /1\.2秒/.test(m), m);
t('訊息含次數', /已試3\/3次/.test(m), m);
t('非 JSON 本文也能顯示', /Bad Gateway/.test(N.describeFailure({ step: 'x', status: 502, bodyText: '<h1>Bad Gateway</h1>' })));

// 網頁診斷：真頁面、同意頁、機器人檢查頁、不完整
const good = '<html><script>var ytInitialData = {};</script><script>var ytInitialPlayerResponse = {};</script></html>';
t('完整頁面', N.diagnoseHtml(good).kind === 'ok', N.diagnoseHtml(good));
t('同意頁', N.diagnoseHtml('<html><form action="https://consent.youtube.com/save"></form></html>').kind === 'consent');
t('機器人檢查頁', N.diagnoseHtml('<html>Our systems have detected unusual traffic <a href="/sorry/index">').kind === 'bot');
t('不完整 HTML（沒有 ytInitialData）', N.diagnoseHtml('<html><head><title>YouTube</title></head><body>').kind === 'incomplete');
t('被截斷（有資料但沒收尾）', N.diagnoseHtml('<html><script>var ytInitialData = {"a":1').kind === 'incomplete');
t('空回應', N.diagnoseHtml('').kind === 'empty');

// yt-dlp 錯誤分類：使用者貼的那一種要能重試；登入／無法播放要誠實說做不到
const userErr = 'ERROR: [youtube] Jsw5U9sBeps: The page needs to be reloaded.';
const c1 = N.classifyYtDlpError(userErr);
t('The page needs to be reloaded 可重試', c1.retryable === true && c1.kind === 'transient', c1);
t('Incomplete data 可重試', N.classifyYtDlpError('Incomplete data received in embedded initial data').retryable === true);
t('HTTP Error 502 可重試', N.classifyYtDlpError('Unable to download webpage: HTTP Error 502: Bad Gateway').retryable === true);
t('逾時可重試', N.classifyYtDlpError('The read operation timed out').retryable === true);
const c2 = N.classifyYtDlpError('ERROR: [youtube] x: Sign in to confirm you’re not a bot');
t('機器人驗證不重試且有替代方案', c2.retryable === false && c2.kind === 'bot' && /瀏覽器控制/.test(c2.hint), c2);
const c3 = N.classifyYtDlpError('ERROR: [youtube] x: Video unavailable. This video is private');
t('影片不可用不重試', c3.retryable === false && c3.kind === 'unavailable', c3);
const c4 = N.classifyYtDlpError('ERROR: [youtube] x: LOGIN_REQUIRED');
t('LOGIN_REQUIRED 不重試', c4.retryable === false && c4.kind === 'login', c4);
t('其他錯誤不重試', N.classifyYtDlpError('some other thing').retryable === false);

// 重試迴圈的模擬：前兩次 502、第三次成功 → 3 次內成功；一直 502 → 放棄並帶最後訊息
function run(seq) {
    let used = 0, last = null;
    for (let a = 0; a < N.MAX_ATTEMPTS; a++) {
        const r = seq[Math.min(a, seq.length - 1)]; used++;
        if (r.status === 200) return { ok: true, used };
        last = r;
        if (!N.isTransientHttp(r.status, r.x)) break;
    }
    return { ok: false, used, msg: N.describeFailure({ step: '抓YouTube首頁', status: last.status, xFaError: last.x, attempt: used, attempts: N.MAX_ATTEMPTS }) };
}
t('502,502,200 → 第 3 次成功', (() => { const r = run([{ status: 502, x: 'connect' }, { status: 502, x: 'connect' }, { status: 200 }]); return r.ok && r.used === 3; })());
t('一直 502 → 試滿 3 次後放棄', (() => { const r = run([{ status: 502, x: 'connect' }]); return !r.ok && r.used === 3 && /已試3\/3次/.test(r.msg); })());
t('403 → 不重試只試 1 次', (() => { const r = run([{ status: 403, x: '' }]); return !r.ok && r.used === 1; })());

console.log(`yt_net_core: ${pass}/${pass + fail} 通過`);
process.exit(fail ? 1 : 0);
