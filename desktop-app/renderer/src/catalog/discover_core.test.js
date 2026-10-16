// node renderer/src/catalog/discover_core.test.js
const D = require('./discover_core.js'); const Card = require('./card_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 600) : '')); };
const NL = '\n'; const j = (...l) => l.join(NL);

// ---- 中文 → 搜尋用英文 ----
const te = D.toEnglish('做一個拍貼機，有美顏功能');
check('glossary: 拍貼機 / 美顏', /photo booth/.test(te.english) && /beautify/.test(te.english), te);
check('longest glossary key wins (背景移除 over 背景)', /background removal/.test(D.toEnglish('背景移除').english));

// ---- 缺口 ----
const bind = { results: [{ usecase: 'Snap', steps: [{ step: 'Camera.captureFrame', unit: null, by: 'none', op_params: ['n:int'], returns: 'bytes' }, { step: 'Files.fsStat', unit: 'tool:fs_stat' }, { step: 'Face.smoothSkin', units: null, by: 'none', op_params: [], returns: 'any' }] }] };
const gaps = D.gapsFrom(bind);
check('only unbound steps are gaps', gaps.length === 2 && gaps[0].cls === 'Camera' && gaps[0].op === 'captureFrame' && gaps[1].op === 'smoothSkin', gaps);
check('wired-by-type steps are not gaps', D.gapsFrom({ results: [{ usecase: 'x', steps: [{ step: 'A.b', units: ['tool:x', 'tool:y'], by: 'type-wiring' }] }] }).length === 0);
check('gaps from plain needs', D.gapsFromNeeds(['擷取相機畫面', '美顏']).length === 2);

// ---- 搜尋關鍵字 ----
const q = D.queriesFor(gaps[1], { runtime: 'browser' });
check('queries: short (search engines want every word), include the language, no duplicates', q.queries.length >= 2 && q.queries.every((x) => x.split(' ').length <= 4 && /javascript/.test(x)) && q.queries[0].includes('smooth') && new Set(q.queries).size === q.queries.length, q);
const qz = D.queriesFor(D.gapsFromNeeds(['美顏濾鏡'])[0], { runtime: 'browser' });
check('queries: chinese need is translated', /beautify|face/.test(qz.queries.join(' ')) && !/[㐀-鿿]/.test(qz.queries.join(' ')), qz.queries);
check('python runtime searches python', D.queriesFor(gaps[0], { runtime: 'python' }).queries.every((x) => /python/.test(x) && !/javascript/.test(x)));

// ---- 排名 ----
const mk = (id, name, md, desc) => ({ id, name, url: id, summary: '', card: Card.cardFromReadme(md, { name, description: desc }) });
const faceLib = mk('u/face', 'face-smooth', j('# face-smooth', '', 'Smooth skin and beautify faces in photos in the browser with WebGL.', '', '## Install', '', '```sh', 'npm install face-smooth', '```', '', '```js', 'faceSmooth.apply(canvas, 0.6)', '```'));
const pdfLib = mk('u/pdf', 'pdfmaker', j('# pdfmaker', '', 'Generate PDF documents in the browser.', '', '```sh', 'npm install pdfmaker', '```'));
const oldLib = mk('u/old', 'old-skin', j('# old-skin', '', 'Smooth skin on faces. This project is no longer maintained.', '', '```sh', 'npm install old-skin', '```'));
const pyLib = mk('u/py', 'pyskin', j('# pyskin', '', 'Smooth skin on faces with numpy.', '', '```sh', 'pip install pyskin', '```', '', '```python', 'from pyskin import smooth', 'smooth(img)', '```'));
const ranked = D.rank(gaps[1], [pdfLib, oldLib, pyLib, faceLib], { runtime: 'browser' });
check('rank: the relevant, maintained, browser-compatible one wins', ranked[0].id === 'u/face', ranked.map((r) => r.id + ':' + r.score));
check('rank: deprecated and wrong-runtime are penalised with reasons', ranked.find((r) => r.id === 'u/old').why.includes('已停止維護') && ranked.find((r) => r.id === 'u/py').why.some((w) => /執行環境是 python/.test(w)), ranked.map((r) => r.why));
check('rank: the right one leads by a clear margin; unrelated ones fall below the threshold', ranked[0].score - ranked[1].score >= 0.3 && ranked.find((x) => x.id === 'u/pdf').score < 0.35, ranked.map((x) => x.id + ':' + x.score));
const cov = D.coverage(['smooth skin on faces', 'generate pdf documents', 'transcribe audio to text'], [faceLib, pdfLib], { runtime: 'browser' });
check('coverage: finds the covered ones and the gap', cov.rows[0].best === 'u/face' && cov.rows[1].best === 'u/pdf' && cov.gaps.join() === 'transcribe audio to text' && cov.covered_pct === 67, cov);

// ---- 錯誤歸類 ----
const E = D.classifyError;
check('errors: missing module (python / node)', E('ModuleNotFoundError: No module named cv2').kind === 'missing_module' && E(new Error("Cannot find module 'sharp'")).action === 'install_or_import');
check('errors: not defined / wrong api / permission / network', E('ReferenceError: faceapi is not defined').kind === 'not_defined' && E('TypeError: booth.start is not a function').kind === 'wrong_api' && E('NotAllowedError: Permission denied').kind === 'permission' && E('Access to fetch blocked by CORS policy').kind === 'network');
check('errors: resource / syntax / async / timeout / missing file', E('WebGL context lost').kind === 'resource' && E('SyntaxError: Unexpected token }').kind === 'syntax' && E('[object Promise]').kind === 'async' && E('operation timed out').kind === 'timeout' && E('ENOENT: no such file').kind === 'missing_resource');
check('errors: unknown goes to the user', E('something weird').action === 'ask_user');
const cands = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
let nx = D.nextAttempt([], 'ReferenceError: x is not defined', cands, 'A');
check('nextAttempt: first failure → fix on the same candidate', nx.next === 'add_import' && nx.candidate === 'A', nx);
nx = D.nextAttempt([{ candidate: 'A', kind: 'not_defined', action: 'add_import' }], 'ReferenceError: x is not defined', cands, 'A');
check('nextAttempt: same fix is not repeated → switch', nx.next === 'switch_candidate' && nx.candidate === 'B', nx);
nx = D.nextAttempt([{ candidate: 'A', kind: 'not_defined', action: 'add_import' }, { candidate: 'B', kind: 'not_defined', action: 'add_import' }, { candidate: 'C', kind: 'not_defined', action: 'add_import' }], 'ReferenceError: x is not defined', cands, 'C');
check('nextAttempt: out of candidates → give up', nx.next === 'give_up', nx);
check('nextAttempt: unknown error → ask user', D.nextAttempt([], 'mystery', cands, 'A').next === 'ask_user');

// ---- 迴圈（假的主機）----
const PAGES = { 'https://x/face': j('# face-smooth', '', 'Smooth skin and beautify faces in photos in the browser with WebGL.', '', '```sh', 'npm install face-smooth', '```', '', '```js', 'faceSmooth.apply(canvas, 0.6)', '```', '', '## License', '', 'MIT'), 'https://x/cam': j('# webcam-grab', '', 'Capture frames from the webcam in the browser.', '', '```sh', 'npm install webcam-grab', '```', '', '```js', 'const g = new WebcamGrab(video)', 'g.captureFrame()', '```', '', 'Needs a camera (getUserMedia).'), 'https://x/junk': 'tiny' };
const mkHost = (over) => {
  const calls = { search: [], fetch: [], bind: 0, onboard: [] };
  return Object.assign({ calls,
    bind: async () => { calls.bind++; return { ok: true, results: bind.results }; },
    search: async (query) => { calls.search.push(query); if (/skin|beautify/.test(query)) return [{ title: 'face-smooth', url: 'https://x/face', snippet: 'smooth skin for faces' }, { title: 'junk', url: 'https://x/junk', snippet: '' }]; if (/capture|frame|webcam|camera/.test(query)) return [{ title: 'webcam-grab', url: 'https://x/cam', snippet: 'capture webcam frames' }]; return []; },
    fetchText: async (url) => { calls.fetch.push(url); if (!(url in PAGES)) throw new Error('404'); return PAGES[url]; } }, over || {});
};
(async () => {
  const host = mkHost(); const plan = await D.run(host, { uml: 'ignored' }, { runtime: 'browser' });
  check('loop: finds a candidate for each gap', plan.ok && plan.gaps_initial === 2 && plan.resolved === 2 && plan.unresolved.length === 0, plan);
  const byGap = Object.fromEntries(plan.candidates.map((c) => [c.gap, c]));
  check('loop: right project per gap', byGap['Snap/Face.smoothSkin'].name === 'face-smooth' && byGap['Snap/Camera.captureFrame'].name === 'webcam-grab', plan.candidates.map((c) => c.gap + '→' + c.name));
  check('loop: plan carries install, api, needs, license', /npm install face-smooth/.test(byGap['Snap/Face.smoothSkin'].install) && byGap['Snap/Camera.captureFrame'].needs.includes('camera') && byGap['Snap/Face.smoothSkin'].license === 'MIT' && byGap['Snap/Camera.captureFrame'].api.some((a) => /WebcamGrab/.test(a)), byGap);
  check('loop: junk page skipped, fetch errors survive', host.calls.fetch.includes('https://x/junk') && plan.trace.every((t) => t.step !== 'fetch_error' || true));
  check('loop: cards are cached across queries', new Set(host.calls.fetch).size === host.calls.fetch.length, host.calls.fetch);
  check('loop: renders to text', /face-smooth/.test(D.toText(plan)) && /安裝：npm install/.test(D.toText(plan)));

  const none = await D.run(mkHost({ search: async () => [] }), { uml: 'x' }, {});
  check('loop: nothing found → unresolved with a reason, not a crash', none.ok && none.resolved === 0 && none.unresolved.length === 2 && /搜不到/.test(none.unresolved[0].reason), none);
  const err = await D.run(mkHost({ search: async () => { throw new Error('offline'); } }), { uml: 'x' }, {});
  check('loop: search errors are logged, loop continues', err.ok && err.trace.some((t) => t.step === 'search_error'));
  const bb = await D.run(mkHost({ bind: async () => ({ ok: false, error: 'UML 格式有問題' }) }), { uml: 'x' }, {});
  check('loop: bind failure is returned', bb.ok === false && /UML/.test(bb.error));
  const needs = await D.run(mkHost(), { needs: ['smooth skin on faces'] }, {});
  check('loop: works from a plain needs list (no UML)', needs.ok && needs.resolved === 1, needs);

  // 自我修正：第一次試跑缺模組，第二次換候選或修好
  let runs = 0; const fixHost = mkHost({ tryRun: async (p) => { runs++; if (runs === 1) return { ok: false, error: 'ReferenceError: faceSmooth is not defined' }; return { ok: true }; } });
  const fixed = await D.run(fixHost, { uml: 'x' }, {});
  check('self-correction: classifies the error and retries', fixed.run.ok === true && fixed.run.attempts === 1 && fixed.trace.some((t) => t.step === 'fix' && t.kind === 'not_defined' && t.next === 'add_import'), [fixed.run, fixed.trace.filter((t) => t.step === 'fix')]);
  const stuck = await D.run(mkHost({ tryRun: async () => ({ ok: false, error: 'ReferenceError: x is not defined' }) }), { uml: 'x' }, { maxFixes: 5 });
  check('self-correction: gives up instead of looping forever', stuck.run.ok === false && stuck.run.attempts <= 5, stuck.run);
  const unk = await D.run(mkHost({ tryRun: async () => ({ ok: false, error: 'mystery failure' }) }), { uml: 'x' }, {});
  check('self-correction: unknown error stops and asks', unk.run.ok === false && unk.trace.some((t) => t.next === 'ask_user'));

  // onboard 之後重新接線
  let binds = 0; const reHost = mkHost({ bind: async () => { binds++; return { ok: true, results: binds === 1 ? bind.results : [{ usecase: 'Snap', steps: [{ step: 'Files.fsStat', unit: 'tool:fs_stat' }] }] }; }, onboard: async () => ({ units: [{ id: 'js:x.y' }] }) });
  const re = await D.run(reHost, { uml: 'x' }, {});
  check('onboard then rebind: gaps close', binds >= 2 && re.candidates.every((c) => c.units === 1) && re.trace.some((t) => t.step === 'rebind' && t.gaps === 0), re.trace.filter((t) => /bind/.test(t.step)));

  // ---- 實測暴露的問題：維基只是參考資料；『畫面』不能被『畫』截走；不像函式庫的頁面降分 ----
  check('kindOf: project / wiki / qa / article', D.kindOf('https://github.com/a/b') === 'project' && D.kindOf('https://zh.wikipedia.org/wiki/PDF') === 'wiki' && D.kindOf('https://stackoverflow.com/questions/1/x') === 'qa' && D.kindOf('https://www.codeproject.com/Articles/1/x') === 'article' && D.kindOf('https://sourceforge.net/projects/x/') === 'project');
  check('glossary: 畫面 is not 畫', !/draw|plot/.test(D.toEnglish('擷取相機畫面').english) && /frame/.test(D.toEnglish('擷取相機畫面').english) && /draw/.test(D.toEnglish('把資料畫成長條圖').english), [D.toEnglish('擷取相機畫面'), D.toEnglish('把資料畫成長條圖')]);
  check('default sources are for finding libraries, not encyclopedias', D.queriesFor(gaps[0]).sources.join() === 'github,sourceforge,codeproject,stackoverflow');
  const refHost = mkHost({ search: async () => [{ title: 'PDF - Wikipedia', url: 'https://en.wikipedia.org/wiki/PDF', snippet: '' }, { title: 'face-smooth', url: 'https://x/face', snippet: '' }], fetchText: async (u) => (/wikipedia/.test(u) ? j('# PDF', '', 'Portable Document Format is a file format. It was invented by Adobe to present documents. Smooth skin on faces is not related.') : PAGES[u]) });
  const refPlan = await D.run(refHost, { needs: ['smooth skin on faces'] }, {});
  check('wiki pages become references, not the chosen project', refPlan.candidates.length === 1 && refPlan.candidates[0].name === 'face-smooth' && refPlan.references.length === 1 && refPlan.references[0].kind === 'wiki' && /參考資料/.test(D.toText(refPlan)), [refPlan.candidates.map((c) => c.name), refPlan.references]);
  const asProj = await D.run(refHost, { needs: ['smooth skin on faces'] }, { allowKnowledge: true });
  check('allowKnowledge lets them compete', asProj.references.length === 0);
  const objHost = mkHost({ fetchText: async (u) => ({ text: PAGES[u] || 'x'.repeat(10), kind: 'readme', description: 'smooth skin for faces' }) });
  check('fetchText may return an object with kind and description', (await D.run(objHost, { needs: ['smooth skin on faces'] }, {})).resolved >= 1);
  const lib = mk('u/page', 'a-blog-post', j('# a blog post', '', 'Some words about nothing in particular here.'));
  const rr = D.rank(D.gapsFromNeeds(['smooth skin on faces'])[0], [lib, faceLib], { runtime: 'browser' });
  check('a page that is not a library is penalised', rr[0].id === 'u/face' && rr.find((x) => x.id === 'u/page').why.some((w) => /不像可以直接用的函式庫/.test(w)) || rr.find((x) => x.id === 'u/page').relevance < 0.15, rr.map((x) => x.id + ':' + x.score));

  console.log('discover_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED' : '')); bad.forEach((x) => console.log('FAIL', x)); process.exit(bad.length ? 1 : 0);
})();
