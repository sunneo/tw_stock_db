'use strict';
/* colu 領域產生器：offline_stack_core.js 的 CoLU 式推入取出（coluChoose／routeColu／coluRestate／parseLetter）。
 *
 * 注意（跟 schema.md 的概略說明不同，以程式碼為準）：真正的 coluChoose/parseLetter 不在 think_stack.js，
 * 而在 renderer/src/recipe/offline_stack_core.js；think_stack.js 只提供框架（push/pop/header/wrap），
 * offline_stack_core.js 才是「模型只答一個字母」的 CoLU 機制本體。
 *
 * 真實來源：renderer/src/recipe/offline_stack.test.js 裡已經斷言過正確答案的情境：
 *   - 基本 coluChoose（「查天氣」該選哪個選項）：test 行 43-50，斷言 r.index === 1（搜尋）。
 *   - routeColu 2 候選（calc／search）：test 行 54-60，直接斷言 r.index/r.none，以及 measureRoute 的
 *     m.colu.correct === 3（「算 1+1」「查雨」「你好」三句話）。
 *   - 去位置偏誤 6 種接線（vote/def/nf/re）那組測試（test 行 68-81）：3 候選（calc／search／code，帶 def），
 *     對 noneFirst（nf）與 restate（re）兩種接線，逐句斷言 r.index/r.none。
 *
 * 作法：不手刻 prompt。直接 require offline_stack_core.js／think_stack.js，呼叫真正的
 * coluChoose()／routeColu()／makeRouteColu()（restate 版）。用一個「讀選單找正確那一行、回傳正確字母」的
 * oracle generate（只讀 production 自己組出來的選單文字，不是我們自己猜字母在哪個位置——所以同一題換了
 * 選項排列、附不附 def，oracle 都還是從訊息內容裡現讀），跑一次完整流程：產生的 messages 直接來自
 * production，completion 是 oracle 回傳、且已經被 coluChoose/parseLetter 的真正驗證通過的那個字串。
 */
const path = require('path');
const O = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'offline_stack_core.js'));
const T = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'think_stack.js'));

const SOURCE_FILE = 'renderer/src/recipe/offline_stack.test.js';

// 從 production 組出來的選單文字裡，找「符合 matcher 的那一行」開頭的字母（A/B/C…）。
// 不預先假設排列順序——不論 noneFirst／多排列投票／附不附 def，都是現場從訊息內容讀。
function findLetter(messages, matcher) {
    const content = messages.map((m) => String(m.content || '')).join('\n');
    for (const raw of content.split('\n')) {
        const line = raw.trim();
        const m = /^([A-J])\.\s*(.*)$/.exec(line);
        if (m && matcher(m[2])) return m[1];
    }
    return null;
}
const toolMatcher = (tool) => (tool == null ? (text) => text.indexOf('都不是') >= 0 : (text) => text.indexOf('（工具 ' + tool + '）') >= 0);
const textMatcher = (want) => (text) => text.indexOf(want) >= 0;

// oracle：讀選單找到正確字母，依 prefill 組出 production 解析器會接受的完整回覆（含 prefill 本身，
// 跟這個 codebase 其餘 generate() 的慣例一致：回傳的是完整字串，不是只回傳 prefill 之後新增的部分）。
function makeOracle(matcher, wantTool) {
    return async (req) => {
        const letter = findLetter(req.messages, matcher);
        if (!letter) throw new Error('oracle 找不到符合的選單行（want=' + wantTool + '）');
        if (req.prefill === '工具：') return '工具：' + (wantTool == null ? '都不是' : wantTool) + '，答案：' + letter;
        return (req.prefill || '') + letter;
    };
}

async function generate() {
    const rows = [];
    let skipped = 0;
    let seq = 0;
    const push = (row) => { seq++; rows.push(Object.assign({ id: 'colu:' + SOURCE_FILE + ':' + seq }, row)); };
    const fail = (why) => { skipped++; console.error('[gen_colu] 跳過：' + why); };

    // ---- 情境 1：基本 coluChoose（offline_stack.test.js 行 43-50 的「查天氣」題，斷言 r.index===1） ----
    {
        const options = [{ text: '算數' }, { text: '搜尋' }, { text: '都不是', isDefault: true }];
        const text = '查天氣'; const want = '搜尋'; const wantIdx = 1;
        const stack = O.fromRounds('目標X', [{ by: 'recipe', ok: false, reason: '沒有' }]);
        const captured = {};
        const oracle = async (req) => { const raw = await makeOracle(textMatcher(want), null)(req); captured.messages = req.messages; captured.prefill = req.prefill || ''; captured.raw = raw; return raw; };
        const r = await O.coluChoose({ stack, stackMod: T, generate: oracle, options, text });
        if (!r.ok || r.index !== wantIdx) { fail('coluChoose 基本情境驗證不過（查天氣）：' + JSON.stringify(r)); }
        else {
            push({ domain: 'colu', stage: 'colu_letter_choice', messages: captured.messages, prefill: captured.prefill, completion: captured.raw.slice(captured.prefill.length), verified_by: 'program_ground_truth', split: 'train', source_file: SOURCE_FILE, meta: { mechanism: 'coluChoose', text, want, options: options.map((o) => o.text), tries: r.tries } });
        }
    }

    // ---- 情境 2：routeColu，2 候選（calc／search），4 句已知正確答案的話 ----
    {
        const cands = [{ tool: 'calc', intent: '算數' }, { tool: 'search', intent: '搜尋' }];
        const cases = [
            { question: '幫我算', want: 'calc' },
            { question: '你好', want: null },
            { question: '算 1+1', want: 'calc' },
            { question: '查雨', want: 'search' },
        ];
        for (const c of cases) {
            const stack = O.fromRounds('路由', [{ by: 'recipe', ok: false, reason: '沒有現成做法' }]);
            const captured = {};
            const oracle = async (req) => { const raw = await makeOracle(toolMatcher(c.want), c.want)(req); captured.messages = req.messages; captured.prefill = req.prefill || ''; captured.raw = raw; return raw; };
            const r = await O.routeColu({ cands, question: c.question, generate: oracle, stack, stackMod: T, label: '選工具' });
            const got = r.ok ? (r.none ? null : cands[r.index] && cands[r.index].tool) : undefined;
            if (!r.ok || got !== c.want) { fail('routeColu（2 候選）驗證不過：' + c.question + '（want=' + c.want + '，got=' + got + '）'); continue; }
            push({ domain: 'colu', stage: 'colu_letter_choice', messages: captured.messages, prefill: captured.prefill, completion: captured.raw.slice(captured.prefill.length), verified_by: 'program_ground_truth', split: 'train', source_file: SOURCE_FILE, meta: { mechanism: 'routeColu', cands: cands.map((x) => x.tool), question: c.question, want: c.want, tries: r.tries } });
        }
    }

    // ---- 情境 3：去位置偏誤接線（offline_stack.test.js 行 68-81），3 候選＋def，noneFirst 與 restate 兩種 ----
    {
        const cands = [
            { tool: 'calc', intent: '算數', def: '做計算' },
            { tool: 'search', intent: '搜尋', def: '上網查' },
            { tool: 'code', intent: '寫程式', def: '寫碼' },
        ];
        const cases = [
            { question: '幫我算', want: 'calc' },
            { question: '查一下', want: 'search' },
            { question: '寫程式', want: 'code' },
            { question: '你好', want: null },
        ];
        const variants = [
            { key: 'nf', cfg: { noneFirst: true }, stage: 'colu_letter_choice' },
            { key: 're', cfg: { restate: true }, stage: 'colu_restate_choice' },
        ];
        for (const v of variants) {
            const router = O.makeRouteColu(v.cfg);
            for (const c of cases) {
                const stack = O.fromRounds('g', []);
                const captured = {};
                const oracle = async (req) => { const raw = await makeOracle(toolMatcher(c.want), c.want)(req); captured.messages = req.messages; captured.prefill = req.prefill || ''; captured.raw = raw; return raw; };
                const r = await router({ cands, question: c.question, generate: oracle, stack, stackMod: T, label: '選工具' });
                const got = r.ok ? (r.none ? null : cands[r.index] && cands[r.index].tool) : undefined;
                if (!r.ok || got !== c.want) { fail('makeRouteColu(' + v.key + ')（3 候選＋def）驗證不過：' + c.question + '（want=' + c.want + '，got=' + got + '）'); continue; }
                push({ domain: 'colu', stage: v.stage, messages: captured.messages, prefill: captured.prefill, completion: captured.raw.slice(captured.prefill.length), verified_by: 'program_ground_truth', split: 'train', source_file: SOURCE_FILE, meta: { mechanism: 'makeRouteColu(' + v.key + ')', cands: cands.map((x) => x.tool), question: c.question, want: c.want, tries: r.tries } });
            }
        }
    }

    console.error('[gen_colu] 產生 ' + rows.length + ' 筆（來源：' + SOURCE_FILE + '／renderer/src/recipe/offline_stack_core.js，跳過 ' + skipped + ' 筆）');
    return rows;
}

module.exports = { generate };

if (require.main === module) {
    (async () => {
        for (const row of await generate()) process.stdout.write(JSON.stringify(row) + '\n');
    })();
}
