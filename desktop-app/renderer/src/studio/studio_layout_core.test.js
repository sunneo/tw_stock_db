'use strict';
const L = require('./studio_layout_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const d = L.defaults(); const N = L.IDS.length;
check('預設左 資產／LoRA／匯入／資料集／評量，右 訓練／老師／紀錄', d.panes.left.join() === 'assets,lora,ingest,datasets,eval' && d.panes.right.join() === 'train,teacher,log');
// normalize 對壞輸入
check('null 輸入回預設', JSON.stringify(L.normalize(null)) === JSON.stringify(d));
const n1 = L.normalize({ panes: { left: ['train', 'train', 'zzz'], right: [] }, closed: ['log', 'assets'], split: 5, max: 'right' });
check('未知與重複丟掉', n1.panes.left.join().startsWith('train') && n1.panes.left.indexOf('zzz') < 0 && n1.panes.left.filter((x) => x === 'train').length === 1, n1);
check('遺失的分頁補回、關閉的保留', L.total(n1) + n1.closed.length === N && n1.closed.indexOf('log') >= 0, n1);
check('split 夾在上限', n1.split === L.SPLIT_MAX);
check('兩區至少各一個', n1.panes.left.length >= 1 && n1.panes.right.length >= 1, n1);
check('max 指向空區時清掉', L.normalize({ panes: { left: L.IDS.slice(), right: [] }, max: 'right' }).max !== 'right' || L.normalize({ panes: { left: L.IDS.slice(), right: [] }, max: 'right' }).panes.right.length > 0);
// 搬移
let r = L.moveTab(d, 'train', 'left', 0); check('右→左搬到最前', r.ok && r.layout.panes.left[0] === 'train' && r.layout.panes.right.indexOf('train') < 0 && r.layout.active.left === 'train', r);
check('搬移不改原物件', d.panes.left.length === 5);
const one = { panes: { left: ['assets'], right: ['train', 'log'] }, active: { left: 'assets', right: 'train' }, closed: ['datasets', 'eval', 'teacher'], split: 0.45, max: null };
check('來源只剩一個時拒絕搬走', !L.moveTab(one, 'assets', 'right').ok);
check('同側重排允許', L.moveTab(one, 'log', 'right', 0).layout.panes.right[0] === 'log');
check('搬到不存在的側拒絕', !L.moveTab(d, 'train', 'middle').ok);
check('搬已關閉的分頁拒絕', !L.moveTab(one, 'eval', 'left').ok);
// 關閉／重開
r = L.closeTab(d, 'datasets'); check('關閉分頁進 closed', r.ok && r.layout.closed.join() === 'datasets' && r.layout.panes.left.join() === 'assets,lora,ingest,eval', r);
check('關閉最後一個被拒', !L.closeTab(one, 'assets').ok);
const c2 = L.closeTab(d, 'assets').layout; check('關閉使用中分頁後換成鄰近', c2.active.left === 'lora', c2.active);
r = L.openTab(c2, 'assets'); check('用「+」重開回原側', r.ok && r.layout.panes.left.indexOf('assets') >= 0 && r.layout.closed.length === 0 && r.layout.active.left === 'assets', r);
check('重開到指定側', L.openTab(c2, 'assets', 'right').layout.panes.right.indexOf('assets') >= 0);
check('開不存在的分頁拒絕', !L.openTab(d, 'nope').ok);
// 分隔線
check('拖曳夾上限', L.setSplit(d, 0.99).split === 0.8 && L.setSplit(d, 0).split === 0.2 && L.setSplit(d, 'x').split === 0.45);
check('雙擊還原', L.resetSplit(L.setSplit(d, 0.7)).split === L.DEFAULT.split);
check('指標換算比例', L.ratioFromPointer(300, 0, 1000) === 0.3 && L.ratioFromPointer(10, 0, 1000) === 0.2 && L.ratioFromPointer(1, 0, 0) === 0.45);
// 最大化
const m = L.toggleMax(d, 'left'); check('最大化左區，再按還原', m.max === 'left' && L.toggleMax(m, 'left').max === null && L.toggleMax(m, 'right').max === 'right');
check('最大化保留分頁狀態', JSON.stringify(m.panes) === JSON.stringify(d.panes));
// 堆疊
check('窄於 640 堆疊', L.orientation(639) === 'stack' && L.orientation(640) === 'side');
// 往返
check('normalize 對自己的輸出不變', JSON.stringify(L.normalize(m)) === JSON.stringify(m));
// 隨機操作後不變量
let s = d; const ids = L.IDS;
for (let i = 0; i < 300; i++) { const id = ids[(i * 7) % N], side = i % 2 ? 'left' : 'right', k = i % 4; const t = k === 0 ? L.moveTab(s, id, side, i % 3) : k === 1 ? L.closeTab(s, id) : k === 2 ? L.openTab(s, id, side) : { ok: true, layout: L.toggleMax(s, side) }; if (t.ok) s = t.layout; }
check('隨機操作後兩區非空且分頁不重複不遺失', s.panes.left.length >= 1 && s.panes.right.length >= 1 && L.total(s) + s.closed.length === N && new Set(s.panes.left.concat(s.panes.right, s.closed)).size === N, s);
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
