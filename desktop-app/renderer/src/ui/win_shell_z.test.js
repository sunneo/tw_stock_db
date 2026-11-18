// 終端機帶的疊放計數：視窗化的終端機與終端機開出的視窗共用，點到誰誰最高；接近上限時重新編號，不超過對話框（2147483000）。
'use strict';
const assert = require('assert');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, e.message); } }

function mkEl() {
  const attrs = {};
  return { style: {}, setAttribute(k, v) { attrs[k] = v; }, hasAttribute(k) { return k in attrs; }, _attrs: attrs };
}
const els = [];
global.window = { document: { querySelectorAll: () => els.filter((e) => 'data-fa-tz' in e._attrs) } };
const FaWin = require('./win_shell.js');

t('第一次從 2147482000 之上開始', () => {
  global.window._faTermZ = undefined;
  const a = mkEl(); els.push(a);
  const z = FaWin.nextTermZ(a);
  assert.strictEqual(z, 2147482001);
  assert.ok(a.hasAttribute('data-fa-tz'));
});

t('後點的比先點的高（終端機與 GUI 視窗共用計數）', () => {
  global.window._faTermZ = 2147482000;
  const term = mkEl(), gui = mkEl(); els.push(term, gui);
  term.style.zIndex = String(FaWin.nextTermZ(term));
  gui.style.zIndex = String(FaWin.nextTermZ(gui));
  assert.ok(+gui.style.zIndex > +term.style.zIndex);
  term.style.zIndex = String(FaWin.nextTermZ(term));
  assert.ok(+term.style.zIndex > +gui.style.zIndex);
});

t('接近上限時依原本高低重新編號，仍低於對話框', () => {
  els.length = 0;
  const a = mkEl(), b = mkEl(), c = mkEl(); els.push(a, b, c);
  [a, b, c].forEach((e) => FaWin.nextTermZ(e));
  a.style.zIndex = '2147482890'; b.style.zIndex = '2147482895'; c.style.zIndex = '2147482899';
  global.window._faTermZ = 2147482900;
  const d = mkEl(); els.push(d);
  d.style.zIndex = String(FaWin.nextTermZ(d));
  assert.ok(+a.style.zIndex < +b.style.zIndex && +b.style.zIndex < +c.style.zIndex, '原本的高低順序要保留');
  assert.ok(+d.style.zIndex > +c.style.zIndex, '剛點的最高');
  assert.ok(+d.style.zIndex < 2147483000, '不能蓋過全域對話框');
  assert.ok(+a.style.zIndex >= 2147482000);
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
