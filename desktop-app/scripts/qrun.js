#!/usr/bin/env node
'use strict';
// 安靜排隊執行器：所有測試／量測／長命令都用它跑，不彈視窗、全機同一時間只跑一個、最多用 2 個核心、低優先權。
// 用法：node scripts/qrun.js [--timeout 秒] [--cwd 目錄] [--name 名稱] -- <整條命令>
//   例：node scripts/qrun.js --timeout 900 -- node renderer/src/uml/domain_ds.test.js
// 做法：把工作寫成 JSON，放進 psmux（tmux 相容）的隱藏背景工作階段執行（一個主控台管所有工作，不會一個個跳視窗）；
// 本程式會等到它結束，把輸出與結束碼原樣交回給呼叫端，所以用起來跟直接執行一樣。
// 全機排隊鎖：os.tmpdir()/fa-qrun.lock（行程死掉的舊鎖會自動清掉）。
// 沒有 psmux／tmux 時退回「直接在隱藏的子行程跑」，其餘規則（排隊、2 核心、低優先權、隱藏視窗）照舊。
const fs = require('fs'), os = require('os'), path = require('path');
const cp = require('child_process');
const DIR = path.join(os.tmpdir(), 'fa-qrun');
const LOCK = path.join(os.tmpdir(), 'fa-qrun.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function acquire(label, maxWaitMs) {
  const t0 = Date.now();
  return (async () => {
    for (;;) {
      try { fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() })); return true; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { const o = JSON.parse(fs.readFileSync(path.join(LOCK, 'owner.json'), 'utf8')); if (!alive(o.pid)) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; } }
        catch (e2) { if (Date.now() - fs.statSync(LOCK).mtimeMs > 15000) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; } }
        if (Date.now() - t0 > maxWaitMs) return false;
        await sleep(1500);
      }
    }
  })();
}
const release = () => { try { const o = JSON.parse(fs.readFileSync(path.join(LOCK, 'owner.json'), 'utf8')); if (o.pid === process.pid) fs.rmSync(LOCK, { recursive: true, force: true }); } catch (e) {} };

function limitCores() {
  // 親和性遮罩 3 = 只用核心 0、1；子行程繼承，所以整個工作最多用 2 個核心，留 2 個給使用者
  if (process.platform !== 'win32') return;
  try { cp.spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id ' + process.pid + ').ProcessorAffinity = 3'], { windowsHide: true, timeout: 8000 }); } catch (e) {}
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
}
function killTree(child) { try { if (process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-child.pid, 'SIGKILL'); } catch (e) {} }

async function inner(id) {
  const job = JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8'));
  const logf = path.join(DIR, id + '.log'), donef = path.join(DIR, id + '.exit');
  const fd = fs.openSync(logf, 'a');
  const say = (s) => fs.writeSync(fd, s + '\n');
  const got = await acquire(job.name || id, (job.waitSec || 3600) * 1000);
  if (!got) { say('[qrun] 排隊等太久，放棄'); fs.writeFileSync(donef, '124'); return; }
  try {
    limitCores();
    say('[qrun] 開始 ' + new Date().toISOString() + ' ：' + job.cmd);
    const env = Object.assign({}, process.env, { OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', UV_THREADPOOL_SIZE: '2', FA_QRUN: '1' });
    const hide = path.join(__dirname, 'hide-child-windows.js');
    if (!/hide-child-windows/.test(env.NODE_OPTIONS || '')) env.NODE_OPTIONS = ((env.NODE_OPTIONS || '') + ' --require ' + hide.replace(/\\/g, '/')).trim();
    const child = cp.spawn(job.cmd, { shell: true, cwd: job.cwd || process.cwd(), env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; say('[qrun] 逾時 ' + job.timeoutSec + ' 秒，結束整棵行程樹'); killTree(child); }, (job.timeoutSec || 900) * 1000);
    const code = await new Promise((r) => { child.on('close', (c) => r(c)); child.on('error', (e) => { say('[qrun] 啟動失敗：' + e.message); r(127); }); });
    clearTimeout(timer);
    say('[qrun] 結束 code=' + code + (timedOut ? '（逾時）' : ''));
    fs.writeFileSync(donef, String(timedOut ? 124 : (code === null ? 1 : code)));
  } finally { release(); fs.closeSync(fd); }
}

async function outer(argv) {
  const i = argv.indexOf('--'); if (i < 0) { console.error('用法：node scripts/qrun.js [--timeout 秒] [--cwd 目錄] [--name 名稱] -- <命令>'); process.exit(2); }
  // 只有一個參數時當成完整命令字串；多個參數時逐個加引號（含空白、括號、引號的參數），避免 shell 把 -e "..." 的引號吃掉
  const q = (s) => (/[\s"'()&|<>^;,=]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s);
  const rest = argv.slice(i + 1);
  const opt = argv.slice(0, i), cmd = rest.length === 1 ? rest[0] : rest.map(q).join(' ');
  const get = (k, d) => { const j = opt.indexOf(k); return j >= 0 ? opt[j + 1] : d; };
  fs.mkdirSync(DIR, { recursive: true });
  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { cmd, cwd: path.resolve(get('--cwd', process.cwd())), timeoutSec: Number(get('--timeout', 900)), waitSec: Number(get('--wait', 3600)), name: get('--name', cmd.slice(0, 40)) };
  fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(job));
  const me = 'node "' + __filename + '" --inner ' + id;
  let usedMux = false;
  try {
    const r = cp.spawnSync('tmux', ['new-session', '-d', '-s', 'fa-' + id, me], { windowsHide: true, timeout: 15000 });
    usedMux = r.status === 0;
  } catch (e) {}
  if (!usedMux) { cp.spawn(process.execPath, [__filename, '--inner', id], { detached: true, windowsHide: true, stdio: 'ignore' }).unref(); }
  const donef = path.join(DIR, id + '.exit'), logf = path.join(DIR, id + '.log');
  let shown = 0;
  const flush = () => { try { const s = fs.readFileSync(logf); if (s.length > shown) { process.stdout.write(s.slice(shown)); shown = s.length; } } catch (e) {} };
  const hardEnd = Date.now() + (job.waitSec + job.timeoutSec + 120) * 1000;
  while (!fs.existsSync(donef)) { flush(); if (Date.now() > hardEnd) { console.error('[qrun] 等待逾時'); process.exit(124); } await sleep(1000); }
  flush();
  const code = Number(fs.readFileSync(donef, 'utf8')) || 0;
  try { cp.spawnSync('tmux', ['kill-session', '-t', 'fa-' + id], { windowsHide: true, timeout: 8000 }); } catch (e) {}
  try { for (const f of [id + '.json', id + '.exit']) fs.rmSync(path.join(DIR, f), { force: true }); } catch (e) {}
  process.exit(code);
}

const a = process.argv.slice(2);
if (a[0] === '--inner') inner(a[1]).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
else outer(a);
