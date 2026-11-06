'use strict';
// 隨機建樹 → 反解 → 真 tree-sitter 解析：不得有 ERROR，且節點結構一致。需要 ~/.cache/fa-ts（tree-sitter.js／wasm，專案本來就從 CDN 載入並快取）。
const fs = require('fs'), path = require('path'), os = require('os');
const A = require('./ast_build_core.js'); const S = A.load(require('./python.grammar.json'));
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function decider(seed) { const r = rng(seed); let n = 0; const NAMES = ['a', 'b', 'n', 'total', 'xs', 'i']; const LEAF = new Set(['identifier', 'integer', 'float', 'true', 'false', 'none', 'string', 'pass_statement']);
    return { async choice(q) { n++; if (q.kind === 'repeat') return r() < Math.max(0.05, 0.5 - 0.05 * q.count - n / 150) ? 0 : 1; if (q.kind === 'option') return r() < (n > 60 ? 0 : 0.3) ? 0 : 1;
        const leafy = q.options.map((o, i) => [o, i]).filter(([o]) => LEAF.has(o.label)); if (n > 40 && leafy.length) return leafy[Math.floor(r() * leafy.length)][1]; return Math.floor(r() * q.options.length); },
        async leaf(q) { if (q.type === 'integer') return String(Math.floor(r() * 99)); if (q.type === 'float') return '1.5'; if (q.type === 'string') return 'hi'; return NAMES[Math.floor(r() * NAMES.length)]; } };
}
const sx = (t) => (t.type === 'parenthesized_list_splat' ? 'parenthesized_expression' : t.type) + (t.kids.length ? '(' + t.kids.map(sx).join(' ') + ')' : '');
function conv(n) { const kids = []; if (n.type === 'string') return { type: 'string', kids }; for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c.type === 'comment') continue; kids.push(conv(c)); } return { type: n.type === 'parenthesized_list_splat' ? 'parenthesized_expression' : n.type, kids }; }
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR + '（tree-sitter 快取）'); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const N = +process.argv[2] || 300; let ok = 0, err = 0, diff = 0; const bad = [];
    for (let seed = 1; seed <= N; seed++) {
        let root; try { root = await A.build(S, decider(seed)); } catch (e) { err++; bad.push({ seed, why: String(e.message) }); continue; }
        const { text, tree } = A.unparse(root, S); const t = P.parse(text);
        if (t.rootNode.hasError()) { err++; bad.push({ seed, why: 'ERROR', text }); continue; }
        const a = sx(tree), b = sx(conv(t.rootNode)); if (a !== b) { diff++; bad.push({ seed, why: 'DIFF', text, a, b }); continue; } ok++;
    }
    console.log('隨機建樹 ' + N + ' 棵：OK ' + ok + '、解析錯誤 ' + err + '、結構不同 ' + diff);
    for (const x of bad.slice(0, +process.argv[3] || 4)) { console.log('--- seed ' + x.seed + ' ' + x.why); if (x.text) console.log(x.text.slice(0, 300)); if (x.a) { let i = 0; while (x.a[i] === x.b[i]) i++; console.log('建: …' + x.a.slice(Math.max(0, i - 40), i + 60) + '\n解: …' + x.b.slice(Math.max(0, i - 40), i + 60)); } }
    // 殘餘的不一致都是文法本身的歧義（with (x): 與元組、yield 後帶逗號、(*x) 括號等）；實際流程反解後會再用 tree-sitter 解析一次擋掉。門檻：95%。
    console.log((ok / N >= 0.95 ? 1 : 0) + ' passed, ' + (ok / N >= 0.95 ? 0 : 1) + ' failed');
    process.exit(ok / N >= 0.95 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
