// 除錯：開曲庫面板，回報錯誤與面板狀態（評測守則同 musiclib_chip.eval.js）
const out = {}; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = []; window.addEventListener('error', (e) => errs.push(String(e.message)));
try {
  out.hasOpen = typeof window.fa._mlOpen; out.hasUI = typeof FaMusicLibUI; out.hasHost = typeof FaMusicLibHost;
  let r; try { r = window.fa._mlOpen(); if (r && r.then) await r; } catch (e) { out.openErr = String((e && e.stack) || e); }
  await sleep(2500);
  out.panels = document.querySelectorAll('.fml').length;
  out.cls = Array.from(document.querySelectorAll('[class*=ml],[class*=fml]')).slice(0, 8).map((x) => x.className);
  out.text = (document.body.innerText || '').slice(0, 300);
  out.errs = errs.slice(0, 5);
} catch (e) { out.error = String((e && e.stack) || e); }
return out;
