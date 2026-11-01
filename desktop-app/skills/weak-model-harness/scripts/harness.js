#!/usr/bin/env node
/* 弱模型 harness 命令列。用法見 ../SKILL.md。
 *   node harness.js start "<任務文字>"   開始一件事（程式先路由）
 *   node harness.js next                  印出目前這一題（封閉題）
 *   node harness.js answer "<答案>"       交出答案，程式核對
 *   node harness.js status                看目前狀態與判定
 *   node harness.js learn                 把這件事的經驗送進閘門（只收程式驗證過的成功）
 *   node harness.js reset                 清掉目前狀態
 * 選項：--dir <資料夾>（預設 ./.weak-harness）、--json（機器可讀輸出）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const tryReq = (p) => { try { return require(p); } catch (_) { return null; } };
const L = require('./loop_core.js');
const X = tryReq('./vendor/experience_core.js') || tryReq('../../../renderer/src/harness/experience_core.js');
const TEMPLATES = path.join(__dirname, '..', 'references', 'templates.json');

function parseArgs(argv) {
    const o = { _: [], dir: path.join(process.cwd(), '.weak-harness'), json: false };
    for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '--dir') o.dir = path.resolve(argv[++i]); else if (a === '--json') o.json = true; else o._.push(a); }
    return o;
}
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); }

// io: { out(line) }；回傳結束碼
function main(argv, io) {
    io = io || { out: (s) => process.stdout.write(s + '\n') };
    const o = parseArgs(argv); const cmd = o._[0]; const stateFile = path.join(o.dir, 'session.json');
    const say = (text, obj) => io.out(o.json ? JSON.stringify(obj === undefined ? { text } : obj) : text);
    const load = () => readJson(stateFile, null);
    if (cmd === 'start') {
        const task = o._.slice(1).join(' ').trim(); if (!task) { say('用法：start "<任務文字>"', { error: '沒有任務文字' }); return 2; }
        const lib = readJson(TEMPLATES, { templates: [] }).templates; const s = L.createSession(lib, task);
        writeJson(stateFile, s); const q = L.currentQuestion(s);
        say(q ? '已開始（' + (s.template ? '程式已路由到「' + s.template.label + '」' : '需要先回答路由題') + '）。接著執行 next。' : '已完成：' + s.result, { id: s.id, state: s.state, template: s.template && s.template.id });
        return 0;
    }
    if (cmd === 'reset') { try { fs.unlinkSync(stateFile); } catch (_) {} say('已清除'); return 0; }
    const s = load(); if (!s) { say('還沒有進行中的工作，先執行 start。', { error: '沒有工作' }); return 2; }
    if (cmd === 'next') {
        const q = L.currentQuestion(s);
        if (!q) { const st = L.status(s); say('工作已結束。判定：' + st.verdict + (st.result ? '\n結果：' + st.result : '') + '\n可以執行 learn。', st); return 0; }
        say(q.text, { id: q.id, kind: q.kind, text: q.text }); return 0;
    }
    if (cmd === 'answer') {
        const r = L.submitAnswer(s, o._.slice(1).join(' ')); writeJson(stateFile, s);
        if (!r.ok) { say(r.error, r); return 2; }
        if (r.accepted) say(s.state === 'done' ? '收到，已完成。執行 next 看結果。' : '收到。執行 next 看下一題。', r);
        else if (r.retry) say('不合格：' + r.error + '\n請再回答一次（執行 next 看題目）。', r);
        else say('連續不合格，已改用程式預設退路（會在判定裡標記）。執行 next 繼續。', r);
        return 0;
    }
    if (cmd === 'status') { const st = L.status(s); say(JSON.stringify(st, null, 1), st); return 0; }
    if (cmd === 'learn') {
        if (!X) { say('找不到 experience_core', { error: 'no experience_core' }); return 2; }
        if (s.state !== 'done') { say('工作還沒結束，不能學。', { error: '未完成' }); return 2; }
        if (s.learned) { say('這件事已經送過閘門了。', { accepted: false, reason: '已送過' }); return 0; }
        const st = L.status(s); const rec = X.makeRecord(Object.assign({ task: s.task }, st));
        const storeFile = path.join(o.dir, 'experience.json');
        const m = X.merge(readJson(storeFile, null), rec); s.learned = true; writeJson(stateFile, s);
        const out = { accepted: m.accepted, reason: m.reason, duplicate: !!m.duplicate, sig: rec.sig };
        if (m.accepted) {
            writeJson(storeFile, m.store);
            const entries = m.store.entries.map((e) => X.toTrainer(e).pattern).filter(Boolean);
            writeJson(path.join(o.dir, 'trainer-patterns.json'), { v: 1, source: X.SOURCE, patterns: entries });
        } else if (rec.verdict !== 'ok') {
            const u = X.toUmlEdit(rec); if (u.issue) { const f = path.join(o.dir, 'uml-candidates.json'); const cur = readJson(f, { v: 1, issues: [] }); if (!cur.issues.some((x) => x.sig === u.sig)) cur.issues.push(u); writeJson(f, cur); out.umlCandidate = true; }
        }
        say(m.accepted ? (m.duplicate ? '已收過相同經驗，次數 +1。' : '已收進經驗（可匯入離線訓練器）。') : '閘門拒絕：' + m.reason + (out.umlCandidate ? '（已記成 UML 編修候選）' : ''), out);
        return 0;
    }
    say('未知命令。可用：start／next／answer／status／learn／reset', { error: '未知命令' }); return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, parseArgs };
