// 訓練工作室「內建資產」真 Electron 驗證：用法 node scripts/qrun.js --timeout 300 -- node scripts/eval/real_electron.run.js studio_builtin 17972
// 做法：開工作室（真假伺服器）；再把同一份檢視器文件放進「同源探測框」（只有評估用，正式視窗仍是無 same-origin 的沙盒），接上同一個假伺服器，
// 讀它真的畫出來的文字；並把每個 kind 的數字跟 renderer 裡實際載入的物件（FaDomains／FaPyLessonsBuiltin／FaMatrixSynth／FaUml…）重新算一次比對。
return (async () => {
    const R = { checks: [] }; const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: ok || extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (_) { /* */ } await wait(200); } return null; };
    R.loaded = Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s));
    ck('載入的是工作目錄的 floating-assistant.js', R.loaded.some((s) => /desktop-app[\\/]renderer[\\/]floating-assistant/i.test(decodeURIComponent(s))), R.loaded);
    ck('內建資產提供者已嵌入', typeof FaStudio.FaStudioBuiltin === 'object' && typeof FA_STUDIO_SEED_COUNTS === 'object');
    await fa._studioCommand('');
    await until(() => document.querySelector('.fwd iframe[sandbox]'));
    const srv = await fa._studioServer(); const route = async (m, p, b) => (await srv.core.route(m, new URL('http://mock.local' + p), b)).j;
    const A = await route('GET', '/api/assets'); const G = {}; A.groups.forEach((g) => { G[g.kind] = g; });
    R.counts = A.groups.map((g) => ({ kind: g.kind, counts: g.counts, items: g.items.map((i) => ({ name: i.name, origin: i.origin, counts: i.counts, unavailable: i.unavailable || undefined })) }));
    const nm = FaStudio.FaStudioBuiltin.NAMES; const it = (k, n) => G[k].items.find((x) => x.name === nm[n]);
    // ---- 從 renderer 裡實際載入的物件重新算 ----
    fa._pyDomainsInit(); const packs = FaDomains.list().map((x) => FaDomains.get(x.id));
    const dom = it('blockly', 'blockly_domains');
    ck('領域包數＝FaDomains 實際註冊數', dom.counts.packs === packs.length && packs.length > 0, { shown: dom.counts, actual: packs.length });
    ck('算法數／骨架數＝各包總和', dom.counts.algos === packs.reduce((n, p) => n + (p.algos || []).length, 0) && dom.counts.skeletons === packs.reduce((n, p) => n + (p.skeletons || []).length, 0), dom.counts);
    ck('種子題 train＋holdout＝seeds，且每包都有題數', dom.counts.train + dom.counts.holdout === dom.counts.seeds && packs.every((p) => FA_STUDIO_SEED_COUNTS[p.id] && FA_STUDIO_SEED_COUNTS[p.id].total > 0), { c: dom.counts, missing: packs.filter((p) => !FA_STUDIO_SEED_COUNTS[p.id]).map((p) => p.id) });
    const ls = it('blockly', 'blockly_lessons'); ck('內建課數＝FaPyLessonsBuiltin.lessons.length', ls.counts.lessons === FaPyLessonsBuiltin.lessons.length, { shown: ls.counts, actual: FaPyLessonsBuiltin.lessons.length });
    const mx = it('matrix', 'matrix'); ck('矩陣層合成器數＝FaMatrixSynth.list() 長度', mx.counts.synthesizers === FaMatrixSynth.list().length, { shown: mx.counts, actual: FaMatrixSynth.list().length });
    const um = it('uml', 'uml'); ck('UML 表 actors／design arch 與核心一致', um.counts.uml_actors === (function (v) { return Array.isArray(v) ? v.length : Object.keys(v).length; })(FaUml.ACTORS) && um.counts.design_arch === (function (v) { return Array.isArray(v) ? v.length : Object.keys(v).length; })(FaDesign.ARCH), um.counts);
    const doms = (await fa._otLoad()).domains; const bd = Array.from(doms.values()).filter((d) => d.source === 'builtin');
    const tr = it('trainer', 'trainer'); ck('離線訓練器內建領域／規則數＝IndexedDB 的 builtin 領域', tr.counts.domains === bd.length && tr.counts.patterns === bd.reduce((n, d) => n + (d.patterns || []).length, 0) && bd.length > 0, { shown: tr.counts, actual: bd.length });
    const pf = Object.keys(FA_PRESET_MODEL_STATE).filter((k) => FA_PRESET_MODEL_STATE[k].coluProfile).length; const cp = it('colu', 'colu_profiles'); ck('CoLU 模型體檢數＝內建模型有 coluProfile 的數量', cp.counts.models === pf && pf > 0, { shown: cp.counts, actual: pf });
    const fbk = it('colu', 'colu_feedback'); const fbSt = FaCatalogFeedback.stats(await fa._unitCatalogFeedbackLoad()); ck('CoLU 回饋筆數＝實際儲存', fbk.counts.records === fbSt.records, { shown: fbk.counts, actual: fbSt.records });
    const lo = it('lora', 'lora'); ck('LoRA：資料表現況與嵌入的建置時筆數一致', lo.counts.datasets === FA_STUDIO_LORA_DATA.datasets.length && lo.counts.rows === FA_STUDIO_LORA_DATA.datasets.reduce((n, d) => n + d.rows, 0) && lo.counts.datasets > 0, lo.counts);
    const rt = it('colu', 'colu_route'); R.route = { counts: rt.counts, unavailable: rt.unavailable, summary: rt.summary };
    ck('每個 kind 都有內建項；origin 皆 builtin', ['colu', 'blockly', 'matrix', 'uml', 'trainer', 'lora'].every((k) => G[k].counts.builtin >= 1 && G[k].items.filter((x) => x.origin === 'builtin').length === G[k].counts.builtin));
    // ---- 詳情／瀏覽／匯出位元組／拒刪 ----
    const det = await route('GET', '/api/asset?kind=blockly&name=' + encodeURIComponent(nm.blockly_lessons)); ck('內建詳情唯讀且雜湊通過', det.ok && det.readonly && det.verify.ok, det);
    const fl = await route('GET', '/api/asset-file?kind=blockly&name=' + encodeURIComponent(nm.blockly_lessons) + '&path=' + encodeURIComponent('data/lessons.jsonl')); ck('可瀏覽資料集前 6000 字元', fl.ok && /palindrome/.test(fl.text), fl.text && fl.text.slice(0, 80));
    const dsr = await route('GET', '/api/datasets'); ck('/api/datasets 含內建資料檔', dsr.files.filter((f) => f.readonly).length >= 5, dsr.files.length);
    const dl = []; const h0 = fa._studioHostApi; const exp = FaStudio.FaFatrain.exportAsset((await srv.core.route('GET', new URL('http://mock.local/api/asset?kind=blockly&name=' + encodeURIComponent(nm.blockly_lessons)), {})) && (await fa._studioBuiltin().read('blockly', nm.blockly_lessons)).asset, {}); ck('用 fatrain_core 匯出 .fatrain', exp.ok && exp.bytes.length > 100, exp.error);
    const del = await srv.core.route('POST', new URL('http://mock.local/api/asset/delete'), { kind: 'blockly', name: nm.blockly_lessons, confirmed: true }); ck('刪除內建資產被拒（409）', del.s === 409, del);
    // ---- 真的畫面文字：同源探測框 ----
    const iframe = document.createElement('iframe'); iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals'); iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1100px;height:900px';
    const cfg = { hosts: ['mock.local'], prefixes: null, block: true, allow_hosts: [], deny: fa._sandboxDenyHosts(), backend: 'iframe' };
    const shim = '<script>(' + __faMockShim.toString() + ')(' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ')</' + 'script>';
    iframe.srcdoc = FA_STUDIO_VIEWER_HTML.replace('__CFG__', () => JSON.stringify({ title: '探測' }).replace(/</g, '\\u003c')).replace('__SHIM__', () => shim).replace('__LAYOUT__', () => FA_STUDIO_LAYOUT_SRC.replace(/<\/script/gi, '<\\/script'));
    const onMsg = (ev) => { const d = ev.data; if (!d || d.__fa_mock !== 1 || ev.source !== iframe.contentWindow) return; const src = ev.source; srv.handle(d, (m, transfer) => { try { src.postMessage(Object.assign({ __fa_mock_r: 1 }, m), '*', transfer || []); } catch (_) { /* */ } }); };
    window.addEventListener('message', onMsg); document.body.appendChild(iframe);
    const txt = await until(() => { const t = iframe.contentDocument && iframe.contentDocument.body && iframe.contentDocument.body.innerText; return t && /內建 \d+／我的 \d+／匯入 \d+/.test(t) ? t : null; }, 25000);
    R.screen = txt ? txt.slice(0, 4500) : null;
    ck('畫面出現「內建 N／我的 M／匯入 K」', !!txt, iframe.contentDocument && iframe.contentDocument.body && iframe.contentDocument.body.innerText.slice(0, 600));
    if (txt) {
        ck('畫面不再顯示「0 個」', !/　0 個/.test(txt) && !/還沒有。這個種類的資產由/.test(txt), txt.slice(0, 600));
        ck('畫面寫明 UML 是唯讀內建、不是可訓練資料', /不是使用者可訓練的資料/.test(txt));
        ck('畫面顯示領域包數量與來源檔案', new RegExp(packs.length + ' 個領域包').test(txt) && /uml\/domain_\*_core\.js/.test(txt));
        ck('畫面顯示內建課數量', new RegExp(FaPyLessonsBuiltin.lessons.length + ' 堂課').test(txt));
    }
    window.removeEventListener('message', onMsg); iframe.remove();
    try { document.querySelector('.fwd') && document.querySelector('.fwd').remove(); } catch (_) { /* */ }
    R.ok = R.checks.every((c) => c.ok); R.failed = R.checks.filter((c) => !c.ok);
    return R;
})();
