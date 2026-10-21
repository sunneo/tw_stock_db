// node scripts/imagegen-tests/nvidia_image.test.js -- NVIDIA 線上圖像生成：請求整理、參數夾範圍、回應解析
const N = require('../../renderer/src/imagegen/nvidia_image.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const PNG = 'iVBORw0KGgo' + 'A'.repeat(200), JPG = '/9j/4AAQSkZJRg' + 'A'.repeat(200);

// ---- 請求：使用者貼的三種範例
const k = N.buildRequest({ model: 'black-forest-labs/flux-3-image-klein', prompt: 'A candid photograph', width: 1024, height: 1024, seed: 0, steps: 50 });
check('flux-3-image-klein: url + payload exactly as in the example', k.ok && k.url === 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-3-image-klein' && k.body.steps === 50 && k.body.width === 1024 && k.body.seed === 0 && k.notes.length === 0, k);
const k4 = N.buildRequest({ model: 'black-forest-labs/flux.2-klein-4b', prompt: 'a frog', steps: 4 });
check('flux.2-klein-4b: 4 steps, 1024 default size', k4.ok && k4.body.steps === 4 && k4.body.width === 1024 && k4.url.endsWith('/flux.2-klein-4b'));
const sc = N.buildRequest({ model: 'black-forest-labs/flux.1-schnell', prompt: 'coffee shop' });
check('schnell: defaults (no model given → schnell, 4 steps)', sc.ok && sc.body.steps === 4 && N.buildRequest({ prompt: 'x' }).model === 'black-forest-labs/flux.1-schnell');

// ---- 參數夾範圍並說明
const cl = N.buildRequest({ model: 'black-forest-labs/flux.1-schnell', prompt: 'x', steps: 50, width: 1000, height: 5000 });
check('out-of-range values are clamped, with notes saying what changed', cl.body.steps === 4 && cl.body.width === 1024 && cl.body.height === 2048 && cl.notes.length === 3, cl);
const dev = N.buildRequest({ model: 'black-forest-labs/flux.1-dev', prompt: 'x' });
check('flux.1-dev: cfg_scale and mode base', dev.body.cfg_scale === 3.5 && dev.body.mode === 'base' && dev.body.steps === 50);
const sd = N.buildRequest({ model: 'stabilityai/stable-diffusion-3-medium', prompt: 'x', width: 1920, height: 1080, negative_prompt: 'blurry' });
check('SD3: aspect_ratio instead of width/height, negative_prompt kept', sd.body.aspect_ratio === '16:9' && !('width' in sd.body) && sd.body.negative_prompt === 'blurry' && sd.body.cfg_scale === 5, sd.body);
const cu = N.buildRequest({ model: 'black-forest-labs/some-new-model', prompt: 'x', steps: 8 });
check('an unlisted model path is accepted with flux-style payload', cu.ok && cu.known === false && cu.body.steps === 8);

// ---- 把關
check('bad model path is refused (no url injection)', !N.buildRequest({ model: '../../evil', prompt: 'x' }).ok && !N.buildRequest({ model: 'a/b?x=1', prompt: 'x' }).ok && !N.buildRequest({ model: 'http://x/y', prompt: 'x' }).ok);
check('empty / too long prompt refused', !N.buildRequest({ prompt: '  ' }).ok && !N.buildRequest({ prompt: 'x'.repeat(4001) }).ok);
check('negative seed becomes 0', N.buildRequest({ prompt: 'x', seed: -5 }).body.seed === 0);

// ---- 回應
const r1 = N.parseResponse({ artifacts: [{ base64: PNG, finishReason: 'SUCCESS', seed: 7 }] });
check('artifacts[].base64 (FLUX)', r1.ok && r1.images.length === 1 && r1.images[0].mime === 'image/png' && r1.images[0].seed === 7);
const r2 = N.parseResponse({ image: JPG, finish_reason: 'SUCCESS', seed: 1 });
check('image (SD3) and jpeg sniffing', r2.ok && r2.images[0].mime === 'image/jpeg');
check('data[].b64_json', N.parseResponse({ data: [{ b64_json: PNG }] }).ok);
const r3 = N.parseResponse({ image: 'data:image/webp;base64,' + 'UklGR' + 'A'.repeat(200) });
check('data: url prefix is stripped and its mime used', r3.ok && r3.images[0].mime === 'image/webp' && r3.images[0].b64.indexOf('UklGR') === 0);
const f = N.parseResponse({ artifacts: [{ finishReason: 'CONTENT_FILTERED', base64: '' }] });
check('a filtered result is reported as filtered, not as a missing field', !f.ok && f.filtered === true && /CONTENT_FILTERED/.test(f.error), f);
check('unknown shape gives a helpful error', /找不到圖片資料/.test(N.parseResponse({ foo: 1 }).error));
check('non-object response', !N.parseResponse('x').ok);

// ---- 錯誤白話
check('http errors explained', /金鑰/.test(N.explainHttpError(401, '')) && /路徑/.test(N.explainHttpError(404, '')) && /參數/.test(N.explainHttpError(422, 'steps')) && /額度/.test(N.explainHttpError(429, '')));
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'nvidia_image: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
