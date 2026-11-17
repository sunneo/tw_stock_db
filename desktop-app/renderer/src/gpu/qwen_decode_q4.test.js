// qwen_decode_q4.js：fp16 解碼表（不需要模型檔）。真檔的載入與對 ORT 逐詞元比對見 DESIGN §7.31（scripts/eval/cudaweb_qwen_gpu_browser.js，QWEN_FMT=q4）。
const Q = require('./qwen_decode_q4.js'); let pass = 0, fail = 0; const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL ' + n); } };
const h = Q.h2f;
ok(h[0x3C00] === 1 && h[0xC000] === -2 && h[0x7BFF] === 65504 && h[0] === 0 && h[0x3555] > 0.333 && h[0x3555] < 0.334, 'fp16 常見值（1、-2、65504、0、1/3）');
ok(h[0x0001] === Math.pow(2, -24) && h[0x0400] === Math.pow(2, -14), 'fp16 次正規數與最小正規數');
ok(h[0x7C00] === Infinity && h[0xFC00] === -Infinity && Number.isNaN(h[0x7E00]), 'fp16 無限大與 NaN');
let bad = 0; for (let x = 0; x < 65536; x++) { const e = (x >> 10) & 31; if (e !== 31 && !Number.isFinite(h[x])) bad++; } ok(bad === 0, 'fp16 其餘全是有限值');
let err = ''; try { Q.loadWeights(new Uint8Array(8)); } catch (e) { err = e.message; } ok(err.length > 0, '不是 ONNX 的位元組會丟錯');
console.log(pass + ' 通過 ' + fail + ' 失敗'); process.exit(fail ? 1 : 0);
