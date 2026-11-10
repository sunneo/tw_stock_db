// gen/gen_uml_design.js — domain "uml_design"
//
// 重用 production 的核心模組（renderer/src/uml/uml_core.js、design_core.js）的「真正」函式來組字：
//   - U.scenarioToModel()：情境 → UML 的一次一個封閉小問題管線（actors → classes → members → relations → sequence），
//     每個階段的 messages 都是 uml_core.js 自己的 stageSpec.* 函式組出來的，不是這支產生器手刻的格式。
//   - D.resolveAmbiguous()：架構／framework 抉擇平手時，呼叫 recipe_core.js 的 chooseTool() 組出選擇題。
// 完全依照 schema.md：答案必須是程式已經驗證過的正確答案，不是另外生成的猜測。
//
// 已知正確答案的來源：renderer/src/uml/uml_core.test.js 裡用來驅動真正 pipeline 的假模型 `script`
// （那個測試本身就斷言：用這份答案表跑完整條 pipeline，res.ok === true 且最終模型通過 U.validateModel()
// 驗證 0 個錯誤——所以這份答案表是「程式驗證過的正解」，不是我們發明的）；
// 以及 renderer/src/uml/design_core.test.js 的平手選擇題 fixture（斷言模型答案把平手正確解成 'cli'）。
//
// 做法：把 uml_core.test.js 的 `script` 函式原封不動抄進來（它本來就是資料，不是程式邏輯），
// 用它當 opts.generate 真的跑一次 U.scenarioToModel()（thinkStack:false，拿到的是 stageSpec 本身
// 的格式，不含思考堆疊標頭——標頭疊加的版本留給 gen_think_stack.js 的 "uml_classes_with_stack_header"
// 示範），邊跑邊攔截每次真正送給模型的 messages 與對應完成；跑完後用 U.validateModel() 再次確認最終
// 模型合法，才把攔截到的題目收進訓練資料（不合法就整批丟掉並在 stderr 說明）。

const path = require('path');
const U = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'uml_core.js'));
const D = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'design_core.js'));

const SRC_UML_TEST = 'renderer/src/uml/uml_core.test.js';
const SRC_DESIGN_TEST = 'renderer/src/uml/design_core.test.js';

// ---- 情境＋已知正解表：逐字抄自 uml_core.test.js 第 90~99 行的 `script`（測試資料，不是邏輯）----
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
// 系統提示詞裡的固定字樣跟 uml_core.js 的 stageSpec 一一對應，用它判斷這次呼叫是哪個階段
const STAGE_PATTERNS = [
    [/參與者（人或外部系統）/, 'uml_actors'],
    [/找出系統需要的類別/, 'uml_classes'],
    [/列出屬性與操作/, 'uml_members'],
    [/跟其他類別的關係/, 'uml_relations'],
    [/呼叫順序/, 'uml_sequence'],
];

async function generate() {
    const rows = [];
    let skipped = 0;
    const skipReasons = [];

    // ---- uml_actors / uml_classes / uml_members / uml_relations / uml_sequence ----
    const captured = [];
    const wrapped = async (a) => {
        const sys = a.messages[0].content;
        const completion = fixtureScript(a.messages);
        const hit = STAGE_PATTERNS.find(([re]) => re.test(sys));
        if (hit) captured.push({ messages: a.messages, completion, stage: hit[1] });
        return completion;
    };
    const res = await U.scenarioToModel(UML_SCENARIO, { program: false, generate: wrapped, thinkStack: false });
    const finalErrs = res.ok ? U.validateModel(res.model) : ['pipeline 沒有成功'];
    if (!res.ok || finalErrs.length !== 0) {
        skipped += captured.length;
        skipReasons.push('scenarioToModel fixture 沒有做出合法模型（ok=' + res.ok + '，errors=' + JSON.stringify(finalErrs).slice(0, 200) + '），' + captured.length + ' 筆候選資料整批丟棄');
    } else {
        let i = 0;
        for (const c of captured) {
            i++;
            // label：這題在問哪個類別／使用案例——直接從真正的系統提示詞裡的「…」讀回來，不是另外記的
            const label = (/「([^」]+)」/.exec(c.messages[0].content) || [])[1] || '';
            rows.push({
                id: 'uml_design:uml_core.test.js:' + c.stage + ':' + i,
                domain: 'uml_design',
                stage: c.stage,
                messages: c.messages,
                completion: c.completion,
                verified_by: 'program_ground_truth',
                split: 'train',
                source_file: SRC_UML_TEST,
                meta: { scenario: UML_SCENARIO, label, pipeline: 'scenarioToModel', thinkStack: false },
            });
        }
    }

    // ---- uml_arch_choice：design_core.test.js 的平手選擇題 fixture（第 24, 29~30 行）----
    // 情境「做一個 api，也要一個命令列」讓 interface 關注點的 rest／cli 兩個選項同分（平手），
    // D.resolveAmbiguous() 用 recipe_core.js 真正的 chooseTool() 組出選單式提示詞；
    // 測試斷言模型答案 {"choice": 2} 會把平手解成 'cli'（這份情境確實兩者都要，是合理且程式驗證過的答案）。
    const ARCH_SCENARIO = '做一個 api，也要一個命令列';
    const rec = D.recommend(ARCH_SCENARIO, 'python');
    const archSeen = [];
    const archCompletion = '{"choice": 2}';
    await D.resolveAmbiguous(rec, ARCH_SCENARIO, async (a) => { archSeen.push(a.messages); return archCompletion; });
    const archOk = rec.choices.find((x) => x.concern === 'interface' && x.option === 'cli' && x.by === 'model');
    if (archSeen.length && archOk) {
        rows.push({
            id: 'uml_design:design_core.test.js:uml_arch_choice:1',
            domain: 'uml_design',
            stage: 'uml_arch_choice',
            messages: archSeen[0],
            completion: archCompletion,
            verified_by: 'program_ground_truth',
            split: 'train',
            source_file: SRC_DESIGN_TEST,
            meta: { scenario: ARCH_SCENARIO, concern: 'interface', resolved_option: 'cli' },
        });
    } else {
        skipped++;
        skipReasons.push('uml_arch_choice fixture 沒有依預期解出 cli，丟棄這筆');
    }

    const byStage = {};
    for (const r of rows) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
    process.stderr.write('[gen_uml_design] 產生 ' + rows.length + ' 筆，跳過 ' + skipped + ' 筆，各 stage 筆數：' + JSON.stringify(byStage) + (skipReasons.length ? '；原因：' + JSON.stringify(skipReasons) : '') + '\n');
    process.stderr.write('[gen_uml_design] 誠實說明：目前只用了 uml_core.test.js 一個情境與 design_core.test.js 一個平手 fixture；' +
        'design_core.test.js 裡 reworkModel／addMembers／reworkRegion 的再問一次（帶著「目前內容」與「要修正的問題」）還沒有另外收，資料量不夠就是不夠，沒有為了湊數虛構。\n');
    return rows;
}

module.exports = { generate };

if (require.main === module) {
    (async () => {
        for (const row of await generate()) process.stdout.write(JSON.stringify(row) + '\n');
    })();
}
