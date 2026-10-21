const fa = window.fa; const R = {}; fa.advancedSettings.offlineMode = false; fa.messages = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* */ } await wait(120); } return null; };
await fa._kiClose(); try { await fa._kiIdbDel('default'); } catch (_) { /* */ }
fa.advancedSettings.knowledge = { location: { kind: 'idb', ref: 'default' }, maxMB: 0, embedConsent: false, autoEmbed: true }; try { localStorage.removeItem('fa.ki.has'); localStorage.removeItem('fa.ki.sideW'); localStorage.removeItem('fa.ki.sideHidden'); } catch (_) { /* */ } fa._kiHas = undefined;
if (fa._kiPopup) { try { fa._kiPopup._ki.destroy(); } catch (_) { /* */ } fa._kiPopup = null; }
if (fa._kiPanels) { for (const w of fa._kiPanels.values()) { try { w._panel._ki.destroy(); } catch (_) { /* */ } } fa._kiPanels.clear(); }
document.querySelectorAll('.fwin-pop,.fwin-ph').forEach((e) => e.remove());
const wiki = '# 蜘蛛\n\n蜘蛛是節肢動物，身體分成頭胸部和腹部。\n\n## 習性\n\n多數蜘蛛會結網捕食昆蟲。\n部分蜘蛛不結網，直接獵捕。\n\n## 分類\n\n目前已知四萬多種蜘蛛。\n';
await fa._kiAdd({ text: wiki, name: '蜘蛛.md', kind: 'md' });
await fa._kiAdd({ text: '本次討論參考 蜘蛛 的資料。\n負責人是 Alice Johnson。\n', name: '會議記錄.txt', kind: 'txt' });
window.confirm = () => true;
const cmd = fa.slashCommands['/knowledge'] || (fa.slashCommands.get && fa.slashCommands.get('/knowledge')); const run = cmd.handler || cmd.run || cmd;
await run('ui', fa);
const pop = await until(() => document.querySelector('.fwin-pop')); const panel = pop;
R.popup = { opened: !!panel, fixed: pop && getComputedStyle(pop).position, handles: pop && pop.querySelectorAll('.fwin-rz').length, max_btn_visible: !!pop && !!Array.from(pop.querySelectorAll('.bar button')).find((b) => b.textContent === '☐'), placeholder_in_chat: !!document.querySelector('.fwin-ph'), message_has_fence: fa.messages.some((m) => /fa-knowledge/.test(String(m.content || ''))) };
const q = (sel, root) => (root || panel).querySelector(sel); const qa = (sel, root) => Array.from((root || panel).querySelectorAll(sel));
const btn = (t) => qa('button').find((b) => b.textContent.includes(t));
await until(() => qa('.src').length === 2);
// 視窗：移動、改大小（邊與角）、最大化／還原（按鈕與雙擊標題列）
const rect = () => pop.getBoundingClientRect(); const r0 = rect(); const bar = q('.bar');
bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 80 })); document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 360, clientY: 120 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); R.moved = { dx: Math.round(rect().left - r0.left), dy: Math.round(rect().top - r0.top) };
const r1 = rect(); const se = pop.querySelector('.fwin-rz.se'); se.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 500, clientY: 500 })); document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 560, clientY: 540 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); R.resize_se = { dw: Math.round(rect().width - r1.width), dh: Math.round(rect().height - r1.height) };
const r2 = rect(); const w = pop.querySelector('.fwin-rz.w'); w.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 400, clientY: 300 })); document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 360, clientY: 300 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); R.resize_w = { dw: Math.round(rect().width - r2.width), dleft: Math.round(rect().left - r2.left) };
const r3 = rect(); pop.querySelector('.fwin-rz.e').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 800, clientY: 300 })); document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: -2000, clientY: 300 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); R.min_width = Math.round(rect().width);
btn('☐').click(); await wait(200); R.maximized = { cls: pop.className.includes('fwin-max'), w: Math.round(rect().width) === window.innerWidth, h: Math.round(rect().height) === window.innerHeight, label: btn('❐') ? '❐' : null };
bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 80 })); document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 500, clientY: 200 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); R.no_move_when_max = Math.round(rect().left) === 0;
btn('❐').click(); await wait(200); R.restored = { cls: !pop.className.includes('fwin-max'), w: Math.round(rect().width) > 0 && Math.round(rect().width) < window.innerWidth };
bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(200); R.dblclick_max = pop.className.includes('fwin-max'); bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(200); R.dblclick_restore = !pop.className.includes('fwin-max');
// 左邊：勾選、全選、看目錄
R.sources = qa('.src .nm').map((e) => e.textContent).join('|');
const row = qa('.src').find((r) => r.textContent.includes('蜘蛛.md')); row.querySelector('input').click(); await wait(1200);
R.uncheck = { ui_off: qa('.src').find((r) => r.textContent.includes('蜘蛛.md')).className.includes('off'), store: (await fa._kiSources()).sources.find((s) => s.name === '蜘蛛.md').enabled === false };
qa('.src').find((r) => r.textContent.includes('蜘蛛.md')).querySelector('input').click(); await wait(1000);
const all = q('.sidehd input[type=checkbox]'); all.click(); await wait(1200); R.select_none = (await fa._kiSources()).stats.enabled; all.click(); await wait(1200); R.select_all = (await fa._kiSources()).stats.enabled;
qa('.src .nm').find((e) => e.textContent === '蜘蛛.md').click(); await until(() => /目錄：蜘蛛/.test(q('.msgs').textContent)); R.outline_card = /習性/.test(q('.msgs').textContent);
// sash 與隱藏／顯示
const side = q('.side'), sash = q('.sash'); const sw0 = side.getBoundingClientRect().width;
sash.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 200 })); document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 420, clientY: 200 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
R.sash = { before: Math.round(sw0), after: Math.round(side.getBoundingClientRect().width), persisted: localStorage.getItem('fa.ki.sideW') };
btn('☰').click(); await wait(200); R.hidden = { side: getComputedStyle(q('.side')).display, sash: getComputedStyle(q('.sash')).display, saved: localStorage.getItem('fa.ki.sideHidden') }; btn('☰').click(); await wait(200); R.shown = getComputedStyle(q('.side')).display !== 'none';
// 拖檔案進來、＋加入
const dt = new DataTransfer(); dt.items.add(new File(['# 拖進來的\n這是拖曳加入的內容。\n'], '拖曳.md', { type: 'text/markdown' }));
side.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt })); R.drag_overlay = side.className.includes('over'); side.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
await until(() => qa('.src .nm').some((e) => e.textContent === '拖曳.md')); R.dropped = qa('.src .nm').some((e) => e.textContent === '拖曳.md'); R.overlay_gone = !side.className.includes('over');
btn('＋ 加入').click(); await until(() => /加入來源/.test(q('.msgs').textContent)); const addCard = qa('.card').pop();
addCard.querySelector('input[placeholder*="名稱"]').value = '貼上.md'; addCard.querySelector('textarea').value = '# 貼上\n貼上的內容在這裡。\n'; Array.from(addCard.querySelectorAll('button')).find((b) => b.textContent === '加入這段文字').click(); await until(() => qa('.src .nm').some((e) => e.textContent === '貼上.md')); R.pasted = qa('.src .nm').some((e) => e.textContent === '貼上.md');
addCard.querySelector('input[placeholder*="網址"]').value = 'ftp://x'; Array.from(addCard.querySelectorAll('button')).find((b) => b.textContent === '加入網址').click(); await until(() => /http/.test(addCard.textContent)); R.bad_url = /http/.test(addCard.textContent);
// 中間：訊息區＋下面的詢問對話區
const ta = q('.ask textarea'); R.layout = { msgs_above_ask: q('.msgs').getBoundingClientRect().bottom <= q('.ask').getBoundingClientRect().top + 2, ask_at_bottom: Math.abs(q('.ask').getBoundingClientRect().bottom - q('.main').getBoundingClientRect().bottom) < 2 };
ta.value = '蜘蛛怎麼結網'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await until(() => qa('.hit').length);
const hits = qa('.hit'); R.ask = { user: q('.u') && q('.u').textContent, n: hits.length, label: hits[0] && hits[0].querySelector('.lb').textContent, by: hits[0] && hits[0].querySelector('.by').textContent, marked: hits[0] && Array.from(hits[0].querySelectorAll('mark')).map((m) => m.textContent).join('|'), cleared: ta.value === '' };
Array.from(hits[0].querySelectorAll('button')).find((b) => b.textContent === '看上下文').click(); await until(() => hits[0].querySelector('pre.code')); R.context = { lines: hits[0].querySelectorAll('.ln').length, hot: hits[0].querySelectorAll('.ln.hot').length };
ta.value = '量子電腦的退火演算法'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await until(() => /找不到/.test(q('.msgs').textContent)); R.ask_none = /找不到/.test(q('.msgs').textContent);
ta.value = '第一行'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); await wait(300); R.shift_enter_keeps_text = ta.value === '第一行'; ta.value = '';
all.click(); await wait(1500);
ta.value = '蜘蛛怎麼結網'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(1500); R.all_unchecked_answer = /找不到/.test(qa('.card').pop().textContent); all.click(); await wait(1500);
// 工具列
const oc = fa._callSimpleCompletion; fa._callSimpleCompletion = async () => '蜘蛛\n結網\n恐龍';
btn('🔄 更新').click(); await until(() => /更新完成/.test(q('.msgs').textContent)); R.refresh = /更新完成/.test(q('.msgs').textContent);
btn('🧹 整理').click(); await until(() => /整理好了|⚠️/.test(qa('.card').pop().textContent), 20000); R.organize = qa('.card').pop().textContent.replace(/\n/g, ' / ').slice(0, 100); fa._callSimpleCompletion = oc;
btn('🔗 關聯').click(); await until(() => !/載入中/.test(qa('.card').pop().textContent)); R.links = qa('.card').pop().textContent.slice(0, 50);
btn('⚙ 設定').click(); await until(() => /目前：/.test(qa('.card').pop().textContent)); const sc = qa('.card').pop();
const unl0 = Array.from(sc.querySelectorAll('input[type=checkbox]')).find((c) => c.nextSibling && c.nextSibling.textContent === '無限'); if (unl0.checked) { unl0.click(); unl0.dispatchEvent(new Event('change', { bubbles: true })); } sc.querySelector('input[type=number]').value = '50'; Array.from(sc.querySelectorAll('button')).find((b) => b.textContent === '套用容量').click(); await until(() => fa._kiSettings().maxMB === 50); R.cap50 = fa._kiSettings().maxMB;
const unl = unl0; unl.click(); unl.dispatchEvent(new Event('change', { bubbles: true })); Array.from(sc.querySelectorAll('button')).find((b) => b.textContent === '套用容量').click(); await until(() => fa._kiSettings().maxMB === 0); R.cap_unlimited = fa._kiSettings().maxMB === 0;
const tmp = 'C:/Users/sunneo/AppData/Local/Temp/fa_ki_ui_' + Date.now() + '.keeplookup'; const ks = sc.querySelector('select'); ks.value = 'file'; sc.querySelector('input[placeholder*="完整路徑"]').value = tmp; Array.from(sc.querySelectorAll('button')).find((b) => b.textContent === '搬過去').click(); await until(() => fa._kiSettings().location.kind === 'file', 20000); R.migrate_file = fa._kiSettings().location.kind;
await wait(2500); ks.value = 'idb'; sc.querySelector('input[placeholder*="完整路徑"]').value = ''; Array.from(sc.querySelectorAll('button')).find((b) => b.textContent === '搬過去').click(); await until(() => fa._kiSettings().location.kind === 'idb', 20000); R.migrate_back = fa._kiSettings().location.kind;
qa('.src').find((r) => r.textContent.includes('貼上.md')).querySelector('button').click(); await until(() => !qa('.src .nm').some((e) => e.textContent === '貼上.md')); R.deleted = !qa('.src .nm').some((e) => e.textContent === '貼上.md');
// 收回對話裡、再彈出；重新整理（重掛）後面板還在對話內
btn('⤓').click(); await wait(300); R.docked = { popped: !!document.querySelector('.fwin-pop'), still_in_dom: panel.isConnected, placeholder_gone: !document.querySelector('.fwin-ph'), restored_style: !panel.style.left };
await run('ui', fa); await wait(300); R.repop_same_panel = document.querySelector('.fwin-pop') === panel; R.no_duplicate_message = fa.messages.filter((m) => /fa-knowledge/.test(String(m.content || ''))).length === 1;
btn('⤓').click(); await wait(300);
// 模擬重新整理：丟掉所有面板、重畫對話紀錄 → 面板從訊息回來，停在對話內（沒有彈出）
for (const w of fa._kiPanels.values()) { try { w._panel._ki.destroy(); } catch (_) { /* */ } } fa._kiPanels.clear(); document.querySelectorAll('.fwin-pop,.fwin-ph').forEach((e) => e.remove());
fa._renderMessageHistory(); const back = await until(() => document.querySelector('.fki')); R.after_refresh = { in_chat: !!back, popped: !!document.querySelector('.fwin-pop'), sources_listed: !!(await until(() => back && back.querySelectorAll('.src').length >= 1)) };
// 內嵌（不彈出）版本
await run('ui inline', fa); await wait(600); R.inline_count = document.querySelectorAll('.fki').length; R.inline_not_popped = !document.querySelector('.fwin-pop');
for (const w of fa._kiPanels.values()) { try { w._panel._ki.destroy(); } catch (_) { /* */ } } fa._kiPanels.clear(); document.querySelectorAll('.fwin-pop,.fwin-ph').forEach((e) => e.remove()); await fa._kiClose(); return R;
