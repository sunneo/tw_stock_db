// 啟動隔離的真 Electron 跑 WASM 量測（獨立 --user-data-dir、換埠，不碰使用者正在跑的環境，也不用 17923）。
// 用法：node run_wasm.js <工作資料夾> <模型資料夾> <electron.exe> <desktop-app 資料夾> [模型 id,逗號分隔]
// 同時每 500 毫秒輪詢這個行程樹的工作集（wmic），記錄峰值記憶體，寫進 <工作資料夾>\wasm_mem.json。
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const [, , WORK, MODELS, ELECTRON, APP, ONLY = ''] = process.argv;
if (!APP) { console.error('用法見檔頭'); process.exit(2); }
const esc = (s) => s.replace(/\\/g, '\\\\');
const src = fs.readFileSync(path.join(__dirname, 'wasm_bench.eval.js'), 'utf8')
  .split('__WORK__').join(esc(WORK)).split('__MODELS__').join(esc(MODELS)).split('__ONLY__').join(ONLY);
const evalFile = path.join(WORK, 'wasm_bench.run.eval.js');
fs.mkdirSync(path.join(WORK, 'out', 'wasm'), { recursive: true });
fs.writeFileSync(evalFile, src);
fs.copyFileSync(path.join(__dirname, 'bench-config.json'), path.join(WORK, 'bench-config.json'));
try { fs.unlinkSync(path.join(WORK, 'wasm.jsonl')); } catch (_) { /* 沒有就算了 */ }
const ud = path.join(WORK, 'wasm-userdata');
const PORT = String(17960 + Math.floor(Math.random() * 30)); // 絕不用 17923
const env = Object.assign({}, process.env, { FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: PORT, FA_DEBUG_EVAL_FILE: evalFile });
delete env.ELECTRON_RUN_AS_NODE;
const child = cp.spawn(ELECTRON, [APP, '--user-data-dir=' + ud, '--no-sandbox', '--disable-gpu'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
let peakTree = 0, peakMain = 0;
const poll = setInterval(() => {
  try {
    // wmic csv 欄位順序：Node,ParentProcessId,ProcessId,WorkingSetSize
    const out = cp.execFileSync('wmic', ['process', 'get', 'ProcessId,ParentProcessId,WorkingSetSize', '/format:csv'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const rows = out.split(/\r?\n/).map((l) => l.trim().split(',')).filter((c) => c.length >= 4 && /^\d+$/.test(c[2]));
    const by = new Map(rows.map((c) => [+c[2], { ppid: +c[1], ws: +c[3] }]));
    const tree = new Set([child.pid]); let grew = true;
    while (grew) { grew = false; for (const [pid, v] of by) if (!tree.has(pid) && tree.has(v.ppid)) { tree.add(pid); grew = true; } }
    let sum = 0; for (const pid of tree) if (by.has(pid)) sum += by.get(pid).ws;
    if (sum > peakTree) peakTree = sum;
    const main = by.get(child.pid); if (main && main.ws > peakMain) peakMain = main.ws;
  } catch (_) { /* 輪詢失敗就跳過這一次 */ }
}, 500);
const killer = setTimeout(() => { try { child.kill(); } catch (_) { /* 已結束 */ } }, +process.env.NAB_WASM_CAP_MS || 40 * 60 * 1000);
child.on('exit', (code) => {
  clearInterval(poll); clearTimeout(killer);
  fs.writeFileSync(path.join(WORK, 'wasm_mem.json'), JSON.stringify({ peak_tree_mb: Math.round(peakTree / 1048576), peak_main_mb: Math.round(peakMain / 1048576), port: PORT }));
  fs.writeFileSync(path.join(WORK, 'wasm_electron.log'), log.slice(-6000));
  console.log('electron 結束', code, '行程樹峰值工作集 MB', Math.round(peakTree / 1048576));
});
