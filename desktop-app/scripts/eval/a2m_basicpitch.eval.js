// 音訊轉 MIDI 的真桌面版評測（Basic Pitch 基準 ＋ 非模型 Viterbi 路徑）。本檔只寫不跑，由使用者在真桌面版執行。
// 做法：
//   1. 在頁面內用 FaAudioRuntime（既有的 loadOrt／createSession）載入 E:/Temp/onnx-models/nmp.onnx（Basic Pitch 1.0 的 ONNX）。
//   2. 合成「已知主旋律＋伴奏（低音＋和弦）」的真值，過三種喇叭→麥克風條件（乾淨／中等殘響／強殘響），每條件 4 段，8 秒。
//   3. 同一份錄音跑兩條路：
//        (A) Basic Pitch：FaAudioRuntime.makeTranscriber（高低音分跑＋Basic Pitch 後處理）
//        (B) 非模型 Viterbi：FaMusicLibAudio.humNotes（諧波和能量＋連續性）
//   4. 指標（對真值）：音符 F1（onset 50 ms、音高 ±0.5 半音）、主旋律幀準確度（真值有音的 10 ms 幀，估計音高在 ±0.5 半音內的比例）、
//      碎音比例（< 0.12 秒）、音高跳動次數（相鄰音高差 ≥ 1 半音）／秒、每秒音符數。
//   輸出：E:/Temp/a2m_eval_out.json（同時寫進度到 E:/Temp/a2m_eval_progress.txt）。
// 驗收（之後由人判讀）：兩路的 F1 與幀準確度都要寫進結果；不設通過門檻，數字照實回報。
const T_START = Date.now();
const out = { conditions: {}, model: { path: 'E:/Temp/onnx-models/nmp.onnx', loaded: false, error: null }, timing: {}, truncated: false };
let prog = ''; const NL = String.fromCharCode(10);
const plog = async (t) => { prog += '[' + Math.round((Date.now() - T_START) / 1000) + 's] ' + t + NL; try { await window.desktopAPI.rawfs.writeFile('E:/Temp/a2m_eval_progress.txt', { text: prog }); } catch (_) { /* 寫不成功不影響評測 */ } };
const DEADLINE_MS = 470 * 1000, overTime = () => Date.now() - T_START > DEADLINE_MS;
const SR = 16000, DUR = 8, TRIALS = 4;
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
function makeMelody(r, dur) {
  const o = []; let t = 0.2, m = 66;
  while (t < dur - 0.6) { m = Math.max(57, Math.min(76, m + Math.round((r() - 0.5) * 6))); const d = 0.3 + r() * 0.3; o.push({ t, d: Math.min(d, dur - t - 0.05), n: m }); t += d; }
  return o;
}
function accomp(r, dur) {
  const bass = [], chords = [];
  for (let t = 0; t < dur; t += 0.5) bass.push({ t, d: 0.5, n: 36 + Math.floor(r() * 8) });
  for (let t = 0; t < dur; t += 0.6) { const root = 48 + Math.floor(r() * 8); chords.push({ t, d: 0.6, ns: [root, root + 4, root + 7] }); }
  return { bass, chords };
}
function render(mel, acc, dur) {
  const n = Math.floor(dur * SR), x = new Float32Array(n);
  const add = (t, d, f, amp, harm) => { const s0 = Math.floor(t * SR), ln = Math.floor(d * SR); for (let i = 0; i < ln && s0 + i < n; i++) { const env = Math.min(1, i / (0.015 * SR)) * Math.exp(-2.2 * i / ln), tt = i / SR; let v = 0; for (let h = 1; h <= harm; h++) v += Math.sin(2 * Math.PI * f * h * tt) / h; x[s0 + i] += amp * env * v; } };
  mel.forEach((q) => add(q.t, q.d, mtof(q.n), 0.35, 2));
  acc.bass.forEach((b) => add(b.t, b.d * 0.95, mtof(b.n), 0.55, 6));
  acc.chords.forEach((c) => c.ns.forEach((m) => add(c.t, c.d, mtof(m), 0.12, 2)));
  return x;
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
function mic(x, r, p) {
  const y = Float32Array.from(x); const a = 1 - Math.exp(-2 * Math.PI * p.lp / SR); let s1 = 0, s2 = 0;
  for (let i = 0; i < y.length; i++) { s1 += a * (y[i] - s1); s2 += a * (s1 - s2); y[i] = s2; }
  if (p.rt60 > 0) { const rev = new Float32Array(y.length); for (const d of [0.0297, 0.0371, 0.0411, 0.0437]) { const N = Math.round(d * SR), g = Math.pow(10, -3 * N / (p.rt60 * SR)), buf = new Float32Array(N); let idx = 0; for (let i = 0; i < y.length; i++) { const o = buf[idx]; buf[idx] = y[i] + g * o; rev[i] += o / 4; idx = (idx + 1) % N; } } for (let i = 0; i < y.length; i++) y[i] = 0.5 * y[i] + 0.5 * rev[i]; }
  let ps = 0; for (let i = 0; i < y.length; i++) ps += y[i] * y[i]; ps /= y.length;
  if (p.snrDb != null) { const sd = Math.sqrt(ps / Math.pow(10, p.snrDb / 10)); for (let i = 0; i < y.length; i++) y[i] += sd * gauss(r); }
  for (let i = 0; i < y.length; i++) y[i] = Math.max(-1, Math.min(1, y[i] * p.gain));
  return y;
}
function f1(est, truth) {
  const used = new Set(); let tp = 0;
  for (const e of est) { let best = -1, bd = 1e9; truth.forEach((t, i) => { if (used.has(i)) return; const dt = Math.abs(e.t - t.t); if (dt > 0.05 || Math.abs(e.n - t.n) > 0.5) return; if (dt < bd) { bd = dt; best = i; } }); if (best >= 0) { used.add(best); tp++; } }
  const p = est.length ? tp / est.length : 0, rc = truth.length ? tp / truth.length : 0;
  return p + rc > 0 ? +(2 * p * rc / (p + rc)).toFixed(3) : 0;
}
function frameAcc(est, truth, dur) {
  let tot = 0, ok = 0;
  for (let t = 0; t < dur; t += 0.01) { const tr = truth.find((x) => t >= x.t && t < x.t + x.d); if (!tr) continue; tot++; const es = est.find((x) => t >= x.t && t < x.t + x.d); if (es && Math.abs(es.n - tr.n) <= 0.5) ok++; }
  return tot ? +(ok / tot).toFixed(3) : 0;
}
function stats(est, dur) {
  let jumps = 0; for (let i = 1; i < est.length; i++) if (Math.abs(est[i].n - est[i - 1].n) >= 1) jumps++;
  return { notesPerSec: +(est.length / dur).toFixed(2), shortShare: est.length ? +(est.filter((x) => x.d < 0.12).length / est.length).toFixed(3) : 0, jumpsPerSec: +(jumps / dur).toFixed(2) };
}
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const CONDS = { clean: { gain: 0.9, lp: 9000, rt60: 0, snrDb: null }, room: { gain: 0.5, lp: 4500, rt60: 0.5, snrDb: 15 }, harsh: { gain: 0.3, lp: 3500, rt60: 0.9, snrDb: 8 } };
return (async () => {
  let transcriber = null, humFn = null;
  try {
    const bytes = b64ToBytes((await window.desktopAPI.rawfs.readFile(out.model.path, 'base64')).base64);
    const ort = await FaAudioRuntime.loadOrt();
    const s = await FaAudioRuntime.createSession(ort, bytes, ['wasm'], {});
    transcriber = FaAudioRuntime.makeTranscriber(ort, s.session);
    out.model.loaded = true; out.model.ep = s.ep; await plog('模型載入：' + s.ep);
  } catch (e) { out.model.error = String((e && e.message) || e); await plog('模型載入失敗：' + out.model.error); }
  humFn = (input) => FaMusicLibAudio.humNotes(input, { AudioToMidi: FaAudioToMidi, thr: 0.3, glideMax: 0.12 }).notes;
  const t0 = Date.now();
  for (const [cn, cond] of Object.entries(CONDS)) {
    const rows = { basicPitch: [], viterbi: [] };
    for (let k = 0; k < TRIALS; k++) {
      if (overTime()) { out.truncated = true; await plog('逾時，停在 ' + cn + ' #' + k); break; }
      const r = rng(777 + k * 13 + cn.length), mel = makeMelody(r, DUR), ac = accomp(r, DUR);
      const rec = mic(render(mel, ac, DUR), r, cond), input = { channels: [rec], sampleRate: SR };
      if (transcriber) {
        const bp = await transcriber(rec, SR);
        rows.basicPitch.push({ f1: f1(bp, mel), fa: frameAcc(bp, mel, DUR), ...stats(bp, DUR) });
      }
      const vit = humFn(input);
      rows.viterbi.push({ f1: f1(vit, mel), fa: frameAcc(vit, mel, DUR), ...stats(vit, DUR) });
      await plog(cn + ' #' + k + ' 完成');
    }
    const avg = (arr, key) => arr.length ? +(arr.reduce((s, x) => s + x[key], 0) / arr.length).toFixed(3) : null;
    out.conditions[cn] = {};
    for (const v of ['basicPitch', 'viterbi']) out.conditions[cn][v] = { trials: rows[v].length, f1: avg(rows[v], 'f1'), melFrameAcc: avg(rows[v], 'fa'), shortShare: avg(rows[v], 'shortShare'), jumpsPerSec: avg(rows[v], 'jumpsPerSec'), notesPerSec: avg(rows[v], 'notesPerSec') };
  }
  out.timing.totalSec = Math.round((Date.now() - t0) / 1000);
  try { await window.desktopAPI.rawfs.writeFile('E:/Temp/a2m_eval_out.json', { text: JSON.stringify(out, null, 1) }); } catch (_) { /* 寫不成功時結果仍回傳 */ }
  await plog('完成');
  return out;
})().catch(async (e) => { out.error = String((e && e.stack) || e); await plog('錯誤：' + out.error); return out; });
