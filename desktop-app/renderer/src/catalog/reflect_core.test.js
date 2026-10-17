// node renderer/src/catalog/reflect_core.test.js
const R = require('./reflect_core.js'); const D = require('./discover_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
const V = R.vocabFrom({ zh: Object.keys(D.GLOSSARY), en: Object.values(D.GLOSSARY).join(' ').split(/\s+/), texts: ['pdf_images extractClipRange webcam camera filter smoothing beautify download subtitle burn', 'image resize canvas library face detection'] });

// ---- 編輯距離 ----
check('編輯距離：相同、替換、插入、刪除、對調', R.editDistance('camera', 'camera', 2) === 0 && R.editDistance('camera', 'camara', 2) === 1 && R.editDistance('camera', 'cmera', 2) === 1 && R.editDistance('camera', 'cameraa', 2) === 1 && R.editDistance('camera', 'camrea', 2) === 1);
check('編輯距離：差太多就提早放棄（回傳 max+1）', R.editDistance('camera', 'banana', 1) === 2 && R.editDistance('a', 'abcdef', 2) === 3);

// ---- 英文打錯字 ----
let s = R.suggestWord('camara', V); check('英文：camara → camera', s.length && s[0].to === 'camera' && s[0].dist === 1, s);
check('英文：webcm → webcam、smoothng → smoothing', R.suggestWord('webcm', V)[0].to === 'webcam' && R.suggestWord('smoothng', V)[0].to === 'smoothing');
check('英文：相鄰兩個字母對調（filetr → filter）', R.suggestWord('filetr', V)[0].to === 'filter');
check('英文：認得的字不當成打錯（含複數）', R.suggestWord('camera', V).length === 0 && R.suggestWord('filters', V).length === 0 && R.suggestWord('images', V).length === 0);
check('英文：差太遠的不亂猜', R.suggestWord('quantumflux', V).length === 0);
check('中文：兩個字的詞差的字不是常見同音近形字（濾竟→濾鏡）：不亂改', R.suggestZh('做美顏濾竟', V).length === 0, R.suggestZh('做美顏濾竟', V));
check('英文：漏一個字母（beatify → beautify）', R.suggestWord('beatify', V)[0].to === 'beautify', R.suggestWord('beatify', V));

// ---- 中文錯別字 ----
let z = R.suggestZh('擷取像機畫面', V); check('中文：像機 → 相機（常見的同音近形字）', z.some((x) => x.from === '像機' && x.to === '相機'), z);
z = R.suggestZh('用攝影幾來看', V); check('中文：三個字以上的詞差一個字也算（攝影幾 → 攝影機）', z.some((x) => x.from === '攝影幾' && x.to === '攝影機'), z);
check('中文：兩個字的詞，不是常見的同音近形字就不算（相簿 ≠ 相機）', !R.suggestZh('整理相簿', V).some((x) => x.to === '相機'), R.suggestZh('整理相簿', V));
check('中文：已經有的詞不再被當成錯字', R.suggestZh('擷取相機畫面', V).length === 0);
check('中文：不會在已認得的詞中間亂找', !R.suggestZh('拍貼機', V).some((x) => x.at >= 0 && x.from.length === 2 && x.from !== '拍貼'), R.suggestZh('拍貼機', V));

// ---- 整句分析 ----
let a = R.analyze('做一個拍貼機，擷取像機畫面，用 camara 美顏', V);
check('分析：英文與中文的錯字都找到，並給改正後的句子', a.typos.some((x) => x.from === 'camara' && x.to === 'camera') && a.typos.some((x) => x.from === '像機' && x.to === '相機') && /camera/.test(a.corrected) && /相機/.test(a.corrected) && !/camara|像機/.test(a.corrected), a);
a = R.analyze('把圖片做成 zorbulax 風格', V); check('分析：詞庫不認得、又不像打錯字的字記在 unknown', a.unknown.includes('zorbulax') && a.typos.length === 0, a);
a = R.analyze('量子糾纏模擬器', V); check('分析：中文裡詞庫沒涵蓋的連續字記在 uncovered', a.uncovered.some((u) => u.length >= 3), a);
a = R.analyze('擷取相機畫面 camera', V); check('分析：全部認得 → 沒有打錯、沒有不認得', a.typos.length === 0 && a.unknown.length === 0 && a.corrected === null, a);
a = R.analyze('做 zorbulax 風格的美顏', V); check('概念句：拿掉不認得的字，只留認得的概念', a.concept && !/zorbulax/.test(a.concept) && /美顏/.test(a.concept), a.concept);

// ---- 分類 ----
const AN = (t) => R.analyze(t, V);
check('分類：找到夠好的 → ok', R.classify(AN('camera'), { n: 3, best: 0.8 }).kind === 'ok');
check('分類：沒找到 + 有錯字嫌疑 → typo_suspect，並講出哪個字', (() => { const c = R.classify(AN('用 camara 做美顏'), { n: 0, best: 0 }); return c.kind === 'typo_suspect' && /camara/.test(c.reason) && /camera/.test(c.reason); })());
check('分類：只勉強過門檻 + 有錯字嫌疑 → 也算 typo_suspect', R.classify(AN('用 camara 做美顏'), { n: 1, best: 0.4 }).kind === 'typo_suspect');
check('分類：沒找到、不像打錯字、詞庫也不認得 → novel_suspect', (() => { const c = R.classify(AN('做 zorbulax 風格'), { n: 0, best: 0 }); return c.kind === 'novel_suspect' && /不認得：zorbulax/.test(c.reason) && /也不像打錯字/.test(c.reason); })());
check('分類：最像的只有 20 分、不像打錯字 → novel_suspect', R.classify(AN('做 zorbulax 風格'), { n: 2, best: 0.2 }).kind === 'novel_suspect');
check('分類：過了門檻但不算好、也沒有線索 → plain', R.classify(AN('camera'), { n: 1, best: 0.4 }).kind === 'plain');
check('分類：門檻可調', R.classify(AN('camera'), { n: 1, best: 0.5 }, { minScore: 0.5, weakBand: 0 }).kind === 'ok');

// ---- 文字 ----
const tx = R.toText([{ gap: 'need/0', kind: 'typo', from: 'camara', to: 'camera', outcome: 'found', name: 'webcam-lib' }, { gap: 'need/1', kind: 'typo', from: '像機', to: '相機', outcome: 'declined' }, { gap: 'need/2', kind: 'novel', reason: '搜不到任何候選；詞庫不認得：zorbulax' }, { gap: 'need/3', kind: 'concept', to: '美顏', outcome: 'still' }]);
check('報告文字', /need\/0：「camara」可能是「camera」，改用後找到了「webcam-lib」/.test(tx) && /照原樣/.test(tx) && /可能是新的需求/.test(tx) && /還是沒找到/.test(tx), tx);
check('新需求的下一步：指向 UML 拆解、接線與回填', /uml_guide/.test(R.NOVEL_NEXT) && /catalog_bind/.test(R.NOVEL_NEXT) && /catalog_onboard/.test(R.NOVEL_NEXT));



// ---- 反思整份計畫（假的主機）----
const jn = (...l) => l.join('\n');
const PAGES = { 'https://x/cam': jn('# webcam-grab', '', 'Capture frames from the webcam camera in the browser with getUserMedia. Grab a camera frame as an image.', '', '```sh', 'npm install webcam-grab', '```', '', '```js', 'const frame = await webcamGrab.capture(video)', '```', '', '## License', '', 'MIT') };
const mkHost = () => { const calls = { search: [] }; return { calls, search: async (q) => { calls.search.push(q); return /camera/.test(q) ? [{ title: 'webcam-grab', url: 'https://x/cam', snippet: 'camera frames' }] : []; }, fetchText: async (u) => { if (!(u in PAGES)) throw new Error('404'); return PAGES[u]; } }; };
const RO = { runtime: 'browser' };
(async () => {
  // 打錯字（像機）：第一次找不到 → 反思 → 問使用者 → 改成相機重找 → 找到
  let host = mkHost(); let plan = await D.run(host, { needs: ['擷取像機畫面'] }, RO);
  check('前提：打錯字的需求第一次找不到', plan.resolved === 0 && plan.unresolved.length === 1 && plan.unresolved[0].need === '擷取像機畫面', plan.unresolved);
  let asked = null; await R.reflectPlan(plan, { D, host, runOpts: RO, V, ask: async (q) => { asked = q; return { kind: 'choice', index: 0 }; } });
  check('問了使用者，附上原句、改正後的句子、哪個字', asked && asked.need === '擷取像機畫面' && asked.corrected === '擷取相機畫面' && /像機/.test(asked.reason), asked);
  check('改正後找到了：進了候選、從沒找到移除、解決數加一', plan.candidates.length === 1 && plan.candidates[0].name === 'webcam-grab' && plan.candidates[0].gap === 'need/0' && plan.unresolved.length === 0 && plan.resolved === 1, { c: plan.candidates.map((c) => c.name), u: plan.unresolved });
  check('反思紀錄與文字', plan.reflections[0].kind === 'typo' && plan.reflections[0].outcome === 'found' && /像機.*相機.*webcam-grab/.test(plan.reflect_text), plan.reflect_text);
  check('沒有被當成新的需求', plan.novel.length === 0);
  // 使用者說「不是打錯」→ 照原樣，標成可能是新的
  host = mkHost(); plan = await D.run(host, { needs: ['擷取像機畫面'] }, RO);
  await R.reflectPlan(plan, { D, host, runOpts: RO, V, ask: async () => ({ kind: 'choice', index: 1 }) });
  check('說不是打錯字：不改、標成可能是新的', plan.candidates.length === 0 && plan.novel.length === 1 && plan.reflections[0].outcome === 'declined' && /照原樣/.test(plan.reflect_text), plan);
  // 使用者直接打字給自己的說法 → 用他的說法重找
  host = mkHost(); plan = await D.run(host, { needs: ['擷取像機畫面'] }, RO);
  await R.reflectPlan(plan, { D, host, runOpts: RO, V, ask: async () => ({ kind: 'supplement', text: '抓攝影機的畫面' }) });
  check('打字給自己的說法：用那句重找', host.calls.search.some((q) => /webcam/.test(q)) && plan.candidates.length === 1, host.calls.search);
  // 統一走建議（auto）：不問，直接用改正後的
  host = mkHost(); plan = await D.run(host, { needs: ['擷取像機畫面'] }, RO); let asked2 = false;
  await R.reflectPlan(plan, { D, host, runOpts: RO, V, auto: true, ask: async () => { asked2 = true; return { kind: 'cancel' }; } });
  check('統一走建議：不問、直接用改正後的找到', !asked2 && plan.candidates.length === 1);
  // 真的是新的：詞庫不認得、不像打錯字、搜不到 → 標成可能是新的，不是失敗
  host = mkHost(); plan = await D.run(host, { needs: ['做 zorbulax 風格轉換'] }, RO);
  await R.reflectPlan(plan, { D, host, runOpts: RO, V, ask: async () => { throw new Error('不該問'); } });
  check('新的需求：標成 novel，講出為什麼', plan.novel.length === 1 && /zorbulax/.test(plan.novel[0].reason) && plan.reflections.some((r) => r.kind === 'novel') && /可能是新的需求/.test(plan.reflect_text), plan.reflections);
  // 概念再找：不認得的字拿掉，只用認得的概念
  host = mkHost(); plan = await D.run(host, { needs: ['用 zorbulax 相機擷取畫面'] }, RO);
  if (!plan.candidates.length) { await R.reflectPlan(plan, { D, host, runOpts: RO, V }); check('只用認得的概念再找：找到了', plan.candidates.length === 1 && plan.reflections.some((r) => r.kind === 'concept' && r.outcome === 'found'), plan.reflections); } else check('（原句就找到了，略過概念再找）', true);
  // 反思有上限：最多 3 個缺口
  host = mkHost(); plan = await D.run(host, { needs: ['a1 zorbulax', 'b2 zorbulax', 'c3 zorbulax', 'd4 zorbulax', 'e5 zorbulax'] }, RO);
  await R.reflectPlan(plan, { D, host, runOpts: RO, V }); check('最多反思 3 個缺口（不會無限制多搜）', plan.reflections.filter((r) => r.kind === 'novel').length <= 3 && plan.reflections.filter((r) => r.kind === 'novel').length >= 1, plan.reflections.length);
  // 已經找得很好的缺口不打擾
  host = mkHost(); plan = await D.run(host, { needs: ['擷取相機畫面'] }, RO); const before = JSON.stringify(plan.candidates.map((c) => c.name)); let asked3 = false;
  await R.reflectPlan(plan, { D, host, runOpts: RO, V, ask: async () => { asked3 = true; return { kind: 'cancel' }; } });
  check('找得好的缺口：不反思、不問', !asked3 && JSON.stringify(plan.candidates.map((c) => c.name)) === before && plan.reflections.length === 0, plan.reflections);
  done();
})();
function done() {
  console.log('reflect_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' failed ' + JSON.stringify(bad) : ''));
  if (bad.length) process.exit(1);
}
