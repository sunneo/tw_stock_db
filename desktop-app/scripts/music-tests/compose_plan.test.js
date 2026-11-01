// node scripts/music-tests/compose_plan.test.js -- 作曲的「理解需求」:用假 AI(完美、亂答、部分答對、沉默、逾時、丟錯)驗證每一欄與退路
const P = require('../../renderer/src/music/compose_plan.js'), C = require('../../renderer/src/music/music_compose.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const REQ = '建立科技感的音樂 用來描述intel';
const perfect = async () => '好的:{"style":"H","mood":"G","speed":"C","mode":"B","lead":"G","bars":"C","purpose":"描述 Intel 的科技感"}';
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
  check('silent AI: tried twice, then the rules', r.report.attempts === 2 && !r.report.usedAi && r.fields.style === 'edm');
  r = await P.decide(REQ, { ask: async () => { throw new Error('HTTP 429'); }, attempts: 2 });
  check('AI error: kept as a concrete fact in the report', /HTTP 429/.test(r.report.aiError) && r.report.notes[0].indexOf('HTTP 429') > 0, r.report);
  // 6. 逾時
  const t0 = Date.now(); r = await P.decide(REQ, { ask: () => new Promise(() => {}), timeoutMs: 60, attempts: 2 });
  check('timeout: gives up after the limit (twice) and falls back to the rules', Date.now() - t0 < 1500 && /逾時/.test(r.report.aiError) && !r.report.usedAi && r.fields.style === 'edm', [Date.now() - t0, r.report.aiError]);
  // 7. 第一次失敗第二次成功(暫時性失敗自己重試)
  let n = 0; r = await P.decide(REQ, { ask: async () => { n++; if (n === 1) throw new Error('HTTP 503'); return perfect(); }, attempts: 2 });
  check('a transient failure is retried once and the second answer is used', r.report.usedAi && r.report.attempts === 2 && r.sources.style === 'ai');
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
  // 13. parseAnswer 小細節
  const pa = P.parseAnswer('{"style":"h. 電子","mood":"g","speed":"B","mode":"c","lead":"j","bars":"a","purpose":"  開場  "}');
  check('parseAnswer: lower case and "H. text" forms are accepted, purpose is trimmed', pa.style === 'H' && pa.mood === 'G' && pa.mode === 'C' && pa.lead === 'J' && pa.bars === 'A' && pa.purpose === '開場', pa);
  check('parseAnswer: junk gives nothing', Object.keys(P.parseAnswer('')).length === 0 && Object.keys(P.parseAnswer('{bad json')).length === 0 && Object.keys(P.parseAnswer('[1,2]')).length === 0);
  check('every composed result passes the program\'s own checks (no warnings) for several seeds', [1, 2, 3, 4].every((sd) => C.compose(Object.assign({}, base.options, { seed: sd })).warnings.length === 0));
  console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
})();
