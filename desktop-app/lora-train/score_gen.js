'use strict';
/* score_gen.js — 替 eval_gen.py 的輸出評分（需要 node 與判題器）。
 *
 *   node score_gen.js out/eval/base.json [out/eval/tuned.json] [--eval_file data/heldout.jsonl]
 *
 * 評分（每個 domain/stage 都列出來，包含退步）：
 *   fn_template/code_split   ：valid＝JSON 合法、有 main、每個 calls 都指向清單裡的函式；names＝函式名集合與標準答案相同；
 *                              calls＝名稱相同且每個函式的呼叫關係也相同
 *   fn_template/code_write_fn：judge＝把模型寫的函式放進「標準答案的其他函式」組成整份程式，判題器 AC（真的跑 tests＋hidden）
 *                              （另列 def＝輸出裡有定義該函式）
 *   think_stack/self_validate：ok 欄位相同（false 時另列 missing 有內容）
 *   think_stack/review_return：每一項的 ok 都相同
 *   think_stack/plan_check   ：JSON 合法且 checks 是非空陣列（答案本來就沒有唯一，所以只看格式）
 *   其他 stage               ：不在這裡評（用 eval_run.py）
 * 判題用的題目要從種子題庫用 meta.problem_id＋source_file 找回來；找不到的題記為 skipped，不算對也不算錯。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const runner = require(path.join(ROOT, 'judge-runner.js'));

const args = process.argv.slice(2);
const evalFile = (() => { const i = args.indexOf('--eval_file'); if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; } return path.join(__dirname, 'data', 'heldout.jsonl'); })();
const files = args;
if (!files.length) { console.error('用法：node score_gen.js base.json [tuned.json] [--eval_file …]'); process.exit(2); }

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const gold = new Map(readJsonl(evalFile).map((r) => [r.id, r]));
const probCache = new Map();
function problemOf(row) {
    const key = row.source_file + '|' + row.meta.problem_id;
    if (probCache.has(key)) return probCache.get(key);
    let p = null;
    try { p = readJsonl(path.join(ROOT, row.source_file)).find((x) => x.id === row.meta.problem_id) || null; } catch (_) { p = null; }
    probCache.set(key, p); return p;
}
const jsonOf = (t) => { const m = /\{[\s\S]*\}/.exec(String(t || '')); if (!m) return null; try { return JSON.parse(m[0]); } catch (_) { return null; } };
const codeOf = (t) => { const m = /```(?:python)?\s*\n([\s\S]*?)(?:```|$)/.exec(String(t || '')); return (m ? m[1] : String(t || '')).trim(); };
const nameSet = (o) => (o && Array.isArray(o.functions) ? o.functions.map((f) => String(f && f.name)).sort().join(',') : null);
const callMap = (o) => (o && Array.isArray(o.functions) ? JSON.stringify(o.functions.map((f) => [String(f && f.name), (Array.isArray(f && f.calls) ? f.calls : []).slice().sort()]).sort()) : null);

async function scoreOne(r, g) {
    const k = g.domain + '/' + g.stage; const out = r.output; const m = {};
    if (k === 'fn_template/code_split') {
        const o = jsonOf(out), want = jsonOf(g.completion);
        const names = o && Array.isArray(o.functions) ? o.functions.map((f) => f && f.name) : [];
        m.valid = !!(o && Array.isArray(o.functions) && o.functions.length && names.includes('main') && o.functions.every((f) => f && Array.isArray(f.calls || []) && (f.calls || []).every((c) => names.includes(c))));
        m.names = nameSet(o) !== null && nameSet(o) === nameSet(want);
        m.calls = m.names && callMap(o) === callMap(want);
    } else if (k === 'fn_template/code_write_fn') {
        const fn = g.meta.fn; const code = codeOf(out);
        m.def = new RegExp('(^|\\n)def\\s+' + fn + '\\s*\\(').test(code);
        const prob = problemOf(g);
        if (!prob) return { skipped: true };
        // 同一題的其他函式用標準答案
        const siblings = [...gold.values()].filter((x) => x.stage === 'code_write_fn' && x.source_file === g.source_file && x.meta.problem_id === g.meta.problem_id && x.meta.fn !== fn);
        const parts = siblings.map((x) => codeOf(x.completion)).concat([code]);
        const imports = [], body = [];
        for (const p of parts) for (const l of p.split('\n')) (/^(import|from)\s/.test(l) ? imports : body).push(l);
        const source = Array.from(new Set(imports)).join('\n') + '\n' + body.join('\n') + '\nmain()\n';
        if (!m.def) m.judge = false;
        else { const v = await runner.judge({ lang: 'python', source: source.replace(/\nmain\(\)\n\nmain\(\)\n$/, '\nmain()\n'), problem: prob, timeoutMs: 8000 }); m.judge = v.verdict === 'AC'; }
    } else if (k === 'think_stack/self_validate') {
        const o = jsonOf(out), want = jsonOf(g.completion);
        m.ok = !!(o && typeof o.ok === 'boolean' && o.ok === want.ok);
        if (want.ok === false) m.neg_ok = m.ok; else m.pos_ok = m.ok;
    } else if (k === 'think_stack/review_return') {
        const o = jsonOf(out), want = jsonOf(g.completion);
        m.items = !!(o && Array.isArray(o.results) && want.results.every((w, i) => o.results[i] && (o.results[i].ok !== false) === (w.ok !== false)));
    } else if (k === 'think_stack/plan_check') {
        const o = jsonOf(out); m.valid = !!(o && Array.isArray(o.checks) && o.checks.length);
    } else return { skipped: true };
    return { k, m };
}

(async () => {
    const tables = [];
    for (const f of files) {
        const data = JSON.parse(fs.readFileSync(f, 'utf8')); const agg = {};
        for (const r of data.rows) {
            const g = gold.get(r.id); if (!g) continue;
            const s = await scoreOne(r, g); if (s.skipped) continue;
            const a = (agg[s.k] = agg[s.k] || { n: 0 }); a.n++;
            for (const [mk, v] of Object.entries(s.m)) { a[mk] = a[mk] || { y: 0, n: 0 }; a[mk].n++; if (v) a[mk].y++; }
        }
        tables.push({ file: f, adapter: data.adapter || '(base)', agg });
    }
    const keys = new Set(); tables.forEach((t) => Object.keys(t.agg).forEach((k) => keys.add(k)));
    for (const k of [...keys].sort()) {
        console.log('\n' + k);
        const metrics = new Set(); tables.forEach((t) => t.agg[k] && Object.keys(t.agg[k]).filter((x) => x !== 'n').forEach((x) => metrics.add(x)));
        for (const mk of metrics) console.log('  ' + mk.padEnd(8) + tables.map((t) => { const c = t.agg[k] && t.agg[k][mk]; return (path.basename(t.file) + ' ' + (c ? c.y + '/' + c.n : '-')).padEnd(34); }).join(''));
        if (tables.length === 2) { for (const mk of metrics) { const a = tables[0].agg[k] && tables[0].agg[k][mk], b = tables[1].agg[k] && tables[1].agg[k][mk]; if (a && b && b.y < a.y) console.log('  REGRESSION ' + mk + ' ' + a.y + ' → ' + b.y); } }
    }
})();
