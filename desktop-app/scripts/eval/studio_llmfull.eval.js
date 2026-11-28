// 工作室 llm_full 真跑（真 Electron）：同一組設定先跑 cudaweb、再跑 cpu-py，各自輪詢到完成，回報每步損失與毫秒、檢查點。
// 用法：node scripts/eval/real_electron.run.js studio_llmfull 17931（用 run_gpu 的副本，保留 WebGPU）
return (async () => {
  const R = { runs: {} };
  const fa = window.fa;
  const srv = await fa._studioServer();
  const route = async (m, p, b) => (await srv.core.route(m, new URL('http://mock.local' + p), b)).j;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 資料：一般文字與對話各一行，足以產生多個窗口
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ text: '今天天氣很好，我們去公園散步，第' + i + '次。' }));
  for (let i = 0; i < 20; i++) lines.push(JSON.stringify({ messages: [{ role: 'user', content: '問題' + i + '？' }, { role: 'assistant', content: '回答' + i + '。' }] }));
  const trainText = lines.join('\n');
  const body = (backend) => ({ name: 'llmfull_' + backend, backend, trainText, steps: 6, lr: 0.001, wd: 0.01, clip: 1, seed: 1, cfg: { V: 258, d: 32, L: 2, H: 4, kvH: 2, F: 64, T: 12, qkNorm: true } });
  for (const backend of ['cudaweb', 'cpu-py']) {
    const t0 = Date.now();
    const st = await route('POST', '/api/llmfull/start', body(backend));
    if (!st.ok) { R.runs[backend] = { startError: st.error || st, status: st.status || null }; continue; }
    let s = null;
    for (let i = 0; i < 1200; i++) { s = await route('GET', '/api/llmfull/status'); if (s.state !== 'running') break; await wait(250); }
    R.runs[backend] = { rows: st.rows, skipped: st.skipped, steps: st.steps, state: s.state, error: s.error, records: s.records, ckpt: s.ckpt, wallMs: Date.now() - t0 };
  }
  // 續訓（cudaweb）：記憶中的檢查點接續 2 步
  if (R.runs.cudaweb && R.runs.cudaweb.state === 'done') {
    const st = await route('POST', '/api/llmfull/start', Object.assign(body('cudaweb'), { steps: 2, resume: true }));
    let s = null; for (let i = 0; i < 1200; i++) { s = await route('GET', '/api/llmfull/status'); if (s.state !== 'running') break; await wait(250); }
    R.resumeCudaweb = { ok: st.ok, state: s && s.state, records: s && s.records, ckpt: s && s.ckpt, error: st.error || (s && s.error) };
  }
  return R;
})();
