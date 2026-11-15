// 離線模型（qwen3-0.6b）預設啟用與自動準備 LoRA 槽版（renderer/src/floating-assistant.js 的 _nrQwenOptIn／_nrAutoSlotOnce／_slotPrepareAndWait）。
// 做法：從原始碼擷取這幾個方法（不載入整個聊天主程式），配上假的 this（假的主程序呼叫、假的同意卡片）與假的 localStorage。
// 沒測到的：真的 Electron 信箱、真的同意卡片畫面（見 DESIGN.lora-training.md §10）。
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');

let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

// 假的 localStorage
const store = {};
global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
// 重試與輪詢的等待改成立刻完成（測試不用真的等）
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);

// 擷取方法：從 _nrQwenOptIn 那行到 _nrBackendLabel 之前（含 _nrAutoSlotOnce、_slotPrepareAndWait）
function extract() {
    const a = src.indexOf('    _nrQwenOptIn() {'), b = src.indexOf('    _nrBackendLabel(');
    if (a < 0 || b < 0 || b < a) throw new Error('找不到要擷取的方法（原始碼改了？）');
    const body = src.slice(a, b);
    // 包成 class 本體再取原型（方法之間沒有逗號，不能用物件字面值）
    return new Function('return class {' + body + '};')().prototype;
}
const M = extract();

// 假的 this：依序回傳預先排好的主程序回應；記錄每次呼叫
function fakeHost(script) {
    const calls = [], msgs = [], forms = [];
    const queue = {};
    for (const k of Object.keys(script)) if (Array.isArray(script[k])) queue[k] = script[k].slice();
    const host = {
        calls, msgs, forms,
        _nrAvailable: () => true,
        _nrCall: async (op, payload) => {
            calls.push({ op, payload });
            const q = queue[op] || [];
            const v = q.length > 1 ? q.shift() : (q[0] || { ok: false, message: 'no script for ' + op });
            return typeof v === 'function' ? v(payload) : v;
        },
        requestUserForm: async (o) => { forms.push(o); return script.__answer || { confirmed: false, answer: '' }; },
        _pushAssistantMessage: (t) => { msgs.push(t); },
    };
    Object.assign(host, { _nrQwenOptIn: M._nrQwenOptIn, _nrAutoSlotOnce: M._nrAutoSlotOnce, _slotPrepareAndWait: M._slotPrepareAndWait });
    return host;
}
const ops = (h) => h.calls.map((c) => c.op);
const missing = { repo: 'onnx-community/Qwen3-0.6B-ONNX', totalBytes: 617687575 + 9117040, files: [
    { name: 'model_quantized.onnx', url: 'https://huggingface.co/x/model_quantized.onnx', bytes: 617687575 },
    { name: 'tokenizer.json', url: 'https://huggingface.co/x/tokenizer.json', bytes: 9117040 },
] };
const readyStatus = { ok: true, phase: 'ready', slot: { rank: 16, total_bytes: 1 }, standard: { bytes: 1 }, missing: null };
const noSlotWithStd = { ok: true, phase: 'idle', slot: null, standard: { bytes: 1 }, missing: null };
const noSlotNoStd = { ok: true, phase: 'need_std', slot: null, standard: null, missing };

(async () => {
    // ---- 預設值 ----
    store.length = 0; for (const k of Object.keys(store)) delete store[k];
    const h0 = fakeHost({});
    check('預設（沒設過）視為啟用', h0._nrQwenOptIn() === true);
    store['fa.native.enabled'] = '0';
    check('使用者明確關掉（0）→ 關', h0._nrQwenOptIn() === false);
    store['fa.native.enabled'] = '1';
    check('安裝過（1）→ 開', h0._nrQwenOptIn() === true);
    delete store['fa.native.enabled'];

    // ---- 1) 已有標準版：不問、直接背景轉換 ----
    {
        const h = fakeHost({ slot_status: [noSlotWithStd, readyStatus], slot_prepare: [{ ok: true, started: true }] });
        const r = await h._nrAutoSlotOnce();
        check('有標準版：直接轉換、不彈卡片', r === 'ready' && h.forms.length === 0, { r, forms: h.forms.length });
        check('有標準版：呼叫順序 slot_status→slot_prepare→slot_status', JSON.stringify(ops(h)) === JSON.stringify(['slot_status', 'slot_prepare', 'slot_status']), ops(h));
    }

    // ---- 2) 沒有標準版、同意：彈一次卡片（含檔名／來源／大小）→ 下載（confirm:true、清單一致）→ 轉換 ----
    {
        for (const k of Object.keys(store)) delete store[k];
        const h = fakeHost({ slot_status: [noSlotNoStd, readyStatus], slot_download: [{ ok: true }], slot_prepare: [{ ok: true, started: true }], __answer: { confirmed: true, answer: '同意下載' } });
        const r = await h._nrAutoSlotOnce();
        check('沒標準版：同意後完成', r === 'ready', r);
        check('沒標準版：卡片只出現一次', h.forms.length === 1, h.forms.length);
        const desc = h.forms[0] && h.forms[0].description || '';
        check('卡片含檔名、來源與大小', desc.indexOf('model_quantized.onnx') >= 0 && desc.indexOf('huggingface.co') >= 0 && desc.indexOf('MB') >= 0, desc.slice(0, 200));
        const dl = h.calls.find((c) => c.op === 'slot_download');
        check('下載帶 confirm:true 與同一份清單', !!dl && dl.payload.confirm === true && dl.payload.files.length === 2 && dl.payload.files[0].bytes === 617687575, dl && dl.payload);
        check('同意後記下清單，之後不必再問', store['fa.native.slotConsent'] && store['fa.native.slotConsent'] !== 'no');
    }

    // ---- 3) 同一份清單已同意過：不再彈卡片，直接下載（清單沒變）----
    {
        const h = fakeHost({ slot_status: [noSlotNoStd, readyStatus], slot_download: [{ ok: true }], slot_prepare: [{ ok: true, started: true }] });
        const r = await h._nrAutoSlotOnce();
        check('已同意的同一份清單：不再問、直接下載', r === 'ready' && h.forms.length === 0 && ops(h).indexOf('slot_download') >= 0, { r, forms: h.forms.length, ops: ops(h) });
    }

    // ---- 4) 使用者拒絕：不下載；記住不再問 ----
    {
        for (const k of Object.keys(store)) delete store[k];
        const h = fakeHost({ slot_status: [noSlotNoStd], __answer: { confirmed: true, answer: '不要' } });
        const r = await h._nrAutoSlotOnce();
        check('拒絕：回 declined、不下載', r === 'declined' && ops(h).indexOf('slot_download') < 0, { r, ops: ops(h) });
        check('拒絕：記住 no', store['fa.native.slotConsent'] === 'no');
        // 下一個工作階段
        const h2 = fakeHost({ slot_status: [noSlotNoStd] });
        const r2 = await h2._nrAutoSlotOnce();
        check('拒絕過：之後不再問也不下載', r2 === 'declined' && h2.forms.length === 0 && ops(h2).indexOf('slot_download') < 0, { r2, forms: h2.forms.length });
    }

    // ---- 5) 下載暫時失敗：自動重試，不再彈卡片，最後成功 ----
    {
        for (const k of Object.keys(store)) delete store[k];
        const h = fakeHost({
            slot_status: [noSlotNoStd, readyStatus],
            slot_download: [{ ok: false, code: 'download_failed', message: '下載失敗：HTTP 503' }, { ok: false, code: 'download_failed', message: '下載失敗：HTTP 503' }, { ok: true }],
            slot_prepare: [{ ok: true, started: true }],
            __answer: { confirmed: true, answer: '同意下載' },
        });
        const r = await h._nrAutoSlotOnce();
        check('下載第 1、2 次失敗後第 3 次成功', r === 'ready' && ops(h).filter((o) => o === 'slot_download').length === 3, { r, ops: ops(h) });
        check('重試時不重複彈卡片', h.forms.length === 1, h.forms.length);
        check('重試時說明原因（HTTP 狀態）', h.msgs.some((m) => m.indexOf('HTTP 503') >= 0), h.msgs.slice(0, 3));
    }

    // ---- 6) 轉換失敗（主程序回 failed）：自動再送一次，第二次成功 ----
    {
        const h = fakeHost({
            slot_prepare: [{ ok: true, started: true }, { ok: true, started: true }],
            slot_status: [{ ok: true, phase: 'failed', error: 'Error: boom', slot: null }, { ok: true, phase: 'failed', error: 'Error: boom', slot: null }, readyStatus],
        });
        const r = await h._slotPrepareAndWait();
        check('轉換失敗自動再試一次後成功', r === 'ready' && ops(h).filter((o) => o === 'slot_prepare').length === 2, { r, ops: ops(h) });
        check('失敗時寫出具體原因', h.msgs.some((m) => m.indexOf('Error: boom') >= 0), h.msgs.slice(0, 3));
    }

    // ---- 7) 主程序沒回應：這次不算數，下次生成再試 ----
    {
        const h = fakeHost({ slot_status: [{ ok: false, code: 'mailbox_timeout', message: '沒回應' }, noSlotWithStd, readyStatus], slot_prepare: [{ ok: true, started: true }], });
        const r1 = await h._nrAutoSlotOnce();
        check('主程序沒回應：回 no_status 且不卡住', r1 === 'no_status' && h._slotAuto === null, { r1, slotAuto: h._slotAuto });
        const r2 = await h._nrAutoSlotOnce();
        check('下一次生成會重新檢查', r2 !== 'no_status', r2);
    }

    console.log(bad.length ? 'FAILED ' + bad.length + ' / ' + (ok + bad.length) : 'OK ' + ok + ' checks');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外', e && e.stack); process.exit(1); });
