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
const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
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

async function needTab(a) {
  const tabId = Number(a && a.tab_id);
  if (!Number.isInteger(tabId)) throw new Error("缺少 tab_id（先用 browser_create_tab / browser_list_tabs 取得）");
  const m = await getManaged();
  if (!m.tabs.has(tabId)) throw new Error(`分頁 ${tabId} 不是由助理建立的，基於安全考量不能操作。請用 browser_create_tab 開一個新分頁。`);
  try { return { tabId, tab: await chrome.tabs.get(tabId) }; }
  catch (_) { await unmarkTab(tabId); throw new Error(`分頁 ${tabId} 已經被關閉`); }
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

async function createTabInGroup(url, groupSpec, active) {
  const windowId = await targetWindowId();
  const tab = await chrome.tabs.create({ url: normUrl(url), active: !!active, windowId });
  await markTab(tab.id);
  let groupId = null;
  if (groupSpec) {
    const m = await getManaged();
    if (groupSpec.group_id != null && m.groups[String(groupSpec.group_id)] != null) groupId = Number(groupSpec.group_id);
    else if (groupSpec.group_title) {
      for (const [gid, title] of Object.entries(m.groups)) {
        if (title === groupSpec.group_title) {
          try { await chrome.tabGroups.get(Number(gid)); groupId = Number(gid); break; } catch (_) {}
        }
      }
    }
  }
  if (groupId != null) await chrome.tabs.group({ tabIds: [tab.id], groupId });
  return { tab, groupId };
}

const commands = {
  async ping() {
    return { version: VERSION, browser: navigator.userAgent };
  },

  async tab_group_create(a) {
    const title = String(a.title || "AI").slice(0, 60);
    const color = GROUP_COLORS.includes(a.color) ? a.color : "blue";
    const urls = Array.isArray(a.urls) && a.urls.length ? a.urls : [a.url || "about:blank"];
    const windowId = await targetWindowId();
    const tabIds = [];
    for (let i = 0; i < Math.min(urls.length, 20); i++) {
      const t = await chrome.tabs.create({ url: normUrl(urls[i]), active: i === 0 && !!a.active, windowId });
      await markTab(t.id);
      tabIds.push(t.id);
    }
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title, color, collapsed: false });
    const m = await getManaged();
    m.groups[String(groupId)] = title;
    await saveManaged(m);
    if (a.wait !== false) await Promise.all(tabIds.map((id) => waitLoad(id, 15000)));
    const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id).then(tabInfo)));
    return { group_id: groupId, title, color, tabs };
  },

  async tab_create(a) {
    const { tab, groupId } = await createTabInGroup(a.url, { group_id: a.group_id, group_title: a.group_title }, a.active);
    if (a.wait !== false) await waitLoad(tab.id, 15000);
    const t = await chrome.tabs.get(tab.id);
    return Object.assign(tabInfo(t), { group_id: groupId, note: groupId == null && (a.group_id != null || a.group_title) ? "找不到指定的分頁群組，已建立獨立分頁（請先用 browser_create_tab_group 建立群組）" : undefined });
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
    const { tabId } = await needTab(a);
    await chrome.tabs.remove(tabId);
    await unmarkTab(tabId);
    return { closed: 1 };
  },

  async tab_navigate(a) {
    const { tabId } = await needTab(a);
    if (a.action === "back") await chrome.tabs.goBack(tabId);
    else if (a.action === "forward") await chrome.tabs.goForward(tabId);
    else if (a.action === "reload") await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url: normUrl(a.url) });
    if (a.wait !== false) { await sleep(200); await waitLoad(tabId, 15000); }
    return tabInfo(await chrome.tabs.get(tabId));
  },

  async tab_activate(a) {
    const { tabId, tab } = await needTab(a);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tabInfo(await chrome.tabs.get(tabId));
  },

  async scroll(a) {
    const { tabId } = await needTab(a);
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

  async screenshot(a) {
    const { tabId } = await needTab(a);
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

  async mouse(a) {
    const { tabId } = await needTab(a);
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
    await sleep(150);
    return { ok: true, action, x, y };
  },

  async type_text(a) {
    const { tabId } = await needTab(a);
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

  async press_key(a) {
    const { tabId } = await needTab(a);
    await dbg(tabId);
    const key = String(a.key || "");
    if (!key) throw new Error("缺少 key（例如 Enter、Tab、Escape、ArrowDown、a）");
    await pressKey(tabId, key, Array.isArray(a.modifiers) ? a.modifiers : []);
    return { ok: true, key, modifiers: a.modifiers || [] };
  },

  async get_page_text(a) {
    const { tabId } = await needTab(a);
    const max = Math.min(Math.max(Number(a.max_chars) || 12000, 500), 100000);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, args: [max],
      func: (limit) => {
        const t = (document.body && document.body.innerText) || "";
        return { url: location.href, title: document.title, text: t.slice(0, limit), total_chars: t.length, truncated: t.length > limit, scroll_y: Math.round(window.scrollY), scroll_height: document.documentElement.scrollHeight, viewport_height: window.innerHeight };
      },
    });
    if (!r || !r.result) throw new Error("無法讀取此頁面（可能是受保護頁面）");
    return r.result;
  },

  async get_elements(a) {
    const { tabId } = await needTab(a);
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
  await send(tabId, "Input.dispatchKeyEvent", Object.assign({ type: withText ? "keyDown" : "rawKeyDown" }, base, withText ? { text: def.text } : {}, cmd ? { commands: [cmd] } : {}));
  await send(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
}

async function exec(cmd, args) {
  const fn = commands[cmd];
  if (!fn) return { ok: false, error: "未知的指令：" + cmd };
  try { return Object.assign({ ok: true }, await fn(args || {})); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
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
