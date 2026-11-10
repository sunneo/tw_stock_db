#!/usr/bin/env node
'use strict';
/* 結構轉換 runtime tool（nodejs 端）：JSON 型別 ↔ 各語言資料結構，含 load／save 介面。Python 端是同目錄的 fa_struct.py（用本檔當後端），兩邊介面一樣。
 * 核心是 json_struct_core.js（純函式）；本檔補上「從檔案或字串讀入、存成檔案或字串」。設計與用法見 DESIGN.core-ir.md 第 15 節。
 *
 * API（require('./fa_struct.js')）——凡是「來源」參數，可以給 JSON 字串、檔案路徑，或已經解開的物件：
 *   infer(sample, {name})            sample 可以是一個或多個範例（陣列）→ 結構描述（物件）
 *   fromDesc(desc, {name})           型別描述（見 json_struct_core.js 檔頭）→ 結構描述
 *   loadSchema(src)                  從字串／檔案讀入結構描述（fa-struct v1）→ 結構描述
 *   saveSchema(schema, path)         存成檔案（path 給了就寫檔並回傳 path，沒給就回傳字串）
 *   generate(schema, lang, {main, out})  → { ok, code, marshal, notes }；lang：cpp c python nodejs java csharp；out 給了就把程式碼寫成檔案
 *   convert(src, lang, {name, out})  一步到位：src 是範例（JSON）或結構描述 → 目標語言的程式碼
 * CLI：node fa_struct.js infer <範例檔|-> [--name N] [--out schema.json]
 *      node fa_struct.js generate <schema.json|範例檔|-> --lang cpp [--main] [--out 檔]
 *      node fa_struct.js --rpc          （從標準輸入讀 {"cmd":…,"args":[…]}，把 JSON 結果寫到標準輸出——Python 端用這個） */
const fs = require('fs'), path = require('path');
const JSS = require('./json_struct_core.js');
const looksJson = (s) => /^\s*[\[{"]/.test(s) || /^\s*(-?\d|true|false|null)/.test(s);
function text(src) { if (typeof src !== 'string') return src; if (!looksJson(src) && src.length < 4096 && fs.existsSync(src)) return fs.readFileSync(src, 'utf8'); return src; }
function infer(sample, opts) { const list = (Array.isArray(sample) ? sample : [sample]).map(text); return JSS.inferSchema(list, opts); }
function fromDesc(desc, opts) { return JSS.parseTypeDesc(typeof desc === 'string' ? text(desc) : desc, opts); }
function loadSchema(src) { return JSS.loadSchema(typeof src === 'string' ? text(src) : src); }
function saveSchema(schema, p) { const s = JSS.saveSchema(JSS.loadSchema(schema)); if (!p) return s; fs.writeFileSync(p, s, 'utf8'); return p; }
function asSchema(src, opts) { // 結構描述（有 fa_struct 欄位）或範例 JSON
    const t = typeof src === 'string' ? text(src) : src; let o = t; if (typeof t === 'string') { try { o = JSON.parse(t); } catch (e) { o = null; } }
    if (o && typeof o === 'object' && !Array.isArray(o) && o.fa_struct != null) return JSS.loadSchema(o);
    return JSS.inferSchema([t], opts);
}
function generate(schema, lang, opts) { const r = JSS.generate(asSchema(schema, opts), lang, opts); if (r.ok && opts && opts.out) { fs.writeFileSync(opts.out, r.code, 'utf8'); r.written = opts.out; } return r; }
function convert(src, lang, opts) { return generate(asSchema(src, opts), lang, opts); }
module.exports = { infer, fromDesc, loadSchema, saveSchema, generate, convert, LANGS: Object.keys(JSS.LANG_GEN) };

if (require.main === module) {
    const argv = process.argv.slice(2); const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; }; const has = (n) => argv.indexOf(n) >= 0;
    const readIn = (a) => (a === '-' || a == null ? fs.readFileSync(0, 'utf8') : a);
    const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };
    try {
        const cmd = argv[0];
        if (cmd === '--rpc') { const req = JSON.parse(fs.readFileSync(0, 'utf8')); const fn = module.exports[req.cmd]; if (typeof fn !== 'function' || req.cmd === 'LANGS') throw new Error('不認得的指令：' + req.cmd); out({ ok: true, result: fn.apply(null, req.args || []) }); }
        else if (cmd === 'infer') { const sch = infer(readIn(argv[1]), { name: flag('--name') || 'Root' }); if (flag('--out')) { saveSchema(sch, flag('--out')); out({ ok: true, written: flag('--out') }); } else process.stdout.write(saveSchema(sch) + '\n'); }
        else if (cmd === 'generate') { const lang = flag('--lang'); if (!lang) throw new Error('缺 --lang（' + module.exports.LANGS.join('、') + '）'); const r = generate(readIn(argv[1]), lang, { main: has('--main'), name: flag('--name') || 'Root', out: flag('--out') }); if (!r.ok) throw new Error(r.error); if (r.written) out({ ok: true, written: r.written, notes: r.notes }); else process.stdout.write(r.code); }
        else { process.stderr.write('用法：\n  node fa_struct.js infer <範例檔|-> [--name N] [--out schema.json]\n  node fa_struct.js generate <schema.json|範例檔|-> --lang ' + module.exports.LANGS.join('|') + ' [--main] [--name N] [--out 檔]\n  node fa_struct.js --rpc\n'); process.exit(2); }
    } catch (e) { if (argv[0] === '--rpc') out({ ok: false, error: String((e && e.message) || e) }); else process.stderr.write('錯誤：' + ((e && e.message) || e) + '\n'); process.exit(1); }
}
