// 極小的測試框架（跟 scripts/edit-tests 同風格：check(name, cond)，結尾印 "N passed"／"FAILED"）
'use strict';
function suite(title) {
    let ok = 0; const bad = []; const pending = [];
    const api = {
        check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + safe(extra) : '')); },
        // 非同步測項：回傳 promise；例外算失敗
        async acheck(name, fn) { try { const r = await fn(); if (r === true || (r && r.ok === true)) ok++; else bad.push(name + ' -> ' + safe(r)); } catch (e) { bad.push(name + ' 例外：' + ((e && e.stack) || e).toString().slice(0, 400)); } },
        skip(name, why) { console.log('SKIP ' + name + '：' + why); },
        done() { console.log(title + ': ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ', 0 failed')); process.exit(bad.length ? 1 : 0); },
        get failed() { return bad.length; },
    };
    function safe(x) { try { return JSON.stringify(x).slice(0, 500); } catch (_) { return String(x).slice(0, 500); } }
    return api;
}
module.exports = { suite };
