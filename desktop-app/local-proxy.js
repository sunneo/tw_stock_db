// 本地CORS繞道代理——取代Cloudflare Worker（見tw_stock_db_code私有repo的
// code/cloudflare-worker/worker.js）。floating-assistant.js本身一律用
// 瀏覽器`fetch()`打外部API（LLM/git smart-http/TTS/搜尋…），這些外部服務
// 大多數不會對瀏覽器開CORS，webapp部署時才需要一個server端中繼把回應加上
// `Access-Control-Allow-Origin`。Electron桌面版把這個中繼跑在本機（Node的
// http模組，不需要額外套件），renderer打`http://127.0.0.1:<port>/proxy/<url>`
// （或別名`/git-proxy/<url>`，跟git_operations既有的`corsProxy+'/git-proxy'`
// 慣例對齊，不用改floating-assistant.js任何一行）就能繞過CORS，不需要
// 依賴使用者自己部署/維護一個Cloudflare Worker，也不需要任何雲端服務。
//
// 2026-09-15使用者追加要求——「server configure」：NVAPI_KEY/OPENROUTER_API_KEY
// 存在main.js管理的本機secrets.json（使用者要求JSON格式，不要.env），
// renderer完全看不到實際金鑰值（IPC只回報有沒有設定，見main.js的
// fa:secrets:status）。這裡新增`/nvidia/*`、`/openrouter/*`兩條「固定
// 上游、自動注入Authorization」的路由，呼應worker.js的
// handleNvidiaProxy/handleOpenRouterProxy——差別是那邊是多人共用一把雲端
// 金鑰、用假金鑰字串當身分識別，這裡是單人本機使用，金鑰對應關係單純
// （這個Electron app只有一個使用者），renderer送什麼Authorization都會被
// 這裡的真金鑰蓋掉，不需要共用假金鑰那套識別機制。
//

// 路徑格式跟worker.js的handleGitProxy完全對齊（同一次實機測試修好的bug
// 也一併帶過來）：目標URL可以帶完整scheme，也可以省略（isomorphic-git在
// corsProxy不是以"?"結尾時，會先把https://砍掉才接上去，這裡一樣自動補回）。
"use strict";
const http = require("http");
const https = require("https");
const { URL } = require("url");

// tw_stock_db客製: 2026-09-15使用者實測回報——同一個請求在Windows桌面版
// 幾乎不會撞到「端點完全沒有回應任何內容」，Linux桌面版卻常常發生。追查
// 這支本地proxy時發現：原本這裡連"content-length"都列進被剔除的request
// header清單，導致轉發給上游（NVIDIA/OpenRouter）的POST請求完全沒有
// Content-Length——`req.pipe(upstreamReq)`在沒有明確Content-Length時，
// Node的http.request()會自動改用Transfer-Encoding: chunked送出請求本體。
// 這裡轉發的是renderer端fetch()送來、完全沒有被這支proxy修改過的原始
// body，原始請求本來就帶著正確的Content-Length（bytes數完全對得上，因為
// 中間沒有任何轉碼/改寫），沒有任何理由要捨棄這個已知值、改用chunked
// encoding重新編碼——這會讓一個「單一TCP連線裡幾個request/response
// 交錯」在linux上更容易受OS層級socket/TLS堆疊的細微時序差異影響（chunked
// encoding需要額外的分段/收尾標記，比起帶Content-Length的body解析更容易
// 出現「上游還沒完全收到請求就提前判斷request結束/逾時」這類邊界情況），
// 這極可能就是「Linux比Windows更容易撞到完全空白回應」的根因之一——
// Windows/Linux的Node底層socket實作/計時器精度本來就有已知的細微差異，
// chunked encoding對這類時序差異更敏感。修法：不要剔除content-length，
// 讓它跟原始body一起原樣轉發，upstreamReq會直接用這個正確的
// Content-Length送出請求，不再依賴chunked encoding。
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "host", "origin", "referer", "connection",
  // Node的http/https client（跟Cloudflare Workers的fetch()不一樣）預設
  // 不會自動解壓縮回應本體，只會原樣把壓縮過的bytes交給我們——我們這裡是
  // 單純pipe()轉發，沒有自己解壓縮，所以乾脆請上游不要壓縮，回應本體就是
  // 未壓縮的原始bytes，headers也不用特別處理content-encoding/
  // content-length（不動它們，讓它們原樣跟著body一起转发，天然一致）。
  // 一開始沒注意到這個跟worker.js（Cloudflare fetch()會自動解壓縮）的
  // 行為差異，直接照抄「刪掉content-encoding/content-length」會讓有壓縮
  // 的上游回應（很常見）變成亂碼——起點就先擋掉壓縮，不用事後補救。
  "accept-encoding",
]);

function stripScheme(targetUrl) {
  if (!/^https?:\/\//i.test(targetUrl)) return "https://" + targetUrl;
  return targetUrl;
}

function setCorsHeaders(res, req) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqHeaders || "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

function handleProxyRequest(req, res, targetUrlRaw, overrideHeaders) {
  let targetUrl;
  try {
    targetUrl = new URL(stripScheme(targetUrlRaw));
  } catch (err) {
    setCorsHeaders(res, req);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid target url: " + String(err.message || err) }));
    return;
  }
  const client = targetUrl.protocol === "http:" ? http : https;

  const outHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lower) || lower.startsWith("sec-") || lower === "user-agent") continue;
    outHeaders[key] = value;
  }
  outHeaders.host = targetUrl.host;
  // /nvidia、/openrouter用這個蓋掉client端送來的Authorization（renderer端
  // floating-assistant.js的apiKey欄位填什麼都無所謂，真正的金鑰只在這裡
  // 才會被加上去）。
  if (overrideHeaders) Object.assign(outHeaders, overrideHeaders);

  const upstreamReq = client.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "http:" ? 80 : 443),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: outHeaders,
    },
    (upstreamRes) => {
      // 已經在請求端拿掉accept-encoding、請上游不要壓縮，這裡body是原始
      // bytes、headers原樣轉發即可，不用再處理content-encoding/
      // content-length（兩者本來就跟這份未壓縮的body一致）。
      const respHeaders = { ...upstreamRes.headers };
      setCorsHeaders(res, req);
      res.writeHead(upstreamRes.statusCode || 502, respHeaders);
      upstreamRes.pipe(res);
    }
  );
  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      setCorsHeaders(res, req);
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: String(err.message || err) }));
  });

  if (req.method !== "GET" && req.method !== "HEAD") {
    req.pipe(upstreamReq);
  } else {
    upstreamReq.end();
  }
}

// FIXED_UPSTREAM_ROUTES：固定上游+自動注入金鑰的路由，跟通用/proxy/*不同
// （那個目標URL由client決定，這裡目標host是寫死的，client只能決定host
// 之後的path）。getSecrets是main.js傳進來的async callback，每次請求都重新
// 讀一次（不是啟動時snapshot一份），這樣使用者透過fa:secrets:set更新金鑰
// 後，下一個請求就會生效，不用重開app。
//
// 路徑巢狀是刻意對齊floating-assistant.js既有的_resolveModelRowConfig()
// URL組法（不是我自己發明的慣例）：一般row直接用`<seed base>/chat/completions`，
// modelName開頭是"openrouter/"的row則是`<seed base>/openrouter/chat/completions`
// ——也就是說OpenRouter永遠是「巢狀在NVIDIA base底下」，不是平行的獨立
// 路由，這裡的/nvidia/*handler要自己判斷restPath開頭是不是"openrouter/"
// 再決定轉發去哪個真正的上游，不能各自獨立成/nvidia、/openrouter兩條頂層
// 路由（一開始這樣寫過，實際測URL組出來對不上，改成現在這樣）。
function buildFixedUpstreamHandler(getSecrets) {
  return async (req, res, restPath) => {
    let upstreamBase = "https://integrate.api.nvidia.com/v1";
    let secretEnvKey = "NVAPI_KEY";
    let actualRestPath = restPath;
    if (restPath === "openrouter" || restPath.startsWith("openrouter/")) {
      upstreamBase = "https://openrouter.ai/api/v1";
      secretEnvKey = "OPENROUTER_API_KEY";
      actualRestPath = restPath.slice("openrouter".length).replace(/^\/+/, "");
    }
    const secrets = (await getSecrets()) || {};
    const key = secrets[secretEnvKey];
    if (!key) {
      setCorsHeaders(res, req);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: `尚未設定${secretEnvKey}。請在secrets.json填入這個值（或透過應用程式頂部列「設定API金鑰」按鈕）後重新送出請求，不需要重開app。`,
      }));
      return;
    }
    const targetUrl = upstreamBase.replace(/\/+$/, "") + "/" + actualRestPath.replace(/^\/+/, "");
    handleProxyRequest(req, res, targetUrl, { authorization: `Bearer ${key}` });
  };
}

// prefix：這個server要回應的路徑前綴清單（例如["/proxy/", "/git-proxy/"]），
// 每個前綴之後接的就是目標URL。回傳實際監聽的port（EADDRINUSE時自動往上找
// 下一個，直到找到可用的，最多嘗試20次）。getSecrets（選填）：
// async()=>{NVAPI_KEY,OPENROUTER_API_KEY}，提供時才會開放/nvidia這條固定
// 上游路由（openrouter巢狀在它底下，見buildFixedUpstreamHandler說明）。
function startLocalProxy({ preferredPort = 47891, prefixes = ["/proxy/", "/git-proxy/"], getSecrets, onLog } = {}) {
  const log = onLog || (() => {});
  const nvidiaHandler = getSecrets ? buildFixedUpstreamHandler(getSecrets) : null;

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      setCorsHeaders(res, req);
      res.writeHead(204);
      res.end();
      return;
    }
    if (nvidiaHandler && req.url.startsWith("/nvidia/")) {
      nvidiaHandler(req, res, req.url.slice("/nvidia/".length));
      return;
    }
    const matchedPrefix = prefixes.find((p) => req.url.startsWith(p));
    if (!matchedPrefix) {
      setCorsHeaders(res, req);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown route, expected one of: " + prefixes.concat(["/nvidia/", "/nvidia/openrouter/"]).join(", ") }));
      return;
    }
    const targetUrlRaw = req.url.slice(matchedPrefix.length);
    handleProxyRequest(req, res, decodeURIComponentSafe(targetUrlRaw));
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port) => {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && attempt < 20) {
          attempt++;
          tryListen(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        // tw_stock_db客製: 用server.address().port而不是閉包裡的port參數——
        // 兩者在指定明確port時剛好相等，但如果呼叫端傳preferredPort:0
        // （交給OS自動選一個可用port），閉包裡的port只會是原封不動的0，
        // 回傳一個假的port號碼給呼叫端。目前唯一的呼叫端固定傳47891，不會
        // 踩到這個差異，但用真正的listen結果回報才是正確、不會因為將來
        // 改用0而悄悄壞掉。
        const actualPort = server.address().port;
        log(`[local-proxy] 監聽 http://127.0.0.1:${actualPort}`);
        resolve({ server, port: actualPort });
      });
    };
    tryListen(preferredPort);
  });
}

// 目標URL本身可能帶query string（例如info/refs?service=git-upload-pack），
// 直接原樣接在路徑後面即可（不需要decode，Node的URL建構子會自己處理），
// 這裡保留一個no-op包裝只是讓「這段刻意不decode」的決定有名字、方便閱讀。
function decodeURIComponentSafe(s) {
  return s;
}

module.exports = { startLocalProxy };
