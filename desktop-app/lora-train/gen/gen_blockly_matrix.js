'use strict';
/* blockly_matrix 領域產生器：algo_intent_core.js（程式讀情境）＋ py_paradigms_core.js（範式骨架＋槽位窮舉）。
 *
 * 誠實說明（跟 schema.md 的概略說明不同，以程式碼為準——這點與 gen_colu.js 的做法一致）：
 *   py_paradigms_core.js 的槽位選擇**在正式環境裡是 0 次模型呼叫**。production 的真正流程
 *   （renderer/src/uml/py_uml_pipeline_core.js 的 buildFromUML，見該檔 91 行註解「範式骨架…
 *   不問模型」）是：每個範式骨架的槽位選單很小，程式窮舉所有組合（combos()），每個組合交給
 *   判題器（沙盒）驗證，第一個 AC 就用——不問任何模型、不排序、不猜。combos()/solve() 雖然
 *   接受一個可選的 rank(skeleton, choice) 參數，但那只是「換個順序試」的數值排序，不是一個會
 *   組出 messages 餵模型的函式；整個 py_paradigms_core.js 裡沒有任何 pick()/ask()/choose() 這種
 *   會建立模型選單提示詞的函式（跟 py_cnl_choose_core.js 的 writeBlocks()/choose() 是完全不同的
 *   另一套機制，那套用在「範式骨架與課都解不出來」時的區塊微選擇迴圈，不是這個領域要訓練的目標）。
 *
 *   所以這支產生器無法像 gen_colu.js／gen_fn_template.js 那樣「攔截 production 呼叫模型的那個
 *   回呼、原封不動拿它組出來的 messages」——因為這一步 production 根本不呼叫模型。schema.md
 *   列出的 stage 名稱 block_micro_select 看起來就是為了「有朝一日把窮舉搜尋換成模型微選擇」
 *   預留的訓練目標。我們能做、且誠實的事：
 *     1. 完全重用 production 的核心函式決定「正確答案」——algo_intent_core.read() 讀情境、
 *        py_paradigms_core.forIntent() 找候選骨架、combos() 窮舉槽位組合、render()／
 *        renderHelpers() 產生程式碼（render() 內建的變數改名機制也原封不動重用，見下方
 *        extractPy()）——跟 production 的 solve() 完全同一套搜尋順序：候選骨架依序、
 *        每個骨架的組合依 combos() 的順序，第一個通過 judge-runner.js 沙盒驗證（judge_pass）
 *        的就是「正確答案」，不是我們自己猜的。
 *     2. messages 的「選單」文字本身（題目怎麼呈現、槽位怎麼條列）不是從某個 production 函式
 *        複製來的（因為不存在），是我們依 PARADIGMS 表裡**真正的** sk.label／sk.slots[].label／
 *        options[].label（全部是 production 資料，不是我們發明的演算法知識）組出的一份直白選單。
 *        completion 不是我們發明的格式：就是 combos()／render() 本來就吃的那個 choice 物件
 *        （{槽位id: 選項id, ...}）序列化成 JSON，模型若學會輸出這個 JSON，可以直接餵給
 *        render(skeleton, JSON.parse(completion), intent) 用，不需要再轉譯。
 *   這個落差在 stderr 與每筆 meta.prompt_note 都會重申，不假裝是從某個 production 函式直接複製。
 *
 * 正確答案的驗證：對每個候選骨架的每個槽位組合，呼叫 PAR.render()/renderHelpers() 產生 Python
 * 原始碼，自己另外寫一段輸入讀取程式（genReadCode，見下方；只是機械地把 algo_intent_core.js
 * 檔頭註解裡已經寫明的 inputs 形狀表轉成對應的 input() 讀法，不是新發明的演算法知識），組成完整
 * 腳本，交給 judge-runner.js 的 judge()（跟 gen_fn_template.js 同一支，真的呼叫本機 python 執行
 * problem 的 tests＋hidden）。第一個判成 AC 的組合才算數；都不過就誠實跳過整題，不湊數。
 *
 * 資料來源：renderer/src/recipe/seed/ 底下的 bench_*.jsonl／heldout*.jsonl／holdout_blockly.jsonl
 * （bench/holdout 題庫；problems.jsonl 留給 gen_fn_template.js，避免兩支產生器搶同一批題目）。
 * 檔名含 holdout／heldout 的一律 split:"heldout"，其餘 split:"train"（schema.md 規則 3）。
 */

const fs = require('fs');
const path = require('path');

const AI = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'algo_intent_core.js'));
const PAR = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'py_paradigms_core.js'));
const runner = require(path.join(__dirname, '..', '..', 'judge-runner.js'));

const SEED_DIR = path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'seed');
const SEED_REL = 'renderer/src/recipe/seed/';

// problems.jsonl 是 gen_fn_template.js 的資料來源（schema.md 的產生器清單表），這裡不重複讀取。
// 註（2026-11-10）：heldout/holdout 檔案每題在「沒有一個組合 AC」時會試滿 MAX_CANDIDATES_PER_PROBLEM
// 個組合才放棄（這些題目的用意本來就是「現有範式+矩陣層解不出來」），實測 heldout2_graph.jsonl
// 22 題跑出 0 筆、耗時遠超過 5 個 train 檔案的總和——這是誠實的結果（這些題本來就該解不出來），
// 不是 bug，但代表「production 這一步全部窮舉」在這些檔案上注定是最慢的路徑。環境變數
// BLOCKLY_MATRIX_SEED_FILES（逗號分隔）可以覆蓋要跑哪些檔案，供「先用 train 檔案跑出可訓練資料、
// heldout 檔案另外排程」這種分階段執行使用；不設就是全部 12 個檔案都跑（預設行為不變）。
const DEFAULT_SEED_FILES = [
    'bench_L0_L5_L6.jsonl', 'bench_L1_L2.jsonl', 'bench_L3_L4.jsonl', 'bench_extra.jsonl', 'bench_linux_all.jsonl',
    'heldout2_graph.jsonl', 'heldout3_graph.jsonl', 'heldout4_graph.jsonl', 'heldout5_l0.jsonl', 'heldout6_compose.jsonl',
    'heldout_all.jsonl', 'holdout_blockly.jsonl',
];
const SEED_FILES = process.env.BLOCKLY_MATRIX_SEED_FILES
    ? process.env.BLOCKLY_MATRIX_SEED_FILES.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SEED_FILES;
const splitOf = (file) => (/holdout|heldout/i.test(file) ? 'heldout' : 'train');

// 每題最多試幾個「骨架 x 槽位組合」才放棄（production 自己也有 paradigmLimit 這種搜尋上限的概念；
// 這裡純粹是為了讓產生器在合理時間內跑完，不是演算法知識）。
const MAX_CANDIDATES_PER_PROBLEM = 60;
const JUDGE_TIMEOUT_MS = 4000;

function loadSeed(file) {
    const full = path.join(SEED_DIR, file);
    const text = fs.readFileSync(full, 'utf8');
    return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

// ---- 輸入讀取程式：機械地把 algo_intent_core.js 檔頭已經寫明的 inputs 形狀表換成 input() 讀法 ----
// （k 的種類與欄位名稱全部照抄該檔檔頭註解第 5-10 行；不是另外發明的演算法知識，只是從「CNL 描述」
//  換成「直接可執行的 Python」，因為沒有 tree-sitter-python.wasm 快取可以走 B.parseCNL→IR→C2U 那條
//  正式管線——FA_TS_DIR 這台機器上没有，見 gen 期間的探索記錄。）
function genReadCode(intent) {
    const lines = [];
    let usedSys = false;
    for (const inp of intent.inputs || []) {
        switch (inp.k) {
            case 'scalars': {
                const conv = inp.type === 'float' ? 'float' : 'int';
                if (inp.names.length === 1) lines.push(inp.names[0] + ' = ' + conv + '(input())');
                else lines.push(inp.names.join(', ') + ' = map(' + conv + ', input().split())');
                break;
            }
            case 'list': {
                if (inp.elem === 'str') lines.push(inp.name + ' = input().split()');
                else if (inp.elem === 'float') lines.push(inp.name + ' = list(map(float, input().split()))');
                else lines.push(inp.name + ' = list(map(int, input().split()))');
                break;
            }
            case 'rows':
                lines.push(inp.name + ' = [tuple(map(int, input().split())) for _ in range(' + inp.count + ')]');
                break;
            case 'grid':
                lines.push(inp.name + ' = [input() for _ in range(' + inp.count + ')]');
                break;
            case 'str':
                lines.push(inp.name + ' = input()' + (inp.raw ? '' : '.strip()'));
                break;
            case 'hex':
                lines.push(inp.name + ' = input().strip()');
                break;
            case 'words':
                lines.push(inp.name + ' = input().split()');
                break;
            case 'lines':
                lines.push(inp.name + ' = [input() for _ in range(' + inp.count + ')]');
                break;
            case 'rest':
                if (!usedSys) { lines.push('import sys'); usedSys = true; }
                lines.push(inp.name + " = sys.stdin.read().split('\\n')");
                lines.push('if ' + inp.name + " and " + inp.name + "[-1] == '':");
                lines.push('    ' + inp.name + ' = ' + inp.name + '[:-1]');
                break;
            default:
                break; // pending 已經被 algo_intent_core.read() 自己拿掉了，不會出現在這裡
        }
    }
    return lines.join('\n');
}

// render()/renderHelpers() 回傳 '程式區塊：\n' + 每行縮排兩格 的 CNL 字串；對 py_paradigms_core.js
// 這些「範式骨架」而言，py() 回傳的本來就是逐行合法 Python（不是中文 CNL 關鍵字），render() 只是加了
// 這層「程式區塊：」外殼跟兩格縮排的顯示慣例（見該檔 449 行）。拿掉外殼跟縮排就是可直接執行的 Python，
// 而且 render() 內建的變數改名（撞到題目變數名稱就加 _2）已經套用過，比我們自己呼叫 sk.py() 更安全。
function stripBlockShell(cnl) {
    const body = cnl.replace(/^程式區塊：\n?/, '');
    return body.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');
}

function buildSource(sk, choice, intent, readCode) {
    const body = stripBlockShell(PAR.render(sk, choice, intent));
    let helpersSrc = '';
    if (sk.helpers) {
        const hs = PAR.renderHelpers(sk, choice, intent) || [];
        helpersSrc = hs.map((h) => {
            const hb = stripBlockShell(h.cnl).split('\n').map((l) => '    ' + l).join('\n');
            return 'def ' + h.name + '(' + h.params.join(', ') + '):\n' + hb;
        }).join('\n\n');
    }
    return [helpersSrc, readCode, body].filter((x) => x && x.length).join('\n');
}

// ---- messages：直白選單（見檔頭說明：內容全部是 production 的 sk.label/slots/options，外殼是我們寫的） ----
function buildMessages(sk, intent, statement) {
    const stmt = String(statement || '').slice(0, 500);
    const lines = [];
    lines.push('題目：' + stmt);
    lines.push('');
    lines.push('這題套用範式骨架「' + sk.id + '」（' + (sk.paradigm || '') + '）：' + sk.label);
    lines.push('請為下列每個槽位選擇正確的選項，用 JSON 物件回答（鍵是槽位 id，值是選項 id），例如：{"' + sk.slots[0].id + '":"' + sk.slots[0].options[0].id + '"}');
    for (const sl of sk.slots) {
        lines.push('- 槽位「' + sl.id + '」（' + sl.label + '）選項：' + sl.options.map((o) => o.id + '=' + o.label).join('、'));
    }
    return [{ role: 'user', content: lines.join('\n') }];
}

async function runOne(problem, sourceFile) {
    const statement = problem.statement;
    const intent = AI.read(statement);
    if (!intent.ok) return { skip: true, reason: 'algo_intent_core.read() 讀不出情境（不是這題適用的格式）' };

    const skeletons = PAR.forIntent(intent, statement);
    if (!skeletons.length) return { skip: true, reason: '沒有符合的範式骨架（forIntent 回空陣列）' };

    const readCode = genReadCode(intent);
    const tests = (problem.tests || []).concat(problem.hidden || []);
    if (!tests.length) return { skip: true, reason: '題目沒有 tests/hidden' };
    const judgeProblem = { id: problem.id, tests: problem.tests || [], hidden: problem.hidden || [], checker: problem.checker || 'tokens' };

    let tried = 0;
    for (const sk of skeletons) {
        let combos;
        try { combos = PAR.combos(sk, { limit: sk.limit }); } catch (e) { continue; }
        for (const choice of combos) {
            if (tried >= MAX_CANDIDATES_PER_PROBLEM) return { skip: true, reason: '試過 ' + tried + ' 個組合都沒有 AC（已達上限 ' + MAX_CANDIDATES_PER_PROBLEM + '）' };
            let source;
            try { source = buildSource(sk, choice, intent, readCode); } catch (e) { continue; } // RENDER_ERROR：這個組合的必要參數題目沒給，跳過（跟 production 的 solve() 一樣）
            tried++;
            let v;
            try { v = await runner.judge({ lang: 'python', source, problem: judgeProblem, timeoutMs: JUDGE_TIMEOUT_MS }); }
            catch (e) { continue; }
            if (v.verdict === 'UNAVAILABLE') return { skip: true, reason: '這台機器沒有 python 工具鏈，judge 回報 UNAVAILABLE' };
            if (v.verdict === 'AC') {
                return {
                    skip: false, sk, choice, tried, source, verdict: v.verdict,
                    messages: buildMessages(sk, intent, statement),
                    completion: JSON.stringify(choice),
                };
            }
        }
    }
    return { skip: true, reason: '試過 ' + tried + ' 個「骨架 x 槽位組合」都沒有 AC' };
}

async function generate() {
    const rows = [];
    const skippedByReason = {};
    let seq = 0;
    const skip = (file, id, reason) => { skippedByReason[reason] = (skippedByReason[reason] || 0) + 1; };

    for (const file of SEED_FILES) {
        let problems;
        try { problems = loadSeed(file); } catch (e) { process.stderr.write('[gen_blockly_matrix] 讀不到 ' + file + '：' + e.message + '\n'); continue; }
        const split = splitOf(file);
        const srcPath = SEED_REL + file;
        let fileRows = 0;
        for (const problem of problems) {
            let out;
            try { out = await runOne(problem, file); }
            catch (e) { skip(file, problem.id, 'runOne 例外：' + String(e && e.message || e)); continue; }
            if (out.skip) { skip(file, problem.id, out.reason); continue; }
            seq++; fileRows++;
            rows.push({
                id: 'blockly_matrix:' + file + ':' + problem.id,
                domain: 'blockly_matrix',
                stage: 'block_micro_select',
                messages: out.messages,
                completion: out.completion,
                verified_by: 'judge_pass',
                split,
                source_file: srcPath,
                meta: {
                    problem_id: problem.id,
                    level: problem.level,
                    paradigm: out.sk.paradigm,
                    skeleton: out.sk.id,
                    tried: out.tried,
                    judge_source: 'judge-runner.js',
                    tests: (problem.tests || []).length,
                    hidden: (problem.hidden || []).length,
                    prompt_note: 'production 這一步是 0 次模型呼叫（窮舉+沙盒）；messages 的選單外殼是本產生器組的，內容（骨架/槽位/選項說明）取自 py_paradigms_core.js 的真實資料，completion 是 render() 實際會吃的 choice 物件',
                },
            });
        }
        process.stderr.write('[gen_blockly_matrix] ' + file + '（' + split + '）：' + problems.length + ' 題，產生 ' + fileRows + ' 筆\n');
    }

    process.stderr.write('[gen_blockly_matrix] 總計產生 ' + rows.length + ' 筆（domain=blockly_matrix, stage=block_micro_select）\n');
    process.stderr.write('[gen_blockly_matrix] 跳過原因統計：' + JSON.stringify(skippedByReason) + '\n');
    process.stderr.write('[gen_blockly_matrix] 誠實說明：py_paradigms_core.js 在 production 裡的槽位選擇是 0 次模型呼叫（窮舉 combos() 逐個交給沙盒，第一個 AC 就用，見 py_uml_pipeline_core.js 的 buildFromUML 91 行附近註解「不問模型」）。' +
        '這支產生器裡的 messages 選單文字因此不是從某個 production 的 pick()/ask() 函式複製出來的（該函式不存在）；內容全部取自 py_paradigms_core.js 真實的 sk.label/slots/options 資料，completion 就是 render()/combos() 實際使用的 choice 物件格式，' +
        '「正確答案」則完全由 algo_intent_core.read()+py_paradigms_core.forIntent/combos/render 配合 judge-runner.js 真的執行 problems 的 tests/hidden 驗證過（judge_pass），不是用別的模型生成的猜測，也不是我們自己斷言的。\n');

    return rows;
}

module.exports = { generate };

if (require.main === module) {
    (async () => {
        for (const row of await generate()) process.stdout.write(JSON.stringify(row) + '\n');
    })();
}
