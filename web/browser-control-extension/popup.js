const $ = (id) => document.getElementById(id);
let curOrigin = "";

async function refresh() {
  const cfg = await chrome.storage.local.get({ allowedOrigins: [], desktopToken: "", desktopPort: 17923 });
  $("token").value = cfg.desktopToken;
  $("port").value = cfg.desktopPort;
  const ul = $("allowed");
  ul.textContent = "";
  for (const o of cfg.allowedOrigins) {
    const li = document.createElement("li");
    const s = document.createElement("span"); s.textContent = o;
    const b = document.createElement("button"); b.textContent = "移除";
    b.onclick = async () => { await setAllowed(o, false); };
    li.append(s, b);
    ul.append(li);
  }
  const on = curOrigin && cfg.allowedOrigins.includes(curOrigin);
  $("toggle").textContent = on ? "取消允許目前網站" : "允許目前網站";
  $("toggle").disabled = !curOrigin;
  $("cur").textContent = curOrigin || "（目前分頁不是一般網頁）";
}

async function setAllowed(origin, allow) {
  const cfg = await chrome.storage.local.get({ allowedOrigins: [] });
  const set = new Set(cfg.allowedOrigins);
  if (allow) set.add(origin); else set.delete(origin);
  await chrome.storage.local.set({ allowedOrigins: [...set] });
  await refresh();
}

async function showStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ kind: "popup-status" });
    $("ver").textContent = "版本 " + r.version;
    const d = r.desktop;
    $("dstatus").innerHTML = d.connected ? '<span class="ok">● 已連線到桌面版</span>' : '<span class="bad">● 未連線</span>' + (d.error ? "：" + d.error.replace(/[<>&]/g, "") : "");
  } catch (_) {}
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol)) curOrigin = u.origin; } catch (_) {}
  await refresh();
  $("toggle").onclick = async () => {
    const cfg = await chrome.storage.local.get({ allowedOrigins: [] });
    await setAllowed(curOrigin, !cfg.allowedOrigins.includes(curOrigin));
  };
  $("save").onclick = async () => {
    await chrome.storage.local.set({ desktopToken: $("token").value.trim(), desktopPort: Number($("port").value) || 17923, desktopEnabled: true });
    setTimeout(showStatus, 800);
  };
  showStatus();
  setInterval(showStatus, 2000);
})();
