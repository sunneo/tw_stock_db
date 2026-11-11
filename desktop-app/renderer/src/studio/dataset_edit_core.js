'use strict';
/* 資料集逐筆編輯（純函式，不碰儲存層、不碰 DOM）。設計見 DESIGN.TODO.offline-training-studio.md §22.2 第 3 項。
 *   parseRows(path, text)            .jsonl（每行一個 JSON 物件）或 .json（頂層是陣列）→ {ok, format, rows} 或 {ok:false, error}
 *                                    有一行不合法就整份不給編（寫明第幾行），避免存檔時把別人的資料弄壞
 *   serializeRows(format, rows)      寫回文字（jsonl 每行一筆、結尾換行；json 是陣列）
 *   pageRows(rows, offset, limit)    一頁的列：{total, offset, limit, items:[{index, preview}]}（preview 截短，完整內容用 rowAt 取）
 *   applyEdit(rows, op)              op：{op:'update', index, row}｜{op:'delete', index}｜{op:'add', row, index?}
 *                                    回 {ok, rows} 或 {ok:false, error}；不改傳入的陣列
 * 原則：每一列必須是 JSON 物件（不是陣列、不是純量）；索引必須在範圍內；沒有通過的一律回原因。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioDatasetEdit = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const MAX_BYTES = 5 * 1024 * 1024; // 逐筆編輯的檔案上限（超過就只能預覽）
    const PREVIEW_CHARS = 160;

    const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

    function formatOf(path) {
        const p = String(path || '');
        if (/\.jsonl$/i.test(p)) return 'jsonl';
        if (/\.json$/i.test(p)) return 'json';
        return null;
    }

    function parseRows(path, text) {
        const format = formatOf(path);
        if (!format) return { ok: false, error: '這種檔案不能逐筆編輯（只支援 .jsonl 與 .json）：' + String(path || '') };
        const t = String(text == null ? '' : text);
        if (new TextEncoder().encode(t).length > MAX_BYTES) return { ok: false, error: '檔案超過 ' + (MAX_BYTES / 1048576) + ' MB，不能逐筆編輯' };
        if (format === 'json') {
            let v; try { v = JSON.parse(t); } catch (e) { return { ok: false, error: 'JSON 解析失敗：' + ((e && e.message) || e) }; }
            if (!Array.isArray(v)) return { ok: false, error: '.json 的頂層必須是陣列' };
            for (let i = 0; i < v.length; i++) if (!isObj(v[i])) return { ok: false, error: '第 ' + (i + 1) + ' 筆不是 JSON 物件' };
            return { ok: true, format, rows: v };
        }
        const rows = [];
        const lines = t.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            let v; try { v = JSON.parse(line); } catch (e) { return { ok: false, error: '第 ' + (i + 1) + ' 行不是合法 JSON，請先在檔案裡修正（逐筆編輯不會改它）' }; }
            if (!isObj(v)) return { ok: false, error: '第 ' + (i + 1) + ' 行不是 JSON 物件' };
            rows.push(v);
        }
        return { ok: true, format, rows };
    }

    function serializeRows(format, rows) {
        if (format === 'json') return JSON.stringify(rows, null, 2) + '\n';
        if (format === 'jsonl') return rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
        throw new Error('不認得的格式：' + format);
    }

    function previewOf(row) {
        let s; try { s = JSON.stringify(row); } catch (e) { s = '（無法顯示）'; }
        return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + '…' : s;
    }

    function pageRows(rows, offset, limit) {
        const lim = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
        const off = Math.max(0, Math.min(rows.length, Math.floor(Number(offset)) || 0));
        const items = [];
        for (let i = off; i < Math.min(rows.length, off + lim); i++) items.push({ index: i, preview: previewOf(rows[i]), row: rows[i] });
        return { total: rows.length, offset: off, limit: lim, items };
    }

    function checkIndex(rows, index, allowEnd) {
        const n = Math.floor(Number(index));
        const max = allowEnd ? rows.length : rows.length - 1;
        if (!Number.isInteger(Number(index)) || n < 0 || n > max) return { ok: false, error: '列號 ' + JSON.stringify(index) + ' 不在範圍內（共 ' + rows.length + ' 筆）' };
        return { ok: true, index: n };
    }

    function applyEdit(rows, op) {
        const o = op || {};
        if (o.op === 'update') {
            const c = checkIndex(rows, o.index, false); if (!c.ok) return c;
            if (!isObj(o.row)) return { ok: false, error: '修改後的內容必須是 JSON 物件' };
            const out = rows.slice(); out[c.index] = o.row; return { ok: true, rows: out };
        }
        if (o.op === 'delete') {
            const c = checkIndex(rows, o.index, false); if (!c.ok) return c;
            const out = rows.slice(); out.splice(c.index, 1); return { ok: true, rows: out };
        }
        if (o.op === 'add') {
            if (!isObj(o.row)) return { ok: false, error: '新增的內容必須是 JSON 物件' };
            const at = o.index === undefined || o.index === null ? rows.length : o.index;
            const c = checkIndex(rows, at, true); if (!c.ok) return c;
            const out = rows.slice(); out.splice(c.index, 0, o.row); return { ok: true, rows: out };
        }
        return { ok: false, error: 'op 必須是 update、delete 或 add，收到 ' + JSON.stringify(o.op) };
    }

    return { MAX_BYTES, formatOf, parseRows, serializeRows, pageRows, applyEdit, rowAt: (rows, i) => rows[i] };
}));
