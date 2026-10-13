/* CI/CD 核心（UMD，純函式，不碰網路／檔案）：Gerrit／GitHub／Jenkins 的網址與回應整理、CI 失敗記錄分診（triage）。
 * 設計原則（弱模型友善）：
 *   - 工具回傳的是「整理好的結構」：哪個階段失敗、第一個真正的錯誤在哪個檔案第幾行、是程式問題還是環境問題、怎麼在本機重現——
 *     而不是把幾十 MB 的 console 記錄丟給模型。
 *   - 連線與寫入動作（留 review、觸發 build）不在這裡，這裡只有解析與組網址；網路由主行程做（沒有 CORS，Authorization 不經過頁面以外的地方）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const enc = encodeURIComponent;
    const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
    const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
    const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

    // ================= 分診（triage） =================
    // 每條規則：{ tool, re, make(m, line) -> finding 欄位 }；一行只算第一個命中的規則
    const SEV_ORDER = { error: 0, warning: 1, info: 2 };
    const RULES = [
        // 編譯器 GCC／Clang：file:line:col: error: msg
        { tool: 'cc', re: /^(?<file>[^\s:][^:]*?):(?<line>\d+):(?:(?<col>\d+):)?\s*(?<sev>fatal error|error|warning):\s*(?<msg>.+)$/, make: (g) => ({ kind: 'compile', severity: g.sev === 'warning' ? 'warning' : 'error', file: g.file, line: +g.line, col: g.col ? +g.col : undefined, message: g.msg }) },
        { tool: 'ld', re: /^(?:.*?:\s*)?(?:undefined reference to|cannot find -l|multiple definition of)\s*(?<msg>.+)$/, make: (g, l) => ({ kind: 'link', severity: 'error', message: l.trim() }) },
        { tool: 'make', re: /^(?:g?make(?:\[\d+\])?:\s+\*\*\*\s+(?<msg>.+?)\s+Error\s+(?<code>\d+))$/, make: (g) => ({ kind: 'build', severity: 'error', message: 'make 失敗：' + g.msg + '（結束碼 ' + g.code + '）', cascade: true }) },
        // Rust
        { tool: 'rustc', re: /^error(?:\[(?<code>E\d+)\])?:\s*(?<msg>.+)$/, make: (g) => ({ kind: 'compile', severity: 'error', message: (g.code ? g.code + '：' : '') + g.msg, needsLoc: 'rust' }) },
        { tool: 'rustc-loc', re: /^\s*-->\s*(?<file>[^:\s][^:]*):(?<line>\d+):(?<col>\d+)\s*$/, make: (g) => ({ attach: { file: g.file, line: +g.line, col: +g.col } }) },
        // TypeScript／tsc
        { tool: 'tsc', re: /^(?<file>[^\s(][^(]*)\((?<line>\d+),(?<col>\d+)\):\s*(?<sev>error|warning)\s+(?<code>TS\d+):\s*(?<msg>.+)$/, make: (g) => ({ kind: 'compile', severity: g.sev, file: g.file, line: +g.line, col: +g.col, message: g.code + '：' + g.msg }) },
        // Java／Maven：[ERROR] /path/File.java:[12,5] msg
        { tool: 'javac', re: /^\[(?:ERROR|WARNING)\]\s+(?<file>\S+\.(?:java|kt|scala|groovy)):\[(?<line>\d+)(?:,(?<col>\d+))?\]\s*(?<msg>.+)$/, make: (g) => ({ kind: 'compile', severity: 'error', file: g.file, line: +g.line, col: g.col ? +g.col : undefined, message: g.msg }) },
        { tool: 'javac2', re: /^(?<file>\S+\.java):(?<line>\d+):\s*error:\s*(?<msg>.+)$/, make: (g) => ({ kind: 'compile', severity: 'error', file: g.file, line: +g.line, message: g.msg }) },
        { tool: 'maven-tests', re: /^\[(?:ERROR|WARNING)\]\s+Tests run:\s*(?<run>\d+),\s*Failures:\s*(?<f>\d+),\s*Errors:\s*(?<e>\d+)/, make: (g) => (+g.f + +g.e ? { kind: 'test', severity: 'error', message: '測試失敗：' + g.run + ' 個測試，Failures ' + g.f + '、Errors ' + g.e, summary: true } : null) },
        { tool: 'maven', re: /^\[ERROR\]\s+(?:Failed to execute goal\s+)?(?<msg>.+)$/, make: (g) => ({ kind: 'build', severity: 'error', message: g.msg, cascade: /^(?:Failed to execute|-> \[Help|For more information|Re-run Maven|To see the full)/.test(g.msg) || /^\s*$/.test(g.msg), weak: true }) },
        { tool: 'gradle', re: /^>\s*Task\s+(?<task>\S+)\s+FAILED$/, make: (g) => ({ kind: 'build', severity: 'error', message: 'Gradle 工作失敗：' + g.task, cascade: true }) },
        { tool: 'gradle-why', re: /^\*\s*What went wrong:\s*$/, make: () => ({ kind: 'build', severity: 'error', message: 'Gradle：What went wrong', expectNext: true }) },
        // Go
        { tool: 'go', re: /^(?<file>[^\s:][^:]*\.go):(?<line>\d+):(?:(?<col>\d+):)?\s*(?<msg>.+)$/, make: (g) => ({ kind: 'compile', severity: 'error', file: g.file, line: +g.line, col: g.col ? +g.col : undefined, message: g.msg, weak: true }) },
        { tool: 'go-test', re: /^--- FAIL:\s*(?<name>\S+)/, make: (g) => ({ kind: 'test', severity: 'error', message: '測試失敗：' + g.name, test: g.name }) },
        { tool: 'go-panic', re: /^panic:\s*(?<msg>.+)$/, make: (g) => ({ kind: 'runtime', severity: 'error', message: 'panic：' + g.msg }) },
        // Python
        { tool: 'py-frame', re: /^\s*File "(?<file>[^"]+)", line (?<line>\d+)(?:, in (?<fn>.+))?$/, make: (g) => ({ frame: { file: g.file, line: +g.line, fn: g.fn } }) },
        { tool: 'js-exc', re: /^(?<exc>(?:[A-Z][A-Za-z0-9]*)?(?:Error|Exception)(?: \[[A-Z0-9_]+\])?):\s*(?<msg>.*)$/, make: (g) => ({ kind: 'runtime', severity: 'error', message: g.exc + ': ' + g.msg, exception: g.exc, needsFrame: true, jsFrame: true }) },
        { tool: 'py-exc', re: /^(?<exc>(?:[A-Za-z_][\w.]*\.)?(?:[A-Z][A-Za-z0-9]*(?:Error|Exception|Exit|Interrupt|Warning)|AssertionError)):\s*(?<msg>.*)$/, make: (g) => ({ kind: 'runtime', severity: 'error', message: g.exc + ': ' + g.msg, exception: g.exc, needsFrame: true }) },
        { tool: 'pytest', re: /^(?:FAILED|ERROR)\s+(?<id>[^\s:]+(?:::\S+)+)(?:\s+-\s+(?<msg>.+))?$/, make: (g) => ({ kind: 'test', severity: 'error', file: g.id.split('::')[0], message: '測試失敗：' + g.id.split('::').slice(1).join('::') + (g.msg ? ' — ' + g.msg : ''), test: g.id }) },
        { tool: 'pytest-loc', re: /^(?<file>[^\s:][^:]*\.py):(?<line>\d+):\s+(?<exc>\w+(?:Error|Exception)\b.*|AssertionError.*)$/, make: (g) => ({ kind: 'test', severity: 'error', file: g.file, line: +g.line, message: g.exc }) },
        // JS：jest／mocha／eslint
        { tool: 'jest', re: /^\s*●\s+(?<name>.+?)\s*$/, make: (g) => (/Console|Test suite failed to run/i.test(g.name) ? (/failed to run/i.test(g.name) ? { kind: 'test', severity: 'error', message: g.name } : null) : { kind: 'test', severity: 'error', message: '測試失敗：' + g.name, test: g.name }) },
        { tool: 'jest-fail', re: /^\s*FAIL\s+(?<file>\S+\.(?:js|jsx|ts|tsx|mjs|cjs))\b/, make: (g) => ({ kind: 'test', severity: 'error', file: g.file, message: '測試檔失敗：' + g.file, cascade: true }) },
        { tool: 'mocha', re: /^\s*\d+\)\s+(?<name>.+)$/, make: (g) => ({ kind: 'test', severity: 'error', message: '測試失敗：' + g.name, weak: true }) },
        { tool: 'eslint', re: /^\s+(?<line>\d+):(?<col>\d+)\s+(?<sev>error|warning)\s+(?<msg>.+?)\s{2,}(?<rule>[\w@/-]+)$/, make: (g) => ({ kind: 'lint', severity: g.sev, line: +g.line, col: +g.col, message: g.msg + '（' + g.rule + '）', needsFile: 'eslint' }) },
        { tool: 'eslint-file', re: /^(?<file>(?:\/|\.\/|[A-Za-z]:\\)?[^\s:]+\.(?:js|jsx|ts|tsx|vue|mjs|cjs))\s*$/, make: (g) => ({ eslintFile: g.file }) },
        { tool: 'npm', re: /^npm (?:ERR!|error)\s+(?<msg>(?:code|path|command|errno|missing|enoent|Cannot find)\b.+|.*ERESOLVE.*|.*ENOENT.*)$/i, make: (g) => ({ kind: 'dependency', severity: 'error', message: 'npm：' + g.msg, weak: true }) },
        // gtest／ctest／junit
        { tool: 'gtest', re: /^\[\s+FAILED\s+\]\s+(?<name>[\w./]+(?:, where.+)?)/, make: (g) => ({ kind: 'test', severity: 'error', message: '測試失敗：' + g.name, test: g.name.split(',')[0] }) },
        { tool: 'ctest', re: /^\s*\d+\s*-\s*(?<name>\S+)\s*\((?:Failed|Timeout|SEGFAULT|Subprocess aborted)[^)]*\)/i, make: (g) => ({ kind: 'test', severity: 'error', message: 'ctest 失敗：' + g.name, test: g.name }) },
        { tool: 'junit', re: /^(?:FAILED|FAILURE):?\s+(?<name>[\w.$]+(?:\.[\w$]+)+)\s*(?:\((?<where>[^)]+)\))?/, make: (g) => ({ kind: 'test', severity: 'error', message: '測試失敗：' + g.name, test: g.name, weak: true }) },
        // 環境／基礎設施（重試通常有用，不是程式問題）
        { tool: 'infra-net', re: /(?:Could not resolve host|Temporary failure in name resolution|Connection (?:timed out|reset by peer|refused)|Read timed out|TLS handshake timeout|Failed to connect to|unable to access '|HTTP(?:\/\d(?:\.\d)?)? (?:502|503|504)\b|rate limit exceeded|ETIMEDOUT|ECONNRESET|EAI_AGAIN)/i, make: (g, l) => ({ kind: 'infra', category: 'infra', severity: 'error', message: '網路／服務問題：' + clip(l.trim(), 200) }) },
        { tool: 'infra-disk', re: /(?:No space left on device|ENOSPC|disk quota exceeded)/i, make: (g, l) => ({ kind: 'infra', category: 'infra', severity: 'error', message: '磁碟空間不足：' + clip(l.trim(), 200) }) },
        { tool: 'infra-oom', re: /(?:Out of memory|OutOfMemoryError|java\.lang\.OutOfMemory|Killed\s*$|exit code 137|oom-kill|Cannot allocate memory|heap out of memory)/i, make: (g, l) => ({ kind: 'infra', category: 'infra', severity: 'error', message: '記憶體不足（OOM）：' + clip(l.trim(), 200) }) },
        { tool: 'infra-agent', re: /(?:Agent (?:went offline|was removed)|Waiting for next available executor|Cannot contact\s|channel is already closed|hudson\.remoting\.RequestAbortedException|Runner (?:has received a shutdown signal|lost))/i, make: (g, l) => ({ kind: 'infra', category: 'infra', severity: 'error', message: 'CI 執行節點問題：' + clip(l.trim(), 200) }) },
        { tool: 'timeout', re: /(?:Timeout has been exceeded|Cancelling nested steps due to timeout|The job running on runner .* has exceeded the maximum execution time|Build timed out|timed out after \d+)/i, make: (g, l) => ({ kind: 'timeout', category: 'infra', severity: 'error', message: '逾時：' + clip(l.trim(), 200) }) },
        { tool: 'cmd-nf', re: /^(?:.*?:\s*)?(?<cmd>[\w./+-]+):\s*(?:command not found|not found|No such file or directory)\s*$/, make: (g, l) => ({ kind: 'environment', severity: 'error', message: '找不到指令／檔案：' + clip(l.trim(), 200) }) },
        { tool: 'perm', re: /(?:Permission denied|EACCES|Access is denied)/i, make: (g, l) => ({ kind: 'environment', severity: 'error', message: '權限問題：' + clip(l.trim(), 200) }) },
        { tool: 'git-conflict', re: /^(?:CONFLICT \(|error: could not apply|Automatic merge failed|fatal: refusing to merge unrelated histories)/, make: (g, l) => ({ kind: 'merge', severity: 'error', message: 'git 合併衝突：' + clip(l.trim(), 200) }) },
        { tool: 'auth', re: /(?:Authentication failed|401 Unauthorized|403 Forbidden|Permission to .* denied|could not read Username|Invalid username or password|Bad credentials)/i, make: (g, l) => ({ kind: 'auth', category: 'config', severity: 'error', message: '認證／授權失敗：' + clip(l.trim(), 200) }) },
        // CI 系統自己的錯誤標記
        { tool: 'gha-error', re: /^##\[error\](?<msg>.*)$/, make: (g) => ({ kind: 'ci', severity: 'error', message: clip(g.msg.trim(), 300), weak: /^Process completed with exit code/.test(g.msg.trim()) }) },
        { tool: 'jenkins-script', re: /^(?:ERROR:\s*)?script returned exit code (?<code>\d+)/, make: (g) => ({ kind: 'ci', severity: 'error', message: '腳本結束碼 ' + g.code, exit_code: +g.code, weak: true, cascade: true }) },
        { tool: 'jenkins-error', re: /^ERROR:\s*(?<msg>.+)$/, make: (g) => ({ kind: 'ci', severity: 'error', message: clip(g.msg, 300), weak: true }) },
        { tool: 'generic-fatal', re: /^(?:fatal|FATAL|Fatal error|FAILURE|Error)[:!]\s*(?<msg>.+)$/, make: (g) => ({ kind: 'generic', severity: 'error', message: clip(g.msg, 300), weak: true }) },
    ];

    // 環境問題的規則要排在語言例外（py-exc 等）之前：java.lang.OutOfMemoryError 長得像一個 Python 例外
    ['infra-oom', 'infra-disk', 'infra-agent'].reverse().forEach((name) => { const i = RULES.findIndex((r) => r.tool === name); if (i > 0) RULES.unshift(RULES.splice(i, 1)[0]); });

    const STAGE_RES = [
        /^\[Pipeline\]\s*\{\s*\((?<s>.+)\)\s*$/,                // Jenkins: [Pipeline] { (Build)
        /^##\[group\](?:Run\s+)?(?<s>.+)$/,                      // GitHub Actions
        /^Running with gitlab-runner|^\$ (?<s>.+)$/,             // GitLab（命令行當階段線索）
        /^\[INFO\] --- (?<s>[\w.:-]+)/,                          // Maven 外掛目標
        /^> Task (?<s>\S+)(?!\s+FAILED)/,                        // Gradle
        /^=+\s*(?<s>[\w .:/-]+?)\s*=+$/,                         // pytest 區段
    ];

    const JS_FRAME_RE = /^\s+at\s+(?:(?<fn>[^\s(]+)\s+\()?(?<file>(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/]|\.{1,2}\/)?[^\s():]+?\.(?:[cm]?js|jsx|ts|tsx)):(?<line>\d+):(?<col>\d+)\)?\s*$/;
    function findJsFrame(lines, i) { // Node／瀏覽器的例外：訊息在前、stack frame 在後；跳過 node 內部與 node_modules
        for (let k = i + 1; k < Math.min(lines.length, i + 30); k++) { const m = JS_FRAME_RE.exec(lines[k]); if (!m) continue; const f = m.groups.file.replace(/^file:\/\//, ''); if (/node_modules|^node:|^internal\//.test(f)) continue; return { file: f, line: +m.groups.line, col: +m.groups.col, fn: m.groups.fn }; }
        return null;
    }
    function triage(log, opts) {
        opts = opts || {}; const max = opts.maxFindings || 12;
        const text = stripAnsi(String(log == null ? '' : log)).replace(/\r\n?/g, '\n');
        const lines = text.split('\n'); const findings = []; let stage = null; let stageFailed = null; let last = null; let pyFrames = []; let eslintFile = null;
        const seen = new Set();
        const push = (f, i) => {
            const key = [f.kind, f.file || '', f.line || '', clip(f.message, 80)].join('|'); if (seen.has(key)) return null; seen.add(key);
            const o = Object.assign({ stage, at_line: i + 1 }, f); findings.push(o); return o;
        };
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const sr of STAGE_RES) { const m = sr.exec(line); if (m && m.groups && m.groups.s) { if (!/^\$ /.test(line) && !/^Running with/.test(line)) stage = m.groups.s.trim(); break; } }
            let hit = null;
            for (const r of RULES) { const m = r.re.exec(line); if (!m) continue; const f = r.make(m.groups || {}, line); if (f === null) { hit = false; break; } hit = { f, r }; break; }
            if (!hit || hit === false) continue;
            const f = hit.f;
            if (f.frame) { pyFrames.push(f.frame); if (pyFrames.length > 30) pyFrames.shift(); continue; }
            if (f.eslintFile) { eslintFile = f.eslintFile; continue; }
            if (f.attach) { if (last && !last.file) Object.assign(last, f.attach); continue; }
            if (f.expectNext) { const nx = lines.slice(i + 1, i + 6).map((s) => s.trim()).filter(Boolean)[0]; if (nx) f.message = 'Gradle：' + clip(nx, 300); delete f.expectNext; }
            if (f.needsFrame && (f.jsFrame || !pyFrames.length)) { const jf = findJsFrame(lines, i); if (jf) { f.file = jf.file; f.line = jf.line; f.col = jf.col; f.function = jf.fn; delete f.needsFrame; } }
            if (f.needsFrame) { const fr = pyFrames[pyFrames.length - 1]; if (fr) { f.file = fr.file; f.line = fr.line; f.function = fr.fn; f.trace = pyFrames.slice(-4).map((x) => x.file + ':' + x.line + (x.fn ? ' (' + x.fn + ')' : '')); } delete f.needsFrame; pyFrames = []; }
            delete f.jsFrame;
            if (f.needsFile && eslintFile) { f.file = eslintFile; delete f.needsFile; }
            delete f.needsLoc;
            if (f.summary && findings.some((x) => x.kind === 'test' && !x.summary)) continue;
            const o = push(f, i); if (!o) continue;
            o.tool = hit.r.tool; o.context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 4)).map((s) => clip(s, 200)).filter((s) => s.trim());
            last = o;
            if (/Finished: (?:FAILURE|ABORTED)|##\[error\]|BUILD FAILURE|script returned exit code/.test(line)) stageFailed = stageFailed || stage;
        }
        // 結論
        const verdict = (() => {
            const t = text.slice(-4000);
            if (/Finished:\s*SUCCESS|BUILD SUCCESS(?:FUL)?\b|Job succeeded/i.test(t) && !findings.some((f) => f.severity === 'error' && !f.weak)) return 'success';
            if (/Finished:\s*ABORTED|Cancelling nested steps|The operation was canceled|Job canceled/i.test(t)) return 'aborted';
            if (/Finished:\s*FAILURE|BUILD FAILURE|Job failed|Process completed with exit code [1-9]|FAILED/i.test(t) || findings.some((f) => f.severity === 'error')) return 'failure';
            return 'unknown';
        })();
        const errors = findings.filter((f) => f.severity === 'error');
        const strong = errors.filter((f) => !f.weak && !f.cascade);
        const infra = errors.filter((f) => f.category === 'infra');
        const codeish = strong.filter((f) => f.category !== 'infra' && f.category !== 'config');
        // 根因：第一個非連鎖的「程式／測試／編譯」錯誤；沒有的話看環境問題；最後才是 weak 的訊息
        let root = codeish.find((f) => ['compile', 'link', 'runtime', 'test', 'lint', 'merge', 'dependency'].includes(f.kind)) || codeish[0] || infra[0] || strong[0] || errors.find((f) => !f.cascade) || errors[0] || null;
        const category = !root ? 'unknown' : root.category === 'infra' ? 'infra' : root.category === 'config' ? 'config' : (root.kind === 'environment' || root.kind === 'auth') ? 'environment' : 'code';
        const failedTests = Array.from(new Set(errors.filter((f) => f.kind === 'test' && f.test).map((f) => f.test))).slice(0, 30);
        const sorted = findings.slice().sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || (a.at_line - b.at_line));
        const advice = [];
        if (category === 'infra') advice.push('這看起來是環境／基礎設施問題（網路、磁碟、OOM、節點離線、逾時），不是程式碼錯誤：先重試一次（rebuild／re-run failed jobs），反覆發生再處理，不要為了它改程式。');
        if (category === 'environment') advice.push('缺少指令、檔案或權限：檢查 CI 的 agent／image 是否安裝了需要的工具（版本也要對），不是改程式能解決的。');
        if (category === 'config') advice.push('認證／授權失敗：檢查 CI 上的憑證（credentials／secrets）是否存在、是否過期、權限夠不夠；不要把 token 寫進程式碼或 patch。');
        if (category === 'code' && root) advice.push('根因看起來是程式碼：先在本機重現（用 pipeline_inspect 的 local_commands 或下面的 reproduce），修好後用同一條指令驗證，再上 patch。' + (root.file ? ' 從 ' + root.file + (root.line ? ':' + root.line : '') + ' 開始。' : ''));
        if (errors.some((f) => f.cascade) && root) advice.push('後面連鎖的 make／Maven／Gradle／腳本結束碼錯誤只是結果，請從最前面的真正錯誤處理。');
        return {
            verdict, category, failed_stage: stageFailed || (root && root.stage) || null,
            root_cause: root ? { kind: root.kind, file: root.file, line: root.line, col: root.col, message: root.message, stage: root.stage, at_log_line: root.at_line, context: root.context, trace: root.trace } : null,
            failed_tests: failedTests,
            findings: sorted.slice(0, max).map((f) => ({ kind: f.kind, severity: f.severity, file: f.file, line: f.line, message: f.message, stage: f.stage, at_log_line: f.at_line, tool: f.tool })),
            total_findings: findings.length, log_lines: lines.length, advice,
            tail: lines.filter((l) => l.trim()).slice(-20).map((s) => clip(s, 200)),
        };
    }

    // ================= Gerrit =================
    const gerrit = {
        stripXssi: (t) => String(t == null ? '' : t).replace(/^\)\]\}'\s*\n?/, ''),
        parseJson: (t) => { const s = gerrit.stripXssi(t); try { return JSON.parse(s); } catch (e) { throw new Error('Gerrit 回應不是 JSON：' + clip(s, 120)); } },
        // base：Gerrit 網址（有登入時要 /a/ 前綴，由 auth 決定）
        base: (baseUrl, authed) => trimSlash(baseUrl) + (authed ? '/a' : ''),
        urls: {
            query: (b, q, o) => b + '/changes/?q=' + enc(q) + '&n=' + ((o && o.n) || 15) + '&o=LABELS&o=CURRENT_REVISION&o=DETAILED_ACCOUNTS',
            change: (b, id) => b + '/changes/' + enc(id) + '/detail?o=CURRENT_REVISION&o=CURRENT_COMMIT&o=CURRENT_FILES&o=LABELS&o=DETAILED_LABELS&o=MESSAGES&o=DETAILED_ACCOUNTS&o=DOWNLOAD_COMMANDS',
            comments: (b, id) => b + '/changes/' + enc(id) + '/comments',
            drafts: (b, id) => b + '/changes/' + enc(id) + '/drafts',
            patch: (b, id, rev) => b + '/changes/' + enc(id) + '/revisions/' + enc(rev || 'current') + '/patch',
            files: (b, id, rev) => b + '/changes/' + enc(id) + '/revisions/' + enc(rev || 'current') + '/files/',
            fileDiff: (b, id, rev, file) => b + '/changes/' + enc(id) + '/revisions/' + enc(rev || 'current') + '/files/' + enc(file) + '/diff',
            review: (b, id, rev) => b + '/changes/' + enc(id) + '/revisions/' + enc(rev || 'current') + '/review',
        },
        parseChangeUrl: (u) => { // https://host/c/project/+/12345[/3]  或  https://host/#/c/12345/3  或 /12345
            const s = String(u || '').trim(); let m = /^(https?:\/\/[^/]+(?:\/[^/]+)*?)\/(?:c\/(?<proj>.+?)\/\+\/|#\/c\/)(?<n>\d+)(?:\/(?<ps>\d+|edit))?(?:[/?#].*)?$/.exec(s);
            if (m) { const g = m.groups; return { base: m[1], project: g.proj ? decodeURIComponent(g.proj) : undefined, number: +g.n, patchset: g.ps && g.ps !== 'edit' ? +g.ps : undefined }; }
            m = /^(\d{1,9})$/.exec(s); return m ? { number: +m[1] } : null;
        },
        // Change-Id（I + 40 hex）也算一種 id
        isChangeId: (s) => /^I[0-9a-f]{40}$/.test(String(s || '')),
        parseChange: (j) => {
            const revs = j.revisions || {}; const cur = revs[j.current_revision] || {}; const labels = {};
            for (const [name, l] of Object.entries(j.labels || {})) {
                const all = (l.all || []).filter((v) => v.value).map((v) => ({ by: v.name || v.username || (v._account_id && ('#' + v._account_id)), value: v.value }));
                labels[name] = { approved: l.approved ? (l.approved.name || true) : undefined, rejected: l.rejected ? (l.rejected.name || true) : undefined, recommended: l.recommended ? l.recommended.name : undefined, disliked: l.disliked ? l.disliked.name : undefined, votes: all, blocking: !!l.blocking, optional: !!l.optional };
            }
            const files = Object.entries(cur.files || {}).filter(([p]) => p !== '/COMMIT_MSG').map(([p, f]) => ({ path: p, status: f.status || 'M', inserted: f.lines_inserted || 0, deleted: f.lines_deleted || 0 })).slice(0, 200);
            const dl = cur.fetch || {}; const fetch = {}; for (const [proto, v] of Object.entries(dl)) fetch[proto] = { url: v.url, ref: v.ref, checkout: 'git fetch ' + v.url + ' ' + v.ref + ' && git checkout FETCH_HEAD', cherry_pick: 'git fetch ' + v.url + ' ' + v.ref + ' && git cherry-pick FETCH_HEAD' };
            const messages = (j.messages || []).slice(-25).map((m) => ({ id: m.id, author: (m.author && (m.author.name || m.author.username)) || 'unknown', date: m.date, patchset: m._revision_number, message: clip(String(m.message || ''), 600), ci_links: gerrit.ciLinks(m.message) }));
            const ciLinks = []; messages.forEach((m) => m.ci_links.forEach((l) => { if (!ciLinks.some((x) => x.url === l.url)) ciLinks.push(Object.assign({ patchset: m.patchset, author: m.author }, l)); }));
            return {
                number: j._number, id: j.change_id, project: j.project, branch: j.branch, subject: j.subject, status: j.status, topic: j.topic, work_in_progress: !!j.work_in_progress, mergeable: j.mergeable, submittable: j.submittable,
                owner: j.owner && (j.owner.name || j.owner.username), created: j.created, updated: j.updated, insertions: j.insertions, deletions: j.deletions,
                current_patchset: cur._number, current_revision: j.current_revision, ref: cur.ref, commit_message: cur.commit && cur.commit.message, parents: cur.commit && (cur.commit.parents || []).map((p) => p.commit),
                labels, files, fetch, messages, ci_links: ciLinks,
                blockers: gerrit.blockers({ labels, work_in_progress: j.work_in_progress, mergeable: j.mergeable, submittable: j.submittable, status: j.status }),
            };
        },
        // 為什麼還不能 submit
        blockers: (c) => {
            const out = []; if (c.status && c.status !== 'NEW') out.push('狀態是 ' + c.status + '，不是 NEW');
            if (c.work_in_progress) out.push('標成 WIP（work in progress），要先「Ready for review」');
            if (c.mergeable === false) out.push('跟目標分支有衝突（mergeable:false），要 rebase 並解衝突');
            for (const [n, l] of Object.entries(c.labels || {})) { if (l.rejected) out.push(n + ' 被 ' + (l.rejected === true ? '人' : l.rejected) + ' 擋住（負分）'); else if (!l.approved && !l.optional && /^(Code-Review|Verified)$/i.test(n)) out.push(n + ' 還沒通過' + (l.votes && l.votes.length ? '（目前：' + l.votes.map((v) => (v.by || '?') + ' ' + (v.value > 0 ? '+' : '') + v.value).join('、') + '）' : '（還沒有人投票）')); }
            if (c.submittable === false && !out.length) out.push('Gerrit 回報 submittable:false（可能有 submit requirement 沒滿足）');
            return out;
        },
        // 從留言（多半是 CI 機器人）抓 build 連結與結果
        ciLinks: (msg) => {
            const out = []; const s = String(msg || '');
            const re = /(https?:\/\/[^\s)>\]"']+)/g; let m;
            while ((m = re.exec(s))) {
                const url = m[1].replace(/[.,;]+$/, ''); let kind = null;
                if (/\/job\/[^/]+\/(?:job\/[^/]+\/)*\d+\/?/.test(url)) kind = 'jenkins'; else if (/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+/.test(url)) kind = 'github_actions'; else if (/zuul|\/builds?\/[0-9a-f]{8,}/i.test(url)) kind = 'zuul';
                if (kind) out.push({ kind, url, result: /FAIL(?:URE|ED)?|UNSTABLE|ERROR/i.test(s) ? 'failure' : /SUCCESS|PASSED/i.test(s) ? 'success' : undefined });
            }
            return out;
        },
        // 未解決的 review 留言（comments API：{path:[{line,message,author,patch_set,unresolved,...}]}）
        parseComments: (j) => {
            const out = [];
            for (const [path, arr] of Object.entries(j || {})) for (const c of arr || []) out.push({ path, line: c.line || (c.range && c.range.start_line), patch_set: c.patch_set, author: c.author && (c.author.name || c.author.username), message: clip(c.message, 800), unresolved: !!c.unresolved, id: c.id, in_reply_to: c.in_reply_to, updated: c.updated });
            // 只有「串的最後一則」是 unresolved 才算未解決
            const byId = new Map(out.map((c) => [c.id, c])); const replied = new Set(out.map((c) => c.in_reply_to).filter(Boolean));
            const open = out.filter((c) => c.unresolved && !replied.has(c.id));
            return { all: out.length, unresolved: open.sort((a, b) => (a.path + (a.line || 0)).localeCompare(b.path + (b.line || 0))), byId: undefined };
        },
        // 留 review 的 body（寫入動作，呼叫端要先確認）
        reviewInput: (o) => { const b = { message: o.message || undefined, labels: o.labels || undefined, drafts: 'KEEP' }; if (o.comments) b.comments = o.comments; if (o.notify) b.notify = o.notify; if (o.ready) b.ready = true; return b; },
        pushCommands: (o) => {
            o = o || {}; const opts = []; if (o.topic) opts.push('topic=' + o.topic); (o.reviewers || []).forEach((r) => opts.push('r=' + r)); (o.cc || []).forEach((r) => opts.push('cc=' + r)); if (o.wip) opts.push('wip'); if (o.ready) opts.push('ready'); if (o.hashtag) opts.push('t=' + o.hashtag); if (o.message) opts.push('m=' + String(o.message).replace(/ /g, '_'));
            const remote = o.remote || 'origin'; const branch = o.branch || 'master';
            return { push: 'git push ' + remote + ' HEAD:refs/for/' + branch + (opts.length ? '%' + opts.join(',') : ''), amend_new_patchset: 'git commit --amend --no-edit && git push ' + remote + ' HEAD:refs/for/' + branch, rebase: 'git fetch ' + remote + ' ' + branch + ' && git rebase ' + remote + '/' + branch, change_id_hook: 'Gerrit 用 commit message 最後的 "Change-Id: I<40 hex>" 判斷是同一個 change 的新 patchset；沒有的話安裝 hook：gitdir=$(git rev-parse --git-dir); curl -Lo ${gitdir}/hooks/commit-msg <gerrit>/tools/hooks/commit-msg && chmod +x ${gitdir}/hooks/commit-msg，然後 git commit --amend --no-edit。', note: '不要 force push 到 refs/for；每次 push 到同一個 Change-Id 就是新的 patchset。' };
        },
    };

    // ================= GitHub =================
    const github = {
        api: (host) => (!host || /(^|\/\/)(www\.)?github\.com/.test(host) ? 'https://api.github.com' : trimSlash(host) + '/api/v3'),
        parseUrl: (u) => {
            const s = String(u || '').trim(); let m;
            if ((m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(?:files|commits|checks))?/.exec(s))) return { host: m[1], owner: m[2], repo: m[3], kind: 'pull', number: +m[4] };
            if ((m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(s))) return { host: m[1], owner: m[2], repo: m[3], kind: 'run', run_id: +m[4], job_id: m[5] ? +m[5] : undefined };
            if ((m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/.exec(s))) return { host: m[1], owner: m[2], repo: m[3], kind: 'commit', sha: m[4] };
            if ((m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(s))) return { host: m[1], owner: m[2], repo: m[3], kind: 'issue', number: +m[4] };
            if ((m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s))) return { host: m[1], owner: m[2], repo: m[3], kind: 'repo' };
            if ((m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s))) return { owner: m[1], repo: m[2], kind: 'pull', number: +m[3] };
            return null;
        },
        urls: {
            pull: (a, o, r, n) => a + '/repos/' + o + '/' + r + '/pulls/' + n,
            pullFiles: (a, o, r, n) => a + '/repos/' + o + '/' + r + '/pulls/' + n + '/files?per_page=100',
            reviewComments: (a, o, r, n) => a + '/repos/' + o + '/' + r + '/pulls/' + n + '/comments?per_page=100',
            reviews: (a, o, r, n) => a + '/repos/' + o + '/' + r + '/pulls/' + n + '/reviews?per_page=100',
            checkRuns: (a, o, r, sha) => a + '/repos/' + o + '/' + r + '/commits/' + sha + '/check-runs?per_page=100',
            status: (a, o, r, sha) => a + '/repos/' + o + '/' + r + '/commits/' + sha + '/status',
            runsForSha: (a, o, r, sha) => a + '/repos/' + o + '/' + r + '/actions/runs?head_sha=' + sha + '&per_page=30',
            runs: (a, o, r, q) => a + '/repos/' + o + '/' + r + '/actions/runs?per_page=' + ((q && q.n) || 15) + (q && q.branch ? '&branch=' + enc(q.branch) : '') + (q && q.status ? '&status=' + enc(q.status) : ''),
            run: (a, o, r, id) => a + '/repos/' + o + '/' + r + '/actions/runs/' + id,
            jobs: (a, o, r, id) => a + '/repos/' + o + '/' + r + '/actions/runs/' + id + '/jobs?per_page=100',
            jobLogs: (a, o, r, id) => a + '/repos/' + o + '/' + r + '/actions/jobs/' + id + '/logs',
            rerunFailed: (a, o, r, id) => a + '/repos/' + o + '/' + r + '/actions/runs/' + id + '/rerun-failed-jobs',
            workflows: (a, o, r) => a + '/repos/' + o + '/' + r + '/actions/workflows',
            dispatch: (a, o, r, wf) => a + '/repos/' + o + '/' + r + '/actions/workflows/' + enc(wf) + '/dispatches',
            comment: (a, o, r, n) => a + '/repos/' + o + '/' + r + '/issues/' + n + '/comments',
            diffHeader: { Accept: 'application/vnd.github.v3.diff' },
        },
        parsePull: (j) => ({
            number: j.number, title: j.title, state: j.state, draft: !!j.draft, merged: !!j.merged, mergeable: j.mergeable, mergeable_state: j.mergeable_state, author: j.user && j.user.login, url: j.html_url,
            base: j.base && { ref: j.base.ref, sha: j.base.sha }, head: j.head && { ref: j.head.ref, sha: j.head.sha, repo: j.head.repo && j.head.repo.full_name }, from_fork: !!(j.head && j.base && j.head.repo && j.base.repo && j.head.repo.full_name !== j.base.repo.full_name),
            changed_files: j.changed_files, additions: j.additions, deletions: j.deletions, commits: j.commits, labels: (j.labels || []).map((l) => l.name), body: clip(j.body, 1500), requested_reviewers: (j.requested_reviewers || []).map((r) => r.login),
            checkout: j.head ? 'gh pr checkout ' + j.number + '   或   git fetch origin pull/' + j.number + '/head:pr-' + j.number + ' && git checkout pr-' + j.number : undefined,
        }),
        parseCheckRuns: (j) => {
            const runs = (j.check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url, details_url: c.details_url, app: c.app && c.app.slug, summary: clip(c.output && (c.output.summary || c.output.title), 600), annotations: c.output && c.output.annotations_count, started: c.started_at, completed: c.completed_at, run_id: (/actions\/runs\/(\d+)/.exec(c.details_url || c.html_url || '') || [])[1], job_id: (/\/job\/(\d+)/.exec(c.html_url || '') || [])[1] }));
            const failed = runs.filter((r) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(r.conclusion));
            const pending = runs.filter((r) => r.status !== 'completed');
            return { total: runs.length, failed, pending, passed: runs.filter((r) => r.conclusion === 'success').length, skipped: runs.filter((r) => ['skipped', 'neutral'].includes(r.conclusion)).length, overall: failed.length ? 'failure' : pending.length ? 'pending' : runs.length ? 'success' : 'none', runs };
        },
        parseRun: (j) => ({ id: j.id, name: j.name || j.display_title, status: j.status, conclusion: j.conclusion, event: j.event, branch: j.head_branch, sha: j.head_sha, attempt: j.run_attempt, url: j.html_url, created: j.created_at, updated: j.updated_at, actor: j.actor && j.actor.login, workflow_id: j.workflow_id }),
        parseJobs: (j) => (j.jobs || []).map((jb) => ({ id: jb.id, name: jb.name, status: jb.status, conclusion: jb.conclusion, runner: jb.runner_name, url: jb.html_url, started: jb.started_at, completed: jb.completed_at, failed_steps: (jb.steps || []).filter((s) => s.conclusion === 'failure').map((s) => ({ number: s.number, name: s.name })), steps: (jb.steps || []).map((s) => s.number + '. ' + s.name + ' → ' + (s.conclusion || s.status)) })),
        parseReviewComments: (arr) => (arr || []).map((c) => ({ id: c.id, path: c.path, line: c.line || c.original_line, side: c.side, author: c.user && c.user.login, message: clip(c.body, 800), in_reply_to: c.in_reply_to_id, url: c.html_url, outdated: c.position == null && c.line == null })),
        parseReviews: (arr) => (arr || []).map((r) => ({ id: r.id, author: r.user && r.user.login, state: r.state, message: clip(r.body, 600), submitted: r.submitted_at })),
        parseFiles: (arr) => (arr || []).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ? clip(f.patch, 3000) : undefined })),
    };

    // ================= Jenkins =================
    const jenkins = {
        // https://ci/job/a/job/b/123/  → { base, job:'a/b', build:123 }
        parseUrl: (u) => {
            const s = String(u || '').trim(); const m = /^(https?:\/\/[^/]+(?:\/[^/]+)*?)((?:\/job\/[^/]+)+)(?:\/(\d+|lastBuild|lastSuccessfulBuild|lastFailedBuild|lastCompletedBuild))?(?:\/.*)?$/.exec(s);
            if (!m) return null; const job = m[2].split('/job/').filter(Boolean).map(decodeURIComponent).join('/');
            return { base: m[1], job, build: m[3] ? (/^\d+$/.test(m[3]) ? +m[3] : m[3]) : undefined };
        },
        jobPath: (job) => String(job).split('/').filter(Boolean).map((p) => '/job/' + enc(p)).join(''),
        urls: {
            job: (b, job) => trimSlash(b) + jenkins.jobPath(job) + '/api/json?tree=name,fullName,url,color,description,buildable,inQueue,lastBuild[number,url,result],lastSuccessfulBuild[number],lastFailedBuild[number],healthReport[description,score],property[parameterDefinitions[name,type,defaultParameterValue[value],description,choices]],jobs[name,url,color]',
            build: (b, job, n) => trimSlash(b) + jenkins.jobPath(job) + '/' + (n || 'lastBuild') + '/api/json?tree=number,url,result,building,duration,estimatedDuration,timestamp,displayName,description,builtOn,actions[causes[shortDescription,userName],parameters[name,value],failCount,skipCount,totalCount],changeSets[items[commitId,author[fullName],msg,paths[file]]],artifacts[relativePath,fileName]',
            console: (b, job, n) => trimSlash(b) + jenkins.jobPath(job) + '/' + (n || 'lastBuild') + '/consoleText',
            consoleRange: (b, job, n, start) => trimSlash(b) + jenkins.jobPath(job) + '/' + (n || 'lastBuild') + '/logText/progressiveText?start=' + (start || 0),
            tests: (b, job, n) => trimSlash(b) + jenkins.jobPath(job) + '/' + (n || 'lastBuild') + '/testReport/api/json?tree=failCount,passCount,skipCount,duration,suites[name,cases[className,name,status,duration,errorDetails,errorStackTrace,age]]',
            stages: (b, job, n) => trimSlash(b) + jenkins.jobPath(job) + '/' + (n || 'lastBuild') + '/wfapi/describe',
            stageLog: (b, job, n, nodeId) => trimSlash(b) + jenkins.jobPath(job) + '/' + (n || 'lastBuild') + '/execution/node/' + enc(nodeId) + '/wfapi/log',
            crumb: (b) => trimSlash(b) + '/crumbIssuer/api/json',
            trigger: (b, job, hasParams) => trimSlash(b) + jenkins.jobPath(job) + (hasParams ? '/buildWithParameters' : '/build') + '?delay=0sec',
            replay: (b, job, n) => trimSlash(b) + jenkins.jobPath(job) + '/' + n + '/replay',
        },
        parseJob: (j) => ({
            name: j.fullName || j.name, url: j.url, color: j.color, buildable: j.buildable, in_queue: j.inQueue, description: clip(j.description, 400),
            last_build: j.lastBuild && { number: j.lastBuild.number, result: j.lastBuild.result, url: j.lastBuild.url }, last_success: j.lastSuccessfulBuild && j.lastSuccessfulBuild.number, last_failed: j.lastFailedBuild && j.lastFailedBuild.number,
            health: (j.healthReport || []).map((h) => h.description).slice(0, 3),
            parameters: [].concat(...(j.property || []).map((p) => p.parameterDefinitions || [])).map((p) => ({ name: p.name, type: (p.type || '').replace(/ParameterDefinition$/, ''), default: p.defaultParameterValue && p.defaultParameterValue.value, description: clip(p.description, 120), choices: p.choices })),
            sub_jobs: (j.jobs || []).map((x) => ({ name: x.name, status: x.color })),
        }),
        parseBuild: (j) => {
            const actions = j.actions || []; const causes = [].concat(...actions.map((a) => a && a.causes ? a.causes : [])).map((c) => c.shortDescription).filter(Boolean);
            const params = [].concat(...actions.map((a) => a && a.parameters ? a.parameters : [])).map((p) => ({ name: p.name, value: /pass|token|secret|key/i.test(p.name) ? '(隱藏)' : p.value }));
            const tc = actions.find((a) => a && a.totalCount != null);
            const commits = [].concat(...(j.changeSets || []).map((cs) => cs.items || [])).map((i) => ({ id: (i.commitId || '').slice(0, 12), author: i.author && i.author.fullName, message: clip(i.msg, 200), files: (i.paths || []).map((p) => p.file).slice(0, 15) }));
            return { number: j.number, url: j.url, result: j.result || (j.building ? 'BUILDING' : undefined), building: !!j.building, duration_s: j.duration != null ? Math.round(j.duration / 1000) : undefined, estimated_s: j.estimatedDuration != null ? Math.round(j.estimatedDuration / 1000) : undefined, started: j.timestamp ? new Date(j.timestamp).toISOString() : undefined, node: j.builtOn, causes, parameters: params, tests: tc ? { total: tc.totalCount, failed: tc.failCount, skipped: tc.skipCount } : undefined, commits, artifacts: (j.artifacts || []).map((a) => a.relativePath).slice(0, 30) };
        },
        parseTests: (j) => {
            const failed = []; for (const s of j.suites || []) for (const c of s.cases || []) if (/FAILED|REGRESSION/.test(c.status || '')) failed.push({ suite: s.name, class: c.className, name: c.name, status: c.status, age: c.age, details: clip(c.errorDetails, 500), stack: clip(c.errorStackTrace, 1200) });
            return { passed: j.passCount, failed_count: j.failCount, skipped: j.skipCount, duration_s: j.duration != null ? Math.round(j.duration) : undefined, failed: failed.slice(0, 40), new_failures: failed.filter((f) => f.status === 'REGRESSION' || f.age === 1).map((f) => f.class + '.' + f.name).slice(0, 30) };
        },
        parseStages: (j) => ({ status: j.status, duration_s: j.durationMillis != null ? Math.round(j.durationMillis / 1000) : undefined, stages: (j.stages || []).map((s) => ({ id: s.id, name: s.name, status: s.status, duration_s: Math.round((s.durationMillis || 0) / 1000), error: s.error && s.error.message ? clip(s.error.message, 300) : undefined })), failed_stage: ((j.stages || []).find((s) => /FAILED|ABORTED|UNSTABLE/.test(s.status)) || {}).name }),
        // 這個結果算不算「成功」
        resultOk: (r) => r === 'SUCCESS',
    };

    // 把 build／job 的狀態字串統一成 success／failure／pending／aborted／unknown
    function normalizeResult(s) {
        s = String(s || '').toLowerCase();
        if (/^(success|passed|succeeded|completed:success|neutral)$/.test(s)) return 'success';
        if (/^(failure|failed|error|timed_out|startup_failure|unstable)$/.test(s)) return 'failure';
        if (/^(aborted|cancelled|canceled|skipped)$/.test(s)) return 'aborted';
        if (/^(building|in_progress|queued|pending|running|waiting|requested)$/.test(s)) return 'pending';
        return 'unknown';
    }


    // ================= 觀念與指令速查（給 ci_guide 工具）=================
    const guide = {
        workflow: [
            '【修 CI 失敗的標準流程】（修 bug 也一樣：先重現、再最小修改、再補回歸測試）',
            '1. 拿到失敗現場：GitHub 用 github_ci action:pr（看 checks.failed）→ action:log 帶 job_id；Jenkins 用 jenkins action:build（失敗時自動帶 triage）；Gerrit 先 gerrit action:change，從 ci_links 找 build 網址再交給 jenkins。',
            '2. 看 triage.category 決定怎麼做：infra（網路／磁碟／OOM／節點離線／逾時）→ 先重試，不要改程式；config（認證失敗）→ 檢查 CI 的憑證，不要把 token 寫進程式；environment（找不到指令／權限）→ 修 CI 環境或 image；code → 繼續往下。',
            '3. 先確認「根因」不是連鎖錯誤：make／Maven／Gradle 的 Error 1、script returned exit code 都只是結果，從 triage.root_cause（最前面的真正錯誤）開始。',
            '4. 開暫存工作區（coding_workspace open），用 pipeline_inspect action:local_commands 取得 CI 那一步的指令，**在本機先重現同樣的失敗**（看到同樣的錯誤才算重現；重現不了先找環境差異：版本、環境變數、平台、時區、並行）。',
            '5. 讀失敗位置附近的程式（root_cause.file:line），用 repo_ask／explain_code 查誰呼叫它、它做什麼，再決定修法。小的改動用 coding_edit；機械式的大量修改寫 coding_patch_tool。',
            '6. 補一個「修之前會失敗、修之後會通過」的測試（回歸測試），然後跑同一條 CI 指令確認通過，再跑完整測試。',
            '7. commit（訊息寫「為什麼」）。Gerrit：amend 後 push 到 refs/for 產生新 patchset（gerrit action:push_help）；GitHub：push 到 PR 的分支。**不要自己 push，除非使用者說可以**；絕不 force push 共用分支。',
            '8. push 之後再查一次 CI 結果（github_ci action:checks／jenkins action:build），確認真的綠了才回報完成。連續失敗兩次且 triage 是 infra，如實告訴使用者是環境問題。',
        ].join('\n'),
        gerrit: [
            '【Gerrit 觀念】',
            '- change＝一個「正在被 review 的 commit」，用 commit message 最後的 `Change-Id: I<40 hex>` 識別；同一個 Change-Id 每次 push 就是新的 patchset（PS1、PS2…）。',
            '- 一個 change 的 patchset 在 ref `refs/changes/<最後兩位數>/<change 編號>/<patchset>`，例如 change 12345 的 PS3＝refs/changes/45/12345/3。拿到它：`git fetch <remote> refs/changes/45/12345/3 && git checkout FETCH_HEAD`（要在上面改就 `git checkout -b fix-12345`）。',
            '- 上傳：`git push origin HEAD:refs/for/<目標分支>`；加選項用 %：`%topic=名稱,r=審查者email,cc=email,wip`（WIP 不通知），`%ready` 把 WIP 變成可審查。amend 後再 push 同一個指令就是新 patchset。**不是 push 到分支本身**，那會被拒絕。',
            '- 沒有 Change-Id 的 commit 會被拒絕：安裝 commit-msg hook（見 push_help）後 `git commit --amend --no-edit`。',
            '- 標籤（labels）：Code-Review（-2 擋住、-1 不建議、+1 看起來可以、+2 核准）、Verified（-1 CI 失敗、+1 CI 通過；通常只有 CI 帳號能投）。要 submit 需要 Code-Review +2 與 Verified +1（依 project 設定）、沒有 -2、沒有衝突（mergeable）、不是 WIP。blockers 欄位會直接列出缺什麼。',
            '- 未解決的留言（unresolved）也會擋住 submit：逐一處理後在網頁或用 review API 回覆並標成 resolved。',
            '- 衝突：`git fetch origin <分支> && git rebase origin/<分支>`，解完 `git rebase --continue`，再 push 成新 patchset。',
            '- 搜尋語法：`status:open`、`owner:self`、`project:foo`、`branch:main`、`topic:x`、`change:12345`、`label:Code-Review=-1`、`is:wip`、`age:2d`、`message:"關鍵字"`、`file:path`，用空白連接（且）。',
            '- REST：有登入的網址要加 `/a/` 前綴（HTTP Basic，密碼是 Gerrit 設定頁產生的 HTTP password，不是登入密碼）；回應開頭有 `)]}\'` 防 XSSI，要先去掉。',
            '- CI 通常是 Jenkins／Zuul 帳號在 change 的留言裡貼 build 網址並投 Verified；gerrit action:change 的 ci_links 會抓出來。',
            '- cherry-pick／backport：`git cherry-pick -x <sha>` 會在訊息裡記錄來源；跨分支 backport 在 Gerrit 網頁有 Cherry Pick 按鈕，也可 `git push origin HEAD:refs/for/<舊分支>`。',
        ].join('\n'),
        github: [
            '【GitHub 觀念】',
            '- PR：head（你的分支，可能在 fork）→ base（目標分支）。在本機拿到 PR：`gh pr checkout <N>`，或 `git fetch origin pull/<N>/head:pr-<N> && git checkout pr-<N>`；`pull/<N>/merge` 是「合併後」的結果（CI 預設測這個）。',
            '- checks：每個 workflow 的每個 job 是一個 check run（conclusion：success／failure／cancelled／timed_out／skipped／neutral／action_required）；另有舊的 commit status。github_ci action:pr 會一次列出失敗的 job 與失敗的 step。',
            '- Actions：workflow（.github/workflows/*.yml）→ run（一次觸發）→ jobs → steps。看失敗：`gh run view <run id> --log-failed`；重跑失敗的：`gh run rerun <run id> --failed`；列表 `gh run list --branch <b>`。',
            '- 常見失敗原因：從 fork 來的 PR 拿不到 secrets（所以用 secrets 的步驟會失敗，不是程式錯）；pull_request_target 在目標 repo 權限下跑（危險，不要 checkout PR 程式碼）；action 沒釘版本被上游改壞；runner 的 ubuntu-latest 升級改了預設工具版本；快取過期；流量／並行限制。',
            '- 本機重現：pipeline_inspect action:local_commands 把 workflow 的 run: 步驟變成本機指令；setup-node／setup-python 這類 action 會轉成「需要什麼版本」。',
            '- 流量：未登入 REST API 每小時 60 次，登入後 5000 次；403 且 x-ratelimit-remaining 是 0 就是用完了。',
            '- 常用 gh：`gh pr view <N> --comments`、`gh pr diff <N>`、`gh pr checks <N>`、`gh pr create --fill`、`gh api repos/<o>/<r>/pulls/<N>/comments`。沒有 gh 時用 github_ci 工具。',
            '- 留言、重跑、觸發都是「寫入」，會跳確認框；使用者沒要求就不要做。',
        ].join('\n'),
        jenkins: [
            '【Jenkins 觀念】',
            '- job 路徑：資料夾與 multibranch 會巢狀，網址是 /job/team/job/app/job/main/，工具的 job 參數寫 team/app/main。build 編號之外還有 lastBuild／lastSuccessfulBuild／lastFailedBuild。',
            '- Pipeline 記錄裡的標記：`[Pipeline] { (Build)` 是進入 stage Build；`+ make -j4` 是 sh 步驟執行的指令（sh 預設 -xe，任何指令失敗就停）；`script returned exit code 2` 是那個 sh 的結束碼；`Finished: FAILURE|UNSTABLE|ABORTED|SUCCESS` 是最後結果。UNSTABLE 通常是測試有失敗但 build 沒壞。',
            '- 看失敗：jenkins action:build 一次給結果、各 stage 狀態、測試統計與失敗分診；只想看記錄原文用 action:console。測試報告要有 junit 步驟才有（tests 回 has_test_report:false 就是沒有）。',
            '- 有參數的 job 觸發要用 buildWithParameters；POST 需要 crumb（CSRF token），工具會自動先取；使用者認證用「使用者名稱＋API token」（個人設定頁產生），不是登入密碼。',
            '- 節點問題：`Waiting for next available executor`、`Agent went offline`、`Cannot contact <節點>` 是基礎設施問題，重試或找管理員，不是程式錯。',
            '- Replay：Pipeline build 頁面可以修改 Jenkinsfile 後重跑一次（不用 commit），適合試 pipeline 本身的修改；正式修改仍要 commit 進 Jenkinsfile。',
            '- 好的 Jenkinsfile：固定 agent（label／docker）、options 裡設 timeout 與 buildDiscarder、測試後 junit 發佈報告、post 區塊通知與清理、機密只用 credentials()／withCredentials。pipeline_inspect action:lint 會檢查這些。',
        ].join('\n'),
        patch: [
            '【準備與上 patch】',
            '- 優先順序：①小修改用 coding_edit（找這段、換成那段，程式幫你定位並產生 diff）；②機械式的大量修改（改名、批次替換、搬移、產生檔案）用 coding_patch_tool 寫一支小腳本（node 不用安裝），dry_run 看 diff → apply；③手寫 unified diff 用 apply_git_patch（最容易寫錯，行號與 context 要逐字對）。',
            '- unified diff 格式：`--- a/路徑`、`+++ b/路徑`、`@@ -舊起始行,舊行數 +新起始行,新行數 @@`，之後每行以空白（不變）、`-`（刪除）、`+`（新增）開頭；hunk 前後至少 3 行 context；新增檔案用 `--- /dev/null`。結尾沒換行要有 `\\ No newline at end of file`。',
            '- 驗證順序：`git apply --check` 乾跑 → 套用 → `git diff` 看實際變更 → 語法檢查 → 測試 → commit。失敗就 `git_inspect mode:restore` 還原，不要在壞掉的檔案上繼續疊修改。',
            '- 收到別人的 patch：`git apply --check x.patch` 看能不能直接套；`git am x.patch` 保留作者與訊息（mbox 格式，Gerrit patch API 與 git format-patch 的輸出都是）；對不上用 `git apply --3way` 或 `git am -3`；有衝突時先看是不是目標分支已經改過同一處。',
            '- 好 patch 的樣子：一個 patch 只做一件事；改動小到能一眼看完；commit message 第一行說「做了什麼」、內文說「為什麼」；包含測試；不夾帶無關的格式化。',
            '- 上游審查：Gerrit 用 amend 同一個 commit（保留 Change-Id）push 成新 patchset，不要開新的 change；GitHub 在 PR 的分支上追加 commit（或 amend 後 force-with-lease 自己的分支）。',
            '- backport：`git cherry-pick -x <sha>`；衝突時理解兩邊差異再解，不要只是挑一邊。',
            '- 回復：`git revert <sha>` 產生一個還原的新 commit（共用分支用這個）；本機還沒 push 的才用 reset。',
        ].join('\n'),
        pipeline: [
            '【設計 pipeline 的原則】',
            '- 失敗要快：順序是 lint／靜態檢查 → 建置 → 單元測試 → 整合測試 → 打包 → 部署；便宜的檢查放前面，獨立的工作用 parallel／matrix 並行。',
            '- 可重現：固定 agent 環境（容器 image 或 label）、釘住工具與 action 的版本（最好是 commit SHA）、依賴用 lockfile（npm ci、pip 的 hash、go.sum）。',
            '- 同一條指令本機與 CI 都能跑：把真正的步驟放在 Makefile／scripts／package.json scripts，pipeline 只呼叫它們；這樣 CI 失敗時本機就能重現，pipeline 檔案也最薄。',
            '- 一定要有：timeout（避免卡死占節點）、測試報告（junit／artifacts）、失敗通知、舊記錄與產物的清理。',
            '- 機密：只用 CI 的憑證機制（Jenkins credentials、GitHub secrets、GitLab masked variables），不印出、不寫進 repo、不給 fork 的 PR；權限給最小（GitHub 的 permissions）。',
            '- 避免：`|| true` 吞失敗、`curl | sh`、`sudo`、寫死的路徑、依賴「上一次 build 留下來的東西」、用 sleep 等服務（改成輪詢健康檢查）。',
            '- 重試只用在「已知會偶發的基礎設施問題」（下載、拉 image），不要用來掩蓋不穩定的測試；不穩定的測試要修或隔離並開 issue。',
            '- 部署：prod 要人工核准（Jenkins input 加 timeout、GitHub environments 的 required reviewers）、部署要能回復、同一版本的 artifact 從 staging 原封不動升到 prod。',
            '- 沒有 pipeline 時：pipeline_inspect action:scaffold 依專案工具鏈產生樣板，先在本機把那些指令跑過，再放進專案。',
        ].join('\n'),
    };

    return { triage, gerrit, github, jenkins, normalizeResult, stripAnsi, guide };
});
