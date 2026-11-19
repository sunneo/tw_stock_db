// llc fluid3d 畫面像素檢查（真 Electron）：解開截圖 PNG，數出非背景像素，並存到 /tmp 供目視
const fa = window.fa; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
const R = {};
for (const name of ['llc/gpgpu/fluid3d.ll']) {
  const j = await tool('job_run', { lang: 'llc', code: FA_PY_EXAMPLES[name], args: ['400'], detach: true, timeout_s: 120 });
  await wait(9000);
  const sh = await tool('job_gui', { job_id: j.job_id, action: 'screenshot', canvas: 0 });
  const job = fa._jobTable().get(j.job_id), rt = await fa._ensureBashWasmLoaded(), fsx = await fa._ensureTerminalFsStore(job.session, rt); const bytes = fa._terminalSandboxFileBytes(fsx, sh.screenshot.path);
  const bmp = await createImageBitmap(new Blob([bytes])), oc = new OffscreenCanvas(bmp.width, bmp.height), cx = oc.getContext('2d'); cx.drawImage(bmp, 0, 0); const d = cx.getImageData(0, 0, bmp.width, bmp.height).data; let diff = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 40) diff++;
  R[name] = { bytes: bytes.length, w: bmp.width, h: bmp.height, drawn: diff, b64: btoa(String.fromCharCode(...bytes)) };
  await tool('job_stop', { job_id: j.job_id });
}
console.log('SHOT ' + JSON.stringify(R).slice(0, 100000));
return Object.fromEntries(Object.entries(R).map(([k, v]) => [k, { bytes: v.bytes, drawn: v.drawn, b64: v.b64 }]));
