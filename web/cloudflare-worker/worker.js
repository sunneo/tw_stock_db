/**
 * 共用 Cloudflare Worker：
 *   1. 台股追蹤網頁用的 TWSE 即時資料 CORS 代理（本檔案新增的部分）
 *   2. 既有的 NVIDIA chat completions 代理（保留原邏輯，只把寫死在原始碼裡
 *      的 API key 改成從 Cloudflare 環境變數讀，見下方「NVAPI_KEY」說明）
 *
 * ── 為什麼台股部分需要代理 ──
 * 網頁想在收盤前、本地資料庫還沒有當天資料時，直接向證交所抓即時股價，
 * 畫出當天還在成形中的K棒。但證交所這兩個公開資料源都沒有回傳 CORS
 * header，瀏覽器會直接擋下跨網域 fetch()（實測結果見 README.md）：
 *   - MIS 即時行情：https://mis.twse.com.tw/stock/api/getStockInfo.jsp
 *   - OpenAPI 休市日曆：https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule
 * 這裡只是原樣轉發 + 加上 CORS header，不做資料轉換、不需要金鑰。
 *
 * 路由：
 *   GET /realtime?ex_ch=tse_2330.tw   單一個股即時行情（上市 tse_、上櫃 otc_ 開頭）
 *   GET /holiday                      休市日曆（Cloudflare 邊緣快取24小時）
 *   POST /api 或 /chat/completions    既有的 NVIDIA chat completions 代理（不變）
 *
 * ── 關於 NVAPI_KEY ──
 * 原本的程式碼把 API key 直接寫死在原始碼字串裡。這個檔案會被放進
 * tw_stock_db 這個公開 repo，寫死金鑰等於直接公開金鑰，所以這裡改成從
 * Cloudflare 的環境變數/密鑰讀取：
 *   Cloudflare Dashboard → Workers & Pages → 選這個 Worker → Settings →
 *   Variables and Secrets → 新增一個 Secret，名稱 NVAPI_KEY，值貼上你的
 *   nvapi-xxxx 金鑰 → Save and Deploy。
 * 如果前端呼叫時有自己帶 Authorization header，還是會優先用前端帶的那組，
 * 邏輯跟原本完全一樣，只是「找不到前端帶的 key 時要 fallback 用誰」從
 * 寫死字串改成讀 env.NVAPI_KEY。
 * 你稍早在對話裡貼出的那組 nvapi-... 金鑰建議直接去 NVIDIA 那邊註銷重發一組，
 * 因為它已經以明文出現在這個對話紀錄裡。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MIS_BASE = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const HOLIDAY_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule";

// ex_ch 只允許「交易所前綴_股票代號.tw」這種形式的字元，多檔用 | 分隔。
// 白名單而非黑名單，避免這個路由被當成任意網址的通用代理。
const EX_CH_PATTERN = /^[a-z]+_[A-Za-z0-9]+\.tw(\|[a-z]+_[A-Za-z0-9]+\.tw)*$/;

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders, ...extraHeaders },
  });
}

async function handleRealtime(url) {
  const exCh = url.searchParams.get("ex_ch") || "";
  if (!EX_CH_PATTERN.test(exCh)) {
    return jsonResponse(JSON.stringify({ error: "invalid ex_ch" }), 400);
  }
  const upstream = new URL(MIS_BASE);
  upstream.searchParams.set("ex_ch", exCh);
  upstream.searchParams.set("json", "1");
  upstream.searchParams.set("_", String(Date.now()));

  const resp = await fetch(upstream.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tw-stock-tracker-proxy/1.0)" },
  });
  const body = await resp.text();
  // 即時行情不快取（每次都要最新報價），只加 CORS header 原樣轉發。
  return jsonResponse(body, resp.status, { "Cache-Control": "no-store" });
}

async function handleHoliday(request, ctx) {
  const cacheKey = new Request(HOLIDAY_URL, request);
  const cache = caches.default;

  let resp = await cache.match(cacheKey);
  if (!resp) {
    const upstream = await fetch(HOLIDAY_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; tw-stock-tracker-proxy/1.0)" },
    });
    const body = await upstream.text();
    resp = new Response(body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  }

  const body = await resp.text();
  return jsonResponse(body, resp.status, { "Cache-Control": "public, max-age=86400" });
}

async function handleNvidiaProxy(request, env) {
  const clientAuth = request.headers.get("Authorization");
  const apiKey = clientAuth ? clientAuth.replace("Bearer ", "") : env.NVAPI_KEY;
  if (!apiKey) {
    return jsonResponse(JSON.stringify({ error: "missing API key (set NVAPI_KEY secret or pass Authorization header)" }), 401);
  }

  const targetApiUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
  const requestBody = request.method !== "GET" && request.method !== "HEAD" ? await request.text() : undefined;

  const modifiedRequest = new Request(targetApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: requestBody,
  });

  try {
    const response = await fetch(modifiedRequest);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...corsHeaders,
        "Content-Type": response.headers.get("Content-Type") || "application/json;charset=UTF-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return jsonResponse(JSON.stringify({ error: error.message }), 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    // 強制優先處理所有瀏覽器的 OPTIONS 預檢請求
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const sanitizedPath = url.pathname.replace(/\/+/g, "/");

    try {
      // ── 台股即時行情 / 休市日曆（tw_stock_db 網頁用）──
      if (sanitizedPath === "/realtime") return await handleRealtime(url);
      if (sanitizedPath === "/holiday") return await handleHoliday(request, ctx);

      // ── 既有的 NVIDIA chat completions 代理 ──
      if (sanitizedPath === "/api" || sanitizedPath === "/chat/completions") {
        return await handleNvidiaProxy(request, env);
      }
    } catch (error) {
      return jsonResponse(JSON.stringify({ error: "upstream fetch failed", message: String(error) }), 502);
    }

    // 非以上路由的回應
    return new Response("Worker 運作正常。", {
      headers: { ...corsHeaders, "Content-Type": "text/plain;charset=UTF-8" },
    });
  },
};
