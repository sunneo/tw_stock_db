/* 網頁編輯器的畫面（對話裡的小工具）：左邊是「預覽／程式碼／後端」三個分頁，右邊是 AI 助手與編輯記錄；復原／重做、摘要成 prompt、匯出。
 * 後端分頁就是「模擬後端編輯器」：選語言（JS 的 Node 風格或 Python）、改程式、重啟、看路由、送測試請求、看請求紀錄與持久資料。
 * 狀態（每一步的描述、復原位置、對話紀錄）會存起來，重新開啟後接著編輯。只依賴 FaWebEdit 與 host：
 *   host.start(iframe, spec) -> Promise<{ok, kind, routes, wsRoutes, error?}>   （啟動／重啟預覽與後端；後端程式沒變就不重啟）
 *   host.stop()
 *   host.request({method,url,headers,body}) -> Promise<{status, headers, body}>    （後端分頁的測試請求）
 *   host.log() -> {calls:[…], console:[…]}                                         （請求紀錄與伺服器 console）
 *   host.db(op, args) -> Promise                                                    （JS 後端：list／get／set／delete／clear）
 *   host.exportBackend(target) -> Promise<{files:[{name,content}], note}>          （node／cloudflare）
 *   host.ask({text, images, spec, onStatus}) -> Promise<{say, edits?, refs?, notes?}>   （程式讀不懂的句子／附圖／後端要改時才呼叫）
 *   host.download(blob, name, mime)、host.save(state)、host.regenerate(promptText)?、host.polish(text)?、host.palette()? */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./webedit_core.js'), require('../ui/win_shell.js')); else root.FaWebEditUI = factory(root.FaWebEdit || (typeof FaWebEdit !== 'undefined' ? FaWebEdit : undefined), root.FaWin || (typeof FaWin !== 'undefined' ? FaWin : undefined));
})(typeof self !== 'undefined' ? self : this, function (WE, WIN) {
  'use strict';
  var MAXSTATES = 25;
  var CSS = '.fwe{--bg:#fff;--fg:#1f2328;--bd:#d0d7de;--hd:#f6f8fa;--mut:#59636e;--acc:#0969da;--ok:#1a7f37;--bad:#cf222e;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);font:13px system-ui,"Microsoft JhengHei",sans-serif;margin:6px 0;overflow:hidden;max-width:100%}.fwe.dark{--bg:#0d1117;--fg:#e6edf3;--bd:#30363d;--hd:#161b22;--mut:#8b949e;--acc:#2f81f7;--ok:#3fb950;--bad:#f85149}'
    + '.fwe *{box-sizing:border-box}.fwe button{background:var(--hd);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit}.fwe button:hover:not(:disabled){border-color:var(--acc)}.fwe button:disabled{opacity:.4;cursor:default}.fwe button.pri{background:var(--acc);border-color:var(--acc);color:#fff}'
    + '.fwe input,.fwe select,.fwe textarea{background:var(--bg);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:3px 6px;font:inherit;max-width:100%}.fwe textarea{width:100%;resize:vertical}.fwe textarea.code{font:12px/1.45 ui-monospace,Consolas,"Courier New",monospace;tab-size:2;white-space:pre;overflow:auto}'
    + '.fwe .bar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--hd);border-bottom:1px solid var(--bd);flex-wrap:wrap}.fwe .ttl{font-weight:600;margin-right:auto}.fwe .st{color:var(--mut);font-size:12px}'
    + '.fwe .main{display:flex;flex-wrap:wrap;align-items:stretch}.fwe .left{flex:1.5 1 420px;min-width:300px;display:flex;flex-direction:column;min-height:420px}.fwe .side{flex:1 1 280px;min-width:260px;display:flex;flex-direction:column;border-left:1px solid var(--bd);max-height:600px}'
    + '.fwe .tabs{display:flex;border-bottom:1px solid var(--bd);background:var(--hd)}.fwe .tabs span{padding:6px 12px;cursor:pointer;color:var(--mut);border-bottom:2px solid transparent}.fwe .tabs span.on{color:var(--fg);border-bottom-color:var(--acc);font-weight:600}.fwe .pane{display:none;flex:1;overflow:auto;padding:8px;min-height:240px;flex-direction:column;gap:6px}.fwe .pane.on{display:flex}'
    + '.fwe .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.fwe .row label{color:var(--mut)}.fwe .frame{flex:1;min-height:320px;border:1px solid var(--bd);border-radius:6px;background:#fff;width:100%}.fwe .frame.m{max-width:390px;align-self:center}.fwe .frame.t{max-width:768px;align-self:center}'
    + '.fwe .files{display:flex;gap:4px;flex-wrap:wrap}.fwe .files span{padding:2px 9px;border:1px solid var(--bd);border-radius:5px;cursor:pointer}.fwe .files span.on{border-color:var(--acc);background:rgba(47,129,247,.12);font-weight:600}'
    + '.fwe .log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:120px}.fwe .msg{padding:5px 8px;border-radius:7px;max-width:92%;white-space:pre-wrap;word-break:break-word}.fwe .msg.u{align-self:flex-end;background:var(--acc);color:#fff}.fwe .msg.a{align-self:flex-start;background:var(--hd);border:1px solid var(--bd)}.fwe .chip{display:inline-block;margin:2px 3px 0 0;padding:0 6px;border-radius:9px;background:rgba(47,129,247,.15);font-size:11px}.fwe .chip.rej{background:rgba(248,81,73,.18)}'
    + '.fwe .att{display:flex;gap:4px;flex-wrap:wrap}.fwe .att span{position:relative;display:inline-block}.fwe .att img{height:44px;border:1px solid var(--bd);border-radius:4px}.fwe .att b{position:absolute;top:-5px;right:-5px;background:var(--bad);color:#fff;border-radius:50%;width:15px;height:15px;font-size:10px;line-height:15px;text-align:center;cursor:pointer}'
    + '.fwe .hist div{padding:3px 6px;border-radius:5px;cursor:pointer;border:1px solid transparent}.fwe .hist div:hover{border-color:var(--bd)}.fwe .hist div.cur{background:rgba(47,129,247,.14);font-weight:600}.fwe .hist div.fut{opacity:.45}.fwe .sum{padding:8px;border-bottom:1px solid var(--bd);background:var(--hd);display:none;flex-direction:column;gap:6px}.fwe .sum.on{display:flex}'
    + '.fwe pre.out{margin:0;padding:6px;background:var(--hd);border:1px solid var(--bd);border-radius:6px;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-all;font:12px ui-monospace,Consolas,monospace}.fwe .calls div{padding:1px 0;font:12px ui-monospace,Consolas,monospace}.fwe .bad{color:var(--bad)}.fwe .good{color:var(--ok)}'
    + '.fwe.full{position:fixed;inset:8px;z-index:100000;margin:0;display:flex;flex-direction:column;max-width:none;box-shadow:0 8px 40px rgba(0,0,0,.5)}.fwe.full .main{flex:1;min-height:0}.fwe.full .side{max-height:none}';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function mount(opt) {
    var W = opt.W || WE, host = opt.host || {}, el = h('div', 'fwe'); var dark = false; try { dark = !!(host.palette && host.palette().dark); } catch (e) { dark = false; } if (dark) el.className += ' dark';
    if (!document.getElementById('fwe-css')) { var st0 = document.createElement('style'); st0.id = 'fwe-css'; st0.textContent = CSS; (document.head || document.documentElement).appendChild(st0); }
    var S = { v: 1, ptr: 0, states: [], log: [] }, leftTab = 'preview', rightTab = 'ai', curFile = 'index.html', pending = [], busy = false, saveT = null, previewT = null, lastRun = '';
    function initState(state, spec) {
      if (state && Array.isArray(state.states) && state.states.length) { S = { v: 1, ptr: Math.max(0, Math.min(state.states.length - 1, state.ptr | 0)), states: state.states.slice(-MAXSTATES).map(function (x) { return { spec: W.validate(x.spec).spec, summary: x.summary || '', text: x.text || '', kind: x.kind || 'panel', t: x.t || 0 }; }), log: Array.isArray(state.log) ? state.log.slice(-60) : [] }; if (S.ptr >= S.states.length) S.ptr = S.states.length - 1; }
      else S = { v: 1, ptr: 0, states: [{ spec: W.validate(spec || W.defaults()).spec, summary: '開始', text: '', kind: 'start', t: Date.now() }], log: [] };
    }
    function cur() { return S.states[S.ptr].spec; }
    function getState() { var st = { v: 1, ptr: S.ptr, states: S.states, log: S.log.slice(-60) }; try { while (JSON.stringify(st).length > 2500000 && st.states.length > 2) { st.states = st.states.slice(1); st.ptr = Math.max(0, st.ptr - 1); } } catch (e) { /* 照存 */ } return st; }
    function persist() { clearTimeout(saveT); saveT = setTimeout(function () { try { if (host.save) host.save(getState()); } catch (e) { /* 存不了這次還是有效 */ } }, 400); }
    function commit(spec, summary, text, kind) { S.states = S.states.slice(0, S.ptr + 1); S.states.push({ spec: W.validate(spec).spec, summary: summary || '', text: text || '', kind: kind || 'panel', t: Date.now() }); if (S.states.length > MAXSTATES) S.states.shift(); S.ptr = S.states.length - 1; render(); persist(); }
    function apply(edits, summary, text, kind) { var r = W.applyEdits(cur(), edits); if (!r.applied.length) return r; var words = summary || edits.filter(function (e) { return r.applied.indexOf(e.op) >= 0; }).map(W.editWords).filter(Boolean).join('；'); commit(r.spec, words, text, kind); return r; }
    function undo() { if (S.ptr > 0) { S.ptr--; render(); persist(); } }
    function redo() { if (S.ptr < S.states.length - 1) { S.ptr++; render(); persist(); } }

    // ───── 骨架 ─────
    var bar = h('div', 'bar'), ttl = h('span', 'ttl', '🌐 網頁編輯器'), stat = h('span', 'st'), bUndo = h('button', null, '↶ 復原'), bRedo = h('button', null, '↷ 重做'), bTpl = h('button', null, '📋 起手式'), bSum = h('button', null, '📝 摘要成 prompt'), bExp = h('select'), bFull = h('button', null, '⛶');
    bUndo.title = 'Ctrl+Z'; bRedo.title = 'Ctrl+Y';
    [['', '⬇ 匯出…'], ['html', '網頁（單一 HTML）'], ['json', '專案描述（JSON）'], ['node', '後端：Node 部署檔'], ['cloudflare', '後端：Cloudflare 部署檔']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; bExp.appendChild(op); });
    [ttl, stat, bUndo, bRedo, bTpl, bSum, bExp].forEach(function (x) { bar.appendChild(x); });
    var tpl = h('div', 'sum'), tplList = h('div', 'row'), tplX = h('button', null, '✕'); tpl.appendChild(h('div', 'st', '從起手式開始（會換掉目前的內容，這一步可以復原）：')); tpl.appendChild(tplList); tpl.appendChild(tplX);
    (W.listStarters ? W.listStarters() : []).forEach(function (t) { var b = h('button', null, t.label); b.title = t.desc; b.onclick = function () { var sp = W.starter(t.id); if (sp) { commit(sp, '從起手式「' + t.label + '」開始', '', 'chat'); tpl.className = 'sum'; curFile = 'index.html'; } }; tplList.appendChild(b); });
    bTpl.onclick = function () { tpl.className = tpl.className.indexOf(' on') >= 0 ? 'sum' : 'sum on'; }; tplX.onclick = function () { tpl.className = 'sum'; };
    var sum = h('div', 'sum'), sumTa = h('textarea'); sumTa.rows = 8; var sumRow = h('div', 'row'), bCopy = h('button', null, '📋 複製'), bRegen = h('button', 'pri', '↻ 用這段重新生成'), bPol = h('button', null, '✨ 請 AI 潤飾'), bSumX = h('button', null, '✕'); [bCopy, bRegen, bPol, bSumX].forEach(function (x) { sumRow.appendChild(x); }); sumRow.insertBefore(h('span', 'st', '把目前的網站與編輯過程整理成一段可以重用的描述'), bCopy); sum.appendChild(sumTa); sum.appendChild(sumRow);
    var main = h('div', 'main'), left = h('div', 'left'), lTabs = h('div', 'tabs'), side = h('div', 'side'), rTabs = h('div', 'tabs');
    var lp = { preview: h('div', 'pane'), code: h('div', 'pane'), backend: h('div', 'pane') }, rp = { ai: h('div', 'pane'), hist: h('div', 'pane hist') };
    [['preview', '👁 預覽'], ['code', '🧩 程式碼'], ['backend', '🖥 後端']].forEach(function (t) { var s = h('span', null, t[1]); s.setAttribute('data-t', t[0]); s.onclick = function () { leftTab = t[0]; showTabs(); if (t[0] === 'backend') refreshBackend(); }; lTabs.appendChild(s); });
    [['ai', '🤖 AI 助手'], ['hist', '🕘 記錄']].forEach(function (t) { var s = h('span', null, t[1]); s.setAttribute('data-t', t[0]); s.onclick = function () { rightTab = t[0]; showTabs(); }; rTabs.appendChild(s); });
    left.appendChild(lTabs); ['preview', 'code', 'backend'].forEach(function (k) { left.appendChild(lp[k]); }); side.appendChild(rTabs); ['ai', 'hist'].forEach(function (k) { side.appendChild(rp[k]); }); main.appendChild(left); main.appendChild(side);
    el.appendChild(bar); el.appendChild(tpl); el.appendChild(sum); el.appendChild(main);
    function showTabs() { Array.prototype.forEach.call(lTabs.children, function (s) { s.className = s.getAttribute('data-t') === leftTab ? 'on' : ''; }); Array.prototype.forEach.call(rTabs.children, function (s) { s.className = s.getAttribute('data-t') === rightTab ? 'on' : ''; }); Object.keys(lp).forEach(function (k) { lp[k].className = 'pane' + (k === leftTab ? ' on' : ''); }); Object.keys(rp).forEach(function (k) { rp[k].className = 'pane' + (k === 'hist' ? ' hist' : '') + (k === rightTab ? ' on' : ''); }); }

    // ───── 預覽 ─────
    var pvBar = h('div', 'row'), bReload = h('button', null, '↻ 重新載入'), vw = h('select'), pvStat = h('span', 'st'), frame = h('iframe', 'frame'); frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    [['', '桌面'], ['t', '平板 768'], ['m', '手機 390']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; vw.appendChild(op); }); vw.onchange = function () { frame.className = 'frame' + (vw.value ? ' ' + vw.value : ''); };
    [bReload, vw, pvStat].forEach(function (x) { pvBar.appendChild(x); }); lp.preview.appendChild(pvBar); lp.preview.appendChild(frame);
    function startPreview(force, opts) {
      clearTimeout(previewT); previewT = setTimeout(function () {
        var sp = cur(), key = JSON.stringify([sp.files, sp.backend]); if (!force && key === lastRun) return; lastRun = key; if (!host.start) { frame.srcdoc = W.buildHtml(sp); pvStat.textContent = '（這個環境沒有沙盒，只顯示頁面）'; return; }
        pvStat.textContent = '啟動中…'; Promise.resolve(host.start(frame, sp, opts)).then(function (r) { r = r || {}; if (r.ok === false) { pvStat.textContent = '⚠ ' + (r.error || '啟動失敗'); pvStat.className = 'st bad'; } else { pvStat.className = 'st'; pvStat.textContent = r.kind ? '● 後端已啟動（' + (r.kind === 'python' ? 'Python' : 'JS') + '，' + ((r.routes || []).length + (r.wsRoutes || []).length) + ' 個路由）' : '● 純前端（沒有後端）'; } if (leftTab === 'backend') refreshBackend(); }, function (e) { pvStat.className = 'st bad'; pvStat.textContent = '⚠ ' + String((e && e.message) || e).slice(0, 100); });
      }, 250);
    }
    bReload.onclick = function () { startPreview(true); };

    // ───── 程式碼 ─────
    var fileBar = h('div', 'files'), fileTools = h('div', 'row'), codeTa = h('textarea', 'code'); codeTa.rows = 18; codeTa.spellcheck = false; var bAdd = h('button', null, '＋ 新增檔案'), bDel = h('button', null, '🗑 刪除這個檔'), bRen = h('button', null, '✎ 改名'), fnIn = h('input'); fnIn.placeholder = '檔名，例如 app.js'; fnIn.style.display = 'none'; fnIn.style.width = '160px'; var fnMode = '', fnOk = h('button', 'pri', '確定'); fnOk.style.display = 'none';
    [bAdd, bRen, bDel, fnIn, fnOk].forEach(function (x) { fileTools.appendChild(x); }); lp.code.appendChild(fileBar); lp.code.appendChild(codeTa); lp.code.appendChild(fileTools);
    codeTa.addEventListener('keydown', function (ev) { if (ev.key === 'Tab' && !ev.shiftKey) { ev.preventDefault(); var s = codeTa.selectionStart; codeTa.value = codeTa.value.slice(0, s) + '  ' + codeTa.value.slice(codeTa.selectionEnd); codeTa.selectionStart = codeTa.selectionEnd = s + 2; } });
    codeTa.onchange = function () { var f = cur().files.filter(function (x) { return x.name === curFile; })[0]; if (f && f.content !== codeTa.value) apply([{ op: 'set_file', name: curFile, content: codeTa.value }], '手動修改 ' + curFile, '', 'panel'); };
    function fileUi(mode) { fnMode = mode; fnIn.style.display = fnOk.style.display = ''; fnIn.value = mode === 'rename' ? curFile : ''; fnIn.focus(); }
    bAdd.onclick = function () { fileUi('add'); }; bRen.onclick = function () { if (curFile !== 'index.html') fileUi('rename'); };
    fnOk.onclick = function () { var n = fnIn.value.trim(); var r = fnMode === 'add' ? apply([{ op: 'add_file', name: n, content: '' }], '新增 ' + n, '', 'panel') : apply([{ op: 'rename_file', name: curFile, to: n }], curFile + ' 改名為 ' + n, '', 'panel'); if (r.rejected && r.rejected.length) { stat.textContent = r.rejected[0].error; setTimeout(function () { stat.textContent = ''; }, 3500); } else { curFile = n; fnIn.style.display = fnOk.style.display = 'none'; render(); } };
    bDel.onclick = function () { if (curFile === 'index.html') { stat.textContent = 'index.html 是進入點，不能刪'; setTimeout(function () { stat.textContent = ''; }, 2500); return; } apply([{ op: 'remove_file', name: curFile }], '刪掉 ' + curFile, '', 'panel'); curFile = 'index.html'; render(); };
    function renderCode() { var sp = cur(); if (!sp.files.some(function (f) { return f.name === curFile; })) curFile = 'index.html'; fileBar.textContent = ''; sp.files.forEach(function (f) { var s = h('span', f.name === curFile ? 'on' : '', f.name); s.onclick = function () { curFile = f.name; renderCode(); }; fileBar.appendChild(s); }); var f0 = sp.files.filter(function (f) { return f.name === curFile; })[0]; codeTa.value = f0 ? f0.content : ''; bDel.disabled = curFile === 'index.html'; bRen.disabled = curFile === 'index.html'; }

    // ───── 後端（模擬後端編輯器）─────
    var beBar = h('div', 'row'), lang = h('select'), bApply = h('button', 'pri', '▶ 套用並重啟'), bBeX = h('button', null, '✕ 移除後端'), bRefresh = h('button', null, '🔄 重整後端'), beStat = h('span', 'st'), beTa = h('textarea', 'code'); beTa.rows = 14; beTa.spellcheck = false;
    [['none', '沒有後端'], ['js', 'JS（Node 風格）'], ['python', 'Python（Flask／FastAPI）'], ['php', 'PHP（目前不能執行）']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; if (o[0] === 'php') op.disabled = true; lang.appendChild(op); });
    bRefresh.title = '這會讓套件重裝'; bRefresh.setAttribute('aria-label', '重整後端：這會讓套件重裝');
    [h('label', null, '語言'), lang, bApply, bRefresh, bBeX, beStat].forEach(function (x) { beBar.appendChild(x); }); lp.backend.appendChild(beBar); lp.backend.appendChild(beTa);
    beTa.addEventListener('keydown', function (ev) { if (ev.key === 'Tab' && !ev.shiftKey) { ev.preventDefault(); var s = beTa.selectionStart; beTa.value = beTa.value.slice(0, s) + (lang.value === 'python' ? '    ' : '  ') + beTa.value.slice(beTa.selectionEnd); beTa.selectionStart = beTa.selectionEnd = s + (lang.value === 'python' ? 4 : 2); } });
    lang.onchange = function () { if (lang.value === 'none') return; if (!beTa.value.trim()) beTa.value = lang.value === 'python' ? 'from flask import Flask, jsonify\n\napp = Flask(__name__)\n\n@app.get("/api/ping")\ndef ping():\n    return jsonify({"ok": True})\n' : '// 模擬後端（Node 風格）\nconst app = router();\napp.get("/api/ping", () => ({ ok: true }));\n'; };
    bApply.onclick = function () { if (lang.value === 'none') { if (cur().backend) apply([{ op: 'remove_backend' }], '移除後端', '', 'panel'); return; } var r = apply([{ op: 'set_backend', lang: lang.value, code: beTa.value }], '手動修改後端（' + (lang.value === 'python' ? 'Python' : 'JS') + '）', '', 'panel'); if (r.rejected && r.rejected.length) { beStat.className = 'st bad'; beStat.textContent = r.rejected[0].error; } else if (!r.applied.length) { startPreview(true); } };
    bRefresh.onclick = function () { if (!cur().backend) return; startPreview(true, { refresh: true }); };
    bBeX.onclick = function () { if (cur().backend) apply([{ op: 'remove_backend' }], '移除後端', '', 'panel'); };
    var routesBox = h('div', 'st'), tester = h('div', 'row'), tm = h('select'), tu = h('input'), tb = h('textarea'), tgo = h('button', 'pri', '送出'), tout = h('pre', 'out'); tb.rows = 2; tb.placeholder = '請求內容（JSON 或文字，沒有就留空）'; tu.placeholder = '/api/ping'; tu.style.flex = '1'; tout.textContent = '（測試請求的回應會顯示在這裡）';
    ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].forEach(function (m) { var op = h('option', null, m); tm.appendChild(op); }); [tm, tu, tgo].forEach(function (x) { tester.appendChild(x); });
    tgo.onclick = function () {
      if (!host.request) return; tout.textContent = '送出中…'; var body = tb.value.trim(), headers = []; if (body && /^[\[{]/.test(body)) headers.push(['content-type', 'application/json']);
      Promise.resolve(host.request({ method: tm.value, url: tu.value || '/', headers: headers, body: body && tm.value !== 'GET' ? body : null })).then(function (r) { var t = r && r.body != null ? String(r.body) : ''; try { t = JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* 純文字 */ } tout.textContent = (r.status || '') + ' ' + (r.statusText || '') + '\n' + t.slice(0, 4000); refreshBackend(true); }, function (e) { tout.textContent = '失敗：' + String((e && e.message) || e); });
    };
    var callsBox = h('div', 'calls'), dbBar = h('div', 'row'), bDb = h('button', null, '🗂 看持久資料'), bDbClear = h('button', null, '🧹 清除資料'), dbOut = h('pre', 'out'); dbOut.style.display = 'none'; [bDb, bDbClear].forEach(function (x) { dbBar.appendChild(x); });
    bDb.onclick = function () { if (!host.db) return; dbOut.style.display = ''; dbOut.textContent = '讀取中…'; Promise.resolve(host.db('list', [''])).then(function (r) { var rows = Array.isArray(r) ? r : (r && r.entries) || []; dbOut.textContent = rows.length ? rows.slice(0, 60).map(function (x) { return (x.key || x[0]) + ' = ' + JSON.stringify(x.value != null ? x.value : x[1]); }).join('\n').slice(0, 4000) : '（沒有資料）'; }, function (e) { dbOut.textContent = '失敗：' + String((e && e.message) || e); }); };
    bDbClear.onclick = function () { if (!host.db) return; Promise.resolve(host.db('clear', [])).then(function () { dbOut.style.display = ''; dbOut.textContent = '已清除資料'; startPreview(true); }); };
    var expBar = h('div', 'row'); var bE1 = h('button', null, '⬇ Node 部署檔'), bE2 = h('button', null, '⬇ Cloudflare 部署檔'), bE3 = h('button', null, '⬇ Python 部署檔（含教學）'); [bE1, bE2, bE3].forEach(function (x) { expBar.appendChild(x); });
    [routesBox, h('div', 'st', '測試請求（直接送給模擬後端，不經過頁面）：'), tester, tb, tout, h('div', 'st', '請求紀錄（頁面與測試請求；最近 30 筆）：'), callsBox, dbBar, dbOut, expBar].forEach(function (x) { lp.backend.appendChild(x); });
    function refreshBackend(keep) {
      var b = cur().backend; if (!keep || document.activeElement !== beTa) { lang.value = b ? b.lang : 'none'; if (document.activeElement !== beTa) beTa.value = b ? b.code : ''; }
      beTa.disabled = false; beStat.className = 'st'; beStat.textContent = b ? '' : '目前沒有後端：頁面的 fetch 會直接走瀏覽器網路'; var rs = b ? W.routesOf(b.code, b.lang) : []; routesBox.textContent = rs.length ? '路由：' + rs.join('　') : (b ? '（程式裡讀不到路由）' : '');
      [tm, tu, tgo, tb, bDb, bDbClear].forEach(function (x) { x.disabled = !b || !host.request; }); bDb.disabled = !b || b.lang !== 'js' || !host.db; bDbClear.disabled = bDb.disabled; bE1.disabled = bE2.disabled = !b || b.lang !== 'js' || !host.exportBackend; bE3.disabled = !b || b.lang !== 'python' || !host.exportBackend; bBeX.disabled = !b;
      var lg = host.log ? host.log() : null; callsBox.textContent = ''; var calls = (lg && lg.calls || []).slice(-30); calls.forEach(function (c) { var d = h('div', c.status >= 400 || c.error ? 'bad' : 'good', (c.kind === 'ws' ? 'WS  ' + (c.ev || '') + ' ' + (c.path || '') + (c.data ? '  ' + c.data : '') : (c.method || '') + ' ' + (c.path || '') + ' → ' + (c.status || '?') + (c.ms != null ? '（' + c.ms + ' ms）' : '') + (c.error ? ' ' + c.error : ''))); callsBox.appendChild(d); }); if (!calls.length) callsBox.appendChild(h('div', 'st', '（還沒有請求）')); (lg && lg.console || []).slice(-6).forEach(function (c) { callsBox.appendChild(h('div', c.l === 'error' ? 'bad' : 'st', '[console.' + (c.l || 'log') + '] ' + String(c.m != null ? c.m : JSON.stringify(c)).slice(0, 160))); });
    }
    function doExport(target) { if (!host.exportBackend) return; stat.textContent = '產生部署檔…'; Promise.resolve(host.exportBackend(target)).then(function (r) { (r.files || []).forEach(function (f) { host.download(new Blob([f.content], { type: 'text/plain' }), f.name.replace(/\//g, '_'), 'text/plain'); }); stat.textContent = (r.files || []).length + ' 個檔案已匯出' + (r.note ? '：' + r.note : ''); setTimeout(function () { stat.textContent = ''; }, 5000); }, function (e) { stat.textContent = '匯出失敗：' + String((e && e.message) || e).slice(0, 80); }); }
    bE1.onclick = function () { doExport('node'); }; bE2.onclick = function () { doExport('cloudflare'); }; bE3.onclick = function () { doExport('python'); };

    // ───── 記錄 ─────
    function renderHist() { var p = rp.hist; p.textContent = ''; p.appendChild(h('div', 'st', '點一步就回到那一步（之後的步驟還在，可以重做）：')); S.states.forEach(function (s, i) { var d = h('div', i === S.ptr ? 'cur' : (i > S.ptr ? 'fut' : ''), (i + 1) + '. ' + (s.summary || '（沒有說明）') + (s.text ? '　— 「' + s.text.slice(0, 30) + '」' : '')); d.onclick = function () { S.ptr = i; render(); persist(); }; p.appendChild(d); }); }

    // ───── AI 對話（可附圖）─────
    var logEl = h('div', 'log'), attEl = h('div', 'att'), inRow = h('div', 'row'), ta = h('textarea'), bAtt = h('button', null, '📎'), bSend = h('button', 'pri', '送出'), file = h('input'); file.type = 'file'; file.accept = 'image/*'; file.multiple = true; file.style.display = 'none';
    ta.rows = 2; ta.placeholder = '說說想怎麼改（頁面或後端都可以），例如「新增一個搜尋框」「後端加一個 /api/search」；也可以附一張設計圖叫我照著做'; bAtt.title = '附圖（也可以直接貼上、拖進來）'; inRow.appendChild(bAtt); inRow.appendChild(bSend);
    rp.ai.appendChild(logEl); rp.ai.appendChild(attEl); rp.ai.appendChild(ta); rp.ai.appendChild(inRow); rp.ai.appendChild(file);
    function addMsg(role, text, chips, rejected) { var m = h('div', 'msg ' + (role === 'user' ? 'u' : 'a')); m.appendChild(document.createTextNode(text || '')); (chips || []).forEach(function (c) { m.appendChild(h('span', 'chip', c)); }); (rejected || []).forEach(function (c) { m.appendChild(h('span', 'chip rej', c)); }); logEl.appendChild(m); logEl.scrollTop = logEl.scrollHeight; return m; }
    function renderLog() { logEl.textContent = ''; if (!S.log.length) addMsg('ai', '我在這裡幫你改這個網站：頁面（HTML／CSS／JS）我直接改；後端的修改我會請「程式設計」的專家來做，並在模擬後端裡先測過。直接說就好，改錯了可以按「復原」。也可以按上面的「📋 起手式」選一個小專案開始，或附一張設計圖。'); S.log.forEach(function (m) { addMsg(m.role, m.text, m.chips, m.rejected); }); }
    function readFile(f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { res({ name: f.name || 'image', dataUrl: String(r.result) }); }; r.onerror = function () { res(null); }; r.readAsDataURL(f); }); }
    function addFiles(files) { Promise.all(Array.prototype.filter.call(files || [], function (f) { return /^image\//.test(f.type); }).slice(0, 3).map(readFile)).then(function (list) { list.filter(Boolean).forEach(function (x) { if (pending.length < 3) pending.push(x); }); renderAtt(); }); }
    function renderAtt() { attEl.textContent = ''; pending.forEach(function (x, i) { var s = h('span'), im = h('img'); im.src = x.dataUrl; im.alt = x.name; var rm = h('b', null, '×'); rm.onclick = function () { pending.splice(i, 1); renderAtt(); }; s.appendChild(im); s.appendChild(rm); attEl.appendChild(s); }); }
    bAtt.onclick = function () { file.click(); }; file.onchange = function () { addFiles(file.files); file.value = ''; };
    ta.addEventListener('paste', function (ev) { var items = ev.clipboardData && ev.clipboardData.files; if (items && items.length) { addFiles(items); ev.preventDefault(); } });
    ['dragover', 'drop'].forEach(function (n) { rp.ai.addEventListener(n, function (ev) { ev.preventDefault(); if (n === 'drop' && ev.dataTransfer) addFiles(ev.dataTransfer.files); }); });
    ta.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); } });
    async function send() {
      var text = ta.value.trim(), imgs = pending.slice(); if (busy || (!text && !imgs.length)) return; busy = true; bSend.disabled = true; ta.value = ''; pending = []; renderAtt(); rightTab = 'ai'; showTabs();
      var um = { role: 'user', text: (text || '（附圖）') + (imgs.length ? '　📎×' + imgs.length : '') }; S.log.push(um); addMsg('user', um.text); var think = addMsg('ai', '…');
      var chips = [], rej = [], say = '', spec0 = cur(), edits = [], applied = 0, words = [];
      try {
        var pr = text ? W.parseEditRequest(text, spec0) : { edits: [], matched: [], unmatched: [] }; edits = pr.edits.slice(); var rest = pr.unmatched.join('，');
        if ((rest || imgs.length) && host.ask) { var ans = await host.ask({ text: rest, images: imgs, spec: spec0, onStatus: function (t) { think.textContent = t; } }); say = (ans && ans.say) || ''; if (ans && ans.edits) edits = edits.concat(ans.edits); if (ans && ans.notes) ans.notes.forEach(function (n) { chips.push(n); }); }
        else if (rest) say = '我沒聽懂：「' + rest.slice(0, 40) + '」。這個環境沒有 AI 可以幫忙，可以直接在「程式碼」或「後端」分頁改。';
        var r = W.applyEdits(spec0, edits); var next = spec0; if (r.applied.length) { next = r.spec; edits.forEach(function (e) { if (r.applied.indexOf(e.op) >= 0) words.push(W.editWords(e)); }); }
        (r.rejected || []).forEach(function (x) { rej.push('✗ ' + x.op + '：' + x.error); });
        if (JSON.stringify(next) !== JSON.stringify(spec0)) { commit(next, words.filter(Boolean).join('；'), text || '（附圖）', imgs.length ? 'image' : 'chat'); applied = words.length; words.forEach(function (w) { chips.push('✓ ' + w); }); curFile = cur().files.some(function (f) { return f.name === curFile; }) ? curFile : 'index.html'; }
        if (!applied && (rej.length || chips.length)) say = say && !rej.length && chips.length ? say : '這次沒有改成：'; if (!say) say = applied ? '改好了：' : '這樣已經是目前的樣子了。';
      } catch (e) { say = '這次沒成功：' + String((e && e.message) || e).slice(0, 160); }
      think.remove(); var am = { role: 'ai', text: say, chips: chips.slice(0, 12), rejected: rej.slice(0, 6) }; S.log.push(am); addMsg('ai', am.text, am.chips, am.rejected); persist(); busy = false; bSend.disabled = false;
    }
    bSend.onclick = send;

    // ───── 摘要、匯出、放大、鍵盤 ─────
    bSum.onclick = function () { sumTa.value = W.specToPrompt(cur(), S.states.slice(0, S.ptr + 1).filter(function (s) { return s.kind !== 'start'; })); sum.className = 'sum on'; sumTa.focus(); }; bSumX.onclick = function () { sum.className = 'sum'; };
    bCopy.onclick = function () { try { navigator.clipboard.writeText(sumTa.value); bCopy.textContent = '✓ 已複製'; setTimeout(function () { bCopy.textContent = '📋 複製'; }, 1500); } catch (e) { sumTa.select(); } };
    bRegen.style.display = host.regenerate ? '' : 'none'; bRegen.onclick = function () { bRegen.disabled = true; Promise.resolve(host.regenerate(sumTa.value)).then(function () { bRegen.disabled = false; sum.className = 'sum'; }, function () { bRegen.disabled = false; }); };
    bPol.style.display = host.polish ? '' : 'none'; bPol.onclick = function () { bPol.disabled = true; var old = bPol.textContent; bPol.textContent = '潤飾中…'; Promise.resolve(host.polish(sumTa.value)).then(function (t) { if (t) sumTa.value = t; }, function () { /* 用原本的 */ }).then(function () { bPol.disabled = false; bPol.textContent = old; }); };
    function safeName() { return String(cur().title || '網頁').replace(/[\\/:*?"<>|｜]/g, '_').replace(/\s+/g, '').slice(0, 40) || 'webpage'; }
    bExp.onchange = async function () { var k = bExp.value; bExp.value = ''; if (!k) return; if (k === 'node' || k === 'cloudflare') { doExport(k); return; } if (!host.download) return; try { if (k === 'html') await host.download(new Blob([W.buildHtml(cur())], { type: 'text/html' }), safeName() + '.html', 'text/html'); else await host.download(new Blob([JSON.stringify(cur(), null, 1)], { type: 'application/json' }), safeName() + '.json', 'application/json'); stat.textContent = '已匯出'; } catch (e) { stat.textContent = '匯出失敗：' + String((e && e.message) || e).slice(0, 80); } setTimeout(function () { stat.textContent = ''; }, 3000); };
    var win = WIN ? WIN.decorate(el, { id: 'we:' + (opt.id || ''), title: '🌐 網頁編輯器', bar: bar, minW: 640, minH: 420 }) : null; el._win = win;
    bUndo.onclick = undo; bRedo.onclick = redo;
    el.addEventListener('keydown', function (ev) { var tag = ev.target && ev.target.tagName; if ((tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') && ev.target !== el) return; if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); } else if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); redo(); } else if (ev.key === 'Escape' && el.className.indexOf(' full') >= 0) bFull.onclick(); });
    el.tabIndex = 0;
    function render() { renderCode(); refreshBackend(); renderHist(); bUndo.disabled = S.ptr === 0; bRedo.disabled = S.ptr >= S.states.length - 1; stat.textContent = '第 ' + (S.ptr + 1) + '／' + S.states.length + ' 步'; showTabs(); startPreview(false); }
    initState(opt.state, opt.spec); renderLog(); render();
    el._we = { getState: getState, reload: function (state) { initState(state, null); lastRun = ''; renderLog(); render(); }, setSpec: function (spec, summary) { commit(spec, summary || '由對話修改', '', 'chat'); }, undo: undo, redo: redo, send: function (t) { ta.value = t; return send(); }, refreshBackend: refreshBackend, showTab: function (t) { leftTab = t; showTabs(); if (t === 'backend') refreshBackend(); }, restart: function () { startPreview(true); }, destroy: function () { try { if (host.stop) host.stop(); } catch (e) { /* */ } } };
    return el;
  }
  return { mount: mount, CSS: CSS };
});
