// 把真正的 background.js 放進 vm（chrome 以代理假造），除錯器指令轉到真的 Chrome（遠端除錯），驗證 capture 全流程
const fs = require('fs'), vm = require('vm'), http = require('http'), crypto = require('crypto'), cp = require('child_process'), os = require('os'), path = require('path');
const SRC = 'D:/Downloads/videos-嗨投資/web/browser-control-extension/background.js';
const DATA = crypto.randomBytes(900000), want = crypto.createHash('sha256').update(DATA).digest('hex');

const srv = http.createServer((req, res) => {
  if (req.url === '/') { const b = '<a id=a href="/file.bin">dl</a><form method=post action="/post.bin"><button id=f>post</button></form><button id=bl>blob</button><button id=dt>data</button><a id=pdf href="/doc.html">html</a><input type=file id=fi multiple><input type=file id=one><button id=ub style="width:120px;height:40px" onclick="fi.click()">choose</button><script>window.changes=0;fi.addEventListener(\'change\',function(){window.changes++});window.report=async function(sel){var out=[];for(var f of document.querySelector(sel).files){var b=await f.arrayBuffer();var h=await crypto.subtle.digest(\'SHA-256\',b);out.push({name:f.name,size:f.size,type:f.type,sha:Array.from(new Uint8Array(h)).map(function(x){return x.toString(16).padStart(2,\'0\')}).join(\'\')})}return out};bl.onclick=function(){var a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["blob-content-123"]));a.download="made.txt";document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href)},50)};dt.onclick=function(){var a=document.createElement("a");a.href="data:text/plain;base64,aGVsbG8gZGF0YQ==";a.download="d.txt";document.body.appendChild(a);a.click()}</script>'; res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(b); }
  if (req.url === '/doc.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<p>normal page</p>'); }
  if (req.url === '/big.bin') { const B = Buffer.alloc(2 * 1048576, 7); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="big.bin"', 'Content-Length': B.length }); return res.end(B); }
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
    run('needTab = async () => ({ tabId: 1 })');
    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const crcOf = (buf) => { let c = ~0 >>> 0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) >>> 0 : c >>> 1; } return (~c >>> 0).toString(16).padStart(8, '0'); };
    const evalPage = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
    const push = async (id, name, mime, buf, badCrc) => {
      await run('commands.upload_begin(' + JSON.stringify({ id, name, mime, size: buf.length }) + ')');
      for (let off = 0; off < buf.length; off += 393216) await run('commands.upload_chunk(' + JSON.stringify({ id, offset: off, b64: buf.subarray(off, off + 393216).toString('base64') }) + ')');
      return run('commands.upload_end(' + JSON.stringify({ id, crc32: badCrc ? '00000000' : crcOf(buf) }) + ')');
    };
    const small = Buffer.from('你好 upload 測試\n'), big = crypto.randomBytes(900000);
    // 1) 位元組模式 → 直接指定欄位
    R.end1 = await push('u1', 'big.bin', 'application/octet-stream', big); R.end2 = await push('u2', 'note.txt', 'text/plain', small);
    R.set_input = await run('commands.set_file_input({selector:"#fi", upload_ids:["u1","u2"]})');
    R.page1 = await evalPage('report("#fi")'); R.changes1 = await evalPage('window.changes');
    R.bytes_ok = R.page1.length === 2 && R.page1[0].sha === sha(big) && R.page1[1].sha === sha(small) && R.page1[1].size === small.length && R.page1[1].type === 'text/plain';
    // 2) 點一個會開對話框的按鈕（真實滑鼠事件）→ 對話框被攔下、檔案直接填入
    await evalPage('fi.value=""; window.changes=0; 1');
    await run('armFileChooser(1, {upload_ids:["u2"]})');
    const pos = await evalPage('(function(){var r=document.getElementById("ub").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
    for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: t, x: pos.x, y: pos.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, sessionId);
    R.chooser = await run('waitChooserResult(1, 8000)'); await run('disarmFileChooser(1)');
    R.page2 = await evalPage('report("#fi")'); R.chooser_ok = R.page2.length === 1 && R.page2[0].sha === sha(small) && (await evalPage('window.changes')) === 1;
    // 3) 路徑模式（桌面版）
    const tmp = path.join(os.tmpdir(), 'fa_up_' + Date.now() + '.bin'); fs.writeFileSync(tmp, big);
    R.path_set = await run('commands.set_file_input({selector:"#fi", paths:[' + JSON.stringify(tmp) + ']})');
    R.page3 = await evalPage('report("#fi")'); R.path_ok = R.page3.length === 1 && R.page3[0].sha === sha(big) && R.page3[0].name === path.basename(tmp);
    // 4) 把關：壞 crc 被丟棄；不能多選的欄位不收兩個檔案；找不到欄位
    try { await push('u3', 'bad.bin', '', small, true); R.bad_crc = 'accepted?!'; } catch (e) { R.bad_crc = e.message.slice(0, 50); }
    try { await run('commands.set_file_input({selector:"#one", upload_ids:["u1","u2"]})'); R.single_multi = 'accepted?!'; } catch (e) { R.single_multi = e.message.slice(0, 40); }
    try { await run('commands.set_file_input({selector:"#nope", upload_ids:["u1"]})'); R.no_input = 'accepted?!'; } catch (e) { R.no_input = e.message.slice(0, 40); }
    R.listed = (await run('commands.list_uploads()')).uploads.map((u) => u.id + ':' + u.ready);
    await run('commands.upload_drop({ids:["u1","u2"]})'); R.after_drop = (await run('commands.list_uploads()')).uploads.length;
  } catch (e) { R.fatal = String(e.stack || e).slice(0, 400); }
  console.log(JSON.stringify(R, null, 1));
  try { chrome.kill(); } catch (_) { } srv.close(); setTimeout(() => process.exit(0), 300);
})();
