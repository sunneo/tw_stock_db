const fa = window.fa; const R = {}; fa.advancedSettings.offlineMode = false; fa.messages = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
document.querySelectorAll('.fwin-pop,.fwin-ph').forEach((e) => e.remove());
const NL = String.fromCharCode(10);
const checkWin = async (name, el, barSel) => {
  const out = { found: !!el };
  if (!el) return out;
  const root = el; const tools = () => Array.from(root.querySelectorAll('button')).filter((b) => ['☐', '❐', '⤢', '⤓'].includes(b.textContent.trim()));
  out.buttons = tools().map((b) => b.textContent.trim()).join('');
  const rect0 = root.getBoundingClientRect(); const popBtn = tools().find((b) => b.textContent.trim() === '⤢'); if (!popBtn) { out.error = 'no pop button'; return out; }
  popBtn.click(); await wait(400);
  out.popped = root.classList.contains('fwin-pop') && getComputedStyle(root).position === 'fixed'; out.placeholder = !!root.parentNode.querySelector(':scope > .fwin-ph') || !!document.querySelector('.fwin-ph');
  const r1 = root.getBoundingClientRect(); out.size = Math.round(r1.width) + 'x' + Math.round(r1.height); out.in_viewport = r1.left >= -1 && r1.top >= -1 && r1.right <= window.innerWidth + 1 && r1.bottom <= window.innerHeight + 1;
  const maxBtn = tools().find((b) => b.textContent.trim() === '☐'); maxBtn.click(); await wait(300); out.maximized = Math.round(root.getBoundingClientRect().width) === window.innerWidth && Math.round(root.getBoundingClientRect().height) === window.innerHeight;
  const restBtn = tools().find((b) => b.textContent.trim() === '❐'); restBtn.click(); await wait(300); out.restored = !root.classList.contains('fwin-max');
  const dockBtn = tools().find((b) => b.textContent.trim() === '⤓'); dockBtn.click(); await wait(400); out.docked = !root.classList.contains('fwin-pop') && !document.querySelector('.fwin-ph') && root.isConnected;
  return out;
};
// 1) 網頁編輯器（有 iframe 預覽：彈出後 iframe 不能重新載入）
const o1 = await fa._webeditOpen({ starter: 'todo' }); fa._renderMessageHistory(); const we = await until(() => document.querySelector('.fwe')); await wait(1500);
const ifr = we && we.querySelector('iframe'); let loads = 0; if (ifr) { ifr.addEventListener('load', () => { loads++; }); }
R.webedit = await checkWin('webedit', we); R.webedit.iframe_kept = !!ifr && loads === 0 && ifr.isConnected; R.webedit.iframe_loads_during_pop_dock = loads;
R.webedit.old_full_button_gone = !we || !Array.from(we.querySelectorAll('button')).some((b) => b.textContent.trim() === '⛶');
// 2) 學習單編輯器
const o2 = await fa._worksheetMake({ request: '做一張數到十的數一數學習單' }).catch((e) => ({ error: String(e) })); fa._renderMessageHistory(); const wk = await until(() => document.querySelector('.fwk')); await wait(800);
R.worksheet = await checkWin('worksheet', wk); R.worksheet.old_full_button_gone = !wk || !Array.from(wk.querySelectorAll('button')).some((b) => b.textContent.trim() === '⛶');
// 3) 資料檢視器（json 程式碼區塊）
fa._pushAssistantMessage('資料' + NL + NL + '```json' + NL + JSON.stringify({ name: 'x', items: [{ id: 1 }, { id: 2 }], meta: { owner: 'Bob' } }, null, 2) + NL + '```', null); fa._renderMessageHistory(); const dv = await until(() => document.querySelector('.fdv')); await wait(800);
R.dataview = await checkWin('dataview', dv);
// 4) 對話裡的卡片（圖片）：統一外殼
const png = (() => { const c = document.createElement('canvas'); c.width = c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 120, 120); return c.toDataURL('image/png'); })();
const msg = { role: 'tool', content: '[測試圖片]' }; Object.defineProperty(msg, '_displayDataUrl', { value: png, enumerable: false, configurable: true }); fa.messages.push(msg); fa._renderMessageHistory(); await wait(600);
const imgCard = Array.from(document.querySelectorAll('.fwin-host')).find((e) => e.querySelector('img') && !e.classList.contains('fwe') && !e.classList.contains('fwk') && !e.classList.contains('fdv') && !e.classList.contains('fki'));
R.image_card = await checkWin('image', imgCard);
// 5) 知識庫面板
const cmd = fa.slashCommands['/knowledge'] || fa.slashCommands.get('/knowledge'); const run = cmd.handler || cmd.run || cmd; await run('ui inline', fa); const ki = await until(() => document.querySelector('.fki')); R.knowledge = await checkWin('knowledge', ki);
// 6) 終端機（自己的視窗化）
const tr = Array.from(document.querySelectorAll('button')).some((b) => /視窗化/.test(b.textContent)); R.terminal_has_own_windowing = tr;
document.querySelectorAll('.fwin-pop,.fwin-ph').forEach((e) => e.remove()); return R;
