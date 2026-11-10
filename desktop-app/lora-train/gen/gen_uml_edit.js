'use strict';
/* uml_design 編修選擇題（對應對照設計 uml/edit_real・edit_shuf）：uml_edit_core.js 的 chooseMessages（字母選單 {"choice":"A"}，prefill '{"choice":'）。
 * 問題來源：我們建帶缺陷的 UML 模型（孤兒類別／空類別／太短的使用案例），交給真正的 design_core.findIssues 找出問題，
 * 再用真正的 uml_edit_core.candidates 產生候選與「程式預設」。missing_capability／unneeded_step 兩種問題在 production 來自模型反思，
 * 這裡用手造的 issue（欄位照 candidates 的註解）。標籤＝程式預設（candidates 標 default 的那個，這是程式的預設策略，不是人工驗證的最佳解）。
 * edit_real＝保留程式原本順序；edit_shuf＝候選打亂（兩者分開報，因為 real 的答案偏 A）。
 * 留出：最後 2 組詞彙（類別名稱）整組 heldout。 */
const path = require('path');
const U = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'uml_core.js'));
const D = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'design_core.js'));
const E = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'uml_edit_core.js'));
const C = require('./w2c_common.js');

const SRC = 'renderer/src/uml/uml_edit_core.js';
const V = [ // [model, 正常類別 a,b,c, 孤兒, 空類別, 使用案例 u1,u2, 能力 need/cls/op]
    ['Shop', 'Cart', 'Item', 'Order', 'Junk', 'Empty', '下單', '查詢', ['語音合成', 'Speech', 'speak(text:str):bytes']],
    ['Library', 'Reader', 'Book', 'Loan', 'Stamp', 'Shelf', '借書', '還書', ['簡訊通知', 'Notifier', 'send(msg:str):bool']],
    ['Clinic', 'Patient', 'Doctor', 'Visit', 'Memo', 'Room', '掛號', '看診', ['列印單據', 'Printer', 'print(doc:str):void']],
    ['School', 'Student', 'Course', 'Grade', 'Badge', 'Hall', '選課', '查成績', ['寄出通知信', 'Mailer', 'mail(to:str):bool']],
    ['Bank', 'Account', 'Card', 'Transfer', 'Note', 'Vault', '轉帳', '查餘額', ['詐欺檢查', 'Fraud', 'check(tx:str):bool']],
    ['Hotel', 'Guest', 'Room', 'Booking', 'Key', 'Lobby', '訂房', '退房', ['發票開立', 'Invoice', 'issue(b:str):str']],
    ['Garage', 'Owner', 'Car', 'Repair', 'Tag', 'Bay', '送修', '取車', ['拍照存證', 'Camera', 'shoot():bytes']],
    ['Forum', 'Member', 'Post', 'Thread', 'Flag', 'Board', '發文', '回文', ['敏感字過濾', 'Filter', 'clean(t:str):str']],
    ['Cinema', 'Viewer', 'Movie', 'Ticket', 'Poster', 'Hall2', '購票', '退票', ['掃碼驗票', 'Scanner', 'scan(code:str):bool']],
    ['Farm', 'Worker', 'Crop', 'Harvest', 'Scarecrow', 'Barn', '採收', '盤點', ['天氣預報', 'Weather', 'forecast():str']],
];
const HELD = new Set(['Cinema', 'Farm']);
const ATTR = [['id:int', 'name:str'], ['code:str', 'size:int'], ['no:int', 'note:str']];
const LETTER = (i) => String.fromCharCode(65 + i);

function build(v, av) {
    const [m, a, b, c, junk, empty, u1, u2] = v; const [x, y] = ATTR[av];
    return U.parseDsl('model: ' + m + '\nactor: User\nclass ' + a + ' { +' + x + '; +add(i:' + b + '):void }\nclass ' + b + ' { +' + y + '; +price:float }\nclass ' + c + ' { +id:int; +pay(p:float):bool }\nclass ' + junk + ' { +x:int }\nclass ' + empty + ' { }\n' + a + ' o-- ' + b + '\nusecase ' + u1 + ': User -> ' + a + '.add(i) -> ' + c + '.pay(p)\nusecase ' + u2 + ': User -> ' + a + '.add(i)').model;
}

async function generate() {
    const rows = []; let skipped = 0; let seq = 0;
    for (const v of V) for (let av = 0; av < ATTR.length; av++) {
        const split = HELD.has(v[0]) ? 'heldout' : 'train';
        let model; try { model = build(v, av); } catch (e) { skipped++; continue; }
        if (!model || !model.classes || model.classes.length < 4) { skipped++; continue; }
        const issues = D.findIssues(model).slice();
        issues.push({ kind: 'missing_capability', need: v[8][0], cls: v[8][1], op: v[8][2], usecase: v[6] });
        issues.push({ kind: 'unneeded_step', usecase: v[6], to: v[3], msg: 'pay' });
        for (const issue of issues) {
            const cands = E.candidates(model, issue); if (cands.length < 2) { skipped++; continue; }
            for (const mode of ['real', 'shuf']) {
                const rand = C.rng('umledit:' + v[0] + av + issue.kind + (issue.region || '') + mode);
                const order = mode === 'shuf' ? C.shuffle(rand, cands) : cands;
                const di = order.findIndex((x) => x.default); if (di < 0) { skipped++; continue; }
                const messages = E.chooseMessages(model, issue, order);
                const completion = ' "' + LETTER(di) + '"}';
                if (E.pickIndex(JSON.parse('{"choice":' + completion), order.length) !== di) { skipped++; continue; }
                seq++;
                rows.push({ id: 'uml_edit:' + seq, domain: 'uml_design', stage: 'uml_edit_' + mode, task: 'uml', kind: 'edit_' + mode, messages, prefill: '{"choice":', completion, rejected: ' "' + LETTER((di + 1) % order.length) + '"}', verified_by: 'program_ground_truth', split, source_file: SRC, group: 'uml/edit_' + mode, seen: split === 'heldout' ? 'unseen' : 'seen', meta: { group: 'uml/edit_' + mode, issue_kind: issue.kind, model: v[0], default_letter: LETTER(di), label_is: 'program default (uml_edit_core.candidates default), not human-verified' } });
            }
        }
    }
    const tr = rows.filter((r) => r.split === 'train').length;
    console.error('[gen_uml_edit] 產生 ' + rows.length + ' 筆（train ' + tr + '／heldout ' + (rows.length - tr) + '），跳過 ' + skipped + '；標籤＝程式預設策略；對照設計的 ask_verb/ask_entity（design_reader.designAsk）在我們這邊沒有對應程式，沒收');
    return rows;
}
module.exports = { generate };
if (require.main === module) (async () => { for (const r of await generate()) process.stdout.write(JSON.stringify(r) + '\n'); })();
