
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
        const U = { errors: {}, commands: {}, options: {}, pragmas: [], clauses: [], generic: [] };
        const idx = { built: false, byName: new Map(), bySys: {}, cmdAlias: new Map(), errNameRe: null };
        function mergeUser(u) {
            U.errors = {}; U.commands = {}; U.options = {}; U.pragmas = []; U.clauses = []; U.generic = [];
            if (!u) return;
            for (const [s, l] of Object.entries(u.errors || {})) U.errors[s] = l.slice();
            Object.assign(U.commands, u.commands || {}); Object.assign(U.options, u.options || {});
            U.pragmas = (u.pragmas || []).slice(); U.clauses = (u.clauses || []).slice(); U.generic = (u.generic || []).slice();
        }
        const allGeneric = () => (data.generic || []).concat(U.generic);
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
            const numToks = q.match(/-?0x[0-9a-fA-F]+|(?<![A-Za-z_])-?\d{1,10}(?![A-Za-z_])/g) || [];
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
            for (const g of allGeneric()) { const hay = ((g.key || '') + ' ' + (g.text || '') + ' ' + (g.tags || []).join(' ')).toLowerCase(); let sc = 0; for (const w of words) if (hay.indexOf(w) >= 0) sc++; if (sc && sc >= Math.min(2, words.length)) out.results.push({ kind: g.kind, key: g.key, text: g.text, source: g.src || undefined, _s: sc }); }
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
            u = u || U; const out = { errors_dsl: '', commands_dsl: '', pragmas_dsl: '', generic: [] };
            const el = []; for (const [s, rows] of Object.entries(u.errors || {})) { if (!rows.length) continue; el.push('@' + s); for (const r of rows) el.push([r.code, clean(r.name), clean(r.msg), clean((r.note || '') + (r.src ? '（來源：' + r.src + '）' : ''))].join(' | ')); } out.errors_dsl = el.join('\n') + (el.length ? '\n' : '');
            const cl = []; const names = new Set(Object.keys(u.commands || {}).concat(Object.keys(u.options || {})));
            for (const n of names) { const c = (u.commands || {})[n] || {}; cl.push('## ' + [clean(n), (c.aliases || []).map(clean).join(','), clean(c.summary || ''), clean(c.synopsis || '')].join(' | ')); for (const o of (c.options || []).concat((u.options || {})[n] || [])) cl.push([clean(o.flag), clean(o.arg || ''), clean(o.desc || '') + (o.src ? '（來源：' + clean(o.src) + '）' : '')].join(' | ')); } out.commands_dsl = cl.join('\n') + (cl.length ? '\n' : '');
            const pl = []; if ((u.pragmas || []).length) { pl.push('@pragma'); for (const p of u.pragmas) pl.push(clean(p.key) + ' | ' + clean(p.desc) + (p.src ? '（來源：' + clean(p.src) + '）' : '')); } if ((u.clauses || []).length) { pl.push('@clause'); for (const p of u.clauses) pl.push(clean(p.key) + ' | ' + clean(p.desc) + (p.src ? '（來源：' + clean(p.src) + '）' : '')); } out.pragmas_dsl = pl.join('\n') + (pl.length ? '\n' : '');
            out.generic = (u.generic || []).map((g) => ({ kind: g.kind, key: g.key, text: g.text, tags: g.tags || [], rules: g.rules || undefined, src: g.src || '' }));
            return out;
        }
        return {
            exportBuiltin, setUser(u) { mergeUser(u); idx.built = false; }, lookup, lookupError, lookupCommand, explainCommandLine, explainPragma, annotateText, tokenize, hresultDecode, ntDecode, errorLine, tokenizeShell,
            stats() { ensure(); const e = {}; for (const [k, m] of Object.entries(idx.bySys)) e[k] = m.size; const c = Object.keys(data.commands || {}).length + Object.keys(U.commands).length; let o = 0; for (const x of Object.values(data.commands || {})) o += (x.options || []).length; return { errors: e, commands: c, options: o, pragmas: (data.pragmas || []).length + U.pragmas.length, clauses: (data.clauses || []).length + U.clauses.length, generic: allGeneric().length }; },
        };
    }
    return { create };
