// 測試 scripts/cleanup-orphans.js：
//  1. 只列出（findOrphans）不殺任何行程
//  2. 清除（killOrphans）只殺命令列含標記的行程，無關行程與 powershell 自己都不受影響
// 執行：node scripts/cleanup-orphans.test.js（非 Windows 直接略過，結束碼 0）
const cp = require('child_process');
const path = require('path');
const { findOrphans, killOrphans } = require('./cleanup-orphans.js');

if (process.platform !== 'win32') { console.log('略過：非 Windows'); process.exit(0); }

const mark = 'fa-cold-CLEANTEST' + Date.now();
const victim = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},100000)', path.join('C:/tmp', mark)], { stdio: 'ignore' });
const bystander = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},100000)', 'unrelated-' + Date.now()], { stdio: 'ignore' });
const alive = (p) => { try { process.kill(p.pid, 0); return true; } catch (_) { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, ok) => { checks.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name); };

(async () => {
    try {
        await sleep(1500); // 等子行程起來
        const listed = findOrphans(mark);
        check('只列出：找得到標記行程', Array.isArray(listed) && listed.some((p) => p.ProcessId === victim.pid));
        check('只列出：不殺任何行程（標記行程仍活著）', alive(victim));
        check('只列出：無關行程仍活著', alive(bystander));

        const killed = killOrphans(mark);
        await sleep(1000);
        check('清除：回報有清到標記行程', Array.isArray(killed) && killed.some((p) => p.ProcessId === victim.pid));
        check('清除：標記行程已死', !alive(victim));
        check('清除：無關行程仍活著', alive(bystander));
        check('清除：測試程序本身沒被殺（能走到這裡即是）', true);
    } catch (e) {
        check('例外：' + e.message, false);
    } finally {
        try { victim.kill(); } catch (_) { /* */ }
        try { bystander.kill(); } catch (_) { /* */ }
        const failed = checks.filter((x) => !x).length;
        console.log('\n' + (checks.length - failed) + '／' + checks.length + ' 項通過');
        process.exit(failed ? 1 : 0);
    }
})();
