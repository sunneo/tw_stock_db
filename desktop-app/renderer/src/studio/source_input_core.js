/* 資料匯入的「輸入欄位」核心（UMD，依賴注入，不碰 DOM／網路／檔案系統）。設計 §13.3、§15.4。
 * 把使用者貼的輸入（本機路徑、檔案存取資料夾參照 fap:…、GitHub wiki／原始檔網址，可多行＝多個資料夾）展開成匯入核心吃的 files 陣列
 * [{path, content|null, size, origin}]，並回報每個輸入的來源、檔數、位元組數與失敗原因（畫面顯示來源與大小）。
 *   parseLine(line) → {type:'path'|'fap'|'url', value}
 *   classifyUrl(url) → {ok, kind:'wiki'|'raw'|'github_blob'|'other', owner, repo, page, rawBase, host, error}
 *   expandInputs(inputs, d, o) → async { files, sources[] }
 *   d：{ localReadDir(path)→[{name,type,size}]|null, localStat(path)→{isFile,isDir,size}|null, localReadFile(path)→string,
 *        fapList(ref)→{entries:[{name,type,sizeBytes}]}, fapRead(ref)→string,
 *        fetchUrl(url)→{ok,status,text,bytes,contentType,finalUrl,error} }（缺的接口＝該類型輸入回「這個環境沒有…」的具體原因）
 * 規則：跳過 .git／node_modules、二進位副檔名、過大檔（預設 1MB）；最多 maxFiles 個檔（預設 3000）；wiki 最多 maxPages 頁（預設 40）。
 * 網址只抓文字（.md／.txt／.html／wiki 頁），不下載二進位；抓取前由呼叫端先取得使用者確認（planUrls 列出要連線的網址）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioSourceInput = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const BIN = /\.(png|jpe?g|gif|webp|bmp|ico|zip|gz|tgz|7z|rar|pdf|exe|dll|so|dylib|wasm|bin|onnx|safetensors|mp[34]|wav|ogg|webm|mov|woff2?|ttf|otf|sqlite3?|db)$/i;
    const SKIP_DIR = /(^|\/)(\.git|node_modules)(\/|$)/;
    const TEXT_URL = /\.(md|markdown|txt|html?|rst)$/i;
    const LIM = { maxFiles: 3000, maxBytes: 1048576, maxPages: 40, maxUrlBytes: 2097152 };
    const norm = (p) => String(p).replace(/\\/g, '/');
    function parseLine(line) {
        const v = String(line || '').trim(); if (!v) return null;
        if (/^https?:\/\//i.test(v)) return { type: 'url', value: v };
        if (/^fap:/i.test(v)) return { type: 'fap', value: v };
        return { type: 'path', value: v };
    }
    function classifyUrl(url) {
        let u; try { u = new URL(url); } catch (_) { return { ok: false, error: '不是合法網址：' + url }; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: '只支援 http／https' };
        const host = u.hostname.toLowerCase(), parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (host === 'github.com' && parts.length >= 3 && parts[2] === 'wiki') return { ok: true, kind: 'wiki', host, owner: parts[0], repo: parts[1], page: parts[3] || null, rawBase: 'https://raw.githubusercontent.com/wiki/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]) + '/' };
        if (host === 'github.com' && parts.length >= 5 && parts[2] === 'blob') return { ok: true, kind: 'github_blob', host, owner: parts[0], repo: parts[1], rawUrl: 'https://raw.githubusercontent.com/' + parts[0] + '/' + parts[1] + '/' + parts.slice(3).join('/') };
        if (host === 'raw.githubusercontent.com') return { ok: true, kind: 'raw', host, rawUrl: u.href };
        if (host === 'github.com' && parts.length === 2) return { ok: false, error: '這是倉庫首頁，不是 wiki：若要抓 wiki 請貼 https://github.com/' + parts[0] + '/' + parts[1] + '/wiki；若要整個開源專案請 clone 後用本機路徑（本功能不下載壓縮檔）' };
        return { ok: true, kind: 'other', host, rawUrl: u.href };
    }
    // 抓取前要讓使用者確認的清單：實際會連線的主機與網址
    function planUrls(inputs) {
        return (inputs || []).filter((i) => i.type === 'url').map((i) => { const c = classifyUrl(i.value); if (!c.ok) return { url: i.value, ok: false, error: c.error }; const will = c.kind === 'wiki' ? [c.rawBase + (c.page ? c.page + '.md' : '_Sidebar.md／Home.md 及其中連到的頁面（最多 ' + LIM.maxPages + ' 頁）')] : [c.rawUrl]; return { url: i.value, ok: true, kind: c.kind, host: c.kind === 'wiki' || c.kind === 'github_blob' ? 'raw.githubusercontent.com' : c.host, willFetch: will }; });
    }
    const wikiLinks = (text) => { const out = []; const re = /\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]|\]\(([^)#\s]+)\)/g; let m; while ((m = re.exec(text))) { let p = m[3] || m[2] || m[1]; if (!p || /^[a-z]+:/i.test(p)) continue; p = p.replace(/^\.\//, '').replace(/\.md$/i, ''); if (m[1] && !m[3]) p = (m[2] ? m[2] : m[1]).trim().replace(/\s+/g, '-'); out.push(p); } return out; };

    async function expandInputs(inputs, d, o) {
        d = d || {}; const lim = Object.assign({}, LIM, o || {}); const files = [], sources = []; let budget = lim.maxFiles;
        for (const inp of inputs || []) {
            const src = { type: inp.type, value: inp.value, ok: false, files: 0, bytes: 0, skipped: 0 };
            const addText = (rel, size, text) => { if (budget <= 0) { src.skipped++; return; } if (text == null) { skip(rel, size); return; } budget--; src.files++; src.bytes += size == null ? text.length : size; files.push({ path: norm(rel), content: text, size: size == null ? text.length : size, origin: inp.value }); };
            const skip = (rel, size) => { src.skipped++; files.push({ path: norm(rel), content: null, size: size || 0, origin: inp.value }); };
            const bad = (rel, size) => SKIP_DIR.test(norm(rel)) || BIN.test(rel) || (size != null && size > lim.maxBytes);
            try {
                if (inp.type === 'path') {
                    if (!d.localReadDir || !d.localReadFile) { src.error = '這個環境不能用路徑讀本機檔案（網頁版瀏覽器的沙盒不允許）；改用「選檔案／資料夾」按鈕，或用檔案存取資料夾參照 fap:<名稱>'; sources.push(src); continue; }
                    const rootP = norm(inp.value).replace(/\/+$/, ''); const st = d.localStat ? await d.localStat(rootP) : null;
                    if (st && st.isFile) { const nm = rootP.split('/').pop(); if (bad(nm, st.size)) skip(nm, st.size); else addText(nm, st.size, await d.localReadFile(rootP)); }
                    else {
                        const walk = async (dir, rel) => { const ents = await d.localReadDir(dir); if (!ents) throw new Error('讀不到資料夾：' + dir); for (const e of ents) { if (budget <= 0) break; const r = rel ? rel + '/' + e.name : e.name; if (e.type === 'directory' || e.isDir) { if (!SKIP_DIR.test(r + '/')) await walk(dir + '/' + e.name, r); } else if (bad(r, e.size)) skip(r, e.size); else addText(r, e.size, await d.localReadFile(dir + '/' + e.name)); } };
                        await walk(rootP, '');
                    }
                    src.ok = src.files > 0; if (!src.ok) src.error = '沒有可讀的文字檔（略過 ' + src.skipped + ' 個）';
                } else if (inp.type === 'fap') {
                    if (!d.fapList || !d.fapRead) { src.error = '這個環境沒有檔案存取資料夾（先在設定授權一個資料夾，格式 fap:<名稱>[/子路徑]）'; sources.push(src); continue; }
                    const walk = async (ref, rel) => { const r = await d.fapList(ref); for (const e of (r && r.entries) || []) { if (budget <= 0) break; const rr = rel ? rel + '/' + e.name : e.name; if (e.type === 'directory') { if (!SKIP_DIR.test(rr + '/')) await walk(ref + '/' + e.name, rr); } else if (bad(rr, e.sizeBytes)) skip(rr, e.sizeBytes); else addText(rr, e.sizeBytes, await d.fapRead(ref + '/' + e.name)); } };
                    await walk(inp.value.replace(/\/+$/, ''), ''); src.ok = src.files > 0; if (!src.ok) src.error = '參照裡沒有可讀的文字檔（略過 ' + src.skipped + ' 個）';
                } else if (inp.type === 'url') {
                    if (!d.fetchUrl) { src.error = '這個環境不能連網抓取（沒有 fetchUrl）'; sources.push(src); continue; }
                    const c = classifyUrl(inp.value); if (!c.ok) { src.error = c.error; sources.push(src); continue; }
                    src.kind = c.kind; src.fetched = [];
                    const get = async (url) => { const r = await d.fetchUrl(url); src.fetched.push({ url, ok: !!(r && r.ok), status: r && r.status, bytes: r && r.bytes, error: r && r.error }); if (!r || !r.ok) return null; if (r.bytes > lim.maxUrlBytes) { src.fetched[src.fetched.length - 1].error = '超過 ' + lim.maxUrlBytes + ' 位元組上限'; return null; } if (r.contentType && !/text|markdown|json|xml/i.test(r.contentType)) { src.fetched[src.fetched.length - 1].error = '不是文字內容（' + r.contentType + '），不收'; return null; } return r; };
                    if (c.kind === 'wiki') {
                        const pages = new Map(); const addPage = async (name) => { if (pages.has(name) || pages.size >= lim.maxPages) return; const r = await get(c.rawBase + encodeURIComponent(name) + '.md'); pages.set(name, r); if (r) addText(name + '.md', r.bytes, r.text); };
                        if (c.page) await addPage(c.page);
                        else { const sb = await get(c.rawBase + '_Sidebar.md'); const hm = await get(c.rawBase + 'Home.md'); const names = new Set(['Home']); [sb, hm].forEach((r) => { if (r) wikiLinks(r.text).forEach((p) => names.add(p)); }); if (hm) { pages.set('Home', hm); addText('Home.md', hm.bytes, hm.text); } for (const n of names) { if (n === 'Home') continue; await addPage(n); } if (sb) addText('_Sidebar.md', sb.bytes, sb.text); }
                    } else { const r = await get(c.rawUrl); if (r) { const nm = (new URL(c.rawUrl).pathname.split('/').pop() || 'index') + (TEXT_URL.test(c.rawUrl) ? '' : '.txt'); addText(nm, r.bytes, r.text); } }
                    src.ok = src.files > 0; if (!src.ok) src.error = (src.fetched.find((f) => f.error) || {}).error || '沒有抓到可用的文字內容（狀態：' + src.fetched.map((f) => f.status).join('、') + '）';
                } else src.error = '不認得的輸入類型：' + inp.type;
            } catch (e) { src.ok = false; src.error = String((e && e.message) || e); }
            sources.push(src);
        }
        return { files, sources, totalBytes: sources.reduce((n, s) => n + s.bytes, 0) };
    }
    // 常用來源釘選（純函式；呼叫端負責存偏好）
    const PIN_MAX = 30;
    function addPin(pins, p) { pins = Array.isArray(pins) ? pins.slice() : []; const t = String(p.type || ''); const v = String(p.value || '').trim(); if (['path', 'fap', 'url'].indexOf(t) < 0 || !v) return { ok: false, error: '釘選要有 type（path／fap／url）與 value' }; if (pins.some((x) => x.type === t && x.value === v)) return { ok: false, error: '已經釘選過了' }; if (pins.length >= PIN_MAX) return { ok: false, error: '最多釘選 ' + PIN_MAX + ' 個' }; const pin = { id: 'p' + Date.now().toString(36) + pins.length, label: String(p.label || v).slice(0, 60), type: t, value: v }; pins.push(pin); return { ok: true, pins, pin }; }
    function removePin(pins, id) { const a = (pins || []).filter((x) => x.id !== id); return { ok: a.length !== (pins || []).length, pins: a }; }
    return { parseLine, classifyUrl, planUrls, expandInputs, addPin, removePin, LIM, BIN, wikiLinks };
});
