// /edit-media-presentation 的畫面,蓋在共用外框(FaEditShell)上:左邊是「章 > 頁」的樹狀大綱(搬動、複製、隱藏、鎖定、刪除、改名),中間是原本的簡報播放器(播放、拖進度、匯出 MP4／PPTX／封包都在播放器上),
// 右邊是 AI 對話框(知道你現在看的是哪一頁:「這頁加一張圖」「在這頁後面加一頁」「旁白講短一點」「上網找資料加一章」)與每一步的記錄(復原、重做、點一步回到那一步)。
//   每一個版本的簡報都存成一份 .deck.yaml(檔案快取),復原／重做＝換播放器指向哪一份;AI 這一輪改的東西先放進播放器預覽(停在第一個被改的頁),按「接受」才算。
//   FaDeckEditUI.mount({ id, state, spec, host, restoring, mountPlayer(container, url) -> Promise<box(有 _deckPlayer)>, saveDeck(doc) -> Promise<{url}|{error}>, windowApi }) -> element(el._ed 見 FaEditShell)
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDeckEditUI = factory((root.FaDeckEdit || (typeof FaDeckEdit !== 'undefined' ? FaDeckEdit : undefined)), (root.FaEditShell || (typeof FaEditShell !== 'undefined' ? FaEditShell : undefined))); })(typeof self !== 'undefined' ? self : this, function (D, Shell) {
  'use strict';
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const slug = (s) => String(s || 'deck').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'deck';

  function mount(opt) {
    let stage = null; const host = opt.host || {}, W = { validate: D.validate, applyEdits: D.applyEdits, editWords: D.editWords, list: D.list, find: D.find };
    return Shell.mount({
      id: opt.id, kind: 'edit-media-presentation', title: '📽 簡報編輯器', W, spec: opt.spec, state: opt.state, host, container: opt.container, restoring: opt.restoring, windowApi: opt.windowApi,
      tabs: [{ id: 'view', label: '📽 播放', viewer: true }, { id: 'src', label: '🧾 YAML' }],
      placeholder: '用說的改簡報:「這頁加一張飛機的照片」「在這頁後面加一頁,講風險」「旁白講短一點」「第3頁標題改成…」「上網查最新規格,加一章」',
      intro: '我是簡報的助手:中間是原本的簡報播放器,左邊是章與頁的大綱。你現在看的那一頁就是「這頁」——直接說「這頁加一張…的照片」「這頁的旁白改成…」「在這頁後面插入一頁講…」;要上網找圖、查資料、讀網頁或檔案、畫圖表,我會請簡報的代理人(跟 /media-presentation 一樣的工具)去做。我改的會先放進播放器預覽,你按「接受」才算;每一步都能復原。',
      objectIcon: (o) => (o.type === 'chapter' ? '📂' : '🖼'),
      objectInfo: (o) => (o.type === 'chapter' ? '' : [o.slide.layout || '', o.slide.visual ? '圖:' + (o.slide.visual.kind || '?') : '', o.slide.narration ? '旁白' + String(o.slide.narration).length + '字' : ''].filter(Boolean).join(' ')),
      treeRows: (sp, collapsed) => { const out = []; let hide = false; sp.objects.forEach((o) => { if (o.type === 'chapter') { hide = !!collapsed[o.id]; out.push({ obj: o, depth: 0 }); } else if (!hide) { out.push({ obj: o, depth: 1 }); } }); return out; },
      confirmRemove: (o, sp) => { if (o.type === 'chapter') { const n = sp.objects.filter((x) => x.parent === o.id).length; try { return window.confirm('刪掉章「' + o.name + '」會連它的 ' + n + ' 頁一起刪。要繼續嗎?(刪掉之後可以按「復原」)'); } catch (e) { return true; } } return true; },
      previewEdits: (p) => (stage ? stage.preview(p) : Promise.resolve(true)),
      parseCommands: (text, spec) => D.parseCommands(text, spec, stage ? stage.env() : {}), promptOf: D.promptOf,
      exports: [{ id: 'yaml', label: '簡報 YAML', chat: false }],
      runExport: async (id, spec) => { if (id === 'yaml') { return { blob: new Blob([D.toYaml(spec)], { type: 'text/yaml' }), name: slug(spec.deck.title) + '.deck.yaml', mime: 'text/yaml' }; } throw new Error('不認得的輸出 ' + id); },
      build: (ctx) => buildView(ctx),
    });
    function buildView(ctx) {
      let spec = null, sel = null, lastKey = '', playerUrl = '', box = null, curId = null, alive = true, token = 0, wantIndex = 0, overlayOpen = false, savedUrl = {}, err = '';
      const view = h('div'); view.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0'; const bar = h('div', 'row'); bar.style.cssText = 'padding:4px 6px;gap:6px;border-bottom:1px solid var(--bd);flex-wrap:wrap'; const where = h('span', 'st'); const note = h('div', 'st'); note.style.cssText = 'padding:2px 8px;color:var(--bad);display:none';
      const holder = h('div'); holder.style.cssText = 'position:relative;flex:1;min-height:360px;background:#111'; const playerBox = h('div'); playerBox.style.cssText = 'min-height:360px'; holder.appendChild(playerBox);
      const overlay = h('div', 'fd-preview'); overlay.style.cssText = 'position:absolute;left:8px;right:8px;bottom:8px;display:none;gap:8px;align-items:flex-start;background:rgba(15,20,30,.94);color:#fff;border:1px solid #3fb950;border-radius:8px;padding:6px 10px;z-index:30;flex-wrap:wrap'; holder.appendChild(overlay);
      const mk = (txt, title, fn) => { const b = h('button', null, txt); b.title = title || ''; b.onclick = fn; return b; };
      const bPrev = mk('◀ 上一頁', '', () => player() && player().prev()), bNext = mk('下一頁 ▶', '', () => player() && player().next()), bReload = mk('↻ 重畫', '重新載入播放器', () => { lastKey = ''; refreshDeck(true); });
      [bPrev, bNext, where, bReload].forEach((x) => bar.appendChild(x)); view.appendChild(bar); view.appendChild(note); view.appendChild(holder);
      const player = () => (box && box._deckPlayer) || null;
      const visible = () => D.slides(spec);
      function indexOfSel() { const v = visible(), id = sel && D.byId(spec, sel) >= 0 && spec.objects[D.byId(spec, sel)].type === 'slide' ? sel : curId; const i = v.findIndex((o) => o.id === id); return i < 0 ? 0 : i; }
      function setLabel() { const v = visible(); const i = curId ? v.findIndex((o) => o.id === curId) : -1; where.textContent = v.length ? '📍 第 ' + (i + 1) + ' 頁 / 共 ' + v.length + ' 頁' + (i >= 0 ? ':' + v[i].name : '') : '(還沒有頁)'; }
      async function showUrl(url, index) {
        const my = ++token; playerUrl = url; try { if (box) { const p = player(); if (p) { try { p.destroy(); } catch (e) { /* 已經沒了 */ } } box.remove(); } } catch (e) { /* */ } box = null; playerBox.textContent = ''; playerBox.appendChild(h('div', 'st', '載入播放器…'));
        let b = null; try { b = await opt.mountPlayer(playerBox, url); } catch (e) { playerBox.textContent = '播放器載入失敗:' + String((e && e.message) || e); return; } if (my !== token || !alive) { return; } box = b;
        for (let i = 0; i < 100 && !(box._deckPlayer) && my === token; i++) { await wait(50); } const p = player(); if (p && index > 0) { try { p.goTo(index); } catch (e) { /* 還沒好 */ } }
        const loading = playerBox.querySelector('.st'); if (loading && loading.textContent === '載入播放器…') { loading.remove(); }
      }
      async function refreshDeck(force) {
        const v = visible(); const doc = D.toDoc(spec); const key = JSON.stringify(doc); if (!force && key === lastKey) { return; } lastKey = key;
        if (!doc.chapters.length) { playerBox.textContent = ''; box = null; playerBox.appendChild(h('div', 'st', '(簡報還是空的:說「加一頁」或「新增一章」)')); setLabel(); return; }
        const idx = Math.min(indexOfSel(), Math.max(0, v.length - 1)); wantIndex = idx; let url = savedUrl[key];
        if (!url) { const r = await opt.saveDeck(doc); if (r.error) { err = String(r.error).slice(0, 600); note.textContent = '⚠ 簡報有問題,播放器沒有更新:' + err + '(可以按「復原」,或在 YAML 分頁修好)'; note.style.display = ''; return; } url = r.url; savedUrl[key] = url; if (Object.keys(savedUrl).length > 12) { delete savedUrl[Object.keys(savedUrl)[0]]; } }
        err = ''; note.style.display = 'none'; await showUrl(url, idx); setLabel();
      }
      // 現在看的是哪一頁:播放器自己換頁時,大綱跟著
      const watch = setInterval(() => {
        if (!alive) { clearInterval(watch); return; } if (!view.isConnected) { return; } const p = player(); if (!p || !spec || overlayOpen) { return; } let i = -1; try { i = p.buffering >= 0 ? p.buffering : p.curIndex(); } catch (e) { return; } const v = visible(); if (i < 0 || i >= v.length) { return; }
        if (v[i].id !== curId) { curId = v[i].id; setLabel(); if (sel !== curId && p.playing) { ctx.select(curId); } else if (sel !== curId && !sel) { /* 沒有選取就不搶 */ } }
      }, 500);
      // 預覽再套用:把這一輪的結果存成候選版本、放進播放器(停在第一個被改的頁),接受才算
      async function preview(p) {
        const d = p.edits.some((e) => e.op === 'replace_deck') ? D.diffSemantic(p.spec0, p.next) : D.diff(p.spec0, p.next); if (!d.added.length && !d.removed.length && !d.changed.length) { return true; }
        const doc = D.toDoc(p.next); const prevKey = lastKey; const r = await opt.saveDeck(doc); if (r.error) { ctx.say('這一輪的結果簡報檢查沒過:' + String(r.error).slice(0, 160)); return false; }
        const vis = D.slides(p.next), firstChanged = vis.findIndex((o) => d.added.indexOf(o.id) >= 0 || d.changed.indexOf(o.id) >= 0); const idx = firstChanged >= 0 ? firstChanged : Math.min(indexOfSel(), Math.max(0, vis.length - 1));
        const line = (t, o) => '<div>' + t + ' 第' + (vis.indexOf(o) + 1) + '頁「' + String(o.name).replace(/</g, '&lt;').slice(0, 30) + '」</div>';
        const rows = []; d.added.forEach((id) => { const o = p.next.objects.find((x) => x.id === id); if (o && o.type === 'slide') { rows.push(line('<b style="color:#3fb950">＋新增</b>', o)); } else if (o) { rows.push('<div><b style="color:#3fb950">＋新增</b> 章「' + String(o.name).replace(/</g, '&lt;').slice(0, 30) + '」</div>'); } });
        d.changed.forEach((id) => { const o = p.next.objects.find((x) => x.id === id); if (o && o.type === 'slide') { rows.push(line('<b style="color:#d29922">✎修改</b>', o)); } }); d.removed.forEach((id) => { const o = p.spec0.objects.find((x) => x.id === id); if (o) { rows.push('<div><b style="color:#f85149">－刪除</b> 「' + String(o.name).replace(/</g, '&lt;').slice(0, 30) + '」</div>'); } });
        overlayOpen = true; ctx.setTab('view'); await showUrl(r.url, idx);
        return new Promise((resolve) => {
          overlay.textContent = ''; overlay.style.display = 'flex'; const t = h('div'); t.style.flex = '1'; t.innerHTML = '<div><b>AI 的改動</b>(播放器現在放的是改過的版本)</div>' + rows.slice(0, 8).join('') + (rows.length > 8 ? '<div>…還有 ' + (rows.length - 8) + ' 處</div>' : ''); const yes = h('button', 'pri', '✔ 接受'), no = h('button', null, '✕ 退回');
          const done = async (v) => { overlay.style.display = 'none'; overlayOpen = false; if (!v) { lastKey = ''; const k = prevKey; void k; await refreshDeck(true); } else { savedUrl[JSON.stringify(doc)] = r.url; } resolve(v); };
          yes.onclick = () => done(true); no.onclick = () => done(false); overlay.appendChild(t); overlay.appendChild(yes); overlay.appendChild(no);
        });
      }
      // YAML 分頁
      const srcWrap = h('div'); srcWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1;padding:8px'; const ta = h('textarea', 'code'); ta.rows = 22; ta.spellcheck = false; ta.style.flex = '1'; const srow = h('div', 'row'), bApply = h('button', 'pri', '▶ 套用並看畫面'), bRe = h('button', null, '↻ 放棄修改'), sst = h('span', 'st'); [bApply, bRe, sst].forEach((x) => srow.appendChild(x));
      srcWrap.appendChild(h('div', 'st', '簡報的 YAML(權威文件;deck、chapters、slides)。改完按「套用並看畫面」或切回「播放」。隱藏的頁不會出現在這裡。')); srcWrap.appendChild(ta); srcWrap.appendChild(srow);
      let lastSource = ''; const sourceNow = () => D.toYaml(spec);
      function applySource(quiet) { const text = ta.value; if (text === lastSource) { sst.textContent = quiet ? '' : '沒有改動'; return true; } const r = D.fromYaml(text); if (!r.ok) { sst.className = 'st bad'; sst.textContent = r.error; return false; } sst.className = 'st'; sst.textContent = '已套用'; const hidden = spec.objects.filter((o) => o.type === 'slide' && !o.visible); void hidden; ctx.commit(r.spec, '改寫簡報 YAML(' + D.slides(r.spec).length + ' 頁)', '', 'panel'); return true; }
      bApply.onclick = () => { if (applySource(false)) { ctx.setTab('view'); } }; bRe.onclick = () => { ta.value = lastSource = sourceNow(); sst.textContent = ''; };
      ta.addEventListener('input', () => { const r = D.fromYaml(ta.value); sst.className = 'st' + (r.ok ? '' : ' bad'); sst.textContent = r.ok ? (ta.value === lastSource ? '' : '有改動,還沒套用') : r.error; });
      const props = () => {
        const b = h('div'); b.style.cssText = 'display:flex;flex-direction:column;gap:6px'; const o = sel ? spec.objects[D.byId(spec, sel)] : null; const A = (edits, words) => ctx.apply(edits, words, '', 'panel');
        const fld = (label, type, value, onChange, w) => { const l = h('label'), i = h(type === 'area' ? 'textarea' : 'input'); if (type !== 'area') { i.type = type; } else { i.rows = 4; } i.value = value == null ? '' : value; if (w) { i.style.width = w; } l.appendChild(document.createTextNode(label)); l.appendChild(i); i.onchange = () => onChange(type === 'number' ? Number(i.value) : i.value); return l; };
        if (!o) { b.appendChild(h('div', 'st', '簡報')); b.appendChild(fld('標題', 'text', spec.deck.title, (v) => A([{ op: 'set_deck', props: { title: v } }], '簡報標題改成「' + v + '」'))); b.appendChild(fld('語速(0.5–2)', 'number', spec.deck.speed || 1, (v) => A([{ op: 'set_deck', props: { speed: v } }], '語速 ' + v), '70px')); b.appendChild(fld('語言', 'text', spec.deck.lang || '', (v) => A([{ op: 'set_deck', props: { lang: v } }], '語言 ' + v), '80px')); const st = h('label'), sSel = h('select'); [['', '平面(預設)'], ['flat', '平面'], ['3d', '3D']].forEach((p) => { const op = h('option', null, p[1]); op.value = p[0]; if ((spec.deck.style || '') === p[0]) { op.selected = true; } sSel.appendChild(op); }); st.appendChild(document.createTextNode('風格')); st.appendChild(sSel); sSel.onchange = () => A([{ op: 'set_deck', props: { style: sSel.value || null } }], '風格 ' + (sSel.value || '平面')); b.appendChild(st); b.appendChild(h('div', 'st', '點大綱裡的一頁就能改那一頁;匯出 MP4／PPTX／封包用播放器上的匯出鈕。')); return b; }
        if (o.type === 'chapter') { b.appendChild(h('div', 'st', '章:' + o.name)); const add = h('button', null, '＋ 在這一章最後加一頁'); add.onclick = () => A([{ op: 'add_slide', chapter: o.id, position: 'end', slide: { title: '新的一頁' } }], '在「' + o.name + '」加一頁'); b.appendChild(add); return b; }
        const sl = o.slide; b.appendChild(h('div', 'st', '第 ' + D.numberOf(spec, o) + ' 頁(' + o.id + ')')); b.appendChild(fld('標題', 'text', o.name, (v) => A([{ op: 'set_title', id: o.id, text: v }], '標題改成「' + v + '」')));
        const ls = h('label'), lSel = h('select'); [['', '(自動)'], ['title', '標題頁'], ['topic', '章節頁'], ['content', '重點'], ['split', '重點＋圖'], ['visual', '整頁圖']].forEach((p) => { const op = h('option', null, p[1]); op.value = p[0]; if ((sl.layout || '') === p[0]) { op.selected = true; } lSel.appendChild(op); }); ls.appendChild(document.createTextNode('版面')); ls.appendChild(lSel); lSel.onchange = () => A([{ op: 'update_slide', id: o.id, props: { layout: lSel.value || null } }], '版面 ' + (lSel.value || '自動')); b.appendChild(ls);
        b.appendChild(fld('副標題', 'text', sl.subtitle || '', (v) => A([{ op: 'update_slide', id: o.id, props: { subtitle: v || null } }], '副標題')));
        b.appendChild(fld('重點(一行一條,最多 6)', 'area', (sl.bullets || []).join('\n'), (v) => A([{ op: 'set_bullets', id: o.id, bullets: v.split('\n').map((x) => x.trim()).filter(Boolean) }], '重點')));
        b.appendChild(fld('旁白(念出來的話)', 'area', sl.narration || '', (v) => A([{ op: 'set_narration', id: o.id, text: v }], '旁白')));
        const tr = h('label'), tSel = h('select'); [['', '(預設)'], ['fade', '淡入'], ['slide-left', '左滑入'], ['slide-right', '右滑入'], ['push', '推進'], ['zoom', '縮放'], ['wipe', '擦除'], ['none', '無']].forEach((p) => { const op = h('option', null, p[1]); op.value = p[0]; if (((sl.transition && sl.transition.type) || '') === p[0]) { op.selected = true; } tSel.appendChild(op); }); tr.appendChild(document.createTextNode('轉場')); tr.appendChild(tSel); tSel.onchange = () => A(tSel.value ? [{ op: 'set_transition', id: o.id, type: tSel.value }] : [{ op: 'update_slide', id: o.id, props: { transition: null } }], '轉場 ' + (tSel.value || '預設')); b.appendChild(tr);
        b.appendChild(h('div', 'st', '圖:' + (sl.visual ? (sl.visual.kind || '?') + (sl.visual.src ? ' ' + String(sl.visual.src).slice(0, 30) : '') : '(沒有)') + '。要換圖,直接說「這頁換成…的照片」。')); if (sl.visual) { const rm = h('button', null, '移除這頁的圖'); rm.onclick = () => A([{ op: 'update_slide', id: o.id, props: { visual: null } }], '拿掉圖'); b.appendChild(rm); } return b;
      };
      let stageObj = null;
      const api = {
        tabs: { view, src: srcWrap },
        env: () => ({ slide: curId, selection: sel, playing: !!(player() && player().playing), index: (() => { const v = visible(); return v.findIndex((o) => o.id === curId); })() }),
        refresh: (s, selId) => {
          const selChanged = selId !== sel; spec = s; sel = selId; const v = visible(); if (!curId || !v.some((o) => o.id === curId)) { curId = v.length ? v[Math.min(wantIndex, v.length - 1)].id : null; }
          const so = selId && D.byId(s, selId) >= 0 ? s.objects[D.byId(s, selId)] : null; if (so && so.type === 'slide' && so.visible && selChanged) { curId = so.id; const p = player(); const i = v.findIndex((o) => o.id === so.id); if (p && i >= 0 && !overlayOpen) { try { p.goTo(i); } catch (e) { /* */ } } }
          ctx.setProps(props()); if (document.activeElement !== ta) { ta.value = lastSource = sourceNow(); } setLabel(); if (!overlayOpen) { refreshDeck(false); }
        },
        showTab: (t) => { if (t === 'src') { ta.value = lastSource = sourceNow(); sst.textContent = ''; return; } if (ta.value !== lastSource && !applySource(true)) { ctx.setTab('src'); } },
        destroy: () => { alive = false; clearInterval(watch); token++; const p = player(); if (p) { try { p.destroy(); } catch (e) { /* */ } } },
        player, box: () => box, state: () => ({ curId, overlayOpen, err, url: playerUrl }), preview, goTo: (i) => { const p = player(); if (p) { p.goTo(i); } },
      };
      stageObj = api; void stageObj; stage = api; return api;
    }
  }
  return { mount };
});
