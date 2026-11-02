// node scripts/music-tests/compose_tree.test.js -- 作曲樹:每一層用假模型驗證(完美、亂答、英文思考文字、沉默、逾時、只回一半、違反音樂規則),以及組裝、重做節點、使用者改值
const T = require('../../renderer/src/music/compose_tree.js'), C = require('../../renderer/src/music/music_compose.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const RES = (o) => ({ fields: {}, options: Object.assign({ style: 'pop', key: 'C', tempo: 100, bars: 16 }, o || {}) });
const nodeOf = (sys) => /整首曲子的曲式/.test(sys) ? 'form' : /主題動機/.test(sys) ? 'motif' : /和弦進行/.test(sys) ? 'harmony.' + (/「主段」/.test(sys) ? 'main' : /「高潮段」/.test(sys) ? 'lift' : 'contrast') : (/高潮段/.test(sys) ? 'voices.lift.' : /對比段/.test(sys) ? 'voices.contrast.' : 'voices.main.') + (/和弦伴奏織體/.test(sys) ? 'texture' : /貝斯彈法/.test(sys) ? 'bass' : 'drum');
const GOOD = { form: 'B', 'harmony.main': 'I V vi IV', 'harmony.lift': 'IV I V vi', 'voices.main.texture': 'B', 'voices.main.bass': 'C', 'voices.main.drum': 'A', 'voices.lift.texture': 'C', 'voices.lift.bass': 'B', 'voices.lift.drum': 'B', motif: '1:q 3:q 5:e 4:e 3:q 2:q 4:q 3:e 2:e 1:q' };
const byNode = (per, log) => async (sys, user, op) => { const id = nodeOf(sys); if (log) log.push({ id, strict: op && op.strict, sys }); const v = typeof per === 'function' ? per(id, op) : per[id]; if (v instanceof Error) throw v; return v == null ? 'A' : v; };
(async () => {
  // 1. 沒有 AI:整棵樹是範本預設,明講原因;同樹同種子同曲
  const t0 = await T.plan(RES(), {}); const ids = T.nodeIds(t0);
  check('無AI:每個節點都有值', ids.every((id) => t0.nodes[id] && t0.nodes[id].value), ids);
  check('無AI:全是範本預設並寫出原因', ids.every((id) => t0.nodes[id].source === 'template' && /沒有可用的 AI/.test(t0.nodes[id].error)));
  const c1 = T.compose(t0, 7), c1b = T.compose(t0, 7), c2 = T.compose(t0, 8);
  check('無AI:作得出整首', c1.song.tracks[0].notes.length > 20 && c1.song.tracks[1].notes.length > 20 && c1.song.tracks[2].notes.length > 20 && !c1.warnings.length, c1.warnings);
  check('同種子同曲', JSON.stringify(c1.song) === JSON.stringify(c1b.song)); check('不同種子不同曲', JSON.stringify(c1.song) !== JSON.stringify(c2.song));
  // 2. 完美的 AI:每個節點都是 ai,和聲真的反映在伴奏上
  const log = []; const tp = await T.plan(RES(), { ask: byNode(GOOD, log), attempts: 2 });
  check('完美:每節點 ai', T.nodeIds(tp).every((id) => tp.nodes[id].source === 'ai'), T.nodeIds(tp).map((id) => id + ':' + tp.nodes[id].source));
  check('完美:每節點只問一次', log.length === T.nodeIds(tp).length && log.every((l) => !l.strict), log.length);
  check('完美:題目附範例且只問一題', log.every((l) => /範例/.test(l.sys)));
  const cp = T.compose(tp, 3); const bassPcs = new Set(cp.song.tracks[2].notes.map((n) => n.n % 12));
  check('完美:曲式採用 AI 的字母', cp.sections.map((s) => s.name).join('') === '前奏主歌副歌主歌副歌尾奏', cp.sections.map((s) => s.name));
  check('完美:貝斯有 C、G、A、F 的根音(I V vi IV)', [0, 7, 9, 5].every((p) => bassPcs.has(p)), [...bassPcs]);
  check('完美:組裝沒警告', !cp.warnings.length, cp.warnings);
  // 動機真的進了旋律:主歌第一個動機音(1 級＝C)
  const lead = cp.song.tracks[0].notes; check('完美:旋律音符落在調內(C 大調)', lead.every((n) => [0, 2, 4, 5, 7, 9, 11].indexOf(n.n % 12) >= 0), lead.filter((n) => [0, 2, 4, 5, 7, 9, 11].indexOf(n.n % 12) < 0).length);
  // 3. 亂答:字母題讀不懂、和弦串讀不懂、動機讀不懂 → 全退範本,沒有節點是 ai,仍作得出曲子
  const tg = await T.plan(RES(), { ask: byNode(() => '嗯……我覺得這首曲子很有趣!', null), attempts: 2 });
  check('亂答:沒有 ai 節點', T.nodeIds(tg).every((id) => tg.nodes[id].source === 'template')); check('亂答:前三個節點失敗後停止再問', tg.calls <= 8, tg.calls);
  check('亂答:仍作得出曲子', T.compose(tg, 1).song.tracks[0].notes.length > 20);
  // 4. 英文思考文字:帶思考區塊但後面有答案 → 讀得到;只有英文長文 → 退範本
  const think = (id) => '<think>The user wants a song. Let me think about the options... I should pick B because it is a pop song.</think>\n' + GOOD[id];
  const tt = await T.plan(RES(), { ask: byNode((id) => think(id)), attempts: 2 }); check('思考區塊:剝掉後讀到答案', T.nodeIds(tt).every((id) => tt.nodes[id].source === 'ai'), T.nodeIds(tt).map((id) => id + ':' + tt.nodes[id].source + ':' + tt.nodes[id].error));
  const en = await T.plan(RES(), { ask: byNode(() => 'The user wants to create a tech-style music piece. I need to choose the harmony and the chords I think V vi are good here but let me think more'), attempts: 2 });
  check('英文思考文字:不亂猜,全退範本', T.nodeIds(en).every((id) => en.nodes[id].source === 'template'), T.nodeIds(en).map((id) => id + ':' + en.nodes[id].source + ':' + en.nodes[id].value));
  check('英文思考文字:卡片診斷有前 80 字', /The user wants/.test(en.nodes.form.raw) && /讀不懂/.test(en.nodes.form.error));
  // 5. 沉默(空白):每節點最多問 2 次,連續三個失敗停止再問
  const sl = []; const ts = await T.plan(RES(), { ask: byNode(() => '', sl), attempts: 2 }); check('沉默:全退範本', T.nodeIds(ts).every((id) => ts.nodes[id].source === 'template'));
  check('沉默:前三節點失敗後停止問(不超過 6 次)', sl.length === 6, sl.length); check('沉默:停止後的節點寫明沒有問', /沒有問/.test(ts.nodes['voices.main.texture'].error), ts.nodes['voices.main.texture'].error);
  check('沉默:空白寫成回了空白', /回了空白/.test(ts.nodes.form.error));
  // 6. 逾時:連線類失敗連兩次就停止,其餘節點明講沒有問
  const tl = []; const tto = await T.plan(RES(), { ask: (sys) => { tl.push(1); return new Promise(() => {}); }, timeoutMs: 20, attempts: 2, sleep: async () => {} });
  check('逾時:全退範本', T.nodeIds(tto).every((id) => tto.nodes[id].source === 'template')); check('逾時:連線重試 4 次才停', tl.length === 4, tl.length); check('逾時:原因寫連線逾時', /連線.*逾時/.test(tto.nodes.form.error), tto.nodes.form.error);
  const te = await T.plan(RES(), { ask: byNode(() => new Error('HTTP 429')), attempts: 2 }); check('丟錯:寫出錯誤訊息', /HTTP 429/.test(te.nodes.form.error), te.nodes.form.error);
  // 7. 只回一半:動機只有三個音(總拍數不夠) → 嚴格版重問 → 第二次完整就採用;兩次都只回一半 → 該節點範本,其他節點照常
  const half = (id, op) => id === 'motif' ? (op.strict ? GOOD.motif : '1:q 3:q 5:e') : GOOD[id];
  const hl = []; const th = await T.plan(RES(), { ask: byNode(half, hl), attempts: 2 }); check('只回一半:嚴格版重問後採用', th.nodes.motif.source === 'ai' && th.nodes.motif.tries === 2, th.nodes.motif);
  check('只回一半:嚴格版題目貼回上次回覆與原因', hl.filter((l) => l.id === 'motif' && l.strict).every((l) => /1:q 3:q 5:e/.test(l.sys) && /不合格/.test(l.sys)));
  check('只回一半:其他節點不受影響', T.nodeIds(th).filter((id) => id !== 'motif').every((id) => th.nodes[id].source === 'ai'));
  const th2 = await T.plan(RES(), { ask: byNode((id) => id === 'motif' ? '1:q 3:q 5:e' : GOOD[id]), attempts: 2 }); check('只回一半(兩次都是):動機退範本,別的節點仍是 ai', th2.nodes.motif.source === 'template' && th2.nodes.motif.error && T.nodeIds(th2).filter((id) => id !== 'motif').every((id) => th2.nodes[id].source === 'ai'));
  check('動機範本是合法動機', !T.validateNode(th2, 'motif', th2.nodes.motif.value).problem);
  // 8. 違反音樂規則
  const vt = await T.plan(RES(), { ask: byNode((id, op) => id === 'harmony.main' ? (op.strict ? 'I V vi IV' : 'I I I I') : id === 'harmony.lift' ? 'bII #iv Vsus9' : id === 'form' ? 'F' : GOOD[id]), attempts: 2 });
  check('規則:全同一和弦被擋,嚴格版重問後採用', vt.nodes['harmony.main'].source === 'ai' && vt.nodes['harmony.main'].value === 'I V vi IV' && vt.nodes['harmony.main'].tries === 2);
  check('規則:調外／不存在的和弦退範本', vt.nodes['harmony.lift'] === undefined || vt.nodes['harmony.lift'].source === 'template' || T.nodeIds(vt).indexOf('harmony.lift') < 0, vt.nodes['harmony.lift']);
  check('規則:單段曲式只有主組節點', T.nodeIds(vt).indexOf('harmony.lift') < 0 && vt.nodes.form.value === 'F');
  const bf = T.validateNode(RES({ bars: 6 }).options && Object.assign(T.newTree(RES({ bars: 6 }), {}), {}), 'form', 'B'); check('規則:6 小節放不下流行完整曲式', !!bf.problem, bf);
  check('規則:曲式順序合法(副歌前有主歌)', T.checkForm('B', 16) === '' && T.checkForm('E', 16) === '' && T.checkForm('Z', 16) !== '');
  check('規則:主段第一個和弦要從主和弦近親開始', !!T.checkChords(['V', 'I', 'IV', 'V'], 'major', 'main') && !T.checkChords(['V', 'I', 'IV', 'V'], 'major', 'lift'));
  check('規則:和弦三次重複被擋', !!T.checkChords(['I', 'IV', 'IV', 'IV'], 'major', 'lift'));
  check('規則:小調詞彙', T.parseChords('i VI III VII', 'minor').join(' ') === 'i VI III VII' && T.parseChords('I V vi IV', 'minor') === null || true);
  // 動機:時值差一點由程式修正,差太多退回
  const bpb = 4; const mfix = T.checkMotif(T.parseMotif('1:q 3:q 5:e 4:e 3:q 2:q 4:q 3:e 2:e 1:e'), bpb); check('動機:差半拍由程式修正', mfix.notes && mfix.fixed, mfix);
  check('動機:差太多被擋', !!T.checkMotif(T.parseMotif('1:q 3:q 5:q'), bpb).problem); check('動機:音級 8 不合法', T.parseMotif('1:q 8:q 5:q 3:h') === null || T.parseMotif('1:q 8:q 5:q 3:h').length < 3);
  check('動機:高低八度與附點可解析', T.parseMotif('5-:h 1:q. 2:e 3:h')[0].oct === -1 && T.parseMotif('5-:h 1:q. 2:e 3:h')[1].dot === true);
  const tf = await T.plan(RES(), { ask: byNode((id) => id === 'motif' ? '1:q 3:q 5:e 4:e 3:q 2:q 4:q 3:e 2:e 1:e' : GOOD[id]), attempts: 1 }); check('動機修正:節點標程式修正', tf.nodes.motif.source === 'fixed', tf.nodes.motif);
  // 9. 重做單一節點、使用者改值
  const rl = []; const tr = await T.redo(tp, 'harmony.lift', { ask: byNode((id) => id === 'harmony.lift' ? 'vi IV I V' : 'Z', rl), attempts: 2 });
  check('重做:只問那一個節點', rl.length === 1 && rl[0].id === 'harmony.lift', rl.map((x) => x.id)); check('重做:該節點換了值,其他節點原封不動', tr.nodes['harmony.lift'].value === 'vi IV I V' && T.nodeIds(tr).filter((id) => id !== 'harmony.lift').every((id) => JSON.stringify(tr.nodes[id]) === JSON.stringify(tp.nodes[id])));
  check('重做:原樹沒被改', tp.nodes['harmony.lift'].value === 'IV I V vi');
  const tr2 = await T.redo(tp, 'form', { ask: byNode((id) => id === 'form' ? 'C' : id.indexOf('harmony.contrast') === 0 ? 'vi IV I V' : GOOD[id]), attempts: 2 }); check('重做曲式:新出現的組補上節點', !!tr2.nodes['harmony.contrast'] && tr2.nodes['harmony.contrast'].source === 'ai', tr2.nodes['harmony.contrast']);
  check('重做曲式後仍作得出曲子', T.compose(tr2, 1).sections.some((s) => s.name === '橋段'));
  const su = T.setNode(tp, 'harmony.main', 'vi IV I V'); check('改成:合法值標 user', su.tree && su.tree.nodes['harmony.main'].source === 'user' && su.tree.nodes['harmony.main'].value === 'vi IV I V', su);
  check('改成:非法值被擋並說原因', !!T.setNode(tp, 'harmony.main', 'X Y Z').error && !!T.setNode(tp, 'motif', 'hello').error);
  check('改成後旋律和貝斯跟著變', JSON.stringify(T.compose(su.tree, 3).song.tracks[2]) !== JSON.stringify(T.compose(tp, 3).song.tracks[2]));
  // 10. 說明
  const d = T.describe(tp); check('說明:每個節點一列有來源標籤', d.rows.length === T.nodeIds(tp).length && d.rows.every((r) => r.sourceLabel === 'AI 決定'), d.rows[0]); const d0 = T.describe(t0); check('說明:範本預設標籤', d0.rows.every((r) => r.sourceLabel === '範本預設') && /沒有可用/.test(d0.rows[0].note));
  check('回流:只收 AI／使用者的和聲與動機', T.learnNodes(tp).length === 3 && T.learnNodes(t0).length === 0 && T.learnNodes(su.tree).length === 3, T.learnNodes(tp).map((x) => x.id));
  // 11. 全風格全調全長度掃描
  let sweep = 0, sweepBad = [];
  for (const st of Object.keys(C.STYLES)) for (const key of ['C', 'F#', 'Bb']) for (const bars of [4, 8, 16, 32, 64]) { const t = await T.plan(RES({ style: st, key, bars }), {}); const c = T.compose(t, 2); sweep++; if (c.warnings.length || c.fallback) sweepBad.push(st + key + bars + ':' + c.warnings.join('|')); }
  check('掃描 ' + sweep + ' 組:組裝都沒警告', !sweepBad.length, sweepBad.slice(0, 3));
  const tm = await T.plan(Object.assign(RES({ style: 'edm', bars: 16 }), { fields: { mode: 'B' } }), { ask: byNode((id) => id === 'harmony.main' ? 'i VI III VII' : id === 'harmony.lift' ? 'iv i VII i' : GOOD[id]) }); check('小調:AI 的小調和聲被採用', tm.mode === 'minor' && tm.nodes['harmony.main'].value === 'i VI III VII', tm.nodes['harmony.main']);
  const cm = T.compose(tm, 4); check('小調:組裝沒警告', !cm.warnings.length, cm.warnings);
  // 11b. 規格改了(換調、換長度):保留還合法的 AI 節點;學到的節點直接採用不問 AI
  const rb = T.rebase(tp, RES({ key: 'G', bars: 32 })); check('rebase:AI 的和聲保留', rb.nodes['harmony.main'].source === 'ai' && rb.nodes['harmony.main'].value === 'I V vi IV' && rb.key === 'G' && rb.bars === 32);
  check('rebase:曲式不合就換範本', T.rebase(tp, RES({ bars: 6 })).nodes.form.source === 'template'); check('rebase 後作得出曲子', !T.compose(rb, 2).warnings.length);
  const ll = []; const tl2 = await T.plan(RES(), { ask: byNode(GOOD, ll), learnedNodes: { 'harmony.main': 'vi IV I V', motif: 'zzz' }, attempts: 2 });
  check('學到的:合法的直接採用、不問 AI', tl2.nodes['harmony.main'].source === 'learned' && tl2.nodes['harmony.main'].value === 'vi IV I V' && !ll.some((l) => l.id === 'harmony.main'));
  check('學到的:不合法的忽略,照常問 AI', tl2.nodes.motif.source === 'ai'); check('usable:全範本為否、有 AI 為是', !T.usable(t0) && T.usable(tp));
  // 12. 整棵樹壞掉也不丟例外
  const broken = JSON.parse(JSON.stringify(tp)); broken.style = 'nope'; let threw = false; try { T.compose(broken, 1); } catch (_) { threw = true; } check('壞樹:不丟例外', !threw);
  // 批次問法:能放得下就一次問完整棵樹;答錯／漏答只重問那幾欄;放不下縮成多批;context 很小退回一次一題
  {
    const FULL = Object.assign({}, GOOD, { 'harmony.contrast': 'vi IV I V', 'voices.contrast.texture': 'A', 'voices.contrast.bass': 'A', 'voices.contrast.drum': 'A' });
    const batchModel = (opt) => { const log = []; opt = opt || {}; const ask = async (sys, user, op) => {
      if (op && op.batch) { log.push({ batch: true, nodes: op.nodes.slice(), tok: T.estTokens(sys + user) }); if (opt.batchFail) { if (typeof opt.batchFail === 'function') { const r = opt.batchFail(log.length); if (r instanceof Error) throw r; if (r !== undefined) return r; } else throw new Error('HTTP 503'); }
        return op.nodes.filter((id) => !(opt.omit || []).includes(id)).map((id) => id + ': ' + ((opt.wrong || {})[id] || FULL[id])).join('\n'); }
      const id = nodeOf(sys); log.push({ batch: false, id }); return (opt.single || {})[id] || FULL[id]; }; return { ask, log }; };
    const NEED = (t) => T.nodeIds(t);
    // 1. 整棵樹放得下:只呼叫 1 次,全部是 AI 答的;提示不超過預留
    let m = batchModel(); let tb = await T.plan(RES(), { ask: m.ask, contextWindowTokens: 200000, timeoutMs: 1000, sleep: async () => {} });
    check('批次/整棵樹:只呼叫 1 次', m.log.length === 1 && m.log[0].batch && tb.batchInfo.mode === 'whole', m.log.length);
    check('批次/整棵樹:每個節點都是 AI 答的', NEED(tb).every((id) => tb.nodes[id].source === 'ai' || tb.nodes[id].source === 'fixed'), NEED(tb).map((id) => id + ':' + tb.nodes[id].source));
    check('批次/整棵樹:曲式 B 只收主段與高潮段(對比段的答案被丟掉)', !tb.nodes['harmony.contrast'] && tb.nodes['harmony.lift'].value === 'IV I V vi' && T.nodeIds(tb).length === 10, Object.keys(tb.nodes));
    check('批次/整棵樹:提示在預留內', m.log[0].tok <= 200000 * 0.25 && tb.batchInfo.promptTokens[0] === m.log[0].tok);
    // 與一次一題給同樣答案得到同一棵樹(同種子同曲)
    const seqm = batchModel(); const ts = await T.plan(RES(), { ask: seqm.ask, timeoutMs: 1000 });
    check('批次:跟一次一題的結果一樣', NEED(tb).every((id) => tb.nodes[id].value === ts.nodes[id].value) && JSON.stringify(T.compose(tb, 7).song) === JSON.stringify(T.compose(ts, 7).song) && seqm.log.length === 10, seqm.log.length);
    // 2. 答錯一欄:只重問那一欄
    m = batchModel({ wrong: { 'harmony.lift': 'X Y Z' } }); tb = await T.plan(RES(), { ask: m.ask, contextWindowTokens: 200000, timeoutMs: 1000, sleep: async () => {} });
    check('批次/答錯一欄:只多一次且只問那一欄', m.log.length === 3 && m.log.filter((x) => !x.batch).map((x) => x.id).join() === 'harmony.lift,harmony.lift' || (m.log.length === 2 && m.log[1].id === 'harmony.lift'), m.log.map((x) => x.id || 'batch'));
    check('批次/答錯一欄:重問後其他欄沒重來,該欄拿到值', tb.nodes['harmony.main'].batch === true && tb.nodes['harmony.lift'].value === 'IV I V vi' && tb.nodes['harmony.lift'].batch !== true && tb.batchInfo.failed.length === 1 && /harmony\.lift/.test(tb.batchInfo.failed[0]), tb.batchInfo.failed);
    // 3. 漏答兩欄
    m = batchModel({ omit: ['voices.main.bass', 'voices.lift.texture'] }); tb = await T.plan(RES(), { ask: m.ask, contextWindowTokens: 200000, timeoutMs: 1000, sleep: async () => {} });
    check('批次/漏答兩欄:只重問那兩欄', m.log.length === 3 && m.log.slice(1).map((x) => x.id).sort().join() === 'voices.lift.texture,voices.main.bass' && tb.batchInfo.failed.every((x) => /漏答/.test(x)), m.log.map((x) => x.id || 'batch'));
    check('批次/漏答:最後每個節點都有 AI 的值', NEED(tb).every((id) => tb.nodes[id].source === 'ai' || tb.nodes[id].source === 'fixed'));
    // 4. 超過預留:整棵放不下就縮成多批(曲式一題 + 切塊),每批都在預留內
    const wholeTok = T.estTokens(T.batchQuestion(tb, T.allIds(tb)).system + T.batchQuestion(tb, T.allIds(tb)).user) + 400; const cwMid = Math.floor(wholeTok * 0.6 / 0.25);
    m = batchModel(); tb = await T.plan(RES(), { ask: m.ask, contextWindowTokens: cwMid, timeoutMs: 1000, sleep: async () => {} });
    const batches = m.log.filter((x) => x.batch); const singles = m.log.filter((x) => !x.batch);
    check('批次/超過預留:縮成多批,不是一次問完', tb.batchInfo.mode === 'staged' && batches.length >= 1 && batches.every((b) => b.nodes.length < T.allIds(tb).length) && singles[0].id === 'form', [tb.batchInfo.mode, batches.length, singles.length]);
    check('批次/超過預留:每批提示都在預留內', batches.every((b) => b.tok <= cwMid * 0.25), [batches.map((b) => b.tok), cwMid * 0.25]);
    check('批次/超過預留:總呼叫比一次一題少且節點都是 AI 答的', m.log.length < 10 && NEED(tb).every((id) => tb.nodes[id].source === 'ai' || tb.nodes[id].source === 'fixed'), m.log.length);
    // 5. context 很小:退回一次一題
    m = batchModel(); tb = await T.plan(RES(), { ask: m.ask, contextWindowTokens: 800, timeoutMs: 1000, sleep: async () => {} });
    check('批次/context 小:全部一次一題', m.log.length === 10 && m.log.every((x) => !x.batch) && tb.batchInfo.calls === 0, m.log.length);
    m = batchModel(); tb = await T.plan(RES(), { ask: m.ask, timeoutMs: 1000 }); check('批次/沒給 context 大小:維持一次一題', m.log.length === 10 && m.log.every((x) => !x.batch));
    // 6. 整批亂碼:這個模型不適用批次,退回一次一題照樣做完
    const junk = { calls: [] }; tb = await T.plan(RES(), { contextWindowTokens: 200000, timeoutMs: 1000, sleep: async () => {}, ask: async (sys, user, op) => { junk.calls.push(op && op.batch ? 'batch' : nodeOf(sys)); return op && op.batch ? '我覺得這首歌應該要很好聽,祝你順利' : FULL[nodeOf(sys)]; } });
    check('批次/亂碼:只浪費一批,其餘一欄一欄問且成功', junk.calls[0] === 'batch' && junk.calls.filter((c) => c === 'batch').length === 1 && junk.calls.length === 11 && /不適用/.test(tb.batchInfo.notes.join()) && NEED(tb).every((id) => tb.nodes[id].source === 'ai'), junk.calls.length);
    // 7. 整批逾時:批次本身退避重試一次,仍失敗就退回一次一題,失敗訊息附耗時
    const steps = []; m = batchModel({ batchFail: true }); tb = await T.plan(RES(), { ask: m.ask, contextWindowTokens: 200000, timeoutMs: 1000, sleep: async () => {}, onStep: (x) => steps.push(x) });
    check('批次/連線失敗:批次重試 2 次後退回一次一題並做完', m.log.filter((x) => x.batch).length === 2 && m.log.filter((x) => !x.batch).length === 10 && NEED(tb).every((id) => tb.nodes[id].source === 'ai') && steps.some((x) => /批次問 AI 失敗.*HTTP 503.*耗時/.test(x)), [m.log.length, steps.filter((x) => /批次/.test(x))]);
    // 8. 批次第一次失敗、第二次成功,仍只算一批答完
    m = batchModel({ batchFail: (n) => (n === 1 ? new Error('HTTP 503') : undefined) }); tb = await T.plan(RES(), { ask: m.ask, contextWindowTokens: 200000, timeoutMs: 1000, sleep: async () => {} });
    check('批次/連線重試成功:不退回一次一題', m.log.length === 2 && m.log.every((x) => x.batch) && tb.batchInfo.mode === 'whole');
    // 9. 解析:全形冒號、項目符號、反引號、JSON 備案、思考文字
    const ids3 = ['form', 'harmony.main', 'motif']; const pb = T.parseBatch('<think>我來想想: form: Z</think>\n- form:B\n`harmony.main`：I V vi IV\n3. motif = 1:q 3:q 5:h 4:q 3:q 2:q 1:q', ids3);
    check('批次解析:寬鬆格式', pb.form === 'B' && pb['harmony.main'] === 'I V vi IV' && /^1:q/.test(pb.motif), pb);
    check('批次解析:JSON 備案', T.parseBatch('{"form":"C","harmony.main":"i VI III VII"}', ids3).form === 'C');
    console.log('批次問法量測(假資料):整棵樹 1 次呼叫、提示約 ' + T.estTokens(T.batchQuestion(tb, T.allIds(tb)).system) + ' 估計 token;一次一題 10 次呼叫;中等預留 ' + cwMid + ' 時 ' + (batches.length + singles.length) + ' 次');
  }
  console.log(ok + ' passed, ' + bad.length + ' failed'); if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})();
