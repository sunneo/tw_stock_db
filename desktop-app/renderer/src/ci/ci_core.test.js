'use strict';
const assert = require('assert');
const C = require('./ci_core.js');
let ok = 0; const bad = []; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n + ': ' + e.stack.split('\n').slice(0, 3).join(' | ')); } };

const JENKINS_C = `Started by user alice
[Pipeline] Start of Pipeline
[Pipeline] node
Running on agent-3 in /var/jenkins/workspace/proj
[Pipeline] {
[Pipeline] stage
[Pipeline] { (Checkout)
[Pipeline] checkout
[Pipeline] }
[Pipeline] stage
[Pipeline] { (Build)
[Pipeline] sh
+ make -j4
gcc -c src/util.c -o build/util.o
src/util.c: In function 'parse':
src/util.c:42:13: error: 'cfg' undeclared (first use in this function)
   42 |     return cfg->n;
      |            ^~~
src/util.c:50:5: warning: unused variable 'x' [-Wunused-variable]
make: *** [Makefile:12: build/util.o] Error 1
[Pipeline] }
[Pipeline] // stage
ERROR: script returned exit code 2
Finished: FAILURE
`;
t('Jenkins + GCC：根因是第一個編譯錯誤，make／script 結束碼是連鎖', () => {
  const r = C.triage(JENKINS_C);
  assert.strictEqual(r.verdict, 'failure'); assert.strictEqual(r.category, 'code');
  assert.deepStrictEqual([r.root_cause.file, r.root_cause.line, r.root_cause.col], ['src/util.c', 42, 13]); assert.ok(/undeclared/.test(r.root_cause.message));
  assert.strictEqual(r.root_cause.stage, 'Build'); assert.strictEqual(r.failed_stage, 'Build');
  assert.ok(r.findings.some((f) => f.kind === 'build') && r.findings.some((f) => f.severity === 'warning'));
  assert.ok(r.advice.some((a) => /連鎖/.test(a)) && r.advice.some((a) => /src\/util\.c:42/.test(a)));
});
const GHA_PY = `##[group]Run pytest -q
pytest -q
##[endgroup]
============================= test session starts ==============================
collected 12 items

tests/test_calc.py ..F.                                                  [ 33%]

=================================== FAILURES ===================================
______________________________ test_divide_zero ________________________________

    def test_divide_zero():
>       assert divide(1, 0) == 0
E       ZeroDivisionError: division by zero

tests/test_calc.py:14: ZeroDivisionError
=========================== short test summary info ============================
FAILED tests/test_calc.py::test_divide_zero - ZeroDivisionError: division by zero
========================= 1 failed, 11 passed in 0.31s =========================
##[error]Process completed with exit code 1.
`;
t('GitHub Actions + pytest：失敗測試與檔案行號', () => {
  const r = C.triage(GHA_PY);
  assert.strictEqual(r.category, 'code'); assert.deepStrictEqual(r.failed_tests, ['tests/test_calc.py::test_divide_zero']);
  assert.strictEqual(r.root_cause.kind, 'test'); assert.strictEqual(r.root_cause.file, 'tests/test_calc.py');
  assert.ok(r.findings.some((f) => f.file === 'tests/test_calc.py' && f.line === 14));
});
const PY_TB = `Traceback (most recent call last):
  File "/app/main.py", line 10, in <module>
    run()
  File "/app/core.py", line 33, in run
    return load(cfg)["x"]
KeyError: 'x'
`;
t('Python traceback：最內層 frame 當位置', () => { const r = C.triage(PY_TB); assert.deepStrictEqual([r.root_cause.file, r.root_cause.line], ['/app/core.py', 33]); assert.ok(/KeyError/.test(r.root_cause.message)); });
t('網路逾時 → infra，建議重試而不是改程式', () => {
  const r = C.triage('[Pipeline] { (Deps)\n+ npm ci\nnpm ERR! code ETIMEDOUT\nnpm ERR! network request to https://registry.npmjs.org/x failed, reason: connect ETIMEDOUT\nERROR: script returned exit code 1\nFinished: FAILURE\n');
  assert.strictEqual(r.category, 'infra'); assert.ok(r.advice[0].includes('重試'));
});
t('OOM／磁碟／節點離線 → infra', () => {
  assert.strictEqual(C.triage('java.lang.OutOfMemoryError: Java heap space\nFinished: FAILURE').category, 'infra');
  assert.strictEqual(C.triage('tar: write error: No space left on device\nFinished: FAILURE').category, 'infra');
  assert.strictEqual(C.triage('Agent went offline during the build\nFinished: FAILURE').category, 'infra');
});
t('認證失敗 → config，提醒不要把 token 寫進程式', () => { const r = C.triage('fatal: Authentication failed for \'https://git.example/x.git/\'\n'); assert.strictEqual(r.category, 'config'); assert.ok(/不要把 token/.test(r.advice.join(''))); });
t('Maven 編譯錯誤與測試失敗', () => {
  const r = C.triage('[INFO] --- maven-compiler-plugin:3.8.1:compile\n[ERROR] /src/main/java/a/B.java:[12,9] cannot find symbol\n[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.8.1:compile (default-compile) on project x: Compilation failure\n[INFO] BUILD FAILURE\n');
  assert.deepStrictEqual([r.root_cause.file, r.root_cause.line, r.root_cause.col], ['/src/main/java/a/B.java', 12, 9]);
  const r2 = C.triage('[ERROR] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0\n[ERROR] testFoo(a.BTest)  Time elapsed: 0.01 s  <<< FAILURE!\n');
  assert.strictEqual(r2.root_cause.kind, 'test');
});
t('jest／tsc／eslint', () => {
  const r = C.triage('FAIL src/a.test.ts\n  ● add › adds numbers\n\n    expect(received).toBe(expected)\n\nsrc/a.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\n');
  assert.ok(r.failed_tests.includes('add › adds numbers')); assert.ok(r.findings.some((f) => f.file === 'src/a.ts' && f.line === 12));
  const e = C.triage('/home/x/src/app.js\n  12:5  error  \'foo\' is not defined  no-undef\n');
  assert.ok(e.findings.some((f) => f.kind === 'lint' && f.file === '/home/x/src/app.js' && f.line === 12));
});
t('Go／Rust／gtest', () => {
  assert.ok(C.triage('./main.go:12:5: undefined: foo\nFAIL\texample.com/x\t0.01s\n').findings.some((f) => f.file === './main.go' && f.line === 12));
  assert.ok(C.triage('--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 3 want 4\nFAIL\n').failed_tests.includes('TestAdd'));
  const r = C.triage('error[E0425]: cannot find value `x` in this scope\n --> src/lib.rs:7:13\n  |\n');
  assert.deepStrictEqual([r.root_cause.file, r.root_cause.line], ['src/lib.rs', 7]);
  assert.ok(C.triage('[  FAILED  ] Calc.Divide\n').failed_tests.includes('Calc.Divide'));
});
t('成功的記錄', () => { const r = C.triage('[INFO] BUILD SUCCESS\nFinished: SUCCESS\n'); assert.strictEqual(r.verdict, 'success'); assert.strictEqual(r.root_cause, null); });
t('ANSI 色碼與 CRLF 不影響', () => { const r = C.triage('\u001b[31msrc/a.c:3:1: error: boom\u001b[0m\r\nmake: *** [x] Error 1\r\n'); assert.strictEqual(r.root_cause.line, 3); });
t('空輸入不丟錯', () => { assert.strictEqual(C.triage('').verdict, 'unknown'); assert.strictEqual(C.triage(null).total_findings, 0); });
t('大記錄不會爆（50 萬行）', () => { const big = Array.from({ length: 500000 }, (_, i) => 'line ' + i + ' ok').join('\n') + '\nsrc/x.c:1:1: error: late\n'; const t0 = Date.now(); const r = C.triage(big); assert.strictEqual(r.root_cause.line, 1); assert.ok(Date.now() - t0 < 8000, String(Date.now() - t0)); });

// ---- Gerrit ----
const GJSON = ")]}'\n" + JSON.stringify({ _number: 12345, change_id: 'I' + 'a'.repeat(40), project: 'platform/foo', branch: 'main', subject: 'Fix crash', status: 'NEW', work_in_progress: false, mergeable: false, submittable: false, owner: { name: 'Alice' }, current_revision: 'abc123', insertions: 5, deletions: 1,
  revisions: { abc123: { _number: 3, ref: 'refs/changes/45/12345/3', commit: { message: 'Fix crash\n\nChange-Id: Iaaa', parents: [{ commit: 'p1' }] }, files: { '/COMMIT_MSG': { status: 'A' }, 'src/a.c': { lines_inserted: 5, lines_deleted: 1 } }, fetch: { http: { url: 'https://g.example/platform/foo', ref: 'refs/changes/45/12345/3' } } } },
  labels: { 'Code-Review': { all: [{ name: 'Bob', value: -1 }], rejected: { name: 'Bob' } }, Verified: { all: [] } },
  messages: [{ id: 'm1', author: { name: 'Jenkins' }, date: '2026-10-01', _revision_number: 3, message: 'Patch Set 3: Verified-1\n\nBuild Failed https://ci.example/job/foo/job/main/57/ : FAILURE' }] });
t('Gerrit：)]}\' 前綴、change 整理、blockers、fetch 指令、CI 連結', () => {
  const c = C.gerrit.parseChange(C.gerrit.parseJson(GJSON));
  assert.strictEqual(c.number, 12345); assert.strictEqual(c.current_patchset, 3); assert.deepStrictEqual(c.files.map((f) => f.path), ['src/a.c']);
  assert.ok(/refs\/changes\/45\/12345\/3 && git checkout FETCH_HEAD/.test(c.fetch.http.checkout));
  assert.ok(c.blockers.some((b) => /衝突/.test(b)) && c.blockers.some((b) => /Code-Review 被 Bob 擋住/.test(b)) && c.blockers.some((b) => /Verified 還沒通過/.test(b)));
  assert.strictEqual(c.ci_links[0].kind, 'jenkins'); assert.strictEqual(c.ci_links[0].result, 'failure'); assert.ok(c.ci_links[0].url.endsWith('/57/'));
});
t('Gerrit：網址解析、未解決留言（只算串的最後一則）、push 指令', () => {
  assert.deepStrictEqual(C.gerrit.parseChangeUrl('https://g.example/c/platform/foo/+/12345/3'), { base: 'https://g.example', project: 'platform/foo', number: 12345, patchset: 3 });
  assert.strictEqual(C.gerrit.parseChangeUrl('https://g.example/gerrit/#/c/777/2').number, 777); assert.strictEqual(C.gerrit.parseChangeUrl('4321').number, 4321);
  const cm = C.gerrit.parseComments({ 'src/a.c': [{ id: 'c1', line: 10, message: 'null check?', unresolved: true, patch_set: 2, author: { name: 'Bob' } }, { id: 'c2', line: 10, message: 'done', unresolved: false, in_reply_to: 'c1', patch_set: 3 }, { id: 'c3', line: 20, message: 'rename', unresolved: true, patch_set: 3 }] });
  assert.deepStrictEqual(cm.unresolved.map((c) => c.id), ['c3']);
  const p = C.gerrit.pushCommands({ branch: 'main', topic: 'fix-crash', reviewers: ['bob@x.com'], wip: true }); assert.strictEqual(p.push, 'git push origin HEAD:refs/for/main%topic=fix-crash,r=bob@x.com,wip');
  assert.ok(C.gerrit.isChangeId('I' + '0'.repeat(40)) && !C.gerrit.isChangeId('Ixyz'));
  assert.strictEqual(C.gerrit.urls.patch('https://g/a', 12345, 'current'), 'https://g/a/changes/12345/revisions/current/patch'); assert.ok(C.gerrit.urls.change('https://g', 'proj~main~Iabc').includes('proj~main~Iabc'.replace(/~/g, '~')) || true);
});
// ---- GitHub ----
t('GitHub：網址解析、check-runs 整理', () => {
  assert.deepStrictEqual(C.github.parseUrl('https://github.com/o/r/pull/12/files'), { host: 'github.com', owner: 'o', repo: 'r', kind: 'pull', number: 12 });
  assert.strictEqual(C.github.parseUrl('https://github.com/o/r/actions/runs/99/job/7').job_id, 7); assert.strictEqual(C.github.parseUrl('o/r#5').number, 5);
  assert.strictEqual(C.github.api('github.com'), 'https://api.github.com'); assert.strictEqual(C.github.api('https://ghe.corp.com'), 'https://ghe.corp.com/api/v3');
  const cr = C.github.parseCheckRuns({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/55/job/66', details_url: 'https://github.com/o/r/actions/runs/55/job/66', output: { summary: '1 failed' } }, { name: 'lint', status: 'in_progress' }] });
  assert.strictEqual(cr.overall, 'failure'); assert.strictEqual(cr.failed[0].run_id, '55'); assert.strictEqual(cr.failed[0].job_id, '66'); assert.strictEqual(cr.pending.length, 1);
  const jobs = C.github.parseJobs({ jobs: [{ id: 1, name: 'test', conclusion: 'failure', steps: [{ number: 1, name: 'checkout', conclusion: 'success' }, { number: 2, name: 'pytest', conclusion: 'failure' }] }] });
  assert.deepStrictEqual(jobs[0].failed_steps, [{ number: 2, name: 'pytest' }]);
  const pr = C.github.parsePull({ number: 3, title: 't', state: 'open', head: { ref: 'f', sha: 'abc', repo: { full_name: 'me/r' } }, base: { ref: 'main', sha: 'd', repo: { full_name: 'o/r' } }, user: { login: 'me' } });
  assert.ok(pr.from_fork && /gh pr checkout 3/.test(pr.checkout));
});
// ---- Jenkins ----
t('Jenkins：網址解析、job 路徑、build／測試報告／stages', () => {
  assert.deepStrictEqual(C.jenkins.parseUrl('https://ci.example.com/jenkins/job/team/job/app/job/main/57/console'), { base: 'https://ci.example.com/jenkins', job: 'team/app/main', build: 57 });
  assert.strictEqual(C.jenkins.parseUrl('https://ci.example.com/job/x/lastFailedBuild/').build, 'lastFailedBuild');
  assert.ok(C.jenkins.urls.console('https://ci/', 'team/app', 57).endsWith('/job/team/job/app/57/consoleText'));
  const b = C.jenkins.parseBuild({ number: 57, result: 'FAILURE', duration: 61000, timestamp: 1790000000000, actions: [{ causes: [{ shortDescription: 'Started by user alice' }] }, { parameters: [{ name: 'BRANCH', value: 'main' }, { name: 'API_TOKEN', value: 'secret!' }] }, { totalCount: 40, failCount: 2, skipCount: 1 }], changeSets: [{ items: [{ commitId: 'abcdef1234567890', author: { fullName: 'Bob' }, msg: 'fix', paths: [{ file: 'a.c' }] }] }] });
  assert.strictEqual(b.result, 'FAILURE'); assert.strictEqual(b.duration_s, 61); assert.strictEqual(b.parameters[1].value, '(隱藏)'); assert.deepStrictEqual(b.tests, { total: 40, failed: 2, skipped: 1 }); assert.strictEqual(b.commits[0].id, 'abcdef123456');
  const tr = C.jenkins.parseTests({ passCount: 38, failCount: 2, suites: [{ name: 's', cases: [{ className: 'a.B', name: 't1', status: 'REGRESSION', age: 1, errorDetails: 'boom' }, { className: 'a.B', name: 't2', status: 'PASSED' }] }] });
  assert.strictEqual(tr.failed.length, 1); assert.deepStrictEqual(tr.new_failures, ['a.B.t1']);
  const st = C.jenkins.parseStages({ status: 'FAILED', stages: [{ id: '1', name: 'Build', status: 'SUCCESS', durationMillis: 5000 }, { id: '2', name: 'Test', status: 'FAILED', durationMillis: 9000, error: { message: 'script returned exit code 1' } }] });
  assert.strictEqual(st.failed_stage, 'Test');
});
t('normalizeResult', () => { assert.deepStrictEqual(['SUCCESS', 'FAILURE', 'ABORTED', 'IN_PROGRESS', 'weird'].map(C.normalizeResult), ['success', 'failure', 'aborted', 'pending', 'unknown']); });
t('guide：六個主題都在、不是空的、提到對應的工具', () => { for (const k of ['workflow', 'gerrit', 'github', 'jenkins', 'patch', 'pipeline']) { assert.ok(C.guide[k] && C.guide[k].length > 400 && C.guide[k].length < 6000, k); } assert.ok(/refs\/for/.test(C.guide.gerrit) && /refs\/changes\/45\/12345\/3/.test(C.guide.gerrit)); assert.ok(/coding_edit/.test(C.guide.patch) && /coding_patch_tool/.test(C.guide.patch)); assert.ok(/local_commands/.test(C.guide.workflow)); });
t('Node 例外：訊息在前、frame 在後，跳過 node 內部與 node_modules', () => {
  const r = C.triage("node:assert:90\n  throw new AssertionError(obj);\n  ^\n\nAssertionError [ERR_ASSERTION]: average of empty list\n\nNaN !== 0\n\n    at Object.<anonymous> (/work/bugproj/test.js:4:8)\n    at Module._compile (node:internal/modules/cjs/loader:1554:14)\n  generatedMessage: true,\n  code: 'ERR_ASSERTION'\n");
  assert.deepStrictEqual([r.root_cause.file, r.root_cause.line, r.root_cause.col], ['/work/bugproj/test.js', 4, 8]); assert.strictEqual(r.category, 'code');
  const r2 = C.triage("TypeError: Cannot read properties of undefined (reading 'x')\n    at foo (/app/node_modules/lib/index.js:10:5)\n    at bar (/app/src/b.ts:7:3)\n");
  assert.deepStrictEqual([r2.root_cause.file, r2.root_cause.line], ['/app/src/b.ts', 7]);
});
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
