// node scripts/webedit-tests/webedit_core.test.js -- 網頁編輯器核心：描述驗證、預覽內嵌、起手式、編輯動作（patch 要找得到且唯一）、讀指令、前後端分流、後端任務與程式碼擷取。
const E = require('../../renderer/src/webedit/webedit_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

// ---------- 驗證 ----------
const v = E.validate({ title: 'x'.repeat(300), files: [{ name: 'style.css', content: 'a{}' }, { name: '../evil.js', content: 'x' }, { name: 'bad name.html', content: 'x' }, { name: 'a.exe', content: 'x' }, { name: 'style.css', content: 'dup' }, { name: 'index.html', content: '<p>hi</p>' }], backend: { lang: 'ruby', code: 'x' } });
check('validate: bad/duplicate/dangerous file names are dropped with reasons; index.html is moved first', v.spec.files.map((f) => f.name).join() === 'index.html,style.css' && v.problems.length >= 4, v);
check('validate: a title is cut, an unknown backend language falls back to js with a note', v.spec.title.length === 80 && v.spec.backend.lang === 'js' && v.problems.some((p) => /ruby/.test(p)));
check('validate: no index.html -> a blank one is added; garbage input never throws', E.validate({ files: [] }).spec.files[0].name === 'index.html' && (() => { try { E.validate(null); E.validate('x'); E.validate({ files: 5 }); return true; } catch (e) { return false; } })());
check('validate: size limits (a huge file is cut, too many files are dropped)', E.validate({ files: [{ name: 'index.html', content: 'a'.repeat(200000) }] }).spec.files[0].content.length === 150000 && E.validate({ files: Array.from({ length: 15 }, (_, i) => ({ name: 'f' + i + '.js', content: '' })) }).spec.files.length <= 11);
check('validate: backend code is kept only when it is not blank; python is accepted', E.validate({ backend: { code: '   ' } }).spec.backend === null && E.validate({ backend: { lang: 'python', code: 'app=1' } }).spec.backend.lang === 'python');

// ---------- 預覽：本地的 css／js 內嵌 ----------
const todo = E.starter('todo');
const html = E.buildHtml(todo);
check('buildHtml: the linked css and js files are inlined (no link/script src left), file names kept as data-file', /<style data-file="style\.css">/.test(html) && /<script data-file="app\.js">/.test(html) && !/href="style\.css"/.test(html) && !/src="app\.js"/.test(html));
check('buildHtml: an external stylesheet or script is left alone; "</script" inside a file cannot break out', (() => { const sp = { files: [{ name: 'index.html', content: '<link rel="stylesheet" href="https://x/y.css"><script src="https://x/a.js"></script><script src="a.js"></script>' }, { name: 'a.js', content: 'var s = "</script><b>";' }] }; const h = E.buildHtml(sp); return h.indexOf('href="https://x/y.css"') >= 0 && h.indexOf('src="https://x/a.js"') >= 0 && h.indexOf('<\\/script><b>') >= 0; })());

// ---------- 起手式 ----------
check('starters: blank, todo, chat, form, python_api; each validates cleanly and has what it promises', E.listStarters().map((s) => s.id).join() === 'blank,todo,chat,form,python_api' && E.listStarters().every((s) => { const sp = E.starter(s.id); return sp && E.validate(sp).problems.length === 0; }) && E.starter('nope') === null);
check('starters: todo/form/chat use the mock-server style, python_api uses Flask; the page uses relative paths only', E.starter('todo').backend.code.indexOf('app.crud') >= 0 && E.starter('chat').backend.code.indexOf('app.ws') >= 0 && E.starter('form').backend.code.indexOf('env.db') >= 0 && E.starter('python_api').backend.lang === 'python' && E.starter('todo').files.every((f) => !/https?:\/\//.test(f.content.replace(/xmlns="[^"]*"/, ''))));
check('routesOf: reads routes from JS and Python backends', E.routesOf(E.starter('todo').backend.code, 'js').join() === 'CRUD /api/todos,GET /api/ping' && E.routesOf(E.starter('chat').backend.code, 'js').join() === 'WS /chat' && E.routesOf(E.starter('python_api').backend.code, 'python').join() === 'GET /api/hello' && E.routesOf('@app.route("/x", methods=["POST","GET"])\ndef x(): pass', 'python').join() === 'POST,GET /x');

// ---------- 編輯動作 ----------
const base = E.starter('blank');
const e1 = E.applyEdits(todo, [{ op: 'patch_file', name: 'index.html', find: '<h1>待辦清單</h1>', replace: '<h1>我的待辦</h1>' }, { op: 'set_title', text: '我的待辦' }, { op: 'add_file', name: 'extra.js', content: 'console.log(1)' }, { op: 'rename_file', name: 'extra.js', to: 'more.js' }, { op: 'remove_file', name: 'more.js' }]);
check('edits: patch, set_title, add, rename, remove all work, and the input is not changed', e1.applied.length === 5 && e1.rejected.length === 0 && /我的待辦/.test(e1.spec.files[0].content) && e1.spec.title === '我的待辦' && e1.spec.files.length === 3 && /<h1>待辦清單<\/h1>/.test(todo.files[0].content));
const e2 = E.applyEdits(todo, [{ op: 'patch_file', name: 'index.html', find: '不存在的文字', replace: 'x' }, { op: 'patch_file', name: 'style.css', find: 'padding', replace: 'margin' }, { op: 'remove_file', name: 'index.html' }, { op: 'rename_file', name: 'index.html', to: 'a.html' }, { op: 'add_file', name: 'app.js', content: '' }, { op: 'add_file', name: '../x.js', content: '' }, { op: 'set_file', name: 'nope.js', content: '' }, { op: 'format_disk' }]);
check('edits: a patch must find its text and find it only once; the entry file is protected; bad names/duplicates/unknown ops are rejected with the reason', e2.applied.length === 0 && e2.rejected.length === 8 && /找不到/.test(e2.rejected[0].error) && /出現 \d+ 次/.test(e2.rejected[1].error) && /進入點/.test(e2.rejected[2].error) && /進入點/.test(e2.rejected[3].error) && /已經存在/.test(e2.rejected[4].error) && /不合法/.test(e2.rejected[5].error) && /沒有檔案/.test(e2.rejected[6].error) && /不認得/.test(e2.rejected[7].error), e2.rejected.map((x) => x.error.slice(0, 20)));
check('edits: patch with all:true replaces every occurrence', E.applyEdits(todo, [{ op: 'patch_file', name: 'style.css', find: 'padding', replace: 'margin', all: true }]).spec.files[1].content.indexOf('padding') < 0);
check('edits: renaming a file updates the quoted references in index.html', E.applyEdits(todo, [{ op: 'rename_file', name: 'style.css', to: 'theme.css' }]).spec.files[0].content.indexOf('href="theme.css"') >= 0);
const e3 = E.applyEdits(base, [{ op: 'set_backend', lang: 'js', code: 'const app = router();\napp.get("/api/x", () => ({ok:true}));' }, { op: 'patch_backend', find: '"/api/x"', replace: '"/api/y"' }]);
check('backend edits: set_backend, then patch_backend on it', e3.applied.length === 2 && E.routesOf(e3.spec.backend.code, 'js').join() === 'GET /api/y');
const e4 = E.applyEdits(base, [{ op: 'set_backend', lang: 'php', code: '<?php echo 1;' }, { op: 'set_backend', lang: 'js', code: '  ' }, { op: 'patch_backend', find: 'a', replace: 'b' }, { op: 'remove_backend' }]);
check('backend edits: PHP is refused with the reason, empty code is refused, patching/removing without a backend is refused', e4.applied.length === 0 && e4.rejected.length === 4 && /PHP/.test(e4.rejected[0].error), e4.rejected.map((x) => x.error.slice(0, 24)));
check('backend edits: remove_backend works', E.applyEdits(E.starter('todo'), [{ op: 'remove_backend' }]).spec.backend === null);

// ---------- 讀指令 / 分流 ----------
const PR = E.parseEditRequest('標題改成「我的相簿」，刪掉 style.css，把 app.js 改名為 main.js，把按鈕變成圓的', todo);
check('edit request: title, delete file, rename file are read by the program; the rest is left for the AI', PR.edits.map((e) => e.op).join() === 'set_title,remove_file,rename_file' && PR.edits[0].text === '我的相簿' && PR.unmatched.join() === '把按鈕變成圓的', PR);
check('classify: backend words / frontend words / both', (() => { const c = (t) => E.classify(t); return c('加一個 /api/users 的端點').backend === true && c('把按鈕顏色改成藍色').backend === false && c('把按鈕顏色改成藍色').frontend === true && c('新增登入功能：頁面加表單，後端驗證').backend === true && c('新增登入功能：頁面加表單，後端驗證').frontend === true; })());
// ---------- 給模型的提示 ----------
const P = E.editPrompt(todo, '把標題換成紅色', '使用者附了參考圖，描述如下：…');
check('editPrompt: closed op list, file contents, backend routes, the image description, the sentence', /patch_file/.test(P.system) && /只回一段 JSON/.test(P.system) && /=== index\.html ===/.test(P.user) && /CRUD \/api\/todos/.test(P.user) && /參考圖/.test(P.user) && /把標題換成紅色/.test(P.user) && /後端的程式不要在這裡改/.test(P.system));
check('editPrompt: long files are truncated', E.editPrompt({ files: [{ name: 'index.html', content: 'x'.repeat(30000) }] }, 'x').user.length < 12000);
const R = E.parseEditsReply('好：{"say":"改好了","edits":[{"op":"set_title","text":"x"},{"op":"rm_rf"},{"nope":1}]}');
check('parseEditsReply: only closed ops survive; garbage is not ok', R.ok && R.edits.length === 1 && R.dropped === 2 && E.parseEditsReply('hello').ok === false);
// ---------- 後端任務（交給程式設計領域）----------
const T = E.backendTask(todo, '加一個 /api/search?q= 的搜尋端點');
check('backendTask: self-contained (request, current backend, the page that calls it, the dialect, how to test, the answer format)', /搜尋端點/.test(T) && /app\.crud/.test(T) && /index\.html/.test(T) && /sandbox_mock/.test(T) && /完整的新後端程式/.test(T) && /router\(\)/.test(T));
check('backendTask: python backends get the Flask/Pyodide dialect', /Flask/.test(E.backendTask(E.starter('python_api'), '加一個端點')) && /不支援 WebSocket/.test(E.backendTask(E.starter('python_api'), 'x')));
check('extractCode: takes the last code block of the right language; none -> null', E.extractCode('說明\n```js\nconst a=1\n```\n好了\n```js\nconst app = router();\n```\n結束', 'js') === 'const app = router();\n' && E.extractCode('沒有程式碼', 'js') === null && E.extractCode('```python\napp = 1\n```', 'python') === 'app = 1\n' && E.extractCode('```python\napp = 1\n```', 'js') === null);
// ---------- 摘要 prompt ----------
const SP = E.specToPrompt(E.applyEdits(todo, [{ op: 'set_title', text: '我的待辦' }]).spec, [{ kind: 'start', summary: '開始' }, { kind: 'chat', text: '改標題', summary: '標題改成「我的待辦」' }]);
check('specToPrompt: files, backend routes, the edit steps (no start)', /我的待辦/.test(SP) && /index\.html/.test(SP) && /CRUD \/api\/todos/.test(SP) && /編輯過程/.test(SP) && /1\. 我說：「改標題」/.test(SP) && !/開始/.test(SP), SP);
check('pyPackages: Flask/FastAPI/Bottle imports are mapped to installable packages (once each); plain stdlib needs none', E.pyPackages(E.starter('python_api').backend.code).join() === 'flask' && E.pyPackages('import json\nfrom fastapi import FastAPI\nfrom pydantic import BaseModel\nimport flask').join() === 'fastapi,pydantic,flask' && E.pyPackages('import os, sqlite3\n').length === 0);
check('describe / editWords / refPrompt / topics exist and mention what they should', E.describe(todo).join().includes('待辦清單') && E.editWords({ op: 'patch_file', name: 'a.js' }) === '修改 a.js' && /版面/.test(E.refPrompt()) && /PHP/.test(E.TOPICS.backend) && /todo/.test(E.TOPICS.starters));
console.log((bad.length ? 'FAIL' : 'PASS') + ' 網頁編輯器核心（描述驗證、預覽內嵌、起手式、編輯動作、讀指令與分流、後端任務、摘要 prompt）：' + ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
