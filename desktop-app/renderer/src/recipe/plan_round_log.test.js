// node renderer/src/recipe/plan_round_log.test.js
// 計畫的「每一輪一行」（FaPlan.roundLog）：輪數＝開始一個步驟的次數；行序與事件順序一致；誰做（程式／模型）與關鍵參數、回傳大小、退路原因都在行裡。
// 事件形狀照 plan_core.js 的 advanceCore 裡 emit({...}) 的實際欄位造（step_start／fill／step_done／step_failed／decision／replan…）；
// 沒有跑真的 advance（建計畫的參數太多，這裡只驗行格式與順序）。
const P = require('./plan_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };

// 1. 兩輪：第 1 輪工具（有參數與回傳）、第 2 輪模型填欄位、第 2 輪完成；應該是 4 行、順序固定
{
    const lines = []; const RL = P.roundLog((x) => lines.push(x));
    RL.event({ type: 'step_start', step: 's1', tool: 'fetch_web_page' });
    RL.tool('fetch_web_page', { url: 'https://tw.news.yahoo.com/' }, true, '標題一\n標題二 內容很長很長');
    RL.event({ type: 'step_done', step: 's1', artifacts: ['text'] });
    RL.event({ type: 'step_start', step: 's2', tool: 'local_summarize' });
    RL.event({ type: 'fill', step: 's2', missing: ['text'], filled: ['text'] });
    RL.event({ type: 'step_failed', step: 's2', error: '模型退回' });
    check('1 行數正確', lines.length === 4, lines);
    check('1 第 1 輪工具行含工具名與參數', lines[0].startsWith('第 1 輪｜工具｜程式｜fetch_web_page {"url":"https://tw.news.yahoo.com/"}'), lines[0]);
    check('1 工具行含回傳字數與開頭', lines[0].includes('回 ') && lines[0].includes('字，開頭「標題一'), lines[0]);
    check('1 步驟完成行帶同一輪的工具名', lines[1] === '第 1 輪｜完成｜程式｜fetch_web_page｜成品：text｜' + lines[1].split('｜').pop(), lines[1]);
    check('2 填欄位行標明模型做的', lines[2].startsWith('第 2 輪｜填欄位｜模型｜缺：text｜填入：text'), lines[2]);
    check('2 失敗行帶工具名與原因', lines[3].startsWith('第 2 輪｜失敗｜程式｜local_summarize｜模型退回｜'), lines[3]);
}

// 2. 工具失敗：工具行標「失敗：」與原因；沒有 step_start 的事件仍不崩（輪數至少 1）
{
    const lines = []; const RL = P.roundLog((x) => lines.push(x));
    RL.tool('browser_create_tab', { url: 'x' }, false, '逾時');
    check('2 沒有 step_start 時輪數記為第 1 輪', lines[0].startsWith('第 1 輪｜工具｜程式｜browser_create_tab'), lines[0]);
    check('2 失敗原因寫進行裡', lines[0].includes('失敗：逾時'), lines[0]);
}

// 3. 退路與重新規劃、停止：行序與內容
{
    const lines = []; const RL = P.roundLog((x) => lines.push(x));
    RL.event({ type: 'step_start', step: 's1', tool: 'fetch_web_page' });
    RL.event({ type: 'decision', step: 's1', rule: 'x', action: 'replan', why: '網路逾時' });
    RL.event({ type: 'replan', excluded: ['fetch_web_page'], steps: ['browser_create_tab', 'fetch_web_page'] });
    RL.event({ type: 'limit', what: 'calls' });
    check('3 退路行', lines[0] === '第 1 輪｜退路｜程式｜replan（網路逾時）', lines[0]);
    check('3 重新規劃行列出步驟', lines[1] === '第 1 輪｜重新規劃｜程式｜browser_create_tab → fetch_web_page', lines[1]);
    check('3 呼叫次數上限行', lines[2] === '第 1 輪｜停止｜程式｜呼叫次數已達上限', lines[2]);
    check('3 共 3 行', lines.length === 3, lines);
}

// 4. 行的順序與事件順序一致，且每輪編號遞增（5 個工具呼叫，每輪 2 行：工具＋完成；開始一個步驟本身不寫行）
{
    const lines = []; const RL = P.roundLog((x) => lines.push(x));
    for (let i = 1; i <= 5; i++) {
        RL.event({ type: 'step_start', step: 's' + i, tool: 't' + i });
        RL.tool('t' + i, { n: i }, true, 'r' + i);
        RL.event({ type: 'step_done', step: 's' + i, artifacts: [] });
    }
    const rounds = lines.map((l) => Number(/^第 (\d+) 輪/.exec(l)[1]));
    check('4 每輪編號遞增且不重複', JSON.stringify(rounds) === JSON.stringify([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]), rounds);
    check('4 行數 10（每輪工具行＋完成行）', lines.length === 10, lines.length);
}

// 5. 參數過長會截斷；寫入函式丟錯不影響計畫（不拋出）
{
    const lines = []; const RL = P.roundLog((x) => lines.push(x));
    RL.tool('big', { s: 'x'.repeat(500) }, true, 'ok');
    check('5 參數截斷', lines[0].length < 260 && lines[0].includes('…'), lines[0].length);
    const bad = P.roundLog(() => { throw new Error('UI 壞了'); });
    let threw = false; try { bad.event({ type: 'step_start', step: 's', tool: 't' }); bad.tool('t', {}, true, 'x'); } catch (_) { threw = true; }
    check('5 寫入丟錯不影響計畫', !threw);
}

console.log('plan_round_log.test.js: ' + ok + ' passed, ' + bad + ' failed');
if (bad) process.exit(1);
