// 用法：同 gui_bridge.eval.js。實測：module Worker 裡 SharedArrayBuffer 與 Atomics.wait 是否可用，且主執行緒可以喚醒它。
const R = { pageSab: typeof SharedArrayBuffer, coi: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : null };
const workerSrc = `self.onmessage = (ev) => {
  const sab = ev.data; const ctrl = new Int32Array(sab);
  const r = { sab: typeof SharedArrayBuffer, atomics: typeof Atomics };
  const t0 = Date.now();
  try { r.wait = Atomics.wait(ctrl, 0, 0, 5000); r.ms = Date.now() - t0; r.value = Atomics.load(ctrl, 0); } catch (e) { r.err = String(e && e.message || e); }
  postMessage(r);
};`;
const w = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' })), { type: 'module' });
const sab = new SharedArrayBuffer(16);
const res = await new Promise((resolve) => {
  w.onmessage = (ev) => resolve(ev.data);
  w.onerror = (ev) => resolve({ error: ev.message });
  w.postMessage(sab);
  setTimeout(() => { Atomics.store(new Int32Array(sab), 0, 7); Atomics.notify(new Int32Array(sab), 0); }, 300);
});
R.worker = res; w.terminate();
return R;
