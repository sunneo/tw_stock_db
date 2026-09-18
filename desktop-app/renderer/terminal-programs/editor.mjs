// tw_stock_db客製: 2026-09-18使用者要求——WASM沙盒沒有fork/exec，真正的vi/
// vim在這裡跑不起來（見wasi-sh README的scope說明），這是JS重寫的極簡版
// modal editor，透過registerTerminalProgram()掛到vi/vim這兩個指令名稱上
// （見floating-assistant.js的_ensureTerminalProgramLoaded說明）。刻意只做
// 「開檔、移動游標、插入/刪除文字、存檔離開」這條最小可用路徑，不是完整
// 重現vim的所有指令/模式（沒有visual mode、沒有復原/取代、沒有正規表示式
// 搜尋替換），滿足「可以編輯一個檔案」這個實用需求。
//
// ctx契約見pager.mjs開頭的說明（同一份約定）。

function resolvePath(cwd, target) {
    const raw = target.startsWith('/') ? target : `${cwd}/${target}`;
    const parts = raw.split('/').filter((x) => x && x !== '.');
    const stack = [];
    for (const part of parts) { if (part === '..') stack.pop(); else stack.push(part); }
    return '/' + stack.join('/');
}

async function readFileTextOrEmpty(fs, absPath) {
    try {
        const stat = fs.statSync(absPath);
        const buf = new Uint8Array(stat.size);
        fs.readSync(absPath, buf, 0, stat.size);
        return new TextDecoder('utf-8').decode(buf);
    } catch (_) {
        return null; // 檔案不存在——vi開一個新檔一樣合法，等:w才真的建立
    }
}

// 整份覆寫寫入：writeSync只會長不會縮（見wasi-sh的fs.mjs說明），存檔前
// 先unlink+createFile重新建立，確保檔案長度跟目前內容完全一致，不會殘留
// 舊內容縮短前多出來的尾端字元。
function overwriteFile(fs, absPath, text) {
    try { fs.unlinkSync(absPath); } catch (_) { /* 不存在就直接建立 */ }
    fs.createFileSync(absPath);
    const bytes = new TextEncoder().encode(text);
    fs.writeSync(absPath, bytes, 0);
}

export async function run(ctx) {
    const prog = ctx.name || 'vi';
    const filename = ctx.args[0];
    if (!filename) { ctx.write(`usage: ${prog} <檔案路徑>\n`); return; }
    const abs = resolvePath(ctx.cwd, filename);
    const fs = await ctx.fs();
    const initialText = await readFileTextOrEmpty(fs, abs);
    const state = {
        lines: (initialText === null ? [''] : initialText.split('\n')),
        isNew: initialText === null,
        row: 0, col: 0,
        scrollTop: 0,
        mode: 'normal', // 'normal' | 'insert' | 'command'
        commandBuffer: '',
        modified: false,
        pendingKey: '', // 'd'等待第二個鍵組成dd這類雙鍵指令
        statusMsg: '',
    };
    state.statusMsg = initialText === null ? `"${filename}" [新檔案]` : `"${filename}" ${state.lines.length}行`;

    const bodyRows = Math.max(1, ctx.rows - 1); // 最後一行當狀態列

    const clampCursor = () => {
        state.row = Math.max(0, Math.min(state.lines.length - 1, state.row));
        const lineLen = state.lines[state.row].length;
        const maxCol = state.mode === 'insert' ? lineLen : Math.max(0, lineLen - 1);
        state.col = Math.max(0, Math.min(maxCol, state.col));
        if (state.row < state.scrollTop) state.scrollTop = state.row;
        if (state.row >= state.scrollTop + bodyRows) state.scrollTop = state.row - bodyRows + 1;
    };

    const draw = () => {
        clampCursor();
        let out = '\x1b[2J\x1b[H';
        const visible = state.lines.slice(state.scrollTop, state.scrollTop + bodyRows);
        out += visible.join('\n');
        for (let i = visible.length; i < bodyRows; i++) out += '\n~';
        const modeLabel = state.mode === 'insert' ? '-- INSERT --' : state.mode === 'command' ? ':' + state.commandBuffer : (state.modified ? '[+]' : '');
        out += `\n\x1b[7m${state.statusMsg}  ${modeLabel}\x1b[0m`;
        // 游標定位（ANSI是1-based）：內容區在最上面，狀態列固定在最後一行。
        const cursorScreenRow = (state.row - state.scrollTop) + 1;
        const cursorScreenCol = (state.mode === 'command' ? state.commandBuffer.length + 2 : state.col + 1);
        const cursorRowFinal = state.mode === 'command' ? bodyRows + 1 : cursorScreenRow;
        out += `\x1b[${cursorRowFinal};${cursorScreenCol}H`;
        ctx.write(out);
    };

    const enterInsert = (afterCursor) => {
        if (afterCursor && state.lines[state.row].length > 0) state.col++;
        state.mode = 'insert';
        state.statusMsg = filename;
    };

    const execCommand = () => {
        const cmd = state.commandBuffer.trim();
        state.commandBuffer = '';
        state.mode = 'normal';
        if (cmd === 'w' || cmd === 'wq' || cmd === 'x') {
            overwriteFile(fs, abs, state.lines.join('\n'));
            state.modified = false;
            state.statusMsg = `"${filename}" 已寫入`;
            if (cmd === 'wq' || cmd === 'x') return 'quit';
        } else if (cmd === 'q') {
            if (state.modified) { state.statusMsg = '有未儲存的變更（用:q!放棄、或:wq存檔後離開）'; return; }
            return 'quit';
        } else if (cmd === 'q!') {
            return 'quit';
        } else if (cmd) {
            state.statusMsg = `不認得的指令：${cmd}`;
        }
        return null;
    };

    draw();
    for (;;) {
        const key = await ctx.readKey();

        if (state.mode === 'insert') {
            if (key === '\x1b') { state.mode = 'normal'; if (state.col > 0) state.col--; }
            else if (key === '\r') {
                const line = state.lines[state.row];
                const before = line.slice(0, state.col);
                const after = line.slice(state.col);
                state.lines.splice(state.row, 1, before, after);
                state.row++; state.col = 0; state.modified = true;
            } else if (key === '\x7f' || key === '\b') {
                if (state.col > 0) {
                    const line = state.lines[state.row];
                    state.lines[state.row] = line.slice(0, state.col - 1) + line.slice(state.col);
                    state.col--; state.modified = true;
                } else if (state.row > 0) {
                    const prevLen = state.lines[state.row - 1].length;
                    state.lines[state.row - 1] += state.lines[state.row];
                    state.lines.splice(state.row, 1);
                    state.row--; state.col = prevLen; state.modified = true;
                }
            } else if (key.length && key.charCodeAt(0) >= 32) {
                const line = state.lines[state.row];
                state.lines[state.row] = line.slice(0, state.col) + key + line.slice(state.col);
                state.col += key.length; state.modified = true;
            }
        } else if (state.mode === 'command') {
            if (key === '\x1b') { state.mode = 'normal'; state.commandBuffer = ''; }
            else if (key === '\r') { if (execCommand() === 'quit') return; }
            else if (key === '\x7f' || key === '\b') {
                if (state.commandBuffer.length) state.commandBuffer = state.commandBuffer.slice(0, -1);
                else state.mode = 'normal';
            } else if (key.length && key.charCodeAt(0) >= 32) state.commandBuffer += key;
        } else { // normal
            if (state.pendingKey === 'd' && key === 'd') {
                if (state.lines.length > 1) state.lines.splice(state.row, 1);
                else state.lines[0] = '';
                state.modified = true;
                state.pendingKey = '';
            } else if (key === 'd') {
                state.pendingKey = 'd';
                continue; // 不重畫、等下一個鍵
            } else {
                state.pendingKey = '';
                if (key === 'h' || key === '\x1b[D') state.col--;
                else if (key === 'l' || key === '\x1b[C') state.col++;
                else if (key === 'j' || key === '\x1b[B') state.row++;
                else if (key === 'k' || key === '\x1b[A') state.row--;
                else if (key === '0') state.col = 0;
                else if (key === '$') state.col = Math.max(0, state.lines[state.row].length - 1);
                else if (key === 'i') enterInsert(false);
                else if (key === 'a') enterInsert(true);
                else if (key === 'x') {
                    const line = state.lines[state.row];
                    if (line.length) { state.lines[state.row] = line.slice(0, state.col) + line.slice(state.col + 1); state.modified = true; }
                } else if (key === ':') { state.mode = 'command'; state.commandBuffer = ''; }
                else if (key === '\x03') { /* Ctrl+C：normal mode下不做事 */ }
            }
        }
        draw();
    }
}
