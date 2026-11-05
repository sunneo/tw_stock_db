// 合併原生與 WASM 結果，輸出量測表（Markdown），並算輸出張量最大絕對誤差。
// 用法：node compare.js <工作資料夾> [輸出 .md]
const fs = require('fs'), path = require('path');
const WORK = process.argv[2]; if (!WORK) { console.error('用法：node compare.js <工作資料夾> [輸出 .md]'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench-config.json'), 'utf8'));
const read = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const nat = read(path.join(WORK, 'native.jsonl')), was = read(path.join(WORK, 'wasm.jsonl'));
let base = 0; try { base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test-reports', 'native-all-models', 'wasm-mem-baseline.json'), 'utf8')).peak_tree_mb; } catch (_) { /* 沒有基線就不扣 */ }
let mem = {}; try { mem = JSON.parse(fs.readFileSync(path.join(WORK, 'wasm_mem.json'), 'utf8')); } catch (_) { /* 沒有就空 */ }
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function maxErr(model, q, names) {
  let worst = 0;
  for (const n of names) {
    const f = model + '_q' + q + '_' + n.replace(/[^\w.-]/g, '_') + '.bin', a = path.join(WORK, 'out', 'native', f), b = path.join(WORK, 'out', 'wasm', f);
    if (!fs.existsSync(a) || !fs.existsSync(b)) return null;
    const x = fs.readFileSync(a), y = fs.readFileSync(b); if (x.length !== y.length) return Infinity;
    const fa = new Float32Array(x.buffer, x.byteOffset, x.length / 4), fb = new Float32Array(y.buffer, y.byteOffset, y.length / 4);
    for (let i = 0; i < fa.length; i++) { const d = Math.abs(fa[i] - fb[i]); if (d > worst) worst = d; else if (d !== d) return NaN; }
  }
  return worst;
}
const rows = [['模型', '原生 CPU 中位數（毫秒）', 'WASM 中位數（毫秒）', '原生／WASM 速度比', '最大絕對誤差', '原生載入（毫秒）', 'WASM 載入（毫秒）', '原生子程序峰值（MB）', 'WASM 整個 Electron 峰值（MB，基線 ' + base + '）', '狀態']];
const detail = [];
for (const m of cfg.models) {
  const nq = nat.filter((r) => r.model === m.id && r.q !== undefined && r.ok), wq = was.filter((r) => r.model === m.id && r.q !== undefined && r.ok);
  const nl = nat.find((r) => r.model === m.id && r.event === 'loaded'), wl = was.find((r) => r.model === m.id && r.event === 'loaded');
  const skip = (nat.find((r) => r.model === m.id && r.skipped) || was.find((r) => r.model === m.id && r.skipped));
  const err = nat.concat(was).find((r) => r.model === m.id && r.ok === false);
  if (!nq.length && !wq.length) { rows.push([m.label, '—', '—', '—', '—', '—', '—', '—', '—', skip ? (skip.skipped === 'needs_download' ? '本機沒有模型檔，未量（需先問使用者才可下載）' : skip.skipped) : (err ? '失敗：' + err.error : '未量')]); continue; }
  const nm = nq.length ? med(nq.map((r) => r.ms)) : null, wm = wq.length ? med(wq.map((r) => r.ms)) : null;
  const errs = nq.map((r) => maxErr(m.id, r.q, r.out_names)).filter((e) => e !== null); const worst = errs.length ? Math.max(...errs) : null;
  const same = nq.length && wq.length && nq.every((r) => { const w = wq.find((x) => x.q === r.q); return w && w.out_hash === r.out_hash; });
  rows.push([m.label, nm ?? '—', wm ?? '—', nm && wm ? (wm / nm).toFixed(2) + '×（>1 表示原生較快）' : '—', worst === null ? '—' : worst.toExponential(2) + (same ? '（位元相同）' : ''), nl ? nl.load_ms : '—', wl ? wl.load_ms : '—', nq.length ? Math.max(...nq.map((r) => r.maxrss_mb)) : '—', (was.find((r) => r.model === m.id && r.event === 'mem') || {}).peak_tree_mb || '—', nq.length && wq.length ? '實測' : '部分實測']);
  for (const r of nq) { const w = wq.find((x) => x.q === r.q); detail.push([m.id, 'q' + r.q, r.ms, '[' + r.all_ms.join(',') + ']', w ? w.ms : '—', w ? '[' + w.all_ms.join(',') + ']' : '—']); }
}
const tab = (t) => t.map((r, i) => '| ' + r.join(' | ') + ' |' + (i === 0 ? '\n|' + r.map(() => '---').join('|') + '|' : '')).join('\n');
const md = '## 量測表\n\n' + tab(rows) + '\n\n### 逐題（毫秒；中括號是每次計時）\n\n' + tab([['模型', '題', '原生中位數', '原生各次', 'WASM 中位數', 'WASM 各次']].concat(detail)) +
  '\n\nWASM 行程樹峰值工作集（含渲染、主程序、背景執行緒，整個 Electron）：' + (mem.peak_tree_mb || '—') + ' MB；主程序峰值：' + (mem.peak_main_mb || '—') + ' MB。\n';
if (process.argv[3]) fs.writeFileSync(process.argv[3], md); console.log(md);
