#!/usr/bin/env node
// 清除本專案自己留下的殘留行程（2026-11-16）。
// 用法：
//   node scripts/cleanup-orphans.js          只列出（預設，不殺任何行程）
//   node scripts/cleanup-orphans.js --kill   列出並清除
//
// 判斷依據：命令列含本專案獨有的暫存 user-data-dir 標記（預設 "fa-cold-"，即 web-cold-load-headless.js 的 Chrome 暫存資料夾）。
// 使用者自己的 Chrome、Claude 的 MCP、其他工具的行程都沒有這個標記，不會被碰。
// 標記走環境變數傳進 powershell，不放在命令列裡（否則 powershell 自己會符合條件，把自己殺掉）；並排除自己的 PID。
// 只在 Windows 有效；其他系統直接回報略過。

const cp = require('child_process');

const DEFAULT_MARK = 'fa-cold-';

const PS_LIST = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($env:FA_CLEAN_MARK) } | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress";
const PS_KILL = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($env:FA_CLEAN_MARK) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";

function runPs(script, mark) {
    const env = Object.assign({}, process.env, { FA_CLEAN_MARK: mark });
    return cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000, env });
}

// 回傳符合標記的殘留行程清單（陣列；沒有就是空陣列）。非 Windows 或查詢失敗回傳 null。
function findOrphans(mark = DEFAULT_MARK) {
    if (process.platform !== 'win32') return null;
    const r = runPs(PS_LIST, mark);
    if (r.error || r.status !== 0) return null;
    const txt = String(r.stdout || '').trim();
    if (!txt) return [];
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [parsed];
}

// 清除符合標記的殘留行程，回傳清除前列出的行程（清除失敗時回傳 null）。
function killOrphans(mark = DEFAULT_MARK) {
    const before = findOrphans(mark);
    if (before === null) return null;
    if (before.length === 0) return before;
    const r = runPs(PS_KILL, mark);
    if (r.error) return null;
    return before;
}

module.exports = { findOrphans, killOrphans, DEFAULT_MARK };

if (require.main === module) {
    const kill = process.argv.includes('--kill');
    if (process.platform !== 'win32') {
        console.log('清除殘留行程：非 Windows，略過。');
        process.exit(0);
    }
    const list = kill ? killOrphans() : findOrphans();
    if (list === null) {
        console.log('清除殘留行程：查詢失敗（powershell 無法執行），略過。');
        process.exit(0);
    }
    if (list.length === 0) {
        console.log('清除殘留行程：沒有符合標記（' + DEFAULT_MARK + '）的殘留。');
    } else {
        console.log((kill ? '已清除' : '找到（未清除，加 --kill 才會清）') + ' ' + list.length + ' 個殘留行程：');
        for (const p of list) console.log('  PID ' + p.ProcessId + '（父 ' + p.ParentProcessId + '）' + p.Name + '：' + String(p.CommandLine || '').slice(0, 120));
    }
    process.exit(0);
}
