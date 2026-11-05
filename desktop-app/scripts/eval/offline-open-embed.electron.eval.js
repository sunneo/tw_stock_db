// 真桌面版量「字面＋語意向量」的程式端命中率與耗時（用法：先建持久的評估資料夾 <P> 並寫 main-ext-rev.txt；
//   FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17951 FA_DEBUG_EVAL_FILE=<本檔，前面接 window.__d=資料集;> electron . --no-sandbox --disable-gpu --user-data-dir=<P>；絕不用 17923）
// 第一次會下載模型（約 118MB，已在 <P> 的 Cache Storage 就不再下載）。評測 localStorage 同意旗標由本檔設定（等同使用者按了「下載並啟用」）。
const fa = window.fa; fa.advancedSettings.offlineMode = true; localStorage.setItem('fa_gate_embed_consent', '1');
const index = Object.entries(fa.tools).map(([n, t]) => ({ name: n, desc: String((t && t.description) || '') }));
const syn = Object.values(typeof FA_SEM_GROUPS !== 'undefined' ? FA_SEM_GROUPS : {}).map((v) => String(v).toLowerCase().split(/\s+/).filter(Boolean)).concat(fa._otSynGroups());
const tr = () => {}; tr.end = () => {};
const tl0 = Date.now(); await fa._otGateEmbedRank('叫出損益表', tr); const firstLoadMs = Date.now() - tl0;
const out = { firstLoadMs, sets: {}, perSentenceMs: [] };
for (const [name, data] of Object.entries(window.__d)) {
    let lexRight = 0, bothRight = 0, wrong = 0, undecided = 0; const miss = [];
    for (const [t, exp] of data) {
        const g = FaIntentGate.gate(t); let k = null, by = '';
        if (g.kind) { k = g.kind; by = 'table'; }
        else if (g.explicit) { const p = FaIntentGate.pickDerived(FaIntentGate.deriveTool(t, index, { synonyms: syn })); if (p) { k = p.kind; by = 'lex'; } }
        if (by && k === exp) lexRight++;
        if (!k && g.explicit) { const a = Date.now(); const rk = await fa._otGateEmbedRank(t, tr); out.perSentenceMs.push(Date.now() - a); const ep = FaIntentGate.pickEmbedded(rk); if (ep) { k = ep.kind; by = 'embed'; } }
        if (k === exp) bothRight++; else { if (k) wrong++; else undecided++; miss.push(t + '→' + k + '(' + by + ')'); }
    }
    out.sets[name] = { total: data.length, lexRight, bothRight, wrong, undecided, miss };
}
const ms = out.perSentenceMs; out.embedAvgMs = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0; out.embedMaxMs = ms.length ? Math.max(...ms) : 0; delete out.perSentenceMs;
out.script = [...document.scripts].map((s) => s.src).filter((s) => /floating-assistant/.test(s));
return out;
