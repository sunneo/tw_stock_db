'use strict';
// 思考寫程式迴圈的基準（量「小模型靠切割＋思考堆疊＋判題重寫，能把種子題寫對多少」）。
//   node scripts/eval/code_loop_bench.js [--backend replay|http|native] [--lang python] [--via direct|colu] [--model-dir D --ort-dir D --threads N] [--trace-file f.jsonl] [--write-mode guided|free（預設：有文法的語言走 guided）] [--problems all|id1,id2] [--max-rethink 3] [--max-calls 40]
//        [--url http://127.0.0.1:8080/v1/chat/completions --model 名稱 --key-env 環境變數名 --think] [--out report.json] [--no-stack-checks]
// replay：回放參考解（只證明管線；數字不是模型能力）。http：OpenAI 相容的聊天服務（llama.cpp server、vLLM、Ollama 的 /v1…），這才是量模型。
// 這台機器沒有 qwen3-0.6b 的模型檔（桌面版執行時按需下載、下載前要使用者同意），所以 http 模式需要你自己把模型服務跑起來再指給它。
// 輸出：每題的判決、模型呼叫次數、重寫次數、耗時；總表有「一次通過率」（AC 且沒重寫）、「重寫後通過率」、平均呼叫；
//       hidden 失敗但範例全過的題另外列出（過擬合／寫死範例的訊號）。不寫入任何檔案，除非給 --out。
const fs = require('fs'); const path = require('path');
const R = require('../../judge-runner.js'); const Agent = require('../../renderer/src/recipe/code_agent_core.js'); const Loop = require('../../renderer/src/recipe/code_loop_core.js'); const Fake = require('../../renderer/src/recipe/code_loop_fake.js');
const Plan = require('../../renderer/src/recipe/plan_core.js'); const LC = require('../../renderer/src/recipe/lang_colu_core.js'); const Think = require('../../renderer/src/recipe/think_stack.js');
const PROBLEMS_FILE = path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'seed', 'problems.jsonl');

function loadProblems(ids) { const all = fs.readFileSync(PROBLEMS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); return ids && ids !== 'all' ? all.filter((p) => ids.split(',').includes(p.id)) : all; }

// OpenAI 相容的 generate：忽略 prefill（不是每個服務都支援），jsonStep 會自己從回覆裡解析 JSON；enableThinking 用 chat_template_kwargs 傳（llama.cpp／vLLM 認得）
function httpGenerate(o) {
  return async (req) => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), req.timeoutMs || o.timeoutMs || 120000);
    try {
      const headers = { 'content-type': 'application/json' }; if (o.key) headers.authorization = 'Bearer ' + o.key;
      const body = { model: o.model, messages: req.messages, max_tokens: req.maxTokens || 600, temperature: o.temperature == null ? 0 : o.temperature, stream: false };
      if (req.enableThinking !== undefined) body.chat_template_kwargs = { enable_thinking: !!req.enableThinking };
      const res = await fetch(o.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
      const j = await res.json(); const m = j.choices && j.choices[0] && j.choices[0].message; return (m && (m.content || '')) || '';
    } catch (e) { if (e && e.name === 'AbortError') { const err = new Error('逾時'); err.timeout = true; throw err; } throw e; } finally { clearTimeout(timer); }
  };
}

// 回放：把參考解當「模型」，只在 python 有（種子題的 ref 是 python）
function replayBackend(problem) {
  const m = Fake.makeScriptedModel({ plan: { functions: [{ name: 'main', signature: 'def main()', purpose: '整個程式', calls: [] }] }, codes: { main: [problem.ref.python] } });
  return { ask: m.ask, write: m.write };
}

// 走 CoLU：把需求包成使用者的話 → matchGoals → buildPlan（帶語言，每種語言有自己的能力）→ advance；該語言專屬的本機函式（local_write_code_<語言>）呼叫 runCode（宿主 _planEnv 做的就是這件事）
async function viaColu(p, lang, deps) {
  const text = '寫一個程式：' + p.statement; const facts = Plan.factsFrom({ text, lang }); const goals = Plan.matchGoals(text, facts);
  const goal = goals.find((g) => g.id === 'code_program'); if (!goal) return { ok: false, verdict: 'NO_GOAL', gaps: ['CoLU 沒有把這個需求分類成 code_program：' + goals.map((g) => g.id).join(',')], calls: { ask: 0, write: 0, judge: 0 }, rethinks: 0 };
  const pr = Plan.buildPlan(goal, facts); if (!pr.ok) return { ok: false, verdict: 'NO_PLAN', gaps: [pr.reason], calls: { ask: 0, write: 0, judge: 0 }, rethinks: 0 };
  const run = Plan.createRun(goal, facts, pr, text); let captured = null;
  const env = { tool: async () => ({ ok: false, text: '不該呼叫 AI 工具' }), stackMod: Think, fns: { [LC.toolName(lang)]: async () => { captured = await deps.runCode(); return captured.ok ? { ok: true, text: captured.source, json: { gaps: captured.gaps } } : { ok: false, text: (captured.gaps && captured.gaps[0]) || captured.verdict }; } } };
  await Plan.advance(run, env); const r = captured || { ok: false, verdict: 'NO_RUN', gaps: ['計畫沒有執行到寫程式：' + run.state], calls: { ask: 0, write: 0, judge: 0 }, rethinks: 0 };
  r.colu = { goal: goal.id, plan: pr.steps.map((x) => x.tool), state: run.state }; return r;
}

async function run(o) {
  o = Object.assign({ backend: 'replay', lang: 'python', problems: 'all', maxRethink: 3, maxCalls: 40, stackChecks: true, think: false, via: 'direct' }, o || {});
  if (o.backend === 'replay' && o.lang !== 'python') throw new Error('回放模式只有 python 的參考解；其他語言請用 --backend http');
  const av = await R.available(o.lang); if (!av.ok) throw new Error('這台機器沒有 ' + o.lang + ' 的工具鏈：' + av.reason);
  let gen = null; let nativeGen = null;
  if (o.backend === 'http') gen = httpGenerate(o);
  else if (o.backend === 'native') { const { makeNativeGenerate } = require('./native_gen_adapter.js'); if (!o.modelDir || !o.ortDir) throw new Error('native 模式需要 --model-dir 與 --ort-dir'); nativeGen = makeNativeGenerate({ modelDir: o.modelDir, ortDir: o.ortDir, threads: o.threads || 8 }); gen = nativeGen; }
  // 每次模型呼叫都記一筆（給診斷用：看它被問了什麼、回了什麼）
  const traceFile = o.traceFile; let curId = ''; const rawGen = gen;
  if (gen && traceFile) { const wrapped = async (req) => { const t0 = Date.now(); let out = '', err = ''; try { out = await rawGen(req); return out; } catch (e) { err = String((e && e.message) || e); throw e; } finally { const u = req.messages.filter((m) => m.role === 'user').pop(); fs.appendFileSync(traceFile, JSON.stringify({ problem: curId, ms: Date.now() - t0, think: !!req.enableThinking, maxTokens: req.maxTokens, sys: String((req.messages[0] || {}).content || '').slice(0, 80), user_tail: String(u ? u.content : '').slice(-300), out: String(out).slice(0, 1500), err }) + '\n'); } }; wrapped.openCursor = rawGen.openCursor; wrapped.tokenizer = rawGen.tokenizer; wrapped.stats = rawGen.stats; gen = wrapped; } // 包裝要保留游標（約束解碼用）
  const rows = [];
  for (const p of loadProblems(o.problems)) {
    const t0 = Date.now(); let res; curId = p.id;
    const judge = ({ lang, source }) => R.judge({ lang, source, problem: p }); const check = ({ lang, source }) => R.check({ lang, source });
    try {
      if (o.backend === 'replay') res = await Loop.solve({ problem: p, lang: o.lang, ask: replayBackend(p).ask, write: replayBackend(p).write, judge, opts: { maxRethink: o.maxRethink, maxCalls: o.maxCalls } });
      else {
        const runCode = () => Agent.runCode({ text: p.statement, lang: o.lang, problem: { id: p.id, title: p.title, statement: p.statement, tests: p.tests }, generate: gen, judge, check, opts: { maxRethink: o.maxRethink, maxCalls: o.maxCalls, stackChecks: o.stackChecks, split: o.split, writeMode: o.writeMode, guidedStrategy: o.strategy, guided: { deadlineMs: o.deadlineMs } } });
        res = o.via === 'colu' ? await viaColu(p, o.lang, { runCode }) : await runCode();
      }
    } catch (e) { res = { ok: false, verdict: 'ERROR', gaps: [String((e && e.message) || e).slice(0, 200)], calls: { ask: 0, write: 0, judge: 0 }, rethinks: 0 }; }
    // 驗收時 hidden 也要過才算 AC；範例全過但 hidden 沒過 = 寫死／過擬合
    let overfit = false; if (res.source && res.verdict !== 'AC') { const only = await R.judge({ lang: o.lang, source: res.source, problem: Object.assign({}, p, { hidden: [] }) }).catch(() => null); overfit = !!(only && only.verdict === 'AC'); }
    rows.push({ id: p.id, tags: p.tags, colu: res.colu, verdict: res.verdict, first_try: res.verdict === 'AC' && !res.rethinks, rethinks: res.rethinks || 0, calls: (res.calls ? res.calls.ask + res.calls.write : 0), rank: res.calls ? (res.calls.rank || 0) : 0, guided: (res.trace || []).filter((e) => e.t === 'guided').map((e) => (e.ok ? '✓' : '✗' + e.reason)), choose: res.calls ? (res.calls.choose || 0) : 0, free: res.calls ? (res.calls.free || 0) : 0, judge_calls: res.calls ? res.calls.judge : 0, ms: Date.now() - t0, overfit, gaps: (res.gaps || []).slice(0, 3) });
    if (o.progress) o.progress(rows[rows.length - 1]);
  }
  const ac = rows.filter((r) => r.verdict === 'AC'); const summary = { backend: o.backend, lang: o.lang, model: o.model || '', problems: rows.length, ac: ac.length, first_try: rows.filter((r) => r.first_try).length, after_rethink: ac.length - rows.filter((r) => r.first_try).length, overfit: rows.filter((r) => r.overfit).map((r) => r.id), mean_calls: rows.length ? +(rows.reduce((a, r) => a + r.calls, 0) / rows.length).toFixed(2) : 0, total_ms: rows.reduce((a, r) => a + r.ms, 0), via: o.via, tokens: nativeGen ? nativeGen.stats : undefined };
  return { summary, rows };
}

function toMarkdown(rep) {
  const s = rep.summary; const L = ['# 思考寫程式迴圈基準（' + s.backend + (s.model ? '：' + s.model : '') + '，' + s.lang + '）', '', '- 題數 ' + s.problems + '；AC ' + s.ac + '（一次通過 ' + s.first_try + '、重寫後通過 ' + s.after_rethink + '）；平均模型呼叫 ' + s.mean_calls + ' 次；總耗時 ' + (s.total_ms / 1000).toFixed(1) + ' 秒', s.overfit.length ? '- **範例全過但 hidden 沒過（可能寫死範例）**：' + s.overfit.join('、') : '- 沒有「範例全過但 hidden 沒過」的題', s.backend === 'replay' ? '- ⚠ 回放模式：「模型」是參考解，這些數字只證明管線，不是模型能力' : '', '', '| 題目 | 判決 | 一次過 | 重寫 | 自由寫 | 選擇題 | 打分 | 引導結果（每次寫函式一格；✓＝引導寫完、✗＝退回自由寫） | 耗時(ms) |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rep.rows) L.push('| ' + r.id + ' | ' + r.verdict + ' | ' + (r.first_try ? '✓' : '') + ' | ' + r.rethinks + ' | ' + r.calls + ' | ' + r.choose + ' | ' + r.rank + ' | ' + (r.guided.join(' ') || '—') + ' | ' + r.ms + ' |');
  return L.filter((x) => x !== '').join('\n') + '\n';
}

module.exports = { run, toMarkdown, httpGenerate, loadProblems, viaColu };

if (require.main === module) {
  const argv = process.argv.slice(2); const get = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; }; const has = (k) => argv.includes('--' + k);
  const key = get('key-env') ? process.env[get('key-env')] : undefined;
  run({ backend: get('backend') || 'replay', via: get('via') || 'direct', modelDir: get('model-dir'), ortDir: get('ort-dir'), threads: +(get('threads') || 8), traceFile: get('trace-file'), lang: get('lang') || 'python', problems: get('problems') || 'all', maxRethink: +(get('max-rethink') || 3), maxCalls: +(get('max-calls') || 40), url: get('url'), model: get('model'), key, writeMode: get('write-mode'), strategy: get('strategy'), deadlineMs: +(get('fn-deadline-sec', 300)) * 1000, stackChecks: !has('no-stack-checks'), progress: (r) => process.stderr.write(r.id.padEnd(18) + r.verdict + '\n') })
    .then((rep) => { process.stdout.write(toMarkdown(rep)); if (get('out')) fs.writeFileSync(get('out'), JSON.stringify(rep, null, 2)); })
    .catch((e) => { console.error('FAIL', e.message || e); process.exit(1); });
}
