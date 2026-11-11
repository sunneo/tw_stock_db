'use strict';
// 純 JS LoRA 參考實作：手寫反向對有限差分（fp64）、fp32 捨入模擬對 fp64、20 步訓練 loss 下降、每步時間。
const R = require('./lora_ref_train.js');
let fail = 0; const ok = (c, n, extra) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };

const cfg = { V: 32, d: 64, L: 2, H: 4, F: 128, r: 8, alpha: 16 };
const m = R.makeModel(cfg, 7); const rng = R.makeRng(11);
const toks = Array.from({ length: 17 }, () => Math.floor(rng() * cfg.V));

const { loss, grads } = R.lossAndGrads(m, toks);
ok(isFinite(loss) && loss > 0, '初始 loss 有限', 'loss=' + loss.toFixed(4) + '（隨機猜 ln32=' + Math.log(32).toFixed(4) + '）');

// 有限差分：每個張量抽樣
let worst = 0, n = 0; const eps = 1e-5;
for (let l = 0; l < cfg.L; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) {
    const p = m.lora[l][k][w];
    for (let s = 0; s < 6; s++) {
        const i = Math.floor(rng() * p.length), o = p[i];
        p[i] = o + eps; const lp = R.lossAndGrads(m, toks, { noGrad: true }).loss;
        p[i] = o - eps; const lm = R.lossAndGrads(m, toks, { noGrad: true }).loss; p[i] = o;
        const num = (lp - lm) / (2 * eps), g = grads[l][k][w][i];
        const rel = Math.abs(g - num) / Math.max(Math.abs(g), Math.abs(num), 1e-7); if (!(rel <= worst)) worst = rel; n++;
    }
}
ok(worst < 1e-5, '手寫反向對有限差分（' + n + ' 個抽樣參數，涵蓋 q/k/v/o 的 A/B、2 層）', '最大相對誤差=' + worst.toExponential(2));

// fp32 捨入模擬 vs fp64：整體梯度的相對 L2 誤差
const g32 = R.lossAndGrads(m, toks, { f32: true });
let num2 = 0, den = 0; for (let l = 0; l < cfg.L; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) { const a = grads[l][k][w], b = g32.grads[l][k][w]; for (let i = 0; i < a.length; i++) { num2 += (a[i] - b[i]) ** 2; den += a[i] ** 2; } }
const rel32 = Math.sqrt(num2 / den);
ok(rel32 < 1e-4, 'fp32 捨入模擬對 fp64 的梯度相對 L2 誤差', rel32.toExponential(2) + '；loss 差=' + Math.abs(g32.loss - loss).toExponential(2));

// 零 B：LoRA 輸出為 0 → 與無 LoRA 基底前向相同，且 A 梯度為 0
const m0 = R.makeModel(cfg, 7); for (const lo of m0.lora) for (const k in lo) lo[k].B.fill(0);
const r0 = R.lossAndGrads(m0, toks); let aMax = 0; for (const G of r0.grads) for (const k in G) for (const v of G[k].A) aMax = Math.max(aMax, Math.abs(v));
ok(aMax === 0, 'B=0 時 A 的梯度為 0（LoRA 標準初始化性質）');

// 訓練：固定一條序列，30 步 Adam，loss 必須明顯下降；量每步時間
const mt = R.makeModel(cfg, 7); for (const lo of mt.lora) for (const k in lo) lo[k].B.fill(0);
const st = R.adamInit(mt); const losses = []; const t0 = Date.now();
for (let i = 0; i < 30; i++) { const r = R.lossAndGrads(mt, toks); losses.push(r.loss); R.adamStep(mt, r.grads, st, 0.02); }
const ms = (Date.now() - t0) / 30;
ok(losses[29] < losses[0] * 0.6, '30 步 Adam 後 loss 下降 40% 以上', losses[0].toFixed(3) + ' → ' + losses[29].toFixed(3) + '；每步 ' + ms.toFixed(1) + ' ms（T=16，純 JS 單執行緒 fp64）');

// 0.6B 估算（算術）
const e = R.estimate06B(512, 16);
ok(e.loraParams > 3e6 && e.loraParams < 3e7, '0.6B LoRA 參數量落在預期範圍', (e.loraParams / 1e6).toFixed(1) + 'M；基底 ' + ((e.body + e.emb) / 1e6).toFixed(0) + 'M；訓練 FLOP/token=' + (e.trainFlopsPerTok / 1e9).toFixed(2) + 'G（含檢查點 ' + (e.ckptFlopsPerTok / 1e9).toFixed(2) + 'G）；T=512：權重 f16 ' + e.weightsF16MB.toFixed(0) + 'MB／q8 ' + e.weightsQ8MB.toFixed(0) + 'MB、激活（無檢查點）' + e.actNoCkptMB.toFixed(0) + 'MB／（檢查點）' + e.actCkptMB.toFixed(0) + 'MB、logits ' + e.logitsF32MB.toFixed(0) + 'MB');
console.log(fail ? fail + ' 項失敗' : '全部通過'); process.exit(fail ? 1 : 0);
