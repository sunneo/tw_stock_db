/* Pipeline 定義的核心（UMD，純函式）：偵測 → 解析 → 檢查（lint）→ 本機重現用指令 → 產生樣板。
 * 支援：Jenkinsfile（宣告式與腳本式）、GitHub Actions（.github/workflows/*.yml）、GitLab CI（.gitlab-ci.yml）。
 * YAML 解析由呼叫端提供（yamlLoad：js-yaml 的 load），這裡不內建 YAML 解析器。
 * 目的不是取代 CI，而是讓 AI「讀得懂 pipeline 在做什麼、哪裡有風險、失敗的那一步怎麼在本機重現、沒有 pipeline 時產生一份合理的」。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaPipeline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

    function detect(path, text) {
        const p = String(path || '').replace(/\\/g, '/'); const base = p.split('/').pop();
        if (/^Jenkinsfile(\..+)?$/i.test(base) || /\.jenkinsfile$/i.test(base) || /\.groovy$/i.test(base) && /\bpipeline\s*\{|\bnode\s*(?:\(|\{)/.test(text || '')) return 'jenkins';
        if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(p)) return 'github';
        if (/(^|\/)\.gitlab-ci\.ya?ml$/i.test(p)) return 'gitlab';
        const t = String(text || '');
        if (/^\s*pipeline\s*\{/m.test(t) || /^\s*node\s*(?:\([^)]*\))?\s*\{/m.test(t)) return 'jenkins';
        if (/^on\s*:|^\s*jobs\s*:/m.test(t) && /runs-on\s*:|uses\s*:/.test(t)) return 'github';
        if (/^stages\s*:/m.test(t) && /script\s*:/.test(t)) return 'gitlab';
        return null;
    }

    // ---------- Groovy 區塊掃描（略過字串與註解）----------
    function scanCode(text) { // 回傳遮蔽掉字串與註解內容的同長度文字（括號比對用），以及字串區間
        const out = text.split(''); const strs = []; let i = 0; const n = text.length;
        while (i < n) {
            const c = text[i], d = text[i + 1];
            if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') { out[i] = ' '; i++; } continue; }
            if (c === '/' && d === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; for (let k = i; k < end; k++) if (text[k] !== '\n') out[k] = ' '; i = end; continue; }
            if ((c === "'" || c === '"')) {
                const tri = text.substr(i, 3) === c + c + c; const q = tri ? c + c + c : c; let j = i + q.length;
                while (j < n) { if (text[j] === '\\') { j += 2; continue; } if (text.substr(j, q.length) === q) break; if (!tri && text[j] === '\n') break; j++; }
                const end = Math.min(n, j + q.length); strs.push({ start: i, end, quote: q, body: text.slice(i + q.length, Math.max(i + q.length, j)) });
                for (let k = i; k < end; k++) if (text[k] !== '\n') out[k] = ' '; i = end; continue;
            }
            i++;
        }
        return { masked: out.join(''), strs };
    }
    function matchBrace(masked, open) { let d = 0; for (let i = open; i < masked.length; i++) { if (masked[i] === '{') d++; else if (masked[i] === '}') { d--; if (!d) return i; } } return -1; }
    // 在 [from,to) 內、depth 0 找 name { … } 區塊
    function blocksNamed(masked, text, from, to, nameRe) {
        const out = []; let depth = 0; let seg = from; // seg：目前這個「敘述」從哪裡開始（換行、分號、剛關掉的區塊之後）
        for (let i = from; i < to; i++) {
            const c = masked[i];
            if (c === '{') {
                if (depth === 0) { const head = text.slice(seg, i); const m = nameRe.exec(head); if (m) { const end = matchBrace(masked, i); if (end > 0) out.push({ name: m[1], head, start: i + 1, end, args: m }); } }
                depth++;
            } else if (c === '}') { depth--; if (depth === 0) seg = i + 1; }
            else if (depth === 0 && (c === '\n' || c === ';')) seg = i + 1;
        }
        return out;
    }
    const blockNamedFirst = (masked, text, from, to, name) => blocksNamed(masked, text, from, to, new RegExp('^\\s*(' + name + ')\\b[^\\n{]*$'))[0] || null;

    function parseSteps(text, masked, strs, from, to) {
        const found = [];
        // sh／bat／powershell：看每個字串「前面」是不是這些指令（不管在第幾層、同一行的 timeout { sh 'x' } 也抓得到）
        for (const sg of strs) {
            if (sg.start < from || sg.end > to) continue;
            const before = masked.slice(Math.max(from, sg.start - 48), sg.start);
            const m = /(?:^|[\s;{(])(sh|bat|powershell|pwsh)\s*\(?\s*(?:script\s*:\s*)?$/.exec(before);
            if (m) found.push({ pos: sg.start, step: { type: m[1] === 'pwsh' ? 'powershell' : m[1], cmd: sg.body.replace(/^\n/, '').replace(/\n\s*$/, ''), dynamic: /\$\{|\$[A-Za-z_]/.test(sg.body) && sg.quote[0] === '"' } });
        }
        // 其他步驟：只看「最上層」的行（wrapper 裡面的 echo／junit 之類不重要）
        let depth = 0, ls = from;
        for (let i = from; i <= to; i++) {
            if (i < to && masked[i] !== '\n') continue;
            const mline = masked.slice(ls, i); const line = text.slice(ls, i); const at = ls; ls = i + 1;
            const opens = (mline.match(/\{/g) || []).length, closes = (mline.match(/\}/g) || []).length;
            if (depth === 0) {
                let m; const add = (step) => found.push({ pos: at, step });
                if ((m = /^\s*(echo|println)\b/.exec(mline))) add({ type: 'echo' });
                else if ((m = /^\s*(checkout|git)\b/.exec(mline))) add({ type: 'checkout', text: clip(line.trim(), 160) });
                else if ((m = /^\s*(junit|archiveArtifacts|publishHTML|recordIssues|cobertura|jacoco|publishTestResults)\b/.exec(mline))) add({ type: 'report', name: m[1], text: clip(line.trim(), 160) });
                else if (/^\s*build\b/.test(mline)) add({ type: 'trigger_job', text: clip(line.trim(), 200) });
                else if (/^\s*input\b/.test(mline)) add({ type: 'input', text: clip(line.trim(), 160) });
                else if ((m = /^\s*(withCredentials|withEnv|dir|timeout|retry|lock|ws|docker\.image|withDockerContainer|script|parallel|catchError|waitUntil|sleep)\b/.exec(mline))) add({ type: 'wrapper', name: m[1], text: clip(line.trim(), 160) });
                else if ((m = /^\s*(deleteDir|cleanWs|stash|unstash|slackSend|mail|emailext|error|unstable|currentBuild\.\w+)\b/.exec(mline))) add({ type: 'misc', name: m[1], text: clip(line.trim(), 160) });
            }
            depth = Math.max(0, depth + opens - closes);
        }
        return found.sort((a, b) => a.pos - b.pos).map((x) => x.step);
    }

    function parseJenkins(raw) {
        const text = String(raw || ''); const { masked, strs } = scanCode(text);
        const res = { kind: 'jenkins', style: 'scripted', agent: null, options: {}, env: {}, parameters: [], triggers: [], stages: [], post: {}, tools: [] };
        const pl = /\bpipeline\s*\{/.exec(masked);
        let from = 0, to = text.length;
        if (pl) { res.style = 'declarative'; const open = pl.index + pl[0].length - 1; from = open + 1; to = matchBrace(masked, open); if (to < 0) to = text.length; }
        // agent
        if (pl) {
            const am = /(^|\n)\s*agent\s+(any|none)\b/.exec(masked.slice(from, to));
            if (am) res.agent = am[2]; else { const ab = blockNamedFirst(masked, text, from, to, 'agent'); if (ab) res.agent = clip(text.slice(ab.start, ab.end).replace(/\s+/g, ' ').trim(), 160); }
            const ob = blockNamedFirst(masked, text, from, to, 'options'); if (ob) { const o = text.slice(ob.start, ob.end); const tm = /timeout\s*\(\s*time\s*:\s*(\d+)(?:\s*,\s*unit\s*:\s*['"](\w+)['"])?/.exec(o); if (tm) res.options.timeout = tm[1] + ' ' + (tm[2] || 'MINUTES').toLowerCase(); res.options.timestamps = /timestamps\s*\(\)/.test(o); res.options.disableConcurrentBuilds = /disableConcurrentBuilds/.test(o); res.options.buildDiscarder = /buildDiscarder/.test(o); res.options.retry = (/retry\s*\(\s*(\d+)/.exec(o) || [])[1]; }
            const eb = blockNamedFirst(masked, text, from, to, 'environment'); if (eb) for (const l of text.slice(eb.start, eb.end).split('\n')) { const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/.exec(l); if (m) res.env[m[1]] = /credentials\(/.test(m[2]) ? '(credentials)' : clip(m[2].replace(/^['"]|['"]$/g, ''), 80); }
            const pb = blockNamedFirst(masked, text, from, to, 'parameters'); if (pb) for (const m of text.slice(pb.start, pb.end).matchAll(/(string|booleanParam|choice|text|password|file)\s*\(\s*(?:name\s*:\s*)?['"]([^'"]+)['"]/g)) res.parameters.push({ type: m[1], name: m[2] });
            const tb = blockNamedFirst(masked, text, from, to, 'triggers'); if (tb) for (const m of text.slice(tb.start, tb.end).matchAll(/(cron|pollSCM|upstream|githubPush|gerrit)\s*\(?\s*['"]?([^'")\n]*)/g)) res.triggers.push((m[1] + ' ' + m[2]).trim());
            const tl = blockNamedFirst(masked, text, from, to, 'tools'); if (tl) res.tools = text.slice(tl.start, tl.end).split('\n').map((l) => l.trim()).filter(Boolean);
            const post = blockNamedFirst(masked, text, from, to, 'post'); if (post) for (const c of blocksNamed(masked, text, post.start, post.end, /^\s*(always|success|failure|unstable|changed|fixed|regression|aborted|cleanup)\b[^\n{]*$/)) res.post[c.name] = parseSteps(text, masked, strs, c.start, c.end);
        }
        const stageRe = /^\s*(?:stage)\s*\(\s*['"]([^'"]+)['"]\s*\)\s*$/;
        const walkStage = (b, depthName) => {
            const st = { name: b.args[1], steps: [], parallel: false };
            const inner = (n) => blockNamedFirst(masked, text, b.start, b.end, n);
            const ag = /(^|\n)\s*agent\s+(any|none)\b/.exec(masked.slice(b.start, b.end)); const agb = inner('agent'); st.agent = ag ? ag[2] : (agb ? clip(text.slice(agb.start, agb.end).replace(/\s+/g, ' ').trim(), 120) : undefined);
            const wh = inner('when'); if (wh) st.when = clip(text.slice(wh.start, wh.end).replace(/\s+/g, ' ').trim(), 160);
            const stepsB = inner('steps'); st.steps = stepsB ? parseSteps(text, masked, strs, stepsB.start, stepsB.end) : (pl ? [] : parseSteps(text, masked, strs, b.start, b.end));
            const par = inner('parallel'); if (par) { st.parallel = true; st.children = blocksNamed(masked, text, par.start, par.end, stageRe).map(walkStage); st.failFast = /failFast\s+true/.test(text.slice(par.start, par.end)) || undefined; }
            const seq = inner('stages'); if (seq) st.children = blocksNamed(masked, text, seq.start, seq.end, stageRe).map(walkStage);
            const po = inner('post'); if (po) { st.post = {}; for (const c of blocksNamed(masked, text, po.start, po.end, /^\s*(always|success|failure|unstable|changed|fixed|cleanup)\b[^\n{]*$/)) st.post[c.name] = parseSteps(text, masked, strs, c.start, c.end); }
            const tmo = /timeout\s*\(\s*time\s*:\s*(\d+)/.exec(text.slice(b.start, b.end)); if (tmo) st.timeout = tmo[1];
            return st;
        };
        if (pl) { const sb = blockNamedFirst(masked, text, from, to, 'stages'); if (sb) res.stages = blocksNamed(masked, text, sb.start, sb.end, stageRe).map(walkStage); }
        else res.stages = blocksNamed(masked, text, 0, text.length, stageRe).length ? blocksNamed(masked, text, 0, text.length, stageRe).map(walkStage) : (function () { const nb = blocksNamed(masked, text, 0, text.length, /^\s*(node)\b.*$/)[0]; return nb ? blocksNamed(masked, text, nb.start, nb.end, stageRe).map(walkStage) : []; })();
        return res;
    }

    function stepFromGha(s, i) {
        const o = { name: s.name || undefined };
        if (s.uses) { o.type = 'uses'; o.uses = String(s.uses); o.with = s.with || undefined; }
        else if (s.run != null) { o.type = 'sh'; o.cmd = String(s.run).replace(/\n$/, ''); o.shell = s.shell; o.dynamic = /\$\{\{/.test(String(s.run)); o['working-directory'] = s['working-directory']; }
        else o.type = 'other';
        if (s.if) o.if = String(s.if); if (s.env) o.env = s.env; if (s['continue-on-error']) o.continueOnError = true; if (s['timeout-minutes']) o.timeout = s['timeout-minutes'];
        o.index = i + 1; return o;
    }
    function parseGithub(yamlLoad, raw) {
        const y = yamlLoad(String(raw || '')) || {}; const on = y.on != null ? y.on : y[true];
        const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
        const jobs = y.jobs && typeof y.jobs === 'object' ? y.jobs : {};
        return {
            kind: 'github', name: y.name, triggers, trigger_detail: on && typeof on === 'object' && !Array.isArray(on) ? on : undefined, env: y.env || {}, permissions: y.permissions, concurrency: y.concurrency, defaults: y.defaults,
            stages: Object.entries(jobs).map(([id, j]) => ({ id, name: j.name || id, runsOn: j['runs-on'], needs: arr(j.needs), if: j.if, timeout: j['timeout-minutes'], permissions: j.permissions, matrix: j.strategy && j.strategy.matrix, failFast: j.strategy ? j.strategy['fail-fast'] : undefined, container: typeof j.container === 'string' ? j.container : (j.container && j.container.image), services: j.services && Object.keys(j.services), environment: j.environment, env: j.env, continueOnError: !!j['continue-on-error'], steps: arr(j.steps).map(stepFromGha), uses: j.uses })),
        };
    }
    function parseGitlab(yamlLoad, raw) {
        const y = yamlLoad(String(raw || '')) || {}; const RESERVED = new Set(['stages', 'variables', 'default', 'include', 'workflow', 'image', 'services', 'before_script', 'after_script', 'cache', 'pages']);
        const stages = arr(y.stages).length ? arr(y.stages) : ['build', 'test', 'deploy']; const jobs = [];
        for (const [id, j] of Object.entries(y)) {
            if (RESERVED.has(id) || id.startsWith('.') || !j || typeof j !== 'object') continue;
            const cmds = [].concat(arr(j.before_script || (y.default && y.default.before_script) || y.before_script), arr(j.script), arr(j.after_script));
            jobs.push({ id, name: id, stage: j.stage || 'test', image: typeof j.image === 'string' ? j.image : (j.image && j.image.name) || (typeof y.image === 'string' ? y.image : undefined), needs: arr(j.needs).map((n) => (typeof n === 'string' ? n : n.job)), rules: j.rules, only: j.only, except: j.except, when: j.when, allowFailure: j.allow_failure, timeout: j.timeout, retry: j.retry, extends: j.extends, trigger: j.trigger, artifacts: j.artifacts && (j.artifacts.paths || true), steps: cmds.filter((c) => typeof c === 'string').map((c, i) => ({ type: 'sh', cmd: c, index: i + 1, dynamic: /\$[A-Za-z_{]/.test(c) })), variables: j.variables });
        }
        const order = (s) => { const i = stages.indexOf(s); return i < 0 ? 99 : i; };
        return { kind: 'gitlab', stage_order: stages, variables: y.variables || {}, workflow: y.workflow, include: y.include, stages: jobs.sort((a, b) => order(a.stage) - order(b.stage)) };
    }
    function parse(kind, text, opts) {
        opts = opts || {}; kind = kind || detect(opts.path, text);
        if (kind === 'jenkins') return parseJenkins(text);
        if (!opts.yamlLoad) throw new Error('解析 ' + kind + ' 需要 YAML 解析器（yamlLoad）');
        if (kind === 'github') return parseGithub(opts.yamlLoad, text);
        if (kind === 'gitlab') return parseGitlab(opts.yamlLoad, text);
        throw new Error('不認得的 pipeline 類型：' + kind + '（支援 jenkins／github／gitlab）');
    }

    // ---------- 統計 ----------
    function flatten(p) { const out = []; const rec = (s, path) => { out.push({ s, path: path.concat(s.name) }); (s.children || []).forEach((c) => rec(c, path.concat(s.name))); }; p.stages.forEach((s) => rec(s, [])); return out; }
    function summarize(p) {
        const st = flatten(p); const stepsOf = (s) => s.steps || [];
        const allSteps = [].concat(...st.map((x) => stepsOf(x.s)));
        const shells = allSteps.filter((x) => x.type === 'sh' || x.type === 'bat' || x.type === 'powershell');
        const text = shells.map((x) => x.cmd || '').join('\n');
        return {
            kind: p.kind, stage_count: st.length, stages: st.map((x) => x.path.join(' › ')), has: { build: /\b(make|cmake|gradle|mvn|npm run build|cargo build|go build|tsc|msbuild|ninja|bazel|setup\.py|pip install|npm ci|npm install|yarn)\b/i.test(text) || p.stages.some((s) => /build|compile/i.test(s.name || s.id || '')), test: /\b(pytest|unittest|jest|mocha|vitest|go test|cargo test|ctest|mvn test|gradle test|npm test|npm run test|make check|make test|rspec|phpunit|dotnet test)\b/i.test(text) || p.stages.some((s) => /test/i.test(s.name || s.id || '')), lint: /\b(eslint|flake8|ruff|pylint|golangci-lint|clippy|checkstyle|prettier|black|mypy|shellcheck|cppcheck|clang-tidy)\b/i.test(text) || p.stages.some((s) => /lint|static/i.test(s.name || s.id || '')), deploy: /\b(deploy|kubectl|helm|terraform|ansible|docker push|scp|rsync|aws s3|gcloud)\b/i.test(text) || p.stages.some((s) => /deploy|release|publish/i.test(s.name || s.id || '')), report: allSteps.some((x) => x.type === 'report') || /junit|upload-artifact|artifacts/i.test(JSON.stringify(p).slice(0, 20000)) },
            shell_steps: shells.length,
        };
    }

    // ---------- lint ----------
    const SECRET_RES = [/(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*['"]?[A-Za-z0-9/+_=.-]{12,}/i, /AKIA[0-9A-Z]{16}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/];
    function lint(p, raw) {
        const out = []; const add = (id, severity, where, message, fix) => out.push({ id, severity, where, message, fix });
        const raws = String(raw || ''); const st = flatten(p);
        const shells = [].concat(...st.map((x) => (x.s.steps || []).filter((s) => ['sh', 'bat', 'powershell'].includes(s.type)).map((s) => ({ where: x.path.join(' › '), cmd: s.cmd || '', dynamic: s.dynamic, s }))));
        for (const s of shells) {
            if (/\bcurl\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b|\bwget\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/.test(s.cmd)) add('curl-pipe-sh', 'high', s.where, '把網路上的腳本直接 pipe 給 shell 執行（curl … | sh）：來源被竄改就直接在 CI 上執行任意程式。', '先下載、驗證 checksum／簽章，再執行；或用固定版本的 package。');
            if (/\bchmod\s+(?:-R\s+)?777\b/.test(s.cmd)) add('chmod-777', 'warn', s.where, 'chmod 777 讓所有人可讀寫執行。', '只給需要的權限（例如 755／644）。');
            if (/\|\|\s*true\b/.test(s.cmd)) add('swallow-failure', 'warn', s.where, '「|| true」會吞掉失敗，之後的步驟會在壞掉的狀態下繼續。', '真的可以失敗的步驟才用，並寫清楚理由；測試、建置不要用。');
            if (/\bsudo\b/.test(s.cmd)) add('sudo', 'info', s.where, '用到 sudo：CI agent 通常不一定有、或會改到共用機器。', '用容器（docker／container）隔離環境，或確認 agent 的權限政策。');
            if (/\brm\s+-rf\s+(?:\/|\$HOME|~|\$\{?WORKSPACE\}?\/?\s*$)/.test(s.cmd)) add('rm-rf-dangerous', 'high', s.where, 'rm -rf 的目標看起來是根目錄、家目錄或整個 workspace。', '只刪明確的子資料夾，變數要加防呆（${VAR:?}）。');
            if (/\b(?:echo|printf|cat)\b[^\n]*\$\{?[A-Z_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z_]*\}?/.test(s.cmd)) add('echo-secret', 'high', s.where, '把可能是機密的變數印到記錄裡。', '不要印；Jenkins 用 withCredentials 並確認遮蔽、GitHub 用 secrets（會自動遮蔽但輸出變形後仍會洩漏）。');
            if (/\bset\s+\+e\b/.test(s.cmd)) add('set-plus-e', 'info', s.where, 'set +e 關掉了「出錯就停」。', '確認之後有檢查結束碼。');
            for (const re of SECRET_RES) if (re.test(s.cmd)) { add('hardcoded-secret', 'high', s.where, '指令裡看起來有寫死的密碼／token／金鑰。', '改用 CI 的憑證機制（Jenkins credentials、GitHub secrets、GitLab CI variables masked），並立刻換掉已經外洩的值。'); break; }
        }
        for (const re of SECRET_RES) if (re.test(raws)) { if (!out.some((o) => o.id === 'hardcoded-secret')) add('hardcoded-secret', 'high', '(檔案)', 'pipeline 檔案裡看起來有寫死的密碼／token／金鑰。', '改用 CI 的憑證機制並換掉外洩的值。'); break; }
        const sum = summarize(p);
        if (!sum.has.test && p.stages.length) add('no-tests', 'warn', '(整體)', '這個 pipeline 沒有看到跑測試的階段或指令。', '加一個 test 階段（先看專案用什麼：pytest／npm test／go test／ctest…）。');
        if (!p.stages.length) add('no-stages', 'high', '(整體)', '解析不到任何階段（stage／job）。', '檢查語法，或這是 scripted pipeline 但沒有 stage()。');
        if (p.kind === 'jenkins') {
            if (!p.agent && p.style === 'declarative') add('no-agent', 'high', '(整體)', '宣告式 pipeline 沒有 agent（沒有它不能執行）。', "加上 agent any 或指定 label／docker。");
            if (p.agent === 'any') add('agent-any', 'info', '(整體)', "agent any：任何節點都可能執行，環境不固定。", '用 label 或 docker 固定環境，結果才可重現。');
            if (p.style === 'declarative' && !p.options.timeout && !st.filter((x) => (x.s.steps || []).length).every((x) => x.s.timeout)) add('no-timeout', 'warn', '(整體)', '沒有設定 timeout：卡住的 build 會一直占著節點。', "options { timeout(time: 30, unit: 'MINUTES') }");
            if (p.style === 'declarative' && !p.options.buildDiscarder) add('no-build-discarder', 'info', '(整體)', '沒有 buildDiscarder：舊的 build 記錄與產物會一直累積。', "options { buildDiscarder(logRotator(numToKeepStr: '30')) }");
            if (p.style === 'declarative' && !Object.keys(p.post || {}).length && !st.some((x) => x.s.post)) add('no-post', 'info', '(整體)', '沒有 post 區塊：失敗時沒有通知、也不會保存測試報告。', 'post { always { junit "**/test-results/*.xml" } failure { … 通知 … } }');
            if (sum.has.test && !sum.has.report) add('no-test-report', 'info', '(整體)', '有跑測試但沒有發佈測試報告（junit／archiveArtifacts），Jenkins 看不到失敗的測試是哪幾個。', "post { always { junit '**/build/test-results/**/*.xml' } }");
            for (const x of st) if (x.s.parallel && x.s.failFast === undefined) add('parallel-no-failfast', 'info', x.path.join(' › '), 'parallel 沒有設 failFast：某個分支失敗後其他分支還會繼續跑完。', 'parallel { failFast true … }');
            for (const x of st) if ((x.s.steps || []).some((s) => s.type === 'input') && !(x.s.steps || []).some((s) => s.type === 'wrapper' && s.name === 'timeout')) add('input-no-timeout', 'warn', x.path.join(' › '), 'input 沒有包在 timeout 裡：沒人按會永遠等下去。', "timeout(time: 1, unit: 'HOURS') { input … }");
            if (!st.some((x) => (x.s.steps || []).some((s) => s.type === 'checkout')) && p.style === 'declarative' && !/checkout scm|git url/.test(raws)) add('no-checkout', 'info', '(整體)', '沒有明確的 checkout（宣告式 pipeline 預設會 checkout scm，若有 skipDefaultCheckout 就要自己做）。', null);
        }
        if (p.kind === 'github') {
            if (!p.permissions) add('no-permissions', 'warn', '(整體)', '沒有設定 permissions：GITHUB_TOKEN 會用預設權限（可能是讀寫）。', '在最上層設 permissions: { contents: read }，需要寫入的 job 再單獨開。');
            if (!p.concurrency) add('no-concurrency', 'info', '(整體)', '沒有 concurrency：同一個分支連續 push 會同時跑多份。', 'concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }');
            if (p.triggers.includes('pull_request_target')) { const checksHead = st.some((x) => (x.s.steps || []).some((s) => s.type === 'uses' && /^actions\/checkout/.test(s.uses) && s.with && /head|pull_request/.test(JSON.stringify(s.with)))); add('pull-request-target', checksHead ? 'high' : 'warn', '(觸發條件)', 'pull_request_target 在「目標 repo 的權限」下執行' + (checksHead ? '，而且 checkout 了 PR 的程式碼——外部人員的 PR 就能執行任意程式並拿到 secrets。' : '；不要 checkout 或執行 PR 的程式碼。'), '改用 pull_request；真的需要時只做不執行 PR 程式碼的事（貼標籤、留言）。'); }
            for (const x of st) {
                if (!x.s.timeout) add('no-timeout', 'warn', x.s.id, 'job 沒有 timeout-minutes（預設 360 分鐘）。', 'timeout-minutes: 30');
                if (x.s.continueOnError) add('continue-on-error', 'warn', x.s.id, 'continue-on-error: true：這個 job 失敗不會讓整體失敗。', '確認真的可以失敗。');
                for (const s of x.s.steps || []) {
                    if (s.continueOnError) add('continue-on-error', 'warn', x.s.id + ' › ' + (s.name || s.uses || 'run'), 'step 設了 continue-on-error: true：這一步失敗不會讓 job 失敗。', '確認真的可以失敗。');
                    if (s.type === 'uses' && /^[^./][^@]*@(?:main|master|latest|develop)$/.test(s.uses)) add('unpinned-action', 'warn', x.s.id + ' › ' + s.uses, '第三方 action 指到會變動的分支（' + s.uses + '），上游被入侵或改版會直接影響你的 CI。', '釘到版本標籤，最好是完整 commit SHA。');
                    else if (s.type === 'uses' && /^[^./][^@]*$/.test(s.uses) && !/^docker:/.test(s.uses)) add('unpinned-action', 'warn', x.s.id + ' › ' + s.uses, 'uses 沒有版本（@…）。', '加上 @v4 之類的版本。');
                    if (s.type === 'sh' && /\$\{\{\s*(?:github\.event\.(?:issue|pull_request|comment|review|head_commit|commits|pages|workflow_run)[\w.\[\]*]*|github\.head_ref|inputs\.[\w-]+)\s*\}\}/.test(s.cmd || '')) add('script-injection', 'high', x.s.id + ' › ' + (s.name || 'run'), '在 run: 裡直接插入 ${{ github.event… }}／github.head_ref／inputs：標題、分支名稱等可以被外人控制，會變成 shell 注入。', '先放進 env:（env: TITLE: ${{ github.event.pull_request.title }}），run 裡用 "$TITLE"。');
                }
            }
            const ids = new Set(p.stages.map((s) => s.id)); for (const s of p.stages) for (const n of s.needs) if (!ids.has(n)) add('needs-missing', 'high', s.id, 'needs 指到不存在的 job：' + n, '修正名稱。');
        }
        if (p.kind === 'gitlab') {
            const known = new Set(p.stage_order); for (const j of p.stages) if (!known.has(j.stage)) add('unknown-stage', 'high', j.id, 'job 的 stage「' + j.stage + '」沒有出現在 stages 清單裡。', '把它加進 stages，或改 job 的 stage。');
            for (const j of p.stages) {
                if (!j.steps.length && !j.trigger && !j.extends) add('no-script', 'high', j.id, 'job 沒有 script。', '加上 script:。');
                if (j.only || j.except) add('only-except', 'info', j.id, 'only／except 已不建議使用。', '改用 rules:。');
                if (j.allowFailure === true) add('allow-failure', 'warn', j.id, 'allow_failure: true：失敗不會擋住 pipeline。', '確認真的可以失敗。');
                if (!j.timeout) add('no-timeout', 'info', j.id, '沒有 timeout（用 runner／專案預設）。', 'timeout: 30 minutes');
            }
            const vars = Object.entries(p.variables || {}).filter(([k, v]) => /pass|secret|token|key/i.test(k) && typeof v === 'string' && v.length > 6 && !/^\$/.test(v)); vars.forEach(([k]) => add('hardcoded-secret', 'high', 'variables.' + k, '變數 ' + k + ' 看起來是寫死的機密。', '改在 CI/CD Settings 設成 masked／protected variable。'));
        }
        const rank = { high: 0, warn: 1, info: 2 }; return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
    }

    // ---------- 本機重現 ----------
    const ACTION_HINT = [
        [/^actions\/checkout@/, '（略過：本機已經有程式碼）'], [/^actions\/setup-node@/, (w) => '需要 Node.js ' + ((w && (w['node-version'] || w['node-version-file'])) || '（版本見 package.json engines／.nvmrc）')],
        [/^actions\/setup-python@/, (w) => '需要 Python ' + ((w && w['python-version']) || '3.x')], [/^actions\/setup-go@/, (w) => '需要 Go ' + ((w && (w['go-version'] || w['go-version-file'])) || '見 go.mod')],
        [/^actions\/setup-java@/, (w) => '需要 JDK ' + ((w && w['java-version']) || '17') + (w && w.distribution ? '（' + w.distribution + '）' : '')], [/^actions\/cache@/, '（略過：快取）'], [/^actions\/(upload|download)-artifact@/, '（略過：產物上傳／下載）'],
        [/^(docker\/|codecov\/|coverallsapp\/)/, '（略過：需要特定服務）'], [/^dtolnay\/rust-toolchain|^actions-rs\/toolchain/, '需要 Rust toolchain（rustup）'],
    ];
    function localCommands(p) {
        const out = [];
        const emit = (name, steps, extra) => {
            const cmds = []; const notes = []; if (extra && extra.note) notes.push(extra.note);
            for (const s of steps || []) {
                if (s.type === 'sh' && s.cmd) { if (s.dynamic) notes.push('「' + clip(s.cmd.split('\n')[0], 60) + '」含有變數／${{ }} 運算式，本機要換成實際值'); cmds.push({ cmd: s.cmd, cwd: s['working-directory'] || undefined, env: s.env || undefined, from: s.name || undefined, if: s.if || undefined }); }
                else if (s.type === 'uses') { for (const [re, h] of ACTION_HINT) if (re.test(s.uses)) { const t = typeof h === 'function' ? h(s.with) : h; if (t && !t.startsWith('（略過')) notes.push(t); break; } if (!ACTION_HINT.some(([re]) => re.test(s.uses))) notes.push('用了 action ' + s.uses + '，沒有直接的本機對應，看它做什麼再手動處理'); }
                else if (s.type === 'bat' || s.type === 'powershell') notes.push('Windows 專用步驟（' + s.type + '）：' + clip((s.cmd || '').split('\n')[0], 80));
                else if (s.type === 'wrapper' && s.name === 'withCredentials') notes.push('用到 Jenkins 憑證：本機要自己提供對應的環境變數');
            }
            if (cmds.length || notes.length) out.push({ stage: name, commands: cmds, notes, env: extra && extra.env || undefined, image: extra && extra.image || undefined });
        };
        const rec = (s, path) => { const nm = path.concat(s.name || s.id).join(' › '); emit(nm, s.steps, { env: s.env, image: s.image || s.container, note: s.if ? '條件：' + s.if : undefined }); (s.children || []).forEach((c) => rec(c, path.concat(s.name || s.id))); };
        p.stages.forEach((s) => rec(s, []));
        return { global_env: p.env && Object.keys(p.env).length ? p.env : undefined, stages: out, tip: '照順序在「暫存工作區」用 run_command 一條一條跑；某一條失敗就是 CI 失敗的那一步，先在本機修好再上 patch。' };
    }

    // ---------- 樣板 ----------
    function detectToolchain(files) {
        const has = (re) => Object.keys(files || {}).some((p) => re.test(p)); const get = (re) => { const k = Object.keys(files || {}).find((p) => re.test(p)); return k ? String(files[k]) : ''; };
        const tc = { lang: null, setup: null, install: [], build: [], test: [], lint: [], artifacts: [], notes: [] };
        if (has(/(^|\/)package\.json$/)) {
            let pj = {}; try { pj = JSON.parse(get(/(^|\/)package\.json$/)); } catch (_) { tc.notes.push('package.json 不是合法 JSON'); }
            const sc = pj.scripts || {}; const lock = has(/yarn\.lock$/) ? 'yarn' : has(/pnpm-lock\.yaml$/) ? 'pnpm' : 'npm';
            tc.lang = 'node'; tc.setup = { node: (pj.engines && pj.engines.node && (/(\d+)/.exec(pj.engines.node) || [])[1]) || '20' };
            tc.install = [lock === 'npm' ? (has(/package-lock\.json$/) ? 'npm ci' : 'npm install') : lock === 'yarn' ? 'yarn install --frozen-lockfile' : 'pnpm install --frozen-lockfile'];
            const run = (n) => (lock === 'npm' ? 'npm run ' + n : lock + ' ' + n);
            if (sc.lint) tc.lint.push(run('lint')); if (sc.build) tc.build.push(run('build')); if (sc.test) tc.test.push(lock === 'npm' ? 'npm test' : lock + ' test'); else tc.notes.push('package.json 沒有 scripts.test');
        } else if (has(/(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|pytest\.ini|tox\.ini)$/)) {
            tc.lang = 'python'; tc.setup = { python: '3.11' };
            const pyproj = get(/pyproject\.toml$/); tc.install = has(/requirements\.txt$/) ? ['pip install -r requirements.txt'] : (pyproj || has(/setup\.py$/)) ? ['pip install -e .'] : [];
            if (/\[tool\.ruff|ruff/.test(pyproj) || has(/ruff\.toml$/)) tc.lint.push('ruff check .'); else if (has(/\.flake8$|setup\.cfg$|tox\.ini$/) && /flake8/.test(get(/(\.flake8|setup\.cfg|tox\.ini)$/))) tc.lint.push('flake8');
            if (/pytest/.test(pyproj + get(/requirements[^/]*\.txt$/) + get(/(pytest\.ini|tox\.ini)$/)) || has(/(^|\/)tests?\/.*test_.*\.py$|(^|\/)test_.*\.py$/)) { tc.test.push('python -m pytest -q'); if (!/pytest/.test(pyproj + get(/requirements[^/]*\.txt$/))) tc.install.push('pip install pytest'); } else tc.test.push('python -m unittest discover');
        } else if (has(/(^|\/)go\.mod$/)) { tc.lang = 'go'; tc.setup = { go: (/^go\s+(\d+\.\d+)/m.exec(get(/go\.mod$/)) || [])[1] || '1.22' }; tc.build = ['go build ./...']; tc.test = ['go test ./...']; tc.lint = ['go vet ./...']; }
        else if (has(/(^|\/)Cargo\.toml$/)) { tc.lang = 'rust'; tc.setup = { rust: 'stable' }; tc.build = ['cargo build --locked']; tc.test = ['cargo test --locked']; tc.lint = ['cargo clippy -- -D warnings']; }
        else if (has(/(^|\/)pom\.xml$/)) { tc.lang = 'java-maven'; tc.setup = { java: '17' }; tc.build = ['mvn -B -DskipTests package']; tc.test = ['mvn -B test']; tc.artifacts = ['target/*.jar']; }
        else if (has(/(^|\/)(build\.gradle|build\.gradle\.kts)$/)) { tc.lang = 'java-gradle'; tc.setup = { java: '17' }; const g = has(/(^|\/)gradlew$/) ? './gradlew' : 'gradle'; tc.build = [g + ' build -x test']; tc.test = [g + ' test']; tc.artifacts = ['build/libs/*.jar']; }
        else if (has(/(^|\/)CMakeLists\.txt$/)) { tc.lang = 'cpp-cmake'; tc.build = ['cmake -S . -B build -DCMAKE_BUILD_TYPE=Release', 'cmake --build build -j']; tc.test = /enable_testing|add_test/.test(get(/CMakeLists\.txt$/)) ? ['ctest --test-dir build --output-on-failure'] : []; if (!tc.test.length) tc.notes.push('CMakeLists.txt 沒有 enable_testing／add_test'); }
        else if (has(/(^|\/)Makefile$/)) { const mk = get(/Makefile$/); tc.lang = 'make'; tc.build = ['make']; if (/^test\s*:/m.test(mk)) tc.test = ['make test']; else if (/^check\s*:/m.test(mk)) tc.test = ['make check']; else tc.notes.push('Makefile 沒有 test／check 目標'); }
        return tc;
    }

    const SETUP_GHA = { node: (v) => '      - uses: actions/setup-node@v4\n        with:\n          node-version: ' + v + '\n          cache: npm\n', python: (v) => '      - uses: actions/setup-python@v5\n        with:\n          python-version: "' + v + '"\n          cache: pip\n', go: (v) => '      - uses: actions/setup-go@v5\n        with:\n          go-version: "' + v + '"\n', java: (v) => '      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: ' + v + '\n', rust: () => '      - uses: dtolnay/rust-toolchain@stable\n' };
    function scaffold(kind, tc, o) {
        o = o || {}; const branch = o.branch || 'main'; const cmds = (name, list) => (list || []).map((c) => ({ name, c }));
        const steps = [].concat(cmds('Install', tc.install), cmds('Lint', tc.lint), cmds('Build', tc.build), cmds('Test', tc.test));
        if (!steps.length) throw new Error('偵測不到建置或測試指令，沒辦法產生有意義的 pipeline（先確認專案的工具鏈）');
        if (kind === 'github') {
            let y = 'name: CI\n\non:\n  push:\n    branches: [' + branch + ']\n  pull_request:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n  build-test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    steps:\n      - uses: actions/checkout@v4\n';
            for (const [k, v] of Object.entries(tc.setup || {})) if (SETUP_GHA[k]) y += SETUP_GHA[k](v);
            for (const s of steps) y += '      - name: ' + s.name + '\n        run: ' + (s.c.includes('\n') ? '|\n          ' + s.c.split('\n').join('\n          ') : s.c) + '\n';
            if (tc.artifacts && tc.artifacts.length) y += '      - uses: actions/upload-artifact@v4\n        if: always()\n        with:\n          name: artifacts\n          path: ' + tc.artifacts.join('\n            ') + '\n';
            return y;
        }
        if (kind === 'gitlab') {
            const img = { node: 'node:' + ((tc.setup || {}).node || '20'), python: 'python:' + ((tc.setup || {}).python || '3.11'), go: 'golang:' + ((tc.setup || {}).go || '1.22'), rust: 'rust:latest', 'java-maven': 'maven:3-eclipse-temurin-17', 'java-gradle': 'gradle:8-jdk17', 'cpp-cmake': 'gcc:13', make: 'gcc:13' }[tc.lang] || 'alpine:3.20';
            let y = 'stages: [build, test]\n\ndefault:\n  image: ' + img + '\n  timeout: 30 minutes\n\n';
            if (tc.install.length || tc.build.length || tc.lint.length) y += 'build:\n  stage: build\n  script:\n' + [].concat(tc.install, tc.lint, tc.build).map((c) => '    - ' + c).join('\n') + '\n' + (tc.artifacts.length ? '  artifacts:\n    paths: [' + tc.artifacts.join(', ') + ']\n' : '') + '\n';
            if (tc.test.length) y += 'test:\n  stage: test\n  script:\n' + [].concat(tc.install, tc.test).map((c) => '    - ' + c).join('\n') + '\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n    - if: $CI_COMMIT_BRANCH == "' + branch + '"\n';
            return y;
        }
        if (kind === 'jenkins') {
            const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const stage = (name, list) => (list && list.length ? "        stage('" + name + "') {\n            steps {\n" + list.map((c) => "                sh '" + q(c) + "'\n").join('') + '            }\n        }\n' : '');
            let j = "pipeline {\n    agent { label '" + (o.label || 'linux') + "' }\n    options {\n        timeout(time: 30, unit: 'MINUTES')\n        timestamps()\n        disableConcurrentBuilds()\n        buildDiscarder(logRotator(numToKeepStr: '30'))\n    }\n    stages {\n        stage('Checkout') {\n            steps { checkout scm }\n        }\n";
            j += stage('Install', tc.install) + stage('Lint', tc.lint) + stage('Build', tc.build) + stage('Test', tc.test);
            j += '    }\n    post {\n        always {\n' + (tc.test.length ? "            junit allowEmptyResults: true, testResults: '**/test-results/**/*.xml,**/surefire-reports/*.xml,**/build/test-results/**/*.xml'\n" : '') + (tc.artifacts.length ? "            archiveArtifacts artifacts: '" + tc.artifacts.join(',') + "', allowEmptyArchive: true\n" : '') + "        }\n        failure {\n            echo 'Build failed: ${env.BUILD_URL}'\n        }\n    }\n}\n";
            return j;
        }
        throw new Error('kind 必須是 jenkins／github／gitlab');
    }
    const PATHS = { jenkins: 'Jenkinsfile', github: '.github/workflows/ci.yml', gitlab: '.gitlab-ci.yml' };

    return { detect, parse, summarize, lint, localCommands, detectToolchain, scaffold, PATHS, scanCode };
});
