// node renderer/src/uml/uml_edit_core.test.js
const U = require('./uml_core.js'); const D = require('./design_core.js'); const E = require('./uml_edit_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };

const model = U.parseDsl('model: Shop\nactor: User\nclass Cart { +items:List<Item>; +add(item:Item):void }\nclass Item { +id:int; +price:float }\nclass Order { +id:int; +pay(amount:float):bool }\nclass Junk { +x:int }\nCart o-- Item\nusecase 下單: User -> Cart.add(i) -> Order.pay(p)').model;
check('前提：模型沒錯誤', U.validateModel(model).length === 0 && model.usecases.length === 1, U.validateModel(model));

// ---- 成員／步驟文字 ----
check('parseMember 屬性', E.parseMemberText('total:float').kind === 'attr');
check('parseMember 操作', E.parseMemberText('pay(amount:float):bool').kind === 'op');
check('parseMember 空', !!E.parseMemberText('').error);
check('parseStep', E.parseStepText('Order.pay(x,y):bool').args.length === 2);
check('parseStep 壞', E.parseStepText('哈囉') === null);

// ---- 各種編修 ----
let r = E.apply(model, [{ op: 'add_class', name: 'Speech', members: ['speak(text:str):bytes'] }, { op: 'add_step', usecase: '下單', step: 'Speech.speak(msg)' }]);
check('新增類別＋步驟', r.applied.length === 2 && r.rejected.length === 0 && r.model.usecases[0].steps.length === 3, r);
check('原模型不被改動', model.classes.length === 4 && model.usecases[0].steps.length === 2);
check('新步驟接在後面', r.model.usecases[0].steps[2].from === 'Order', r.model.usecases[0].steps[2]);

r = E.apply(model, [{ op: 'remove_class', name: 'Order' }]);
check('刪類別：步驟與關係被程式收拾', r.applied.length === 1 && r.model.usecases[0].steps.every((s) => s.to !== 'Order') && U.validateModel(r.model).length === 0, r);

r = E.apply(model, [{ op: 'rename_class', from: 'Item', to: 'Product' }]);
check('改名：關係、型別、步驟一起改', r.applied.length === 1 && r.model.relations[0].to === 'Product' && r.model.classes.find((c) => c.name === 'Cart').attrs[0].type.args[0].base === 'Product' && U.validateModel(r.model).length === 0, r);
r = E.apply(model, [{ op: 'rename_class', from: 'Item', to: 'cart' }]);
check('改名成壞名稱被擋', r.rejected.length === 1);
r = E.apply(model, [{ op: 'rename_class', from: 'Item', to: 'Order' }]);
check('改名撞名被擋', r.rejected.length === 1);

r = E.apply(model, [{ op: 'add_member', cls: 'Item', member: 'name:str' }, { op: 'remove_member', cls: 'Item', name: 'price' }]);
check('成員加減', r.applied.length === 2 && r.model.classes.find((c) => c.name === 'Item').attrs.map((a) => a.name).join() === 'id,name', r);
r = E.apply(model, [{ op: 'remove_member', cls: 'Order', name: 'pay' }]);
check('刪掉被用到的操作：呼叫步驟由程式補回或被退回，結果合法', r.applied.length + r.rejected.length === 1 && U.validateModel(r.model).length === 0, r);
r = E.apply(model, [{ op: 'remove_member', cls: 'Order', name: 'nope' }]);
check('刪不存在的成員被擋', r.rejected.length === 1);

r = E.apply(model, [{ op: 'add_relation', from: 'Order', to: 'Cart', kind: 'assoc' }, { op: 'remove_relation', from: 'Cart', to: 'Item' }]);
check('關係加減', r.applied.length === 2 && r.model.relations.length === 1 && r.model.relations[0].from === 'Order', r);
r = E.apply(model, [{ op: 'add_relation', from: 'Order', to: 'Nope' }]);
check('關係指向不存在類別被擋', r.rejected.length === 1);
r = E.apply(model, [{ op: 'add_relation', from: 'Order', to: 'Cart', kind: 'inherit' }, { op: 'add_relation', from: 'Cart', to: 'Order', kind: 'inherit' }]);
check('繼承成環：第二條被退回', r.applied.length === 1 && r.rejected.length === 1 && U.validateModel(r.model).length === 0, r);

r = E.apply(model, [{ op: 'add_usecase', name: '退貨', actor: 'User', steps: ['Order.pay(x)', 'Cart.add(y)'] }, { op: 'remove_usecase', name: '下單' }]);
check('使用案例加減', r.applied.length === 2 && r.model.usecases.length === 1 && r.model.usecases[0].name === '退貨', r);
r = E.apply(model, [{ op: 'add_usecase', name: '下單', actor: 'User' }]);
check('同名使用案例被擋', r.rejected.length === 1);
r = E.apply(model, [{ op: 'add_usecase', name: '壞', actor: 'User', steps: ['亂寫'] }]);
check('壞步驟格式被擋', r.rejected.length === 1);
r = E.apply(model, [{ op: 'add_actor', name: 'Admin' }, { op: 'remove_actor', name: 'User' }]);
check('參與者加減（有使用案例的不能刪）', r.applied.length === 1 && r.rejected.length === 1 && r.model.actors.includes('Admin'), r);

r = E.apply(model, [{ op: 'remove_step', usecase: '下單', to: 'Cart', msg: 'add' }]);
check('刪步驟並重接', r.applied.length === 1 && r.model.usecases[0].steps.length === 1 && r.model.usecases[0].steps[0].from === 'User', r);
r = E.apply(model, [{ op: 'add_step', usecase: '下單', at: 0, step: 'Item.nothing()' }]);
check('加步驟時缺的操作由程式補', r.applied.length === 1 && r.model.classes.find((c) => c.name === 'Item').ops.some((o) => o.name === 'nothing'), r);

r = E.apply(model, [{ op: 'explode' }, null, { op: 'add_class' }]);
check('不認得的編修與缺欄位都被擋', r.applied.length === 0 && r.rejected.length === 3, r);
r = E.apply(model, [{ op: 'add_class', name: 'Bad', members: ['pay(:'] }]);
check('壞成員被擋', r.rejected.length === 1);

// ---- diff ----
r = E.apply(model, [{ op: 'add_class', name: 'Speech', members: ['speak(text:str):bytes'] }, { op: 'remove_class', name: 'Junk' }, { op: 'add_step', usecase: '下單', step: 'Speech.speak(m)' }]);
const df = E.diff(model, r.model);
check('diff 看得到新增與刪除', df.some((x) => x === '＋類別 Speech') && df.some((x) => x === '－類別 Junk') && df.some((x) => /使用案例「下單」的呼叫順序變了/.test(x)), df);
check('沒改就沒有 diff', E.diff(model, model).length === 0);

// ---- 候選編修 ----
check('前提：Junk 是孤兒', D.findIssues(model).some((i) => i.kind === 'orphan' && i.region === 'class:Junk'), D.findIssues(model));
let cs = E.candidates(model, { kind: 'orphan', region: 'class:Junk' });
check('孤兒候選：刪、接、不改', cs.map((c) => c.id).join() === 'remove,relate,keep' && cs.find((c) => c.default).id === 'remove', cs);
cs = E.candidates(model, { kind: 'missing_capability', need: '語音合成', cls: 'Speech', op: 'speak(text:str):bytes', usecase: '下單' });
check('缺能力候選：補類別＋成員步驟，或不改', cs[0].ops.length === 2 && cs[0].ops[0].op === 'add_class' && cs[0].ops[1].op === 'add_step' && cs[1].id === 'keep', cs);
cs = E.candidates(model, { kind: 'unneeded_step', usecase: '下單', to: 'Order', msg: 'pay' });
check('不需要的步驟候選', cs[0].ops[0].op === 'remove_step');
cs = E.candidates(model, { kind: 'whatever' });
check('未知問題只有不改', cs.length === 1 && cs[0].id === 'keep');

// ---- 選擇題 ----
const fake = (choice) => async () => JSON.stringify({ choice });
(async () => {
    const orphan = { kind: 'orphan', region: 'class:Junk', msg: 'Junk 沒人用' };
    cs = E.candidates(model, orphan);
    let c = await E.choose(model, orphan, cs, { generate: fake(3) });
    check('模型挑編號 → 不改', c.by === 'model' && c.cand.id === 'keep', c);
    c = await E.choose(model, orphan, cs, { generate: fake(9) });
    check('模型亂挑 → 用程式預設', c.by === 'program' && c.cand.id === 'remove', c);
    c = await E.choose(model, orphan, cs, { generate: async () => { throw new Error('連線失敗'); } });
    check('模型連線失敗 → 用程式預設', c.by === 'program' && c.cand.id === 'remove', c);
    c = await E.choose(model, orphan, cs, {});
    check('沒有模型 → 程式預設', c.by === 'program' && c.cand.id === 'remove');
    let n = 0; c = await E.choose(model, orphan, cs, { generate: async () => (++n === 1 ? '胡言亂語' : JSON.stringify({ choice: 2 })) });
    check('第一次亂答、退回重來後挑對', c.by === 'model' && c.cand.id === 'relate' && c.tries === 2, c);
    const msg = E.chooseMessages(model, orphan, cs)[1].content;
    check('選擇題內容包含編號與問題', /1\. .*Junk/.test(msg) && /Junk 沒人用/.test(msg), msg);

    const res = await E.resolve(model, [orphan, { kind: 'missing_capability', need: '語音合成', cls: 'Speech', op: 'speak(text:str):bytes', usecase: '下單' }], { generate: fake(1) });
    check('resolve：刪孤兒＋補能力', res.applied === 3 && res.rejected === 0 && !res.model.classes.some((x) => x.name === 'Junk') && res.model.classes.some((x) => x.name === 'Speech') && res.diff.length >= 3, res);
    check('resolve 結果合法', U.validateModel(res.model).length === 0, U.validateModel(res.model));
    check('resolve 不改原模型', model.classes.some((x) => x.name === 'Junk'));
    const res2 = await E.resolve(model, [orphan], { generate: fake(3) });
    check('resolve：模型選不改 → 沒有差異', res2.diff.length === 0 && res2.applied === 0);

    console.log('uml_edit_core: ' + ok + ' passed, ' + bad.length + ' failed'); if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})();
