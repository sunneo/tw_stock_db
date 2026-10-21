// 真 Chrome 驗證：擴充功能 capture ＋ 助理端管線（需要本機 Chrome；用 Playwright 附的 Node 24 執行：.../playwright/driver/node.exe 這個檔案）
// 把真正的 background.js 放進 vm（chrome 以代理假造），除錯器指令轉到真的 Chrome（遠端除錯），驗證 capture 全流程
const fs = require('fs'), vm = require('vm'), http = require('http'), crypto = require('crypto'), cp = require('child_process'), os = require('os'), path = require('path');
const SRC = 'D:/Downloads/videos-嗨投資/web/browser-control-extension/background.js';
const DATA = crypto.randomBytes(900000), want = crypto.createHash('sha256').update(DATA).digest('hex');

const srv = http.createServer((req, res) => {
  if (req.url === '/') { const b = '<a id=a href="/file.bin">dl</a><form method=post action="/post.bin"><button id=f>post</button></form><button id=bl>blob</button><button id=dt>data</button><a id=pdf href="/doc.html">html</a><script>bl.onclick=function(){var a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["blob-content-123"]));a.download="made.txt";document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href)},50)};dt.onclick=function(){var a=document.createElement("a");a.href="data:text/plain;base64,aGVsbG8gZGF0YQ==";a.download="d.txt";document.body.appendChild(a);a.click()}</script>'; res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(b); }
  if (req.url === '/doc.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<p>normal page</p>'); }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + (req.url.includes('post') ? 'posted' : 'data') + '.bin"', 'Content-Length': DATA.length });
  req.resume(); res.end(DATA);
}).listen(0);

(async () => {
  const port = srv.address().port, dbgPort = 9555, prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cap_prof_'));
  const chrome = cp.spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=' + dbgPort, '--user-data-dir=' + prof, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 50; i++) { try { ver = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/version')).json(); break; } catch (_) { await new Promise((r) => setTimeout(r, 300)); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(), listeners = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const { res, rej } = pend.get(d.id); pend.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result || {}); } else if (d.method) listeners.forEach((f) => f({ tabId: 1, sessionId: d.sessionId }, d.method, d.params)); };
  const cdp = (method, params, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });
  const { targetId } = await cdp('Target.createTarget', { url: 'http://127.0.0.1:' + port + '/' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await new Promise((r) => setTimeout(r, 800));

  const deep = (o = () => { }) => new Proxy(o, { get: (t, k) => (k === 'then' ? undefined : (Object.prototype.hasOwnProperty.call(t, k) ? t[k] : deep())), apply: () => deep() });
  const chromeMock = deep();
  chromeMock.debugger = deep({ attach: async () => { }, detach: async () => { }, sendCommand: (_t, m, p) => cdp(m, p, sessionId), onEvent: { addListener: (f) => listeners.push(f) }, onDetach: { addListener() { } } });
  chromeMock.downloads = undefined;
  chromeMock.storage = deep({ local: { get: async () => ({ allowedOrigins: [], desktopToken: '', desktopPort: 1, desktopEnabled: false }), set: async () => { } }, session: { get: async (d) => d, set: async () => { } } });
  const ctx = vm.createContext({ chrome: chromeMock, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch, URL, TextEncoder, TextDecoder, atob, btoa, crypto, AbortController, Uint8Array, Uint32Array, Promise, performance });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'background.js' });
  const run = (code) => vm.runInContext(code, ctx);
  const R = { want: want.slice(0, 12) };
  const click = async (sel) => { await cdp('Runtime.evaluate', { expression: 'document.querySelector("' + sel + '").click()' }, sessionId); };
  const pull = async (cid) => { let off = 0, parts = [], last; for (;;) { last = await run('commands.read_capture(' + JSON.stringify({ id: cid, offset: off, length: 786432 }) + ')'); const b = Buffer.from(last.b64, 'base64'); parts.push(b); off += b.length; if (last.eof) break; } return { buf: Buffer.concat(parts), last }; };
  const crc = (buf) => { let c = ~0 >>> 0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) >>> 0 : c >>> 1; } return (~c >>> 0).toString(16).padStart(8, '0'); };

  try {
    await run('setDownloadBehavior(1, "capture")');
    for (const [label, sel] of [['get', '#a'], ['post', '#f'], ['blob', '#bl'], ['data', '#dt']]) {
      const since = Date.now(); await click(sel);
      let info; try { info = await run('waitForNewDownload(8000,' + since + ',1)'); } catch (e) { R[label] = { error: e.message }; continue; }
      const { buf, last } = await pull(info.capture_id);
      R[label] = { info, sizeOk: buf.length === info.size_bytes, crcOk: crc(buf) === info.crc32 && last.crc32 === info.crc32, shaOk: label === 'get' || label === 'post' ? crypto.createHash('sha256').update(buf).digest('hex') === want : undefined, text: label === 'blob' || label === 'data' ? buf.toString() : undefined };
      await run('commands.release_capture({id:' + JSON.stringify(info.capture_id) + '})');
    }
    // 助理端管線（真正的 _bcIngestCapture／_bcPostprocess 原始碼）接到同一個擴充功能
    const app = fs.readFileSync('D:/Downloads/videos-嗨投資-desktop-app/desktop-app/renderer/src/floating-assistant.js', 'utf8');
    const i0 = app.indexOf('    async _bcIngestCapture(info, opts) {'), i1 = app.indexOf('    async _bcCall(cmd, args, timeoutMs = 30000) {');
    const delivered = [], written = [];
    const holder = eval('({' + app.slice(i0, i1).replace(/^\s*async _bcPostprocess/m, ',\n async _bcPostprocess') .replace(/(\n\s*\}\n)(\s*\/\/ browser_click)/, '$1$2') + '})'.replace('})', '})'));
    holder._bcCall = async (cmd, args) => Object.assign({ ok: true }, await run('commands.' + cmd + '(' + JSON.stringify(args) + ')'));
    holder.generateAndDeliverFile = async (blob, name, mime) => { delivered.push({ name, size: blob.size, mime }); return { id: 'f1', filename: name }; };
    globalThis.window = { desktopAPI: { rawfs: { writeFile: async (p, o) => { written.push({ p, bytes: Buffer.from(o.base64, 'base64').length }); return { ok: true, path: p }; } } } };
    const since2 = Date.now(); await click('#a'); const dl = await run('waitForNewDownload(8000,' + since2 + ',1)');
    const ing = await holder._bcPostprocess('wait_download', { save_path: 'C:/tmp/dl' }, dl);
    R.pipeline = { ing, delivered, written, shaOk: ing.sha256 === want, verified: ing.verified, released: !(await run('commands.list_captures({})')).captures.some((c) => c.capture_id === dl.capture_id) };
    // 壞資料要被擋下來：把擴充功能那邊的 crc32 弄錯
    const since3 = Date.now(); await click('#f'); const dl2 = await run('waitForNewDownload(8000,' + since3 + ',1)');
    const bad = await holder._bcPostprocess('click', { }, { download: Object.assign({}, dl2, { crc32: '00000000' }) });
    R.bad_crc = { ingest_error: (bad.download.ingest_error || '').slice(0, 60), delivered_after: delivered.length };
    // 一般頁面連結不被當成下載
    await cdp('Runtime.evaluate', { expression: 'location.href="/doc.html"' }, sessionId); await new Promise((r) => setTimeout(r, 1200));
    const t = await cdp('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sessionId); R.normal_page = t.result.value;
    R.list = (await run('commands.list_captures({})')).captures.length;
    // 換回 default 會關掉 Fetch 攔截
    await run('setDownloadBehavior(1, "default")'); R.after_default = run('dlBehavior.has(1)');
  } catch (e) { R.fatal = String(e.stack || e).slice(0, 400); }
  console.log(JSON.stringify(R, null, 1));
  try { chrome.kill(); } catch (_) { } srv.close(); setTimeout(() => process.exit(0), 300);
})();
