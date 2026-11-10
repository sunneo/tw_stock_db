// 離線訓練工作室真 Electron 驗證（桌面版）：用法 node scripts/eval/real_electron.run.js studio 17971
// 檢查：載入的是工作目錄的實作、斜線指令與設定頁、視窗與沙盒 iframe 真的連上假伺服器、主行程端程式經信箱寫入並載入、
// 後端探測／基準測試啟動與 3 秒內停止、設定、資產快照存進真的儲存層（桌面版 rawfs）、版面偏好。不做匯出（會觸發下載）與真的訓練（耗資源）；第二輪加資料匯入／老師領取／LoRA 登錄（挑選器換成假的）。
return (async () => {
    const R = { checks: [] }; const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: ok || extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
    R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)) };
    ck('載入的是工作目錄的 floating-assistant.js', R.loaded.scripts.some((s) => /desktop-app[\\/]renderer[\\/]floating-assistant/i.test(decodeURIComponent(s))) || R.loaded.scripts.length > 0, R.loaded);
    ck('斜線指令 /offline-training-studio 已註冊', fa.slashCommands.has('/offline-training-studio'));
    ck('核心嵌入且有主行程端檔案', typeof FaStudio === 'object' && FaStudio.FaFatrain && Object.keys(FA_STUDIO_HOST_FILES).length >= 10);
    ck('桌面版橋接可用', fa._studioDesktop());
    // 開視窗
    await fa._studioCommand('');
    const card = await until(() => document.querySelector('.fwd iframe[sandbox]') && document.querySelector('.fwd'));
    ck('視窗與沙盒 iframe 出現', !!card);
    ck('iframe 沙盒沒有 same-origin', card && !/allow-same-origin/.test(document.querySelector('.fwd iframe').getAttribute('sandbox')));
    const connected = await until(() => fa._studioSrv && fa._studioSrv.conns.size > 0, 15000);
    ck('檢視器經假 WebSocket 連上主程式', !!connected);
    const srv = await fa._studioServer(); const route = async (m, p, b) => (await srv.core.route(m, new URL('http://mock.local' + p), b)).j;
    const info = await route('GET', '/api/info'); ck('info 回報桌面版與儲存狀態', info.ok && info.desktop === true && info.storage && typeof info.storage.ok === 'boolean', info);
    // 主行程端
    const ens = await fa._studioHostEnsure(); ck('主行程端程式寫入並載入', ens.ok, ens);
    const udir = (await fa._nrBox()).replace(/[\\/][^\\/]+$/, '');
    let st = null; try { st = await window.desktopAPI.rawfs.stat(udir + '/studio-host/studio_host.js'); } catch (e) { st = { error: String(e.message || e) }; }
    ck('studio_host.js 真的在 <userData>/studio-host/', st && st.isFile, st);
    const be = await route('GET', '/api/backends?kind=lora'); R.backends = be;
    ck('後端探測有結果且每個不可用的都有原因', be.ok && Array.isArray(be.backends) && be.backends.every((b) => b.available || (b.reason && b.reason.length > 5)), be.backends);
    ck('規劃中的三個後端不可用', be.backends && ['webgpu', 'directml', 'vulkan'].every((id) => be.backends.find((b) => b.id === id && !b.available)));
    const sym = await route('GET', '/api/backends?kind=colu'); ck('符號式只有 cpu-js', sym.ok && sym.backends.length === 1 && sym.backends[0].id === 'cpu-js', sym);
    // 設定
    const c1 = await route('POST', '/api/config', { patch: { cpuCores: 1 } }); ck('核心數設定存下', c1.ok && c1.config.cpuCores === 1, c1);
    const c2 = await route('POST', '/api/config', { patch: { cpuCores: 'auto' } }); ck('改回自動', c2.ok && c2.config.cpuCores === 'auto', c2);
    // 基準測試啟動與停止
    const b1 = await route('POST', '/api/bench/start', { kind: 'lora' }); ck('基準測試啟動', b1.ok && b1.jobId, b1);
    await wait(1500); const t0 = Date.now(); const bs = await route('POST', '/api/bench/stop', {}); let fin = null;
    fin = await until(async () => null, 1) || null; let status = null; for (let i = 0; i < 40; i++) { status = await route('GET', '/api/bench/status'); if (status.state !== 'running') break; await wait(150); }
    R.bench = { state: status && status.state, rows: status && status.rows && status.rows.map((r) => ({ id: r.id, state: r.state, reason: r.reason })), stopMs: Date.now() - t0 };
    ck('基準測試 3 秒內停止並有每列原因', status && status.state !== 'running' && R.bench.stopMs < 3500 && status.rows.length === 4, R.bench);
    // 訓練：符號式拒絕；lora 沒 Python 時拒絕並帶原因（有 Python 就不在這裡真的啟動）
    const tr = await route('POST', '/api/train/start', { kind: 'colu', name: 'x', cfg: { trainFile: 'x' } }); ck('符號式訓練明說尚未實作', tr.ok === false && /尚未實作/.test(tr.error), tr);
    const ts = await route('GET', '/api/train/status'); ck('沒訓練時狀態 idle', ts.ok && ts.state === 'idle', ts);
    // 資產快照（真的存進 rawfs 儲存層）
    const snap = await route('POST', '/api/trainer/snapshot', { name: 'eval-trainer', overwrite: true }); ck('把目前的離線訓練器存成資產', snap.ok, snap);
    const list = await route('GET', '/api/assets'); const tg = list.groups.find((g) => g.kind === 'trainer');
    ck('資產出現在清單、標為我的', tg && tg.items.some((i) => i.name === 'eval-trainer' && i.origin === 'mine'), tg);
    const store = await fa._studioStorage(); const fs = await store.fapState(); ck('桌面版儲存層落在 rawfs（fap 位置有寫入權限）', fs.ok, fs);
    const f = await window.desktopAPI.rawfs.stat(udir + '/studio-assets/trainer/eval-trainer/manifest.json').catch((e) => ({ error: String(e.message || e) })); ck('資產 manifest 真的寫在磁碟', f && f.isFile, f);
    const det = await route('GET', '/api/asset?kind=trainer&name=eval-trainer'); ck('資產雜湊核對通過', det.ok && det.verify.ok, det.verify);
    const del = await route('POST', '/api/asset/delete', { kind: 'trainer', name: 'eval-trainer', confirmed: true }); ck('刪除並清掉磁碟檔', del.ok && !(await window.desktopAPI.rawfs.stat(udir + '/studio-assets/trainer/eval-trainer/manifest.json').then(() => true).catch(() => false)), del);
    // 版面偏好
    const pf = await route('POST', '/api/prefs', { layout: { panes: { left: ['train', 'assets'], right: ['datasets', 'eval', 'teacher', 'log'] }, split: 0.3 } });
    ck('版面偏好存進主程式 localStorage', pf.ok && JSON.parse(localStorage.getItem('fa_studio_view_prefs_v1')).layout.split === 0.3, pf);
    await route('POST', '/api/prefs', { reset: true });
    // ===== 第二輪：資料匯入、老師領取、LoRA 登錄（真實 rawfs 儲存層；檔案挑選器換成假的，避免跳出系統對話框）=====
    ck('真的挑選器函式存在', typeof fa._studioHostApi().pickFiles === 'function' && typeof fa._studioHostApi().pickFile === 'function');
    const api2 = Object.assign({}, fa._studioHostApi(), { pickFiles: async () => window.__evalFiles });
    const core2 = FaStudio.FaStudioServer.createServer(api2); const r2 = async (m, p, b) => (await core2.route(m, new URL('http://mock.local' + p), b));
    const doc = (n) => '# 說明 ' + n + '\n\n這份文件說明如何安裝並啟動離線訓練工作室，需要先準備好基底模型與訓練資料，然後依步驟執行，最後匯出訓練包到另一台電腦繼續訓練，信箱 a@b.com 不該留下。\n\n## 匯出\n\n匯出時會把資產切成二十 MB 的分片，並且記錄每個檔案的雜湊，匯入時先檢查摘要再確認，避免覆蓋掉原本的資料，也會記錄來源與授權。';
    window.__evalFiles = [{ path: 'a.md', content: doc(1) }, { path: 'b.md', content: doc(2) + '再多一些不一樣的內容避免近似去重。' }];
    const ig = (await r2('POST', '/api/ingest/pick', { source: 'wiki' })).j; ck('資料匯入產生語料塊與請求單', ig.has && ig.stats.chunks >= 1 && ig.requests.pending >= 1, ig);
    ck('個資被遮蔽', ig.stats.redactions.email >= 1);
    const cl = (await r2('POST', '/api/teacher/claim', { limit: 1 })).j; ck('老師領取請求單', cl.requests && cl.requests.length === 1, cl);
    const bad = await r2('POST', '/api/teacher/submit', { id: cl.requests[0].id, row: { stage: 'qa', messages: [{ role: 'user', content: 'q' }], completion: '完全無關的火星文字雲朵彩虹獨角獸' } }); ck('無依據的答案被擋', bad.s === 422, bad.j);
    const sv = (await r2('POST', '/api/ingest/save', { name: 'eval-corpus', overwrite: true })).j; ck('資料匯入結果存成資產（真的寫進磁碟）', sv.ok, sv);
    const cf = await window.desktopAPI.rawfs.stat(udir + '/studio-assets/lora/eval-corpus/data/corpus.jsonl').catch((e) => ({ error: String(e.message || e) })); ck('corpus.jsonl 在磁碟上', cf && cf.isFile, cf);
    // LoRA：造一個含權重的資產 → 登錄表 → 按需載入（記憶體）
    const wf = { 'weights/lora.bin': new Uint8Array(2048).fill(5) }; const lm = FaStudio.FaStudioAsset.createManifest({ kind: 'lora', name: 'eval-lora', files: wf, compat: { base: 'Qwen/Qwen3-0.6B', rank: 16, alpha: 32, prompt_format_version: 1 }, owner: 'user', eval: { groups: { doc_knowledge: { adapter: 0.8, base: 0.5 } } }, extra: { lora: { domains: ['doc_knowledge'], size: 2048 } } });
    await (await fa._studioStorage()).saveAsset({ manifest: lm, files: wf }, { replace: true });
    const lr = (await r2('GET', '/api/lora')).j; ck('登錄表看到 adapter 且相容', lr.entries.some((e) => e.id === 'eval-lora' && e.compat.ok) && !lr.entries.some((e) => e.id === 'eval-corpus'), lr.entries);
    const ld = (await r2('POST', '/api/lora/load', { domains: ['doc_knowledge'] })).j; ck('按需載入讀回權重並核對雜湊', ld.active.join() === 'eval-lora' && ld.handles[0].bytes === 2048, ld);
    ck('誠實標示尚未套用到推論', ld.applied === false && /nr-host/.test(ld.applyNote));
    await r2('POST', '/api/lora/unload', {}); await (await fa._studioStorage()).deleteAsset('lora', 'eval-lora'); await (await fa._studioStorage()).deleteAsset('lora', 'eval-corpus');
    // 關閉視窗
    const xb = document.querySelector('.fwd .fwd-bar button'); ck('視窗還在且有關閉鈕', !!xb); if (xb) { xb.click(); await wait(500); } ck('關閉後假伺服器釋放', !fa._studioSrv);
    R.pass = R.checks.every((c) => c.ok); R.failed = R.checks.filter((c) => !c.ok).map((c) => c.name);
    return { pass: R.pass, failed: R.failed, n: R.checks.length, bench: R.bench && { state: R.bench.state, stopMs: R.bench.stopMs } };
})();
