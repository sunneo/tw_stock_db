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
 *   GET /yahoo-intraday?symbol=2330.TW  今日 1分K（開盤到現在），見下方說明
 *   GET /webfetch?url=...              AI助理查詢官方公開資料網頁（白名單網域）
 *   POST /browser-search               AI助理（floating-assistant.js的browser_search
 *                                      工具）查詢Wiki/StackOverflow/GitHub/一般網頁/
 *                                      SourceForge/CodeProject/DeepWiki，見下方說明
 *   POST /api 或 /chat/completions    既有的 NVIDIA chat completions 代理（不變）
 *   POST /sheet-sync                  雲端同步設定（轉發到使用者自架的 Apps
 *                                      Script，見下方「關於 /sheet-sync」）
 *   POST /edge-tts                    轉接Microsoft Edge神經網路語音（免費、
 *                                      不用金鑰），AI助理text_to_speech工具的
 *                                      中文語音走這條路，見下方「關於 /edge-tts」
 *
 * ── 為什麼多一個 /yahoo-intraday ──
 * 證交所自己完全沒有「個股當日已發生的分時/逐筆歷史」這種公開 API（只有
 * 這一瞬間的快照，或收盤後才發布的前一日彙總，見 README.md 的測試紀錄），
 * 所以走勢圖如果只靠 /realtime 輪詢，使用者收盤前才打開網頁的話，開盤到
 * 打開網頁那段時間永遠是空的、補不回來；縮小(zoom out)想看前幾個交易日
 * 也一樣沒資料。Yahoo 股市的公開圖表 API
 * （query1.finance.yahoo.com/v8/finance/chart/...）剛好有這份資料，支援
 * range/interval 參數（例如 range=5d&interval=1m 可以拿到近5個交易日的
 * 1分K），拿來補這段空白的輪廓；跟 /realtime 一樣沒有 CORS header，一樣
 * 需要代理。這不是官方資料，之後的即時更新還是靠 /realtime 輪詢，不會
 * 每 20 秒重打 Yahoo（避免對這個非正式資料源造成不必要負擔，見前端
 * IntradayFeed.BACKFILL_REFRESH_MS 的節流）。
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
 *
 * ── 關於 tw_stock_db_api:{sessionId} 假金鑰 ──
 * 網頁內嵌的AI助理分頁（見 web/index.html 的 renderAiTab）預設沒有要求
 * 每個訪客自己申請NVIDIA金鑰，前端會在Authorization帶一個
 * `tw_stock_db_api:{隨機sessionId}` 格式的假值——這裡（handleNvidiaProxy）
 * 辨識出這個格式後改用 env.NVAPI_KEY（不會外洩給前端），sessionId拿來做
 * 輕量per-session流量控管（見 checkAndIncrementRateLimit，需要另外綁定
 * RATE_LIMIT_KV，設定步驟見 README.md，沒綁定就不擋流量、優雅降級）。
 * 使用者自己在AI助理設定裡填了真金鑰的話，前端就會帶真金鑰，不會是這個
 * 假格式，這裡完全不受影響。
 *
 * ── 關於 /webfetch（AI助理查詢外部網頁用）──
 * AI助理需要查詢官方公開資料（例如證交所公告、公開資訊觀測站財報）時，
 * 瀏覽器端一樣會被目標網站沒有CORS header擋下來，需要靠這個worker代理。
 * 刻意用白名單網域（WEBFETCH_HOST_WHITELIST）而不是開放任意URL：開放任意
 * URL等於把這個worker變成一個公開的免費fetch代理，共用金鑰模式下任何知道
 * 這個worker網址的人都能濫用它繞過CORS/隱藏真實來源IP去打任何網站，風險
 * 遠高於「使用者自己填API金鑰、只有自己在用」的情境。目前只收錄官方/政府
 * 公開資料源（證交所/櫃買中心/公開資訊觀測站/政府資料開放平台），沒有納入
 * 任何商業新聞網站——爬取新聞內容牽涉版權/網站使用條款，這裡不自作主張
 * 加入，之後如果要開放特定新聞/財經網站來源，請明確列出網域名稱再個別
 * 評估、加進 WEBFETCH_HOST_WHITELIST。
 *
 * ── 關於 /browser-search（floating-assistant.js的browser_search工具用）──
 * 2026-09-09新增：floating-assistant.js內建的browser_search子agent（見
 * SUBAGENT_DOMAIN_REGISTRY.browser_search）需要查詢Wikipedia/StackOverflow/
 * GitHub/一般網頁(google)/Google新聞(news)/SourceForge/CodeProject/
 * DeepWiki，這裡跟/webfetch同樣的理由（目標網站沒開CORS）需要代理，但跟
 * /webfetch不同的是**不接受任意URL**——只接受{query, sources}，每個來源
 * 打哪個固定上游API/網址完全由這個worker自己決定（不是呼叫端指定），所以
 * 不需要host whitelist這一層防護，風險模型比/webfetch更收斂。
 * 各來源實作方式（2026-09-09實測過各來源真實回應後才決定）：
 *   - wiki/stackoverflow/github：呼叫各自官方搜尋API，穩定、有結構化snippet。
 *   - google：直接fetch Google搜尋結果頁拿不到任何可解析連結（實測結果，
 *     近年高度JS化），改用DuckDuckGo的HTML介面(html.duckduckgo.com/html/)
 *     代打，不加site:限制——適合一般網頁查詢，**不適合**「今日焦點/最新
 *     新聞」這類需要新聞垂直領域時效性的查詢（DuckDuckGo一般網頁搜尋沒有
 *     這個概念，實測回應品質很差），這類需求請改用news來源。
 *   - news：Google News官方RSS Feed（news.google.com/rss/search），不需要
 *     金鑰、官方文件本身就允許「個人非商業feed reader」用途，回傳真正依
 *     時間排序、含正確發布時間/來源媒體名稱的新聞——這是2026-09-09使用者
 *     實測回報google來源對「今日焦點新聞」查詢效果很差後，另外新增的專門
 *     新聞來源，不是拿google來源硬套。固定用zh-TW/TW locale（跟searchWiki
 *     固定用zh.wikipedia.org同一個「中文使用者優先」的既有慣例）。
 *   - sourceforge/codeproject：兩站自己的搜尋頁會擋掉非瀏覽器請求(403)或
 *     用JS轉址（實測結果），改用DuckDuckGo HTML介面+site:限定範圍代打。
 *   - deepwiki：純前端SPA，靜態HTML拿不到搜尋結果（實測結果），同樣改用
 *     DuckDuckGo HTML介面+site:deepwiki.com；另外對「像GitHub repo命名」
 *     的查詢附加一個推測連結候選（deepwiki.com網址規則是/owner/repo）。
 * 用Cloudflare Workers runtime原生的HTMLRewriter解析DuckDuckGo回應的HTML
 * （比手刻regex parser穩健，這個runtime本來就有這個API，不需要額外套件）；
 * news來源的RSS本身是結構固定、可信任的XML，用一般正則表達式解析即可。
 *
 * ── 關於 /sheet-sync（雲端同步設定）──
 * 2026-08-23使用者要求：網頁的「設定」齒輪要能把整包Settings JSON同步到
 * 使用者自己架的Google Apps Script + Google Sheet後端（get_config/
 * set_config，token<30字元當Sheet分頁名稱）。這個worker路由只是單純轉發，
 * 見上方 handleSheetSync 開頭的說明——存在的唯一理由是不要讓Apps Script的
 * 網址出現在公開的 index.html 原始碼裡。設定步驟：
 *   Cloudflare Dashboard → Workers & Pages → 選這個Worker → Settings →
 *   Variables and Secrets → 新增一個Secret，名稱 SHEET_SYNC_APPS_SCRIPT_URL，
 *   值貼上你部署的Apps Script網址（https://script.google.com/macros/s/.../exec）
 *   → Save and Deploy。沒有設定這個secret時，/sheet-sync會回傳
 *   {status:"error"}說明尚未設定，不會噴500例外。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MIS_BASE = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const HOLIDAY_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule";
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

// ex_ch 只允許「交易所前綴_股票代號.tw」這種形式的字元，多檔用 | 分隔。
// 白名單而非黑名單，避免這個路由被當成任意網址的通用代理。
const EX_CH_PATTERN = /^[a-z]+_[A-Za-z0-9]+\.tw(\|[a-z]+_[A-Za-z0-9]+\.tw)*$/;

// Yahoo 股票代號只允許「數字代號.TW」（上市）、「數字代號.TWO」（上櫃），
// 或「^開頭的美股指數代號」（例如 ^DJI/^GSPC/^IXIC/^SOX，見 US_INDEX_LIST）。
const YAHOO_SYMBOL_PATTERN = /^(\^[A-Za-z0-9]{1,10}|[A-Za-z0-9]+\.(TW|TWO))$/;

// 走勢圖縮小(zoom out)超出當天範圍時，用比較長的 range 補前幾個交易日的分K
// （見 README「為什麼多一個 Yahoo 來源」）；白名單住 Yahoo 實際支援的組合，
// 避免這個路由被當成任意參數的通用代理。
const YAHOO_RANGE_PATTERN = /^(1d|5d|1mo)$/;
const YAHOO_INTERVAL_PATTERN = /^(1m|2m|5m|15m|30m)$/;

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

async function handleYahooIntraday(url) {
  const symbol = url.searchParams.get("symbol") || "";
  if (!YAHOO_SYMBOL_PATTERN.test(symbol)) {
    return jsonResponse(JSON.stringify({ error: "invalid symbol" }), 400);
  }
  const range = url.searchParams.get("range") || "1d";
  const interval = url.searchParams.get("interval") || "1m";
  if (!YAHOO_RANGE_PATTERN.test(range) || !YAHOO_INTERVAL_PATTERN.test(interval)) {
    return jsonResponse(JSON.stringify({ error: "invalid range/interval" }), 400);
  }
  const upstream = new URL(`${YAHOO_CHART_BASE}/${symbol}`);
  upstream.searchParams.set("range", range);
  upstream.searchParams.set("interval", interval);

  const resp = await fetch(upstream.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tw-stock-tracker-proxy/1.0)" },
  });
  const body = await resp.text();
  // 只當進走勢圖那一刻的一次性 backfill，不快取（每次抓都要當下最新的分K）。
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

// 只收錄官方/政府公開資料源，見上方檔頭註解「關於 /webfetch」的說明。
// 之後要開放新聞/財經網站，把網域加進這個Set即可，其餘邏輯不用改。
const WEBFETCH_HOST_WHITELIST = new Set([
  "www.twse.com.tw",       // 證交所
  "www.tpex.org.tw",       // 櫃買中心
  "mops.twse.com.tw",      // 公開資訊觀測站
  "openapi.twse.com.tw",   // 證交所OpenAPI
  "data.gov.tw",           // 政府資料開放平台
]);

async function handleWebFetch(url) {
  const target = url.searchParams.get("url") || "";
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonResponse(JSON.stringify({ error: "invalid url" }), 400);
  }
  if (targetUrl.protocol !== "https:") {
    return jsonResponse(JSON.stringify({ error: "only https urls are allowed" }), 400);
  }
  if (!WEBFETCH_HOST_WHITELIST.has(targetUrl.hostname)) {
    return jsonResponse(JSON.stringify({
      error: `host not in whitelist: ${targetUrl.hostname}（目前只開放官方公開資料網域，如需開放其他來源請聯絡管理者評估後加入worker的WEBFETCH_HOST_WHITELIST）`,
    }), 403);
  }

  const resp = await fetch(targetUrl.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tw-stock-tracker-proxy/1.0)" },
  });
  const contentType = resp.headers.get("Content-Type") || "text/plain";
  const body = await resp.text();
  // tw_stock_db客製: 2026-09-09使用者明確要求拿掉這裡的截斷——不論抓回來
  // 的內容多長都原樣回傳，不再用WEBFETCH_MAX_BYTES砍斷丟棄後面的部分。
  // 「內容太長會塞爆對話上下文」這個原本截斷想解決的問題，改由呼叫端
  // （web/index.html的fetch_web_page工具）自己接手：抓到的內容先整份存進
  // floating-assistant.js的persistentStorage（fileCache），只把file_id
  // 回傳給AI，AI要看內容時再委派file_analysis子agent用
  // parse_uploaded_file/summarize_large_text處理，不是在這個worker層級
  // 就先砍斷資料本身。
  return jsonResponse(JSON.stringify({
    url: targetUrl.toString(), status: resp.status, contentType, body,
  }), 200, { "Cache-Control": "no-store" });
}

// ============================================================
// /browser-search（floating-assistant.js的browser_search工具用）
// 見上方檔頭「關於 /browser-search」的整體說明。
// ============================================================

const BROWSER_SEARCH_RESULT_LIMIT = 5;
const BROWSER_SEARCH_FETCH_TIMEOUT_MS = 12000;
const BROWSER_SEARCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function stripHtml(text) {
  return String(text || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BROWSER_SEARCH_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function searchWiki(query) {
  const url = `https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${BROWSER_SEARCH_RESULT_LIMIT}&srsearch=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url, { headers: { "User-Agent": BROWSER_SEARCH_UA } });
  if (!resp.ok) throw new Error(`Wikipedia API HTTP ${resp.status}`);
  const data = await resp.json();
  const hits = (data && data.query && data.query.search) || [];
  return hits.map(h => ({
    title: stripHtml(h.title),
    url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(String(h.title || "").replace(/ /g, "_"))}`,
    snippet: stripHtml(h.snippet),
  }));
}

async function searchStackOverflow(query) {
  const url = `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&pagesize=${BROWSER_SEARCH_RESULT_LIMIT}&site=stackoverflow&q=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url, { headers: { "User-Agent": BROWSER_SEARCH_UA } });
  if (!resp.ok) throw new Error(`StackExchange API HTTP ${resp.status}`);
  const data = await resp.json();
  const items = (data && data.items) || [];
  return items.map(item => ({
    title: stripHtml(item.title) || (item.item_type === "answer" ? "StackOverflow回答" : "StackOverflow問題"),
    url: item.link,
    snippet: stripHtml(item.excerpt || item.body || ""),
  }));
}

async function searchGitHub(query) {
  const url = `https://api.github.com/search/repositories?per_page=${BROWSER_SEARCH_RESULT_LIMIT}&q=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url, {
    headers: { "User-Agent": BROWSER_SEARCH_UA, "Accept": "application/vnd.github+json" },
  });
  if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
  const data = await resp.json();
  const items = (data && data.items) || [];
  return items.map(item => ({
    title: item.full_name,
    url: item.html_url,
    snippet: stripHtml(item.description || "") + (item.stargazers_count ? ` ⭐${item.stargazers_count}` : ""),
  }));
}

// DuckDuckGo HTML介面代打（google無site:限制；sourceforge/codeproject/
// deepwiki各自加site:限制），用HTMLRewriter解析——Cloudflare Workers
// runtime原生提供的streaming HTML parser，比手刻regex parser穩健。
function decodeDdgHref(rawHref) {
  if (!rawHref) return "";
  const href = rawHref.startsWith("//") ? `https:${rawHref}` : rawHref;
  const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch) {
    try { return decodeURIComponent(uddgMatch[1]); } catch { return href; }
  }
  return href;
}

class DdgResultCollector {
  constructor() {
    this.titles = []; // {text, href}
    this.snippets = []; // text
    this._inTitleLink = false;
    this._inSnippet = false;
    this._titleBuf = "";
    this._snippetBuf = "";
  }
  element(el) {
    const cls = el.getAttribute("class") || "";
    if (el.tagName === "a" && /\bresult__a\b/.test(cls)) {
      this._inTitleLink = true;
      this._titleBuf = "";
      this._pendingHref = el.getAttribute("href") || "";
      el.onEndTag(() => {
        this.titles.push({ text: this._titleBuf.trim(), href: this._pendingHref });
        this._inTitleLink = false;
      });
    } else if (/\bresult__snippet\b/.test(cls)) {
      this._inSnippet = true;
      this._snippetBuf = "";
      el.onEndTag(() => {
        this.snippets.push(this._snippetBuf.trim());
        this._inSnippet = false;
      });
    }
  }
  text(chunk) {
    if (this._inTitleLink) this._titleBuf += chunk.text;
    if (this._inSnippet) this._snippetBuf += chunk.text;
  }
}

async function duckDuckGoSearch(rawQuery, siteFilter) {
  const query = siteFilter ? `site:${siteFilter} ${rawQuery}` : rawQuery;
  const body = new URLSearchParams({ q: query }).toString();
  const resp = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": BROWSER_SEARCH_UA, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) throw new Error(`DuckDuckGo HTML介面 HTTP ${resp.status}`);
  const collector = new DdgResultCollector();
  const rewriter = new HTMLRewriter()
    .on("a.result__a", collector)
    .on("a.result__snippet, .result__snippet", collector);
  // HTMLRewriter需要真的消耗過(consume)transformed回應的body才會觸發解析。
  await rewriter.transform(resp).text();
  const items = [];
  for (let i = 0; i < collector.titles.length && items.length < BROWSER_SEARCH_RESULT_LIMIT; i++) {
    const t = collector.titles[i];
    if (!t.text) continue;
    items.push({ title: t.text, url: decodeDdgHref(t.href), snippet: collector.snippets[i] || "" });
  }
  return items;
}

const searchGoogle = query => duckDuckGoSearch(query, null);
const searchSourceForge = query => duckDuckGoSearch(query, "sourceforge.net");
const searchCodeProject = query => duckDuckGoSearch(query, "codeproject.com");

async function searchDeepWiki(query) {
  const items = await duckDuckGoSearch(query, "deepwiki.com");
  // deepwiki.com的網址慣例是 /{owner}/{repo}，query長得像GitHub repo命名
  // （只有一個"/"、沒有空白）時，附加一個推測連結候選（明確標註未驗證）。
  if (/^[\w.-]+\/[\w.-]+$/.test(query.trim())) {
    items.unshift({
      title: `DeepWiki: ${query.trim()}（推測連結，未驗證頁面是否存在）`,
      url: `https://deepwiki.com/${query.trim()}`,
      snippet: "依GitHub repo命名慣例推測出的DeepWiki連結，不保證頁面真的存在，使用前建議先確認。",
    });
  }
  return items.slice(0, BROWSER_SEARCH_RESULT_LIMIT);
}

// tw_stock_db客製: 2026-09-09使用者實測發現——「google」來源（代打
// DuckDuckGo一般網頁搜尋）對「今日焦點新聞」這類時效性強、需要「新聞」
// 這個垂直領域而非一般網頁的查詢，回應品質很差（DuckDuckGo沒有專門的新聞
// 索引，一般網頁搜尋不會理解「今天」「焦點」這類時間/熱度語意）。改用
// Google News自己公開的RSS Feed（news.google.com/rss/search?q=...），這是
// Google官方提供、不需要金鑰、專門設計給「個人非商業用途的feed reader」
// 使用的正式介面（RSS本身的版權聲明也明講這個用途），回應是真正依時間排序
// 的新聞（含正確的發布時間/來源媒體名稱），不是像sourceforge/codeproject/
// deepwiki那樣「不得已才代打」的權宜之計。跟其他來源一樣用XML正規表達式
// 解析（RSS結構固定、可信任，不像任意HTML頁面需要HTMLRewriter那種容錯
// 能力）。hl/gl/ceid固定用zh-TW/TW（跟searchWiki固定用zh.wikipedia.org
// 同一個「中文使用者優先」的既有慣例），不是每個host都需要不同語系時再
// 討論要不要開放參數。
function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

async function searchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const resp = await fetchWithTimeout(url, { headers: { "User-Agent": BROWSER_SEARCH_UA } });
  if (!resp.ok) throw new Error(`Google News RSS HTTP ${resp.status}`);
  const xml = await resp.text();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < BROWSER_SEARCH_RESULT_LIMIT) {
    const block = m[1];
    const title = decodeXmlEntities((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]).trim();
    const link = ((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "").trim();
    const pubDate = ((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "").trim();
    const source = decodeXmlEntities((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]).trim();
    if (!title || !link) continue;
    items.push({ title, url: link, snippet: [source, pubDate].filter(Boolean).join(" · ") });
  }
  return items;
}

const BROWSER_SEARCH_SOURCE_HANDLERS = {
  wiki: searchWiki,
  stackoverflow: searchStackOverflow,
  github: searchGitHub,
  google: searchGoogle,
  news: searchGoogleNews,
  sourceforge: searchSourceForge,
  codeproject: searchCodeProject,
  deepwiki: searchDeepWiki,
};

async function handleBrowserSearch(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(JSON.stringify({ error: "request body不是合法JSON" }), 400);
  }
  const query = String((body && body.query) || "").trim();
  if (!query) return jsonResponse(JSON.stringify({ error: "缺少query參數" }), 400);
  const sources = Array.isArray(body && body.sources)
    ? body.sources.map(String).filter(s => Object.prototype.hasOwnProperty.call(BROWSER_SEARCH_SOURCE_HANDLERS, s))
    : [];
  if (!sources.length) return jsonResponse(JSON.stringify({ error: "缺少合法的sources參數" }), 400);

  const results = {};
  await Promise.all(sources.map(async source => {
    try {
      const items = await BROWSER_SEARCH_SOURCE_HANDLERS[source](query);
      results[source] = { items };
    } catch (err) {
      results[source] = { error: String((err && err.message) || err) };
    }
  }));
  return jsonResponse(JSON.stringify({ results }), 200, { "Cache-Control": "no-store" });
}

// tw_stock_db 網頁內嵌AI分頁用的「假金鑰」格式：使用者沒有自己填NVIDIA API
// key時，前端會自動填一個 tw_stock_db_api:{隨機sessionid} 進API Key欄位
// （見 web/index.html renderAiTab 的說明），滿足前端函式庫好幾處「沒填key
// 就直接報錯」的檢查，同時讓這裡能辨識出「這是要用內建共用金鑰」的請求，
// 不會真的把這個假字串當Bearer token轉發給NVIDIA。sessionid本身不驗證
// 格式（前端用crypto.randomUUID()產生），只用來做下面的輕量流量控管。
const TW_STOCK_DB_KEY_PREFIX = "tw_stock_db_api:";
// 共用金鑰每個session每小時的呼叫上限（只有設定了 RATE_LIMIT_KV binding
// 才會生效，見 checkAndIncrementRateLimit 的優雅降級說明）。
const SHARED_KEY_HOURLY_LIMIT = 30;

/**
 * 輕量、best-effort的per-session流量控管，用Workers KV存計數器（key格式
 * `ratelimit:{sessionId}:{YYYY-MM-DD-HH}`，每小時一個新key，用
 * expirationTtl自動過期，不用另外清理）。KV是最終一致性儲存，不是嚴格
 * atomic，短時間內大量並發請求可能會有極少數超過上限沒被擋到，但用途只是
 * 避免公開repo裡的共用金鑰被單一使用者濫用打爆額度，不需要精確計數。
 * env.RATE_LIMIT_KV 沒綁定時（使用者還沒去Dashboard設定）直接放行，不阻擋
 * 請求——見 README.md 的設定步驟。
 */
async function checkAndIncrementRateLimit(kv, sessionId) {
  const now = new Date();
  const bucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}`;
  const key = `ratelimit:${sessionId}:${bucket}`;
  const current = parseInt((await kv.get(key)) || "0", 10);
  if (current >= SHARED_KEY_HOURLY_LIMIT) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

async function handleNvidiaProxy(request, env) {
  const clientAuth = request.headers.get("Authorization");
  // 原本用 clientAuth.replace("Bearer ", "") 精確比對「Bearer」+一個空白，
  // 但當前端的API Key欄位是空字串時，實際送出的標頭是 "Authorization: Bearer "
  // （尾端只有一個空白），而Cloudflare/底層HTTP實作會把標頭「值」尾端的
  // optional whitespace正規化掉，headers.get()拿到的其實是沒有尾端空白的
  // "Bearer"（沒有空白可以比對），導致.replace("Bearer ", "")完全沒有比對到、
  // 原樣傳回"Bearer"這個字串——這個非空字串接著被誤判成「使用者自己帶了一組
  // 叫"Bearer"的金鑰」，蓋掉了原本該fallback到NVAPI_KEY的邏輯，實測對NVIDIA
  // 送出這個假金鑰只會拿到401，不管NVAPI_KEY/NV_API_KEY_DEFAULT設定得再正確
  // 都一樣會失敗。改用正則（允許任意數量空白、甚至沒有空白）+trim()，不管
  // 中間層怎麼正規化空白都能正確解析成空字串。
  const rawKey = clientAuth ? clientAuth.replace(/^Bearer\s*/i, "").trim() : "";

  let apiKey;
  if (rawKey.startsWith(TW_STOCK_DB_KEY_PREFIX)) {
    // 使用者沒有自己的金鑰，用內建共用金鑰代打——先做流量控管（如果有綁定
    // KV的話），避免被濫用；金鑰本身不外洩給前端。
    const sessionId = rawKey.slice(TW_STOCK_DB_KEY_PREFIX.length) || "unknown";
    if (env.RATE_LIMIT_KV) {
      const ok = await checkAndIncrementRateLimit(env.RATE_LIMIT_KV, sessionId);
      if (!ok) {
        return jsonResponse(JSON.stringify({ error: `此session這小時的共用金鑰額度已用完（上限${SHARED_KEY_HOURLY_LIMIT}次/小時），請稍後再試，或到AI助理設定裡填自己的API金鑰不受此限制。` }), 429);
      }
    }
    apiKey = env.NVAPI_KEY;
  } else {
    // 沒帶假金鑰格式：照舊行為，優先用前端自己帶的真金鑰；空白（使用者在
    // AI助理設定面板把API金鑰欄位清空、又沒有走tw_stock_db_api:假金鑰格式
    // 的情況）則依序 fallback：先試 NV_API_KEY_DEFAULT（給想跟共用金鑰
    // 分開管理的情境，例如想單獨限制/輪替這個「空白視同預設」路徑用的
    // 金鑰），沒設定的話再退回跟假金鑰路徑共用的 NVAPI_KEY——不需要另外
    // 設定新的 secret 也能正常運作，NV_API_KEY_DEFAULT是選用的。
    apiKey = rawKey || env.NV_API_KEY_DEFAULT || env.NVAPI_KEY;
  }
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

// tw_stock_db 網頁「雲端同步設定」功能用：把使用者的 Settings JSON blob
// 存到使用者自己架的 Google Apps Script + Google Sheet 後端（get_config/
// set_config，token=Sheet分頁名稱，Apps Script自己會用一組固定金鑰對資料
// 做XOR「加密」後存檔、讀出時解密，見使用者提供的 Apps Script 原始碼）。
// Worker存在的唯一理由是**不要讓Apps Script的網址出現在公開的index.html
// 原始碼裡**：這個網址本身雖然不是金鑰，但知道網址就能直接對任意token
// 做get_config/set_config（Apps Script的Web App部署對任何人開放，只靠
// <30字元的token當事實上的存取憑證），寫進公開repo的前端原始碼等於讓
// 任何人都能繞過token去讀寫別人的雲端設定。網址存成這裡的
// env.SHEET_SYNC_APPS_SCRIPT_URL secret，前端只知道這個worker自己的
// /sheet-sync路由。
//
// ── 2026-08-24 修正：中文字元經Apps Script的XOR「加密」round-trip後損毀 ──
// 實測發現：push上去再pull下來的settings JSON裡，中文字元（例如memos裡的
// aiNote.summary/reasons）大量被換成控制字元（等），但英數字/日期
// 完全正常——Apps Script的encrypt()/decrypt()對UTF-8多byte字元的
// byte-level round-trip不保證正確（GAS的Utilities.newBlob/getDataAsString
// 在這個XOR流程裡對多byte序列的處理有問題，這裡不深究GAS內部細節）。
// 修法：Worker端在丟給Apps Script之前，先把settings JSON整個包一層
// base64（讓Apps Script那邊實際處理的字串永遠是純ASCII，完全繞開多byte
// UTF-8問題），讀回來再解開這層base64——不用改動/重新部署使用者已經架好
// 的Apps Script。舊資料（這個修正上線前就存在Sheet上的）已經在寫入當下
// 就損毀，沒辦法救回，需要用修正後的版本重新push一次覆蓋。
function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

const SHEET_SYNC_TOKEN_PATTERN = /^[A-Za-z0-9]{1,29}$/;

async function handleSheetSync(request, env) {
  if (!env.SHEET_SYNC_APPS_SCRIPT_URL) {
    return jsonResponse(JSON.stringify({ status: "error", message: "雲端同步尚未設定（worker缺少SHEET_SYNC_APPS_SCRIPT_URL secret，見README.md）" }), 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(JSON.stringify({ status: "error", message: "invalid JSON body" }), 400);
  }
  const token = body && body.token;
  if (typeof token !== "string" || !SHEET_SYNC_TOKEN_PATTERN.test(token)) {
    return jsonResponse(JSON.stringify({ status: "error", message: "invalid or missing token" }), 400);
  }
  if (body.action !== "get_config" && body.action !== "set_config") {
    return jsonResponse(JSON.stringify({ status: "error", message: "invalid action" }), 400);
  }

  const payload = { action: body.action, token };
  if (body.action === "set_config") {
    payload.metadata = { schema: "tw_stock_cfg_v1", updated_at: new Date().toISOString() };
    // base64包一層，見上方「2026-08-24 修正」說明，避免中文字元被Apps
    // Script的XOR加密流程損毀。
    payload.data = [utf8ToBase64(JSON.stringify(body.settings || {}))];
  }

  const upstream = await fetch(env.SHEET_SYNC_APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const resultText = await upstream.text();

  if (body.action === "get_config") {
    // Apps Script回傳的data[0]（如果有）是base64包裝過的字串（見上方
    // set_config分支），這裡解開還原成真正的settings JSON字串再轉發給
    // 前端；解不開（例如這個token存的是修正上線前的舊資料，本來就已經
    // 損毀，或這個token從沒存過任何東西）就照原樣轉發，讓前端自己的
    // JSON.parse失敗訊息説明狀況，不在這裡吞掉錯誤佯裝成功。
    try {
      const result = JSON.parse(resultText);
      if (result && Array.isArray(result.data) && result.data[0]) {
        result.data[0] = base64ToUtf8(result.data[0]);
        return jsonResponse(JSON.stringify(result), upstream.status, { "Cache-Control": "no-store" });
      }
    } catch { /* Apps Script回應本身不是合法JSON，原樣轉發，交給前端處理 */ }
  }

  // Apps Script的回應本來就已經是我們要的JSON形狀（{status, metadata, data}），
  // 原樣轉發即可，不需要再包一層或轉換欄位名稱。
  return jsonResponse(resultText, upstream.status, { "Cache-Control": "no-store" });
}

/**
 * ── 關於 /edge-tts ──
 * floating-assistant.js的text_to_speech工具，中文（或其他Kokoro本地模型
 * 不支援的語言）走這條路。轉接Microsoft Edge瀏覽器「大聲朗讀」功能背後用的
 * 神經網路語音服務（speech.platform.bing.com）——免費、不需要帳號/API金鑰，
 * 這是Edge瀏覽器本身內建功能，不是Azure付費API，但這個服務只接受來自
 * Edge擴充功能情境的連線（驗證Origin header+一個時間戳雜湊簽章），瀏覽器
 * JS沒辦法直接設定這些header，所以需要這裡（Worker，不受瀏覽器同源限制）
 * 代為轉接：瀏覽器→這個Worker(HTTP POST)→Microsoft(WebSocket)→把回傳的
 * MP3位元組原樣轉發回瀏覽器。protocol細節（Sec-MS-GEC簽章公式、二進位
 * frame格式）抄自目前(2026-09)仍在維護、下載量最大的開源實作
 * node-edge-tts@1.2.10（MIT授權，https://www.npmjs.com/package/node-edge-tts），
 * 不是我們自己逆向的——Microsoft之前的做法只驗證Origin header，該套件
 * 1.0.1版本現在已經失效(HTTP 403)，1.2.x這個新版加了Sec-MS-GEC簽章才能用，
 * 這裡直接採用目前有效的版本。⚠️這個路由送出去的文字會離開瀏覽器、經過
 * 這個Worker、送到Microsoft的伺服器——跟這個專案其餘AI功能（Whisper轉錄／
 * Kokoro英文語音合成）「純瀏覽器端、不上傳」不同，是刻意的取捨（本地端
 * 目前沒有能驗證可靠的中文語音方案，見floating-assistant.js的
 * TTS常數說明），floating-assistant.js那邊預設關閉這個功能、要使用者自己
 * 在設定裡開啟才會用到。
 *
 * POST /edge-tts  body: {text, voice, lang?, rate?, pitch?, volume?}
 *   voice: 例如 "zh-TW-HsiaoChenNeural"（格式 xx-XX-NameNeural，白名單見
 *          EDGE_TTS_VOICE_PATTERN）
 *   lang:  選填，例如 "zh-TW"；留空時從voice前兩段推導（zh-TW-XXX → zh-TW）
 *   rate/pitch/volume: 選填，Edge TTS SSML的prosody參數，例如 "+10%"/"+0Hz"/
 *          "+0%"，不合法就用預設值 "default"（維持原速/原調/原音量）
 * 回傳：成功→ audio/mpeg 位元組；失敗→ JSON {ok:false, error}
 */
const EDGE_TTS_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"; // 公開已知的固定值，不是使用者的密鑰
const EDGE_TTS_CHROMIUM_VERSION = "143.0.3650.75";
const EDGE_TTS_WINDOWS_EPOCH_OFFSET_SEC = 11644473600n; // Windows FILETIME紀元(1601-01-01)跟Unix紀元(1970-01-01)的秒數差
const EDGE_TTS_VOICE_PATTERN = /^[A-Za-z]{2}-[A-Za-z]{2,8}-[A-Za-z0-9]+Neural$/;
const EDGE_TTS_LANG_PATTERN = /^[A-Za-z]{2}-[A-Za-z]{2,8}$/;
const EDGE_TTS_PROSODY_PATTERN = /^[+-]?\d{1,3}(%|Hz)$/;
const EDGE_TTS_MAX_TEXT_LENGTH = 4000; // 單次請求文字長度上限，長文字由前端自己切段分批打

function edgeTtsEscapeXml(unsafe) {
  return unsafe.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Sec-MS-GEC簽章：把「目前時間換算成Windows FILETIME格式(100奈秒為單位)、
// 無條件捨去到最近的5分鐘邊界」跟固定token串起來做SHA-256、轉大寫hex。
// Workers runtime有Web Crypto API(crypto.subtle)，這裡用它算雜湊，等價於
// node-edge-tts參考實作用node:crypto的createHash('sha256')那段邏輯。
async function edgeTtsGenerateSecMsGec() {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const ticks = (nowSec + EDGE_TTS_WINDOWS_EPOCH_OFFSET_SEC) * 10000000n;
  const roundedTicks = ticks - (ticks % 3000000000n); // 3e9 * 100ns = 300秒 = 5分鐘
  const strToHash = `${roundedTicks}${EDGE_TTS_TRUSTED_CLIENT_TOKEN}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(strToHash));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function handleEdgeTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(JSON.stringify({ ok: false, error: "invalid JSON body" }), 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return jsonResponse(JSON.stringify({ ok: false, error: "缺少text" }), 400);
  if (text.length > EDGE_TTS_MAX_TEXT_LENGTH) {
    return jsonResponse(JSON.stringify({ ok: false, error: `文字過長（${text.length}字元，單次請求上限${EDGE_TTS_MAX_TEXT_LENGTH}字元），請分段` }), 400);
  }
  const voice = typeof body.voice === "string" ? body.voice.trim() : "";
  if (!EDGE_TTS_VOICE_PATTERN.test(voice)) {
    return jsonResponse(JSON.stringify({ ok: false, error: `voice格式不合法（例如 zh-TW-HsiaoChenNeural）：${voice}` }), 400);
  }
  let lang = typeof body.lang === "string" ? body.lang.trim() : "";
  if (!EDGE_TTS_LANG_PATTERN.test(lang)) lang = voice.split("-").slice(0, 2).join("-");
  const rate = EDGE_TTS_PROSODY_PATTERN.test(body.rate) ? body.rate : "default";
  const pitch = EDGE_TTS_PROSODY_PATTERN.test(body.pitch) ? body.pitch : "default";
  const volume = EDGE_TTS_PROSODY_PATTERN.test(body.volume) ? body.volume : "default";

  const secMsGec = await edgeTtsGenerateSecMsGec();
  // tw_stock_db客製: 2026-09-12實測發現——Cloudflare Workers的fetch()走
  // Upgrade:websocket這個手法時，URL本身要是https:// scheme（不是wss://），
  // 協定切換完全靠Upgrade header觸發；傳wss://會直接被fetch()拒絕
  // （"Fetch API cannot load: wss://..."），部署後才測出來的，worker.js文件
  // 範例雖然用wss://當client端new WebSocket()的URL，但fetch()這條路徑
  // 不一樣。
  const msUrl = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
    + `?TrustedClientToken=${EDGE_TTS_TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-${EDGE_TTS_CHROMIUM_VERSION}`;

  let upstream;
  try {
    // Cloudflare Workers的outbound WebSocket走fetch()+Upgrade header這個
    // 官方文件記載的手法（不是瀏覽器的new WebSocket()，那個不能自訂
    // Origin/User-Agent等header——這正是本來要繞過的限制，見上方說明）。
    upstream = await fetch(msUrl, {
      headers: {
        Upgrade: "websocket",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_TTS_CHROMIUM_VERSION.split(".")[0]}.0.0.0 Safari/537.36 Edg/${EDGE_TTS_CHROMIUM_VERSION.split(".")[0]}.0.0.0`,
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    return jsonResponse(JSON.stringify({ ok: false, error: "連線Microsoft語音服務失敗：" + String(err && err.message || err) }), 502);
  }
  const ws = upstream.webSocket;
  if (!ws) {
    return jsonResponse(JSON.stringify({ ok: false, error: `Microsoft語音服務拒絕連線（HTTP ${upstream.status}，可能是簽章公式已過期，需要更新Sec-MS-GEC邏輯）` }), 502);
  }
  ws.accept();

  const audioChunks = [];
  // tw_stock_db客製: 2026-09-12——部署後實測卡在「連線成功但沒收到音訊」
  // （沒有丟出fetch層級的錯誤，但turn.end/音訊都沒等到），單靠一個籠統的
  // 「沒有收到音訊資料」沒辦法遠端診斷是卡在哪一步，先加上這些診斷欄位
  // （收到的文字訊息、二進位訊息數量/總長度、close code/reason），失敗時
  // 一起回傳，方便不需要Cloudflare Dashboard日誌也能定位問題。等確認好了
  //之後可以考慮精簡掉。
  const debugTextMsgs = [];
  let binaryMsgCount = 0, binaryTotalBytes = 0;
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "逾時（15秒內沒有收到完整音訊）" }), 15000);
    ws.addEventListener("message", (evt) => {
      if (typeof evt.data === "string") {
        if (debugTextMsgs.length < 10) debugTextMsgs.push(evt.data.slice(0, 200));
        if (evt.data.includes("Path:turn.end")) {
          clearTimeout(timer);
          resolve({ ok: true });
        }
        return;
      }
      // 二進位訊息：前面是一段文字header（含"Path:audio\r\n\r\n"），後面才是
      // 真正的MP3位元組，跟node-edge-tts參考實作的切法一致。
      const data = new Uint8Array(evt.data);
      binaryMsgCount++; binaryTotalBytes += data.length;
      const sep = "Path:audio\r\n";
      const sepBytes = new TextEncoder().encode(sep);
      let idx = -1;
      for (let i = 0; i <= data.length - sepBytes.length; i++) {
        let match = true;
        for (let j = 0; j < sepBytes.length; j++) { if (data[i + j] !== sepBytes[j]) { match = false; break; } }
        if (match) { idx = i + sepBytes.length; break; }
      }
      if (idx >= 0) audioChunks.push(data.subarray(idx));
      else if (debugTextMsgs.length < 10) debugTextMsgs.push(`[binary msg ${data.length}B, no Path:audio separator found; first 60B hex: ${[...data.subarray(0, 60)].map(b => b.toString(16).padStart(2, "0")).join(" ")}]`);
    });
    ws.addEventListener("close", (evt) => {
      clearTimeout(timer);
      if (audioChunks.length > 0) { resolve({ ok: true }); return; }
      resolve({ ok: false, error: `WebSocket關閉時還沒收到音訊（close code=${evt.code} reason=${evt.reason || "(無)"}，收到${debugTextMsgs.length}則文字訊息、${binaryMsgCount}則二進位訊息共${binaryTotalBytes}bytes）：${JSON.stringify(debugTextMsgs)}` });
    });
    ws.addEventListener("error", (evt) => { clearTimeout(timer); resolve({ ok: false, error: `WebSocket連線錯誤：${(evt && evt.message) || String(evt)}` }); });

    const speechConfig = JSON.stringify({ context: { synthesis: { audio: {
      metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
    } } } });
    ws.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${speechConfig}`);
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">`
      + `<voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${edgeTtsEscapeXml(text)}</prosody></voice></speak>`;
    ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`);
  });
  try { ws.close(); } catch { /* 可能已經關閉，忽略 */ }

  if (!result.ok || !audioChunks.length) {
    return jsonResponse(JSON.stringify({ ok: false, error: result.error || "沒有收到音訊資料" }), 502);
  }
  let totalLen = 0;
  for (const c of audioChunks) totalLen += c.length;
  const merged = new Uint8Array(totalLen);
  let off = 0;
  for (const c of audioChunks) { merged.set(c, off); off += c.length; }
  return new Response(merged, { status: 200, headers: { "Content-Type": "audio/mpeg", ...corsHeaders, "Cache-Control": "no-store" } });
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
      if (sanitizedPath === "/yahoo-intraday") return await handleYahooIntraday(url);
      if (sanitizedPath === "/webfetch") return await handleWebFetch(url);
      if (sanitizedPath === "/browser-search") return await handleBrowserSearch(request);
      if (sanitizedPath === "/sheet-sync") return await handleSheetSync(request, env);
      if (sanitizedPath === "/edge-tts") return await handleEdgeTts(request);

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
