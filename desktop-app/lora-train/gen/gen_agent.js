'use strict';
/* agent／writer 領域（對應對照設計的 agent/call_ref・use・direct・nofit・ask 與 writer/answer・unsure・copycode）：
 * 工具＝我們自己的真實工具 lookup_error_code（查錯誤碼）與 explain_command_line（解釋命令列）（規格取自 real_tools_all.json）。
 * 事實池＝公開的 Linux errno／Windows HRESULT／常用命令說明（data/ref_facts.json，取自參考實作的公開事實表；錯誤碼意義是公開事實，不是我們編的）。
 * 對照設計的「團隊知識庫 rag_search／KB 團隊規定」在我們這邊沒有對應工具、內容是他們團隊的規定，所以不收（不編造）。
 * 實體以 md5(entity)%5==0 分出 heldout（對照設計同一規則）。
 * 限制（誠實）：tool 結果文字用事實表原文，不是我們 lookup_error_code 真的回傳的格式；實體只有 44 個，語句是對照設計的小詞庫。 */
const path = require('path');
const crypto = require('crypto');
const C = require('./w2c_common.js');
const F = require(path.join(__dirname, '..', 'data', 'ref_facts.json'));

const SYS_CALL = 'You are an offline assistant inside floating-assistant. You do not remember facts about error codes or commands: ALWAYS call a tool first to look them up, then answer from the tool result only.';
const SYS_FREE = 'You are an offline assistant inside floating-assistant. Call a tool only when you need a fact you do not know; for greetings and small talk answer directly without any tool.';
const SYS_WHEN = 'You are an offline assistant inside floating-assistant. Use a tool only when one of the tools fits the request. If the request is small talk answer directly; if no tool fits say so briefly; if a needed detail is missing ask for it. Never guess facts.';
const WSYS = (zh) => 'You rewrite the given FACTS as a short answer to the QUESTION. Use ONLY the facts. Do not add anything that is not in the facts. If the facts do not answer the question, reply exactly: ' + (zh ? '不確定。' : 'Not sure.');
const NOFIT_ANS_EN = "I can't do that with the tools I have. I can only look up error codes and explain command lines.";
const NOFIT_ANS_ZH = '這個我做不到。我只能查錯誤碼和解釋命令列。';
const ASK = [['Look up the error for me.', 'Which error code or message should I look up?'], ['What does that error mean?', 'Which error do you mean? Please give me the error code or message.'], ['Explain this command.', 'Which command do you mean? Please paste it.'], ['What does this code mean?', 'Which code do you mean? Please paste it.'], ['幫我查一下那個錯誤', '請問是哪一個錯誤？請給我錯誤碼或訊息。'], ['這個指令是做什麼的？', '請問是哪個指令？請貼給我。']];

const ERR = F.errno.concat(F.hres); const CMD = F.cmds;
const isHeld = (e) => parseInt(crypto.createHash('md5').update(e).digest('hex'), 16) % 5 === 0;
const splitOf = (e) => (isHeld(e) ? 'heldout' : 'train');
const T_ERR = C.BY_NAME.lookup_error_code, T_CMD = C.BY_NAME.explain_command_line, T_REF = C.BY_NAME.ref_lookup;
// lookup_error_code／explain_command_line 的 md5 恰好被分到 heldout（未見過的工具），所以 train 一律用 ref_lookup（參數 query，與對照設計相同），
// 這兩個 heldout 工具只出現在 split:"heldout" 的列（測對沒見過工具的泛化）。
const trainTool = () => ({ tool: T_REF, arg: 'query' });
const toolFor = (split, isCmd) => (split === 'train' ? trainTool() : { tool: isCmd ? T_CMD : T_ERR, arg: isCmd ? 'command' : 'query' });
const lower1 = (s) => s[0].toLowerCase() + s.slice(1);
const zhAns = (q, f) => (F.zh_err[q] ? '根據資料，' + q + ' 是 ' + (F.errcode[q] || f.split('=')[1].split(':')[0].trim()) + '：' + F.zh_err[q] + '。' : '根據資料：' + f);

async function generate() {
    const rows = []; const cnt = {};
    let n = 0;
    const add = (task, kind, split, o) => { n++; const r = Object.assign({ id: 'agent:' + task + ':' + kind + ':' + n, domain: task, stage: task + '_' + kind, task, kind, prefill: '', verified_by: 'program_ground_truth', split, source_file: 'lora-train/data/ref_facts.json', group: task + '/' + kind, seen: split === 'heldout' ? 'unseen' : 'seen' }, o); r.meta = Object.assign({ group: r.group, behavior: kind }, o.meta || {}); rows.push(r); cnt[task + '/' + kind] = (cnt[task + '/' + kind] || 0) + 1; };
    const tools = (rand, need) => { const ts = [need]; for (let i = 0; i < 1 + Math.floor(rand() * 4); i++) { const x = C.pick(rand, C.TRAIN_POOL); if (!ts.includes(x)) ts.push(x); } return C.shuffle(rand, ts).map(C.toolSpec); };
    const um = (sys, user, extra) => [{ role: 'system', content: sys }, { role: 'user', content: user }].concat(extra || []);
    const qOf = (e, zh, rand, isCmd) => C.pick(rand, isCmd ? (zh ? F.q_cmd_zh : F.q_cmd_en) : (zh ? F.q_err_zh : F.q_err_en)).replace('{q}', e);

    const entities = ERR.map((e) => ({ q: e[0], f: e[1], cmd: false })).concat(CMD.map((e) => ({ q: e[0], f: e[1], cmd: true })));
    entities.forEach((en, ei) => {
        const split = splitOf(en.q); const { tool, arg } = toolFor(split, en.cmd);
        for (let v = 0; v < 6; v++) {
            const rand = C.rng('agent:' + en.q + ':' + v); const zh = rand() < 0.4;
            const u = qOf(en.q, zh, rand, en.cmd); const call = C.toolCall(tool.name, { [arg]: en.q });
            const list = tools(rand, tool);
            // call_ref
            add('agent', 'call_ref', split, { messages: um(rand() < 0.6 ? SYS_CALL : SYS_WHEN, u), tools: list, completion: call, rejected: C.toolCall(C.pick(rand, C.TRAIN_POOL).name, {}), meta: { tool: tool.name, check: { kind: 'call', name: tool.name, args: { [arg]: en.q } } } });
            // use：用工具結果回答（rejected：抄別筆資料，或答案尾巴多附「不確定」）
            const ans = zh ? zhAns(en.q, en.f) : (en.cmd ? 'According to the reference, ' + lower1(en.f) : 'According to the reference, ' + lower1(en.f));
            const other = C.pick(rand, en.cmd ? CMD.filter((x) => x[0] !== en.q) : ERR.filter((x) => x[0] !== en.q));
            let rej = zh ? '根據資料，' + other[1] : 'According to the reference, ' + lower1(other[1]); if (rand() < 0.4) rej = ans + (zh ? ' 不確定。' : ' Not sure.');
            add('agent', 'use', split, { messages: um(SYS_CALL, u, [{ role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: tool.name, arguments: { [arg]: en.q } } }] }, { role: 'tool', name: tool.name, content: en.f }]), tools: list, completion: ans, rejected: rej, meta: { tool: tool.name, check: { kind: 'no_call' } } });
        }
        // writer：answer／copycode（facts 就是答案）；unsure（facts 與問題無關）
        for (let v = 0; v < 3; v++) {
            const rand = C.rng('writer:' + en.q + ':' + v); const zh = rand() < 0.45; const tail = zh ? '\n\n請用繁體中文回答（不要用簡體字）。' : '\n\nAnswer in English.';
            const q1 = qOf(en.q, zh, rand, en.cmd); const ans = zh ? zhAns(en.q, en.f) : 'According to the reference, ' + lower1(en.f);
            const o = C.pick(rand, en.cmd ? CMD.filter((x) => x[0] !== en.q) : ERR.filter((x) => x[0] !== en.q));
            let rej = zh ? '根據資料，' + o[1] : 'According to the reference, ' + lower1(o[1]); if (rand() < 0.4) rej = ans + (zh ? ' 不確定。' : ' Not sure.');
            const copy = v === 2 && !en.cmd;
            add('writer', copy ? 'copycode' : 'answer', split, { messages: um(WSYS(zh) + (copy ? ' Copy the key terms (codes, names, numbers) from the facts exactly.' : ''), 'FACTS:\n[reference]\n' + en.f + '\n\nQUESTION: ' + q1 + tail), completion: ans, rejected: rej, meta: { check: { kind: 'text' } } });
            if (v === 0) {   // unsure：facts 屬於另一個實體，問題問這個實體
                const wrong = C.pick(rand, ERR.filter((x) => x[0] !== en.q && !en.cmd));
                if (!en.cmd && wrong) add('writer', 'unsure', split, { messages: um(WSYS(zh), 'FACTS:\n[reference]\n' + wrong[1] + '\n\nQUESTION: ' + q1 + tail), completion: zh ? '不確定。' : 'Not sure.', rejected: zh ? zhAns(wrong[0], wrong[1]) : 'According to the reference, ' + lower1(wrong[1]), meta: { check: { kind: 'text' } } });
            }
        }
    });
    // direct／nofit／ask（工具清單＝我們兩個查詢工具＋訓練池干擾）
    for (let i = 0; i < 80; i++) {
        const rand = C.rng('agent:direct:' + i); const zh = rand() < 0.4; const pool = zh ? F.small_zh : F.small_en; const u = C.pick(rand, pool); const ans = F.small_ans[u]; if (!ans) continue;
        add('agent', 'direct', splitOf(u), { messages: um(rand() < 0.5 ? SYS_FREE : SYS_WHEN, u), tools: tools(rand, toolFor(splitOf(u), false).tool), completion: ans.replace(/Redmw+/g, 'floating-assistant'), rejected: C.toolCall(toolFor(splitOf(u), false).tool.name, { query: u }), meta: { check: { kind: 'no_call' } } });
    }
    for (let i = 0; i < 60; i++) {
        const rand = C.rng('agent:nofit:' + i); const zh = rand() < 0.4; const u = C.pick(rand, zh ? F.nofit_zh : F.nofit_en);
        add('agent', 'nofit', splitOf(u), { messages: um(SYS_WHEN, u), tools: tools(rand, toolFor(splitOf(u), false).tool), completion: zh ? NOFIT_ANS_ZH : NOFIT_ANS_EN, rejected: C.toolCall(toolFor(splitOf(u), false).tool.name, { query: u }), meta: { check: { kind: 'no_call' } } });
    }
    for (let i = 0; i < 60; i++) {
        const rand = C.rng('agent:ask:' + i); const [u, a] = ASK[i % ASK.length];
        const sp = splitOf(u + (i % 2)); const tl = toolFor(sp, false).tool;
        add('agent', 'ask', sp, { messages: um(SYS_WHEN, u), tools: tools(rand, tl), completion: a, rejected: C.toolCall(tl.name, { query: 'error' }), meta: { check: { kind: 'no_call' } } });
    }
    const tr = rows.filter((r) => r.split === 'train').length;
    console.error('[gen_agent] 實體 ' + entities.length + '（errno ' + F.errno.length + '／HRESULT ' + F.hres.length + '／命令 ' + F.cmds.length + '），產生 ' + rows.length + ' 筆（train ' + tr + '／heldout ' + (rows.length - tr) + '）；' + JSON.stringify(cnt) + '；tool 結果用事實表原文，非 lookup_error_code 真實回傳格式');
    return rows;
}
module.exports = { generate };
if (require.main === module) (async () => { for (const r of await generate()) process.stdout.write(JSON.stringify(r) + '\n'); })();
