// gen/gen_fn_template.js — domain "fn_template"
//
// 重用 production 的「真正」程式碼：
//   - renderer/src/recipe/code_loop_core.js 的 solve()：寫函式時送給模型的 messages（含 think_stack.js
//     的 header()/wrap() 標頭）完全是 solve() 內部組出來的，這支產生器不手刻任何提示詞字串。
//   - judge-runner.js 的 judge()：真的把組好的程式丟給本機 python 直譯器執行，對 problems.jsonl 的
//     tests/hidden 逐筆比對（judge_core.js 的 compare/summarize），回傳真實判決。
//
// 做法：對 problems.jsonl 每一題，用 code_loop_core.solve({problem, lang:'python', write, judge}) 跑一次
// 「正式流程」，但不傳 ask（split 要挑怎麼切函式需要模型回答，這支產生器沒有模型可問，所以照 solve() 自己
// 的退路——没有 ask 就退回單一入口函式 `main`，这是 solve() 本来就有的真实行为，不是我们另外发明的格式）；
// write() 回呼不呼叫模型，而是直接把題目自帶的 ref.python 參考解（經過沙盒執行驗證為正解，不是另外生成的
// 猜測）包成程式碼區塊回傳給 solve()，藉此攔截 solve() 真正建構、經過 Stack.wrap() 疊加思考堆疊標頭的
// messages；judge 回呼轉呼叫 judge-runner.js 的 judge()，讓這份 ref 解答真的跑過 problems.jsonl 自己的
// tests + hidden 測資。只有真的判決 AC 才標 verified_by:"judge_pass"；判決不是 AC 的就老實標
// "rejection_sampling" 並在 meta 記下判決與原因，不假裝驗證過。
//
// code_split（UML-design 風格把題目切成多個小函式的那一步）：code_loop_core.js 里真正的切割是靠
// ask() 把 JSON 選擇題丟給模型、模型回答「怎麼切」，normalizePlan() 只是把模型的回答整理成合法計畫——
// 切法本身不是程式能算出來的（不像 step_split_core.js 那種有限 token 積木庫可窮舉排序）。這支產生器
// 沒有模型可問，所以 code_split 这个 stage 整批跳過，不假造一份「程式自己決定」的切法。

'use strict';

const path = require('path');

const CodeLoop = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'code_loop_core.js'));
const runner = require(path.join(__dirname, '..', '..', 'judge-runner.js'));
const readFileSync = require('fs').readFileSync;

const PROBLEMS_PATH = path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'seed', 'problems.jsonl');
const SRC_PROBLEMS = 'renderer/src/recipe/seed/problems.jsonl';
const SRC_RUNNER = 'judge-runner.js';
const LANG = 'python'; // problems.jsonl 目前每一題的 ref 只有這個語言的鍵（見下方 stderr 統計再次確認）

function loadProblems() {
    const text = readFileSync(PROBLEMS_PATH, 'utf8');
    return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

// 對一題跑一次真正的 solve()：write() 不叫模型，直接餵 ref 解；judge() 轉呼叫 judge-runner.js 真的執行。
// 回傳 {skip:true, reason} 或 {skip:false, messages, completion, verified_by, verdict, gaps}
async function runOne(problem) {
    const ref = problem.ref && problem.ref[LANG];
    if (typeof ref !== 'string' || !ref.trim()) return { skip: true, reason: '沒有 ref.' + LANG };

    let captured = null;
    const writeFn = async (msgs) => {
        // solve() 對同一個函式最多只會在第一次判決不過時才重寫；我們餵的是已知正解，正常只會呼叫一次。
        // 仍用陣列收集以防萬一（例如 CHECKED/CE 之類邊緣情況造成重寫），最後只取第一次（最乾淨的單輪寫法）。
        if (!captured) captured = { msgs };
        return '```' + LANG + '\n' + ref.trim() + '\n```';
    };
    const judgeFn = async ({ lang, source }) => runner.judge({ lang, source, problem, timeoutMs: problem.timeoutMs || 8000 });

    let res;
    try {
        res = await CodeLoop.solve({ problem, lang: LANG, write: writeFn, judge: judgeFn, opts: { maxRethink: 0 } });
    } catch (e) {
        return { skip: true, reason: 'solve() 丟出例外：' + e.message };
    }
    if (!captured) return { skip: true, reason: 'write() 沒有被呼叫到（非預期）' };
    if (res.verdict === 'UNAVAILABLE') return { skip: true, reason: '這台機器沒有 ' + LANG + ' 工具鏈，judge 回報 UNAVAILABLE' };

    const verified = res.verdict === 'AC';
    return {
        skip: false,
        messages: captured.msgs,
        completion: '```' + LANG + '\n' + ref.trim() + '\n```',
        verified_by: verified ? 'judge_pass' : 'rejection_sampling',
        verdict: res.verdict,
        gaps: res.gaps || [],
    };
}

async function generate() {
    const problems = loadProblems();
    const rows = [];
    const skipped = [];
    let judgePass = 0, rejectionSampling = 0;

    for (const problem of problems) {
        let out;
        try {
            out = await runOne(problem);
        } catch (e) {
            skipped.push(problem.id + '：執行時例外（' + e.message + '）');
            continue;
        }
        if (out.skip) { skipped.push(problem.id + '：' + out.reason); continue; }
        if (out.verified_by === 'judge_pass') judgePass++; else rejectionSampling++;
        rows.push({
            id: 'fn_template:problems.jsonl:code_write:' + problem.id,
            domain: 'fn_template',
            stage: 'code_write',
            messages: out.messages,
            completion: out.completion,
            verified_by: out.verified_by,
            split: 'train',
            source_file: SRC_PROBLEMS,
            meta: {
                problem_id: problem.id,
                tags: problem.tags || [],
                lang: LANG,
                checker: problem.checker || 'tokens',
                tests: (problem.tests || []).length,
                hidden: (problem.hidden || []).length,
                judge_verdict: out.verdict,
                judge_source: SRC_RUNNER,
                gaps: out.gaps,
            },
        });
    }

    process.stderr.write(
        '[gen_fn_template] problems.jsonl 共 ' + problems.length + ' 題，產生 ' + rows.length + ' 筆 code_write（' +
        'judge_pass=' + judgePass + '、rejection_sampling=' + rejectionSampling + '），跳過 ' + skipped.length + ' 題' +
        (skipped.length ? '：' + JSON.stringify(skipped) : '') + '\n'
    );
    process.stderr.write(
        '[gen_fn_template] 誠實說明：code_split（把題目切成多個小函式）這個 stage 完全跳過——' +
        'code_loop_core.js 真正的切法是把 JSON 選擇題丟給模型（ask()）決定怎麼切，這支產生器沒有模型可問；' +
        '沒有 ask 時 solve() 會走它自己内建的退路（單一入口函式 main），這支產生器就是用這條退路跑 code_write，' +
        '不是另外發明的格式。problems.jsonl 的 ref 目前每一題都只有 ' + LANG + ' 這個語言鍵，所以沒有產生其他語言的 code_write。\n'
    );

    return rows;
}

module.exports = { generate };

if (require.main === module) {
    (async () => {
        for (const row of await generate()) process.stdout.write(JSON.stringify(row) + '\n');
    })();
}
