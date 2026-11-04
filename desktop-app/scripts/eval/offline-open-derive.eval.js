// 離線「打開」語意推導評測：分段回報——①種類表直接認得 ②工具目錄推導（程式）③推導不出（交給小模型字母題／問使用者）④推導錯了
// 用法：node scripts/eval/offline-open-derive.eval.js [--verbose]；程式端命中率＝①＋②答對的比例。加小模型後的命中率要在真桌面版量（見 scripts/eval/offline-open-derive.electron.eval.js）。
const fs = require('fs'), path = require('path');
const G = require('../../renderer/src/offline/intent_gate.js');
const DATA = require('./offline-open-derive.data.js');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer/src/floating-assistant.js'), 'utf8');
const scan = G.scanTools(src);
const gm = src.indexOf('const FA_SEM_GROUPS = {'), gm2 = src.indexOf('function _faSemBuildLex');
const GROUPS = new Function(src.slice(gm, gm2) + '\nreturn FA_SEM_GROUPS;')();
const synonyms = Object.values(GROUPS).map((v) => String(v).toLowerCase().split(/\s+/).filter(Boolean));
function classify(text) {
    // 附件與網址不是這裡要量的東西：這裡只量「種類判斷」
    let g = G.gate(text); if (g.kind) return { kind: g.kind, stage: 'table', by: g.kindBy };
    if (!g.explicit) return { kind: null, stage: 'not-explicit', by: '不是明確的打開說法' };
    const c = G.deriveTool(text, scan.tools, { synonyms }); const p = G.pickDerived(c);
    if (p) return { kind: p.kind, stage: 'derive', by: p.hit.slice(0, 4).join('、') + ' ' + p.score + '分' };
    return { kind: null, stage: 'unresolved', by: '候選：' + c.slice(0, 3).map((x) => x.kind + ':' + x.score).join('、'), cands: c };
}
function run(data) {
    const rows = (data || DATA).map(([t, exp]) => Object.assign({ text: t, exp }, classify(t)));
    const seg = { table: 0, derive: 0, unresolved: 0, wrong: 0, notExplicit: 0 }; let right = 0;
    for (const r of rows) {
        if (r.stage === 'table' || r.stage === 'derive') { if (r.kind === r.exp) { right++; seg[r.stage]++; } else seg.wrong++; r.ok = r.kind === r.exp; }
        else if (r.stage === 'not-explicit') seg.notExplicit++; else seg.unresolved++;
    }
    return { rows, seg, right, total: rows.length, rate: right / rows.length };
}
if (require.main === module) {
    for (const [name, data] of [['seen（寫說明時看過的詞，偏樂觀）', DATA.seen], ['heldout（說明補完後才寫、詞沒出現在說明裡）', DATA.heldout]]) {
        const r = run(data);
        console.log('【' + name + '】評測 ' + r.total + ' 句；程式端命中 ' + r.right + '（' + Math.round(r.rate * 100) + '%）＝表直接認得 ' + r.seg.table + '＋工具目錄推導 ' + r.seg.derive + '；推導錯 ' + r.seg.wrong + '；推導不出（交給小模型／問使用者）' + r.seg.unresolved + '；不是明確打開說法 ' + r.seg.notExplicit);
        for (const x of r.rows) if (process.argv.includes('--verbose') || !x.ok) console.log((x.ok ? 'ok   ' : 'MISS ') + x.text + ' → ' + (x.kind || '（無）') + '（期望 ' + x.exp + '；' + x.stage + '：' + x.by + '）');
    }
}
module.exports = { run, classify, DATA };
