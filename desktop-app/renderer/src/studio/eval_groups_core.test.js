// node renderer/src/studio/eval_groups_core.test.js —— 評量組定義：題數、可重現、判準、沙盒缺席時的說明、以標準答案當生成器時全部通過
const G = require('./eval_groups_core.js');
let ok = 0, bad = 0; const check = (n, c, d) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };
const ids = G.GROUPS.map((g) => g.id);
check('五個評量組：toolcall、plan、decompose、code_write、reading', ['toolcall', 'plan', 'decompose', 'code_write', 'reading'].every((x) => ids.indexOf(x) >= 0) && ids.length === 5);
check('組名唯一，且每組都寫來源', new Set(G.GROUPS.map((g) => g.group)).size === 5 && G.GROUPS.every((g) => g.source && g.source.length > 20));
check('每組 20 題，可重現（同一種子產生一樣的題目）', G.GROUPS.every((g) => JSON.stringify(g.make(g.seed)) === JSON.stringify(g.make(g.seed)) && g.make(g.seed).length === G.N_PER_GROUP));
// toolcall
const tc = G.genToolcall(11), okCall = tc.find((x) => !x.gold.refuse), refuse = tc.find((x) => x.gold.refuse);
const goodOut = '<tool_call>{"name":"' + okCall.gold.name + '","arguments":' + JSON.stringify(okCall.gold.arguments) + '}</tool_call>';
check('工具：參數正確 → 通過，格式合法', G.scoreToolcall(okCall, goodOut).pass === true && G.scoreToolcall(okCall, goodOut).formatOk === true);
check('工具：參數錯 → 不通過', G.scoreToolcall(okCall, '<tool_call>{"name":"' + okCall.gold.name + '","arguments":{}}</tool_call>').pass === false);
check('工具：沒有 tool_call 標籤 → 格式不合法', G.scoreToolcall(okCall, '我來查天氣').formatOk === false);
check('工具：缺工具要拒絕（用句型）', G.scoreToolcall(refuse, '工具清單裡沒有 send_email，無法寄信。').pass === true && G.scoreToolcall(refuse, '好的，我寄出了。').pass === false);
// plan
check('plan：合法 JSON、checks 夠多、每筆有 item 與布林 ok → 通過', G.scorePlan({ gold: { min: 2 } }, '{"checks":[{"item":"a","ok":true},{"item":"b","ok":false}]}').pass === true);
check('plan：checks 太少或格式錯 → 不通過', G.scorePlan({ gold: { min: 3 } }, '{"checks":[{"item":"a","ok":true}]}').pass === false && G.scorePlan({ gold: { min: 1 } }, '不是 JSON').pass === false);
// decompose
const dc = G.genDecompose()[0];
check('decompose：函式名稱集合完全相同 → 通過', G.scoreDecompose(dc, JSON.stringify({ functions: dc.gold.fns.map((n) => ({ name: n })) })).pass === true);
check('decompose：少一個 → 不通過', G.scoreDecompose(dc, JSON.stringify({ functions: dc.gold.fns.slice(1).map((n) => ({ name: n })) })).pass === false);
// reading
const rd = G.genReading(), rq = rd.find((x) => !x.gold.refuse), rn = rd.find((x) => x.gold.refuse);
check('閱讀：引用句逐字出現在文中且答對 → 通過', G.scoreReading(rq, '答案是「' + rq.gold.answer + '」。').pass === true);
check('閱讀：引用的句子不在文中（改寫）或沒有引用 → 不通過', G.scoreReading(rq, '答案是「' + rq.gold.answer + '的意思」。').pass === false && G.scoreReading(rq, '答案是' + rq.gold.answer).pass === false);
check('閱讀：無答案的題要拒答；亂猜不通過', G.scoreReading(rn, '文中沒有提到。').pass === true && G.scoreReading(rn, '答案是「三點」').pass === false);
// 描述與沙盒
const d = G.describeAll({});
check('code_write 沒有判題沙盒：標不可用並寫原因', d.find((x) => x.id === 'code_write').available === false && /桌面版 Python/.test(d.find((x) => x.id === 'code_write').unavailable));
check('描述：每組都列題數、來源、留出', d.every((x) => x.n === 20 && x.source && x.heldout === true));
(async () => {
    const all = G.GROUPS.map((g) => ({ g, items: g.make(g.seed) }));
    const oracle = (p) => { for (const x of all) { const it = x.items.find((i) => i.prompt === p); if (!it) continue; const g = it.gold, k = x.g.kind;
        if (k === 'toolcall') return g.refuse ? '工具清單裡沒有那個工具。' : '<tool_call>' + JSON.stringify({ name: g.name, arguments: g.arguments }) + '</tool_call>';
        if (k === 'plan') return JSON.stringify({ checks: Array.from({ length: g.min }, (_, i) => ({ item: '第' + i + '項', ok: true })) });
        if (k === 'decompose') return JSON.stringify({ functions: g.fns.map((n) => ({ name: n })) });
        if (k === 'code') return '```python\ndef ' + g.name + '(*a):\n    return None\n```';
        return g.refuse ? '文中沒有提到。' : '答案是「' + g.answer + '」。'; } return ''; };
    const res = await G.runGroups({ generate: async (p) => oracle(p), judge: async (code) => ({ pass: /def /.test(code) }) });
    check('標準答案當生成器：四個純判題組全部 20／20', res.filter((r) => r.kind !== 'code').every((r) => r.pass === r.n && r.n === 20), res.map((r) => [r.kind, r.pass, r.n]));
    check('沙盒有接上時 code 組會跑（以假判題通過）', res.find((r) => r.kind === 'code').pass === 20);
    check('格式率有算（工具組）', res.find((r) => r.kind === 'toolcall').formatN > 0 && res.find((r) => r.kind === 'toolcall').formatPass > 0);
    const noSb = await G.runGroups({ generate: async (p) => oracle(p) });
    const c = noSb.find((r) => r.kind === 'code');
    check('沒有沙盒：code 組寫原因、不計入通過', !!c.unavailable && c.n === 0 && c.pass === 0, c);
    const garbage = await G.runGroups({ generate: async () => '亂答' });
    check('亂答：純判題組都不通過（不會誤判）', garbage.filter((r) => r.kind !== 'code').every((r) => r.pass === 0));
    console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})();
