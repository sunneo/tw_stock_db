/* Python：離線訓練器的「課」（lesson）——老師（線上模型或 Claude）教出來、驗證過、之後離線自己就能用的做法。純函式 UMD，Python 專屬。
 * 一堂課 = 一種算法（動作表的 algo key）＋輸入形狀＋「solve 的區塊配方」（變數角色化：輸入變數叫 v0、v1…，套用時換成題目讀出來的名稱）。
 * 老師的解答格式：一段 Python，內含 `def solve(<輸入變數>):`（輸入已由 read_input 讀好；解答裡可以有輔助函式與 import）。
 *
 *   deriveLesson({statement, intent, source, B, C2U, parseTree}) → {ok, lesson, reason}
 *     lesson = { id, algo, shape, nparams, roles:[…], body:[敘述 IR（輸入變數已改成 v0..）], prelude:[import 敘述 IR], cnl（給人看）, createdBy, note }
 *   matchLesson(lessons, intent) → lesson | null          algo 與輸入形狀都相同才算
 *   applyLesson(lesson, intent) → { body, prelude }       把 v0.. 換成題目的變數名稱；區域變數若跟題目變數撞名就改名
 *   shapeOf(intent) → 字串                                輸入形狀：每種輸入的種類與數量，例如 scalars2|list|rows2
 * 內建的課在 py_lessons_builtin.js（由 scripts/teach-builtin-lessons.js 跑老師迴圈產生，每一堂都過判題器與回歸）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyLessons = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const shapeOf = (intent) => intent.inputs.map((i) => (i.k === 'scalars' ? 'scalars' + i.names.length : i.k === 'rows' ? 'rows' + i.names.length : i.k)).join('|');
    // 名稱改寫（IR 層：變數節點、for／生成式目標、lambda 與 def 的參數）
    function renameIR(x, map) {
        if (Array.isArray(x)) return x.map((y) => renameIR(y, map));
        if (x && typeof x === 'object') {
            const o = {}; for (const k of Object.keys(x)) o[k] = renameIR(x[k], map);
            if (x.n === 'name' && Object.prototype.hasOwnProperty.call(map, x.v)) o.v = map[x.v];
            if (x.k === 'def' && Object.prototype.hasOwnProperty.call(map, x.name)) o.name = map[x.name];
            if ((x.k === 'def' || x.n === 'lambda') && Array.isArray(x.ps)) o.ps = x.ps.map((p) => (Object.prototype.hasOwnProperty.call(map, p.name) ? Object.assign({}, p, { name: map[p.name] }) : renameIR(p, map)));
            if (x.n === 'walrus' && Object.prototype.hasOwnProperty.call(map, x.t)) o.t = map[x.t];
            return o;
        }
        return x;
    }
    // 敘述樹裡所有出現的名稱（用來找區域變數）
    function allNames(x, out) { out = out || new Set(); if (Array.isArray(x)) { x.forEach((y) => allNames(y, out)); return out; } if (x && typeof x === 'object') { if (x.n === 'name') out.add(x.v); if (x.k === 'def') { out.add(x.name); (x.ps || []).forEach((p) => out.add(p.name)); } if (x.n === 'lambda') (x.ps || []).forEach((p) => out.add(p.name)); for (const k of Object.keys(x)) allNames(x[k], out); } return out; }

    function deriveLesson(o) {
        const { intent, B, C2U, parseTree } = o;
        if (!intent || !intent.algo) return { ok: false, reason: '動作表認不出這題是哪一種算法（intent.algo 是空的），沒辦法歸類成課' };
        const tree = parseTree(o.source); if (!tree || tree.rootNode.hasError()) return { ok: false, reason: '老師的解答有語法錯誤' };
        const u = C2U.fromTree(tree.rootNode, { source: o.source }); const ops = u.model.classes[0].ops; const solve = ops.find((x) => x.name === 'solve');
        if (!solve) return { ok: false, reason: '老師的解答裡沒有 def solve(...)；請照約定寫：輸入已由 read_input 讀好，變數是 ' + intent.vars.map((v) => v.name).join(', ') };
        const pnames = solve.params.map((p) => p.name); if (pnames.length !== intent.vars.length) return { ok: false, reason: 'solve 的參數數量（' + pnames.length + '）和題目讀出來的輸入變數數量（' + intent.vars.length + '）不同；變數是 ' + intent.vars.map((v) => v.name).join(', ') };
        // 輸入變數 → 角色（v0, v1, …）；參數名稱不管老師取什麼都可以
        const roles = {}; pnames.forEach((n, i) => { roles[n] = 'v' + i; });
        // 輔助函式（solve 以外的 def）變成 solve 裡面的巢狀函式；模組層的 import 等放進 prelude
        const helpers = ops.filter((x) => x.name !== 'solve' && x.name !== 'main').map((h) => ({ k: 'def', name: h.name, ps: h.params.map((p) => Object.assign({ name: p.name }, p.default ? { default: p.default } : {})), a: h.body }));
        const body = clone(helpers.concat(solve.body)); const prelude = clone(u.model.prelude || []);
        const lesson = { id: intent.algo + '#' + (o.serial || 1), algo: intent.algo, shape: shapeOf(intent), nparams: pnames.length, roles: pnames.map((_, i) => 'v' + i), paradigms: intent.paradigms || [], body: renameIR(body, roles), prelude, createdBy: o.createdBy || 'teacher', note: o.note || '' };
        try { const bl = B.fromIR(lesson.body); lesson.cnl = B.toCNL(bl); } catch (_) { lesson.cnl = ''; }
        return { ok: true, lesson };
    }
    function matchLesson(lessons, intent) {
        if (!intent || !intent.algo) return null; const sh = shapeOf(intent);
        return (lessons || []).find((l) => l.algo === intent.algo && l.shape === sh && l.nparams === intent.vars.length) || null;
    }
    function applyLesson(lesson, intent) {
        const map = {}; intent.vars.forEach((v, i) => { map['v' + i] = v.name; });
        // 區域變數（教案裡宣告、但不是 v0..）若跟題目的變數撞名，改成 name_2
        const taken = new Set(intent.vars.map((v) => v.name)); const locals = [...allNames(lesson.body)].filter((n) => !/^v\d+$/.test(n)); const used = new Set(taken);
        for (const n of locals) { if (taken.has(n)) { let k = 2; while (used.has(n + '_' + k)) k++; map[n] = n + '_' + k; used.add(map[n]); } else used.add(n); }
        return { body: renameIR(clone(lesson.body), map), prelude: clone(lesson.prelude || []) };
    }
    return { deriveLesson, matchLesson, applyLesson, shapeOf, renameIR };
});
