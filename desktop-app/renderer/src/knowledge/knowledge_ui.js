/* Knowledge Inventory 的畫面：像 NotebookLM 的三塊版面，可以彈出成獨立的浮動視窗（拖曳標題列移動、拉角落改大小、收回對話裡）。
 *   左：來源清單（Inventory）——可以拖曳檔案進來、按「＋加入」加入來源；每個來源可勾選／取消勾選（勾選的才會用來回答）、刪除；
 *       左右兩塊中間的 sash 可以拖曳調整寬度（會記住）。
 *   中：訊息區（問答、目錄、摘要、更新結果、關聯、設定都以訊息卡片出現），下面是詢問對話區。
 *   上方工具列：🔄更新知識庫、🧹模型整理、🧠語意索引、🔗關聯、⚙設定（.keeplookup 放哪裡與搬家、容量上限可無限）、⤢彈出／⤓收回。
 * 每個回答都是原文片段，標明來源、第幾行、章節（頁／投影片／工作表／時間），查詢的詞會標起來，可展開上下文、複製出處。
 * 只依賴 host（由 app 提供）：
 *   status() sources() ask({question,sources,limit}) outline(ref) detail(ref, which, opts) summary(ref)
 *   links() setLinkStatus(id, status) rebuildLinks() addUrl(url) addText(name, text, kind) addFile(File) remove(ref) enable(ref, on)
 *   refresh() organize(ref) embedStatus() embedRun() migrate(kind, path, keepOld) setCapacity(mb) palette()? */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../ui/win_shell.js')); else root.FaKnowledgeUI = factory(root.FaWin || (typeof FaWin !== 'undefined' ? FaWin : undefined));
})(typeof self !== 'undefined' ? self : this, function (WIN) {
  'use strict';
  var CSS = '.fki{--bg:#fff;--fg:#1f2328;--bd:#d0d7de;--hd:#f6f8fa;--mut:#59636e;--acc:#0969da;--ok:#1a7f37;--bad:#cf222e;--hl:#fff3b0;position:relative;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);font:13px system-ui,"Microsoft JhengHei",sans-serif;margin:6px 0;overflow:hidden;max-width:100%;display:flex;flex-direction:column;height:560px}'
    + '.fki.dark{--bg:#161b22;--fg:#e6edf3;--bd:#30363d;--hd:#21262d;--mut:#8b949e;--acc:#58a6ff;--ok:#3fb950;--bad:#f85149;--hl:#5a4a00}.fki *{box-sizing:border-box}'
    + '.fki button{background:var(--hd);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit}.fki button:hover:not(:disabled){border-color:var(--acc)}.fki button:disabled{opacity:.4;cursor:default}.fki button.pri{background:var(--acc);border-color:var(--acc);color:#fff}.fki button.ic{padding:1px 6px;background:transparent;border-color:transparent}.fki button.ic:hover{border-color:var(--bd)}'
    + '.fki input[type=text],.fki input[type=number],.fki select,.fki textarea{background:var(--bg);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:4px 6px;font:inherit;max-width:100%}.fki textarea{width:100%;resize:none}'
    + '.fki .bar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--hd);border-bottom:1px solid var(--bd);flex-wrap:wrap;cursor:default}.fki .ttl{font-weight:600}.fki .st{color:var(--mut);font-size:12px}.fki .spacer{margin-left:auto}'
    + '.fki .body{display:flex;flex:1;min-height:0}.fki .side{width:230px;min-width:150px;display:flex;flex-direction:column;border-right:0;position:relative;background:var(--bg)}.fki .sash{width:6px;cursor:col-resize;background:var(--hd);border-left:1px solid var(--bd);border-right:1px solid var(--bd);flex:none}.fki .sash:hover,.fki .sash.drag{background:var(--acc);opacity:.6}'
    + '.fki .sidehd{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--bd);background:var(--hd)}.fki .sidehd b{margin-right:auto}.fki .list{flex:1;overflow:auto;padding:4px}.fki .src{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:5px;border:1px solid transparent}.fki .src:hover{border-color:var(--bd)}.fki .src.off .nm{opacity:.5;text-decoration:line-through}.fki .src .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.fki .src .meta{color:var(--mut);font-size:11px}'
    + '.fki .dropov{position:absolute;inset:0;background:rgba(9,105,218,.12);border:2px dashed var(--acc);display:none;align-items:center;justify-content:center;color:var(--acc);font-weight:600;z-index:2;text-align:center;padding:10px}.fki .side.over .dropov{display:flex}.fki .empty{color:var(--mut);padding:10px;text-align:center}'
    + '.fki .main{flex:1;min-width:0;display:flex;flex-direction:column}.fki .msgs{flex:1;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px}.fki .u{align-self:flex-end;max-width:85%;background:var(--acc);color:#fff;border-radius:10px;padding:5px 10px;white-space:pre-wrap;word-break:break-word}'
    + '.fki .card{border:1px solid var(--bd);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:6px;background:var(--bg)}.fki .card h4{margin:0;font-size:13px;display:flex;align-items:center;gap:6px}.fki .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.fki .row label{color:var(--mut)}'
    + '.fki .hit{border:1px solid var(--bd);border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:4px}.fki .hit .lb{font-weight:600}.fki .hit .by{font-size:11px;color:var(--mut);border:1px solid var(--bd);border-radius:8px;padding:0 6px;margin-left:6px}'
    + '.fki blockquote{margin:0;padding:3px 8px;border-left:3px solid var(--acc);white-space:pre-wrap;word-break:break-word}.fki mark{background:var(--hl);color:inherit;border-radius:2px}'
    + '.fki pre.code{margin:0;padding:6px;background:var(--hd);border:1px solid var(--bd);border-radius:6px;max-height:260px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}.fki .ln{color:var(--mut);display:inline-block;min-width:3.2em;text-align:right;margin-right:8px;user-select:none}.fki .ln.hot{color:var(--acc);font-weight:700}'
    + '.fki .ask{border-top:1px solid var(--bd);padding:8px;display:flex;flex-direction:column;gap:4px;background:var(--hd)}.fki .ask .r{display:flex;gap:6px;align-items:flex-end}.fki .ask textarea{flex:1;min-height:42px;max-height:120px}.fki .ok{color:var(--ok)}.fki .bad{color:var(--bad)}'
    + '.fki .src{flex-wrap:wrap}.fki .pg{flex-basis:100%;display:flex;flex-direction:column;gap:2px;padding:0 2px 2px 24px}.fki .pgb{height:5px;border-radius:3px;background:var(--bd);overflow:hidden}.fki .pgb i{display:block;height:100%;background:var(--acc);width:0;transition:width .25s}.fki .pgb.run i{background:var(--acc)}.fki .pgb.full i{background:var(--ok)}.fki .pgt{font-size:11px;color:var(--mut)}'
    + '.fki .opl{padding:4px 8px;font-size:12px;color:var(--acc);border-bottom:1px solid var(--bd);background:var(--hd);display:none;white-space:pre-wrap;word-break:break-word}.fki .opl.on{display:block}'
    + '.fki details.tr{border:1px dashed var(--bd);border-radius:6px;padding:2px 8px;font-size:12px;color:var(--mut)}.fki details.tr summary{cursor:pointer}.fki .trl{padding:1px 0;white-space:pre-wrap;word-break:break-word}.fki .trl.bad{color:var(--bad)}.fki .trl.ok{color:var(--ok)}'
    + '.fki details.dim{border:1px solid var(--bd);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--mut);opacity:.85}.fki details.dim summary{cursor:pointer}.fki details.dim .hit{font-size:11px;filter:grayscale(1)}.fki details.dim blockquote{border-left-color:var(--bd)}.fki button.cite{padding:0 6px;margin-left:3px;font-size:11px;border-radius:9px;color:var(--acc);background:transparent}.fki .dlgbg{position:absolute;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:5}.fki .dlg{background:var(--bg);border:1px solid var(--bd);border-radius:8px;width:min(640px,92%);max-height:86%;overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:6px;box-shadow:0 6px 24px rgba(0,0,0,.35)}.fki .dlg h4{margin:0;font-size:13px;display:flex;gap:6px;align-items:center}.fki .ans{border:1px solid var(--acc);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:4px}.fki .ans .cite{font-size:11px;color:var(--acc);margin-left:2px}.fki .ask select{max-width:110px}';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var LKIND = { mentions: '提到', identifier: '同一個識別字', same_quote: '同一句話', heading_match: '同樣的章節標題', issue_ref: '議題引用', wiki_link: 'wiki 連結', url_link: '網址連結', shared_term: '共有的詞', model: '模型提出' };
  function esc(s) { return String(s == null ? '' : s); }
  // 把查詢的詞在原文裡標起來（只是顯示，不改內容）
  function highlight(container, text, query) {
    var words = Array.from(new Set((String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9_.\-]*|[㐀-鿿]{1,}/g) || []).flatMap(function (w) { return /[㐀-鿿]/.test(w) ? (w.length > 1 ? w.split('').concat(Array.from({ length: w.length - 1 }, function (_, i) { return w.slice(i, i + 2); })) : [w]) : [w]; })));
    var t = String(text), low = t.toLowerCase(), marks = new Array(t.length).fill(false);
    words.sort(function (a, b) { return b.length - a.length; }).forEach(function (w) { if (w.length === 1 && /[a-z0-9]/.test(w)) return; var i = -1; while ((i = low.indexOf(w, i + 1)) >= 0) for (var k = i; k < i + w.length; k++) marks[k] = true; });
    var i2 = 0; while (i2 < t.length) { var j = i2; while (j < t.length && marks[j] === marks[i2]) j++; var seg = t.slice(i2, j); if (marks[i2]) { var m = document.createElement('mark'); m.textContent = seg; container.appendChild(m); } else container.appendChild(document.createTextNode(seg)); i2 = j; }
  }

  function mount(opt) {
    var host = opt.host || {}, el = h('div', 'fki'), dark = false; try { dark = !!(host.palette && host.palette().dark); } catch (e) { dark = false; } if (dark) el.className += ' dark';
    if (!document.getElementById('fki-css')) { var st0 = document.createElement('style'); st0.id = 'fki-css'; st0.textContent = CSS; (document.head || document.documentElement).appendChild(st0); }
    var sources = [], busy = false, lastQuery = '', statusInfo = {}, orgNow = null, orgDone = {}, orgProg = {}, orgRunning = false, embActive = false, embText = '', refreshT = 0;
    // 進度事件（建立語意向量、模型整理）：上面的進度列說明現在做到哪，每個來源下面的進度條跟著動
    function setOpl(t) { opl.textContent = t || ''; opl.className = 'opl' + (t ? ' on' : ''); }
    var offProg = host.onProgress ? host.onProgress(function (ev) {
      if (ev.op === 'embed') {
        embActive = !ev.end; embText = ev.text || '';
        if (ev.end) { setOpl(''); refreshStatus(); return; }
        setOpl('🧠 ' + embText); var now = Date.now(); if (now - refreshT > 1200) { refreshT = now; refreshSourcesOnly(); }
      } else if (ev.op === 'images') {
        setOpl(ev.end ? '' : ev.text || '🖼 讀圖片中…');
      } else if (ev.op === 'organize') {
        if (ev.end) { orgNow = null; setOpl(''); renderList(); return; }
        if (ev.source_id != null) { if (orgNow != null && orgNow !== ev.source_id) orgDone[orgNow] = true; orgNow = ev.source_id; orgProg[ev.source_id] = { done: ev.done || 0, total: ev.total || 0, text: ev.text || '' }; } setOpl('🧹 ' + (ev.text || '模型整理中…')); renderList();
      }
    }) : null;
    function refreshSourcesOnly() { return host.sources().then(function (r) { sources = (r && r.sources) || sources; renderList(); }).catch(function () { /* */ }); }
    // ───── 骨架 ─────
    var bar = h('div', 'bar'), ttl = h('span', 'ttl', '📚 Knowledge Inventory'), stat = h('span', 'st'), spacer = h('span', 'spacer');
    var bRef = h('button', 'pri', '🔄 更新'), bOrg = h('button', null, '🧹 整理'), bEmb = h('button', null, '🧠 語意'), bLk = h('button', null, '🔗 關聯'), bSet = h('button', null, '⚙ 設定');
    bRef.title = '更新知識庫：重新抓取網址來源（內容有變才更新）、補算語意向量、重算關聯'; bOrg.title = '模型整理：請模型替每個來源挑關鍵詞（只能是來源裡原本有的字，程式逐個核對）；線上模型用不了會自動改用離線模型'; bEmb.title = '語意索引：用小型向量模型建立（第一次要下載約 118 MB）'; bLk.title = '關聯：只用字面證據（來源互相提到、共有的專有名詞或關鍵詞）'; bSet.title = '.keeplookup 放哪裡、搬家、容量上限';
    var bSide = h('button', null, '☰'); bSide.title = '隱藏／顯示左邊的來源清單';
    var bClr = h('button', null, '🗑'); bClr.title = '清除這個庫的對話紀錄（按兩下確認）';
    [bSide, ttl, stat, spacer, bRef, bOrg, bEmb, bLk, bClr, bSet].forEach(function (x) { bar.appendChild(x); });
    var body = h('div', 'body'), side = h('div', 'side'), sash = h('div', 'sash'), main = h('div', 'main');
    var sidehd = h('div', 'sidehd'), sidetitle = h('b', null, '來源'), bAll = h('input'), bAdd = h('button', 'pri', '＋ 加入'), fileIn = h('input'), list = h('div', 'list'), dropov = h('div', 'dropov', '放開滑鼠，把檔案加入知識庫');
    bAll.type = 'checkbox'; bAll.title = '全選／全不選'; bAdd.title = '加入來源：檔案、網址、貼上的文字（也可以直接把檔案拖進來）'; fileIn.type = 'file'; fileIn.multiple = true; fileIn.style.display = 'none';
    [bAll, sidetitle, bAdd, fileIn].forEach(function (x) { sidehd.appendChild(x); }); var opl = h('div', 'opl'); [sidehd, opl, list, dropov].forEach(function (x) { side.appendChild(x); });
    var msgs = h('div', 'msgs'), askbox = h('div', 'ask'), askrow = h('div', 'r'), ta = h('textarea'), go = h('button', 'pri', '問'), scope = h('div', 'st');
    var mode = h('select'); [['quote', '原文'], ['ai', '🤖 AI 對話']].forEach(function (k) { var o = h('option', null, k[1]); o.value = k[0]; mode.appendChild(o); }); mode.title = '原文：只給原文片段與出處。AI 對話：放進來的文件就是 AI 的記憶——閒聊直接聊，問問題、要它解釋、整合、甚至設計／寫程式，都會基於知識庫回答；用自己的話說明，不是一條一條抄原文；有依據的地方標編號（點開看原始資料），知識庫沒有、AI 憑自己知識補的標 [外]；程式會核對編號與指令、數字、名稱'; try { var mv = localStorage.getItem('fa.ki.mode'); mode.value = mv === 'ai' || mv === 'create' || mv === 'strict' ? 'ai' : 'quote'; } catch (e) { /* */ } mode.onchange = function () { try { localStorage.setItem('fa.ki.mode', mode.value); } catch (e) { /* */ } };
    ta.rows = 2; ta.placeholder = '問你放進知識庫的資料（Enter 送出，Shift+Enter 換行）——回答只會是原文，附出處'; askrow.appendChild(mode); askrow.appendChild(ta); askrow.appendChild(go); askbox.appendChild(askrow); askbox.appendChild(scope);
    main.appendChild(msgs); main.appendChild(askbox); [side, sash, main].forEach(function (x) { body.appendChild(x); }); el.appendChild(bar); el.appendChild(body);
    // sash：拖曳調整左邊寬度（會記住）
    var sideW = 230; try { var sw = Number(localStorage.getItem('fa.ki.sideW')); if (sw >= 150) sideW = sw; } catch (e) { /* */ } side.style.width = sideW + 'px';
    sash.onmousedown = function (ev) { ev.preventDefault(); var x0 = ev.clientX, w0 = side.getBoundingClientRect().width; sash.className = 'sash drag'; var mv = function (e) { var max = Math.max(200, body.getBoundingClientRect().width * 0.6); sideW = Math.max(150, Math.min(max, w0 + e.clientX - x0)); side.style.width = sideW + 'px'; }; var up = function () { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); sash.className = 'sash'; try { localStorage.setItem('fa.ki.sideW', String(Math.round(sideW))); } catch (e) { /* */ } }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); };

    // 左邊可隱藏／顯示（會記住）
    var sideHidden = false; try { sideHidden = localStorage.getItem('fa.ki.sideHidden') === '1'; } catch (e) { /* */ }
    function applySide() { side.style.display = sideHidden ? 'none' : ''; sash.style.display = sideHidden ? 'none' : ''; bSide.title = sideHidden ? '顯示左邊的來源清單' : '隱藏左邊的來源清單'; bSide.style.borderColor = sideHidden ? 'var(--acc)' : ''; }
    bSide.onclick = function () { sideHidden = !sideHidden; try { localStorage.setItem('fa.ki.sideHidden', sideHidden ? '1' : '0'); } catch (e) { /* */ } applySide(); }; applySide();
    function scroll() { msgs.scrollTop = msgs.scrollHeight; }
    function userMsg(t) { var m = h('div', 'u', t); msgs.appendChild(m); scroll(); return m; }
    function card(title) { var c = h('div', 'card'), hd = h('h4', null, title); c.appendChild(hd); var x = h('button', 'ic', '✕'); x.title = '關掉這張卡片'; x.style.marginLeft = 'auto'; x.onclick = function () { c.remove(); }; hd.appendChild(x); msgs.appendChild(c); scroll(); return c; }
    function note(c, t, cls) { var p = h('div', cls || 'st', t); p.style.whiteSpace = 'pre-wrap'; c.appendChild(p); scroll(); return p; }
    function guard(fn) { return function () { var a = arguments; if (busy) { stat.textContent = '還在處理上一個動作…'; return; } busy = true; var done = function () { busy = false; }; try { Promise.resolve(fn.apply(null, a)).then(done, function (e) { done(); stat.className = 'st bad'; stat.textContent = '⚠️ ' + String((e && e.message) || e).slice(0, 160); }); } catch (e) { done(); stat.textContent = '⚠️ ' + e.message; } }; }

    function refreshStatus() {
      return Promise.all([host.status(), host.sources()]).then(function (r) {
        statusInfo = r[0] || {}; var st = statusInfo.stats || {}; sources = (r[1] && r[1].sources) || [];
        stat.className = 'st'; stat.textContent = '來源 ' + (st.sources || 0) + '（用 ' + (st.enabled || 0) + '）・片段 ' + (st.chunks || 0) + '・向量 ' + (st.vectors || 0) + '・摘要 ' + ((statusInfo.digests && statusInfo.digests.docs) || 0) + ' 份・關聯 ' + (st.links || 0);
        scope.textContent = '回答範圍：左邊勾選的 ' + (st.enabled || 0) + ' 個來源　語意：' + (statusInfo.semantic ? '開（關鍵字＋語意）' : '關（只用關鍵字；🧠 可以啟用）') + '　位置：' + (statusInfo.location_label || '');
        renderList(); return statusInfo;
      }).catch(function (e) { stat.className = 'st bad'; stat.textContent = '⚠️ ' + String((e && e.message) || e).slice(0, 160); });
    }
    // ───── 左：來源清單 ─────
    function renderList() {
      list.textContent = ''; bAll.checked = sources.length > 0 && sources.every(function (s) { return s.enabled; });
      if (!sources.length) { list.appendChild(h('div', 'empty', '還沒有來源\n把檔案拖進來，或按「＋ 加入」')); list.firstChild.style.whiteSpace = 'pre-wrap'; return; }
      sources.forEach(function (s) {
        var r = h('div', 'src' + (s.enabled ? '' : ' off')), cb = h('input'), nm = h('span', 'nm', s.name), meta = h('span', 'meta', (s.kind || '') + (s.vectors ? '' : '')), del = h('button', 'ic', '🗑');
        cb.type = 'checkbox'; cb.checked = !!s.enabled; cb.title = s.enabled ? '勾選中：這個來源會用來回答（取消勾選＝不用，資料還在）' : '沒勾選：不會用來回答'; nm.title = s.name + '\n' + (s.kind || '') + '・' + (s.sections || 0) + ' 節・' + (s.chunks || 0) + ' 片段・向量 ' + (s.vectors || 0) + (s.tags && s.tags.length ? '\n關鍵詞：' + s.tags.join('、') : '') + '\n（點一下看目錄）'; del.title = '刪除這個來源';
        cb.onchange = guard(function () { return host.enable(s.id, cb.checked).then(refreshStatus); });
        nm.onclick = guard(function () { return showOutline(s); });
        del.onclick = guard(function () { if (!window.confirm('把「' + s.name + '」從知識庫刪除？（片段、向量、關聯都會一起刪）')) return; return host.remove(s.id).then(function () { var c = card('🗑 已刪除'); note(c, s.name); return refreshStatus(); }); });
        [cb, nm, meta, del].forEach(function (x) { r.appendChild(x); });
        // 進度條：模型整理中的來源、語意向量還沒補滿的來源
        var vtotal = s.chunks || 0, vdone = s.vectors || 0, pend = !!statusInfo.semantic && vtotal > 0 && vdone < vtotal;
        if (orgNow === s.id || pend || (embActive && vtotal > 0 && vdone < vtotal)) {
          var pg = h('div', 'pg'), bar2 = h('div', 'pgb' + (orgNow === s.id ? ' run' : '')), fill = h('i'), tx = h('div', 'pgt');
          if (orgNow === s.id) { var op = orgProg[s.id] || {}; fill.style.width = op.total ? Math.max(4, Math.round(op.done / op.total * 100)) + '%' : '100%'; if (!op.total) fill.style.opacity = '.5'; tx.textContent = (op.text || '模型整理中…').replace(/^模型整理 \d+\/\d+：[^　]*　?/, ''); } else { fill.style.width = Math.round(vdone / vtotal * 100) + '%'; tx.textContent = '語意向量 ' + vdone + '/' + vtotal; }
          bar2.appendChild(fill); pg.appendChild(bar2); pg.appendChild(tx); r.appendChild(pg);
        } else if (orgDone[s.id] && s.tags && s.tags.length) { var pg2 = h('div', 'pg'); pg2.appendChild(h('div', 'pgt', '已整理：' + s.tags.slice(0, 4).join('、'))); r.appendChild(pg2); }
        list.appendChild(r);
      });
    }
    bAll.onchange = guard(function () { var on = bAll.checked; return Promise.all(sources.map(function (s) { return s.enabled === on ? null : host.enable(s.id, on); }).filter(Boolean)).then(refreshStatus); });
    // 拖曳加入
    var dragDepth = 0;
    side.ondragenter = function (e) { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0) { dragDepth++; side.className = 'side over'; } };
    side.ondragover = function (e) { e.preventDefault(); }; side.ondragleave = function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) side.className = 'side'; };
    side.ondrop = function (e) { e.preventDefault(); dragDepth = 0; side.className = 'side'; addFiles(e.dataTransfer && e.dataTransfer.files); };
    bAdd.onclick = function () { showAdd(); }; fileIn.onchange = function () { addFiles(fileIn.files); fileIn.value = ''; };
    var addFiles = guard(function (files) {
      var arr = Array.from(files || []); if (!arr.length) return; var c = card('📥 加入檔案'), p = note(c, ''), msgs2 = [], chain = Promise.resolve();
      arr.forEach(function (f) { chain = chain.then(function () { p.textContent = msgs2.concat('加入「' + f.name + '」…（音訊影片要先轉錄，會比較久）').join('\n'); return host.addFile(f).then(function (r) { msgs2.push(r.ok ? '✅ ' + r.name + '（' + r.kind + '，' + r.lines + ' 行、' + r.chunks + ' 片段' + (r.status === 'unchanged' ? '，內容沒變' : r.status === 'updated' ? '，已更新' : '') + '）' : '⚠️ ' + f.name + '：' + r.error); p.textContent = msgs2.join('\n'); }); }); });
      return chain.then(refreshStatus);
    });
    function showAdd() {
      var c = card('＋ 加入來源'); var r1 = h('div', 'row'), url = h('input'), bu = h('button', null, '加入網址'), bf = h('button', null, '選檔案…'); url.type = 'text'; url.placeholder = '網址（網頁、wiki、新聞…）'; url.style.flex = '1 1 220px'; [url, bu, bf].forEach(function (x) { r1.appendChild(x); }); c.appendChild(r1);
      bf.onclick = function () { fileIn.click(); };
      var out = note(c, '支援：pdf、docx、pptx、xlsx、md、txt、textile、mediawiki、json、jsonl、yaml、toon、csv、mp3／mp4（轉錄）…。檔案也可以直接拖到左邊。');
      bu.onclick = guard(function () { var u = url.value.trim(); if (!u) return; out.textContent = '加入中：' + u + ' …'; return host.addUrl(u).then(function (r) { out.textContent = r.ok ? '✅ ' + (r.status === 'unchanged' ? '內容沒變：' : r.status === 'updated' ? '已更新：' : '已加入：') + r.name + '（' + r.kind + '，' + r.lines + ' 行、' + r.sections + ' 節）' + (r.embedding && r.embedding.note ? '\n' + r.embedding.note : '') : '⚠️ ' + r.error; if (r.ok) url.value = ''; return refreshStatus(); }); });
      var tn = h('input'), tk = h('select'), tx = h('textarea'), bt = h('button', null, '加入這段文字'), r3 = h('div', 'row'); tn.type = 'text'; tn.placeholder = '名稱（貼上文字時用）'; ['txt', 'md', 'textile', 'mediawiki', 'json', 'jsonl', 'yaml', 'toon', 'csv'].forEach(function (k) { var o = h('option', null, k); o.value = k; tk.appendChild(o); }); tx.rows = 3; tx.placeholder = '或直接貼上文字…'; tx.style.resize = 'vertical'; [tn, tk, bt].forEach(function (x) { r3.appendChild(x); }); c.appendChild(r3); c.appendChild(tx);
      bt.onclick = guard(function () { if (!tx.value.trim()) return; return host.addText(tn.value.trim() || '貼上的文字', tx.value, tk.value).then(function (r) { out.textContent = r.ok ? '✅ 已加入：' + r.name + '（' + r.lines + ' 行）' : '⚠️ ' + r.error; if (r.ok) { tx.value = ''; tn.value = ''; } return refreshStatus(); }); });
    }
    // ───── 中：問答 ─────
    // 過程記錄：像 transcript，一步一步寫出現在在做什麼（含等待模型的秒數）；做完收合成一行
    function transcript(c, title) {
      var d = h('details', 'tr'), sm = h('summary', null, title), body = h('div'), t0 = Date.now(), timer = null; d.open = true; d.appendChild(sm); d.appendChild(body); c.appendChild(d);
      function line(t, cls) { var l = h('div', 'trl' + (cls ? ' ' + cls : '')); l.textContent = '[' + ((Date.now() - t0) / 1000).toFixed(1) + ' s] ' + t; body.appendChild(l); scroll(); return l; }
      return {
        step: function (t, cls) { return line(t, cls); },
        wait: function (label, ctl) { var l = line(label + '（0 秒）'), w0 = Date.now(), skip = null; if (ctl) { skip = h('button', 'ic', '略過等待'); skip.title = '模型沒回應（例如 AI 節點斷線）時，不等了，直接用找到的原文'; skip.onclick = function () { if (ctl.cancel) ctl.cancel(); skip.disabled = true; }; l.parentNode.insertBefore(skip, l.nextSibling); } timer = setInterval(function () { l.textContent = '[' + ((Date.now() - t0) / 1000).toFixed(1) + ' s] ' + label + '（' + Math.round((Date.now() - w0) / 1000) + ' 秒）'; }, 1000); return function () { if (timer) clearInterval(timer); timer = null; if (l.parentNode) l.remove(); if (skip && skip.parentNode) skip.remove(); }; },
        end: function (t) { if (timer) clearInterval(timer); sm.textContent = t || '🧾 過程'; d.open = false; }
      };
    }
    // 送出鍵：閒著＝問；查詢進行中，沒打字＝■ 停止，有打字＝↪ 轉向（停下目前的、改問新的）
    var run = null;
    function syncBtn() { var typed = !!ta.value.trim(); go.textContent = run ? (typed ? '↪ 轉向' : '■ 停止') : '問'; go.className = run && !typed ? '' : 'pri'; go.title = run ? '沒打字：停止這次查詢。有打字：停下目前的，改問你新打的（steering）' : ''; }
    function stopRun() { if (!run) return Promise.resolve(); run.aborted = true; try { if (run.ctl.cancel) run.ctl.cancel(); if (run.ctl2.cancel) run.ctl2.cancel(); } catch (e) { /* */ } return run.done || Promise.resolve(); }
    function send() { if (run) { var steer = ta.value.trim(), p = stopRun(); if (steer) p.then(function () { ask(); }); return; } ask(); }
    function ask() {
      var q = ta.value.trim(); if (!q) return Promise.resolve(); ta.value = ''; var me = { aborted: false, ctl: {}, ctl2: {}, done: null }; run = me; syncBtn();
      function fin() { if (run === me) run = null; syncBtn(); }
      me.done = askCore(q, me).then(fin, fin); return me.done;
    }
    // ───── 對話：保存（這個瀏覽器的 IndexedDB，每個庫一份，最多 60 則）與恢復、清除 ─────
    var conv = [];
    function saveConv() { if (host.chatSave) { try { host.chatSave(conv.slice(-60)); } catch (e) { /* */ } } }
    function histForRoute() { return conv.filter(function (r) { return r.k === 'a' || r.k === 'chat'; }).slice(-4).map(function (r) { var a = r.k === 'chat' ? r.reply : ((r.ai && r.ai.sentences && r.ai.sentences.map(function (x) { return x.text; }).join(' ')) || (r.res && r.res.found ? '（找到 ' + r.res.hits.length + ' 筆原文）' : '（沒找到）')); return { q: r.q, a: a }; }); }
    function cardTitle(rec) { return rec.k === 'chat' ? '💬 對話' : rec.k === 'create' ? '✨ 創作' : '🔎 查詢'; }
    function copyText(t, btn, label) { try { navigator.clipboard.writeText(t); btn.textContent = '已複製'; } catch (e) { btn.textContent = '複製不了'; } setTimeout(function () { btn.textContent = label; }, 1200); }
    // 文字裡的 [編號] 變成可點的小標籤（點開才是原始資料），[外] 是「知識庫沒有、AI 憑自己的知識補的」
    function addInline(p, text, sources) {
      if (text.indexOf('`') >= 0) { text.split(/(`[^`]*`)/g).forEach(function (part, i) { if (i % 2) { var cd = h('code', null, part.slice(1, -1)); cd.style.background = 'var(--hd)'; cd.style.padding = '0 3px'; cd.style.borderRadius = '3px'; p.appendChild(cd); } else if (part) addInline(p, part, sources); }); return; }
      var re = /\[(\d+|外|\?)\]/g, last = 0, m;
      while ((m = re.exec(text))) {
        p.appendChild(document.createTextNode(text.slice(last, m.index)));
        if (m[1] === '外') { var o = h('span', 'cite', '外'); o.title = '知識庫沒有，AI 憑自己的知識補的，請自己確認'; o.style.opacity = '.6'; p.appendChild(o); }
        else if (m[1] === '?') p.appendChild(document.createTextNode('[?]'));
        else { var n = Number(m[1]), sr = (sources || [])[n - 1], b = h('button', 'cite', '[' + n + ']'); b.title = sr ? sr.label : ''; b.onclick = (function (x) { return function () { if (x) openSource(x); }; })(sr); p.appendChild(b); }
        last = m.index + m[0].length;
      }
      p.appendChild(document.createTextNode(text.slice(last)));
    }
    function showHits(c, res, q, cited) {
      if (cited) { var all = h('details', 'dim'); all.appendChild(h('summary', null, '找到的原文（' + res.hits.length + ' 筆；點答案裡的 [編號] 看出處）')); res.hits.forEach(function (hit, i) { all.appendChild(hitCard(hit, i, q)); }); c.appendChild(all); scroll(); return; }
      c.appendChild(h('div', 'st', '原文出處（' + res.hits.length + ' 筆）')); res.hits.forEach(function (hit, i) { c.appendChild(hitCard(hit, i, q)); }); scroll();
    }
    // 創作的成品：說明文字＋程式碼區塊（可複製）、依據檢查、參考的素材
    function renderCreate(c, cr) {
      if (cr.creative) c.appendChild(h('div', 'st', '✨ 這是 AI 依知識庫資料創作的內容——設計與寫法是 AI 自己的，不是知識庫原文。用到知識庫的語法／API 標 [編號]（點開看原始資料）；標 [外] 的是知識庫沒有、AI 憑自己的知識補的，請自己確認。'));
      var box = h('div', 'ans'); String(cr.text).split(/(```[^\n]*\n[\s\S]*?```)/g).forEach(function (pt) {
        var m = /^```([^\n]*)\n([\s\S]*?)```$/.exec(pt);
        if (m) { var pre = h('pre', 'code'), cb = h('button', 'ic', '複製'); pre.textContent = m[2].replace(/\n$/, ''); cb.onclick = function () { copyText(m[2], cb, '複製'); }; box.appendChild(h('div', 'st', m[1].trim() || '程式碼')); box.appendChild(pre); box.appendChild(cb); }
        else pt.split(/\n{2,}/).forEach(function (para) { if (!para.trim()) return; var p = h('div'); p.style.whiteSpace = 'pre-wrap'; addInline(p, para.trim(), cr.sources); box.appendChild(p); });
      }); c.appendChild(box);
      var row = h('div', 'row'), cpAll = h('button', null, '複製全部'), dl = h('button', null, '下載 .md'); cpAll.onclick = function () { copyText(cr.text, cpAll, '複製全部'); }; dl.onclick = function () { try { var a = document.createElement('a'), u = URL.createObjectURL(new Blob([cr.text], { type: 'text/markdown' })); a.href = u; a.download = '創作.md'; a.click(); setTimeout(function () { URL.revokeObjectURL(u); }, 2000); } catch (e) { /* */ } }; row.appendChild(cpAll); row.appendChild(dl); c.appendChild(row);
      if (cr.dropped && cr.dropped.length) { var dd0 = h('details', 'dim'); dd0.appendChild(h('summary', null, '丟掉了 ' + cr.dropped.length + ' 句（指令、數字或名稱在給 AI 的資料裡找不到，沒有採用）')); cr.dropped.forEach(function (x) { dd0.appendChild(h('div', 'trl', x.text + '　← ' + x.why)); }); c.appendChild(dd0); }
      if (!cr.report) { var srcOnly = h('details', 'dim'); srcOnly.appendChild(h('summary', null, '參考的資料（' + (cr.sources || []).length + ' 段，點答案裡的 [編號] 或這裡看出處）')); (cr.sources || []).forEach(function (sr) { var b0 = h('button', 'cite', '[' + sr.n + '] ' + sr.label); b0.style.display = 'block'; b0.style.textAlign = 'left'; b0.onclick = function () { openSource(sr); }; srcOnly.appendChild(b0); }); c.appendChild(srcOnly); scroll(); return; }
      var rp = cr.report || {}, dt = h('details', 'tr'); dt.open = true; dt.appendChild(h('summary', null, '🔍 依據檢查：程式碼用到的名稱，' + (rp.inKb || []).length + ' 個在知識庫素材裡找得到、' + (rp.notInKb || []).length + ' 個素材沒提到' + (rp.invalid_refs ? '、' + rp.invalid_refs + ' 個編號不存在' : '')));
      if ((rp.inKb || []).length) { var d1 = h('div', 'trl'); d1.appendChild(document.createTextNode('素材裡找得到：')); rp.inKb.forEach(function (x) { d1.appendChild(document.createTextNode(x.name + ' ')); var b = h('button', 'cite', '[' + x.n + ']'), sr = (cr.sources || [])[x.n - 1]; b.title = sr ? sr.label : ''; b.onclick = function () { if (sr) openSource(sr); }; d1.appendChild(b); d1.appendChild(document.createTextNode('　')); }); dt.appendChild(d1); }
      if ((rp.notInKb || []).length) dt.appendChild(h('div', 'trl', '素材沒提到（AI 憑自己的知識用的，請自己確認）：' + rp.notInKb.join('、')));
      if (rp.truncated) dt.appendChild(h('div', 'trl bad', '⚠️ 模型的輸出被截斷了（太長），程式碼可能不完整；可以請它分成幾次、或只做其中一個版本。'));
      c.appendChild(dt);
      var src = h('details', 'dim'); src.appendChild(h('summary', null, '參考的素材（' + (cr.sources || []).length + ' 段' + (cr.queries && cr.queries.length ? '；查詢：' + cr.queries.join('、') : '') + '）')); (cr.sources || []).forEach(function (sr) { var b = h('button', 'cite', '[' + sr.n + '] ' + sr.label); b.style.display = 'block'; b.onclick = function () { openSource(sr); }; src.appendChild(b); }); c.appendChild(src); scroll();
    }
    // 把一則對話紀錄畫成卡片內容（即時回答與重新整理後恢復都用這個）
    function fillRec(c, rec) {
      var q = rec.q;
      if (rec.k === 'chat') { var tx = h('div'); tx.style.whiteSpace = 'pre-wrap'; tx.textContent = rec.reply; c.appendChild(tx); return; }
      if (rec.err && rec.err !== '已停止') note(c, '⚠️ ' + rec.err, 'st bad');
      if (rec.k === 'create') { if (rec.cr) renderCreate(c, rec.cr); return; }
      if (rec.pr) { renderCreate(c, rec.pr); return; }
      var res = rec.res; if (!res) return;
      if (!res.found) { var nf0 = h('details', 'dim'); nf0.appendChild(h('summary', null, '沒有找到相關內容')); nf0.appendChild(h('div', null, (res.message || '在目前勾選的來源裡找不到相關內容。') + (res.semantic === false ? '（' + (res.semantic_note || '只用關鍵字檢索') + '）' : ''))); c.appendChild(nf0); return; }
      var ai = rec.ai; if (!ai) { showHits(c, res, q); return; }
      if (!ai.ok) { note(c, '⚠️ AI 整理失敗：' + ai.error + '\n下面是原文。', 'st bad'); showHits(c, res, q); return; }
      if (!ai.sentences.length) { var nf = h('details', 'dim'); nf.appendChild(h('summary', null, '沒有找到能回答的內容（' + (ai.dropped.length ? '丟掉了 ' + ai.dropped.length + ' 句對不上原文的' : '模型說找不到') + '）')); c.appendChild(nf); }
      else { var box = h('div', 'ans'); ai.sentences.forEach(function (x) { var p = h('div'); p.appendChild(document.createTextNode(x.text)); if (x.image) { var im = h('span', 'cite', '🖼'); im.title = '這句的根據包含圖片的模型描述（不是原文，可能有誤）'; p.appendChild(im); } x.cites.forEach(function (n) { var b = h('button', 'cite', '[' + n + ']'), sr = (ai.sources || [])[n - 1]; b.title = sr ? sr.label : ''; b.onclick = function () { if (sr) openSource(sr); }; p.appendChild(b); }); box.appendChild(p); }); c.appendChild(box); }
      if (ai.dropped && ai.dropped.length) { var dd = h('details', 'dim'); dd.appendChild(h('summary', null, '丟掉了 ' + ai.dropped.length + ' 句（對不上原文，沒有採用）')); ai.dropped.forEach(function (x) { dd.appendChild(h('div', 'trl', x.text + '　← ' + x.why)); }); c.appendChild(dd); }
      showHits(c, res, q, ai.cited || []);
    }
    function restoreConv(list) {
      conv = list.slice();
      conv.forEach(function (rec) { userMsg(rec.q); var c = card(cardTitle(rec)); if (rec.steps && rec.steps.length) { var tr0 = transcript(c, '🧾 過程'); rec.steps.forEach(function (st) { tr0.step(st[0], st[1]); }); tr0.end(rec.took || '🧾 過程'); } fillRec(c, rec); });
      scroll();
    }
    function askCore(q, me) {
      var kindMode = mode.value; lastQuery = q; userMsg(q);
      var hist0 = histForRoute(), rec = { k: 'a', q: q, mode: kindMode, steps: [], ts: Date.now() }; conv.push(rec);
      var c = card('🔎 查詢'), tr0 = transcript(c, '🧾 過程（進行中…）'), t0 = Date.now(), ctl = me.ctl;
      var tr = { step: function (t, cls) { rec.steps.push([t, cls || '']); return tr0.step(t, cls); }, wait: tr0.wait, end: function (t) { rec.took = t; tr0.end(t); } };
      var stopWait = tr.wait('處理中', ctl);
      var onStep = function (t) { stopWait(); tr.step(t); stopWait = tr.wait('處理中', ctl); };
      var setTitle = function (t) { try { c.firstChild.firstChild.nodeValue = t; } catch (e) { /* */ } };
      function aborted() { if (me.aborted) { stopWait(); tr.step('⏹ 已停止', 'bad'); tr.end('🧾 過程（已停止）'); rec.err = '已停止'; saveConv(); return true; } return false; }
      function finish(label) { stopWait(); tr.end('🧾 過程（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒' + (label ? '，' + label : '') + '）'); saveConv(); scroll(); }
      function onErr(e) { stopWait(); if (me.aborted) { aborted(); return; } rec.err = String((e && e.message) || e).slice(0, 200); tr.step('⚠️ ' + rec.err, 'bad'); tr.end('🧾 過程（出錯）'); saveConv(); }
      var routeP = (kindMode === 'ai' && host.route) ? host.route(q, hist0, onStep, ctl) : Promise.resolve({ route: 'search', query: q });
      return routeP.then(function (rt) {
        if (aborted()) return;
        if (rt.route === 'chat') { rec.k = 'chat'; rec.reply = rt.reply; setTitle('💬 對話'); stopWait(); fillRec(c, rec); finish(); return; }
        var qq = rt.query || q; rec.query = qq;
        if (kindMode === 'ai' && host.respond) {
          return host.respond(qq, hist0, onStep, ctl).then(function (pr) { stopWait(); if (aborted()) return; if (!pr.ok) { rec.err = pr.error; rec.pr = null; fillRec(c, rec); finish('沒完成'); return; } rec.pr = pr; fillRec(c, rec); finish(); });
        }
        return host.ask({ question: qq, limit: 6, ctl: ctl, onStep: onStep }).then(function (res) {
          stopWait(); if (aborted()) return; rec.res = res;
          if (!res.found) { tr.step('沒有找到相關內容', 'bad'); fillRec(c, rec); finish('沒找到'); return; }
          tr.step('找到 ' + res.hits.length + ' 筆　' + (res.semantic ? '關鍵字＋語意' : (res.semantic_note || '只用關鍵字')), 'ok');
          if (kindMode !== 'ai' || !host.answerAI) { fillRec(c, rec); finish(); return; }
          var ctl2 = me.ctl2, stop2 = tr.wait('等待模型回應', ctl2);
          return host.answerAI(qq, res.hits, function (t) { stop2(); tr.step(t); stop2 = tr.wait('等待模型回應', ctl2); }, ctl2).then(function (ai) { stop2(); if (aborted()) return; rec.ai = ai; fillRec(c, rec); finish(); });
        });
      }).catch(onErr);
    }
    var clrT = null; bClr.onclick = function () { if (!clrT) { bClr.textContent = '再按一次清除'; clrT = setTimeout(function () { bClr.textContent = '🗑'; clrT = null; }, 3000); return; } clearTimeout(clrT); clrT = null; bClr.textContent = '🗑'; conv = []; msgs.textContent = ''; if (host.chatClear) host.chatClear(); var cc = card('🗑 已清除這個庫的對話紀錄'); note(cc, '來源與索引都還在。'); };
    go.onclick = send; ta.oninput = syncBtn; ta.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
    function hitCard(hit, i, question) {
      var c = h('div', 'hit'), top = h('div'), lb = h('span', 'lb', (i + 1) + '. ' + hit.label), by = h('span', 'by', hit.found_by || '關鍵字'); top.appendChild(lb); top.appendChild(by); c.appendChild(top);
      var bq = h('blockquote'); highlight(bq, hit.quote, question); c.appendChild(bq);
      (hit.related || []).forEach(function (r) { var rl = h('div', 'st', '🔗 相關（' + (LKIND[r.kind] || r.kind) + '「' + String(r.evidence).slice(0, 30) + '」）→ ' + r.source + ' 第 ' + r.line_start + ' 行：' + String(r.quote).slice(0, 80)); c.appendChild(rl); });
      var row = h('div', 'row'), ctx = h('button', null, '看上下文'), cp = h('button', null, '複製出處'), box = h('div'); [ctx, cp].forEach(function (x) { row.appendChild(x); }); c.appendChild(row); c.appendChild(box);
      cp.onclick = function () { var t = hit.label + '\n' + hit.quote; try { navigator.clipboard.writeText(t); cp.textContent = '已複製'; setTimeout(function () { cp.textContent = '複製出處'; }, 1200); } catch (e) { cp.textContent = '複製不了'; } };
      ctx.onclick = guard(function () { if (box.firstChild) { box.textContent = ''; ctx.textContent = '看上下文'; return; } return host.detail(hit.source_id || hit.source, { line_start: Math.max(1, hit.line_start - 4), line_end: hit.line_end + 4 }, { maxLines: 40 }).then(function (d) { box.appendChild(lineView(d.lines || [], hit.line_start, hit.line_end)); ctx.textContent = '收起'; }); });
      return c;
    }
    // 點答案裡的 [編號]：開一個對話框，顯示那段原始資料（標明來源、行號，命中的行標起來），可以看更多上下文、複製出處
    function openSource(sr) {
      var bg = h('div', 'dlgbg'), dlg = h('div', 'dlg'), hd = h('h4', null, '[' + sr.n + '] ' + sr.label), x = h('button', 'ic', '✕'), body = h('div'), row = h('div', 'row'), more = h('button', null, '看更多上下文'), cp = h('button', null, '複製出處');
      x.style.marginLeft = 'auto'; hd.appendChild(x); var close = function () { bg.remove(); }; x.onclick = close; bg.onclick = function (e) { if (e.target === bg) close(); };
      var pad = 3; function load() { return host.detail(sr.source_id || sr.source, { line_start: Math.max(1, sr.line_start - pad), line_end: sr.line_end + pad + 6 }, { maxLines: 60 }).then(function (d) { body.textContent = ''; body.appendChild(lineView(d.lines || [], sr.line_start, sr.line_end)); }).catch(function () { body.textContent = String(sr.ctx || sr.quote || ''); }); }
      more.onclick = function () { pad += 6; load(); }; cp.onclick = function () { try { navigator.clipboard.writeText(sr.label + '\n' + (sr.quote || '')); cp.textContent = '已複製'; setTimeout(function () { cp.textContent = '複製出處'; }, 1200); } catch (e) { cp.textContent = '複製不了'; } };
      [more, cp].forEach(function (b) { row.appendChild(b); }); [hd, body, row].forEach(function (n) { dlg.appendChild(n); }); if (sr.digest) { var dg = h('div', 'st', '🧠 這是模型事先讀過整理的摘要（不是原文），原文章節在下面：' + String(sr.quote || '')); dg.style.whiteSpace = 'pre-wrap'; dlg.insertBefore(dg, body); } bg.appendChild(dlg); el.appendChild(bg); load();
    }
    function lineView(lines, hotA, hotB) { var pre = h('pre', 'code'); lines.forEach(function (l) { pre.appendChild(h('span', 'ln' + (l.line >= hotA && l.line <= hotB ? ' hot' : ''), String(l.line))); pre.appendChild(document.createTextNode(l.text + '\n')); }); return pre; }
    function showOutline(s) {
      return host.outline(s.id).then(function (o) {
        var c = card('📑 目錄：' + s.name + '（' + (o.lines || 0) + ' 行）'), sum = h('button', null, '看摘要（只選原句）'); c.firstChild.insertBefore(sum, c.firstChild.lastChild);
        (o.sections || []).forEach(function (x) { var r = h('div', 'row'), t = h('span', null, '　'.repeat(Math.max(0, x.level - 1)) + x.title), g = h('button', null, '第 ' + x.line_start + '–' + x.line_end + ' 行'); g.onclick = guard(function () { return host.detail(s.id, { line_start: x.line_start, line_end: x.line_end }, { maxLines: 60 }).then(function (d) { var old = c.querySelector('pre'); if (old) old.remove(); c.appendChild(lineView(d.lines || [], x.line_start, x.line_end)); scroll(); }); }); r.appendChild(t); r.appendChild(g); c.appendChild(r); });
        sum.onclick = guard(function () { return host.summary(s.id).then(function (m) { var c2 = card('📝 摘要：' + s.name + '（只選原句，每句附行號）'); (m.sentences || []).forEach(function (x) { c2.appendChild(h('blockquote', null, x.quote)); note(c2, '第 ' + x.line_start + ' 行' + (x.section ? '，' + x.section : '') + (x.loc ? '，' + x.loc : '')); }); if (!(m.sentences || []).length) note(c2, '（沒有可選的句子）'); }); });
      });
    }
    // ───── 工具列 ─────
    bRef.onclick = guard(function () { var c = card('🔄 更新知識庫'), p = note(c, '更新中…'); return host.refresh().then(function (r) { p.textContent = '✅ 更新完成\n' + ((r.refreshed || []).map(function (x) { return '- ' + x.source + '：' + (x.error ? '⚠️ ' + x.error : x.status); }).join('\n') || '（沒有網址來源需要重抓）') + '\n語意索引：' + (r.embedding && r.embedding.embedded != null ? '新增 ' + r.embedding.embedded + ' 個向量' : (r.embedding && (r.embedding.note || r.embedding.error)) || '—') + '\n關聯：' + r.links + ' 筆'; return refreshStatus(); }); });
    bOrg.onclick = function () {
      if (orgRunning) { if (host.stopOrganize) host.stopOrganize(); bOrg.textContent = '停止中…'; return; }
      orgRunning = true; bOrg.textContent = '■ 停止整理'; var c = card('🧹 模型整理（關鍵詞＋摘要＝讓 AI 讀懂每份文件，對話時當記憶用）'), p = note(c, '整理中…（線上模型用不了會自動改用離線模型；可以按 ■ 停止，做好的會保留，下次接著做）');
      host.organize().then(function (r) { p.textContent = r.ok ? (r.stopped ? '⏹ ' : '✅ ') + '整理' + (r.stopped ? '到一半停止了' : '好了') + '\n' + (r.organized || []).map(function (x) { var dg = x.digest || {}; return '- ' + x.source + '：' + (x.error ? '⚠️ ' + x.error : (x.tags && x.tags.length ? x.tags.join('、') : '（沒有挑出可以核對的關鍵詞）')) + (dg.ok === false ? '　摘要：⚠️ ' + dg.error : dg.ok ? '　摘要：新做 ' + (dg.made || 0) + ' 則' + (dg.failed ? '、' + dg.failed + ' 則沒成功' : '') + (dg.dropped ? '、丟掉 ' + dg.dropped + ' 句對不上原文的' : '') : ''); }).join('\n') + '\n' + (r.note || '') : '⚠️ ' + r.error; return refreshStatus(); }).catch(function (e) { p.textContent = '⚠️ ' + String((e && e.message) || e).slice(0, 160); }).then(function () { orgRunning = false; orgNow = null; bOrg.textContent = '🧹 整理'; setOpl(''); renderList(); });
    };
    bEmb.onclick = guard(function () { var c = card('🧠 語意索引'), p = note(c, '檢查中…'); return host.embedStatus().then(function (s) { if (s.enabled && !s.pending) { p.textContent = '語意索引已啟用：向量 ' + s.vectors + '/' + s.chunks + '，沒有待補的片段。'; return; } p.textContent = s.enabled ? '補算語意向量…' : '啟用語意索引（第一次要下載約 ' + s.approx_mb + ' MB 的小型模型）…'; return host.embedRun().then(function (r) { p.textContent = r.ok === false ? '⚠️ ' + r.error : '✅ 建立了 ' + (r.embedded || 0) + ' 個片段的向量'; return refreshStatus(); }); }); });
    bLk.onclick = guard(function () { var c = card('🔗 關聯（每一條都附證據）'), p = note(c, '載入中…'); if (host.proposeLinks) { var pb = h('button', null, '🤖 請模型找更多關聯'), po = h('div', 'st'); pb.title = '用語意向量找「不同來源、意思接近」的段落，請模型說共同點；片語由程式核對過才收，要你接受才會用在回答裡'; pb.onclick = guard(function () { po.textContent = '找關聯中…'; return host.proposeLinks(function (t) { po.textContent = t; }).then(function (r) { po.textContent = r.ok ? '✅ 看了 ' + r.checked + ' 組，提出 ' + r.proposed + ' 條' + (r.dropped ? '，丟掉 ' + r.dropped + ' 條對不上原文的' : '') + (r.failed ? '，' + r.failed + ' 組模型沒回應' : '') + (r.note ? '\n' + r.note : '') : '⚠️ ' + r.error; return refreshStatus(); }); }); c.insertBefore(pb, p); c.insertBefore(po, p); } return host.links().then(function (res) {
      var ls = res.links || [], cnt = {}; ls.forEach(function (l) { cnt[LKIND[l.kind] || l.kind] = (cnt[LKIND[l.kind] || l.kind] || 0) + 1; }); p.textContent = ls.length ? ls.length + ' 筆關聯（' + Object.keys(cnt).map(function (k) { return k + ' ' + cnt[k]; }).join('、') + '），每一條都附證據與行號' : '目前沒有找到關聯（來源互相提到、同一個識別字、同一句話、同樣的章節標題、議題／wiki／網址引用才算）。';
      ls.forEach(function (l) {
        var k = h('div', 'hit'), top = h('div'); top.appendChild(h('span', 'lb', l.from.source + ' ⇄ ' + l.to.source)); top.appendChild(h('span', 'by', (LKIND[l.kind] || l.kind) + (l.term ? '「' + String(l.term).slice(0, 40) + '」' : ''))); if (l.status === 'confirmed') top.appendChild(h('span', 'by ok', '已確認')); if (l.status === 'proposed') top.appendChild(h('span', 'by', '🤖 模型提出・等你決定')); if (l.status === 'stale') { top.appendChild(h('span', 'by bad', '失效（來源內容變了）')); k.style.opacity = '.6'; } k.appendChild(top);
        [l.from, l.to].forEach(function (sd) { if (!sd.line_start) return; k.appendChild(h('blockquote', null, sd.source + ' 第 ' + sd.line_start + ' 行：' + esc(sd.quote))); });
        var row = h('div', 'row'), ok = h('button', null, l.status === 'proposed' ? '接受' : '確認'), no = h('button', null, l.status === 'proposed' ? '拒絕' : '移除'); if (l.status === 'stale') ok.disabled = true; ok.onclick = guard(function () { return host.setLinkStatus(l.id, 'confirmed').then(function () { k.appendChild(h('div', 'st ok', '已確認')); }); }); no.onclick = guard(function () { return host.setLinkStatus(l.id, 'rejected').then(function () { k.remove(); }); }); row.appendChild(ok); row.appendChild(no); k.appendChild(row); c.appendChild(k);
      }); scroll(); }); });
    bSet.onclick = function () {
      var c = card('⚙ 設定'), locSt = note(c, '載入中…'); var kind = h('select'); [['idb', '瀏覽器 IndexedDB'], ['file', '磁碟檔案（桌面版）'], ['fap', 'FAP 資料夾']].forEach(function (k) { var o = h('option', null, k[1]); o.value = k[0]; kind.appendChild(o); });
      var path = h('input'); path.type = 'text'; path.style.flex = '1 1 220px'; path.placeholder = '磁碟：完整路徑；FAP：<名稱>/<路徑>'; var keep = h('input'); keep.type = 'checkbox'; keep.checked = true; var kl = h('label', null, '保留舊檔'), mv = h('button', null, '搬過去'), r5 = h('div', 'row'); [h('label', null, '.keeplookup 放在'), kind, path, keep, kl, mv].forEach(function (x) { r5.appendChild(x); }); c.appendChild(r5);
      var out = note(c, '');
      mv.onclick = guard(function () { out.textContent = '搬家中（會先核對數量一致才切換）…'; return host.migrate(kind.value, path.value.trim(), keep.checked).then(function (r) { out.textContent = r.ok ? '✅ 已搬到 ' + r.to + '，數量核對一致（來源 ' + r.verified.sources + '、片段 ' + r.verified.chunks + '、向量 ' + r.verified.vectors + '）' + (r.note ? '\n' + r.note : '') : '⚠️ ' + r.error; return refreshStatus(); }); });
      var cap = h('input'); cap.type = 'number'; cap.min = '1'; cap.step = '10'; cap.style.width = '110px'; var unl = h('input'); unl.type = 'checkbox'; var cs = h('button', null, '套用容量'), r6 = h('div', 'row'); [h('label', null, '容量上限（MB）'), cap, unl, h('label', null, '無限'), cs].forEach(function (x) { r6.appendChild(x); }); c.appendChild(r6);
      unl.onchange = function () { cap.disabled = unl.checked; };
      cs.onclick = guard(function () { var mb = unl.checked ? 0 : Number(cap.value); if (!unl.checked && !(mb > 0)) { out.textContent = '⚠️ 容量要是大於 0 的數字，或勾「無限」'; return; } return host.setCapacity(mb).then(function () { out.textContent = '✅ 容量上限：' + (mb ? mb + ' MB' : '無限'); return refreshStatus(); }); });
      // 圖片：pptx／docx／pdf 裡的圖片要不要用視覺模型讀（線上視覺模型優先，失敗自動改離線模型）。讀出來的字標「圖片描述（模型）」，不是原文
      var imEn = h('input'), imMax = h('input'), imKB = h('input'), imSave = h('button', null, '套用圖片設定'), r7 = h('div', 'row'), r8 = h('div', 'row'); imEn.type = 'checkbox'; imMax.type = 'number'; imMax.min = '1'; imMax.max = '60'; imMax.style.width = '70px'; imKB.type = 'number'; imKB.min = '1'; imKB.max = '500'; imKB.style.width = '70px';
      [h('label', null, '🖼 讀取圖片'), imEn, h('label', null, '（用視覺模型描述 pptx／docx／pdf 裡的圖片）')].forEach(function (x) { r7.appendChild(x); }); [h('label', null, '每個來源最多'), imMax, h('label', null, '張，小於'), imKB, h('label', null, 'KB 的圖不讀'), imSave].forEach(function (x) { r8.appendChild(x); }); c.appendChild(r7); c.appendChild(r8);
      note(c, '開啟後，新加入或更新的來源才會讀圖片（已加入的來源要移除後重新加入）。圖片讀出來的內容會標「圖片描述（模型）」，回答引用到時會標 🖼；會比較慢，也可能讀錯。');
      imSave.onclick = guard(function () { return host.setImages({ enabled: imEn.checked, maxPerSource: Number(imMax.value) || 12, minKB: Number(imKB.value) || 15 }).then(function () { out.textContent = '✅ 圖片設定已套用'; }); });
      host.status().then(function (s) { var im = s.images || {}; imEn.checked = !!im.enabled; imMax.value = im.maxPerSource || 12; imKB.value = im.minKB || 15; }).catch(function () { /* */ });
      host.status().then(function (s) { locSt.textContent = '目前：' + (s.location_label || '') + '（' + (s.ref || '') + '）'; kind.value = (s.location && s.location.kind) || 'idb'; unl.checked = !s.capacity_mb; cap.value = s.capacity_mb || ''; cap.disabled = unl.checked; }).catch(function () { locSt.textContent = ''; });
    };
    // ───── 視窗外殼：彈出、最大化、收回對話裡（共用 FaWin；元素留在原位，不重新載入）─────
    var win = WIN ? WIN.decorate(el, { id: 'knowledge', title: '📚 Knowledge Inventory', bar: bar, minW: 520, minH: 320 }) : null;
    el._ki = { win: win, pop: function () { if (win) win.pop(); }, dock: function () { if (win) win.dock(); }, maximize: function (on) { if (win) win.maximize(on); }, isPopped: function () { return !!win && win.isPopped(); }, isMaximized: function () { return !!win && win.isMaximized(); }, toggleSide: function (show) { sideHidden = show === undefined ? !sideHidden : !show; applySide(); }, isSideHidden: function () { return sideHidden; }, refresh: refreshStatus, destroy: function () { try { if (offProg) offProg(); if (win) win.destroy(); el.remove(); } catch (e) { /* */ } }, ask: function (q) { ta.value = q; send(); }, showAdd: showAdd };
    refreshStatus().then(function () { return (host.chatLoad ? host.chatLoad() : Promise.resolve([])).then(function (list) { if (list && list.length) { restoreConv(list); return; } var c = card('👋 你好'); note(c, '左邊是你的來源：勾選的才會用來回答，可以拖檔案進來或按「＋ 加入」。下面問問題，回答只會是原文，標明來源與第幾行。上面的按鈕可以更新知識庫、模型整理、建立語意索引、看關聯、設定位置與容量。「🤖 AI 整理」閒聊直接聊、問資料才查原文；「✨ 創作」可以請 AI 依知識庫的資料設計知識庫裡沒有的東西。對話紀錄會保存，重新整理後還在（🗑 可以清除）。'); }); });
    return el;
  }
  return { mount: mount, highlight: highlight };
});
