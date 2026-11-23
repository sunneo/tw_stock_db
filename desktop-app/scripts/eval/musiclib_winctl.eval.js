// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：全新 --user-data-dir、一次一個、結束前確認無殘留行程、最多跑兩次。
// 音樂庫視窗控制鈕真桌面版評測：打開音樂庫面板，檢查標題區（.fml-hero）右邊有視窗外殼的三個按鈕（最大化、彈出、全螢幕），
// 工具列上沒有另外一顆「最大化」；按最大化後面板撐滿視窗；再按還原。結果寫進 checks。
const out = { checks: [], info: {} };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rc = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
try {
  window.fa._mlOpen(); await sleep(2500);
  const panels = document.querySelectorAll('.fml'), p = panels[panels.length - 1];
  check('音樂庫面板存在', !!p);
  const hero = p && p.querySelector('.fml-hero');
  const btns = hero ? Array.from(hero.querySelectorAll(':scope > button')) : [];
  out.info.heroButtons = btns.map((b) => b.textContent + '@' + JSON.stringify(rc(b)));
  check('標題區有三個視窗控制鈕', btns.length === 3, String(btns.length));
  check('控制鈕看得到（有大小、在標題區右半邊）', btns.length === 3 && btns.every((b) => { const r = b.getBoundingClientRect(); const h = hero.getBoundingClientRect(); return r.width > 10 && r.height > 10 && r.left > h.left + h.width / 2; }), JSON.stringify(out.info.heroButtons));
  const ownMax = Array.from(p.querySelectorAll('.fml-bar button')).filter((b) => /最大化|還原/.test(b.textContent) && b.style.display !== 'none');
  check('工具列沒有另一顆最大化', ownMax.length === 0, String(ownMax.length));
  out.info.hostClass = p && p.parentElement ? p.parentElement.className : null;
  check('面板外層是視窗外殼 fwin-host', !!(p && p.parentElement && p.parentElement.classList.contains('fwin-host')), out.info.hostClass);
  if (btns.length === 3) {
    btns[0].click(); await sleep(500);
    const host = p.parentElement, r = rc(host);
    out.info.maxRect = r; out.info.viewport = { w: innerWidth, h: innerHeight };
    check('按最大化後撐滿視窗', r && r.w >= innerWidth - 4 && r.h >= innerHeight - 4, JSON.stringify(r) + ' vs ' + innerWidth + 'x' + innerHeight);
    btns[0].click(); await sleep(300);
  }
} catch (e) { check('評測本身沒出錯', false, String((e && e.stack) || e)); }
out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
return out;
