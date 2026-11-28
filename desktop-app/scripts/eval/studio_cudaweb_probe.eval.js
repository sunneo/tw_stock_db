// 工作室後端選單的 cudaweb 真 Electron 驗證：打開工作室後端清單（/api/backends?kind=lora），回傳 cudaweb 那一項與渲染端 backendInfo。
// 用法：node scripts/eval/real_electron.run.js studio_cudaweb_probe 17931
return (async () => {
  const R = {};
  const fa = window.fa;
  const srv = await fa._studioServer();
  const route = async (m, p, b) => (await srv.core.route(m, new URL('http://mock.local' + p), b)).j;
  const be = await route('GET', '/api/backends?kind=lora');
  R.desktop = be.desktop; R.beKeys = Object.keys(be); R.beError = be.error || null;
  R.backendsList = (be.backends || []).map((b) => ({ id: b.id, available: b.available, reason: b.reason, layer: b.layer || null, source: b.source || null }));
  R.cudawebEntry = (be.backends || []).find((b) => b.id === 'cudaweb') || null;
  try { const bi = await fa._studioHostApi().cudawebEnvProbe(); R.rendererBackendInfo = { deviceReady: bi.deviceReady, profile: bi.profile, probeReason: bi.probeReason, webgl2: bi.webgl2 && bi.webgl2.available, last: bi.last }; } catch (e) { R.rendererBackendInfo = { error: String((e && e.message) || e) }; }
  return R;
})();
