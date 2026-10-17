// node renderer/src/catalog/route_core.test.js
const F = require('./route_core.js'); const E = require('../uml/uml_edit_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };

// ---- 分類 ----
const k = (t) => F.classify(t).kind;
check('寄信是外部動作', k('幫我寄一封信給 bob@example.com 說會議改期') === 'external_action');
check('發 Line 訊息是外部動作', k('傳 line 訊息提醒我媽') === 'external_action');
check('付款是外部動作', k('幫我結帳付款') === 'external_action');
check('發文是外部動作', k('把這段發文到粉專') === 'external_action');
check('翻譯是模型', k('把這段中文翻譯成英文') === 'model');
check('語音合成是模型', k('用英文語音說 Goodnight') === 'model');
check('文字辨識是模型', k('幫我做圖片文字辨識 OCR') === 'model');
check('轉換是程式', k('把 csv 轉換成 json 並排序') === 'program');
check('整個系統是設計', k('做一個會員管理系統，有登入和訂單') === 'design');
check('完全沒命中就寫程式', k('哈哈') === 'program' && F.classify('哈哈').fallback === true);
check('副作用優先於其他', k('把翻譯好的內容寄信給客戶') === 'external_action');
check('歧義會標出來', F.classify('做一個管理系統，計算統計').ambiguous === true, F.classify('做一個管理系統，計算統計'));

// ---- 程式語言（依環境）----
let l = F.pickLanguages('把資料夾裡的檔案批次改名', { environment: 'desktop' });
check('檔案批次 → bash 優先', l[0].id === 'bash', l);
l = F.pickLanguages('統計 csv 每欄平均', { environment: 'web' });
check('統計 csv → Python（網頁版標示 Pyodide）', l[0].id === 'python' && /Pyodide/.test(l[0].label), l);
l = F.pickLanguages('做一個按鈕切換頁面顏色', { environment: 'web' });
check('網頁互動 → JavaScript', l[0].id === 'javascript');
check('三種語言都在候選', l.length === 3 && l.map((x) => x.id).sort().join() === 'bash,javascript,python');
l = F.pickLanguages('算 1+1', { environment: 'desktop' });
check('預設 Python', l[0].id === 'python');

// ---- 寄信：三條路線 ----
let p = F.plan('幫我寄一封信給 bob@example.com', { environment: 'web', browserControl: false });
check('外部動作有 api／browser_control／template 三條', p.routes.map((r) => r.id).join() === 'api,browser_control,template', p.routes);
check('瀏覽器控制沒啟用就標不能用，範本是預設', p.routes[1].available === false && p.routes[2].default === true && /還沒啟用/.test(p.routes[1].reason));
p = F.plan('幫我寄一封信給 bob@example.com', { environment: 'desktop', browserControl: true });
check('有瀏覽器控制就預設用它', p.routes[1].available && p.routes[1].default && !p.routes[2].default);
p = F.plan('幫我寄信', { apiProvided: true });
check('已提供 API 就預設 api', p.routes[0].default === true);
check('寄信計畫含寫範本與送出，送出有副作用', p.steps.some((s) => s.kind === 'draft' && s.draft.to === '') && p.steps.find((s) => s.kind === 'send').sideEffect === true && p.sideEffect === true);
p = F.plan('幫我寄信給 bob@example.com', {});
check('範本抓得到收件者', p.steps.find((s) => s.kind === 'draft').draft.to === 'bob@example.com');

// ---- 其他類型計畫 ----
p = F.plan('把這段中文翻譯成英文', { environment: 'desktop' });
check('模型路線：先搜尋、選模型、驗證、交付', p.kind === 'model' && p.steps.map((s) => s.kind).join() === 'reflect,model,verify,deliver' && !p.sideEffect, p.steps);
p = F.plan('做一個會員管理系統，有登入和訂單', {});
check('設計路線：design→edit→code→run→deliver', p.steps.map((s) => s.kind).join() === 'design,edit,code,run,deliver' && p.steps[0].tool === 'uml_design' && p.steps[1].tool === 'uml_edit');
p = F.plan('把 csv 轉換成 json', { environment: 'web' });
check('程式路線：短需求不拆 UML', p.steps.map((s) => s.kind).join() === 'code,run,deliver' && p.steps[0].language === 'python');
p = F.plan('把一堆 csv 轉換成 json，欄位名稱要正規化，缺值要補上預設，最後輸出成一份報表', {});
check('程式路線：長需求先拆 UML', p.steps[0].kind === 'design');

// ---- 閘門 ----
p = F.plan('幫我寄信給 bob@example.com', { browserControl: true });
let g = F.gate(p, 'manual');
check('手動：先送計畫，每步都問', g.askPlanFirst && g.steps.every((s) => s.confirm) && g.mode === 'manual');
g = F.gate(p, 'auto');
check('自動：不先問計畫，但問使用者的步驟與有副作用的步驟一定問', !g.askPlanFirst && g.steps.find((s) => s.kind === 'send').confirm && g.steps.find((s) => s.kind === 'ask').confirm && !g.steps.find((s) => s.kind === 'draft').confirm, g.steps.map((s) => s.kind + ':' + s.confirm));
check('自動：副作用清單', g.alwaysAsk.length === 1);
check('mayRun：自動模式下沒副作用的才能直接做', F.mayRun({ kind: 'code', sideEffect: false }, 'auto') && !F.mayRun({ kind: 'send', sideEffect: true }, 'auto') && !F.mayRun({ kind: 'code', sideEffect: false }, 'manual') && !F.mayRun({ kind: 'ask' }, 'auto'));
p = F.plan('把 csv 轉換成 json', {}); g = F.gate(p, 'auto');
check('自動模式、無副作用：全部直接做', g.steps.every((s) => !s.confirm));
check('沒指定模式當手動（保守）', F.gate(p).askPlanFirst === true);

// ---- 訊息 ----
p = F.plan('幫我寄信給 bob@example.com', { browserControl: false }); const msg = F.planMessage(p, F.gate(p, 'manual'));
check('計畫訊息：路線、步驟、副作用提醒、要不要', /A\. /.test(msg) && /瀏覽器控制還沒啟用/.test(msg) && /有副作用/.test(msg) && /要照這個計畫做嗎/.test(msg), msg);
check('自動模式訊息說明副作用仍會問', /自動模式.*副作用.*先問/.test(F.planMessage(p, F.gate(p, 'auto'))));

// ---- 接 UML 編修 ----
const iss = F.umlIssue('把這段中文翻譯成英文', '下單');
check('缺能力 → UML 問題', iss.kind === 'missing_capability' && iss.cls === 'Translator' && /translate/.test(iss.op) && iss.usecase === '下單', iss);
check('沒對到就用泛用名稱', F.umlIssue('做奇怪的事').cls === 'Capability');
const U = require('../uml/uml_core.js');
const model = U.parseDsl('model: S\nactor: User\nclass Cart { +add(x:int):void }\nusecase 下單: User -> Cart.add(i)').model;
const cands = E.candidates(model, F.umlIssue('用英文語音朗讀', '下單'));
const r = E.apply(model, cands[0].ops);
check('反思結論 → 候選編修 → 套用 → 合法', r.applied.length === 2 && r.model.classes.some((c) => c.name === 'Speech') && r.model.usecases[0].steps.length === 2 && r.errors.length === 0, r);

// ---- 用模型解歧義 ----
(async () => {
    const amb = '做一個管理系統，計算統計';
    let c = await F.classifyWithModel(amb, { generate: async () => '{"choice":2}' });
    check('歧義：模型挑編號', c.by === 'model' || c.by === 'program');
    c = await F.classifyWithModel('把這段翻譯成英文', { generate: async () => { throw new Error('x'); } });
    check('不歧義就不問模型', c.by === 'program' && c.kind === 'model');
    c = await F.classifyWithModel(amb, { generate: async () => { throw new Error('連線失敗'); } });
    check('模型失敗就用程式第一名', c.by === 'program' && !!c.kind);
    console.log('route_core: ' + ok + ' passed, ' + bad.length + ' failed'); if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})();
