/* 離線訓練工作室：把 LoRA 登錄載入後的 handle（{id, bytes}，見 lora_registry_core 的 nrEngineLoader）交給桌面版原生推論的「套用器」。
 *  純函式核心（UMD、依賴注入）：Node 與瀏覽器都能載入；實際的檔案寫入與主程序通訊由呼叫端傳入，所以能用假橋接測試。
 *  流程：算 sha256 → 把 bytes 寫到 <信箱>/lora-in/<安全id>/lora.bin → 送主程序 lora_apply（主程序核對大小與雜湊、核對模型是 LoRA 槽版、搬到 native-lora、之後每次原生生成都帶它）。
 *  誠實原則：執行包太舊（回 runtime_outdated）、沒有執行包、模型不是槽版、雜湊不符……都回 {ok:false, error:具體原因}，絕不回 ok:true 假裝已套用。
 *  deps：{ call(op, payload, timeoutMs)→{ok,...}, rawfs:{writeFile(path,{base64})，remove(path,recursive)}, box, sep, sha256Hex(bytes)→Promise<string>|string, toBase64(bytes)→string }
 *  方法：apply(handles)、clear()、status()。 */
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
        async function apply(handles) {
            if (!d.call || !d.rawfs) return { ok: false, error: '沒有主程序橋接（不是桌面版），LoRA 只能在桌面版原生推論套用' };
            const hs = (handles || []).filter((h) => h && h.bytes && h.bytes.length);
            if (!hs.length) return { ok: false, error: '沒有可套用的 adapter（載入結果是空的）' };
            const h = hs[0], extra = hs.slice(1).map((x) => x.id);
            const sha = await d.sha256Hex(h.bytes), id = safeId(h.id, sha), dir = d.box + sep + 'lora-in' + sep + id;
            try { await d.rawfs.writeFile(dir + sep + 'lora.bin', { base64: d.toBase64(h.bytes) }); }
            catch (e) { return { ok: false, error: '把 adapter 寫進信箱失敗：' + String((e && e.message) || e) }; }
            let r;
            try { r = await d.call('lora_apply', { id, sha256: sha, size: h.bytes.length }, 120000); }
            catch (e) { r = { ok: false, message: String((e && e.message) || e) }; }
            if (!r || r.ok === false) {
                try { await d.rawfs.remove(dir, true); } catch (_) { /* 信箱殘檔之後會被主程序清掉或覆寫 */ }
                const why = (r && (r.message || r.error || r.code)) || '主程序沒有回應';
                last = { ok: false, code: r && r.code, error: why };
                return { ok: false, code: r && r.code, error: why, needsRuntimeUpdate: !!(r && r.code === 'runtime_outdated') };
            }
            last = { ok: true, id, label: h.id };
            return { ok: true, id, note: (r.note || '已套用到原生推論') + (extra.length ? '；同時只能套一個 adapter（模型只有一個 LoRA 槽），未套用：' + extra.join('、') : '') };
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
