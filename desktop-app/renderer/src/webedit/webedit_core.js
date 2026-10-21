// 網頁編輯器核心：一個小網站（HTML／CSS／JS 檔案）＋一個模擬後端（Node 風格的 JS 或 Python），可以用對話修改。純函式，node 與瀏覽器都能跑
// （UMD，嵌入成 FaWebEdit，見 scripts/embed-code-ui.js）。
//
// 描述（spec）：{ v:1, title, files:[{name, content}], backend:{ lang:'js'|'python', code } | null }
//   - 前端：files[0] 是進入點 index.html；其他 .css／.js 用 <link href="style.css">、<script src="app.js"> 引用，預覽時會被內嵌進頁面。
//   - 後端：lang 'js'＝跟沙盒的 mock 伺服器同一套寫法（const app = router(); app.crud("/api/x","x"); app.ws("/chat", …)，env.db 持久、頁面的
//     fetch／XMLHttpRequest／EventSource／WebSocket 都由它回應）；lang 'python'＝Flask／Bottle／FastAPI／Starlette 的 app（Pyodide）。
//   - 伺服器只是讓人體驗架設的感覺；要上線就匯出：程式、重建用的 prompt（PROMPT.md）與部署教學（README.md）。
// 修改一律用「封閉的編輯動作」（set_file／patch_file／add_file／remove_file／rename_file／set_backend／patch_backend／remove_backend／set_title），
// 程式逐一驗證（檔名、大小、patch 要找得到且唯一）；模型只能回這些動作，改不了其他東西。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaWebEdit = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LIMITS = { files: 10, file: 150000, total: 400000, backend: 120000, title: 80 };
  var EXT = /\.(html|css|js|json|txt|svg|md)$/i;
  function str(v, max) { return String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max || 200); }
  function okName(n) { n = String(n || ''); return /^[A-Za-z0-9_\-./]{1,60}$/.test(n) && n.indexOf('..') < 0 && n.charAt(0) !== '/' && EXT.test(n); }
  function defaults() { return { v: 1, title: '我的網頁', files: [{ name: 'index.html', content: '<!doctype html>\n<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的網頁</title></head>\n<body>\n<h1>Hello</h1>\n</body></html>\n' }], backend: null }; }
  function validate(input) {
    var problems = [], s = { v: 1, title: '', files: [], backend: null }; var r = input && typeof input === 'object' ? input : {};
    s.title = str(r.title, LIMITS.title) || '我的網頁'; var total = 0, seen = {};
    (Array.isArray(r.files) ? r.files : []).forEach(function (f) {
      if (!f || typeof f !== 'object') return; if (s.files.length >= LIMITS.files) { problems.push('檔案太多，只留前 ' + LIMITS.files + ' 個'); return; }
      if (!okName(f.name)) { problems.push('檔名不合法，略過：' + str(f.name, 40) + '（只能用英數、_ - . /，副檔名是 html／css／js／json／txt／svg／md）'); return; }
      if (seen[f.name]) { problems.push('檔名重複，略過：' + f.name); return; } seen[f.name] = 1;
      var c = String(f.content == null ? '' : f.content); if (c.length > LIMITS.file) { problems.push(f.name + ' 太大（超過 ' + LIMITS.file + ' 字），已截斷'); c = c.slice(0, LIMITS.file); } if (total + c.length > LIMITS.total) { problems.push('全部檔案加起來太大，略過 ' + f.name); return; } total += c.length; s.files.push({ name: f.name, content: c });
    });
    if (!s.files.length || s.files[0].name !== 'index.html') { var i = s.files.findIndex(function (f) { return f.name === 'index.html'; }); if (i > 0) s.files.unshift(s.files.splice(i, 1)[0]); else if (i < 0) { s.files.unshift(defaults().files[0]); problems.push('沒有 index.html，補上一個空白的'); } }
    var b = r.backend; if (b && typeof b === 'object' && String(b.code || '').trim()) { var lang = b.lang === 'python' ? 'python' : 'js'; if (b.lang && ['js', 'python'].indexOf(b.lang) < 0) problems.push('不支援的後端語言「' + str(b.lang, 20) + '」（可以用 js 或 python），改用 js'); var code = String(b.code); if (code.length > LIMITS.backend) { problems.push('後端程式太大，已截斷'); code = code.slice(0, LIMITS.backend); } s.backend = { lang: lang, code: code }; }
    return { ok: true, spec: s, problems: problems };
  }
  // 預覽用的單一 HTML：把引用的本地 .css／.js 檔內嵌進去
  function buildHtml(spec) {
    var s = validate(spec).spec, byName = {}; s.files.forEach(function (f) { byName[f.name] = f.content; }); var doc = byName['index.html'] || '';
    function clean(p) { return String(p || '').replace(/^\.\//, '').replace(/[?#].*$/, ''); }
    doc = doc.replace(/<link\b[^>]*>/gi, function (tag) { var m = /href\s*=\s*["']([^"']+)["']/i.exec(tag); if (m && /rel\s*=\s*["']?stylesheet/i.test(tag) && byName[clean(m[1])] != null) return '<style data-file="' + clean(m[1]) + '">\n' + byName[clean(m[1])].replace(/<\/style/gi, '<\\/style') + '\n</style>'; return tag; });
    doc = doc.replace(/<script\b([^>]*?)>\s*<\/script>/gi, function (tag, attrs) { var m = /src\s*=\s*["']([^"']+)["']/i.exec(attrs); if (m && byName[clean(m[1])] != null) return '<script data-file="' + clean(m[1]) + '">\n' + byName[clean(m[1])].replace(/<\/script/gi, '<\\/script') + '\n</script>'; return tag; });
    return doc;
  }
  // Python 後端要用到的套件（Pyodide 沒有預載 Flask 等網頁框架，第一次要用 micropip 安裝；安裝過的之後是空操作）
  function pyPackages(code) {
    var known = { flask: 'flask', bottle: 'bottle', fastapi: 'fastapi', starlette: 'starlette', jinja2: 'jinja2', werkzeug: 'werkzeug', pydantic: 'pydantic', itsdangerous: 'itsdangerous', markupsafe: 'markupsafe' }, out = [], re = /^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)/gm, m; var c = String(code || '');
    while ((m = re.exec(c))) { var p = known[m[1].toLowerCase()]; if (p && out.indexOf(p) < 0) out.push(p); } return out;
  }
  // ───── 匯出成真正能部署的後端（沙盒只是體驗，要上線就匯出）─────
  function pyKind(code) { return /^\s*(?:from|import)\s+(?:fastapi|starlette)\b/m.test(String(code || '')) ? 'asgi' : 'wsgi'; }
  var PY_WSGI_MAIN = [
    'import os, mimetypes',
    'from app import app as _app',
    '',
    'PUBLIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")',
    '',
    '# 後端沒有處理的網址（回 404），改去 public/ 找靜態頁面',
    'def application(environ, start_response):',
    '    status_box = {}',
    '    def capture(status, headers, exc_info=None):',
    '        status_box["s"] = (status, headers)',
    '        return lambda data: None',
    '    body = b"".join(_app(environ, capture))',
    '    status, headers = status_box["s"]',
    '    if status.startswith("404") and environ.get("REQUEST_METHOD") in ("GET", "HEAD"):',
    '        rel = environ.get("PATH_INFO", "/").lstrip("/") or "index.html"',
    '        path = os.path.normpath(os.path.join(PUBLIC, rel))',
    '        if os.path.isdir(path): path = os.path.join(path, "index.html")',
    '        if path.startswith(PUBLIC) and os.path.isfile(path):',
    '            data = open(path, "rb").read()',
    '            start_response("200 OK", [("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream"), ("Content-Length", str(len(data)))])',
    '            return [data]',
    '    start_response(status, headers)',
    '    return [body]',
    '',
    'if __name__ == "__main__":',
    '    from wsgiref.simple_server import make_server',
    '    port = int(os.environ.get("PORT", 8000))',
    '    print("http://localhost:%d" % port)',
    '    make_server("0.0.0.0", port, application).serve_forever()',
    ''
  ].join('\n');
  var PY_ASGI_MAIN = [
    'import os',
    'from app import app as api',
    'from starlette.applications import Starlette',
    'from starlette.routing import Mount',
    'from starlette.staticfiles import StaticFiles',
    '',
    'PUBLIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")',
    '',
    '# 後端的路由優先，其餘網址去 public/ 找靜態頁面',
    'application = Starlette(routes=[Mount("/", app=api)])',
    'try:',
    '    api.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")',
    'except Exception:',
    '    pass',
    'app = api',
    '',
    'if __name__ == "__main__":',
    '    import uvicorn',
    '    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))',
    ''
  ].join('\n');
  function deployGuide(target, title) {
    var T = String(title || '我的網站'), L = ['# ' + T + '：部署教學', '', '這包檔案是從編輯器的「模擬後端」匯出的：後端程式跟你在編輯器裡測試的是同一份，頁面放在 `public/`。編輯器裡的伺服器只是讓你體驗架設的感覺，要讓別人連得到，就照下面部署到真正的主機。', ''];
    if (target === 'python') L.push('## 一、先在自己電腦跑跑看', '', '```bash', 'python -m venv .venv', '.venv\\Scripts\\activate        # macOS／Linux：source .venv/bin/activate', 'pip install -r requirements.txt', 'python main.py', '```', '', '打開 http://localhost:8000 。', '', '## 二、放上網路（任選一種）', '', '### Render（最省事，有免費方案）', '1. 把這個資料夾推到 GitHub。', '2. Render → New → Web Service，選那個 repo。', '3. Build Command：`pip install -r requirements.txt`；Start Command：見 `Procfile` 那一行。', '4. 部署完成會給你一個 https 網址。', '', '### Railway／Fly.io', '- Railway：New Project → Deploy from GitHub，會讀 `Procfile`。', '- Fly.io：`fly launch`，它會用資料夾裡的 `Dockerfile`。', '', '### 自己的主機（VPS）', '```bash', 'docker build -t mysite .', 'docker run -d -p 80:8000 --restart unless-stopped mysite', '```', '', '## 三、注意', '- 編輯器裡的資料只存在記憶體；真正部署後要存資料請用資料庫（SQLite 檔、Postgres 等），並放在會保留的磁碟。', '- 前端的 `fetch("/api/...")` 不用改，因為頁面和後端在同一個網址。', '- 密碼、金鑰一律用環境變數，不要寫進程式碼。');
    else if (target === 'node') L.push('## 一、先在自己電腦跑跑看', '', '```bash', 'npm install', 'npm start', '```', '', '預設在 http://localhost:8787 ，頁面放在 `public/index.html`。環境變數：`PORT`、`DATA_DIR`（資料存放的資料夾）、`PUBLIC_DIR`。', '', '## 二、放上網路（任選一種）', '', '### Render／Railway／Fly.io', '1. 推到 GitHub。', '2. 建立 Web Service，Build：`npm install`，Start：`npm start`。', '3. 要保留資料，掛一個持久磁碟，並把 `DATA_DIR` 指到它。', '', '### 自己的主機（VPS）', '```bash', 'npm install --omit=dev', 'npm install -g pm2', 'pm2 start npm --name mysite -- start', 'pm2 save && pm2 startup', '```', '前面再放 Nginx 或 Caddy 做 https。', '', '## 三、注意', '- 資料存成 `DATA_DIR` 裡的 JSON 檔，適合小型專案；用戶多了請改成真正的資料庫。', '- 密碼、金鑰一律用環境變數。');
    else L.push('## 一、先在自己電腦跑跑看', '', '```bash', 'npm install', 'npx wrangler dev', '```', '', '## 二、部署到 Cloudflare', '', '```bash', 'npx wrangler login', 'npx wrangler deploy', '```', '', '部署完成會給你一個 `*.workers.dev` 的網址，之後可以在 Cloudflare 後台綁自己的網域。', '', '## 三、注意', '- 即時通訊（WebSocket）在 Cloudflare 需要 Durable Objects，匯出的只有骨架，要自己補完。', '- 資料請改存 Workers KV、D1 或 Durable Objects；匯出檔的儲存只是示範。');
    return L.join('\n') + '\n';
  }
  // Python 後端匯出：app.py 就是編輯器裡的程式，main.py 負責把 public/ 的頁面一起服務
  function exportPython(spec) {
    var s = validate(spec).spec, be = s.backend; if (!be || be.lang !== 'python') return null;
    var kind = pyKind(be.code), pk = pyPackages(be.code); var reqs = pk.slice(); if (kind === 'asgi') { ['starlette', 'uvicorn', 'aiofiles'].forEach(function (p) { if (reqs.indexOf(p) < 0) reqs.push(p); }); } else if (reqs.indexOf('gunicorn') < 0) reqs.push('gunicorn');
    var files = [{ name: 'app.py', content: be.code }, { name: 'main.py', content: kind === 'asgi' ? PY_ASGI_MAIN : PY_WSGI_MAIN }, { name: 'requirements.txt', content: reqs.join('\n') + '\n' }];
    var start = kind === 'asgi' ? 'uvicorn main:app --host 0.0.0.0 --port $PORT' : 'gunicorn main:application --bind 0.0.0.0:$PORT';
    files.push({ name: 'Procfile', content: 'web: ' + start + '\n' });
    files.push({ name: 'Dockerfile', content: ['FROM python:3.12-slim', 'WORKDIR /app', 'COPY requirements.txt .', 'RUN pip install --no-cache-dir -r requirements.txt', 'COPY . .', 'ENV PORT=8000', 'EXPOSE 8000', 'CMD ' + JSON.stringify(start.replace('$PORT', '8000').split(' ')), ''].join('\n') });
    files.push({ name: 'public/index.html', content: buildHtml(s) });
    (s.files || []).forEach(function (f) { if (f.name !== 'index.html') files.push({ name: 'public/' + f.name, content: f.content }); });
    files.push({ name: 'README.md', content: deployGuide('python', s.title) });
    return { files: files, kind: kind };
  }
  function routesOf(code, lang) {
    var out = [], c = String(code || ''), m, re;
    if (lang === 'python') { re = /@\w+\.(route|get|post|put|delete|patch|websocket)\(\s*["']([^"']+)["']([^)]*)\)/g; while ((m = re.exec(c))) { var meth = m[1] === 'route' ? ((/methods\s*=\s*\[([^\]]*)\]/.exec(m[3]) || [])[1] || 'GET').replace(/["'\s]/g, '').toUpperCase() : m[1].toUpperCase(); out.push(meth + ' ' + m[2]); } }
    else { re = /\b\w+\.(get|post|put|delete|patch|crud|ws|sse)\(\s*["'`]([^"'`]+)["'`]/g; while ((m = re.exec(c))) out.push((m[1] === 'crud' ? 'CRUD' : m[1].toUpperCase()) + ' ' + m[2]); }
    return out.filter(function (x, i) { return out.indexOf(x) === i; }).slice(0, 40);
  }

  // ───────────────────────── 起手式（範本）：都是可以直接跑的小網站 ─────────────────────────
  var STARTERS = [
    { id: 'blank', label: '空白網頁', desc: '只有一個標題的 HTML，從零開始用對話做。', spec: function () { return defaults(); } },
    { id: 'todo', label: '待辦清單（HTML＋JS 後端）', desc: '新增、勾選、刪除待辦；後端用 router().crud 存在持久的 env.db。', spec: function () { return {
      title: '待辦清單', files: [
        { name: 'index.html', content: '<!doctype html>\n<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>待辦清單</title><link rel="stylesheet" href="style.css"></head>\n<body>\n<main>\n<h1>待辦清單</h1>\n<form id="f"><input id="t" placeholder="要做什麼？" autocomplete="off" required><button>新增</button></form>\n<ul id="list"></ul>\n<p id="msg" class="muted"></p>\n</main>\n<script src="app.js"></script>\n</body></html>\n' },
        { name: 'style.css', content: 'body{font-family:system-ui,"Microsoft JhengHei",sans-serif;background:#f4f6f8;margin:0}\nmain{max-width:460px;margin:24px auto;background:#fff;padding:20px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.08)}\nh1{margin:0 0 12px;font-size:22px}\nform{display:flex;gap:8px}\ninput{flex:1;padding:8px;border:1px solid #cbd5e1;border-radius:8px}\nbutton{padding:8px 14px;border:0;border-radius:8px;background:#2f6fd0;color:#fff;cursor:pointer}\nul{list-style:none;padding:0;margin:14px 0 0}\nli{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #eef2f6}\nli.done span{text-decoration:line-through;color:#94a3b8}\nli span{flex:1}\n.muted{color:#64748b;font-size:12px}\n' },
        { name: 'app.js', content: 'const list = document.getElementById("list"), msg = document.getElementById("msg");\nasync function load() {\n  const r = await fetch("/api/todos"); const items = await r.json();\n  list.innerHTML = "";\n  items.forEach((it) => {\n    const li = document.createElement("li"); if (it.done) li.className = "done";\n    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!it.done; cb.onchange = async () => { await fetch("/api/todos/" + it.id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...it, done: cb.checked }) }); load(); };\n    const sp = document.createElement("span"); sp.textContent = it.text;\n    const x = document.createElement("button"); x.textContent = "刪除"; x.onclick = async () => { await fetch("/api/todos/" + it.id, { method: "DELETE" }); load(); };\n    li.append(cb, sp, x); list.appendChild(li);\n  });\n  msg.textContent = items.length + " 項";\n}\ndocument.getElementById("f").onsubmit = async (e) => {\n  e.preventDefault(); const t = document.getElementById("t");\n  await fetch("/api/todos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t.value, done: false }) });\n  t.value = ""; load();\n};\nload();\n' }],
      backend: { lang: 'js', code: '// 模擬後端（Node 風格）：資料存在持久的 env.db，重新整理不會消失\nconst app = router();\napp.crud("/api/todos", "todos");\napp.get("/api/ping", () => ({ ok: true, time: Date.now() }));\n' } }; } },
    { id: 'chat', label: '聊天室（WebSocket）', desc: '多人聊天：頁面用 WebSocket 連 /chat，後端用 app.ws 廣播。', spec: function () { return {
      title: '聊天室', files: [
        { name: 'index.html', content: '<!doctype html>\n<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>聊天室</title>\n<style>body{font-family:system-ui,"Microsoft JhengHei",sans-serif;margin:0;background:#eef2f7}#w{max-width:480px;margin:20px auto;background:#fff;border-radius:12px;padding:14px}#log{height:240px;overflow:auto;border:1px solid #dbe3ec;border-radius:8px;padding:8px;margin-bottom:8px}form{display:flex;gap:6px}input{flex:1;padding:8px}</style></head>\n<body><div id="w"><h2>聊天室</h2><div id="log"></div><form id="f"><input id="m" placeholder="說點什麼" autocomplete="off"><button>送出</button></form><small id="st">連線中…</small></div>\n<script>\nconst ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/chat");\nconst log = document.getElementById("log"), st = document.getElementById("st");\nws.onopen = () => st.textContent = "已連線"; ws.onclose = () => st.textContent = "已中斷";\nws.onmessage = (e) => { const p = document.createElement("div"); p.textContent = e.data; log.appendChild(p); log.scrollTop = log.scrollHeight; };\ndocument.getElementById("f").onsubmit = (e) => { e.preventDefault(); const m = document.getElementById("m"); if (m.value) ws.send(m.value); m.value = ""; };\n</script></body></html>\n' }],
      backend: { lang: 'js', code: '// 模擬後端：WebSocket 廣播給所有連線的人（包含自己）\nconst app = router();\napp.ws("/chat", (ws, req, env) => {\n  ws.on("message", (m) => ws.broadcast(m, { includeSelf: true }));\n});\n' } }; } },
    { id: 'form', label: '聯絡表單（POST＋列表）', desc: '送出表單存進後端，下面列出收到的訊息。', spec: function () { return {
      title: '聯絡表單', files: [
        { name: 'index.html', content: '<!doctype html>\n<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>聯絡表單</title>\n<style>body{font-family:system-ui,"Microsoft JhengHei",sans-serif;background:#f6f7f9;margin:0}main{max-width:420px;margin:24px auto;background:#fff;padding:18px;border-radius:12px}label{display:block;margin:8px 0 2px}input,textarea{width:100%;box-sizing:border-box;padding:8px}button{margin-top:10px;padding:8px 16px}pre{background:#f1f5f9;padding:8px;border-radius:8px;white-space:pre-wrap}</style></head>\n<body><main><h2>聯絡我們</h2><form id="f"><label>姓名</label><input name="name" required><label>訊息</label><textarea name="msg" rows="3" required></textarea><button>送出</button></form><h3>已收到</h3><pre id="out"></pre></main>\n<script>\nasync function refresh() { const r = await fetch("/api/messages"); document.getElementById("out").textContent = JSON.stringify(await r.json(), null, 2); }\ndocument.getElementById("f").onsubmit = async (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); await fetch("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) }); e.target.reset(); refresh(); };\nrefresh();\n</script></body></html>\n' }],
      backend: { lang: 'js', code: '// 模擬後端：收到的訊息存進 env.db\nconst app = router();\napp.post("/api/messages", async (req, env) => {\n  const b = await req.json();\n  if (!b.name || !b.msg) return fail(400, "姓名和訊息都要填");\n  const id = await env.db.nextId("messages");\n  await env.db.set("messages/" + id, { id, name: String(b.name).slice(0, 40), msg: String(b.msg).slice(0, 500), at: new Date().toISOString() });\n  return json({ ok: true, id }, 201);\n});\napp.get("/api/messages", async (req, env) => {\n  const rows = await env.db.list("messages/");\n  return json(rows.map((r) => r.value));\n});\n' } }; } },
    { id: 'python_api', label: 'Python（Flask）API', desc: '頁面呼叫 Python 後端（Pyodide 跑 Flask）：問候與計算。', spec: function () { return {
      title: 'Python 後端範例', files: [
        { name: 'index.html', content: '<!doctype html>\n<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Python 後端範例</title>\n<style>body{font-family:system-ui,"Microsoft JhengHei",sans-serif;margin:24px}input{padding:6px}</style></head>\n<body><h2>Python 後端範例</h2><p>輸入名字，由 Python（Flask）回應：</p><input id="n" value="小明"> <button id="b">打招呼</button><pre id="o"></pre>\n<script>\ndocument.getElementById("b").onclick = async () => { const r = await fetch("/api/hello?name=" + encodeURIComponent(document.getElementById("n").value)); document.getElementById("o").textContent = JSON.stringify(await r.json(), null, 2); };\n</script></body></html>\n' }],
      backend: { lang: 'python', code: 'from flask import Flask, jsonify, request\n\napp = Flask(__name__)\n\n@app.get("/api/hello")\ndef hello():\n    name = request.args.get("name", "世界")\n    return jsonify({"message": f"哈囉，{name}！", "length": len(name)})\n' } }; } }
  ];
  function starter(id) { var t = STARTERS.filter(function (x) { return x.id === id; })[0]; return t ? validate(t.spec()).spec : null; }
  function listStarters() { return STARTERS.map(function (t) { return { id: t.id, label: t.label, desc: t.desc }; }); }

  // ───────────────────────── 編輯動作（封閉）─────────────────────────
  var OPS = ['set_title', 'set_file', 'patch_file', 'add_file', 'remove_file', 'rename_file', 'set_backend', 'patch_backend', 'remove_backend'];
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function count(hay, needle) { if (!needle) return 0; var n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; }
  function patchText(text, e, label) {
    var find = String(e.find == null ? '' : e.find), rep = String(e.replace == null ? '' : e.replace); if (!find) throw new Error(label + '：find 不能是空的');
    var n = count(text, find); if (n === 0) throw new Error(label + '：找不到要取代的文字（find 要跟現在的內容一字不差，包含縮排）：' + find.slice(0, 50));
    if (n > 1 && e.all !== true) throw new Error(label + '：要取代的文字出現 ' + n + ' 次，請多帶幾行上下文讓它唯一，或加 all:true');
    return e.all === true ? text.split(find).join(rep) : text.replace(find, function () { return rep; });
  }
  function applyEdits(spec, edits) {
    var s = clone(validate(spec).spec), applied = [], rejected = []; var list = Array.isArray(edits) ? edits : (edits ? [edits] : []);
    function fileIx(name) { return s.files.findIndex(function (f) { return f.name === name; }); }
    function checkSize(c, what) { if (String(c).length > LIMITS.file) throw new Error(what + ' 太大（超過 ' + LIMITS.file + ' 字）'); var t = s.files.reduce(function (a, f) { return a + f.content.length; }, 0); if (t > LIMITS.total + LIMITS.file) throw new Error('全部檔案加起來太大'); }
    list.slice(0, 30).forEach(function (e) {
      var op = e && e.op; try {
        if (op === 'set_title') s.title = str(e.text, LIMITS.title) || s.title;
        else if (op === 'set_file') { var i = fileIx(e.name); if (i < 0) throw new Error('沒有檔案 ' + e.name + '（新檔案用 add_file）'); checkSize(e.content, e.name); s.files[i].content = String(e.content == null ? '' : e.content); }
        else if (op === 'add_file') { if (!okName(e.name)) throw new Error('檔名不合法：' + str(e.name, 40) + '（英數、_ - . /，副檔名 html／css／js／json／txt／svg／md）'); if (fileIx(e.name) >= 0) throw new Error(e.name + ' 已經存在（要改內容用 set_file／patch_file）'); if (s.files.length >= LIMITS.files) throw new Error('檔案太多（最多 ' + LIMITS.files + ' 個）'); checkSize(e.content, e.name); s.files.push({ name: e.name, content: String(e.content == null ? '' : e.content) }); }
        else if (op === 'remove_file') { var j = fileIx(e.name); if (j < 0) throw new Error('沒有檔案 ' + e.name); if (e.name === 'index.html') throw new Error('index.html 是進入點，不能刪'); s.files.splice(j, 1); }
        else if (op === 'rename_file') { var k = fileIx(e.name); if (k < 0) throw new Error('沒有檔案 ' + e.name); if (e.name === 'index.html') throw new Error('index.html 是進入點，不能改名'); if (!okName(e.to)) throw new Error('新檔名不合法：' + str(e.to, 40)); if (fileIx(e.to) >= 0) throw new Error(e.to + ' 已經存在'); s.files[k].name = e.to; s.files.forEach(function (f) { if (f.name === 'index.html') f.content = f.content.split('"' + e.name + '"').join('"' + e.to + '"').split("'" + e.name + "'").join("'" + e.to + "'"); }); }
        else if (op === 'patch_file') { var p = fileIx(e.name); if (p < 0) throw new Error('沒有檔案 ' + e.name); var nt = patchText(s.files[p].content, e, e.name); checkSize(nt, e.name); s.files[p].content = nt; }
        else if (op === 'set_backend') { var lang = e.lang === 'python' ? 'python' : (e.lang === 'js' || e.lang == null ? 'js' : null); if (!lang) throw new Error('後端語言只能是 js 或 python（PHP 目前不能在瀏覽器裡執行）'); var code = String(e.code == null ? '' : e.code); if (!code.trim()) throw new Error('code 不能是空的（要移除後端用 remove_backend）'); if (code.length > LIMITS.backend) throw new Error('後端程式太大（超過 ' + LIMITS.backend + ' 字）'); s.backend = { lang: lang, code: code }; }
        else if (op === 'patch_backend') { if (!s.backend) throw new Error('目前沒有後端（先用 set_backend）'); var nb = patchText(s.backend.code, e, '後端'); if (nb.length > LIMITS.backend) throw new Error('後端程式太大'); s.backend.code = nb; }
        else if (op === 'remove_backend') { if (!s.backend) throw new Error('目前沒有後端'); s.backend = null; }
        else throw new Error('不認得的動作「' + op + '」（可用：' + OPS.join('、') + '）');
        applied.push(op);
      } catch (err) { rejected.push({ op: op || '?', error: String(err && err.message || err) }); }
    });
    return { ok: true, spec: validate(s).spec, applied: applied, rejected: rejected };
  }
  function editWords(e) {
    var t = { set_title: function () { return '標題改成「' + e.text + '」'; }, set_file: function () { return '改寫 ' + e.name; }, patch_file: function () { return '修改 ' + e.name; }, add_file: function () { return '新增 ' + e.name; }, remove_file: function () { return '刪掉 ' + e.name; }, rename_file: function () { return e.name + ' 改名為 ' + e.to; }, set_backend: function () { return '改寫後端（' + (e.lang === 'python' ? 'Python' : 'JS') + '）'; }, patch_backend: function () { return '修改後端'; }, remove_backend: function () { return '移除後端'; } };
    return t[e && e.op] ? t[e.op]() : String(e && e.op || '');
  }
  function describe(spec) {
    var s = validate(spec).spec, out = [s.title + '：' + s.files.length + ' 個檔案（' + s.files.map(function (f) { return f.name; }).join('、') + '）'];
    out.push(s.backend ? '後端：' + (s.backend.lang === 'python' ? 'Python' : 'JS（Node 風格）') + '，' + (routesOf(s.backend.code, s.backend.lang).join('、') || '沒有讀到路由') : '沒有後端'); return out;
  }
  function specToPrompt(spec, history) {
    var s = validate(spec).spec, L = ['幫我做一個網頁「' + s.title + '」，檔案：' + s.files.map(function (f) { return f.name + '（' + f.content.length + ' 字）'; }).join('、') + '。'];
    s.files.forEach(function (f) { var t = f.content.replace(/\s+/g, ' ').trim(); L.push(f.name + '：' + t.slice(0, 160) + (t.length > 160 ? '…' : '')); });
    if (s.backend) { var rs = routesOf(s.backend.code, s.backend.lang); L.push('後端（' + (s.backend.lang === 'python' ? 'Python Flask/FastAPI' : 'Node 風格的模擬伺服器：router／app.crud／app.ws／env.db') + '）：' + (rs.join('、') || '（讀不到路由）') + '；前端用 fetch／WebSocket 呼叫同一個網域底下的這些路徑。'); }
    var steps = (history || []).filter(function (h) { return h && h.kind !== 'undo' && h.kind !== 'start' && (h.summary || h.text); });
    if (steps.length) { L.push('', '（編輯過程，依序）：'); steps.forEach(function (h, i) { L.push((i + 1) + '. ' + (h.text ? '我說：「' + String(h.text).slice(0, 80) + '」→ ' : '') + (h.summary || '')); }); }
    return L.join('\n');
  }
  // ───────────────────────── 對話：先讀得懂的（改標題、刪檔、改名），其餘交給 AI ─────────────────────────
  function parseEditRequest(text, spec) {
    var out = { edits: [], matched: [], unmatched: [] }, cur = validate(spec).spec; var clauses = String(text || '').replace(/\[附件：[^\]]*\]/g, ' ').split(/[，。；;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    clauses.forEach(function (c) {
      var m, e = [];
      if ((m = /(?:網頁|頁面|網站)?標題\s*(?:改成|換成|改為|設為|變成|叫做?|是)\s*[「"'『]?(.+?)[」"'』]?$/.exec(c))) e.push({ op: 'set_title', text: m[1] });
      else if ((m = /(?:刪掉|刪除|移除|拿掉)\s*(?:檔案)?\s*([A-Za-z0-9_\-./]+\.(?:html|css|js|json|txt|svg|md))/.exec(c))) e.push({ op: 'remove_file', name: m[1] });
      else if ((m = /(?:把)?\s*([A-Za-z0-9_\-./]+\.(?:html|css|js|json|txt|svg|md))\s*(?:改名(?:成|為)?|重新命名(?:成|為)?)\s*([A-Za-z0-9_\-./]+\.(?:html|css|js|json|txt|svg|md))/.exec(c))) e.push({ op: 'rename_file', name: m[1], to: m[2] });
      else if (/(?:不要|拿掉|移除|刪掉)[^，。]{0,4}後端/.test(c) && cur.backend) e.push({ op: 'remove_backend' });
      if (e.length) { out.edits = out.edits.concat(e); out.matched.push(c); } else out.unmatched.push(c);
    });
    return out;
  }
  // 這句話主要在改前端還是後端（後端的修改交給「程式設計」領域的子Agent，前端的修改用封閉的編輯動作）
  function classify(text) {
    var t = String(text || ''); var be = /後端|伺服器|server|\bAPI\b|api|端點|endpoint|路由|route|資料庫|database|\bdb\b|websocket|\bws\b|\bsse\b|crud|express|flask|fastapi|node|python|php|資料表|存進|儲存資料|登入驗證|認證|auth|token|權限|\/api\//i.test(t);
    var fe = /頁面|畫面|按鈕|樣式|顏色|版面|字體|字型|css|html|表單|標題|圖片|響應式|手機版|動畫|文字|排版|介面|ui|背景|間距|對齊|導覽列|選單/i.test(t);
    return { backend: be, frontend: fe || !be };
  }
  function trunc(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n) + '\n…（共 ' + t.length + ' 字，後面省略）' : t; }
  // 給模型的前端編輯提示：只准回 { say, edits }，動作在封閉清單裡
  function editPrompt(spec, text, extra) {
    var s = validate(spec).spec;
    var system = '你是網頁編輯助手。使用者說想怎麼改這個小網站（HTML／CSS／JS），你把它翻成「編輯動作」。只回一段 JSON，不要說明、不要 markdown 區塊：{"say":"一句話告訴使用者你改了什麼（做不到就說做不到）","edits":[…]}。\n動作只能是下面這些（不要發明新的動作）：\n'
      + '{op:"patch_file",name:"index.html",find:"要取代的原文（要一字不差、只出現一次，多帶幾行上下文）",replace:"新的文字"}（小修改優先用這個）、{op:"set_file",name:"style.css",content:"整份新內容"}（大幅改寫）、{op:"add_file",name:"app.js",content:"…"}、{op:"remove_file",name:"x.css"}、{op:"rename_file",name:"a.js",to:"b.js"}、{op:"set_title",text:"…"}。\n'
      + '檔名只能用英數、_ - . /，副檔名 html／css／js／json／txt／svg／md；進入點是 index.html，用 <link rel="stylesheet" href="style.css">、<script src="app.js"></script> 引用其他檔。頁面呼叫後端請用相對路徑（fetch("/api/…")）、WebSocket 用 (location.protocol==="https:"?"wss://":"ws://")+location.host+"/路徑"。不要用外部 CDN、不要在前端放金鑰。後端的程式不要在這裡改（會另外交給程式設計的專家）。看不懂或做不到：edits 給空陣列，在 say 說明。';
    var files = s.files.map(function (f) { return '=== ' + f.name + ' ===\n' + trunc(f.content, 7000); }).join('\n\n');
    var user = '目前的網站「' + s.title + '」：\n' + describe(s).join('\n') + '\n\n' + files + (s.backend ? '\n\n後端路由：' + (routesOf(s.backend.code, s.backend.lang).join('、') || '（無）') : '') + (extra ? '\n\n' + extra : '') + '\n\n使用者說：' + String(text || '');
    return { system: system, user: user };
  }
  function parseEditsReply(text) {
    var s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) return { ok: false, say: '', edits: [], error: '模型的回覆讀不成 JSON' }; var j; try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { return { ok: false, say: '', edits: [], error: '模型的回覆讀不成 JSON' }; }
    var edits = (Array.isArray(j.edits) ? j.edits : []).filter(function (e) { return e && OPS.indexOf(e.op) >= 0; }).slice(0, 20);
    return { ok: true, say: j.say ? str(j.say, 300) : '', edits: edits, dropped: (Array.isArray(j.edits) ? j.edits.length : 0) - edits.length };
  }
  // 後端的修改任務（交給程式設計領域的子Agent）：自給自足，因為子Agent看不到這段對話
  function backendTask(spec, text, extra) {
    var s = validate(spec).spec, lang = s.backend ? s.backend.lang : 'js';
    var html = s.files.map(function (f) { return '--- ' + f.name + ' ---\n' + trunc(f.content, 5000); }).join('\n\n');
    return '你要修改（或新寫）一個網頁的「模擬後端」。使用者的要求：' + String(text || '') + '\n\n'
      + (lang === 'python' ? '後端語言：Python（Flask／Bottle／FastAPI／Starlette，要定義一個叫 app 的物件；跑在瀏覽器的 Pyodide 裡，沒有真的網路埠與資料庫，要存資料請用檔案或 sqlite3 存在 /tmp；不支援 WebSocket）。'
        : '後端語言：JavaScript（Node 風格的模擬伺服器，跟沙盒 sandbox_mock 同一套寫法）：const app = router(); app.crud("/api/x","x")（自動存取 env.db）、app.get/post/put/delete(路徑, async (req, env) => json(資料, 狀態碼))、app.ws("/路徑", (ws, req, env) => { ws.on("message", (m) => ws.broadcast(m, { includeSelf: true })); })、env.db.get/set/delete/list(前綴)/nextId(集合名)、fail(狀態碼, 訊息)、sse(setup)。頁面的 fetch／WebSocket／EventSource 都由它回應，資料持久。')
      + '\n\n目前的後端程式：\n```' + (lang === 'python' ? 'python' : 'js') + '\n' + (s.backend ? trunc(s.backend.code, 9000) : '（還沒有後端）') + '\n```\n\n前端頁面（它會呼叫後端，路徑要對得上）：\n' + html + (extra ? '\n\n' + extra : '')
      + '\n\n做法：先用 sandbox_mock（JS）或 sandbox_py_app（Python）實際測試過、確認端點回應正確，再回覆。最後只用一個程式碼區塊（```' + (lang === 'python' ? 'python' : 'js') + '）給出「完整的新後端程式」，區塊後面用一兩句話說明改了什麼、有哪些路由。不要省略任何部分，也不要只給片段。';
  }
  function extractCode(text, lang) {
    var t = String(text || ''), re = /```([A-Za-z0-9_+-]*)\n([\s\S]*?)```/g, m, best = null; while ((m = re.exec(t))) { var l = m[1].toLowerCase(); if (!l || /^(js|javascript|node|mjs|python|py)$/.test(l)) { if (!lang || !l || (lang === 'python') === /^(python|py)$/.test(l) || !l) best = m[2]; } }
    return best && best.trim() ? best.replace(/\s+$/, '') + '\n' : null;
  }
  function refPrompt() { return '這是一張網頁（或 App 畫面）的截圖或設計圖。請用繁體中文簡潔描述它，讓工程師能照著做出來：整體版面（幾欄、頂部／側邊／內容區）、每個區塊的內容與文字、按鈕與表單欄位、主要顏色（用 #RRGGBB）、字體風格、圖示或圖片的位置。只描述看得到的，不要猜功能。'; }
  var TOPICS = {
    format: '網頁描述（JSON）：{title, files:[{name,content}], backend:{lang:"js"|"python", code}|null}。files[0] 是 index.html，其他檔案用 <link rel="stylesheet" href="style.css">、<script src="app.js"></script> 引用（預覽時內嵌）。後端 lang js＝沙盒 mock 伺服器的寫法（router／app.crud／app.ws／env.db），python＝Flask／FastAPI。',
    edits: '編輯動作：{op:"patch_file",name,find,replace,all?}、{op:"set_file",name,content}、{op:"add_file",name,content}、{op:"remove_file",name}、{op:"rename_file",name,to}、{op:"set_title",text}、{op:"set_backend",lang,code}、{op:"patch_backend",find,replace,all?}、{op:"remove_backend"}。patch 的 find 要跟現有內容一字不差、而且只出現一次。',
    backend: '模擬後端：只是體驗架設的感覺，要上線請匯出部署檔（含部署教學）。JS 後端（Node 風格）：const app = router(); app.crud("/api/x","x"); app.get("/api/ping", () => ({ok:true})); app.post(...); app.ws("/chat", (ws,req,env)=>{...}); 資料用 env.db（持久）；可以匯出成 Node 或 Cloudflare 的部署檔。Python 後端：Flask／Bottle／FastAPI／Starlette，用 Pyodide 跑（每個請求重新載入 app，資料請存 /tmp 的檔案或 sqlite3；不支援 WebSocket）。PHP：瀏覽器裡沒有 PHP 執行環境，目前不能跑。',
    starters: '起手式：' + STARTERS.map(function (t) { return t.id + '（' + t.label + '）'; }).join('、') + '。'
  };
  return { LIMITS: LIMITS, OPS: OPS, TOPICS: TOPICS, STARTERS: listStarters(), defaults: defaults, validate: validate, buildHtml: buildHtml, routesOf: routesOf, pyPackages: pyPackages, pyKind: pyKind, deployGuide: deployGuide, exportPython: exportPython, starter: starter, listStarters: listStarters, applyEdits: applyEdits, editWords: editWords, describe: describe, specToPrompt: specToPrompt, parseEditRequest: parseEditRequest, classify: classify, editPrompt: editPrompt, parseEditsReply: parseEditsReply, backendTask: backendTask, extractCode: extractCode, refPrompt: refPrompt, okName: okName };
});
