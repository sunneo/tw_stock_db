// 訓練工作室 cpu-py 真 Electron 驗證：用法 node scripts/eval/real_electron.run.js studio_cpupy 17972
// 檢查：主行程端用真的探測找到 lora-train/.venv（Python 3.11 以上）且 torch／transformers／peft 齊全 → cpu-py 顯示可用；
// 按「基準測試」（/api/bench/start）會真的啟動訓練子行程。基底模型 Qwen/Qwen3-0.6B 若本機沒有已下載的檔案，
// 子行程在離線模式（HF_HUB_OFFLINE=1，由呼叫端環境提供）會失敗——這時 cpu-py 那列必須是「失敗並附具體原因」，而且絕不能自己下載。
return (async () => {
    const R = { checks: [] }; const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: ok || extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await fa._studioCommand('');
    const srv = await fa._studioServer(); const route = async (m, p, b) => (await srv.core.route(m, new URL('http://mock.local' + p), b)).j;
    const ens = await fa._studioHostEnsure(); ck('主行程端程式寫入並載入', ens.ok, ens);
    const be = await route('GET', '/api/backends?kind=lora'); R.backends = be.backends;
    const cp = be.backends && be.backends.find((b) => b.id === 'cpu-py');
    ck('cpu-py 顯示可用', cp && cp.available, cp);
    R.cpuPy = cp;
    const b1 = await route('POST', '/api/bench/start', { kind: 'lora' }); ck('基準測試啟動', b1.ok && b1.jobId, b1);
    let status = null; const t0 = Date.now();
    for (let i = 0; i < 400; i++) { status = await route('GET', '/api/bench/status'); if (status.state !== 'running') break; await wait(500); if (Date.now() - t0 > 200000) { await route('POST', '/api/bench/stop', {}); break; } }
    const row = status && status.rows && status.rows.find((r) => r.id === 'cpu-py');
    R.bench = { state: status && status.state, row, ms: Date.now() - t0 };
    ck('基準測試結束且 cpu-py 那列有結果（數字，或失敗＋具體原因）', row && row.result && (row.result.tokPerSec > 0 || (row.result.reason && row.result.reason.length > 5)), row);
    R.failed = R.checks.filter((c) => !c.ok).length; R.pass = R.failed === 0;
    return { pass: R.pass, failed: R.failed, n: R.checks.length, bench: R.bench, checks: R.checks.filter((c) => !c.ok) };
})();
