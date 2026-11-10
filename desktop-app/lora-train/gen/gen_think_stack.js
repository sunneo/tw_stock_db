// gen/gen_think_stack.js — domain "think_stack"
//
// think_stack.js（renderer/src/recipe/think_stack.js）是跨領域共用的小模型「焦點標頭」機制：
//   push/pop/decide/header/wrap 把目標、路徑、現在這題、上層已定的決定濃縮成一段標頭，疊在每次問模型的
//   提示最前面；2026-11-05 加的 planChecks（往下鑽之前先列檢查）、reviewReturn（回來後逐項核對）、
//   selfValidate（離開前自問有沒有回答這一題）則是堆疊「自己」的封閉問題——不管上層是 UML 設計、
//   recipe 路由還是寫程式，這三個都用同一套固定格式。
//
// 這支產生器只收堆疊自己的這三種封閉問題，完全重用真正的函式：
//   - D.reworkRegion() 走到套件層會呼叫 think_stack.js 真正的 planChecks()/reviewReturn()/selfValidate()，
//     而這兩個函式內部又是呼叫真正的 wrap()（不是這支產生器自己組字）。
//   - messages／完成的配對逐字沿用 design_core.test.js 的「思考堆疊：往下一層前列檢查、回來核對、離開前
//     自問」那段測試的 fixture（同一個 `gen` 假模型），該測試本身斷言 planCalls===1、
//     reviewCalls>=套件類別數、selfCalls>=套件類別數，是程式驗證過的正解。
//   - 另外附 1 筆 "uml_classes_with_stack_header"：拿 gen_uml_design.js 用的同一個情境／已知正解，
//     這次不關閉 thinkStack，示範 jsonStep 真的會把 think_stack.js 的標頭疊在 uml_design 的題目前面
//     （一樣是呼叫真正的 scenarioToModel()／wrap()，不是手刻標頭文字）。

const path = require('path');
const U = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'uml_core.js'));
const D = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'design_core.js'));

const SRC_DESIGN_TEST = 'renderer/src/uml/design_core.test.js';
const SRC_UML_TEST = 'renderer/src/uml/uml_core.test.js';

async function generate() {
    const rows = [];
    let skipped = 0;
    const skipReasons = [];

    // ---- plan_check / review_return / self_validate ----
    // 設置逐字照抄 design_core.test.js 第 166~187 行左右那個區塊：挑 FRAGMENTS 裡類別最多的片段、
    // 找一個至少兩個類別的套件，呼叫真正的 D.reworkRegion('package:'+pk.name) 重做整個套件。
    {
        const m = D.FRAGMENTS.map((f) => U.parseDsl(f.dsl).model).sort((a, b) => b.classes.length - a.classes.length)[0];
        const pkgs = D.packagesOf(m);
        const pk = pkgs.find((p) => p.classes.length >= 2) || pkgs[0];
        if (!pk) {
            skipped++; skipReasons.push('FRAGMENTS 片段組不出一個至少兩個類別的套件，packagesOf 這段 fixture 跳過');
        } else {
            let planCalls = 0, reviewCalls = 0, selfCalls = 0; const captured = [];
            // 已知正解表：逐字照抄 design_core.test.js 的 `gen`（測試資料，不是邏輯）
            const gen = async (req) => {
                const p = req.messages[req.messages.length - 1].content;
                let kind = null, completion;
                if (p.includes('往下一層做')) { planCalls++; kind = 'plan_check'; completion = JSON.stringify({ checks: [{ check: '每個類別名稱不能重複', standard: '全部類別名稱互不相同' }] }); }
                else if (p.includes('要檢查的項目')) { reviewCalls++; kind = 'review_return'; completion = JSON.stringify({ results: [{ i: 1, ok: reviewCalls !== 1, fix: reviewCalls === 1 ? '第一個類別名稱怪怪的' : '' }] }); }
                else if (p.includes('結果有回答這一題嗎')) { selfCalls++; kind = 'self_validate'; completion = JSON.stringify({ ok: true, missing: '' }); }
                else completion = JSON.stringify({ attrs: [{ name: 'id', type: 'int' }], ops: [{ name: 'run', params: [], returns: 'void' }], relations: [] });
                if (kind) captured.push({ messages: req.messages, completion, kind });
                return completion;
            };
            const r = await D.reworkRegion(JSON.parse(JSON.stringify(m)), '做一個測試系統', 'package:' + pk.name, { generate: gen });
            const shapeOk = r.ok && planCalls === 1 && reviewCalls >= pk.classes.length && selfCalls >= pk.classes.length;
            if (!shapeOk) {
                skipped += captured.length;
                skipReasons.push('reworkRegion 套件 fixture 沒有符合 design_core.test.js 斷言的形狀（r.ok=' + r.ok + ' planCalls=' + planCalls + ' reviewCalls=' + reviewCalls + ' selfCalls=' + selfCalls + ' pkClasses=' + pk.classes.length + '），整批（' + captured.length + ' 筆）丟棄');
            } else {
                let i = 0;
                for (const c of captured) {
                    i++;
                    rows.push({
                        id: 'think_stack:design_core.test.js:' + c.kind + ':' + i,
                        domain: 'think_stack',
                        stage: c.kind,
                        messages: c.messages,
                        completion: c.completion,
                        verified_by: 'program_ground_truth',
                        split: 'train',
                        source_file: SRC_DESIGN_TEST,
                        meta: { scenario: '做一個測試系統', region: 'package:' + pk.name, package_classes: pk.classes },
                    });
                }
            }
        }
    }

    // ---- uml_classes_with_stack_header：同一題 uml_design，這次不關 thinkStack ----
    // 跟 gen_uml_design.js 用的是同一個情境與同一份已知正解表（都衍生自 uml_core.test.js 的 `script`
    // fixture），差別只在這裡故意不傳 thinkStack:false，讓 jsonStep 走真正會疊 think_stack 標頭的那條路。
    {
        const UML_SCENARIO = '顧客可以瀏覽書籍、加入購物車並結帳付款，管理員可以上架書籍。';
        function fixtureScript(messages) {
            const sys = messages[0].content;
            if (/參與者（人或外部系統）/.test(sys)) return '{"actors":["Customer","Admin"],"usecases":[{"name":"Checkout","actor":"Customer","summary":"結帳"},{"name":"AddBook","actor":"Admin","summary":"上架"}]}';
            if (/找出系統需要的類別/.test(sys)) return '{"classes":[{"name":"Book","kind":"class","label":"書"},{"name":"Cart","kind":"class","label":"購物車"},{"name":"Payable","kind":"interface","label":"可付款"},{"name":"Status","kind":"enum","label":"狀態"}]}';
            if (/列出屬性與操作/.test(sys)) {
                if (/「Book」/.test(sys)) return '{"attrs":[{"name":"title","type":"str"},{"name":"price","type":"decimal"}],"ops":[]}';
                if (/「Cart」/.test(sys)) return '{"attrs":[{"name":"items","type":"List<Book>"}],"ops":[{"name":"add","params":[{"name":"book","type":"Book"}],"returns":"void"},{"name":"checkout","params":[],"returns":"bool"}]}';
                if (/「Payable」/.test(sys)) return '{"attrs":[],"ops":[{"name":"pay","params":[{"name":"amount","type":"float"}],"returns":"bool"}]}';
                return '{"values":["NEW","PAID"]}';
            }
            if (/跟其他類別的關係/.test(sys)) {
                if (/「Cart」/.test(sys)) return '{"relations":[{"to":"Book","kind":"aggregate"},{"to":"Payable","kind":"implement"}]}';
                return '{"relations":[]}';
            }
            if (/呼叫順序/.test(sys)) {
                if (/「Checkout」/.test(sys)) return '{"steps":[{"to":"Cart","op":"add"},{"to":"Cart","op":"checkout"}]}';
                return '{"steps":[{"to":"Book","op":"publish"}]}';
            }
            return '{}';
        }
        const captured2 = [];
        const wrapped2 = async (a) => {
            const sys = a.messages[0].content;
            const completion = fixtureScript(a.messages);
            if (/找出系統需要的類別/.test(sys)) captured2.push({ messages: a.messages, completion });
            return completion;
        };
        const res2 = await U.scenarioToModel(UML_SCENARIO, { program: false, generate: wrapped2 }); // thinkStack 預設開啟（不傳 thinkStack:false）
        const finalErrs2 = res2.ok ? U.validateModel(res2.model) : ['pipeline 沒有成功'];
        const userMsg2 = captured2[0] && captured2[0].messages[captured2[0].messages.length - 1];
        const headerOk = res2.ok && finalErrs2.length === 0 && captured2.length === 1 && userMsg2 && /^【目標】/.test(userMsg2.content) && userMsg2.content.includes('【路徑】') && userMsg2.content.includes('【現在這題】');
        if (headerOk) {
            rows.push({
                id: 'think_stack:uml_core.test.js:uml_classes_with_stack_header:1',
                domain: 'think_stack',
                stage: 'uml_classes_with_stack_header',
                messages: captured2[0].messages,
                completion: captured2[0].completion,
                verified_by: 'program_ground_truth',
                split: 'train',
                source_file: SRC_UML_TEST,
                meta: { scenario: UML_SCENARIO, note: '與 gen_uml_design.js 的 uml_classes 同一題；這裡示範 think_stack 標頭疊加後 jsonStep 真正送出的版本（thinkStack 未關閉）', pipeline: 'scenarioToModel' },
            });
        } else {
            skipped++;
            skipReasons.push('uml_classes_with_stack_header 示範沒有產生預期中帶標頭的訊息，丟棄（res2.ok=' + res2.ok + ' captured=' + captured2.length + '）');
        }
    }

    const byStage = {};
    for (const r of rows) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
    process.stderr.write('[gen_think_stack] 產生 ' + rows.length + ' 筆，跳過 ' + skipped + ' 筆，各 stage 筆數：' + JSON.stringify(byStage) + (skipReasons.length ? '；原因：' + JSON.stringify(skipReasons) : '') + '\n');
    process.stderr.write('[gen_think_stack] 誠實說明：只收了 think_stack.js 自己的三種封閉問題（plan_check／review_return／self_validate），都來自同一個 design_core.test.js 套件 rework fixture，資料量不大；' +
        'think_stack.test.js 裡 planChecks／reviewReturn／selfValidate 的單元測試是直接 mock 物件（略過 jsonStep 的字串↔物件轉換那一層），格式跟 production 的「原始字串」不是同一層，這次沒有另外收，避免為了湊數而生出不是真的 wire format 的完成字串。\n');
    return rows;
}

module.exports = { generate };

if (require.main === module) {
    (async () => {
        for (const row of await generate()) process.stdout.write(JSON.stringify(row) + '\n');
    })();
}
