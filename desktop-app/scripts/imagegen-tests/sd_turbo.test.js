// node scripts/imagegen-tests/sd_turbo.test.js -- sd-turbo 圖生圖改圖的純函式核心
const S = require('../../renderer/src/imagegen/sd_turbo_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

const ac = S.alphasCumprod();
check('alphas: starts near 1, ends near 0.0047 (sigma 14.6)', near(ac[0], 0.99915, 1e-6) && near(ac[999], 0.00466, 0.0003) && ac[500] < ac[100], [ac[0], ac[999]]);
check('timesteps: 1 step full strength is 999; lower strength starts later', S.timesteps(1, 1).join() === '999' && S.timesteps(1, 0.5)[0] < 999 && S.timesteps(1, 0.5)[0] > 100);
check('timesteps: 4 steps spaced trailing, strength drops early ones', S.timesteps(4, 1).join() === '999,749,499,249' && S.timesteps(4, 0.5).join() === '499,249' && S.timesteps(4, 0.05).length === 1);
check('timesteps: clamps steps to 1..4', S.timesteps(99, 1).length === 4 && S.timesteps(0, 1).length === 1);

const z0 = Float32Array.from([1, -1, 0.5, 2]), nz = Float32Array.from([0.3, 0.2, -0.4, 1]);
const xt = S.addNoise(z0, nz, 600);
const eps = nz; // 完美預測 eps 時應還原 z0
const back = S.predictX0(xt, eps, 600);
check('predictX0: perfect eps recovers z0', Array.from(back).every((v, i) => near(v, z0[i], 1e-4)), Array.from(back));
check('step: last step returns x0, otherwise re-noises to the next timestep', S.step(xt, eps, 600, null).every((v, i) => near(v, z0[i], 1e-4)) && S.step(xt, eps, 600, 300, nz).every((v, i) => near(v, S.addNoise(z0, nz, 300)[i], 1e-4)));

const g1 = S.gaussian(7, 1000), g2 = S.gaussian(7, 1000), g3 = S.gaussian(8, 1000);
const mean = g1.reduce((a, b) => a + b, 0) / g1.length, vr = g1.reduce((a, b) => a + (b - mean) * (b - mean), 0) / g1.length;
check('gaussian: reproducible, ~unit variance, different seed differs', g1.every((v, i) => v === g2[i]) && g1.some((v, i) => v !== g3[i]) && Math.abs(mean) < 0.15 && Math.abs(vr - 1) < 0.2);

check('latentFromEncoder: scales by 0.18215, rejects short output', near(S.latentFromEncoder(new Float32Array(16384 * 2).fill(1))[0], 0.18215) && S.latentFromEncoder(new Float32Array(10)) === null);
const chw = S.toChw(new Uint8ClampedArray([0, 255, 128, 255]), 1, 1);
check('toChw: [-1,1] planar', near(chw[0], -1) && near(chw[1], 1) && near(chw[2], 128 / 127.5 - 1));

check('taesd: [0,1] input, scale 1, pinned small files under MIT', near(S.toChw(new Uint8ClampedArray([0, 255, 51, 255]), 1, 1, '01')[2], 0.2) && near(S.latentFromEncoder(new Float32Array(16384).fill(2), 0, S.TAESD.scale)[0], 2) && S.TAESD.license === 'MIT' && /^[0-9a-f]{40}$/.test(S.TAESD.rev) && S.TAESD.files.every((f) => f.bytes > 4e6 && f.bytes < 6e6) && S.TAESD.files.some((f) => f.role === 'vaeEnc'));
check('padIds: sd-turbo pads with 0 after the end token, sdxs pads with 49407, long input is cut with an end token', (() => { const a = S.padIds([49406, 5, 6, 49407, 49407, 49407], 0), b = S.padIds([49406, 5, 49407], 49407), c = S.padIds(new Array(100).fill(7)); return a.length === 77 && a[3] === 49407 && a[4] === 0 && a[76] === 0 && b[3] === 49407 && c.length === 77 && c[76] === 49407; })());
const fb = S.fitBox(1024, 512);
check('fitBox: keeps aspect, multiple of 8, centered in 512', fb.dw === 512 && fb.dh === 256 && fb.dx === 0 && fb.dy === 128 && S.fitBox(300, 900).dh === 512 && S.fitBox(300, 900).dw % 8 === 0);

const orig = new Uint8ClampedArray(4 * 4).fill(0), nw = new Uint8ClampedArray(4 * 4).fill(200);
for (let i = 0; i < 4; i++) { orig[i * 4 + 3] = 255; nw[i * 4 + 3] = 255; }
const m = Float32Array.from([1, 1, 0, 0]);
const bl = S.blend(orig, nw, m, 4, 1, 0);
check('blend: only inside mask changes; no mask replaces all colors but keeps alpha', bl[0] === 200 && bl[8] === 0 && S.blend(orig, nw, null, 4, 1)[12] === 200);
const fm = S.feather(Float32Array.from([1, 0, 0, 0, 0]), 5, 1, 1);
check('feather: softens edge, keeps range 0..1', near(fm[0], 0.5) && near(fm[1], 1 / 3) && fm.every((v) => v >= 0 && v <= 1));

check('plan: empty prompt rejected', S.plan({}).ok === false);
check('plan: strength words map (微調 / 大改), default 0.5', S.plan({ prompt: 'x', request: '微調一下' }).strength === 0.35 && S.plan({ prompt: 'x', request: '大改成水彩' }).strength === 0.8 && S.plan({ prompt: 'x' }).strength === 0.5);
check('plan: explicit strength wins and is clamped; seed reproducible', S.plan({ prompt: 'x', strength: 5 }).strength === 1 && S.plan({ prompt: 'x', strength: 5 }).notes.length === 1 && S.plan({ prompt: 'x', seed: 5 }).seed === 5);
check('plan: steps clamped 1..4, big strength defaults to 2 steps', S.plan({ prompt: 'x', steps: 9 }).steps === 4 && S.plan({ prompt: 'x', strength: 0.9 }).steps === 2);

check('pickModel: always sdxs; wasm without gpu or f16, webgpu with f16, forced webgpu without gpu is refused', S.pickModel({ hasGpu: false }).ep === 'wasm' && S.pickModel({ hasGpu: true, f16: false }).ep === 'wasm' && S.pickModel({ hasGpu: true, f16: true }).ep === 'webgpu' && S.pickModel({ hasGpu: true, f16: true }, 'cpu').ep === 'wasm' && S.pickModel({}, 'webgpu').ok === false && S.MODELS.length === 0);
check('license: SDXS and TAESD only', /RAIL/.test(S.LICENSE.name) && /MIT/.test(S.LICENSE.name));
check('explainError: memory and download are explained', /記憶體/.test(S.explainError(new Error('Array buffer allocation failed'), null)) && /已下載的部分會保留/.test(S.explainError(new Error('Failed to fetch'), null)));
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'sd_turbo: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
