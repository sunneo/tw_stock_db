// 最小 CDP 驅動（Node 22 內建 WebSocket）。用法：require('./cdp').connect(port)
const fs = require('fs');
async function connect(port, pick) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pick ? list.find(pick) : (list.find((t) => t.type === "page" && /renderer\/index\.html/.test(t.url)) || list.find((t) => t.type === "page"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const ctxs = []; const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const [res, rej] = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else if (m.method === 'Runtime.executionContextCreated') ctxs.push(m.params.context);
    else if (m.method === 'Runtime.executionContextDestroyed') { const i = ctxs.findIndex((c) => c.id === m.params.executionContextId); if (i >= 0) ctxs.splice(i, 1); }
    listeners.forEach((f) => f(m));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, [res, rej]); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable').catch(() => {});
  const evalIn = async (expr, contextId) => {
    const r = await send('Runtime.evaluate', Object.assign({ expression: expr, awaitPromise: true, returnByValue: true }, contextId ? { contextId } : {}));
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const frameTree = async () => (await send('Page.getFrameTree')).frameTree;
  const ctxForFrame = async (frameId) => { // 等 iframe 的執行環境出現
    for (let i = 0; i < 100; i++) { const c = ctxs.find((x) => x.auxData && x.auxData.frameId === frameId && x.auxData.type === 'default' || (x.auxData && x.auxData.frameId === frameId)); if (c) return c.id; await new Promise((r) => setTimeout(r, 200)); }
    return null;
  };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  const click = async (x, y) => { // 真的滑鼠事件（經 CDP Input），不是 DOM click()
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  };
  const key = async (text) => { for (const t of text) { await send('Input.dispatchKeyEvent', { type: 'keyDown', text: t, key: t }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: t }); } };
  return { send, evalIn, frameTree, ctxForFrame, shot, click, key, ctxs, ws, listeners, close: () => ws.close() };
}
module.exports = { connect };
