#!/usr/bin/env node
// 網頁版冷載入量測（2026-11-15）：在真瀏覽器（使用者的 Chrome）量「沒有快取時助理多久就緒」，前後對照用。
//
// 用法：
//   node scripts/web-cold-load-probe.js --print
//       印出要貼進 Chrome 開發者工具（或 javascript_tool）的量測程式。
//   node scripts/web-cold-load-probe.js --summarize <結果檔.json>
//       讀取量測程式回傳的 JSON，印出摘要：就緒時間、來源（jsDelivr 或 raw）、分塊數、開機候選區塊（可用來寫 scripts/web-lazy-boot.json）。
//
// 冷快取的做法（管理者在 Chrome 進行）：
//   1. 開一個新的無痕視窗（或在 DevTools Network 勾 Disable cache，重新整理前先清 Storage／Cache Storage）。
//   2. 開 https://sunneo.github.io/tw_stock_db/web/aiweb/ ，等頁面跑完，在 Console 貼 --print 的程式（它會讀 performance 紀錄）。
//   3. 把回傳物件存成 JSON 檔，用 --summarize 看摘要。
// 注意：「就緒」以 window.fa 出現為準；量測程式在頁面跑完後才執行，就緒時間是由 performance 紀錄推得的近似值（chunk 最後結束時間與 fa 出現時間取較大者）。
'use strict';
const fs = require('fs');

// 瀏覽器端執行的量測程式（只讀 performance 紀錄與 window.fa，不改頁面、不發請求）
const PROBE_SRC = `(() => {
  const t0 = performance.timeOrigin;
  const res = performance.getEntriesByType('resource').map(e => ({
    name: e.name, initiator: e.initiatorType, start: Math.round(e.startTime), end: Math.round(e.responseEnd),
    size: e.encodedBodySize || 0, transfer: e.transferSize || 0
  }));
  const isLazy = n => /\\/web-lazy\\//.test(n);
  const chunks = res.filter(r => isLazy(r.name) && /\\/chunks\\//.test(r.name));
  const core = res.find(r => /\\/web-lazy\\/core\\.js/.test(r.name));
  const jsd = res.filter(r => /cdn\\.jsdelivr\\.net/.test(r.name)).length;
  const raw = res.filter(r => /raw\\.githubusercontent\\.com/.test(r.name)).length;
  const faReady = typeof window.fa !== 'undefined';
  const lastLazy = Math.max(0, ...res.filter(r => isLazy(r.name)).map(r => r.end));
  const readyApprox = faReady ? Math.round(lastLazy) : null;
  // 核心下載完成後才開始執行、才會發出的分塊請求，當成開機候選（近似，見 --summarize 的提醒）
  const bootCandidates = core ? chunks.filter(r => r.start >= core.end).map(r => r.name.split('/chunks/')[1].replace(/\\.js$/, '')) : [];
  return {
    probedAt: new Date().toISOString(), page: location.href, faReady, readyApproxMs: readyApprox,
    coreUrl: core ? core.name : null, coreStart: core ? core.start : null, coreEnd: core ? core.end : null, coreBytes: core ? core.size : null,
    chunkCount: chunks.length, chunkNames: chunks.map(c => c.name.split('/chunks/')[1]),
    fromJsDelivr: jsd, fromRaw: raw, bootCandidates,
    resources: res.filter(r => isLazy(r.name) || /api\\.github\\.com|supabase/.test(r.name)),
    timeOriginEpoch: t0
  };
})()`;

function summarize(file) {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const kb = (n) => (n ? Math.round(n / 1024) + ' KB' : '未知');
    const lines = [
        '網頁版冷載入量測摘要（' + (d.probedAt || '') + '）',
        '  頁面：' + (d.page || '') + '　助理就緒：' + (d.faReady ? '是' : '否（window.fa 不存在）'),
        '  就緒時間（近似）：' + (d.readyApproxMs != null ? d.readyApproxMs + ' 毫秒' : '無法判定'),
        '  核心：' + (d.coreUrl || '沒有找到') + '（' + kb(d.coreBytes) + '，' + d.coreStart + '→' + d.coreEnd + ' 毫秒）',
        '  來源：jsDelivr ' + (d.fromJsDelivr || 0) + ' 個、raw ' + (d.fromRaw || 0) + ' 個',
        '  分塊：' + (d.chunkCount || 0) + ' 個',
        '  開機候選區塊（核心下載完成後才發出請求的分塊）：' + ((d.bootCandidates || []).join(', ') || '（無）'),
        '  提醒：候選清單是「依下載時間推得」的近似；正式清單請用 window.__FA_LAZY_TRACE 量的實際載入順序，確認後寫進 scripts/web-lazy-boot.json。',
    ];
    console.log(lines.join('\n'));
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args[0] === '--print') {
        process.stdout.write(PROBE_SRC + '\n');
    } else if (args[0] === '--summarize' && args[1]) {
        summarize(args[1]);
    } else {
        console.error('用法：node scripts/web-cold-load-probe.js --print | --summarize <結果檔.json>');
        process.exit(2);
    }
}

module.exports = { PROBE_SRC, summarize };
