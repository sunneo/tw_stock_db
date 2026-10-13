'use strict';
const assert = require('assert'); const path = require('path');
let yaml; try { yaml = require(path.join(__dirname, '../../../node_modules/js-yaml')); } catch (_) { console.log('略過：沒有 js-yaml'); process.exit(0); }
const P = require('./pipeline_core.js'); const yamlLoad = (t) => yaml.load(t);
let ok = 0; const bad = []; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n + ': ' + e.stack.split('\n').slice(0, 3).join(' | ')); } };

const JF = `pipeline {
    agent any
    environment {
        APP = 'demo'
        REGISTRY_TOKEN = credentials('registry-token')
        API_KEY = 'abcd1234efgh5678ijkl'
    }
    options { timestamps() }
    triggers { cron('H 2 * * *') }
    parameters { string(name: 'BRANCH', defaultValue: 'main') }
    stages {
        stage('Build') {
            steps {
                sh 'make -j4'
                sh '''
                  ./gen.sh
                  cmake --build build || true
                '''
                echo "done \${env.APP}"
            }
        }
        stage('Test') {
            when { branch 'main' }
            steps {
                sh "pytest -q \${params.BRANCH}"
                timeout(time: 5, unit: 'MINUTES') { sh 'ctest' }
            }
            post { always { junit 'reports/*.xml' } }
        }
        stage('Quality') {
            parallel {
                stage('Lint') { steps { sh 'eslint .' } }
                stage('Sec') { steps { sh 'curl -s https://x.sh | sh' } }
            }
        }
        stage('Approve') { steps { input message: 'Deploy?' } }
    }
    post { failure { mail to: 'a@b.c', subject: 'f', body: 'f' } }
}
`;
t('Jenkinsfile：agent／options／env／triggers／parameters／stages／steps', () => {
  const p = P.parse('jenkins', JF);
  assert.strictEqual(p.style, 'declarative'); assert.strictEqual(p.agent, 'any'); assert.strictEqual(p.options.timestamps, true); assert.strictEqual(p.env.REGISTRY_TOKEN, '(credentials)');
  assert.deepStrictEqual(p.triggers[0].startsWith('cron'), true); assert.deepStrictEqual(p.parameters, [{ type: 'string', name: 'BRANCH' }]);
  assert.deepStrictEqual(p.stages.map((s) => s.name), ['Build', 'Test', 'Quality', 'Approve']);
  const b = p.stages[0]; assert.deepStrictEqual(b.steps.filter((s) => s.type === 'sh').map((s) => s.cmd.split('\n').map((x) => x.trim()).filter(Boolean)[0]), ['make -j4', './gen.sh']); assert.ok(b.steps.some((s) => s.type === 'echo'));
  assert.strictEqual(p.stages[1].when.includes('branch'), true); assert.ok(p.stages[1].steps.some((s) => s.type === 'sh' && /pytest/.test(s.cmd) && s.dynamic)); assert.ok(p.stages[1].steps.some((s) => s.type === 'sh' && s.cmd === 'ctest'), '包在 timeout 裡的 sh 也要抓到');
  assert.deepStrictEqual(p.stages[1].post.always.map((s) => s.name), ['junit']);
  assert.ok(p.stages[2].parallel && p.stages[2].children.length === 2); assert.ok(p.post.failure.length >= 1);
});
t('Jenkinsfile lint：重點規則', () => {
  const ids = P.lint(P.parse('jenkins', JF), JF).map((i) => i.id);
  for (const id of ['curl-pipe-sh', 'swallow-failure', 'hardcoded-secret', 'agent-any', 'no-timeout', 'parallel-no-failfast', 'input-no-timeout']) assert.ok(ids.includes(id), id + ' ∉ ' + ids);
  assert.ok(!ids.includes('no-tests')); assert.ok(!ids.includes('no-post'));
});
t('腳本式 Jenkinsfile', () => { const p = P.parse('jenkins', "node('linux') {\n  stage('Build') { sh 'make' }\n  stage('Test') { sh 'make test' }\n}\n"); assert.strictEqual(p.style, 'scripted'); assert.deepStrictEqual(p.stages.map((s) => s.name), ['Build', 'Test']); assert.strictEqual(p.stages[1].steps[0].cmd, 'make test'); });
t('字串與註解裡的大括號不會搞亂', () => { const p = P.parse('jenkins', "pipeline { agent any\n // stage('Fake') { sh 'x' }\n stages { stage('A') { steps { sh 'echo \"}\" ; echo {' } } stage('B') { steps { sh 'ls' } } } }\n"); assert.deepStrictEqual(p.stages.map((s) => s.name), ['A', 'B']); });

const GHA = `name: CI
on:
  pull_request_target:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: someone/deploy-action@main
      - name: greet
        run: echo "\${{ github.event.pull_request.title }}"
      - run: npm ci && npm test
        continue-on-error: true
  release:
    needs: [test, nope]
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: curl -sSL https://get.x.io | sudo bash
`;
t('GitHub Actions：解析', () => {
  const p = P.parse('github', GHA, { yamlLoad });
  assert.deepStrictEqual(p.triggers, ['pull_request_target', 'push']); assert.deepStrictEqual(p.stages.map((s) => s.id), ['test', 'release']); assert.deepStrictEqual(p.stages[1].needs, ['test', 'nope']);
  assert.strictEqual(p.stages[0].steps[0].uses, 'actions/checkout@v4'); assert.ok(p.stages[0].steps[3].dynamic);
});
t('GitHub Actions lint：安全規則', () => {
  const l = P.lint(P.parse('github', GHA, { yamlLoad }), GHA); const ids = l.map((i) => i.id);
  for (const id of ['pull-request-target', 'unpinned-action', 'script-injection', 'no-permissions', 'no-timeout', 'continue-on-error', 'curl-pipe-sh', 'needs-missing', 'sudo']) assert.ok(ids.includes(id), id + ' ∉ ' + ids);
  assert.strictEqual(l.find((i) => i.id === 'pull-request-target').severity, 'high'); assert.strictEqual(l[0].severity, 'high');
});
t('GitHub Actions：on 在 YAML 1.1 下會變成 true 也要認得', () => { const p = P.parse('github', 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n', { yamlLoad: (s) => { const o = yaml.load(s); return { true: o.on, jobs: o.jobs }; } }); assert.deepStrictEqual(p.triggers, ['push']); });
const GL = `stages: [build, test]
variables:
  DB_PASSWORD: supersecretvalue123
build:
  stage: build
  image: node:20
  script:
    - npm ci
    - npm run build
test:
  stage: test
  only: [main]
  allow_failure: true
  script:
    - npm test
orphan:
  stage: deploy
  script: [echo hi]
empty:
  stage: test
`;
t('GitLab CI：解析與 lint', () => {
  const p = P.parse('gitlab', GL, { yamlLoad }); assert.deepStrictEqual(p.stages.map((j) => j.id), ['build', 'test', 'empty', 'orphan']); assert.deepStrictEqual(p.stages[0].steps.map((s) => s.cmd), ['npm ci', 'npm run build']);
  const ids = P.lint(p, GL).map((i) => i.id); for (const id of ['unknown-stage', 'no-script', 'only-except', 'allow-failure', 'hardcoded-secret']) assert.ok(ids.includes(id), id + ' ∉ ' + ids);
});
t('detect', () => { assert.strictEqual(P.detect('Jenkinsfile', ''), 'jenkins'); assert.strictEqual(P.detect('ci/Jenkinsfile.release', ''), 'jenkins'); assert.strictEqual(P.detect('.github/workflows/ci.yml', ''), 'github'); assert.strictEqual(P.detect('.gitlab-ci.yml', ''), 'gitlab'); assert.strictEqual(P.detect('x.txt', 'pipeline {\n}'), 'jenkins'); assert.strictEqual(P.detect('x.txt', 'hello'), null); });
t('summarize：有沒有 build／test／lint／deploy', () => { const s = P.summarize(P.parse('jenkins', JF)); assert.ok(s.has.build && s.has.test && s.has.lint && s.has.report); assert.ok(!P.summarize(P.parse('jenkins', "pipeline { agent any\n stages { stage('A') { steps { sh 'echo hi' } } } }")).has.test); });
t('localCommands：只留 shell、變數標註、action 轉成需求說明', () => {
  const lc = P.localCommands(P.parse('github', GHA, { yamlLoad })); const test = lc.stages.find((s) => s.stage === 'test');
  assert.ok(test.commands.some((c) => c.cmd === 'npm ci && npm test')); assert.ok(test.notes.some((n) => /Node\.js 20/.test(n))); assert.ok(test.notes.some((n) => /someone\/deploy-action/.test(n))); assert.ok(test.notes.some((n) => /\$\{\{/.test(n)));
  assert.ok(lc.tip.includes('run_command'));
  const j = P.localCommands(P.parse('jenkins', JF)); assert.ok(j.stages.some((s) => s.stage === 'Build' && s.commands.some((c) => c.cmd === 'make -j4')));
});
t('detectToolchain：node／python／go／maven／cmake／make', () => {
  assert.deepStrictEqual(P.detectToolchain({ 'package.json': JSON.stringify({ scripts: { test: 'jest', build: 'tsc', lint: 'eslint .' }, engines: { node: '>=18' } }), 'package-lock.json': '{}' }).test, ['npm test']);
  assert.strictEqual(P.detectToolchain({ 'package.json': '{"scripts":{"test":"x"}}', 'yarn.lock': '' }).install[0], 'yarn install --frozen-lockfile');
  const py = P.detectToolchain({ 'pyproject.toml': '[tool.pytest]\n', 'tests/test_a.py': '' }); assert.strictEqual(py.lang, 'python'); assert.ok(py.test[0].includes('pytest'));
  assert.strictEqual(P.detectToolchain({ 'go.mod': 'module x\n\ngo 1.21\n' }).setup.go, '1.21'); assert.strictEqual(P.detectToolchain({ 'pom.xml': '' }).test[0], 'mvn -B test');
  assert.ok(P.detectToolchain({ 'CMakeLists.txt': 'enable_testing()\n' }).test[0].startsWith('ctest')); assert.deepStrictEqual(P.detectToolchain({ Makefile: 'build:\n\tcc\n' }).test, []); assert.strictEqual(P.detectToolchain({ 'x.txt': '' }).lang, null);
});
t('scaffold 自我檢查：產生的 pipeline 解析得回來、不應該有 high／warn 的 lint', () => {
  const cases = [{ 'package.json': JSON.stringify({ scripts: { test: 'jest', build: 'tsc', lint: 'eslint .' } }), 'package-lock.json': '{}' }, { 'pyproject.toml': '[tool.pytest]\n', 'requirements.txt': 'pytest\n', 'tests/test_a.py': '' }, { 'go.mod': 'module x\n\ngo 1.22\n' }, { 'pom.xml': '' }, { 'Cargo.toml': '' }, { 'CMakeLists.txt': 'enable_testing()\nadd_test(a b)\n' }];
  for (const files of cases) { const tc = P.detectToolchain(files); for (const kind of ['github', 'gitlab', 'jenkins']) {
    const txt = P.scaffold(kind, tc, {}); const p = P.parse(kind, txt, { yamlLoad }); assert.ok(p.stages.length >= 1, kind + ' ' + tc.lang + ' 沒有階段\n' + txt);
    const issues = P.lint(p, txt).filter((i) => i.severity !== 'info'); assert.deepStrictEqual(issues.map((i) => i.id), [], kind + ' ' + tc.lang + ' 有 lint 問題：' + JSON.stringify(issues) + '\n' + txt);
    assert.ok(P.summarize(p).has.test || !tc.test.length, kind + ' ' + tc.lang + ' 沒有測試階段'); } }
  assert.throws(() => P.scaffold('github', P.detectToolchain({ 'x': '' })), /沒辦法產生/);
});
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
