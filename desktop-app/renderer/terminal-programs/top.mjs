// tw_stock_db客製: 2026-09-18——WASM沙盒沒有fork/exec，也就沒有其他process
// 可以列（wasi-sh README「No processes, ever」），真正的`top`在這裡完全沒有
// 資料來源。這不是重現`top`的process table，是一個誠實承認限制的替代品：
// 只顯示這個終端機session自己的資訊（存活時間、目前工作目錄），每秒重繪一次
// 維持「像top一樣會動」的體感，按q離開。透過registerTerminalProgram()掛在
// `top`這個指令名稱上（見floating-assistant.js的TERMINAL_PROGRAM_BUNDLES）。
//
// ctx契約見pager.mjs開頭的說明，額外用到這裡才新增的ctx.readKeyOrTimeout(ms)
// （沒按鍵時逾時resolve(null)，讓畫面可以定時重繪，不是永遠卡在readKey()等
// 下一個按鍵）跟ctx.sessionStartedAt（這個終端機session掛載的時間戳）。

function formatUptime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

export async function run(ctx) {
    const draw = () => {
        const now = Date.now();
        const uptime = formatUptime(now - (ctx.sessionStartedAt || now));
        const clock = new Date(now).toTimeString().slice(0, 8);
        const lines = [
            `top - ${clock} up ${uptime}, 1 session（WASM沙盒：沒有真正的process，這裡只顯示這個終端機session自己）`,
            '',
            'PID USER     CMD                  STATE    UPTIME',
            `  1 guest    ash（本session）      running  ${uptime}`,
            '',
            `cwd: ${ctx.cwd}`,
            '',
            '[q]離開，畫面每秒自動重整',
        ];
        ctx.write('\x1b[2J\x1b[H' + lines.join('\n'));
    };

    for (;;) {
        draw();
        const key = await ctx.readKeyOrTimeout(1000);
        if (key === null) continue; // 逾時＝這一輪沒有按鍵，單純重繪
        if (key === 'q' || key === '\x03') return;
    }
}
