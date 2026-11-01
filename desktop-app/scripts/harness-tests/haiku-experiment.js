#!/usr/bin/env node
// 小樣本實驗：光桿小模型 vs 小模型＋harness。預設模型 claude-haiku-5-5，用無頭模式 claude -p 呼叫。
//   node scripts/harness-tests/haiku-experiment.js [--model claude-haiku-5-5] [--limit 8] [--dry]
// 規則：第一次呼叫就失敗（登入過期、額度、模型不可用）→ 立刻中止並印「未驗證」，不重試、不編數字。
// 結果與用量寫到 .weak-harness/experiment-<時間>.json。--dry 只印會呼叫幾次，不呼叫。
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const L = require('../../skills/weak-model-harness/scripts/loop_core.js');
const lib = JSON.parse(fs.readFileSync(path.join(__dirname, '../../skills/weak-model-harness/references/templates.json'), 'utf8')).templates;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const only = arg('--only', '') ? arg('--only', '').split(',').map(Number) : null;
const model = arg('--model', 'claude-haiku-5-5'), limit = Number(arg('--limit', 8)), dry = process.argv.includes('--dry');

// 固定題組：期望的範本與欄位（人工寫的標準答案）
const TASKS = [
    { task: '約週三 15 點開會，主題是季度檢討', template: 'schedule_meeting', slots: { weekday: '週三', hour: 15, title: '季度檢討' } },
    { task: '把 12 公里換算成英里', template: 'convert_units', slots: { value: 12, from: '公里', to: '英里' } },
    { task: '30 磅等於多少公斤', template: 'convert_units', slots: { value: 30, from: '磅', to: '公斤' } },
    { task: '程式一打開就當機，連線也斷了', template: 'triage_issue', slots: { severity: 'blocker', area: 'network' } },
    { task: '排版有點對不齊，按鈕也歪了', template: 'triage_issue', slots: { severity: 'minor', area: 'ui' } },
    { task: '請問怎麼用匯出功能', template: 'triage_issue', slots: { severity: 'question', area: 'data' } },
    { task: '幫我重新命名，前面加 2024_', template: 'rename_files', slots: { mode: 'prefix', text: '2024_' } },
    { task: '重新命名檔名，把 draft 取代成 final', template: 'rename_files', slots: { mode: 'replace', text: 'final', target: 'draft' } }
].slice(0, limit).filter((t, i) => !only || only.includes(i));

const usage = { calls: 0, input: 0, output: 0, cost: 0, ms: 0 };
function callModel(prompt) {
    const t0 = Date.now(); const r = spawnSync('claude', ['-p', '--model', model, '--output-format', 'json'], { input: prompt, encoding: 'utf8', timeout: 90000, shell: process.platform === 'win32' });
    usage.calls++; usage.ms += Date.now() - t0; let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
    if (!j || j.is_error) { const e = new Error((j && j.result) || r.stderr || '呼叫失敗'); e.fatal = true; throw e; }
    usage.input += (j.usage.input_tokens || 0) + (j.usage.cache_read_input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0); usage.output += j.usage.output_tokens || 0; usage.cost += j.total_cost_usd || 0;
    return String(j.result || '');
}

function bareTask(t) {
    const desc = lib.map((x) => x.id + '（' + x.label + '）：' + x.questions.map((q) => q.kind === 'choose' ? q.id + ' 只能是 ' + q.options.map((o) => o.key).join('/') : q.fields.map((f) => f.name + (f.enum ? '(' + f.enum.join('/') + ')' : '')).join('、')).join('；')).join('\n');
    const out = callModel('使用者的話：' + t.task + '\n可選的範本與欄位：\n' + desc + '\n請選一個範本並填欄位，沒提到的填 null。只輸出一個 JSON：{"template":"...","slots":{...}}');
    const J = require('../../renderer/src/recipe/recipe_core.js').parseJsonLoose(out);
    return J && typeof J === 'object' ? { template: J.template, slots: J.slots || {}, valid: true } : { template: null, slots: {}, valid: false };
}
function harnessTask(t) {
    const s = L.createSession(lib, t.task); let asked = 0, rejected = 0;
    while (s.state === 'running' && asked < 12) { const q = L.currentQuestion(s); asked++; const ans = callModel('你在一個固定流程裡，只回答這一題，不要解釋。\n' + q.text); const r = L.submitAnswer(s, ans); if (r.accepted === false) rejected++; }
    return { template: s.template ? s.template.id : null, slots: s.slots, asked, rejected, verdict: s.verdict, valid: true };
}
function score(t, got) {
    const keys = Object.keys(t.slots); const hit = keys.filter((k) => String(got.slots[k]) === String(t.slots[k])).length;
    return { routeOk: got.template === t.template, slotHit: hit, slotOf: keys.length, exact: got.template === t.template && hit === keys.length };
}

const plannedCalls = TASKS.length + TASKS.length * 2;
if (dry) { console.log('模型 ' + model + '；題數 ' + TASKS.length + '；光桿約 ' + TASKS.length + ' 次呼叫，harness 約 ' + TASKS.length * 2 + ' 次（程式先決定的題目不呼叫）'); process.exit(0); }
const result = { model, at: new Date().toISOString(), tasks: TASKS.length, bare: [], harness: [], note: '' };
try {
    for (const t of TASKS) { const g = bareTask(t); result.bare.push(Object.assign({ task: t.task }, g, score(t, g))); }
    const usageBare = Object.assign({}, usage);
    for (const t of TASKS) { const g = harnessTask(t); result.harness.push(Object.assign({ task: t.task }, g, score(t, g))); }
    result.usage = { bare: usageBare, total: usage };
    const sum = (a) => ({ exact: a.filter((x) => x.exact).length, routeOk: a.filter((x) => x.routeOk).length, invalid: a.filter((x) => !x.valid).length, slots: a.reduce((n, x) => n + x.slotHit, 0) + '/' + a.reduce((n, x) => n + x.slotOf, 0) });
    result.summary = { bare: sum(result.bare), harness: sum(result.harness), rejectedAnswers: result.harness.reduce((n, x) => n + x.rejected, 0) };
    console.log(JSON.stringify(result.summary, null, 1)); console.log('用量', JSON.stringify(usage));
} catch (e) {
    result.note = '未驗證：' + String(e.message).slice(0, 200); result.usage = { total: usage };
    console.log('未驗證：實驗中止（' + String(e.message).slice(0, 120) + '）；已呼叫 ' + usage.calls + ' 次。沒有任何成績可報。');
}
const dir = path.join(process.cwd(), '.weak-harness'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'experiment-' + Date.now() + '.json'), JSON.stringify(result, null, 1));
process.exit(result.note ? 3 : 0);
