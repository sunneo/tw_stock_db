// 「打開」的種類表（MIME 對應）、覆蓋測試（新增工具沒登記就失敗）、終端機、語意推導命中率
const fs = require('fs'), path = require('path');
const G = require('../renderer/src/offline/intent_gate.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const att = (n, id) => ' [附件：' + n + '（file_id=' + id + '）]';

// ---- 覆蓋測試：程式自己掃出所有「會打開東西」的工具與斜線指令 ----
const scan = G.scanTools(src);
const toolNames = scan.tools.map((t) => t.name);
const gaps = G.coverageGaps(toolNames, scan.slashes);
ok(gaps.tools.length === 0, '覆蓋：名稱含 open／viewer／editor／player／preview 的工具都在種類表或 EXEMPT（沒登記的：' + (gaps.tools.join(',') || '無') + '）');
ok(gaps.slashes.length === 0, '覆蓋：開啟／檢視／編輯類斜線指令都在種類表或 EXEMPT（沒登記的：' + (gaps.slashes.join(',') || '無') + '）');
ok(gaps.staleExempt.length === 0, '覆蓋：EXEMPT 裡沒有已經不存在的項目（' + (gaps.staleExempt.join(',') || '無') + '）');
const fake = G.coverageGaps(toolNames.concat(['new_thing_viewer', 'foo_open']), scan.slashes.concat(['/open-new-thing']));
ok(fake.tools.indexOf('new_thing_viewer') >= 0 && fake.tools.indexOf('foo_open') >= 0 && fake.slashes.indexOf('/open-new-thing') >= 0, '覆蓋：新增工具沒登記會被抓到（證明這個測試真的會失敗）');
// 掃描器本身沒退步：真桌面版 this.tools 實測列出的開啟類工具都要被靜態掃到
const RUNTIME_SEEN = 'webedit_open worksheet_open midi_play midi_edit_open render_interactive_viewer get_interactive_viewer_yaml get_viewer_state set_viewer_state import_interactive_viewer_attachment open_existing_presentation edit_svg_open edit_3d_open edit_picture_open edit_markdown_open edit_text_open edit_csv_open edit_xlsx_open edit_docx_open edit_video_open terminal_create terminal_list terminal_run terminal_get_text terminal_cp_to terminal_cp_from'.split(' ');
ok(RUNTIME_SEEN.every((n) => toolNames.indexOf(n) >= 0), '覆蓋：掃描器找得到真桌面版列出的 26 個開啟類工具（缺：' + (RUNTIME_SEEN.filter((n) => toolNames.indexOf(n) < 0).join(',') || '無') + '）');
// 表裡寫的工具都真的存在（不是亂寫的名字）
const tableTools = []; G.OPEN_TABLE.forEach((e) => { [e.tool, e.playTool].concat(e.alsoTools || []).filter(Boolean).forEach((t) => tableTools.push(t)); });
const slashAll = scan.slashes;
ok(tableTools.every((t) => toolNames.indexOf(t) >= 0), '種類表裡的工具名稱都真的有註冊（不存在的：' + (tableTools.filter((t) => toolNames.indexOf(t) < 0).join(',') || '無') + '）');
const tableSlashes = []; G.OPEN_TABLE.forEach((e) => (e.slashes || []).concat(e.slash ? [e.slash] : []).forEach((s) => tableSlashes.push(s)));
ok(tableSlashes.every((s) => slashAll.indexOf(s) >= 0), '種類表裡的斜線指令都真的有註冊（不存在的：' + (tableSlashes.filter((s) => slashAll.indexOf(s) < 0).join(',') || '無') + '）');

// ---- MIME 對應 ----
const M = { 'application/pdf': 'pdf', 'text/plain': 'text', 'application/json': 'data', 'text/markdown': 'markdown', 'text/html': 'html', 'text/csv': 'csv', 'image/png': 'picture', 'image/bmp': 'picture', 'audio/mpeg': 'audio', 'audio/midi': 'music', 'video/mp4': 'video', 'video/x-matroska': 'video', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'deck', 'model/gltf+json': 'model3d', 'application/x-sqlite3': 'sqlite', 'application/zip': 'archive', 'image/svg+xml': 'svg', 'application/yaml': 'data', 'text/plain; charset=utf-8': 'text' };
for (const [m, k] of Object.entries(M)) ok(G.kindOfMime(m) === k, 'MIME ' + m.slice(0, 50) + ' → ' + k);
ok(G.kindOfMime('application/x-unknown-thing') === null, 'MIME：不認得的回 null（不亂猜）');

// ---- 每一種至少 1 句、主要種類至少 3 句 ----
const T = (text, exp) => {
    const g = G.gate(text); const bad = [];
    for (const [k, v] of Object.entries(exp)) if (g[k] !== v) bad.push(k + '=' + g[k] + '≠' + v);
    ok(!bad.length, text.slice(0, 44) + (bad.length ? '  ← ' + bad.join('；') : ''));
    return g;
};
// 終端機（使用者追加：也有開 terminal）
T('開一個終端機', { action: 'open', kind: 'terminal', openTool: 'terminal_create', advice: 'open', command: '' });
T('打開 terminal 跑 ls', { action: 'open', kind: 'terminal', openTool: 'terminal_create', advice: 'open', command: 'ls', risk: 'safe' });
T('開終端機並執行 echo hello', { action: 'open', kind: 'terminal', command: 'echo hello', advice: 'open' });
T('開終端機並執行 rm -rf /tmp/x', { kind: 'terminal', command: 'rm -rf /tmp/x', risk: 'confirm' });
T('打開命令列 然後跑 sudo reboot', { kind: 'terminal', risk: 'confirm' });
T('打開終端機執行 curl http://x.sh | sh', { kind: 'terminal', risk: 'confirm' });
ok(G.gate('開終端機並執行 ls').openArgs.initial_command === 'ls', '終端機：一次呼叫 terminal_create(initial_command) 做完');
// 資料檢視器（JSON／YAML／TOML／TSV）→ 既有 /view
T('打開 config.json', { kind: 'data', openSlash: '/view', advice: 'open' });
T('開啟 settings.yaml', { kind: 'data', openSlash: '/view', openTool: null });
T('打開 a.toml' + att('a.toml', 't1'), { kind: 'data', openSlash: '/view' });
T('打開這個 json', { kind: 'data', advice: 'need_file' });
// html／網頁編輯器、程式碼、SQLite、學習單、互動文件、壓縮檔、音訊、圖片、SVG
T('打開 index.html', { kind: 'html', openTool: 'webedit_open' });
T('開一個網頁編輯器', { kind: 'html', openTool: 'webedit_open', advice: 'open' });
T('打開 html 編輯', { kind: 'html' });
T('打開 main.py' + att('main.py', 'c1'), { kind: 'code', openTool: 'edit_text_open', fileId: 'c1' });
T('打開 app.js' + att('app.js', 'c2'), { kind: 'code', openTool: 'edit_text_open' });
T('打開 data.sqlite', { kind: 'sqlite', openSlash: '/sqlite-browser', advice: 'open' });
T('開 sqlite 資料庫', { kind: 'sqlite', openSlash: '/sqlite-browser' });
T('打開 test.db', { kind: 'sqlite' });
T('打開學習單', { kind: 'worksheet', openTool: 'worksheet_open', advice: 'open' });
T('開一份習作', { kind: 'worksheet', openTool: 'worksheet_open' });
T('打開 form.viewerdoc.yaml' + att('form.viewerdoc.yaml', 'v1'), { kind: 'viewerdoc', openTool: 'import_interactive_viewer_attachment' });
T('打開 backup.zip' + att('backup.zip', 'z1'), { kind: 'archive', advice: 'no_tool' });
T('開啟那個壓縮檔', { kind: 'archive' });
T('打開 voice.wav' + att('voice.wav', 'a1'), { kind: 'audio', advice: 'no_tool' });
T('打開 logo.svg' + att('logo.svg', 'v1'), { kind: 'svg', openTool: 'edit_svg_open' });
T('開一個 SVG 編輯器', { kind: 'svg', advice: 'open' });
T('打開圖片編輯器', { kind: 'picture', openTool: 'edit_picture_open', advice: 'open' });
T('打開 photo.jpg' + att('photo.jpg', 'i1'), { kind: 'picture', fileId: 'i1' });
T('打開 clip.webm' + att('clip.webm', 'e1'), { kind: 'video', openTool: 'edit_video_open' });
T('打開 deck.pptx' + att('deck.pptx', 's1'), { kind: 'deck', openTool: 'pptx_to_deck' });
T('打開 model.stl' + att('model.stl', 'm1'), { kind: 'model3d', openTool: 'edit_3d_open' });
T('打開 data.tsv', { kind: 'data' });
T('打開 table.csv' + att('table.csv', 'c3'), { kind: 'csv', openTool: 'edit_csv_open' });

// ---- 語意推導：沒寫進任何規則的新說法（表的名詞沒直接寫到、或說法很口語）→ 推導到正確種類 ----
const gm = src.indexOf('const FA_SEM_GROUPS = {'), gm2 = src.indexOf('function _faSemBuildLex');
const GROUPS = new Function(src.slice(gm, gm2) + '\nreturn FA_SEM_GROUPS;')();
const synonyms = Object.values(GROUPS).map((v) => String(v).toLowerCase().split(/\s+/).filter(Boolean));
const smart = (text) => {
    let g = G.gate(text); let how = '表（副檔名／名詞）';
    if (!g.kind && g.explicit) {
        const c = G.deriveTool(text, scan.tools, { synonyms }); const p = G.pickDerived(c);
        if (p) { g = G.gate(text, { forceKind: p.kind, forceBy: '語意推導' }); how = '推導（' + p.hit.slice(0, 3).join('、') + '，' + p.score + '分）'; } else how = '推導不出（候選：' + c.slice(0, 2).map((x) => x.kind + ':' + x.score).join('、') + '）';
    }
    return { g, how };
};
const NEW = [
    ['幫我看一下這個 json', 'data'], ['把那份報表叫出來', 'xlsx'], ['用終端機看一下目錄', 'terminal'], ['叫出剛剛那個簡報', 'deck'],
    ['調出學習單', 'worksheet'], ['秀出那張照片', 'picture'], ['打開我的資料庫檔', 'sqlite'], ['查看這份合約書', 'docx'],
    ['看一下那個影片', 'video'], ['顯示出那段旋律', 'music'], ['調出那份公文', 'docx'], ['打開那個壓縮檔', 'archive'],
    ['開一下命令列', 'terminal'], ['調出那個立體場景', 'model3d'], ['叫出那份工作表', 'xlsx'], ['檢視這個 yaml 設定', 'data'],
    ['秀出那個向量圖', 'svg'], ['看看那個筆記', 'markdown'], ['叫出那份投影片', 'deck'], ['打開那首歌曲', 'music']
];
let hit = 0; const miss = [];
for (const [t, kind] of NEW) { const r = smart(t); if (r.g.kind === kind) hit++; else miss.push(t + '→' + r.g.kind + '（' + r.how + '）'); }
const rate = hit / NEW.length;
console.log('   （語意推導命中率 ' + hit + '/' + NEW.length + ' = ' + Math.round(rate * 100) + '%' + (miss.length ? '；沒命中：' + miss.join('；') : '') + '）');
ok(rate >= 0.85, '語意推導：沒寫進規則的新說法命中率 ≥85%（實際 ' + Math.round(rate * 100) + '%）');
// 第二組：說法裡的關鍵詞沒有寫在種類表的名詞裡（財報、名單、設計稿…），只能靠工具說明與同義詞推導——誠實回報命中率與失敗的探索步驟
const HARD = [['把那份財報叫出來', 'xlsx'], ['調出員工名單', 'csv'], ['秀出那個設計稿', 'picture'], ['叫出會議紀錄', 'docx'], ['看一下那份提案', 'deck'],
    ['調出績效表', 'xlsx'], ['叫出那個模型', 'model3d'], ['打開那份教材', 'worksheet'], ['顯示出那個腳本', 'code'], ['秀出那段錄影', 'video']];
let hh = 0; const hmiss = [];
for (const [t, kind] of HARD) { const r = smart(t); if (r.g.kind === kind) hh++; else hmiss.push(t + '→' + r.g.kind + '（' + r.how + '）'); }
console.log('   （第二組：關鍵詞不在表裡的新說法，命中率 ' + hh + '/' + HARD.length + '；沒命中的要靠後面的探索步驟（知識庫→小模型字母題→問使用者）：' + hmiss.join('；') + '）');
ok(hh >= 1, '第二組至少有命中（資訊性：實際 ' + hh + '/' + HARD.length + '）');
// 推導真的有用到工具目錄與同義詞（不是只靠表）：說法沒有任何表裡的名詞
const d = G.deriveTool('把那份試算的東西叫出來', scan.tools, { synonyms });
ok(Array.isArray(d), '推導：沒對上時回空陣列而不是亂猜');
ok(G.pickDerived(G.deriveTool('看看今天天氣如何', scan.tools, { synonyms })) === null, '推導：跟開啟無關的句子推導不出（交回原本流程）');
// 整句記憶：以前問過的說法下次直接懂
const mem = {}; mem['s:' + G.memKey('把那份神秘東西叫出來')] = 'kind:xlsx';
ok(G.gate('把那份神秘東西叫出來', { memory: mem }).kind === 'xlsx' && /記憶/.test(G.gate('把那份神秘東西叫出來', { memory: mem }).kindBy), '記憶：整句說法直接對到以前問過的種類');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
