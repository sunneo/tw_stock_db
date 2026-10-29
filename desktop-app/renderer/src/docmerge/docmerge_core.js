/* 文件合併成 PDF 的核心（UMD，純函式，不碰 DOM／canvas／檔案）：文字檔、docx、xlsx 的「簡化版」轉換——沒有 Word／Excel／LibreOffice 可用時的備援，
 * 以及判斷檔案種類。完整保真的轉換（版面、圖片、字型）要靠 Word／Excel／LibreOffice（桌面版優先用它們，見 floating-assistant.js 的 _docMergeConvertOffice）。
 * 簡化版只保留：文字、段落／標題、清單符號、表格（docx）、工作表的儲存格內容（xlsx，日期序號會轉成日期）。圖片、圖表、頁首頁尾、字型、顏色都不保留。
 *  - readZip(u8)           ：讀 zip（docx／xlsx／pptx 都是 zip），用瀏覽器／Node 內建的 DecompressionStream，不需要 JSZip
 *  - sniffDoc(u8, name)    ：判斷種類 pdf／image／docx／xlsx／pptx／rtf／ole（舊版 doc／xls／ppt）／text／unknown
 *  - decodeText(u8)        ：UTF-8／UTF-16（含 BOM）、Big5、GBK、Windows-1252 依序嘗試
 *  - docxToBlocks／xlsxToBlocks：轉成區塊（段落、標題、表格、換頁）
 *  - layoutBlocks          ：把區塊排成頁（只算位置，量字寬由呼叫端給 measure，所以在 Node 裡也能測試） */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaDocMerge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const td = (enc, fatal) => new TextDecoder(enc, { fatal: !!fatal });

    // ───────────────────────── zip ─────────────────────────
    async function inflateRaw(u8) {
        if (typeof DecompressionStream === 'undefined' && typeof module === 'object' && module.exports && typeof require === 'function') { return new Uint8Array(require('zlib').inflateRawSync(u8)); }   // Node 18 以前沒有 DecompressionStream（只有測試會走到）
        const ds = new DecompressionStream('deflate-raw'); const w = ds.writable.getWriter(); w.write(u8); w.close();
        const buf = await new Response(ds.readable).arrayBuffer(); return new Uint8Array(buf);
    }
    async function readZip(u8, want) {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let eocd = -1;
        for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        if (eocd < 0) throw new Error('不是有效的 zip（docx／xlsx 檔案可能損毀）');
        const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true); const files = new Map();
        for (let k = 0; k < n; k++) {
            if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip 目錄損毀');
            const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
            const name = td('utf-8').decode(u8.subarray(p + 46, p + 46 + nlen)); p += 46 + nlen + elen + clen;
            if (want && !want(name)) { files.set(name, null); continue; }
            const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true), start = lho + 30 + lnl + lel; const raw = u8.subarray(start, start + csize);
            files.set(name, method === 0 ? raw : (method === 8 ? await inflateRaw(raw) : null));
        }
        return files;
    }
    const str = (files, name) => { const b = files.get(name); return b ? td('utf-8').decode(b) : ''; };

    // ───────────────────────── 種類判斷 ─────────────────────────
    function decodeText(u8) {
        if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return td('utf-8').decode(u8.subarray(3));
        if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return td('utf-16le').decode(u8.subarray(2));
        if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return td('utf-16be').decode(u8.subarray(2));
        for (const enc of ['utf-8', 'big5', 'gbk']) { try { return td(enc, true).decode(u8); } catch (_) { /* 換下一個 */ } }
        return td('windows-1252').decode(u8);
    }
    const TEXT_EXT = /\.(txt|text|log|md|markdown|csv|tsv|json|jsonl|xml|html?|ya?ml|ini|cfg|conf|toml|properties|py|js|mjs|ts|tsx|jsx|c|h|cc|cpp|hpp|cs|java|kt|go|rs|rb|php|sh|bash|bat|cmd|ps1|sql|css|scss|lua|swift|r|pl|vb|tex|rst|srt|vtt|diff|patch|env|gitignore)$/i;
    function looksText(u8) {
        const n = Math.min(u8.length, 4096); if (!n) return true; let ctl = 0;
        if (u8.length >= 2 && ((u8[0] === 0xFF && u8[1] === 0xFE) || (u8[0] === 0xFE && u8[1] === 0xFF))) return true;
        for (let i = 0; i < n; i++) { const c = u8[i]; if (c === 0) return false; if (c < 9 || (c > 13 && c < 32)) ctl++; }
        return ctl / n < 0.02;
    }
    // 回傳 { kind, detail }：kind＝pdf／image／docx／xlsx／pptx／rtf／ole／text／unknown。圖片的格式細節由 images_to_pdf 那邊用內容判斷，這裡只認「是圖片」。
    async function sniffDoc(u8, name) {
        const a4 = (i) => String.fromCharCode(u8[i] || 0, u8[i + 1] || 0, u8[i + 2] || 0, u8[i + 3] || 0);
        if (a4(0) === '%PDF') return { kind: 'pdf' };
        if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return { kind: 'image' };
        if (u8[0] === 0x89 && a4(1).startsWith('PNG')) return { kind: 'image' };
        if (a4(0) === 'GIF8' || (a4(0) === 'RIFF' && a4(8) === 'WEBP')) return { kind: 'image' };
        if (u8[0] === 0x42 && u8[1] === 0x4D && [12, 40, 52, 56, 64, 108, 124].includes((u8[14] || 0) | ((u8[15] || 0) << 8))) return { kind: 'image' };
        if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2A && u8[3] === 0) || (u8[0] === 0x4D && u8[1] === 0x4D && u8[2] === 0 && u8[3] === 0x2A)) return { kind: 'image', detail: 'tiff' };
        if (a4(4) === 'ftyp' && /^(avif|avis|heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(a4(8))) return { kind: 'image' };
        if (u8[0] === 0 && u8[1] === 0 && (u8[2] === 1 || u8[2] === 2) && u8[3] === 0 && u8[4] > 0 && u8[4] < 64) return { kind: 'image' };
        if (a4(0) === '{\\rt') return { kind: 'rtf' };
        if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) { const e = (String(name || '').match(/\.([a-z0-9]+)$/i) || [])[1] || ''; return { kind: 'ole', detail: e.toLowerCase() }; }
        if (u8[0] === 0x50 && u8[1] === 0x4B) {
            try { const files = await readZip(u8, () => false); const names = Array.from(files.keys());
                if (names.some((x) => x === 'word/document.xml')) return { kind: 'docx' }; if (names.some((x) => x === 'xl/workbook.xml')) return { kind: 'xlsx' }; if (names.some((x) => x === 'ppt/presentation.xml')) return { kind: 'pptx' };
                if (names.includes('content.xml') && names.includes('mimetype')) return { kind: 'odf' }; } catch (_) { /* 當成未知 */ }
            return { kind: 'unknown', detail: 'zip' };
        }
        const head = td('utf-8').decode(u8.subarray(0, 1024)).replace(/^﻿/, '').trimStart(); if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head))) return { kind: 'image', detail: 'svg' };
        if (TEXT_EXT.test(String(name || '')) && looksText(u8)) return { kind: 'text' };
        if (looksText(u8)) return { kind: 'text', detail: 'guess' };
        return { kind: 'unknown' };
    }

    // ───────────────────────── docx ─────────────────────────
    const ent = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10))).replace(/&amp;/g, '&');
    function paraOf(xml) {
        const style = (/<w:pStyle\s+w:val="([^"]+)"/.exec(xml) || [])[1] || ''; let level = 0; const hm = /^(?:heading|標題|title)\s*(\d)?/i.exec(style.replace(/\s+/g, '')); if (hm) level = Number(hm[1] || 1);
        if (/^Title$/i.test(style)) level = 1;
        let text = '', pagebreak = false, bold = false, first = true; const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\s*\/>|<w:br\s+w:type="page"\s*\/>|<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g; let m;
        // 逐個 run：第一個 run 有 <w:b/> 就把整段當粗體（簡化）
        const runRe = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g; while ((m = runRe.exec(xml))) {
            const r = m[1]; if (first && /<w:b(?:\s[^>]*)?\/>/.test(r) && !/<w:b\s+w:val="(?:0|false)"/.test(r)) bold = true; first = false;
            if (/<w:br\s+w:type="page"/.test(r)) pagebreak = true;
            const tre = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:br\s[^>]*\/>/g; let t; while ((t = tre.exec(r))) { if (t[1] != null) text += ent(t[1]); else if (/^<w:tab/.test(t[0])) text += '\t'; else if (!/type="page"/.test(t[0])) text += '\n'; }
        }
        void re;
        if (/<w:numPr>/.test(xml) && text) text = '• ' + text;
        return { text, level, bold, pagebreak };
    }
    function docxToBlocks(files) {
        const xml = str(files, 'word/document.xml'); if (!xml) throw new Error('docx 裡找不到 word/document.xml（檔案損毀或不是 docx）');
        const body = (/<w:body>([\s\S]*)<\/w:body>/.exec(xml) || [, xml])[1]; const blocks = []; let i = 0; let images = (xml.match(/<w:drawing|<w:pict/g) || []).length;
        while (i < body.length) {
            const tbl = body.indexOf('<w:tbl>', i), p1 = body.indexOf('<w:p>', i), p2 = body.indexOf('<w:p ', i); const pp = [p1, p2].filter((x) => x >= 0).sort((a, b) => a - b)[0];
            if (tbl < 0 && pp == null) break;
            if (tbl >= 0 && (pp == null || tbl < pp)) {
                let depth = 0, j = tbl; const tre = /<w:tbl>|<\/w:tbl>/g; tre.lastIndex = tbl; let m; while ((m = tre.exec(body))) { depth += m[0] === '<w:tbl>' ? 1 : -1; if (depth === 0) { j = m.index + m[0].length; break; } }
                const tx = body.slice(tbl, j); const rows = [];
                for (const rm of tx.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) { const cells = []; for (const cm of rm[1].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)) cells.push(Array.from(cm[1].matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)).map((x) => paraOf(x[0]).text).join('\n')); rows.push(cells); }
                if (rows.length) blocks.push({ type: 'table', rows }); i = j; continue;
            }
            const end = body.indexOf('</w:p>', pp); if (end < 0) break; const para = paraOf(body.slice(pp, end + 6)); i = end + 6;
            if (para.pagebreak) blocks.push({ type: 'pagebreak' });
            blocks.push({ type: 'p', text: para.text, level: para.level, bold: para.bold || para.level > 0 });
        }
        return { blocks, images };
    }

    // ───────────────────────── xlsx ─────────────────────────
    const colIndex = (ref) => { const m = /^([A-Z]+)/.exec(ref); let n = 0; for (const ch of m ? m[1] : 'A') n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
    const isoDate = (serial) => { const ms = Math.round((serial - 25569) * 86400000); const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); const hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + (hasTime ? ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) : ''); };
    function xlsxToBlocks(files, opts) {
        opts = opts || {}; const maxRows = opts.maxRows || 3000, maxCols = opts.maxCols || 40;
        const wb = str(files, 'xl/workbook.xml'); if (!wb) throw new Error('xlsx 裡找不到 xl/workbook.xml（檔案損毀或不是 xlsx）');
        const rels = {}; for (const m of str(files, 'xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s[^>]*>/g)) { const id = /Id="([^"]+)"/.exec(m[0]), tg = /Target="([^"]+)"/.exec(m[0]); if (id && tg) rels[id[1]] = tg[1]; }
        const shared = []; for (const m of str(files, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(ent(Array.from(m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)).map((x) => x[1]).join('')));
        const styles = str(files, 'xl/styles.xml'); const customDate = new Set(); for (const m of styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) if (/[ymdhs]/i.test(m[2].replace(/\[[^\]]*\]|"[^"]*"/g, ''))) customDate.add(Number(m[1]));
        const xfs = (/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles) || [, ''])[1]; const dateXf = []; Array.from(xfs.matchAll(/<xf\s[^>]*>/g)).forEach((m, i) => { const id = Number((/numFmtId="(\d+)"/.exec(m[0]) || [])[1] || 0); dateXf[i] = (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || customDate.has(id); });
        const blocks = []; const notes = [];
        for (const sm of wb.matchAll(/<sheet\s[^>]*>/g)) {
            const nm = /name="([^"]*)"/.exec(sm[0]), rid = /r:id="([^"]+)"/.exec(sm[0]); if (!nm || !rid) continue; let target = rels[rid[1]] || ''; target = target.replace(/^\//, ''); const path = target.startsWith('xl/') ? target : 'xl/' + target;
            const sx = str(files, path); if (!sx) continue; const rows = []; let truncated = false, maxC = 0;
            for (const rm of sx.matchAll(/<row\s[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
                const rn = Number((/\sr="(\d+)"/.exec(rm[0]) || [])[1] || rows.length + 1); if (rn > maxRows) { truncated = true; break; } const cells = [];
                for (const cm of (rm[1] || '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
                    const at = cm[1], inner = cm[2] || ''; const ref = (/\sr="([A-Z]+\d+)"|^r="([A-Z]+\d+)"/.exec(' ' + at) || [])[1] || (/r="([A-Z]+\d+)"/.exec(at) || [])[1]; const ci = ref ? colIndex(ref) : cells.length; if (ci >= maxCols) { truncated = true; continue; }
                    const t = (/\st="([^"]+)"/.exec(' ' + at) || [])[1] || 'n', sIdx = Number((/\ss="(\d+)"/.exec(' ' + at) || [])[1] || 0); let v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1]; let out = '';
                    if (t === 's') out = shared[Number(v)] || ''; else if (t === 'inlineStr') out = ent(Array.from(inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)).map((x) => x[1]).join('')); else if (t === 'b') out = v === '1' ? 'TRUE' : 'FALSE'; else if (v != null) { v = ent(v); if (t === 'n' && dateXf[sIdx] && isFinite(Number(v))) out = isoDate(Number(v)); else if (t === 'n' && isFinite(Number(v))) { const num = Number(v); out = Number.isInteger(num) ? String(num) : String(Math.round(num * 1e10) / 1e10); } else out = v; }
                    while (cells.length < ci) cells.push(''); cells[ci] = out; maxC = Math.max(maxC, ci + 1);
                }
                while (rows.length < rn - 1) rows.push([]); rows[rn - 1] = cells;
            }
            while (rows.length && !rows[rows.length - 1].some((c) => c !== '' && c != null)) rows.pop();
            if (truncated) notes.push('工作表「' + ent(nm[1]) + '」超過 ' + maxRows + ' 列或 ' + maxCols + ' 欄，只轉換前面的部分');
            blocks.push({ type: 'p', text: ent(nm[1]), level: 2, bold: true }); rows.forEach((r) => { for (let c = 0; c < maxC; c++) if (r[c] == null) r[c] = ''; });
            if (rows.length) blocks.push({ type: 'table', rows, compact: true }); else blocks.push({ type: 'p', text: '（空白工作表）', level: 0 });
            blocks.push({ type: 'pagebreak' });
        }
        if (blocks.length && blocks[blocks.length - 1].type === 'pagebreak') blocks.pop();
        return { blocks, notes };
    }

    // ───────────────────────── 排版 ─────────────────────────
    // opts: { pageW, pageH, margin, fontPx, lineH（倍數）, measure(text, {bold, mono, size}) → px, mono, header, footer }
    // 回傳 pages：每頁一個 ops 陣列：{t:'text', x, y, s, size, bold, mono} 或 {t:'line', x1, y1, x2, y2}（y 是文字頂端，向下為正）
    function wrapText(text, maxW, measure, font) {
        const out = [];
        for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
            const para = raw.replace(/\t/g, '    '); if (para === '') { out.push(''); continue; } let line = '', w = 0, lastSpace = -1;
            for (const ch of Array.from(para)) {
                const cw = measure(ch, font); if (w + cw > maxW && line) { if (lastSpace > 0 && ch !== ' ') { out.push(line.slice(0, lastSpace)); line = line.slice(lastSpace + 1); w = measure(line, font); } else { out.push(line); line = ''; w = 0; } lastSpace = -1; if (ch === ' ' && !line) continue; }
                line += ch; w += cw; if (ch === ' ') lastSpace = line.length - 1;
            }
            out.push(line);
        }
        return out;
    }
    function layoutBlocks(blocks, o) {
        const { pageW, pageH, margin } = o; const fontPx = o.fontPx || 21, lh = (o.lineH || 1.4); const topPad = o.header ? fontPx * 2 : 0, botPad = o.footer ? fontPx * 2 : 0;
        const left = margin, right = pageW - margin, top = margin + topPad, bottom = pageH - margin - botPad; const measure = o.measure; const pages = [[]]; let y = top;
        const cur = () => pages[pages.length - 1]; const newPage = () => { pages.push([]); y = top; };
        const place = (s, x, size, bold, mono) => { const h = size * lh; if (y + h > bottom && y > top) newPage(); cur().push({ t: 'text', x, y, s, size, bold: !!bold, mono: !!mono }); y += h; };
        for (const b of blocks) {
            if (b.type === 'pagebreak') { if (cur().length) newPage(); continue; }
            if (b.type === 'p') {
                const size = b.level ? Math.round(fontPx * ({ 1: 1.7, 2: 1.4, 3: 1.2 }[b.level] || 1.1)) : fontPx; const bold = b.bold || b.level > 0; const mono = !!o.mono && !b.level;
                if (b.level && y > top) y += size * 0.4; const lines = wrapText(b.text, right - left, measure, { bold, mono, size });
                for (const ln of lines) place(ln, left, size, bold, mono);
                y += (b.level ? 0.2 : 0.35) * fontPx * (o.mono ? 0 : 1); continue;
            }
            if (b.type === 'table') {
                const rows = b.rows, nc = Math.max(1, ...rows.map((r) => r.length)); const size = b.compact ? Math.max(11, Math.round(fontPx * 0.8)) : Math.round(fontPx * 0.9); const pad = 6;
                let want = Array.from({ length: nc }, (_, c) => Math.max(...rows.slice(0, 200).map((r) => measure(String((r[c] == null ? '' : r[c])).split('\n').reduce((a, x) => (x.length > a.length ? x : a), ''), { size })), 30) + 2 * pad);
                const avail = right - left; let tot = want.reduce((a, c) => a + c, 0); let widths;
                if (tot <= avail) widths = want; else { const minW = 40; widths = want.map((w) => Math.max(minW, w * avail / tot)); tot = widths.reduce((a, c) => a + c, 0); if (tot > avail) widths = widths.map((w) => w * avail / tot); }
                const xs = [left]; widths.forEach((w) => xs.push(xs[xs.length - 1] + w));
                for (const r of rows) {
                    const cellLines = widths.map((w, c) => wrapText(String(r[c] == null ? '' : r[c]), w - 2 * pad, measure, { size })); const n = Math.max(1, ...cellLines.map((l) => l.length)); const rowH = n * size * lh + 2 * pad * 0.6;
                    if (y + rowH > bottom && y > top) newPage(); const y0 = y;
                    cellLines.forEach((ls, c) => ls.forEach((ln, k) => { if (ln) cur().push({ t: 'text', x: xs[c] + pad, y: y0 + pad * 0.6 + k * size * lh, s: ln, size, bold: false, mono: false }); }));
                    cur().push({ t: 'line', x1: xs[0], y1: y0, x2: xs[xs.length - 1], y2: y0 }); cur().push({ t: 'line', x1: xs[0], y1: y0 + rowH, x2: xs[xs.length - 1], y2: y0 + rowH });
                    xs.forEach((x) => cur().push({ t: 'line', x1: x, y1: y0, x2: x, y2: y0 + rowH })); y += rowH;
                }
                y += fontPx * 0.5;
            }
        }
        if (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
        return pages;
    }

    return { readZip, sniffDoc, decodeText, docxToBlocks, xlsxToBlocks, layoutBlocks, wrapText, looksText, TEXT_EXT };
});
