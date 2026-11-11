// 評估腳本找「最新已安裝的原生執行包」：與主程式 findNativeRuntime 同一規則（新版優先、舊版退路、md5 竄改退回），且各評估腳本不再寫死版本資料夾。
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const root = path.join(__dirname, '..', '..');
const F = require(path.join(root, 'scripts', 'eval', 'find_installed_runtime.js'));
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'find-rt-'));
const proto = fs.readFileSync(path.join(root, 'nr-protocol.js'));
const mk = (ver) => {
    const d = path.join(ud, 'native-runtime', ver); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'nr-protocol.js'), proto);
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ runtimeVersion: ver, ortVersion: '1.22.0', platform: process.platform, arch: process.arch, files: { 'nr-protocol.js': { size: proto.length, md5: md5(proto) } } }));
    return d;
};
check('什麼都沒有：ok:false 並說明原因', F.findInstalledRuntime(ud).ok === false);
let threw = ''; try { F.requireInstalledRuntimeDir(ud); } catch (e) { threw = e.message; }
check('什麼都沒有：requireInstalledRuntimeDir 丟出帶原因的錯誤（不退回寫死路徑）', /找不到可用的原生執行包/.test(threw), threw);
const d1 = mk('1.22.0-1');
check('只有舊版：找到舊版資料夾', F.requireInstalledRuntimeDir(ud) === d1);
const d2 = mk('1.22.0-2');
check('新舊並存：回新版資料夾', F.requireInstalledRuntimeDir(ud) === d2 && F.findInstalledRuntime(ud).version === '1.22.0-2');
fs.appendFileSync(path.join(d2, 'nr-protocol.js'), '// 竄改');
check('新版 md5 被竄改：退回舊版（與主程式同一規則）', F.requireInstalledRuntimeDir(ud) === d1);
const cli = cp.spawnSync(process.execPath, [path.join(root, 'scripts', 'eval', 'find_installed_runtime.js'), '--user-data', ud], { encoding: 'utf8', timeout: 30000 });
check('命令列：只印資料夾', cli.status === 0 && cli.stdout.trim() === d1, cli);
const cli2 = cp.spawnSync(process.execPath, [path.join(root, 'scripts', 'eval', 'find_installed_runtime.js'), '--user-data', path.join(ud, 'nope')], { encoding: 'utf8', timeout: 30000 });
check('命令列：找不到時以 1 結束並說明原因', cli2.status === 1 && /找不到可用的原生執行包/.test(cli2.stderr), cli2);
// 評估腳本不再寫死版本資料夾
const walk = (d, out = []) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p, out); else if (/\.(js|sh)$/.test(n)) out.push(p); } return out; };
const hard = walk(path.join(root, 'scripts', 'eval')).filter((p) => /native-runtime[\\/]+1\.22\.0-\d/.test(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))).map((p) => path.relative(root, p));
check('scripts/eval 沒有寫死 native-runtime/1.22.0-N 路徑', hard.length === 0, hard);
fs.rmSync(ud, { recursive: true, force: true });
console.log(bad.length ? 'find_installed_runtime.test.js：通過 ' + ok + ' 項，失敗 ' + bad.length + ' 項：' + bad.join('；') : 'find_installed_runtime.test.js：通過 ' + ok + ' 項');
process.exit(bad.length ? 1 : 0);
