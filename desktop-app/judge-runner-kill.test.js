'use strict';
// exec 逾時要把子行程連同子孫一起清掉（孫行程抓著管線不放時，exec 也不能無限等待）。node judge-runner-kill.test.js
const assert = require('assert'); const J = require('./judge-runner.js'); let n = 0;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    // 父行程啟動一個睡很久的孫行程（繼承 stdout），印出孫行程 pid，自己也睡
    const grand = "setInterval(()=>{},1000)";
    const parent = "const c=require('child_process').spawn(process.execPath,['-e'," + JSON.stringify(grand) + "],{detached:true,stdio:['ignore','ignore','ignore']});console.log('GRAND='+c.pid);setInterval(()=>{},1000)";
    const t0 = Date.now();
    const r = await J.exec(process.execPath, ['-e', parent], { timeoutMs: 1500 });
    const dt = Date.now() - t0; const m = /GRAND=(\d+)/.exec(r.stdout); assert.ok(m, '沒有拿到孫行程 pid：' + JSON.stringify(r).slice(0, 200)); n++;
    assert.ok(r.timedOut, '應該逾時'); n++; assert.ok(dt < 6000, 'exec 不能因孫行程無限等待：' + dt + 'ms'); n++;
    const gpid = Number(m[1]); let gone = false; for (let i = 0; i < 20 && !gone; i++) { gone = !alive(gpid); if (!gone) await sleep(250); }
    assert.ok(gone, '孫行程 ' + gpid + ' 逾時後還活著（孤兒行程）'); n++;
    if (alive(gpid)) { try { process.kill(gpid, 'SIGKILL'); } catch (e) { /* */ } }
    // 沒逾時的正常行程不受影響
    const ok = await J.exec(process.execPath, ['-e', "console.log('hi')"], { timeoutMs: 5000 }); assert.ok(!ok.timedOut && ok.code === 0 && /hi/.test(ok.stdout)); n++;
    console.log('judge-runner-kill.test.js：' + n + ' passed, 0 failed');
})().catch((e) => { console.error(e); process.exit(1); });
