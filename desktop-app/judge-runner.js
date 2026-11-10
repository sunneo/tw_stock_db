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
const PY = process.platform === 'win32' ? 'python' : 'python3';
// 每種語言：file（原始檔名）、compile(dir)→null 或 {cmd,args}、run(dir)→{cmd,args}、detect（版本探測）、probe（可選，真的跑一個空程式，證明這台機器跑得起來）
const LANGS = {
    // Windows 的 python3 只是 Microsoft Store 的空殼，真的直譯器叫 python；其他平台叫 python3
    python: { file: 'main.py', detect: [PY, ['--version']], check: (d) => sh(PY, ['-m', 'py_compile', path.join(d, 'main.py')]), run: (d) => sh(PY, [path.join(d, 'main.py')]) },
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
// Windows 的 C／C++：PATH 上排前面的 gcc 可能是 Strawberry Perl 或 msys usrin 那支（前者編出來的程式連 hello world 都以 0xC0000005 崩潰，後者找不到標準標頭）。
// 有 mingw64 就明確用它的 gcc／g++，並讓編譯與執行都把它的 bin 放在 PATH 最前面（DLL 才會載對）。位置：環境變數 FA_MINGW_BIN，或 J:\msys64\mingw64in、C:\msys64\mingw64in；都沒有就維持原行為。
const mingwBin = (() => { if (process.platform !== 'win32') return null; for (const d of [process.env.FA_MINGW_BIN, 'J:\\msys64\\mingw64\\bin', 'C:\\msys64\\mingw64\\bin']) { if (d && fs.existsSync(path.join(d, 'gcc.exe')) && fs.existsSync(path.join(d, 'g++.exe'))) return d; } return null; })();
const CC_LANGS = new Set(['c', 'cpp']);
const ccCmd = (lang, cmd) => (mingwBin && CC_LANGS.has(lang) && (cmd === 'gcc' || cmd === 'g++') ? path.join(mingwBin, cmd + '.exe') : cmd);
const ccPath = (lang) => (mingwBin && CC_LANGS.has(lang) ? mingwBin : null);

// 殺掉子行程「連同子孫」：Windows 用 taskkill /T /F（process.kill(-pid) 在 Windows 無效，java／測試的孫行程會變孤兒跑很久）；其他平台殺整個行程群組（spawn 已 detached）
function killTree(child) {
    if (!child || !child.pid) return;
    if (process.platform === 'win32') { try { require('child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch (e) { /* 已結束 */ } try { child.kill('SIGKILL'); } catch (e) { /* 已結束 */ } return; }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* 已結束 */ } }
}
// 子行程的環境變數：精簡集合＋（Windows 需要的系統變數，沒有 SystemRoot 的話 winsock 起不來，python／C 的 socket 都會失敗）＋題目指定的 env
function baseEnv(o) {
    const e = { PATH: o.pathPrefix ? o.pathPrefix + path.delimiter + process.env.PATH : process.env.PATH, HOME: o.cwd || os.tmpdir(), LANG: 'C', LC_ALL: 'C' };
    if (process.platform === 'win32') for (const k of ['SystemRoot', 'SYSTEMDRIVE', 'windir', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) { if (process.env[k]) e[k] = process.env[k]; }
    return Object.assign(e, o.env || {});
}
// o：cwd、input（字串）、inputBuf（Buffer，優先）、timeoutMs、maxOutput、pathPrefix、env（額外環境變數）。結果多帶 stdoutBuf（原始位元組）
function exec(cmd, args, o) {
    o = o || {};
    return new Promise((resolve) => {
        const t0 = Date.now(); let outBufs = [], outLen = 0, err = '', over = false, timedOut = false, done = false, child;
        const cap = o.maxOutput || 1 << 20;
        const fin = (r) => { if (done) return; done = true; clearTimeout(timer); const buf = Buffer.concat(outBufs); resolve(Object.assign({ pid: child && child.pid, stdout: buf.toString('utf8'), stdoutBuf: buf, stderr: err, timedOut, over, ms: Date.now() - t0 }, r)); };
        const killAll = () => { killTree(child); };
        try { child = spawn(cmd, args, { cwd: o.cwd, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: baseEnv(o) }); } catch (e) { return resolve({ code: -1, signal: null, stdout: '', stdoutBuf: Buffer.alloc(0), stderr: String(e.message || e), spawnError: true, ms: 0 }); }
        // 逾時：連子孫一起殺。保險起見 2 秒後若 close 還沒來（有孫行程抓著管線不放）就直接收尾，不能讓呼叫端無限等待
        const timer = setTimeout(() => { timedOut = true; killAll(); setTimeout(() => fin({ code: null, signal: 'SIGKILL' }), 2000).unref(); }, o.timeoutMs || 5000);
        child.stdout.on('data', (b) => { if (outLen < cap) { outBufs.push(b); outLen += b.length; } else if (!over) { over = true; killAll(); } });
        child.stderr.on('data', (b) => { if (err.length < 65536) err += b.toString('utf8'); });
        child.stdin.on('error', () => { /* 程式沒讀完 stdin 就結束：EPIPE，不算錯 */ });
        child.on('error', (e) => fin({ code: -1, signal: null, stderr: String(e.message || e), spawnError: true }));
        child.on('close', (code, signal) => fin({ code, signal }));
        try { child.stdin.end(o.inputBuf ? o.inputBuf : (o.input == null ? '' : String(o.input))); } catch (e) { /* 同上 */ }
    });
}

const cache = new Map();
async function which(name) { const r = await exec('sh', ['-c', 'command -v ' + name], { timeoutMs: 3000 }); return r.code === 0 ? r.stdout.trim().split('\n')[0] : ''; }

function available(lang) {
    if (cache.has(lang)) return cache.get(lang);
    const p = (async () => {
        const L = LANGS[lang]; if (!L) return { ok: false, reason: '不認得的語言：' + lang };
        const tools = {};
        const v = await exec(ccCmd(lang, L.detect[0]), L.detect[1], { timeoutMs: 8000, pathPrefix: ccPath(lang) });
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
            const r = await exec(ccCmd(lang, step.cmd), step.args, { cwd: dir, timeoutMs: o.compileTimeoutMs || 30000, maxOutput: 1 << 16, pathPrefix: ccPath(lang) });
            log += (r.stdout || '') + (r.stderr || '');
            if (r.timedOut || r.spawnError || r.code !== 0) { cleanup(dir); return { stage: 'compile', stderr: (r.timedOut ? '編譯逾時\n' : '') + log }; }
        }
    }
    return { stage: 'ok', dir, log };
}
async function runOnce(lang, source, input, o) {
    const p = await prepare(lang, source, o); if (p.stage !== 'ok') return p;
    try { const r = await exec(LANGS[lang].run(p.dir).cmd, LANGS[lang].run(p.dir).args, { cwd: p.dir, input, timeoutMs: o.timeoutMs, maxOutput: o.maxOutput, pathPrefix: ccPath(lang) }); return Object.assign({ stage: r.spawnError ? 'spawn' : 'ok' }, r); } finally { cleanup(p.dir); }
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

// ───────── 真行程／fork／socket／檔案夾具（G15、G16）─────────
// 題目的每筆測試除了 {in, out}，還可以帶：
//   args:[…]            程式的命令列引數（接在執行命令後面）
//   env:{K:V}           額外的環境變數
//   files:{名稱: 內容}   執行前在這筆測試專屬的工作目錄預置檔案；內容是字串，或 {hex:'…'} 二進位
//   expectFiles:{名稱: 內容}  執行後比對這些檔案（字串用 tokens 比對，{hex} 位元組完全相等）；檔案不存在算 WA
//   expectExit:數字|'any'  結束碼比對（沒寫＝只接受 0，其餘算 RE）；結束碼不符算 WA
//   inHex／outHex       stdin 與 stdout 用二進位（十六進位字串）；有 outHex 時不看 out
//   needs:['fork','socket']  這筆測試需要的行程能力：fork＝程式自己會 fork／waitpid；socket＝用 127.0.0.1 迴圈網路
//   env 與 args 裡的 {{PORT}} 會換成判題器替這筆測試挑好的空閒埠（needs 含 socket 才有；也會設環境變數 JUDGE_PORT）
// 結果多帶 modes：每筆測試實際跑的模式。
//   native＝這個平台本身就能跑（exec／管線／環境／結束碼／socket 一律是真的行程）；
//   msys＝Windows 上的 bash 走 msys／Cygwin 執行環境，fork 是它做出來的真 fork（不是事件模擬）；
//   wsl＝Windows 沒有 fork，改把程式交給 WSL 發行版跑（真 Linux fork），第一次啟動要等十幾秒；
//   none＝這台 Windows 既沒有 WSL 又不是 bash：該筆測試判 UNAVAILABLE（明確說明，不假裝通過）。
const wslCache = {};
const wslPath = (p) => { const m = /^([A-Za-z]):[\\/](.*)$/.exec(p); return m ? '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/') : String(p).replace(/\\/g, '/'); };
function wslInfo() {
    if (wslCache.p) return wslCache.p;
    wslCache.p = (async () => {
        if (process.platform !== 'win32') return { ok: false, reason: '不是 Windows' };
        if (process.env.FA_NO_WSL) return { ok: false, reason: '環境變數 FA_NO_WSL 關閉了 WSL' };
        let name = process.env.FA_WSL_DISTRO;
        if (!name) {
            const raw = await new Promise((res) => require('child_process').execFile('wsl', ['-l', '-q'], { encoding: 'buffer', timeout: 15000, windowsHide: true }, (e, so) => res(e ? null : so)));
            if (!raw) return { ok: false, reason: '執行 wsl -l 失敗（沒裝 WSL）' };
            name = raw.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
            if (!name) return { ok: false, reason: 'WSL 沒有任何發行版' };
        }
        const pr = await exec('wsl', ['-d', name, '--', 'sh', '-c', 'echo wsl-ok'], { timeoutMs: 90000 });
        if (!/wsl-ok/.test(pr.stdout)) return { ok: false, reason: 'WSL 發行版 ' + name + ' 啟動失敗' };
        return { ok: true, distro: name };
    })();
    return wslCache.p;
}
// WSL 裡能跑的語言（發行版要自己有工具；沒有就那筆測試的 stderr 會寫出來）
const WSL_LANGS = {
    python: { file: 'main.py', run: (d) => ['python3', d + '/main.py'] },
    c: { file: 'main.c', compile: (d) => ['gcc', '-O2', '-o', d + '/a.out', d + '/main.c', '-lm'], run: (d) => [d + '/a.out'] },
    cpp: { file: 'main.cpp', compile: (d) => ['g++', '-O2', '-std=c++17', '-o', d + '/a.out', d + '/main.cpp'], run: (d) => [d + '/a.out'] },
    bash: { file: 'main.sh', run: (d) => ['bash', d + '/main.sh'] },
    perl: { file: 'main.pl', run: (d) => ['perl', d + '/main.pl'] },
    ruby: { file: 'main.rb', run: (d) => ['ruby', d + '/main.rb'] },
    nodejs: { file: 'main.js', run: (d) => ['node', d + '/main.js'] }
};
async function prepareWsl(lang, source, o, distro) {
    const L = WSL_LANGS[lang]; const dir = fs.mkdtempSync(path.join(o.workDir || os.tmpdir(), 'judge-wsl-' + lang + '-'));
    fs.writeFileSync(path.join(dir, L.file), source);
    if (L.compile) {
        const c = L.compile(wslPath(dir));
        const r = await exec('wsl', ['-d', distro, '--', ...c], { timeoutMs: o.compileTimeoutMs || 60000, maxOutput: 1 << 16 });
        if (r.timedOut || r.spawnError || r.code !== 0) { cleanup(dir); return { stage: 'compile', stderr: (r.timedOut ? '編譯逾時\n' : '') + (r.stdout || '') + (r.stderr || '') }; }
    }
    return { stage: 'ok', dir, distro, lang };
}
function loopbackOk() {
    return new Promise((res) => { const s = require('net').createServer(); s.on('error', () => res(false)); s.listen(0, '127.0.0.1', () => s.close(() => res(true))); });
}
function freePort() {
    return new Promise((res, rej) => { const s = require('net').createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
// 這台機器的行程能力：{platform, fork:'native'|'msys'|'wsl'|'none', wsl, socket}
async function capabilities(opts) {
    const caps = { platform: process.platform, fork: process.platform === 'win32' ? 'none' : 'native', wsl: null, socket: await loopbackOk() };
    if (process.platform === 'win32') {
        if ((await available('bash')).ok) caps.bashFork = 'msys';
        if (!(opts && opts.skipWsl)) { caps.wsl = await wslInfo(); if (caps.wsl.ok) caps.fork = 'wsl'; }
        if (caps.fork === 'none' && caps.bashFork) caps.fork = 'msys';
    }
    return caps;
}
async function pickMode(lang, need) {
    if (!need.has('fork') || process.platform !== 'win32') return { mode: 'native' };
    if (lang === 'bash') return { mode: 'msys' };
    const w = await wslInfo();
    if (w.ok && WSL_LANGS[lang]) return { mode: 'wsl', distro: w.distro };
    return { mode: 'none', reason: 'Windows 沒有 fork；' + (w.ok ? 'WSL 跑不了語言 ' + lang : 'WSL 不可用（' + w.reason + '）') + '。這筆測試不判通過也不判失敗' };
}
// Windows 上孫行程若在父行程結束後才變孤兒，taskkill /T 追不到（命令列也不含暫存目錄）：
// 孤兒的 ParentProcessId 仍是已死的父行程編號，所以從那個編號往下找「建立時間不早於這筆測試開始」的後代全部殺掉
function sweepOrphans(rootPid, sinceMs) {
    if (process.platform !== 'win32' || !rootPid) return;
    const ps = "$since=" + Math.floor(sinceMs) + ";$all=Get-CimInstance Win32_Process;$q=New-Object System.Collections.Queue;$q.Enqueue([int]" + Number(rootPid) + ");$seen=@{};" +
        "while($q.Count){$x=$q.Dequeue();foreach($p in $all){if($p.ParentProcessId -eq $x -and $p.ProcessId -ne $PID -and -not $seen[$p.ProcessId] -and ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() -ge $since){$seen[$p.ProcessId]=1;$q.Enqueue([int]$p.ProcessId);Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue}}}";
    try { require('child_process').spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore', timeout: 20000 }); } catch (e) { /* 掃不到就算了 */ }
}
const safeRel = (n) => typeof n === 'string' && n.length && !path.isAbsolute(n) && !/(^|[\\/])\.\.([\\/]|$)/.test(n) && !/^[A-Za-z]:/.test(n);
const asBuf = (c) => (c && typeof c === 'object' && typeof c.hex === 'string') ? Buffer.from(c.hex.replace(/\s+/g, ''), 'hex') : Buffer.from(String(c == null ? '' : c), 'utf8');
const subst = (s, port) => (port == null ? s : String(s).replace(/\{\{PORT\}\}/g, String(port)));
// 分析 stdout 之後再比對輸出檔
function checkFiles(td, expect, checker, eps) {
    for (const name of Object.keys(expect || {})) {
        if (!safeRel(name)) return '檔名不合法：' + name;
        const fp = path.join(td, name); let got; try { got = fs.readFileSync(fp); } catch (e) { return '沒有產生檔案 ' + name; }
        const want = expect[name];
        if (want && typeof want === 'object' && typeof want.hex === 'string') { const w = Buffer.from(want.hex.replace(/\s+/g, ''), 'hex'); if (!got.equals(w)) return '檔案 ' + name + ' 位元組不同（長度 ' + got.length + ' vs 期望 ' + w.length + '）'; }
        else { const c = core.compare(got.toString('utf8'), String(want), checker, { eps }); if (!c.ok) return '檔案 ' + name + '：' + c.reason; }
    }
    return '';
}

async function judge(opts) {
    const lang = opts.lang, problem = opts.problem, source = String(opts.source == null ? '' : opts.source);
    if (!LANGS[lang]) return Object.assign(core.summarize([]), { lang, detail: '不認得的語言：' + lang });
    const v = core.validateProblem(problem); if (!v.ok) throw new Error('題目格式不對：' + v.errors.join('；'));
    const tests = problem.tests.map((t) => ({ t, hidden: false })).concat((problem.hidden || []).map((t) => ({ t, hidden: true })));
    const timeoutMs = opts.timeoutMs || problem.timeoutMs || 3000;
    // 全部測試都得交給 WSL 跑（Windows 的 python／C 要 fork）時，不在本機先編譯：POSIX 專屬的原始碼在本機工具鏈會誤判成 CE
    const plan = []; for (const x of tests) plan.push(await pickMode(lang, new Set(x.t.needs || [])));
    const allWsl = plan.length > 0 && plan.every((m) => m.mode === 'wsl');
    const p = allWsl ? { stage: 'ok', dir: fs.mkdtempSync(path.join(opts.workDir || os.tmpdir(), 'judge-' + lang + '-')) } : await prepare(lang, source, { compileTimeoutMs: opts.compileTimeoutMs, workDir: opts.workDir });
    if (p.stage === 'unavailable') return Object.assign(core.summarize([]), { lang, verdict: 'UNAVAILABLE', detail: p.stderr });
    if (p.stage === 'compile') return Object.assign(core.summarize(tests.map((x) => ({ hidden: x.hidden, verdict: 'CE', detail: p.stderr.slice(0, 400) }))), { lang, compileLog: p.stderr });
    const results = [], modes = new Set(); let wslPrep = null;
    try {
        const run = allWsl ? null : LANGS[lang].run(p.dir);
        for (let i = 0; i < tests.length; i++) {
            const { t, hidden } = tests[i];
            const need = new Set(t.needs || []);
            const pm = plan[i];
            modes.add(pm.mode);
            if (pm.mode === 'none') { results.push({ hidden, verdict: 'UNAVAILABLE', detail: pm.reason, ms: 0, mode: 'none' }); if (opts.stopAtFirstFail) break; continue; }
            if (need.has('socket') && !(await loopbackOk())) { results.push({ hidden, verdict: 'UNAVAILABLE', detail: '這台機器開不了 127.0.0.1 的 socket', ms: 0, mode: pm.mode }); continue; }
            const port = need.has('socket') ? await freePort() : null;
            const td = path.join(p.dir, 'w' + i); fs.mkdirSync(td, { recursive: true });
            let bad = '';
            for (const name of Object.keys(t.files || {})) { if (!safeRel(name)) { bad = '檔名不合法：' + name; break; } const fp = path.join(td, name); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, asBuf(t.files[name])); }
            if (bad) { results.push({ hidden, verdict: 'RE', detail: bad, ms: 0, mode: pm.mode }); continue; }
            const env = {}; for (const k of Object.keys(t.env || {})) env[k] = subst(t.env[k], port); if (port != null) env.JUDGE_PORT = String(port);
            const args = (t.args || []).map((a) => subst(a, port));
            const inBuf = t.inHex != null ? Buffer.from(String(t.inHex).replace(/\s+/g, ''), 'hex') : null;
            let r;
            if (pm.mode === 'wsl') {
                if (!wslPrep) wslPrep = await prepareWsl(lang, source, { compileTimeoutMs: opts.compileTimeoutMs, workDir: opts.workDir }, pm.distro);
                if (wslPrep.stage !== 'ok') { results.push({ hidden, verdict: 'CE', detail: String(wslPrep.stderr).slice(0, 400), ms: 0, mode: 'wsl' }); continue; }
                const cmd = WSL_LANGS[lang].run(wslPath(wslPrep.dir)).concat(args);
                const envArgs = Object.keys(env).map((k) => k + '=' + env[k]);
                const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
                r = await exec('wsl', ['-d', pm.distro, '--cd', wslPath(td), '--', 'env'].concat(envArgs, ['timeout', '-k', '1', '-s', 'KILL', String(secs)], cmd), { cwd: td, input: t.in, inputBuf: inBuf, timeoutMs: timeoutMs + 3000, maxOutput: opts.maxOutput });
                if ((r.code === 137 || r.code === 9 || r.signal === 'SIGKILL') && r.ms >= secs * 1000 - 300) { r.timedOut = true; r.ms = Math.min(r.ms, timeoutMs + 1); } // timeout -s KILL 被 wsl.exe 回報成 137 或 9；用耗時區分「自己被訊號殺掉」
            } else {
                const tStart = Date.now();
                r = await exec(run.cmd, run.args.concat(args), { cwd: td, input: t.in, inputBuf: inBuf, env, timeoutMs, maxOutput: opts.maxOutput, pathPrefix: ccPath(lang) });
                if (need.has('fork') || need.has('socket') || t.sweep) sweepOrphans(r.pid, tStart - 500);
            }
            let verdict, detail = '';
            if (r.timedOut) { verdict = 'TLE'; detail = '超過 ' + timeoutMs + 'ms' + (pm.mode === 'wsl' ? '（WSL 以整秒計：' + Math.ceil(timeoutMs / 1000) + ' 秒）' : ''); }
            else if (r.over) { verdict = 'OLE'; detail = '輸出超過上限'; }
            else if (pm.mode !== 'wsl' && !r.spawnError && r.code !== 0 && t.expectExit === undefined && startupSyntaxError(lang, r.stderr)) return Object.assign(core.summarize(tests.map((x) => ({ hidden: x.hidden, verdict: 'CE', detail: String(r.stderr).slice(0, 400) }))), { lang, compileLog: String(r.stderr) });
            else if (r.spawnError) { verdict = 'RE'; detail = String(r.stderr || '').slice(0, 160).trim(); }
            else if (t.expectExit === undefined && r.code !== 0) { verdict = 'RE'; detail = (r.signal ? '訊號 ' + r.signal : '結束碼 ' + r.code) + '；' + String(r.stderr || '').slice(0, 160).trim(); }
            else if (t.expectExit !== undefined && t.expectExit !== 'any' && r.code !== t.expectExit) { verdict = 'WA'; detail = '結束碼 ' + (r.signal ? '訊號 ' + r.signal : r.code) + ' vs 期望 ' + t.expectExit; }
            else if (t.outHex != null) { const want = String(t.outHex).replace(/\s+/g, '').toLowerCase(), got = r.stdoutBuf.toString('hex'); if (got === want) verdict = 'AC'; else { verdict = 'WA'; detail = 'stdout 位元組不同（長度 ' + r.stdoutBuf.length + ' vs 期望 ' + want.length / 2 + '）'; } }
            else { const c = core.compare(r.stdout, t.out, problem.checker, { eps: problem.eps }); verdict = c.ok ? 'AC' : 'WA'; detail = c.ok ? '' : c.reason; }
            if (verdict === 'AC' && t.expectFiles) { const msg = checkFiles(td, t.expectFiles, problem.checker, problem.eps); if (msg) { verdict = 'WA'; detail = msg; } }
            results.push({ hidden, verdict, detail, ms: r.ms, mode: pm.mode });
            if (opts.stopAtFirstFail && verdict !== 'AC') break;
        }
    } finally { cleanup(p.dir); if (wslPrep && wslPrep.dir) cleanup(wslPrep.dir); }
    return Object.assign(core.summarize(results), { lang, modes: [...modes], results: results.map((x) => ({ verdict: x.verdict, mode: x.mode, ms: x.ms })) });
}

module.exports = { LANGS, ORDER, available, judge, check, exec, killTree, startupSyntaxError, capabilities, freePort, sweepOrphans, wslPath };
