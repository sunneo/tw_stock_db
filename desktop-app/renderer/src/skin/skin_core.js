// 蒙皮動畫的純演算法（不碰 DOM／three.js，node 與瀏覽器都能跑；嵌入成 FaSkin，見 scripts/embed-code-ui.js）
// 資料（3D 場景 YAML 的 polygon 節點，選填的 skin 區塊）：
//   skin: { skeleton: { joints: [{name, parent, pos:[x,y,z], limits?:{min:[..],max:[..]}}] },   // pos：節點座標（跟 vertices 同一個空間）的靜止位置
//           weights: 'auto' | [[[關節序,權重],…] 每個頂點],   motions: [{name, duration, loop, ease, tracks:[{joint, keys:[{t, rot:[rx,ry,rz 弧度]}]}]}],
//           static_radius?, power?, active?: 動作名稱|'all', speed? }
// 做法：線性混合蒙皮（linear blend skinning）：v' = Σ wᵢ · Mᵢ · v，Mᵢ ＝ 目前姿勢的世界矩陣 · 靜止位置的反矩陣。
// 權重（auto）是幾何猜測：頂點到每根骨頭（關節到子關節的線段）的距離，取反距離的 power 次方，留最近的 4 個並正規化；
// 另外加一個「不動」的虛擬骨頭（距離 static_radius），離骨架很遠的頂點（例如背景）就保持靜止，不會跟著彎。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaSkin = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---------- 4×4 矩陣（列主序 → 這裡用「行主序陣列、列向量」：m[r*4+c]） ----------
    const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    function mul(a, b) { const o = new Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; } return o; }
    function trans(x, y, z) { const m = ident(); m[3] = x; m[7] = y; m[11] = z; return m; }
    function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]; }
    function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; }
    function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
    function rotXYZ(r) { return mul(mul(rotX(r[0] || 0), rotY(r[1] || 0)), rotZ(r[2] || 0)); }
    function xform(m, x, y, z) { return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]]; }

    // ---------- 緩動 ----------
    const EASE = { linear: (u) => u, ease_in: (u) => u * u, ease_out: (u) => 1 - (1 - u) * (1 - u), ease_in_out: (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2) };

    // ---------- 骨架 ----------
    // 把知識庫展開後的骨架（關節用 offset：相對於父關節，單位 relative＝容器高度，y 往下＝影像座標）放到場景空間。
    // opts: {anchor:[x,y,z]（根關節的位置）, scale（relative 1.0 ＝ 場景單位幾長）, flipY（影像座標 y 往下→場景 y 往上，預設 true）, z}
    function placeSkeleton(skel, opts) {
        opts = opts || {}; const sc = opts.scale || 1, flip = opts.flipY === false ? 1 : -1, anchor = opts.anchor || [0, 0, 0];
        const byName = new Map(); (skel.joints || []).forEach((j) => byName.set(j.name || j.key, j));
        const pos = new Map(), out = [];
        const place = (j) => {
            const nm = j.name || j.key; if (pos.has(nm)) return pos.get(nm);
            const off = j.offset || [0, 0, 0]; let p;
            if (!j.parent || !byName.has(j.parent)) p = [anchor[0] + (off[0] || 0) * sc, anchor[1] + flip * (off[1] || 0) * sc, anchor[2] + (off[2] || 0) * sc];
            else { const pp = place(byName.get(j.parent)); p = [pp[0] + (off[0] || 0) * sc, pp[1] + flip * (off[1] || 0) * sc, pp[2] + (off[2] || 0) * sc]; }
            pos.set(nm, p); return p;
        };
        for (const j of skel.joints || []) { const nm = j.name || j.key; const o = { name: nm, parent: j.parent && byName.has(j.parent) ? j.parent : null, pos: place(j).map((v) => Math.round(v * 10000) / 10000) }; if (j.rot_min || j.rot_max) o.limits = { min: j.rot_min, max: j.rot_max }; out.push(o); }
        return { joints: out };
    }

    // ---------- 自動權重 ----------
    function _segDist(p, a, b) { const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], L = abx * abx + aby * aby + abz * abz; let t = L > 1e-12 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / L : 0; t = Math.max(0, Math.min(1, t)); const dx = p[0] - (a[0] + abx * t), dy = p[1] - (a[1] + aby * t), dz = p[2] - (a[2] + abz * t); return Math.sqrt(dx * dx + dy * dy + dz * dz); }
    // 回傳 {idx: Int16Array(N*4)（-1＝不動的虛擬骨頭／沒用到）, w: Float32Array(N*4)}
    function autoWeights(verts, joints, opts) {
        opts = opts || {}; const N = verts.length, J = joints.length, power = opts.power || 3;
        const idxOf = new Map(); joints.forEach((j, i) => idxOf.set(j.name, i));
        const segs = joints.map(() => []); // 每個關節的骨頭線段：到各子關節；沒有子關節就是一個點
        joints.forEach((j, i) => { if (j.parent != null && idxOf.has(j.parent)) segs[idxOf.get(j.parent)].push([joints[idxOf.get(j.parent)].pos, j.pos]); });
        joints.forEach((j, i) => { if (!segs[i].length) segs[i].push([j.pos, j.pos]); });
        // 骨架範圍 → 預設的「不動半徑」
        let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; joints.forEach((j) => { for (let k = 0; k < 3; k++) { if (j.pos[k] < mn[k]) mn[k] = j.pos[k]; if (j.pos[k] > mx[k]) mx[k] = j.pos[k]; } });
        const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-6);
        const R = opts.static_radius > 0 ? opts.static_radius : ext * 0.9;
        const idx = new Int16Array(N * 4).fill(-1), w = new Float32Array(N * 4);
        const d = new Float64Array(J);
        for (let v = 0; v < N; v++) {
            const p = verts[v];
            for (let j = 0; j < J; j++) { let m = 1e18; for (const s of segs[j]) { const dd = _segDist(p, s[0], s[1]); if (dd < m) m = dd; } d[j] = m; }
            // 候選：每個關節＋「不動」；取最近的 4 個
            const cand = []; for (let j = 0; j < J; j++) if (d[j] <= R * 2.5) cand.push([j, d[j]]); cand.push([-1, R]); // 離任何骨頭太遠的頂點（超過不動半徑的 2.5 倍）完全不動
            cand.sort((a, b) => a[1] - b[1]); const top = cand.slice(0, 4);
            let sum = 0; const ws = top.map(([j, dd]) => { const x = 1 / Math.pow(Math.max(dd, ext * 0.01), power); sum += x; return x; });
            for (let k = 0; k < top.length; k++) { idx[v * 4 + k] = top[k][0]; w[v * 4 + k] = ws[k] / sum; }
        }
        return { idx, w };
    }
    // 明確給的權重（[[ [關節序,權重],… ] 每個頂點]）→ 同樣的格式；沒用到的格子 idx=-1
    function explicitWeights(list, N) {
        const idx = new Int16Array(N * 4).fill(-1), w = new Float32Array(N * 4);
        for (let v = 0; v < N; v++) { const l = (list[v] || []).slice().sort((a, b) => b[1] - a[1]).slice(0, 4); let s = 0; l.forEach((x) => { s += x[1]; }); if (s <= 0) { idx[v * 4] = -1; w[v * 4] = 1; continue; } l.forEach((x, k) => { idx[v * 4 + k] = x[0]; w[v * 4 + k] = x[1] / s; }); }
        return { idx, w };
    }

    // ---------- 動作 ----------
    function _clamp(v, lo, hi) { return Math.max(lo == null ? -1e9 : lo, Math.min(hi == null ? 1e9 : hi, v)); }
    function evalTrack(keys, t, ease) {
        if (!keys || !keys.length) return [0, 0, 0];
        if (t <= keys[0].t) return (keys[0].rot || [0, 0, 0]).slice();
        const last = keys[keys.length - 1]; if (t >= last.t) return (last.rot || [0, 0, 0]).slice();
        for (let i = 0; i < keys.length - 1; i++) { const a = keys[i], b = keys[i + 1]; if (t >= a.t && t <= b.t) { const u = (EASE[ease] || EASE.linear)((t - a.t) / Math.max(1e-9, b.t - a.t)); const ra = a.rot || [0, 0, 0], rb = b.rot || [0, 0, 0]; return [0, 1, 2].map((k) => (ra[k] || 0) + ((rb[k] || 0) - (ra[k] || 0)) * u); } }
        return [0, 0, 0];
    }
    // 準備一個骨架＋權重＋動作：回傳 rig
    function prepare(skin, verts, opts) {
        opts = opts || {}; const joints = (skin.skeleton && skin.skeleton.joints) || []; if (!joints.length) throw new Error('skin.skeleton.joints 是空的');
        const idxOf = new Map(); joints.forEach((j, i) => idxOf.set(j.name, i));
        for (const j of joints) { if (!Array.isArray(j.pos) || j.pos.length !== 3 || !j.pos.every(Number.isFinite)) throw new Error('關節 ' + j.name + ' 沒有合法的 pos [x,y,z]'); if (j.parent != null && !idxOf.has(j.parent)) throw new Error('關節 ' + j.name + ' 的 parent「' + j.parent + '」不存在'); }
        // 拓撲排序（父在前）；偵測循環
        const order = [], state = new Map();
        const visit = (i) => { if (state.get(i) === 2) return; if (state.get(i) === 1) throw new Error('骨架有循環：' + joints[i].name); state.set(i, 1); const p = joints[i].parent; if (p != null) visit(idxOf.get(p)); state.set(i, 2); order.push(i); };
        joints.forEach((_, i) => visit(i));
        const wts = Array.isArray(skin.weights) ? explicitWeights(skin.weights, verts.length) : autoWeights(verts, joints, { power: skin.power, static_radius: skin.static_radius });
        const motions = {}; for (const m of skin.motions || []) { if (m && m.name) motions[m.name] = m; }
        const names = Object.keys(motions);
        const rig = { joints, order, idxOf, weights: wts, motions, motionNames: names };
        // 某個動作在時間 t 的每個關節的蒙皮矩陣（長度 J*16）
        rig.pose = function (motionName, t) {
            const m = motionName ? motions[motionName] : null; const dur = m && m.duration > 0 ? m.duration : 0;
            let tt = t; if (m && dur) tt = m.loop === false ? Math.min(t, dur) : ((t % dur) + dur) % dur;
            const rots = joints.map(() => [0, 0, 0]);
            if (m) for (const tr of m.tracks || []) { const ji = idxOf.get(tr.joint); if (ji == null) continue; const lim = joints[ji].limits; let r = evalTrack(tr.keys, tt, m.ease); if (lim) r = r.map((v, k) => _clamp(v, lim.min && lim.min[k], lim.max && lim.max[k])); rots[ji] = r; }
            const world = new Array(joints.length), skinM = new Array(joints.length * 16);
            for (const i of order) {
                const j = joints[i], pi = j.parent != null ? idxOf.get(j.parent) : -1;
                const off = pi >= 0 ? [j.pos[0] - joints[pi].pos[0], j.pos[1] - joints[pi].pos[1], j.pos[2] - joints[pi].pos[2]] : j.pos;
                const local = mul(trans(off[0], off[1], off[2]), rotXYZ(rots[i]));
                world[i] = pi >= 0 ? mul(world[pi], local) : local;
                const M = mul(world[i], trans(-j.pos[0], -j.pos[1], -j.pos[2])); for (let k = 0; k < 16; k++) skinM[i * 16 + k] = M[k];
            }
            return skinM;
        };
        // 把靜止頂點（[[x,y,z],…]）依矩陣變形，寫進 out（Float32Array/Array，長度 N*3）
        rig.apply = function (rest, skinM, out) {
            const { idx, w } = wts;
            for (let v = 0; v < rest.length; v++) {
                const p = rest[v]; let x = 0, y = 0, z = 0;
                for (let k = 0; k < 4; k++) {
                    const wi = w[v * 4 + k]; if (!wi) continue; const ji = idx[v * 4 + k];
                    if (ji < 0) { x += wi * p[0]; y += wi * p[1]; z += wi * p[2]; continue; }
                    const o = ji * 16;
                    x += wi * (skinM[o] * p[0] + skinM[o + 1] * p[1] + skinM[o + 2] * p[2] + skinM[o + 3]);
                    y += wi * (skinM[o + 4] * p[0] + skinM[o + 5] * p[1] + skinM[o + 6] * p[2] + skinM[o + 7]);
                    z += wi * (skinM[o + 8] * p[0] + skinM[o + 9] * p[1] + skinM[o + 10] * p[2] + skinM[o + 11]);
                }
                out[v * 3] = x; out[v * 3 + 1] = y; out[v * 3 + 2] = z;
            }
            return out;
        };
        // 關節目前的世界位置（畫骨架用）
        rig.jointPositions = function (skinM) { return joints.map((j, i) => { const o = i * 16; return [skinM[o] * j.pos[0] + skinM[o + 1] * j.pos[1] + skinM[o + 2] * j.pos[2] + skinM[o + 3], skinM[o + 4] * j.pos[0] + skinM[o + 5] * j.pos[1] + skinM[o + 6] * j.pos[2] + skinM[o + 7], skinM[o + 8] * j.pos[0] + skinM[o + 9] * j.pos[1] + skinM[o + 10] * j.pos[2] + skinM[o + 11]]; }); };
        return rig;
    }
    // 驗證 skin 區塊（給場景 YAML 驗證用）：回傳錯誤字串陣列
    function validate(skin, nVerts) {
        const errs = []; if (!skin || typeof skin !== 'object') return ['skin 必須是物件'];
        const js = skin.skeleton && skin.skeleton.joints; if (!Array.isArray(js) || !js.length) return ['skin.skeleton.joints 必須是非空陣列'];
        const names = new Set(); js.forEach((j, i) => { if (!j || typeof j.name !== 'string' || !j.name) errs.push('joints[' + i + '] 缺 name'); else if (names.has(j.name)) errs.push('關節名稱重複：' + j.name); else names.add(j.name); if (!j || !Array.isArray(j.pos) || j.pos.length !== 3 || !j.pos.every(Number.isFinite)) errs.push('joints[' + i + '].pos 要是 [x,y,z] 數字'); });
        js.forEach((j) => { if (j && j.parent != null && !names.has(j.parent)) errs.push('關節 ' + j.name + ' 的 parent「' + j.parent + '」不存在'); });
        if (Array.isArray(skin.weights)) { if (skin.weights.length !== nVerts) errs.push('skin.weights 長度（' + skin.weights.length + '）要等於頂點數（' + nVerts + '）'); } else if (skin.weights != null && skin.weights !== 'auto') errs.push('skin.weights 要是 "auto" 或每個頂點的 [[關節序,權重],…]');
        for (const m of skin.motions || []) { if (!m || !m.name || !(m.duration > 0)) { errs.push('動作需要 name 與 duration>0'); continue; } for (const t of m.tracks || []) { if (!names.has(t.joint)) errs.push('動作 ' + m.name + ' 的軌跡指到不存在的關節「' + t.joint + '」'); if (!Array.isArray(t.keys) || !t.keys.length) errs.push('動作 ' + m.name + ' / ' + t.joint + ' 沒有 keys'); } }
        return errs;
    }
    return { prepare, placeSkeleton, autoWeights, explicitWeights, evalTrack, validate, mul, trans, rotXYZ, xform, ident };
});
