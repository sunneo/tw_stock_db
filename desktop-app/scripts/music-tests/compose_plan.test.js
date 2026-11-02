// node scripts/music-tests/compose_plan.test.js -- 作曲的「理解需求」:用假 AI(完美、亂答、部分答對、沉默、逾時、丟錯)驗證每一欄與退路
const P = require('../../renderer/src/music/compose_plan.js'), C = require('../../renderer/src/music/music_compose.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const REQ = '建立科技感的音樂 用來描述intel';
// 假模型:看題目是哪一欄,回該欄的字母(per 沒給的欄位回 A);用途那題回一句話
const fieldOf = (sys) => /用一句話/.test(sys) ? 'purpose' : /最適合哪一種風格/.test(sys) ? 'style' : /曲子的情緒/.test(sys) ? 'mood' : /曲子的速度/.test(sys) ? 'speed' : /曲子的調式/.test(sys) ? 'mode' : /主奏樂器/.test(sys) ? 'lead' : /曲子的長度/.test(sys) ? 'bars' : '?';
const byField = (per) => async (sys) => { const k = fieldOf(sys); return per[k] != null ? per[k] : 'A'; };
const PERFECT = { style: 'H', mood: 'G', speed: 'C', mode: 'B', lead: 'G', bars: 'C', purpose: '描述 Intel 的科技感' };
const perfect = byField(PERFECT);
(async () => {
  // 1. 完美的 AI
  let r = await P.decide(REQ, { ask: perfect });
  check('perfect AI: style/mood/speed/mode/lead/bars all come from the AI', r.fields.style === 'edm' && r.fields.mood === 'G' && r.fields.speed === 'C' && r.fields.mode === 'B' && r.fields.lead === 'G' && r.fields.bars === 24 && ['style', 'mood', 'speed', 'mode', 'lead', 'bars'].every((k) => r.sources[k] === 'ai'), [r.fields, r.sources]);
  check('perfect AI: the purpose the user stated is kept (user), and goes into the title', r.fields.purpose === '描述intel' && r.sources.purpose === 'user' && /描述intel/.test(r.options.title), r.options.title);
  check('perfect AI: fast = the template\'s upper tempo, lead program from the list, drum pattern follows the mood', r.options.tempo === C.STYLES.edm.tempo[1] && r.options.lead === 80 && r.options.drumIdx === 1 && r.report.usedAi && !r.report.notes.some((n) => /沒有用 AI/.test(n)), [r.options, r.report.notes]);
  const c1 = C.compose(Object.assign({}, r.options, { seed: 5 })), c2 = C.compose(Object.assign({}, r.options, { seed: 5 }));
  check('perfect AI: the composed song uses the chosen lead and is reproducible from the seed', c1.song.tracks[0].program === 80 && JSON.stringify(c1.song) === JSON.stringify(c2.song));
  // 2. 沒有 AI(離線)
  r = await P.decide(REQ, {});
  check('no AI: rules pick the tech-feel template, the report says so plainly', r.fields.style === 'edm' && r.sources.style === 'rule' && r.fields.mood === 'G' && !r.report.usedAi && r.report.notes[0].indexOf('這次沒有用 AI,用的是範本規則') === 0, r.report.notes);
  check('no AI: the purpose is not thrown away', r.fields.purpose === '描述intel' && /描述intel/.test(r.options.title));
  // 3. 亂答
  r = await P.decide(REQ, { ask: async () => '我覺得很棒!\n{"style":"Z","mood":"??","speed":5,"mode":null,"lead":"x","bars":"Q","purpose":123}' });
  check('chaos answer: every bad field falls back by itself, nothing throws', r.fields.style === 'edm' && r.sources.style === 'rule' && r.fields.bars === 16 && r.sources.bars === 'default' && r.fields.mode === 'C' && r.sources.mode === 'default', [r.fields, r.sources]);
  check('chaos answer with no usable field counts as no AI', !r.report.usedAi && /讀不懂/.test(r.report.aiError), r.report);
  r = await P.decide(REQ, { ask: async () => 'blah blah, no json at all' });
  check('text with no JSON: rules take over', !r.report.usedAi && r.fields.style === 'edm' && /讀不懂/.test(r.report.aiError));
  // 4. 部分答對:只有答對的欄位用 AI,其他退回那一欄的預設
  r = await P.decide('寫一首曲子', { ask: async () => '{"style":"C","mood":"nonsense","speed":"A","mode":"A","lead":"zz","bars":"D","purpose":""}' });
  check('partly right: valid fields are AI\'s, invalid ones fall back one by one', r.fields.style === 'jazz' && r.sources.style === 'ai' && r.sources.speed === 'ai' && r.fields.bars === 32 && r.sources.mood === 'default' && r.fields.mood === null && r.sources.lead === 'default' && r.fields.lead === 'J', [r.fields, r.sources]);
  check('partly right: the report names what fell back', r.report.usedAi && r.report.notes.some((n) => /AI 沒答對的欄位/.test(n)), r.report.notes);
  // 5. 沉默(空字串)與丟錯
  r = await P.decide(REQ, { ask: async () => '', attempts: 2 });
  check('silent AI: each field tried twice, then the rules', r.report.perField.style.tries === 2 && !r.report.usedAi && r.fields.style === 'edm');
  r = await P.decide(REQ, { ask: async () => { throw new Error('HTTP 429'); }, attempts: 2 });
  check('AI error: kept as a concrete fact in the report', /HTTP 429/.test(r.report.aiError) && r.report.notes[0].indexOf('HTTP 429') > 0, r.report);
  // 6. 逾時
  const t0 = Date.now(); r = await P.decide(REQ, { ask: () => new Promise(() => {}), timeoutMs: 60, attempts: 2, sleep: async () => {} });
  check('timeout: gives up after the limit (4 connection tries) and falls back to the rules', Date.now() - t0 < 1500 && /逾時/.test(r.report.aiError) && !r.report.usedAi && r.fields.style === 'edm', [Date.now() - t0, r.report.aiError]);
  // 7. 第一次失敗第二次成功(暫時性失敗自己重試)
  let n = 0; r = await P.decide(REQ, { ask: async (sys) => { n++; if (n === 1) throw new Error('HTTP 503'); return perfect(sys); }, attempts: 2 });
  check('a transient failure is retried once and the second answer is used', r.report.usedAi && r.report.perField.style.tries === 2 && r.sources.style === 'ai');
  // 8. 使用者自己說的優先於 AI
  r = await P.decide('來一首爵士,D 調,90 bpm,12 小節,用小提琴', { ask: perfect });
  check('what the user said beats the AI: style, key, tempo, bars, lead', r.fields.style === 'jazz' && r.sources.style === 'user' && r.fields.key === 'D' && r.sources.key === 'user' && r.options.tempo === 90 && r.fields.bars === 12 && r.fields.lead === 'D' && r.sources.lead === 'user', [r.fields, r.sources]);
  r = await P.decide('寫一首曲子', { ask: perfect, explicit: { style: 'waltz', tempo: 100, bars: 8, key: 'F' } });
  check('explicit tool parameters count as the user\'s', r.fields.style === 'waltz' && r.sources.style === 'user' && r.options.tempo === 100 && r.fields.bars === 8 && r.fields.key === 'F');
  // 9. 作曲家(程式規則對到最接近的範本並講明;AI 也可以選)
  r = await P.decide('寫一首貝多芬風格的曲子', {});
  check('composer without AI: closest template, said out loud', r.fields.style === 'classical' && r.report.notes.some((x) => /貝多芬/.test(x) && /古典/.test(x)), r.report.notes);
  // 10. 調式與範本衝突要講明,不假裝做到
  r = await P.decide('寫一首小調的流行歌', {});
  check('mode the template cannot do is reported, the template wins', r.fields.style === 'pop' && r.report.notes.some((x) => /小調/.test(x) && /以範本為準/.test(x)), r.report.notes);
  // 11. 改成…:改的欄位標成 user,其他不動,同種子同曲
  const base = await P.decide(REQ, { ask: perfect }), ed = P.edit(base, { bars: 8, lead: 'A', style: 'jazz' });
  check('edit: changed fields become user, the rest stay as they were', ed.fields.bars === 8 && ed.sources.bars === 'user' && ed.fields.style === 'jazz' && ed.sources.lead === 'user' && ed.sources.mood === 'ai' && ed.options.lead === 0, [ed.fields, ed.sources]);
  check('edit: an unknown style is ignored', P.edit(base, { style: 'nope' }).fields.style === 'edm');
  check('edit: a tempo number overrides the slow/mid/fast choice', P.edit(base, { tempo: 77 }).options.tempo === 77 && P.edit(base, { tempo: 77 }).sources.tempo === 'user');
  { const bt = await P.decide('來一首爵士,90 bpm', {}); const e2 = P.edit(bt, { speed: 'A' }); check('edit: choosing slow/mid/fast drops the bpm number the user gave earlier', e2.fields.tempo === null && e2.options.tempo === C.STYLES.jazz.tempo[0] && e2.sources.speed === 'user', [e2.fields, e2.options]); }
  // 12. 說明卡片
  const d = P.describe(base, 1234);
  check('describe: every field with value and source, plus template and seed', d.rows.length === 8 && d.rows.find((x) => x.key === 'style').sourceLabel === 'AI 選的' && d.rows.find((x) => x.key === 'purpose').sourceLabel === '你說的' && d.seed === 1234 && d.template === '電子舞曲', d);
  // 13. parseLetter 寬容解析
  const pl = (raw, k) => P.parseLetter(raw, k || 'style');
  check('parseLetter: plain, lower-case single letter, "H. text", quoted and JSON forms', pl('H') === 'H' && pl('h') === 'H' && pl('H. 電子舞曲') === 'H' && pl('"G"', 'mood') === 'G' && pl('{"mood":"g"}', 'mood') === 'G' && pl('**B**', 'speed') === 'B');
  check('parseLetter: think blocks are stripped, the answer after them is found', pl('<think>The user wants A tech piece... maybe C</think>\nH') === 'H' && pl('<think>hmm</think>答案:E', 'mood') === 'E');
  check('parseLetter: an unclosed think block or long English reasoning gives nothing (no guessing)', pl('<think>The user wants tech music, so A or B') === null && pl('The user wants to create tech-style music for describing Intel. A tech feel means electronic. So the style is') === null);
  check('parseLetter: "答案是 H" and the option name alone are understood; out-of-range letters are refused', pl('我想了一下,答案是 H') === 'H' && pl('電子舞曲') === 'H' && pl('Z') === null && pl('J', 'mood') === null && pl('') === null);
  check('parsePurpose: one short line; thinking text and over-long text are refused; 無 means none', P.parsePurpose('簡報開場') === '簡報開場' && P.parsePurpose('無') === '' && P.parsePurpose('The user wants a piece') === null && P.parsePurpose('一二三四五六七八九十'.repeat(5)) === null);
  // 14. 六種情況(假模型測試法):完美、亂答、英文思考文字、沉默、逾時、只回一半 -- 每種的欄位來源與退路
  const THINK = 'The user wants to create tech-style music to describe Intel. Let me think about which style fits. A tech feel suggests electronic';
  { const asked = []; r = await P.decide(REQ, { ask: async (sys, usr, op) => { asked.push([fieldOf(sys), op && op.strict]); return perfect(sys); } });
    check('six cases / perfect: one question per field (the purpose the user stated is not asked), 6 calls, none strict, every field from the AI', asked.length === 6 && asked.every((x) => !x[1]) && ['style', 'mood', 'speed', 'mode', 'lead', 'bars'].every((k) => r.sources[k] === 'ai' && r.report.perField[k].ok), asked); }
  { const calls = []; r = await P.decide(REQ, { ask: async (sys, usr, op) => { calls.push([fieldOf(sys), !!(op && op.strict), sys]); return '亂七八糟 !!! ###'; } });
    check('six cases / chaos: each field tried twice (second one strict, quotes the previous reply), then that field alone falls back', calls.filter((c) => c[0] === 'style').length === 2 && calls.filter((c) => c[0] === 'style')[1][1] === true && calls.filter((c) => c[0] === 'style')[1][2].indexOf('亂七八糟') > 0 && calls.filter((c) => c[0] === 'style')[0][2] !== calls.filter((c) => c[0] === 'style')[1][2] && r.fields.style === 'edm' && r.sources.style === 'rule', calls.length);
    check('six cases / chaos: the report says which field failed and what the model said', !r.report.usedAi && /「style」/.test(r.report.aiError) && /亂七八糟/.test(r.report.aiError) && r.report.perField.style.tries === 2, r.report.aiError); }
  { const calls = []; r = await P.decide(REQ, { ask: async (sys) => { calls.push(fieldOf(sys)); return THINK; } });
    check('six cases / English thinking text: not understood, strict retry, rules take over, report shows the start of the text and stops asking after three dead fields', !r.report.usedAi && r.fields.style === 'edm' && /The user wants/.test(r.report.aiError) && calls.length === 6 && r.report.perField.mode.error.indexOf('沒有問') === 0, [calls.length, r.report.aiError]); }
  { let n = 0; r = await P.decide(REQ, { ask: async (sys, usr, op) => { n++; if (!(op && op.strict)) return THINK; return perfect(sys); } });
    check('six cases / thinking first, strict retry succeeds: AI is used for every field', r.report.usedAi && ['style', 'mood', 'speed', 'mode', 'lead', 'bars'].every((k) => r.sources[k] === 'ai') && n === 12, n); }
  { r = await P.decide(REQ, { ask: async () => '', attempts: 2 });
    check('six cases / silent: the report says blank and rules are used', !r.report.usedAi && /空白/.test(r.report.aiError) && r.fields.style === 'edm' && r.sources.style === 'rule'); }
  { const t1 = Date.now(); r = await P.decide(REQ, { ask: () => new Promise(() => {}), timeoutMs: 40, attempts: 2, sleep: async () => {} });
    check('six cases / timeout: stops after the first field uses up 4 connection tries (not 7 fields x tries)', Date.now() - t1 < 2000 && /逾時/.test(r.report.aiError) && /耗時/.test(r.report.aiError) && r.report.calls === 4 && r.report.perField.mood.error.indexOf('沒有問') === 0, r.report.calls); }
  { r = await P.decide(REQ, { ask: async (sys) => { const k = fieldOf(sys); return k === 'style' ? 'H' : k === 'mood' ? 'G' : k === 'speed' ? 'The user' : ''; } });
    check('six cases / half answered: answered fields are the AI\'s, the others fall back one by one with a note naming them', r.report.usedAi && r.sources.style === 'ai' && r.sources.mood === 'ai' && r.sources.bars === 'default' && r.sources.lead !== 'ai' && r.report.notes.some((n) => /AI 沒答對的欄位/.test(n) && /speed/.test(n)), r.report.notes); }
  { const asked = []; r = await P.decide('來一首爵士,90 bpm,12 小節,用小提琴,小調', { ask: async (sys) => { asked.push(fieldOf(sys)); return perfect(sys); } });
    check('fields the user already decided are not asked', asked.indexOf('style') < 0 && asked.indexOf('speed') < 0 && asked.indexOf('bars') < 0 && asked.indexOf('lead') < 0 && asked.indexOf('mode') < 0 && asked.indexOf('mood') >= 0, asked); }
  // 15. 經驗回流:接受的結果 → 類似說法下次直接用,不再問 AI(只收使用者說的、AI 選的,程式猜的與預設不收)
  { const acc = await P.decide(REQ, { ask: perfect }); const picks = P.learnPicks(acc);
    check('learnPicks: letters of the fields that AI/user decided; mode "auto" and guesses are not learned', picks.style === 'H' && picks.mood === 'G' && picks.speed === 'C' && picks.lead === 'G' && picks.bars === 'C' && picks.mode === 'B', picks);
    const entries = [{ task: REQ, picks }]; let asked = 0;
    const r2 = await P.decide('建立科技感的音樂 用來描述 intel 產品', { ask: async (s) => { asked++; return perfect(s); }, learned: (t) => P.matchLearned(t, entries) });
    check('learned: a similar request takes the accepted picks and asks the AI nothing', asked === 0 && r2.sources.style === 'learned' && r2.fields.style === 'edm' && r2.report.notes.some((n) => /以前接受過/.test(n)), [asked, r2.sources]);
    check('learned: an unrelated request does not match', P.matchLearned('來一首悲傷的圓舞曲給婚禮', entries) === null && P.matchLearned('', entries) === null);
    const r3 = await P.decide('建立科技感的音樂 用來描述 intel 產品', { learned: () => ({ style: 'ZZ', mood: 'G' }), ask: perfect });
    check('learned: invalid letters in a stored entry are ignored', r3.sources.mood === 'learned' && r3.sources.style === 'ai'); }
  check('every composed result passes the program\'s own checks (no warnings) for several seeds', [1, 2, 3, 4].every((sd) => C.compose(Object.assign({}, base.options, { seed: sd })).warnings.length === 0));
  { // 暫時性連線失敗:前兩次逾時／503,第三次才好 → 仍用 AI,不退回範本;逾時值一次比一次長;讀不懂的次數不被連線失敗吃掉
    let n = 0; const tmos = []; const slept = []; let q = 0;
    r = await P.decide(REQ, { timeoutMs: 100, attempts: 2, sleep: async (ms) => { slept.push(ms); }, ask: (sys, user, op) => { n++; if (n === 1) return new Promise(() => {}); if (n === 2) return Promise.reject(new Error('API錯誤(503): Service temporarily overloaded')); return Promise.resolve('A'); } });
    check('transient: timeout then 503 then ok on the same field -> AI still used', r.report.usedAi && r.report.perField.style.ok && r.report.perField.style.tries === 3 && slept.length === 2 && slept[1] > slept[0], [r.report.perField.style, slept]); }
  { const u = '創作midi 音樂，以搖滾卡農跟final fantasy的風格演奏, 3分鐘';
    check('repeat guard: first compose in a turn is allowed', P.repeatGuard(u, 0) === ''); check('repeat guard: second compose for the same one-song request is refused with a reason', /不要再呼叫/.test(P.repeatGuard(u, 1)));
    check('repeat guard: user asking for several versions may compose again', P.repeatGuard('幫我作三首不同風格的曲子', 1) === '' && P.repeatGuard('做兩個版本比較', 2) === ''); }
  console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
})();
