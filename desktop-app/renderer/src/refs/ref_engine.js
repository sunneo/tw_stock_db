
    // ============================================================
    // FaRef：參考知識查詢（錯誤碼、命令與手冊、qemu 命令列、pragma）＋使用者／AI 補的定義。
    // 資料來源：renderer/src/refs/*.dsl（scripts/refs-dsl.js 轉成 FA_REF_DATA）。
    // 這一份同時被三個地方用：(1) 離線訓練器的工具 lookup_error_code／explain_command_line／ref_lookup，
    // (2) 程式行為分析（FaBeh2 的 annotateText／explainPragma：錯誤碼常數、exit code、命令列字串、#pragma 會被標註），
    // (3) AI 補定義（ref_define）。純函式，不碰 DOM、不碰儲存；使用者定義由呼叫端保存後用 setUser 餵進來。
    // ============================================================
    const H = (n) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const SIGNAME = {};
    const FACILITY = { 0: 'NULL', 1: 'RPC', 2: 'DISPATCH（COM 派送）', 3: 'STORAGE（結構化儲存）', 4: 'ITF（介面特定）', 7: 'WIN32', 8: 'WINDOWS', 9: 'SECURITY／SSPI', 10: 'CONTROL', 11: 'CERT', 12: 'INTERNET', 13: 'MEDIASERVER', 16: 'SETUPAPI', 17: 'SCARD', 24: 'WINDOWSUPDATE', 28: 'SXS', 31: 'GRAPHICS／DXGI', 38: 'TPM', 39: 'D3D', 48: 'DIRECT3D11', 0x7FF: 'NT 狀態轉換' };
    const NT_SEV = ['成功（Success）', '資訊（Informational）', '警告（Warning）', '錯誤（Error）'];
    function create(data, user) {
        data = data || { errors: {}, commands: {}, pragmas: [], clauses: [] };
        const U = { errors: {}, commands: {}, options: {}, pragmas: [], clauses: [], generic: [], buildRules: [], types: {}, typed: [] }; const ktCache = new Map();
        const idx = { built: false, byName: new Map(), bySys: {}, cmdAlias: new Map(), errNameRe: null };
        function mergeUser(u) {
            U.errors = {}; U.commands = {}; U.options = {}; U.pragmas = []; U.clauses = []; U.generic = [];
            if (!u) return;
            for (const [s, l] of Object.entries(u.errors || {})) U.errors[s] = l.slice();
            Object.assign(U.commands, u.commands || {}); Object.assign(U.options, u.options || {});
            U.pragmas = (u.pragmas || []).slice(); U.clauses = (u.clauses || []).slice(); U.generic = (u.generic || []).slice(); U.buildRules = (u.buildRules || []).slice(); bRules = null;
            U.types = u.types && typeof u.types === 'object' && !Array.isArray(u.types) ? Object.assign({}, u.types) : {}; U.typed = Array.isArray(u.typed) ? u.typed.slice() : []; ktCache.clear();
        }
        const allGeneric = () => (data.generic || []).concat(U.generic);
        // ---------------- 可註冊的知識類型（見 DESIGN.knowledge-types.md）----------------
        // 條目 {kind, key, text, tags, src, customize, tv}；customize 的結構由 kind 對應的「已註冊類型」的 schema 規定。
        // 類型與條目分內建（data.types／data.typed）與使用者（U.types／U.typed），同 kind／同 key 使用者的覆蓋內建。
        // 驗證只看結構（型別、範圍、必填、引用的條目存在），不執行任何程式碼。
        const KT_NAME = /^[a-z][a-z0-9_]{1,40}$/;
        const KT_TYPES = ['string', 'number', 'integer', 'boolean', 'enum', 'range', 'list', 'object', 'map', 'color', 'ref', 'regex', 'any'];
        const specOf = (s) => (typeof s === 'string' ? { type: s } : (s && typeof s === 'object' ? s : { type: 'any' }));
        const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
        const deepMerge = (base, over) => {
            if (over === undefined) return clone(base); if (base === undefined) return clone(over);
            if (base && over && typeof base === 'object' && typeof over === 'object' && !Array.isArray(base) && !Array.isArray(over)) { const o = clone(base); for (const k of Object.keys(over)) o[k] = deepMerge(base[k], over[k]); return o; }
            return clone(over);
        };
        function typesAll() { const m = new Map(); for (const t of (data.types || [])) m.set(t.kind, Object.assign({ source: 'builtin' }, t)); for (const [k, t] of Object.entries(U.types || {})) m.set(k, Object.assign({}, t, { kind: k, source: 'user' })); return m; }
        function getType(kind) { return typesAll().get(String(kind || '')) || null; }
        function typedAll() { const m = new Map(); for (const e of (data.typed || [])) m.set(e.kind + '\u0000' + e.key, Object.assign({ source: 'builtin' }, e)); for (const e of (U.typed || [])) m.set(e.kind + '\u0000' + e.key, Object.assign({}, e, { source: 'user' })); return m; }
        function findTyped(kind, key) { return typedAll().get(String(kind) + '\u0000' + String(key)) || null; }
        function listTyped(kind) { return Array.from(typedAll().values()).filter((e) => !kind || e.kind === kind); }
        // 類型定義本身的檢查（註冊時用）
        function validateTypeDef(def) {
            const errs = [];
            if (!def || typeof def !== 'object') return { ok: false, errors: [{ path: '', msg: '類型定義要是物件' }] };
            if (!KT_NAME.test(String(def.kind || ''))) errs.push({ path: 'kind', msg: 'kind 要是小寫英文開頭、只含小寫英文／數字／底線（2～41 字），例如 visual_part' });
            if (!(Number.isInteger(def.version) && def.version >= 1)) errs.push({ path: 'version', msg: 'version 要是 1 以上的整數' });
            if (!def.schema || typeof def.schema !== 'object' || Array.isArray(def.schema)) errs.push({ path: 'schema', msg: 'schema 要是 {欄位名: 欄位規格} 的物件' });
            const chk = (spec, path, depth) => {
                spec = specOf(spec);
                if (depth > 6) { errs.push({ path, msg: 'schema 巢狀太深（最多 6 層）' }); return; }
                if (KT_TYPES.indexOf(spec.type) < 0) { errs.push({ path, msg: '不認得的型別 ' + spec.type + '（可用：' + KT_TYPES.join('、') + '）' }); return; }
                if (spec.type === 'enum' && !(Array.isArray(spec.values) && spec.values.length)) errs.push({ path, msg: 'enum 要給 values 清單' });
                if (spec.type === 'ref' && !KT_NAME.test(String(spec.kind || ''))) errs.push({ path, msg: 'ref 要給 kind（被引用的類型）' });
                if ((spec.type === 'list' || spec.type === 'map') && spec.of !== undefined) chk(spec.of, path + '.of', depth + 1);
                if (spec.type === 'object' && spec.fields) for (const [k, s] of Object.entries(spec.fields)) chk(s, path + '.' + k, depth + 1);
            };
            if (def.schema && typeof def.schema === 'object') for (const [k, s] of Object.entries(def.schema)) chk(s, 'schema.' + k, 0);
            return { ok: !errs.length, errors: errs };
        }
        // 值的檢查。ctx：{ refs: true（檢查引用存在）, errors, warnings }
        function checkValue(specIn, v, path, ctx) {
            const spec = specOf(specIn); const err = (m) => ctx.errors.push({ path, msg: m });
            if (v === undefined || v === null) { if (spec.required) err('必填'); return; }
            const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
            switch (spec.type) {
                case 'any': return;
                case 'string': if (typeof v !== 'string') return err('要是字串'); if (spec.pattern && !new RegExp(spec.pattern).test(v)) err('格式不符 ' + spec.pattern); return;
                case 'regex': if (typeof v !== 'string') return err('要是字串（正規表示式）'); try { new RegExp(v); } catch (e) { err('不是有效的正規表示式：' + String(e.message).slice(0, 60)); } return;
                case 'number': case 'integer': if (!isNum(v) || (spec.type === 'integer' && !Number.isInteger(v))) return err('要是' + (spec.type === 'integer' ? '整數' : '數字')); if (Array.isArray(spec.range) && (v < spec.range[0] || v > spec.range[1])) err('超出範圍 ' + spec.range[0] + '～' + spec.range[1]); return;
                case 'boolean': if (typeof v !== 'boolean') err('要是 true／false'); return;
                case 'enum': if (spec.values.indexOf(v) < 0) err('要是 ' + spec.values.join('／') + ' 其中之一'); return;
                case 'color': if (typeof v !== 'string' || !v) err('要是色彩名稱（字串）'); return;
                case 'range': if (!(Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[0] <= v[1])) return err('要是 [最小, 最大] 兩個數字且最小 ≤ 最大'); if (Array.isArray(spec.range) && (v[0] < spec.range[0] || v[1] > spec.range[1])) err('超出範圍 ' + spec.range[0] + '～' + spec.range[1]); return;
                case 'list': {
                    if (!Array.isArray(v)) return err('要是清單');
                    if (Number.isInteger(spec.length) && v.length !== spec.length) err('長度要是 ' + spec.length);
                    if (Number.isInteger(spec.min) && v.length < spec.min) err('至少 ' + spec.min + ' 個');
                    if (Number.isInteger(spec.max) && v.length > spec.max) err('最多 ' + spec.max + ' 個');
                    if (spec.of !== undefined) v.forEach((x, i) => checkValue(spec.of, x, path + '[' + i + ']', ctx)); return;
                }
                case 'map': if (typeof v !== 'object' || Array.isArray(v)) return err('要是物件（名稱→值）'); if (spec.of !== undefined) for (const [k, x] of Object.entries(v)) checkValue(spec.of, x, path + '.' + k, ctx); return;
                case 'object': {
                    if (typeof v !== 'object' || Array.isArray(v)) return err('要是物件');
                    const fields = spec.fields || {};
                    for (const [k, s] of Object.entries(fields)) checkValue(s, v[k], path ? path + '.' + k : k, ctx);
                    for (const k of Object.keys(v)) if (!(k in fields) && spec.fields) ctx.warnings.push({ path: path ? path + '.' + k : k, msg: '不認得的欄位（原樣保留）' });
                    return;
                }
                case 'ref': {
                    const key = typeof v === 'string' ? v : (v && typeof v === 'object' ? v.ref : undefined);
                    if (typeof key !== 'string' || !key) return err('引用要是條目 key（字串），或 {ref, as?, set?}');
                    if (ctx.refs && !findTyped(spec.kind, key)) err('引用的條目不存在：' + spec.kind + ':' + key);
                    return;
                }
            }
        }
        function validateCustomize(kind, customize, opts) {
            const ty = getType(kind); const ctx = { refs: !(opts && opts.noRefs), errors: [], warnings: [] };
            if (!ty) return { ok: false, errors: [{ path: '', msg: '沒有註冊過這個類型：' + kind }], warnings: [] };
            if (customize === undefined || customize === null) return { ok: true, errors: [], warnings: [] };
            if (typeof customize !== 'object' || Array.isArray(customize)) return { ok: false, errors: [{ path: '', msg: 'customize 要是物件' }], warnings: [] };
            checkValue({ type: 'object', fields: ty.schema }, customize, '', ctx);
            return { ok: !ctx.errors.length, errors: ctx.errors, warnings: ctx.warnings };
        }
        function validateEntry(e, opts) {
            const errs = []; opts = opts || {};
            if (!e || typeof e !== 'object') return { ok: false, errors: [{ path: '', msg: '條目要是物件' }], warnings: [] };
            if (!String(e.key || '').trim()) errs.push({ path: 'key', msg: '要給 key' });
            if (!KT_NAME.test(String(e.kind || ''))) errs.push({ path: 'kind', msg: 'kind 格式不對' });
            if (opts.requireSource && String(e.src || '').trim().length < 3) errs.push({ path: 'src', msg: '要給來源（沒有來源的內容不收；使用者自己補的寫 user）' });
            if (!String(e.text || '').trim() && !opts.allowNoText) errs.push({ path: 'text', msg: '要給 text（給人讀、給檢索用的說明）' });
            const r = validateCustomize(e.kind, e.customize, opts);
            const ty = getType(e.kind);
            const warnings = r.warnings.slice();
            if (ty && Number.isInteger(e.tv) && e.tv !== ty.version) warnings.push({ path: 'tv', msg: '條目是依類型 v' + e.tv + ' 寫的，目前類型是 v' + ty.version });
            return { ok: !errs.length && r.ok, errors: errs.concat(r.errors), warnings };
        }
        // 遞迴展開：把 ref 換成被引用條目的 customize（帶 _ref 標記），extends 先合併父條目，ref 可帶 as／set 覆寫；深度上限與循環偵測
        function resolve(kind, key, opts) {
            opts = opts || {}; const maxDepth = Number.isInteger(opts.depth) ? opts.depth : 8; const errors = [];
            const memo = new Map();
            // 繼承在「原始條目」層級合併（父條目的 ref 還是字串），之後再一次展開——不能先展開父條目再合併，否則 ref 欄位已經變成物件，第二次展開會失效
            const rawOf = (k, key2, depth, stack, path) => {
                const id = k + ':' + key2;
                if (stack.indexOf(id) >= 0) { errors.push({ path, msg: '循環引用：' + stack.concat(id).join(' → ') }); return undefined; }
                if (depth > maxDepth) { errors.push({ path, msg: '展開太深（超過 ' + maxDepth + ' 層）：' + id }); return undefined; }
                const e = findTyped(k, key2); if (!e) { errors.push({ path, msg: '引用的條目不存在：' + id }); return undefined; }
                const ty = getType(k); const st = stack.concat(id); let c = clone(e.customize) || {};
                for (const [f, sp0] of Object.entries(ty ? ty.schema : {})) {
                    const sp = specOf(sp0);
                    if (sp.type === 'ref' && sp.extends && c[f] !== undefined) {
                        const parents = Array.isArray(c[f]) ? c[f] : [c[f]]; let base = {};
                        for (const pk of parents) { const pv = rawOf(sp.kind || k, typeof pk === 'string' ? pk : pk.ref, depth + 1, st, path + '/extends:' + pk); if (pv) base = deepMerge(base, pv); }
                        const own = clone(c); delete own[f]; c = deepMerge(base, own); c._extends = parents.slice();
                    }
                }
                return c;
            };
            const go = (k, key2, depth, stack, path) => {
                const id = k + ':' + key2;
                if (memo.has(id)) return clone(memo.get(id));
                const c = rawOf(k, key2, depth, stack, path); if (c === undefined) return undefined;
                const ty = getType(k); const st = stack.concat(id); const schema = ty ? ty.schema : {};
                const walk = (spIn, v, p) => {
                    const sp = specOf(spIn);
                    if (v === undefined || v === null) return v;
                    if (sp.type === 'ref' && !sp.extends) {
                        const rk = typeof v === 'string' ? v : v.ref; const as = typeof v === 'object' ? v.as : undefined; const set = typeof v === 'object' ? v.set : undefined;
                        let ev = go(sp.kind, rk, depth + 1, st, p); if (ev === undefined) return { _ref: { kind: sp.kind, key: rk, as, unresolved: true } };
                        if (set) ev = deepMerge(ev, set);
                        ev._ref = { kind: sp.kind, key: rk, as }; return ev;
                    }
                    if (sp.type === 'list' && Array.isArray(v) && sp.of !== undefined) return v.map((x, i) => walk(sp.of, x, p + '[' + i + ']'));
                    if (sp.type === 'map' && typeof v === 'object' && sp.of !== undefined) { const o = {}; for (const [kk, x] of Object.entries(v)) o[kk] = walk(sp.of, x, p + '.' + kk); return o; }
                    if (sp.type === 'object' && typeof v === 'object' && sp.fields) { const o = Object.assign({}, v); for (const [kk, s] of Object.entries(sp.fields)) if (o[kk] !== undefined) o[kk] = walk(s, o[kk], p + '.' + kk); return o; }
                    return v;
                };
                const out = {}; const fieldSpecs = schema;
                for (const kk of Object.keys(c)) out[kk] = fieldSpecs[kk] !== undefined ? walk(fieldSpecs[kk], c[kk], path ? path + '.' + kk : kk) : c[kk];
                memo.set(id, out);
                return clone(out);
            };
            const e0 = findTyped(kind, key);
            if (!e0) return { ok: false, errors: [{ path: '', msg: '找不到條目：' + kind + ':' + key }] };
            const value = go(kind, key, 0, [], '');
            return { ok: !errors.length, kind, key, text: e0.text, tags: e0.tags || [], value, errors };
        }
        // 全庫驗證：每個條目的結構、引用存在、有沒有循環、類型本身是否合法
        function validateAll() {
            const problems = []; let n = 0;
            for (const [k, ty] of typesAll()) { const r = validateTypeDef(ty); if (!r.ok) r.errors.forEach((e) => problems.push({ where: 'type:' + k, path: e.path, msg: e.msg })); }
            for (const e of typedAll().values()) {
                n++; const r = validateEntry(e, { allowNoText: false });
                r.errors.forEach((x) => problems.push({ where: e.kind + ':' + e.key, path: x.path, msg: x.msg }));
                if (r.ok) { const rr = resolve(e.kind, e.key); rr.errors.forEach((x) => problems.push({ where: e.kind + ':' + e.key, path: x.path, msg: x.msg })); }
            }
            return { ok: !problems.length, types: typesAll().size, entries: n, problems: problems.slice(0, 200) };
        }
        // ---------------- 建置錯誤診斷（make／CMake／BitBake／gcc／ld／ninja／meson／maven／gradle／npm／cargo／pip…）----------------
        let bRules = null;
        const dedupeGroups = (src) => { const seen = {}; return String(src).replace(/\(\?<([A-Za-z_]\w*)>/g, (all, n) => { seen[n] = (seen[n] || 0) + 1; return seen[n] === 1 ? all : '(?<' + n + '__' + seen[n] + '>'; }); };
        const grp = (m, k) => { const g = m.groups || {}; if (g[k] !== undefined) return g[k]; for (let i = 2; i < 8; i++) if (g[k + '__' + i] !== undefined) return g[k + '__' + i]; return undefined; };
        // 多行規則的區塊範圍：indent（接著的縮排行）、indent+1（再多收一行結尾，例如 Python 的例外那行）、lines N、until 正規表示式（含該行）、blank（到空白行前）
        const parseSpan = (s) => { s = String(s).trim(); let m = /^indent(?:\+(\d+))?(?:\s+(\d+))?(?:\s+or\s+(.+))?$/.exec(s); if (m) { let orRe = null; if (m[3]) { try { orRe = new RegExp(m[3], 'i'); } catch (_) { return null; } } return { kind: 'indent', extra: +(m[1] || 0), max: +(m[2] || 60), orRe }; } m = /^lines\s+(\d+)$/.exec(s); if (m) return { kind: 'lines', max: Math.min(+m[1], 200) }; m = /^until\s+(.+)$/.exec(s); if (m) { try { return { kind: 'until', re: new RegExp(m[1], 'i'), max: 80 }; } catch (_) { return null; } } if (/^blank$/.test(s)) return { kind: 'blank', max: 60 }; return null; };
        const takeBlock = (clean, i, sp) => {
            const out = [clean[i]]; let j = i + 1;
            if (sp.kind === 'lines') { while (j < clean.length && out.length < sp.max) out.push(clean[j++]); return out; }
            if (sp.kind === 'until') { while (j < clean.length && out.length < sp.max) { out.push(clean[j]); if (sp.re.test(clean[j])) break; j++; } return out; }
            if (sp.kind === 'blank') { while (j < clean.length && out.length < sp.max && clean[j].trim()) out.push(clean[j++]); return out; }
            while (j < clean.length && out.length < sp.max && (/^\s+\S/.test(clean[j]) || (sp.orRe && sp.orRe.test(clean[j])))) out.push(clean[j++]);
            for (let k = 0; k < sp.extra && j < clean.length && clean[j].trim(); k++) out.push(clean[j++]);
            return out;
        };
        const buildRules = () => {
            if (bRules) return bRules; const merged = []; const all = (data.buildRules || []).concat(U.buildRules || []);
            for (const r of all) { const i = merged.findIndex((x) => x.id === r.id); if (i >= 0) merged[i] = r; else merged.push(r); }
            bRules = merged.map((r) => { let re = null, st = null; try { re = new RegExp(dedupeGroups(r.re), r.span ? 'ims' : 'i'); if (r.span) st = new RegExp(r.start || '^', 'i'); } catch (_) { re = null; } return Object.assign({}, r, { _re: re, _st: st, _span: r.span ? parseSpan(r.span) : null }); }).filter((r) => r._re && (!r.span || r._span)); return bRules;
        };
        const SIGNS = [
            ['bitbake', /(?:^|\s)(?:ERROR|NOTE|WARNING):\s.*\bdo_[a-z_]+\b|bitbake|NOTE: Executing|Nothing PROVIDES|BitBake Fetcher/i], ['cmake', /CMake (?:Error|Warning)|-- Configuring (?:incomplete|done)|CMakeLists\.txt|CMakeCache/i],
            ['make', /\bmake(?:\[\d+\])?: \*\*\*|\bmake(?:\[\d+\])?: (?:Entering|Leaving) directory|\*\*\* missing separator|No rule to make target/i], ['ninja', /^FAILED: |ninja: (?:error|build stopped)/im],
            ['meson', /meson\.build:\d+|\bmeson\b.*ERROR|^ERROR: Dependency/im], ['gcc', /:\d+(?::\d+)?: (?:fatal )?error:|\bcc1(?:plus)?: |gcc: (?:fatal )?error|g\+\+: (?:fatal )?error|clang: error|error: unknown type name/i],
            ['ld', /undefined reference to|cannot find -l|ld returned \d+ exit status|collect2: error|\/ld: |ld\.lld: error|multiple definition of/i], ['maven', /\[ERROR\]|BUILD FAILURE|maven-compiler-plugin|COMPILATION ERROR/], ['java', /(?:^|\n)\s+at [\w$.]+\([\w$.]*(?::\d+)?\)|Exception in thread "|(?:^|\n)Caused by: |\.java:\d+|cannot find symbol|package [\w.]+ does not exist|UnsupportedClassVersion|Unsupported class file|java\.lang\.\w+Error/], ['go', /\.go:\d+:\d+:|^go: |cannot find package/m],
            ['kernel', /Call trace:|Backtrace:|(?:PC|LR) is at \S+\+0x|Internal error: Oops|\[\s*\d+\.\d{3,6}\]|\bkernel:|Call Trace:|\bBUG:|\bOops\b|Hardware name:|RIP: 0010|pc : \S+ lr : /], ['panic', /Kernel panic - not syncing|---\[ end (?:Kernel panic|trace)|Oops: [0-9a-f]+|Unable to handle kernel|VFS: Unable to mount root/],
            ['journal', /systemd(?:\[\d+\])?: |(?:Started|Stopped|Starting|Failed to start) [^\n]+\.|-- (?:Boot|Logs begin)|\b(?:sshd|systemd-logind|NetworkManager|dbus-daemon)\[\d+\]:|Main process exited|code=(?:exited|killed|dumped), status=/], ['gdb', /Program (?:received|terminated with) signal|\(gdb\)|Reading symbols from|GNU gdb|Cannot access memory at address|No symbol .* in current context|Remote communication error|warning: Error disabling address space/],
            ['runtime', /error while loading shared libraries|Exec format error|Illegal instruction|Segmentation fault|Address already in use|Permission denied|cannot execute: required file not found/], ['gradle', /FAILURE: Build failed|> Task :|Execution failed for task|Could not resolve all/],
            ['npm', /npm ERR!|gyp ERR!|node-gyp|ERESOLVE/], ['cargo', /panicked at |stack backtrace:|error\[E\d{4}\]|could not compile|failed to select a version|cargo build/i], ['python', /Traceback \(most recent call last\)|File "[^"]+", line \d+|pip(?:3)?(?: install)?|setup\.py|ModuleNotFoundError|externally-managed-environment|Failed building wheel/i], ['autotools', /configure: error|config\.status: error|checking for .*\.\.\. no/i], ['kbuild', /scripts\/Makefile|modpost|Kconfig|include\/generated\/autoconf\.h|\bKBUILD\b/i],
        ];
        function diagnoseBuild(log, o) {
            o = o || {}; const raw = String(log == null ? '' : log); if (raw.trim().length < 4) return { ok: false, error: '要給 log（建置失敗時的輸出文字，整段貼上最好）' };
            const text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, ''); const lines = text.split('\n');
            const clean = lines.map((l) => l.replace(/^\|\s?/, '').replace(/^\s*\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s+/, ''));
            const systems = SIGNS.filter(([, re]) => re.test(text)).map(([n]) => n); if (o.system && systems.indexOf(o.system) < 0) systems.push(o.system);
            const ctx = { recipe: null, task: null, logfile: null, targets: [], locations: [], cmakeAt: [], ninja: [] };
            for (const l of clean) {
                let m = /(?:ERROR|NOTE|WARNING):\s+(?<recipe>[A-Za-z0-9_.+-]+?)(?:-[0-9][^\s]*)?-r\d+ do_(?<task>[a-z_]+)(?::|\s)/.exec(l); if (m && !ctx.recipe && /ERROR/.test(l)) { ctx.recipe = m.groups.recipe; ctx.task = m.groups.task; }
                m = /Logfile of failure stored in:\s*(\S+)/i.exec(l); if (m) ctx.logfile = m[1];
                m = /Task \((?<f>[^)]+?):do_(?<task>[a-z_]+)\) failed/.exec(l); if (m && !ctx.recipe) { ctx.recipe = m.groups.f.replace(/^.*\//, '').replace(/\.bb(append)?$/, ''); ctx.task = m.groups.task; }
                m = /make(?:\[(?<lvl>\d+)\])?: \*\*\* \[(?:(?<f>[^:\]]+):(?<ln>\d+): )?(?<t>[^\]]+)\] Error (?<c>\d+)/.exec(l); if (m && ctx.targets.length < 6) ctx.targets.push({ target: m.groups.t, file: m.groups.f || '', line: m.groups.ln || '', code: m.groups.c, level: m.groups.lvl || '0' });
                m = /^FAILED:\s+(\S.*)$/.exec(l); if (m && ctx.ninja.length < 4) ctx.ninja.push(m[1].trim());
                m = /CMake Error at (?<f>[^:\s]+):(?<ln>\d+) \((?<cmd>[\w]+)\)/.exec(l); if (m && ctx.cmakeAt.length < 4) ctx.cmakeAt.push({ file: m.groups.f, line: m.groups.ln, command: m.groups.cmd });
                m = /(?<f>[^\s:()]+\.(?:c|cc|cpp|cxx|h|hpp|S|s|cu|java|rs|go|py|ts|js)):(?<ln>\d+)(?::(?<col>\d+))?:\s*(?:fatal )?(?:error|Error)/.exec(l); if (m && ctx.locations.length < 8) ctx.locations.push({ file: m.groups.f, line: m.groups.ln, col: m.groups.col || '' });
            }
            const rules = buildRules(); const hits = []; const seen = new Set(); const matchedLines = new Set();
            const fmt = (s, m) => String(s || '').replace(/\{(\w+)\}/g, (all, k) => { const v = grp(m, k); const w = v !== undefined ? v : (/^\d+$/.test(k) ? m[+k] : undefined); return w === undefined ? (/^[a-z]\w*$/.test(k) ? '' : all) : w; });
            for (let i = 0; i < clean.length; i++) {
                const l = clean[i]; if (!l.trim() || l.length > 2000) continue;
                for (const r of rules) {
                    if (r.system !== 'any' && systems.length && systems.indexOf(r.system) < 0 && !o.anySystem) continue;
                    let m, blockLen = 1; if (r._span) { if (!r._st.test(l)) continue; const blk = takeBlock(clean, i, r._span); blockLen = blk.length; m = r._re.exec(blk.join('\n')); } else m = r._re.exec(l); if (!m) continue; const whatText = fmt(r.what, m); const key = r.once ? r.id : r.id + '|' + whatText; if (seen.has(key)) { for (let b = 0; b < blockLen; b++) matchedLines.add(i + b); continue; } seen.add(key); for (let b = 0; b < blockLen; b++) matchedLines.add(i + b); const lvl = r.level === 'root' && /^\s*(?:WARNING|NOTE):|\bwarning:/i.test(l) && !/\berror\b/i.test(l) ? 'warn' : r.level;
                    const eno = grp(m, 'errno'); let enoMeaning; if (eno !== undefined && /^-?\d+$/.test(eno)) { const dn = describeNum(Math.abs(parseInt(eno, 10)), 'linux').filter((x) => x.system === 'linux_errno')[0]; if (dn) enoMeaning = dn.name + '（' + dn.code + '）＝' + (dn.note || dn.message); }
                    hits.push({ id: r.id, system: r.system, level: lvl, line: i + 1, text: l.trim().slice(0, 240), what: whatText, causes: r.causes.map((c) => fmt(c, m)), fixes: r.fixes.map((c) => fmt(c, m)), errno: enoMeaning, see: r.see || undefined });
                }
            }
            const roots = hits.filter((h) => h.level === 'root'), casc = hits.filter((h) => h.level === 'cascade'), warns = hits.filter((h) => h.level === 'warn');
            const unmatched = []; const ERRLINE = /(?:^|\s)(?:fatal )?error\b|\bERROR\b|\*\*\*|FAILED|Error \d+|cannot|undefined|not found|No such file|failed|\bfatal\b|exception|\bpanic\b|abort|\bdied\b|crash|exploded|denied|refused|time(?:d )?out|invalid|unable|unexpected|\bBUG\b|\bOops\b|traceback/i;
            for (let i = 0; i < clean.length && unmatched.length < 8; i++) { const l = clean[i].trim(); if (l && !matchedLines.has(i) && ERRLINE.test(l) && l.length < 400 && !/^(?:make|ninja)\b.*(?:Entering|Leaving)/.test(l)) unmatched.push({ line: i + 1, text: l.slice(0, 240) }); }
            // 傳遞鏈：由內到外
            const chain = [];
            if (roots.length) chain.push('原始錯誤（' + (roots[0].system) + '）：' + roots[0].what.split('。')[0]);
            for (const g of ctx.targets.slice(0, 3)) chain.push('make 的目標 ' + g.target + (g.file ? '（' + g.file + ':' + g.line + '）' : '') + ' 的命令失敗，退出碼 ' + g.code + (g.code === '127' ? '（找不到命令）' : g.code === '126' ? '（不能執行）' : g.code === '139' ? '（程式當掉 SIGSEGV）' : g.code === '137' ? '（被殺掉，常是記憶體不足）' : '') + '，make 往上一層回報 Error');
            for (const f of ctx.ninja.slice(0, 2)) chain.push('ninja 的步驟失敗：' + f);
            if (ctx.recipe) chain.push('BitBake：配方 ' + ctx.recipe + ' 的 do_' + ctx.task + ' 失敗' + (ctx.logfile ? '，詳細日誌 ' + ctx.logfile : '（詳細日誌在 tmp/work/…/temp/log.do_' + ctx.task + '）'));
            const parts = []; const LOGKIND = { kernel: '核心日誌', panic: '核心 panic', journal: 'systemd／journal 日誌', gdb: 'gdb 輸出', runtime: '執行期錯誤' }; if (systems.length) parts.push('看起來是 ' + systems.map((s) => LOGKIND[s] || s).join('、') + (systems.some((s) => LOGKIND[s]) && !systems.some((s) => !LOGKIND[s]) ? '' : ' 的輸出')); else parts.push('不確定是哪個系統的輸出');
            if (roots.length) parts.push('根本原因：' + roots.slice(0, 3).map((h) => '第 ' + h.line + ' 行「' + h.what.split('。')[0] + '」').join('；')); else if (casc.length) parts.push('只看到連帶結果（' + casc[0].what.split('。')[0] + '），找不到根本原因，要往上找第一個 error');
            if (chain.length > 1) parts.push('傳遞路徑：' + chain.join(' → '));
            const summary = parts.join('。') + '。';
            const res = { ok: roots.length + casc.length + warns.length > 0, systems, context: { recipe: ctx.recipe || undefined, task: ctx.task || undefined, logfile: ctx.logfile || undefined, failed_targets: ctx.targets.length ? ctx.targets : undefined, failed_ninja: ctx.ninja.length ? ctx.ninja : undefined, cmake_at: ctx.cmakeAt.length ? ctx.cmakeAt : undefined, locations: ctx.locations.length ? ctx.locations : undefined }, summary, chain, root_causes: roots.slice(0, 8), consequences: casc.slice(0, 6), warnings: warns.slice(0, 5), unmatched_error_lines: unmatched };
            if (!res.ok) res.hint = '沒有比對到收錄的規則。可以請 AI 看完整日誌找原因，並用 ref_define（kind:"build_error_rule"）補一條規則，下次離線也能直接說明。';
            else if (unmatched.length) res.hint = '另外有 ' + unmatched.length + ' 行錯誤沒有對應規則（unmatched_error_lines），可請 AI 查資料後用 ref_define 補規則。';
            res.markdown = buildMarkdown(res); return res;
        }
        function buildMarkdown(r) {
            const L = ['**' + r.summary + '**']; const one = (h) => { L.push('', '- 第 ' + h.line + ' 行：`' + h.text + '`', '  - 發生什麼事：' + h.what); if (h.errno) L.push('  - 錯誤碼：' + h.errno); if (h.causes.length) L.push('  - 常見原因：' + h.causes.join('；')); if (h.fixes.length) L.push('  - 怎麼處理：' + h.fixes.join('；')); };
            if (r.root_causes.length) { L.push('', '### 根本原因'); r.root_causes.forEach(one); }
            if (r.consequences.length) { L.push('', '### 連帶結果（不是原因，是上面錯誤造成的）'); r.consequences.slice(0, 4).forEach((h) => L.push('- 第 ' + h.line + ' 行：' + h.what)); }
            if (r.warnings.length) { L.push('', '### 警告'); r.warnings.forEach(one); }
            if (r.unmatched_error_lines.length) { L.push('', '### 還沒有規則的錯誤行'); r.unmatched_error_lines.forEach((u) => L.push('- 第 ' + u.line + ' 行：`' + u.text + '`')); }
            return L.join('\n');
        }
        function build() {
            idx.byName = new Map(); idx.bySys = {};
            const sys = Object.keys(data.errors || {}).concat(Object.keys(U.errors).filter((k) => !(data.errors || {})[k]));
            for (const s of sys) {
                const rows = ((data.errors || {})[s] || []).concat(U.errors[s] || []); idx.bySys[s] = new Map();
                for (const r of rows) {
                    let code = r.code; if (typeof code === 'string' && /^0x/i.test(code)) code = parseInt(code, 16) >>> 0; else if (typeof code === 'string' && /^-?\d+$/.test(code)) code = parseInt(code, 10);
                    const e = Object.assign({}, r, { system: s, num: code }); idx.bySys[s].set(code, e);
                    if (r.name) { const k = r.name.toLowerCase(); if (!idx.byName.has(k)) idx.byName.set(k, []); idx.byName.get(k).push(e); }
                }
            }
            idx.cmdAlias = new Map();
            const all = Object.assign({}, data.commands || {}, U.commands);
            for (const [n, c] of Object.entries(all)) { idx.cmdAlias.set(n.toLowerCase(), n); for (const a of c.aliases || []) idx.cmdAlias.set(a.toLowerCase(), n); }
            const names = Array.from(idx.byName.keys()).filter((n) => /^(e[a-z0-9]{2,}|error_[a-z0-9_]+|status_[a-z0-9_]+|wsa[a-z0-9_]+|e_[a-z0-9_]+|sig[a-z0-9]+|[a-z]+_e_[a-z0-9_]+|[a-z]+_s_[a-z0-9_]+|rpc_[se]_[a-z0-9_]+|s_[a-z0-9_]+)$/.test(n));
            names.sort((a, b) => b.length - a.length);
            idx.errNameRe = names.length ? new RegExp('(?<![A-Za-z0-9_])(' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z0-9_])', 'gi') : null;
            idx.built = true;
        }
        function ensure() { if (!idx.built) build(); }
        mergeUser(user);
        const cmdOf = (name) => { ensure(); const n = idx.cmdAlias.get(String(name || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')); if (!n) return null; return U.commands[n] ? Object.assign({}, (data.commands || {})[n] || {}, U.commands[n], { options: (((data.commands || {})[n] || {}).options || []).concat((U.commands[n] || {}).options || []).concat(U.options[n] || []) }) : Object.assign({}, data.commands[n], { options: (data.commands[n].options || []).concat(U.options[n] || []) }); };
        // ---------------- 錯誤碼 ----------------
        function hresultDecode(h) {
            h = h >>> 0; const sev = h >>> 31, cust = (h >>> 29) & 1, fac = (h >>> 16) & 0x7FF, code = h & 0xFFFF;
            const o = { value: H(h), severity: sev ? '失敗（Failure）' : '成功（Success）', customer: !!cust, facility: fac, facility_name: FACILITY[fac] || '（未收錄）', code };
            if (fac === 7) o.win32 = code; return o;
        }
        function ntDecode(n) { n = n >>> 0; return { value: H(n), severity: NT_SEV[n >>> 30], facility: (n >>> 16) & 0xFFF, code: n & 0xFFFF, customer: !!((n >>> 29) & 1) }; }
        function parseNumber(tok) {
            tok = String(tok).trim().replace(/^[-+]?/, (s) => s);
            if (/^-?0x[0-9a-f]+$/i.test(tok)) { const neg = tok[0] === '-'; const v = parseInt(tok.replace('-', ''), 16); return neg ? -v : v; }
            if (/^[0-9a-f]{8}h?$/i.test(tok) && /[a-f]/i.test(tok)) return parseInt(tok, 16);
            if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
            return null;
        }
        function describeNum(n, hint) {
            ensure(); const out = []; const add = (e, extra) => out.push(Object.assign({ system: e.system, code: e.num, hex: typeof e.num === 'number' && e.num >= 0 ? '0x' + e.num.toString(16).toUpperCase() : undefined, name: e.name, message: e.msg, note: e.note || undefined }, extra || {}));
            const pref = (s) => !hint || hint === s || (hint === 'windows' && /^(win32|hresult|ntstatus|winsock)$/.test(s)) || (hint === 'linux' && /^(linux_errno|signal|exit)$/.test(s));
            const has = (s, k) => idx.bySys[s] && idx.bySys[s].get(k);
            if (n < 0 && n >= -4294967295) {
                // 負數：Linux 核心習慣 -errno；Windows 常把 HRESULT／NTSTATUS 印成帶號整數
                if (n >= -4095 && pref('linux_errno') && has('linux_errno', -n)) add(has('linux_errno', -n), { via: '核心慣例：回傳 -errno' });
                const u = (n >>> 0); n = u;
            }
            if (n >= 0 && n <= 4095) {
                for (const s of ['linux_errno', 'win32', 'winsock', 'signal', 'exit']) { if (!pref(s)) continue; const e = has(s, n); if (e) add(e); }
                if (n > 128 && n < 128 + 65 && pref('exit')) { const sg = idx.bySys.signal && idx.bySys.signal.get(n - 128); if (sg) out.push({ system: 'exit', code: n, name: '128+' + (n - 128), message: '被訊號結束：' + sg.name + '（' + sg.msg + '）', note: 'shell 慣例：行程被訊號 N 結束時，退出碼是 128+N' }); }
            }
            if (n >= 4096 || (n >= 10000 && n < 12000)) {
                for (const s of ['winsock', 'win32']) { const e = has(s, n); if (e && pref(s)) add(e); }
            }
            if (n > 0xFFFF) {
                const e1 = has('hresult', n), e2 = has('ntstatus', n);
                if (e1 && pref('hresult')) add(e1, { decode: hresultDecode(n) });
                if (e2 && pref('ntstatus')) add(e2, { decode: ntDecode(n) });
                if (!e1 && !e2 && (n >>> 31) === 1 && (n >>> 30) !== 3 && pref('hresult')) { const d = hresultDecode(n); if (d.facility === 7) { const w = has('win32', d.win32); out.push({ system: 'hresult', code: n, hex: H(n), name: 'HRESULT_FROM_WIN32(' + d.win32 + ')', message: w ? w.name + '：' + w.msg : 'Win32 錯誤 ' + d.win32, note: w && w.note || undefined, decode: d }); } else out.push({ system: 'hresult', code: n, hex: H(n), name: '（未收錄的 HRESULT）', message: '嚴重度 ' + d.severity + '，facility ' + d.facility_name + '，代碼 ' + d.code, decode: d }); }
                if (!e2 && !e1 && (n >>> 30) === 3 && pref('ntstatus')) out.push({ system: 'ntstatus', code: n, hex: H(n), name: '（未收錄的 NTSTATUS）', message: '嚴重度 ' + ntDecode(n).severity, decode: ntDecode(n) });
            }
            return out;
        }
        function lookupError(query, o) {
            ensure(); o = o || {}; const q = String(query == null ? '' : query).trim(); const low = q.toLowerCase();
            let hint = o.system || null; let only = null;
            if (/\berrno\b/i.test(q)) only = ['linux_errno']; else if (/\b(signal|signum|sig[a-z]+)\b/i.test(q) && !/\berrno\b/i.test(q)) only = ['signal']; else if (/\bexit\s*(code|status)\b/i.test(q)) only = ['exit', 'signal']; else if (/(getlasterror|win32|winerror)/i.test(q)) only = ['win32', 'winsock']; else if (/\bhresult\b/i.test(q)) only = ['hresult']; else if (/\bntstatus\b/i.test(q)) only = ['ntstatus']; else if (/\bwsa/i.test(q)) only = ['winsock'];
            if (!hint) { if (/(getlasterror|win32|windows|winerror|hresult|ntstatus|wsa|0x8[0-9a-f]{7}|0xc[0-9a-f]{7})/i.test(q)) hint = 'windows'; else if (/(errno|linux|posix|strerror|exit code|signal|signum|segfault|核心|kernel)/i.test(q)) hint = 'linux'; }
            const matches = []; const seen = new Set(); const push = (m) => { const k = m.system + ':' + m.code + ':' + m.name; if (!seen.has(k)) { seen.add(k); matches.push(m); } };
            // 名稱（含 -ENOMEM、errno=EACCES）
            const nameToks = q.match(/[-]?[A-Za-z_][A-Za-z0-9_]{1,}/g) || [];
            for (let t of nameToks) { t = t.replace(/^-/, ''); const es = idx.byName.get(t.toLowerCase()); if (es) for (const e of es) describeEntry(e).forEach(push); }
            // 數字
            const numToks = q.match(/-?0x[0-9a-fA-F]+|(?<![A-Za-z_0-9])-?\d{1,10}(?![A-Za-z_0-9])/g) || [];
            for (const t of numToks) { const n = parseNumber(t); if (n == null) continue; for (const m of describeNum(n, hint)) if (!only || only.indexOf(m.system) >= 0) push(m); }
            // 名稱查不到、也沒有數字：用關鍵字找訊息
            if (!matches.length && q.length >= 3 && !numToks.length && !o.noKeyword) {
                const words = low.split(/[^a-z0-9一-鿿]+/).filter((w) => w.length >= 3); const scored = [];
                for (const [s, mp] of Object.entries(idx.bySys)) for (const e of mp.values()) { const hay = ((e.name || '') + ' ' + (e.msg || '') + ' ' + (e.note || '')).toLowerCase(); let sc = 0; for (const w of words) if (hay.indexOf(w) >= 0) sc++; if (sc) scored.push([sc, e]); }
                scored.sort((a, b) => b[0] - a[0]); scored.slice(0, 6).forEach(([, e]) => describeEntry(e).forEach(push));
            }
            return { ok: matches.length > 0, query: q, count: matches.length, matches: matches.slice(0, 12), hint: matches.length ? undefined : '沒有收錄這個代碼。可以請 AI 查官方文件後用 ref_define（kind:"error_code"）補進來。' };
        }
        function describeEntry(e) {
            const base = { system: e.system, code: e.num, hex: typeof e.num === 'number' && e.num > 255 ? H(e.num) : undefined, name: e.name, message: e.msg, note: e.note || undefined };
            if (e.system === 'hresult') base.decode = hresultDecode(e.num); if (e.system === 'ntstatus') base.decode = ntDecode(e.num); return [base];
        }
        function errorLine(m) { return m.name + (m.code != null ? '（' + (m.system === 'hresult' || m.system === 'ntstatus' ? (m.hex || H(m.code)) : m.code) + '）' : '') + '＝' + (m.note || m.message); }
        // ---------------- 命令列 ----------------
        function tokenizeShell(line) {
            const out = []; let cur = '', q = null, has = false;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < line.length) cur += line[++i]; else cur += c; }
                else if (c === '"' || c === "'") { q = c; has = true; }
                else if (c === '\\' && i + 1 < line.length) { if (line[i + 1] === '\n') i++; else cur += line[++i]; has = true; }
                else if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
                else cur += c;
            }
            if (cur || has) out.push(cur); return out;
        }
        function findOption(cmd, flag) {
            const opts = cmd.options || []; let hit = opts.find((o) => o.flag === flag); if (hit) return { opt: hit, rest: '' };
            // 前綴型：-O2、-lm、-I/inc、-DNAME=1、-std=c11、-Wall
            let best = null; for (const o of opts) { if (o.flag.endsWith('*') && flag.startsWith(o.flag.slice(0, -1)) && (!best || o.flag.length > best.opt.flag.length)) best = { opt: o, rest: flag.slice(o.flag.length - 1) }; }
            return best;
        }
        function explainSubOptions(cmd, name, value) {
            const tbl = (cmd.subs || {})[name]; if (!tbl || !value) return [];
            const out = []; const parts = name === 'append' ? value.split(/\s+/).filter(Boolean) : value.split(','); const first = parts[0];
            parts.forEach((p, i) => {
                const eq = p.indexOf('='); const key = eq < 0 ? p : p.slice(0, eq); const val = eq < 0 ? '' : p.slice(eq + 1);
                const row = tbl.find((r) => r.key === key) || tbl.find((r) => r.key.endsWith('*') && (key.startsWith(r.key.slice(0, -1)) || p.startsWith(r.key.slice(0, -1))));
                if (i === 0 && eq < 0 && name !== 'append') { const t = tbl.find((r) => r.key === '@type:' + key) || row; if (t) out.push({ key: key, val: '', desc: t.desc }); return; }
                out.push({ key, val, desc: row ? row.desc : '（沒有收錄這個子選項）' });
            });
            return out;
        }
        function listDesc(cmd, list, name) { const l = (cmd.lists || {})[list]; if (!l) return ''; const hit = l.find((x) => x.name === name); return hit ? hit.desc : ''; }
        function explainCommandLine(line, o) {
            ensure(); o = o || {}; let toks = tokenizeShell(String(line || '').trim().replace(/^\$\s*/, '').replace(/^sudo\s+/, ''));
            while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift(); // 環境變數前綴
            if (!toks.length) return { ok: false, error: '沒有命令' };
            const prog = toks[0]; const cmd = cmdOf(prog);
            if (!cmd) return { ok: false, program: prog, error: '沒有收錄這個命令（' + prog + '）', hint: '可以請 AI 查手冊／官方文件後用 ref_define（kind:"command" 或 "option"）補進來。' };
            const items = []; const unknown = []; const positional = []; let i = 1;
            const sum = { machine: '', cpu: '', mem: '', smp: '', kernel: '', append: '', serial: [], net: [], drives: [], extras: [], nographic: false, gdb: false, bios: '', dtb: '', initrd: '', accel: '' };
            while (i < toks.length) {
                let t = toks[i++];
                if (t === '--') { positional.push(...toks.slice(i)); break; }
                if (t[0] !== '-' || t === '-') { const sc = t[0] !== '-' ? (cmd.options || []).find((o) => o.flag === t && o.flag[0] !== '-') : null; if (sc && !positional.length) items.push({ flag: t, arg: '', desc: sc.desc }); else positional.push(t); continue; }
                let flag = t, val = null; const eq = t.indexOf('=');
                if (t.startsWith('--') && eq > 0) { flag = t.slice(0, eq); val = t.slice(eq + 1); }
                let f = findOption(cmd, flag);
                if (!f && val != null) { const f2 = findOption(cmd, t); if (f2) { f = f2; val = null; } }
                if (!f && !t.startsWith('--') && /^-[a-zA-Z]{2,}$/.test(t) && !(cmd.name || '').startsWith('qemu') && !/^(gcc|g\+\+|javac|java|python|node|gdb)$/.test(cmd.name)) { // 合併短選項 -la
                    const fl = t.slice(1).split(''); const subs = fl.map((c) => findOption(cmd, '-' + c)); if (subs.every(Boolean)) { subs.forEach((s, k) => items.push({ flag: '-' + fl[k], arg: '', desc: s.opt.desc })); continue; }
                }
                if (!f) { unknown.push(t); continue; }
                const o2 = f.opt; let arg = val != null ? val : (f.rest || null);
                if (arg == null && o2.arg && !/^\?/.test(o2.arg) && i < toks.length && !(toks[i][0] === '-' && toks[i].length > 1 && !/^-\d/.test(toks[i]))) arg = toks[i++];
                else if (arg == null && o2.arg && /^\?/.test(o2.arg) && i < toks.length && toks[i][0] !== '-') { arg = toks[i++]; }
                const item = { flag: t === flag || val != null ? flag : t, arg: arg == null ? '' : arg, desc: o2.desc };
                if (f.rest && o2.flag.endsWith('*')) { item.desc = o2.desc.split('{v}').join(f.rest); item.arg = ''; }
                else if (arg && o2.desc.indexOf('{v}') >= 0) item.desc = o2.desc.split('{v}').join(arg);
                const nm = o2.flag.replace(/^-+/, '').replace(/\*$/, ''); const subTbl = (cmd.subs || {})[nm]; if (subTbl && arg) item.sub = explainSubOptions(cmd, nm, arg);
                if (cmd.lists) { if ((nm === 'M' || nm === 'machine') && arg) { const d = listDesc(cmd, 'machines', arg.split(',')[0]); if (d) item.value_desc = d; } if (nm === 'cpu' && arg) { const d = listDesc(cmd, 'cpus', arg.split(',')[0]); if (d) item.value_desc = d; } }
                items.push(item);
                // qemu 摘要
                if ((cmd.name || '').indexOf('qemu') === 0 && arg !== null || /^-(nographic|s|S)$/.test(flag)) {
                    const a = arg || ''; if (nm === 'M' || nm === 'machine') sum.machine = a; else if (nm === 'cpu') sum.cpu = a; else if (nm === 'm') sum.mem = a; else if (nm === 'smp') sum.smp = a; else if (nm === 'kernel') sum.kernel = a; else if (nm === 'append') sum.append = a; else if (nm === 'initrd') sum.initrd = a; else if (nm === 'dtb') sum.dtb = a; else if (nm === 'bios') sum.bios = a;
                    else if (nm === 'serial') sum.serial.push(a); else if (nm === 'netdev' || nm === 'nic' || nm === 'net') sum.net.push(a); else if (nm === 'drive' || nm === 'hda' || nm === 'hdb' || nm === 'cdrom' || nm === 'sd' || nm === 'mtdblock' || nm === 'pflash') sum.drives.push(nm + ' ' + a); else if (nm === 'nographic') sum.nographic = true; else if (nm === 's' || nm === 'S' || nm === 'gdb') sum.gdb = true; else if (nm === 'accel') sum.accel = a; else if (nm === 'device') sum.extras.push(a);
                }
            }
            const out = { ok: true, program: cmd.name, summary: cmd.summary, synopsis: cmd.synopsis || undefined, items, positional, unknown_options: unknown };
            if ((cmd.name || '').indexOf('qemu') === 0) out.overview = qemuOverview(cmd, sum);
            else if (/^(gcc|g\+\+|cc|c\+\+)$/.test(cmd.name)) out.overview = gccOverview(toks.slice(1), items, positional);
            out.markdown = commandMarkdown(out); return out;
        }
        function qemuOverview(cmd, s) {
            const arch = cmd.name.replace('qemu-system-', ''); const parts = [];
            parts.push('在本機用 QEMU 模擬一台 ' + ({ arm: 'ARM（32 位元）', aarch64: 'ARM64', x86_64: 'x86-64', i386: 'x86（32 位元）' }[arch] || arch) + ' 的機器');
            if (s.machine) { const d = listDesc(cmd, 'machines', s.machine.split(',')[0]); parts.push('機型 ' + s.machine + (d ? '（' + d + '）' : '')); }
            if (s.cpu) { const d = listDesc(cmd, 'cpus', s.cpu.split(',')[0]); parts.push('CPU ' + s.cpu + (d ? '（' + d + '）' : '')); }
            if (s.smp) parts.push(s.smp + ' 個核心設定'); if (s.mem) parts.push('記憶體 ' + s.mem);
            if (s.bios) parts.push('韌體／BIOS ' + s.bios); if (s.kernel) parts.push('直接載入核心 ' + s.kernel + '（不經過開機載入器）'); if (s.initrd) parts.push('initrd ' + s.initrd); if (s.dtb) parts.push('裝置樹 ' + s.dtb);
            if (s.append) parts.push('核心命令列「' + s.append + '」'); if (s.drives.length) parts.push('儲存：' + s.drives.join('；')); if (s.net.length) parts.push('網路：' + s.net.join('；'));
            if (s.serial.length) parts.push('序列埠導向 ' + s.serial.join('、')); if (s.nographic) parts.push('不開圖形視窗（-nographic：序列埠與監控接到終端機）'); if (s.gdb) parts.push('開 GDB 伺服器（預設 tcp::1234；若有 -S 則啟動後先暫停等 gdb 連線）');
            if (s.extras.length) parts.push('額外裝置：' + s.extras.join('；')); return parts.join('；') + '。';
        }
        function gccOverview(args, items, pos) {
            const stage = items.some((i) => i.flag === '-E') ? '只做前處理' : items.some((i) => i.flag === '-S') ? '編譯成組合語言（不組譯）' : items.some((i) => i.flag === '-c') ? '編譯並組譯成目的檔（不連結）' : '編譯並連結成可執行檔';
            const opt = items.find((i) => /^-O/.test(i.flag)); const dbg = items.some((i) => /^-g/.test(i.flag)); const out = items.find((i) => i.flag === '-o');
            return stage + (opt ? '；最佳化 ' + opt.flag : '；沒有指定最佳化（等於 -O0）') + (dbg ? '；含除錯資訊' : '') + (out ? '；輸出 ' + out.arg : '') + (pos.length ? '；輸入 ' + pos.join('、') : '') + '。';
        }
        function commandMarkdown(r) {
            const L = ['**' + r.program + '**：' + r.summary]; if (r.overview) L.push('', '整體：' + r.overview);
            if (r.items.length) { L.push('', '逐項：'); for (const it of r.items) { L.push('- `' + it.flag + (it.arg ? ' ' + it.arg : '') + '`：' + it.desc + (it.value_desc ? '（' + it.arg + '＝' + it.value_desc + '）' : '')); if (it.sub) for (const s of it.sub) L.push('  - `' + s.key + (s.val ? '=' + s.val : '') + '`：' + s.desc); } }
            if (r.positional.length) L.push('', '位置引數：' + r.positional.map((p) => '`' + p + '`').join('、'));
            if (r.unknown_options.length) L.push('', '還不認得的選項：' + r.unknown_options.map((p) => '`' + p + '`').join('、') + '（可請 AI 查手冊後用 ref_define 補）');
            return L.join('\n');
        }
        function lookupCommand(name, option) {
            ensure(); const cmd = cmdOf(name); if (!cmd) return { ok: false, error: '沒有收錄這個命令：' + name, hint: '可以請 AI 查手冊後用 ref_define（kind:"command"）補進來。' };
            if (option && cmd.lists && cmd.lists.commands) { const hit = cmd.lists.commands.find((x) => x.name === option || x.name.split(' ')[0] === option); if (hit) return { ok: true, program: cmd.name, command: hit.name, desc: hit.desc }; }
            if (option) { const f = findOption(cmd, option); if (!f) { const near = cmd.options.filter((o) => o.flag.indexOf(option.replace(/^-+/, '')) >= 0).slice(0, 8); return { ok: false, program: cmd.name, error: '沒有收錄選項 ' + option, similar: near.map((o) => ({ flag: o.flag, arg: o.arg, desc: o.desc })) }; } return { ok: true, program: cmd.name, option: f.opt.flag, arg: f.opt.arg, desc: f.opt.desc }; }
            return { ok: true, program: cmd.name, aliases: cmd.aliases, summary: cmd.summary, synopsis: cmd.synopsis, options: cmd.options.map((o) => ({ flag: o.flag, arg: o.arg, desc: o.desc })), machines: cmd.lists && cmd.lists.machines ? cmd.lists.machines.length : undefined };
        }
        // ---------------- pragma ----------------
        function explainPragma(text) {
            ensure(); let s = String(text || '').trim().replace(/^#\s*pragma\s+/i, '').replace(/\s+/g, ' '); if (!s) return null;
            const rows = (data.pragmas || []).concat(U.pragmas); let best = null;
            for (const r of rows) { const k = r.key; if ((s === k || s.startsWith(k + ' ') || s.startsWith(k + '(')) && (!best || k.length > best.key.length)) best = r; }
            // 子句：name 或 name(args)，先去掉指令本體
            const rest = best ? s.slice(best.key.length).trim() : s; const clauses = []; const re = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(((?:[^()]|\([^()]*\))*)\))?/g; let m;
            const crow = (data.clauses || []).concat(U.clauses);
            if (best && /^(omp|acc)\b/.test(best.key) || /^(omp|acc)\b/.test(s)) { while ((m = re.exec(rest))) { const n = m[1]; const row = crow.find((c) => c.key === n || c.key === (s.split(' ')[0] + ' ' + n)); if (row) clauses.push({ clause: n + (m[2] != null ? '(' + m[2] + ')' : ''), desc: row.desc.replace('{v}', m[2] != null ? m[2] : '') }); else if (!/^(for|do|parallel|sections|section|single|master|critical|atomic|barrier|task|simd|target|teams|distribute)$/.test(n) && n.length > 2) clauses.push({ clause: n + (m[2] != null ? '(' + m[2] + ')' : ''), desc: '（沒有收錄這個子句）' }); } }
            if (!best && !clauses.length) return null;
            return { pragma: s, desc: best ? best.desc.replace('{v}', rest) : '（沒有收錄這個 pragma）', clauses };
        }
        // ---------------- 程式碼裡的標註（給行為分析用）----------------
        const SHELL_CALL = /\b(system|popen|execl|execlp|execv|execvp|execve|posix_spawn|spawn|exec|execSync|execFile|check_output|check_call|run|Popen|getoutput|WinExec|ShellExecuteA|ShellExecuteW|CreateProcessA|CreateProcessW)\s*\(\s*(?:[A-Za-z_.]*,\s*)?["'`]([^"'`]{3,300})["'`]/;
        function annotateText(text, lang) {
            ensure(); const notes = []; const seen = new Set(); const add = (n) => { if (!seen.has(n)) { seen.add(n); notes.push(n); } };
            text = String(text || '');
            if (idx.errNameRe) { idx.errNameRe.lastIndex = 0; let m; while ((m = idx.errNameRe.exec(text))) { const es = idx.byName.get(m[1].toLowerCase()); if (es && es[0]) { const e = es[0]; add(e.name + '（' + (e.system === 'hresult' || e.system === 'ntstatus' ? H(e.num) : e.num) + '）＝' + (e.note || e.msg)); } if (notes.length >= 6) break; } }
            let m2 = /\b(?:exit|_exit|_Exit|quick_exit|sys\.exit|process\.exit|ExitProcess|os\._exit)\s*\(\s*(-?\d+|0x[0-9a-fA-F]+)\s*\)/.exec(text);
            if (m2) { const n = parseNumber(m2[1]); if (n != null) { const e = idx.bySys.exit && idx.bySys.exit.get(n); add('退出碼 ' + n + '＝' + (n === 0 ? '成功' : e ? (e.note || e.msg) : (n > 128 && n < 193 && idx.bySys.signal && idx.bySys.signal.get(n - 128) ? '被訊號 ' + (n - 128) + '（' + idx.bySys.signal.get(n - 128).name + '）結束的慣例' : '非 0 表示失敗（約定的程式自訂碼）'))); } }
            const sm = SHELL_CALL.exec(text);
            if (sm && /\s|^[\w./-]+$/.test(sm[2])) { const r = explainCommandLine(sm[2]); if (r.ok) add('字串裡的命令 ' + r.program + '：' + (r.overview || r.summary)); }
            if (/\bpython\d?\s+-m\s+\w+/.test(text) === false && /\b(?:errno|GetLastError\(\)|WSAGetLastError\(\))\s*(?:==|!=)\s*(-?\d+)\b/.test(text)) { const mm = /(?:errno|GetLastError\(\)|WSAGetLastError\(\))\s*(?:==|!=)\s*(-?\d+)\b/.exec(text); const hint = /errno/.test(mm[0]) ? 'linux' : 'windows'; const rr = describeNum(parseInt(mm[1], 10), hint); if (rr[0]) add(rr[0].name + '（' + mm[1] + '）＝' + (rr[0].note || rr[0].message)); }
            return notes;
        }
        // ---------------- 總查詢 ----------------
        function lookup(query) {
            ensure(); const q = String(query || '').trim(); if (!q) return { ok: false, error: '沒有查詢內容' };
            const out = { ok: true, query: q, results: [] };
            if (/^#?\s*pragma\b/i.test(q) || /^omp\s/.test(q)) { const p = explainPragma(q); if (p) out.results.push({ kind: 'pragma', pragma: p }); }
            const first = tokenizeShell(q.replace(/^\$\s*/, '').replace(/^sudo\s+/, ''))[0];
            if (first && cmdOf(first) && /(\s-|--|^\S+$)/.test(q)) { const r = /\s/.test(q) ? explainCommandLine(q) : lookupCommand(first); if (r.ok) out.results.push({ kind: /\s/.test(q) ? 'command_line' : 'command', command: r }); }
            const er = lookupError(q, { noKeyword: true }); if (er.ok && !(out.results.length && /\s-/.test(q))) out.results.push({ kind: 'error', matches: er.matches });
            const low = q.toLowerCase(); const words = low.split(/[^a-z0-9_+.\-一-鿿]+/).filter((w) => w.length >= 2);
            for (const g of allGeneric()) { const hay = ((g.key || '') + ' ' + (g.text || '') + ' ' + (g.tags || []).join(' ')).toLowerCase(); let sc = 0; for (const w of words) if (hay.indexOf(w) >= 0) sc++; const strong = words.some((w) => w.length >= 3 && ((g.key || '').toLowerCase().indexOf(w) >= 0 || (g.tags || []).some((tg) => String(tg).toLowerCase() === w))); if (sc && (sc >= Math.min(2, words.length) || strong)) out.results.push({ kind: g.kind, key: g.key, text: g.text, source: g.src || undefined, _s: sc }); }
            for (const e of typedAll().values()) { const c = e.customize || {}; const hay = (e.key + ' ' + (e.text || '') + ' ' + (e.tags || []).join(' ') + ' ' + [].concat(c.aliases || [], c.name || []).join(' ')).toLowerCase(); let sc = 0; for (const w of words) if (hay.indexOf(w) >= 0) sc++; if (sc && (sc >= Math.min(2, words.length) || e.key.toLowerCase() === low)) out.results.push({ kind: 'typed', typed: { kind: e.kind, key: e.key, text: e.text, tags: e.tags || [], src: e.src || '', source: e.source } }); }
            if (!out.results.length) { const ek = lookupError(q); if (ek.ok) out.results.push({ kind: 'error', matches: ek.matches }); }
            if (!out.results.length) { // 關鍵字搜尋命令選項
                const hits = []; const all = Object.assign({}, data.commands || {}, U.commands);
                for (const c of Object.values(all)) for (const o of c.options || []) { const hay = (o.flag + ' ' + o.desc).toLowerCase(); let sc = 0; for (const w of words) if (hay.indexOf(w) >= 0) sc++; if (sc) hits.push([sc, c.name, o]); }
                hits.sort((a, b) => b[0] - a[0]); hits.slice(0, 8).forEach(([, n, o]) => out.results.push({ kind: 'option', command: n, flag: o.flag, arg: o.arg, desc: o.desc }));
            }
            out.ok = out.results.length > 0; if (!out.ok) out.hint = '沒有收錄。可以請 AI 上網查官方文件，用 ref_define 補進來（或 /ref-expand <主題>）。';
            return out;
        }
        // ---------------- 簡單 tokenizer（AI 補的規則）----------------
        function tokenize(rules, text) {
            const out = []; text = String(text || ''); let i = 0; const res = (rules || []).map((r) => ({ name: r.name, re: new RegExp(r.re.startsWith('^') ? r.re : '^(?:' + r.re + ')') }));
            while (i < text.length) { let hit = null; const rest = text.slice(i); for (const r of res) { const m = r.re.exec(rest); if (m && m[0].length) { hit = { name: r.name, text: m[0] }; break; } } if (hit) { if (hit.name !== 'skip') out.push(hit); i += hit.text.length; } else { out.push({ name: 'unknown', text: text[i] }); i++; } }
            return out;
        }
        // ---------------- 執行期補的定義 → 內建來源檔的格式（之後交給 Claude 或其他 AI 協助併進內建）----------------
        const clean = (s) => String(s == null ? '' : s).replace(/\s*\|\s*/g, '／').replace(/\n+/g, ' ').trim();
        function exportBuiltin(u) {
            u = u || U; const out = { buildrules_dsl: '', errors_dsl: '', commands_dsl: '', pragmas_dsl: '', generic: [] };
            const el = []; for (const [s, rows] of Object.entries(u.errors || {})) { if (!rows.length) continue; el.push('@' + s); for (const r of rows) el.push([r.code, clean(r.name), clean(r.msg), clean((r.note || '') + (r.src ? '（來源：' + r.src + '）' : ''))].join(' | ')); } out.errors_dsl = el.join('\n') + (el.length ? '\n' : '');
            const cl = []; const names = new Set(Object.keys(u.commands || {}).concat(Object.keys(u.options || {})));
            for (const n of names) { const c = (u.commands || {})[n] || {}; cl.push('## ' + [clean(n), (c.aliases || []).map(clean).join(','), clean(c.summary || ''), clean(c.synopsis || '')].join(' | ')); for (const o of (c.options || []).concat((u.options || {})[n] || [])) cl.push([clean(o.flag), clean(o.arg || ''), clean(o.desc || '') + (o.src ? '（來源：' + clean(o.src) + '）' : '')].join(' | ')); } out.commands_dsl = cl.join('\n') + (cl.length ? '\n' : '');
            const pl = []; if ((u.pragmas || []).length) { pl.push('@pragma'); for (const p of u.pragmas) pl.push(clean(p.key) + ' | ' + clean(p.desc) + (p.src ? '（來源：' + clean(p.src) + '）' : '')); } if ((u.clauses || []).length) { pl.push('@clause'); for (const p of u.clauses) pl.push(clean(p.key) + ' | ' + clean(p.desc) + (p.src ? '（來源：' + clean(p.src) + '）' : '')); } out.pragmas_dsl = pl.join('\n') + (pl.length ? '\n' : '');
            const bl = []; for (const r of (u.buildRules || [])) { bl.push('## ' + [clean(r.id), clean(r.system || 'any'), clean(r.level || 'root')].join(' | ')); if (r.span) { bl.push('start: ' + String(r.start || '^')); bl.push('span: ' + clean(r.span)); } bl.push('re: ' + String(r.re).replace(/\n/g, ' ')); bl.push('what: ' + clean(r.what) + (r.src ? '（來源：' + clean(r.src) + '）' : '')); (r.causes || []).forEach((c) => bl.push('cause: ' + clean(c))); (r.fixes || []).forEach((c) => bl.push('fix: ' + clean(c))); bl.push(''); } out.buildrules_dsl = bl.join('\n');
            out.types_json = JSON.stringify(Object.entries(u.types || {}).map(([k, v]) => Object.assign({ kind: k }, v)), null, 1);
            out.typed_json = JSON.stringify((u.typed || []).map((e) => ({ kind: e.kind, key: e.key, text: e.text, tags: e.tags || [], src: e.src || '', tv: e.tv, customize: e.customize })), null, 1);
            out.generic = (u.generic || []).map((g) => ({ kind: g.kind, key: g.key, text: g.text, tags: g.tags || [], rules: g.rules || undefined, src: g.src || '' }));
            return out;
        }
        return {
            types: () => Array.from(typesAll().values()), getType, validateTypeDef, validateCustomize, validateEntry, findTyped, listTyped, resolve, validateAll,
            diagnoseBuild, diagnoseLog: diagnoseBuild, validateBuildRules() { const all = (data.buildRules || []).concat(U.buildRules || []); const bad = []; for (const r of all) { try { new RegExp(dedupeGroups(r.re), 'i'); if (r.span) { if (!parseSpan(r.span)) throw new Error('span 格式不對'); new RegExp(r.start || '^', 'i'); } } catch (e) { bad.push({ id: r.id, error: String(e.message).slice(0, 100) }); } } return { total: all.length, invalid: bad }; }, exportBuiltin, setUser(u) { mergeUser(u); idx.built = false; }, lookup, lookupError, lookupCommand, explainCommandLine, explainPragma, annotateText, tokenize, hresultDecode, ntDecode, errorLine, tokenizeShell,
            stats() { ensure(); const e = {}; for (const [k, m] of Object.entries(idx.bySys)) e[k] = m.size; const c = Object.keys(data.commands || {}).length + Object.keys(U.commands).length; let o = 0; for (const x of Object.values(data.commands || {})) o += (x.options || []).length; return { errors: e, commands: c, options: o, pragmas: (data.pragmas || []).length + U.pragmas.length, clauses: (data.clauses || []).length + U.clauses.length, generic: allGeneric().length, build_rules: buildRules().length }; },
        };
    }
    // ===== 知識包（knowledge pack）：離線訓練器資料包（bundle）裡的 `knowledge` 區塊 =====
    // 純函式，不碰儲存與介面——所有用到這個引擎的專案（桌面版、網頁版、redmine 的 AI 聊天）共用同一份語意，host 只負責「讀寫使用者資料、問使用者」。
    // 格式：{ format:'fa-knowledge-types', version, types:[{kind,label,description,version,schema}], typed:[{kind,key,text,tags,src,tv,customize}] }
    const PACK_FORMAT = 'fa-knowledge-types';
    // 使用者資料 → 知識包（只有使用者註冊的類型與條目；內建的每個版本都有，不帶）。沒有東西就回 null。
    function exportPack(userDefs, version) {
        const u = userDefs || {};
        const types = Object.entries(u.types || {}).map(([kind, v]) => Object.assign({ kind }, JSON.parse(JSON.stringify(v))));
        const typed = JSON.parse(JSON.stringify(u.typed || []));
        if (!types.length && !typed.length) return null;
        return { format: PACK_FORMAT, version, types, typed };
    }
    // 檢查一個知識包（不寫入）：用「現有知識庫＋這份」一起驗證類型定義、條目結構、引用是否存在、有沒有循環。
    // data：內建資料（FA_REF_DATA）；userDefs：目前的使用者資料；maxVersion：這個程式認得的最高知識包版本。
    // 回傳 { ok, warnings:[字串], knowledge:{version, types, typed, rejected, by_kind} | null }；不合法的類型與條目只會列警告、不收進 knowledge。
    function inspectPack(data, userDefs, pack, maxVersion) {
        const warnings = []; if (!pack || typeof pack !== 'object') return { ok: true, warnings, knowledge: null };
        const kv = Number(pack.version) || 0;
        if (pack.format !== PACK_FORMAT) { warnings.push('知識區塊的 format 不認得，略過'); return { ok: true, warnings, knowledge: null }; }
        if (kv > maxVersion) { warnings.push('知識區塊是格式 v' + kv + '，比這個程式認得的（v' + maxVersion + '）新，略過；請先更新程式'); return { ok: true, warnings, knowledge: null }; }
        const u = userDefs || {}; const base = create(data, u); const okTypes = [], okEntries = [], bad = []; const tmpTypes = {};
        for (const ty of Array.isArray(pack.types) ? pack.types : []) {
            if (!ty || !ty.kind) { bad.push('類型缺 kind'); continue; }
            const v = base.validateTypeDef({ kind: ty.kind, label: ty.label, description: ty.description, version: ty.version, schema: ty.schema });
            if (!v.ok) { bad.push('類型 ' + ty.kind + '：' + v.errors.slice(0, 2).map((e) => e.msg).join('；')); continue; }
            okTypes.push(ty); tmpTypes[ty.kind] = { label: ty.label, description: ty.description, version: ty.version, schema: ty.schema };
        }
        const incoming = (Array.isArray(pack.typed) ? pack.typed : []).filter((e) => e && e.kind && e.key);
        const cand = Object.assign({}, u, { types: Object.assign({}, u.types || {}, tmpTypes), typed: (u.typed || []).filter((e) => !incoming.some((x) => x.kind === e.kind && x.key === e.key)).concat(incoming) });
        let tmp = null; try { tmp = create(data, cand); } catch (e) { bad.push('知識庫無法載入：' + e.message); }
        if (tmp) for (const e of incoming) {
            if (!tmp.getType(e.kind)) { bad.push(e.kind + ':' + e.key + '：沒有這個類型'); continue; }
            const v = tmp.validateEntry(e, { requireSource: false });
            if (!v.ok) { bad.push(e.kind + ':' + e.key + '：' + v.errors.slice(0, 2).map((x) => x.msg).join('；')); continue; }
            const r = tmp.resolve(e.kind, e.key);
            if (!r.ok) { bad.push(e.kind + ':' + e.key + '：' + r.errors.slice(0, 1).map((x) => x.msg).join('；')); continue; }
            okEntries.push(e);
        }
        bad.slice(0, 8).forEach((m) => warnings.push('知識：' + m + '（不會匯入）'));
        if (bad.length > 8) warnings.push('知識：另有 ' + (bad.length - 8) + ' 筆不合法，不會匯入');
        const by_kind = {}; okEntries.forEach((e) => { by_kind[e.kind] = (by_kind[e.kind] || 0) + 1; });
        return { ok: true, warnings, knowledge: { version: kv, types: okTypes, typed: okEntries, rejected: bad.length, by_kind } };
    }
    // 把檢查過的知識包併進使用者資料（就地修改 userDefs，host 之後自己存檔）。衝突一律保留使用者的，除非 opts.overwrite。
    // 回傳 { types, entries, kept_yours, conflicts:[字串] }
    function mergePack(userDefs, knowledge, opts) {
        opts = opts || {}; const when = opts.when || Date.now(); const out = { types: 0, entries: 0, kept_yours: 0, conflicts: [] };
        if (!knowledge) return out;
        userDefs.types = userDefs.types || {}; userDefs.typed = userDefs.typed || [];
        for (const ty of knowledge.types || []) {
            const old = userDefs.types[ty.kind];
            if (old && Number(old.version) === Number(ty.version) && JSON.stringify(old.schema) === JSON.stringify(ty.schema)) continue; // 一樣：不動、不算新增
            if (old && Number(old.version) > Number(ty.version)) { out.conflicts.push('知識類型 ' + ty.kind + '：你的版本（v' + old.version + '）比較新，保留'); out.kept_yours++; continue; }
            if (old && JSON.stringify(old.schema) !== JSON.stringify(ty.schema) && !opts.overwrite && Number(old.version) === Number(ty.version)) { out.conflicts.push('知識類型 ' + ty.kind + '：結構跟你的不同，保留你的'); out.kept_yours++; continue; }
            userDefs.types[ty.kind] = { label: ty.label, description: ty.description, version: ty.version, schema: ty.schema, src: ty.src || 'bundle', by: ty.by || 'import', at: ty.at || when }; out.types++;
        }
        for (const e of knowledge.typed || []) {
            const i = userDefs.typed.findIndex((x) => x.kind === e.kind && x.key === e.key);
            if (i >= 0) {
                if (JSON.stringify(userDefs.typed[i].customize) === JSON.stringify(e.customize)) continue;
                if (!opts.overwrite) { out.conflicts.push('知識 ' + e.kind + ':' + e.key + '：你已經有不同的版本，保留你的（要覆蓋請帶 overwrite）'); out.kept_yours++; continue; }
                userDefs.typed.splice(i, 1);
            }
            userDefs.typed.push(Object.assign({}, e, { src: e.src || 'bundle', by: e.by || 'import', at: e.at || when })); out.entries++;
        }
        return out;
    }

    // ===== 知識資料（使用者／AI 補的定義）的格式版本與遷移：純函式，host 只負責讀寫儲存、備份、問使用者 =====
    // 見 DESIGN.knowledge-types.md §11、DESIGN.knowledge-portability.md。v0＝沒有 _format 欄位的舊格式（一律這樣稱呼）；v1＝加上 _format 封套，並備好 types 與 typed 兩個容器。
    // 遷移是宣告式的（不跑程式碼）：op 只有 default（補預設值）、rename、move、drop、stamp（寫入格式封套）。永遠只做向前遷移；要退回用備份還原。
    const FORMAT = { name: 'fa-ref-user-defs', current: 1 };
    const MIGRATIONS = [
        { from: 0, to: 1, label: '加上格式版本號，並備好 types／typed 兩個容器（既有的錯誤碼、命令、規則、通用知識…全部原樣保留）',
            steps: [{ op: 'default', path: 'types', value: {} }, { op: 'default', path: 'typed', value: [] }, { op: 'stamp' }] },
    ];
    function countStore(d) {
        const c = { errors: 0, commands: 0, options: 0, pragmas: 0, clauses: 0, generic: 0, buildRules: 0, typed: 0, types: 0 };
        if (!d || typeof d !== 'object') return c;
        for (const l of Object.values(d.errors || {})) c.errors += Array.isArray(l) ? l.length : 0;
        c.commands = Object.keys(d.commands || {}).length;
        for (const l of Object.values(d.options || {})) c.options += Array.isArray(l) ? l.length : 0;
        for (const k of ['pragmas', 'clauses', 'generic', 'buildRules', 'typed']) c[k] = Array.isArray(d[k]) ? d[k].length : 0;
        c.types = d.types && typeof d.types === 'object' ? Object.keys(d.types).length : 0;
        return c;
    }
    // raw：host 讀出來的 { text, data, error }（text＝原始 JSON 字串，data＝解析後；沒有資料時兩者都是 null）。
    // 回傳 { version, current, status: 'empty'|'current'|'outdated'|'newer'|'error', counts, bytes }
    function formatInfo(raw) {
        const current = FORMAT.current; raw = raw || {};
        if (raw.error) return { version: null, current, status: 'error', error: raw.error, counts: countStore(null), bytes: 0 };
        if (!raw.data || typeof raw.data !== 'object') return { version: current, current, status: 'empty', counts: countStore(null), bytes: 0 };
        const v = raw.data._format && Number.isFinite(Number(raw.data._format.version)) ? Number(raw.data._format.version) : 0;
        return { version: v, current, status: v === current ? 'current' : (v < current ? 'outdated' : 'newer'), counts: countStore(raw.data), bytes: (raw.text || '').length };
    }
    function applyStep(d, s) {
        const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
        const setp = (o, p, v) => { const ks = p.split('.'); let x = o; for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null || typeof x[ks[i]] !== 'object') x[ks[i]] = {}; x = x[ks[i]]; } x[ks[ks.length - 1]] = v; };
        const delp = (o, p) => { const ks = p.split('.'); let x = o; for (let i = 0; i < ks.length - 1; i++) { x = x && x[ks[i]]; } if (x && typeof x === 'object') delete x[ks[ks.length - 1]]; };
        const log = [];
        if (s.op === 'default') { if (get(d, s.path) === undefined) { setp(d, s.path, JSON.parse(JSON.stringify(s.value))); log.push('新增欄位 ' + s.path); } }
        else if (s.op === 'rename' || s.op === 'move') { const v = get(d, s.path); if (v !== undefined) { setp(d, s.to, v); delp(d, s.path); log.push((s.op === 'rename' ? '改名 ' : '搬移 ') + s.path + ' → ' + s.to); } }
        else if (s.op === 'drop') { if (get(d, s.path) !== undefined) { delp(d, s.path); log.push('移除 ' + s.path); } }
        else if (s.op === 'stamp') { /* 在 migrationPlan 每一步結束時依目標版本寫入 */ }
        else throw new Error('不認得的遷移動作：' + s.op);
        return log;
    }
    // 預演：不寫入任何東西。回傳 { ok, from, to, steps:[{from,to,label,log}], before, after, warnings, result } 或 { ok:false, error } 或 { ok:true, nothing:true }
    function migrationPlan(raw, target) {
        const info = formatInfo(raw);
        target = Number.isFinite(Number(target)) ? Number(target) : info.current;
        if (target > info.current) return { ok: false, error: `目標版本 v${target} 比這個程式支援的（v${info.current}）新，請更新程式` };
        if (info.status === 'error') return { ok: false, error: '讀取知識資料失敗：' + info.error };
        if (info.status === 'newer') return { ok: false, error: `資料格式是 v${info.version}，比這個版本認得的（v${info.current}）新，已進入唯讀，不能遷移也不會被覆寫。請更新程式。` };
        if (info.status === 'current' || info.status === 'empty' || info.version >= target) return { ok: true, nothing: true, from: info.version, to: Math.max(info.version, target), before: info.counts, after: info.counts, steps: [], warnings: [] };
        const d = JSON.parse(JSON.stringify(raw.data));
        const steps = []; let v = info.version; const warnings = [];
        while (v < target) {
            const m = MIGRATIONS.find((x) => x.from === v);
            if (!m) return { ok: false, error: `沒有從 v${v} 遷移的步驟（找不到 ${v} → ${v + 1}）` };
            const log = [];
            for (const s of m.steps) { try { log.push(...applyStep(d, s)); } catch (e) { return { ok: false, error: `遷移 v${m.from} → v${m.to} 失敗：${String((e && e.message) || e)}` }; } }
            d._format = { name: FORMAT.name, version: m.to, migratedAt: Date.now(), from: m.from };
            log.push('寫入格式版本 v' + m.to);
            steps.push({ from: m.from, to: m.to, label: m.label, log });
            v = m.to;
        }
        // 非破壞性檢查：原本的每個欄位都要原樣還在（只允許多出新欄位）
        const lost = Object.keys(raw.data).filter((k) => JSON.stringify(raw.data[k]) !== JSON.stringify(d[k]));
        if (lost.length) return { ok: false, error: '遷移會改到既有欄位（' + lost.join('、') + '），為了保護你已經訓練的資料，已中止、沒有寫入任何東西。' };
        return { ok: true, from: info.version, to: info.current, steps, before: info.counts, after: countStore(d), warnings, result: d };
    }
    return { create, PACK_FORMAT, exportPack, inspectPack, mergePack, FORMAT, MIGRATIONS, countStore, formatInfo, applyStep, migrationPlan };
