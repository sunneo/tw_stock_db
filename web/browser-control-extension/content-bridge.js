// 網頁版 Floating AI Assistant 跟擴充功能之間的橋：頁面用 window.postMessage 送請求，
// 這裡轉給 background.js，回應再 postMessage 回頁面。是否允許由 background.js 依
// 「允許的網站清單」判斷（使用者在擴充功能的彈出視窗裡明確加入才會放行）。
(() => {
  if (window.top !== window) return;
  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "fa-bc-page" || d.type !== "req" || typeof d.id !== "string") return;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ kind: "bc", cmd: String(d.cmd || ""), args: d.args && typeof d.args === "object" ? d.args : {} });
    } catch (err) {
      res = { ok: false, error: "無法連到擴充功能背景程式：" + String((err && err.message) || err) };
    }
    window.postMessage(Object.assign({ source: "fa-bc-ext", type: "res", id: d.id }, res || { ok: false, error: "沒有回應" }), location.origin);
  });
})();
