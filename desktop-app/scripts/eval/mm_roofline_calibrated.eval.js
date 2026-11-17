// 真桌面版（Electron，真 GPU）：驗證「安全校準」的屋頂量測（不是再量屋頂峰值），並找出 64×1024×1024 沒有勝者的原因。
// 做一次「重跑變體競賽」，然後回報：
//   (1) TUNE.roofline：校準結果（迭代數、每次派發毫秒數）或「屋頂量測不可信」的原因（中止條件是任何派發 > 150 ms，見 mm_ops.js 的 rooflineCalibrate）
//   (2) 每個形狀的候選：驗證不過（bad）與預估逾時略過（skipped）的逐一原因
//   (3) 狀態列與表格的勝者
// 用法：node scripts/eval/mm_race_configure.run.js mm_roofline_calibrated
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(100); } return null; };
R.hasApi = !!(fa && fa._gpuVariantPanel && fa._gpuBenchShapesList);
R.gpu = !!navigator.gpu;
const panel = R.hasApi ? fa._gpuVariantPanel() : null;
if (panel) document.body.appendChild(panel);
R.tableReady = !!(panel && await until(() => panel.children[4] && panel.children[4].querySelector('table'), 20000));
const btn = panel ? [...panel.querySelectorAll('button')].find((b) => b.textContent === '重跑變體競賽') : null;
R.hasButton = !!btn;
const statusEl = panel ? panel.children[2] : null;
if (btn) btn.click();
const finalStatus = /競賽完成|已取消|沒有 GPU|競賽失敗/;
R.finished = !!(await until(() => statusEl && finalStatus.test(statusEl.textContent) && !btn.disabled, 300000));
await wait(1500);
R.statusAfter = statusEl ? statusEl.textContent : null;
const mm = fa._qwenModule ? fa._qwenModule().mm : null;
R.roofline = mm && mm.TUNE ? mm.TUNE.roofline : null;
// 每個形狀的逐一原因（來自 UI 記下的競賽結果）
const last = fa._gpuRaceLast || {};
R.raceLast = Object.keys(last).map((k) => ({ shape: k, error: last[k].error || null, bad: last[k].bad || [], skipped: last[k].skipped || [] }));
// 表格的勝者與來源欄
const tbl = panel && panel.children[4] ? panel.children[4].querySelector('table') : null;
const rows = tbl ? [...tbl.querySelectorAll('tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent)) : [];
R.rowCount = rows.length;
R.winners = rows.filter((c) => /勝者/.test(c[9])).map((c) => ({ shape: c[0], variant: c[1], medianMs: c[3], gflops: c[4], compileMs: c[6] }));
R.rowSources = rows.map((c) => c[0] + ' ' + c[1] + ' → ' + c[8]);
const info = panel && panel.children[1] ? panel.children[1].textContent : null;
R.infoAfter = info;
// (3) GPU 驗證（同一次 eval，不另外開）：轉置路徑、批次路徑（宿主 matmul_many）、gemv（既有核心）；都對 CPU 參考比對。
// gemv 的小 M 路徑還沒實作，這裡只驗既有的 gemv。
const MMm = mm;
const rnd = (n, s) => { let x = s; return Float32Array.from({ length: n }, () => { x = (Math.imul(x, 1664525) + 1013904223) | 0; return ((x >>> 0) / 4294967296) - 0.5; }); };
const maxErr = (got, want) => { let d = 0; for (let i = 0; i < want.length; i++) d = Math.max(d, Math.abs(Number(got[i]) - Number(want[i]))); return d; };
R.gpuChecks = {};
try {
  const M = 64, K = 64, N = 64;
  const An = rnd(M * K, 5), Bn = rnd(K * N, 7);
  const want = MMm.matmulRef(An, [M, K], Bn, [K, N]).y;
  // 轉置：A 以 K×M 儲存（transA）、B 以 N×K 儲存（transB），邏輯維度仍是 M、K、N
  const As = new Float32Array(M * K); for (let i = 0; i < M; i++) for (let k = 0; k < K; k++) As[k * M + i] = An[i * K + k];
  const Bs = new Float32Array(K * N); for (let k = 0; k < K; k++) for (let j = 0; j < N; j++) Bs[j * K + k] = Bn[k * N + j];
  const o1 = { navigator: navigator, transA: true, transB: true };
  const r1 = await MMm.matmul(As, [M, K], Bs, [K, N], o1);
  R.gpuChecks.transpose = { layer: o1.lastInfo && o1.lastInfo.layer, maxErr: maxErr(r1.y, want) };
} catch (e) { R.gpuChecks.transposeError = String((e && e.message) || e).slice(0, 200); }
try {
  const M = 64, K = 64, N = 64;
  const An = rnd(M * K, 5), Bn = rnd(K * N, 7);
  const want = MMm.matmulRef(An, [M, K], Bn, [K, N]).y;
  const items = [[Array.from(An), Array.from(Bn), M, K, N], [Array.from(An), Array.from(Bn), M, K, N]];
  const bo = await fa._cudawebCall('matmul_many', { items: items });
  R.gpuChecks.batch = { groups: bo.length, maxErr: Math.max(maxErr(bo[0], want), maxErr(bo[1], want)) };
} catch (e) { R.gpuChecks.batchError = String((e && e.message) || e).slice(0, 200); }
try {
  const M = 64, N = 64;
  const A = rnd(M * N, 11), xv = rnd(N, 13);
  const gw = new Float64Array(M); for (let i = 0; i < M; i++) { let s = 0; for (let j = 0; j < N; j++) s += A[i * N + j] * xv[j]; gw[i] = s; }
  const gy = await fa._cudawebCall('gemv', { a: Array.from(A), x: Array.from(xv), m: M, n: N });
  R.gpuChecks.gemv = { len: gy.length, maxErr: maxErr(gy, gw) };
} catch (e) { R.gpuChecks.gemvError = String((e && e.message) || e).slice(0, 200); }
if (panel) panel.remove();
return R;
