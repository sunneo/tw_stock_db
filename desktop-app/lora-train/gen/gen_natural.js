'use strict';
/* natural 領域：手寫中英自然語句（我們最重要的編輯器／影片／瀏覽器／電腦操作家族），每個工具 3~4 種說法。
 * 偶數索引的說法進 train，奇數索引進 heldout（訓練時沒見過的說法）；工具本身 heldout=true 的，所有說法一律 heldout。
 * 期望的參數由人手寫；產生時程式逐一檢查：工具存在、參數鍵在 schema 內、必填都有、enum 值合法，不合的丟掉並在 stderr 報。
 * 限制：只有約 34 個工具，說法為手寫小樣本。 */
const C = require('./w2c_common.js');

const N = [
    ['sheet_set_cell', [['把第3列B欄改成 100', { row: '3', col: 'B', value: '100' }], ['Set cell C5 to hello', { row: '5', col: 'C', value: 'hello' }], ['第 2 列的「價格」欄請改成 250', { row: '2', col: '價格', value: '250' }], ['change row 7 column D to done', { row: '7', col: 'D', value: 'done' }]]],
    ['sheet_add_column', [['在表格加一欄叫「備註」', { name: '備註' }], ['add a column named Total', { name: 'Total' }], ['幫我新增欄位，標題是 數量', { name: '數量' }]]],
    ['sheet_delete_column', [['把 C 欄刪掉', { col: 'C' }], ['delete the column Notes', { col: 'Notes' }], ['請刪除「備註」這一欄', { col: '備註' }]]],
    ['sheet_sort', [['依「價格」欄排序', { col: '價格' }], ['sort the table by Date', { col: 'Date' }], ['幫我照 B 欄排序', { col: 'B' }]]],
    ['sheet_rename_sheet', [['把工作表 Sheet1 改名為 總表', { sheet: 'Sheet1', name: '總表' }], ['rename sheet Data to Archive', { sheet: 'Data', name: 'Archive' }], ['工作表「草稿」改叫「定稿」', { sheet: '草稿', name: '定稿' }]]],
    ['sheet_add_sheet', [['新增一張工作表叫 預算', { name: '預算' }], ['add a new sheet called Summary', { name: 'Summary' }], ['幫我開個新工作表，名稱 2025', { name: '2025' }]]],
    ['sheet_delete_sheet', [['刪掉工作表 暫存', { sheet: '暫存' }], ['delete the sheet Temp', { sheet: 'Temp' }], ['請移除 Sheet3 這張工作表', { sheet: 'Sheet3' }]]],
    ['sheet_replace_all', [['把表格裡的「舊版」全部換成「新版」', { find: '舊版', repl: '新版' }], ['replace all foo with bar in the sheet', { find: 'foo', repl: 'bar' }], ['全部的 TODO 改成 DONE', { find: 'TODO', repl: 'DONE' }]]],
    ['sheet_move_column', [['move column Price to end', { col: 'Price', to: 'end' }], ['把「備註」欄移到最前面', { col: '備註', to: 'start' }], ['把 D 欄移到最後面', { col: 'D', to: 'end' }]]],
    ['sheet_duplicate_sheet', [['複製工作表 總表', { sheet: '總表' }], ['duplicate the sheet Data', { sheet: 'Data' }], ['幫我把 Sheet2 複製一份', { sheet: 'Sheet2' }]]],
    ['doc_replace_all', [['在文件裡把「公司A」全部換成「公司B」', { find: '公司A', repl: '公司B' }], ['replace every Draft with Final in the document', { find: 'Draft', repl: 'Final' }], ['Word 檔的 2023 都改成 2024', { find: '2023', repl: '2024' }]]],
    ['doc_add_block', [['在文件最後加一段：「謝謝大家」', { text: '謝謝大家', after: 'end' }], ['add a paragraph saying Hello team to the doc', { text: 'Hello team' }], ['幫我在 Word 加一個區塊，內容是 會議紀錄', { text: '會議紀錄' }]]],
    ['doc_move_block', [['把這個區塊移到最前面', { to: 'first' }], ['move the block up one', { to: 'earlier' }], ['把這段往後移一格', { to: 'later' }]]],
    ['text_set_heading', [['把這個區塊改成二級標題', { level: 2 }], ['make this a level 1 heading in the markdown', { level: 1 }], ['改成 3 級標題', { level: 3 }]]],
    ['text_move_block', [['把這個區塊移到最後面', { to: 'last' }], ['move this block to the top', { to: 'first' }], ['這段往前移一格', { to: 'earlier' }]]],
    ['text_replace_all', [['在 Markdown 把「舊名」全部換成「新名」', { find: '舊名', repl: '新名' }], ['replace all colour with color in the text file', { find: 'colour', repl: 'color' }], ['純文字檔裡的 beta 都換成 stable', { find: 'beta', repl: 'stable' }]]],
    ['video_cut_range', [['把影片 00:10 到 00:25 剪掉', { start: '00:10', end: '00:25' }], ['cut the video from 1:00 to 1:30', { start: '1:00', end: '1:30' }], ['刪掉 5 秒到 12 秒之間的畫面', { start: '5', end: '12' }]]],
    ['video_cut_clip', [['把第 2 個片段拿掉', { n: 2 }], ['remove clip 3 from the timeline', { n: 3 }], ['刪除時間軸第 1 段', { n: 1 }]]],
    ['video_cut_line', [['把逐字稿第 5 句刪掉', { n: 5 }], ['delete subtitle line 12', { n: 12 }], ['第 3 句字幕整句拿掉', { n: 3 }]]],
    ['video_set_transition', [['片段之間加上淡入淡出轉場', { type: 'fade' }], ['use a dissolve transition between clips', { type: 'dissolve' }], ['不要任何轉場', { type: 'none' }]]],
    ['video_shift_lines', [['字幕整體延後 2 秒', { seconds: 2 }], ['shift all subtitles 3 seconds earlier', { seconds: -3 }], ['逐字稿提早 1.5 秒', { seconds: -1.5 }]]],
    ['browser_create_tab', [['開一個新分頁到 https://example.com', { url: 'https://example.com' }], ['open https://github.com in a new tab', { url: 'https://github.com' }], ['用新分頁打開 https://news.ycombinator.com', { url: 'https://news.ycombinator.com' }]]],
    ['browser_search', [['幫我搜尋 Rust borrow checker', { query: 'Rust borrow checker' }], ['search for python asyncio tutorial', { query: 'python asyncio tutorial' }], ['上網查 WebGPU 支援狀況', { query: 'WebGPU 支援狀況' }]]],
    ['browser_press_key', [['按 Enter', { key: 'Enter' }], ['press the Escape key', { key: 'Escape' }], ['幫我按一下 Tab 鍵', { key: 'Tab' }]]],
    ['browser_type_text', [['在輸入框打 hello world', { text: 'hello world' }], ['type 你好 into the field', { text: '你好' }], ['輸入 test@example.com', { text: 'test@example.com' }]]],
    ['browser_task', [['打開 Google 搜尋天氣並告訴我結果', { goal: '打開 Google 搜尋天氣並告訴我結果' }], ['go to example.com and take a screenshot of the login page', { goal: 'go to example.com and take a screenshot of the login page' }], ['到 GitHub 首頁找出 trending 的第一個專案', { goal: '到 GitHub 首頁找出 trending 的第一個專案' }]]],
    ['browser_set_download_behavior', [['之後的下載都拒絕', { behavior: 'deny' }], ['allow downloads on this tab', { behavior: 'allow' }], ['下載行為還原預設', { behavior: 'default' }]]],
    ['browser_list_tabs', [['列出目前開著的分頁', {}], ['list the tabs you opened', {}], ['現在有哪些分頁是你開的？', {}]]],
    ['computer_type', [['在目前視窗打字 你好', { text: '你好' }], ['type hello into the focused window', { text: 'hello' }], ['幫我輸入 abc123', { text: 'abc123' }]]],
    ['computer_key', [['按 Ctrl+C', { keys: 'ctrl+c' }], ['press Alt+Tab', { keys: 'alt+tab' }], ['送出 Enter 鍵', { keys: 'Enter' }]]],
    ['computer_window_action', [['把視窗 w1 最小化', { action: 'minimize', window_id: 'w1' }], ['focus window w3', { action: 'focus', window_id: 'w3' }], ['切到視窗 w5 前景', { action: 'focus', window_id: 'w5' }]]],
    ['computer_scroll', [['在 400,300 往下捲動', { x: 400, y: 300, dy: 3 }], ['scroll at 100,200', { x: 100, y: 200 }], ['在座標 50,60 捲動', { x: 50, y: 60 }]]],
    ['computer_drag', [['從 10,20 拖到 100,200', { x: 10, y: 20, x2: 100, y2: 200 }], ['drag from 5,5 to 50,60', { x: 5, y: 5, x2: 50, y2: 60 }], ['把滑鼠從 0,0 拖曳到 300,400', { x: 0, y: 0, x2: 300, y2: 400 }]]],
];

function valid(t, args) {
    const p = t.parameters.properties || {}; const req = t.parameters.required || [];
    for (const k of Object.keys(args)) { if (!p[k]) return 'unknown param ' + k; if (p[k].enum && !p[k].enum.includes(args[k])) return 'bad enum ' + k + '=' + args[k]; }
    for (const k of req) if (!(k in args)) return 'missing required ' + k;
    return null;
}

async function generate() {
    const rows = []; let dropped = 0; const tools = new Set();
    for (const [name, items] of N) {
        const t = C.BY_NAME[name]; if (!t) { dropped += items.length; console.error('[gen_natural] 丟掉：工具不存在 ' + name); continue; }
        items.forEach(([text, args], idx) => {
            const bad = valid(t, args); if (bad) { dropped++; console.error('[gen_natural] 丟掉 ' + name + '[' + idx + ']：' + bad); return; }
            const rand = C.rng('nat:' + name + ':' + idx); const list = C.toolList(t, rand, 3, 7);
            const split = t.heldout || idx % 2 === 1 ? 'heldout' : 'train'; tools.add(name);
            rows.push(C.tag({ id: 'natural:' + name + ':' + idx, domain: 'natural', stage: 'natural_call', messages: [C.sysMsg(), { role: 'user', content: text }], tools: list.map(C.toolSpec), completion: C.toolCall(name, args), verified_by: 'program_ground_truth', split, source_file: 'lora-train/gen/gen_natural.js', meta: { behavior: 'call', tool: name, group: C.groupOf(t), check: { kind: 'call', name, args }, phrasing_index: idx, tool_heldout: !!t.heldout } }, 'natural', 'call'));
        });
    }
    const tr = rows.filter((r) => r.split === 'train').length;
    console.error('[gen_natural] ' + tools.size + ' 個工具，產生 ' + rows.length + ' 筆（train ' + tr + '／heldout ' + (rows.length - tr) + '），丟掉 ' + dropped + '；手寫小樣本，偶數索引說法進 train、奇數進 heldout');
    return rows;
}
module.exports = { generate, N };
if (require.main === module) (async () => { for (const r of await generate()) process.stdout.write(JSON.stringify(r) + '\n'); })();
