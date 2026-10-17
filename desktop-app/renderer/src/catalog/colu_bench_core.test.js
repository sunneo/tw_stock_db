// node renderer/src/catalog/colu_bench_core.test.js
const M = require('./matrix_core.js'); const B = require('./colu_bench_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
const U = (name, params, returns, summary) => ({ id: 'tool:' + name, runtime: 'app', name, summary: summary || '', params: params.map(([n, t, req]) => ({ name: n, kind: 'named', type: t, type_src: 'schema', required: !!req })), returns: { type: returns, type_src: 'doc' }, effects: ['state.read'], pure: false, avail: { state: 'builtin', needs: [] }, domains: [], tests: [], tier: 1 });
const units = [
    U('download_a', [['url', 'url', true]], 'object{file_id:file_id}', '用方法A下載網址'), U('download_b', [['url', 'url', true]], 'object{file_id:file_id}', '用方法B下載網址'),
    U('to_pdf_a', [['file_id', 'file_id', true]], 'object{pdf:pdf_file}', '轉成PDF（快）'), U('to_pdf_b', [['file_id', 'file_id', true]], 'object{pdf:pdf_file}', '轉成PDF（精準）'),
    U('pdf_images_a', [['pdf', 'pdf_file', true]], 'object{img:image_file}', '把PDF每頁轉圖片'), U('pdf_images_b', [['pdf', 'pdf_file', true]], 'object{img:image_file}', '把PDF封面轉圖片'),
    U('thumb', [['img', 'image_file', true]], 'object{gif:gif_file}', '做成縮圖動畫'), U('thumb2', [['img', 'image_file', true]], 'object{gif:gif_file}', '做成輪播動畫'),
    U('extract_audio', [['file_id', 'file_id', true]], 'object{audio:audio_file}', '抽出聲音'), U('make_subs', [['audio', 'audio_file', true]], 'object{subs:subtitle_file}', '產生字幕'),
    U('noise1', [['path', 'path', true]], 'object{video:video_file}', '剪輯影片'), U('noise2', [['video', 'video_file', true]], 'object{out:path}', '輸出影片'),
];
const mx = M.buildMatrix(units); const r = B.makeTasks(mx, { n: 6, seed: 7 }); const tasks = r.tasks;
check('出得了題：6 題', tasks.length === 6, { got: tasks.length, skipped: r.skipped });
check('每題的出題路徑是合法的、2～3 步', tasks.every((t) => t.intended.length >= 2 && t.intended.length <= 3 && t.intended.every((id, i) => i === 0 || mx.edges[mx.index.get(t.intended[i - 1])].has(mx.index.get(id)))));
check('每題的清單包含出題路徑上的所有函式，加上干擾', tasks.every((t) => t.intended.every((id) => t.candidates.some((c) => c.id === id)) && t.candidates.length > t.intended.length));
check('同樣的種子出一樣的題', JSON.stringify(B.makeTasks(mx, { n: 6, seed: 7 }).tasks.map((t) => t.intended)) === JSON.stringify(tasks.map((t) => t.intended)));
check('不同種子出不一樣的題', JSON.stringify(B.makeTasks(mx, { n: 6, seed: 8 }).tasks.map((t) => t.intended)) !== JSON.stringify(tasks.map((t) => t.intended)));
const withOpt = tasks.filter((t) => t.options); check('有選項的題：選項數、答案位置、需求描述', withOpt.length >= 3 && withOpt.every((t) => t.options.length === 3 && t.options[t.answerIndex].map((d) => d.id).join() === t.intended.join() && /需要的步驟是/.test(t.need)), withOpt.length);
check('單元太少：不出題並說原因', B.makeTasks(M.buildMatrix(units.slice(0, 2)), { n: 3 }).tasks.length === 0);
check('提示詞：自己排有清單與格式、選計畫有編號', /\{"steps":/.test(B.buildPrompt(tasks[0], 'self').user) && tasks[0].candidates.every((c) => B.buildPrompt(tasks[0], 'self').user.includes(c.name)) && /\{"choice":/.test(B.buildPrompt(withOpt[0], 'assisted').user) && /1\. /.test(B.buildPrompt(withOpt[0], 'assisted').user));

// ---- 評分 ----
const t0 = tasks[0]; const names = (ids) => ids.map((id) => t0.candidates.find((c) => c.id === id).name);
let g = B.grade(mx, t0, JSON.stringify({ steps: names(t0.intended) }), 'self'); check('自己排：出題那條 → 對、exact', g.ok && g.exact, g);
check('自己排：文字包著 JSON 也能讀（含思考標籤、程式碼區塊）', B.grade(mx, t0, '<think>想一想</think>\n```json\n' + JSON.stringify({ steps: names(t0.intended) }) + '\n```', 'self').ok);
check('自己排：直接給陣列也可以', B.grade(mx, t0, JSON.stringify(names(t0.intended)), 'self').ok);
check('自己排：名稱大小寫不拘', B.grade(mx, t0, JSON.stringify({ steps: names(t0.intended).map((n) => n.toUpperCase()) }), 'self').ok);
g = B.grade(mx, t0, '我覺得應該這樣排，先下載再轉', 'self'); check('自己排：沒有 JSON → 格式不對', !g.parsed && !g.ok, g);
g = B.grade(mx, t0, JSON.stringify({ steps: ['不存在的函式'] }), 'self'); check('自己排：不存在的函式', g.parsed && !g.ok && /沒有的函式/.test(g.reason), g);
g = B.grade(mx, t0, JSON.stringify({ steps: [names(t0.intended)[0], names(t0.intended)[0]] }), 'self'); check('自己排：重複用同一個函式', !g.ok && /兩次/.test(g.reason), g);
g = B.grade(mx, t0, JSON.stringify({ steps: names(t0.intended).slice().reverse() }), 'self'); check('自己排：順序倒過來 → 不合法（接不上或吃不下）', !g.ok && g.reason, g);
g = B.grade(mx, t0, JSON.stringify({ steps: [] }), 'self'); check('自己排：空陣列', !g.ok && /沒有排任何步驟/.test(g.reason));
// 另一條也合法的路徑（換成同型別的備用函式）算對、但 exact 為 false
const alt = (() => { for (const t of tasks) { const swapped = t.intended.map((id) => { const i = mx.index.get(id); const same = t.candidates.find((c) => c.id !== id && mx.units[mx.index.get(c.id)].returns.type === mx.units[i].returns.type && JSON.stringify(mx.ins[mx.index.get(c.id)].map((p) => p.type)) === JSON.stringify(mx.ins[i].map((p) => p.type))); return same ? same.id : id; }); if (swapped.join() !== t.intended.join()) return { t, swapped }; } return null; })();
if (alt) { const gg = B.grade(mx, alt.t, JSON.stringify({ steps: alt.swapped.map((id) => alt.t.candidates.find((c) => c.id === id).name) }), 'self'); check('自己排：換成同型別的備用函式也算對（不要求跟出題一樣）', gg.ok && gg.exact === false, gg); } else check('（沒有可換的備用函式，略過）', true);
const t1 = withOpt[0];
check('選計畫：選對', B.grade(mx, t1, '{"choice":' + (t1.answerIndex + 1) + '}', 'assisted').ok);
check('選計畫：選錯', !B.grade(mx, t1, '{"choice":' + (((t1.answerIndex + 1) % 3) + 1) + '}', 'assisted').ok);
check('選計畫：只回數字、「選2」「第2條」也讀得懂', B.parseAnswer('2', 'assisted').choice === 2 && B.parseAnswer('選 2', 'assisted').choice === 2 && B.parseAnswer('第3個', 'assisted').choice === 3);
check('選計畫：編號超出範圍與亂答', /超出/.test(B.grade(mx, t1, '{"choice":9}', 'assisted').reason) && !B.grade(mx, t1, '都不錯', 'assisted').parsed);

// ---- 退化偵測 ----
check('退化：空白／只有思考／同一行重複／同一段重複', B.degenerate({ content: '' }) === '空白回應' && B.degenerate({ content: '', reasoning: '想了很多' }) === '只有思考、沒有答案' && B.degenerate({ content: '好的我來處理\n'.repeat(5) }) === '同一行重複輸出' && B.degenerate({ content: ('這是一段會一直重複的話，真的會一直重複。'.repeat(30)) }) !== '');
check('退化：正常回答不算', B.degenerate({ content: '{"steps":["a","b"]}' }) === '' && B.degenerate({ content: '先下載，再轉成 PDF，最後轉圖片。' }) === '');


// ---- 出題規則：每題都有選項、出題那條自己要對、泛型別不出題、亂猜基準 ----
check('預設每一題都有選項（才測得到「給計畫選」）', tasks.every((t) => t.options && t.answerIndex >= 0));
check('每一題的清單裡沒有同名函式', tasks.every((t) => new Set(t.candidates.map((c) => c.name.toLowerCase())).size === t.candidates.length));
check('每題的起訖都是具體的型別（不是 text／json 這種什麼都接得上的）', tasks.every((t) => !/^(text|json|any|dict|bytes|number)$/.test(t.from) && !/^(text|json|any|dict|bytes|number)$/.test(t.to)), tasks.map((t) => [t.from, t.to]));
const generic = [U('g1', [['t', 'text', true]], 'object{t:text}'), U('g2', [['t', 'text', true]], 'object{t:text}'), U('g3', [['t', 'text', true]], 'object{t:text}'), U('g4', [['t', 'text', true]], 'object{t:text}')];
check('全是泛型別的目錄：不出題，說原因', B.makeTasks(M.buildMatrix(generic, { minScore: 0.1 }), { n: 3 }).tasks.length === 0);
const bl = B.randomBaseline(mx, tasks); check('亂猜基準在 0..1 之間，而且遠低於 1', bl >= 0 && bl < 0.6, bl);
check('同樣種子算出一樣的基準', B.randomBaseline(mx, tasks) === bl);
const resBase = B.summarize([], tasks, { baseline: 0.12 }); check('報告會附上亂猜基準', resBase.notes.some((x) => /亂排碰巧合法的機率約 12%/.test(x)), resBase.notes);

// ---- 假模型跑整套，看建議 ----
function run(model) {
    const res = [];
    for (const t of tasks) { const c = model(t, 'self'); res.push(Object.assign({ mode: 'self', http_ok: c.http_ok !== false, degenerate: B.degenerate(c), ms: c.ms || 100 }, B.grade(mx, t, c.content, 'self'))); }
    for (const t of tasks) { if (!t.options) continue; const c = model(t, 'assisted'); res.push(Object.assign({ mode: 'assisted', http_ok: c.http_ok !== false, degenerate: B.degenerate(c), ms: c.ms || 100 }, B.grade(mx, t, c.content, 'assisted'))); }
    return B.summarize(res, tasks);
}
const solveA = (t) => JSON.stringify({ steps: t.intended.map((id) => t.candidates.find((c) => c.id === id).name) });
const oracle = (t, m) => ({ content: m === 'self' ? solveA(t) : '{"choice":' + (t.answerIndex + 1) + '}' });
let p = run(oracle); check('完美模型 → 建議 self', p.advice === 'self' && p.self.rate === 1 && p.assisted.rate === 1 && p.degenerate.ok === 0, p);
p = run((t, m) => (m === 'self' ? { content: '我不確定耶' } : oracle(t, m))); check('只會選、不會排 → 建議 guided', p.advice === 'guided' && p.self.rate === 0 && p.assisted.rate === 1, p);
p = run(() => ({ content: '不知道' })); check('什麼都不會 → 建議 auto，並提醒連選擇題都不穩', p.advice === 'auto' && p.notes.some((x) => /連選擇題都不穩/.test(x)) && p.notes.some((x) => /格式正確率/.test(x)), p);
p = run(() => ({ content: '', reasoning: '一直想一直想' })); check('只有思考 → auto＋退化率偏高', p.advice === 'auto' && p.notes.some((x) => /退化率偏高.*只有思考/.test(x)), p);
p = run((t, m) => (m === 'self' ? { content: '好的我來處理\n'.repeat(6) } : oracle(t, m))); check('排的時候一直重複、選的時候正常 → guided，理由提到退化', p.advice === 'guided' && /退化/.test(p.reason), p);
p = run((t, m) => ({ http_ok: false, content: '', error: 'HTTP 429' })); check('全部呼叫失敗 → unknown（不是亂給建議）', p.advice === 'unknown' && p.failed_calls > 0 && /判斷不了/.test(p.reason), p);
let flip = 0; p = run((t, m) => (m === 'self' ? (flip++ % 2 ? { content: solveA(t) } : { content: '{"steps":[]}' }) : oracle(t, m))); check('一半對一半錯：不到 0.8 → 不建議 self', p.advice !== 'self', p);
check('CoLU 直接排的參考數字有算（0..1）', p.auto_top1.n >= 3 && p.auto_top1.rate >= 0 && p.auto_top1.rate <= 1, p.auto_top1);
check('題數少會提醒只是粗略估計', run(oracle).notes.some((x) => /粗略/.test(x)));

// ---- 文字與提示 ----
p = run((t, m) => (m === 'self' ? { content: 'x' } : oracle(t, m))); const txt = B.toText('測試模型', p);
check('報告文字：有分數、建議與理由', /自己排接線：0\/6/.test(txt) && /建議：CoLU 先給計畫、模型只選/.test(txt) && /測試模型/.test(txt), txt);
check('使用時的提示：guided 與 auto 才有，且指向 catalog_query', /catalog_query/.test(B.hintFor('guided')) && /action:"path"/.test(B.hintFor('guided')) && /action:"plan"/.test(B.hintFor('auto')) && B.hintFor('self') === '' && B.hintFor('unknown') === '' && B.hintFor(undefined) === '');

console.log('colu_bench_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' failed ' + JSON.stringify(bad) : ''));
if (bad.length) process.exit(1);
