// node scripts/harness-tests/portable.test.js
// 任何人匯入這個 skill 資料夾就有完整 harness：把 skill 複製到 repo 之外的暫存資料夾，只靠 vendor/ 跑迴圈、經驗閘門、離線訓練器、行為分析載入；
// 並檢查 vendor/ 沒有過期（跟來源一致）。
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };
const repo = path.join(__dirname, '../..'); const skill = path.join(repo, 'skills/weak-model-harness');
const norm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// ---- vendor 與來源一致 ----
check('vendor/recipe_core.js 與來源一致', norm(path.join(skill, 'scripts/vendor/recipe_core.js')) === norm(path.join(repo, 'renderer/src/recipe/recipe_core.js')));
check('vendor/experience_core.js 與來源一致', norm(path.join(skill, 'scripts/vendor/experience_core.js')) === norm(path.join(repo, 'renderer/src/harness/experience_core.js')));
const fa = norm(path.join(repo, 'renderer/src/floating-assistant.js')), tc = norm(path.join(skill, 'scripts/vendor/trainer_core.js'));
const fnText = (name) => { const a = fa.indexOf('function ' + name + '('); const b = fa.indexOf('\n}\n', a); return fa.slice(a, b + 2); };
check('vendor/trainer_core.js 的語意與規則核心與 floating-assistant.js 一致', ['_faSemEmbed', '_faSemTokens', '_faOtSlots', '_faOtFill', '_faOtMatchRule'].every((n) => tc.includes(fnText(n))));
const eng = ['engine_1_core.js', 'engine_2_scan.js', 'engine_3_narrative.js', 'engine_4_analyze.js', 'engine_5_api.js'].map((f) => norm(path.join(repo, 'renderer/src/behavior', f))).join('\n');
check('vendor/behavior_engine.js 與 engine_1～5 一致', norm(path.join(skill, 'scripts/vendor/behavior_engine.js')).includes(eng));

// ---- 搬到 repo 外跑 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-portable-')); const dest = path.join(tmp, 'weak-model-harness'); fs.cpSync(skill, dest, { recursive: true });
const run = (...a) => spawnSync(process.execPath, [path.join(dest, 'scripts/harness.js')].concat(a, ['--dir', path.join(tmp, 'data'), '--json']), { encoding: 'utf8' });
let r = run('start', '把 12 公里換算成英里'); check('搬走後 start 可跑', r.status === 0, r.stderr);
r = run('answer', '{"from":"公里","to":"英里"}'); r = run('status'); const st = JSON.parse(r.stdout);
check('搬走後迴圈完成且 ok', st.verdict === 'ok' && st.slots.value === 12, st);
r = run('learn'); check('搬走後經驗閘門可跑', JSON.parse(r.stdout).accepted === true, r.stdout);
r = run('trainer', '把 30 公里換成英里'); const tr = JSON.parse(r.stdout);
check('搬走後離線訓練器乾跑可跑，且學到的經驗能被語意比對到', r.status === 0 && tr.domains >= 1 && tr.candidates.length >= 1 && tr.candidates[0].by === 'semantic', tr);
const rules = path.join(tmp, 'dom.json'); fs.writeFileSync(rules, JSON.stringify({ domains: [{ name: 'd', enabled: true, patterns: [{ id: 'r1', type: 'regex', expr: '打開\\s*(\\S+)', confidence: 0.9, tool: 'open_url', args: { url: '{url}' } }] }] }));
r = run('trainer', '打開 https://a.com/x', '--domains', rules); const tr2 = JSON.parse(r.stdout);
check('離線訓練器規則比對與槽位填參數', tr2.candidates[0] && tr2.candidates[0].by === 'rule' && tr2.candidates[0].args.url === 'https://a.com/x', tr2);
r = run('behavior', path.join(tmp, '不存在.js')); check('行為分析讀不到檔案時回明確錯誤', r.status === 2 && /讀不到檔案/.test(r.stdout), r.stdout);
const B = require(path.join(dest, 'scripts/behavior.js'));
const low = B.getEngine().scanLowLevelText ? B.getEngine().scanLowLevelText('x.ll', 'define i32 @f() {\nentry:\n  ret i32 0\n}\n', 'llvm') : null;
check('行為分析引擎搬走後可載入（純文字低階掃描不需要網路）', !!B.getEngine() && typeof B.getEngine().explain === 'function');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '\n' + bad.join('\n') : '')); process.exit(bad.length ? 1 : 0);
