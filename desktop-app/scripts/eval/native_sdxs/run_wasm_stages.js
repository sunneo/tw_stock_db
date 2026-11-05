// 用法：node run_wasm_stages.js <OUT 資料夾> <MODELS> <electron.exe> <desktop-app> [THREADS] [GOPT]；埠 17960+，不用 17923
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [, , OUT, MODELS, ELECTRON, APP, THREADS = '', GOPT = ''] = process.argv;
const fwd = (p) => p.replace(/\\/g, '/');
const src = fs.readFileSync(path.join(__dirname, 'wasm_stages.eval.js'), 'utf8').split('__MODELS__').join(fwd(MODELS)).split('__OUT__').join(fwd(OUT)).split('__THREADS__').join(THREADS).split('__GOPT__').join(GOPT);
const evalFile = path.join(OUT, 'wasm_stages.run.eval.js'); fs.writeFileSync(evalFile, src);
try { fs.unlinkSync(path.join(OUT, 'wasm-result.json')); } catch (_) { /* */ }
const PORT = String(17960 + Math.floor(Math.random() * 30));
const env = Object.assign({}, process.env, { FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: PORT, FA_DEBUG_EVAL_FILE: evalFile }); delete env.ELECTRON_RUN_AS_NODE;
const child = cp.spawn(ELECTRON, [APP, '--user-data-dir=' + path.join(OUT, 'wasm-userdata' + (THREADS || 'd')), '--no-sandbox', '--disable-gpu'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const killer = setTimeout(() => { try { child.kill(); } catch (_) { /* */ } }, 15 * 60 * 1000);
const poll = setInterval(() => { try { const r = JSON.parse(fs.readFileSync(path.join(OUT, 'wasm-result.json'), 'utf8')); if (r.steps.some((s) => s.step === 'done')) { clearInterval(poll); setTimeout(() => child.kill(), 3000); } } catch (_) { /* */ } }, 3000);
child.on('exit', (c) => { clearTimeout(killer); clearInterval(poll); fs.writeFileSync(path.join(OUT, 'wasm-electron.log'), log.slice(-4000)); console.log('electron 結束', c, '埠', PORT); });
