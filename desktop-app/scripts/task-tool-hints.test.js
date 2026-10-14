'use strict';
// 「依任務文字補專用工具」（FA_TASK_TOOL_HINTS／_faTaskToolHints）的純函式測試：node scripts/task-tool-hints.test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
const a = src.indexOf('/* TASK-HINTS-BEGIN */'), b = src.indexOf('/* TASK-HINTS-END */'); assert.ok(a > 0 && b > a, '找不到 TASK-HINTS 標記');
const hints = new Function(src.slice(a, b) + '\nreturn _faTaskToolHints;')();
let ok = 0; const bad = []; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n); console.log('FAIL', n, e.message.slice(0, 300)); } };
const ids = (s) => hints(s).map((h) => h.id);
t('真實對話的兩份委派任務都命中', () => {
  assert.deepStrictEqual(ids('處理 12 張上傳的圖片檔案（file_id 已提供），需求如下：1. 依檔名編號前綴排序 2. 等比例縮放 3. 將 12 張處理後的圖片各佔一頁，合併成單一 PDF'), ['images_to_pdf']);
  assert.deepStrictEqual(ids('處理圖片轉 PDF 任務：資料夾路徑：C:\\Users\\hungfu.lee\\Pictures\\topdf\\in-1 1. 列出該資料夾所有 .jpg/.jpeg 檔案 4. 使用 img2pdf 將處理後的圖片依序合併為單一 PDF'), ['images_to_pdf']);
});
t('一般說法都命中', () => { for (const s of ['把這些照片合成一個pdf', 'jpg 轉 pdf', '圖片轉PDF', 'combine these images into a PDF', 'merge scans into one pdf', '做一份pdf，內容是附件這些圖片', '把 png 變成 PDF']) assert.deepStrictEqual(ids(s), ['images_to_pdf'], s); });
t('反方向（PDF→圖片、從 PDF 抽圖）與無關任務不命中', () => { for (const s of ['把 pdf 轉成圖片', 'PDF 轉 PNG', 'convert pdf to jpg', '抽出 PDF 裡的圖片', '從 PDF 取出所有照片', 'pdf中的圖片幫我解讀', '合併兩份PDF', '分析這份 pdf 的內容', '畫一張流程圖', '把照片縮小成一半']) assert.deepStrictEqual(ids(s), [], s); });
t('命中時補的工具與提醒內容', () => { const h = hints('圖片轉PDF')[0]; assert.ok(h.tools.includes('images_to_pdf') && h.tools.includes('list_uploaded_files')); assert.ok(/fit:"contain"/.test(h.note) && /orientation:"auto"/.test(h.note) && /img2pdf/.test(h.note) && /folder/.test(h.note)); });
t('合併文件類：有 docx／xlsx／文字檔＋合併＋pdf 才命中 merge_pdfs', () => {
  for (const s of ['把這三個 docx 和一個 xlsx 合併成一份 PDF', 'merge word and excel files into one pdf', '合併成一個pdf，內容有 txt 跟 docx', '把 pdf 、docx、圖片合併成一份']) assert.ok(ids(s).includes('merge_pdfs') || /圖片/.test(s), s);
  assert.ok(ids('把 docx 合併成 pdf').includes('merge_pdfs'));
  for (const s of ['合併兩份PDF', '把 pdf 轉成 word', '拆分 pdf 的 docx 範例', 'extract pages from pdf', '寫一份 docx 報告']) assert.ok(!ids(s).includes('merge_pdfs'), s);
  assert.deepStrictEqual(ids('圖片合併成一個pdf'), ['images_to_pdf']);
});
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
