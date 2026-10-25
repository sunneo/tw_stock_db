/* Knowledge Inventory 的 app 轉接層（掛到 FloatingAssistant.prototype）：.keeplookup 放哪裡（IndexedDB／磁碟／FAP）、搬家、
 * 把各種檔案讀成帶行號的文字、預處理（BM25 全文索引＋語意向量）、問答（每個回答都帶出處）、模型整理（接 LLM 橋接，線上不行自動改離線）、
 * knowledge_* 工具與 /knowledge 指令。純邏輯在 knowledge_core.js／knowledge_store.js，這裡只做 app 的事。 */
const FaKnowledgeHost = (function () {
    'use strict';
    const IDB_NAME = 'FloatingAssistantKnowledge';
    const READ_TOOLS = ['knowledge_ask', 'knowledge_outline', 'knowledge_detail', 'knowledge_sources'];
    const ALL_TOOLS = READ_TOOLS.concat(['knowledge_summary', 'knowledge_links', 'knowledge_add', 'knowledge_remove', 'knowledge_enable', 'knowledge_refresh', 'knowledge_embed', 'knowledge_organize', 'knowledge_location']);
    const AUDIO_VIDEO = /^(mp3|wav|m4a|ogg|oga|flac|aac|opus|mp4|m4v|mov|mkv|webm|avi)$/i;
    const TEXT_KINDS = { md: 'md', markdown: 'md', txt: 'txt', text: 'txt', log: 'log', textile: 'textile', mediawiki: 'mediawiki', wiki: 'mediawiki', json: 'json', jsonl: 'jsonl', ndjson: 'jsonl', yaml: 'yaml', yml: 'yaml', toon: 'toon', csv: 'csv', tsv: 'tsv', ini: 'txt', cfg: 'txt', inf: 'txt', toml: 'txt', rst: 'txt', tex: 'txt', xml: 'txt', js: 'txt', ts: 'txt', py: 'txt', c: 'txt', cpp: 'txt', h: 'txt', java: 'txt', go: 'txt', rs: 'txt', sh: 'txt', sql: 'txt' };

    const pad2 = (n) => String(Math.floor(n)).padStart(2, '0');
    const hms = (sec) => { sec = Math.max(0, Math.floor(sec || 0)); return pad2(sec / 3600) + ':' + pad2((sec % 3600) / 60) + ':' + pad2(sec % 60); };

    const methods = {
        // ───── 設定 ─────
        _kiSettings() {
            const k = (this.advancedSettings && this.advancedSettings.knowledge) || {};
            const L = k.location && ['idb', 'file', 'fap'].includes(k.location.kind) ? k.location : { kind: 'idb', ref: 'default' };
            return { location: { kind: L.kind, ref: String(L.ref || (L.kind === 'idb' ? 'default' : '')) }, maxMB: Number(k.maxMB) > 0 ? Number(k.maxMB) : 0, embedConsent: k.embedConsent !== false, autoEmbed: k.autoEmbed !== false, pipeline: k.pipeline !== false, images: { enabled: !!(k.images && k.images.enabled), maxPerSource: Math.max(1, Math.min(60, Number(k.images && k.images.maxPerSource) || 12)), minKB: Math.max(1, Math.min(500, Number(k.images && k.images.minKB) || 15)) } };
        },
        _kiSaveSettings(patch) { this.advancedSettings.knowledge = Object.assign({}, this._kiSettings(), patch); this._saveAdvancedSettings(); },
        _kiRef() { const L = this._kiSettings().location; if (L.kind === 'idb') return 'idb:' + (L.ref || 'default'); if (L.kind === 'file') return 'file:' + L.ref; return 'fap:' + String(L.ref).replace(/^fap:/i, ''); },
        _kiLocationLabel() { const L = this._kiSettings().location; return L.kind === 'idb' ? '瀏覽器的 IndexedDB（只在這個瀏覽器／這台 app 裡）' : L.kind === 'file' ? '磁碟檔案：' + L.ref : 'FAP 資料夾：' + L.ref; },

        // ───── IndexedDB 放法（.keeplookup 的位元組整個存成一筆；不受檔案快取的容量淘汰影響）─────
        _kiIdb() {
            if (!this._kiIdbP) this._kiIdbP = new Promise((res, rej) => { const rq = indexedDB.open(IDB_NAME, 1); rq.onupgradeneeded = () => { rq.result.createObjectStore('dbs'); }; rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error || new Error('IndexedDB 打不開')); });
            return this._kiIdbP;
        },
        async _kiIdbGet(key) { const db = await this._kiIdb(); return new Promise((res, rej) => { const rq = db.transaction('dbs', 'readonly').objectStore('dbs').get(key); rq.onsuccess = () => res(rq.result ? new Uint8Array(rq.result) : null); rq.onerror = () => rej(rq.error); }); },
        async _kiIdbPut(key, bytes) { const db = await this._kiIdb(); return new Promise((res, rej) => { const tx = db.transaction('dbs', 'readwrite'); tx.objectStore('dbs').put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), key); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); },
        async _kiIdbDel(key) { const db = await this._kiIdb(); return new Promise((res, rej) => { const tx = db.transaction('dbs', 'readwrite'); tx.objectStore('dbs').delete(key); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); }); },

        // ───── 連線（一個工作階段：開著，寫入後存回；換位置時關掉重開）─────
        async _kiSession() {
            const ref = this._kiRef();
            if (this._kiS && this._kiS.ref === ref) return this._kiS;
            if (this._kiSP && this._kiSP.ref === ref) return this._kiSP.p; // 正在開：等同一個，不要再開第二個
            const p = (async () => {
                await this._kiClose();
                if (!this._sqlAvailable()) throw new Error('這個環境沒有 SQLite 引擎（需要桌面版，或支援 Web Worker 的瀏覽器）');
                const h = await this._sqlOpen(ref, { create: true });
                const exec = async (sql, bind) => (await this._sqlCall('exec', { db: h.db, sql, bind, limit: 1000000, timeoutMs: 600000 })).results;
                const store = new FaKnowledgeStore.Store(exec); await store.init(); await h.commit();
                this._kiS = { ref, h, store, chain: Promise.resolve() };
                return this._kiS;
            })();
            this._kiSP = { ref, p};
            try { return await p; } finally { if (this._kiSP && this._kiSP.p === p) this._kiSP = null; }
        },
        async _kiClose() { const s = this._kiS; this._kiS = null; if (s) { try { await s.chain; } catch (_) { /* */ } try { await s.h.close(); } catch (_) { /* 已關或沒開 */ } } },
        // 依序執行（同一時間只有一個動作碰資料庫）；write=true 的動作做完把變更存回去
        async _kiRun(fn, write) {
            const s = await this._kiSession();
            const run = s.chain.then(async () => { const r = await fn(s.store, s); if (write) await s.h.commit(); return r; });
            s.chain = run.catch(() => {}); return run;
        },
        async _kiNoteFlag() { try { const st = await this._kiRun((store) => store.stats()); localStorage.setItem('fa.ki.has', st && st.enabled > 0 ? '1' : '0'); this._kiHas = !!(st && st.enabled > 0); } catch (_) { /* */ } },
        _kiHasSources() { if (this._kiHas === undefined) { try { this._kiHas = localStorage.getItem('fa.ki.has') === '1'; } catch (_) { this._kiHas = false; } } return !!this._kiHas; },

        // ───── 把各種來源讀成帶行號的文字（完整，不截斷）─────
        async _kiLoadSource(a) {
            a = a || {};
            if (a.text != null && String(a.text).trim()) return { name: String(a.name || '貼上的文字').slice(0, 120), kind: TEXT_KINDS[String(a.kind || 'txt').toLowerCase()] || 'txt', raw: String(a.text), url: null };
            let rec = null, url = a.url ? String(a.url).trim() : null, title = a.name ? String(a.name) : '';
            if (url) {
                if (!/^https?:\/\//i.test(url)) return { error: 'url 要是 http(s):// 開頭的完整網址' };
                const tl = this.tools.fetch_web_page; if (!tl) return { error: '這個環境沒有 fetch_web_page，請改用 file_id 或 text' };
                let j; try { j = JSON.parse(await tl.callback.call(this, JSON.stringify({ url }))); } catch (e) { return { error: '抓取網頁失敗：' + String((e && e.message) || e) }; }
                if (!j || j.ok === false) return { error: String((j && j.error) || '抓取網頁失敗') };
                rec = await this.fileCache.get(j.file_id); title = title || j.title || url;
            } else if (a.file_id) {
                rec = await this.fileCache.get(String(a.file_id)); if (!rec) return { error: '找不到檔案 file_id=' + a.file_id };
            } else if (a.path) {
                const raw = window.desktopAPI && window.desktopAPI.rawfs; if (!raw) return { error: '網頁版讀不到本機路徑；請把檔案附加到對話再用 file_id 加入' };
                let r; try { r = await raw.readFile(String(a.path), 'base64'); } catch (e) { return { error: '讀不到檔案：' + String((e && e.message) || e) }; }
                const bin = atob(r.base64 || ''), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
                rec = { filename: String(a.path).split(/[\\/]/).pop(), blob: new Blob([u]) };
            } else return { error: '要給 url、file_id、path 或 text 其中一個' };
            const fname = String(rec.filename || title || 'source'), ext = ((/\.([A-Za-z0-9]+)$/.exec(fname) || [])[1] || '').toLowerCase();
            const name = (title || fname).slice(0, 160);
            if (ext === 'pdf') {
                const img = this._kiSettings().images; let nImg = 0;
                let numPages, pageTexts;
                if (img.enabled) {
                    this._kiEmit({ op: 'images', text: '🖼 讀 PDF 裡有圖片的頁面…（用視覺模型，會比較久）' });
                    try { ({ numPages, pageTexts } = await this._extractPdfPageContentWithImages(rec.blob, { filename: fname, interpretImages: true, interpretImagesCount: img.maxPerSource })); } finally { this._kiEmit({ op: 'images', end: true }); }
                    pageTexts = pageTexts.map((t) => String(t).replace(/\[圖片區塊：[^\]]*\]\n?/g, '').replace(/\[圖片內容描述：([\s\S]*)\]\s*$/, (m, d) => { nImg++; return '[圖片描述（模型）] ' + String(d).replace(/\s+/g, ' ').trim(); }).replace(/\[圖片內容描述失敗：([^\]]*)\]/g, (m, e) => '[圖片描述（模型）] （沒有讀成功：' + String(e).slice(0, 60) + '）').replace(/（已超過[^）]*）|（尚未由[^）]*）/g, '').trim());
                } else ({ numPages, pageTexts } = await this._extractPdfPageTexts(rec.blob, { filename: fname }));
                const text = pageTexts.map((t, i) => '[第 ' + (i + 1) + ' 頁]\n' + t).join('\n');
                if (!pageTexts.some((t) => String(t).trim())) return { error: '這份 PDF 沒有文字層（可能是掃描件），沒有辦法讀；Knowledge Inventory 不會用猜的補內容。' };
                return { name, kind: 'pdf', raw: text, url, pages: numPages, note: nImg ? '含 ' + nImg + ' 段圖片內容的模型描述（標「圖片描述（模型）」），不是原文，可能有誤。' : undefined };
            }
            if (ext === 'docx') {
                const bud = this._kiImgBudget(), raw = await this._kiDocxText(rec.blob, bud);
                if (!String(raw).trim()) { await this._ensureJSZipLoaded(); const zf = await JSZip.loadAsync(rec.blob), n = Object.keys(zf.files).filter((f) => /^word\/media\//.test(f)).length; return { error: '這份 docx 沒有文字' + (n ? '，裡面只有 ' + n + ' 張圖片（可能是投影片截圖）' : '') + '，Knowledge Inventory 不會用猜的補內容；要用的話請先把圖片裡的字轉成文字。' }; }
                return { name, kind: 'docx', raw, url, note: this._kiImgNote(bud) };
            }
            if (ext === 'srt' || ext === 'vtt') {
                // 字幕檔：每則字幕前面放開始時間，跟語音轉錄一樣，出處就能指到「第幾分幾秒」
                const out = [];
                for (const blk of String(await rec.blob.text()).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\n+/)) {
                    const ls = blk.split('\n'), ti = ls.findIndex((l) => /\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}\s*-->/.test(l)); if (ti < 0) continue;
                    const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?[.,]\d{1,3}/.exec(ls[ti]); const sec = m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
                    const t = ls.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim(); if (t) out.push('[' + hms(sec) + ']\n' + t);
                }
                if (!out.length) return { error: '這個字幕檔讀不出任何字幕（格式不是 srt／vtt？）' };
                return { name, kind: ext, raw: out.join('\n'), url, note: '字幕檔；時間是該則字幕的開始時間。' };
            }
            if (ext === 'pptx') { const bud = this._kiImgBudget(), raw = await this._kiPptxText(rec.blob, bud); return { name, kind: 'pptx', raw, url, note: this._kiImgNote(bud) }; }
            if (ext === 'xlsx') {
                const d = await this._dataViewHost().deps(); if (!d.JSZip) return { error: 'XLSX 讀取工具載入失敗（需要網路載入 JSZip）' };
                const wb = await FaDataCore.readXlsx(new Uint8Array(await rec.blob.arrayBuffer()), d);
                const sheets = wb.sheets.map((sh) => ({ name: sh.name, rows: [sh.columns || []].concat(sh.rows || []) })), bud = this._kiImgBudget();
                if (bud) { try { await this._kiXlsxImages(rec.blob, sheets, bud); } catch (e) { bud.failed++; } finally { this._kiEmit({ op: 'images', end: true }); } }
                return { name, kind: 'xlsx', raw: { sheets }, url, note: this._kiImgNote(bud) };
            }
            if (AUDIO_VIDEO.test(ext)) {
                const tr = await this._transcribeMedia(rec, a.language); if (tr && tr.ok === false) return { error: '語音轉錄失敗：' + tr.error };
                const text = (tr.chunks && tr.chunks.length) ? tr.chunks.map((c) => '[' + hms(c.timestamp && c.timestamp[0]) + ']\n' + String(c.text || '').trim()).join('\n') : String(tr.text || '');
                if (!text.trim()) return { error: '轉錄結果是空的' };
                return { name, kind: ext, raw: text, url, note: '語音轉錄文字，可能有錯字；時間是該句開始的時間。' };
            }
            if (ext === 'html' || ext === 'htm') {
                const html = await rec.blob.text(), r = this._extractReadableContentFromHtml(html), bud = this._kiImgBudget(); let md = r.markdown;
                if (bud) { try { md = await this._kiHtmlImages(html, url, md, bud); } catch (e) { bud.failed++; } finally { this._kiEmit({ op: 'images', end: true }); } }
                return { name: title || r.title || name, kind: 'md', raw: md, url, note: this._kiImgNote(bud) };
            }
            const kind = a.kind ? (TEXT_KINDS[String(a.kind).toLowerCase()] || 'txt') : (TEXT_KINDS[ext] || (url ? 'md' : null));
            const head = new Uint8Array(await rec.blob.slice(0, 4096).arrayBuffer());
            if (!kind && head.indexOf(0) >= 0) return { error: '「' + fname + '」看起來是二進位檔（副檔名 ' + (ext || '沒有') + '），不支援。支援：pdf、docx、pptx、xlsx、mp3／mp4 等音訊影片（轉錄）、md、txt、textile、mediawiki、json、jsonl、yaml、toon、csv，以及其他純文字。' };
            return { name, kind: kind || 'txt', raw: await rec.blob.text(), url };
        },
        // ───── 圖片：用視覺模型讀（設定裡開啟才會讀）。讀出來的字一律標「圖片描述（模型）」，不是原文，可能有誤；讀不到就照實寫讀不到 ─────
        _kiImgBudget() { const im = this._kiSettings().images; return im.enabled ? { left: im.maxPerSource, used: 0, failed: 0, skipped: 0, minBytes: im.minKB * 1024 } : null; },
        _kiImgNote(bud) { return bud && (bud.used || bud.failed) ? '含 ' + bud.used + ' 張圖片的模型描述（標「圖片描述（模型）」），不是原文，可能有誤' + (bud.failed ? '；' + bud.failed + ' 張沒讀成功' : '') + (bud.skipped ? '；另有 ' + bud.skipped + ' 張超過設定的張數上限沒讀' : '') + '。' : undefined; },
        async _kiVisionImage(blob, hint) {
            try {
                const dataUrl = await this._pptxShrinkToDataUrl(blob, 1400);
                const prompt = '這是文件裡的一張圖片' + (hint ? '（所在位置：' + hint + '）' : '') + '。請：1) 逐項照抄圖上讀得到的文字、數字、標籤；2) 再用一兩句話說明這張圖是什麼（圖表、截圖、照片、流程圖…）。只寫看得到的，看不清楚就說看不清楚，不要推測。';
                const r = await this._visionDescribe({ images: [dataUrl], prompt, runLlm: () => this._interpretImageWithVisionModel(dataUrl, prompt) });
                if (!r || !r.ok) return { error: String((r && r.error) || '視覺模型沒有回應').slice(0, 120) };
                const text = String(r.backend === 'llm' ? (r.llm && r.llm.description) : r.text || '').replace(/\s+/g, ' ').trim();
                return text ? { text: text.slice(0, 1500) } : { error: '視覺模型沒有讀出內容' };
            } catch (e) { return { error: String((e && e.message) || e).slice(0, 120) }; }
        },
        async _kiZipImageLine(zip, path, hint, bud) {
            if (!bud) return ''; const f = zip.file(path); if (!f) return '';
            const ext = (/\.([A-Za-z0-9]+)$/.exec(path) || [])[1] || '', mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' })[ext.toLowerCase()];
            if (!mime) return ''; const b = await f.async('blob'); if (b.size < bud.minBytes) return '';
            if (bud.left <= 0) { bud.skipped++; return ''; }
            bud.left--; this._kiEmit({ op: 'images', text: '🖼 讀圖片 ' + (bud.used + bud.failed + 1) + '：' + hint });
            const r = await this._kiVisionImage(new Blob([b], { type: mime }), hint);
            if (r.error) { bud.failed++; return '[圖片描述（模型）] （沒有讀成功：' + r.error + '）'; }
            bud.used++; return '[圖片描述（模型）] ' + r.text;
        },
        // xlsx：工作表裡的圖片（xl/drawings 的錨點給出儲存格位置），讀出來加在該工作表最後面，標明位置
        async _kiXlsxImages(blob, sheets, bud) {
            await this._ensureJSZipLoaded(); const zip = await JSZip.loadAsync(blob), wbx = zip.file('xl/workbook.xml'); if (!wbx) return;
            const parse = (x) => new DOMParser().parseFromString(x, 'application/xml'), RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
            const colName = (n) => { let t = '', k = n + 1; while (k > 0) { const m = (k - 1) % 26; t = String.fromCharCode(65 + m) + t; k = Math.floor((k - 1) / 26); } return t; };
            const wbRels = await this._kiRels(zip, 'xl/_rels/workbook.xml.rels');
            for (const sh of Array.from(parse(await wbx.async('string')).getElementsByTagName('sheet'))) {
                const name = sh.getAttribute('name'), tg = wbRels[sh.getAttributeNS(RNS, 'id')], target = sheets.find((x) => x.name === name); if (!tg || !target) continue;
                const sp = 'xl/' + tg.replace(/^\/?(xl\/)?/, ''), srel = await this._kiRels(zip, sp.slice(0, sp.lastIndexOf('/')) + '/_rels/' + sp.split('/').pop() + '.rels');
                const dt = Object.values(srel).find((t) => /drawings\/drawing\d+\.xml$/.test(t)); if (!dt) continue;
                const dp = 'xl/drawings/' + dt.split('/').pop(), df = zip.file(dp); if (!df) continue;
                const drels = await this._kiRels(zip, 'xl/drawings/_rels/' + dp.split('/').pop() + '.rels'), ddoc = parse(await df.async('string'));
                for (const anc of Array.from(ddoc.getElementsByTagName('xdr:twoCellAnchor')).concat(Array.from(ddoc.getElementsByTagName('xdr:oneCellAnchor')))) {
                    const bl = anc.getElementsByTagName('a:blip')[0]; if (!bl) continue; const t2 = drels[bl.getAttributeNS(RNS, 'embed')]; if (!t2) continue;
                    const fr = anc.getElementsByTagName('xdr:from')[0], col = fr ? Number((fr.getElementsByTagName('xdr:col')[0] || {}).textContent || 0) : 0, row = fr ? Number((fr.getElementsByTagName('xdr:row')[0] || {}).textContent || 0) : 0, cell = colName(col) + (row + 1);
                    const ln = await this._kiZipImageLine(zip, 'xl/media/' + t2.split('/').pop(), name + '!' + cell, bud); if (ln) target.rows.push([ln + '（圖片在 ' + cell + '）']);
                }
            }
        },
        // 網頁：<img> 逐張抓下來讀（抓不到就照實記「抓不到」，常見原因是對方網站不准跨網域讀圖）；描述插在原文裡出現這張圖的那行後面，找不到那行就接在最後
        async _kiHtmlImages(html, baseUrl, md, bud) {
            const doc = new DOMParser().parseFromString(html, 'text/html'), lines = String(md).split('\n'), seen = new Set(), extra = [], inserts = [];
            for (const im of Array.from(doc.querySelectorAll('img'))) {
                let src = im.getAttribute('src') || im.getAttribute('data-src') || ''; if (!src || /^data:/i.test(src)) continue;
                try { src = new URL(src, baseUrl || undefined).href; } catch (_) { continue; } if (seen.has(src) || /\.(svg|ico)(\?|#|$)/i.test(src)) continue; seen.add(src);
                const w = Number(im.getAttribute('width') || 0), hh = Number(im.getAttribute('height') || 0); if ((w && w < 48) || (hh && hh < 48)) continue;
                if (bud.left <= 0) { bud.skipped++; continue; } const file = decodeURIComponent(src.split('?')[0].split('/').pop() || src), alt = String(im.getAttribute('alt') || '').trim();
                let blob = null; try { const r = await fetch(src); if (r.ok) blob = await r.blob(); } catch (_) { /* */ }
                let ln; if (!blob) { bud.failed++; ln = '[圖片描述（模型）] （圖片抓不到：' + file + '）'; } else if (blob.size < bud.minBytes) continue; else {
                    bud.left--; this._kiEmit({ op: 'images', text: '🖼 讀網頁圖片 ' + (bud.used + bud.failed + 1) + '：' + file });
                    const r = await this._kiVisionImage(blob.type ? blob : new Blob([blob], { type: 'image/jpeg' }), '網頁圖片' + (alt ? '，替代文字：' + alt : '') + '：' + file);
                    if (r.error) { bud.failed++; ln = '[圖片描述（模型）] （沒有讀成功：' + r.error + '）'; } else { bud.used++; ln = '[圖片描述（模型）] ' + r.text; }
                }
                const key = file.length >= 6 ? file : src, at = lines.findIndex((l) => l.indexOf(key) >= 0); if (at >= 0) inserts.push([at, ln]); else extra.push(ln);
            }
            inserts.sort((a, b) => b[0] - a[0]).forEach((x) => lines.splice(x[0] + 1, 0, x[1]));
            return lines.join('\n') + (extra.length ? '\n\n' + extra.join('\n') : '');
        },
        _kiRels(zip, relsPath) { const f = zip.file(relsPath); return f ? f.async('string').then((x) => { const m = {}; Array.from(new DOMParser().parseFromString(x, 'application/xml').getElementsByTagName('Relationship')).forEach((e) => { m[e.getAttribute('Id')] = e.getAttribute('Target'); }); return m; }) : Promise.resolve({}); },
        async _kiDocxText(blob, bud) {
            await this._ensureJSZipLoaded(); const zip = await JSZip.loadAsync(blob), f = zip.file('word/document.xml'); if (!f) throw new Error('找不到 word/document.xml，可能不是有效的 docx');
            const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml'), W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
            const textOf = (p) => { let s = ''; const walk = (n) => { for (const c of Array.from(n.childNodes)) { if (c.nodeType !== 1) continue; if (c.localName === 't') s += c.textContent; else if (c.localName === 'tab') s += '\t'; else if (c.localName === 'br' || c.localName === 'cr') s += '\n'; else walk(c); } }; walk(p); return s; };
            const para = (p) => { const st = p.getElementsByTagNameNS(W, 'pStyle')[0], sv = st ? st.getAttributeNS(W, 'val') : ''; const m = /^(?:Heading|標題)\s*(\d)$/i.exec(sv || ''); const t = textOf(p).trim(); if (!t) return ''; if (m) return '#'.repeat(+m[1]) + ' ' + t; if (p.getElementsByTagNameNS(W, 'numPr')[0]) return '- ' + t; return t; };
            const out = []; const body = doc.getElementsByTagNameNS(W, 'body')[0];
            for (const n of Array.from(body ? body.childNodes : [])) {
                if (n.nodeType !== 1) continue;
                if (n.localName === 'p') { const t = para(n); if (t) out.push(t); if (bud) Array.from(n.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')).forEach((bl) => { const rid = bl.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'); if (rid) out.push('\u0001' + rid); }); }
                else if (n.localName === 'tbl') for (const tr of Array.from(n.getElementsByTagNameNS(W, 'tr'))) out.push(Array.from(tr.getElementsByTagNameNS(W, 'tc')).map((tc) => Array.from(tc.getElementsByTagNameNS(W, 'p')).map(textOf).join(' ').trim()).join(' | '));
            }
            if (bud && out.some((x) => x.charCodeAt(0) === 1)) { const rels = await this._kiRels(zip, 'word/_rels/document.xml.rels'), res = []; let k = 0; for (const x of out) { if (x.charCodeAt(0) === 1) { k++; const tg = rels[x.slice(1)]; const ln = tg ? await this._kiZipImageLine(zip, 'word/' + tg.replace(/^\.?\//, ''), '文件裡第 ' + k + ' 張圖', bud) : ''; if (ln) res.push(ln); } else res.push(x); } return res.join('\n'); }
            return out.join('\n');
        },
        async _kiPptxText(blob, bud) {
            await this._ensureJSZipLoaded(); const zip = await JSZip.loadAsync(blob);
            const slides = Object.keys(zip.files).map((n) => ({ n, i: Number((/slides\/slide(\d+)\.xml$/.exec(n) || [])[1]) })).filter((x) => x.i).sort((a, b) => a.i - b.i), A = 'http://schemas.openxmlformats.org/drawingml/2006/main', out = [];
            const lines = (xml) => { const d = new DOMParser().parseFromString(xml, 'application/xml'); return Array.from(d.getElementsByTagNameNS(A, 'p')).map((p) => Array.from(p.getElementsByTagNameNS(A, 't')).map((t) => t.textContent).join('')).map((s) => s.trim()).filter(Boolean); };
            for (const s of slides) {
                const sx = await zip.file(s.n).async('string'); out.push('[投影片 ' + s.i + ']'); out.push(...lines(sx));
                if (bud) { const rels = await this._kiRels(zip, 'ppt/slides/_rels/slide' + s.i + '.xml.rels'), seen = {}; for (const bl of Array.from(new DOMParser().parseFromString(sx, 'application/xml').getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip'))) { const rid = bl.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'), tg = rels[rid]; if (!tg || seen[rid]) continue; seen[rid] = 1; const ln = await this._kiZipImageLine(zip, 'ppt/' + tg.replace(/^\.\.\//, ''), '投影片 ' + s.i, bud); if (ln) out.push(ln); } }
                const nf = zip.file('ppt/notesSlides/notesSlide' + s.i + '.xml'); if (nf) { const nl = lines(await nf.async('string')).filter((l) => !/^\d+$/.test(l)); if (nl.length) { out.push('（講者備註）'); out.push(...nl); } }
            }
            return out.join('\n');
        },

        // ───── 加入、更新、移除 ─────
        _kiCapacityCheck(stats, addChars) { const cap = this._kiSettings().maxMB; if (!cap) return null; const used = (stats && stats.chars) || 0; if ((used + addChars) / 1048576 > cap) return '超過知識庫的容量上限（' + cap + ' MB，已用約 ' + Math.round(used / 1048576 * 10) / 10 + ' MB）。到管理設定把上限調高或改成「無限」，或先移除不要的來源。'; return null; },
        async _kiAdd(a) {
            const loaded = await this._kiLoadSource(a); if (loaded.error) return { ok: false, error: loaded.error };
            const src = FaKnowledge.ingest({ name: loaded.name, kind: loaded.kind, raw: loaded.raw, url: loaded.url });
            if (!src.text.trim()) return { ok: false, error: '這個來源沒有可讀的文字，沒有加入。' };
            if (loaded.note) src.notes = (src.notes || []).concat(loaded.note);
            const res = await this._kiRun(async (store) => { const over = this._kiCapacityCheck(await store.stats(), src.text.length); if (over) return { ok: false, error: over }; const r = await store.addSource(src, { force: !!a.force }); return Object.assign({ ok: true }, r); }, true);
            if (!res.ok) return res;
            await this._kiNoteFlag();
            const out = { ok: true, status: res.status, source_id: res.id, name: src.name, kind: src.kind, lines: src.lines.length, sections: src.sections.length, chunks: res.chunks, notes: src.notes };
            if (res.status !== 'unchanged') { out.pipeline = '已排入自動處理（語意向量、逐層摘要、關聯），背景進行，不用手動操作'; this._kiPipeline().catch(() => { /* */ }); }
            return out;
        },
        async _kiRemove(ref) { return this._kiRun(async (store) => { const s = await store.findSource(ref); if (!s) return { ok: false, error: '找不到來源：' + ref }; await store.removeSource(s.id); return { ok: true, removed: s.name }; }, true).then(async (r) => { await this._kiNoteFlag(); return r; }); },
        async _kiEnable(ref, on) { return this._kiRun(async (store) => { const s = await store.findSource(ref); if (!s) return { ok: false, error: '找不到來源：' + ref }; await store.setEnabled(s.id, on); return { ok: true, name: s.name, enabled: !!on }; }, true).then(async (r) => { await this._kiNoteFlag(); if (on) this._kiPipeline().catch(() => { /* */ }); return r; }); },
        async _kiSources() { return this._kiRun(async (store) => { const dset = new Set((await store.getDigests(null, 'doc')).map((d) => d.source_id)); return { ok: true, location: this._kiLocationLabel(), stats: await store.stats(), sources: (await store.listSources()).map((s) => ({ id: s.id, name: s.name, kind: s.kind, enabled: !!s.enabled, chars: s.chars, sections: s.sections, chunks: s.chunks, vectors: s.vectors, has_digest: dset.has(s.id), tags: s.tags ? (() => { try { return JSON.parse(s.tags).terms; } catch (_) { return undefined; } })() : undefined })) }; }); },

        // ───── 預處理的第二半：語意向量（小型嵌入模型；vendor-models 分支優先，抓不到再 HuggingFace）─────
        _kiModelId() { const M = FaCatalogEmbed.MODEL; return M.repo + '@' + M.dtype; },
        async _kiEmbedPipe(onProgress) { const p = await this._unitCatalogEmbedder(onProgress); return p || null; },
        // 進度事件：{ op: 'embed'|'organize', done, total, text, source_id?, end? }——面板訂閱後畫進度條
        _kiOn(fn) { (this._kiLs = this._kiLs || new Set()).add(fn); return () => this._kiLs.delete(fn); },
        _kiEmit(ev) { for (const fn of Array.from(this._kiLs || [])) { try { fn(ev); } catch (_) { /* */ } } },
        async _kiEmbedPending(onProgress) {
            const st = this._kiSettings(); if (!st.embedConsent) return { skipped: true, note: '語意索引還沒啟用（/knowledge embed）' };
            const pipe = await this._kiEmbedPipe(onProgress); if (!pipe) return { error: '嵌入模型載入失敗：' + (this._unitCatalogEmbedError || '原因不明') + '；目前用關鍵字檢索。' };
            const model = this._kiModelId(), M = FaCatalogEmbed.MODEL; let done = 0; const t0 = Date.now();
            const st0 = await this._kiRun((store) => store.stats()); const total = Math.max(0, ((st0 && st0.chunks) || 0) - ((st0 && st0.vectors) || 0));
            this._kiEmit({ op: 'embed', done: 0, total, text: '語意向量 0/' + total });
            try { for (;;) {
                const batch = await this._kiRun((store) => store.pendingVectors(model, 32)); if (!batch.length) break;
                const vecs = await this._unitCatalogEmbedTexts(pipe, batch.map((b) => (b.section ? b.section + '\n' : '') + String(b.text).slice(0, 1500)), M.passagePrefix);
                await this._kiRun((store) => store.putVectors(model, batch.map((b, i) => ({ id: b.id, vec: vecs[i] }))), true);
                done += batch.length; if (onProgress) onProgress('語意索引 ' + done); this._kiEmit({ op: 'embed', done, total, text: '語意向量 ' + done + '/' + total });
            } } finally { this._kiEmit({ op: 'embed', done, total, end: true }); }
            return { embedded: done, ms: Date.now() - t0, model };
        },
        async _kiQueryVec(question) {
            const st = this._kiSettings(); if (!st.embedConsent) return { vec: null, why: '語意索引還沒啟用' };
            const stats = await this._kiRun((store) => store.stats()); if (!stats || !stats.vectors) return { vec: null, why: '還沒有向量（/knowledge embed）' };
            const pipe = await this._kiEmbedPipe(); if (!pipe) return { vec: null, why: '嵌入模型載入失敗' };
            const v = await this._unitCatalogEmbedTexts(pipe, [question], FaCatalogEmbed.MODEL.queryPrefix); return { vec: v[0], why: '' };
        },

        // ───── 問答：回傳原文與出處，不生成 ─────
        async _kiAsk(a) {
            const q = String((a && (a.question || a.query)) || '').trim(); if (!q) return { ok: false, error: '缺少問題（question）' };
            const step = (t) => { try { if (a && typeof a.onStep === 'function') a.onStep(t); } catch (_) { /* */ } };
            const ids = a.sources ? await this._kiResolveIds(a.sources) : null;
            step('🔎 檢索：關鍵字（BM25）' + (this._kiSettings().embedConsent ? '＋語意向量' : '（語意索引沒開）') + (ids ? '，限定 ' + ids.length + ' 個來源' : ''));
            const qv = await this._kiQueryVec(q).catch(() => ({ vec: null, why: '語意檢索出錯' }));
            const lim = Math.min(Math.max(Number(a.limit) || 5, 1), 12), model = this._kiModelId();
            let res = await this._kiRun((store) => store.answer(q, { limit: lim, sources: ids, queryVec: qv.vec || undefined, model }));
            // 問法跟文件用字對不上（中文問英文文件、換個說法）：請模型替問題想幾個「文件裡可能出現的詞」，再用這些詞多找一輪。
            // 模型只出主意；找到的永遠是原文，詞對不上就找不到，不會因此編出內容。已經有「關鍵字與語意都命中」的結果就不必問模型。
            const strong = (r) => (r.hits || []).some((h) => /＋/.test(h.found_by || ''));
            let expanded = null;
            step('　第一輪：' + (res.found ? '找到 ' + res.hits.length + ' 筆' + (strong(res) ? '（有關鍵字與語意都命中的）' : '（沒有雙重命中）') : '沒有找到'));
            if (!(a && a.no_expand) && !strong(res)) {
                step('🧭 問法可能跟文件用字對不上，請模型想「文件裡可能出現的詞」…');
                const terms = await this._kiExpandQuery(q, step, a && a.ctl).catch((e) => { step('　（' + String((e && e.message) || e).slice(0, 80) + '，維持第一輪的結果）'); return []; });
                step(terms.length ? '　模型提的詞：' + terms.join('、') : '　（模型沒有回應，維持第一輪的結果）');
                if (terms.length) {
                    const q2 = q + ' ' + terms.join(' '); const qv2 = qv.vec ? await this._kiQueryVec(q2).catch(() => ({ vec: null })) : { vec: null };
                    const r2 = await this._kiRun((store) => store.answer(q2, { minCoverage: 0.06, limit: lim, sources: ids, queryVec: qv2.vec || qv.vec || undefined, model }));
                    const hasKw = (r) => (r.hits || []).some((h) => /關鍵字/.test(h.found_by || '')); const take = r2.found && (!res.found || strong(r2) || (hasKw(r2) && !hasKw(res)) || (r2.hits[0] && r2.hits[0].score > ((res.hits[0] && res.hits[0].score) || 0)));
                    step('　第二輪：' + (r2.found ? '找到 ' + r2.hits.length + ' 筆，' + (take ? '採用這一輪' : '不比第一輪好，維持第一輪') : '沒有找到，維持第一輪'));
                    if (take) { res = r2; expanded = terms; }
                }
            }
            if (res.found) for (const h of res.hits) { try { const rel = await this._kiRun((store) => store.relatedOf(h.source_id, h.line_start, h.line_end)); if (rel.length) h.related = rel; } catch (_) { /* */ } }
            return Object.assign(res, { expanded_terms: expanded || undefined, semantic: !!qv.vec, semantic_note: qv.vec ? undefined : qv.why + '（只用關鍵字檢索）', how_to_answer: res.found ? '只能根據 hits 裡的 quote 回答，每個說法後面標出處（label：來源、第幾行）；quote 沒講到的就說沒有，不要補充或推測。' : '沒有找到，就照實說在知識庫裡找不到，不要用自己的知識代替。' });
        },
        // AI 整理：把找到的原文片段編號交給模型，請它只用這些回答、每句結尾標 [編號]。
        // 程式逐句核對：沒標編號、編號不存在、句子裡的指令／數字／英文識別字在被引用的原文裡找不到的句子，一律丟掉（並告訴使用者丟了幾句）。
        async _kiAnswerAI(question, hits, onStep, ctl) {
            const step = (t) => { try { if (onStep) onStep(t); } catch (_) { /* */ } };
            const use = (hits || []).slice(0, 6); if (!use.length) return { ok: false, error: '沒有可以整理的原文' };
            if (typeof this._callSimpleCompletion !== 'function') return { ok: false, error: '這個環境沒有可用的模型' };
            // 命中的只是標題（投影片標題、章節名）時，答案常在它後面幾行：把後面的幾行一起交給模型（仍是原文）
            for (const h of use) {
                h.ctx = String(h.quote);
                if (h.ctx.length < 160 && h.source_id) { try { const d = await this._kiRun((store) => store.detail(h.source_id, { line_start: h.line_start, line_end: h.line_end + 8 }, { maxLines: 12 })); const t = ((d && d.lines) || []).map((l) => l.text).join('\n'); if (t.length > h.ctx.length) h.ctx = t; } catch (_) { /* */ } }
            }
            const mkCtx = (per, n) => use.slice(0, n).map((h, i) => '[' + (i + 1) + '] 《' + h.source + '》' + h.ctx.slice(0, per)).join('\n\n'), ctx = mkCtx(900, 6);
            step('🤖 交給模型整理（只准用 ' + use.length + ' 段原文，每句要標編號）…'); const t0 = Date.now();
            let reply = ''; try {
                const prompt1 = ('問題：' + question + '\n\n下面是從知識庫找到的原文片段（有編號）：\n\n' + ctx + '\n\n請只根據這些片段回答問題。規則：1) 每一句結尾都要標它所根據的片段編號，例如「按下 Save 鈕 [2]」；2) 指令放在 `反引號` 裡，並且逐字照抄原文；數字、名稱原樣照抄，不要改寫；3) 片段沒有講到的就不要說，不要補充或推測；4) 標題或章節名稱跟問題對得上也算有找到（例如「在《某某》找到標題『Plugin Installation』 [2]」），把它後面接著的內容也一併說出來；5) 完全找不到答案就只輸出「找不到」。'); reply = await this._kiLlm(prompt1, { systemPrompt: '你只能用給你的片段回答，每句都要標編號。', maxTokens: 1500, temperature: 0 }, { label: '整理回答', timeoutMs: 120000, onStep: step, ctl, offlinePrompt: () => prompt1.replace(ctx, () => mkCtx(350, 4)) });
            } catch (e) { return { ok: false, error: '模型沒有回應：' + String((e && e.message) || e).slice(0, 160), ms: Date.now() - t0 }; }
            step('　模型回應了（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒），逐句核對編號與原文…');
            const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ''); const sentences = [], dropped = [];
            const pieces = String(reply || '').split(/\n+/).flatMap((l) => l.split(/(?<=[。！？!?；;])\s*/)).map((x) => x.trim()).filter(Boolean);
            for (const piece of pieces) {
                const cites = Array.from(piece.matchAll(/\[(\d+)\]/g)).map((m) => Number(m[1])); const text = piece.replace(/\s*\[\d+\]\s*/g, ' ').trim();
                if (!text || /^[^\p{L}\p{N}]*找不到[^\p{L}\p{N}]*$/u.test(text)) continue;
                if (!cites.length) { dropped.push({ text, why: '沒有標編號' }); continue; }
                if (cites.some((n) => n < 1 || n > use.length)) { dropped.push({ text, why: '編號不存在' }); continue; }
                const src = cites.map((n) => norm(FaKnowledge.fold(use[n - 1].ctx || use[n - 1].quote))).join('');
                const bt = Array.from(text.matchAll(/`([^`]+)`/g)).map((m) => m[1]); const badCmd = bt.find((c) => src.indexOf(norm(FaKnowledge.fold(c))) < 0 && src.indexOf(norm(c)) < 0);
                if (badCmd) { dropped.push({ text, why: '指令「' + badCmd.slice(0, 40) + '」不是原文的逐字片段' }); continue; }
                const ids = text.match(/[A-Za-z][A-Za-z0-9_.\-/]{2,}|\d+(?:\.\d+)*/g) || []; const missing = ids.filter((w) => src.indexOf(norm(w)) < 0);
                if (missing.length) { dropped.push({ text, why: '「' + missing.slice(0, 3).join('、') + '」在引用的原文裡找不到' }); continue; }
                sentences.push({ text, cites: Array.from(new Set(cites)), image: cites.some((n) => /\[圖片描述（模型）\]/.test(use[n - 1].ctx || use[n - 1].quote || '')) });
            }
            step('　核對完成：留下 ' + sentences.length + ' 句' + (dropped.length ? '，丟掉 ' + dropped.length + ' 句（對不上原文）' : '') + '（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）');
            return { ok: true, sentences, dropped, cited: Array.from(new Set(sentences.flatMap((x) => x.cites))), sources: use.map((h, i) => ({ n: i + 1, label: h.label, source: h.source, source_id: h.source_id, line_start: h.line_start, line_end: h.line_end, quote: h.quote, ctx: h.ctx })), ms: Date.now() - t0 };
        },
        // ───── 對話保存：每個庫一份，存在這個瀏覽器的 IndexedDB（不放進 .keeplookup 檔），最多 60 則；重新整理後恢復 ─────
        _kiChatDb() { return new Promise((res, rej) => { const rq = indexedDB.open('fa-ki-chat', 1); rq.onupgradeneeded = () => { rq.result.createObjectStore('chats'); }; rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); },
        async _kiChatLoad() { try { const db = await this._kiChatDb(), key = this._kiRef(); const v = await new Promise((res, rej) => { const r = db.transaction('chats').objectStore('chats').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); db.close(); return Array.isArray(v) ? v : []; } catch (_) { return []; } },
        async _kiChatSave(list) { try { const db = await this._kiChatDb(), key = this._kiRef(); await new Promise((res, rej) => { const tx = db.transaction('chats', 'readwrite'); tx.objectStore('chats').put(JSON.parse(JSON.stringify(list.slice(-60))), key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); db.close(); return true; } catch (_) { return false; } },
        async _kiChatClear() { try { const db = await this._kiChatDb(), key = this._kiRef(); await new Promise((res, rej) => { const tx = db.transaction('chats', 'readwrite'); tx.objectStore('chats').delete(key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); db.close(); } catch (_) { /* */ } return true; },
        // ───── 閒聊路由：招呼、道謝、閒聊直接聊；要資訊就查原文 ─────
        // 先用規則判斷（問句詞、識別字、指令、很長的話一定查）；只有「不確定」的（很短又不像在問資料、或是接著上一輪的追問）才問模型：CHAT: 回覆，或 SEARCH: 補成完整的查詢句。
        // 保險：看起來是在問資料的話，就算模型選了閒聊也照樣查原文，模型憑記憶寫的回答不顯示。
        _kiLooksLikeLookup(q) { const t = String(q || '').trim(); return /[?？]/.test(t) || /怎麼|如何|什麼|甚麼|為什麼|為何|哪[裡個些邊]|是否|能不能|可以|有沒有|多少|幾個|\b(how|what|why|where|which|can|does|is there)\b/i.test(t) || /[A-Za-z]+[_.:\-][A-Za-z0-9]+|[A-Z][a-z]+[A-Z]|\d{2,}|--?\w{2,}|\(\)/.test(t) || t.length > 40; },
        async _kiRoute(q, history, onStep, ctl) {
            const step = (t) => { try { if (onStep) onStep(t); } catch (_) { /* */ } }; const t = String(q || '').trim(), hist = Array.isArray(history) ? history.slice(-4) : [];
            const lookup = this._kiLooksLikeLookup(t), followUp = hist.length > 0 && t.length <= 14 && /^(那|還有|然後|所以|它|這個|那個|另外|and |what about|how about)/i.test(t);
            if (lookup && !followUp) return { route: 'search', query: t };
            step('🧭 判斷是閒聊還是要查資料…');
            let names = []; try { names = (await this._kiRun((store) => store.listSources())).slice(0, 20).map((x) => x.name); } catch (_) { /* */ }
            const prompt = '你是知識庫助理。使用者說：「' + t + '」\n' + (hist.length ? '前幾輪：\n' + hist.map((h) => '使用者：' + String(h.q).slice(0, 80) + '\n助理：' + String(h.a || '').slice(0, 120)).join('\n') + '\n' : '') + '知識庫裡的來源：' + (names.join('、') || '（空的）') + '\n請判斷並只輸出一行：\n1) 招呼、道謝、閒聊、問你是誰／能做什麼／知識庫裡有什麼 → CHAT: <簡短回覆，繁體中文；不要回答任何需要查資料的事>\n2) 其他（包含接著上一輪的追問）→ SEARCH: <把使用者的話用前幾輪補成一句完整、獨立的查詢句>';
            let reply = ''; try { reply = await this._kiLlm(prompt, { systemPrompt: '你只負責分流，不回答資料問題。', maxTokens: 300, temperature: 0 }, { label: '判斷', timeoutMs: 45000, onStep, ctl }); } catch (e) { step('　（模型沒有回應，直接查原文）'); return { route: 'search', query: t }; }
            const lines = String(reply).split('\n').map((x) => x.trim()), lastChat = lines.filter((x) => /^CHAT\s*[:：]/i.test(x)).pop(), lastSearch = lines.filter((x) => /^SEARCH\s*[:：]/i.test(x)).pop();
            if (lastSearch) { const qq = lastSearch.replace(/^SEARCH\s*[:：]\s*/i, '').trim(); if (qq) { if (qq !== t) step('　改寫成查詢句：' + qq); return { route: 'search', query: qq }; } }
            if (lastChat && !lookup) { const rp = lastChat.replace(/^CHAT\s*[:：]\s*/i, '').trim(); if (rp) return { route: 'chat', reply: rp }; }
            return { route: 'search', query: t };
        },
        // ───── 回應的排版：沿用主聊天同一套美化（marked＋DOMPurify＋.ai-markdown-body 樣式）：表格、清單、程式碼區塊、圖片、數學式；另外 ```svg 區塊會消毒後直接畫出來 ─────
        async _kiRenderMd(text) {
            try { if (typeof this._ensureMarkdownLibsLoaded === 'function') await this._ensureMarkdownLibsLoaded(); } catch (_) { /* */ }
            if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return null;
            try { this._ensureMarkdownStyles(); } catch (_) { /* */ }
            const svgs = [], src = String(text || '').replace(/```svg[ \t]*\r?\n([\s\S]*?)```/gi, (m, code) => { svgs.push(code); return '\n\n@@KISVG' + (svgs.length - 1) + '@@\n\n'; });
            const div = document.createElement('div'); div.className = 'ai-markdown-body';
            try { div.innerHTML = DOMPurify.sanitize(this._renderMarkdownWithMath(src)); } catch (_) { div.textContent = String(text || ''); return div; }
            const copy = (t, b, label) => { try { navigator.clipboard.writeText(t); b.textContent = '已複製'; } catch (_) { b.textContent = '複製不了'; } setTimeout(() => { b.textContent = label; }, 1200); };
            const mkBtn = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'font-size:11px;padding:1px 8px;margin:2px 4px 0 0;border:1px solid rgba(128,128,128,.5);border-radius:5px;background:transparent;color:inherit;cursor:pointer'; b.onclick = fn; return b; };
            // SVG 圖：消毒（不准 script、事件屬性），放進有框的區塊，可複製原始碼、下載
            svgs.forEach((code, i) => {
                const ph = Array.from(div.querySelectorAll('p')).find((p) => p.textContent.trim() === '@@KISVG' + i + '@@'); if (!ph) return;
                const clean = DOMPurify.sanitize(code, { USE_PROFILES: { svg: true, svgFilters: true } }), wrap = document.createElement('div'); wrap.style.cssText = 'margin:8px 0;border:1px solid rgba(128,128,128,.35);border-radius:6px;padding:6px;overflow:auto;background:#fff;color:#000';
                if (!clean.trim()) { wrap.textContent = '（這張 SVG 圖是空的，或內容被判定不安全（script、事件屬性），沒有顯示）'; }
                else { const holder = document.createElement('div'); holder.innerHTML = clean; const sv = holder.querySelector('svg'); if (sv) { sv.style.maxWidth = '100%'; sv.style.height = 'auto'; if (!sv.getAttribute('viewBox') && parseFloat(sv.getAttribute('width')) > 0 && parseFloat(sv.getAttribute('height')) > 0) sv.setAttribute('viewBox', '0 0 ' + parseFloat(sv.getAttribute('width')) + ' ' + parseFloat(sv.getAttribute('height'))); } wrap.appendChild(holder);
                    const row = document.createElement('div'); row.appendChild(mkBtn('複製 SVG', function () { copy(clean, this, '複製 SVG'); })); row.appendChild(mkBtn('下載 .svg', () => { try { const a = document.createElement('a'), u = URL.createObjectURL(new Blob([clean], { type: 'image/svg+xml' })); a.href = u; a.download = '圖.svg'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); } catch (_) { /* */ } })); wrap.appendChild(row); }
                ph.replaceWith(wrap);
            });
            // 圖片：限制寬度、點一下放大
            div.querySelectorAll('img').forEach((im) => { im.style.maxWidth = '100%'; im.style.height = 'auto'; im.style.cursor = 'zoom-in'; im.loading = 'lazy'; im.addEventListener('click', () => { try { window.open(im.src, '_blank'); } catch (_) { /* */ } }); });
            // 表格：沿用主聊天的表格後處理；寬的表格可以橫向捲動
            div.querySelectorAll('table').forEach((tb) => { try { if (this.options && typeof this.options.onTableRendered === 'function') this.options.onTableRendered(tb); } catch (_) { /* */ } const sc = document.createElement('div'); sc.style.cssText = 'overflow-x:auto;max-width:100%'; tb.parentNode.insertBefore(sc, tb); sc.appendChild(tb); });
            // 程式碼區塊：右上角複製
            div.querySelectorAll('pre').forEach((pre) => { pre.style.position = 'relative'; const code = pre.textContent; const b = mkBtn('複製', function () { copy(code, this, '複製'); }); b.style.cssText += ';position:absolute;top:2px;right:2px'; pre.appendChild(b); });
            return div;
        },
        // ───── 記憶式對話：放進藏書閣的文件就是 AI 的記憶——回答、解釋、整合、甚至創作都可以基於這些知識，但不會把整個知識庫塞進上下文 ─────
        // 做法（程式主導，模型只負責理解與寫）：
        //   ① 知識庫概覽（每份文件一兩句＋關鍵詞，永遠放進去，很小）；② 跟問題相關的章節摘要（模型事先讀完整理的「理解」）；③ 檢索到的原文片段（要細節時看）；
        //   ④ 前幾輪對話。份量依模型的上下文大小按比例分配，放不下的就不放；模型還想看更多，可以在答案最後說 NEED: 查詢，程式再查一輪補進去。
        // 模型用自己的話整合成自然的段落回答（不是逐條抄原文）；有依據的地方標資料編號，資料沒講、憑它自己知識補的標 [外]；程式再核對：編號要存在、
        // 指令／數字／英文名稱要真的在給它的資料裡（核對不過的句子丟掉並列出）；程式碼用到的函式、標頭，哪些在資料裡找得到、哪些沒有，另外列出「依據檢查」。
        _kiBudgetChars(offline) {
            if (offline) return 3500; let cw = 0; try { const rows = this._getModelRows(); cw = Number(rows && rows[0] && rows[0].contextWindowTokens) || 0; } catch (_) { /* */ }
            const tokens = Math.max(2000, Math.min(cw > 0 ? cw * 0.25 : 8000, 9000)); return Math.round(tokens * 1.8);
        },
        async _kiMapText(ids, maxChars) {
            const data = await this._kiRun(async (store) => { const list = (await store.listSources()).filter((x) => x.enabled && (!ids || ids.indexOf(x.id) >= 0)); const docs = await store.getDigests(list.map((x) => x.id), 'doc'); const titles = {}; for (const x of list) { if (!docs.some((d) => d.source_id === x.id)) titles[x.id] = await store.topTitles(x.id, 8); } return { list, docs, titles }; });
            if (!data.list.length) return '（知識庫是空的）'; const per = Math.max(90, Math.floor(maxChars / data.list.length)); const lines = [];
            for (const x of data.list) { const d = data.docs.find((y) => y.source_id === x.id); const tags = x.tags ? (() => { try { return JSON.parse(x.tags).terms || []; } catch (_) { return []; } })() : []; let body = d ? d.text.replace(/\s+/g, ' ') : '章節：' + ((data.titles[x.id] || []).join('、') || '（無章節）') + '（還沒有整理摘要）'; const kw = d && d.terms && d.terms.length ? d.terms : tags; if (kw && kw.length) body += '｜關鍵詞：' + kw.slice(0, 6).join('、'); lines.push('《' + x.name + '》' + body.slice(0, per)); }
            return lines.join('\n').slice(0, maxChars);
        },
        // 由上往下展開：每份文件從最精簡的整份概覽開始（概覽已經在「知識庫概覽」裡），哪個分支跟問題有關（自己或底下的任何一段摘要有問題裡的詞）就展開成下一層比較詳細的摘要，
        // 在預算內盡量往下，沒關係的分支留在上層、不放進去。回傳選出的摘要節點（每個附 sc＝相關度、行範圍），之後原文片段另外查。
        async _kiPickDigests(q, ids, mats, budget) {
            const enabledIds = new Set((await this._kiRun((store) => store.listSources())).filter((x) => x.enabled).map((x) => x.id));
            const rows = (await this._kiRun((store) => store.getDigests(ids && ids.length ? ids : null))).filter((d) => enabledIds.has(d.source_id)); if (!rows.length) return [];
            const qt = new Set(FaKnowledge.queryTokens(q)), relMemo = new Map(), rel = (d) => { if (relMemo.has(d)) return relMemo.get(d); const toks = FaKnowledge.tokenize(d.title + ' ' + d.text + ' ' + (d.terms || []).join(' ')); let m = 0; toks.forEach((t) => { if (qt.has(t)) m++; }); const v = toks.length ? m / Math.sqrt(toks.length) : 0; relMemo.set(d, v); return v; };
            const bySrc = new Map(); rows.forEach((d) => { if (!bySrc.has(d.source_id)) bySrc.set(d.source_id, []); bySrc.get(d.source_id).push(d); });
            const lvOf = (d) => (d.kind === 'doc' ? 99 : Number(String(d.kind).slice(1)) || 1), kidsMemo = new Map(), prioMemo = new Map(); let frontier = [], used = 0;
            const mk = (list) => {
                const maxLv = Math.max(0, ...list.filter((d) => d.kind !== 'doc').map(lvOf));
                const kidsOf = (d) => { if (kidsMemo.has(d)) return kidsMemo.get(d); const lv = d.kind === 'doc' ? maxLv : lvOf(d) - 1; const ks = lv < 1 ? [] : list.filter((x) => x.kind !== 'doc' && lvOf(x) === lv && x.line_start >= d.line_start && x.line_end <= d.line_end).sort((a, b) => a.line_start - b.line_start); kidsMemo.set(d, ks); return ks; };
                const prio = (d) => { if (prioMemo.has(d)) return prioMemo.get(d); let m = rel(d); kidsOf(d).forEach((k) => { m = Math.max(m, prio(k)); }); prioMemo.set(d, m); return m; };
                return { kidsOf, prio, maxLv, doc: list.find((d) => d.kind === 'doc') };
            };
            const ctxs = new Map(); bySrc.forEach((list, sid) => { const c = mk(list); ctxs.set(sid, c); if (c.doc) frontier.push(c.doc); else list.filter((d) => lvOf(d) === c.maxLv).forEach((d) => { frontier.push(d); used += d.text.length; }); });
            const blocked = new Set(); const cost = (d, kids) => kids.reduce((a, k) => a + k.text.length, 0) - (d.kind === 'doc' ? 0 : d.text.length);
            for (let guard = 0; guard < 400; guard++) {
                const cands = frontier.filter((d) => !blocked.has(d)).map((d) => ({ d, c: ctxs.get(d.source_id), p: ctxs.get(d.source_id).prio(d) })).filter((x) => x.p > 0 && x.c.kidsOf(x.d).length).sort((a, b) => b.p - a.p); if (!cands.length) break;
                const top = cands[0], kids = top.c.kidsOf(top.d), cs = cost(top.d, kids); if (used + cs > budget) { blocked.add(top.d); continue; }
                frontier = frontier.filter((d) => d !== top.d).concat(kids); used += cs;
            }
            return frontier.filter((d) => d.kind !== 'doc').map((d) => Object.assign({}, d, { sc: ctxs.get(d.source_id).prio(d) })).filter((d) => d.sc > 0).sort((a, b) => a.source_id - b.source_id || a.line_start - b.line_start);
        },
        // 檢索到的片段太短（只是標題）時，把後面幾行一起拿來
        async _kiWidenHits(mats) { for (const h of mats) { if (h.ctx) continue; h.ctx = String(h.quote); if (h.ctx.length < 200 && h.source_id) { try { const d = await this._kiRun((store) => store.detail(h.source_id, { line_start: h.line_start, line_end: h.line_end + 10 }, { maxLines: 14 })); const tx = ((d && d.lines) || []).map((l) => l.text).join('\n'); if (tx.length > h.ctx.length) h.ctx = tx; } catch (_) { /* */ } } } },
        // 要設計／寫程式這類請求：請模型列出要查的短關鍵詞，每條都查，每個來源至少再查一輪（避免只撈到其中一份手冊）
        async _kiGatherPlanned(request, onStep, ctl, sources, addHit, mats) {
            const step = (t) => { try { if (onStep) onStep(t); } catch (_) { /* */ } }; let queries = [];
            step('🧭 這是要創作／設計的請求，先決定要從知識庫查哪些資料…');
            try { const rp = await this._kiLlm('使用者說：「' + String(request).slice(0, 400) + '」\n他有一個知識庫（裡面是他放進去的手冊、文件）。為了做好這件事，需要先從知識庫查哪些資料（語法規則、函式用法、設計規範…）？請列出最多 8 個查詢，一行一個，每個只有 1 到 3 個詞，像搜尋引擎的關鍵詞（例如：struct、vector sort、scanf），中英文都可以，不要解釋、不要寫完整句子。', { systemPrompt: '你只負責列出要查什麼，不回答。', maxTokens: 500, temperature: 0 }, { label: '決定要查什麼', timeoutMs: 45000, onStep, ctl }); queries = String(rp || '').split('\n').map((l) => l.replace(/^[\s\-*\d.、)）]+/, '').trim()).filter((l) => l && l.length <= 40).slice(0, 8); } catch (e) { if (/已略過/.test(String((e && e.message) || e))) throw e; }
            if (!queries.length) return; step('　要查：' + queries.join('；'));
            for (const q of queries) { const r = await this._kiAsk({ question: q, limit: 3, no_expand: true, sources }).catch(() => null); let n = 0; for (const h of ((r && r.hits) || [])) if (mats.length < 14 && addHit(h)) n++; if (n) step('　「' + q.slice(0, 30) + '」→ 新增 ' + n + ' 段'); }
            try { const srcList = (await this._kiRun((store) => store.listSources())).filter((x) => x.enabled).slice(0, 8); for (const sc of srcList) { if (mats.some((h) => h.source_id === sc.id) || mats.length >= 14) continue; const r = await this._kiAsk({ question: queries.join(' ') + ' ' + String(request).slice(0, 60), limit: 2, no_expand: true, sources: [sc.id] }).catch(() => null); let n = 0; for (const h of ((r && r.hits) || [])) if (mats.length < 14 && addHit(h)) n++; if (n) step('　再從《' + sc.name + '》補 ' + n + ' 段'); } } catch (_) { /* */ }
        },
        async _kiRespond(question, history, onStep, ctl, sources) {
            const step = (t) => { try { if (onStep) onStep(t); } catch (_) { /* */ } }, t0 = Date.now(), q = String(question || '').trim(); if (!q) return { ok: false, error: '請說要問什麼' };
            const creative = /設計|寫(一個|個|出)?(程式|程序|腳本|code)|實作|實現|幫我(寫|做|設計|規劃)|規劃|產生|生成|範例|\b(design|implement|write|create|build|generate)\b/i.test(q);
            const ids = sources ? await this._kiResolveIds(sources) : null; const mats = [], seen = new Set();
            const addHit = (h) => { const k = h.source_id + ':' + h.line_start; if (seen.has(k)) return false; seen.add(k); mats.push(h); return true; };
            step('🔎 從知識庫找相關資料…'); const r0 = await this._kiAsk({ question: q, limit: 8, sources, onStep: step, ctl }).catch(() => ({ found: false, hits: [] })); (r0.hits || []).forEach(addHit);
            if (creative) await this._kiGatherPlanned(q, step, ctl, sources, addHit, mats);
            const hist = (Array.isArray(history) ? history : []).slice(-4).map((h) => '使用者：' + String(h.q).slice(0, 100) + '\n你：' + String(h.a || '').slice(0, 220)).join('\n');
            let attempts = 0, needed = [], used = null, reply = '';
            for (;;) {
                attempts++; await this._kiWidenHits(mats); const digs = await this._kiPickDigests(q, ids, mats, Math.floor(this._kiBudgetChars(false) * 0.28));
                // 組提示詞（同步版）：先概覽、再摘要、其餘給原文片段
                const mapCache = {}; const getMap = async (offline) => { const k = offline ? 'o' : 'n'; if (!mapCache[k]) mapCache[k] = await this._kiMapText(ids, Math.floor(this._kiBudgetChars(offline) * 0.18)); return mapCache[k]; };
                const composeFor = (offline, mapText) => {
                    const bud = this._kiBudgetChars(offline), digMax = Math.floor(bud * 0.28), items = []; let used2 = 0;
                    const passMax = bud - Math.floor(bud * 0.18) - digMax;
                    mats.forEach((h) => { const per = offline ? 350 : 900, txt = String(h.ctx || h.quote).slice(0, per); if (used2 + txt.length > passMax && items.length) return; used2 += txt.length; items.push({ n: items.length + 1, label: h.label, source: h.source, source_id: h.source_id, line_start: h.line_start, line_end: h.line_end, quote: h.quote, ctx: txt }); });
                    let du = 0; digs.slice().sort((x, y) => y.sc - x.sc).forEach((d) => { if (du + d.text.length > digMax) return; du += d.text.length; items.push({ n: 0, digest: true, label: '《' + d.name + '》第 ' + d.line_start + '–' + d.line_end + ' 行的摘要（模型整理，不是原文）', source: d.name, source_id: d.source_id, line_start: d.line_start || 1, line_end: d.line_end || 1, quote: d.text, ctx: d.text }); });
                    items.sort((x, y) => (x.digest ? 1 : 0) - (y.digest ? 1 : 0)); items.forEach((x, k) => { x.n = k + 1; });
                    const refs = items.map((x) => '[' + x.n + '] ' + (x.digest ? '（摘要）' : '《' + x.source + '》') + x.ctx).join('\n\n');
                    const prompt = '【知識庫概覽】（使用者放進來的所有文件，一份一兩句）\n' + mapText + '\n\n' + (hist ? '【對話前文】\n' + hist + '\n\n' : '') + '【參考資料】（有編號；標「摘要」的是事先讀過整理的大意，其餘是原文片段）\n' + (refs || '（這次沒有檢索到相關片段，只有上面的概覽）') + '\n\n【使用者說】\n' + q + '\n\n請像一個讀懂了這些文件的人那樣回答：\n1) 用自己的話理解、整合之後，以自然流暢的段落說明（需要時可以用少量條列），不要把原文一條一條照抄列出來；\n2) 有具體依據的地方，在句末標資料編號 [n]（整段的結尾標也可以）；指令、數字、名稱照資料原樣寫；\n3) 使用者要你設計、寫程式或創作時，直接創作：用到資料裡的語法、API、規則要照資料寫並標編號；資料沒講、憑你自己的知識補的，在那一句（程式碼是那一行的註解）標 [外]；結構與構想是你的，不用標；程式碼放在 ``` 圍起來的區塊裡；\n4) 資料不足以回答時，明講「知識庫裡沒有足夠的資料」，說明有什麼、缺什麼，再視情況用一般知識補充並標 [外]；\n5) 如果還需要看更多細節才答得好，答案寫完後最後一行輸出 NEED: 查詢1; 查詢2（只在真的需要時，每個查詢 1 到 3 個詞）。\n6) 需要比較或整理資料時可以用 Markdown 表格；需要圖示（流程圖、架構圖、示意圖）時可以直接輸出 ```svg 區塊（完整的 <svg>…</svg>，只用基本圖形與文字，不要 script）；要放圖片用 Markdown 圖片語法（只用資料裡出現過的圖片網址，不要編網址）。\n回答使用者用的語言。';
                    return { prompt, items };
                };
                const online = composeFor(false, await getMap(false)); let cur = online;
                step('📚 交給模型：概覽 ' + (await getMap(false)).split('\n').length + ' 份文件、章節摘要 ' + digs.length + ' 則、原文片段 ' + online.items.filter((x) => !x.digest).length + ' 段，提示詞共約 ' + online.prompt.length + ' 字' + (attempts > 1 ? '（補查之後第 ' + attempts + ' 次）' : '') + '…');
                const offMap = await getMap(true); let off = null;
                try {
                    reply = await this._kiLlm(online.prompt, { systemPrompt: '你是使用者的藏書閣：他放進來的文件就是你的記憶。依資料理解後用自己的話回答，有依據的標編號，資料沒有的標 [外]。', maxTokens: 3500, temperature: 0.3 }, { label: '回答', timeoutMs: 240000, onStep: step, ctl, onAttempt: (kind) => { if (kind === 'offline') { off = off || composeFor(true, offMap); cur = off; } else cur = online; }, offlinePrompt: () => (off = off || composeFor(true, offMap)).prompt });
                } catch (e) { return { ok: false, error: '模型沒有回應：' + String((e && e.message) || e).slice(0, 160), sources: online.items }; }
                used = cur;
                const nm = String(reply).match(/(?:^|\n)\s*NEED\s*[:：]\s*(.+)\s*$/i);
                if (nm && attempts < 2) { needed = nm[1].split(/[;；]/).map((x) => x.trim()).filter(Boolean).slice(0, 4); step('🔁 模型想看更多：' + needed.join('；') + '，再查一輪…'); let n = 0; for (const nq of needed) { const rr = await this._kiAsk({ question: nq, limit: 3, no_expand: true, sources }).catch(() => null); for (const h of ((rr && rr.hits) || [])) if (mats.length < 16 && addHit(h)) n++; } step('　補了 ' + n + ' 段'); if (n) continue; }
                break;
            }
            // 核對
            let text = String(reply || '').replace(/(?:^|\n)\s*NEED\s*[:：].*$/i, '').trim(); if (!text) return { ok: false, error: '模型回了空白', sources: used.items };
            if ((text.match(/```/g) || []).length % 2 === 1) text += '\n```';
            // 模型常把編號寫成 [2, 4]：統一成 [2][4]（程式碼區塊本身不動，只處理註解與說明文字）
            const normList = (t) => t.replace(/\[(\d+(?:\s*[,，、]\s*\d+)+)\]/g, (m, g) => g.split(/\s*[,，、]\s*/).map((y) => '[' + y + ']').join(''));
            text = text.split(/(```[^\n]*\n[\s\S]*?```)/g).map((part) => (/^```/.test(part) ? part.split('\n').map((ln) => { const ci = ln.search(/\/\/|\/\*|(^|\s)#(?!include|define|if|endif|else|pragma)|--\s/); return ci < 0 ? ln : ln.slice(0, ci) + normList(ln.slice(ci)); }).join('\n') : part.split(/(`[^`]*`)/g).map((x, i) => (i % 2 ? x : normList(x))).join(''))).join('');
            const items = used.items, corpus = FaKnowledge.fold(items.map((x) => x.ctx).join('\n') + '\n' + (await this._kiMapText(ids, 6000))).toLowerCase().replace(/\s+/g, '');
            const dropped = [], cited = new Set(); let invalid = 0;
            const fixRef = (m, d) => { const k = Number(d); if (k >= 1 && k <= items.length) { cited.add(k); return m; } invalid++; return '[?]'; };
            const cmdBad = (c) => { if (corpus.indexOf(FaKnowledge.fold(c).toLowerCase().replace(/\s+/g, '')) >= 0) return false; const toks = c.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || []; return toks.some((w) => corpus.indexOf(w.toLowerCase()) < 0); };
            const fixOutside = (t) => t.split(/(`[^`]*`)/g).map((x, i) => (i % 2 ? x : x.replace(/\[(\d+)\]/g, fixRef))).join('');
            const splitP = (text, re) => { const sp = []; const pr = text.replace(/`[^`]*`|!?\[[^\]]*\]\([^)]*\)/g, (m) => { sp.push(m); return '\u0001' + (sp.length - 1) + '\u0002'; }); return pr.split(re).map((x) => x.replace(/\u0001(\d+)\u0002/g, (m, i) => sp[Number(i)])); };
            const outParts = text.split(/(```[^\n]*\n[\s\S]*?```)/g).map((part) => {
                if (/^```/.test(part)) return part.split('\n').map((ln) => { const ci = ln.search(/\/\/|\/\*|(^|\s)#(?!include|define|if|endif|else|pragma)|--\s/); return ci < 0 ? ln : ln.slice(0, ci) + ln.slice(ci).replace(/\[(\d+)\]/g, fixRef); }).join('\n');
                return part.split('\n').map((line) => {
                    if (/^\s*\|.*\|\s*$/.test(line)) {
                        if (/^\s*\|[\s:\-|]+\|\s*$/.test(line)) return line;
                        return line.replace(/\|([^|]*)(?=\|)/g, (m0, cell) => {
                            const plain = cell.replace(/\[(?:\d+|外|\?)\]/g, '').trim(); if (!plain || /\[外\]/.test(cell)) return '|' + fixOutside(cell);
                            const bt2 = Array.from(plain.matchAll(/`([^`]+)`/g)).map((m) => m[1]), bad2 = bt2.find(cmdBad);
                            const ids3 = (plain.replace(/`[^`]*`/g, ' ').match(/[A-Za-z][A-Za-z0-9_.\-/:]{3,}|\d+(?:\.\d+)+|\d{3,}/g) || []).map((w) => w.replace(/[.\-:/]+$/, '')).filter((w) => w.length >= 3 && corpus.indexOf(w.toLowerCase()) < 0);
                            if (bad2 || ids3.length) { dropped.push({ text: plain.slice(0, 100), why: '表格裡的「' + String(bad2 || ids3[0]).slice(0, 30) + '」在給模型的資料裡找不到（沒標 [外]）' }); return '| —'; }
                            return '|' + fixOutside(cell);
                        });
                    }
                    const segs = splitP(line, /(?<=[。！？!?；;])/); const kept = [];
                    for (let seg of segs) {
                        seg = seg.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m0, alt, url) => { if (corpus.indexOf(FaKnowledge.fold(url).toLowerCase().replace(/\s+/g, '')) >= 0) return m0; dropped.push({ text: '圖片「' + String(alt).slice(0, 30) + '」', why: '圖片網址在給模型的資料裡找不到（模型不能自己編圖片網址）' }); return ''; });
                        const plain = seg.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\[(?:\d+|外|\?)\]/g, '').trim(); if (!plain) { kept.push(seg); continue; }
                        if (/\[外\]/.test(seg)) { kept.push(fixOutside(seg)); continue; }
                        const bt = Array.from(plain.matchAll(/`([^`]+)`/g)).map((m) => m[1]); const badCmd = bt.find(cmdBad);
                        const ids2 = (plain.replace(/`[^`]*`/g, ' ').match(/[A-Za-z][A-Za-z0-9_.\-/:]{3,}|\d+(?:\.\d+)+|\d{3,}/g) || []).map((w) => w.replace(/[.\-:/]+$/, '')); const missing = ids2.filter((w) => w.length >= 3 && corpus.indexOf(w.toLowerCase()) < 0);
                        if (badCmd || missing.length) {
                            // 只丟有問題的子句，同一句裡有依據的部分保留
                            const clauses = splitP(seg, /(?<=[，,；;、：:])/), bad = (cl) => { const pl = cl.replace(/\[(?:\d+|外|\?)\]/g, ''); return bt.some((c) => pl.indexOf(c) >= 0 && cmdBad(c)) || missing.some((w) => pl.toLowerCase().indexOf(w.toLowerCase()) >= 0); };
                            const good = clauses.filter((cl) => !bad(cl)), badOnes = clauses.filter(bad), why = badCmd ? '程式碼「' + badCmd.slice(0, 40) + '」用到的名稱在給模型的資料裡找不到（沒標 [外]）' : '「' + missing.slice(0, 3).join('、') + '」在給模型的資料裡找不到（沒標 [外]）';
                            badOnes.forEach((cl) => dropped.push({ text: cl.replace(/\[(?:\d+|外|\?)\]/g, '').trim().slice(0, 140), why }));
                            if (good.join('').replace(/\[(?:\d+|外|\?)\]/g, '').replace(/[，,；;、：:。！？!?\s]/g, '').length >= 14) { let t = good.join('').replace(/[，,；;、：:]\s*$/, ''); if (!/[。！？!?]\s*$/.test(t) && /[。！？!?]\s*$/.test(seg)) t += seg.match(/[。！？!?]\s*$/)[0]; kept.push(fixOutside(t)); }
                            continue;
                        }
                        kept.push(fixOutside(seg));
                    }
                    return kept.join('');
                }).join('\n');
            });
            const fixed = outParts.join('').replace(/\n{3,}/g, '\n\n').trim();
            // 程式碼的依據檢查
            const code = Array.from(fixed.matchAll(/```[^\n]*\n([\s\S]*?)```/g)).map((m) => m[1]).join('\n'); let report = null;
            if (code.trim()) {
                const defined = new Set(Array.from(code.matchAll(/\b(?:int|void|char|float|double|auto|bool|long|short|unsigned|class|struct|enum|def|function|func|fn)\s+\**([A-Za-z_]\w*)\s*[(\{:<=]/g)).map((m) => m[1]).concat(Array.from(code.matchAll(/\b([A-Za-z_]\w*)\s*(?:=\s*(?:\(|function|lambda)|\(\s*[^)]*\)\s*\{)/g)).map((m) => m[1])));
                const KW = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'main', 'catch', 'else', 'do', 'case', 'new', 'delete', 'throw', 'print', 'range', 'len', 'typeof', 'defined', 'elif', 'and', 'or', 'not']); const names = []; const add = (x) => { if (x && x.length >= 3 && !KW.has(x) && !defined.has(x.split(/::|\.|->/).pop()) && names.indexOf(x) < 0) names.push(x); };
                Array.from(code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.|->)[A-Za-z_][A-Za-z0-9_]*)*)\s*\(/g)).forEach((m) => add(m[1])); Array.from(code.matchAll(/#include\s*[<"]([^>"]+)[>"]/g)).forEach((m) => add(m[1])); Array.from(code.matchAll(/\bstd::[A-Za-z_]\w*/g)).forEach((m) => add(m[0]));
                const inKb = [], notInKb = []; const rawCorp = items.map((x) => FaKnowledge.fold(x.ctx));
                for (const nm of names.slice(0, 40)) { const probe = [nm, nm.split(/::|\.|->/).pop()].filter((x) => x && x.length >= 3); let at = -1; for (const pr of probe) { at = rawCorp.findIndex((c) => c.indexOf(FaKnowledge.fold(pr)) >= 0); if (at >= 0) break; } if (at >= 0) inKb.push({ name: nm, n: at + 1 }); else notInKb.push(nm); }
                report = { inKb, notInKb }; step('🔍 依據檢查：程式碼用到 ' + names.length + ' 個名稱，資料裡找得到 ' + inKb.length + ' 個，沒提到 ' + notInKb.length + ' 個');
            }
            step('✅ 核對完成：' + (dropped.length ? '丟掉 ' + dropped.length + ' 句對不上資料的' : '沒有句子被丟掉') + (invalid ? '，' + invalid + ' 個編號不存在' : ''));
            return { ok: true, text: fixed, sources: items, dropped, report, cited: Array.from(cited), needed, creative, invalid_refs: invalid, ms: Date.now() - t0 };
        },
        // ───── 摘要：逐層壓縮（像「分析大檔案」的 map-reduce），資訊不砍，只一層一層變精簡 ─────
        // 整份文件依序切成小段（每段約 2400 字，不切斷行、盡量在章節邊界換段）→ 每段摘一次（第 1 層）→ 每 6 個相鄰的摘要再摘一次（第 2 層）→ … → 最後一層只剩一個，就是整份文件的概覽（doc）。
        // 每一層都存下來（附行範圍），所以全文每一段都被讀過、沒有任何內容被截掉；回答時由上往下展開——只展開跟問題有關的分支，其他的留在上層的精簡版，上下文不會被塞爆。
        // 程式主導：怎麼切、怎麼分組、做到哪、要不要繼續都是程式決定；摘要裡的數字、英文名稱、指令必須在它的來源（原文或下一層的子摘要）裡找得到，核對不過的句子丟掉；可以停止，已做好的不重做、下次接著做。
        async _kiSummarize(text, mk, label, ctl) {
            const opts = { systemPrompt: '你把一段文字概括成幾句話，只根據內容，不加內容裡沒有的東西。', maxTokens: 900, temperature: 0 };
            const offFirst = !!(this.advancedSettings && this.advancedSettings.offlineMode);
            if (!offFirst) { try { return await this._kiLlm(mk(text), opts, { label, timeoutMs: 120000, ctl, noOffline: true }); } catch (e) { if (/已略過/.test(String((e && e.message) || e))) throw e; } }
            // 線上不行（或離線優先）：切成兩半各自用離線模型摘，再把兩段摘要接起來——離線模型的上下文小，但資訊不砍掉
            const t = String(text), mid = t.length > 1600 ? (() => { const m = t.indexOf('\n', Math.floor(t.length / 2)); return m > 0 && m < t.length - 200 ? m : Math.floor(t.length / 2); })() : -1, parts = mid > 0 ? [t.slice(0, mid), t.slice(mid)] : [t], outs = [];
            for (const part of parts) outs.push(await this._kiLlm(mk(part), opts, { label: label + '（離線）', timeoutMs: 180000, ctl, only: 'offline' }));
            return outs.join('\n');
        },
        async _kiBuildDigest(srcId, onProg, ctl) {
            const src = await this._kiRun((store) => store.getSource(srcId)); if (!src) return { ok: false, error: '找不到來源' };
            const have = await this._kiRun((store) => store.getDigests([srcId])), haveMap = new Map(have.map((d) => [d.kind + ':' + d.n, d])), norm = (x) => FaKnowledge.fold(x).toLowerCase().replace(/\s+/g, '');
            const parse = (reply, basis) => {
                const lines = String(reply || '').split('\n').map((l) => l.trim()).filter(Boolean); let terms = []; const body = [];
                for (const l of lines) { const m = /^(?:關鍵詞|关键词|關鍵字|keywords?)\s*[:：]\s*(.+)$/i.exec(l); if (m) terms = terms.concat(m[1].split(/[、,，;；]/).map((x) => x.trim()).filter((x) => x && x.length <= 30)); else body.push(l); }
                const hay = norm(basis), kept = []; let dropped = 0;
                body.join('').split(/(?<=[。！？!?])/).forEach((sg) => { const ids = (sg.match(/[A-Za-z][A-Za-z0-9_.\-/:]{3,}|\d+(?:\.\d+)+|\d{3,}/g) || []).map((w) => w.replace(/[.\-:/]+$/, '')); if (ids.some((w) => w.length >= 3 && hay.indexOf(w.toLowerCase()) < 0)) dropped++; else kept.push(sg); });
                return { text: kept.join('').trim(), terms: Array.from(new Set(terms.filter((x) => hay.indexOf(norm(x)) >= 0))).slice(0, 8), dropped };
            };
            // 第 1 層的視窗：依序切全文，一行都不漏
            const WIN = 2400, secStarts = new Set((src.sections || []).filter((x) => x.level <= 2).map((x) => x.line_start)), windows = []; let cur = null;
            const flush = () => { if (cur) { windows.push({ a: cur.a, b: cur.b, text: cur.lines.join('\n') }); cur = null; } };
            for (let li = 0; li < src.lines.length; li++) {
                const ln = src.lines[li], l1 = li + 1;
                if (ln.length > WIN * 1.5) { flush(); for (let o = 0; o < ln.length; o += WIN) windows.push({ a: l1, b: l1, text: ln.slice(o, o + WIN) }); continue; }
                if (cur && (cur.len + ln.length + 1 > WIN || (secStarts.has(l1) && cur.len >= 600))) flush();
                if (!ln.trim() && !cur) continue;
                if (!cur) cur = { a: l1, b: l1, lines: [], len: 0 }; cur.lines.push(ln); cur.len += ln.length + 1; cur.b = l1;
            }
            flush(); if (!windows.length) return { ok: true, made: 0, failed: 0, dropped: 0, total: 0 };
            let total = 0; { let c = windows.length; if (c === 1) total = 1; else { total = c; while (c > 1) { c = Math.ceil(c / 6); total += c; } } }
            let done = 0, made = 0, failed = 0, dropped = 0, level = 1, nodes = windows.map((w) => ({ a: w.a, b: w.b, text: w.text })), levels = 0;
            for (; level <= 12; level++) {
                const groups = []; if (level === 1) nodes.forEach((x) => groups.push([x])); else for (let g = 0; g < nodes.length; g += 6) groups.push(nodes.slice(g, g + 6));
                const isDoc = groups.length === 1, out = [];
                for (let gi = 0; gi < groups.length; gi++) {
                    const g = groups[gi], kind = isDoc ? 'doc' : 'L' + level, n = isDoc ? 0 : gi + 1, a = g[0].a, b = g[g.length - 1].b, ex = haveMap.get(kind + ':' + n);
                    if (ex && ex.line_start === a && ex.line_end === b) { out.push({ a, b, text: ex.text }); done++; continue; }
                    if (this._kiOrgStop) return { ok: true, stopped: true, made, failed, dropped, total, levels };
                    onProg && onProg({ done, total, text: '摘要 ' + (done + 1) + '/' + total + '（' + (isDoc ? '整份概覽' : '第 ' + level + ' 層') + '）' });
                    const basis = level === 1 ? g[0].text : g.map((x) => '[第 ' + x.a + '–' + x.b + ' 行] ' + x.text).join('\n');
                    const mk = (txt) => isDoc
                        ? '下面是文件《' + src.name + '》' + (level === 1 ? '的全文' : '各部分的摘要') + '。請用 3 到 5 句話概括這整份文件在講什麼、適合誰看、有哪些主要部分，用自己的話寫；最後另起一行寫「關鍵詞：」，接 5 到 8 個文件裡原本就有的詞，用頓號隔開。\n\n' + txt
                        : level === 1
                            ? '下面是文件《' + src.name + '》第 ' + a + '–' + b + ' 行的內容（依序切下來的一段）。請用 2 到 4 句話，用自己的話概括這一段在講什麼（重要的名稱、指令、數字照原樣保留，不要逐句抄）；最後另起一行寫「關鍵詞：」，接 3 到 6 個這一段裡原本就有的詞，用頓號隔開。\n\n' + txt
                            : '下面是文件《' + src.name + '》依序排列的幾段摘要（含行範圍）。請整合成 2 到 4 句話：保留重要的名稱、指令、數字，涵蓋每一段的主要主題，不要遺漏；最後另起一行寫「關鍵詞：」，接 3 到 6 個詞，用頓號隔開。\n\n' + txt;
                    let reply = null; try { reply = await this._kiSummarize(basis, mk, isDoc ? '整份概覽' : '摘要', ctl); } catch (e) { if (/已略過/.test(String((e && e.message) || e))) return { ok: true, stopped: true, made, failed, dropped, total, levels }; failed++; done++; if (failed >= 2 && made === 0) return { ok: false, error: '模型連續沒有回應：' + String((e && e.message) || e).slice(0, 100), made, failed, total }; continue; }
                    const r = parse(reply, basis); dropped += r.dropped; done++;
                    if (r.text) { await this._kiRun((store) => store.putDigest(srcId, kind, n, isDoc ? src.name : '第 ' + a + '–' + b + ' 行', a, b, r.text, r.terms, 'model'), true); made++; out.push({ a, b, text: r.text }); }
                    else { const ext = level === 1 ? basis.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 3).join(' ').slice(0, 320) : g.map((x) => String(x.text).slice(0, 110)).join(' ').slice(0, 480); if (ext) { await this._kiRun((store) => store.putDigest(srcId, kind, n, isDoc ? src.name : '第 ' + a + '–' + b + ' 行', a, b, ext, [], 'extract'), true); out.push({ a, b, text: ext }); made++; } failed++; }
                }
                levels = level; if (isDoc || !out.length) break; nodes = out;
            }
            return { ok: true, made, failed, dropped, total, levels };
        },
        // 叫模型：先走線上；線上逾時／出錯，緊接著改用離線文字模型（使用者在 Configure 裝好的）；離線也不行，再試一次線上（節點重新上線後就接得上）。
        // 每一步都用 onStep 說出原因與秒數；使用者可以按「略過等待」（ctl.cancel）。全部失敗就丟出最後一個錯誤，呼叫端退回「只給原文」，不會卡住。
        // 離線小模型的上下文小，所以呼叫端可以給 offlinePrompt（較短的提示詞）。離線模型寫出來的東西一樣要過逐句核對。
        async _kiLlm(prompt, opts, o) {
            o = o || {}; const tm = Math.max(o.timeoutMs || 60000, 60000), step = o.onStep || (() => {}), offFirst = !!(this.advancedSettings && this.advancedSettings.offlineMode);
            const plan = o.only === 'offline' ? ['offline'] : offFirst ? ['offline', 'online'] : o.noOffline ? ['online', 'online'] : ['online', 'online', 'offline', 'online']; let lastErr = null, offlineGone = false, skipRetry = false;
            for (let i = 0; i < plan.length; i++) {
                const kind = plan[i]; if (kind === 'offline' && offlineGone) continue; if (skipRetry && kind === 'online' && i === 1) continue; if (o.onAttempt) { try { o.onAttempt(kind); } catch (_) { /* */ } }
                let timer = null; const t0 = Date.now(), label = (o.label || '模型') + (kind === 'offline' ? '（離線模型）' : '');
                if (kind === 'offline') step('🔌 ' + (i === 0 ? '離線模式：' : '線上試了兩次都沒成功，') + '改用離線文字模型…（第一次要載入模型，會比較慢；小模型的品質有限，寫出來的一樣會逐句核對）');
                try {
                    const lim0 = kind === 'offline' ? Math.max(tm, 180000) : (i > 0 ? Math.round(tm * 1.5) : tm), lim = kind === 'offline' ? lim0 : lim0 * 4; // 線上：最多輪過 4 個模型，每個各自有 lim0 的耐心 // 線上重試時多給一點耐心：一次慢回應不代表離線
                    let lastActive = Date.now(); const touch = () => { lastActive = Date.now(); }; // 離線模型：有在吐字（或載入進度有在動）就不算沒回應，只有「安靜」超過上限才放棄；整體另有 20 分鐘的絕對上限
                    const call = kind === 'offline' ? this._kiOfflineComplete(o.offlinePrompt ? o.offlinePrompt() : prompt, Object.assign({}, opts, { onActive: touch })) : this._kiOnlineAcrossRows(prompt, opts, step, lim);
                    const reply = await Promise.race([
                        call,
                        new Promise((_, rej) => { const t00 = Date.now(), quiet = () => rej(new Error('等了 ' + Math.round(lim / 1000) + ' 秒沒有回應' + (kind === 'online' ? '（AI 節點可能斷線了）' : '（離線模型安靜太久，可能卡住了）'))); if (kind !== 'offline') { timer = setTimeout(quiet, lim); return; } const tick = () => { if (Date.now() - lastActive > lim || Date.now() - t00 > 20 * 60 * 1000) quiet(); else timer = setTimeout(tick, 4000); }; timer = setTimeout(tick, 4000); }),
                        new Promise((_, rej) => { if (o.ctl) o.ctl.cancel = () => rej(new Error('已略過等待')); }),
                    ]);
                    clearTimeout(timer);
                    if (!String(reply || '').trim()) throw new Error('模型回了空白');
                    if (kind === 'offline') step('　✅ 離線模型回應了（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）'); else if (i > 0) step('　✅ 線上模型接上了（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）');
                    return reply;
                } catch (e) {
                    clearTimeout(timer); lastErr = e; const msg = String((e && e.message) || e);
                    if (/已略過/.test(msg)) throw e;
                    if (kind === 'offline' && /還沒下載|沒有已下載|NOT_SUPPORTED|關掉|使用者取消/.test(msg)) offlineGone = true;
                    // 判斷「線上不行」要有憑據：逾時、5xx、429、網路錯誤才值得多試一次線上（節點可能只是忙或剛重連）；金鑰錯誤、404 這類試幾次都一樣，直接換離線
                    const transient = /逾時|沒有回應|timeout|network|Failed to fetch|網路|空白|HTTP 5\d\d|API錯誤\(5\d\d\)|API錯誤\(429\)|API錯誤\(408\)|429/i.test(msg); if (kind === 'online' && i === 0 && !transient) skipRetry = true;
                    const next = plan.slice(i + 1).find((k, j) => !(k === 'offline' && offlineGone) && !(skipRetry && k === 'online' && i + 1 + j === 1));
                    step('　⚠️ ' + label + '沒成功（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）：' + msg.slice(0, 140) + (next === 'offline' ? '。緊接著改用離線模型' : next === 'online' ? '。3 秒後再試線上（節點重新上線後就接得上）' : ''));
                    if (next === 'online') await new Promise((r) => setTimeout(r, 3000));
                }
            }
            throw lastErr;
        },
        // 離線文字模型（Configure 裡選好、已下載的）：只拿「文字生成」，不經過離線訓練器與工具
        // 線上：先試第一組，這個節點本身有問題（5xx、連線被重置、逾時、404、金鑰被拒）就換下一個線上模型，最多 4 個，才輪到離線。
        // 429（太密集）與 400（內容有問題）換節點沒有用，直接丟出去讓上層等一等再重試。每次換模型都寫進過程記錄（哪個模型、為什麼、花多久）。
        async _kiOnlineAcrossRows(prompt, opts, step, totalMs) {
            step = step || (() => {}); const perMs = Math.max(20000, Math.round((totalMs || 240000) / 4)); let order = [];
            try { const seen = new Set(); this._computeModelRowGroups().forEach((g) => { const first = this._pickRowFromGroup(g); [first].concat(g.rows.filter((r) => r !== first).slice(0, 1)).forEach((r) => { const c = this._resolveModelRowConfig(r); const key = c.apiUrl + '|' + c.apiModel + '|' + c.apiKey; if (c.apiKey && c.apiUrl && !seen.has(key)) { seen.add(key); order.push(c); } }); }); } catch (_) { order = []; }
            if (!order.length) { return this._callSimpleCompletion(prompt, opts); }
            order = order.slice(0, 4); let lastErr = null; const tried = [];
            // 暫時性的斷線（連線被重置、串流提早結束、5xx）：同一個節點先再試一次（隔一下），還是不行才換下一個線上模型；逾時（已經等夠久了）與 404／金鑰被拒不重試同一個節點
            const flaky = (m) => /ECONNRESET|串流提早結束|串流中斷|API錯誤\(5\d\d\)|網路錯誤|Failed to fetch/.test(m) && !/逾時|等了/.test(m);
            const endpointProblem = (m) => /API錯誤\((?:5\d\d|404|401|403)\)|網路錯誤|Failed to fetch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|逾時|等了|串流/.test(m);
            for (let i = 0; i < order.length; i++) {
                const c = order[i]; let again = 0;
                for (;;) {
                    const t0 = Date.now(); let timer = null;
                    try {
                        const reply = await Promise.race([this._callSimpleCompletion(prompt, Object.assign({}, opts, { cfg: { apiKey: c.apiKey, apiUrl: c.apiUrl, apiModel: c.apiModel } })), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('逾時：等了 ' + Math.round(perMs / 1000) + ' 秒沒有回應')), perMs); })]);
                        clearTimeout(timer); if (i > 0 || again) step('　✅ ' + (again ? '同一個節點再試一次成功了' : '改用「' + c.apiModel + '」成功了') + '（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）'); return reply;
                    } catch (e) {
                        clearTimeout(timer); lastErr = e; const msg = String((e && e.message) || e); tried.push(c.apiModel + '：' + msg.slice(0, 60));
                        if (flaky(msg) && again < 1) { again++; step('　⚠️ 線上模型「' + c.apiModel + '」斷線了（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）：' + msg.slice(0, 90) + '。同一個節點再試一次…'); await new Promise((r) => setTimeout(r, 1500)); continue; }
                        if (!endpointProblem(msg) || i === order.length - 1) { if (i > 0 && lastErr) { lastErr.message = msg + '（已輪過 ' + (i + 1) + ' 個線上模型：' + tried.join('；') + '）'; } throw lastErr; }
                        step('　⚠️ 線上模型「' + c.apiModel + '」這個節點有問題（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）：' + msg.slice(0, 100) + '。改試下一個線上模型'); break;
                    }
                }
            }
            throw lastErr;
        },
        async _kiOfflineComplete(prompt, opts) {
            opts = opts || {}; const S = this._omSettings(), inst = await this._omInstalled();
            const route = FaVlm.routeStages({ config: S.roles, bench: S.bench, installed: inst.set, requireInstalled: true, defaultId: S.textModel, hasTools: false });
            const model = route && route.answer; if (!model) throw new Error('還沒有下載離線文字模型（Configure → 離線模型 裡可以下載）');
            const msgs = []; if (opts.systemPrompt) msgs.push({ role: 'system', content: opts.systemPrompt }); msgs.push({ role: 'user', content: String(prompt) });
            const r = await this._llmGenerate(model, { messages: msgs, maxTokens: Math.min(Number(opts.maxTokens) || 512, 700), deterministic: true }, { update() { if (opts.onActive) opts.onActive(); }, log() { if (opts.onActive) opts.onActive(); }, onToken() { if (opts.onActive) opts.onActive(); } });
            return String(r == null ? '' : r).trim();
        },
        // 模型想的「可能出現在文件裡的詞」：只拿來多找一輪，不當答案。沒有模型可用就回空的（維持原本的檢索結果）。
        async _kiExpandQuery(q, onStep, ctl) {
            if (typeof this._callSimpleCompletion !== 'function') return [];
            const reply = await this._kiLlm('使用者在一份文件（可能是英文的使用手冊、教學、講義）裡找答案，問題是：「' + q + '」\n請列出最多 8 個「這個問題的答案附近很可能出現的詞或短語」，中文和英文都要有（例如問題問「怎麼安裝」，可以列 install、installation、安裝、setup）。一行一個，只輸出詞本身，不要解釋。', { systemPrompt: '你是搜尋助手，只負責想關鍵詞，不回答問題。', maxTokens: 800, temperature: 0 }, { label: '想關鍵詞', timeoutMs: 45000, onStep, ctl });
            return String(reply || '').split('\n').map((l) => l.replace(/^[\s\-*\d.、)）]+/, '').trim()).filter((l) => l && l.length <= 30).slice(0, 8);
        },
        async _kiResolveIds(list) { const arr = Array.isArray(list) ? list : String(list).split(/[,，、]/); return this._kiRun(async (store) => { const ids = []; for (const x of arr) { const s = await store.findSource(String(x).trim()); if (s) ids.push(s.id); } return ids; }); },
        async _kiWithSource(ref, fn) { return this._kiRun(async (store) => { const s = await store.findSource(ref); if (!s) return { ok: false, error: '找不到來源：' + ref + '（knowledge_sources 看清單）' }; return Object.assign({ ok: true }, await fn(store, s)); }); },
        _kiFormatHits(res) {
            if (!res.found) return '🔎 ' + res.message;
            return res.hits.map((h, i) => '**' + (i + 1) + '.** ' + h.label + (h.found_by ? '　〔' + h.found_by + '〕' : '') + '\n' + String(h.quote).split('\n').slice(0, 6).map((l) => '> ' + l).join('\n')).join('\n\n');
        },

        // ───── 自動處理流程：上傳 → 背景處理 → 等一下 → 問 ─────
        // 使用者只做兩件事：把文件放進來、問問題。放進來之後程式自己依序做（做好的不重做、失敗的稍後再試、可暫停、重新開啟會接著做）：
        //   ① 讀入與建索引（加入時同步完成，立刻就能用關鍵字查）② 語意向量（小型模型，第一次要下載約 118 MB）③ 逐層摘要（讓 AI 讀懂每份文件，對話時當記憶）④ 關聯（只用字面證據，回答時附相關）。
        // 處理到哪裡，每個來源下面都有進度條；還沒做完也可以先問，只是回答會少用到摘要與語意。
        async _kiPipeline() {
            if (this._kiPipeRun) { this._kiPipeAgain = true; return this._kiPipeRun; }
            if (!this._kiSettings().pipeline) return { ok: true, skipped: true, note: '自動處理已關閉（設定裡可以打開）' };
            this._kiPipeStop = false; this._kiOrgStop = false;
            const run = (async () => {
                const rep = { embedded: 0, digests: 0, failed: 0, links: 0 };
                try {
                    do {
                        this._kiPipeAgain = false; const st = this._kiSettings();
                        if (st.embedConsent && !this._kiPipeStop) { this._kiPipeStage = '語意向量'; const e = await this._kiEmbedPending().catch((x) => ({ error: String((x && x.message) || x) })); if (e.embedded) rep.embedded += e.embedded; if (e.error) rep.embed_error = e.error; }
                        const list = (await this._kiRun((store) => store.listSources())).filter((x) => x.enabled); const failedAt = (this._kiDigFail = this._kiDigFail || {});
                        for (const x of list) {
                            if (this._kiPipeStop) break; if (failedAt[x.id] && Date.now() - failedAt[x.id] < 300000) continue;
                            this._kiPipeStage = '摘要：' + String(x.name).slice(0, 20);
                            const dg = await this._kiBuildDigest(x.id, (e) => this._kiEmit({ op: 'organize', source_id: x.id, name: x.name, done: e.done, total: e.total, text: e.text }), null).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
                            if (dg.ok === false) { failedAt[x.id] = Date.now(); rep.failed++; rep.digest_error = dg.error; continue; }
                            rep.digests += dg.made || 0; if (dg.stopped) break; delete failedAt[x.id];
                            try { const docs = await this._kiRun((store) => store.getDigests([x.id], 'doc')); if (docs[0] && docs[0].terms && docs[0].terms.length) await this._kiRun((store) => store.setTags(x.id, docs[0].terms, 'model'), true); } catch (_) { /* */ }
                        }
                        if (!this._kiPipeStop) { this._kiPipeStage = '關聯'; const lk = await this._kiRun((store) => store.rebuildLinks(), true).catch(() => ({ links: 0 })); rep.links = lk.links; }
                    } while (this._kiPipeAgain && !this._kiPipeStop);
                } finally { this._kiPipeStage = ''; this._kiPipeRun = null; this._kiEmit({ op: 'organize', end: true }); this._kiEmit({ op: 'pipeline', end: true }); }
                await this._kiNoteFlag(); return Object.assign({ ok: true, stopped: !!this._kiPipeStop }, rep);
            })();
            this._kiPipeRun = run; return run;
        },
        async _kiRefresh() {
            const list = await this._kiRun((store) => store.listSources()); const refreshed = [];
            const urlSrcs = list.filter((x) => x.url && /^https?:\/\//i.test(x.url)), states = {}; urlSrcs.forEach((x) => { states[x.name] = 'wait'; });
            this._kiEmit({ op: 'refresh', states: Object.assign({}, states) }); // 後面還沒輪到的，先都標「等待前面的完成」
            try {
                for (const sc of urlSrcs) {
                    this._kiEmit({ op: 'refresh', name: sc.name, state: 'run' });
                    try { const r = await this._kiAdd({ url: sc.url, name: sc.name }); refreshed.push({ source: sc.name, status: r.ok ? r.status : 'failed', error: r.ok ? undefined : r.error }); }
                    catch (e) { refreshed.push({ source: sc.name, status: 'failed', error: String((e && e.message) || e) }); }
                    this._kiEmit({ op: 'refresh', name: sc.name, state: 'done' });
                }
            } finally { this._kiEmit({ op: 'refresh', end: true }); }
            await this._kiNoteFlag(); this._kiPipeline().catch(() => { /* */ });
            return { ok: true, refreshed, note: '語意向量、逐層摘要、關聯會在背景自動補齊。' };
        },
        async _kiStatus() {
            const st = await this._kiRun((store) => store.stats()); const k = this._kiSettings(); const dc = await this._kiRun((store) => store.digestCounts()).catch(() => null);
            return { ok: true, pending: { vectors: k.embedConsent ? Math.max(0, (st.chunks || 0) - (st.vectors || 0)) : 0, digests: Math.max(0, (st.enabled || 0) - ((dc && dc.docs) || 0)) }, location: k.location, location_label: this._kiLocationLabel(), ref: this._kiRef(), capacity_mb: k.maxMB || 0, images: k.images, digests: dc, pipeline_on: k.pipeline, pipeline: { running: !!this._kiPipeRun, stage: this._kiPipeStage || '' }, stats: st, semantic: !!(k.embedConsent && st.vectors > 0) };
        },
        // ───── 面板（對話裡的小工具：查詢／管理／關聯）─────
        _kiPanelHost() {
            const self = this;
            return {
                palette: () => ({ dark: !self._isLightTheme() }),
                status: () => self._kiStatus(), sources: () => self._kiSources(),
                ask: (a) => self._kiAsk(a), respond: (q, h, onStep, ctl) => self._kiRespond(q, h, onStep, ctl), chatLoad: () => self._kiChatLoad(), chatSave: (l) => self._kiChatSave(l), chatClear: () => self._kiChatClear(), route: (q, h, onStep, ctl) => self._kiRoute(q, h, onStep, ctl), answerAI: (q, hits, onStep, ctl) => self._kiAnswerAI(q, hits, onStep, ctl), onProgress: (fn) => self._kiOn(fn),
                outline: (ref) => self._kiWithSource(ref, (store, s) => store.outline(s.id)),
                detail: (ref, which, o) => self._kiWithSource(ref, (store, s) => store.detail(s.id, which, o)),
                summary: (ref) => self._kiWithSource(ref, (store, s) => store.summary(s.id)),
                links: async () => self._kiRun(async (store) => { let ls = await store.getLinks(null); if (!ls.length) { await store.rebuildLinks(); ls = await store.getLinks(null); } return { ok: true, links: ls }; }, true),
                setLinkStatus: (id, status) => self._kiRun((store) => store.setLinkStatus(id, status), true),
                rebuildLinks: () => self._kiRun((store) => store.rebuildLinks(), true),
                addUrl: (url) => self._kiAdd({ url }),
                addText: (name, text, kind) => self._kiAdd({ text, name, kind }),
                addFile: async (file) => { const id = await self.fileCache.put(file.name, file.type || 'application/octet-stream', file, 'uploaded'); return self._kiAdd({ file_id: id, name: file.name }); },
                remove: (ref) => self._kiRemove(ref), enable: (ref, on) => self._kiEnable(ref, on),
                refresh: () => self._kiRefresh(), renderMarkdown: (t) => self._kiRenderMd(t), pipelineStart: () => { self._kiPipeline().catch(() => { /* */ }); return { ok: true }; }, pipelineStop: () => { self._kiPipeStop = true; self._kiOrgStop = true; return { ok: true }; }, setPipeline: async (on) => { self._kiSaveSettings({ pipeline: !!on }); if (on) self._kiPipeline().catch(() => { /* */ }); return { ok: true }; },
                embedStatus: () => self._kiEmbedCommand('status'), embedRun: () => self._kiEmbedCommand('run'),
                migrate: (kind, path, keepOld) => self._kiMigrate({ kind, ref: path }, { keepOld }),
                setImages: async (o) => { const cur = self._kiSettings().images; self._kiSaveSettings({ images: Object.assign({}, cur, o || {}) }); return { ok: true, images: self._kiSettings().images }; },
                setCapacity: async (mb) => { self._kiSaveSettings({ maxMB: Number(mb) > 0 ? Number(mb) : 0 }); return { ok: true }; },
            };
        },
        // 開面板：面板一律是對話裡的一則訊息（重新整理後還在對話內）；預設立刻彈出成視窗（可拖曳、改大小、最大化、收回），inline=true 就留在對話裡。
        _kiLivePanels() { return Array.from((this._kiPanels || new Map()).values()).filter((w) => w._panel && w._panel.isConnected && w._panel._ki); },
        _kiOpenPanel(tab, inline) {
            const live = this._kiLivePanels();
            if (!inline && live.length) { const k = live[live.length - 1]._panel._ki; k.pop(); k.refresh(); return live[live.length - 1]._panel; }
            this._kiPopOnMount = !inline;
            this._pushAssistantMessage('📚 Knowledge Inventory：來源、問答、管理都在這個面板（可以彈出成視窗、最大化、收回對話裡）。\n\n```fa-knowledge\n' + JSON.stringify({ id: 'k' + Date.now().toString(36), tab: tab || 'ask' }) + '\n```', null);
            try { this._persistChatHistory(); this._renderMessageHistory(); } catch (_) { /* */ }
        },
        _mountKnowledgePanels(mdDiv) {
            if (typeof FaKnowledgeUI === 'undefined' || !FaKnowledgeUI || !FaKnowledgeUI.mount) return; this._kiPanels = this._kiPanels || new Map();
            mdDiv.querySelectorAll('pre > code.language-fa-knowledge').forEach((code) => {
                let ref = null; try { ref = JSON.parse(code.textContent); } catch (_) { /* */ } if (!ref) return; const key = String(ref.id || 'main');
                let wrap = this._kiPanels.get(key);
                if (!wrap || !wrap._panel || !wrap._panel.isConnected) {
                    wrap = document.createElement('div'); const panel = FaKnowledgeUI.mount({ host: this._kiPanelHost() }); wrap.appendChild(panel); wrap._panel = panel; this._kiPanels.set(key, wrap);
                    if (this._kiPanels.size > 6) { for (const [k, w] of this._kiPanels) { if (k !== key && !(w._panel && w._panel._ki && w._panel._ki.isPopped())) { try { w._panel._ki.destroy(); } catch (_) { /* */ } this._kiPanels.delete(k); break; } } }
                }
                code.parentElement.replaceWith(wrap);
                if (this._kiPopOnMount) { this._kiPopOnMount = false; setTimeout(() => { try { wrap._panel._ki.pop(); } catch (_) { /* */ } }, 0); }
            });
        },

        // ───── 搬家：IndexedDB ⇄ 磁碟檔案 ⇄ FAP ─────
        async _kiReadBytes(loc) {
            if (loc.kind === 'idb') return this._kiIdbGet(loc.ref || 'default');
            const ref = loc.kind === 'file' ? 'file:' + loc.ref : 'fap:' + String(loc.ref).replace(/^fap:/i, '');
            if (loc.kind === 'file') { const raw = window.desktopAPI && window.desktopAPI.rawfs; if (!raw) throw new Error('網頁版讀不到磁碟路徑'); const r = await raw.readFile(loc.ref, 'base64'); return this._sqlB64ToBytes(r.base64 || ''); }
            return (await this._resolveTerminalCopySource(ref)).bytes;
        },
        async _kiWriteBytes(loc, bytes) {
            if (loc.kind === 'idb') return this._kiIdbPut(loc.ref || 'default', bytes);
            if (loc.kind === 'file') { const raw = window.desktopAPI && window.desktopAPI.rawfs; if (!raw) throw new Error('網頁版不能寫磁碟路徑，請選 IndexedDB 或 FAP'); await raw.writeFile(loc.ref, { base64: this._sqlBytesToB64(bytes) }); return true; }
            const ref = 'fap:' + String(loc.ref).replace(/^fap:/i, ''); return this._writeTerminalCopyDestination(ref, bytes, ref.split('/').pop() || 'knowledge.keeplookup', 'application/vnd.sqlite3');
        },
        // 搬到新位置：先把目前的內容存回、複製過去、用新位置開起來核對（來源數、片段數、向量數都要一樣）、確認沒問題才切換設定。舊的預設保留（keepOld=false 才刪）。
        async _kiMigrate(to, o) {
            o = o || {}; const from = this._kiSettings().location; const dest = { kind: to.kind, ref: String(to.ref || (to.kind === 'idb' ? 'default' : '')) };
            if (!['idb', 'file', 'fap'].includes(dest.kind)) return { ok: false, error: '位置要是 idb、file 或 fap' };
            if (dest.kind !== 'idb' && !dest.ref) return { ok: false, error: dest.kind === 'file' ? '磁碟檔案要給完整路徑，例如 D:\\knowledge\\main.keeplookup' : 'FAP 要給 <名稱>/<路徑>，例如 myfolder/knowledge/main.keeplookup' };
            if (dest.kind === 'file' && !/\.keeplookup$/i.test(dest.ref)) dest.ref += '.keeplookup'; if (dest.kind === 'fap' && !/\.keeplookup$/i.test(dest.ref)) dest.ref += '.keeplookup';
            if (dest.kind === from.kind && dest.ref === from.ref) return { ok: false, error: '已經在這個位置了' };
            if (dest.kind === 'file' && !(window.desktopAPI && window.desktopAPI.rawfs)) return { ok: false, error: '網頁版沒有磁碟路徑可以用；請選 IndexedDB 或 FAP 資料夾' };
            const before = await this._kiRun((store) => store.stats()); await this._kiRun(() => 0, true); await this._kiClose();
            let bytes; try { bytes = await this._kiReadBytes(from); } catch (e) { return { ok: false, error: '讀不到目前的知識庫檔案：' + String((e && e.message) || e) }; }
            if (!bytes || !bytes.length) return { ok: false, error: '目前的知識庫是空的（還沒有存過），不用搬；直接換位置即可。' };
            try { await this._kiWriteBytes(dest, bytes); } catch (e) { return { ok: false, error: '寫不進新位置：' + String((e && e.message) || e) + '（目前的位置沒有動）' }; }
            const prev = this.advancedSettings.knowledge; this._kiSaveSettings({ location: dest });
            let after; try { after = await this._kiRun((store) => store.stats()); } catch (e) { this.advancedSettings.knowledge = prev; this._saveAdvancedSettings(); await this._kiClose(); return { ok: false, error: '新位置打不開，已退回原本的位置：' + String((e && e.message) || e) }; }
            const same = after.sources === before.sources && after.chunks === before.chunks && after.vectors === before.vectors;
            if (!same) { this.advancedSettings.knowledge = prev; this._saveAdvancedSettings(); await this._kiClose(); return { ok: false, error: '搬過去之後數量對不起來（來源 ' + before.sources + '→' + after.sources + '、片段 ' + before.chunks + '→' + after.chunks + '、向量 ' + before.vectors + '→' + after.vectors + '），已退回原本的位置。' }; }
            let removed = false; if (o.keepOld === false) { try { if (from.kind === 'idb') { await this._kiIdbDel(from.ref || 'default'); removed = true; } else if (from.kind === 'file' && window.desktopAPI && window.desktopAPI.rawfs && window.desktopAPI.rawfs.remove) { await window.desktopAPI.rawfs.remove(from.ref, false); removed = true; } } catch (_) { /* 刪不掉就留著 */ } }
            return { ok: true, from: from.kind + ':' + from.ref, to: dest.kind + ':' + dest.ref, verified: after, old_removed: removed, note: removed ? undefined : '舊位置的檔案還留著（確認新位置正常之後可以自己刪）。' };
        },

        // ───── 工具與指令 ─────
        _registerKnowledgeTools(registerOptional) {
            const parse = async (raw) => { try { return await this.repairJsonPayload(String(raw || '{}')); } catch (_) { return {}; } };
            const tool = (name, desc, props, required, fn) => registerOptional(name, desc, async function (raw) { const a = await parse(raw); try { return JSON.stringify(await fn.call(this, a)); } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); } }, { type: 'object', properties: props, required: required || [], additionalProperties: false });
            const SRC = { type: 'string', description: '來源的名稱（可以只寫一部分）或編號，knowledge_sources 看清單' };
            tool('knowledge_ask', '問 Knowledge Inventory（使用者自己放進去的文件、網頁、講義、錄音轉錄…）。回傳最相關的**原文片段**與出處（哪個來源、第幾行、章節／頁／投影片／時間），不生成、不改寫。回答時只能根據 hits 的 quote，每個說法標出處；找不到就說找不到。檢索是關鍵字（BM25）加語意（小型向量模型，已啟用時）。sources 可限定來源。',
                { question: { type: 'string', description: '問題或關鍵字' }, sources: { type: 'array', items: { type: 'string' }, description: '選填：只在這些來源裡找（名稱或編號）' }, limit: { type: 'integer', description: '最多幾個片段，預設 5' } }, ['question'], function (a) { return this._kiAsk(a); });
            tool('knowledge_sources', '列出 Knowledge Inventory 裡的來源（編號、名稱、格式、有沒有啟用、片段數、向量數）與知識庫放在哪裡、總量。', {}, [], function () { return this._kiSources(); });
            tool('knowledge_outline', '看一個來源的目錄（章節標題、層級、每節從第幾行到第幾行）。再用 knowledge_detail 讀某一節。', { source: SRC }, ['source'], function (a) { return this._kiWithSource(a.source, (store, s) => store.outline(s.id)); });
            tool('knowledge_detail', '讀一個來源的原文並逐行附行號：section＝章節編號或標題的一部分，或給 line_start／line_end。長的會分段（truncated／next_line）。', { source: SRC, section: { description: '章節編號或標題的一部分' }, line_start: { type: 'integer' }, line_end: { type: 'integer' }, max_lines: { type: 'integer', description: '最多幾行，預設 200' } }, ['source'], function (a) { return this._kiWithSource(a.source, (store, s) => store.detail(s.id, a.line_start ? { line_start: a.line_start, line_end: a.line_end || a.line_start } : (a.section != null ? a.section : 1), { maxLines: a.max_lines })); });
            tool('knowledge_summary', '一個來源的摘要：只選來源裡的原句（每章節最多 2 句），每句附行號，逐句核對過，沒有改寫。', { source: SRC }, ['source'], function (a) { return this._kiWithSource(a.source, (store, s) => store.summary(s.id)); });
            tool('knowledge_links', '知識之間的關聯（只用字面證據：來源互相提到、共有的專有名詞或關鍵詞），雙方都附行號與原文。source 不給就列全部。', { source: SRC }, [], async function (a) { const r = await this._kiRun(async (store) => { let id = null; if (a.source) { const s = await store.findSource(a.source); if (!s) return { ok: false, error: '找不到來源：' + a.source }; id = s.id; } let ls = await store.getLinks(id); if (!ls.length) { await store.rebuildLinks(); ls = await store.getLinks(id); } return { ok: true, links: ls }; }, true); return r; });
            tool('knowledge_add', '把東西放進 Knowledge Inventory：file_id（聊天附件或已上傳的檔案：pdf、docx、pptx、xlsx、md、txt、textile、mediawiki、json、jsonl、yaml、toon、csv、其他文字，mp3／mp4 會先語音轉錄）、url（網頁／wiki，會抓下來）、path（桌面版本機路徑）、text（直接給文字，可指定 kind）。同名同內容不會重複加。容量上限看設定（可設無限）。', { file_id: { type: 'string' }, url: { type: 'string' }, path: { type: 'string' }, text: { type: 'string' }, name: { type: 'string', description: '選填：來源名稱' }, kind: { type: 'string', description: '選填：格式（md、txt、textile、mediawiki、json、jsonl、yaml、toon、csv…）' }, force: { type: 'boolean' } }, [], function (a) { return this._kiAdd(a); });
            tool('knowledge_remove', '把一個來源從 Knowledge Inventory 移除（連同它的片段、向量、關聯）。', { source: SRC }, ['source'], function (a) { return this._kiRemove(a.source); });
            tool('knowledge_enable', '啟用或停用一個來源（停用的來源不會出現在回答裡，但資料還在）。', { source: SRC, enabled: { type: 'boolean' } }, ['source', 'enabled'], function (a) { return this._kiEnable(a.source, a.enabled !== false); });
            tool('knowledge_embed', '建立語意索引（小型向量模型把每個片段轉成向量）。第一次要下載約 118 MB 的模型（先從專案的 vendor-models 分支，沒有再 HuggingFace）；action:"enable" 同意並開始，"status" 看進度。', { action: { type: 'string', enum: ['status', 'enable', 'run'] } }, [], function (a) { return this._kiEmbedCommand(a.action || 'status'); });
            tool('knowledge_refresh', '更新知識庫：網址來源重新抓一次（內容有變才更新）、補算還沒有向量的片段、重算關聯。（檔案來源要更新請用 knowledge_add 重新加入，內容有變才會更新。）', {}, [], function () { return this._kiRefresh(); });
            tool('knowledge_organize', '處理流程：語意向量、逐層摘要、關聯。放進來的來源會自動處理，這個工具是叫它現在補齊並等到做完（線上模型用不了會自動改用離線模型）。', { source: SRC }, [], function () { return this._kiPipeline(); });
            tool('knowledge_location', '看或搬 Knowledge Inventory（.keeplookup，SQLite3 檔）放的位置：action:"status"；action:"migrate" 搬到 to＝idb（瀏覽器 IndexedDB）、file（磁碟，path 給完整路徑，桌面版）、fap（path 給 <FAP 名稱>/<路徑>）。搬完會核對數量，不一致就退回。', { action: { type: 'string', enum: ['status', 'migrate'] }, to: { type: 'string', enum: ['idb', 'file', 'fap'] }, path: { type: 'string' }, keep_old: { type: 'boolean' } }, [], async function (a) { if (a.action === 'migrate') return this._kiMigrate({ kind: a.to, ref: a.path }, { keepOld: a.keep_old !== false }); const st = await this._kiRun((store) => store.stats()); return { ok: true, location: this._kiLocationLabel(), ref: this._kiRef(), capacity_mb: this._kiSettings().maxMB || '無限', stats: st }; });
        },
        async _kiEmbedCommand(action) {
            const st = this._kiSettings(); const stats = await this._kiRun((store) => store.stats());
            if (action === 'status') return { ok: true, enabled: st.embedConsent, model: FaCatalogEmbed.MODEL.repo, approx_mb: FaCatalogEmbed.MODEL.approxMB, vectors: stats.vectors, chunks: stats.chunks, pending: stats.chunks - stats.vectors };
            this._kiSaveSettings({ embedConsent: true }); const rr = await this._kiPipeline(); return Object.assign({ ok: true }, rr);
        },
        _registerKnowledgeCommand() {
            const say = (r, t) => r._pushAssistantMessage(t, null);
            this.register_slash_command('/knowledge', '[問題｜add｜list｜outline｜summary｜detail｜links｜remove｜embed｜organize｜refresh｜where｜migrate｜capacity]',
                'Knowledge Inventory：你自己放進去的文件、網頁、講義、錄音轉錄的本機知識庫，回答只用裡面的原文，每個回答都標出處（來源、第幾行、章節／頁／時間）。/knowledge 蜘蛛怎麼結網（直接問）；/knowledge add <網址或檔名>、/knowledge list、/knowledge outline <來源>、/knowledge summary <來源>、/knowledge detail <來源> <章節>、/knowledge links、/knowledge remove <來源>、/knowledge embed（啟用語意索引）、/knowledge organize（模型整理）、/knowledge refresh（更新）、/knowledge where、/knowledge migrate idb|file <路徑>|fap <名稱/路徑>、/knowledge capacity <MB｜無限>。',
                async (argsText, run) => {
                    const r = run || this; const raw = String(argsText || '').trim(); r.messages.push({ role: 'user', content: '/knowledge' + (raw ? ' ' + raw : '') });
                    const m = /^(\S+)\s*([\s\S]*)$/.exec(raw) || [], sub = (m[1] || '').toLowerCase(), rest = (m[2] || '').trim();
                    try {
                        if (!raw || sub === 'help' || sub === '?') {
                            const st = await r._kiRun((store) => store.stats());
                            say(r, '📚 **Knowledge Inventory**　位置：' + r._kiLocationLabel() + '\n來源 ' + st.sources + '（啟用 ' + st.enabled + '）、片段 ' + st.chunks + '、向量 ' + st.vectors + '、關聯 ' + st.links + '、容量上限 ' + (r._kiSettings().maxMB ? r._kiSettings().maxMB + ' MB' : '無限') + '\n\n用法：`/knowledge ui`（開啟浮動視窗：來源、問答、管理）、`/knowledge 問題`（直接問）、`add <網址｜檔名>`、`list`、`outline <來源>`、`summary <來源>`、`detail <來源> <章節>`、`links`、`remove <來源>`、`embed`（語意索引）、`organize`（模型整理）、`refresh`、`where`、`migrate idb｜file <路徑>｜fap <名稱/路徑>`、`capacity <MB｜無限>`。');
                        } else if (sub === 'list') {
                            const s = await r._kiSources(); say(r, '📚 ' + s.location + '\n' + (s.sources.length ? s.sources.map((x) => '- **' + x.id + '** ' + x.name + '（' + x.kind + '，' + x.sections + ' 節、' + x.chunks + ' 片段、向量 ' + x.vectors + (x.enabled ? '' : '，已停用') + (x.tags && x.tags.length ? '，關鍵詞：' + x.tags.join('、') : '') + '）').join('\n') : '（還沒有來源。/knowledge add <網址或檔名>）'));
                        } else if (sub === 'add') {
                            if (!rest) { say(r, '用法：/knowledge add <網址｜附件或已上傳的檔名｜file_id>'); }
                            else {
                                const a = /^https?:\/\//i.test(rest) ? { url: rest } : { file_id: rest };
                                if (a.file_id) { const all = await r.fileCache.getAll(); const hit = all.filter((x) => x && x.blob && (x.id === rest || String(x.filename || '').toLowerCase().includes(rest.toLowerCase()))).sort((p, q) => (q.createdAt || 0) - (p.createdAt || 0))[0]; if (hit) a.file_id = hit.id; else { say(r, '⚠️ 找不到檔案「' + rest + '」：請先把檔案附加到對話（📎），或給網址。'); a.file_id = null; } }
                                if (a.url || a.file_id) { say(r, '📥 加入中…'); const res = await r._kiAdd(a); say(r, res.ok ? '✅ ' + (res.status === 'unchanged' ? '內容沒有變，不用更新：' : res.status === 'updated' ? '已更新：' : '已加入：') + res.name + '（' + res.kind + '，' + res.lines + ' 行、' + res.sections + ' 節、' + res.chunks + ' 片段）' + (res.embedding && res.embedding.embedded ? '\n語意索引：' + res.embedding.embedded + ' 片段' : res.embedding && res.embedding.note ? '\n' + res.embedding.note : '') : '⚠️ ' + res.error); }
                            }
                        } else if (sub === 'outline') { const o = await r._kiWithSource(rest, (store, s) => store.outline(s.id)); say(r, o.ok === false ? '⚠️ ' + o.error : '📑 **' + o.source + '**（' + o.lines + ' 行）\n' + o.sections.map((x) => '　'.repeat(Math.max(0, x.level - 1)) + '- ' + x.title + '　〔第 ' + x.line_start + '–' + x.line_end + ' 行〕').join('\n'));
                        } else if (sub === 'summary') { const o = await r._kiWithSource(rest, (store, s) => store.summary(s.id)); say(r, o.ok === false ? '⚠️ ' + o.error : '📝 **' + o.source + '** 的摘要（只選原句，附行號）\n' + o.sentences.map((x) => '- ' + x.quote + '　〔第 ' + x.line_start + ' 行' + (x.section ? '，' + x.section : '') + '〕').join('\n'));
                        } else if (sub === 'detail') { const mm = /^(\S+(?:\s+\S+)*?)\s+(\S+)$/.exec(rest) || [null, rest, '1']; const o = await r._kiWithSource(mm[1], (store, s) => store.detail(s.id, /^\d+$/.test(mm[2]) ? Number(mm[2]) : mm[2], { maxLines: 80 })); say(r, o.ok === false || o.error ? '⚠️ ' + (o.error) : '📄 ' + o.cite.label + '\n```\n' + o.lines.map((l) => String(l.line).padStart(4) + '  ' + l.text).join('\n') + '\n```' + (o.truncated ? '\n（還有，從第 ' + o.next_line + ' 行接著看）' : ''));
                        } else if (sub === 'links') { const o = await r._kiRun(async (store) => { let ls = await store.getLinks(null); if (!ls.length) { await store.rebuildLinks(); ls = await store.getLinks(null); } return ls; }, true); say(r, o.length ? '🔗 知識關聯（字面證據）\n' + o.slice(0, 30).map((l) => '- **' + l.from.source + '** ⇄ **' + l.to.source + '**　〔' + (l.kind === 'mentions' ? '提到' : '共有「' + l.term + '」') + '〕\n  > ' + l.from.source + ' 第 ' + l.from.line_start + ' 行：' + String(l.from.quote || '').slice(0, 80) + (l.to.line_start ? '\n  > ' + l.to.source + ' 第 ' + l.to.line_start + ' 行：' + String(l.to.quote || '').slice(0, 80) : '')).join('\n') : '（目前沒有找到關聯）');
                        } else if (sub === 'remove') { const o = await r._kiRemove(rest); say(r, o.ok ? '🗑 已移除：' + o.removed : '⚠️ ' + o.error);
                        } else if (sub === 'embed') { say(r, '🧠 語意索引…'); const o = await r._kiEmbedCommand(rest === 'status' ? 'status' : 'run'); say(r, o.ok === false ? '⚠️ ' + o.error : '✅ ' + (o.embedded != null ? '建立了 ' + o.embedded + ' 個片段的向量（' + Math.round(o.ms / 100) / 10 + ' 秒）' : '語意索引：' + (o.enabled ? '已啟用' : '未啟用') + '，向量 ' + o.vectors + '/' + o.chunks));
                        } else if (sub === 'organize') { say(r, '⚙ 處理流程進行中（語意向量、逐層摘要、關聯）…'); const o = await r._kiPipeline(); say(r, '✅ ' + (o.stopped ? '已暫停' : '做完了') + '：新增向量 ' + (o.embedded || 0) + '、摘要 ' + (o.digests || 0) + ' 則、關聯 ' + (o.links || 0) + ' 筆' + (o.failed ? '；' + o.failed + ' 份文件的摘要沒成功（模型沒回應，稍後會再試）' : '') + (o.embed_error ? '；語意向量：' + o.embed_error : ''));
                        } else if (sub === 'refresh') { say(r, '🔄 更新中…'); const o = await r._kiRefresh(); const e = o.embedding || {}; say(r, '🔄 更新完成：' + (o.refreshed.length ? '網址來源 ' + o.refreshed.map((x) => x.source + '（' + (x.error ? '⚠️ ' + x.error : x.status) + '）').join('、') + '；' : '') + (e.embedded != null ? '新增 ' + e.embedded + ' 個向量；' : e.note ? e.note + '；' : e.error ? '語意索引 ⚠️ ' + e.error + '；' : '') + '關聯 ' + o.links + ' 筆');
                        } else if (sub === 'ui' || sub === 'panel' || sub === 'manage' || sub === '管理') { r._kiOpenPanel(null, /inline|對話/.test(rest));
                        } else if (sub === 'where' || sub === 'location') { const st = await r._kiRun((store) => store.stats()); say(r, '📍 ' + r._kiLocationLabel() + '\n（SQLite3 檔，副檔名 .keeplookup；ref：' + r._kiRef() + '）\n來源 ' + st.sources + '、片段 ' + st.chunks + '、向量 ' + st.vectors);
                        } else if (sub === 'migrate') { const mm = /^(idb|file|fap)\s*([\s\S]*)$/i.exec(rest); if (!mm) say(r, '用法：/knowledge migrate idb｜file <完整路徑>｜fap <FAP名稱/路徑>'); else { say(r, '📦 搬家中…'); const o = await r._kiMigrate({ kind: mm[1].toLowerCase(), ref: mm[2].trim() }, { keepOld: true }); say(r, o.ok ? '✅ 已搬到 ' + o.to + '，數量核對一致（來源 ' + o.verified.sources + '、片段 ' + o.verified.chunks + '、向量 ' + o.verified.vectors + '）。' + (o.note ? '\n' + o.note : '') : '⚠️ ' + o.error); }
                        } else if (sub === 'capacity') { const v = /^(無限|不限|unlimited|0)$/i.test(rest) ? 0 : Number(rest); if (!Number.isFinite(v) || v < 0) say(r, '用法：/knowledge capacity <MB 數字｜無限>'); else { r._kiSaveSettings({ maxMB: v }); say(r, '✅ 容量上限：' + (v ? v + ' MB' : '無限')); } }
                        else {
                            const res = await r._kiAsk({ question: raw }); say(r, '🔎 **' + raw + '**\n\n' + r._kiFormatHits(res) + (res.found && !res.semantic ? '\n\n（' + res.semantic_note + '）' : ''));
                        }
                    } catch (e) { say(r, '⚠️ Knowledge Inventory：' + String((e && e.message) || e)); }
                    try { r._persistChatHistory(); r._renderMessageHistory(); } catch (_) { /* */ }
                });
        },
    };
    return { methods, READ_TOOLS, ALL_TOOLS };
})();
