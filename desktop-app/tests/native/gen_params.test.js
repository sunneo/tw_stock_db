// 原生生成參數（重複懲罰、不重複 n-gram、溫度、top-p、可重現取樣）的單元測試。
// 期望值以手算得到（註解內有算式），不是從程式輸出複製。用法：node native-runner/gen_params.test.js
'use strict';
const G = require('../../nr-gen-params.js');

let ok = 0; const bad = [];
const check = (name, c, x) => { if (c) ok++; else { bad.push(name); console.log('FAIL', name, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

// 1. 重複懲罰（手算）：logits [2, -1, 0.5, 3]，已出現過的 token 是 0 與 1，penalty = 2。
//    token 0：2 > 0 → 2 / 2 = 1；token 1：-1 < 0 → -1 × 2 = -2；token 2、3 未出現，不變。
const a = [2, -1, 0.5, 3];
G.applyRepetitionPenalty(a, [0, 1], 2);
check('重複懲罰：正數除以 2、負數乘以 2（手算 [1, -2, 0.5, 3]）', a[0] === 1 && a[1] === -2 && a[2] === 0.5 && a[3] === 3, a);

// 2. 重複懲罰會把「已出現的正 logit」壓低，可能改變 argmax（手算）：
//    logits [2, 1.9, 0, 0]，prompt = [0]，penalty = 1.08。token 0：2 / 1.08 = 1.85185…，仍 < 1.9，所以 argmax 是 token 1。
const g1 = { do_sample: false, repetition_penalty: 1.08 };
const b = [2, 1.9, 0, 0];
check('貪婪＋重複懲罰：2/1.08≈1.852 < 1.9，選 token 1（手算）', G.pickToken(b, [0], [], g1) === 1, b);

// 3. 重複懲罰以「輸入＋已生成」為範圍：生成過 token 2 後，它的 logit 也被懲罰（手算）
//    logits [0, 0, 5, 4.9]，prompt [0]，生成 [2]，penalty 1.08 → token 2：5/1.08≈4.6296 < 4.9 → 選 token 3。
const b2 = [0, 0, 5, 4.9];
check('重複懲罰包含已生成的 token（手算：5/1.08≈4.63 < 4.9，選 3）', G.pickToken(b2, [0], [2], g1) === 3, b2);

// 4. penalty = 1 時完全不改 logits
const c = [1, -2, 3];
G.applyRepetitionPenalty(c, [0, 1, 2], 1);
check('penalty = 1 不改 logits', c[0] === 1 && c[1] === -2 && c[2] === 3);

// 5. 不重複 n-gram（n = 2）：序列 [5, 6, 7, 5]，最後一個 token 是 5，之前出現過 5→6，所以 6 被禁止。
const d = [0, 0, 0, 0, 0, 0, 9, 0];
G.applyNoRepeatNGram(d, [5, 6, 7, 5], 2);
check('不重複 2-gram：5 之後出現過 6，禁止 6', d[6] === -Infinity && d[0] === 0, d);
const g2 = { do_sample: false, no_repeat_ngram_size: 2 };
const e = [0, 0, 0, 0, 0, 0, 9, 0];
check('不重複 2-gram 下貪婪不選 6（選到 0）', G.pickToken(e, [5, 6, 7], [5], g2) === 0, e);

// 6. 溫度：logits [1, 2] ÷ 0.5 = [2, 4]
const t = [1, 2];
G.applyTemperature(t, 0.5);
check('溫度 0.5：[1,2] → [2,4]', t[0] === 2 && t[1] === 4, t);

// 7. top-p（手算）：機率約 [0.5, 0.3, 0.2]（logits = ln 機率），top_p = 0.7。
//    升序：0.2、0.3、0.5；累積 0.2、0.5、1.0；移除累積 ≤ 1 − 0.7 = 0.3 的 → 只移除 0.2（token 2），保留 0.3 與 0.5。
const p = [Math.log(0.5), Math.log(0.3), Math.log(0.2)];
G.applyTopP(p, 0.7);
check('top-p 0.7：移除機率 0.2 的 token 2，保留 0 與 1', p[2] === -Infinity && p[0] > -Infinity && p[1] > -Infinity, p);

// 8. top-p 至少保留一個 token
const q = [0, 0, 0];
G.applyTopP(q, 0.000001);
check('top-p 極小仍至少保留一個 token', q.filter((x) => x > -Infinity).length >= 1, q);

// 9. 可重現取樣：同一個 seed 得到同一串亂數；pickToken 結果相同
const r1 = G.makeRng(20261104), r2 = G.makeRng(20261104);
const seqA = [r1(), r1(), r1()], seqB = [r2(), r2(), r2()];
check('同一 seed 的亂數序列相同', seqA.every((v, i) => v === seqB[i]), [seqA, seqB]);
const gs = { do_sample: true, temperature: 0.4, top_p: 0.9, repetition_penalty: 1.08 };
const outA = [], outB = [];
const ra = G.makeRng(7), rb = G.makeRng(7);
for (let i = 0; i < 50; i++) { outA.push(G.pickToken([1, 2, 3, 0.5], [0], outA, gs, ra)); outB.push(G.pickToken([1, 2, 3, 0.5], [0], outB, gs, rb)); }
check('取樣：同一 seed 的 50 次結果完全相同', outA.join(',') === outB.join(','));

// 10. 取樣的分布（大量抽樣）：兩個 token，機率 0.7 與 0.3（logits = ln），抽 20000 次，token 0 的比例應在 0.7 ± 0.02
const rr = G.makeRng(123); let c0 = 0; const N = 20000;
for (let i = 0; i < N; i++) { const l = [Math.log(0.7), Math.log(0.3)]; if (G.pickToken(l, [], [], { do_sample: true }, rr) === 0) c0++; }
check('取樣分布：token 0 的比例 ≈ 0.7', Math.abs(c0 / N - 0.7) < 0.02, c0 / N);

// 11. 錯誤：取樣沒有 rng 會丟錯；不支援的鍵會丟錯；超出範圍的參數會丟錯
let threw = false; try { G.pickToken([1, 2], [], [], { do_sample: true }, undefined); } catch (_) { threw = true; }
check('取樣未給 rng 丟錯（不用 Math.random）', threw);
threw = false; try { G.validateGen({ do_sample: false, typical_p: 0.5 }); } catch (e) { threw = /不支援/.test(e.message); }
check('不支援的生成參數丟錯（不靜默忽略）', threw);
threw = false; try { G.validateGen({ top_p: 1.5 }); } catch (_) { threw = true; }
check('top_p 超出範圍丟錯', threw);

// 12. 產品 textGenParams 的形狀（與 vlm_core.js 相同的鍵）可直接通過驗證
const productDeterministic = { do_sample: false, repetition_penalty: 1.08 };
const productSampling = { do_sample: true, temperature: 0.4, top_p: 0.9, repetition_penalty: 1.08 };
check('產品的貪婪 gen 通過驗證', G.validateGen(productDeterministic) === productDeterministic);
check('產品的取樣 gen 通過驗證', G.validateGen(productSampling) === productSampling);

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
