const fa = window.fa; const R = {}; fa.advancedSettings.offlineMode = false; fa.messages = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
document.querySelectorAll('.fwin-pop,.fwin-ph').forEach((e) => e.remove()); if (fa._wgLive) fa._wgLive.clear();
const btns = (root) => Array.from(root.querySelectorAll('button'));
const find = (root, t) => btns(root).find((b) => b.textContent.trim() === t);
const cycle = async (el) => {
  const o = {}; o.popped = el.classList.contains('fwin-pop') && getComputedStyle(el).position === 'fixed'; const r = el.getBoundingClientRect(); o.in_viewport = r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; o.size = Math.round(r.width) + 'x' + Math.round(r.height);
  find(el, '☐').click(); await wait(300); o.maximized = Math.round(el.getBoundingClientRect().width) === innerWidth; find(el, '❐').click(); await wait(300); o.restored = !el.classList.contains('fwin-max');
  find(el, '⤓').click(); await wait(400); o.docked = !el.classList.contains('fwin-pop') && el.isConnected && !document.querySelector('.fwin-ph'); o.docked_size = Math.round(el.getBoundingClientRect().height);
  find(el, '⤢').click(); await wait(300); o.repopped = el.classList.contains('fwin-pop'); find(el, '⤓').click(); await wait(300);
  return o;
};
// 1) HTML 檢視器
fa._openHtmlViewer('測試頁.html', '<!doctype html><title>t</title><h1 id=x>你好</h1>', 'k1');
const hv = await until(() => document.querySelector('.fwd')); await wait(600);
R.html = { found: !!hv, message_fence: fa.messages.some((m) => /fa-widget/.test(String(m.content || '')) && /htmlview/.test(String(m.content || ''))), title: hv && hv.querySelector('.t') && hv.querySelector('.t').textContent, iframe: !!(hv && hv.querySelector('iframe') && hv.querySelector('iframe').srcdoc.includes('你好')) };
R.html.window = hv && await cycle(hv);
// 關閉後留下卡片、可重新開啟
find(hv, '✕').click(); await until(() => /已關閉/.test(document.body.textContent)); R.html.closed_card = /已關閉/.test(document.body.textContent);
const reopen = btns(document.body).find((b) => b.textContent.trim() === '重新開啟'); if (reopen) { reopen.click(); await until(() => document.querySelector('.fwd iframe')); R.html.reopened = !!document.querySelector('.fwd iframe'); }
// 2) sqlitebrowser（記憶體資料庫）
const api = await fa._openSqliteBrowser(':memory:', {}); await api.ready;
const sb = await until(() => document.querySelector('.fsb')); R.sqlite = { found: !!sb, ready_db: !!(api.state && api.state.db), badge: sb && sb.querySelector('.badge') && sb.querySelector('.badge').textContent, has_old_max_button: !!(sb && btns(sb).find((b) => b.textContent.trim() === '🗖')) };
R.sqlite.window = sb && await cycle(sb);
// 在視窗裡真的下 SQL（驗證功能沒壞）
const tabs = sb && Array.from(sb.querySelectorAll('.tabs span')); const sqlTab = tabs && tabs.find((t) => /Execute SQL/.test(t.textContent)); if (sqlTab) { sqlTab.click(); await wait(300); const ta = sb.querySelector('textarea.sql'); ta.value = 'select 1+41 as answer'; const run = btns(sb).find((b) => /Execute|執行/.test(b.textContent)); if (run) { run.click(); await until(() => /42/.test(sb.textContent), 8000); R.sqlite.sql_result_42 = /42/.test(sb.textContent); } }
// 3) 重新整理：用真的重新載入驗證（步驟二在 Python 做）；這裡先把狀態存好
fa._persistChatHistory(); R.persisted = fa.messages.filter((m) => /fa-widget/.test(String(m.content || ''))).length;
return R;
