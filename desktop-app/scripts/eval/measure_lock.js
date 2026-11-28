'use strict';
// 全域量測鎖（真 Electron 量測與 cpu-py 基準共用）。mkdir 是原子的：成功＝取得，失敗＝別人在量。
// 規則：取不到就等 30 秒再試；鎖內 owner.txt 寫工作階段名稱與時間；鎖超過 20 分鐘視為殘留，可清除後重取；量完 rmdir。
// 同步版（Atomics.wait 睡眠），讓量測腳本在鎖取得前不跑任何負載。
//   const lock = acquireSync('工作階段名'); → { dir, cpuBefore }（cpuBefore：取鎖後量測前 10 秒的處理器使用率）
//   releaseSync()；腳本結束時會自動 releaseSync（process.on('exit')）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DIR = 'E:/Temp/fa-measure.lock';
const RETRY_MS = 30000, STALE_MS = 20 * 60 * 1000;
let held = null;

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function cpuTotals() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const k of Object.keys(c.times)) total += c.times[k]; idle += c.times.idle; }
  return { idle, total };
}
// 取樣期間的處理器使用率（百分比）；預設 10 秒。會實際睡 ms 毫秒。
function sampleCpuSync(ms = 10000) {
  const a = cpuTotals(), t0 = Date.now();
  sleepMs(ms);
  const b = cpuTotals();
  const busy = (b.total - a.total) - (b.idle - a.idle), tot = b.total - a.total;
  return { percent: tot > 0 ? Math.round(busy / tot * 1000) / 10 : null, seconds: (Date.now() - t0) / 1000, cores: os.cpus().length };
}

function acquireSync(owner, opts) {
  const dir = (opts && opts.dir) || DEFAULT_DIR;
  const log = (opts && opts.log) || ((m) => console.log(m));
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.txt'), JSON.stringify({ owner, since: new Date().toISOString(), pid: process.pid }, null, 2), 'utf8');
      held = dir;
      process.once('exit', () => releaseSync());
      const cpuBefore = sampleCpuSync(10000);
      return { dir, held: true, cpuBefore };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0, who = '?';
      try { age = Date.now() - fs.statSync(dir).mtimeMs; who = fs.readFileSync(path.join(dir, 'owner.txt'), 'utf8').replace(/\s+/g, ' ').slice(0, 200); } catch (_) { /* 讀不到就當作剛建立 */ }
      if (age > STALE_MS) {
        log('[measure-lock] 殘留鎖（' + Math.round(age / 60000) + ' 分鐘），清除後重取：' + who);
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      log('[measure-lock] 別人在量（' + who + '），30 秒後再試');
      sleepMs(RETRY_MS);
    }
  }
}

function releaseSync() {
  if (!held) return false;
  try { fs.rmSync(held, { recursive: true, force: true }); } catch (_) { /* 已清 */ }
  held = null;
  return true;
}

module.exports = { acquireSync, releaseSync, sampleCpuSync, DEFAULT_DIR };
