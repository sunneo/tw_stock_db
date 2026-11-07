'use strict';
/* 判題執行器（Node／Electron 主程序專用）：把一份原始碼用該語言的工具鏈編譯（需要的話）、對每筆測試餵 stdin、比對 stdout，回傳判決。
 * 純函式的部分（題目格式、比對、彙整）在 renderer/src/recipe/judge_core.js。設計見 DESIGN.fn-template.md。
 *
 *   LANGS                          語言表：python nodejs c cpp java ruby perl bash asm-x64 asm-x86 csharp
 *   available(lang)                → Promise<{ok, version?, reason?}>（結果快取；有 probe 的語言會真的編譯並執行一個空程式）
 *   judge({lang, source, problem, timeoutMs, compileTimeoutMs, maxOutput}) → Promise<summarize 的結果 + {lang, compileLog?}>
 *   check({lang, source}) → Promise<{verdict:'CHECKED'|'CE'|'UNAVAILABLE', compileLog, detail}>   只編譯／語法檢查，不執行
 *
 * 誠實的限制：這**不是安全沙盒**。子程序用精簡的環境變數、獨立的暫存目錄、時間與輸出上限，逾時會殺整個行程群組；
 * 但沒有記憶體上限（Java／Mono 用位址空間限制會直接起不來）、沒有檔案與網路隔離。所以只能跑自己（或本機模型）產生的程式，
 * 不能拿來跑不信任的第三方程式碼。要更強的隔離得加容器或 seccomp，這裡沒做。 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 根目錄的 judge-core.js 是 build-assistant.js 從 renderer/src/recipe/judge_core.js 同步產生的（熱更新只認根目錄的主行程模組）；開發時沒有就退回原檔
const core = (() => { try { return require('./judge-core.js'); } catch (e) { return require('./renderer/src/recipe/judge_core.js'); } })();

const sh = (cmd, args) => ({ cmd, args });
// 每種語言：file（原始檔名）、compile(dir)→null 或 {cmd,args}、run(dir)→{cmd,args}、detect（版本探測）、probe（可選，真的跑一個空程式，證明這台機器跑得起來）
const LANGS = {
    python: { file: 'main.py', detect: ['python3', ['--version']], check: (d) => sh('python3', ['-m', 'py_compile', path.join(d, 'main.py')]), run: (d) => sh('python3', [path.join(d, 'main.py')]) },
    nodejs: { file: 'main.js', detect: ['node', ['--version']], check: (d) => sh('node', ['--check', path.join(d, 'main.js')]), run: (d) => sh('node', [path.join(d, 'main.js')]) },
    c: { file: 'main.c', detect: ['gcc', ['--version']], check: (d) => sh('gcc', ['-fsyntax-only', path.join(d, 'main.c')]), compile: (d) => sh('gcc', ['-O2', '-o', path.join(d, 'a.out'), path.join(d, 'main.c'), '-lm']), run: (d) => sh(path.join(d, 'a.out'), []) },
    cpp: { file: 'main.cpp', detect: ['g++', ['--version']], check: (d) => sh('g++', ['-std=c++17', '-fsyntax-only', path.join(d, 'main.cpp')]), compile: (d) => sh('g++', ['-O2', '-std=c++17', '-o', path.join(d, 'a.out'), path.join(d, 'main.cpp')]), run: (d) => sh(path.join(d, 'a.out'), []) },
    // Java：公開類別必須叫 Main
    java: { file: 'Main.java', detect: ['javac', ['-version']], compile: (d) => sh('javac', ['-d', d, path.join(d, 'Main.java')]), run: (d) => sh('java', ['-Xss64m', '-cp', d, 'Main']) },
    ruby: { file: 'main.rb', detect: ['ruby', ['--version']], check: (d) => sh('ruby', ['-c', path.join(d, 'main.rb')]), run: (d) => sh('ruby', [path.join(d, 'main.rb')]) },
    perl: { file: 'main.pl', detect: ['perl', ['-e', 'print "$]"']], check: (d) => sh('perl', ['-c', path.join(d, 'main.pl')]), run: (d) => sh('perl', [path.join(d, 'main.pl')]) },
    bash: { file: 'main.sh', detect: ['bash', ['--version']], check: (d) => sh('bash', ['-n', path.join(d, 'main.sh')]), run: (d) => sh('bash', [path.join(d, 'main.sh')]) },
    // 組語：GNU as（要寫 .intel_syntax noprefix，進入點 _start，直接用系統呼叫、不連 libc）。x64：syscall；x86：int 0x80（需要核心支援 32 位元執行檔，所以有 probe）
    'asm-x64': { file: 'main.s', detect: ['as', ['--version']], needs: ['ld'], check: (d) => sh('as', ['--64', '-o', path.join(d, 'm.o'), path.join(d, 'main.s')]), compile: (d) => ({ chain: [sh('as', ['--64', '-o', path.join(d, 'm.o'), path.join(d, 'main.s')]), sh('ld', ['-o', path.join(d, 'a.out'), path.join(d, 'm.o')])] }), run: (d) => sh(path.join(d, 'a.out'), []), probe: '.intel_syntax noprefix\n.globl _start\n.text\n_start:\n  mov eax, 60\n  xor edi, edi\n  syscall\n' },
    'asm-x86': { file: 'main.s', detect: ['as', ['--version']], needs: ['ld'], check: (d) => sh('as', ['--32', '-o', path.join(d, 'm.o'), path.join(d, 'main.s')]), compile: (d) => ({ chain: [sh('as', ['--32', '-o', path.join(d, 'm.o'), path.join(d, 'main.s')]), sh('ld', ['-m', 'elf_i386', '-o', path.join(d, 'a.out'), path.join(d, 'm.o')])] }), run: (d) => sh(path.join(d, 'a.out'), []), probe: '.intel_syntax noprefix\n.globl _start\n.text\n_start:\n  mov eax, 1\n  xor ebx, ebx\n  int 0x80\n' },
    // C#：優先 mcs＋mono；沒有就 csc＋mono（dotnet 沒測過，這裡不支援）
    csharp: { file: 'main.cs', detect: ['mono', ['--version']], needsAny: ['mcs', 'csc'], check: (d, tools) => sh(tools.csharp, ['-target:library', '-out:' + path.join(d, 'main.dll'), path.join(d, 'main.cs')]), compile: (d, tools) => sh(tools.csharp, ['-out:' + path.join(d, 'main.exe'), path.join(d, 'main.cs')]), run: (d) => sh('mono', [path.join(d, 'main.exe')]) }
};
const ORDER = ['python', 'nodejs', 'c', 'cpp', 'java', 'ruby', 'perl', 'bash', 'asm-x64', 'asm-x86', 'csharp'];

function exec(cmd, args, o) {
    o = o || {};
    return new Promise((resolve) => {
        const t0 = Date.now(); let out = '', err = '', over = false, timedOut = false, done = false, child;
        const cap = o.maxOutput || 1 << 20;
        const fin = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ stdout: out, stderr: err, timedOut, over, ms: Date.now() - t0 }, r)); };
        const killAll = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* 已結束 */ } } };
        try { child = spawn(cmd, args, { cwd: o.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: o.cwd || os.tmpdir(), LANG: 'C', LC_ALL: 'C' } }); } catch (e) { return resolve({ code: -1, signal: null, stdout: '', stderr: String(e.message || e), spawnError: true, ms: 0 }); }
        const timer = setTimeout(() => { timedOut = true; killAll(); }, o.timeoutMs || 5000);
        child.stdout.on('data', (b) => { if (out.length < cap) out += b.toString('utf8'); else if (!over) { over = true; killAll(); } });
        child.stderr.on('data', (b) => { if (err.length < 65536) err += b.toString('utf8'); });
        child.stdin.on('error', () => { /* 程式沒讀完 stdin 就結束：EPIPE，不算錯 */ });
        child.on('error', (e) => fin({ code: -1, signal: null, stderr: String(e.message || e), spawnError: true }));
        child.on('close', (code, signal) => fin({ code, signal }));
        try { child.stdin.end(o.input == null ? '' : String(o.input)); } catch (e) { /* 同上 */ }
    });
}

const cache = new Map();
async function which(name) { const r = await exec('sh', ['-c', 'command -v ' + name], { timeoutMs: 3000 }); return r.code === 0 ? r.stdout.trim().split('\n')[0] : ''; }

function available(lang) {
    if (cache.has(lang)) return cache.get(lang);
    const p = (async () => {
        const L = LANGS[lang]; if (!L) return { ok: false, reason: '不認得的語言：' + lang };
        const tools = {};
        const v = await exec(L.detect[0], L.detect[1], { timeoutMs: 8000 });
        if (v.spawnError || v.code !== 0) return { ok: false, reason: '找不到 ' + L.detect[0] };
        for (const n of L.needs || []) if (!(await which(n))) return { ok: false, reason: '找不到 ' + n };
        if (L.needsAny) { for (const n of L.needsAny) if (await which(n)) { tools.csharp = n; break; } if (!tools.csharp) return { ok: false, reason: '找不到 ' + L.needsAny.join(' 或 ') }; }
        const version = (v.stdout || v.stderr).split('\n')[0].trim();
        if (L.probe) {
            const r = await runOnce(lang, L.probe, '', { timeoutMs: 5000, compileTimeoutMs: 20000, tools });
            if (r.stage !== 'ok') return { ok: false, reason: '工具鏈在，但空程式跑不起來（' + r.stage + '：' + String(r.stderr || '').slice(0, 120).trim() + '）' };
        }
        return { ok: true, version, tools };
    })();
    cache.set(lang, p); return p;
}

// 單次：編譯（若需要）＋執行一次。回 {stage:'ok'|'unavailable'|'compile'|'spawn', ...exec 結果}。給 probe 用；judge 為了只編譯一次，走 prepare＋runTest
async function prepare(lang, source, o) {
    const L = LANGS[lang]; const av = o.tools ? { ok: true, tools: o.tools } : await available(lang);
    if (!av.ok) return { stage: 'unavailable', stderr: av.reason };
    const dir = fs.mkdtempSync(path.join(o.workDir || os.tmpdir(), 'judge-' + lang + '-'));
    fs.writeFileSync(path.join(dir, L.file), source);
    let log = '';
    const plan = o.checkOnly ? (L.check ? L.check(dir, av.tools || {}) : (L.compile ? L.compile(dir, av.tools || {}) : null)) : (L.compile ? L.compile(dir, av.tools || {}) : null);
    if (plan) {
        const c = plan; const chain = c.chain || [c];
        for (const step of chain) {
            const r = await exec(step.cmd, step.args, { cwd: dir, timeoutMs: o.compileTimeoutMs || 30000, maxOutput: 1 << 16 });
            log += (r.stdout || '') + (r.stderr || '');
            if (r.timedOut || r.spawnError || r.code !== 0) { cleanup(dir); return { stage: 'compile', stderr: (r.timedOut ? '編譯逾時\n' : '') + log }; }
        }
    }
    return { stage: 'ok', dir, log };
}
async function runOnce(lang, source, input, o) {
    const p = await prepare(lang, source, o); if (p.stage !== 'ok') return p;
    try { const r = await exec(LANGS[lang].run(p.dir).cmd, LANGS[lang].run(p.dir).args, { cwd: p.dir, input, timeoutMs: o.timeoutMs, maxOutput: o.maxOutput }); return Object.assign({ stage: r.spawnError ? 'spawn' : 'ok' }, r); } finally { cleanup(p.dir); }
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 殘留的暫存目錄不影響結果 */ } }

// 只編譯／做語法檢查、不執行：{lang, source} → {verdict:'CHECKED'|'CE'|'UNAVAILABLE', compileLog, detail, ...}。沒有測試可跑時用（驗證只到「能編譯」，不代表行為正確）
async function check(opts) {
    const lang = opts.lang, source = String(opts.source == null ? '' : opts.source);
    const base = { passed: 0, total: 0, visible: { passed: 0, total: 0 }, hidden: { passed: 0, total: 0 }, failedIndex: -1, maxMs: 0, lang };
    if (!LANGS[lang]) return Object.assign(base, { verdict: 'UNAVAILABLE', detail: '不認得的語言：' + lang });
    const p = await prepare(lang, source, { checkOnly: true, compileTimeoutMs: opts.compileTimeoutMs, workDir: opts.workDir });
    if (p.stage === 'unavailable') return Object.assign(base, { verdict: 'UNAVAILABLE', detail: p.stderr });
    if (p.stage === 'compile') return Object.assign(base, { verdict: 'CE', detail: p.stderr.slice(0, 400), compileLog: p.stderr });
    cleanup(p.dir); return Object.assign(base, { verdict: 'CHECKED', detail: '只通過編譯／語法檢查，沒有執行', compileLog: p.log || '' });
}

// 解釋型語言的語法錯誤是「啟動時」才報的（整份檔案先解析，解析失敗就直接結束）：判成 CE（帶訊息），不是 RE。
// 只認「解析階段」的格式，避免把執行期才丟出的 SyntaxError（例如 python 的 eval("1+")，輸出裡有 Traceback）誤判成編譯失敗
function startupSyntaxError(lang, stderr) {
    const e = String(stderr || '');
    if (lang === 'python') return /^\s*File ".*main\.py", line \d+/m.test(e) && /^(Syntax|Indentation|Tab)Error\b/m.test(e) && !/Traceback \(most recent call last\)/.test(e);
    if (lang === 'nodejs') return /main\.js:\d+/.test(e) && /^SyntaxError\b/m.test(e) && /wrapSafe|compileFunction|Module\._compile|checkSyntax/.test(e);
    if (lang === 'ruby') return /main\.rb:\d+: .*(syntax error|unexpected)/.test(e) || /syntax error, unexpected/.test(e);
    if (lang === 'perl') return /(syntax error at |Missing right curly|Can't find string terminator|Execution of .* aborted due to compilation errors)/.test(e);
    if (lang === 'bash') return /main\.sh: (line \d+: )?syntax error|syntax error near unexpected token|unexpected end of file/.test(e);
    return false;
}

async function judge(opts) {
    const lang = opts.lang, problem = opts.problem, source = String(opts.source == null ? '' : opts.source);
    if (!LANGS[lang]) return Object.assign(core.summarize([]), { lang, detail: '不認得的語言：' + lang });
    const v = core.validateProblem(problem); if (!v.ok) throw new Error('題目格式不對：' + v.errors.join('；'));
    const tests = problem.tests.map((t) => ({ t, hidden: false })).concat((problem.hidden || []).map((t) => ({ t, hidden: true })));
    const timeoutMs = opts.timeoutMs || problem.timeoutMs || 3000;
    const p = await prepare(lang, source, { compileTimeoutMs: opts.compileTimeoutMs, workDir: opts.workDir });
    if (p.stage === 'unavailable') return Object.assign(core.summarize([]), { lang, verdict: 'UNAVAILABLE', detail: p.stderr });
    if (p.stage === 'compile') return Object.assign(core.summarize(tests.map((x) => ({ hidden: x.hidden, verdict: 'CE', detail: p.stderr.slice(0, 400) }))), { lang, compileLog: p.stderr });
    const results = [];
    try {
        const run = LANGS[lang].run(p.dir);
        for (const { t, hidden } of tests) {
            const r = await exec(run.cmd, run.args, { cwd: p.dir, input: t.in, timeoutMs, maxOutput: opts.maxOutput });
            let verdict, detail = '';
            if (r.timedOut) { verdict = 'TLE'; detail = '超過 ' + timeoutMs + 'ms'; }
            else if (r.over) { verdict = 'OLE'; detail = '輸出超過上限'; }
            else if (!r.spawnError && r.code !== 0 && startupSyntaxError(lang, r.stderr)) return Object.assign(core.summarize(tests.map((x) => ({ hidden: x.hidden, verdict: 'CE', detail: String(r.stderr).slice(0, 400) }))), { lang, compileLog: String(r.stderr) });
            else if (r.spawnError || r.code !== 0) { verdict = 'RE'; detail = (r.signal ? '訊號 ' + r.signal : '結束碼 ' + r.code) + '；' + String(r.stderr || '').slice(0, 160).trim(); }
            else { const c = core.compare(r.stdout, t.out, problem.checker, { eps: problem.eps }); verdict = c.ok ? 'AC' : 'WA'; detail = c.ok ? '' : c.reason; }
            results.push({ hidden, verdict, detail, ms: r.ms });
            if (opts.stopAtFirstFail && verdict !== 'AC') break;
        }
    } finally { cleanup(p.dir); }
    return Object.assign(core.summarize(results), { lang });
}

module.exports = { LANGS, ORDER, available, judge, check, exec, startupSyntaxError };
