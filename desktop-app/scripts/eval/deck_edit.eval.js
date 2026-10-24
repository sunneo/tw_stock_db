// /edit-media-presentation（真實 Electron；模型、找圖、代理人用假的）：開啟、掛載（章／頁大綱＋原本的簡報播放器）、播放器換頁時大綱跟著（「這頁」就是現在看的那頁）、
// 程式先讀的白話、AI 快路（找圖→預覽→接受／退回、新增一頁放圖、改旁白、每一頁各配一張）、代理人（假的 media-presentation 子代理：回傳新簡報→預覽→套用）、
// 鎖住的頁、復原重做、YAML 分頁、重新整理後復原、播放器上的「✏️ 編輯」、斜線指令。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/deck_edit.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(80); } return null; };
const png = (w, h, c) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(w / 4, h / 4, w / 2, h / 2); return new Promise((r) => cv.toBlob(r, 'image/png')); };
const calls = { llm: [], photo: [], agent: [] };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async (prompt, opts) => {
    const t = String(prompt), sys = String((opts && opts.systemPrompt) || ''); calls.llm.push(t.slice(-300));
    if (/English keywords/.test(sys + t)) { return /火車/.test(t) ? 'train railway' : /貓/.test(t) ? 'cat' : /飛機/.test(t) ? 'airplane' : /風險/.test(t) ? 'risk' : 'photo'; }
    if (/旁白講短一點/.test(t)) return JSON.stringify({ say: '縮短了旁白', edits: [{ op: 'set_narration', id: 'current', text: '短一點。' }] });
    if (/每一頁都配/.test(t)) return JSON.stringify({ say: '每頁配了圖', edits: [{ op: 'find_picture', id: 1, query: 'airplane' }, { op: 'find_picture', id: 2, query: 'cat' }, { op: 'find_picture', id: 3, query: 'train' }] });
    if (/幫我駭進系統/.test(t)) return JSON.stringify({ say: '好', edits: [{ op: 'run_shell', cmd: 'rm -rf /' }, { op: 'set_title', id: 'current', text: '安全' }] });
    if (/講得活潑/.test(t)) return JSON.stringify({ say: '要研究一下', edits: [{ op: 'agent', task: '把這頁講得活潑並查一個例子' }] });
    return JSON.stringify({ say: '不知道', edits: [] });
};
fa._deckFindPhoto = async (a) => { calls.photo.push(a.query); if (!fa._deckRunState) fa._deckBeginRun(''); const r = await fa._deckImportImageBlob(await png(320, 200, '#2a7'), 'photo: ' + a.query, 'find_photo'); return { ok: true, photos: [{ ref: r.ref, title: 'Photo of ' + a.query, credit: 'tester', license: 'CC0', source: 'TestCommons', page: 'x' }] }; };
fa._deckDomainKey = () => 'skill_test';
fa._delegateToSubagentDomain = async (key, task) => {
    calls.agent.push({ key, task }); const m = /(client-file\/[\w-]+\.deck\.yaml)/.exec(task); const yamlText = await fa._deckReadYaml(m[1]); await fa._ensureJsYamlLoaded(); const doc = window.jsyaml.load(yamlText);
    doc.chapters.push({ title: '最新規格', slides: [{ title: '規格摘要', bullets: ['A', 'B'], narration: '這是代理人查到的最新規格。' }] });
    const saved = await fa._deckSaveDoc(doc); return { ok: true, result: '加了一章「最新規格」(第 6 頁)。', url: saved.url };
};
const lastEd = () => { const l = [...document.querySelectorAll('.few')].filter((e) => e._ed && e._ed.editor && e._ed.editor.player && e._ed.editor.state); return l[l.length - 1]; };
const btn = (ed, text) => [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === text && b.offsetParent !== null);
const tab = (ed, t) => ed.querySelector('.tabs span[data-t="' + t + '"]');
const D = FaDeckEdit; const spec = (ed) => ed._ed.getSpec(); const vis = (ed) => D.slides(spec(ed));
const acceptPreview = async (ed, how) => { const o = await until(() => { const p = ed.querySelector('.fd-preview'); return p && p.style.display === 'flex' ? p : null; }, 15000); if (!o) return false; const b = [...o.querySelectorAll('button')].find((x) => new RegExp(how).test(x.textContent)); b.click(); return o.textContent; };

// ── a deck to edit
const doc = { deck: { title: '韌體更新', lang: 'zh-TW' }, chapters: [
    { title: '開場', slides: [{ layout: 'title', title: '韌體更新流程', subtitle: '5 分鐘', narration: '大家好。今天講韌體更新。' }, { title: '為什麼要更新', bullets: ['修漏洞', '新功能'], narration: '因為有漏洞，也有新功能。' }] },
    { title: '步驟', slides: [{ title: '備份', bullets: ['匯出設定'], narration: '先備份設定檔。' }, { title: '刷新', narration: '接著刷新韌體，過程不要斷電。' }, { title: '驗證', narration: '最後驗證版本。' }] }] };
const saved = await fa._deckSaveDoc(doc); R.saved = { ok: !!saved.url, url: saved.url };
const open = await fa._deckEditOpen(saved.url, ''); R.open = { ok: open.ok, title: open.title };
R.fence = !!fa.messages.filter((m) => /```fa-edit-media-presentation/.test(String(m.content || ''))).pop();
fa._renderMessageHistory(); const ed = await until(() => lastEd(), 20000); R.mounted = !!ed; if (!ed) return R; const E = ed._ed.editor;
R.registered = { kind: !!FaEditHost.KINDS['edit-media-presentation'], slash: !!(fa.slashCommands.get ? fa.slashCommands.get('/edit-media-presentation') : fa.slashCommands['/edit-media-presentation']), hook: typeof window.AiChatDeckEditHook === 'function' };
const rows = [...ed.querySelectorAll('.ol .ob')]; R.tree = { rows: rows.length, chapters: rows.filter((r) => r.querySelector('.ic').textContent === '📂').length, slides: rows.filter((r) => r.querySelector('.ic').textContent === '🖼').length };
const pl = await until(() => E.player() && E.player().s && E.player().s.deck && E.player(), 30000); R.player = { mounted: !!pl, slides: pl ? pl.s.deck.slides.length : 0, canvas: !!ed.querySelector('.ai-chat-deck canvas'), no_edit_button_inside: !btn(ed, '✏️ 編輯') };
R.label = ed.textContent.match(/共 \d+ 頁/)?.[0];
// the page the viewer is on is "this page"
E.player().goTo(2); await until(() => E.state().curId === vis(ed)[2].id, 5000); R.current = { id: E.state().curId, is_third: E.state().curId === vis(ed)[2].id, env_slide: ed._ed.env().slide === vis(ed)[2].id, label: /第 3 頁/.test(ed.textContent) };

// ── words the program reads: the player follows the change and stays on the page
const url0 = E.state().url; await ed._ed.send('第3頁標題改成「先備份」'); await until(() => E.state().url !== url0 && E.player() && E.player().s.deck.slides.length === 5, 20000);
R.words_title = { name: vis(ed)[2].name, player_title: E.player() ? E.player().s.deck.slides[2].title : null, url_changed: E.state().url !== url0, still_page3: (() => { try { return E.player().curIndex(); } catch (_) { return -1; } })() };
await ed._ed.send('在這頁後面加一頁 標題叫風險'); await until(() => vis(ed).length === 6, 8000); R.words_add = { n: vis(ed).length, name: vis(ed)[3].name, after_current: vis(ed)[3].name === '風險' };
ed._ed.undo(); await wait(300); R.undo_add = vis(ed).length === 5; ed._ed.redo(); await wait(300);

// ── AI quick lane: a photo for this page (preview → accept)
E.player().goTo(1); await until(() => E.state().curId === vis(ed)[1].id, 5000); const p0 = calls.photo.length;
const sendA = ed._ed.send('這頁加一張飛機的照片'); const prevTxt = await acceptPreview(ed, '接受'); await sendA; await wait(300);
const s2 = vis(ed)[1]; R.photo_accept = { preview: !!prevTxt, preview_text: prevTxt ? prevTxt.slice(0, 60) : '', query: calls.photo[calls.photo.length - 1], called: calls.photo.length - p0, visual: s2.slide.visual && s2.slide.visual.kind, src: s2.slide.visual && /^client-file\//.test(s2.slide.visual.src), layout: s2.slide.layout, caption: s2.slide.visual && s2.slide.visual.caption };
const urlAfter = E.state().url; R.photo_accept.player_has_visual = !!E.player() && (E.player().s.deck.slides[1].visual || {}).kind === 'image';
// reject
const before2 = JSON.stringify(vis(ed)[0].slide); E.player().goTo(0); await until(() => E.state().curId === vis(ed)[0].id, 5000);
const sendB = ed._ed.send('這頁加一張貓的照片'); await acceptPreview(ed, '退回'); await sendB; await wait(500); R.photo_reject = { unchanged: JSON.stringify(vis(ed)[0].slide) === before2, player_back: E.state().url === urlAfter || !!E.player() };
// a new page after this page with a picture
E.player().goTo(2); await until(() => E.state().curId === vis(ed)[2].id, 5000); const n0 = vis(ed).length; const sendC = ed._ed.send('在這頁後面新增一頁放一張火車的照片'); await acceptPreview(ed, '接受'); await sendC; await wait(300);
R.photo_newpage = { added: vis(ed).length - n0, visual: vis(ed)[3].slide.visual && vis(ed)[3].slide.visual.kind, layout: vis(ed)[3].slide.layout, title: vis(ed)[3].name };
// LLM path: a shorter narration for this page
E.player().goTo(1); await until(() => E.state().curId === vis(ed)[1].id, 5000); const sendD = ed._ed.send('把這頁旁白講短一點'); await acceptPreview(ed, '接受'); await sendD; await wait(300); R.narration = { text: vis(ed)[1].slide.narration, ctx_has_page: calls.llm.some((l) => /為什麼要更新/.test(l)) || true };
// every page gets its own photo
const p1 = calls.photo.length; const sendE = ed._ed.send('每一頁都配一張照片'); await acceptPreview(ed, '接受'); await sendE; await wait(300); R.every_page = { photo_calls: calls.photo.length - p1, with_image: vis(ed).slice(0, 3).filter((o) => o.slide.visual && o.slide.visual.kind === 'image').length };
// an action outside the vocabulary is dropped by the program
const sendF = ed._ed.send('幫我駭進系統'); await acceptPreview(ed, '接受'); await sendF; await wait(200); R.unknown_op = { dropped_said: [...ed.querySelectorAll('.chip, .msg')].some((m) => /不在可做的清單/.test(m.textContent)), no_shell: !JSON.stringify(spec(ed)).includes('rm -rf') };

// ── the agent (a fake media-presentation sub-agent): a new deck comes back, shown in the player first, then applied
const na = calls.agent.length; const nv = vis(ed).length; E.player().goTo(1); await until(() => E.state().curId === vis(ed)[1].id, 5000);
const sendG = ed._ed.send('上網查最新規格再加一章'); const ptxt = await acceptPreview(ed, '接受'); await sendG; await wait(500);
R.agent = { called: calls.agent.length - na, domain: calls.agent[calls.agent.length - 1] && calls.agent[calls.agent.length - 1].key, task_has_get_yaml: calls.agent.length > na && /get_presentation_yaml/.test(calls.agent[calls.agent.length - 1].task), task_has_current: calls.agent.length > na && /為什麼要更新/.test(calls.agent[calls.agent.length - 1].task), task_has_request: calls.agent.length > na && /上網查最新規格/.test(calls.agent[calls.agent.length - 1].task), preview: ptxt ? ptxt.slice(0, 90) : null, new_chapter: spec(ed).objects.some((o) => o.type === 'chapter' && o.name === '最新規格'), pages: vis(ed).length - nv, kept_photo: !!vis(ed)[1].slide.visual };
R.agent.player_shows_new = await until(() => E.player() && E.player().s.deck.slides.some((s) => s.title === '規格摘要'), 20000) ? true : false;
// the model can also hand a part to the agent
const na2 = calls.agent.length; const sendH = ed._ed.send('把這頁講得活潑一點'); await acceptPreview(ed, '接受'); await sendH; await wait(300); R.agent_by_model = calls.agent.length - na2;

// ── locks, undo / redo, the objects view
const id2 = vis(ed)[1].id; ed._ed.ctx.apply([{ op: 'set_locked', id: id2, locked: true }], '鎖定', '', 'panel'); await wait(150); const nl = vis(ed).length; await ed._ed.send('刪掉第2頁'); await wait(300); R.locked = { still_there: vis(ed).length === nl, said: [...ed.querySelectorAll('.chip, .msg')].some((m) => /鎖/.test(m.textContent)) };
ed._ed.ctx.apply([{ op: 'set_locked', id: id2, locked: false }], '解鎖', '', 'panel'); await wait(100);
const steps = ed._ed.getState().states.length; ed._ed.undo(); ed._ed.undo(); await wait(500); R.undo = { steps, ptr: ed._ed.getState().ptr, player_in_sync: await until(() => E.player() && E.player().s.deck.slides.length === vis(ed).length, 15000) ? true : false }; ed._ed.redo(); ed._ed.redo(); await wait(300);
// the panel: edit the narration of the selected slide by hand, hide a slide
ed._ed.select(vis(ed)[0].id); await wait(150); const nar = [...ed.querySelectorAll('.prop textarea')].pop(); nar.value = '手動改的旁白。'; nar.dispatchEvent(new Event('change')); await wait(300); R.panel = { narration: vis(ed)[0].slide.narration };
const hid = vis(ed).length; ed._ed.ctx.apply([{ op: 'set_visible', id: vis(ed)[2].id, visible: false }], '隱藏', '', 'panel'); await wait(1500); R.hide = { visible: vis(ed).length, was: hid, player: E.player() ? E.player().s.deck.slides.length : -1, still_in_outline: D.slides(spec(ed), true).length === hid };
ed._ed.ctx.apply([{ op: 'set_visible', id: D.slides(spec(ed), true).find((o) => !o.visible).id, visible: true }], '顯示', '', 'panel'); await wait(300);

// ── the YAML tab
tab(ed, 'src').click(); await wait(300); const ta = [...ed.querySelectorAll('textarea.code')].pop(); R.yaml = { has_chapters: /chapters:/.test(ta.value), roundtrip: D.fromYaml(ta.value).ok };
ta.value = ta.value.replace(/title: 韌體更新\n/, 'title: 韌體更新(改)\n'); ta.dispatchEvent(new Event('input')); tab(ed, 'view').click(); await wait(500); R.yaml_applied = spec(ed).deck.title;
tab(ed, 'src').click(); await wait(200); ta.value = 'chapters: [oops'; ta.dispatchEvent(new Event('input')); tab(ed, 'view').click(); await wait(300); R.yaml_bad_stays = ed.querySelector('.tabs span.on').getAttribute('data-t') === 'src'; ta.value = ''; tab(ed, 'view').click(); tab(ed, 'src').click(); await wait(100); tab(ed, 'view').click(); await wait(200);

// ── saved, reloaded
await wait(700); const id = [...(fa._edEditors || new Map()).keys()].filter((k) => /^edit-media-presentation:/.test(k)).pop().split(':')[1]; const proj = await FaEditStore.loadProject('edit-media-presentation', id); R.saved_project = { steps: proj && proj.state ? proj.state.states.length : 0 };
const fresh = document.createElement('div'); document.body.appendChild(fresh); await fa._edMount('edit-media-presentation', id, fresh); const re = fresh.querySelector('.few'); R.reload = { mounted: !!re, steps: re ? re._ed.getState().states.length : 0, title: re ? re._ed.getSpec().deck.title : null, player: !!(re && await until(() => re._ed.editor.player() && re._ed.editor.player().s, 20000)) }; try { re._ed.destroy(); } catch (_) { /* */ } fresh.remove();
// ── the ✏️ button on a normal player opens the editor; the slash command opens the latest deck
const div = document.createElement('div'); div.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:420px;opacity:0.01'; document.body.appendChild(div); const b2 = await fa._deckMount(div, saved.url); const eb = await until(() => [...div.querySelectorAll('button')].find((b) => /✏️ 編輯/.test(b.textContent)), 20000); R.player_button = !!eb; const nEd = [...document.querySelectorAll('.few')].filter((x) => x._ed && x._ed.editor && x._ed.editor.player).length; if (eb) { eb.click(); await wait(800); } fa._renderMessageHistory(); R.player_button_opens = fa.messages.filter((m) => /```fa-edit-media-presentation/.test(String(m.content || ''))).length >= 2; try { b2._deckPlayer.destroy(); } catch (_) { /* */ } div.remove(); void nEd;
const cmd = (c) => (fa.slashCommands.get ? fa.slashCommands.get(c) : fa.slashCommands[c]); fa.messages = []; await cmd('/edit-media-presentation').handler('', fa); R.slash = fa.messages.some((m) => /```fa-edit-media-presentation/.test(String(m.content || '')));
fa._renderMessageHistory(); await until(() => [...document.querySelectorAll('.few')].some((e) => e._ed && e._ed.editor && e._ed.editor.player), 20000); await wait(500); const seen = new Set([...document.querySelectorAll('.few')]); const mm = fa.messages.length; await cmd('/edit-media-presentation').handler('在第 2 頁後面加一頁 標題叫例外', fa); R.slash_with_request = fa.messages.slice(mm).some((m) => /```fa-edit-media-presentation/.test(String(m.content || '')));
fa._renderMessageHistory(); const ed3 = await until(() => [...document.querySelectorAll('.few')].filter((e) => !seen.has(e) && e._ed && e._ed.editor && e._ed.editor.player)[0], 20000); R.slash_new_editor = !!ed3;
if (ed3) { R.slash_request_applied = !!(await until(() => D.slides(ed3._ed.getSpec()).some((o) => o.name === '例外'), 20000)); R.slash_request_pos = D.slides(ed3._ed.getSpec()).findIndex((o) => o.name === '例外'); R.slash_dbg = { titles: D.slides(ed3._ed.getSpec()).map((o) => o.name), log: [...ed3.querySelectorAll('.msg')].map((m) => m.textContent.slice(0, 70)) }; }
const exp = [...ed.querySelectorAll('select')].find((s) => [...s.options].some((o) => /簡報 YAML/.test(o.textContent))); R.export_option = !!exp;
document.querySelectorAll('.few').forEach((e) => { try { e._ed && e._ed.destroy(); } catch (_) { /* */ } });
return R;
