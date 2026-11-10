'use strict';
// 把 stack_route_native.js --slice 分批跑出的結果檔合併成一份總表，並跟先前結果（--baseline）逐題對照。
//   node scripts/eval/stack_route_merge.js --out 合併.json [--baseline 先前.json] 批1.json 批2.json ...
const fs = require('fs'); const a = process.argv.slice(2); const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a.splice(i, 2)[1] : null; };
const outFile = opt('out'), baseFile = opt('baseline'); const files = a;
if (!files.length) { console.log('用法：node scripts/eval/stack_route_merge.js [--out f.json] [--baseline 先前.json] 批1.json 批2.json ...'); process.exit(0); }
const parts = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).result); const m = {};
parts.forEach((p) => Object.keys(p).forEach((v) => { const x = p[v]; const t = m[v] = m[v] || { n: 0, correct: 0, failed: 0, calls: 0, fmtErrReplies: 0, sec: 0, rows: [] }; t.n += x.n; t.correct += x.correct; t.failed += x.failed; t.calls += x.calls; t.fmtErrReplies += x.fmtErrReplies || 0; t.sec += (x.avgSec || 0) * x.n; t.rows = t.rows.concat(x.rows); }));
const show = (v, t) => { const retry = t.rows.filter((r) => r.tries > 1).length; console.log(v + '：正確 ' + t.correct + '/' + t.n + '（' + (100 * t.correct / t.n).toFixed(1) + '%）；沒有有效回答（含走預設）' + t.failed + '；格式錯誤回覆 ' + t.fmtErrReplies + '；需重試 ' + retry + ' 題；每題平均呼叫 ' + (t.calls / t.n).toFixed(2) + '、' + (t.sec / t.n).toFixed(1) + ' 秒'); };
Object.keys(m).forEach((v) => show(v, m[v]));
let base = null; if (baseFile) { base = JSON.parse(fs.readFileSync(baseFile, 'utf8')).result; Object.keys(base).forEach((v) => { const rows = base[v].rows; const bad = rows.reduce((s, r) => s + (r.rejected ? r.rejected.length : 0) + (r.error && !(r.rejected && r.rejected.length) ? 1 : 0), 0); console.log('（先前）' + v + '：正確 ' + base[v].correct + '/' + base[v].n + '；格式錯誤回覆 ' + bad + '；需重試 ' + rows.filter((r) => r.tries > 1).length + ' 題；每題平均呼叫 ' + (base[v].calls / base[v].n).toFixed(2)); }); }
if (base) Object.keys(m).forEach((v) => Object.keys(base).forEach((bv) => { if (bv === v) return; const L = Math.min(m[v].rows.length, base[bv].rows.length); let b = 0, w = 0; for (let i = 0; i < L; i++) { const x = m[v].rows[i], y = base[bv].rows[i]; if (x.hit && !y.hit) b++; else if (!x.hit && y.hit) w++; } console.log('成對 ' + v + ' 對先前 ' + bv + '（前 ' + L + ' 題）：' + v + ' 較好 ' + b + '、較差 ' + w + '、持平 ' + (L - b - w)); }));
// 逐題類別
Object.keys(m).forEach((v) => { const q = {}; m[v].rows.forEach((r) => { const k = r.q; (q[k] = q[k] || { want: r.want, ok: 0, n: 0, got: [] }); q[k].n++; if (r.hit) q[k].ok++; else q[k].got.push(r.got); }); console.log('[' + v + ' 逐題]'); Object.keys(q).forEach((k) => console.log('  ' + k + '（應為 ' + q[k].want + '）：' + q[k].ok + '/' + q[k].n + (q[k].got.length ? ' 錯選 ' + JSON.stringify(q[k].got) : ''))); });
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ result: m }, null, 1));
