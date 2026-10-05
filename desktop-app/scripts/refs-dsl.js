// 參考知識（錯誤碼、命令說明、pragma）的來源檔是 renderer/src/refs/*.dsl（純文字，好編輯、好 diff）。
// 這個模組把它們轉成 FA_REF_DATA 的物件；embed-code-ui.js 嵌進 floating-assistant.js，測試也直接 require。
//
// 格式（每行用「 | 」分欄，# 開頭是註解）：
//   errors.dsl   ：@區段名（linux_errno／win32／hresult／ntstatus／winsock／signal／exit）
//                  之後每行：代碼 | 名稱 | 原文訊息 | 白話說明（可省略）
//   commands.dsl ：## 名稱 | 別名（逗號分隔，可空） | 摘要 | 用法
//                  之後每行：選項 | 參數（沒有就空） | 說明；
//                  選項結尾是 * 代表前綴比對（例如 -O* 、-l*、-I*）；
//                  @sub 名稱 開一個子選項表（qemu 的 -drive／-device 等的 key=value）：key | 說明
//                  @list 名稱 開一個清單（qemu 的 machines／cpus）：名稱 | 說明
//   pragmas.dsl  ：@pragma 區段：每行 指令 | 白話說明；@clause 區段：子句 | 白話說明
const fs = require('fs'), path = require('path');
const cols = (line) => line.split(' | ').map((s) => s.trim());
function parseErrors(text) {
    const out = {}; let sec = null;
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.trim(); if (!line || line[0] === '#') continue;
        if (line[0] === '@') { sec = line.slice(1).trim(); out[sec] = []; continue; }
        if (!sec) continue; const [code, name, msg, note] = cols(line);
        out[sec].push({ code, name: name || '', msg: msg || '', note: note || '' });
    }
    return out;
}
function parseCommands(text) {
    const out = {}; let cur = null, sub = null, list = null;
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.trim(); if (!line || (line[0] === '#' && !line.startsWith('## '))) continue;
        if (line.startsWith('## ')) { const [name, aliases, summary, synopsis] = cols(line.slice(3)); if (out[name]) { cur = out[name]; if (summary && !cur.summary) cur.summary = summary; if (synopsis && !cur.synopsis) cur.synopsis = synopsis; for (const a of (aliases || '').split(',').map((s) => s.trim()).filter(Boolean)) if (cur.aliases.indexOf(a) < 0) cur.aliases.push(a); sub = list = null; continue; } cur = out[name] = { name, aliases: (aliases || '').split(',').map((s) => s.trim()).filter(Boolean), summary: summary || '', synopsis: synopsis || '', options: [], subs: {}, lists: {} }; sub = list = null; continue; }
        if (!cur) continue;
        if (line.startsWith('@sub ')) { sub = cur.subs[line.slice(5).trim()] = []; list = null; continue; }
        if (line.startsWith('@list ')) { list = cur.lists[line.slice(6).trim()] = []; sub = null; continue; }
        if (line.startsWith('@inherit ')) { cur.inherit = line.slice(9).trim(); continue; }
        if (line === '@options') { sub = list = null; continue; }
        const c = cols(line);
        if (sub) sub.push({ key: c[0], desc: c[1] || '' });
        else if (list) list.push({ name: c[0], desc: c[1] || '' });
        else cur.options.push({ flag: c[0], arg: c[1] || '', desc: c[2] || '' });
    }
    return out;
}
function resolveInherit(out) {
    const done = {}; const resolve = (n) => { if (done[n]) return; done[n] = true; const c = out[n]; if (!c || !c.inherit) return; const p = out[c.inherit]; if (!p) return; resolve(c.inherit); c.options = c.options.concat(p.options.filter((o) => !c.options.some((x) => x.flag === o.flag))); for (const [k, v] of Object.entries(p.subs)) if (!c.subs[k]) c.subs[k] = v; for (const [k, v] of Object.entries(p.lists)) if (!c.lists[k]) c.lists[k] = v; };
    Object.keys(out).forEach(resolve); return out;
}
function parsePragmas(text) {
    const out = { pragmas: [], clauses: [] }; let sec = null;
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.trim(); if (!line || line[0] === '#') continue;
        if (line[0] === '@') { sec = line.slice(1).trim(); continue; }
        const c = cols(line); if (sec === 'pragma') out.pragmas.push({ key: c[0], desc: c[1] || '' }); else if (sec === 'clause') out.clauses.push({ key: c[0], desc: c[1] || '' });
    }
    return out;
}
// 建置錯誤規則：## id | 系統 | 層級（root 根本原因／cascade 連帶結果／warn 警告）
//   re: 正規表示式（逐行比對，不分大小寫，可用具名群組 (?<名稱>…)）
//   what: 發生什麼事（白話，可用 {名稱} 或 {1}）；cause: 常見原因（可重複）；fix: 怎麼處理（可重複）；see: 相關說明（選填）
function parseBuildRules(text) {
    const out = []; let cur = null;
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.replace(/\s+$/, ''); if (!line.trim() || (line.trim()[0] === '#' && !line.startsWith('## '))) continue;
        if (line.startsWith('## ')) { const [id, system, level] = cols(line.slice(3)); cur = { id, system: system || 'any', level: String(level || 'root').replace(/!$/, ''), once: /!$/.test(level || ''), re: '', start: '', span: '', what: '', causes: [], fixes: [], see: '' }; out.push(cur); continue; }
        if (!cur) continue; const m = /^(re|start|span|what|cause|fix|see):\s?(.*)$/.exec(line.trim()); if (!m) continue;
        if (m[1] === 're') cur.re = m[2]; else if (m[1] === 'start') cur.start = m[2]; else if (m[1] === 'span') cur.span = m[2]; else if (m[1] === 'what') cur.what = m[2]; else if (m[1] === 'cause') cur.causes.push(m[2]); else if (m[1] === 'fix') cur.fixes.push(m[2]); else cur.see = m[2];
    }
    return out;
}
function build(dir) {
    const rd = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
    const errors = {}; for (const f of fs.readdirSync(dir).filter((x) => /^errors.*\.dsl$/.test(x))) { const e = parseErrors(rd(f)); for (const [k, v] of Object.entries(e)) errors[k] = (errors[k] || []).concat(v); }
    const commands = {}; for (const f of fs.readdirSync(dir).filter((x) => /^commands.*\.dsl$/.test(x)).sort()) { const part = parseCommands(rd(f)); for (const [n, c] of Object.entries(part)) { const o = commands[n]; if (!o) { commands[n] = c; continue; } for (const op of c.options) if (!o.options.some((x) => x.flag === op.flag)) o.options.push(op); for (const [k, v] of Object.entries(c.subs)) o.subs[k] = (o.subs[k] || []).concat(v.filter((r) => !(o.subs[k] || []).some((x) => x.key === r.key))); for (const [k, v] of Object.entries(c.lists)) o.lists[k] = (o.lists[k] || []).concat(v.filter((r) => !(o.lists[k] || []).some((x) => x.name === r.name))); for (const a of c.aliases) if (o.aliases.indexOf(a) < 0) o.aliases.push(a); if (!o.summary) o.summary = c.summary; } }
    resolveInherit(commands);
    const buildRules = []; for (const f of fs.readdirSync(dir).filter((x) => /^buildrules.*\.dsl$/.test(x)).sort()) for (const r of parseBuildRules(rd(f))) { const i = buildRules.findIndex((x) => x.id === r.id); if (i >= 0) buildRules[i] = r; else buildRules.push(r); }
    const pr = { pragmas: [], clauses: [] }; for (const f of fs.readdirSync(dir).filter((x) => /^pragmas.*\.dsl$/.test(x))) { const p = parsePragmas(rd(f)); pr.pragmas.push(...p.pragmas); pr.clauses.push(...p.clauses); }
    const generic = []; for (const f of fs.readdirSync(dir).filter((x) => /^generic.*\.json$/.test(x))) { try { const a = JSON.parse(rd(f)); if (Array.isArray(a)) generic.push(...a); } catch (_) {} }
    return { version: 1, errors, commands, pragmas: pr.pragmas, clauses: pr.clauses, generic, buildRules };
}
module.exports = { parseBuildRules, resolveInherit, build, parseErrors, parseCommands, parsePragmas };
