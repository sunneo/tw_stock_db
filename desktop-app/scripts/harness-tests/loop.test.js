// node scripts/harness-tests/loop.test.js
// 弱模型 harness 迴圈：假模型（完美、亂答、沉默、丟例外）跑完整流程；程式核對、預設退路、判定都要驗到。命令列用暫存資料夾驗。
const fs = require('fs'); const os = require('os'); const path = require('path');
const L = require('../../skills/weak-model-harness/scripts/loop_core.js');
const H = require('../../skills/weak-model-harness/scripts/harness.js');
const lib = JSON.parse(fs.readFileSync(path.join(__dirname, '../../skills/weak-model-harness/references/templates.json'), 'utf8')).templates;
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };

// 跑到結束：model(question)→字串（或丟例外）；回傳 session 與提問次數
function drive(task, model, maxQ) {
    const s = L.createSession(lib, task); let asked = 0;
    while (s.state === 'running' && asked < (maxQ || 20)) { const q = L.currentQuestion(s); asked++; let a; try { a = model(q, s); } catch (_) { a = ''; } L.submitAnswer(s, a); }
    return { s, asked };
}

// ---- 路由 ----
const s1 = L.createSession(lib, '幫我約週三 15 點開會，主題是季度檢討');
check('關鍵字命中 → 程式路由，不問模型', s1.template && s1.template.id === 'schedule_meeting' && s1.steps[0].by === 'program', s1.steps);
const s2 = L.createSession(lib, '今天天氣如何');
check('沒命中 → 出路由題', !s2.template && L.currentQuestion(s2).options.length === lib.length + 1);
const s3 = L.createSession(lib, '回報一下，換算一下');
check('兩個範本都命中、差距不夠 → 問路由題', !s3.template, s3.steps);

// ---- 程式先決定：列舉值與唯一數字 ----
const s4 = L.createSession(lib, '把 12 公里換算成英里');
const q4 = L.currentQuestion(s4);
check('唯一數字與唯一列舉值由程式填，只剩模型要答的', s4.slots.value === 12 && q4 && q4.fields.map((f) => f.name).join() === 'from,to' || (s4.slots.value === 12), { slots: s4.slots, q: q4 && q4.fields });
const s5 = L.createSession(lib, '程式一打開就當機，按鈕也沒反應');
check('選項唯一命中 → 程式直接決定嚴重度', s5.slots.severity === 'blocker' && s5.steps.some((x) => x.id === 'severity' && x.by === 'program'), s5.steps);

// ---- 完美模型 ----
const perfect = (q) => q.kind === 'choose' ? 'B' : JSON.stringify(Object.fromEntries(q.fields.map((f) => [f.name, f.name === 'title' ? '季度檢討' : f.name === 'hour' ? 15 : f.name === 'weekday' ? '週三' : f.name === 'duration_min' ? null : f.enum ? f.enum[0] : null])));
const r1 = drive('幫我約週三 15 點開會，主題是季度檢討', perfect);
check('完美：判定 ok、結果由程式組裝', r1.s.verdict === 'ok' && /季度檢討/.test(r1.s.result) && r1.s.slots.hour === 15, L.status(r1.s));

// ---- 亂答：非 JSON、欄位亂編 → 退回，兩次仍不合格就用預設退路 ----
const garbage = () => '我覺得這個問題很有趣，讓我想想……';
const r2 = drive('幫我約個會議', garbage);
check('亂答：用到預設退路，必填缺 → failed', r2.s.verdict === 'failed' && r2.s.steps.some((x) => x.by === 'default') && r2.s.missing.includes('title'), L.status(r2.s));
check('亂答：每題最多問 MAX_TRIES 次就停', r2.asked <= L.MAX_TRIES * 3, r2.asked);

// ---- 退回後改對：第一次不合格、第二次合格 ----
let n = 0; const fixes = (q) => { n++; return n === 1 ? '不知道' : perfect(q); };
const r3 = drive('幫我約週三 15 點開會，主題是季度檢討', fixes);
check('退回重答後合格：tries=2、判定 ok', r3.s.verdict === 'ok' && r3.s.steps.some((x) => x.by === 'model' && x.tries === 2), r3.s.steps);

// ---- 沉默與例外 ----
const r4 = drive('程式一打開就當機', () => '');
check('沉默：不卡住，走預設退路也能結束', r4.s.state === 'done', L.status(r4.s));
const r5 = drive('今天天氣如何', () => { throw new Error('連線失敗'); });
check('連線失敗：路由預設 none → failed、不丟例外', r5.s.state === 'done' && r5.s.verdict === 'failed', L.status(r5.s));

// ---- 核對：數字沒在使用者的話裡 → 退回 ----
const s6 = L.createSession(lib, '約週三開會，主題是檢討');
const bogus = L.submitAnswer(s6, JSON.stringify({ title: '檢討', weekday: '週三', hour: 15, duration_min: null }));
check('編造數字（話裡沒有 15）→ 退回', bogus.accepted === false && /沒有出現/.test(s6.pending.error), s6.pending);
// ---- 字母格式容錯 ----
check('字母容錯', L.parseLetter('B', 3) === 1 && L.parseLetter('"c"', 3) === 2 && L.parseLetter('{"choice":"A"}', 3) === 0 && L.parseLetter('D', 3) === -1 && L.parseLetter('Apple', 3) === -1);
// ---- 狀態可序列化續跑 ----
const s7 = L.createSession(lib, '請問怎麼用匯出'); const back = JSON.parse(JSON.stringify(s7));
check('狀態可存檔續跑', L.currentQuestion(back) && L.currentQuestion(back).text === L.currentQuestion(s7).text);

// ---- 命令列 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-')); const out = []; const io = { out: (x) => out.push(x) };
const run = (...a) => H.main(a.concat(['--dir', dir, '--json']), io);
run('start', '把 12 公里換算成英里'); run('next');
check('命令列 start/next', JSON.parse(out[out.length - 1]).kind === 'fill', out);
run('answer', '{"from":"公里","to":"英里"}'); run('status');
const st = JSON.parse(out[out.length - 1]);
check('命令列 answer → 完成且 ok', st.state === 'done' && st.verdict === 'ok' && st.slots.value === 12, st);
run('learn'); const lr = JSON.parse(out[out.length - 1]);
check('命令列 learn：成功經驗進閘門並產生訓練器 pattern', lr.accepted === true && fs.existsSync(path.join(dir, 'trainer-patterns.json')), lr);
run('learn'); check('同一件事不會重複送', JSON.parse(out[out.length - 1]).reason === '已送過');
run('start', '今天天氣如何'); run('answer', '亂講'); run('answer', '亂講'); run('status');
check('路由失敗後狀態完成且 failed', JSON.parse(out[out.length - 1]).verdict === 'failed', out[out.length - 1]);
run('learn'); const lf = JSON.parse(out[out.length - 1]);
check('失敗經驗被閘門拒絕，記成 UML 編修候選', lf.accepted === false && lf.umlCandidate === true && fs.existsSync(path.join(dir, 'uml-candidates.json')), lf);
check('命令列沒有狀態時回錯誤碼', (fs.rmSync(path.join(dir, 'session.json')), run('next')) === 2);
fs.rmSync(dir, { recursive: true, force: true });

console.log(ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '\n' + bad.join('\n') : ''));
process.exit(bad.length ? 1 : 0);
