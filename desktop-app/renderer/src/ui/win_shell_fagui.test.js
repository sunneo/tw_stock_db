// 網頁版全螢幕 GUI 頁（body.fa-gui-mode）不彈出成小窗：pop() 直接不動作、⤢ 按鈕收起、即使 opts.floating 也不彈出。
// 執行：node renderer/src/ui/win_shell_fagui.test.js
'use strict';
const assert = require('assert');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, e.message); } }

// 最小 DOM 替身：只實作 win_shell.decorate 會用到的部分
function mkNode(tag) {
  const cls = new Set();
  const n = {
    tagName: String(tag || 'DIV').toUpperCase(), className: '', textContent: '', title: '', style: {}, children: [], _attrs: {},
    classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (x) => cls.has(x) },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c) { this.children.unshift(c); c.parentNode = this; return c; },
    insertAdjacentElement() {}, remove() {}, setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    get nextSibling() { return null; }, parentNode: null,
  };
  return n;
}
function setupDom(faGui) {
  const body = mkNode('body');
  if (faGui) body.classList.add('fa-gui-mode');
  global.document = {
    body, documentElement: mkNode('html'), head: mkNode('head'), fullscreenEnabled: false,
    createElement: (tag) => mkNode(tag), getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  global.getComputedStyle = () => ({ position: 'relative' });
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.window = { innerWidth: 1920, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
}

// 每次重新載入模組（模組內部的 injectCss 只做一次，讀 document 的狀態要重來）
function loadFaWin() { delete require.cache[require.resolve('./win_shell.js')]; return require('./win_shell.js'); }

t('一般對話：floating:true 會彈出（原本行為不變）', () => {
  setupDom(false);
  const FaWin = loadFaWin();
  const el = mkNode('div');
  const ctl = FaWin.decorate(el, { id: 'x1', title: 'a', floating: true });
  assert.strictEqual(ctl.isPopped(), true);
});

t('全螢幕 GUI 頁：floating:true 也不彈出，且 pop() 不動作', () => {
  setupDom(true);
  const FaWin = loadFaWin();
  const el = mkNode('div');
  const ctl = FaWin.decorate(el, { id: 'x2', title: 'b', floating: true });
  assert.strictEqual(ctl.isPopped(), false);
  ctl.pop();
  assert.strictEqual(ctl.isPopped(), false);
  assert.ok(!el.classList.contains('fwin-pop'), '不該加上 fwin-pop');
  assert.strictEqual(document.body.children.indexOf(el), -1, '不該被搬到 body 底下');
});

t('全螢幕 GUI 頁：⤢ 彈出按鈕收起（display:none）', () => {
  setupDom(true);
  const FaWin = loadFaWin();
  const el = mkNode('div');
  FaWin.decorate(el, { id: 'x3', title: 'c' });
  const btns = el.children.flatMap((c) => [c].concat(c.children || []));
  const pop = btns.find((b) => b.tagName === 'BUTTON' && b.textContent === '⤢');
  assert.ok(pop, '找不到 ⤢ 按鈕');
  assert.strictEqual(pop.style.display, 'none');
});

console.log(`win_shell 全螢幕頁測試：${pass} 通過、${fail} 失敗`);
if (fail) process.exit(1);
