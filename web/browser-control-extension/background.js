// Floating AI Assitant(Chrome Extension) 背景程式（Manifest V3 service worker）。
//
// 兩條入口，共用同一組指令（exec）：
//   1. 網頁版：content-bridge.js 轉來的訊息。只有「允許的網站」清單裡的來源可以下指令，
//      使用者要在彈出視窗手動加入，任意網站不能操控瀏覽器。
//   2. 桌面版：定時輪詢 http://127.0.0.1:<port>/bc/poll（桌面 app 內建的本機服務），
//      用配對碼（X-FA-Token）驗證，取回指令、執行、回傳結果。
//
// 安全邊界：除了 ping，所有指令都只作用在「助理自己建立的分頁」（managedTabs），
// 不能讀取或操作使用者原本開著的其他分頁。

const VERSION = "1.6.0";
const AI_GROUP_TITLE = "AI Controlled";
const AI_GROUP_COLOR = "purple";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 設定 / 狀態 ----------
async function getCfg() {
  return chrome.storage.local.get({ allowedOrigins: [], desktopToken: "", desktopPort: 17923, desktopEnabled: true });
}
async function getManaged() {
  const s = await chrome.storage.session.get({ managedTabs: [], managedGroups: {} });
  return { tabs: new Set(s.managedTabs), groups: s.managedGroups };
}
async function saveManaged(m) {
  await chrome.storage.session.set({ managedTabs: [...m.tabs], managedGroups: m.groups });
}
async function markTab(tabId) {
  const m = await getManaged();
  m.tabs.add(tabId);
  await saveManaged(m);
}
async function unmarkTab(tabId) {
  const m = await getManaged();
  if (m.tabs.delete(tabId)) await saveManaged(m);
}
// 2026-09-30（跟Redmine那邊對齊）：分頁不管是被AI關、自動清理、還是使用者自己關掉，都從追蹤名單移除；
// 群組裡最後一個分頁關掉後（Chrome會自動移除空群組），也把我們記錄的群組資料清掉。
async function getKeep() { const s = await chrome.storage.session.get({ keepTabs: [] }); return new Set(s.keepTabs); }
async function markKeep(tabId) {
  const k = await getKeep();
  if (!k.has(tabId)) { k.add(tabId); await chrome.storage.session.set({ keepTabs: [...k] }); }
}
async function unmarkKeep(tabId) {
  const k = await getKeep();
  if (k.delete(tabId)) await chrome.storage.session.set({ keepTabs: [...k] });
}
async function pruneGroups() {
  const m = await getManaged();
  let changed = false;
  for (const gid of Object.keys(m.groups)) {
    let n = 0;
    try { n = (await chrome.tabs.query({ groupId: Number(gid) })).length; } catch (_) { n = 0; }
    if (n === 0) { delete m.groups[gid]; changed = true; }
  }
  if (changed) await saveManaged(m);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  unmarkTab(tabId).then(() => unmarkKeep(tabId)).then(() => pruneGroups()).catch(() => {});
  attached.delete(tabId);
  focusEmulated.delete(tabId);
});
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId != null) {
    const m = await getManaged();
    if (m.tabs.has(tab.openerTabId)) await markTab(tab.id);
  }
});

// 找不到分頁（沒給 tab_id、已被關掉、或不是助理建立的）一律無條件開新分頁，不回錯誤。
async function needTab(a, ctx) {
  const tabId = Number(a && a.tab_id);
  const m = await getManaged();
  if (Number.isInteger(tabId) && m.tabs.has(tabId)) {
    try { return { tabId, tab: await chrome.tabs.get(tabId) }; } catch (_) { await unmarkTab(tabId); }
  } else if (!Number.isInteger(tabId)) {
    let blank = null;
    for (const id of [...m.tabs].reverse()) {
      try {
        const t = await chrome.tabs.get(id);
        if (t.url && !/^about:blank/.test(t.url)) return { tabId: id, tab: t };
        if (!blank) blank = { tabId: id, tab: t };
      } catch (_) { await unmarkTab(id); }
    }
    if (blank) return blank;
  }
  const { tab } = await createAiTab(a && a.url ? a.url : "about:blank", false);
  if (ctx) ctx.recovered = { requested_tab_id: Number.isInteger(tabId) ? tabId : null, new_tab_id: tab.id };
  return { tabId: tab.id, tab };
}

// ---------- debugger（滑鼠/鍵盤/截圖用真實輸入事件） ----------
const attached = new Set();
const focusEmulated = new Set();
chrome.debugger.onDetach.addListener((src) => { if (src.tabId != null) { attached.delete(src.tabId); focusEmulated.delete(src.tabId); } });
async function dbg(tabId) {
  if (attached.has(tabId)) return;
  try { await chrome.debugger.attach({ tabId }, "1.3"); }
  catch (err) {
    const msg = String((err && err.message) || err);
    if (!/already attached/i.test(msg)) throw new Error("無法附加到分頁（可能是 chrome:// 頁面，或已被開發人員工具占用）：" + msg);
  }
  attached.add(tabId);
}
const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params || {});

// tw_stock_db客製: 2026-09-22使用者要求——瀏覽器讀取（get_page_text/
// get_page_structure）原本是「一次讀完＋max_chars硬截斷」，長文章讀到
// 一半就沒了，也沒辦法接著讀。跟桌面版FAP/附件系統既有的
// _pageText（floating-assistant.js）同一套分頁契約：offset/start_line
// 決定起點，max_chars/max_lines決定這次讀多少，回傳has_more/next_offset
// 讓呼叫端接著讀，盡量停在行尾不切斷一行。這裡獨立重寫一份（不是
// import那邊的實作）——瀏覽器擴充功能是完全獨立的沙盒環境，沒有辦法
// require/共用floating-assistant.js的程式碼。
function pageText(text, o = {}) {
  text = String(text == null ? "" : text);
  const total = text.length;
  const budget = Math.max(500, Math.min(150000, Math.floor(Number(o.maxChars) || 12000)));
  let start;
  if (o.startLine != null && Number(o.startLine) >= 1) {
    const target = Math.floor(Number(o.startLine));
    let idx = 0, line = 1;
    while (line < target) { const nl = text.indexOf("\n", idx); if (nl < 0) { idx = total; break; } idx = nl + 1; line++; }
    start = idx;
  } else start = Math.max(0, Math.min(total, Math.floor(Number(o.offset) || 0)));
  let end = Math.min(total, start + budget);
  if (o.maxLines != null && Number(o.maxLines) > 0) {
    let cnt = 0, idx = start;
    const want = Math.floor(Number(o.maxLines));
    while (idx < total && cnt < want) { const nl = text.indexOf("\n", idx); if (nl < 0) { idx = total; break; } idx = nl + 1; cnt++; }
    end = Math.min(end, idx);
  } else if (end < total) {
    const nl = text.lastIndexOf("\n", end - 1);
    if (nl > start) end = nl + 1;
  }
  const content = text.slice(start, end);
  const count = (s) => { let n = 0; for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) n++; return n; };
  const startLineNo = count(text.slice(0, start)) + 1;
  const endLineNo = startLineNo + count(content) - (content.endsWith("\n") ? 1 : 0);
  const hasMore = end < total;
  return {
    text: content, offset: start, returned_chars: content.length, total_chars: total,
    start_line: startLineNo, end_line: Math.max(startLineNo, endLineNo),
    has_more: hasMore, next_offset: hasMore ? end : null,
    page_hint: hasMore ? `還沒讀完（${end}/${total}字元）：用offset=${end}繼續讀，長文章要分頁讀完整份，不要只看第一段就下結論。` : undefined,
  };
}

// tw_stock_db客製: 2026-09-22——移植到Redmine時實測發現背景分頁（active:false）幾乎每次都收不到
// 合成滑鼠/鍵盤事件（screenshot/scroll等唯讀操作則不受影響，維持背景可用），所以真的要打字/點擊/
// 按鍵前一律先把分頁切到前景，等一小段時間讓頁面真正拿到焦點再送CDP指令。
// 2026-09-30（跟Redmine那邊對齊）：使用者要求不要自動切到助理開的分頁——會干擾使用者正在做的事。
// 背景分頁收不到合成的滑鼠/鍵盤事件的問題，改用 Emulation.setFocusEmulationEnabled 解決：
// 讓頁面「以為」自己有焦點，實際上分頁仍留在背景、使用者的畫面不動。
// 只有 tab_activate（browser_activate_tab）才會真的把分頁切到前景。
async function keepPageFocused(tabId) {
  await dbg(tabId);
  if (!focusEmulated.has(tabId)) {
    await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    focusEmulated.add(tabId);
  }
  return chrome.tabs.get(tabId);
}

// tw_stock_db客製: 2026-09-28使用者要求——批次走訪多個頁面、逐一點「免費下載」把檔案抓下來
// （例如worksheet網站的PDF圖集），原本完全沒有下載追蹤能力：AI點了下載按鈕之後，不知道
// 有沒有真的觸發下載、存到哪裡、檔名是什麼，沒辦法確認成功或接著搬動/改名檔案。這裡用
// chrome.downloads的onCreated/onChanged維護一份最近下載的記錄（記憶體內，service worker
// 重啟就清空，不需要持久化），click/wait_download指令用「呼叫當下的時間戳記」當分界線，
// 只等「這次操作之後才新建立」的下載項目，避免撈到使用者自己之前下載的舊檔案。
const recentDownloads = [];
function pushOrUpdateDownload(patch) {
  let d = recentDownloads.find((x) => x.id === patch.id);
  if (!d) {
    d = { id: patch.id, startTime: Date.now(), state: "in_progress" };
    recentDownloads.unshift(d);
    if (recentDownloads.length > 40) recentDownloads.pop();
  }
  for (const k of ["url", "filename", "state", "mime", "fileSize", "error", "exists"]) {
    if (patch[k] !== undefined) d[k] = patch[k];
  }
}
if (chrome.downloads) {
  chrome.downloads.onCreated.addListener((item) => pushOrUpdateDownload(item));
  chrome.downloads.onChanged.addListener((delta) => {
    const patch = { id: delta.id };
    for (const k of ["filename", "state", "mime", "fileSize", "error", "exists"]) {
      if (delta[k]) patch[k] = delta[k].current;
    }
    pushOrUpdateDownload(patch);
  });
}
function downloadInfo(d) {
  return { id: d.id, path: d.filename || null, url: d.url || null, mime: d.mime || null, size_bytes: d.fileSize != null ? d.fileSize : null };
}
// since：只認「startTime >= since」的下載項目為「這次操作觸發的」；用「呼叫時的Date.now()」
// 當since、不是「點擊後才記」，避免下載快到在我們開始等待之前就已經進了onCreated的race condition。
async function waitForNewDownload(timeoutMs, since, tabId) {
  const budget = Math.max(1000, Math.min(180000, Number(timeoutMs) || 20000));
  const end = Date.now() + budget;
  if (tabId == null && dlBehavior.size === 1) tabId = [...dlBehavior.keys()][0];
  const ctl = tabId != null ? dlBehavior.get(tabId) : null;
  for (;;) {
    if (ctl && ctl.behavior === "capture") {
      const c = [...captures.values()].filter((x) => x.tabId === tabId && x.startTime >= since).sort((x, y) => x.startTime - y.startTime)[0];
      if (c) {
        if (c.error) throw new Error("擷取下載失敗：" + c.error + (c.filename ? "（" + c.filename + "）" : ""));
        if (c.done) return capInfo(c);
      } else {
        const pd = pageDownloads.find((d) => d.tabId === tabId && d.startTime >= since && !/^(blob|data):/i.test(d.url || ""));
        if (pd && Date.now() - pd.startTime > 3000) return Object.assign(pageDownloadInfo(pd, ctl), { denied: true, captured: false, note: "有下載想發生，但不是可擷取的檔案回應（沒被存檔也沒被擷取）" });
      }
    }
    // 下載行為由助理控制的分頁：以除錯器事件為準
    if (ctl && ctl.behavior !== "capture") {
      const pd = pageDownloads.find((d) => d.tabId === tabId && d.startTime >= since);
      if (pd) {
        if (ctl.behavior === "deny") return Object.assign(pageDownloadInfo(pd, ctl), { denied: true, note: "下載被擋掉了（download_behavior=deny），沒有存檔" });
        if (pd.state === "completed") return pageDownloadInfo(pd, ctl);
        if (pd.state === "canceled") throw new Error("下載被取消：" + (pd.suggestedFilename || pd.url || ""));
      }
    }
    const cand = recentDownloads.find((d) => d.startTime >= since);
    if (cand && !(ctl && ctl.behavior === "deny")) {
      if (cand.state === "complete") return downloadInfo(cand);
      if (cand.state === "interrupted") throw new Error("下載被中斷/失敗：" + (cand.error || "未知原因") + (cand.filename ? "（" + cand.filename + "）" : ""));
    }
    if (Date.now() >= end) {
      throw new Error(
        cand || (ctl && pageDownloads.find((d) => d.tabId === tabId && d.startTime >= since))
          ? "下載還沒完成就逾時了（可能是大檔案或網路慢，可以再呼叫一次wait_download繼續等）"
          : "等不到新的下載開始——可能是：(1)跳出了「另存新檔」對話框卡住（擴充功能碰不到系統對話框；請在 click 或 set_download_behavior 帶 download_behavior=allow 與 download_path，讓下載不跳對話框）(2)這次點擊根本沒有觸發下載(3)網站要求登入或有擋下載"
      );
    }
    await sleep(300);
  }
}

// ---------- 下載行為（Page.setDownloadBehavior）----------
// 點擊會觸發下載時，Chrome 可能跳「另存新檔」對話框（擴充功能碰不到系統對話框）。這裡用除錯器對「那個分頁」
// 送 Page.setDownloadBehavior，由助理決定：allow（直接存到指定資料夾，不跳對話框）、deny（擋掉，只回報有下載想發生）、
// default（還給 Chrome 自己處理）。並開啟 Page.downloadWillBegin／downloadProgress 事件，不用等 chrome.downloads。
const dlBehavior = new Map(); // tabId -> { behavior, path }
const pageDownloads = []; // 最近的下載事件（記憶體內）：{ guid, tabId, url, suggestedFilename, state, receivedBytes, totalBytes, startTime }
chrome.debugger.onEvent.addListener((src, method, p) => {
  if (src.tabId == null) return;
  if (method === "Page.downloadWillBegin") {
    pageDownloads.unshift({ guid: p.guid, tabId: src.tabId, url: p.url || null, suggestedFilename: p.suggestedFilename || null, state: "inProgress", receivedBytes: 0, totalBytes: 0, startTime: Date.now() });
    if (pageDownloads.length > 40) pageDownloads.pop();
  } else if (method === "Page.downloadProgress") {
    const d = pageDownloads.find((x) => x.guid === p.guid);
    if (d) { d.state = p.state; d.receivedBytes = p.receivedBytes; d.totalBytes = p.totalBytes; }
  }
});
chrome.debugger.onDetach.addListener((src) => { if (src.tabId != null) dlBehavior.delete(src.tabId); });
function joinPath(dir, name) { const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/"; return String(dir).replace(/[\\/]+$/, "") + sep + name; }
async function setDownloadBehavior(tabId, behavior, path) {
  behavior = String(behavior || "");
  if (!["allow", "deny", "default", "capture"].includes(behavior)) throw new Error("download_behavior 要是 allow／deny／default／capture");
  if (behavior === "allow" && !/^([A-Za-z]:[\\/]|\/)/.test(String(path || ""))) throw new Error("download_behavior=allow 要附 download_path（要存到哪個資料夾，必須是絕對路徑，例如 C:\\Users\\你\\Downloads\\ai 或 /home/你/Downloads/ai）");
  await dbg(tabId);
  try {
    const prev = dlBehavior.get(tabId);
    if (prev && prev.behavior === "capture" && behavior !== "capture") await send(tabId, "Fetch.disable").catch(() => {});
    await send(tabId, "Page.enable");
    if (behavior === "capture") {
      // 先擋掉 Chrome 自己的下載（擷取不到的東西也不會悄悄落地，只會被回報），再用 Fetch 在回應階段攔截檔案回應
      await send(tabId, "Page.setDownloadBehavior", { behavior: "deny" });
      await send(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
      dlBehavior.set(tabId, { behavior: "capture", path: null });
      return { behavior: "capture", path: null };
    }
    await send(tabId, "Page.setDownloadBehavior", behavior === "allow" ? { behavior, downloadPath: String(path) } : { behavior });
  } catch (err) {
    throw new Error("這個 Chrome 版本不接受 Page.setDownloadBehavior：" + String((err && err.message) || err));
  }
  if (behavior === "default") dlBehavior.delete(tabId); else dlBehavior.set(tabId, { behavior, path: behavior === "allow" ? String(path) : null });
  return { behavior, path: behavior === "allow" ? String(path) : null };
}
function pageDownloadInfo(d, ctl) {
  const out = { guid: d.guid, url: d.url, filename: d.suggestedFilename, size_bytes: d.totalBytes || d.receivedBytes || null };
  if (ctl && ctl.behavior === "allow" && d.suggestedFilename) out.path = joinPath(ctl.path, d.suggestedFilename);
  return out;
}

// ---------- 擷取下載（capture）----------
// 自動化期間「下載到什麼」不可控：另存新檔對話框會卡住、檔案落在哪也不知道。capture 模式把下載攔下來、
// 不讓 Chrome 存檔，位元組留在擴充功能的記憶體裡，由網頁（助理）用 read_capture 一段一段拉走（pipeline），
// 助理端邊收邊驗證（大小、crc32），收完再決定寫到哪（助理自己的儲存、或預設下載資料夾）。
//  - 網路下載（GET／POST 表單都行）：用 Fetch 網域在「回應階段」攔截，讀出回應本體後讓請求中止，Chrome 完全不知道有下載。
//  - blob:／data: 下載（沒有網路請求）：收到 Page.downloadWillBegin 後，在頁面裡 fetch 那個網址把位元組讀出來。
const captures = new Map(); // id -> { id, tabId, url, filename, mime, source, chunks, bytes, crc, done, error, startTime }
const CAP_MAX_FILE = 200 * 1024 * 1024, CAP_MAX_TOTAL = 400 * 1024 * 1024, CAP_KEEP_MS = 20 * 60 * 1000, CAP_SLICE = 393216;
let capSeq = 0;
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32Update(crc, bytes) { let c = (crc ^ 0xFFFFFFFF) >>> 0; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const crcHex = (n) => (n >>> 0).toString(16).padStart(8, "0");
function capTotal() { let n = 0; for (const c of captures.values()) n += c.bytes; return n; }
function pruneCaptures() {
  const now = Date.now();
  for (const [id, c] of captures) if (now - c.startTime > CAP_KEEP_MS) captures.delete(id);
  const all = [...captures.values()].sort((a, b) => a.startTime - b.startTime);
  while (all.length > 1 && capTotal() > CAP_MAX_TOTAL) captures.delete(all.shift().id);
}
function newCapture(tabId, meta) {
  pruneCaptures();
  const c = Object.assign({ id: "cap" + (++capSeq), tabId, url: null, filename: "download", mime: "", source: "network", chunks: [], bytes: 0, crc: 0, done: false, error: null, startTime: Date.now() }, meta);
  captures.set(c.id, c);
  return c;
}
function capAppend(c, bytes) {
  if (c.bytes + bytes.length > CAP_MAX_FILE) throw new Error("檔案超過擷取上限 " + Math.round(CAP_MAX_FILE / 1048576) + " MB");
  c.chunks.push(bytes); c.bytes += bytes.length; c.crc = crc32Update(c.crc, bytes);
}
function capInfo(c) { return { captured: true, capture_id: c.id, filename: c.filename, mime: c.mime || null, url: c.url, source: c.source, size_bytes: c.bytes, crc32: crcHex(c.crc) }; }
function capSlice(c, off, len) {
  const out = new Uint8Array(Math.max(0, Math.min(len, c.bytes - off)));
  let pos = 0, w = 0;
  for (const ch of c.chunks) {
    if (w >= out.length) break;
    const end = pos + ch.length;
    if (end > off) { const from = Math.max(0, off - pos), take = Math.min(ch.length - from, out.length - w); out.set(ch.subarray(from, from + take), w); w += take; }
    pos = end;
  }
  return out;
}
function dispositionFilename(cd, url) {
  let n = null;
  const m5 = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd || "");
  if (m5) { try { n = decodeURIComponent(m5[1].trim()); } catch (_) { n = m5[1].trim(); } }
  if (!n) { const m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd || ""); if (m) n = m[1].trim(); }
  if (!n) { try { const p = new URL(url).pathname.split("/").filter(Boolean).pop(); if (p) n = decodeURIComponent(p); } catch (_) { /* 沒有路徑就用預設名 */ } }
  return (n || "download").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
}
const DOWNLOAD_MIME = /^(application\/(octet-stream|zip|x-zip-compressed|gzip|x-gzip|x-7z-compressed|x-rar-compressed|vnd\.rar|x-tar|x-msdownload|msword|force-download|x-download)|application\/vnd\.(openxmlformats|ms-)|binary\/octet-stream)/i;
function isDownloadResponse(p) {
  const hs = {}; for (const h of (p.responseHeaders || [])) hs[h.name.toLowerCase()] = h.value;
  if (p.responseStatusCode >= 300 && p.responseStatusCode < 400) return null;
  const cd = hs["content-disposition"] || "";
  if (/^\s*attachment/i.test(cd)) return { hs, cd };
  if (p.resourceType === "Document" && DOWNLOAD_MIME.test(hs["content-type"] || "")) return { hs, cd };
  return null;
}
async function onFetchPaused(tabId, p) {
  const rid = p.requestId;
  const pass = () => (p.responseStatusCode == null && !p.responseErrorReason ? send(tabId, "Fetch.continueRequest", { requestId: rid }) : send(tabId, "Fetch.continueResponse", { requestId: rid })).catch(() => {});
  const hit = p.responseStatusCode != null ? isDownloadResponse(p) : null;
  if (!hit) { await pass(); return; }
  const c = newCapture(tabId, { url: p.request && p.request.url, filename: dispositionFilename(hit.cd, p.request && p.request.url), mime: String(hit.hs["content-type"] || "").split(";")[0].trim(), source: "network" });
  try {
    const { stream } = await send(tabId, "Fetch.takeResponseBodyAsStream", { requestId: rid });
    for (;;) {
      const r = await send(tabId, "IO.read", { handle: stream, size: 262144 });
      if (r.data) capAppend(c, r.base64Encoded ? b64ToBytes(r.data) : new TextEncoder().encode(r.data));
      if (r.eof) break;
    }
    await send(tabId, "IO.close", { handle: stream }).catch(() => {});
    c.done = true;
    await send(tabId, "Fetch.failRequest", { requestId: rid, errorReason: "Aborted" }).catch(() => {}); // 不讓 Chrome 存檔
  } catch (err) {
    c.error = String((err && err.message) || err); c.done = true;
    await pass();
  }
}
async function captureFromPage(tabId, url, filename) {
  const c = newCapture(tabId, { url: /^data:/i.test(url) ? "data:(內嵌)" : url, filename: String(filename || "download").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180), source: "page" });
  try {
    const ev = await send(tabId, "Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: "(async()=>{const r=await fetch(" + JSON.stringify(url) + ");const b=new Uint8Array(await r.arrayBuffer());window.__faCap=b;return{size:b.length,type:r.headers.get('content-type')||''}})()" });
    if (ev.exceptionDetails) throw new Error("讀不到 " + (/^data:/i.test(url) ? "內嵌資料" : url) + "（可能已被頁面撤銷）：" + String((ev.exceptionDetails.exception && ev.exceptionDetails.exception.description) || ev.exceptionDetails.text || "").slice(0, 120));
    const info = ev.result.value; c.mime = String(info.type || "").split(";")[0].trim();
    if (info.size > CAP_MAX_FILE) throw new Error("檔案超過擷取上限");
    for (let off = 0; off < info.size; off += CAP_SLICE) {
      const r = await send(tabId, "Runtime.evaluate", { returnByValue: true, expression: "(()=>{const u=window.__faCap.subarray(" + off + "," + (off + CAP_SLICE) + ");let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()" });
      capAppend(c, b64ToBytes(r.result.value));
    }
    c.done = true;
  } catch (err) { c.error = String((err && err.message) || err); c.done = true; }
  finally { send(tabId, "Runtime.evaluate", { expression: "delete window.__faCap" }).catch(() => {}); }
}
chrome.debugger.onEvent.addListener((src, method, p) => {
  const tabId = src.tabId; if (tabId == null) return;
  const ctl = dlBehavior.get(tabId); if (!ctl || ctl.behavior !== "capture") return;
  if (method === "Fetch.requestPaused") onFetchPaused(tabId, p);
  else if (method === "Page.downloadWillBegin" && /^(blob|data):/i.test(p.url || "")) captureFromPage(tabId, p.url, p.suggestedFilename);
});

async function waitLoad(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let t;
    try { t = await chrome.tabs.get(tabId); } catch (_) { return false; }
    if (t.status === "complete") return true;
    await sleep(150);
  }
  return false;
}

// ---------- 指令 ----------
async function targetWindowId() {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (w && w.id != null) return w.id;
  } catch (_) {}
  const w = await chrome.windows.create({});
  return w.id;
}
const isUrl = (u) => typeof u === "string" && /^(https?:|about:blank$)/i.test(u.trim());
function normUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "about:blank";
  if (isUrl(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return "https://" + s;
  throw new Error("只接受 http(s):// 網址（收到：" + s.slice(0, 80) + "）");
}
function tabInfo(t) {
  return { tab_id: t.id, group_id: t.groupId >= 0 ? t.groupId : null, title: t.title || "", url: t.url || t.pendingUrl || "", active: !!t.active, status: t.status };
}

// 所有助理開的分頁都放進同一個「AI Controlled」分頁群組，讓使用者一眼看出哪些是 AI 在控制的。
async function findAiGroup() {
  const m = await getManaged();
  for (const [gid, title] of Object.entries(m.groups)) {
    if (title !== AI_GROUP_TITLE) continue;
    try { const g = await chrome.tabGroups.get(Number(gid)); return { id: Number(gid), windowId: g.windowId }; }
    catch (_) { delete m.groups[gid]; await saveManaged(m); }
  }
  return null;
}
async function placeInAiGroup(tabIds, windowId) {
  const existing = await findAiGroup();
  if (existing) { await chrome.tabs.group({ tabIds, groupId: existing.id }); return existing.id; }
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: AI_GROUP_TITLE, color: AI_GROUP_COLOR, collapsed: false });
  const m = await getManaged();
  m.groups[String(groupId)] = AI_GROUP_TITLE;
  await saveManaged(m);
  return groupId;
}
// keepOpen：回合結束時不要自動關閉（AI要讓使用者看的頁面）。用 active 開的分頁也一律保留——
// 使用者既然被切到那個分頁，就不該在他還在看的時候被關掉。
async function createAiTab(url, active, keepOpen) {
  const existing = await findAiGroup();
  const windowId = existing ? existing.windowId : await targetWindowId();
  const tab = await chrome.tabs.create({ url: normUrl(url), active: !!active, windowId });
  await markTab(tab.id);
  if (active || keepOpen) await markKeep(tab.id);
  const groupId = await placeInAiGroup([tab.id], windowId);
  return { tab, groupId };
}

// tw_stock_db客製: 2026-09-30——http_fetch：讓 app 用「使用者自己瀏覽器的網路」發 HTTP 請求。
// 背景：YouTube 對 Cloudflare 這類資料中心 IP 會要求登入，經 Worker 轉送的請求出口 IP 就是資料中心；
// 擴充功能有 <all_urls> 主機權限（不受 CORS 限制），請求從使用者真實網路出去。
// 安全邊界（比 <all_urls> 窄很多）：只放行 https 的 YouTube 相關網域、只允許 GET/POST/HEAD、
// 不帶 cookie（credentials: omit），網頁版仍受既有「允許的網站」清單限制。
const HTTP_FETCH_HOSTS = [/(^|\.)youtube\.com$/, /(^|\.)googlevideo\.com$/, /(^|\.)googleapis\.com$/, /^youtu\.be$/, /(^|\.)ytimg\.com$/];
const HTTP_FETCH_DROP_HEADERS = /^(host|origin|referer|cookie|accept-encoding|content-length|connection|sec-.*|proxy-.*)$/i;
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const commands = {
  async ping() {
    return { version: VERSION, browser: navigator.userAgent, capabilities: ["http_fetch", "turn_end", "focus_emulation", "eval_js"] };
  },

  async http_fetch(a) {
    let u;
    try { u = new URL(String(a.url || "")); } catch (_) { throw new Error("不合法的網址"); }
    if (u.protocol !== "https:" || !HTTP_FETCH_HOSTS.some((re) => re.test(u.hostname))) throw new Error("http_fetch 只允許 https 的 YouTube 相關網域：" + u.hostname);
    const method = String(a.method || "GET").toUpperCase();
    if (!["GET", "POST", "HEAD"].includes(method)) throw new Error("http_fetch 只支援 GET/POST/HEAD");
    const headers = {};
    for (const [k, v] of Object.entries(a.headers && typeof a.headers === "object" ? a.headers : {})) {
      if (!HTTP_FETCH_DROP_HEADERS.test(k)) headers[k] = String(v);
    }
    const init = { method, headers, credentials: "omit", redirect: "follow" };
    if (a.bodyBase64 && method === "POST") init.body = b64ToBytes(String(a.bodyBase64));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(Math.max(Number(a.timeoutMs) || 30000, 1000), 100000));
    try {
      const resp = await fetch(u.href, Object.assign(init, { signal: ctrl.signal }));
      const buf = new Uint8Array(await resp.arrayBuffer());
      const outHeaders = {};
      resp.headers.forEach((v, k) => { outHeaders[k] = v; });
      return { status: resp.status, statusText: resp.statusText, url: resp.url, headers: outHeaders, bodyBase64: bytesToB64(buf) };
    } finally { clearTimeout(timer); }
  },

  async tab_group_create(a) {
    const urls = Array.isArray(a.urls) && a.urls.length ? a.urls : [a.url || "about:blank"];
    const tabIds = [];
    let groupId = null;
    for (let i = 0; i < Math.min(urls.length, 20); i++) {
      const r = await createAiTab(urls[i], i === 0 && !!a.active, !!a.keep_open);
      tabIds.push(r.tab.id);
      groupId = r.groupId;
    }
    if (a.wait !== false) await Promise.all(tabIds.map((id) => waitLoad(id, 15000)));
    const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id).then(tabInfo)));
    return { group_id: groupId, title: AI_GROUP_TITLE, tabs, note: "所有助理開的分頁都放在同一個「" + AI_GROUP_TITLE + "」分頁群組（已存在就直接加進去）" };
  },

  async tab_create(a) {
    const { tab, groupId } = await createAiTab(a.url, a.active, !!a.keep_open);
    if (a.wait !== false) await waitLoad(tab.id, 15000);
    return Object.assign(tabInfo(await chrome.tabs.get(tab.id)), { group_id: groupId, group_title: AI_GROUP_TITLE });
  },

  async tab_list() {
    const m = await getManaged();
    const keep = await getKeep();
    const out = [];
    for (const id of [...m.tabs]) {
      try { out.push(Object.assign(tabInfo(await chrome.tabs.get(id)), { keep_open: keep.has(id) })); } catch (_) { m.tabs.delete(id); }
    }
    await saveManaged(m);
    const groups = [];
    for (const [gid, title] of Object.entries(m.groups)) {
      try { await chrome.tabGroups.get(Number(gid)); groups.push({ group_id: Number(gid), title }); } catch (_) {}
    }
    return { tabs: out, groups };
  },

  async tab_close(a) {
    if (a.group_id != null) {
      const m = await getManaged();
      if (m.groups[String(a.group_id)] == null) throw new Error("不是助理建立的分頁群組");
      const tabs = await chrome.tabs.query({ groupId: Number(a.group_id) });
      await chrome.tabs.remove(tabs.map((t) => t.id).filter((id) => m.tabs.has(id)));
      await pruneGroups();
      return { closed: tabs.length };
    }
    const tabId = Number(a.tab_id);
    const m = await getManaged();
    if (!Number.isInteger(tabId) || !m.tabs.has(tabId)) return { closed: 0, note: "這個分頁已經不存在或不是助理開的，不需要關閉" };
    try { await chrome.tabs.remove(tabId); } catch (_) {}
    await unmarkTab(tabId);
    await unmarkKeep(tabId);
    await pruneGroups();
    return { closed: 1 };
  },

  // 2026-09-30：助理回合結束時呼叫。關閉這一輪助理開的分頁（沒被標記keep_open、也沒被activate過的），
  // 並清掉空群組的紀錄。找不到要關的分頁也不算錯（可能AI已經自己關了）。
  async turn_end() {
    const m = await getManaged();
    const keep = await getKeep();
    let closed = 0;
    for (const id of [...m.tabs]) {
      if (keep.has(id)) continue;
      try { await chrome.tabs.remove(id); closed++; } catch (_) {}
      await unmarkTab(id);
    }
    await pruneGroups();
    return { closed, kept: [...m.tabs].filter((id) => keep.has(id)).length };
  },

  async tab_navigate(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    if (a.action === "back") await chrome.tabs.goBack(tabId);
    else if (a.action === "forward") await chrome.tabs.goForward(tabId);
    else if (a.action === "reload") await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url: normUrl(a.url) });
    if (a.wait !== false) { await sleep(200); await waitLoad(tabId, 15000); }
    return tabInfo(await chrome.tabs.get(tabId));
  },

  // 2026-10-02：給「程式設計領域」的沙盒實驗用——在助理自己開的about:blank分頁裡寫入一份完整的HTML（會執行裡面的script），
  // 之後可以用tab_eval下指令（例如查詢DOM、點擊、回報console）。about:blank分頁沒有opener，origin是不透明的，
  // 跟助理的網站與使用者的其他分頁完全隔離；仍然只作用在「助理自己建立的分頁」。
  async tab_set_html(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    const html = String(a.html == null ? "" : a.html);
    if (html.length > 1500000) throw new Error("HTML太大（上限約1.5MB）");
    await dbg(tabId);
    const expr = "document.open();document.write(" + JSON.stringify(html) + ");document.close();'ok'";
    const r = await send(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r && r.exceptionDetails) throw new Error("寫入HTML失敗：" + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || "").slice(0, 300));
    await sleep(150);
    return { tab_id: tabId, bytes: html.length };
  },

  // 在助理的分頁裡執行一段JavaScript並回傳結果（字串化）。只給程式設計領域沙盒用的小工具：
  // js通常是 (async()=>{ ... return JSON.stringify(x) })() 這種形式。有逾時；只作用在助理自己的分頁。
  async tab_eval(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    const js = String(a.js || "");
    if (!js) throw new Error("缺少js");
    await dbg(tabId);
    const timeout = Math.min(Math.max(Number(a.timeout_ms) || 8000, 500), 30000);
    const r = await send(tabId, "Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true, timeout });
    if (r && r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value)) || r.exceptionDetails.text || "執行失敗").slice(0, 500));
    const v = r && r.result ? r.result.value : null;
    return { value: v === undefined ? null : v };
  },

  async tab_activate(a, ctx) {
    const { tabId, tab } = await needTab(a, ctx);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await markKeep(tabId); // 使用者被切到這個分頁了，回合結束時不能關掉
    return tabInfo(await chrome.tabs.get(tabId));
  },

  async scroll(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [String(a.direction || "down"), a.amount != null ? Number(a.amount) : null, a.selector ? String(a.selector) : null],
      func: (dir, amount, selector) => {
        const el = selector ? document.querySelector(selector) : null;
        if (selector && !el) return { error: "找不到 selector：" + selector };
        const target = el || document.scrollingElement || document.documentElement;
        const view = el ? el.clientHeight : window.innerHeight;
        const step = amount != null && isFinite(amount) ? amount : Math.round(view * 0.8);
        if (dir === "top") target.scrollTo({ top: 0 });
        else if (dir === "bottom") target.scrollTo({ top: target.scrollHeight });
        else if (dir === "up") target.scrollBy({ top: -step });
        else if (dir === "left") target.scrollBy({ left: -step });
        else if (dir === "right") target.scrollBy({ left: step });
        else target.scrollBy({ top: step });
        return { scroll_y: Math.round(target.scrollTop), scroll_height: target.scrollHeight, viewport_height: view, at_bottom: target.scrollTop + view >= target.scrollHeight - 2 };
      },
    });
    const res = r && r.result;
    if (!res) throw new Error("無法在此頁面捲動（可能是受保護頁面）");
    if (res.error) throw new Error(res.error);
    await sleep(150);
    return res;
  },

  async screenshot(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    const tab = await keepPageFocused(tabId); // 不切到前景（見keepPageFocused）
    const m = await send(tabId, "Page.getLayoutMetrics");
    const vp = m.cssVisualViewport || m.visualViewport;
    const params = { format: "jpeg", quality: Math.min(95, Math.max(30, Number(a.quality) || 70)) };
    let width, height;
    // region={x,y,width,height}：只截指定範圍（像素；一般模式是畫面可視區左上角0,0，full_page時是整頁座標）；scale(1~3)放大
    const rg = a.region && typeof a.region === "object" ? { x: Number(a.region.x), y: Number(a.region.y), width: Number(a.region.width), height: Number(a.region.height) } : null;
    if (rg && !(Number.isFinite(rg.x) && Number.isFinite(rg.y) && rg.width > 0 && rg.height > 0)) throw new Error("region需要{x,y,width,height}四個數字，width/height要大於0");
    const scale = Math.min(3, Math.max(1, Number(a.scale) || 1));
    let regionApplied;
    if (a.full_page) {
      const cs = m.cssContentSize || m.contentSize;
      const fullW = Math.round(cs.width), fullH = Math.min(Math.round(cs.height), 8000);
      params.captureBeyondViewport = true;
      if (rg) {
        const x = Math.max(0, Math.round(rg.x)), y = Math.max(0, Math.round(rg.y));
        width = Math.min(Math.round(rg.width), fullW - x); height = Math.min(Math.round(rg.height), fullH - y);
        if (!(width > 0 && height > 0)) throw new Error("region超出整頁範圍（頁面 " + fullW + "×" + fullH + "）");
        params.clip = { x, y, width, height, scale };
        regionApplied = { x, y, width, height };
      } else { width = fullW; height = fullH; params.clip = { x: 0, y: 0, width, height, scale: 1 }; }
    } else {
      const vw = Math.round(vp.clientWidth), vh = Math.round(vp.clientHeight);
      if (rg) {
        const x = Math.max(0, Math.round(rg.x)), y = Math.max(0, Math.round(rg.y));
        width = Math.min(Math.round(rg.width), vw - x); height = Math.min(Math.round(rg.height), vh - y);
        if (!(width > 0 && height > 0)) throw new Error("region超出畫面範圍（可視區 " + vw + "×" + vh + "）");
        params.clip = { x: vp.pageX + x, y: vp.pageY + y, width, height, scale };
        regionApplied = { x, y, width, height };
      } else { width = vw; height = vh; params.clip = { x: vp.pageX, y: vp.pageY, width, height, scale: 1 }; }
    }
    const shot = await send(tabId, "Page.captureScreenshot", params);
    return { data_url: "data:image/jpeg;base64," + shot.data, width, height, region_applied: regionApplied, url: tab.url || "", title: tab.title || "", note: "座標以這張圖的像素為準（左上角=0,0），可直接給 browser_mouse 的 x/y" };
  },

  async mouse(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    await keepPageFocused(tabId);
    const action = String(a.action || "click");
    const x = Number(a.x), y = Number(a.y);
    if (!isFinite(x) || !isFinite(y)) throw new Error("x、y 必須是數字（分頁可視區內的像素座標）");
    const button = ["left", "right", "middle"].includes(a.button) ? a.button : action === "right_click" ? "right" : "left";
    const modifiers = modMask(a.modifiers);
    if (action !== "wheel") {
      // 座標是分頁可視區的像素；在可視區外的話事件打不到元件（也有網頁會擋）。要點畫面外的元件請用 browser_click（selector／文字，會先捲進畫面），或先 browser_scroll。
      let v = null; try { const [vp] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ w: innerWidth, h: innerHeight }) }); v = vp && vp.result; } catch (_) { /* 受保護頁面讀不到就照原本送 */ }
      if (v && (x < 0 || y < 0 || x >= v.w || y >= v.h)) throw new Error("座標 (" + x + "," + y + ") 在可視區外（可視區 " + v.w + "×" + v.h + "）：請先 browser_scroll 把元件捲進畫面，或改用 browser_click（用 selector／文字，會自動捲到畫面中央再點）");
    }
    const ev = (type, extra) => send(tabId, "Input.dispatchMouseEvent", Object.assign({ type, x, y, button, modifiers }, extra));
    if (action === "move" || action === "hover") await ev("mouseMoved", { button: "none" });
    else if (action === "down") await ev("mousePressed", { clickCount: 1 });
    else if (action === "up") await ev("mouseReleased", { clickCount: 1 });
    else if (action === "wheel") await ev("mouseWheel", { deltaX: Number(a.delta_x) || 0, deltaY: Number(a.delta_y) || 0, button: "none" });
    else if (action === "drag") {
      const tx = Number(a.to_x), ty = Number(a.to_y);
      if (!isFinite(tx) || !isFinite(ty)) throw new Error("drag 需要 to_x、to_y");
      await ev("mouseMoved", { button: "none" });
      await ev("mousePressed", { clickCount: 1 });
      for (let i = 1; i <= 8; i++) {
        await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: x + ((tx - x) * i) / 8, y: y + ((ty - y) * i) / 8, button: "left", buttons: 1, modifiers });
      }
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: tx, y: ty, button: "left", clickCount: 1, modifiers });
    } else if (action === "click" || action === "right_click" || action === "double_click") {
      await ev("mouseMoved", { button: "none" });
      const n = action === "double_click" ? 2 : 1;
      for (let i = 1; i <= n; i++) {
        await ev("mousePressed", { clickCount: i });
        await ev("mouseReleased", { clickCount: i });
      }
    } else throw new Error("不支援的 action：" + action + "（click/double_click/right_click/move/down/up/wheel/drag）");
    if (action === "click" || action === "double_click" || action === "right_click") {
      // tw_stock_db客製: 2026-09-22——Redmine實測發現CDP的合成點擊不保證讓元素真的拿到焦點
      // （尤其是自訂元件），點完緊接著type_text常打不進去；點擊後額外補一次真正的.focus()。
      try {
        await chrome.scripting.executeScript({
          target: { tabId }, args: [x, y],
          func: (px, py) => { const el = document.elementFromPoint(px, py); if (el && typeof el.focus === "function") el.focus(); },
        });
      } catch (_) { /* 受保護頁面或無法注入時，點擊本身已送出，不阻擋結果 */ }
    }
    await sleep(150);
    return { ok: true, action, x, y };
  },

  // tw_stock_db客製: 2026-09-28——選擇器/文字點擊，不用每次先screenshot+get_elements算座標。
  // 對「同一種頁面模板、跑很多個網址」這種批次任務（例如逐一走訪很多個worksheet頁面各點一次
  // 下載）特別重要：同一個CSS selector在每個頁面都找得到對應元素，比每次重新截圖辨識座標
  // 快很多也穩很多。selector找不到/被selector排除掉不可見的元素時，回傳「找到幾個」讓AI
  // 判斷是selector寫錯還是頁面結構不同。點擊本身仍然透過CDP合成滑鼠事件（跟mouse()共用
  // 邏輯），是瀏覽器認證的「真實使用者手勢」，會觸發下載/彈窗等需要user gesture的行為。
  async click(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    await keepPageFocused(tabId);
    let out_dl = null;
    const selector = a.selector ? String(a.selector) : null;
    const text = a.text != null && a.text !== "" ? String(a.text) : null;
    const index = Number.isInteger(Number(a.index)) && Number(a.index) >= 0 ? Number(a.index) : 0;
    if (!selector && !text) throw new Error("selector與text至少要給一個");
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector, text, index],
      func: (selector, text, index) => {
        const CLICKABLE = 'a,button,label,input[type=submit],input[type=button],input[type=checkbox],input[type=radio],[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],summary,[onclick],[contenteditable=""],[contenteditable=true]';
        let list = selector ? Array.from(document.querySelectorAll(selector)) : Array.from(document.querySelectorAll(CLICKABLE));
        const totalBySelector = list.length;
        if (text) {
          const needle = text.toLowerCase();
          list = list.filter((el) => {
            const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").toLowerCase();
            return label.includes(needle);
          });
        }
        const visible = list.filter((el) => {
          const rect = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) !== 0;
        });
        const el = visible[index];
        if (!el) {
          return { error: "找不到符合的元素（selector=" + (selector || "(無)") + " text=" + (text || "(無)") + " index=" + index + "）：selector先比對到" + totalBySelector + "個，text篩選後" + list.length + "個，其中可見的有" + visible.length + "個", matched_by_selector: totalBySelector, matched_after_text_filter: list.length, visible_count: visible.length };
        }
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); // 先把元素捲到畫面中央：錄影看得到在做什麼，也避免網頁擋掉畫面外的事件
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: el.tagName.toLowerCase(), matched_text: (el.innerText || el.value || "").trim().slice(0, 120), visible_count: visible.length };
      },
    });
    const res = r && r.result;
    if (!res) throw new Error("無法在此頁面尋找元素（可能是受保護頁面）");
    if (res.error) throw new Error(res.error);
    await sleep(250); // scrollIntoView後讓版面穩定（也讓錄影看得到捲動後的畫面），避免座標算完、畫面又reflow導致點歪
    if (a.download_behavior) out_dl = await setDownloadBehavior(tabId, a.download_behavior, a.download_path);
    const sinceTs = Date.now(); // 一定要在真正點擊「之前」記下，避免下載在我們開始等待前就已完成的race condition
    const ev = (type, extra) => send(tabId, "Input.dispatchMouseEvent", Object.assign({ type, x: res.x, y: res.y, button: "left", modifiers: 0 }, extra));
    await ev("mouseMoved", { button: "none" });
    await ev("mousePressed", { clickCount: 1 });
    await ev("mouseReleased", { clickCount: 1 });
    await sleep(150);
    const out = { ok: true, x: res.x, y: res.y, tag: res.tag, clicked_text: res.matched_text, visible_count: res.visible_count };
    if (out_dl) out.download_behavior = out_dl;
    if (a.wait_download) out.download = await waitForNewDownload(a.download_timeout_ms, sinceTs, tabId);
    return out;
  },

  // 獨立的下載等待（例如下載是click之外的動作觸發的：例如按了Enter、或頁面延遲幾秒後自動觸發）。
  // since_ms選填：預設用「這次呼叫當下」當分界線，只等這之後才新建立的下載。
  async wait_download(a) {
    const since = Number.isFinite(Number(a.since_ms)) ? Number(a.since_ms) : Date.now();
    const tid = Number.isInteger(Number(a.tab_id)) && Number(a.tab_id) > 0 ? Number(a.tab_id) : null;
    return waitForNewDownload(a.timeout_ms, since, tid);
  },

  // capture 的位元組由網頁分段拉走：read_capture{id, offset, length}（每段最多 768 KB）→ { b64, offset, length, eof, size, crc32 }
  async read_capture(a) {
    const c = captures.get(String(a.id || ""));
    if (!c) throw new Error("找不到這個擷取（可能已釋放或超過保存時間）：" + a.id);
    if (!c.done) throw new Error("這個擷取還沒完成");
    if (c.error) throw new Error("擷取失敗：" + c.error);
    const off = Math.max(0, Math.floor(Number(a.offset) || 0)), len = Math.min(786432, Math.max(1, Math.floor(Number(a.length) || 786432)));
    const bytes = capSlice(c, off, len);
    return { id: c.id, offset: off, length: bytes.length, eof: off + bytes.length >= c.bytes, size: c.bytes, crc32: crcHex(c.crc), b64: bytesToB64(bytes) };
  },
  async release_capture(a) { const ok = captures.delete(String(a.id || "")); return { ok, released: String(a.id || "") }; },
  async list_captures(a) {
    const n = Math.max(1, Math.min(40, Number(a.max) || 10));
    return { captures: [...captures.values()].sort((x, y) => y.startTime - x.startTime).slice(0, n).map((c) => Object.assign(capInfo(c), { done: c.done, error: c.error, tab_id: c.tabId, age_ms: Date.now() - c.startTime })), total_bytes: capTotal() };
  },

  // 預先設定這個分頁的下載行為（之後這個分頁觸發的下載都照它處理，直到改回 default 或分頁關掉）。
  async set_download_behavior(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    return Object.assign({ ok: true }, await setDownloadBehavior(tabId, a.behavior || a.download_behavior, a.path || a.download_path));
  },

  // 除錯用：列出目前記得的最近下載（service worker重啟就會清空，不是長期歷史）。
  async list_downloads(a) {
    const n = Math.max(1, Math.min(40, Number(a.max) || 10));
    return { downloads: recentDownloads.slice(0, n).map((d) => Object.assign(downloadInfo(d), { state: d.state, started_ms_ago: Date.now() - d.startTime })) };
  },

  async type_text(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    await keepPageFocused(tabId);
    const text = String(a.text == null ? "" : a.text);
    // 輸入前先把目標元件捲到畫面中央（錄影看得到在打哪裡；有的網頁也會擋畫面外的事件）。
    // 有 selector 就用它；沒有就用目前拿到焦點的元件（例如剛點擊過的輸入框）。
    {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId }, args: [a.selector ? String(a.selector) : null],
        func: (sel) => {
          const el = sel ? document.querySelector(sel) : document.activeElement;
          if (sel && !el) return { found: false };
          if (el && el !== document.body && el !== document.documentElement) {
            el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            if (sel) el.focus({ preventScroll: true });
          }
          return { found: true };
        },
      });
      if (a.selector && (!r || !r.result || !r.result.found)) throw new Error("找不到 selector：" + a.selector);
      await sleep(200);
    }
    if (a.clear) {
      await pressKey(tabId, "a", ["ctrl"]);
      await pressKey(tabId, "Backspace", []);
    }
    if (text) await send(tabId, "Input.insertText", { text });
    if (a.submit) await pressKey(tabId, "Enter", []);
    return { ok: true, typed_chars: text.length, submitted: !!a.submit };
  },

  async press_key(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    await keepPageFocused(tabId);
    const key = String(a.key || "");
    if (!key) throw new Error("缺少 key（例如 Enter、Tab、Escape、ArrowDown、a）");
    await pressKey(tabId, key, Array.isArray(a.modifiers) ? a.modifiers : []);
    return { ok: true, key, modifiers: a.modifiers || [] };
  },

  async get_page_text(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    // 頁面內只抓一次「完整」文字（上限50萬字元防止極端病態頁面），真正
    // 分頁交回background.js做（見上面pageText），不在注入的頁面腳本裡
    // 重複實作一份分頁邏輯。
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const t = (document.body && document.body.innerText) || "";
        return { url: location.href, title: document.title, full_text: t.slice(0, 500000), scroll_y: Math.round(window.scrollY), scroll_height: document.documentElement.scrollHeight, viewport_height: window.innerHeight };
      },
    });
    if (!r || !r.result) throw new Error("無法讀取此頁面（可能是受保護頁面）");
    const { full_text, ...meta } = r.result;
    const page = pageText(full_text, { offset: a.offset, maxChars: a.max_chars, startLine: a.start_line, maxLines: a.max_lines });
    return Object.assign(meta, { text: page.text, offset: page.offset, returned_chars: page.returned_chars, total_chars: page.total_chars, start_line: page.start_line, end_line: page.end_line, has_more: page.has_more, next_offset: page.next_offset, page_hint: page.page_hint });
  },

  async get_page_structure(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    // tw_stock_db客製: 2026-09-22使用者要求——原本這裡的limit是「這次呼叫
    // 最多回傳幾個字元」，用來在頁面腳本裡邊組字串邊截斷；改成分頁模式後
    // 頁面腳本要先組出「完整」markdown（上限30萬字元防病態頁面），實際
    // 分頁交回background.js的pageText統一處理（跟get_page_text同一套）。
    const limit = 300000;
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, args: [limit],
      func: (limit) => {
        const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "TEMPLATE", "CANVAS"]);
        const CHROME_REGIONS = new Set(["NAV", "FOOTER", "ASIDE", "HEADER"]);
        const root = document.querySelector("main,[role=main],article") || document.body;
        const usingBody = root === document.body;
        const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
        const visible = (el) => { const st = getComputedStyle(el); return st.display !== "none" && st.visibility !== "hidden"; };
        const headings = [], tables = [], skippedRegions = [];
        let out = "", truncated = false;
        const push = (s) => { if (out.length >= limit) { truncated = true; return; } out += s; };
        function inline(el) {
          let s = "";
          for (const n of el.childNodes) {
            if (n.nodeType === 3) { s += n.nodeValue; continue; }
            if (n.nodeType !== 1 || SKIP.has(n.tagName) || !visible(n)) continue;
            const t = n.tagName;
            const inner = inline(n);
            if (t === "A") { const h = n.href || ""; const c = clean(inner); s += c && /^https?:/i.test(h) ? "[" + c + "](" + h + ")" : inner; }
            else if (t === "STRONG" || t === "B") s += clean(inner) ? "**" + clean(inner) + "**" : "";
            else if (t === "CODE") s += clean(inner) ? "`" + clean(inner) + "`" : "";
            else if (t === "BR") s += " ";
            else if (t === "IMG") s += n.alt ? "[圖: " + clean(n.alt) + "]" : "";
            else s += inner;
          }
          return s;
        }
        const blockTags = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "UL", "OL", "LI", "TABLE", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "FORM", "DL", "FIGURE", "DETAILS", "HEADER", "FOOTER", "NAV", "ASIDE"]);
        function table(el) {
          const rows = [...el.querySelectorAll("tr")].slice(0, 40).map((tr) => [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH").map((c) => clean(c.innerText).slice(0, 80)));
          if (!rows.length) return;
          const headerRow = el.querySelector("thead tr") || (el.querySelector("tr th") ? el.querySelector("tr") : null);
          const headers = headerRow ? [...headerRow.children].map((c) => clean(c.innerText).slice(0, 80)) : [];
          const body = headers.length ? rows.slice(1) : rows;
          const cap = el.querySelector("caption");
          tables.push({ caption: cap ? clean(cap.innerText) : "", headers, rows: body, row_count: el.querySelectorAll("tr").length });
          const w = Math.max(...rows.map((r) => r.length));
          const line = (r) => "| " + Array.from({ length: w }, (_, i) => r[i] || "").join(" | ") + " |";
          push("\n" + line(headers.length ? headers : rows[0]) + "\n| " + Array.from({ length: w }, () => "---").join(" | ") + " |\n");
          for (const r of headers.length ? rows.slice(1) : rows.slice(1)) push(line(r) + "\n");
          push("\n");
        }
        function walk(el) {
          let buf = "";
          const flush = () => { const t = clean(buf); if (t) push(t + "\n\n"); buf = ""; };
          for (const n of el.childNodes) {
            if (out.length >= limit) { truncated = true; return; }
            if (n.nodeType === 3) { buf += n.nodeValue; continue; }
            if (n.nodeType !== 1 || SKIP.has(n.tagName) || !visible(n)) continue;
            const t = n.tagName;
            if (usingBody && CHROME_REGIONS.has(t)) { flush(); skippedRegions.push(t.toLowerCase() + (n.id ? "#" + n.id : "")); continue; }
            if (/^H[1-6]$/.test(t)) { flush(); const text = clean(inline(n)); if (text) { headings.push({ level: Number(t[1]), text: text.slice(0, 120) }); push("#".repeat(Number(t[1])) + " " + text + "\n\n"); } }
            else if (t === "UL" || t === "OL") { flush(); let i = 0; for (const li of n.children) { if (li.tagName !== "LI" || !visible(li)) continue; i++; const text = clean(inline(li)).slice(0, 400); if (text) push((t === "OL" ? i + ". " : "- ") + text + "\n"); } push("\n"); }
            else if (t === "TABLE") { flush(); table(n); }
            else if (t === "PRE") { flush(); push("```\n" + (n.innerText || "").slice(0, 2000) + "\n```\n\n"); }
            else if (t === "BLOCKQUOTE") { flush(); const text = clean(inline(n)); if (text) push("> " + text + "\n\n"); }
            else if (t === "FORM") { flush(); }
            else if (blockTags.has(t)) { flush(); walk(n); }
            else buf += inline({ childNodes: [n] });
          }
          flush();
        }
        walk(root);
        const seen = new Set(), links = [];
        for (const a of root.querySelectorAll("a[href]")) {
          if (!/^https?:/i.test(a.href) || seen.has(a.href) || !visible(a)) continue;
          const text = clean(a.innerText || a.getAttribute("aria-label"));
          if (!text) continue;
          seen.add(a.href);
          links.push({ text: text.slice(0, 80), href: a.href.slice(0, 200) });
          if (links.length >= 80) break;
        }
        const forms = [...document.forms].slice(0, 5).map((f) => ({
          action: (f.action || "").slice(0, 150), method: (f.method || "get").toLowerCase(),
          fields: [...f.elements].filter((e) => e.name || e.id).slice(0, 30).map((e) => {
            const lab = e.labels && e.labels[0] ? clean(e.labels[0].innerText) : "";
            const o = { tag: e.tagName.toLowerCase(), type: e.type || undefined, name: e.name || e.id, label: lab || undefined, placeholder: e.placeholder || undefined, required: e.required || undefined };
            if (e.tagName === "SELECT") o.options = [...e.options].slice(0, 10).map((x) => clean(x.text));
            return o;
          }),
        }));
        // tw_stock_db客製: 2026-09-22使用者要求——原本圖片只在inline()裡
        // 收斂成"[圖: alt]"文字，圖片本身的URL整個遺失，沒辦法接著讓vision
        // model解讀圖片內容。額外收集頁面上實際看得到的圖片URL清單（跟
        // links同一種篩選邏輯：可視、去重、有上限），呼叫端（floating-
        // assistant.js的browser_get_page_structure工具）如果想要圖文穿插
        // 解讀，就是靠這個images清單逐一叫interpret_image。
        const seenImg = new Set(), images = [];
        for (const img of root.querySelectorAll("img[src]")) {
          const src = img.currentSrc || img.src || "";
          if (!/^https?:/i.test(src) || seenImg.has(src) || !visible(img)) continue;
          const r2 = img.getBoundingClientRect();
          if (r2.width < 32 || r2.height < 32) continue; // 濾掉小圖示/追蹤像素
          seenImg.add(src);
          images.push({ src: src.slice(0, 300), alt: clean(img.alt).slice(0, 150) });
          if (images.length >= 30) break;
        }
        const md = document.querySelector('meta[name="description"]');
        return { url: location.href, title: document.title, lang: document.documentElement.lang || undefined, description: md ? md.content : undefined, content_root: usingBody ? "body" : root.tagName.toLowerCase(), skipped_regions: skippedRegions.slice(0, 8), headings: headings.slice(0, 60), markdown: out.trim(), tables: tables.slice(0, 10), links, images, forms, scroll_y: Math.round(window.scrollY), scroll_height: document.documentElement.scrollHeight };
      },
    });
    if (!r || !r.result) throw new Error("無法讀取此頁面（可能是受保護頁面）");
    const { markdown, ...rest } = r.result;
    const page = pageText(markdown, { offset: a.offset, maxChars: a.max_chars, startLine: a.start_line, maxLines: a.max_lines });
    return Object.assign(rest, { markdown: page.text, offset: page.offset, returned_chars: page.returned_chars, total_chars: page.total_chars, start_line: page.start_line, end_line: page.end_line, has_more: page.has_more, next_offset: page.next_offset, page_hint: page.page_hint });
  },

  async get_elements(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    const max = Math.min(Math.max(Number(a.max) || 60, 5), 200);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, args: [max, a.viewport_only !== false],
      func: (limit, viewportOnly) => {
        const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick],[contenteditable=""],[contenteditable=true]';
        const out = [];
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
          const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
          if (viewportOnly && !inView) continue;
          const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.alt || "").trim().replace(/\s+/g, " ").slice(0, 80);
          out.push({ tag: el.tagName.toLowerCase(), type: el.type || undefined, text: label, href: el.tagName === "A" ? el.href.slice(0, 120) : undefined, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), in_viewport: inView });
          if (out.length >= limit) break;
        }
        return { elements: out, viewport: { width: innerWidth, height: innerHeight }, note: "x、y 是元素中心點（分頁可視區像素），可直接給 browser_mouse" };
      },
    });
    if (!r || !r.result) throw new Error("無法讀取此頁面（可能是受保護頁面）");
    return r.result;
  },
};

function modMask(mods) {
  const list = Array.isArray(mods) ? mods : typeof mods === "string" && mods ? mods.split("+") : [];
  let m = 0;
  for (const x of list.map((s) => String(s).toLowerCase())) {
    if (x === "alt") m |= 1;
    else if (x === "ctrl" || x === "control") m |= 2;
    else if (x === "meta" || x === "cmd" || x === "command") m |= 4;
    else if (x === "shift") m |= 8;
  }
  return m;
}
const NAMED_KEYS = {
  Enter: { vk: 13, code: "Enter", text: "\r" }, Tab: { vk: 9, code: "Tab" }, Escape: { vk: 27, code: "Escape" },
  Backspace: { vk: 8, code: "Backspace" }, Delete: { vk: 46, code: "Delete" }, Space: { vk: 32, code: "Space", text: " ", key: " " },
  ArrowUp: { vk: 38, code: "ArrowUp" }, ArrowDown: { vk: 40, code: "ArrowDown" }, ArrowLeft: { vk: 37, code: "ArrowLeft" }, ArrowRight: { vk: 39, code: "ArrowRight" },
  Home: { vk: 36, code: "Home" }, End: { vk: 35, code: "End" }, PageUp: { vk: 33, code: "PageUp" }, PageDown: { vk: 34, code: "PageDown" },
};
const EDIT_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };
async function pressKey(tabId, key, mods) {
  const modifiers = modMask(mods);
  let def = NAMED_KEYS[key] || NAMED_KEYS[key.charAt(0).toUpperCase() + key.slice(1)];
  if (!def) {
    if (key.length !== 1) throw new Error("不認得的按鍵：" + key);
    const up = key.toUpperCase();
    def = { vk: up.charCodeAt(0), code: /[a-z]/i.test(key) ? "Key" + up : /\d/.test(key) ? "Digit" + key : "", text: key };
  }
  const withText = def.text && !(modifiers & 6);
  const base = { modifiers, key: def.key || (def.text === "\r" ? "Enter" : key.length === 1 ? key : key), code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk };
  const cmd = modifiers & 6 && key.length === 1 ? EDIT_COMMANDS[key.toLowerCase()] : null;
  // tw_stock_db客製: 2026-09-22——Redmine實測發現keyDown事件本身帶text參數時，Chrome有時會
  // 連同後續的char事件一起插入文字，造成重複輸入（"test"變"tteesstt"）；改成rawKeyDown（不帶
  // text）+ 單獨的char事件（只有它帶text）+ keyUp，文字只在char事件出現一次，不會重複。
  await send(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "rawKeyDown" }, base, cmd ? { commands: [cmd] } : {}));
  if (withText) await send(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "char", text: def.text }, base));
  await send(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
}

async function exec(cmd, args) {
  const fn = commands[cmd];
  if (!fn) return { ok: false, error: "未知的指令：" + cmd };
  const ctx = {};
  try {
    const r = await fn(args || {}, ctx);
    const out = Object.assign({ ok: true }, r);
    if (ctx.recovered) {
      out.tab_recovered = ctx.recovered;
      out.recovery_note = "找不到指定的分頁，已自動在「" + AI_GROUP_TITLE + "」群組開了新分頁（tab_id=" + ctx.recovered.new_tab_id + "），後續請用這個 tab_id。";
    }
    return out;
  }
  catch (err) {
    const out = { ok: false, error: String((err && err.message) || err) };
    if (ctx.recovered) { out.tab_recovered = ctx.recovered; out.recovery_note = "指定的分頁不存在，已在「" + AI_GROUP_TITLE + "」群組開了新的空白分頁（tab_id=" + ctx.recovered.new_tab_id + "），請先用 browser_navigate 前往網址再操作。"; }
    return out;
  }
}

// ---------- 入口 1：網頁版（content-bridge.js） ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.kind !== "bc" || sender.id !== chrome.runtime.id) return;
  (async () => {
    let origin = "";
    try { origin = sender.origin || new URL(sender.url).origin; } catch (_) {}
    const cfg = await getCfg();
    const allowed = cfg.allowedOrigins.includes(origin);
    if (msg.cmd === "ping") {
      const r = await exec("ping", {});
      return Object.assign(r, { allowed, origin, note: allowed ? undefined : "擴充功能已安裝，但這個網站還沒被允許。請點瀏覽器工具列上的擴充功能圖示，按「允許目前網站」。" });
    }
    if (!allowed) return { ok: false, error: "NOT_ALLOWED", origin, note: "這個網站還沒被允許控制瀏覽器。請點擴充功能圖示，按「允許目前網站」。" };
    return exec(msg.cmd, msg.args);
  })().then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

// ---------- 入口 2：桌面版（輪詢本機服務） ----------
const desktop = { polling: false, connected: false, lastOk: 0, error: "" };
async function pollDesktop() {
  if (desktop.polling) return;
  desktop.polling = true;
  try {
    for (;;) {
      const cfg = await getCfg();
      if (!cfg.desktopEnabled || !cfg.desktopToken) { desktop.connected = false; desktop.error = cfg.desktopToken ? "已停用" : "尚未填入配對碼"; return; }
      const base = `http://127.0.0.1:${cfg.desktopPort}/bc`;
      const headers = { "X-FA-Token": cfg.desktopToken };
      let job = null;
      try {
        const res = await fetch(`${base}/poll?wait=20000&v=${VERSION}`, { headers });
        if (res.status === 401) { desktop.connected = false; desktop.error = "配對碼不正確"; await sleep(5000); continue; }
        if (!res.ok) throw new Error("HTTP " + res.status);
        desktop.connected = true; desktop.lastOk = Date.now(); desktop.error = "";
        if (res.status === 200) job = await res.json();
      } catch (err) {
        desktop.connected = false; desktop.error = "連不到桌面 app（" + String((err && err.message) || err) + "）";
        await sleep(4000);
        continue;
      }
      if (job && job.id) {
        const result = await exec(job.cmd, job.args);
        try { await fetch(`${base}/result`, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers), body: JSON.stringify({ id: job.id, result }) }); }
        catch (_) {}
      }
      await chrome.storage.local.get("desktopPort");
    }
  } finally { desktop.polling = false; }
}
chrome.alarms.create("fa-poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((al) => { if (al.name === "fa-poll") pollDesktop(); });
chrome.runtime.onStartup.addListener(pollDesktop);
chrome.runtime.onInstalled.addListener(pollDesktop);
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.desktopToken || ch.desktopPort || ch.desktopEnabled)) pollDesktop(); });
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.kind === "popup-status" && sender.id === chrome.runtime.id) { pollDesktop(); sendResponse({ desktop: { connected: desktop.connected, error: desktop.error, lastOk: desktop.lastOk }, version: VERSION }); }
});
pollDesktop();
