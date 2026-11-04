// node scripts/harness-tests/teacher_gate.test.js
// 老師端程式輔助：派工紀錄、提交範圍、共識在提交內容上的檢查、驗收指令、宣稱檢查、原話逐條對照、老師觀察、命令列結束碼。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../../skills/weak-model-harness/scripts/teacher_gate.js');

let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-gate-'));
const repo = path.join(base, 'repo'); const dir = path.join(base, 'wh'); fs.mkdirSync(repo); fs.mkdirSync(dir);
const CLI = path.join(__dirname, '../../skills/weak-model-harness/scripts/teacher_gate.js');
const g = (args, cwd) => spawnSync('git', ['-c', 'core.quotepath=off'].concat(args), { cwd: cwd || repo, encoding: 'utf8' });
const writeIn = (rel, text) => { const p = path.join(repo, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8'); };
const commit = (msg) => { g(['add', '-A']); const r = g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg]); return g(['rev-parse', 'HEAD']).stdout.trim(); };

g(['init', '-q']);
writeIn('allowed.md', '第一版\n標準輸入輸出\n'); writeIn('other.txt', 'x\n');
commit('init');
// 第二次提交：改允許的檔案（與一個不允許的檔案）
writeIn('allowed.md', '第一版\n標準輸入輸出\n已改\n'); writeIn('sub/a.md', 'a\n'); writeIn('other.txt', 'changed\n');
const hashBad = commit('bad: touches disallowed file');
// 第三次提交：只改允許的檔案，內容乾淨
writeIn('allowed.md', '第一版\n標準輸入輸出\n已改2\n'); writeIn('sub/a.md', 'a2\n');
const hashGood = commit('good: only allowed');
// 第四次提交：內容含禁止片語
writeIn('allowed.md', '標準輸入輸出\n這裡提到伺服器模式\n'); writeIn('sub/a.md', 'a3\n');
const hashForbid = commit('forbid: contains forbidden phrase');

// 共識檔與派工用的檔案
const consPath = path.join(repo, 'cons.json');
fs.writeFileSync(consPath, JSON.stringify({ name: 'c', scope: ['allowed.md'], must: ['標準輸入輸出'], forbid: ['伺服器模式'] }), 'utf8');
const cwdRepo = repo;

// 1 dispatch 寫出完整欄位
const d1 = T.dispatchTask({ dir, task: 'native-runner-design', quotes: ['子程序只用標準輸入輸出加進度檔', '不要 HTTP'], consensus: 'cons.json', allow: ['allowed.md', 'sub/'], verify: ['node -e "process.exit(0)"'] });
const saved = JSON.parse(fs.readFileSync(d1.file, 'utf8'));
check('dispatch 寫出派工紀錄含原話、允許檔案、驗收指令', saved.quotes.length === 2 && saved.allow.join() === 'allowed.md,sub/' && saved.verify.length === 1 && saved.consensus === 'cons.json', saved);

// 2 任務名不合法拒絕
let threw = ''; try { T.dispatchTask({ dir, task: '../escape', quotes: ['x'], allow: ['a'] }); } catch (e) { threw = e.message; }
check('dispatch 拒絕含路徑字元的任務名', /任務名稱/.test(threw), threw);

// 3 沒有原話拒絕
threw = ''; try { T.dispatchTask({ dir, task: 't3', quotes: [], allow: ['a'] }); } catch (e) { threw = e.message; }
check('dispatch 沒有原話時拒絕', /原話/.test(threw), threw);

// 4 允許檔案內改動 → 檔案範圍通過
const v4 = T.verifyTask({ dir, task: 'native-runner-design', hash: hashGood, root: cwdRepo, report: '已提交，commit ' + hashGood + '。', confirm: {} });
check('提交只動允許檔案 → 檔案範圍通過', v4.sec.files.ok === true && v4.sec.files.bad.length === 0, v4.sec.files);

// 5 允許之外改動 → 失敗並列出檔名
const v5 = T.verifyTask({ dir, task: 'native-runner-design', hash: hashBad, root: cwdRepo, report: '已提交。', confirm: {} });
check('提交改到允許之外的檔案 → 檔案範圍失敗並列出', v5.sec.files.ok === false && v5.sec.files.bad.indexOf('other.txt') >= 0 && v5.pass === false, v5.sec.files);

// 6 目錄允許（以 / 結尾）涵蓋其下檔案
const v6 = T.verifyTask({ dir, task: 'native-runner-design', hash: hashGood, root: cwdRepo, report: '已提交。', confirm: {} });
check('允許的資料夾 sub/ 涵蓋其下的 sub/a.md', v6.sec.files.bad.indexOf('sub/a.md') < 0);

// 7 宣稱詞沒有證據 → 宣稱未證
const rowsNo = T.claimRows('與先前一致，沒有什麼出入。', cwdRepo);
check('宣稱詞「沒有出入／一致」沒附證據 → 未證', rowsNo.length === 1 && rowsNo[0].proven === false, rowsNo);

// 8 宣稱附可解析的提交 hash → 已證；附假 hash → 未證
const rowsHash = T.claimRows('已完成，見提交 ' + hashGood + '。', cwdRepo);
const rowsFake = T.claimRows('已完成，見提交 abcdef1234。', cwdRepo);
check('宣稱附真實提交 hash → 已證；假 hash → 未證', rowsHash[0].proven === true && rowsFake[0].proven === false, { rowsHash, rowsFake });

// 8b 比較型宣稱（一致）附提交 hash 不算證據，必須附比對輸出或逐條對照
const rowsCmp = T.claimRows('與先前一致，見提交 ' + hashGood + '。', cwdRepo);
check('比較型宣稱「一致」只附 hash 仍未證（hash 不證明內容相同）', rowsCmp[0].proven === false && rowsCmp[0].needs.indexOf('比對') >= 0, rowsCmp);
const rowsCmp2 = T.claimRows('與先前一致：逐條對照 5 條，已對照。', cwdRepo);
check('比較型宣稱附「已對照」逐條對照才算證', rowsCmp2[0].proven === true, rowsCmp2);

// 9 宣稱附指令輸出 → 已證
const rowsCmd = T.claimRows('全過：89 passed, 0 failed。', cwdRepo);
check('宣稱附「N passed」輸出 → 已證', rowsCmd[0].proven === true, rowsCmd);

// 10 沒有報告文字 → 宣稱檢查失敗
const v10 = T.verifyTask({ dir, task: 'native-runner-design', hash: hashGood, root: cwdRepo, confirm: {} });
check('沒有提供報告文字 → 宣稱檢查失敗', v10.sec.claims.missing === true && v10.sec.claims.ok === false && v10.pass === false);

// 11 原話對照預設「否」；只有老師填「是」才通過
const v11a = T.verifyTask({ dir, task: 'native-runner-design', hash: hashGood, root: cwdRepo, report: '已提交 ' + hashGood + '。', confirm: {} });
check('原話對照預設全部「否」，整體不通過', v11a.sec.quotes.every((q) => q.status === '否') && v11a.sec.quotes_ok === false && v11a.pass === false);
const v11b = T.verifyTask({ dir, task: 'native-runner-design', hash: hashGood, root: cwdRepo, report: '已提交 ' + hashGood + '。', confirm: { '1': '是' } });
check('只確認第 1 句，第 2 句仍是「否」，整體仍不通過', v11b.sec.quotes[0].status === '是' && v11b.sec.quotes[1].status === '否' && v11b.pass === false);

// 12 驗收指令結束碼
const v12 = T.verifyTask({ dir, task: 'native-runner-design', hash: hashGood, root: cwdRepo, report: '已提交 ' + hashGood + '。', confirm: { '1': '是', '2': '是' } });
check('驗收指令 exit 0 → 通過，全部確認後整體通過', v12.sec.commands_ok === true && v12.pass === true, v12.sec);
T.dispatchTask({ dir, task: 'cmdfail', quotes: ['原話'], allow: ['allowed.md'], verify: ['node -e "process.exit(3)"'] });
const v12b = T.verifyTask({ dir, task: 'cmdfail', hash: hashGood, root: cwdRepo, report: '已提交。', confirm: { '1': '是' } });
check('驗收指令 exit 3 → 失敗並記下結束碼', v12b.sec.commands_ok === false && v12b.sec.commands[0].exit === 3 && v12b.pass === false, v12b.sec.commands);

// 13 共識在提交內容上檢查：乾淨通過、含禁止片語失敗
const v13a = T.verifyTask({ dir, task: 'native-runner-design', hash: hashGood, root: cwdRepo, report: '已提交。', confirm: {} });
check('提交內容乾淨 → 共識通過', v13a.sec.consensus.ok === true, v13a.sec.consensus);
T.dispatchTask({ dir, task: 'forbidcase', quotes: ['原話'], consensus: 'cons.json', allow: ['allowed.md'] });
const v13b = T.verifyTask({ dir, task: 'forbidcase', hash: hashForbid, root: cwdRepo, report: '已提交。', confirm: { '1': '是' } });
check('提交內容含禁止片語 → 共識失敗', v13b.sec.consensus.ok === false && v13b.pass === false, v13b.sec.consensus);

// 14 驗收單內容：含違反項、宣稱未證、原話表格、請補老師觀察
const v14 = T.verifyTask({ dir, task: 'native-runner-design', hash: hashBad, root: cwdRepo, report: '與先前一致。', confirm: {} });
check('驗收單含違反項、未證宣稱、原話逐條表格與「請補老師觀察」', /違反\] 檔案範圍/.test(v14.md) && /宣稱未證/.test(v14.md) && /\| 1 \| 子程序只用標準輸入輸出加進度檔 \| 否 \|/.test(v14.md) && /請補老師觀察/.test(v14.md), v14.md.slice(0, 400));
check('驗收單寫到派工資料夾', fs.existsSync(v14.file) && /verdict\.md$/.test(v14.file));

// 15 observe：追加老師視角記錄、缺欄位拒絕、同任務同類編號遞增
const expTmp = path.join(base, 'exp.json'); fs.writeFileSync(expTmp, JSON.stringify({ version: 1, records: [] }), 'utf8');
const r15 = T.observeRecord({ task: 'native-runner', kind: 'branch', stage: '設計', lesson: '否決方案要寫成條款', evidence: '提交 88116691' }, expTmp);
const r15b = T.observeRecord({ task: 'native-runner', kind: 'branch', stage: '設計', lesson: '第二筆', evidence: '提交 5826fe36' }, expTmp);
const saved15 = JSON.parse(fs.readFileSync(expTmp, 'utf8'));
check('observe 追加 observer=teacher，同任務同類編號遞增', saved15.records.length === 2 && saved15.records[0].observer === 'teacher' && r15.id !== r15b.id, saved15.records);
threw = ''; try { T.observeRecord({ task: 'x', kind: 'branch', stage: 's', lesson: '', evidence: 'e' }, expTmp); } catch (e) { threw = e.message; }
check('observe 缺 lesson 拒絕', /lesson/.test(threw), threw);
threw = ''; try { T.observeRecord({ task: 'x', kind: 'nonsense', stage: 's', lesson: 'l', evidence: 'e' }, expTmp); } catch (e) { threw = e.message; }
check('observe 不認得的 kind 拒絕', /kind/.test(threw), threw);

// 16 命令列結束碼：全部通過 → 0；有違反 → 1；參數錯 → 2
const confPass = path.join(base, 'cp.json'); fs.writeFileSync(confPass, JSON.stringify({ '1': '是' }), 'utf8');
const reportPass = path.join(base, 'rp.txt'); fs.writeFileSync(reportPass, '已完成，見提交 ' + hashGood + '。', 'utf8');
T.dispatchTask({ dir, task: 'clipass', quotes: ['原話'], allow: ['allowed.md', 'sub/'], verify: ['node -e "process.exit(0)"'] });
let s = spawnSync(process.execPath, [CLI, 'verify', '--task', 'clipass', '--hash', hashGood, '--root', cwdRepo, '--report', reportPass, '--confirm', confPass, '--dir', dir], { encoding: 'utf8' });
check('命令列 verify 全部通過結束碼 0', s.status === 0, { status: s.status, out: s.stdout.slice(0, 200), err: s.stderr });
s = spawnSync(process.execPath, [CLI, 'verify', '--task', 'native-runner-design', '--hash', hashBad, '--root', cwdRepo, '--dir', dir], { encoding: 'utf8' });
check('命令列 verify 有違反結束碼 1', s.status === 1, { status: s.status });
s = spawnSync(process.execPath, [CLI, 'bogus'], { encoding: 'utf8' });
check('未知子指令結束碼 2', s.status === 2, { status: s.status });

// 17 宣稱詞集合與原話對照預設值的常數檢查
check('宣稱詞包含「沒有出入」「一致」「已完成」「全過」', ['沒有出入', '一致', '已完成', '全過'].every((w) => T.CLAIM_WORDS.includes(w)));

fs.rmSync(base, { recursive: true, force: true });
console.log(ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '\n' + bad.join('\n') : ''));
process.exit(bad.length ? 1 : 0);
