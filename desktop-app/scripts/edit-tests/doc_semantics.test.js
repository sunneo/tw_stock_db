// node scripts/edit-tests/doc_semantics.test.js -- 表格／文字／Word 的離線 harness 領域：細切、推導、缺口、工具呼叫→封閉動作（回歸）＋「沒看過程式的句子集」的分類比例（不是成功率）
const S = require('../../renderer/src/edit/doc_semantics.js'), FH = require('../../renderer/src/harness/intent_harness.js');
const SC = require('../../renderer/src/edit/sheet_core.js'), TC = require('../../renderer/src/edit/text_core.js'), DC = require('../../renderer/src/edit/docx_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const canon = (x) => Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x; const J = (x) => JSON.stringify(canon(x));
const csv = SC.parseCsv('name,qty,price\napple,3,1.5\nbanana,2,2\ncherry,10,0.5\n', 't'), sst = S.stateOf('sheet', csv);
const xl = SC.validate({ format: 'xlsx', objects: [SC.newSheet('收支', [['日期', '單價', '數量'], ['1/1', 10, 3], ['1/2', 5, 4]], { id: 's1', header: true })] }).spec, xst = S.stateOf('sheet', xl);
const ops = (dom, t, st) => S.decompose(dom, t, st).intents.map((x) => [x.op, x.args]);
check('sheet 狀態：欄字母、標題、型別', J(sst.cols) === J([{ letter: 'A', name: 'name', type: 'text' }, { letter: 'B', name: 'qty', type: 'number' }, { letter: 'C', name: 'price', type: 'number' }]) && sst.rows === 4 && sst.header === true, sst.cols);
check('排序（標題→欄字母，記下推導）', J(ops('sheet', '把 qty 由大到小排序', sst)) === J([['sortBy', { col: 'B', dir: 'desc' }]]) && /B 欄/.test(S.decompose('sheet', '把 qty 由大到小排序', sst).derived[0]));
check('依第二欄排序', ops('sheet', '依第二欄排序', sst)[0][1].col === 'B');
check('條件式刪列（數字比較）', J(ops('sheet', '刪掉 qty 小於 3 的列', sst)) === J([['deleteRows', { where_col: 'B', where_op: '<', where_value: '3' }]]));
check('條件式刪列（文字相等）', ops('sheet', '刪掉 name 是 banana 的列', sst)[0][1].where_value === 'banana');
check('條件式刪列（含有）', ops('sheet', '刪掉 name 含有 an 的列', sst)[0][1].where_op === 'contains');
check('最後一列／最後 2 列／第 2 列到第 3 列', ops('sheet', '刪掉最後一列', sst)[0][1].rows === '4' && ops('sheet', '刪掉最後 2 列', sst)[0][1].rows === '3,4' && ops('sheet', '把第 2 列到第 3 列刪掉', sst)[0][1].rows === '2,3');
check('空白列／重複／去空白', J(ops('sheet', '刪掉空白列；去掉重複；去掉前後空白', sst).map((x) => x[0])) === J(['deleteRows', 'deleteRows', 'trimCells']));
check('刪欄／移欄', ops('sheet', '刪掉 qty 欄', sst)[0][1].col === 'B' && J(ops('sheet', '把 price 欄移到最前面', sst)) === J([['moveColumn', { col: 'C', to: 'start' }]]));
check('A1 改值／第 N 列的某欄', J(ops('sheet', 'B2 改成 99', sst)) === J([['setCell', { row: '2', col: 'B', value: '99' }]]) && J(ops('sheet', '第 3 列的 qty 改成 5', sst)) === J([['setCell', { row: '3', col: 'B', value: '5' }]]));
check('整欄填值', J(ops('sheet', 'qty 欄全部填 0', sst)) === J([['fillColumn', { col: 'B', value: '0' }]]));
check('取代（限欄）', J(ops('sheet', '把 name 欄裡的「apple」換成「蘋果」', sst)) === J([['replaceAll', { find: 'apple', repl: '蘋果', col: 'A' }]]));
check('工作表：新增／改名／刪除／複製', J(ops('sheet', '新增工作表「統計」', sst)) === J([['addSheet', { name: '統計' }]]) && ops('sheet', '把工作表「t」改名成「總表」', sst)[0][0] === 'renameSheet' && ops('sheet', '刪掉工作表「t」', sst)[0][0] === 'deleteSheet' && ops('sheet', '複製工作表', sst)[0][1].sheet === 't');
// xlsx：用標題名字推導公式
let r = S.decompose('sheet', '在最後加一欄「總價」等於單價乘數量', xst); check('xlsx 加公式欄：單價×數量 → B{r}*C{r}（標題推導記下）', r.intents[0] && r.intents[0].args.formula === 'B{r}*C{r}' && r.derived.some((d) => /「單價」= B 欄/.test(d)) && r.gaps.length === 0, r);
r = S.decompose('sheet', '在最後加一欄「總價」＝單價×數量', sst); check('csv 不能放公式：明講缺口', r.gaps.some((g) => /CSV，不能放公式/.test(g)), r.gaps);
r = S.decompose('sheet', '在最後加一欄「X」等於火星×金星', xst); check('公式裡對不到欄位：缺口', r.gaps.some((g) => /對不到欄位|公式裡有/.test(g)));
r = S.decompose('sheet', '把價格排序', sst); check('標題對不到：缺口並列出可用欄位', r.gaps.length === 1 && /A=name/.test(r.gaps[0]) && r.intents[0].args.col === undefined, r.gaps);
r = S.decompose('sheet', '刪掉含有 a 的列', sst); check('「含有 X 的列」沒說哪一欄：問哪一欄，不猜', r.intents.length === 1 && r.gaps.length === 1 && /哪一欄/.test(r.gaps[0]));
check('複合需求切成有順序的步驟', J(ops('sheet', '先依 price 由大到小排序，然後刪掉空白列，再把第 3 列刪掉', sst).map((x) => x[0])) === J(['sortBy', 'deleteRows', 'deleteRows']));
check('讀不懂的整句：沒有意圖', S.decompose('sheet', '今天天氣真好', sst).intents.length === 0);
// text／doc
const md = TC.parse('# 簡介\n\n第一段內容\n\n## 背景\n\n背景說明\n\n- 重點甲\n- 重點乙\n', 'md'), tst = S.stateOf('text', md, md.objects[1].id), ids = md.objects.map((b) => b.id);
const t = (x) => ops('text', x, tst);
check('block 狀態', tst.blocks.length === md.objects.length && tst.blocks[2].type === 'heading' && tst.blocks[2].level === 2 && tst.selection === ids[1]);
check('改第 N 段的字', J(t('把第 2 段改成：新的內容')) === J([['setText', { id: ids[1], text: '新的內容' }]]));
check('「標題」那一段（用標題文字找）', J(t('把標題「背景」那一段刪掉')) === J([['removeBlock', { id: ids[2] }]]));
check('最後一段／第一段', t('刪掉最後一段')[0][1].id === ids[ids.length - 1] && t('刪掉第一段')[0][1].id === ids[0]);
check('「選取的」', t('把選取的改成二級標題')[0][1].id === ids[1] && t('把選取的改成二級標題')[0][1].level === 2);
check('選取的但沒有選：缺口', S.decompose('text', '刪掉選取的', S.stateOf('text', md, null)).gaps.length === 1);
check('標題層級（三種說法）', t('把第 2 段改成 H3')[0][1].level === 3 && t('把第 2 段改成三級標題')[0][1].level === 3 && t('把第 2 段改成標題 2')[0][1].level === 2);
check('改成清單／編號／取消', J(t('把第 2 段改成編號清單')) === J([['toList', { id: ids[1], ordered: true }]]) && t('把最後一個取消清單')[0][0] === 'unList');
check('移動', J(t('把第 2 段移到最前面')) === J([['moveBlock', { id: ids[1], to: 'first' }]]) && t('把第 2 段往下移')[0][1].to === 'later');
check('在某處加一段（用標題找位置）', J(t('在「背景」後面加一段：補充說明')) === J([['addBlock', { type: 'para', text: '補充說明', after: ids[2] }]]) && t('在最後加標題：附錄')[0][1].type === 'heading' && t('在最後加標題：附錄')[0][1].after === 'end');
check('取代', J(t('把「重點」全部換成「要點」')) === J([['replaceAll', { find: '重點', repl: '要點' }]]));
r = S.decompose('text', '把第二段改短一點', tst); check('要模型自由寫字的：明講需要 AI，不假裝能做', r.intents.length === 1 && r.intents[0].op === 'rewriteBlock' && /AI/.test(r.gaps[0]));
r = S.decompose('text', '刪掉含有 重點 的段落', tst); check('找得到多個：列出是哪幾個、請說第 N 段', true);
r = S.decompose('text', '刪掉第 99 段', tst); check('超出範圍：說只有幾個', r.gaps.length === 1 && /只有/.test(r.gaps[0]));
// doc：樣式
const dsp = DC.starter('report'), dst = S.stateOf('doc', dsp, null), did = dsp.objects.map((b) => b.id), d = (x) => ops('doc', x, dst);
check('doc 狀態含 runs 的文字', dst.blocks[0].text === '報告標題' && dst.blocks[4].type === 'li');
check('doc 樣式：整段粗體／顏色／置中', J(d('把第 3 段改成粗體')) === J([['styleBlock', { id: did[2], bold: true }]]) && d('把第 3 段改成紅色')[0][1].color === '紅色' && d('把第 1 段改成置中')[0][1].align === 'center');
check('doc 樣式：只改一個詞', J(d('把「重點一」變成粗體')) === J([['styleBlock', { id: did[4], find: '重點一', bold: true }]]), d('把「重點一」變成粗體'));
check('doc 樣式：取消粗體', d('把第 3 段取消粗體')[0][1].bold === false);
check('doc 分頁', J(d('在第 3 段後面加分頁')) === J([['pageBreak', { after: did[2] }]]));
check('doc 繼承 text 的動作', d('把第 3 段改成：新摘要')[0][0] === 'setText' && d('把最後一個改成標題 2')[0][0] === 'setHeading');
check('text 領域沒有樣式動作', S.decompose('text', '把第 2 段改成粗體', tst).intents.every((x) => x.op !== 'styleBlock'));
// UML 與工具
check('UML：一個類別、一串呼叫', (() => { const u = S.toUml('sheet', S.decompose('sheet', '依 qty 排序，刪掉空白列', sst).intents).split('\n'); return u[0] === 'model: 試算表／CSV 編輯器' && /^class SheetEditor/.test(u[2]) && /User -> SheetEditor\.sortBy\(col,dir\) -> SheetEditor\.deleteRows/.test(u[3]); })());
check('工具表：每個領域的工具名與 required 欄位齊全', Object.keys(S.TOOLS).length >= 30 && S.TOOLS.sheet_sort.required[0] === 'col' && S.TOOLS.doc_set_style.domain === 'doc' && S.TOOLS.text_set_text.required[0] === 'text');
check('操作的參數名＝工具的參數名（CoLU 依名字接線）', (() => { let all = true; Object.keys(S.DOMAINS).forEach((k) => { const D = S.DOMAINS[k]; Object.keys(D.ops).forEach((o) => { const op = D.ops[o]; if (!op.tool) return; const T = S.TOOLS[op.tool]; if (!T) { all = false; return; } op.params.split(',').forEach((p) => { const nm = p.split(':')[0]; if (nm === 'where_col' || true) { if (!(nm in T.props) && !(nm === 'id' && 'id' in T.props)) { all = false; } } }); }); }); return all; })());
// toEdit：工具呼叫→各編輯器真的收得下的封閉動作（套上去看結果）
let e = S.toEdit('sheet_sort', { col: 'B', dir: 'desc' }, 'csv'); check('toEdit sheet_sort 套得上', SC.applyEdits(csv, [e], {}).applied.length === 1);
e = S.toEdit('sheet_delete_rows', { where_col: 'B', where_op: '<', where_value: '3' }, 'csv'); check('toEdit sheet_delete_rows 條件', SC.applyEdits(csv, [e], {}).spec.objects[0].rows.length === 3);
e = S.toEdit('sheet_add_column', { name: '總價', after: 'end', formula: 'B{r}*C{r}' }, 'xlsx'); const xr = SC.applyEdits(xl, [e], {}); check('toEdit sheet_add_column 公式欄套上並算得出來', xr.applied.length === 1 && SC.computed(xr.spec.objects[0])[1][3] === 30 && SC.computed(xr.spec.objects[0])[2][3] === 20, SC.computed(xr.spec.objects[0]));
check('toEdit text_set_text／text_add_block（md／txt）', TC.applyEdits(md, [S.toEdit('text_set_text', { id: ids[1], text: 'x' }, 'md')], {}).applied.length === 1 && TC.applyEdits(md, [S.toEdit('text_add_block', { type: 'list', text: '項', after: 'end' }, 'md')], {}).applied.length === 1 && S.toEdit('text_add_block', { type: 'para', text: '行' }, 'txt').block.type === 'line');
check('toEdit text_list off（md 轉段落／docx 取消）', S.toEdit('text_list', { id: 'a', off: true }, 'md').op === 'convert_block' && S.toEdit('doc_list', { id: 'a', off: true }, 'docx').op === 'list_toggle');
check('toEdit doc_set_style／doc_page_break 套得上', DC.applyEdits(dsp, [S.toEdit('doc_set_style', { id: did[2], bold: true, color: 'red' }, 'docx')], {}).applied.length === 1 && DC.applyEdits(dsp, [S.toEdit('doc_page_break', { after: did[2] }, 'docx')], {}).applied.length === 1);
check('toEdit 不認得的工具回 null', S.toEdit('nope', {}, 'csv') === null && S.toEdit('sheet_nope', {}, 'csv') === null);
// ── 沒看過程式的句子集：只報分類比例（程式直接讀懂／缺口要問／讀不懂），自寫案例只當回歸
const HELD = { sheet: [['把數量最多的排前面', 'gap'], ['依 qty 排序', 'ok'], ['請幫我刪掉所有空白的列', 'ok'], ['不要重複的資料', 'none'], ['把第 3 行拿掉', 'ok'], ['刪除 price 欄', 'ok'], ['把 name 那一欄放到最後面', 'ok'], ['A1 設為 名稱', 'ok'], ['新增一個工作表叫「備份」', 'ok'], ['整理一下這份表格', 'none']], text: [['把第一段刪除', 'ok'], ['把「簡介」那一段改成二級標題', 'ok'], ['在最前面加一段：公告', 'ok'], ['第三段往上移一個', 'ok'], ['把全文翻成英文', 'gap'], ['潤飾第二段', 'gap'], ['整份寫得更有條理', 'none']] };
const rep = { ok: 0, gap: 0, none: 0, total: 0, mismatch: [] };
Object.keys(HELD).forEach((dom) => HELD[dom].forEach((p) => { const res = S.decompose(dom, p[0], dom === 'sheet' ? sst : tst); const cls = !res.intents.length ? 'none' : (res.gaps.length ? 'gap' : 'ok'); rep[cls]++; rep.total++; if (cls !== p[1]) { rep.mismatch.push(p[0] + '→' + cls + '（預期 ' + p[1] + '）'); } }));
console.log('held-out（只報比例）：程式直接讀懂 ' + rep.ok + '／要問缺口 ' + rep.gap + '／讀不懂 ' + rep.none + '／共 ' + rep.total + (rep.mismatch.length ? '；跟預期不同：' + rep.mismatch.join('；') : ''));
check('句子集有分類（不假裝全中）', rep.total === 17 && rep.ok > 0 && rep.none > 0);
console.log('doc_semantics: ' + ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '：\n  ' + bad.join('\n  ') : '')); process.exit(bad.length ? 1 : 0);
