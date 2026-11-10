'use strict';
// 路由量測的題組（stack_route.js 與 stack_route_native.js 共用）。自己出的小題組（不是 holdout），解讀時留意天花板效應。
// def＝給「附定義」變體用的一句說明（量測用；舊變體不看它。刻意不放跟題目重疊的例子，避免洩題）
const cands = [{ tool: 'calc', intent: '算數、單位換算', def: '做數學計算或單位換算' }, { tool: 'search', intent: '上網搜尋最新資訊', def: '查要上網才知道的最新資訊' }, { tool: 'code', intent: '寫程式、修程式', def: '撰寫程式或除錯' }, { tool: 'file', intent: '讀寫、整理檔案', def: '讀取、搬移、分類電腦裡的檔案' }, { tool: 'timer', intent: '設定提醒、計時', def: '設定時間到了提醒或倒數計時' }];
const base = [['幫我算 123 乘 45', 'calc'], ['5 英里是幾公里', 'calc'], ['今天台積電股價多少', 'search'], ['最近有什麼新的顯示卡', 'search'], ['寫一個把清單排序的函式', 'code'], ['這段程式跑出 IndexError 幫我修', 'code'], ['把下載資料夾的圖片依日期分類', 'file'], ['讀一下 notes.txt 的內容', 'file'], ['十分鐘後提醒我關火', 'timer'], ['你覺得人生的意義是什麼', null]];
function buildCases(reps) { const cases = []; for (let i = 0; i < reps; i++) base.forEach(([q, w]) => cases.push({ question: q, cands, want: w })); return cases; }
module.exports = { cands, base, buildCases };
