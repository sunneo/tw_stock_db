/* Studio 視窗版面核心（UMD，純函式，不碰 DOM）。設計見 DESIGN.TODO.offline-training-studio.md §4：
 * 左右兩個分頁區，分頁可搬移／關閉／重新開啟，分隔線可拖曳（有上下限、雙擊還原），每區可最大化／還原，窄於 640px 上下堆疊。
 * 版面狀態 L = { panes:{left:[tabId…], right:[…]}, active:{left, right}, closed:[tabId…], split:0.45, max:null|'left'|'right' }
 * 偏好存主程式 localStorage（iframe 沒有儲存空間），所以所有輸入都當不可信：normalize 會丟掉未知分頁、補回遺失的、保證兩區至少各一個。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const TABS = [
        { id: 'assets', title: '資產清單', icon: '📦' },
        { id: 'lora', title: 'LoRA 登錄', icon: '🧩' },
        { id: 'ingest', title: '資料匯入', icon: '📥' },
        { id: 'datasets', title: '資料集', icon: '🗂️' },
        { id: 'eval', title: '評量', icon: '📊' },
        { id: 'train', title: '訓練', icon: '🏋️' },
        { id: 'teacher', title: '老師', icon: '🎓' },
        { id: 'log', title: '紀錄', icon: '📜' },
    ];
    const IDS = TABS.map((t) => t.id);
    const DEFAULT = { panes: { left: ['assets', 'lora', 'ingest', 'datasets', 'eval'], right: ['train', 'teacher', 'log'] }, active: { left: 'assets', right: 'train' }, closed: [], split: 0.45, max: null };
    const SPLIT_MIN = 0.2, SPLIT_MAX = 0.8, STACK_BELOW = 640;
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

    function defaults() { return clone(DEFAULT); }
    // 正規化：未知分頁丟掉、重複只留第一個、沒出現在任何地方的（也不在 closed）補回預設所在側、兩區至少一個分頁
    function normalize(input) {
        const L = defaults(); if (!input || typeof input !== 'object') return L;
        const seen = new Set(), panes = { left: [], right: [] }, closed = [];
        ['left', 'right'].forEach((side) => { const a = input.panes && Array.isArray(input.panes[side]) ? input.panes[side] : []; a.forEach((id) => { if (IDS.indexOf(id) >= 0 && !seen.has(id)) { seen.add(id); panes[side].push(id); } }); });
        (Array.isArray(input.closed) ? input.closed : []).forEach((id) => { if (IDS.indexOf(id) >= 0 && !seen.has(id)) { seen.add(id); closed.push(id); } });
        IDS.forEach((id) => { if (!seen.has(id)) { seen.add(id); (DEFAULT.panes.left.indexOf(id) >= 0 ? panes.left : panes.right).push(id); } });
        ['left', 'right'].forEach((side, i) => { if (!panes[side].length) { const other = side === 'left' ? 'right' : 'left'; if (panes[other].length > 1) panes[side].push(panes[other].pop()); else if (closed.length) panes[side].push(closed.shift()); } });
        L.panes = panes; L.closed = closed;
        ['left', 'right'].forEach((side) => { const a = input.active && input.active[side]; L.active[side] = panes[side].indexOf(a) >= 0 ? a : (panes[side][0] || null); });
        const sp = Number(input.split); L.split = Number.isFinite(sp) ? clamp(sp, SPLIT_MIN, SPLIT_MAX) : DEFAULT.split;
        L.max = input.max === 'left' || input.max === 'right' ? input.max : null;
        if (L.max && !panes[L.max].length) L.max = null;
        return L;
    }
    const sideOf = (L, id) => (L.panes.left.indexOf(id) >= 0 ? 'left' : (L.panes.right.indexOf(id) >= 0 ? 'right' : null));
    const total = (L) => L.panes.left.length + L.panes.right.length;
    // 搬移：兩區各至少一個分頁（來源只剩這一個時拒絕，除非搬進同一側重新排序）
    function moveTab(L, id, side, index) {
        const from = sideOf(L, id); if (!from) return { ok: false, error: '分頁不在任何一區（先用「+」開啟）' };
        if (side !== 'left' && side !== 'right') return { ok: false, error: '目標只能是 left／right' };
        if (from !== side && L.panes[from].length <= 1) return { ok: false, error: '每一區至少要保留一個分頁' };
        const N = clone(L); N.panes[from] = N.panes[from].filter((x) => x !== id);
        const at = index === undefined || index < 0 || index > N.panes[side].length ? N.panes[side].length : index;
        N.panes[side].splice(at, 0, id); N.active[side] = id;
        if (from !== side) N.active[from] = N.panes[from].indexOf(N.active[from]) >= 0 ? N.active[from] : N.panes[from][0];
        return { ok: true, layout: N };
    }
    function closeTab(L, id) {
        const side = sideOf(L, id); if (!side) return { ok: false, error: '分頁已經關閉' };
        if (L.panes[side].length <= 1) return { ok: false, error: '每一區至少要保留一個分頁' };
        const N = clone(L); N.panes[side] = N.panes[side].filter((x) => x !== id); N.closed.push(id);
        if (N.active[side] === id) N.active[side] = N.panes[side][Math.min(L.panes[side].indexOf(id), N.panes[side].length - 1)];
        return { ok: true, layout: N };
    }
    function openTab(L, id, side) {
        if (IDS.indexOf(id) < 0) return { ok: false, error: '沒有這個分頁' };
        if (sideOf(L, id)) { const N = clone(L); N.active[sideOf(L, id)] = id; return { ok: true, layout: N }; }
        const s = side === 'left' || side === 'right' ? side : (DEFAULT.panes.left.indexOf(id) >= 0 ? 'left' : 'right');
        const N = clone(L); N.closed = N.closed.filter((x) => x !== id); N.panes[s].push(id); N.active[s] = id; return { ok: true, layout: N };
    }
    function activate(L, id) { const s = sideOf(L, id); if (!s) return L; const N = clone(L); N.active[s] = id; return N; }
    // 分隔線：以比例（0–1）記，拖曳時夾在上下限；雙擊還原
    const setSplit = (L, v) => { const N = clone(L), x = Number(v); N.split = Number.isFinite(x) ? clamp(x, SPLIT_MIN, SPLIT_MAX) : DEFAULT.split; return N; };
    const resetSplit = (L) => { const N = clone(L); N.split = DEFAULT.split; return N; };
    const toggleMax = (L, side) => { const N = clone(L); N.max = N.max === side ? null : (side === 'left' || side === 'right' ? side : null); return N; };
    const orientation = (widthPx) => (widthPx < STACK_BELOW ? 'stack' : 'side');
    // 滑鼠位置 → 比例；horizontal＝左右（用 x），否則上下（用 y）
    const ratioFromPointer = (pos, start, size) => (size > 0 ? clamp((pos - start) / size, SPLIT_MIN, SPLIT_MAX) : DEFAULT.split);
    return { TABS, IDS, DEFAULT, SPLIT_MIN, SPLIT_MAX, STACK_BELOW, defaults, normalize, sideOf, total, moveTab, closeTab, openTab, activate, setSplit, resetSplit, toggleMax, orientation, ratioFromPointer };
});
