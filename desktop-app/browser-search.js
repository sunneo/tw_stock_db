// tw_stock_db客製: 2026-09-17使用者要求——桌面版的browser_search（floating-
// assistant.js內建工具，見web/floating-assistant.js的_browserSearch/
// SUBAGENT_DOMAIN_REGISTRY.browser_search）原本設計成打Cloudflare Worker的
// /browser-search路由（tw_stock_db_code私有repo的code/cloudflare-worker/
// worker.js的handleBrowserSearch），但桌面版renderer.bootstrap.js早就把
// browserSearchProxyUrl seed成本地proxy的base URL（見bootstrap.js第389行）
// ——local-proxy.js卻從來沒有實作對應的/browser-search路由，導致每次呼叫
// 都落進local-proxy.js的404「unknown route」分支。使用者明確要求：「單機
// 版不要有任何限制」——桌面版是Node環境，完全沒有瀏覽器的CORS限制，不需要
// 依賴任何Cloudflare Worker/雲端服務，這支檔案把worker.js的
// handleBrowserSearch整段邏輯（8個搜尋來源：wiki/stackoverflow/github/
// google/news/sourceforge/codeproject/deepwiki）原封不動的語意port成
// Node.js版本，讓桌面版完全自主運作。
//
// 跟worker.js的差異只有執行環境本身帶來的必要調整：
//   - Cloudflare Workers runtime原生提供HTMLRewriter（streaming HTML
//     parser）解析DuckDuckGo搜尋結果頁；Node.js沒有這個API，改用正則表達式
//     抓取`result__a`(標題連結)/`result__snippet`(摘要)這兩個CSS class——
//     DuckDuckGo的HTML lite介面本身結構單純、多年來相對穩定，這是務實的
//     近似解法，不是完整的HTML parser，如果DuckDuckGo改版HTML結構這裡
//     可能需要跟著調整。
//   - fetch()/AbortController/URLSearchParams都是Node.js（Electron 44
//     內建的Node版本≥20）原生支援的全域API，不需要額外npm套件。
//
// ⚠️已知風險（2026-09-17實測發現，如實記錄）：直接用一般HTTP client（不是
// 真實瀏覽器）打DuckDuckGo的HTML搜尋介面，在某些網路環境/IP下會被其
// anomaly-detection機制擋下、回傳一個JS challenge頁面而不是真正的搜尋
// 結果（這裡的parser對這種頁面會正確地抓不到任何`result__a`，回傳空陣列，
// 不會誤判/崩潰，但使用者會看到「這個來源沒有結果」）。這會影響
// google/sourceforge/codeproject/deepwiki這四個依賴DuckDuckGo代打的來源，
// wiki/stackoverflow/github/news四個直接呼叫官方API的來源不受影響。是否
// 觸發跟請求來源IP的信譽有關，居家網路環境通常比雲端/機房IP的信譽好，
// 無法從程式碼層面完全避免，如實告知這個限制。
"use strict";

const BROWSER_SEARCH_RESULT_LIMIT = 5;
const BROWSER_SEARCH_FETCH_TIMEOUT_MS = 12000;
const BROWSER_SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
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
  return hits.map((h) => ({
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
  return items.map((item) => ({
    title: stripHtml(item.title) || (item.item_type === "answer" ? "StackOverflow回答" : "StackOverflow問題"),
    url: item.link,
    snippet: stripHtml(item.excerpt || item.body || ""),
  }));
}

async function searchGitHub(query) {
  const url = `https://api.github.com/search/repositories?per_page=${BROWSER_SEARCH_RESULT_LIMIT}&q=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url, {
    headers: { "User-Agent": BROWSER_SEARCH_UA, Accept: "application/vnd.github+json" },
  });
  if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
  const data = await resp.json();
  const items = (data && data.items) || [];
  return items.map((item) => ({
    title: item.full_name,
    url: item.html_url,
    snippet: stripHtml(item.description || "") + (item.stargazers_count ? ` ⭐${item.stargazers_count}` : ""),
  }));
}

function decodeDdgHref(rawHref) {
  if (!rawHref) return "";
  const href = rawHref.startsWith("//") ? `https:${rawHref}` : rawHref;
  const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch) {
    try {
      return decodeURIComponent(uddgMatch[1]);
    } catch (_) {
      return href;
    }
  }
  return href;
}

// tw_stock_db客製: Node.js沒有HTMLRewriter，改用regex抓
// `class="...result__a..." href="...">TITLE</a>`（標題連結）跟緊接在後面
// 的`class="...result__snippet..." ...>SNIPPET</a>`（摘要）——用「這個標題
// 連結到下一個標題連結之間」當一個搜尋結果的範圍（regex不擅長配對巢狀
// <div>，這是務實的邊界近似，不是完整HTML parser）。
async function duckDuckGoHtmlSearch(rawQuery, siteFilter) {
  const query = siteFilter ? `site:${siteFilter} ${rawQuery}` : rawQuery;
  const resp = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": BROWSER_SEARCH_UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!resp.ok) throw new Error(`DuckDuckGo HTML介面 HTTP ${resp.status}`);
  const html = await resp.text();

  const titleRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const matches = [];
  let m;
  while ((m = titleRe.exec(html))) {
    matches.push({ href: m[1], titleHtml: m[2], end: titleRe.lastIndex });
  }
  const items = [];
  for (let i = 0; i < matches.length && items.length < BROWSER_SEARCH_RESULT_LIMIT; i++) {
    const cur = matches[i];
    const title = stripHtml(cur.titleHtml);
    if (!title) continue;
    const segEnd = i + 1 < matches.length ? matches[i + 1].end : html.length;
    const segment = html.slice(cur.end, segEnd);
    const snippetMatch = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(segment);
    items.push({ title, url: decodeDdgHref(cur.href), snippet: snippetMatch ? stripHtml(snippetMatch[1]) : "" });
  }
  return items;
}

// tw_stock_db客製: 2026-09-17使用者回報「browser search的duck duck go有
// 問題，沒辦法真正查資料」——html.duckduckgo.com/html/這個介面在某些網路
// 環境/IP信譽下會被anomaly-detection擋下（見上面既有的風險說明），
// lite.duckduckgo.com/lite/是DuckDuckGo自己維護給純文字瀏覽器/腳本用的
// 極簡版介面（多年來HTML結構刻意保持穩定），跟html.duckduckgo.com是
// 完全獨立的兩個服務端點，被擋的網路環境不一定兩邊同時被擋，值得當
// 備援重試一次，而不是主要介面一失敗就直接放棄。GET
// （不是POST，這是lite介面本身的協定）＋一樣的regex近似解析手法
// （class="result-link"是標題連結、緊接著的class="result-snippet"是
// 摘要）。
async function duckDuckGoLiteSearch(rawQuery, siteFilter) {
  const query = siteFilter ? `site:${siteFilter} ${rawQuery}` : rawQuery;
  const resp = await fetchWithTimeout(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": BROWSER_SEARCH_UA },
  });
  if (!resp.ok) throw new Error(`DuckDuckGo Lite介面 HTTP ${resp.status}`);
  const html = await resp.text();

  const titleRe = /<a[^>]*class="[^"]*\bresult-link\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const matches = [];
  let m;
  while ((m = titleRe.exec(html))) {
    matches.push({ href: m[1], titleHtml: m[2], end: titleRe.lastIndex });
  }
  const items = [];
  for (let i = 0; i < matches.length && items.length < BROWSER_SEARCH_RESULT_LIMIT; i++) {
    const cur = matches[i];
    const title = stripHtml(cur.titleHtml);
    if (!title) continue;
    const segEnd = i + 1 < matches.length ? matches[i + 1].end : html.length;
    const segment = html.slice(cur.end, segEnd);
    const snippetMatch = /class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(segment);
    items.push({ title, url: decodeDdgHref(cur.href), snippet: snippetMatch ? stripHtml(snippetMatch[1]) : "" });
  }
  return items;
}

// tw_stock_db客製: 2026-09-17——兩個獨立介面都試過一次才真的放棄：主要的
// html.duckduckgo.com優先（結果通常比較豐富），拿到0筆結果時（可能是真的
// 查無資料，也可能是被擋下的JS challenge頁——沒辦法從結果本身分辨，見
// duckDuckGoHtmlSearch的regex對challenge頁本來就抓不到任何
// `result__a`class，安全地回傳空陣列，不會誤判/崩潰）才退回lite介面重試
// 一次。任一介面本身丟出例外（網路錯誤/逾時）時也視同0筆，繼續嘗試下一個
// 介面，最後真的兩邊都失敗才把最後一個例外往外拋。
async function duckDuckGoSearch(rawQuery, siteFilter) {
  let primaryError = null;
  try {
    const primary = await duckDuckGoHtmlSearch(rawQuery, siteFilter);
    if (primary.length) return primary;
  } catch (err) {
    primaryError = err;
  }
  try {
    return await duckDuckGoLiteSearch(rawQuery, siteFilter);
  } catch (err) {
    if (primaryError) throw primaryError;
    throw err;
  }
}

const searchGoogle = (query) => duckDuckGoSearch(query, null);
const searchSourceForge = (query) => duckDuckGoSearch(query, "sourceforge.net");
const searchCodeProject = (query) => duckDuckGoSearch(query, "codeproject.com");

async function searchDeepWiki(query) {
  const items = await duckDuckGoSearch(query, "deepwiki.com");
  if (/^[\w.-]+\/[\w.-]+$/.test(query.trim())) {
    items.unshift({
      title: `DeepWiki: ${query.trim()}（推測連結，未驗證頁面是否存在）`,
      url: `https://deepwiki.com/${query.trim()}`,
      snippet: "依GitHub repo命名慣例推測出的DeepWiki連結，不保證頁面真的存在，使用前建議先確認。",
    });
  }
  return items.slice(0, BROWSER_SEARCH_RESULT_LIMIT);
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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

// req/res是Node的http.IncomingMessage/http.ServerResponse（跟local-proxy.js
// 其餘handler同一種介面），setCorsHeaders由呼叫端（local-proxy.js）先設定
// 好，這裡只需要讀body、組回應。
async function handleBrowserSearch(req, res) {
  let rawBody = "";
  req.on("data", (chunk) => {
    rawBody += chunk;
  });
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(rawBody || "{}");
    } catch (_) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request body不是合法JSON" }));
      return;
    }
    const query = String((body && body.query) || "").trim();
    if (!query) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少query參數" }));
      return;
    }
    const sources = Array.isArray(body && body.sources)
      ? body.sources.map(String).filter((s) => Object.prototype.hasOwnProperty.call(BROWSER_SEARCH_SOURCE_HANDLERS, s))
      : [];
    if (!sources.length) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少合法的sources參數" }));
      return;
    }

    const results = {};
    await Promise.all(
      sources.map(async (source) => {
        try {
          const items = await BROWSER_SEARCH_SOURCE_HANDLERS[source](query);
          results[source] = { items };
        } catch (err) {
          results[source] = { error: String((err && err.message) || err) };
        }
      })
    );
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ results }));
  });
}

module.exports = { handleBrowserSearch };
