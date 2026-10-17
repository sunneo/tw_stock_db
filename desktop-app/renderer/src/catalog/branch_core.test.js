// node renderer/src/catalog/branch_core.test.js
const B = require('./branch_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };

const card = (o) => Object.assign({ language: 'js', runtime: ['browser'], installs: [{ line: 'npm i x' }], cdn: [], api: [{ name: 'run' }], needs: [], license: 'MIT', summary: '' }, o || {});
const cand = (gap, name, score, alts, o) => Object.assign({ gap, need: '需求 ' + gap, name, url: 'https://x/' + name, score, why: ['概念對上'], summary: name + ' 的說明', language: 'js', runtime: ['browser'], install: 'npm i ' + name, needs: [], card: card(), features: { f: 1 }, kind: 'project', alternatives: (alts || []).map(([n, s, needs]) => ({ name: n, url: 'https://x/' + n, score: s, card: card({ needs: needs || [], summary: n + ' 說明' }), features: { f: 0 } })) }, o || {});
const plan = (cs, un) => ({ ok: true, plan_id: 'p1', candidates: cs, unresolved: un || [] });

// ---- 沒有分歧就不問 ----
let d = B.detect(plan([cand('need/0', 'solo', 0.9, [['weak-alt', 0.3]]), cand('need/1', 'strong', 0.8, [['far', 0.4]])]));
check('沒有分歧：不問', d.questions.length === 0 && d.quiet === 2, d);
check('低於門檻的備選不算分歧', !d.questions.length);

// ---- 分數接近 ----
d = B.detect(plan([cand('need/0', 'a', 0.62, [['b', 0.6], ['c', 0.58], ['d', 0.3]])]));
check('分數接近：問一題', d.questions.length === 1 && d.questions[0].kind === 'close_call', d);
check('選項：推薦的在最前，低於門檻的不列', d.questions[0].options.map((x) => x.name).join() === 'a,b,c', d.questions[0].options);
check('說明裡有每個候選的分數', /a（62 分）/.test(d.questions[0].description) && /b（60 分）/.test(d.questions[0].description));
d = B.detect(plan([cand('need/0', 'a', 0.9, [['b', 0.5]])]));
check('差距大：不問', d.questions.length === 0);
d = B.detect(plan([cand('need/0', 'a', 0.4, [['b', 0.36]])]));
check('絕對差距在 0.05 內也算接近', d.questions.length === 1 && d.questions[0].kind === 'close_call', d);

// ---- 取捨：推薦的需要金鑰、備選不需要 ----
d = B.detect(plan([cand('need/0', 'cloud', 0.7, [['local', 0.55]], { needs: ['api_key'], card: card({ needs: ['api_key'] }) })]));
check('取捨：問一題', d.questions.length === 1 && d.questions[0].kind === 'tradeoff', d);
check('取捨：不需要金鑰的排在前面當建議', d.questions[0].options[0].name === 'local' && d.questions[0].recommended === 0, d.questions[0].options);
check('取捨：說明講出需要 API 金鑰', /需要 API 金鑰/.test(d.questions[0].description));
d = B.detect(plan([cand('need/0', 'cloud', 0.7, [['local2', 0.2]], { needs: ['api_key'] })]));
check('備選太差（低於門檻）：不構成取捨', d.questions.length === 0, d);

// ---- 勉強合格 / 找不到 ----
d = B.detect(plan([cand('need/0', 'meh', 0.38, [])]));
check('勉強合格：問「用或略過」', d.questions.length === 1 && d.questions[0].kind === 'weak_pick' && d.questions[0].options[1].skip, d);
d = B.detect(plan([], [{ gap: 'need/3', reason: '搜不到' }]));
check('找不到：問一題，建議是略過', d.questions.length === 1 && d.questions[0].kind === 'unresolved' && d.questions[0].options[0].skip, d);

// ---- 題數上限與順序 ----
const many = plan([cand('need/0', 'a', 0.62, [['b', 0.6]]), cand('need/1', 'c', 0.7, [['d', 0.55]], { needs: ['server'] }), cand('need/2', 'e', 0.38, []), cand('need/4', 'f', 0.62, [['g', 0.6], ['h', 0.59]])], [{ gap: 'need/3', reason: 'x' }]);
d = B.detect(many);
check('最多 3 題', d.questions.length === 3 && d.deferred.length === 2, { q: d.questions.length, def: d.deferred.length });
check('取捨最先問', d.questions[0].kind === 'tradeoff', d.questions.map((q) => q.kind));
check('其餘順序：備選多的接近題在前', d.questions[1].gap === 'need/4' && d.questions[1].kind === 'close_call', d.questions.map((q) => q.gap));
check('maxQuestions 可調', B.detect(many, { maxQuestions: 1 }).questions.length === 1);

// ---- 套用回答 ----
let p = plan([cand('need/0', 'a', 0.62, [['b', 0.6], ['c', 0.58]])]); let q = B.detect(p).questions[0];
let rec = B.apply(p, q, { kind: 'choice', index: 1 });
check('選備選：換成它', p.candidates[0].name === 'b' && p.candidates[0].url === 'https://x/b' && rec.decision === 'picked' && rec.explicit, p.candidates[0].name);
check('原本的推薦掉到備選裡', p.candidates[0].alternatives.some((a) => a.name === 'a') && !p.candidates[0].alternatives.some((a) => a.name === 'b'), p.candidates[0].alternatives.map((a) => a.name));
check('換過去的有安裝方式與環境', /npm i/.test(p.candidates[0].install) && p.candidates[0].language === 'js');
p = plan([cand('need/0', 'a', 0.62, [['b', 0.6]])]); q = B.detect(p).questions[0]; rec = B.apply(p, q, { kind: 'choice', index: 0 });
check('選推薦的：維持原樣但算明確選擇', p.candidates[0].name === 'a' && rec.explicit && rec.decision === 'picked');
p = plan([cand('need/0', 'a', 0.62, [['b', 0.6]])]); q = B.detect(p).questions[0]; rec = B.apply(p, q, { kind: 'cancel' });
check('取消：用預設，不算明確選擇', p.candidates[0].name === 'a' && !rec.explicit && rec.decision === 'default', rec);
p = plan([cand('need/0', 'meh', 0.38, [])]); q = B.detect(p).questions[0]; rec = B.apply(p, q, { kind: 'choice', index: 1 });
check('略過：從候選移到沒解決', p.candidates.length === 0 && p.unresolved.length === 1 && rec.decision === 'skipped', p);
p = plan([cand('need/0', 'a', 0.62, [['b', 0.6]])]); q = B.detect(p).questions[0];
rec = B.apply(p, q, { kind: 'supplement', text: '我想用 https://github.com/foo/bar，而且不要用到網路。' });
check('打字補充：記下內容與網址', rec.decision === 'supplement' && rec.explicit && p.user_notes.length === 1 && p.user_urls.join() === 'https://github.com/foo/bar', { rec, notes: p.user_notes, urls: p.user_urls });
check('補充不改推薦', p.candidates[0].name === 'a');
check('網址撿取：中文標點結尾不算進去', B.urlsIn('看 https://a.b/c，還有（https://d.e/f）。').join('|') === 'https://a.b/c|https://d.e/f', B.urlsIn('看 https://a.b/c，還有（https://d.e/f）。'));
check('網址撿取：最多 5 個、去重', B.urlsIn(Array.from({ length: 9 }, (_, i) => 'https://a.b/' + (i % 7)).join(' ')).length === 5);
rec = B.apply(p, q, { kind: 'choice', index: 99 });
check('不存在的選項：當成預設', rec.decision === 'default' && !rec.explicit, rec);


// ---- 不要再問：意圖辨識與自動套用 ----
const yes = ['不要再問了', '別問了', '不用再問我', '都照你的建議', '統一走建議', '一律用推薦的', '直接用建議的', 'stop asking', '以後不要再詢問我'];
const no = ['幫我做一個網站，不要再問一堆問題之後才開始，要用 vue 還有 typescript 並且加上測試', '問題在哪', '建議你先看日誌', '', '這個函式怎麼用'];
check('不要再問：認得這些說法', yes.every((t) => B.askModeIntent(t) === 'recommended'), yes.filter((t) => B.askModeIntent(t) !== 'recommended'));
check('不要再問：長指令與無關的話不誤判', no.every((t) => B.askModeIntent(t) === null), no.filter((t) => B.askModeIntent(t) !== null));
check('恢復詢問：認得', ['可以再問我', '恢復詢問', '開始問我', '讓我決定'].every((t) => B.askModeIntent(t) === 'ask'));
p = plan([cand('need/0', 'cloud', 0.7, [['local', 0.6]], { needs: ['api_key'], card: card({ needs: ['api_key'] }) }), cand('need/1', 'meh', 0.38, [])], [{ gap: 'need/9', reason: 'x' }]);
d = B.detect(p); const all = d.questions.concat(d.deferred);
for (const qq of all) B.apply(p, qq, { kind: 'choice', index: qq.recommended }, { auto: true });
check('自動套用：全部依建議、都不算明確選擇', p.decisions.length === 3 && p.decisions.every((x) => x.auto && !x.explicit), p.decisions);
check('自動套用：取捨換成不需要金鑰的、勉強合格照用、找不到略過', p.candidates.find((c) => c.gap === 'need/0').name === 'local' && p.candidates.some((c) => c.gap === 'need/1') && p.decisions.find((x) => x.gap === 'need/9').decision === 'skipped', p.decisions.map((x) => x.decision));
check('自動套用：摘要寫「依建議」', /依建議用「local」/.test(B.summarize(p, d)) && /依建議略過/.test(B.summarize(p, d)), B.summarize(p, d));


// ---- 反思過、可能是新的需求 ----
p = plan([], [{ gap: 'need/3', reason: '搜不到任何候選' }]); p.novel = [{ gap: 'need/3', need: 'x', reason: '搜不到任何候選；詞庫不認得：zorbulax；也不像打錯字' }];
d = B.detect(p); q = d.questions[0];
check('可能是新的：標題與說明講「新的需求」，建議是用 UML 拆解（不是略過）', /也許是新的需求/.test(q.title) && /UML 拆成極小的單元/.test(q.description) && q.options[0].novel && q.options[1].skip && q.recommended === 0 && q.priority === 55, q);
rec = B.apply(p, q, { kind: 'choice', index: 0 }); check('選用 UML 拆解：記下決定、缺口留著不移除', rec.decision === 'novel' && rec.explicit && p.novel_confirmed.length === 1 && p.unresolved.length === 1, rec);
p2 = plan([], [{ gap: 'need/3', reason: 'x' }]); p2.novel = [{ gap: 'need/3', need: 'x', reason: 'y' }]; rec = B.apply(p2, B.detect(p2).questions[0], { kind: 'choice', index: 0 }, { auto: true }); check('統一走建議：自動當成新的需求，不算明確選擇', rec.decision === 'novel' && !rec.explicit && rec.auto && /依建議當成新的需求/.test(B.summarize(p2, { deferred: [], quiet: 0 })), B.summarize(p2, { deferred: [], quiet: 0 }));
p3 = plan([], [{ gap: 'need/3', reason: '搜不到' }]); q = B.detect(p3).questions[0]; check('沒有反思過的找不到：還是原本的問法（只有略過）', q.options.length === 1 && q.options[0].skip && !/新的需求/.test(q.title) && q.priority === 50, q);

// ---- 摘要 ----
p = plan([cand('need/0', 'a', 0.62, [['b', 0.6]]), cand('need/1', 'z', 0.9, [])]); d = B.detect(p); B.apply(p, d.questions[0], { kind: 'choice', index: 1 });
const s = B.summarize(p, d);
check('摘要：講出選擇與安靜的缺口', /你選了「b」/.test(s) && /1 個需求只有一條合理路線/.test(s), s);
check('摘要：講出超過題數用預設', /先用推薦的：/.test(B.summarize(plan([]), { deferred: [{ gap: 'need/9' }], quiet: 0 })));

console.log('branch_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' failed ' + JSON.stringify(bad) : ''));
if (bad.length) process.exit(1);
