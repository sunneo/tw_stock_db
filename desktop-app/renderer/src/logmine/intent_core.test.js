'use strict';
const assert = require('assert');
const NLU = require('./nlu_core.js');
const INT = require('./intent_core.js');
let n = 0; const bad = []; const t = (name, fn) => { try { fn(); n++; } catch (e) { bad.push(name + ': ' + e.message); process.exitCode = 1; } };

const CATALOG = [
    { id: 'media/video_to_gif', domain: 'media', tool: 'video_to_gif', intent: 'convert a video to a gif', examples: ['make a gif from this video', 'convert the mp4 clip to gif'] },
    { id: 'media/video_subtitle', domain: 'media', tool: 'video_subtitle', intent: 'add subtitles to a video', examples: ['transcribe the video and burn subtitles'] },
    { id: 'coding/convert_code', domain: 'coding', tool: null, intent: 'convert source code from one programming language to another', examples: ['convert this python script to javascript', 'port the function to rust'] },
    { id: 'coding/fix_bug', domain: 'coding', tool: null, intent: 'fix a bug in code', examples: ['fix this error in my script'] },
    { id: 'docs/pdf_merge', domain: 'docs', tool: 'pdf_merge', intent: 'merge pdf files', examples: ['merge these pdfs'] },
];
const run = (text, o) => { const u = NLU.understand(text, { catalog: [] }); return INT.derive(u, Object.assign({ catalog: CATALOG }, o || {})); };

t('semOf：型別與語言', () => {
    const f = NLU.frameOf('convert this python script to javascript', { learn: false });
    const th = INT.semOf(f.obj); assert.strictEqual(th.type, 'code'); assert.strictEqual(th.lang, 'python');
    const tg = INT.semOf(f.pps.find((p) => p.prep === 'to').np); assert.strictEqual(tg.lang, 'javascript'); assert.strictEqual(tg.type, 'code');
});
t('型別相容', () => {
    assert.strictEqual(INT.compat('code', 'code'), 'exact'); assert.strictEqual(INT.compat('video', 'audio'), 'family');
    assert.strictEqual(INT.compat('code', 'video'), null); assert.strictEqual(INT.compat(null, 'video'), 'unknown');
});
t('核心：convert python script to javascript 不配到影片工具', () => {
    const r = run('Please convert this python script to javascript.\n\n```python\nprint("hi")\n```\n');
    const it = r.intents[0]; assert.ok(it, 'has intent'); assert.strictEqual(it.action, 'convert'); assert.strictEqual(it.theme.type, 'code'); assert.strictEqual(it.theme.lang, 'python'); assert.strictEqual(it.target.lang, 'javascript');
    assert.ok(!it.matches.some((m) => /video/.test(m.id)), JSON.stringify(it.matches));
    assert.ok(it.matches.length && it.matches[0].id === 'coding/convert_code', JSON.stringify(it.matches));
    assert.ok(it.rejected.some((x) => /video/.test(x.id)), '影片工具要被明確排除');
    assert.strictEqual(it.plan.feasible, false); assert.strictEqual(it.plan.route, 'model');
});
t('核心：convert the video to a gif 配到影片工具，離線可行', () => {
    const r = run('Convert the video to a gif.', { attachments: [{ id: 'f1', filename: 'demo.mp4' }] });
    const it = r.intents[0]; assert.strictEqual(it.theme.type, 'video'); assert.strictEqual(it.target.type, 'gif');
    assert.strictEqual(it.matches[0].id, 'media/video_to_gif'); assert.ok(!it.matches.some((m) => /convert_code/.test(m.id)));
    assert.strictEqual(it.plan.feasible, true, JSON.stringify(it.plan)); assert.strictEqual(it.plan.goal, 'video_gif');
});
t('離線計畫：沒有附件 → 說明缺什麼', () => {
    const r = run('Convert the video to a gif.'); const p = r.intents[0].plan; assert.strictEqual(p.feasible, false); assert.ok(/video/.test(p.reason), p.reason);
});
t('代名詞承接：上一句的附件', () => {
    const r = run('I attached the report. Please summarize it.', { attachments: [{ id: 'f2', filename: 'report.pdf' }] });
    const it = r.intents.find((x) => x.action === 'summarize'); assert.ok(it); assert.ok(it.entity, 'it → 附件');
});
t('問句：為什麼出錯→診斷，綁到錯誤輸出', () => {
    const r = run('Why does this crash?\n\n```\nTraceback (most recent call last):\n  File "a.py", line 3, in <module>\n    x = 1/0\nZeroDivisionError: division by zero\n```\n');
    const it = r.intents.find((x) => x.action === 'diagnose'); assert.ok(it, JSON.stringify(r.intents.map((x) => x.action)));
});
t('否定祈使句：不要做', () => {
    const r = run("Don't delete the file."); const it = r.intents[0]; assert.ok(it && it.neg && !it.executable); assert.strictEqual(it.plan.route, 'none');
});
t('簽名：能力表工具直接給型別', () => {
    const s = INT.signatureOf({ id: 'x', tool: 'video_to_gif', intent: 'video to gif' }); assert.ok(s.themes.has('video') && s.targets.has('gif'), JSON.stringify([...s.themes, ...s.targets]));
});
t('describe 可讀', () => { const r = run('Convert the video to a gif.', { attachments: [{ id: 'f1', filename: 'demo.mp4' }] }); assert.ok(INT.describe(r).length >= 1); });
t('論元重整：add X to Y 對 Y 做事', () => {
    const r = run('Add subtitles to the video.', { attachments: [{ id: 'f1', filename: 'a.mp4' }] }); const it = r.intents[0];
    assert.strictEqual(it.theme.type, 'video'); assert.strictEqual(it.adds, 'subtitle'); assert.strictEqual(it.matches[0].id, 'media/video_subtitle'); assert.strictEqual(it.plan.goal, 'video_subtitled');
});
t('論元重整：make X from Y 以 Y 為對象', () => {
    const r = run('Make a gif from the clip.', { attachments: [{ id: 'f1', filename: 'c.mov' }] }); const it = r.intents[0]; assert.strictEqual(it.theme.type, 'video'); assert.strictEqual(it.target.type, 'gif'); assert.strictEqual(it.plan.goal, 'video_gif');
});
t('合併兩個 pdf 一步', () => { const r = run('Merge these two pdfs into one file.', { attachments: [{ id: 'a', filename: 'a.pdf' }, { id: 'b', filename: 'b.pdf' }] }); assert.strictEqual(r.intents[0].plan.goal, 'pdf_merge'); assert.ok(r.intents[0].plan.feasible); });
t('修程式：對象在 in 片語；試算表轉 csv 不配到影片', () => {
    assert.strictEqual(run('Fix the bug in this python script.').intents[0].matches[0].id, 'coding/fix_bug');
    assert.ok(!(run('Convert the spreadsheet to csv.').intents[0].matches || []).length);
});const TOOLS = [
    { name: 'merge_pdfs', description: '把多份已上傳的PDF依指定順序合併成一份新的PDF（直接複製原始頁面物件）。回傳{ok, pdf_file_id, filename}。參數: {"files":["PDF的file_id或檔名"]}' },
    { name: 'extract_audio', description: '把一個已上傳的影片（或任何有音軌的媒體檔）的聲音抽出來，存成一個獨立的WAV音檔，回傳 {ok, audio_file_id, filename}。參數: {"file":"file_id或檔名"}' },
    { name: 'convert_to_animated_gif', description: '把影片（或其中一段時間範圍）轉成動態GIF存進persistentStorage。回傳 {ok, gif_file_id, filename, fps}。參數: {"video":"file_id或檔名", "range":"（選填）", "fps":（選填）}' },
    { name: 'burn_subtitles', description: '把字幕燒進影片，產生一支內嵌字幕的新影片。回傳 {ok, video_file_id, filename}。參數: {"video":"file_id或檔名", "subtitle":"（選填）字幕檔file_id"}' },
    { name: 'images_to_pdf', description: '把多張圖片依順序轉成一份PDF。回傳 {ok, pdf_file_id}。參數: {"files":["圖片file_id或檔名"]}' },
];
t('從工具定義自己學：型別、別名、敘述結構', () => {
    const L = INT.learnTools(TOOLS); assert.deepStrictEqual(L.tools.convert_to_animated_gif.ins, ['video']); assert.deepStrictEqual(L.tools.convert_to_animated_gif.outs, ['gif']);
    assert.deepStrictEqual(L.tools.extract_audio.ins, ['video']); assert.deepStrictEqual(L.tools.extract_audio.outs, ['audio']); assert.deepStrictEqual(L.tools.images_to_pdf.ins, ['image']);
    assert.strictEqual(L.alias['影片'], 'video'); assert.strictEqual(L.tools.merge_pdfs.narrative.pattern, '把 X …成 Z');
});
t('只靠工具定義（沒有手寫目錄）：影片轉 GIF 配到對的工具，程式轉換不配到影片工具', () => {
    const u1 = NLU.understand('Convert the video to a gif.', { catalog: [] }); const a = INT.derive(u1, { tools: TOOLS, attachments: [{ id: 'f', filename: 'a.mp4' }] }).intents[0];
    assert.strictEqual(a.matches[0].id, 'tool/convert_to_animated_gif', JSON.stringify(a.matches));
    const u2 = NLU.understand('Convert this python script to javascript.', { catalog: [] }); const b = INT.derive(u2, { tools: TOOLS }).intents[0];
    assert.ok(!(b.matches || []).length, JSON.stringify(b.matches)); assert.ok(b.rejected.length >= 1);
    const u3 = NLU.understand('Extract the audio from the video.', { catalog: [] }); const c = INT.derive(u3, { tools: TOOLS, attachments: [{ id: 'f', filename: 'a.mp4' }] }).intents[0]; assert.strictEqual(c.matches[0].id, 'tool/extract_audio', JSON.stringify(c.matches));
});console.log(n + ' passed, ' + bad.length + ' failed', bad);
