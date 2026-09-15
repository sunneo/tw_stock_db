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
// 這個代理本身不做任何「共用假金鑰→真金鑰」的替換（那是tw_stock_db給多人
// 共用一把NVIDIA/OpenRouter金鑰用的設計，見handleNvidiaProxy的
// tw_stock_db_api:{sessionId}慣例）——桌面版是單人使用，使用者在Advance
// Settings直接填自己的真實API金鑰，這個代理單純負責「轉發+補CORS header」，
// 不經手、不記錄任何金鑰內容。
//
// 路徑格式跟worker.js的handleGitProxy完全對齊（同一次實機測試修好的bug
// 也一併帶過來）：目標URL可以帶完整scheme，也可以省略（isomorphic-git在
// corsProxy不是以"?"結尾時，會先把https://砍掉才接上去，這裡一樣自動補回）。
"use strict";
const http = require("http");
const https = require("https");
const { URL } = require("url");

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "host", "origin", "referer", "connection", "content-length",
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

function handleProxyRequest(req, res, targetUrlRaw) {
  let targetUrl;
  try {
    targetUrl = new URL(stripScheme(targetUrlRaw));
  } catch (err) {
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

// prefix：這個server要回應的路徑前綴清單（例如["/proxy/", "/git-proxy/"]），
// 每個前綴之後接的就是目標URL。回傳實際監聽的port（EADDRINUSE時自動往上找
// 下一個，直到找到可用的，最多嘗試20次）。
function startLocalProxy({ preferredPort = 47891, prefixes = ["/proxy/", "/git-proxy/"], onLog } = {}) {
  const log = onLog || (() => {});
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      setCorsHeaders(res, req);
      res.writeHead(204);
      res.end();
      return;
    }
    const matchedPrefix = prefixes.find((p) => req.url.startsWith(p));
    if (!matchedPrefix) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown route, expected one of: " + prefixes.join(", ") }));
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
        log(`[local-proxy] 監聽 http://127.0.0.1:${port}`);
        resolve({ server, port });
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
