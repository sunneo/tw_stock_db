// node skills/weak-model-harness/scripts/teacher_speed.test.js
// 速度守則：派工附上守則與上限；驗收時掃描報告與新增行中的超限等待、逾時、排程（只是警告，不影響通過與否）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('./teacher_gate.js');

let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-speed-'));
const repo = path.join(base, 'repo'); const dir = path.join(base, 'wh'); fs.mkdirSync(repo); fs.mkdirSync(dir);
const g = (args) => spawnSync('git', ['-c', 'core.quotepath=off'].concat(args), { cwd: repo, encoding: 'utf8' });
const writeIn = (rel, text) => { fs.writeFileSync(path.join(repo, rel), text, 'utf8'); };
const commit = (msg) => { g(['add', '-A']); g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg]); return g(['rev-parse', 'HEAD']).stdout.trim(); };

g(['init', '-q']);
writeIn('slow.js', 'const x = 1;\n');
commit('init');
writeIn('slow.js', 'const x = 1;\nconst r = run({ timeout: 1500000 });\n');
const hashSlow = commit('add a 25-minute timeout');
writeIn('slow.js', 'const x = 1;\nconst r = run({ timeout: 60000 });\n');
const hashOk = commit('timeout within limit');

// 1 派工紀錄附上速度守則、上限與條款
const d1 = T.dispatchTask({ dir, task: 'speed-a', quotes: ['Haiku從頭到尾都在用最慢的方式做事'], allow: ['slow.js'] });
const s1 = JSON.parse(fs.readFileSync(d1.file, 'utf8'));
check('派工紀錄附上速度守則：上限、條款數與原話來源', s1.speed && s1.speed.limits.timeout_ms === 300000 && s1.speed.limits.wait_seconds === 180 && s1.speed.limits.schedule_seconds === 300 && s1.speed.rules.length >= 8 && /最慢/.test(s1.speed.source), s1.speed);

// 2 報告：排程喚醒超過 5 分鐘要警告
let w = T.speedWarnings('已排程，ScheduleWakeup delaySeconds: 1200，等它跑完。', '', null);
check('報告中的 delaySeconds 1200 → 警告', w.length === 1 && /排程喚醒 1200/.test(w[0]), w);

// 3 報告：「N 分鐘後再看」與「等 N 分鐘」超過上限要警告
w = T.speedWarnings('20 分鐘後再看結果。', '', null);
check('報告「20 分鐘後再看」→ 警告', w.length === 1 && /20 分鐘後/.test(w[0]), w);
w = T.speedWarnings('我先等了 13 分鐘才發現卡住。', '', null);
check('報告「等了 13 分鐘」→ 警告', w.length === 1 && /等待 13 分鐘/.test(w[0]), w);

// 4 在上限以內的等待與排程不警告
w = T.speedWarnings('等 2 分鐘後看進度；delaySeconds: 120。', '', null);
check('2 分鐘等待與 120 秒排程 → 不警告', w.length === 0, w);

// 5 程式新增行：逾時超過 5 分鐘警告；刪除的行不算；5 分鐘以內不警告
w = T.speedWarnings('', 'spawnSync(exe, args, { timeout: 1500000 });', null);
check('新增行 timeout: 1500000 → 警告', w.length === 1 && /逾時 1500000/.test(w[0]), w);
w = T.speedWarnings('', 'spawnSync(exe, args, { timeout: 60000 });', null);
check('新增行 timeout 60000 → 不警告', w.length === 0, w);

// 6 sleep 與 setTimeout 超過 3 分鐘警告；shell 的 sleep 240 秒警告，sleep 30 不警告
w = T.speedWarnings('', 'await sleep(600000);\nsetTimeout(resolve, 900000);', null);
check('sleep(600000) 與 setTimeout 900000 → 各一條警告', w.length === 2, w);
w = T.speedWarnings('', 'sleep 240\nsleep 30', null);
check('shell sleep 240 警告，sleep 30 不警告', w.length === 1 && /sleep 240/.test(w[0]), w);

// 7 驗收：提交新增超限逾時 → 有速度警告，但通過與否不受影響
writeIn('slow.js', 'const x = 1;\nconst r = run({ timeout: 1500000 });\n');
const hashSlow2 = commit('slow again');
T.dispatchTask({ dir, task: 'speed-b', quotes: ['原話'], allow: ['slow.js'] });
const v7 = T.verifyTask({ dir, task: 'speed-b', hash: hashSlow, root: repo, report: '已提交 ' + hashSlow + '。', confirm: { '1': '是' } });
check('驗收：提交新增超限逾時 → 速度警告，通過與否不受影響', v7.sec.speed.warnings.length >= 1 && v7.pass === true && /速度檢查（警告/.test(v7.md), v7.sec.speed);

// 8 驗收：沒有超限 → 速度檢查寫「沒有發現」
const v8 = T.verifyTask({ dir, task: 'speed-b', hash: hashOk, root: repo, report: '已提交 ' + hashOk + '。', confirm: { '1': '是' } });
check('驗收：沒有超限 → 沒有速度警告，驗收單寫「沒有發現」', v8.sec.speed.warnings.length === 0 && /沒有發現超過上限/.test(v8.md) && v8.pass === true, v8.sec.speed);

// 9 舊的派工紀錄（沒有 speed 欄位）驗收時用預設上限，不會壞掉
const legacy = path.join(dir, 'dispatch', 'legacy.json');
fs.writeFileSync(legacy, JSON.stringify({ task: 'legacy', quotes: ['原話'], consensus: null, allow: ['slow.js'], verify: [], created: 'x' }), 'utf8');
const v9 = T.verifyTask({ dir, task: 'legacy', hash: hashSlow2, root: repo, report: '已提交。', confirm: { '1': '是' } });
check('舊派工紀錄沒有 speed 欄位 → 仍用預設上限，抓得到 1500000', v9.sec.speed.warnings.length >= 1 && v9.pass === true, v9.sec.speed);

// 10 速度守則檔的上限與 SKILL.md 的條款數一致（八條）
const rules = T.loadSpeed().rules;
check('speed-rules.json 有八條條款，id 不重複', rules.length === 8 && new Set(rules.map((r) => r.id)).size === 8, rules.map((r) => r.id));

fs.rmSync(base, { recursive: true, force: true });
console.log(ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '\n' + bad.join('\n') : ''));
process.exit(bad.length ? 1 : 0);
