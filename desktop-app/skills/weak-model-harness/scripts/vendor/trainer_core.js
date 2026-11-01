'use strict';
// 由 scripts/pack.js 從 renderer/src/floating-assistant.js 切出（離線訓練器的語意核心與規則核心）；不要手改，改來源後重跑 pack.js。
const FA_SEM_VER = 4;
const FA_SEM_GROUPS = {
    search: '搜尋 搜索 查詢 查找 查 找 尋找 檢索 search find lookup query google bing',
    web: '網路 網頁 網站 網址 上網 瀏覽器 網際網路 web website webpage browser internet online url http',
    news: '新聞 消息 報導 頭條 news headline article',
    stock: '股票 股價 台股 個股 大盤 加權指數 漲跌 技術分析 型態 stock price market taiex tsmc 台積電',
    file: '檔案 文件 檔 file document',
    folder: '資料夾 目錄 文件夾 路徑 folder directory dir path',
    read: '讀取 讀 打開 開啟 開 讀檔 查看 看 瀏覽 檢視 read open view show display cat',
    write: '寫入 寫 存檔 儲存 另存 建立檔案 新增檔案 輸出 write save create output',
    delete: '刪除 移除 清除 刪 delete remove erase clear',
    edit: '修改 編輯 更改 改 更新 取代 edit modify change update replace patch',
    download: '下載 抓取 擷取 取得 download fetch get scrape crawl',
    upload: '上傳 傳送 傳 upload send transfer',
    video: '影片 視頻 影音 錄影 video movie clip mp4 youtube',
    audio: '音訊 音檔 聲音 錄音 音樂 audio sound music mp3 wav',
    image: '圖片 圖像 照片 影像 相片 圖 image picture photo png jpg jpeg',
    pdf: 'pdf 文件檔',
    office: 'word excel powerpoint ppt pptx docx xlsx 簡報 投影片 試算表 文書 office slide slides deck spreadsheet',
    convert: '轉換 轉成 轉檔 轉 換成 變成 convert transform export encode decode',
    summarize: '摘要 總結 重點 概述 彙整 整理 summarize summary digest tldr overview',
    translate: '翻譯 譯成 譯 translate translation',
    explain: '解釋 說明 介紹 講解 什麼是 為什麼 原理 explain describe introduce why what meaning',
    code: '程式 程式碼 寫程式 開發 編程 實作 原始碼 code program programming develop implement source script',
    debug: '除錯 偵錯 修bug 錯誤 異常 當機 bug debug error exception crash fix troubleshoot traceback',
    test: '測試 單元測試 驗證 檢查 test unittest verify check validate lint',
    build: '建置 編譯 打包 構建 build compile package bundle make cmake',
    deploy: '部署 發佈 上線 發布 deploy release publish ship',
    git: 'git 版本控制 版控 commit push pull branch merge clone checkout diff 提交 推送 拉取 分支 合併',
    terminal: '終端機 命令列 指令 命令 終端 shell terminal command cli bash powershell cmd console',
    python: 'python py pip pyodide 腳本',
    javascript: 'javascript js node npm typescript ts',
    run: '執行 運行 跑 啟動 run execute launch start invoke',
    click: '點擊 按 點 按鈕 click press button tap',
    screenshot: '截圖 螢幕擷取 擷取畫面 screenshot capture screen',
    form: '表單 填寫 輸入 填入 form fill input type',
    chart: '圖表 走勢圖 K線 折線圖 長條圖 統計圖 chart plot graph candlestick',
    diagram: '流程圖 架構圖 時序圖 類別圖 示意圖 diagram flowchart uml mermaid sequence',
    svg: 'svg 向量圖 繪圖 畫圖 繪製 draw drawing vector',
    animation: '動畫 動態 animation animate motion keyframe',
    scene3d: '3d 三維 立體 場景 模型 three scene 3D場景 render 渲染',
    database: '資料庫 資料表 sql sqlite database table query',
    rag: '知識庫 記憶 筆記 記住 記錄 圖譜 rag memory knowledge note remember',
    schedule: '排程 提醒 定時 時間 日期 現在幾點 schedule reminder cron time date clock now today',
    settings: '設定 配置 選項 偏好 設定檔 settings config configuration preference option',
    model: '模型 llm 語言模型 model gpt claude gemini ollama',
    transcribe: '逐字稿 語音辨識 聽寫 辨識語音 transcribe whisper speech recognition subtitle 字幕',
    tts: '朗讀 語音合成 念出來 發音 tts speak voice readaloud',
    ocr: '文字辨識 圖片轉文字 ocr 辨識文字',
    email: '電子郵件 郵件 信件 寄信 email mail gmail',
    calendar: '行事曆 日曆 會議 活動 calendar meeting event',
    math: '計算 算 數學 加減乘除 公式 calculate math compute formula sum average',
    list: '列出 清單 列表 有哪些 顯示全部 list ls enumerate all',
    compare: '比較 差異 對照 差別 diff compare difference versus',
    analyze: '分析 診斷 評估 研究 analyze analysis diagnose evaluate investigate',
    generate: '產生 生成 製作 做一個 建立 創作 generate create make produce build-me',
    help: '幫助 說明書 怎麼用 用法 教學 指南 help usage guide tutorial how-to 使用方式 功能 features',
    security: '安全 漏洞 弱點 加密 權限 密碼 security vulnerability cve exploit encrypt permission password',
    network: '網路 連線 封包 代理 proxy network packet socket http https dns',
    bmc: 'bmc openbmc redfish ipmi 韌體 firmware',
    uefi: 'uefi bios edk tianocore 開機 韌體',
    docker: 'docker 容器 container kubernetes k8s 映像',
    mobile: 'android ios 手機 行動 app 應用程式',
    game: '遊戲 game unity unreal',
    hardware: '硬體 感測器 傳輸 raspberry gpio i2c spi 樹莓派 嵌入式 embedded sensor',
    parallel: '平行 並行 多執行緒 多核 parallel concurrent thread gpu hpc mpi openmp cuda',
    project: '專案 repo repository 倉庫 結構 架構 專案結構 codebase wiki 百科',
    symbol: '函式 函數 類別 符號 定義 function class symbol method definition 變數 variable',
    dependency: '依賴 相依 引用 呼叫 關聯 import include require dependency call reference related',
};
function _faSemBuildLex(groups, extra) {
    const lex = { word: {}, cjk: [] };
    const all = Object.assign({}, groups || {});
    for (const k in (extra || {})) all[k] = (all[k] ? all[k] + ' ' : '') + extra[k];
    for (const id in all) {
        String(all[id]).toLowerCase().split(/\s+/).filter(Boolean).forEach((t) => {
            if (/^[a-z0-9\-_.#+]+$/.test(t)) { (lex.word[t] = lex.word[t] || []).push(id); }
            else lex.cjk.push([t, id]);
        });
    }
    return lex;
}
const FA_SEM_LEX = _faSemBuildLex(FA_SEM_GROUPS);

// ============================================================
// 2026-10-02：離線語意核心（Offline Trainer與專案問答共用）。構想來自使用者的 DomainResolver（pattern_rules + chromadb
// + TextRank），這裡全部用純JavaScript重寫、不需要任何模型或網路：
//   語意＝特徵雜湊嵌入（英文詞＋CJK單字與雙字組，確定性，同樣文字永遠同樣向量）＋餘弦相似度
//   文字重排＝BM25（字面）＋TextRank（候選之間的中心性，PageRank）＋MMR（多樣性）
// 下面這幾個函式刻意「自給自足」（不引用外面的變數），因為會用toString()塞進產生出來的HTML，在純HTML／JS裡離線問答。
// ============================================================
function _faSemTokens(text, lex) {
    lex = lex || (typeof FA_SEM_LEX !== 'undefined' ? FA_SEM_LEX : null);
    const STOP_EN = { the: 1, a: 1, an: 1, and: 1, or: 1, but: 1, if: 1, of: 1, to: 1, in: 1, on: 1, for: 1, with: 1, as: 1, by: 1, at: 1, from: 1, is: 1, are: 1, was: 1, were: 1, be: 1, this: 1, that: 1, it: 1, its: 1, not: 1, no: 1, so: 1, than: 1, which: 1, who: 1, what: 1, when: 1, where: 1, how: 1, can: 1, will: 1, do: 1, does: 1, did: 1, has: 1, have: 1, had: 1, i: 1, you: 1, he: 1, she: 1, we: 1, they: 1, there: 1, here: 1 };
    const STOP_ZH = '的了是在有和與及或也都就把被讓給對於請幫我你他她它們這那一個嗎呢吧啊哦喔呀嘛什麼怎麼如何可以能不要會想要把將';
    const s = String(text == null ? '' : text).replace(/https?:\/\/\S+/gi, ' http ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.\-\/\\]+/g, ' ').toLowerCase();
    const out = [];
    const re = /[a-z0-9]+|[\u3400-\u9fff\uf900-\ufaff]+/g;
    let m;
    while ((m = re.exec(s))) {
        const w = m[0];
        if (/^[a-z0-9]+$/.test(w)) { if (w.length >= 2 && !STOP_EN[w]) out.push(w); else if (/^\d+$/.test(w)) out.push(w); continue; }
        const chars = Array.from(w);
        for (let i = 0; i < chars.length; i++) {
            if (STOP_ZH.indexOf(chars[i]) < 0) out.push('c:' + chars[i]);
            if (i + 1 < chars.length && !(STOP_ZH.indexOf(chars[i]) >= 0 && STOP_ZH.indexOf(chars[i + 1]) >= 0)) out.push('b:' + chars[i] + chars[i + 1]);
        }
    }
    // 概念特徵：同義詞（含中英文）共用一個 k:概念id，讓離線時也能跨語言、跨說法對上
    if (lex) {
        const seen = {};
        const ascii = s.match(/[a-z0-9-_.#+]+/g) || [];
        ascii.forEach((w) => { (lex.word[w] || []).forEach((id) => { if (!seen[id]) { seen[id] = 1; out.push('k:' + id); } }); });
        for (let i = 0; i < lex.cjk.length; i++) { const e = lex.cjk[i]; if (s.indexOf(e[0]) >= 0 && !seen[e[1]]) { seen[e[1]] = 1; out.push('k:' + e[1]); } }
    }
    return out;
}
function _faSemEmbed(text, dim, lex) {
    dim = dim || 256;
    const v = new Float32Array(dim);
    const toks = _faSemTokens(text, lex);
    const tf = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    for (const t in tf) {
        let h = 2166136261;
        for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
        const w = (1 + Math.log(tf[t])) * (t.indexOf('c:') === 0 ? 0.5 : (t.indexOf('k:') === 0 ? ({ code: 1, run: 1, generate: 1, file: 1, project: 1, help: 1, analyze: 1, read: 1, list: 1, test: 1, web: 1, explain: 1, settings: 1, python: 1, javascript: 1 }[t.slice(2)] ? 0.7 : 1.4) : 1));
        v[h % dim] += ((h >>> 16) & 1) ? -w : w;
    }
    let n = 0;
    for (let i = 0; i < dim; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dim; i++) v[i] /= n;
    return v;
}
function _faSemCos(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
// 句子切分（中英文標點與換行）
function _faSemSentences(text) {
    return String(text || '').replace(/\r/g, '').split(/(?<=[。！？!?；;])\s*|\n+|(?<=[.])\s+(?=[A-Z])/).map((x) => x.trim()).filter((x) => x.length > 1);
}
function _faOtSlots(text) {
    const t = String(text || '');
    const urls = t.match(/https?:\/\/[^\s)）」』"'<>]+/g) || [];
    const paths = (t.match(/(?:[A-Za-z]:[\\/][^\s"'<>|?*]+|fap:[^\s"'<>]+|(?:\.{0,2}\/)?(?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z0-9]{1,6}|\/(?:[\w.\-]+\/)*[\w.\-]+)/g) || []).filter((p) => urls.every((u) => u.indexOf(p) < 0));
    const quoted = [];
    t.replace(/[「『“"']([^「」『』“”"']{1,200})[」』”"']/g, (m, c) => { quoted.push(c); return m; });
    const numbers = t.match(/-?\d+(?:\.\d+)?/g) || [];
    const code = [];
    t.replace(/```[a-z]*\n?([\s\S]*?)```/gi, (m, c) => { code.push(c.trim()); return m; });
    const colon = /[:：]\s*([\s\S]+)$/.exec(t);
    const stock = (t.match(/\b\d{4}\b/g) || []).find(() => true);
    const identStop = { the: 1, what: 1, where: 1, which: 1, how: 1, define: 1, defined: 1, definition: 1, function: 1, class: 1, file: 1, find: 1, show: 1, with: 1, from: 1, this: 1, that: 1, please: 1, source: 1, code: 1, sdk: 1, api: 1, http: 1, https: 1, www: 1, com: 1 };
    const idents = (t.replace(/https?:\/\/\S+/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]*(?:(?:::|->|\.)[A-Za-z_][A-Za-z0-9_]*)*/g) || []).filter((x) => x.length >= 3 && !identStop[x.toLowerCase()] && (/[_A-Z0-9]|[a-z][A-Z]|::|->|\./.test(x.slice(1)) || /\w+\(/.test(t)));
    const cves = (t.match(/\bCVE-\d{4}-\d{4,7}\b/gi) || []).map((x) => x.toUpperCase());
    const hashes = t.match(/\b[0-9a-f]{12,40}\b/g) || [];
    return { problem_text: t.trim(), ident: idents[0] || '', idents, cve: cves[0] || '', cves, hash: hashes[0] || '', url: urls[0] || '', urls, path: paths[0] || '', paths, quoted: quoted[0] || '', quotedAll: quoted, number: numbers[0] || '', numbers, code: code[0] || '', after_colon: colon ? colon[1].trim() : '', stock_id: stock || '' };
}
// 把參數樣板（{problem_text}、{url}、{1}、{名稱}）填成實際參數；找不到的槽位列在 missing（需要追問使用者）
function _faOtFill(template, slots, groups) {
    const missing = [];
    const sub = (s) => {
        if (typeof s !== 'string') return s;
        const exact = /^\{(\w+)\}$/.exec(s);
        const get = (k) => {
            if (groups && Object.prototype.hasOwnProperty.call(groups, k)) return groups[k];
            if (/^\d+$/.test(k) && groups && groups._idx) return groups._idx[Number(k) - 1];
            return slots[k];
        };
        if (exact) { const v = get(exact[1]); if (v === undefined || v === '') { missing.push(exact[1]); return ''; } return v; }
        return s.replace(/\{(\w+)\}/g, (m, k) => { const v = get(k); if (v === undefined || v === '') { missing.push(k); return ''; } return String(v); });
    };
    const walk = (v) => Array.isArray(v) ? v.map(walk) : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : sub(v));
    return { args: walk(template || {}), missing: Array.from(new Set(missing)) };
}
// 單一pattern的規則比對（regex／keyword_any／keyword_all）；語意比對在外面用向量做
function _faOtMatchRule(p, text) {
    const t = String(text || '');
    try {
        if (p.type === 'regex') {
            const m = new RegExp(p.expr, (p.flags || ['i']).join('').replace(/IGNORECASE/gi, 'i').replace(/MULTILINE/gi, 'm').replace(/DOTALL/gi, 's')).exec(t);
            if (!m) return null;
            const groups = Object.assign({}, m.groups || {});
            groups._idx = m.slice(1);
            return { score: p.confidence == null ? 0.8 : p.confidence, detail: m[0].slice(0, 80), groups };
        }
        const kws = (Array.isArray(p.expr) ? p.expr : String(p.expr || '').split(/[,，\n]/)).map((x) => String(x).trim()).filter(Boolean);
        const low = t.toLowerCase();
        if (p.type === 'keyword_any') { const hit = kws.find((k) => low.indexOf(k.toLowerCase()) >= 0); if (!hit) return null; return { score: p.confidence == null ? 0.6 : p.confidence, detail: hit, groups: {} }; }
        if (p.type === 'keyword_all') { if (!kws.length || !kws.every((k) => low.indexOf(k.toLowerCase()) >= 0)) return null; return { score: Math.min(0.98, (p.confidence == null ? 0.65 : p.confidence) + 0.03 * Math.min(3, kws.length)), detail: kws.join('＋'), groups: {} }; }
    } catch (e) { return null; }
    return null;
}


module.exports = { FA_SEM_VER, FA_SEM_GROUPS, FA_SEM_LEX, _faSemBuildLex, _faSemTokens, _faSemEmbed, _faSemCos, _faSemSentences, _faOtSlots, _faOtFill, _faOtMatchRule };
