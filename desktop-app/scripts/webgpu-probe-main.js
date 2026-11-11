// 本機 WebGPU 可用性探測（真 Electron 的 Chromium，隱藏視窗，不載入產品）。
// 用法：<electron.exe> scripts/webgpu-probe-main.js --user-data-dir=<全新暫存資料夾> [--probe-flags=enable-unsafe-webgpu,use-angle=d3d12 ...]
// 輸出一行 [webgpu-probe] {...}：Chromium 版本、navigator.gpu、adapter 資訊、功能（shader-f16 等）、limits。
const { app, BrowserWindow } = require('electron');
const extra = (process.argv.find((a) => a.startsWith('--probe-flags=')) || '').slice(14).split(',').filter(Boolean);
for (const f of extra) { const [k, v] = f.split('='); app.commandLine.appendSwitch(k, v); }
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { sandbox: false } });
    const fs = require('fs'), path = require('path'), os = require('os'); const f = path.join(os.tmpdir(), 'fa-webgpu-probe.html'); fs.writeFileSync(f, '<title>probe</title>'); await win.loadFile(f);   // WebGPU 需要安全來源：data: 網址沒有 navigator.gpu，file: 有
    const code = `(async () => { const r = {};
      try {
        Object.assign(r, { chromium: (navigator.userAgent.split('Chrome/')[1] || '').split(' ')[0], hasGpu: !!navigator.gpu, crossOriginIsolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer });
        try { r.memory64 = await (async () => { try { new WebAssembly.Memory({ initial: 1, maximum: 2, index: 'i64' }); return true; } catch (e) { return 'no: ' + e.message; } })(); } catch (e) { r.memory64 = 'err ' + e.message; }
        if (!navigator.gpu) return r;
        const a = await navigator.gpu.requestAdapter(); r.adapter = !!a; if (!a) return r;
        r.info = a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description, isFallback: a.isFallbackAdapter } : null;
        r.features = [...a.features]; r.limits = { maxBufferSize: a.limits.maxBufferSize, maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize, maxComputeWorkgroupStorageSize: a.limits.maxComputeWorkgroupStorageSize, maxComputeInvocationsPerWorkgroup: a.limits.maxComputeInvocationsPerWorkgroup };
        try { const d = await a.requestDevice(); r.device = true; d.destroy(); } catch (e) { r.device = 'fail ' + e.message; }
      } catch (e) { r.pageError = String(e && e.stack || e); }
        return r; })()`;
    let res; try { res = await win.webContents.executeJavaScript(code); } catch (e) { res = { error: e.message }; }
    res.electron = process.versions.electron; res.gpuFeatureStatus = app.getGPUFeatureStatus();
    console.log('[webgpu-probe] ' + JSON.stringify(res)); app.quit();
});
