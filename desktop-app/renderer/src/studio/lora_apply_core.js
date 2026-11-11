/* 離線訓練工作室：把 LoRA 登錄載入後的 handle（{id, bytes}，見 lora_registry_core 的 nrEngineLoader）交給桌面版原生推論的「套用器」。
 *  純函式核心（UMD、依賴注入）：Node 與瀏覽器都能載入；實際的檔案寫入與主程序通訊由呼叫端傳入，所以能用假橋接測試。
 *  流程：算 sha256 → 把 bytes 寫到 <信箱>/lora-in/<安全id>/lora.bin → 送主程序 lora_apply（主程序核對大小與雜湊、核對模型是 LoRA 槽版、搬到 native-lora、之後每次原生生成都帶它）。
 *  誠實原則：執行包太舊（回 runtime_outdated）、沒有執行包、模型不是槽版、雜湊不符……都回 {ok:false, error:具體原因}，絕不回 ok:true 假裝已套用。
 *  deps：{ call(op, payload, timeoutMs)→{ok,...}, rawfs:{writeFile(path,{base64})，remove(path,recursive)}, box, sep, sha256Hex(bytes)→Promise<string>|string, toBase64(bytes)→string }
 *  方法：apply(handles)、clear()、status()。多個 adapter：依 rank 串接成一個槽檔（見 DESIGN.TODO.native-runner.md §9.2），逐項回報 applied。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLoraApply = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function safeId(id, sha) { return String(id || 'lora').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) + '-' + sha.slice(0, 8); }

    function createLoraApplier(d) {
        d = d || {};
        const sep = d.sep || '/';
        let last = null;
        // handles：[{id, bytes, weight?}]，順序＝優先序。一個且權重 1 → 走 lora_apply（與舊版相同）；多個或有權重 → lora_apply_set（主程序把各 adapter 依 rank 串接成一個槽檔，
        // rank 容量不夠的會被拒絕並逐項回報，不截斷）。回 {ok, id, items:[{id（原始名稱）, applied, rank?, message?}], note}；一個都沒套上才 ok:false。
        async function apply(handles) {
            if (!d.call || !d.rawfs) return { ok: false, error: '沒有主程序橋接（不是桌面版），LoRA 只能在桌面版原生推論套用' };
            const hs = (handles || []).filter((h) => h && h.bytes && h.bytes.length);
            if (!hs.length) return { ok: false, error: '沒有可套用的 adapter（載入結果是空的）' };
            const prepared = [], seenSafe = new Set(), dropped = [];
            for (const h of hs) {
                const sha = await d.sha256Hex(h.bytes); let id = safeId(h.id, sha);
                if (seenSafe.has(id)) { dropped.push({ id: h.id, applied: false, message: '同一批裡重複的 adapter（同名同內容），只套一份' }); continue; }
                seenSafe.add(id); prepared.push({ h, sha, id, dir: d.box + sep + 'lora-in' + sep + id });
            }
            const cleanup = async () => { for (const x of prepared) { try { await d.rawfs.remove(x.dir, true); } catch (_) { /* 信箱殘檔之後會被主程序清掉或覆寫 */ } } };
            for (const x of prepared) {
                try { await d.rawfs.writeFile(x.dir + sep + 'lora.bin', { base64: d.toBase64(x.h.bytes) }); }
                catch (e) { await cleanup(); return { ok: false, error: '把 adapter 寫進信箱失敗：' + String((e && e.message) || e) }; }
            }
            const multi = prepared.length > 1 || (prepared[0].h.weight != null && prepared[0].h.weight !== 1);
            let r;
            try {
                r = multi
                    ? await d.call('lora_apply_set', { items: prepared.map((x) => ({ id: x.id, sha256: x.sha, size: x.h.bytes.length, weight: x.h.weight == null ? 1 : x.h.weight })) }, 180000)
                    : await d.call('lora_apply', { id: prepared[0].id, sha256: prepared[0].sha, size: prepared[0].h.bytes.length }, 120000);
            } catch (e) { r = { ok: false, message: String((e && e.message) || e) }; }
            const nameOf = (sid) => { const x = prepared.find((y) => y.id === sid); return x ? x.h.id : sid; };
            const items = (r && Array.isArray(r.items) ? r.items.map((it) => Object.assign({}, it, { id: nameOf(it.id) })) : prepared.map((x) => ({ id: x.h.id, applied: !!(r && r.ok !== false), message: r && r.ok === false ? (r.message || r.error || r.code) : undefined }))).concat(dropped);
            if (!r || r.ok === false) {
                await cleanup();
                const why = (r && (r.message || r.error || r.code)) || '主程序沒有回應';
                last = { ok: false, code: r && r.code, error: why, items };
                return { ok: false, code: r && r.code, error: why, items, needsRuntimeUpdate: !!(r && r.code === 'runtime_outdated') };
            }
            const okIds = items.filter((x) => x.applied).map((x) => x.id), notIds = items.filter((x) => !x.applied);
            last = { ok: true, id: r.id || prepared[0].id, applied: okIds, items };
            return { ok: true, id: r.id || prepared[0].id, applied: okIds, items, note: (r.note || '已套用到原生推論') + (notIds.length ? '；未套用：' + notIds.map((x) => x.id + (x.message ? '（' + x.message + '）' : '')).join('、') : '') };
        }
        async function clear() {
            if (!d.call) return { ok: true };
            const r = await d.call('lora_clear', {}, 20000).catch((e) => ({ ok: false, message: String((e && e.message) || e) }));
            last = null;
            return r && r.ok === false ? { ok: false, error: r.message || r.code } : { ok: true };
        }
        async function status() { const r = d.call ? await d.call('lora_status', {}, 20000).catch(() => null) : null; return { ok: !!(r && r.ok !== false), last, native: r }; }
        return { apply, clear, status };
    }
    return { createLoraApplier, safeId };
});
