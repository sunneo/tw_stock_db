// tw_stock_db客製: 2026-09-25使用者要求的「build essential」（tcc/gcc、make、
// m4、autoconf）之一。查證過沒有任何可靠的瀏覽器WASM移植版GNU make（不存在），
// 跟vi/less/top同一種做法：JS重寫一份簡化版，透過registerTerminalProgram()
// 掛在`make`這個指令名稱上（見floating-assistant.js的TERMINAL_PROGRAM_BUNDLES）。
//
// **支援的子集**：變數指派（=/:=/?=/+=）與`$(VAR)`/`${VAR}`展開、規則
// （target: prereqs + tab縮排的recipe）、.PHONY、基本pattern rule（單一`%`，
// 例如`%.o: %.c`）、自動變數($@/$</$^/$*)、行尾`\`接續、`#`註解、recipe行
// 開頭`@`靜音（不回顯指令本身）、由指定target（或第一個非特殊target）開始
// 遞迴建構依賴。recipe的每一行透過ctx.runShell()真的丟進WASM busybox ash
// 執行（跟terminal_run AI工具共用同一個執行路徑，輸出會即時顯示在畫面上）。
//
// **明確不支援**（GNU make的完整功能集很大，這裡只做到「常見專案的
// Makefile能動」）：條件式（ifeq/ifdef/else/endif）、`include`、函式呼叫
// （$(wildcard ...)/$(shell ...)/$(foreach ...)等）、多重pattern（`%`只能
// 出現一次）、平行建構（-j）、-k（遇錯繼續）、真正的mtime比對——這個沙盒
// 檔案系統本身就沒有時間戳（wasi-sh README:「No symlinks, permissions, or
// timestamps」，見floating-assistant.js對應的說明），所以「要不要重建」
// 用簡化規則判斷：目標檔案不存在、或這個target是.PHONY、或任一直接依賴
// 這次執行過程中真的被重建過，才會執行recipe，不是完整的GNU make語意。
//
// ctx契約見pager.mjs開頭的說明；額外使用ctx.runShell(line)（見
// floating-assistant.js的_runTerminalProgramBundle新增的說明）執行recipe
// 指令。

function resolvePath(cwd, target) {
    const raw = target.startsWith('/') ? target : `${cwd}/${target}`;
    const parts = raw.split('/').filter((x) => x && x !== '.');
    const stack = [];
    for (const part of parts) { if (part === '..') stack.pop(); else stack.push(part); }
    return '/' + stack.join('/');
}

function readFileTextOrNull(fs, absPath) {
    try {
        const stat = fs.statSync(absPath);
        if ((stat.mode & 0o170000) === 0o040000) return null; // 是目錄
        const buf = new Uint8Array(stat.size);
        fs.readSync(absPath, buf, 0, stat.size);
        return new TextDecoder('utf-8').decode(buf);
    } catch (_) { return null; }
}

function fileExists(fs, absPath) {
    try {
        const stat = fs.statSync(absPath);
        return (stat.mode & 0o170000) !== 0o040000;
    } catch (_) { return false; }
}

// ---- Makefile解析 ----
function parseMakefile(text) {
    const joined = text.replace(/\\\r?\n/g, ' ');
    const rawLines = joined.split(/\r?\n/);
    const vars = new Map(); // name -> string（已經是最終值，指派當下就展開右手邊，符合`=`遞迴展開/`:=`立即展開這裡不細分的簡化行為）
    const rules = []; // {targets:[], prereqs:[], recipe:[lines], isPattern}
    const phony = new Set();
    let current = null;
    for (const rawLine of rawLines) {
        if (/^\t/.test(rawLine)) {
            if (current) current.recipe.push(rawLine.slice(1));
            continue;
        }
        const hashIdx = rawLine.indexOf('#');
        const line = hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine;
        const trimmed = line.trim();
        if (!trimmed) { current = null; continue; }
        const eqIdx = trimmed.search(/(:=|\?=|\+=|=)/);
        const colonIdx = trimmed.indexOf(':');
        const isAssignment = eqIdx !== -1 && (colonIdx === -1 || eqIdx <= colonIdx);
        if (isAssignment) {
            current = null;
            const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(:=|\?=|\+=|=)\s*(.*)$/);
            if (!m) continue;
            const [, name, op, rawValue] = m;
            const value = expandVars(rawValue, vars);
            if (op === '?=') { if (!vars.has(name)) vars.set(name, value); }
            else if (op === '+=') { vars.set(name, (vars.get(name) || '') + (vars.has(name) ? ' ' : '') + value); }
            else { vars.set(name, value); }
            continue;
        }
        const colon = trimmed.indexOf(':');
        if (colon === -1) { current = null; continue; }
        const targetsPart = trimmed.slice(0, colon).trim();
        const prereqsPart = trimmed.slice(colon + 1).trim();
        const targets = targetsPart.split(/\s+/).filter(Boolean);
        const prereqs = expandVars(prereqsPart, vars).split(/\s+/).filter(Boolean);
        if (targets.length === 1 && targets[0] === '.PHONY') {
            for (const p of prereqs) phony.add(p);
            current = null;
            continue;
        }
        const rule = { targets, prereqs, recipe: [] };
        rules.push(rule);
        current = rule;
    }
    return { vars, rules, phony };
}

function expandVars(text, vars) {
    let prev;
    let out = String(text || '');
    // 遞迴展開到不動點（讓$(A)裡面又引用$(B)這種情況也能正確展開），上限
    // 20層避免變數互相循環引用造成無窮迴圈。
    for (let depth = 0; depth < 20; depth++) {
        prev = out;
        out = out.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, a, b) => {
            const name = a || b;
            return vars.has(name) ? vars.get(name) : '';
        });
        if (out === prev) break;
    }
    return out;
}

// 單一`%`的pattern rule比對：pattern="%.o"、target="main.o" → stem="main"；
// 不match回傳null。
function matchPattern(pattern, target) {
    const starIdx = pattern.indexOf('%');
    if (starIdx === -1) return pattern === target ? '' : null;
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1);
    if (!target.startsWith(prefix) || !target.endsWith(suffix)) return null;
    if (target.length < prefix.length + suffix.length) return null;
    return target.slice(prefix.length, target.length - suffix.length);
}

function substStem(pattern, stem) {
    return stem == null ? pattern : pattern.replace('%', stem);
}

function findRuleForTarget(rules, target) {
    for (const r of rules) {
        if (r.targets.includes(target) && !r.targets.some((t) => t.includes('%'))) return { rule: r, stem: null };
    }
    for (const r of rules) {
        for (const t of r.targets) {
            if (t.includes('%')) {
                const stem = matchPattern(t, target);
                if (stem != null) return { rule: r, stem };
            }
        }
    }
    return null;
}

function expandAutoVars(line, target, prereqs, stem) {
    return line
        .replace(/\$@/g, target)
        .replace(/\$</g, prereqs[0] || '')
        .replace(/\$\^/g, prereqs.join(' '))
        .replace(/\$\*/g, stem || '');
}

export async function run(ctx) {
    const args = ctx.args || [];
    let makefileArg = null;
    const explicitTargets = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-f' && args[i + 1]) { makefileArg = args[++i]; }
        else if (!args[i].startsWith('-')) { explicitTargets.push(args[i]); }
    }

    const fs = await ctx.fs();
    const candidates = makefileArg ? [makefileArg] : ['Makefile', 'makefile'];
    let makefileAbs = null, makefileText = null;
    for (const c of candidates) {
        const abs = resolvePath(ctx.cwd, c);
        const text = readFileTextOrNull(fs, abs);
        if (text != null) { makefileAbs = abs; makefileText = text; break; }
    }
    if (makefileText == null) {
        ctx.write(`make: *** 找不到Makefile（試過：${candidates.join('、')}）。停止。\n`);
        return;
    }

    let parsed;
    try { parsed = parseMakefile(makefileText); }
    catch (err) { ctx.write(`make: 解析${makefileAbs}失敗：${String(err.message || err)}\n`); return; }
    const { vars, rules, phony } = parsed;

    const builtThisRun = new Set();
    const visiting = new Set();

    async function build(target) {
        if (builtThisRun.has(target) || visiting.has(target)) return true;
        visiting.add(target);
        const found = findRuleForTarget(rules, target);
        const rule = found ? found.rule : null;
        const stem = found ? found.stem : null;
        const prereqs = rule ? rule.prereqs.map((p) => substStem(p, stem)) : [];
        for (const p of prereqs) {
            const ok = await build(p);
            if (!ok) { visiting.delete(target); return false; }
        }
        visiting.delete(target);

        const targetAbs = resolvePath(ctx.cwd, target);
        const isPhony = phony.has(target);
        const targetExists = fileExists(fs, targetAbs);
        const anyPrereqRebuilt = prereqs.some((p) => builtThisRun.has(p));
        const needsRebuild = isPhony || !targetExists || anyPrereqRebuilt;

        if (!rule) {
            if (!targetExists && !isPhony) {
                ctx.write(`make: *** 沒有規則可以建立目標「${target}」也找不到這個檔案。停止。\n`);
                return false;
            }
            return true; // 既有的來源檔案（葉節點），沒有規則可執行，視為已經是最新
        }
        if (!needsRebuild) {
            ctx.write(`make: '${target}' is up to date.\n`);
            return true;
        }
        for (const recipeLineRaw of rule.recipe) {
            let cmd = expandAutoVars(recipeLineRaw, target, prereqs, stem);
            cmd = expandVars(cmd, vars);
            let silent = false, ignoreError = false;
            let trimmedCmd = cmd.replace(/^\s+/, '');
            while (trimmedCmd[0] === '@' || trimmedCmd[0] === '-') {
                if (trimmedCmd[0] === '@') silent = true; else ignoreError = true;
                trimmedCmd = trimmedCmd.slice(1);
            }
            if (!silent) ctx.write(trimmedCmd + '\n');
            let result;
            try { result = await ctx.runShell(trimmedCmd); }
            catch (err) { ctx.write(`make: *** [${target}] ${String(err.message || err)}\n`); return false; }
            if (!ignoreError && result && result.exit_code !== 0) {
                ctx.write(`make: *** [${target}] Error ${result.exit_code}\n`);
                return false;
            }
        }
        builtThisRun.add(target);
        return true;
    }

    const defaultTarget = rules.length ? rules[0].targets.find((t) => !t.includes('%')) : null;
    const targets = explicitTargets.length ? explicitTargets : (defaultTarget ? [defaultTarget] : []);
    if (!targets.length) {
        ctx.write('make: *** 沒有指定target、Makefile裡也找不到預設target。停止。\n');
        return;
    }
    for (const t of targets) {
        const ok = await build(t);
        if (!ok) return;
    }
}
