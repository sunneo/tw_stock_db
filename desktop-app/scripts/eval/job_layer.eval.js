// job 執行層（真實 Electron）：不開終端機就跑 node／shell／python 程式；GUI 視窗的快照、事件注入、截圖；swap 走真的 IndexedDB。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/job_layer.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
R.tools = ['job_run', 'job_gui', 'job_list', 'job_stop'].every((n) => !!fa.tools[n]);
// 1. node：console.log，沒開終端機
let r = await tool('job_run', { lang: 'node', code: 'console.log("hi " + (1+2));' });
R.node = { ok: r.ok, exit: r.exit_code, out: (r.output || '').trim(), running: r.running };
// 2. shell
r = await tool('job_run', { lang: 'shell', code: 'echo hello; ls /work/examples' });
R.shell = { exit: r.exit_code, has_examples: /node/.test(r.output) && /python/.test(r.output) && /llc/.test(r.output), out: (r.output || '').slice(0, 80) };
await fa._envSwap().setHotBytes(256 * 1024);   // 讓主機端的熱區也很小，頁面真的落到 IndexedDB
// 3. node＋真的 IndexedDB swap：熱區 1 MB，陣列 8 MB（f32，2M 個）
r = await tool('job_run', { lang: 'node', timeout_s: 120, code: `
await swap.hotMB(1);
const a = swap.array(2097152, 'f32'); const n = 262144; let s = 0;
for (let i = 0; i < 2097152; i += n) { const b = new Float32Array(n); for (let k = 0; k < n; k++) b[k] = (i + k) % 7; await a.set(i, b); }
await a.map((b) => { for (let k = 0; k < b.length; k++) s += b[k]; });
const st = await swap.stats();
console.log('sum=' + s + ' writes=' + st.writes + ' reads=' + st.reads + ' disk=' + (st.host.diskBytes || 0));
` });
const m = /sum=(\d+) writes=(\d+) reads=(\d+) disk=(\d+)/.exec(r.output || '');
let expect = 0; for (let i = 0; i < 2097152; i++) expect += i % 7;
R.swap_node = { exit: r.exit_code, out: (r.output || '').trim(), sum_ok: !!m && Number(m[1]) === expect, wrote: !!m && Number(m[2]) > 0, read: !!m && Number(m[3]) > 0, disk_mb: m ? Math.round(Number(m[4]) / 1048576) : null };
R.swap_after = fa._envSwap().stats().items;   // 程式結束後 space 要清掉
// 4. GUI 遊戲（node snake）：detach → 視窗與節點 → 注入按鍵 → 截圖 → 停止
const snake = await (await fetch('examples/node/game/snake.js').catch(() => null))?.text?.().catch(() => null);
const src = (typeof FA_PY_EXAMPLES !== 'undefined' && FA_PY_EXAMPLES['node/game/snake.js']) || null;
R.example_seeded = !!src;
r = await tool('job_run', { lang: 'node', code: src || 'await gui.open("x")', detach: true, timeout_s: 60 });
const jid = r.job_id; R.dbg_run = { ok: r.ok, err: r.error, running: r.running, job: !!jid, out: (r.output || '').slice(0, 300) }; if (!jid) { console.log('JOB_RESULT ' + JSON.stringify(R)); return R; } await wait(500);
let g = await tool('job_gui', { job_id: jid, action: 'snapshot' }); if (!g.windows) { R.dbg_gui = g; console.log('JOB_RESULT ' + JSON.stringify(R)); return R; }
const canvas = (g.windows[0] && g.windows[0].nodes.find((n) => n.kind === 'canvas')) || null;
R.gui = { running: g.running, windows: g.windows.length, title: g.windows[0] && g.windows[0].title, canvas: canvas && { id: canvas.id, w: canvas.width, h: canvas.height } };
if (canvas) {
  const k = await tool('job_gui', { job_id: jid, action: 'key', node: canvas.id, value: { key: 'ArrowDown', down: true }, wait_ms: 700 });
  R.gui.key_ok = k.ok === true;
  const shot = await tool('job_gui', { job_id: jid, action: 'screenshot', canvas: 0 });
  R.gui.shot = shot.ok ? { bytes: shot.screenshot.bytes } : { error: shot.error };
}
const bad = await tool('job_gui', { job_id: jid, action: 'click', node: 'nope' }); R.gui.bad_node_error = bad.ok === false;
r = await tool('job_stop', { job_id: jid }); let waited = 0; while (waited < 4000 && (await tool('job_list', {})).jobs.find((j) => j.job_id === jid).running) { await wait(200); waited += 200; }
R.stopped = { stopped: (await tool('job_list', {})).jobs.find((j) => j.job_id === jid).running === false, waited_ms: waited, exit: (await tool('job_list', {})).jobs.find((j) => j.job_id === jid).exit_code };
// 5. python（要下載 Pyodide；沒網路時回報但不算失敗）
try {
  r = await tool('job_run', { lang: 'python', timeout_s: 180, code: 'import numpy as np, fa_swap\na = fa_swap.array((2000, 64), "float32")\na[:] = np.arange(2000*64, dtype="float32").reshape(2000,64)\nprint("py", float(a[1999, 63]), fa_swap.stats()["backend"])' });
  R.python = { exit: r.exit_code, out: (r.output || '').trim().slice(-700) };
} catch (e) { R.python = { error: String(e.message || e) }; }
R.ok = R.stopped.stopped && R.swap_node.disk_mb > 0 && R.tools && R.node.out === 'hi 3' && R.shell.has_examples && R.swap_node.sum_ok && R.swap_node.wrote && R.swap_node.read && R.gui.windows === 1 && !!R.gui.canvas && R.gui.bad_node_error;
console.log('JOB_RESULT ' + JSON.stringify(R));
return R;
