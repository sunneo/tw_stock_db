// 訓練工作室 GUI 補齊的真 Electron 驗證：用法 node scripts/qrun.js --timeout 300 -- node scripts/eval/real_electron.run.js studio_gui 17973
// 涵蓋：評量（真跑 uml／trainer／colu／blockly／matrix／lora）、符號式訓練（colu 重訓、uml 驗證收錄可暫停繼續、trainer 蒸餾）、
// 老師迴圈（白名單工具真的註冊進 _runSubAgentTask 的 allowedToolNames、留出不可見、驗證才收、結束後移除工具；不連線上 AI）、
// 資料匯入輸入欄位（本機路徑多資料夾、網址先確認）、以及真的畫面文字（同源探測框）。
return (async () => {
    const R = { checks: [] }; const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: ok || extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
    R.loaded = Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s));
    ck('載入的是工作目錄的 floating-assistant.js', R.loaded.some((s) => /desktop-app[\\/]renderer[\\/]floating-assistant/i.test(decodeURIComponent(s))), R.loaded);
    ck('新核心已嵌入', ['FaStudioEval', 'FaStudioSym', 'FaStudioSymTrain', 'FaStudioTeacher', 'FaStudioSourceInput'].every((k) => FaStudio[k]));
    await fa._studioCommand(''); await until(() => document.querySelector('.fwd iframe[sandbox]'));
    const srv = await fa._studioServer(); const route = async (m, p, b) => { const x = await srv.core.route(m, new URL('http://mock.local' + p), b); return Object.assign({ _s: x.s || 200 }, x.j); };
    const store = await fa._studioStorage();

    // ===== 評量 =====
    const ev = {}; for (const k of ['uml', 'trainer', 'colu', 'blockly', 'matrix', 'lora']) ev[k] = await route('POST', '/api/eval/run', { kind: k, saveBaseline: k === 'uml' });
    R.eval = Object.fromEntries(Object.keys(ev).map((k) => [k, ev[k].summary && { summary: ev[k].summary, groups: ev[k].groups.map((g) => g.group + ' ' + (g.ran ? g.pass + '/' + g.n : '沒跑：' + String(g.unavailable).slice(0, 70))) }]));
    ck('uml 評量 8 組全部真跑', ev.uml.ok && ev.uml.summary.ran === 8 && ev.uml.groups.every((g) => g.rate >= 0 && g.rate <= 1), ev.uml.summary);
    ck('uml 再跑一次與基準一致（無退步）', (await route('POST', '/api/eval/run', { kind: 'uml' })).groups.every((g) => g.regressed === false && g.prev === g.rate));
    ck('trainer 規則自檢真跑，筆數＝內建領域規則數', ev.trainer.ok && ev.trainer.groups[0].ran && ev.trainer.groups[0].n > 50, ev.trainer.groups[0]);
    ck('colu：回饋不足寫缺什麼；體檢為已記錄', ev.colu.ok && ev.colu.groups[0].ran === false && /解除條件/.test(ev.colu.groups[0].unavailable) && ev.colu.groups[1].recorded, ev.colu.groups.map((g) => g.unavailable));
    ck('blockly：內建課已記錄、種子題寫原因', ev.blockly.groups[0].recorded && ev.blockly.groups[1].ran === false);
    const judgeOk = !!(window.desktopAPI && window.desktopAPI.judge); R.judge = judgeOk;
    ck('matrix：有判題器就真跑，沒有就每組寫判題器原因', ev.matrix.ok && ev.matrix.groups.length === 6 && ev.matrix.groups.every((g) => g.ran || /判題器/.test(g.unavailable)), ev.matrix.groups.map((g) => g.unavailable));
    ck('lora：沒有評量資產時寫 eval_run.py 與解除條件', ev.lora.groups[0].ran === false && /eval_run\.py/.test(ev.lora.groups[0].unavailable));

    // ===== 符號式訓練：colu =====
    const none = await route('POST', '/api/train/start', { kind: 'colu', name: 'colu-gui' }); ck('colu 沒回饋：409 與解除條件', none._s === 409 && /解除條件/.test(none.error), none);
    const F = FaCatalogFeedback, feats = FaCatalogDiscover.FEATURES; const recs = [];
    for (let g = 0; g < 10; g++) for (let k = 0; k < 4; k++) { const x = {}; feats.forEach((n, i) => { x[n] = k === 0 ? 0.8 + (i % 3) * 0.05 : 0.1 * k + (i % 2) * 0.02; }); recs.push(F.makeRecord({ url: 'https://x/' + g + '/' + k, gap_id: 'g' + g, name: 'n', label: k === 0 ? 1 : 0, source: k === 0 ? 'user_adopt' : 'user_reject', features: x })); }
    const saved = fa._unitCatalogFeedbackStore; fa._unitCatalogFeedbackStore = F.append(F.emptyStore(), recs);
    const cs = await route('POST', '/api/train/start', { kind: 'colu', name: 'colu-gui' }); ck('colu 開始（符號式走 cpu-js）', cs.ok && cs.sym && cs.total === 4, cs);
    const cdone = await until(async () => { const s = await route('GET', '/api/train/sym-status'); return s.state === 'finished' || s.state === 'error' ? s : null; }, 30000);
    ck('colu 訓練完成並存成資產（真 rawfs 儲存層）', cdone && cdone.state === 'finished' && !!(await store.loadManifest('colu', 'colu-gui')), cdone);
    const ca = await store.loadAsset('colu', 'colu-gui'); R.coluEval = ca && ca.asset.manifest.eval;
    ck('資產 manifest.eval 有交叉驗證成績與 owner=user', ca && ca.asset.manifest.eval && ca.asset.manifest.eval.kind === 'cv_f1' && ca.asset.manifest.owner === 'user', R.coluEval);
    fa._unitCatalogFeedbackStore = saved;

    // ===== uml：可暫停／繼續 =====
    const fx = FaUmlBench.FIXTURES; const pairs = []; for (let i = 0; i < 40; i++) { const f = fx[i % fx.length]; const r = await FaUml.scenarioToModel(f.scenario, {}); if (r.ok) pairs.push({ scenario: f.scenario + ' #' + i, model: r.model }); }
    const enc = (o) => new TextEncoder().encode(o); const files = { 'data/pairs.jsonl': enc(pairs.map((p) => JSON.stringify(p)).join('\n')) };
    await store.saveAsset({ manifest: FaStudio.FaStudioAsset.createManifest({ kind: 'uml', name: 'pairs-gui', files, counts: { pairs: pairs.length }, owner: 'user' }), files }, { replace: true });
    const us = await route('POST', '/api/train/start', { kind: 'uml', name: 'uml-gui', fromAsset: 'uml/pairs-gui' }); ck('uml 從資產取情境對開始', us.ok && us.total === pairs.length, us);
    const pz = await route('POST', '/api/train/sym-pause', {}); const stp = await route('GET', '/api/train/sym-status');
    ck('暫停：停在段與段之間（或已做完）', pz.ok !== false ? (stp.state === 'paused' || stp.state === 'finished') : /沒有執行中/.test(pz.error), { pz, stp: { state: stp.state, done: stp.done } });
    if (stp.state === 'paused') { const d0 = stp.done; await wait(300); const s2 = await route('GET', '/api/train/sym-status'); ck('暫停期間進度不動', s2.done === d0, { d0, now: s2.done }); const rs = await route('POST', '/api/train/sym-resume', {}); ck('繼續', rs.ok); }
    const udone = await until(async () => { const s = await route('GET', '/api/train/sym-status'); return s.state === 'finished' || s.state === 'error' ? s : null; }, 30000);
    ck('uml 完成並寫資產（收錄數＝情境對數）', udone && udone.state === 'finished' && udone.result.counts.accepted + udone.result.counts.rejected === pairs.length, udone);

    // ===== trainer 蒸餾（真的對這個全新使用者資料夾的離線訓練器整理）=====
    const ts = await route('POST', '/api/train/start', { kind: 'trainer', name: 'trainer-gui' }); ck('trainer 蒸餾啟動', ts.ok && ts.total === 3, ts);
    const tdone = await until(async () => { const s = await route('GET', '/api/train/sym-status'); return s.state === 'finished' || s.state === 'error' ? s : null; }, 60000);
    ck('trainer：存下 -before 與整理後兩份資產', tdone && tdone.state === 'finished' && !!(await store.loadManifest('trainer', 'trainer-gui')) && !!(await store.loadManifest('trainer', 'trainer-gui-before')), tdone);
    const bs = await route('POST', '/api/train/start', { kind: 'blockly', name: 'b-gui' }); ck('blockly 沒題目：409 寫格式', bs._s === 409 && /tasks\.jsonl/.test(bs.error), bs);

    // ===== 老師迴圈（不連線上 AI；把 _runSubAgentTask 換成會呼叫白名單工具的替身，驗證接線）=====
    const tinfo = await route('GET', '/api/teacher'); ck('老師已實作且列七個白名單工具', tinfo.implemented && tinfo.tools.length === 7, tinfo);
    const plan = await route('POST', '/api/teacher/plan', { kind: 'uml', goal: '補 uml 情境', fromAsset: 'uml/pairs-gui', target: 'uml-teach-gui' }); ck('plan 算出缺口與要送出的內容', plan.ok && plan.session.preview.bytes > 100 && /不送出/.test(plan.session.preview.prompt), plan.error);
    const sid = plan.session.id; const nc = await route('POST', '/api/teacher/run', { id: sid }); ck('沒確認不送', nc._s === 400 && nc.needsConfirm);
    const orig = fa._runSubAgentTask; let seen = null; const good = pairs[0];
    fa._runSubAgentTask = async (prompt, rounds, opts) => {
        seen = { allowed: opts.allowedToolNames.slice(), registered: opts.allowedToolNames.every((n) => !!fa.tools[n]), promptHas: /目標/.test(prompt), sys: /老師/.test(opts.systemPrompt) };
        const add = await fa.tools.studio_dataset_add.callback({ rows: [{ scenario: '全新情境 A', model: good.model }, { scenario: '標留出', model: good.model, split: 'heldout' }, { scenario: '壞', model: { actors: [], classes: [{ name: 'bad' }], usecases: [], relations: [] } }] });
        seen.add = add; seen.gap = await fa.tools.studio_gap_report.callback({}); seen.list = await fa.tools.studio_dataset_list.callback({}); return { text: '{"status":"done"}' };
    };
    const run = await route('POST', '/api/teacher/run', { id: sid, confirmed: true, previewHash: plan.session.preview.hash }); fa._runSubAgentTask = orig;
    ck('白名單恰七個、已註冊進工具表、系統提示是老師規則', seen && seen.allowed.length === 7 && seen.registered && seen.sys && seen.promptHas, seen && { a: seen.allowed, r: seen.registered });
    ck('驗證才收：好的收、heldout／壞設計被拒並有原因', run.ok && run.session.counts.accepted === 1 && seen.add.results[1].error && /split 只能是 train/.test(seen.add.results[1].error) && /程式驗證沒過/.test(seen.add.results[2].error), seen && seen.add);
    ck('結束後白名單工具已從工具表移除（不留在一般對話）', Object.keys(fa.tools).filter((n) => /^studio_(dataset|gap)/.test(n)).length === 0);
    ck('尚未寫入資產、也沒開始訓練', !(await store.loadManifest('uml', 'uml-teach-gui')) && (await route('GET', '/api/train/sym-status')).state !== 'running');
    const cm = await route('POST', '/api/teacher/commit', { id: sid }); const ta = await store.loadAsset('uml', 'uml-teach-gui'); ck('commit 才寫入 data/teacher.jsonl（author:teacher）', cm.ok && ta && /"author":"teacher"/.test(new TextDecoder().decode(ta.asset.files['data/teacher.jsonl'])), cm);
    // 真的線上 AI 路徑（沒有模型時）：要誠實失敗，不崩
    fa._runSubAgentTask = async () => { throw new Error('沒有可用的線上模型（評估用替身）'); };
    const plan2 = await route('POST', '/api/teacher/plan', { kind: 'uml', goal: '無模型' }); const run2 = await route('POST', '/api/teacher/run', { id: plan2.session.id, confirmed: true, previewHash: plan2.session.preview.hash }); fa._runSubAgentTask = orig;
    R.noModel = run2.session && { state: run2.session.state, log: run2.session.log.slice(-2) };
    ck('沒有可用線上模型時：狀態 blocked／no_improvement 並寫原因，不崩', run2.ok && ['blocked', 'no_improvement', 'done'].includes(run2.session.state), run2);
    ck('colu 不給老師代做、寫原因', (await route('POST', '/api/teacher/plan', { kind: 'colu' }))._s === 409);

    // ===== 資料匯入輸入欄位（真 rawfs：臨時資料夾，多資料夾）=====
    const sep = (await fa._nrBox()).indexOf('\\') >= 0 ? '\\' : '/'; const udir = (await fa._nrBox()).replace(/[\\/][^\\/]+$/, ''); const base = udir + sep + 'gui-ingest-test'; const rf = window.desktopAPI.rawfs;
    await rf.mkdir(base + sep + 'w1'); await rf.mkdir(base + sep + 'w2');
    await rf.writeFile(base + sep + 'w1' + sep + 'a.md', { text: '# 安裝訓練工作室\n\n這份文件說明如何安裝並啟動訓練工作室。需要先準備好基底模型與訓練資料，然後依照步驟執行訓練，最後把結果匯出成訓練包。安裝完成後可以在資產清單看到所有資產，並用評量分頁確認品質是否達到上線門檻。\n\n## 注意事項\n\n訓練期間請保持電腦通電，並確認磁碟空間足夠。如果中途需要暫停，可以按暫停鈕，之後再繼續。' });
    await rf.writeFile(base + sep + 'w2' + sep + 'b.md', { text: '# 匯出訓練包\n\n匯出訓練包到另一台電腦繼續訓練時，需要先確認基底模型、秩、提示格式版本與資料雜湊是否一致。如果不一致，系統會建議另存新名稱，不會直接覆蓋原本的資產，以免失去已經訓練好的結果。\n\n## 分片\n\n大檔會自動切成不超過二十 MB 的分片，匯入時再合併並逐檔核對雜湊。' });
    const ing = await route('POST', '/api/ingest/from', { source: 'wiki', lines: base + sep + 'w1\n' + base + sep + 'w2' });
    ck('真路徑多資料夾 → 語料塊，輸入來源各有檔數與位元組', ing.ok && ing.stats.chunks >= 2 && ing.inputs.length === 2 && ing.inputs.every((s) => s.ok && s.files === 1 && s.bytes > 100), ing.inputs || ing);
    const nu = await route('POST', '/api/ingest/from', { source: 'wiki', lines: 'https://github.com/o/r/wiki' }); ck('網址沒確認：不連網，列出要連線的網址', nu._s === 400 && nu.needsConfirm && nu.urls[0].host === 'raw.githubusercontent.com', nu);
    const badp = await route('POST', '/api/ingest/from', { source: 'wiki', lines: base + sep + 'nope' }); ck('不存在的路徑：409 與原因', badp._s === 409 && badp.sources[0].error, badp);
    const nofap = await route('POST', '/api/ingest/from', { source: 'wiki', lines: 'fap:不存在的資料夾' }); ck('不存在的 fap：409 與原因', nofap._s === 409 && nofap.sources[0].error, nofap);
    for (const old of (await route('GET', '/api/ingest/pins')).pins) await route('POST', '/api/ingest/unpin', { id: old.id }); // 這個環境的偏好會跨次執行保留，先清掉別次留下的釘選
    const pin = await route('POST', '/api/ingest/pin', { type: 'path', value: base + sep + 'w1', label: 'w1' }); const pins = await route('GET', '/api/ingest/pins'); ck('釘選存進偏好', pin.ok && pins.pins.length === 1 && pins.can.path && pins.can.url, { pin, pins });
    try { await rf.remove(base, true); } catch (_) { /* */ }

    // ===== 真的畫面文字（同源探測框）=====
    const probe = async (tab, act) => {
        const L = FaStudio.FaStudioLayout; const d = L.defaults(); const all = d.panes.left.concat(d.panes.right).filter((x) => x !== tab); await route('POST', '/api/prefs', { layout: { panes: { left: [tab].concat(all.slice(0, 4)), right: all.slice(4) }, split: 0.9 } });
        const iframe = document.createElement('iframe'); iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals'); iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:900px';
        const cfg = { hosts: ['mock.local'], prefixes: null, block: true, allow_hosts: [], deny: fa._sandboxDenyHosts(), backend: 'iframe' }; const shim = '<script>(' + __faMockShim.toString() + ')(' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ')</' + 'script>';
        iframe.srcdoc = FA_STUDIO_VIEWER_HTML.replace('__CFG__', () => JSON.stringify({ title: '探測' }).replace(/</g, '\\u003c')).replace('__SHIM__', () => shim).replace('__LAYOUT__', () => FA_STUDIO_LAYOUT_SRC.replace(/<\/script/gi, '<\\/script'));
        const onMsg = (ev) => { const m = ev.data; if (!m || m.__fa_mock !== 1 || ev.source !== iframe.contentWindow) return; const src = ev.source; srv.handle(m, (r, tr) => { try { src.postMessage(Object.assign({ __fa_mock_r: 1 }, r), '*', tr || []); } catch (_) { /* */ } }); };
        window.addEventListener('message', onMsg); document.body.appendChild(iframe);
        await until(() => iframe.contentDocument && iframe.contentDocument.querySelector('#pL') && iframe.contentDocument.querySelector('#pL').innerText.length > 30, 15000);
        if (act) { await until(() => iframe.contentDocument.querySelector('#pL select'), 15000); await act(iframe.contentDocument); } await wait(600);
        const t = iframe.contentDocument.querySelector('#pL').innerText; window.removeEventListener('message', onMsg); iframe.remove(); return t;
    };
    R.screens = {};
    R.screens.eval = await probe('eval', async (doc) => { const sel = doc.querySelector('#pL select'); sel.value = 'uml'; const b = Array.from(doc.querySelectorAll('#pL button')).find((x) => x.textContent === '跑評量'); b.click(); await until(() => /組有跑/.test(doc.querySelector('#pL').innerText), 15000); });
    ck('評量畫面：每組都列、顯示通過率與門檻與「可上線」判斷', /uml：8／8 組有跑/.test(R.screens.eval) && /門檻 80%/.test(R.screens.eval) && /(可上線|不可上線)/.test(R.screens.eval) && !/尚未實作/.test(R.screens.eval), R.screens.eval.slice(0, 500));
    R.screens.teacher = await probe('teacher'); ck('老師畫面：寫明規則、工具、上限，且不再說尚未實作', /studio_dataset_add/.test(R.screens.teacher) && /留出|驗證/.test(R.screens.teacher) && !/尚未實作/.test(R.screens.teacher), R.screens.teacher.slice(0, 400));
    R.screens.train = await probe('train', async (doc) => { const sel = doc.querySelector('#pL select'); sel.value = 'matrix'; sel.dispatchEvent(new Event('change')); await wait(800); }); ck('訓練畫面（矩陣層）：有開始／暫停／繼續／停止，不再說尚未實作', /開始/.test(R.screens.train) && /暫停/.test(R.screens.train) && /繼續/.test(R.screens.train) && /L4–L6/.test(R.screens.train) && !/尚未實作/.test(R.screens.train), R.screens.train.slice(0, 400));
    R.screens.ingest = await probe('ingest'); ck('匯入畫面：有輸入欄位與釘選說明', /輸入欄位/.test(R.screens.ingest) && /fap:/.test(R.screens.ingest) && /清洗這些輸入/.test(R.screens.ingest), R.screens.ingest.slice(0, 400));
    await route('POST', '/api/prefs', { reset: true });
    R.ok = R.checks.every((c) => c.ok); R.failed = R.checks.filter((c) => !c.ok); R.counts = { total: R.checks.length, failed: R.failed.length };
    const cut = (x, n) => String(x == null ? '' : x).slice(0, n);
    return { ok: R.ok, counts: R.counts, passed: R.checks.filter((c) => c.ok).map((c) => c.name), failed: R.failed.map((c) => ({ name: c.name, extra: cut(JSON.stringify(c.extra), 400) })), judge: R.judge, coluEval: R.coluEval && { kind: R.coluEval.kind, pass: R.coluEval.pass }, noModel: R.noModel, eval: R.eval, screens: Object.fromEntries(Object.keys(R.screens).map((k) => [k, cut(R.screens[k].split(String.fromCharCode(10)).join(" | "), 700)])) };
})();
