// tw_stock_db客製: 2026-09-18使用者要求——WASM沙盒裡的busybox沒有fork/exec，
// 官方README明確把less列在scope之外，這裡是JS重寫的簡化版pager，透過
// registerTerminalProgram()掛到less/more這兩個指令名稱上（見
// floating-assistant.js的_ensureTerminalProgramLoaded/TERMINAL_PROGRAM_BUNDLES
// 說明）。不是完整重現less的所有功能（沒有/搜尋、沒有正規表示式高亮），
// 只做最常用的：翻頁瀏覽一個文字檔、q離開。
//
// ctx契約（呼叫端_runTerminalProgramBundle()提供，見該方法說明）：
//   ctx.write(text)    輸出到終端機（\n會被呼叫端自動轉成\r\n，這裡不用管）
//   ctx.readKey()      回傳Promise<string>，resolve下一個按鍵/貼上的原始輸入
//   ctx.fs()           async，回傳目前session共用的wasi-sh MemoryFs實例
//   ctx.cwd            目前虛擬工作目錄（呼叫當下的snapshot）
//   ctx.args           指令列參數陣列（args[0]應該是檔名）
//   ctx.cols/ctx.rows  終端機尺寸（呼叫當下的snapshot，不會隨即時resize更新）

function resolvePath(cwd, target) {
    const raw = target.startsWith('/') ? target : `${cwd}/${target}`;
    const parts = raw.split('/').filter((x) => x && x !== '.');
    const stack = [];
    for (const part of parts) { if (part === '..') stack.pop(); else stack.push(part); }
    return '/' + stack.join('/');
}

async function readFileText(fs, absPath) {
    const stat = fs.statSync(absPath);
    const buf = new Uint8Array(stat.size);
    fs.readSync(absPath, buf, 0, stat.size);
    return new TextDecoder('utf-8').decode(buf);
}

export async function run(ctx) {
    const prog = ctx.name || 'less';
    const filename = ctx.args[0];
    if (!filename) { ctx.write(`usage: ${prog} <檔案路徑>\n`); return; }
    const abs = resolvePath(ctx.cwd, filename);
    const fs = await ctx.fs();
    let text;
    try {
        text = await readFileText(fs, abs);
    } catch (err) {
        ctx.write(`${prog}: ${filename}: 讀取失敗（${String((err && err.message) || err)}）\n`);
        return;
    }
    const lines = text.split('\n');
    const visibleRows = Math.max(1, ctx.rows - 1); // 留最後一行當狀態列
    let top = 0;
    const maxTop = Math.max(0, lines.length - visibleRows);

    const draw = () => {
        const page = lines.slice(top, top + visibleRows);
        const percent = maxTop === 0 ? 100 : Math.round((top / maxTop) * 100);
        let out = '\x1b[2J\x1b[H'; // 清畫面、游標回原點
        out += page.join('\n');
        // 補滿剩下的空行，避免舊頁殘留內容（沙盒沒有真正的差異更新，每次
        // 都整頁重畫最簡單可靠）。
        for (let i = page.length; i < visibleRows; i++) out += '\n';
        out += `\n\x1b[7m-- ${filename} (${percent}%) -- [space/f]下頁 [b]上頁 [j/k或↑↓]單行 [g/G]頭/尾 [q]離開\x1b[0m`;
        ctx.write(out);
    };

    draw();
    for (;;) {
        const key = await ctx.readKey();
        if (key === 'q' || key === '\x03') return;
        if (key === ' ' || key === 'f' || key === '\r' || key === '\x06') top = Math.min(maxTop, top + visibleRows);
        else if (key === 'b' || key === '\x02') top = Math.max(0, top - visibleRows);
        else if (key === 'j' || key === '\x1b[B') top = Math.min(maxTop, top + 1);
        else if (key === 'k' || key === '\x1b[A') top = Math.max(0, top - 1);
        else if (key === 'g') top = 0;
        else if (key === 'G') top = maxTop;
        else continue; // 其餘按鍵忽略，不重畫（維持目前頁面）
        draw();
    }
}
