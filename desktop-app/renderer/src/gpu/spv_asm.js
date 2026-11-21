/* SPIR-V 文字組譯器（FaSpvAsm，UMD，純邏輯）：把 spirv-as 風格的文字組成 SPIR-V 二進位（Uint8Array，小端）。給測試與手寫小核心用；
 * 正式流程的 SPIR-V 由 clang＋llvm-spirv（或 clspv 等）離線產生，直接交給 clCreateProgramWithIL。
 *   const bin = FaSpvAsm.assemble(text);          // 每行一個指令：[%結果 =] OpXxx 運算元…；; 開頭是註解
 * 運算元：%名字（id，依第一次出現編號）、數字（十進位／0x 十六進位／負數／浮點，依型別決定寬度）、"字串"、列舉名（Decoration BuiltIn GlobalInvocationId；位元遮罩用 A|B）。
 * OpExtInst 的指令名直接寫（例如 OpExtInst %float %ocl fma %a %b %c，%ocl 是 OpExtInstImport "OpenCL.std" 的結果）。
 * 運算元種類來自 spv_tables.js（由 SPIRV-Headers 產生）。版本字：1.0（0x00010000）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./spv_tables.js'));
    else root.FaSpvAsm = factory(root.FaSpvTables);
})(typeof self !== 'undefined' ? self : this, function (T) {
    'use strict';
    class AsmError extends Error { constructor(m, line) { super((line ? '第 ' + line + ' 行：' : '') + m); this.name = 'AsmError'; this.line = line; } }
    const f32buf = new Float32Array(1), u32buf = new Uint32Array(f32buf.buffer), f64buf = new Float64Array(1), u32pair = new Uint32Array(f64buf.buffer);

    function tokenize(line, ln) {
        const toks = []; let i = 0;
        while (i < line.length) {
            const c = line[i];
            if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
            if (c === ';') break;
            if (c === '"') { let j = i + 1, s = ''; while (j < line.length && line[j] !== '"') { if (line[j] === '\\' && j + 1 < line.length) { j++; s += line[j] === 'n' ? '\n' : line[j] === '0' ? '\0' : line[j]; } else s += line[j]; j++; } if (j >= line.length) throw new AsmError('字串沒有結尾', ln); toks.push({ t: 's', v: s }); i = j + 1; continue; }
            let j = i; while (j < line.length && !' \t\r'.includes(line[j]) && line[j] !== ';') j++;
            const w = line.slice(i, j); toks.push(w[0] === '%' ? { t: 'id', v: w.slice(1) } : { t: 'w', v: w }); i = j;
        }
        return toks;
    }
    const strWords = (s) => { const b = new TextEncoder().encode(s), n = Math.floor(b.length / 4) + 1, w = new Array(n).fill(0); for (let i = 0; i < b.length; i++) w[i >> 2] |= b[i] << (8 * (i & 3)); return w; };

    function assemble(text) {
        const lines = String(text).split('\n'), insts = [];
        for (let k = 0; k < lines.length; k++) { const toks = tokenize(lines[k], k + 1); if (toks.length) insts.push({ toks, ln: k + 1 }); }
        const ids = new Map(); let nextId = 1; const idOf = (name) => { if (!ids.has(name)) ids.set(name, nextId++); return ids.get(name); };
        for (const ins of insts) for (const t of ins.toks) if (t.t === 'id') idOf(t.v);   // 依第一次出現編號（前向參照沒問題）
        const typeOf = new Map(), widthOf = new Map(), floatId = new Set(), extSet = new Map(), words = [], defined = new Set(), refLine = new Map();
        for (const ins of insts) {
            let toks = ins.toks, resName = null;
            if (toks.length >= 3 && toks[0].t === 'id' && toks[1].t === 'w' && toks[1].v === '=') { resName = toks[0].v; toks = toks.slice(2); }
            const opn = toks[0]; if (!opn || opn.t !== 'w' || !T.ops[opn.v]) throw new AsmError('不認得的指令「' + (opn ? opn.v : '') + '」', ins.ln);
            const [code, kinds] = T.ops[opn.v]; const args = toks.slice(1), out = [0]; let ai = 0, resultTypeId = 0;
            const need = (what) => { if (ai >= args.length) throw new AsmError(opn.v + ' 缺少運算元（' + what + '）', ins.ln); return args[ai++]; };
            const num = (t) => { if (t.t !== 'w') throw new AsmError('這裡要數字，得到「' + (t.v) + '」', ins.ln); const s = t.v; if (/^-?\d+$/.test(s)) return Number(s); if (/^0x[0-9a-fA-F]+$/i.test(s)) return parseInt(s, 16); const f = Number(s); if (!Number.isNaN(f)) return f; throw new AsmError('不是數字：' + s, ins.ln); };
            const enumVal = (kind, t, pushParams) => {
                const E = T.enums[kind]; if (!E) throw new AsmError('沒有列舉 ' + kind, ins.ln);
                if (t.t === 'w' && /^(\d+|0x[0-9a-fA-F]+)$/.test(t.v)) { out.push(num(t) >>> 0); return; }
                const names = t.v.split('|'); let val = 0; const params = [];
                for (const n of names) { const e = E[n]; if (e === undefined || n === '__bit') throw new AsmError(kind + ' 沒有「' + n + '」', ins.ln); const v = Array.isArray(e) ? e[0] : e; val |= v; if (Array.isArray(e)) params.push([v, e[1]]); }
                out.push(val >>> 0);
                params.sort((a, b) => a[0] - b[0]);
                for (const [, ps] of params) for (const pk of ps) operand(pk.replace(/[?*]$/, ''));
            };
            const wordsOfNumber = (v, width, isFloat) => {
                if (isFloat) { if (width === 32) { f32buf[0] = v; return [u32buf[0]]; } if (width === 64) { f64buf[0] = v; return [u32pair[0], u32pair[1]]; } throw new AsmError('不支援 ' + width + ' 位元浮點常數', ins.ln); }
                if (width <= 32) return [(v | 0) >>> 0]; const b = BigInt.asUintN(64, BigInt(v)); return [Number(b & 0xFFFFFFFFn), Number(b >> 32n)];
            };
            const operand = (k) => {
                switch (k) {
                    case 'IdResultType': { const t = need('結果型別'); if (t.t !== 'id') throw new AsmError('結果型別要是 %id', ins.ln); resultTypeId = idOf(t.v); out.push(resultTypeId); return; }
                    case 'IdResult': { if (!resName) throw new AsmError(opn.v + ' 需要「%結果 =」', ins.ln); out.push(idOf(resName)); return; }
                    case 'IdRef': case 'IdScope': case 'IdMemorySemantics': { const t = need('id'); if (t.t !== 'id') throw new AsmError(opn.v + ' 的運算元要是 %id，得到「' + t.v + '」', ins.ln); out.push(idOf(t.v)); return; }
                    case 'LiteralString': { const t = need('字串'); if (t.t !== 's') throw new AsmError('要字串', ins.ln); out.push(...strWords(t.v)); return; }
                    case 'LiteralInteger': case 'LiteralExtInstInteger': case 'LiteralSpecConstantOpInteger': out.push(num(need('整數')) >>> 0); return;
                    case 'LiteralContextDependentNumber': {   // OpConstant／OpSpecConstant：寬度與整數／浮點由結果型別決定
                        const t = need('數值'), w = widthOf.get(resultTypeId) || 32, isF = floatId.has(resultTypeId), v = num(t); out.push(...wordsOfNumber(v, w, isF)); return;
                    }
                    case 'PairLiteralIntegerIdRef': { const lit = need('literal'), id = need('label'); const sw = widthOf.get(ins.selWidthId) || 32; out.push(...wordsOfNumber(num(lit), sw, false), idOf(id.v)); return; }
                    case 'PairIdRefLiteralInteger': { const id = need('id'); out.push(idOf(id.v), num(need('index')) >>> 0); return; }
                    case 'PairIdRefIdRef': { out.push(idOf(need('id').v), idOf(need('id').v)); return; }
                    default: if (T.enums[k]) { enumVal(k, need(k), true); return; } throw new AsmError('組譯器不支援運算元種類 ' + k, ins.ln);
                }
            };
            // OpExtInst：集合名 → 指令名（OpenCL.std）
            if (opn.v === 'OpExtInst') {
                operand('IdResultType'); operand('IdResult'); const setTok = need('擴充指令集'); out.push(idOf(setTok.v)); const nm = need('擴充指令名');
                const set = extSet.get(setTok.v); if (set !== 'OpenCL.std') throw new AsmError('只認得 OpenCL.std（%' + setTok.v + '）', ins.ln);
                const ent = T.oclOps[nm.v]; if (!ent) throw new AsmError('OpenCL.std 沒有「' + nm.v + '」', ins.ln); out.push(ent[0]);
                while (ai < args.length) operand('IdRef');
            } else {
                if (opn.v === 'OpSwitch') { const t = args[0]; ins.selWidthId = t && t.t === 'id' ? typeOf.get(idOf(t.v)) : 0; }
                for (let ki = 0; ki < kinds.length; ki++) {
                    let k = kinds[ki], q = ''; if (/[?*]$/.test(k)) { q = k.slice(-1); k = k.slice(0, -1); }
                    if (q === '?') { if (ai < args.length) operand(k); }
                    else if (q === '*') { while (ai < args.length) operand(k); }
                    else operand(k);
                }
                if (ai < args.length) throw new AsmError(opn.v + ' 多了運算元「' + args[ai].v + '」', ins.ln);
            }
            out[0] = ((out.length << 16) | code) >>> 0; words.push(...out);
            // 追蹤型別資訊（常數的寬度、OpSwitch 的選擇值寬度）
            const rid = resName ? idOf(resName) : 0; if (rid) defined.add(rid);
            for (const t of args) if (t.t === 'id' && !refLine.has(t.v)) refLine.set(t.v, ins.ln);
            if (opn.v === 'OpTypeInt') widthOf.set(rid, out[2]);
            else if (opn.v === 'OpTypeFloat') { widthOf.set(rid, out[2]); floatId.add(rid); }
            if (rid && resultTypeId) typeOf.set(rid, resultTypeId);
            if (opn.v === 'OpExtInstImport') { const bytes = []; for (let i = 2; i < out.length; i++) for (let b = 0; b < 4; b++) bytes.push((out[i] >>> (8 * b)) & 255); const nmz = new TextDecoder().decode(Uint8Array.from(bytes.slice(0, bytes.indexOf(0)))); extSet.set(resName, nmz); }
        }
        for (const [name, ln] of refLine) if (!defined.has(idOf(name))) throw new AsmError('%' + name + ' 沒有定義', ln);
        const head = [T.magic, 0x00010000, 0, nextId, 0], all = head.concat(words), u8 = new Uint8Array(all.length * 4), dv = new DataView(u8.buffer);
        all.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true)); return u8;
    }
    return { assemble, AsmError };
});
