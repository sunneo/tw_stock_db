// 聲紋門檻量測的驅動程式（node）：列出工作階段暫存的測試音檔、交給真 Electron 評估算嵌入，再算同人／不同人分數分布。
// 用法：node scripts/voice-tests/voiceprint_measure.js [--cmn=0|1]
// 樣本來源（如實標明）：
//   同人（正樣本）：D:\Downloads\videos\型態圖形班\converted\型態圖形班{1,2,3,6}.mp3 的 6 秒片段（每檔 4 個位置），假設同一位講者。
//   不同人（負樣本）：D:\Downloads\videos\巧虎\2023年09月\*.mp4 的 6 秒片段（每檔 1 個），內容多為角色配音，不保證單一講者。
// 限制：樣本少（正 16、負 16），只能看分布是否分開，不能當作統計上可靠的門檻；真正上線前還要更多人與更多錄音環境。
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..', '..');
const SP = 'C:/Users/sunneo/AppData/Local/Temp/claude/1845096e089295dd/297b791e-2c3f-4f8b-b5fd-9058de6fe069/scratchpad/';
const clipsDir = SP + 'clips/';
const cmnArg = (process.argv.find((a) => a.startsWith('--cmn=')) || '--cmn=1').split('=')[1];
const cmn = cmnArg !== '0';

const names = fs.readdirSync(clipsDir).filter((f) => /^[TK]\d+_\d+\.wav$/.test(f)).sort();
const isSame = (n) => n[0] === 'T';
const evalSrc = fs.readFileSync(path.join(root, 'scripts', 'eval', 'ecapa_measure.eval.js'), 'utf8');
const prefix = 'window.__faMeasureClips = ' + JSON.stringify(names) + '; window.__faMeasureCmn = ' + (cmn ? 'true' : 'false') + ';\n';
const tmp = path.join(SP, 'ecapa_measure_run.js');
fs.writeFileSync(tmp, prefix + evalSrc);

const r = cp.spawnSync(process.execPath, [path.join(root, 'scripts', 'eval', 'run_eval.js'), tmp, '17943'], { encoding: 'utf8', timeout: 175000, maxBuffer: 1 << 27 });
const out = String(r.stdout || '') + String(r.stderr || '');
const line = out.split('\n').find((l) => /\[eval-file\] result: /.test(l));
if (!line) { console.error('沒有取得量測結果。輸出前段：\n' + out.slice(0, 1500)); process.exit(1); }
const res = JSON.parse(line.slice(line.indexOf('result: ') + 8));
if (!res.pass) { console.error('量測失敗：' + JSON.stringify(res.checks).slice(0, 800)); process.exit(1); }

// 去掉能量過低（幾乎無聲）的片段
const usable = names.filter((n) => res.emb[n] && res.emb[n].rms >= 0.01);
const dropped = names.filter((n) => !usable.includes(n));
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const same = [], diff = [];
for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
  const a = usable[i], b = usable[j];
  const s = dot(res.emb[a].v, res.emb[b].v);
  if (isSame(a) && isSame(b)) same.push({ a, b, s });
  else if (isSame(a) !== isSame(b)) diff.push({ a, b, s });
}
const stat = (xs) => { const v = xs.map((o) => o.s).sort((p, q) => p - q); const mean = v.reduce((p, q) => p + q, 0) / v.length; return { n: v.length, min: +v[0].toFixed(4), p10: +v[Math.floor(v.length * 0.1)].toFixed(4), median: +v[Math.floor(v.length / 2)].toFixed(4), mean: +mean.toFixed(4), max: +v[v.length - 1].toFixed(4) }; };
// 門檻掃描：找讓 (同人接受率 − 不同人接受率) 最大的門檻
let best = null;
for (let t = -0.2; t <= 1.0001; t += 0.005) {
  const tpr = same.filter((o) => o.s >= t).length / same.length;
  const fpr = diff.filter((o) => o.s >= t).length / diff.length;
  const j = tpr - fpr;
  if (!best || j > best.j) best = { t: +t.toFixed(3), tpr: +tpr.toFixed(3), fpr: +fpr.toFixed(3), j: +j.toFixed(3) };
}
const summary = { cmn: cmn, clipsUsed: usable.length, droppedSilent: dropped, samePairs: stat(same), diffPairs: stat(diff), bestThreshold: best };
const outFile = SP + 'ecapa_measure_cmn' + (cmn ? '1' : '0') + '.json';
fs.writeFileSync(outFile, JSON.stringify({ summary, emb: res.emb }, null, 0));
console.log(JSON.stringify(summary, null, 2));
console.log('結果檔：' + outFile);
