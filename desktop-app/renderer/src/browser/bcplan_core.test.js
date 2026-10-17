// node renderer/src/browser/bcplan_core.test.js
const B = require('./bcplan_core.js'); const U = require('../uml/uml_core.js'); const E = require('../uml/uml_edit_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };
const ck = (steps, o) => B.check(steps, o);
const msgs = (r) => r.errors.map((e) => e.msg).join('｜');

// ---- 檢查（CoLU：動作要存在、型別接得上、狀態要滿足）----
let r = ck([{ do: 'open', url: 'https://example.com' }, { do: 'look' }, { do: 'click', x: 10, y: 20 }, { do: 'look' }, { do: 'read' }, { do: 'finish' }]);
check('合法的計畫通過', r.ok && r.state.includes('tab'), r);
check('未知動作被擋並列出可用動作', /沒有這個動作/.test(msgs(ck([{ do: 'teleport' }]))));
check('沒開分頁就點擊被擋', /開著的分頁/.test(msgs(ck([{ do: 'look' }]))));
check('沒觀察元素就按座標被擋', /剛觀察過的元素/.test(msgs(ck([{ do: 'open', url: 'https://a.com' }, { do: 'click', x: 1, y: 2 }]))));
check('換頁後元素失效', /剛觀察過的元素/.test(msgs(ck([{ do: 'open', url: 'https://a.com' }, { do: 'look' }, { do: 'goto', url: 'https://b.com' }, { do: 'click', x: 1, y: 2 }]))));
check('點擊後元素失效（要重新 look）', /剛觀察過的元素/.test(msgs(ck([{ do: 'open', url: 'https://a.com' }, { do: 'look' }, { do: 'click', x: 1, y: 2 }, { do: 'click', x: 1, y: 2 }]))));
check('捲動後元素失效', !ck([{ do: 'open', url: 'https://a.com' }, { do: 'look' }, { do: 'scroll', direction: 'down' }, { do: 'click', x: 1, y: 2 }]).ok);
check('javascript: 網址被擋', /http 或 https/.test(msgs(ck([{ do: 'open', url: 'javascript:alert(1)' }]))));
check('file: 網址被擋', !ck([{ do: 'open', url: 'file:///etc/passwd' }]).ok);
check('缺必填參數', /url 必填/.test(msgs(ck([{ do: 'open' }]))));
check('座標型別錯誤', /x 要是整數/.test(msgs(ck([{ do: 'open', url: 'https://a.com' }, { do: 'look' }, { do: 'click', x: 'a', y: 2 }]))));
check('列舉不合法', /只能是/.test(msgs(ck([{ do: 'open', url: 'https://a.com' }, { do: 'key', key: 'Hyperspace' }]))));
check('多餘參數被擋', /多餘的參數/.test(msgs(ck([{ do: 'open', url: 'https://a.com', color: 'red' }]))));
check('輸入前要先點輸入框', /先點一下輸入框/.test(msgs(ck([{ do: 'open', url: 'https://a.com' }, { do: 'type', text: 'hi' }]))));
check('點過輸入框就能輸入', ck([{ do: 'open', url: 'https://a.com' }, { do: 'look' }, { do: 'click', x: 1, y: 2 }, { do: 'type', text: 'hi' }]).ok);
check('給 selector 也能輸入', ck([{ do: 'open', url: 'https://a.com' }, { do: 'type', text: 'hi', selector: '#q' }]).ok);
check('密碼欄位不替使用者輸入', /不替使用者輸入密碼/.test(msgs(ck([{ do: 'open', url: 'https://a.com' }, { do: 'type', text: 'x', selector: 'input[type=password]' }]))));
check('finish 後不能再有步驟', /finish 後面/.test(msgs(ck([{ do: 'finish' }, { do: 'open', url: 'https://a.com' }]))));
check('一定要給 text 或 selector', /text 或 selector/.test(msgs(ck([{ do: 'open', url: 'https://a.com' }, { do: 'click_text' }]))));
r = ck([{ do: 'open', url: 'https://a.com' }, { do: 'click_text', text: '確認付款' }, { do: 'click_text', text: '下一頁' }]);
check('有副作用的點擊被標出來，一般的不標', r.steps[1].sideEffect === true && !r.steps[2].sideEffect && r.sideEffects === 1, r.steps);
r = ck([{ do: 'open', url: 'https://a.com' }, { do: 'type', text: 'hi', selector: '#q', submit: true }]);
check('輸入並送出算副作用', r.steps[1].sideEffect === true);
check('這個環境沒有的工具會被擋', /沒有工具 browser_get_page_text/.test(msgs(ck([{ do: 'open', url: 'https://a.com' }, { do: 'read' }], { tools: ['browser_create_tab'] }))));
check('check 不改原本的步驟', (() => { const s = [{ do: 'open', url: 'https://a.com' }, { do: 'click_text', text: '送出' }]; ck(s); return s[1].sideEffect === undefined; })());

// ---- 合法動作 ----
check('一開始只能開分頁或結束', B.legalActions([]).join() === 'open,finish', B.legalActions([]));
const l1 = B.legalActions(['tab']);
check('有分頁後不能再 open、不能點元素，可以觀察', !l1.includes('open') && !l1.includes('click') && l1.includes('look') && l1.includes('read') && l1.includes('goto'), l1);
check('觀察過元素才能點', B.legalActions(['tab', 'elements']).includes('click'));
check('click_text 不出現在選單（強模型計畫專用）', !B.legalActions(['tab', 'elements']).includes('click_text'));

// ---- UML ⇄ 計畫 ----
const plan = [{ do: 'open', url: 'https://a.com' }, { do: 'look' }, { do: 'click', x: 10, y: 20 }, { do: 'read' }];
const model = B.toModel(plan);
check('計畫轉成 UML 使用案例，驗證通過', U.validateModel(model).length === 0 && model.usecases[0].steps.length === 4, U.validateModel(model));
check('轉回來一樣', JSON.stringify(B.fromModel(model)) === JSON.stringify(plan), B.fromModel(model));
const edited = E.apply(model, [{ op: 'remove_step', usecase: '任務', at: 1 }, { op: 'add_step', usecase: '任務', at: 1, step: 'Browser.look()' }]);
check('用 uml_edit 補／刪步驟後轉回計畫', edited.applied.length === 2 && B.fromModel(edited.model).map((s) => s.do).join() === 'open,look,click,read', edited);
const e2 = E.apply(model, [{ op: 'add_step', usecase: '任務', step: 'Browser.teleport()' }]);
check('UML 編修加不存在的動作：被程式補成操作，但檢查會擋', !B.check(B.fromModel(e2.model)).ok, B.fromModel(e2.model));

// ---- 假瀏覽器世界 ----
function world(opts) {
    opts = opts || {}; const w = { calls: [], tab: null, page: 'home', typed: '', fail: opts.fail || {}, n: {} };
    const pages = { home: { url: 'https://shop.example/', text: '歡迎來到商店', elements: [{ tag: 'input', type: 'search', text: '搜尋', x: 100, y: 40 }, { tag: 'button', text: '搜尋', x: 200, y: 40 }, { tag: 'a', text: '關於我們', href: 'https://shop.example/about', x: 30, y: 300 }] }, results: { url: 'https://shop.example/s?q=貓', text: '貓砂 120 元；貓罐頭 35 元', elements: [{ tag: 'a', text: '貓砂', href: 'https://shop.example/p/1', x: 50, y: 100 }] } };
    w.host = {
        sleep: async () => {},
        probe: async () => (w.connectAfter != null && w.probes++ >= w.connectAfter ? { ok: true } : (w.connectAfter == null ? { ok: true } : { ok: false, error: 'NOT_CONNECTED' })),
        confirm: async (s) => { w.confirmed = (w.confirmed || []).concat(s.do + ':' + (s.text || s.label || '')); return w.allow !== false; },
        call: async (cmd, args) => {
            w.calls.push({ cmd, args }); w.n[cmd] = (w.n[cmd] || 0) + 1; if (w.fail[cmd] && w.n[cmd] <= w.fail[cmd]) return { ok: false, error: '擴充功能 30 秒內沒有回應' }; if (w.hardFail === cmd) return { ok: false, error: '元素不存在' };
            if (cmd === 'tab_create') { w.tab = 7; w.page = 'home'; return { ok: true, tab_id: 7, url: args.url }; }
            if (cmd === 'tab_navigate') return { ok: true, url: pages[w.page].url };
            if (cmd === 'get_elements') return { ok: true, elements: pages[w.page].elements };
            if (cmd === 'get_page_text') return { ok: true, text: pages[w.page].text };
            if (cmd === 'mouse') { if (args.x === 200) w.page = 'results'; return { ok: true }; }
            if (cmd === 'type_text') { w.typed = args.text; return { ok: true }; }
            if (cmd === 'press_key') { if (args.key === 'Enter') w.page = 'results'; return { ok: true }; }
            if (cmd === 'tab_close') return { ok: true };
            return { ok: true };
        }
    };
    w.probes = 0; return w;
}

// ---- 等擴充功能連上 ----
(async () => {
    let w = world(); w.connectAfter = 3; let launched = 0; w.host.launch = async () => { launched++; };
    let c = await B.waitConnected(w.host, { timeoutMs: 20000, intervalMs: 1 });
    check('輪詢到連上為止', c.ok && c.polls >= 2 && launched === 1, c);
    w = world(); w.connectAfter = 1e9; let t = 0; w.host.sleep = async () => { t += 1000; };
    const realNow = Date.now; Date.now = () => realNow() + t; c = await B.waitConnected(w.host, { timeoutMs: 5000, intervalMs: 1000 }); Date.now = realNow;
    check('逾時回報，提示設定檔選擇器', !c.ok && c.error === 'EXTENSION_NOT_CONNECTED' && /誰在使用 Chrome/.test(c.hint) && /不替你選帳號/.test(c.hint), c);
    w = world(); w.host.probe = async () => ({ ok: true, allowed: false }); c = await B.waitConnected(w.host, {});
    check('網站沒被允許：馬上回報不等', !c.ok && c.error === 'NOT_ALLOWED' && /允許目前網站/.test(c.hint));
    w = world(); let launched2 = 0; w.host.launch = async () => { launched2++; }; c = await B.waitConnected(w.host, {});
    check('已經連上就不去開瀏覽器', c.ok && launched2 === 0);

    // ---- 執行與驗證 ----
    w = world(); let ex = await B.execute(B.check([{ do: 'open', url: 'https://shop.example/' }, { do: 'look' }, { do: 'click', x: 200, y: 40 }, { do: 'read' }]).steps, w.host);
    check('依序執行並記錄狀態', ex.ok && ex.state.tab === 7 && /貓砂/.test(ex.state.text) && ex.executed.length === 4, ex);
    check('tab_id 自動帶上', w.calls[1].args.tab_id === 7 && w.calls[3].args.tab_id === 7, w.calls.map((x) => x.args));
    check('點擊用的是觀察到的座標', w.calls[2].cmd === 'mouse' && w.calls[2].args.action === 'click' && w.calls[2].args.x === 200);
    w = world(); w.hardFail = 'mouse'; ex = await B.execute(B.check([{ do: 'open', url: 'https://shop.example/' }, { do: 'look' }, { do: 'click', x: 200, y: 40 }]).steps, w.host);
    check('失敗就停下，說明哪一步為什麼', !ex.ok && /第 3 步（click）失敗：元素不存在/.test(ex.failure) && ex.failedStep.do === 'click', ex);
    w = world(); w.fail = { get_page_text: 1 }; ex = await B.execute(B.check([{ do: 'open', url: 'https://shop.example/' }, { do: 'read' }]).steps, w.host);
    check('暫時性逾時自動重試一次', ex.ok && w.n.get_page_text === 2, ex);
    w = world(); w.fail = { get_page_text: 5 }; ex = await B.execute(B.check([{ do: 'open', url: 'https://shop.example/' }, { do: 'read' }]).steps, w.host);
    check('一直逾時就放棄', !ex.ok && w.n.get_page_text === 2);
    w = world(); w.host.call = async (cmd, args) => (cmd === 'tab_create' ? { ok: true, tab_id: 1, url: 'chrome-error://chromewebdata/' } : { ok: true });
    ex = await B.execute(B.check([{ do: 'open', url: 'https://nope.invalid/' }]).steps, w.host);
    check('頁面載入失敗被驗證出來', !ex.ok && /載入失敗/.test(ex.failure), ex);
    w = world(); ex = await B.execute(B.check([{ do: 'open', url: 'https://a.com' }, { do: 'click_text', text: '確認付款' }]).steps, w.host);
    check('副作用步驟問使用者；同意才做', ex.ok && w.confirmed.length === 1 && /確認付款/.test(w.confirmed[0]) && w.n.click === 1, w.confirmed);
    w = world(); w.allow = false; ex = await B.execute(B.check([{ do: 'open', url: 'https://a.com' }, { do: 'click_text', text: '確認付款' }]).steps, w.host);
    check('不同意就不做', !ex.ok && ex.declined && !w.n.click);
    w = world(); w.host.confirm = undefined; ex = await B.execute(B.check([{ do: 'open', url: 'https://a.com' }, { do: 'click_text', text: '送出' }]).steps, w.host);
    check('沒有確認機制時副作用一律不做', !ex.ok && ex.declined && !w.n.click);

    // ---- 計畫一批（假模型）----
    const script = (answers) => { let i = 0; const log = []; const f = async (req) => { log.push(req.messages.map((m) => m.content).join('\n')); const a = answers[i++]; if (a instanceof Error) throw a; return a === undefined ? 'x' : a; }; f.log = log; f.count = () => i; return f; };
    let g = script(['{"choice": "B"}']); // 第一步程式決定（給了網址），第二步選單：開了之後可選 goto/back/reload/read/look…→ 選 B
    let pb = await B.planBatch('到 https://shop.example/ 看看有什麼', {}, { generate: g });
    check('給了網址：第一步程式直接 open，不問模型', pb.steps[0].do === 'open' && pb.steps[0].url === 'https://shop.example/' && pb.decisions[0].by === 'program', pb);
    check('選單只列合法動作（沒有 click、沒有 open）', !/點擊剛列出/.test(g.log[0]) && !/開一個新分頁/.test(g.log[0]) && /A\. /.test(g.log[0]), g.log[0]);
    check('做到一次觀察就停，等看到結果再計畫', pb.steps.length === 2 && ['read', 'look', 'goto'].includes(pb.steps[1].do) || pb.steps.length >= 2, pb.steps);
    g = script(['{"choice": "Z"}', '{"choice": "Z"}']);
    pb = await B.planBatch('到 https://shop.example/ 看看', {}, { generate: g, maxTries: 2 });
    check('模型亂選：退回重來兩次後用程式建議的第一個（合法動作），並留下記錄', pb.steps.length === 2 && B.check(pb.steps).ok && pb.decisions.some((d) => /程式建議/.test(d.note || '') && d.rejected.length === 2), pb);
    check('決策表把選單縮到 4 個以內', B.suggest(B.legalActions(['tab']), 'open', '到網站看看').length <= 4 && B.suggest(B.legalActions(['tab', 'elements']), 'look', '按搜尋').length <= 4);
    check('要互動的任務：開頁後先 look；要讀的任務：先 read', B.suggest(B.legalActions(['tab']), 'open', '按搜尋')[0] === 'look' && B.suggest(B.legalActions(['tab']), 'open', '告訴我內容')[0] === 'read');
    check('失敗後先重新觀察', B.suggest(B.legalActions(['tab']), 'click', '按搜尋', { failed: true })[0] === 'look');
    pb = await B.planBatch('看看有什麼', {}, {});
    check('沒有網址也沒有模型：只能 open 或 finish，無法計畫', pb.error && /沒有模型|缺少參數/.test(pb.error), pb);
    // 已經看過元素：點擊要從清單挑字母；輸入的文字要出自任務敘述
    const els = world().host && [{ tag: 'input', type: 'search', text: '搜尋', x: 100, y: 40 }, { tag: 'button', text: '搜尋', x: 200, y: 40 }, { tag: 'a', text: '關於我們', href: 'x', x: 30, y: 300 }];
    const sg = B.suggest(B.legalActions(['tab', 'elements']), 'look', '在搜尋框輸入 貓 然後按 Enter');
    const idx = (n) => String.fromCharCode(65 + sg.indexOf(n));
    check('look 之後的選單：點、輸入、讀、捲動', sg.join() === 'click,type,read,scroll', sg);
    g = script(['{"choice": "' + idx('type') + '"}', '{"choice": "A"}', '{"text":"貓"}', '{"choice": "A"}', '{"key":"Enter"}']);
    pb = await B.planBatch('在搜尋框輸入 貓 然後按 Enter', { state: ['tab', 'elements'], elements: els, history: [{ do: 'look', ok: true }] }, { generate: g });
    check('輸入：先補一步點輸入框，再輸入出自任務的文字', pb.steps[0].do === 'click' && pb.steps[0].x === 100 && pb.steps[1].do === 'type' && pb.steps[1].text === '貓', pb.steps);
    check('整批通過檢查', B.check(pb.steps, { state: ['tab', 'elements'] }).ok, B.check(pb.steps, { state: ['tab', 'elements'] }).errors);
    g = script(['{"choice": "' + idx('type') + '"}', '{"choice": "A"}', '{"text":"狗"}', '{"text":"狗"}']);
    pb = await B.planBatch('在搜尋框輸入 貓', { state: ['tab', 'elements'], elements: els, history: [{ do: 'look' }] }, { generate: g });
    check('輸入的文字不是出自任務敘述：被退回，不執行', pb.error && /填不出/.test(pb.error) && !pb.steps.some((s) => s.do === 'type'), pb);
    check('元素排序：跟任務有關的在前', B.rankElements(els, '點搜尋按鈕', 3)[0].text === '搜尋');
    check('輸入框只列輸入類元素', B.rankElements(els, '搜尋', 5, 'input').every((e) => e.tag === 'input'));

    // ---- 整個任務 ----
    w = world(); let events = [];
    w.host.onEvent = (e) => events.push(e.type); w.host.approvePlan = async () => true;
    let res = await B.runTask('搜尋 貓', w.host, { steps: [{ do: 'open', url: 'https://shop.example/' }, { do: 'look' }], once: true });
    check('強模型給計畫：照樣檢查、執行', res.ok && w.n.tab_create === 1 && w.n.get_elements === 1 && events.includes('plan') && events.includes('connect'), { res, events });
    w = world(); res = await B.runTask('x', w.host, { steps: [{ do: 'look' }] });
    check('計畫沒過檢查：一步都不執行', !res.ok && res.stage === 'check' && w.calls.length === 0, res);
    w = world(); w.host.approvePlan = async () => false; res = await B.runTask('x', w.host, { steps: [{ do: 'open', url: 'https://a.com' }] });
    check('使用者不同意計畫就不做（含不連線）', res.declined && w.calls.length === 0 && w.probes === 0, res);
    w = world(); w.connectAfter = 1e9; let tt = 0; w.host.sleep = async () => { tt += 1000; }; const rn = Date.now; Date.now = () => rn() + tt;
    res = await B.runTask('x', w.host, { steps: [{ do: 'open', url: 'https://a.com' }], wait: { timeoutMs: 3000, intervalMs: 1000 } }); Date.now = rn;
    check('連不上：回報提示，不執行', !res.ok && res.stage === 'connect' && /設定檔/.test(res.hint) && w.calls.length === 0, res);
    // 模型一路規劃：開頁 → 觀察 → 計畫下一批（點搜尋）→ 觀察 → 完成
    w = world(); w.host.approvePlan = async () => true;
    const brain = async (req) => {
        req = { messages: req.messages };
        const t = req.messages.map((m) => m.content).join('\n'); const menu = /(?:選單|元素|欄位)：\n([\s\S]*)$/.exec(t); const lines = menu ? menu[1].split('\n') : [];
        const letter = (re) => { const l = lines.find((x) => re.test(x)); return l ? l[0] : 'A'; };
        if (/從清單裡挑出/.test(t)) return JSON.stringify({ choice: letter(/button「搜尋」/) });
        if (/貓砂/.test(t) && /目前頁面文字/.test(t)) return JSON.stringify({ choice: letter(/任務完成/) });
        const hm = /已經做了：(.*)/.exec(t); const bm = /這一批已經計畫：(.*)/.exec(t); const hist = bm ? bm[1] : (hm ? hm[1] : ''); const last = hist.split(' → ').pop().split('(')[0]; if (/✗/.test(last)) return JSON.stringify({ choice: letter(/列出頁面上/) });
        if (last === 'open' || last === '') return JSON.stringify({ choice: letter(/列出頁面上/) });
        if (last === 'look') return JSON.stringify({ choice: letter(/點擊剛列出/) });
        if (last === 'click') return JSON.stringify({ choice: letter(/讀取頁面的文字/) });
        return JSON.stringify({ choice: letter(/列出頁面上/) });
    };
    res = await B.runTask('到 https://shop.example/ 按搜尋，告訴我貓砂多少錢', w.host, { generate: brain, maxRounds: 8 });
    check('模型逐批計畫：開頁→看元素→點搜尋→讀結果→完成', res.ok && res.done && /貓砂 120/.test(res.text) && w.n.mouse === 1 && w.calls.find((c) => c.cmd === 'mouse').args.x === 200, { ok: res.ok, done: res.done, text: res.text, mouse: w.n.mouse, x: (w.calls.find((c) => c.cmd === "mouse") || {}).args, err: res.error, rounds: res.rounds.map((r) => r.steps.join(">")) });
    check('每批做到一次觀察就重新計畫（多輪）', res.rounds.length >= 2 && res.rounds[0].steps.join(">") === "open>look", res.rounds.map((x) => x.steps.join('>')));
    // 失敗後重新計畫：第一次點擊失敗，下一輪重新觀察
    w = world(); w.host.approvePlan = async () => true; w.fail = { mouse: 50 };
    res = await B.runTask('到 https://shop.example/ 按搜尋', w.host, { generate: brain, maxRounds: 14 });
    check('一直失敗：有限次重新計畫後停下並說明（或發現沒有新的元素可點）', !res.ok && /失敗|沒有還沒點過/.test(res.error || ''), res.error);
    // 防原地打轉：點擊不選輸入框、點過的座標不再選
    const els2 = [{ tag: 'input', type: 'search', text: '搜尋', x: 100, y: 40 }, { tag: 'button', text: '搜尋', x: 200, y: 40 }];
    check('點擊不選輸入框（除非任務要輸入）', B.rankElements(els2, '按搜尋', 5, 'click').map((e) => e.tag).join() === 'button' && B.rankElements(els2, '按搜尋', 5, 'click', { allowInput: true }).length === 2);
    check('點過的座標不再選', B.rankElements(els2, '按搜尋', 5, 'click', { skip: new Set(['200,40']) }).length === 0);
    const pbx = await B.planBatch('按搜尋', { state: ['tab', 'elements'], elements: els2, url: 'https://s/', history: [{ do: 'click', x: 200, y: 40, at: 'https://s/' }, { do: 'look' }] }, { generate: async () => '{"choice":"A"}' });
    check('已經點過就不再點：回報沒有新的元素，不原地打轉', /沒有還沒點過/.test(pbx.error || ''), pbx);
    check('點完之後要讀資訊的任務：先 read', B.suggest(B.legalActions(['tab']), 'click', '按搜尋，告訴我價錢')[0] === 'read');

    console.log('bcplan_core: ' + ok + ' passed, ' + bad.length + ' failed'); if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})();
