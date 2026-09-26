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

const VERSION = "1.0.0";
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
chrome.tabs.onRemoved.addListener((tabId) => {
  unmarkTab(tabId);
  attached.delete(tabId);
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
chrome.debugger.onDetach.addListener((src) => { if (src.tabId != null) attached.delete(src.tabId); });
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
async function ensureForeground(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) { /* 視窗可能已關閉或無法取得焦點，不阻擋後續操作 */ }
    await sleep(200);
  }
  return tab;
}

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
async function createAiTab(url, active) {
  const existing = await findAiGroup();
  const windowId = existing ? existing.windowId : await targetWindowId();
  const tab = await chrome.tabs.create({ url: normUrl(url), active: !!active, windowId });
  await markTab(tab.id);
  const groupId = await placeInAiGroup([tab.id], windowId);
  return { tab, groupId };
}

const commands = {
  async ping() {
    return { version: VERSION, browser: navigator.userAgent };
  },

  async tab_group_create(a) {
    const urls = Array.isArray(a.urls) && a.urls.length ? a.urls : [a.url || "about:blank"];
    const tabIds = [];
    let groupId = null;
    for (let i = 0; i < Math.min(urls.length, 20); i++) {
      const r = await createAiTab(urls[i], i === 0 && !!a.active);
      tabIds.push(r.tab.id);
      groupId = r.groupId;
    }
    if (a.wait !== false) await Promise.all(tabIds.map((id) => waitLoad(id, 15000)));
    const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id).then(tabInfo)));
    return { group_id: groupId, title: AI_GROUP_TITLE, tabs, note: "所有助理開的分頁都放在同一個「" + AI_GROUP_TITLE + "」分頁群組（已存在就直接加進去）" };
  },

  async tab_create(a) {
    const { tab, groupId } = await createAiTab(a.url, a.active);
    if (a.wait !== false) await waitLoad(tab.id, 15000);
    return Object.assign(tabInfo(await chrome.tabs.get(tab.id)), { group_id: groupId, group_title: AI_GROUP_TITLE });
  },

  async tab_list() {
    const m = await getManaged();
    const out = [];
    for (const id of [...m.tabs]) {
      try { out.push(tabInfo(await chrome.tabs.get(id))); } catch (_) { m.tabs.delete(id); }
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
      return { closed: tabs.length };
    }
    const tabId = Number(a.tab_id);
    const m = await getManaged();
    if (!Number.isInteger(tabId) || !m.tabs.has(tabId)) return { closed: 0, note: "這個分頁已經不存在或不是助理開的，不需要關閉" };
    try { await chrome.tabs.remove(tabId); } catch (_) {}
    await unmarkTab(tabId);
    return { closed: 1 };
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

  async tab_activate(a, ctx) {
    const { tabId, tab } = await needTab(a, ctx);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
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
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(250);
    }
    await dbg(tabId);
    const m = await send(tabId, "Page.getLayoutMetrics");
    const vp = m.cssVisualViewport || m.visualViewport;
    const params = { format: "jpeg", quality: Math.min(95, Math.max(30, Number(a.quality) || 70)) };
    let width, height;
    // 2026-09-26：region={x,y,width,height}只截指定範圍（非full_page時座標是可視區像素、
    // 左上角0,0，跟browser_mouse/browser_get_elements同一套；full_page時是整頁座標），
    // scale(1~3)放大。回傳region_applied讓呼叫端確認這個版本真的支援。
    const rg = a.region && typeof a.region === "object" ? a.region : null;
    if (rg && Number(rg.width) > 0 && Number(rg.height) > 0) {
      const scale = Math.min(3, Math.max(1, Number(a.scale) || 1));
      const rx = Math.max(0, Number(rg.x) || 0), ry = Math.max(0, Number(rg.y) || 0);
      const rw = Math.round(Number(rg.width)), rh = Math.min(Math.round(Number(rg.height)), 8000);
      if (a.full_page) params.captureBeyondViewport = true;
      params.clip = { x: a.full_page ? rx : vp.pageX + rx, y: a.full_page ? ry : vp.pageY + ry, width: rw, height: rh, scale };
      const shot = await send(tabId, "Page.captureScreenshot", params);
      return { data_url: "data:image/jpeg;base64," + shot.data, width: Math.round(rw * scale), height: Math.round(rh * scale), region_applied: { x: rx, y: ry, width: rw, height: rh, scale }, url: tab.url || "", title: tab.title || "", note: "這是指定範圍的截圖（已套用scale），圖內座標=(該點-region左上角)*scale，跟原分頁座標不同，點擊請用原分頁座標" };
    }
    if (a.full_page) {
      const cs = m.cssContentSize || m.contentSize;
      width = Math.round(cs.width);
      height = Math.min(Math.round(cs.height), 8000);
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    } else {
      width = Math.round(vp.clientWidth);
      height = Math.round(vp.clientHeight);
      params.clip = { x: vp.pageX, y: vp.pageY, width, height, scale: 1 };
    }
    const shot = await send(tabId, "Page.captureScreenshot", params);
    return { data_url: "data:image/jpeg;base64," + shot.data, width, height, url: tab.url || "", title: tab.title || "", note: "座標以這張圖的像素為準（左上角=0,0），可直接給 browser_mouse 的 x/y" };
  },

  async mouse(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    await ensureForeground(tabId);
    await dbg(tabId);
    const action = String(a.action || "click");
    const x = Number(a.x), y = Number(a.y);
    if (!isFinite(x) || !isFinite(y)) throw new Error("x、y 必須是數字（分頁可視區內的像素座標）");
    const button = ["left", "right", "middle"].includes(a.button) ? a.button : action === "right_click" ? "right" : "left";
    const modifiers = modMask(a.modifiers);
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

  async type_text(a, ctx) {
    const { tabId } = await needTab(a, ctx);
    await ensureForeground(tabId);
    await dbg(tabId);
    const text = String(a.text == null ? "" : a.text);
    if (a.selector) {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId }, args: [String(a.selector)],
        func: (sel) => { const el = document.querySelector(sel); if (!el) return false; el.focus(); return true; },
      });
      if (!r || !r.result) throw new Error("找不到 selector：" + a.selector);
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
    await ensureForeground(tabId);
    await dbg(tabId);
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
