// node scripts/eval/plan_real_run.js [outfile]
// 計畫路徑的真模型實跑（真模型 qwen3-0.6b q8、CPU 參考引擎；資料全是假的）：
//   D：doc_summary（附件：假的文字檔）→ parse_uploaded_file → local_summarize（真模型逐段摘要）
//   W：web_research（非新聞查詢）→ browser_search（假搜尋結果）→ pick_urls → fetch_web_page（假網頁）→ local_summarize（真模型）
// 流程用 floating-assistant.js 裡真的 _planEnv／_planLocalSummarize（抽出方法本體執行），計畫用 plan_core 的真 buildPlan／advance。
// 每一輪的進度行（transcribe）印出來並寫進結果 JSON。每個案例只跑一次（CPU 上每次摘要約 2 分鐘）。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer/src/floating-assistant.js'), 'utf8');
const P = require(path.join(ROOT, 'renderer/src/recipe/plan_core.js'));
const R = require(path.join(ROOT, 'renderer/src/recipe/recipe_core.js'));
const { loadModel } = require('./qwen_cpu_model.js');
const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'plan_real_run.json');
const t0 = Date.now(); const log = (m) => console.log('[' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + m);

// 把方法本體從 floating-assistant.js 抽出來（到下一個同層級方法之前，取最後一個 }）
function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    const nxt = /\n    (async )?[_a-zA-Z][_a-zA-Z0-9]*\(/g; nxt.lastIndex = m.index + m[0].length; const n = nxt.exec(SRC);
    const chunk = SRC.slice(m.index + 1, n ? n.index : SRC.length); const close = chunk.lastIndexOf('}');
    return chunk.slice(0, close + 1);
}
const ctx = { console, Promise, JSON, FaRecipe: R, FaPlan: P, FaVlm: { textBudget: () => ({ prompt: 700 }) }, FA_OT_RISKY_TOOL: /(?!)/, FaLangColu: { languages: [], toolName: () => '' }, FaDesign: {} };
vm.createContext(ctx);
const C = vm.runInContext('({' + ['_planEnv', '_planLocalSummarize', '_planReadText'].map(methodSource).join(',\n') + '})', ctx);

// ---- 假資料 ----
const DOC = '會議紀錄（2026 年 11 月 17 日）\n' +
    '一、Q4 產品規劃：離線模型的平日任務範本要在十二月底前完成，優先順序是網頁查資料、文件摘要與 log 分析。\n' +
    '二、預算：GPU 測試機採購延後到明年一月，現有的 Geforce 720T 機器繼續用來做相容性測試。\n' +
    '三、風險：軟體 WebGPU 無法驗證 shader-f16，真 GPU 的結果需要使用者回報，文件摘要的品質目前還沒有在真實文件上驗證。\n' +
    '四、決議：下週一由平台組先提供三份真實文件給團隊測試，摘要結果一律標示是否經過 AI。';
const PAGE_URL = 'https://example.com/tsmc-dividend';
const PAGE = '台積電董事會通過每股現金股利新台幣 4 元，較上一季持平。公司表示股利政策以長期穩定為原則，並依自由現金流量調整。' +
    '分析師認為在 AI 晶片需求仍強的背景下，股利政策短期內不會有大幅變動；另有研究指出，高殖利率股的股價波動通常較小。';

// 假日誌（確定性產生）：每 5 行一則 ERROR、每 7 行一則 WARN、每 11 行一則帶堆疊續行的 ERROR，其餘 INFO
const LOGTEXT = Array.from({ length: Number(process.env.LOG_LINES) || 120 }, (_, i) => {
    const t = '2026-11-17 10:' + String(Math.floor(i / 4)).padStart(2, '0') + ':' + String((i * 7) % 60).padStart(2, '0');
    if (i % 11 === 0) return t + ' ERROR db-pool 連線池耗盡\n  at pool.acquire(pool.js:88)\n  at handler(api.js:12)';
    if (i % 5 === 0) return t + ' ERROR payment-api 呼叫銀行閘道逾時（第 ' + ((i % 3) + 1) + ' 次重試）';
    if (i % 7 === 0) return t + ' WARN 磁碟使用率 91% 於 /data';
    return t + ' INFO 請求處理完成 200';
}).join('\n');

// 假的檔案清單（檔案整理用）：有可以認的副檔名，也有看不出類別的
const FILES = ['2026Q4 產品規劃.pdf', '會議照片.JPG', '展示影片.mp4', '報價單.xlsx', 'config.yaml', '備份.zip', '無副檔名的檔案', '未知格式.dat'];

// ---- 跑一個計畫 ----
async function runPlan(M, name, o) {
    const self = {
        tools: o.tools, advancedSettings: {}, requestUserForm: async () => null,
        // 檔案快取：產品裡附件與抓回的網頁都是 file_id，_planLocalSummarize 用 fileCache 讀回文字（這裡放假資料）
        fileCache: { get: async (id) => (o.files && o.files[id] != null ? { blob: { text: async () => o.files[id] } } : null) },
    };
    self._planLocalSummarize = C._planLocalSummarize.bind(self);
    self._planReadText = C._planReadText.bind(self);
    self._planEnv = C._planEnv.bind(self);
    self._planEnv = C._planEnv.bind(self);
    const facts = P.factsFrom({ attachments: o.attachments || [], url: o.url || '', query: o.query || '', text: o.text, online: false });
    const goal = P.GOALS.find((g) => g.id === o.goal); if (!goal) throw new Error('沒有目標 ' + o.goal);
    const plan = P.buildPlan(goal, facts, {}); if (!plan.ok) throw new Error(name + ' 建不出計畫：' + (plan.reason || JSON.stringify(plan.missing)));
    const run = P.createRun(goal, facts, plan, o.text);
    const lines = []; const prog = { log: (x) => { lines.push(x); log('  ' + x.slice(0, 300)); } };
    const env = self._planEnv(run, o.text, { M, question: o.text, calls: [], trace: R.newTrace(), prog });
    log(name + '：計畫步驟 ' + run.steps.map((s) => s.tool).join(' → '));
    await P.advance(run, env);
    const summary = run.artifacts.filter((a) => a.kind === 'summary').map((a) => String(a.value || '')).join('\n');
    return { name, state: run.state, error: run.error || '', steps: run.steps.map((s) => ({ tool: s.tool, state: s.state, error: s.error || '' })), lines, summary };
}

(async () => {
    // PLAN_FAKE_MODEL=1：不載入真模型，只回傳來源的開頭（用來先驗證接線，不耗 CPU）
    const M = process.env.PLAN_FAKE_MODEL ? { model: { id: 'fake' }, ensure: async () => null, gen: async (a) => { const u = a.messages.filter((m) => m.role === 'user').pop(); return String(u.content).slice(-60).replace(/\s+/g, ' ').slice(0, 40); } } : await loadModel({ log });
    // 案例：PLAN_CASES=D,W,L,F 只跑指定的（預設全部）
    const want = (process.env.PLAN_CASES || 'D,W,L,F').split(',').map((x) => x.trim());
    const cases = {
        // D：文件摘要（假的會議紀錄）
        D: () => runPlan(M, 'D 文件摘要', { goal: 'doc_summary', text: '幫我摘要這份文件的重點', attachments: [{ id: 'doc1234567', filename: 'meeting.txt' }], files: { doc1234567: DOC }, tools: {} }),
        // W：非新聞的網頁查資料（假搜尋結果＋假網頁）
        W: () => runPlan(M, 'W 網頁查資料（非新聞）', {
            goal: 'web_research', query: '台積電 股利政策', text: '上網查 台積電 股利政策 並整理重點',
            tools: {
                browser_search: { callback: async () => JSON.stringify({ ok: true, results: [PAGE_URL], text: PAGE_URL }) },
                fetch_web_page: { callback: async (args) => { const a = JSON.parse(args); return JSON.stringify(a.url === PAGE_URL ? { ok: true, url: a.url, file_id: 'webpage1234567' } : { ok: false, error: '404' }); } },
            },
            files: { webpage1234567: PAGE },
        }),
        // L：日誌分析（篩選→逐段讀→合併）；假日誌
        L: () => runPlan(M, 'L 日誌分析', { goal: 'log_summary', text: '看這個 log 有什麼錯誤並分析', attachments: [{ id: 'logfile1234567', filename: 'app.log' }], files: { logfile1234567: LOGTEXT }, tools: {} }),
        // F：檔案整理（第 0 層程式排計畫、不動檔案；模型逐段說明）；假的檔名清單
        F: () => runPlan(M, '檔案整理', { goal: 'file_organize', text: '把這些檔案整理到資料夾', attachments: FILES.map((n, i) => ({ id: 'file' + String(i).padStart(8, '0'), filename: n })), tools: {} }),
    };
    // 每一次模型呼叫的完整輸入長度與原始輸出都記下來（診斷用：哪一層、模型原本答了什麼）
    const rawCalls = []; const gen0 = M.gen;
    M.gen = async (req) => { const out = await gen0(req); const u = (req.messages || []).filter((m) => m.role === 'user').pop(); rawCalls.push({ userHead: String((u && u.content) || '').slice(0, 60), inputChars: (req.messages || []).map((m) => m.content).join(' ').length, raw: String(out) }); return out; };
    const results = [];
    for (const k of want) { if (!cases[k]) throw new Error('沒有案例 ' + k); results.push(await cases[k]()); }
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    fs.writeFileSync(OUT.replace(/\.json$/, '') + '.rawcalls.json', JSON.stringify(rawCalls, null, 2));
    for (const r of results) log(r.name + ' → ' + r.state + (r.error ? '（' + r.error + '）' : '') + '\n摘要：' + r.summary);
    log('結果寫入 ' + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
