// CI/CD 連線用的 HTTP 請求（主行程）：給 gerrit／github_ci／jenkins 工具打 REST API。
// 為什麼在主行程：沒有瀏覽器 CORS 限制（內部 Gerrit／Jenkins 通常不開）；用 Electron 的 net.fetch（Chromium 網路層）會吃系統代理與作業系統的憑證庫，
// 公司內部自簽 CA 的伺服器也能連。Authorization 之類的標頭由 renderer 依「連線設定」組好帶過來，模型看不到。
// 寫入動作（POST／PUT／DELETE／PATCH：留 review、觸發 build、重跑 job…）一律跳原生確認框，使用者按允許才送。
// 回應大小有上限；console 記錄這種很長的回應可以選「只留尾巴」（keep:"tail"），失敗原因幾乎都在最後。
"use strict";

const HARD_CAP = 64 * 1024 * 1024;     // 最多讀這麼多（超過就停止讀取）
const DEFAULT_MAX = 2 * 1024 * 1024;   // 預設回傳給 renderer 的文字上限
const KEEP_HEADERS = ["content-type", "content-length", "location", "x-more-data", "x-text-size", "x-jenkins", "x-ratelimit-remaining", "x-ratelimit-limit", "x-ratelimit-reset", "retry-after", "x-github-request-id", "www-authenticate"];
const BAD_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "cookie", "set-cookie"]);

function redact(s) { return String(s || "").replace(/("?(?:password|passwd|token|secret|api[_-]?key|authorization)"?\s*[:=]\s*"?)[^",\s&}]+/gi, "$1***"); }

async function readCapped(res, maxBytes, keep) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) { const b = Buffer.from(await res.arrayBuffer()); const t = keep === "tail" ? b.subarray(Math.max(0, b.length - maxBytes)) : b.subarray(0, maxBytes); return { buf: t, total: b.length, truncated: b.length > maxBytes }; }
  const chunks = []; let held = 0, total = 0, stopped = false;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    const c = Buffer.from(value); total += c.length;
    if (keep === "tail") { chunks.push(c); held += c.length; while (held - chunks[0].length >= maxBytes) { held -= chunks.shift().length; } }
    else if (held < maxBytes) { const take = c.subarray(0, maxBytes - held); chunks.push(take); held += take.length; }
    if (total >= HARD_CAP) { stopped = true; try { await reader.cancel(); } catch (_) { /* 已結束 */ } break; }
  }
  let buf = Buffer.concat(chunks); if (keep === "tail" && buf.length > maxBytes) buf = buf.subarray(buf.length - maxBytes);
  return { buf, total, truncated: total > buf.length || stopped, stopped };
}

// deps：{ fetchImpl(url, init), confirm(info) -> Promise<boolean> }
async function doFetch(a, deps) {
  const url = String((a && a.url) || "");
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "url 必須是 http:// 或 https:// 開頭" };
  const method = String(a.method || "GET").toUpperCase();
  if (!/^(GET|HEAD|POST|PUT|DELETE|PATCH)$/.test(method)) return { ok: false, error: "不支援的 method：" + method };
  const write = !/^(GET|HEAD)$/.test(method);
  if (write) {
    const c = a.confirm || {};
    const ok = deps.confirm ? await deps.confirm({ title: c.title || "AI 要對外部服務做「寫入」動作", message: c.message || (method + " " + new URL(url).host), detail: [method + " " + url.replace(/(token|password)=[^&]+/gi, "$1=***"), c.detail || "", a.body ? "內容：" + redact(typeof a.body === "string" ? a.body : JSON.stringify(a.body)).slice(0, 1200) : ""].filter(Boolean).join("\n\n") }) : false;
    if (!ok) return { ok: false, denied: true, error: "使用者沒有允許這個寫入動作（沒有送出任何請求）" };
  }
  const headers = {}; for (const [k, v] of Object.entries(a.headers || {})) if (v != null && !BAD_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
  if (!headers["User-Agent"] && !headers["user-agent"]) headers["User-Agent"] = "FloatingAssistant-CI/1.0";
  const ctl = new AbortController(); const to = Math.max(2, Math.min(300, Number(a.timeoutSec) || 30)) * 1000; const timer = setTimeout(() => ctl.abort(), to);
  const maxBytes = Math.max(1024, Math.min(8 * 1024 * 1024, Number(a.maxBytes) || DEFAULT_MAX));
  try {
    const init = { method, headers, redirect: "follow", signal: ctl.signal };
    if (a.body != null && write) { init.body = typeof a.body === "string" ? a.body : JSON.stringify(a.body); if (typeof a.body !== "string" && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json"; }
    const res = await deps.fetchImpl(url, init);
    const hs = {}; for (const k of KEEP_HEADERS) { const v = res.headers.get(k); if (v != null) hs[k] = v; }
    if (method === "HEAD") return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url, headers: hs, text: "" };
    const r = await readCapped(res, maxBytes, a.keep === "tail" ? "tail" : "head");
    return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url, headers: hs, text: r.buf.toString("utf8"), bytes: r.total, truncated: r.truncated, kept: a.keep === "tail" ? "tail" : "head" };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "逾時（" + to / 1000 + " 秒）" : String((e && e.message) || e);
    return { ok: false, error: msg, hint: /ENOTFOUND|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_CERT|certificate|ETIMEDOUT|ERR_PROXY/i.test(msg) ? "連不上這台伺服器：確認網址、VPN／代理，或（自簽憑證）把公司的根憑證裝進作業系統。" : undefined };
  } finally { clearTimeout(timer); }
}

function register(ipcMain, deps) {
  const { net, dialog, BrowserWindow } = deps;
  const fetchImpl = (u, init) => (net && net.fetch ? net.fetch(u, init) : fetch(u, init));
  const confirm = async (info) => {
    if (process.env.FA_DEBUG_CI_CONFIRM === "allow") return true; // 測試用（無頭環境沒辦法按對話框）；正式使用不會設這個環境變數
    if (process.env.FA_DEBUG_CI_CONFIRM === "deny") return false;
    const win = BrowserWindow ? (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]) : null;
    const r = await dialog.showMessageBox(win || undefined, { type: "question", buttons: ["允許", "拒絕"], defaultId: 1, cancelId: 1, noLink: true, title: info.title, message: info.message, detail: info.detail });
    return r.response === 0;
  };
  ipcMain.handle("fa:ci:fetch", async (_e, a) => { try { return await doFetch(a || {}, { fetchImpl, confirm }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } });
}

module.exports = { register, doFetch, readCapped };
