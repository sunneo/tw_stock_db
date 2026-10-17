/* 瀏覽器控制的穩定生成（FaBcPlan）：先計畫每個動作 → 再跑 CoLU（綁到真正存在的動作、型別接得上才放行）→ 才執行；每次提取網頁資料後重新計畫。
 *
 * 為什麼：離線小模型邊想邊下指令，會下出不存在的動作、點不存在的元素、在沒開分頁時輸入文字——控制不穩定。這裡把「想」變成封閉小問題，把「放行」交給程式：
 *   ① ACTIONS：動作表（對應真正存在的瀏覽器控制指令）。每個動作有參數型別、需要什麼狀態（needs）、做完提供什麼（gives）、會讓什麼失效（kills）。
 *   ② simulate／check：照順序模擬狀態；動作不存在、參數型別不對、需要的東西還沒有（例如沒開分頁就點擊、沒觀察過元素就按座標）、碰到有副作用的步驟，全部在執行前就被擋下並說明原因。
 *   ③ planBatch：一次一個封閉小問題——選單只列「現在合法的動作」（模型選不出非法動作）、點擊／輸入只能從「剛觀察到的元素」裡挑字母、輸入的文字必須出自使用者的話。做到一次觀察（讀頁面、列元素）就停，等看到結果再計畫下一批（用 UML 拆解：每批是一個使用案例的呼叫順序）。
 *   ④ execute／runTask：先等擴充功能連上（有逾時；連不上的常見原因是瀏覽器卡在「誰在使用 Chrome？」設定檔選擇器，要使用者自己選）、逐步執行並驗證、失敗時重新計畫；有副作用的步驟一定先問使用者。
 *   ⑤ toModel／fromModel：計畫 ⇄ UML 使用案例，所以反思的結論可以用 uml_edit 補或刪步驟，再轉回計畫。
 * 純函式（UMD）；模型（generate）與瀏覽器（host）都是注入的，所以能用假的完整測試。
 */
(function (root, factory) {
    const R = (typeof FaRecipe !== 'undefined' && FaRecipe) || (root && root.FaRecipe) || (typeof require === 'function' ? require('../recipe/recipe_core.js') : null);
    const U = (typeof FaUml !== 'undefined' && FaUml) || (root && root.FaUml) || (typeof require === 'function' ? require('../uml/uml_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(R, U);
    else root.FaBcPlan = factory(R, U);
})(typeof self !== 'undefined' ? self : this, function (R, U) {
    'use strict';

    // ---------- 動作表 ----------
    // args：{ 名稱: { type, req, enum, max } }；needs／gives／kills：狀態集合（tab＝有開著的分頁、elements＝剛觀察過的元素、text＝剛讀過的頁面文字）
    const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    const ACTIONS = {
        open: { label: '開一個新分頁並前往網址', tool: 'browser_create_tab', cmd: 'tab_create', args: { url: { type: 'url', req: true } }, needs: [], gives: ['tab'], kills: ['elements', 'text'] },
        goto: { label: '讓目前的分頁前往另一個網址', tool: 'browser_navigate', cmd: 'tab_navigate', args: { url: { type: 'url', req: true } }, fixed: { action: 'goto' }, needs: ['tab'], gives: [], kills: ['elements', 'text'] },
        back: { label: '上一頁', tool: 'browser_navigate', cmd: 'tab_navigate', args: {}, fixed: { action: 'back' }, needs: ['tab'], gives: [], kills: ['elements', 'text'] },
        reload: { label: '重新整理', tool: 'browser_navigate', cmd: 'tab_navigate', args: {}, fixed: { action: 'reload' }, needs: ['tab'], gives: [], kills: ['elements', 'text'] },
        read: { label: '讀取頁面的文字（觀察）', tool: 'browser_get_page_text', cmd: 'get_page_text', args: { offset: { type: 'int', min: 0, max: 1000000 } }, needs: ['tab'], gives: ['text'], kills: [], observe: true },
        look: { label: '列出頁面上可以點或輸入的元素（觀察）', tool: 'browser_get_elements', cmd: 'get_elements', args: {}, fixed: { max: 60 }, needs: ['tab'], gives: ['elements'], kills: [], observe: true },
        click: { label: '點擊剛列出的其中一個元素', tool: 'browser_mouse', cmd: 'mouse', args: { x: { type: 'int', req: true, min: 0, max: 20000 }, y: { type: 'int', req: true, min: 0, max: 20000 } }, fixed: { action: 'click' }, needs: ['tab', 'elements'], gives: [], kills: ['elements', 'text'], pick: 'element' },
        click_text: { label: '用文字或選擇器點擊（強模型的計畫用）', tool: 'browser_click', cmd: 'click', args: { text: { type: 'text' }, selector: { type: 'selector' }, index: { type: 'int', min: 0, max: 50 } }, needs: ['tab'], gives: [], kills: ['elements', 'text'], oneOf: ['text', 'selector'] },
        type: { label: '在剛列出的其中一個輸入框輸入文字', tool: 'browser_type_text', cmd: 'type_text', args: { text: { type: 'text', req: true }, selector: { type: 'selector' }, clear: { type: 'bool' }, submit: { type: 'bool' } }, needs: ['tab'], gives: [], kills: [], focus: true, pick: 'input' },
        key: { label: '按一個鍵', tool: 'browser_press_key', cmd: 'press_key', args: { key: { type: 'enum', req: true, values: KEYS } }, needs: ['tab'], gives: [], kills: ['elements', 'text'] },
        scroll: { label: '捲動頁面', tool: 'browser_scroll', cmd: 'scroll', args: { direction: { type: 'enum', req: true, values: ['down', 'up', 'top', 'bottom'] }, amount: { type: 'int', min: 1, max: 20000 } }, needs: ['tab'], gives: [], kills: ['elements'] },
        wait_download: { label: '等一個檔案下載完成', tool: 'browser_wait_download', cmd: 'wait_download', args: {}, needs: ['tab'], gives: [], kills: [] },
        close: { label: '關閉分頁', tool: 'browser_close', cmd: 'tab_close', args: {}, needs: ['tab'], gives: [], kills: ['tab', 'elements', 'text'] },
        finish: { label: '任務完成，結束', tool: null, cmd: null, args: {}, needs: [], gives: [], kills: [], terminal: true }
    };
    const NAMES = Object.keys(ACTIONS);
    // 有副作用的字眼（點到這些要先問使用者）；輸入欄位名稱出現這些就直接不做（不替使用者輸入密碼、卡號）
    const SIDE_RE = /送出|提交|確認(?:購買|付款|訂單|刪除|送出)?|付款|購買|結帳|下單|刪除|移除|寄出|發送|發佈|發布|發表|登入|登出|註冊|訂閱|捐款|轉帳|submit|send|pay|buy|purchase|checkout|delete|remove|confirm|publish|post|sign.?in|log.?in|sign.?up|subscribe|donate/i;
    const SECRET_RE = /password|passwd|密碼|card.?number|cvv|cvc|信用卡|卡號|驗證碼|otp|ssn|身分證/i;

    const clone = (x) => JSON.parse(JSON.stringify(x));
    const isUrl = (s) => { try { const u = new URL(String(s)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (_) { return false; } };

    // ---------- 參數型別 ----------
    function checkArg(def, v, name) {
        if (v === undefined || v === null || v === '') return def.req ? name + ' 必填' : null;
        switch (def.type) {
            case 'url': return isUrl(v) ? null : name + ' 要是 http 或 https 網址（不接受 file:、javascript:、chrome: 之類）：' + String(v).slice(0, 60);
            case 'int': { const n = Number(v); if (!Number.isInteger(n)) return name + ' 要是整數'; if (def.min != null && n < def.min) return name + ' 太小'; if (def.max != null && n > def.max) return name + ' 太大'; return null; }
            case 'bool': return typeof v === 'boolean' ? null : name + ' 要是 true 或 false';
            case 'enum': return def.values.includes(v) ? null : name + ' 只能是 ' + def.values.join('／');
            case 'selector': return typeof v === 'string' && v.length <= 200 && !/<\s*script/i.test(v) ? null : name + ' 不是合理的選擇器';
            case 'text': return typeof v === 'string' && v.length <= 500 ? null : name + ' 要是 500 字以內的文字';
        }
        return null;
    }

    // ---------- 模擬與檢查（CoLU：動作要真的存在、型別接得上才放行）----------
    // steps：[{ do:'open', url:'https://…' }, …]。回傳 { ok, errors:[{index,msg}], steps:[含 sideEffect 標記的複本], state }
    function check(steps, opts) {
        opts = opts || {}; const errors = []; const out = []; const state = new Set(opts.state || []); const list = Array.isArray(steps) ? steps : [];
        list.forEach((s0, i) => {
            const s = clone(s0 || {}); const a = ACTIONS[s.do]; const err = (m) => errors.push({ index: i, msg: '第 ' + (i + 1) + ' 步（' + (s.do || '?') + '）：' + m });
            if (!a) { err('沒有這個動作，只能用：' + NAMES.join('、')); out.push(s); return; }
            if (opts.tools && a.tool && !opts.tools.includes(a.tool)) err('這個環境沒有工具 ' + a.tool);
            for (const need of a.needs) if (!state.has(need)) err('現在還沒有「' + ({ tab: '開著的分頁（先 open）', elements: '剛觀察過的元素（先 look，而且中間沒有換頁、點擊或捲動）', text: '讀過的頁面文字' }[need]) + '」');
            for (const [k, def] of Object.entries(a.args)) { const m = checkArg(def, s[k], k); if (m) err(m); }
            for (const k of Object.keys(s)) if (!['do', 'why', 'expect', 'label', 'sideEffect'].includes(k) && !(k in a.args)) err('多餘的參數 ' + k);
            if (a.oneOf && !a.oneOf.some((k) => s[k])) err('要給 ' + a.oneOf.join(' 或 ') + ' 其中一個');
            if (a.focus && !s.selector && !lastWasFocusTarget(list, i)) err('輸入文字前要先點一下輸入框（click），或給 selector');
            if (s.do === 'type' && (SECRET_RE.test(String(s.selector || '')) || SECRET_RE.test(String(s.text || '')) && /^[\w.@!#$%^&*-]{6,}$/.test(String(s.text)) && SECRET_RE.test(String(s.why || '')))) err('不替使用者輸入密碼、卡號、驗證碼——請使用者自己輸入');
            const side = (s.do === 'type' && s.submit === true) || ((s.do === 'click_text' || s.do === 'click') && SIDE_RE.test(String(s.text || s.label || s.why || ''))) || (s.do === 'key' && s.key === 'Enter' && i > 0 && list[i - 1] && list[i - 1].do === 'type');
            if (side) s.sideEffect = true;
            if (a.terminal) { if (i !== list.length - 1) err('finish 後面不能再有步驟'); }
            for (const g of a.gives) state.add(g); for (const k of a.kills) state.delete(k);
            out.push(s);
        });
        return { ok: errors.length === 0, errors, steps: out, state: [...state], sideEffects: out.filter((x) => x.sideEffect).length };
    }
    // 前一個動作是不是點擊（點了輸入框才能輸入）
    function lastWasFocusTarget(list, i) { for (let j = i - 1; j >= 0; j--) { const d = list[j] && list[j].do; if (d === 'click' || d === 'click_text') return true; if (d === 'type') return true; if (d === 'look' || d === 'read') continue; return false; } return false; }

    // 目前的合法動作（選單只列這些：模型選不出非法動作）
    function legalActions(state, opts) {
        const st = new Set(state || []); opts = opts || {};
        return NAMES.filter((n) => { const a = ACTIONS[n]; if (n === 'click_text') return false; if (!a.needs.every((x) => st.has(x))) return false; if (n === 'open' && st.has('tab') && !opts.allowMultipleTabs) return false; if (opts.tools && a.tool && !opts.tools.includes(a.tool)) return false; return true; });
    }

    // ---------- 元素挑選 ----------
    function tokens(s) { s = String(s || '').toLowerCase(); const out = new Set(); (s.match(/[a-z0-9]{2,}/g) || []).forEach((x) => out.add(x)); (s.match(/[㐀-鿿]+/g) || []).forEach((run) => { if (run.length === 1) out.add(run); for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2)); }); return out; }
    // 依跟「目前要做的事」的重疊排序（程式），挑前 n 個給模型選
    function rankElements(elements, query, n, kind, o) {
        o = o || {}; const q = tokens(query); const rows = (elements || []).filter((e) => e && Number.isFinite(e.x) && Number.isFinite(e.y)).filter((e) => !(o.skip && o.skip.has(e.x + ',' + e.y))).filter((e) => kind !== 'click' || o.allowInput || !/^(input|textarea|select)$/.test(e.tag)).filter((e) => kind !== 'input' || /^(input|textarea|select)$/.test(e.tag) || e.contenteditable).map((e, i) => { const t = tokens([e.text, e.href, e.type, e.tag].join(' ')); let s = 0; for (const x of t) if (q.has(x)) s += x.length > 1 ? 2 : 1; return { e, i, s }; });
        rows.sort((a, b) => b.s - a.s || a.i - b.i); return rows.slice(0, n || 12).map((r) => r.e);
    }
    const elementLabel = (e) => (e.tag || '?') + (e.type ? '[' + e.type + ']' : '') + '「' + String(e.text || e.href || '').slice(0, 40) + '」';

    // ---------- 計畫 ⇄ UML ----------
    // 每批計畫是一個使用案例的呼叫順序：Browser 類別有所有動作當操作；uml_edit 補或刪步驟，再轉回計畫
    function toModel(steps, name) {
        const m = U.emptyModel(); m.name = 'BrowserTask'; m.actors.push('User');
        m.classes.push({ name: 'Browser', kind: 'class', attrs: [], ops: NAMES.map((n) => ({ name: n, params: Object.keys(ACTIONS[n].args).map((k) => ({ name: k, type: { base: 'any', args: [] } })), returns: { base: 'void', args: [] }, visibility: '+', static: false })), values: [] });
        const ss = []; let prev = 'User'; for (const s of steps || []) { ss.push({ from: prev, to: 'Browser', msg: s.do, args: Object.keys(ACTIONS[s.do] ? ACTIONS[s.do].args : {}).map((k) => s[k] === undefined ? '' : JSON.stringify(s[k])).filter(Boolean), returns: '' }); prev = 'Browser'; }
        m.usecases.push({ name: name || '任務', actor: 'User', steps: ss }); return m;
    }
    function fromModel(m, name) {
        const u = (m.usecases || []).find((x) => x.name === (name || '任務')) || (m.usecases || [])[0]; if (!u) return [];
        return u.steps.filter((s) => s.to === 'Browser').map((s) => { const a = ACTIONS[s.msg]; const o = { do: s.msg }; if (a) Object.keys(a.args).forEach((k, i) => { if (s.args && s.args[i] !== undefined) { try { o[k] = JSON.parse(s.args[i]); } catch (_) { o[k] = s.args[i]; } } }); return o; });
    }

    // ---------- 計畫（一批）----------
    const LETTER = (i) => String.fromCharCode(65 + i);
    function pickIndex(v, n) { let x = v && typeof v === 'object' ? v.choice : v; if (typeof x === 'string') { x = x.trim().replace(/["'.。、）)]/g, ''); if (/^[A-Za-z]$/.test(x)) x = x.toUpperCase().charCodeAt(0) - 64; else if (/^\d+$/.test(x)) x = Number(x); } return Number.isInteger(x) && x >= 1 && x <= n ? x - 1 : -1; }
    const ask = async (opts, messages, validate, prefill, maxTokens) => R.jsonStep({ generate: opts.generate, messages, validate, maxTries: opts.maxTries || 2, maxTokens: maxTokens || 120, prefill });

    function summarizeCtx(ctx) {
        const L = []; if (ctx.history && ctx.history.length) L.push('已經做了：' + ctx.history.slice(-6).map((h) => h.do + (h.url ? '(' + h.url.slice(0, 50) + ')' : '') + (h.ok === false ? '✗' : '')).join(' → '));
        if (ctx.text) L.push('目前頁面文字（節錄）：' + String(ctx.text).replace(/\s+/g, ' ').slice(0, 400));
        if (ctx.failure) L.push('上一步失敗：' + ctx.failure);
        return L.join('\n');
    }
    // 決策表：依上一個動作與任務的意圖，把選單縮到 2～4 個最合理的選項（程式的知識；小模型一次選 11 個選不出來，選 3 個就行）。第一個是程式的建議（模型選不出來時用它）
    const INTERACT_RE = /按|點|輸入|搜尋|填|選擇|登入|送出|下載|捲|click|type|press|search|fill|submit|download/i;
    const READ_RE = /告訴|讀|看看|摘要|內容|多少|查|是什麼|有哪些|列出|read|tell|summar|find|what/i;
    const NEXT = { '': ['look', 'read'], open: ['look', 'read'], goto: ['look', 'read'], back: ['look', 'read'], reload: ['look', 'read'], look: ['click', 'type', 'read', 'scroll'], click: ['look', 'read', 'finish'], type: ['key', 'look', 'read'], key: ['look', 'read', 'finish'], scroll: ['look', 'read', 'finish'], read: ['finish', 'scroll', 'look', 'goto'], wait_download: ['finish', 'look'], close: ['finish'] };
    function suggest(legal, last, goal, c) {
        c = c || {}; const g = String(goal || ''); const wantsAct = INTERACT_RE.test(g), wantsRead = READ_RE.test(g); let order = (NEXT[last || ''] || []).filter((x) => legal.includes(x));
        if (last === 'open' || last === 'goto' || last === 'back' || last === 'reload' || last === '') { if (wantsAct) order = order.sort((x, y) => (x === 'look' ? -1 : 0) - (y === 'look' ? -1 : 0)); else if (wantsRead) order = order.sort((x, y) => (x === 'read' ? -1 : 0) - (y === 'read' ? -1 : 0)); }
        if (last === 'look' && !wantsAct) order = order.filter((x) => x !== 'click' && x !== 'type').concat(order.filter((x) => x === 'click')); // 沒有要互動的意圖：先讀
        if ((last === 'click' || last === 'key') && wantsRead) order = ['read', 'look', 'finish'].filter((x) => legal.includes(x));
        if (last === 'look' && c.failed) order = ['read'].filter((x) => legal.includes(x)).concat(order);
        if (last === 'read' && wantsAct && !(c.history || []).some((h) => h.do === 'click' || h.do === 'type')) order = ['look'].concat(order.filter((x) => x !== 'look' && x !== 'finish')).filter((x) => legal.includes(x));
        if (c.failed && last !== 'look') order = ['look'].filter((x) => legal.includes(x)).concat(order.filter((x) => x !== 'look'));
        const seen = new Set(); order = order.filter((x) => !seen.has(x) && seen.add(x)); return order.length ? order.slice(0, 4) : legal.slice(0, 4);
    }
    // 計畫一批動作：做到一次觀察（read／look）或 finish 就停。回傳 { steps, done, by:[…], rejected }
    // ctx：{ goal, state:[…], elements:[…], text, history, failure }；opts：{ generate, maxSteps, tools }
    async function planBatch(goal, ctx, opts) {
        opts = opts || {}; ctx = ctx || {}; const maxSteps = opts.maxSteps || 6; const steps = []; const decisions = []; let state = new Set(ctx.state || []); const elements = (ctx.elements || []).slice(); let done = false;
        const urlInGoal = (String(goal).match(/https?:\/\/[^\s)）」』]+/) || [])[0];
        for (let n = 0; n < maxSteps; n++) {
            const legalAll = legalActions([...state], opts); const last = (steps.length ? steps[steps.length - 1].do : (ctx.history && ctx.history.length ? ctx.history[ctx.history.length - 1].do : ''));
            const legal = suggest(legalAll, last, goal, { elements, history: ctx.history, failed: !!ctx.failure });
            let act = null, by = 'model';
            if (!state.has('tab') && urlInGoal && !ctx.history) { act = 'open'; by = 'program'; } // 使用者給了網址：第一步程式直接決定，不問模型
            else if (!legal.length) break;
            else if (legal.length === 1) { act = legal[0]; by = 'program'; }
            else {
                if (!opts.generate) { act = legal[0]; by = 'program'; }
                else {
                    const menu = legal.map((x, i) => LETTER(i) + '. ' + ACTIONS[x].label).join('\n');
                    const r = await ask(opts, [{ role: 'system', content: '你在控制瀏覽器完成使用者的任務，一次只決定下一個動作。只輸出一個 JSON 物件，格式：{"choice": "字母"}，字母只能是選單裡有的。已經拿到需要的資訊就選「任務完成」。' }, { role: 'user', content: '任務：' + String(goal).slice(0, 400) + '\n' + summarizeCtx(ctx) + (steps.length ? '\n這一批已經計畫：' + steps.map((s) => s.do).join(' → ') : '') + '\n選單：\n' + menu }], (o) => (pickIndex(o, legal.length) >= 0 ? [] : ['「choice」必須是選單裡的字母 A～' + LETTER(legal.length - 1)]), '{"choice":', 40);
                    if (r.ok) act = legal[pickIndex(r.value, legal.length)]; else { act = legal[0]; by = 'program'; decisions.push({ act, by, note: '模型沒選出來，用程式建議的第一個', rejected: r.rejected }); } // 選項本來就都是合法動作，退回程式的建議是安全的
                }
            }
            const a = ACTIONS[act]; const step = { do: act };
            if (a.terminal) { done = true; decisions.push({ act, by }); break; }
            if (a.pick) { // 從剛觀察到的元素挑一個（字母）
                const skip = new Set((ctx.history || []).filter((h) => h.do === 'click' && h.x != null && h.at === (ctx.url || '')).map((h) => h.x + ',' + h.y));
                const cands = rankElements(elements, String(goal).replace(/https?:\/\/\S+/g, ' ') + ' ' + (ctx.history || []).map((h) => h.why || '').join(' '), 12, a.pick === 'input' ? 'input' : 'click', { skip, allowInput: /輸入|欄位|框|填|input|type|fill/i.test(String(goal)) });
                if (!cands.length) { decisions.push({ act, by, error: '頁面上沒有還沒點過的合適元素' }); if (!steps.length) return { steps, done: false, decisions, error: '頁面上沒有還沒點過的合適元素（點過的不會再點，避免原地打轉）' }; break; }
                let el = cands[0]; let pby = 'program';
                if (cands.length > 1 && opts.generate) {
                    const menu = cands.map((e, i) => LETTER(i) + '. ' + elementLabel(e)).join('\n');
                    const r = await ask(opts, [{ role: 'system', content: '從清單裡挑出符合任務的那一個元素。只輸出一個 JSON 物件，格式：{"choice": "字母"}。' }, { role: 'user', content: '任務：' + String(goal).slice(0, 300) + '\n要' + (act === 'type' ? '輸入文字的欄位' : '點的元素') + '：\n' + menu }], (o) => (pickIndex(o, cands.length) >= 0 ? [] : ['必須是字母 A～' + LETTER(cands.length - 1)]), '{"choice":', 40);
                    if (r.ok) { el = cands[pickIndex(r.value, cands.length)]; pby = 'model'; }
                }
                if (act === 'click') { step.x = el.x; step.y = el.y; step.label = elementLabel(el); }
                else { step.selector = el.selector || undefined; step.label = elementLabel(el); step.click = { x: el.x, y: el.y }; }
                decisions.push({ act, by: pby, pick: step.label });
            }
            const free = Object.entries(a.args).filter(([k, d]) => d.req && !(k in step) && !(a.pick === 'element' && (k === 'x' || k === 'y')));
            if (free.length) { // 其餘必填參數：一個一個封閉填空，程式驗證
                if (act === 'open' && urlInGoal) step.url = urlInGoal;
                else {
                    const need = free.filter(([k]) => !(k in step)); if (need.length) {
                        if (!opts.generate) return { steps, done: false, decisions, error: '缺少參數：' + need.map((x) => x[0]).join('、') };
                        const r = await ask(opts, [{ role: 'system', content: '替動作「' + a.label + '」填參數。只輸出一個 JSON 物件，欄位：' + need.map(([k, d]) => k + '（' + ({ url: '網址', text: '要輸入的文字，必須出自任務敘述', enum: d.values ? d.values.join('／') : '', int: '整數' }[d.type] || d.type) + '）').join('、') + '。' }, { role: 'user', content: '任務：' + String(goal).slice(0, 400) + '\n' + summarizeCtx(ctx) }],
                            (o) => { const e = []; for (const [k, d] of need) { const m = checkArg(d, o[k], k); if (m) e.push(m); else if (act === 'type' && k === 'text' && !String(goal).includes(String(o[k]).trim())) e.push('text 必須是任務敘述裡出現過的字（不要自己編）'); } return e; }, '{"' + need[0][0] + '":', 160);
                        if (!r.ok) return { steps, done: false, decisions, error: '模型填不出「' + a.label + '」的參數：' + (r.error || (r.rejected && r.rejected[0]) || ''), rejected: r.rejected };
                        for (const [k] of need) step[k] = r.value[k];
                    }
                }
            }
            // type 要先點一下輸入框：有座標就在前面補一步 click
            if (act === 'type' && step.click) { steps.push({ do: 'click', x: step.click.x, y: step.click.y, label: step.label }); delete step.click; }
            steps.push(step);
            state = new Set(check(steps, { state: ctx.state, tools: opts.tools }).state);
            decisions.push({ act, by });
            if (a.observe) break;
        }
        return { steps, done, decisions };
    }

    // ---------- 等擴充功能連上 ----------
    // host.probe()：不開瀏覽器地問「連上了嗎」→ { ok }；host.launch()：真的叫一次（桌面版會自動開瀏覽器）；host.sleep(ms)
    async function waitConnected(host, opts) {
        opts = opts || {}; const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 25000, every = opts.intervalMs || 1000; const sleep = host.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        const t0 = Date.now(); let p = await host.probe(); if (p && p.ok && p.allowed !== false) return { ok: true, waitedMs: 0 };
        if (p && p.allowed === false) return { ok: false, error: 'NOT_ALLOWED', waitedMs: 0, hint: '這個網站還沒被允許：請在擴充功能視窗按「允許目前網站」。' };
        let launched = false; if (opts.launch !== false && host.launch) { try { await host.launch(); launched = true; } catch (_) { /* 開不起來就等 */ } }
        let polls = 0;
        while (Date.now() - t0 < timeoutMs) { await sleep(every); polls++; p = await host.probe(); if (p && p.ok && p.allowed !== false) return { ok: true, waitedMs: Date.now() - t0, polls, launched }; if (p && p.allowed === false) return { ok: false, error: 'NOT_ALLOWED', waitedMs: Date.now() - t0, hint: '這個網站還沒被允許：請在擴充功能視窗按「允許目前網站」。' }; }
        return { ok: false, error: 'EXTENSION_NOT_CONNECTED', waitedMs: Date.now() - t0, polls, launched, hint: '等了 ' + Math.round((Date.now() - t0) / 1000) + ' 秒擴充功能還沒連上。常見原因：①瀏覽器停在「誰在使用 Chrome？」設定檔選擇器（擴充功能要選了設定檔才會載入——請你自己選裝了擴充功能的那個，我不替你選帳號）②擴充功能沒裝或配對碼不對 ③桌面版的「瀏覽器控制」沒啟用。處理好之後再叫我一次。' };
    }

    // ---------- 執行 ----------
    const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
    function argsOf(step, st) { const a = ACTIONS[step.do]; const o = Object.assign({}, a.fixed || {}); for (const k of Object.keys(a.args)) if (step[k] !== undefined && step[k] !== '') o[k] = step[k]; if (st.tab != null && a.needs.includes('tab')) o.tab_id = st.tab; if (step.do === 'goto' || step.do === 'back' || step.do === 'reload') o.action = (a.fixed || {}).action; return o; }
    // 驗證一步的結果（程式）：回傳 null＝通過，字串＝失敗原因
    function verify(step, r) {
        if (!r || r.ok === false) return (r && (r.error || r.note)) ? String(r.error || r.note) : '沒有回應';
        if ((step.do === 'open' || step.do === 'goto') && /^(chrome-error|about:neterror)/.test(String(r.url || ''))) return '頁面載入失敗（' + clip(r.url, 60) + '）';
        if (step.do === 'look' && !Array.isArray(r.elements)) return '沒有拿到元素清單';
        if (step.do === 'read' && typeof r.text !== 'string' && typeof r.content !== 'string') return '沒有拿到頁面文字';
        if (step.expect && step.expect.url_contains && !String(r.url || '').includes(step.expect.url_contains)) return '網址不是預期的（要包含 ' + step.expect.url_contains + '，實際 ' + clip(r.url, 80) + '）';
        return null;
    }
    // 執行一批已通過檢查的步驟。host：{ call(cmd,args,timeoutMs), confirm(step)→bool, onStep? }。回傳 { ok, executed:[…], state, failure?, declined? }
    async function execute(steps, host, st) {
        st = st || { tab: null, elements: [], text: '', url: '' }; const executed = [];
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i]; const a = ACTIONS[s.do];
            if (a.terminal) { executed.push({ do: s.do, ok: true }); break; }
            if (s.sideEffect) { const okc = host.confirm ? await host.confirm(s, steps.slice(0, i)) : false; if (!okc) return { ok: false, declined: true, executed, state: st, failure: '有副作用的步驟（' + (s.label || s.text || s.do) + '）沒有得到使用者同意，已停止' }; }
            let r, why = null;
            for (let attempt = 0; attempt < 2; attempt++) { try { r = await host.call(a.cmd, argsOf(s, st), s.do === 'open' || s.do === 'goto' ? 45000 : 30000); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; } why = verify(s, r); if (!why) break; if (!/逾時|沒有回應|timeout|秒內/i.test(why)) break; }
            const rec = { do: s.do, ok: !why, url: (r && r.url) || undefined, why: s.why || s.label, x: s.x, y: s.y, at: st.url || '' }; if (why) rec.error = why; executed.push(rec); if (host.onStep) { try { host.onStep(rec, i); } catch (_) { /* 回報失敗不影響執行 */ } }
            if (why) return { ok: false, executed, state: st, failure: '第 ' + (i + 1) + ' 步（' + s.do + '）失敗：' + why, failedStep: s };
            if (r.tab_id != null) st.tab = r.tab_id; if (r.url) st.url = r.url;
            if (s.do === 'look') st.elements = r.elements; else if (a.kills.includes('elements')) st.elements = [];
            if (s.do === 'read') st.text = typeof r.text === 'string' ? r.text : String(r.content || ''); else if (a.kills.includes('text')) st.text = '';
            if (s.do === 'close') st.tab = null;
        }
        return { ok: true, executed, state: st };
    }

    // ---------- 整個任務：計畫一批 → 檢查 → 執行 → 觀察 → 再計畫 ----------
    // host：{ probe, launch, call, confirm, approvePlan(plan)→bool, onEvent }；opts：{ generate, steps（強模型給的第一批）, maxRounds, mode }
    async function runTask(goal, host, opts) {
        opts = opts || {}; const maxRounds = opts.maxRounds || 8; const emit = (e) => { if (host.onEvent) { try { host.onEvent(e); } catch (_) { /* */ } } };
        const st = { tab: null, elements: [], text: '', url: '' }; const history = []; const rounds = []; let failure = '', connected = false, supplied = Array.isArray(opts.steps) ? opts.steps : null, repairs = 0;
        for (let round = 0; round < maxRounds; round++) {
            const stateNow = [...(st.tab != null ? ['tab'] : []), ...(st.elements.length ? ['elements'] : []), ...(st.text ? ['text'] : [])];
            let batch, decisions = null, done = false, fromUser = false;
            if (supplied) { batch = supplied; supplied = null; fromUser = true; done = batch.some((s) => s && s.do === 'finish'); }
            else { const pl = await planBatch(goal, { state: stateNow, elements: st.elements, text: st.text, url: st.url, history: history.length ? history : undefined, failure }, opts); if (pl.error && !pl.steps.length) { emit({ type: 'plan_failed', error: pl.error }); return { ok: false, error: pl.error, rounds, history, state: st, stage: 'plan' }; } batch = pl.steps; decisions = pl.decisions; done = pl.done; }
            const chk = check(batch, { state: stateNow, tools: opts.tools });
            if (!chk.ok) { // 計畫沒過檢查：把原因餵回去重新計畫一次，還是不行就停（不執行任何一步）
                emit({ type: 'plan_rejected', errors: chk.errors.map((e) => e.msg) }); failure = chk.errors[0].msg; if (fromUser && !opts.generate) return { ok: false, error: '計畫沒有通過檢查：' + chk.errors.map((e) => e.msg).join('；'), rounds, history, state: st, stage: 'check', errors: chk.errors }; if (++repairs > 2) return { ok: false, error: '計畫沒有通過檢查：' + chk.errors.map((e) => e.msg).join('；'), rounds, history, state: st, stage: 'check' }; continue;
            }
            const steps = chk.steps; if (!steps.length && done) return { ok: true, rounds, history, state: st, done: true, text: st.text, elements: st.elements };
            if (!steps.length) { failure = '計畫是空的'; if (++repairs > 2) return { ok: false, error: '計畫是空的', rounds, history, state: st, stage: 'plan' }; continue; }
            emit({ type: 'plan', round, steps, decisions });
            if (round === 0 && host.approvePlan) { const okp = await host.approvePlan({ goal, steps, sideEffects: chk.sideEffects }); if (!okp) return { ok: false, declined: true, error: '使用者沒有同意這份計畫', rounds, history, state: st, stage: 'approve', plan: steps }; }
            if (!connected) { const w = await waitConnected(host, opts.wait); emit({ type: 'connect', result: w }); if (!w.ok) return { ok: false, error: w.error, hint: w.hint, rounds, history, state: st, stage: 'connect', plan: steps }; connected = true; }
            const ex = await execute(steps, host, st); rounds.push({ round, steps: steps.map((s) => s.do), executed: ex.executed }); for (const e of ex.executed) history.push(e);
            if (ex.declined) return { ok: false, declined: true, error: ex.failure, rounds, history, state: st, stage: 'confirm' };
            if (!ex.ok) { failure = ex.failure; emit({ type: 'step_failed', failure }); st.elements = []; if (opts.replan === false || supplied === null && !opts.generate) return { ok: false, error: failure, rounds, history, state: st, stage: 'execute' }; if (++repairs > 3) return { ok: false, error: failure, rounds, history, state: st, stage: 'execute' }; continue; }
            failure = '';
            if (steps.some((s) => s.do === 'finish') || done) return { ok: true, rounds, history, state: st, done: true, text: st.text, elements: st.elements };
            if (!opts.generate) return { ok: true, rounds, history, state: st, text: st.text, elements: st.elements };
            if (opts.once) return { ok: true, rounds, history, state: st, text: st.text, elements: st.elements };
        }
        return { ok: false, error: '超過 ' + maxRounds + ' 輪還沒完成', rounds, history, state: st, stage: 'rounds', text: st.text };
    }

    return { ACTIONS, NAMES, KEYS, SIDE_RE, SECRET_RE, checkArg, check, legalActions, suggest, rankElements, elementLabel, toModel, fromModel, pickIndex, planBatch, waitConnected, argsOf, verify, execute, runTask };
});
