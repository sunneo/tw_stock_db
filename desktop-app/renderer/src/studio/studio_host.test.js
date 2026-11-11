'use strict';
// studio_host 測試：用假子行程（沒有 Python），驗證 probe／設定／基準測試／自動選擇／訓練拒絕的誠實回報。
const fs = require('fs'), os = require('os'), path = require('path');
const { createStudioHost, parseTasklistMemory } = require('./studio_host.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-studio-host-'));
  const cp = { spawnSync: () => ({ error: new Error('ENOENT'), status: null }), spawn: () => { throw new Error('不應該啟動子行程'); } };
  const h = createStudioHost({ fs, path, os, cp, hostDir: dir, loraDir: path.join(dir, 'none') });
  // 畫面用的探測不等慢的探測：第一次先回「探測中…」，等背景探測完成後才有具體結果
  const pr0 = await h.handle('studio_probe', { kind: 'lora' });
  const py0 = pr0.backends.find((b) => b.id === 'cpu-py');
  check('第一次探測：cpu-py 標探測中且立即回', pr0.ok && py0.probing === true && py0.reason === '探測中…' && !py0.available, py0);
  const w = await h.handle('studio_probe_wait', {}); check('等待背景探測完成', w.ok && w.done, w);
  const pr = await h.handle('studio_probe', { kind: 'lora' });
  check('probe 回六種後端中 lora 的五個', pr.ok && pr.backends.map((b) => b.id).join() === 'cpu-py,wasm-web,webgpu,directml,vulkan', pr.backends);
  const py = pr.backends.find((b) => b.id === 'cpu-py');
  check('沒有 Python：cpu-py 不可用且原因具體', !py.available && /找不到 Python/.test(py.reason), py);
  check('規劃中後端不可用並帶阻礙原因', pr.backends.filter((b) => b.planned).every((b) => !b.available && b.reason.length > 10));
  const sym = await h.handle('studio_probe', { kind: 'colu' });
  check('符號式 kind 只有 cpu-js', sym.symbolic && sym.backends.length === 1 && sym.backends[0].id === 'cpu-js');
  // 設定
  const c1 = await h.handle('studio_config_set', { patch: { cpuCores: 1 } });
  check('設定核心數 1', c1.ok && c1.config.cpuCores === 1, c1);
  check('設定寫到檔案', JSON.parse(fs.readFileSync(path.join(dir, 'studio-config.json'), 'utf8')).cpuCores === 1);
  const c2 = await h.handle('studio_config_set', { patch: { cpuCores: 0 } });
  check('不合法的核心數回報錯誤並退回 auto', c2.errors.length === 1 && c2.config.cpuCores === 'auto', c2);
  // 基準
  const st = await h.handle('studio_bench_start', { kind: 'lora' });
  check('基準測試啟動', st.ok && st.jobId, st);
  let s; for (let i = 0; i < 100; i++) { s = await h.handle('studio_bench_status', { jobId: st.jobId }); if (s.state !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  check('基準測試結束', s.state === 'done', s);
  check('五列都有且全部略過並附原因', s.rows.length === 5 && s.rows.every((r) => r.state === 'skipped' && r.reason), s.rows.map((r) => r.id + r.state));
  // 自動選擇：沒有可用後端 → 具體原因
  const sel = await h.handle('studio_select', { kind: 'lora' });
  check('自動選擇沒有可用後端時回原因', !sel.ok && /沒有可用的後端/.test(sel.reason || ''), sel);
  const selS = await h.handle('studio_select', { kind: 'trainer' });
  check('符號式自動選擇 cpu-js', selS.ok && selS.chosen === 'cpu-js');
  // 訓練拒絕
  const t1 = await h.handle('studio_train_start', { kind: 'colu', cfg: {} });
  check('符號式訓練不走主行程，明說由 sym_train_core 執行', !t1.ok && /sym_train_core/.test(t1.error), t1);
  const t2 = await h.handle('studio_train_start', { kind: 'lora', cfg: { trainFile: 'a', outputDir: 'b' } });
  check('cpu-py 不可用時拒絕並帶原因', !t2.ok && /cpu-py 不可用/.test(t2.error), t2);
  const t3 = await h.handle('studio_train_start', { kind: 'lora', backend: 'webgpu', cfg: {} });
  check('webgpu 訓練被拒', !t3.ok && /webgpu/.test(t3.error));
  const ts = await h.handle('studio_train_status', {});
  check('沒訓練時狀態 idle', ts.ok && ts.state === 'idle');
  check('未知 op', (await h.handle('studio_nope', {})).code === 'bad_op');
  // 基準中斷（cpu-js 可用的符號式 kind）：快速完成即可
  const sb = await h.handle('studio_bench_start', { kind: 'colu' });
  let s2; for (let i = 0; i < 200; i++) { s2 = await h.handle('studio_bench_status', { jobId: sb.jobId }); if (s2.state !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  check('cpu-js 基準通過（參考引擎）', s2.rows[0] && s2.rows[0].state === 'passed' && s2.rows[0].result.tokPerSec > 0, s2.rows);
  fs.rmSync(dir, { recursive: true, force: true });
  // Windows 子行程記憶體：tasklist 的 CSV 欄位（千分位、K）→ 位元組；查不到回 null
  check('tasklist：解析千分位的 K 為位元組', parseTasklistMemory('"python.exe","1234","Console","1","1,234,567 K"\r\n') === 1234567 * 1024, parseTasklistMemory('"python.exe","1234","Console","1","1,234,567 K"'));
  check('tasklist：查不到（INFO 訊息）回 null', parseTasklistMemory('INFO: No tasks are running which match the specified criteria.') === null);
  check('tasklist：空輸出回 null', parseTasklistMemory('') === null);
  // LLM 匯出工具偵測（DESIGN §20.3 第 2 項）：PATH 上找不到就照實回報；找到 optimum-cli 就標 found；onnxruntime 還沒偵測
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = path.join(dir, 'empty-bin');
    const t0 = await h.handle('studio_export_tools', {});
    check('匯出工具偵測：回 ok 與三個工具鍵', t0.ok && t0.tools.optimum && t0.tools.onnxruntime && t0.tools.llamaCpp, t0);
    check('匯出工具偵測：PATH 上沒有 optimum-cli 時 found=false 且寫原因', t0.tools.optimum.found === false && /PATH 上找不到/.test(t0.tools.optimum.reason), t0.tools.optimum);
    check('匯出工具偵測：onnxruntime 尚未偵測，寫明尚未實作', t0.tools.onnxruntime.found === false && /尚未實作/.test(t0.tools.onnxruntime.reason), t0.tools.onnxruntime);
    const binDir = path.join(dir, 'bin'); fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'optimum-cli'), '#!/bin/sh\n');
    process.env.PATH = binDir;
    const t1 = await h.handle('studio_export_tools', {});
    check('匯出工具偵測：PATH 上有 optimum-cli 就 found=true（只看存在，不執行）', t1.tools.optimum.found === true, t1.tools.optimum);
    check('匯出工具偵測：沒有的 llama.cpp 仍 found=false', t1.tools.llamaCpp.found === false, t1.tools.llamaCpp);
  } finally { process.env.PATH = savedPath; }
  console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})();
