const fa = window.fa; const R = {}; const seen = []; const realFetch = window.fetch;
const cv = document.createElement('canvas'); cv.width = cv.height = 96; const cx = cv.getContext('2d'); for (let i = 0; i < 96; i += 8) { cx.fillStyle = 'hsl(' + (i * 3) + ',70%,50%)'; cx.fillRect(i, 0, 8, 96); } const PNG = cv.toDataURL('image/png').split(',')[1];
window.fetch = async (url, opts) => { if (/genai/.test(String(url))) { seen.push({ url: String(url), auth: opts.headers.Authorization }); return new Response(JSON.stringify({ artifacts: [{ base64: PNG, finishReason: 'SUCCESS', seed: 1 }] }), { status: 200 }); } return realFetch(url, opts); };
const call = async (a) => JSON.parse(await fa.tools.generate_image.callback.call(fa, JSON.stringify(a)));
const orig = fa._resolveModelRowConfig.bind(fa);
// 1) 內建預設是 Worker（訪客）：不填 key
fa.advancedSettings.imageGen = { apiKey: '', model: 'black-forest-labs/flux.1-schnell', customModel: '' };
fa._resolveModelRowConfig = () => ({ apiUrl: 'https://fa-worker.example.workers.dev/v1', apiKey: 'shared-fake-key' });
const a = await call({ prompt: 'a frog' }); R.worker = { ok: a.ok, url: seen[seen.length - 1].url, auth: seen[seen.length - 1].auth, key_from: a.key_from };
// 2) 內建預設是 NVIDIA 官方端點：直接打 ai.api.nvidia.com
fa._resolveModelRowConfig = () => ({ apiUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvapi-DEFAULT' });
const b = await call({ prompt: 'a frog' }); R.nvidia_default = { ok: b.ok, url: seen[seen.length - 1].url, auth: seen[seen.length - 1].auth, key_from: b.key_from };
// 3) 自己填的 key 優先，一律直接打 NVIDIA
fa.advancedSettings.imageGen.apiKey = 'nvapi-OWN';
const c = await call({ prompt: 'a frog' }); R.own = { url: seen[seen.length - 1].url, auth: seen[seen.length - 1].auth, key_from: c.key_from || null };
// 4) 沒有任何 key
fa.advancedSettings.imageGen.apiKey = ''; fa._resolveModelRowConfig = () => ({ apiUrl: 'https://x/v1', apiKey: '' });
R.no_key = (await call({ prompt: 'a frog' })).error.slice(0, 30);
fa._resolveModelRowConfig = orig; window.fetch = realFetch; return R;
