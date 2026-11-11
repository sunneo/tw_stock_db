'use strict';
/* gen_code_split.js — domain "fn_template"（計畫樣板／UML 逐層切割的「函式層」）
 *
 * 為什麼要這支：種子題庫 377 題的參考解幾乎都只有一個 main()，gen_fn_template.js 因此只能產生單函式的 code_write，
 * 「把題目切成幾個小函式」（code_loop_core.js 的 split 題）完全沒有訓練資料。
 *
 * 做法（答案由程式驗證，不是模型猜的）：
 *   1. refactor_split.py 把參考解機械式重構成 read_input／solve／main（已經有多個函式的參考解沿用原本的函式與呼叫關係）。
 *   2. 用「真正的」CodeLoop.solve()：ask 回呼攔截並回答切割題（答案＝重構出的函式清單），write 回呼攔截並回答逐函式寫作題
 *      （答案＝該函式的原始碼）。messages 是 code_loop_core.js 自己組的（含思考堆疊標頭），不是手刻字串。
 *   3. 組好的整份程式交給 judge-runner.js 在沙盒跑 tests＋hidden；沒有 AC 的題整題丟掉（重構不等價）。
 * 產出兩種 stage：code_split（切割題）、code_write_fn（逐函式寫作題）。
 *
 * 留出紀律：檔名含 heldout／holdout 的題庫，或題目本身 split==='holdout'，列一律標 split:'heldout'。
 * 誠實限制：切法是「讀入／運算／輸出」的機械式切法（再加上 14 題本來就多函式的參考解），
 * 不是人類設計師各式各樣的切法；purpose 是固定句型。評量時要看它在沒見過的題目上有沒有幫助，不能只看 loss。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CodeLoop = require(path.join(ROOT, 'renderer', 'src', 'recipe', 'code_loop_core.js'));
const runner = require(path.join(ROOT, 'judge-runner.js'));
const SEED_DIR = path.join(ROOT, 'renderer', 'src', 'recipe', 'seed');
const PY = process.env.FA_PYTHON || 'python3';
const LANG = 'python';

function loadProblems() {
    const out = [];
    for (const f of fs.readdirSync(SEED_DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
        const fileHeld = /heldout|holdout/i.test(f);
        for (const line of fs.readFileSync(path.join(SEED_DIR, f), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            const p = JSON.parse(line);
            if (!p.ref || typeof p.ref.python !== 'string') continue;
            p._file = 'renderer/src/recipe/seed/' + f;
            p._key = f + ':' + p.id;
            p._split = fileHeld || p.split === 'holdout' ? 'heldout' : 'train';
            out.push(p);
        }
    }
    return out;
}

function refactorAll(problems) {
    const res = execFileSync(PY, [path.join(__dirname, 'refactor_split.py')], { input: JSON.stringify(problems.map((p) => ({ id: p._key, ref: p.ref.python }))), maxBuffer: 1 << 28 });
    const map = new Map();
    for (const r of JSON.parse(res.toString('utf8'))) map.set(r.id, r);
    return map;
}

// import 行放在第一個用到它的函式前面（組裝時 hoist 會搬到最上面並去重）
function withImports(fns, imports) {
    const placed = new Map(fns.map((f) => [f.name, []]));
    for (const imp of imports) {
        const m = /^(?:import\s+(\w+)|from\s+(\w+)\s+import\s+(.+))$/.exec(imp.trim());
        const toks = m ? [m[1] || m[2]].concat(m[3] ? m[3].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()) : []) : [];
        const hit = fns.find((f) => toks.some((t) => t && new RegExp('(^|[^\\w.])' + t + '([^\\w]|$)').test(f.src))) || fns[0];
        placed.get(hit.name).push(imp);
    }
    return (name) => (placed.get(name).length ? placed.get(name).join('\n') + '\n' : '');
}

async function runOne(problem, plan) {
    const fns = plan.functions;
    const importFor = withImports(fns, plan.imports || []);
    const planJson = { functions: fns.map((f) => ({ name: f.name, signature: f.signature, purpose: f.purpose || '', calls: f.calls, complex: false })) };
    const cap = { split: null, writes: [] };
    const ask = async (msgs, validate) => {
        if (cap.split) return null;
        if (validate && validate(planJson).length) return null;
        cap.split = msgs;
        return planJson;
    };
    const write = async (msgs, meta) => {
        const f = fns.find((x) => x.name === (meta && meta.fn));
        if (!f) return '';
        const code = importFor(f.name) + f.src;
        cap.writes.push({ fn: f.name, msgs, code });
        return '```' + LANG + '\n' + code + '\n```';
    };
    const judge = async ({ lang, source }) => runner.judge({ lang, source, problem, timeoutMs: problem.timeoutMs || 8000 });
    const res = await CodeLoop.solve({ problem, lang: LANG, write, ask, judge, opts: { maxRethink: 0, maxFunctions: 8 } });
    return { res, cap, planJson };
}


// ---------- 思考堆疊的三種封閉題（plan_check／self_validate／review_return）：答案由程式用結構檢查算出 ----------
const FIX = {
    missingFn: (n) => '沒有定義函式「' + n + '」',
    arity: (n) => '函式「' + n + '」的參數個數和清單不同',
    stub: (n) => '函式「' + n + '」的內容是空的（只有 pass）',
};
function paramCount(sig) { const m = /\(([^)]*)\)/.exec(sig || ''); return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean).length : 0; }
// 回傳缺什麼（空字串＝沒問題）；只做「看程式碼本身就能判斷」的結構檢查
function structCheck(code, node) {
    const re = new RegExp('(^|\\n)def\\s+' + node.name + '\\s*\\(([^)]*)\\)\\s*:\\s*\\n?([\\s\\S]*)$');
    const m = re.exec(String(code || ''));
    if (!m) return FIX.missingFn(node.name);
    if (m[2].split(',').map((x) => x.trim()).filter(Boolean).length !== paramCount(node.signature)) return FIX.arity(node.name);
    const body = m[3].split('\n').map((l) => l.trim()).filter(Boolean);
    if (!body.length || body.every((l) => l === 'pass')) return FIX.stub(node.name);
    return '';
}
// 故意弄壞（三種都是看程式碼就看得出來的）：kind 輪流
function corrupt(src, node, kind) {
    if (kind === 0) return src.replace(new RegExp('def\\s+' + node.name + '\\s*\\('), 'def ' + node.name + '_v2(');
    if (kind === 1 && paramCount(node.signature) > 0) return src.replace(new RegExp('(def\\s+' + node.name + '\\s*\\()([^)]*?)(?:,\\s*)?[A-Za-z_]\\w*\\s*(\\))'), '$1$2$3');
    return src.replace(/(def\s+\w+\s*\([^)]*\)\s*:)[\s\S]*$/, '$1\n    pass');
}

// 跑一遍 solve(stackChecks:true)，ask 依提示的種類回答；mode：clean／once（第一次寫壞）／always（一直寫壞）
async function stackPass(problem, plan, mode, kind) {
    const fns = plan.functions; const importFor = withImports(fns, plan.imports || []);
    const planJson = { functions: fns.map((f) => ({ name: f.name, signature: f.signature, purpose: f.purpose || '', calls: f.calls, complex: false })) };
    const asks = []; const last = {}; let corrupted = null; const seen = {};
    const target = fns.find((f) => f.name !== 'main' && paramCount(f.signature) >= 0) || fns[0];
    const ask = async (msgs, validate) => {
        const sys = msgs[0].content, usr = msgs[msgs.length - 1].content; let ans = null, stage = null;
        if (/你是軟體設計者/.test(sys)) { ans = planJson; stage = null; }
        else if (/你在規劃深入解題的步驟/.test(sys)) { stage = 'plan_check'; ans = { checks: [{ check: '每個被呼叫的函式都有寫出來', standard: '函式清單裡每一項都有定義' }, { check: '簽名與清單一致', standard: '名稱與參數個數相同' }] }; }
        else if (/你在自我檢查/.test(sys)) {
            stage = 'self_validate'; const fn = /寫函式\s+(\w+)/.exec(usr); const node = fn && fns.find((f) => f.name === fn[1]);
            const res = /我的結果：([\s\S]*?)\n結果有回答這一題嗎/.exec(usr);
            const why = node && res ? structCheck(res[1], node) : '';
            ans = why ? { ok: false, missing: why } : { ok: true, missing: '' };
        } else if (/你在核對剛做完的結果/.test(sys)) {
            stage = 'review_return';
            const results = [];
            const lines = usr.split('\n').filter((l) => /^\d+\.\s/.test(l));
            lines.forEach((l, i) => {
                let fix = '';
                if (/被呼叫的函式都有寫出來/.test(l)) { const miss = fns.find((f) => !last[f.name] || new RegExp('(^|\\n)def\\s+' + f.name + '\\s*\\(').test(last[f.name]) === false); if (miss) fix = '少了函式「' + miss.name + '」'; }
                else if (/簽名與清單一致/.test(l)) { const bad = fns.find((f) => last[f.name] && structCheck(last[f.name], f) === FIX.arity(f.name)); if (bad) fix = FIX.arity(bad.name); }
                results.push({ i: i + 1, ok: !fix, fix });
            });
            ans = { results };
        } else return null;
        if (validate && validate(ans).length) return null;
        if (stage) asks.push({ stage, msgs, completion: JSON.stringify(ans), ans });
        return ans;
    };
    const write = async (msgs, meta) => {
        const f = fns.find((x) => x.name === (meta && meta.fn)); if (!f) return '';
        seen[f.name] = (seen[f.name] || 0) + 1;
        let code = importFor(f.name) + f.src;
        const bad = mode !== 'clean' && f === target && (mode === 'always' || seen[f.name] === 1);
        if (bad) { code = corrupt(code, f, kind); corrupted = corrupted || kind; }
        last[f.name] = code;
        return '```' + LANG + '\n' + code + '\n```';
    };
    const judge = async ({ lang, source }) => runner.judge({ lang, source, problem, timeoutMs: problem.timeoutMs || 8000 });
    await CodeLoop.solve({ problem, lang: LANG, write, ask, judge, opts: { maxRethink: 0, maxFunctions: 8, stackChecks: true } });
    return asks;
}

async function generate() {
    const problems = loadProblems();
    const plans = refactorAll(problems);
    const rows = [];
    const stat = { total: problems.length, noPlan: {}, notAC: [], unavailable: 0, ok: { train: 0, heldout: 0 }, mode: { refactor: 0, existing: 0 }, sv: { n: 0 }, svErr: 0 };
    for (const p of problems) {
        const plan = plans.get(p._key);
        if (!plan || !plan.ok) { const k = plan ? plan.reason : '沒有結果'; stat.noPlan[k] = (stat.noPlan[k] || 0) + 1; continue; }
        let r;
        try { r = await runOne(p, plan); } catch (e) { stat.notAC.push(p._key + '：例外 ' + e.message); continue; }
        if (r.res.verdict === 'UNAVAILABLE') { stat.unavailable++; continue; }
        if (r.res.verdict !== 'AC') { stat.notAC.push(p._key + '：' + r.res.verdict); continue; }
        if (!r.cap.split || r.cap.writes.length !== plan.functions.length) { stat.notAC.push(p._key + '：沒有攔截到完整的切割與寫作題'); continue; }
        stat.ok[p._split]++; stat.mode[plan.mode]++;

        // ---- 思考堆疊的三種封閉題（只收程式用結構檢查算得出答案的）----
        if (plan.functions.length > 1) {
            const seenKey = new Set();
            for (const [mode, kind] of [['clean', 0], ['once', stat.sv.n % 3], ['always', (stat.sv.n + 1) % 3]]) {
                let asks;
                try { asks = await stackPass(p, plan, mode, kind); } catch (e) { stat.svErr++; continue; }
                for (const a of asks) {
                    const neg = a.stage === 'self_validate' ? a.ans.ok === false : a.stage === 'review_return' ? a.ans.results.some((x) => x.ok === false) : false;
                    // clean 收全部（正例）；其他版本只收負例，避免同樣的正例重複
                    if (mode !== 'clean' && !neg) continue;
                    const key = a.stage + '|' + a.completion + '|' + a.msgs[a.msgs.length - 1].content;
                    if (seenKey.has(key)) continue; seenKey.add(key);
                    stat.sv[a.stage + (neg ? '_neg' : '_pos')] = (stat.sv[a.stage + (neg ? '_neg' : '_pos')] || 0) + 1;
                    rows.push({ id: 'think_stack:' + p._key + ':' + a.stage + ':' + mode + ':' + (stat.sv.n++), domain: 'think_stack', stage: a.stage, messages: a.msgs, completion: a.completion,
                        verified_by: 'program_ground_truth', split: p._split, source_file: p._file, meta: { problem_id: p.id, variant: mode, negative: neg, lang: LANG, checker: 'structCheck', functions: plan.functions.map((f) => f.name) } });
                }
            }
        }
        const meta = { problem_id: p.id, level: p.level || null, tags: p.tags || [], lang: LANG, mode: plan.mode, functions: plan.functions.map((f) => f.name), judge_source: 'judge-runner.js' };
        rows.push({
            id: 'fn_template:' + p._key + ':code_split', domain: 'fn_template', stage: 'code_split',
            messages: r.cap.split, completion: JSON.stringify(r.planJson), verified_by: 'judge_pass', split: p._split, source_file: p._file, meta,
        });
        for (const w of r.cap.writes) {
            rows.push({
                id: 'fn_template:' + p._key + ':code_write_fn:' + w.fn, domain: 'fn_template', stage: 'code_write_fn',
                messages: w.msgs, completion: '```' + LANG + '\n' + w.code + '\n```', verified_by: 'judge_pass', split: p._split, source_file: p._file,
                meta: Object.assign({}, meta, { fn: w.fn }),
            });
        }
    }
    process.stderr.write('[gen_code_split] 題數 ' + stat.total + '；可用 train=' + stat.ok.train + ' heldout=' + stat.ok.heldout + '（重構 ' + stat.mode.refactor + '、沿用 ' + stat.mode.existing + '）；'
        + '沒有切法：' + JSON.stringify(stat.noPlan) + '；判題沒過或攔截不全 ' + stat.notAC.length + (stat.notAC.length ? '：' + JSON.stringify(stat.notAC.slice(0, 8)) : '') + '；工具鏈不可用 ' + stat.unavailable + '；思考堆疊題 ' + JSON.stringify(stat.sv) + '（例外 ' + stat.svErr + '）\n');
    return rows;
}

module.exports = { generate };

if (require.main === module) {
    (async () => { for (const row of await generate()) process.stdout.write(JSON.stringify(row) + '\n'); })();
}
