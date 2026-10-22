// node scripts/imagegen-tests/local_sd.test.js -- 本機小模型生圖：模型清單、選版本、取樣的數學、亂數、張量轉圖片、錯誤說明
const S = require('../../renderer/src/imagegen/local_sd.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

// ---- 模型清單：版本是釘住的、大小可核對
check('two models: a GPU build and a CPU build', S.MODELS.length === 2 && S.byId('sdxs-512-webgpu').device === 'webgpu' && S.byId('sdxs-512-cpu-int8').device === 'cpu');
check('every model pins a 40-char revision and has the three files', S.MODELS.every((m) => /^[0-9a-f]{40}$/.test(m.rev) && m.files.map((f) => f.role).join() === 'text,unet,vae' && m.files.every((f) => f.bytes > 1e6)));
check('urls are pinned to the revision', S.urlOf(S.byId('sdxs-512-cpu-int8'), 'unet.onnx') === 'https://huggingface.co/lequangky/tipsy-sdxs-512-int8/resolve/41203dc02882252d74bb683dedc9bfde08641b55/unet.onnx');
check('sizes: GPU about 880 MB, CPU about 1.1 GB', Math.abs(S.totalBytes(S.byId('sdxs-512-webgpu')) - 880e6) < 5e6 && Math.abs(S.totalBytes(S.byId('sdxs-512-cpu-int8')) - 1116e6) < 5e6, [S.totalBytes(S.MODELS[0]), S.totalBytes(S.MODELS[1])]);
check('fmtBytes', S.fmtBytes(246275486) === '246 MB' && S.fmtBytes(1116112919) === '1.12 GB');

// ---- 選版本
check('auto: WebGPU with f16 -> GPU build', S.pickModel({ hasGpu: true, f16: true }).model.id === 'sdxs-512-webgpu');
check('auto: WebGPU without f16 -> CPU build, and says why', (() => { const r = S.pickModel({ hasGpu: true, f16: false }); return r.model.id === 'sdxs-512-cpu-int8' && r.ep === 'wasm' && /f16/.test(r.notes.join()); })());
check('auto: no WebGPU -> CPU build', S.pickModel({ hasGpu: false }).model.id === 'sdxs-512-cpu-int8');
check('forced webgpu without a GPU is refused in plain words', (() => { const r = S.pickModel({ hasGpu: false }, 'webgpu'); return !r.ok && /沒有 WebGPU/.test(r.reason); })());
check('forced webgpu on a GPU without f16 warns but allows', (() => { const r = S.pickModel({ hasGpu: true, f16: false }, 'webgpu'); return r.ok && r.model.id === 'sdxs-512-webgpu' && /可能載入失敗/.test(r.notes.join()); })());
check('forced cpu always works', S.pickModel({ hasGpu: true, f16: true }, 'cpu').model.id === 'sdxs-512-cpu-int8');
check('the CPU build warns it is slow and gives the download size', /比較慢/.test(S.pickModel({}, 'cpu').notes.join()) && /GB/.test(S.pickModel({}, 'cpu').notes.join()));

// ---- 請求整理
check('plan: prompt is required', !S.plan({}).ok && !S.plan({ prompt: '   ' }).ok);
check('plan: size and steps are fixed, with notes when the user asked for others', (() => { const p = S.plan({ prompt: 'a frog', width: 1024, height: 768, steps: 20, negative: 'blurry' }); return p.ok && p.size === 512 && p.steps === 1 && p.notes.length === 3; })());
check('plan: 512 and 1 step produce no notes', S.plan({ prompt: 'a frog', width: 512, height: 512, steps: 1 }).notes.length === 0);
check('plan: seed is kept (as uint32); a missing seed is random', S.plan({ prompt: 'x', seed: 42 }).seed === 42 && S.plan({ prompt: 'x', seed: -1 }).seed === 4294967295 && Number.isInteger(S.plan({ prompt: 'x' }).seed));

// ---- 亂數：可重現、近似常態
const g1 = S.gaussian(7, 4096), g2 = S.gaussian(7, 4096), g3 = S.gaussian(8, 4096);
check('same seed -> identical noise; different seed -> different', g1.every((v, i) => v === g2[i]) && g1.some((v, i) => v !== g3[i]));
check('noise is roughly standard normal', (() => { let m = 0, v = 0; g1.forEach((x) => { m += x; }); m /= g1.length; g1.forEach((x) => { v += (x - m) * (x - m); }); v /= g1.length; return Math.abs(m) < 0.06 && Math.abs(v - 1) < 0.1; })(), (() => { let m = 0; g1.forEach((x) => { m += x; }); return m / g1.length; })());
check('odd lengths work', S.gaussian(1, 5).length === 5 && S.gaussian(1, 5).every(Number.isFinite));
check('initial latent has shape 4x64x64 and std ≈ sigma', (() => { const x = S.initialLatent(3); let v = 0; x.forEach((a) => { v += a * a; }); v = Math.sqrt(v / x.length); return x.length === 4 * 64 * 64 && Math.abs(v - S.SIGMA_MAX) < 0.8; })());

// ---- 取樣的數學（跟模型說明裡的公式一樣）
check('scaleInput divides by sqrt(sigma^2+1)', (() => { const o = S.scaleInput(Float32Array.from([14.614646911621094, -7.307323455810547]), S.SIGMA_MAX); return Math.abs(o[0] - 14.614646911621094 / Math.sqrt(S.SIGMA_MAX * S.SIGMA_MAX + 1)) < 1e-5 && Math.abs(o[1] + o[0] / 2) < 1e-5; })());
check('denoise: x0 = x - sigma*eps', (() => { const o = S.denoise(Float32Array.from([10, 0, -3]), Float32Array.from([0.5, 0.1, -0.2]), 2); return o[0] === 9 && Math.abs(o[1] + 0.2) < 1e-6 && Math.abs(o[2] - -2.6) < 1e-6; })());
check('if the model predicts exactly the noise, x0 is zero', (() => { const x = S.initialLatent(5), eps = x.map((v) => v / S.SIGMA_MAX), o = S.denoise(x, eps); return o.every((v) => Math.abs(v) < 1e-4); })());

// ---- 分詞結果補長度
check('padIds pads to 77 with the end token', (() => { const p = S.padIds([49406, 320, 1125, 49407]); return p.length === 77 && p[3] === 49407 && p[76] === 49407 && p[1] === 320; })());
check('padIds truncates but keeps an end token', (() => { const p = S.padIds(Array.from({ length: 100 }, (_, i) => i + 1)); return p.length === 77 && p[76] === 49407 && p[75] === 76; })());
check('padIds handles BigInt64Array-like input and empty input', S.padIds(BigInt64Array.from([49406n, 5n, 49407n])).length === 77 && S.padIds([]).length === 77);

// ---- 張量 → 圖片
check('toRgba maps [-1,1] to [0,255], alpha 255', (() => { const w = 2, h = 1, chw = new Float32Array([-1, 1, 0, 0, 1, -1]); const o = S.toRgba(chw, w, h); return o.length === 8 && o[0] === 0 && o[1] === 128 && o[2] === 255 && o[3] === 255 && o[4] === 255 && o[5] === 128 && o[6] === 0 && o[7] === 255; })(), Array.from(S.toRgba(new Float32Array([-1, 1, 0, 0, 1, -1]), 2, 1)));
check('toRgba clamps out-of-range values', (() => { const o = S.toRgba(new Float32Array([-5, 5, 0, 0, 0, 0]), 2, 1); return o[0] === 0 && o[4] === 255; })());
check('imageStats flags a flat (blank) image', S.imageStats(S.toRgba(new Float32Array(3 * 4), 2, 2)).flat === true && S.imageStats(S.toRgba(Float32Array.from([-1, 1, -1, 1, 0, 0, 0, 0, 1, 1, 1, 1]), 2, 2)).flat === false);

// ---- 錯誤說明
check('explainError: fp16 problem points at the CPU setting', /CPU/.test(S.explainError(new Error('shader-f16 is not supported'), S.MODELS[0], {})));
check('explainError: out of memory names the size', /GB|MB/.test(S.explainError(new Error('Array buffer allocation failed'), S.MODELS[1], {})));
check('explainError: download problem says what is kept', /已下載的部分會保留/.test(S.explainError(new Error('Failed to fetch'), S.MODELS[0], {})));
check('license note mentions the use restrictions', /不得/.test(S.LICENSE.note) && /OpenRAIL|RAIL/.test(S.LICENSE.name));
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'local_sd: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
