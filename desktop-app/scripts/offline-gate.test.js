// 離線理解閘（renderer/src/offline/intent_gate.js）：動作、目標種類、後置步驟、處理建議
const G = require('../renderer/src/offline/intent_gate.js');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const att = (n, id) => ' [附件：' + n + '（file_id=' + id + '）]';
const T = (text, exp, opts) => {
    const g = G.gate(text, opts); const bad = [];
    for (const [k, v] of Object.entries(exp)) {
        const got = g[k];
        if (k === 'post') { const types = got.map((p) => p.type).join(','); if (types !== v) bad.push(k + '=' + types + '≠' + v); }
        else if (k === 'keyword' || k === 'url') { if (got !== v) bad.push(k + '=' + got + '≠' + v); }
        else if (k === 'unhandled') { if (got.length !== v) bad.push('unhandled=' + got.length + '≠' + v); }
        else if (got !== v) bad.push(k + '=' + got + '≠' + v);
    }
    ok(!bad.length, text.slice(0, 40) + (bad.length ? '  ← ' + bad.join('；') + ' ' + JSON.stringify(g).slice(0, 200) : ''));
    return g;
};

// 使用者原句與網址類
T('瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞', { action: 'open', kind: 'url', openTool: 'browser_create_tab', keyword: '美國選舉', post: 'find_topic', advice: 'open_post', visible: true, closeWhenDone: true, mustBrowser: true, url: 'https://tw.yahoo.com' });
T('瀏覽器打開 tw.yahoo.com 並找美國選舉新聞', { action: 'open', kind: 'url', keyword: '美國選舉', url: 'https://tw.yahoo.com', advice: 'open_post' });
T('用瀏覽器控制開啟 https://a.com', { action: 'open', kind: 'url', post: '', advice: 'open', visible: true });
T('前往 https://news.ycombinator.com 然後摘要', { action: 'open', kind: 'url', post: 'summarize', advice: 'open_post' });
T('打開 https://a.com 並截圖', { action: 'open', kind: 'url', post: 'screenshot' });
T('打開 https://a.com 並找川普，再摘要', { action: 'open', post: 'find_topic,summarize', keyword: '川普' });
T('打開 https://a.com 然後比較兩家的立場', { action: 'open', post: 'reason' });
T('打開 https://a.com 並看第三則', { action: 'open', post: 'pick_item' });
T('瀏覽器打開 https://a.com 並幫我做一個咖啡拿鐵的行銷企劃', { action: 'open', advice: 'partial', unhandled: 1 });
T('瀏覽器打開', { action: 'open', kind: 'url', advice: 'ask' });
T('開', { action: 'open', advice: 'ask' });
// 純截圖／純搜尋／純讀取／沒有後半句
T('截圖 https://example.com', { action: 'screenshot', kind: 'url', post: '', advice: 'direct', closeWhenDone: true });
T('截取螢幕截圖', { action: 'screenshot', post: '', advice: 'direct' });
T('搜尋 美國選舉新聞', { action: 'search', keyword: '美國選舉', post: '', advice: 'direct' });
T('查一下今天天氣', { action: 'search', keyword: '今天天氣', advice: 'direct' });
T('讀一下 https://a.com', { action: 'read', kind: 'url', advice: 'direct', visible: false });
T('找美國選舉新聞，再摘要', { action: 'search', keyword: '美國選舉', post: 'summarize', advice: 'post' });
// 音樂（至少 3 句）
T('打開音樂編輯器', { action: 'open', kind: 'music', openTool: 'midi_edit_open', advice: 'open' });
T('開一首 midi 來編輯', { action: 'open', kind: 'music', openTool: 'midi_edit_open' });
T('打開 song.mid' + att('song.mid', 'm1'), { action: 'open', kind: 'music', openTool: 'midi_edit_open', fileId: 'm1', advice: 'open' });
T('播放 song.mp3' + att('song.mp3', 'm2'), { action: 'play', kind: 'music', openTool: 'midi_play', fileId: 'm2' });
// pdf／docx／xlsx
T('打開 report.pdf' + att('report.pdf', 'p1'), { action: 'open', kind: 'pdf', openTool: 'parse_uploaded_file', advice: 'open', fileId: 'p1' });
T('開啟這份 pdf', { action: 'open', kind: 'pdf', advice: 'need_file' });
T('打開 合約.docx' + att('合約.docx', 'd1'), { action: 'open', kind: 'docx', openTool: 'edit_docx_open', fileId: 'd1', advice: 'open' });
T('開啟 Word 文件', { action: 'open', kind: 'docx', advice: 'need_file' });
T('打開 docx 並整理重點' + att('a.docx', 'd2'), { action: 'open', kind: 'docx', post: 'summarize', advice: 'open_post' });
T('打開 sales.xlsx' + att('sales.xlsx', 'x1'), { action: 'open', kind: 'xlsx', openTool: 'edit_xlsx_open', advice: 'open' });
T('開啟 Excel 試算表', { action: 'open', kind: 'xlsx', advice: 'need_file' });
T('打開 data.csv' + att('data.csv', 'c1'), { action: 'open', kind: 'csv', openTool: 'edit_csv_open' });
// 3D
T('打開 room.glb' + att('room.glb', 'g1'), { action: 'open', kind: 'model3d', openTool: 'edit_3d_open', advice: 'open' });
T('開啟 3D 場景編輯器', { action: 'open', kind: 'model3d', advice: 'need_file' });
T('打開 scene.3dscene.yaml' + att('scene.3dscene.yaml', 'g2'), { kind: 'model3d', fileId: 'g2' });
// deck
T('打開 簡報 demo.deck.yaml' + att('demo.deck.yaml', 's1'), { action: 'open', kind: 'deck', openTool: 'open_existing_presentation', fileId: 's1', advice: 'open' });
T('打開 slides.pptx' + att('slides.pptx', 's2'), { action: 'open', kind: 'deck', openTool: 'pptx_to_deck', advice: 'open' });
T('開啟簡報', { action: 'open', kind: 'deck', advice: 'need_file' });
T('打開投影片編輯器', { kind: 'deck' });
// 其他編輯器
T('打開 logo.svg' + att('logo.svg', 'v1'), { kind: 'svg', openTool: 'edit_svg_open', advice: 'open' });
T('打開 photo.png' + att('photo.png', 'i1'), { kind: 'picture', openTool: 'edit_picture_open' });
T('打開 clip.mp4' + att('clip.mp4', 'e1'), { kind: 'video', openTool: 'edit_video_open' });
T('打開 notes.md' + att('notes.md', 'n1'), { kind: 'markdown', openTool: 'edit_markdown_open' });
T('打開 a.txt' + att('a.txt', 'n2'), { kind: 'text', openTool: 'edit_text_open' });
T('打開編輯器', { action: 'open', kind: 'editor', advice: 'ask' });
// 不該誤判
T('開始寫程式', { action: null, advice: 'direct' });
T('/offline-dry 打開 https://a.com', { advice: 'passthrough' });
T('', { ok: false, advice: 'passthrough' });
T('你好', { action: null, advice: 'direct', post: '' });

// 回傳的工具都是既有工具（對照原始碼註冊）
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8');
const missing = Object.values(G.KINDS).map((k) => k.tool).filter(Boolean).concat(['midi_play', 'pptx_to_deck']).filter((t) => !src.includes("'" + t + "'"));
ok(!missing.length, '用到的開啟工具在程式裡都有註冊：' + (missing.join(',') || '全部'));
// 沒有後半句時 post 為空、unhandled 為空
const plain = G.gate('瀏覽器打開 https://tw.yahoo.com');
ok(plain.post.length === 0 && plain.unhandled.length === 0 && plain.advice === 'open', '沒有後半句：不產生後置步驟');
// FaIntent 補充
const withIntent = G.gate('打開 https://a.com 並幫我評點兩家說法差異', { intents: [{ action: 'compare', confidence: 0.8 }] });
ok(withIntent.post.some((p) => p.type === 'reason'), '英文推導結果補上中文沒認出的後置步驟');
console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
