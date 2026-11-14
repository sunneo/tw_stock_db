// node renderer/src/guitpl/guitpl_core.test.js -- 圖形介面範本核心（規格檢查、檢索、逐步詢問、合併、字母選擇題）
const assert = require('assert');
const T = require('./guitpl_core.js');
let n = 0; const ok = () => { n++; };

const PAL = { bg: '#111111', fg: '#eeeeee', accent: '#4aa3ff', danger: '#e5534b', muted: '#888' };
const goodSpec = () => ({
  format: 'guitpl/1', id: 'x', domain: 'text-editor', source: 'builtin',
  layout: { window: { title: 'T', width: 400 }, tree: [{ kind: 'column', children: [{ id: 'ed', kind: 'editor' }, { id: 'save', kind: 'button', text: 'S' }] }] },
  behavior: { state: {}, handlers: [{ on: 'click:save', do: 'save_file' }] },
  palette: PAL, theme: { name: 'dark' },
  shortcuts: [{ keys: 'Ctrl+S', do: 'save_file' }],
  sound: [{ on: 'save_file', tone: 'ok' }],
  scenes: [{ id: 'main', title: '主畫面' }]
});

// 1. 規格檢查
assert.deepStrictEqual(T.validateSpec(goodSpec(), { actions: { save_file: {} } }), { ok: true, errors: [] }); ok();
let bad = goodSpec(); bad.format = 'x';
assert.ok(T.validateSpec(bad).errors.some((e) => /format/.test(e))); ok();
bad = goodSpec(); bad.layout.tree[0].children[1].id = 'ed';
assert.ok(T.validateSpec(bad).errors.some((e) => /重複/.test(e))); ok();
bad = goodSpec(); bad.behavior.handlers[0].on = 'click:nope';
assert.ok(T.validateSpec(bad).errors.some((e) => /不存在的節點/.test(e))); ok();
bad = goodSpec(); bad.shortcuts[0].keys = 'Ctrl+Ctrl';
assert.ok(T.validateSpec(bad).errors.some((e) => /快捷鍵/.test(e))); ok();
bad = goodSpec(); bad.palette.accent = 'blue';
assert.ok(T.validateSpec(bad).errors.some((e) => /palette\.accent/.test(e))); ok();
assert.ok(T.validateSpec(goodSpec(), { actions: {} }).errors.some((e) => /動作不存在/.test(e))); ok();
assert.ok(T.validateSpec(goodSpec(), { kinds: ['column'] }).errors.some((e) => /不支援的節點種類 editor/.test(e))); ok();
bad = goodSpec(); bad.scenes.push({ id: 'main', title: 'dup' });
assert.ok(T.validateSpec(bad).errors.some((e) => /場景 id 重複/.test(e))); ok();
assert.strictEqual(T.validateSpec(null).ok, false); ok();

// 2. 領域檔檢查與共用步驟展開
const dom = () => ({
  format: 'guitpl-domain/1', domain: 'text-editor', label: '文字編輯器', keywords: ['編輯器', '記事本', 'notepad'],
  steps: [
    { id: 'layout', ask: '版面？', options: [
      { id: 'menu-top', label: '上方選單', keywords: ['傳統'], default: true, fragment: { layout: { window: { title: 'E', width: 500 }, tree: [{ kind: 'column', children: [{ id: 'ed', kind: 'editor' }] }] } } },
      { id: 'side', label: '左側清單', keywords: ['側邊', '多檔'], fragment: { layout: { tree: [{ kind: 'row' }] } } }] },
    { id: 'palette', ask: '配色？', use: '_common:palette' },
    { id: 'shortcuts', ask: '快捷鍵？', optional: true, options: [
      { id: 'editor', label: '編輯器慣用', default: true, fragment: { shortcuts: [{ keys: 'Ctrl+S', do: 'save_file' }] } }] }
  ]
});
const common = { palette: { ask: 'x', options: [
  { id: 'dark', label: '深色', keywords: ['深色', 'dark'], default: true, fragment: { palette: PAL } },
  { id: 'light', label: '淺色', keywords: ['淺色', 'light'], fragment: { palette: Object.assign({}, PAL, { bg: '#ffffff', fg: '#000000' }) } }] } };
assert.strictEqual(T.validateDomain(T.expandUses(dom(), common)).ok, true); ok();
assert.strictEqual(T.validateDomain(dom()).ok, true); ok(); // 沒展開前，引用步驟（use）先略過，展開後才檢查選項
let noOpt = dom(); noOpt.steps[2].options = [];
assert.ok(T.validateDomain(noOpt).errors.some((e) => /需要選項/.test(e))); ok();
let d2 = T.expandUses(dom(), common); d2.steps[0].options[1].default = true;
assert.ok(T.validateDomain(d2).errors.some((e) => /剛好一個 default/.test(e))); ok();
assert.throws(() => T.expandUses({ steps: [{ id: 'palette', use: '_common:nope' }] }, common)); ok();

// 3. 領域檢索：關鍵字、領先門檻、使用者範本加權
const editor = T.expandUses(dom(), common);
const game = { domain: 'game', label: '遊戲設計', keywords: ['遊戲', '打磚塊'], steps: [] };
let r = T.findDomain('幫我做一個記事本', [editor, game]);
assert.strictEqual(r.domain, 'text-editor'); assert.ok(r.decided); ok();
r = T.findDomain('今天天氣', [editor, game]);
assert.strictEqual(r.domain, null); assert.strictEqual(r.decided, false); ok();
r = T.findDomain('記事本遊戲', [editor, game]);
assert.strictEqual(r.decided, false); ok(); // 平手不算決定
const editorU = Object.assign({}, editor, { userSpecs: [{ title: '我的筆記本', keywords: ['日記'] }] });
r = T.findDomain('記事本遊戲 日記', [editorU, game]);
assert.strictEqual(r.domain, 'text-editor'); assert.ok(r.decided); ok();

// 4. 步驟內選項：命中關鍵字、否則預設
assert.strictEqual(T.pickOption('要多檔的', editor.steps[0]).option.id, 'side'); ok();
let p = T.pickOption('隨便', editor.steps[0]);
assert.ok(p.byDefault && p.option.id === 'menu-top'); ok();

// 5. 逐步詢問：需求已含關鍵字的步驟不再問；其餘依序問；你決定走預設
let st = T.newState(editor, '做一個多檔記事本，淺色');
assert.deepStrictEqual(st.auto.sort(), ['layout', 'palette']); ok();
assert.strictEqual(st.picks.layout, 'side'); assert.strictEqual(st.picks.palette, 'light'); ok();
assert.strictEqual(T.nextStep(st).id, 'shortcuts'); ok();
let st2 = T.answer(st, 'shortcuts', 'editor');
assert.strictEqual(T.nextStep(st2), null); assert.strictEqual(st.asked.shortcuts, undefined, '不改原物件'); ok();
assert.throws(() => T.answer(st, 'shortcuts', 'zzz')); ok();
const st3 = T.fillDefaults(T.newState(editor, ''));
assert.strictEqual(T.nextStep(st3), null);
assert.deepStrictEqual(st3.picks, { layout: 'menu-top', palette: 'dark', shortcuts: 'editor' }); ok();
const st4 = T.answer(T.fillDefaults(T.newState(editor, '')), 'shortcuts', null);
assert.strictEqual(st4.picks.shortcuts, undefined); ok(); // 可選步驟可以不選

// 6. 合併：樹與行為附加、視窗欄位後蓋前、配色進規格
const merged = T.mergeFragments(T.picksOf(st3));
assert.strictEqual(merged.layout.window.title, 'E');
assert.strictEqual(merged.layout.tree.length, 1);
assert.deepStrictEqual(merged.palette, PAL);
assert.deepStrictEqual(merged.shortcuts, [{ keys: 'Ctrl+S', do: 'save_file' }]); ok();
const two = T.mergeFragments([{ step: 'layout', option: editor.steps[0].options[0] }, { step: 'layout', option: editor.steps[0].options[1] }]);
assert.strictEqual(two.layout.tree.length, 2, '樹附加'); ok();
assert.strictEqual(editor.steps[0].options[0].fragment.layout.tree.length, 1, '合併不改範本'); ok();

// 7. 離線字母選擇題
const menu = T.choiceMenu(editor.steps[0]);
assert.deepStrictEqual(menu.letters, { A: 'menu-top', B: 'side' });
assert.ok(/A\. 上方選單（預設）/.test(menu.text) && /B\. 左側清單/.test(menu.text)); ok();
assert.strictEqual(T.letterToOption(editor.steps[0], 'b'), 'side');
assert.strictEqual(T.letterToOption(editor.steps[0], ' B。'), 'side');
assert.strictEqual(T.letterToOption(editor.steps[0], 'C'), null);
assert.strictEqual(T.letterToOption(editor.steps[0], '我選第二個'), null);
assert.strictEqual(T.letterToOption(editor.steps[0], ''), null); ok();

console.log('guitpl_core.test.js: ' + n + ' groups OK');
