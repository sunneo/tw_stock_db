// /edit-media-presentation 的文件模型(純函式、沒有 DOM;node 測得到)。簡報的 YAML(deck、chapters[].slides[])攤平成「物件清單」,
// 這樣就能用跟 /edit-svg、/edit-3d-model、/edit-game 同一個外框(樹狀物件欄、復原重做、步驟記錄、AI 對話框、預覽再套用):
//   章 = { type:'chapter', id:'c1', name:章標題, parent:null }        頁 = { type:'slide', id:'s3', name:頁標題, parent:'c1', slide:{ 其餘欄位:layout、subtitle、bullets、narration、caption、visual、cues、transition… } }
//   隱藏(👁)的頁不放進輸出的簡報(先拿掉、之後再顯示);鎖定(🔓)的頁不能被改(AI 與面板都一樣)。物件清單的順序就是簡報的順序。
//   FaDeckEdit.fromDoc(doc) / toDoc(spec) / validate(spec) / applyEdits(spec, edits, env) -> { spec, applied, appliedEdits, rejected, added }
//   env: { selection:id, slide:id(播放器現在看的那一頁) }。頁的指法:id("s3")、"current"(目前這頁)、"selection"、數字(第幾頁,只算沒隱藏的)。
//   FaDeckEdit.parseCommands(text, spec, env) -> { edits, matched, unmatched }(程式先讀的白話)     editPrompt / parseEditsReply / contextText / outline / diff / toYaml / fromYaml
// 封閉動作:set_deck、add_chapter、rename_chapter、add_slide、update_slide、set_title、set_narration、set_bullets、set_visual、set_transition、remove_object、rename_object、
//   move_object、duplicate_object、set_visible、set_locked、replace_deck(整份換成另一份簡報,給「代理人」改完的結果用);主機的動作:find_picture、generate_image、agent。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDeckEdit = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const LIM = { chapters: 30, slides: 150, title: 120, narration: 1200, bullets: 6, bullet: 220 };
  const OPS = ['set_deck', 'add_chapter', 'rename_chapter', 'add_slide', 'update_slide', 'set_title', 'set_narration', 'set_bullets', 'set_visual', 'set_transition', 'remove_object', 'rename_object', 'move_object', 'duplicate_object', 'set_visible', 'set_locked', 'replace_deck'];
  const HOST_OPS = ['find_picture', 'generate_image', 'agent'];
  const SLIDE_KEYS = ['layout', 'subtitle', 'bullets', 'narration', 'caption', 'visual', 'cues', 'transition', 'duration', 'notes', 'stage', 'lang', 'voice'];
  const DECK_KEYS = ['title', 'lang', 'voice', 'captions', 'bullets', 'speed', 'style', 'environment', 'colors'];
  const LAYOUTS = ['title', 'topic', 'content', 'split', 'visual'];
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const str = (s, n) => String(s == null ? '' : s).slice(0, n);
  const num = (v, lo, hi, d) => { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

  function defaultSpec() { return { v: 1, rev: 0, deck: { title: '新簡報', lang: 'zh-TW' }, seq: 0, objects: [] }; }
  function fromDoc(doc) {
    const d = isObj(doc) ? doc : {}, spec = defaultSpec(); spec.deck = isObj(d.deck) ? clone(d.deck) : { title: '簡報', lang: 'zh-TW' }; let c = 0, s = 0;
    (Array.isArray(d.chapters) ? d.chapters : []).forEach((ch) => {
      if (!isObj(ch)) { return; } const cid = 'c' + (++c); spec.objects.push({ type: 'chapter', id: cid, name: str(ch.title, LIM.title) || '章', parent: null, visible: true, locked: false });
      (Array.isArray(ch.slides) ? ch.slides : []).forEach((sl) => { if (!isObj(sl)) { return; } const o = { type: 'slide', id: 's' + (++s), name: str(sl.title, LIM.title) || '', parent: cid, visible: true, locked: false, slide: {} }; Object.keys(sl).forEach((k) => { if (k !== 'title') { o.slide[k] = clone(sl[k]); } }); spec.objects.push(o); });
    });
    spec.seq = Math.max(c, s); return validate(spec).spec;
  }
  function validate(input) {
    const r = isObj(input) ? input : {}, problems = [], out = { v: 1, rev: Math.max(0, Math.round(Number(r.rev) || 0)), deck: isObj(r.deck) ? clone(r.deck) : { title: '簡報', lang: 'zh-TW' }, seq: 0, objects: [] };
    if (!out.deck.title) { out.deck.title = '簡報'; } out.deck.title = str(out.deck.title, LIM.title); const ids = {}, chapters = [], slidesBy = {}; let nc = 0, ns = 0;
    (Array.isArray(r.objects) ? r.objects : []).forEach((o) => {
      if (!isObj(o) || (o.type !== 'chapter' && o.type !== 'slide')) { return; } const id = /^[cs]\d+$/.test(String(o.id || '')) && !ids[o.id] ? o.id : null; const v = { type: o.type, id, name: str(o.name, LIM.title), parent: o.parent ? String(o.parent) : null, visible: o.visible !== false, locked: !!o.locked };
      if (o.type === 'chapter') { if (nc >= LIM.chapters) { problems.push('章太多,只留前 ' + LIM.chapters + ' 章'); return; } nc++; v.parent = null; if (!v.name) { v.name = '章'; } chapters.push(v); } else { if (ns >= LIM.slides) { problems.push('頁太多,只留前 ' + LIM.slides + ' 頁'); return; } ns++; v.slide = {}; const sl = isObj(o.slide) ? o.slide : {}; Object.keys(sl).forEach((k) => { v.slide[k] = clone(sl[k]); }); (slidesBy[v.parent] = slidesBy[v.parent] || []).push(v); }
      if (id) { ids[id] = 1; }
    });
    let max = Number(r.seq) || 0; const all = chapters.concat([].concat.apply([], Object.keys(slidesBy).map((k) => slidesBy[k]))); all.forEach((o) => { const m = /^[cs](\d+)$/.exec(o.id || ''); if (m) { max = Math.max(max, Number(m[1])); } });
    const assign = (o) => { if (!o.id) { let id; do { max++; id = (o.type === 'chapter' ? 'c' : 's') + max; } while (ids[id]); o.id = id; ids[id] = 1; } };
    chapters.forEach(assign); const known = {}; chapters.forEach((c) => { known[c.id] = 1; });
    // 沒有章的頁(或指向不存在的章)併進第一章;沒有任何章就開一章
    const orphans = []; Object.keys(slidesBy).forEach((k) => { if (!known[k]) { slidesBy[k].forEach((s) => orphans.push(s)); delete slidesBy[k]; } });
    if (orphans.length && !chapters.length) { const c = { type: 'chapter', id: null, name: '第一章', parent: null, visible: true, locked: false }; assign(c); chapters.push(c); known[c.id] = 1; }
    if (orphans.length) { slidesBy[chapters[0].id] = (slidesBy[chapters[0].id] || []).concat(orphans); }
    chapters.forEach((c) => { out.objects.push(c); (slidesBy[c.id] || []).forEach((s) => { s.parent = c.id; assign(s); out.objects.push(s); }); });
    out.seq = max; return { ok: true, spec: out, problems };
  }
  function toDoc(spec, o) {
    o = o || {}; const s = validate(spec).spec, doc = { deck: clone(s.deck), chapters: [] }, order = ['id', 'layout', 'subtitle', 'bullets', 'narration', 'caption', 'visual', 'cues', 'transition', 'duration', 'notes']; let cur = null;
    s.objects.forEach((x) => {
      if (x.type === 'chapter') { if (x.visible || o.hidden) { cur = { title: x.name, slides: [] }; doc.chapters.push(cur); } else { cur = null; } return; }
      if (!cur || !(x.visible || o.hidden)) { return; } const sl = { title: x.name }; order.concat(Object.keys(x.slide).filter((k) => order.indexOf(k) < 0)).forEach((k) => { if (k in x.slide) { sl[k] = clone(x.slide[k]); } }); cur.slides.push(sl);
    });
    doc.chapters = doc.chapters.filter((c) => c.slides.length); return doc;
  }
  const yamlLib = () => { if (typeof jsyaml !== 'undefined') { return jsyaml; } try { return typeof require === 'function' ? require('js-yaml') : null; } catch (e) { return null; } };
  function toYaml(spec, o) { const Y = yamlLib(); const doc = toDoc(spec, o); if (!Y) { return JSON.stringify(doc, null, 2); } return Y.dump(doc, { lineWidth: -1, noRefs: true }); }
  function fromYaml(text) { const Y = yamlLib(); if (!Y) { return { ok: false, error: '沒有 YAML 讀取器' }; } let doc; try { doc = Y.load(String(text || '').replace(/^#!fa:[^\n]*\n/, '')); } catch (e) { return { ok: false, error: 'YAML 讀不懂:' + String((e && e.message) || e).split('\n')[0].slice(0, 160) }; } if (!isObj(doc) || !Array.isArray(doc.chapters)) { return { ok: false, error: '簡報要有 deck 與 chapters(每章有 slides)' }; } return { ok: true, spec: fromDoc(doc) }; }

  // ───── 查詢 ─────
  const byId = (s, id) => s.objects.findIndex((o) => o.id === id);
  const find = (s, ref) => { const i = byId(s, ref); if (i >= 0) { return i; } return s.objects.findIndex((o) => o.name === ref); };
  const slides = (s, all) => s.objects.filter((o) => o.type === 'slide' && (all || o.visible));
  const chapterOf = (s, o) => s.objects.find((c) => c.type === 'chapter' && c.id === o.parent);
  const tree = (s) => { const out = []; s.objects.forEach((o) => out.push({ obj: o, depth: o.type === 'chapter' ? 0 : 1 })); return out; };
  const list = (s) => outline(s);
  function numberOf(s, o) { const v = slides(s); const i = v.indexOf(o); return i < 0 ? 0 : i + 1; }
  function outline(s, o) {
    o = o || {}; const lines = []; let n = 0; s.objects.forEach((x) => {
      if (x.type === 'chapter') { lines.push('章 ' + x.id + ' 「' + x.name + '」' + (x.visible ? '' : '(隱藏)')); return; } if (x.visible) { n++; }
      const sl = x.slide, vk = sl.visual ? (sl.visual.kind || '?') : '', nar = sl.narration ? String(sl.narration).length : 0;
      lines.push('  ' + (x.visible ? '第' + n + '頁' : '(隱藏)') + ' ' + x.id + ' 「' + x.name + '」' + (sl.layout ? ' ' + sl.layout : '') + (vk ? ' 圖:' + vk : '') + (sl.bullets ? ' 重點×' + sl.bullets.length : '') + (nar ? ' 旁白' + nar + '字' : '') + (x.locked ? ' 🔒' : '') + (o.focus === x.id ? '  ← 目前這頁' : ''));
    }); return lines.join('\n');
  }
  function slideYaml(x) { const Y = yamlLib(); const d = Object.assign({ title: x.name }, x.slide); return Y ? Y.dump(d, { lineWidth: 100, noRefs: true }).slice(0, 2400) : JSON.stringify(d).slice(0, 2400); }
  function contextText(s, env) {
    env = env || {}; const cur = env.slide && byId(s, env.slide) >= 0 ? s.objects[byId(s, env.slide)] : (env.selection && byId(s, env.selection) >= 0 && s.objects[byId(s, env.selection)].type === 'slide' ? s.objects[byId(s, env.selection)] : null);
    const L = ['簡報「' + s.deck.title + '」(' + (s.deck.lang || '') + (s.deck.speed ? ',語速 ' + s.deck.speed : '') + (s.deck.style ? ',' + s.deck.style : '') + '),共 ' + slides(s).length + ' 頁。', '大綱:', outline(s, { focus: cur && cur.id })];
    if (cur) { L.push('', '使用者現在看的是第 ' + numberOf(s, cur) + ' 頁(' + cur.id + ')的內容:', slideYaml(cur)); const all = slides(s, true), k = all.indexOf(cur); if (k > 0) { L.push('前一頁:「' + all[k - 1].name + '」'); } if (k >= 0 && k < all.length - 1) { L.push('下一頁:「' + all[k + 1].name + '」'); } }
    return L.join('\n');
  }

  // ───── 動作 ─────
  function resolve(s, ref, env) {
    env = env || {}; if (ref == null || ref === '') { return -1; } let r = ref;
    if (typeof r === 'number' || /^\d+$/.test(String(r))) { const v = slides(s)[Number(r) - 1]; return v ? byId(s, v.id) : -1; }
    r = String(r); if (r === 'current' || r === 'this') { return byId(s, env.slide || env.selection || ''); } if (r === 'selection') { return byId(s, env.selection || ''); }
    const m = /^第\s*(\d+)\s*頁$/.exec(r); if (m) { return resolve(s, Number(m[1]), env); } return find(s, r);
  }
  const cleanSlide = (sl) => { const out = {}; if (!isObj(sl)) { return out; } SLIDE_KEYS.forEach((k) => { if (sl[k] === undefined || sl[k] === null) { return; } if (k === 'layout' && LAYOUTS.indexOf(sl[k]) < 0) { return; } if (k === 'bullets') { out.bullets = (Array.isArray(sl.bullets) ? sl.bullets : []).slice(0, LIM.bullets).map((b) => str(b, LIM.bullet)); return; } if (k === 'narration' || k === 'caption') { out[k] = str(sl[k], LIM.narration); return; } out[k] = clone(sl[k]); }); return out; };
  const nextId = (s, p) => { let n = s.seq; let id; do { n++; id = p + n; } while (byId(s, id) >= 0); s.seq = n; return id; };
  const locked = (o) => o && o.locked;
  const OPFN = {
    set_deck: (s, e) => { const p = isObj(e.props) ? e.props : {}; let n = 0; Object.keys(p).forEach((k) => { if (DECK_KEYS.indexOf(k) < 0) { return; } if (p[k] === null) { delete s.deck[k]; } else if (k === 'speed') { s.deck.speed = num(p[k], 0.5, 2, 1); } else if (k === 'title') { s.deck.title = str(p[k], LIM.title) || s.deck.title; } else { s.deck[k] = clone(p[k]); } n++; }); return n ? {} : { error: '沒有可以改的設定(' + DECK_KEYS.join('、') + ')' }; },
    add_chapter: (s, e) => { if (s.objects.filter((o) => o.type === 'chapter').length >= LIM.chapters) { return { error: '章最多 ' + LIM.chapters + ' 章' }; } const c = { type: 'chapter', id: nextId(s, 'c'), name: str(e.title || e.name, LIM.title) || '新的一章', parent: null, visible: true, locked: false }; let at = s.objects.length; if (e.after != null) { const i = resolve(s, e.after, {}); if (i >= 0) { const o = s.objects[i]; const ch = o.type === 'chapter' ? o : chapterOf(s, o); const k = s.objects.indexOf(ch); at = k + 1; while (at < s.objects.length && s.objects[at].type === 'slide') { at++; } } } s.objects.splice(at, 0, c); return { added: [c.id] }; },
    rename_chapter: (s, e) => { const i = resolve(s, e.id, {}); if (i < 0 || s.objects[i].type !== 'chapter') { return { error: '找不到那一章' }; } if (locked(s.objects[i])) { return { error: '這一章鎖住了' }; } s.objects[i].name = str(e.title || e.name, LIM.title) || s.objects[i].name; return {}; },
    add_slide: (s, e, env) => {
      if (slides(s, true).length >= LIM.slides) { return { error: '頁最多 ' + LIM.slides + ' 頁' }; } const sl = isObj(e.slide) ? e.slide : {}; const title = str(sl.title || e.title, LIM.title); let chapter = null, at = -1;
      if (e.after != null || e.before != null) { const ref = e.after != null ? e.after : e.before; const i = resolve(s, ref, env); if (i < 0) { return { error: '找不到要接在哪一頁後面:' + str(ref, 20) }; } const o = s.objects[i]; if (o.type === 'chapter') { chapter = o; at = i + 1; if (e.before != null) { at = i + 1; } } else { chapter = chapterOf(s, o); at = e.before != null ? i : i + 1; } }
      else if (e.chapter) { const i = resolve(s, e.chapter, {}); if (i >= 0 && s.objects[i].type === 'chapter') { chapter = s.objects[i]; at = i + 1; while (at < s.objects.length && s.objects[at].type === 'slide') { at++; } } }
      if (!chapter) { const cs = s.objects.filter((o) => o.type === 'chapter'); if (!cs.length) { const c = { type: 'chapter', id: nextId(s, 'c'), name: '第一章', parent: null, visible: true, locked: false }; s.objects.push(c); chapter = c; at = s.objects.length; } else { chapter = cs[cs.length - 1]; at = s.objects.length; } }
      if (e.position === 'start') { at = s.objects.indexOf(chapter) + 1; } if (e.position === 'end') { at = s.objects.indexOf(chapter) + 1; while (at < s.objects.length && s.objects[at].type === 'slide') { at++; } }
      const o = { type: 'slide', id: nextId(s, 's'), name: title || '新的一頁', parent: chapter.id, visible: true, locked: false, slide: cleanSlide(sl) }; s.objects.splice(at, 0, o); return { added: [o.id] };
    },
    update_slide: (s, e, env) => { const i = resolve(s, e.id, env); if (i < 0 || s.objects[i].type !== 'slide') { return { error: '找不到那一頁:' + str(e.id, 20) }; } const o = s.objects[i]; if (locked(o)) { return { error: '「' + o.name + '」鎖住了(先解鎖)' }; } const p = isObj(e.props) ? e.props : {}; let n = 0; Object.keys(p).forEach((k) => { if (k === 'title') { if (typeof p.title === 'string' && p.title.trim()) { o.name = str(p.title, LIM.title); n++; } return; } if (SLIDE_KEYS.indexOf(k) < 0) { return; } if (p[k] === null) { delete o.slide[k]; n++; return; } const t = cleanSlide({ [k]: p[k] }); if (k in t) { o.slide[k] = t[k]; n++; } }); return n ? {} : { error: '沒有可以改的欄位(title、' + SLIDE_KEYS.join('、') + ')' }; },
    set_title: (s, e, env) => OPFN.update_slide(s, { id: e.id, props: { title: e.text != null ? e.text : e.title } }, env),
    set_narration: (s, e, env) => OPFN.update_slide(s, { id: e.id, props: { narration: e.text != null ? e.text : e.narration } }, env),
    set_bullets: (s, e, env) => OPFN.update_slide(s, { id: e.id, props: { bullets: e.bullets || e.items || [] } }, env),
    set_visual: (s, e, env) => { const i = resolve(s, e.id, env); const p = { visual: e.visual === null ? null : e.visual }; if (e.layout) { p.layout = e.layout; } else if (i >= 0 && e.visual && s.objects[i].slide && !s.objects[i].slide.layout) { p.layout = (s.objects[i].slide.bullets || []).length ? 'split' : 'visual'; } return OPFN.update_slide(s, { id: e.id, props: p }, env); },
    set_transition: (s, e, env) => OPFN.update_slide(s, { id: e.id, props: { transition: { type: str(e.type, 20) || 'fade', ms: Math.round(num(e.ms, 100, 3000, 500)) } } }, env),
    rename_object: (s, e, env) => { const i = resolve(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 20) }; } if (locked(s.objects[i])) { return { error: '鎖住了' }; } const n = str(e.name, LIM.title).trim(); if (!n) { return { error: '名字是空的' }; } s.objects[i].name = n; return {}; },
    remove_object: (s, e, env) => { const i = resolve(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 20) }; } const o = s.objects[i]; if (locked(o)) { return { error: '「' + o.name + '」鎖住了(先解鎖)' }; } if (o.type === 'chapter') { const kids = s.objects.filter((x) => x.parent === o.id); if (kids.some(locked)) { return { error: '這一章裡有鎖住的頁' }; } s.objects = s.objects.filter((x) => x !== o && x.parent !== o.id); } else { s.objects.splice(i, 1); } return {}; },
    move_object: (s, e, env) => {
      const i = resolve(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 20) }; } const o = s.objects[i]; if (locked(o)) { return { error: '鎖住了' }; }
      const group = (x) => (x.type === 'chapter' ? [x].concat(s.objects.filter((y) => y.parent === x.id)) : [x]);
      if (e.after != null || e.before != null) { const ref = resolve(s, e.after != null ? e.after : e.before, env); if (ref < 0 || s.objects[ref] === o) { return { error: '找不到要放到哪一頁的旁邊' }; } const t = s.objects[ref]; if (o.type === 'chapter' && t.type === 'slide') { return { error: '整章只能放到另一章旁邊' }; } const mv = group(o); s.objects = s.objects.filter((x) => mv.indexOf(x) < 0); let k = s.objects.indexOf(t); if (e.after != null) { k++; if (t.type === 'chapter' && o.type === 'chapter') { while (k < s.objects.length && s.objects[k].type === 'slide') { k++; } } } if (o.type === 'slide') { o.parent = t.type === 'chapter' ? t.id : t.parent; } s.objects.splice(k, 0, ...mv); return {}; }
      const sib = s.objects.filter((x) => x.type === o.type && (x.parent || null) === (o.parent || null)), k = sib.indexOf(o); let nk = e.to === 'up' || e.to === 'earlier' ? k - 1 : e.to === 'down' || e.to === 'later' ? k + 1 : e.to === 'first' ? 0 : e.to === 'last' ? sib.length - 1 : k;
      if (nk < 0 || nk >= sib.length) { if (o.type === 'slide' && (e.to === 'earlier' || e.to === 'up' || e.to === 'later' || e.to === 'down')) { const cs = s.objects.filter((x) => x.type === 'chapter'), ci = cs.findIndex((c) => c.id === o.parent), nc = cs[ci + (nk < 0 ? -1 : 1)]; if (!nc) { return { error: '已經在最' + (nk < 0 ? '前' : '後') + '面了' }; } s.objects.splice(i, 1); o.parent = nc.id; let at = s.objects.indexOf(nc) + 1; if (nk >= 0) { s.objects.splice(at, 0, o); } else { while (at < s.objects.length && s.objects[at].type === 'slide') { at++; } s.objects.splice(at, 0, o); } return {}; } return { error: '已經在最' + (nk < 0 ? '前' : '後') + '面了' }; }
      const t = sib[nk]; const mv = group(o); s.objects = s.objects.filter((x) => mv.indexOf(x) < 0); let at = s.objects.indexOf(t); if (nk > k) { at++; if (o.type === 'chapter') { while (at < s.objects.length && s.objects[at].type === 'slide') { at++; } } } s.objects.splice(at, 0, ...mv); return {};
    },
    duplicate_object: (s, e, env) => { const i = resolve(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 20) }; } const o = s.objects[i]; if (o.type === 'chapter') { return { error: '整章不能複製(複製裡面的頁)' }; } if (slides(s, true).length >= LIM.slides) { return { error: '頁最多 ' + LIM.slides + ' 頁' }; } const c = clone(o); c.id = nextId(s, 's'); c.name = str(o.name + ' 2', LIM.title); c.locked = false; if (c.slide && c.slide.id) { delete c.slide.id; } s.objects.splice(i + 1, 0, c); return { added: [c.id] }; },
    set_visible: (s, e, env) => { const i = resolve(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 20) }; } s.objects[i].visible = e.visible !== false; return {}; },
    set_locked: (s, e, env) => { const i = resolve(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 20) }; } s.objects[i].locked = !!e.locked; return {}; },
    replace_deck: (s, e) => { const d = isObj(e.doc) ? e.doc : null; if (!d) { return { error: '沒有簡報內容' }; } const keepLocked = s.objects.filter((o) => o.locked && o.type === 'slide'); const n = fromDoc(d); s.deck = n.deck; s.objects = n.objects; s.seq = n.seq; keepLocked.length; return {}; },
  };
  function applyEdits(spec, edits, env) {
    let s = validate(spec).spec; const applied = [], appliedEdits = [], rejected = [], added = []; env = env || {};
    (Array.isArray(edits) ? edits : []).slice(0, 60).forEach((e) => {
      if (!isObj(e) || OPS.indexOf(e.op) < 0) { rejected.push({ op: e && e.op, error: '不認得的動作 ' + str(e && e.op, 30) }); return; }
      const work = clone(s), prevLen = work.objects.length; let r; try { r = OPFN[e.op](work, e, env) || {}; } catch (x) { r = { error: String((x && x.message) || x) }; }
      if (r.error) { rejected.push({ op: e.op, error: r.error }); return; } const v = validate(work); s = v.spec; applied.push(e.op); appliedEdits.push(e); (r.added || []).forEach((id) => added.push(id)); void prevLen;
    });
    s.rev = (spec && spec.rev || 0) + (applied.length ? 1 : 0); return { spec: s, applied, appliedEdits, rejected, added };
  }
  function editWords(e) {
    const id = str(e.id == null ? '' : e.id, 24); switch (e.op) {
      case 'set_deck': return '改簡報設定(' + Object.keys(e.props || {}).join('、') + ')'; case 'add_chapter': return '新增一章「' + str(e.title || e.name, 30) + '」'; case 'rename_chapter': return '章改名為「' + str(e.title || e.name, 30) + '」';
      case 'add_slide': return '新增一頁「' + str((e.slide && e.slide.title) || e.title, 30) + '」'; case 'update_slide': return '改 ' + id + '(' + Object.keys(e.props || {}).join('、') + ')'; case 'set_title': return id + ' 標題改成「' + str(e.text != null ? e.text : e.title, 30) + '」';
      case 'set_narration': return id + ' 的旁白改了'; case 'set_bullets': return id + ' 的重點改了'; case 'set_visual': return id + ' 的圖換了'; case 'set_transition': return id + ' 的轉場改成 ' + str(e.type, 12);
      case 'remove_object': return '刪掉 ' + id; case 'rename_object': return id + ' 改名為「' + str(e.name, 30) + '」'; case 'move_object': return '調整 ' + id + ' 的順序'; case 'duplicate_object': return '複製 ' + id;
      case 'set_visible': return (e.visible === false ? '隱藏 ' : '顯示 ') + id; case 'set_locked': return (e.locked ? '鎖定 ' : '解鎖 ') + id; case 'replace_deck': return '整份簡報換成新的版本'; default: return str(e.op, 30);
    }
  }
  // 兩個版本差在哪(外框預覽用):加了／拿掉／改了的物件 id
  function diff(a, b) { const A = {}, B = {}; a.objects.forEach((o) => { A[o.id] = JSON.stringify(o); }); b.objects.forEach((o) => { B[o.id] = JSON.stringify(o); }); const added = [], removed = [], changed = []; Object.keys(B).forEach((id) => { if (!(id in A)) { added.push(id); } else if (A[id] !== B[id]) { changed.push(id); } }); Object.keys(A).forEach((id) => { if (!(id in B)) { removed.push(id); } }); return { added, removed, changed }; }
  // replace_deck 之後 id 全部重編,上面的 diff 會全部不同;用「標題＋內容」配對來比較
  function diffSemantic(a, b) { const key = (o) => JSON.stringify([o.type, o.name, o.slide || null]); const A = a.objects.map(key), B = b.objects.map(key); const used = {}; const added = [], changed = [], removed = []; const titleIn = {}; a.objects.forEach((o, i) => { (titleIn[o.type + '|' + o.name] = titleIn[o.type + '|' + o.name] || []).push(i); }); b.objects.forEach((o, i) => { const same = A.indexOf(B[i]); if (same >= 0 && !used[same]) { used[same] = 1; return; } const t = (titleIn[o.type + '|' + o.name] || []).filter((k) => !used[k])[0]; if (t != null) { used[t] = 1; changed.push(o.id); } else { added.push(o.id); } }); a.objects.forEach((o, i) => { if (!used[i]) { removed.push(o.id); } }); return { added, removed, changed: changed.filter((x) => added.indexOf(x) < 0) }; }

  // ───── 程式先讀的白話 ─────
  const CN = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const nnum = (t) => { t = String(t || '').trim(); if (/^\d+$/.test(t)) { return Number(t); } if (t.length === 1) { return CN[t] || 0; } const m = /^十([一二三四五六七八九])?$/.exec(t); if (m) { return 10 + (m[1] ? CN[m[1]] : 0); } const m2 = /^([二三四五六七八九])十([一二三四五六七八九])?$/.exec(t); if (m2) { return CN[m2[1]] * 10 + (m2[2] ? CN[m2[2]] : 0); } return 0; };
  const PAGE = '(?:第\\s*([0-9一二兩三四五六七八九十]+)\\s*頁|(?:這|本|目前這|現在這)\\s*(?:一)?\\s*頁|這張|目前這張|這一張)';
  const pageRef = (m, i) => (m[i] ? nnum(m[i]) : 'current');
  const unq = (t) => String(t || '').trim().replace(/^[「"『]|[」"』]$/g, '').trim();
  function parseCommands(text, spec, env) {
    const s = validate(spec).spec, edits = [], matched = [], unmatched = []; env = env || {};
    String(text || '').split(/[\n;；]+/).map((c) => c.trim()).filter(Boolean).forEach((c0) => {
      const c = c0.replace(/^(?:請你?|幫我|請幫我|麻煩|可以|我要|我想要?|給我)\s*/, ''); let m, e = null;
      if ((m = new RegExp('^(?:把)?' + PAGE + '\\s*(?:的)?\\s*(?:標題|題目)\\s*(?:改成|換成|改為|設成|是)\\s*(.+)$').exec(c))) { e = [{ op: 'set_title', id: pageRef(m, 1), text: unq(m[2]) }]; }
      else if ((m = new RegExp('^(?:把)?' + PAGE + '\\s*(?:的)?\\s*(?:旁白|講稿|口白)\\s*(?:改成|換成|改為|設成)\\s*(.+)$').exec(c))) { e = [{ op: 'set_narration', id: pageRef(m, 1), text: unq(m[2]) }]; }
      else if ((m = new RegExp('^(?:刪除|刪掉|移除|拿掉|去掉)\\s*' + PAGE + '$').exec(c))) { e = [{ op: 'remove_object', id: pageRef(m, 1) }]; }
      else if ((m = new RegExp('^(?:複製|再來一頁|再做一頁)\\s*' + PAGE + '$').exec(c))) { e = [{ op: 'duplicate_object', id: pageRef(m, 1) }]; }
      else if ((m = new RegExp('^(?:把)?' + PAGE + '\\s*(隱藏|顯示|鎖定|解鎖)$').exec(c))) { const v = m[2]; e = [v === '隱藏' || v === '顯示' ? { op: 'set_visible', id: pageRef(m, 1), visible: v === '顯示' } : { op: 'set_locked', id: pageRef(m, 1), locked: v === '鎖定' }]; }
      else if ((m = new RegExp('^(?:把)?' + PAGE + '\\s*(?:移到|放到|搬到|挪到|移動到)\\s*(最後|最前面?|最後面|第\\s*([0-9一二兩三四五六七八九十]+)\\s*頁(?:的)?(後面|之後|前面|之前)?)$').exec(c))) { const id = pageRef(m, 1), where = m[2]; if (/最後/.test(where)) { e = [{ op: 'move_object', id, after: slides(s).length }]; } else if (/最前/.test(where)) { e = [{ op: 'move_object', id, before: 1 }]; } else if (m[3]) { const n = nnum(m[3]); e = [/前面|之前/.test(m[4] || '') ? { op: 'move_object', id, before: n } : { op: 'move_object', id, after: n }]; } }
      else if ((m = new RegExp('^在\\s*' + PAGE + '\\s*(後面|之後|前面|之前)\\s*(?:新增|加|插入|加入|多加|做)\\s*(?:一|1)?\\s*(?:頁|張)(?:\\s*(?:標題|題目)?\\s*(?:叫|叫做|是|為|:|:)\\s*(.+))?$').exec(c)) || (m = new RegExp('^(?:新增|加|插入|加入)\\s*(?:一|1)?\\s*(?:頁|張)\\s*(?:在)?\\s*' + PAGE + '\\s*(後面|之後|前面|之前)(?:\\s*(?:標題|題目)?\\s*(?:叫|叫做|是|為|:|:)\\s*(.+))?$').exec(c))) { const ref = pageRef(m, 1), before = /前面|之前/.test(m[2]); e = [{ op: 'add_slide', [before ? 'before' : 'after']: ref, slide: { title: m[3] ? unq(m[3]) : '新的一頁' } }]; }
      else if ((m = /^(?:新增|加|插入|加入)\s*(?:一|1)?\s*(?:頁|張)(?:\s*(?:標題|題目)?\s*(?:叫|叫做|是|為|:|:)\s*(.+))?$/.exec(c))) { e = [{ op: 'add_slide', after: 'current', slide: { title: m[1] ? unq(m[1]) : '新的一頁' } }]; }
      else if ((m = /^(?:新增|加|建立)\s*(?:一|1)?\s*章\s*(?:叫|叫做|是|為|:|:)?\s*[「"]?(.*?)[」"]?$/.exec(c))) { e = [{ op: 'add_chapter', title: m[1] || '新的一章' }]; }
      else if ((m = /^(?:把)?\s*(?:整份|全部)?\s*(?:簡報)?\s*(?:的)?\s*(?:語速|速度|講話速度)\s*(?:改成|調成|設成)\s*(\d+(?:\.\d+)?)\s*(?:倍|x)?$/.exec(c))) { e = [{ op: 'set_deck', props: { speed: Number(m[1]) } }]; }
      else if ((m = /^(?:把)?\s*(?:整份)?\s*簡報\s*(?:的)?\s*(?:標題|名稱|名字)\s*(?:改成|換成|改為|設成|是)\s*(.+)$/.exec(c))) { e = [{ op: 'set_deck', props: { title: unq(m[1]) } }]; }
      else if ((m = new RegExp('^(?:把)?' + PAGE + '\\s*(?:的)?\\s*轉場\\s*(?:改成|換成|設成)\\s*(淡入淡出|淡入|推進|縮放|擦除|滑入|無)$').exec(c))) { const T2 = { '淡入淡出': 'fade', '淡入': 'fade', '推進': 'push', '縮放': 'zoom', '擦除': 'wipe', '滑入': 'slide-left', '無': 'none' }; e = [{ op: 'set_transition', id: pageRef(m, 1), type: T2[m[2]] }]; }
      if (e && e.length) { e.forEach((x) => edits.push(x)); matched.push(c0); } else { unmatched.push(c0); }
    });
    void env; return { edits, matched, unmatched };
  }
  const ACTIONS_TEXT = '封閉的編輯動作(只能用這些,JSON):set_deck{props:{title,lang,voice,speed,style,environment,colors}};add_chapter{title,after?};rename_chapter{id,title};add_slide{slide:{title,layout?,subtitle?,bullets?,narration?,caption?,visual?,cues?,transition?},after?|before?(頁 id、數字、"current"),chapter?,position?:"start"|"end"};update_slide{id,props:{title?,layout?,subtitle?,bullets?,narration?,caption?,visual?,cues?,transition?,duration?,notes?}(值 null 是拿掉)};set_title{id,text};set_narration{id,text};set_bullets{id,bullets};set_visual{id,visual,layout?};set_transition{id,type,ms?};remove_object{id};rename_object{id,name};move_object{id,to:"earlier"|"later"|"first"|"last"}或{id,after|before:頁};duplicate_object{id};set_visible{id,visible};set_locked{id,locked}。主機的動作(不是改文件,是去取東西再放進去):find_picture{query(2~5 個英文關鍵字),id?("current"=目前這頁),mode?:"visual"|"new_slide"};generate_image{prompt,id?,mode?};agent{task(要代理人做的事,白話,完整)}。頁的指法:id("s3")、"current"(使用者現在看的那一頁)、數字(第幾頁)。';
  function editPrompt(spec, request, extra, selection, env) {
    const s = validate(spec).spec; env = env || {}; const e2 = Object.assign({}, env, { selection });
    const system = '你是簡報編輯器的助手。使用者正在看一份動畫簡報,用說的要你修改它;你只能回一個 JSON 物件 {"say":"一句話說明","edits":[動作…]},不要回別的字。' + ACTIONS_TEXT
      + '\n規則:1) 「這頁／這張」就是使用者現在看的那一頁(id 用 "current");沒說哪一頁又不是整份的事,就改現在這頁。2) 旁白是「念出來的話」(口語、一句一句,不超過 1200 字);重點(bullets)最多 6 條、每條要短。3) 要放真實的照片:用 find_picture(英文關鍵字),不要編圖片網址;要畫的圖用 generate_image;視覺 visual 的種類只能是 shapes、anim2d、svg、mermaid、chart、image、collage、table、scene3d、group、code、terminal、quiz、widget、video(流程圖用 mermaid,表格用 table)。4) 需要上網查資料、讀網頁或檔案、整理來源、畫圖表、一次改很多頁、做一整章——這些你一次做不好——就回 {"op":"agent","task":"…"},由代理人去做(它有搜尋、找圖、讀檔、畫圖表的工具)。5) 鎖住(🔒)的頁不要改。6) 不要改使用者沒提到的頁。';
    return { system, user: contextText(s, e2) + (selection && byId(s, selection) >= 0 ? '\n焦點:' + selection : '') + (extra ? '\n' + extra : '') + '\n\n使用者說:' + String(request || '') };
  }
  function parseEditsReply(text) {
    const t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b <= a) { return { ok: false, error: '沒有 JSON' }; } let obj; try { obj = JSON.parse(t.slice(a, b + 1)); } catch (e) { try { obj = JSON.parse(t.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e2) { return { ok: false, error: 'JSON 讀不懂' }; } }
    const arr = Array.isArray(obj) ? obj : (Array.isArray(obj.edits) ? obj.edits : (obj.op ? [obj] : null)); if (!arr) { return { ok: false, error: '沒有 edits' }; } const edits = []; let dropped = 0; arr.forEach((e) => { if (isObj(e) && (OPS.indexOf(e.op) >= 0 || HOST_OPS.indexOf(e.op) >= 0)) { edits.push(e); } else { dropped++; } }); return { ok: true, say: str(obj.say, 400), edits, dropped };
  }
  function promptOf(spec, steps) { const s = validate(spec).spec, L = ['請做一份動畫簡報「' + s.deck.title + '」(' + (s.deck.lang || '') + '),共 ' + slides(s).length + ' 頁:', '', outline(s)]; const t = (steps || []).filter((x) => x.text); if (t.length) { L.push('', '(有效的修改指示,依序):'); t.forEach((x, i) => L.push((i + 1) + '. ' + x.text + (x.summary ? ' → ' + x.summary : ''))); } return L.join('\n'); }
  function listStarters() { return [{ id: 'last', label: '最近的簡報', desc: '接著這個對話裡最近做的那一份' }]; }
  function starter() { return defaultSpec(); }
  return { OPS, HOST_OPS, LIM, SLIDE_KEYS, DECK_KEYS, defaultSpec, fromDoc, toDoc, validate, toYaml, fromYaml, applyEdits, editWords, list, outline, contextText, find, byId, resolve, slides, chapterOf, numberOf, tree, diff, diffSemantic, parseCommands, editPrompt, parseEditsReply, promptOf, listStarters, starter, ACTIONS_TEXT };
});
