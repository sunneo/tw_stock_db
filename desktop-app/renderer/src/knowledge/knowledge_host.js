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
            return { location: { kind: L.kind, ref: String(L.ref || (L.kind === 'idb' ? 'default' : '')) }, maxMB: Number(k.maxMB) > 0 ? Number(k.maxMB) : 0, embedConsent: !!k.embedConsent, autoEmbed: k.autoEmbed !== false, images: { enabled: !!(k.images && k.images.enabled), maxPerSource: Math.max(1, Math.min(60, Number(k.images && k.images.maxPerSource) || 12)), minKB: Math.max(1, Math.min(500, Number(k.images && k.images.minKB) || 15)) } };
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
            await this._kiClose();
            if (!this._sqlAvailable()) throw new Error('這個環境沒有 SQLite 引擎（需要桌面版，或支援 Web Worker 的瀏覽器）');
            const h = await this._sqlOpen(ref, { create: true });
            const exec = async (sql, bind) => (await this._sqlCall('exec', { db: h.db, sql, bind, limit: 1000000, timeoutMs: 600000 })).results;
            const store = new FaKnowledgeStore.Store(exec); await store.init(); await h.commit();
            this._kiS = { ref, h, store, chain: Promise.resolve() };
            return this._kiS;
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
                return { name, kind: 'xlsx', raw: { sheets: wb.sheets.map((sh) => ({ name: sh.name, rows: [sh.columns || []].concat(sh.rows || []) })) }, url };
            }
            if (AUDIO_VIDEO.test(ext)) {
                const tr = await this._transcribeMedia(rec, a.language); if (tr && tr.ok === false) return { error: '語音轉錄失敗：' + tr.error };
                const text = (tr.chunks && tr.chunks.length) ? tr.chunks.map((c) => '[' + hms(c.timestamp && c.timestamp[0]) + ']\n' + String(c.text || '').trim()).join('\n') : String(tr.text || '');
                if (!text.trim()) return { error: '轉錄結果是空的' };
                return { name, kind: ext, raw: text, url, note: '語音轉錄文字，可能有錯字；時間是該句開始的時間。' };
            }
            if (ext === 'html' || ext === 'htm') { const r = this._extractReadableContentFromHtml(await rec.blob.text()); return { name: title || r.title || name, kind: 'md', raw: r.markdown, url }; }
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
            if (res.status !== 'unchanged' && this._kiSettings().autoEmbed && this._kiSettings().embedConsent) { const e = await this._kiEmbedPending().catch((x) => ({ error: String((x && x.message) || x) })); out.embedding = e; }
            else if (res.status !== 'unchanged') out.embedding = { skipped: true, note: this._kiSettings().embedConsent ? '自動建立語意索引已關閉；用 knowledge_embed 補' : '還沒啟用語意索引（第一次要下載約 118 MB 的小型模型，/knowledge embed 啟用）；目前只有關鍵字檢索（BM25）。' };
            return out;
        },
        async _kiRemove(ref) { return this._kiRun(async (store) => { const s = await store.findSource(ref); if (!s) return { ok: false, error: '找不到來源：' + ref }; await store.removeSource(s.id); return { ok: true, removed: s.name }; }, true).then(async (r) => { await this._kiNoteFlag(); return r; }); },
        async _kiEnable(ref, on) { return this._kiRun(async (store) => { const s = await store.findSource(ref); if (!s) return { ok: false, error: '找不到來源：' + ref }; await store.setEnabled(s.id, on); return { ok: true, name: s.name, enabled: !!on }; }, true).then(async (r) => { await this._kiNoteFlag(); return r; }); },
        async _kiSources() { return this._kiRun(async (store) => ({ ok: true, location: this._kiLocationLabel(), stats: await store.stats(), sources: (await store.listSources()).map((s) => ({ id: s.id, name: s.name, kind: s.kind, enabled: !!s.enabled, chars: s.chars, sections: s.sections, chunks: s.chunks, vectors: s.vectors, tags: s.tags ? (() => { try { return JSON.parse(s.tags).terms; } catch (_) { return undefined; } })() : undefined })) })); },

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
                const terms = await this._kiExpandQuery(q).catch(() => []);
                step(terms.length ? '　模型提的詞：' + terms.join('、') : '　（模型沒有回應，維持第一輪的結果）');
                if (terms.length) {
                    const q2 = q + ' ' + terms.join(' '); const qv2 = qv.vec ? await this._kiQueryVec(q2).catch(() => ({ vec: null })) : { vec: null };
                    const r2 = await this._kiRun((store) => store.answer(q2, { minCoverage: 0.06, limit: lim, sources: ids, queryVec: qv2.vec || qv.vec || undefined, model }));
                    const hasKw = (r) => (r.hits || []).some((h) => /關鍵字/.test(h.found_by || '')); const take = r2.found && (!res.found || strong(r2) || (hasKw(r2) && !hasKw(res)) || (r2.hits[0] && r2.hits[0].score > ((res.hits[0] && res.hits[0].score) || 0)));
                    step('　第二輪：' + (r2.found ? '找到 ' + r2.hits.length + ' 筆，' + (take ? '採用這一輪' : '不比第一輪好，維持第一輪') : '沒有找到，維持第一輪'));
                    if (take) { res = r2; expanded = terms; }
                }
            }
            return Object.assign(res, { expanded_terms: expanded || undefined, semantic: !!qv.vec, semantic_note: qv.vec ? undefined : qv.why + '（只用關鍵字檢索）', how_to_answer: res.found ? '只能根據 hits 裡的 quote 回答，每個說法後面標出處（label：來源、第幾行）；quote 沒講到的就說沒有，不要補充或推測。' : '沒有找到，就照實說在知識庫裡找不到，不要用自己的知識代替。' });
        },
        // AI 整理：把找到的原文片段編號交給模型，請它只用這些回答、每句結尾標 [編號]。
        // 程式逐句核對：沒標編號、編號不存在、句子裡的指令／數字／英文識別字在被引用的原文裡找不到的句子，一律丟掉（並告訴使用者丟了幾句）。
        async _kiAnswerAI(question, hits, onStep) {
            const step = (t) => { try { if (onStep) onStep(t); } catch (_) { /* */ } };
            const use = (hits || []).slice(0, 6); if (!use.length) return { ok: false, error: '沒有可以整理的原文' };
            if (typeof this._callSimpleCompletion !== 'function') return { ok: false, error: '這個環境沒有可用的模型' };
            // 命中的只是標題（投影片標題、章節名）時，答案常在它後面幾行：把後面的幾行一起交給模型（仍是原文）
            for (const h of use) {
                h.ctx = String(h.quote);
                if (h.ctx.length < 160 && h.source_id) { try { const d = await this._kiRun((store) => store.detail(h.source_id, { line_start: h.line_start, line_end: h.line_end + 8 }, { maxLines: 12 })); const t = ((d && d.lines) || []).map((l) => l.text).join('\n'); if (t.length > h.ctx.length) h.ctx = t; } catch (_) { /* */ } }
            }
            const ctx = use.map((h, i) => '[' + (i + 1) + '] 《' + h.source + '》' + h.ctx.slice(0, 900)).join('\n\n');
            step('🤖 交給模型整理（只准用 ' + use.length + ' 段原文，每句要標編號）…'); const t0 = Date.now();
            let reply = ''; try {
                reply = await this._callSimpleCompletion('問題：' + question + '\n\n下面是從知識庫找到的原文片段（有編號）：\n\n' + ctx + '\n\n請只根據這些片段回答問題。規則：1) 每一句結尾都要標它所根據的片段編號，例如「按下 Save 鈕 [2]」；2) 指令放在 `反引號` 裡，並且逐字照抄原文；數字、名稱原樣照抄，不要改寫；3) 片段沒有講到的就不要說，不要補充或推測；4) 標題或章節名稱跟問題對得上也算有找到（例如「在《某某》找到標題『Plugin Installation』 [2]」），把它後面接著的內容也一併說出來；5) 完全找不到答案就只輸出「找不到」。', { systemPrompt: '你只能用給你的片段回答，每句都要標編號。', maxTokens: 1500, temperature: 0 });
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
        // 模型想的「可能出現在文件裡的詞」：只拿來多找一輪，不當答案。沒有模型可用就回空的（維持原本的檢索結果）。
        async _kiExpandQuery(q) {
            if (typeof this._callSimpleCompletion !== 'function') return [];
            const reply = await this._callSimpleCompletion('使用者在一份文件（可能是英文的使用手冊、教學、講義）裡找答案，問題是：「' + q + '」\n請列出最多 8 個「這個問題的答案附近很可能出現的詞或短語」，中文和英文都要有（例如問題問「怎麼安裝」，可以列 install、installation、安裝、setup）。一行一個，只輸出詞本身，不要解釋。', { systemPrompt: '你是搜尋助手，只負責想關鍵詞，不回答問題。', maxTokens: 800, temperature: 0 });
            return String(reply || '').split('\n').map((l) => l.replace(/^[\s\-*\d.、)）]+/, '').trim()).filter((l) => l && l.length <= 30).slice(0, 8);
        },
        async _kiResolveIds(list) { const arr = Array.isArray(list) ? list : String(list).split(/[,，、]/); return this._kiRun(async (store) => { const ids = []; for (const x of arr) { const s = await store.findSource(String(x).trim()); if (s) ids.push(s.id); } return ids; }); },
        async _kiWithSource(ref, fn) { return this._kiRun(async (store) => { const s = await store.findSource(ref); if (!s) return { ok: false, error: '找不到來源：' + ref + '（knowledge_sources 看清單）' }; return Object.assign({ ok: true }, await fn(store, s)); }); },
        _kiFormatHits(res) {
            if (!res.found) return '🔎 ' + res.message;
            return res.hits.map((h, i) => '**' + (i + 1) + '.** ' + h.label + (h.found_by ? '　〔' + h.found_by + '〕' : '') + '\n' + String(h.quote).split('\n').slice(0, 6).map((l) => '> ' + l).join('\n')).join('\n\n');
        },

        // ───── 模型整理（按鈕／指令）：接 LLM 橋接——線上不行時橋接自動改走離線模型。模型只挑「來源裡原本就有的詞」，程式逐個核對 ─────
        async _kiOrganize(ref, onProgress) {
            const list = await this._kiRun((store) => store.listSources()); const one = ref ? await this._kiRun((store) => store.findSource(ref)) : null; const targets = ref ? (one ? list.filter((s) => s.id === one.id) : []) : list.filter((s) => s.enabled);
            if (!targets.length) return { ok: false, error: ref ? '找不到來源：' + ref : '知識庫是空的' };
            const report = []; let rejected = 0;
            for (const t of targets) {
                if (onProgress) onProgress('整理「' + t.name + '」…'); this._kiEmit({ op: 'organize', source_id: t.id, name: t.name, done: report.length, total: targets.length, text: '模型整理 ' + (report.length + 1) + '/' + targets.length + '：' + t.name });
                const src = await this._kiRun((store) => store.getSource(t.id)); const sample = src.text.length > 6000 ? src.text.slice(0, 3000) + '\n…\n' + src.text.slice(Math.floor(src.text.length / 2) - 1000, Math.floor(src.text.length / 2) + 1000) : src.text;
                let reply = '';
                try { reply = await this._callSimpleCompletion('下面是一份文件的內容（可能只有節錄）。請列出最多 8 個最能代表它的關鍵詞或短語。規則：每一個都必須是文件裡「原本出現過的字詞」，原樣抄下來，不要翻譯、不要改寫、不要新創；一行一個，只輸出詞本身。\n\n' + sample, { systemPrompt: '你是文件整理助手，只做挑選，不做創作。', maxTokens: 1500, temperature: 0 }); } catch (e) { report.push({ source: t.name, error: '模型沒有回應：' + String((e && e.message) || e).slice(0, 120) }); continue; }
                const hay = src.text.toLowerCase().replace(/\s+/g, ''); const terms = [];
                String(reply || '').split('\n').map((l) => l.replace(/^[\s\-*\d.、)）]+/, '').trim()).filter((l) => l && l.length <= 40).forEach((l) => { if (hay.indexOf(l.toLowerCase().replace(/\s+/g, '')) >= 0 && terms.indexOf(l) < 0) terms.push(l); else rejected++; });
                await this._kiRun((store) => store.setTags(t.id, terms.slice(0, 8), 'model'), true);
                report.push({ source: t.name, tags: terms.slice(0, 8) });
            }
            this._kiEmit({ op: 'organize', done: targets.length, total: targets.length, text: '重算關聯…' });
            const lk = await this._kiRun((store) => store.rebuildLinks(), true); this._kiEmit({ op: 'organize', end: true, done: targets.length, total: targets.length });
            return { ok: true, organized: report, links: lk.links, rejected_terms: rejected, note: '關鍵詞都是來源裡原本就有的字（程式逐個核對過，沒有的丟掉了）；關聯只用字面證據。' };
        },

        // ───── 更新知識庫（按鈕）：網址來源重新抓（內容有變才更新）、補算語意向量、重算關聯 ─────
        async _kiRefresh() {
            const list = await this._kiRun((store) => store.listSources()); const refreshed = [];
            for (const s of list) {
                if (!s.url || !/^https?:\/\//i.test(s.url)) continue;
                try { const r = await this._kiAdd({ url: s.url, name: s.name }); refreshed.push({ source: s.name, status: r.ok ? r.status : 'failed', error: r.ok ? undefined : r.error }); }
                catch (e) { refreshed.push({ source: s.name, status: 'failed', error: String((e && e.message) || e) }); }
            }
            const embedding = await this._kiEmbedPending().catch((x) => ({ error: String((x && x.message) || x) }));
            const lk = await this._kiRun((store) => store.rebuildLinks(), true); await this._kiNoteFlag();
            return { ok: true, refreshed, embedding, links: lk.links };
        },
        async _kiStatus() {
            const st = await this._kiRun((store) => store.stats()); const k = this._kiSettings();
            return { ok: true, location: k.location, location_label: this._kiLocationLabel(), ref: this._kiRef(), capacity_mb: k.maxMB || 0, images: k.images, stats: st, semantic: !!(k.embedConsent && st.vectors > 0) };
        },
        // ───── 面板（對話裡的小工具：查詢／管理／關聯）─────
        _kiPanelHost() {
            const self = this;
            return {
                palette: () => ({ dark: !self._isLightTheme() }),
                status: () => self._kiStatus(), sources: () => self._kiSources(),
                ask: (a) => self._kiAsk(a), answerAI: (q, hits, onStep) => self._kiAnswerAI(q, hits, onStep), onProgress: (fn) => self._kiOn(fn),
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
                refresh: () => self._kiRefresh(), organize: (ref) => self._kiOrganize(ref || null),
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
            tool('knowledge_organize', '模型整理：請模型替每個來源挑關鍵詞（只能是來源裡原本有的字，程式逐個核對），並重算關聯。線上模型用不了會自動改用離線模型。', { source: SRC }, [], function (a) { return this._kiOrganize(a.source); });
            tool('knowledge_location', '看或搬 Knowledge Inventory（.keeplookup，SQLite3 檔）放的位置：action:"status"；action:"migrate" 搬到 to＝idb（瀏覽器 IndexedDB）、file（磁碟，path 給完整路徑，桌面版）、fap（path 給 <FAP 名稱>/<路徑>）。搬完會核對數量，不一致就退回。', { action: { type: 'string', enum: ['status', 'migrate'] }, to: { type: 'string', enum: ['idb', 'file', 'fap'] }, path: { type: 'string' }, keep_old: { type: 'boolean' } }, [], async function (a) { if (a.action === 'migrate') return this._kiMigrate({ kind: a.to, ref: a.path }, { keepOld: a.keep_old !== false }); const st = await this._kiRun((store) => store.stats()); return { ok: true, location: this._kiLocationLabel(), ref: this._kiRef(), capacity_mb: this._kiSettings().maxMB || '無限', stats: st }; });
        },
        async _kiEmbedCommand(action) {
            const st = this._kiSettings(); const stats = await this._kiRun((store) => store.stats());
            if (action === 'status') return { ok: true, enabled: st.embedConsent, model: FaCatalogEmbed.MODEL.repo, approx_mb: FaCatalogEmbed.MODEL.approxMB, vectors: stats.vectors, chunks: stats.chunks, pending: stats.chunks - stats.vectors };
            if (!st.embedConsent) {
                const ans = await this.requestUserForm({ title: '⬇️ 要啟用語意索引嗎？', description: '會下載小型的語意向量模型（' + FaCatalogEmbed.MODEL.repo + '，約 ' + FaCatalogEmbed.MODEL.approxMB + ' MB，先從專案的 vendor-models 分支，沒有再用 HuggingFace），在你的瀏覽器／這台機器上跑，文字不會上傳。之後每個加入的來源都會建立語意索引，問答能找到「意思相近但用字不同」的片段。', fields: [], submitLabel: '下載並啟用' }).catch(() => null);
                if (!ans || ans.cancelled) return { ok: false, error: '沒有啟用語意索引（你取消了）' };
                this._kiSaveSettings({ embedConsent: true });
            }
            const r = await this._kiEmbedPending(); return Object.assign({ ok: !r.error }, r);
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
                        } else if (sub === 'organize') { say(r, '🧹 模型整理中…（線上模型用不了會自動改用離線模型）'); const o = await r._kiOrganize(rest || null); say(r, o.ok ? '✅ 整理好了\n' + o.organized.map((x) => '- ' + x.source + '：' + (x.error ? '⚠️ ' + x.error : (x.tags.length ? x.tags.join('、') : '（沒有挑出可以核對的關鍵詞）'))).join('\n') + '\n\n' + o.note : '⚠️ ' + o.error);
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
