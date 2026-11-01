/* 編輯器的本機檔案綁定的主機轉接層(接在 docx_host.js 後面,同一個 FaEditHost)。核心在 local_file.js(FaLocalFile)。設計見 DESIGN.edit-docs.md §3。
 * 桌面版:用 desktopAPI.rawfs 的絕對路徑(這個 Electron 的原生檔案對話框不會顯示,所以路徑用輸入的:/edit-file 路徑、或標題列「💾 本機檔案」裡輸入);writeFile 不是原子的、也沒有 rename,
 *   所以存檔前先比對檔案有沒有在外面被改過(大小+修改時間,不同再比內容),寫完讀回檢查。
 * 網頁版:File System Access(Chrome／Edge):選檔／另存得到控制代碼,存在 IndexedDB,下次開啟專案還在(權限要重新按允許)。
 * 綁定存在專案的 origin.file(每台機器各自的,不會跟著遠端共筆傳給別人)。支援的編輯器:edit-markdown、edit-text、edit-csv、edit-xlsx、edit-docx。 */
(function () {
    'use strict';
    const H = FaEditHost, M = H.methods, T = H.T;
    const FILE_KINDS = { 'edit-markdown': 'text', 'edit-text': 'text', 'edit-csv': 'text', 'edit-xlsx': 'bin', 'edit-docx': 'bin' };
    const isUtf8 = (u) => { try { new TextDecoder('utf-8', { fatal: true }).decode(u); return true; } catch (_) { return false; } };
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const unb64 = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    // ───── 控制代碼存在 IndexedDB（FileSystemFileHandle 可以直接存）
    function idbStore() {
        const open = () => new Promise((res, rej) => { const r = indexedDB.open('fa-file-handles', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('h', mode), q = fn(t.objectStore('h')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
        return { get: (k) => tx('readonly', (s) => s.get(k)), set: (k, v) => tx('readwrite', (s) => s.put(v, k)), del: (k) => tx('readwrite', (s) => s.delete(k)) };
    }
    M._edFilePlatform = function () {
        if (this._edFilePlat) return this._edFilePlat; const out = {};
        const raw = window.desktopAPI && window.desktopAPI.rawfs;
        if (raw) out.desk = { stat: async (p) => raw.stat(p), read: async (p) => { const r = await raw.readFile(p); return r && r.base64 != null ? unb64(r.base64) : new TextEncoder().encode(String((r && r.text) || '')); }, write: async (p, bytes) => { await raw.writeFile(p, { base64: b64(bytes) }); } };
        if (typeof window.showOpenFilePicker === 'function') {
            const perm = async (h, write) => { const o = { mode: write ? 'readwrite' : 'read' }; if (h.queryPermission && (await h.queryPermission(o)) === 'granted') return true; return !!(h.requestPermission && (await h.requestPermission(o)) === 'granted'); };
            out.web = { pick: async (o) => { try { const a = await window.showOpenFilePicker({ multiple: false, types: (o && o.types) || undefined }); return a[0] || null; } catch (e) { if (e && e.name === 'AbortError') return null; throw e; } },
                pickSave: async (o) => { try { return await window.showSaveFilePicker({ suggestedName: o && o.suggestedName, types: (o && o.types) || undefined }); } catch (e) { if (e && e.name === 'AbortError') return null; throw e; } },
                file: async (h) => { const f = await h.getFile(); return { bytes: new Uint8Array(await f.arrayBuffer()), size: f.size, mtimeMs: f.lastModified, name: f.name }; },
                write: async (h, bytes) => { const w = await h.createWritable(); try { await w.write(bytes); } finally { await w.close(); } }, allowed: perm };
            try { out.store = idbStore(); } catch (_) { /* 沒有 IndexedDB：下次開啟要重新綁定 */ }
        }
        this._edFilePlat = out; return out;
    };
    M._edIsLocalPath = function (t) { return typeof FaLocalFile !== 'undefined' && FaLocalFile.looksLikePath(t) && !!(window.desktopAPI && window.desktopAPI.rawfs); };
    M._edLocalFile = function (kind, id, proj) {
        const self = this, key = kind + ':' + id, plat = this._edFilePlatform(), lf = FaLocalFile.create(plat); this._edFileB = this._edFileB || new Map();
        const ob = proj && proj.origin && proj.origin.file; if (ob && ob.via && !this._edFileB.has(key)) this._edFileB.set(key, Object.assign({}, ob));
        const persist = (b) => { if (b) this._edFileB.set(key, b); else this._edFileB.delete(key); return this._edPatchOrigin(kind, id, (o) => { o.file = b ? Object.assign({}, b) : { name: (o.file && o.file.name) || '' }; }).catch(() => {}); };
        const withEnc = (b, bytes) => (FILE_KINDS[kind] === 'text' ? Object.assign({}, b, { enc: isUtf8(bytes) ? 'utf-8' : 'big5' }) : b);
        const askPath = (msg, def) => { const d = window.desktopAPI && window.desktopAPI.dialogs; if (!d || !d.prompt) return null; const v = d.prompt(msg, def || ''); return v ? String(v).trim() : null; };
        return {
            info: () => self._edFileB.get(key) || null, supported: () => lf.supported(), ready: () => Promise.resolve(),
            async openAndBind(types) {
                let res; if (plat.desk) { const p = askPath(T('要開啟的檔案的完整路徑（例如 C:\\文件\\a.docx 或 /home/me/a.csv）', 'Full path of the file to open'), ''); if (!p) return null; res = await lf.bindDesktop(p); } else { res = await lf.bindWeb(key, { types }); if (!res) return null; }
                const b = withEnc(res.binding, res.bytes); await persist(b); return { bytes: res.bytes, name: b.name };
            },
            async saveAsAndBind(bytes, name, types) {
                let r; if (plat.desk) {
                    let dir = ''; try { dir = (await window.desktopAPI.downloads.defaultDir()) || ''; } catch (_) { dir = ''; } const sep = /\\/.test(dir) ? '\\' : '/'; const p = askPath(T('存成這個路徑（完整路徑）', 'Save to this path'), dir ? dir.replace(/[\\/]+$/, '') + sep + name : name); if (!p) return null;
                    r = await lf.saveAsDesktop(p, bytes); if (r && r.exists) { if (typeof confirm === 'function' && !confirm(T('這個檔案已經存在，要覆蓋嗎？', 'The file exists. Overwrite?'))) return null; r = await lf.saveAsDesktop(p, bytes, { overwrite: true }); }
                } else { r = await lf.saveAsWeb(key, bytes, { suggestedName: name, types }); if (!r) return null; }
                const b = withEnc(r.binding, bytes); await persist(b); return { name: b.name };
            },
            async save(bytes, o) { const b = self._edFileB.get(key); if (!b) return { ok: false, error: T('還沒綁定檔案', 'No file bound') }; const r = await lf.save(b, key, bytes, o); if (r.ok) { await persist(withEnc(r.binding, bytes)); } return r; },
            async reload() { const b = self._edFileB.get(key); if (!b) return null; const r = await lf.read(b, key); const nb = withEnc(r.binding, r.bytes); await persist(nb); return { bytes: r.bytes, name: nb.name }; },
            async check() { const b = self._edFileB.get(key); return b ? lf.check(b, key) : { changed: false }; },
            unbind() { const b = self._edFileB.get(key); if (b && b.via === 'web' && plat.store) { plat.store.del(key).catch(() => {}); } persist(null); },
            setAuto(v) { const b = self._edFileB.get(key); if (b) persist(Object.assign({}, b, { auto: !!v })); },
        };
    };
    // /edit-file 後面接絕對路徑（桌面版）：讀檔、依副檔名開編輯器、直接綁定
    M._edOpenLocalPath = async function (path, say) {
        const lf = FaLocalFile.create(this._edFilePlatform()); let res; try { res = await lf.bindDesktop(path); } catch (e) { say(T('開不起來：', 'Could not open it: ') + String((e && e.message) || e)); return; }
        const name = res.binding.name, buf = res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength), isText = /\.(md|markdown|mdown|txt|text|log|ini|conf|cfg|properties|env|rst|org|tex|srt|vtt|diff|patch)$/i.test(name), isCsv = /\.(csv|tsv)$/i.test(name), isX = /\.xlsx$/i.test(name), isD = /\.docx$/i.test(name);
        const kindOf = isD ? 'edit-docx' : isX ? 'edit-xlsx' : isCsv ? 'edit-csv' : /\.(md|markdown|mdown)$/i.test(name) ? 'edit-markdown' : 'edit-text';
        if (!isText && !isCsv && !isX && !isD) { say(T('「' + name + '」這種格式還沒有編輯器（目前:.md、純文字、.csv、.xlsx、.docx）。', 'No editor for this format yet.')); return; }
        const b = FILE_KINDS[kindOf] === 'text' ? Object.assign({}, res.binding, { enc: isUtf8(res.bytes) ? 'utf-8' : 'big5' }) : res.binding, extra = { origin: { file: b } };
        const r = isD ? await this._edOpenDocxFile(name, buf, extra) : (isX || isCsv) ? await this._edOpenSheetFile(name, buf, extra) : await this._edOpenTextFile(name, buf, extra);
        if (r && r.ok === false) say('⚠️ ' + (r.error || '')); else say(T('已開啟並綁定 ', 'Opened and bound ') + res.binding.path + T('（Ctrl+S 存回檔案）', ' (Ctrl+S saves back)'));
    };
    M._edFileKinds = FILE_KINDS;
})();
