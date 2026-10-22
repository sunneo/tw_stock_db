// node scripts/imagegen-tests/image_route.test.js -- 圖像生成分流（形狀圖 vs 擴散模型）與提示詞範本
const R = require('../../renderer/src/imagegen/image_route.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

// ---- 分流：單純形狀 → 純文字（svg／mermaid）；畫面與畫風 → 擴散模型
const shapes = ['畫一個登入流程的流程圖', '請畫系統架構圖，前端、API、資料庫三層', '用圓形和方形組成一個簡單的機器人圖示', 'draw a sequence diagram for OAuth login', '做一個長條圖示意各季營收', '甘特圖：專案排程'];
const photos = ['畫一隻在夕陽下的貓，水彩風格', 'a cinematic photo of a lone astronaut walking on a red desert', '賽博龐克風格的雨夜城市街道', '一個女孩坐在咖啡廳窗邊，油畫', '寫實風格的海邊風景'];
shapes.forEach((t) => check('shapes: ' + t, R.classify(t).route === 'shapes', R.classify(t)));
photos.forEach((t) => check('diffusion: ' + t, R.classify(t).route === 'diffusion', R.classify(t)));
check('flowchart wording picks mermaid; a plain geometric request picks svg', R.classify('畫登入流程的流程圖').format === 'mermaid' && R.classify('用圓形和三角形組成圖示').format === 'svg');
check('diagram types', R.diagramType('時序圖') === 'sequenceDiagram' && R.diagramType('甘特圖') === 'gantt' && R.diagramType('心智圖') === 'mindmap' && R.diagramType('流程圖') === 'flowchart' && R.diagramType('一隻貓') === null);
check('no cue at all -> asks (low confidence), defaults to diffusion', (() => { const c = R.classify('給我一張圖'); return c.ask === true && c.route === 'diffusion'; })());
check('a pasted image without shape words leans to diffusion', R.classify('畫成類似這張的', { hasImage: true }).route === 'diffusion');
check('classification explains itself', R.classify('畫流程圖').reasons.length > 0);

// ---- 欄位：程式能做的部分
const s1 = R.extractSlots('畫一隻在夕陽下的貓，水彩風格，特寫，溫馨');
check('slots: style, lighting, camera, mood are found by the program', s1.style === 'watercolor' && s1.lighting.tag === 'golden hour' && s1.camera.tag === 'close-up' && s1.mood.tag === 'warm, cozy', s1);
check('slots: noun dictionary translates common nouns', s1.subject.indexOf('cat') >= 0, s1.subject);
check('slots: unknown Chinese words are listed for translation, not guessed', (() => { const s = R.extractSlots('畫一隻饕餮'); return s.untranslated.indexOf('饕餮') >= 0 && s.subject.length === 0; })(), R.extractSlots('畫一隻饕餮'));
check('slots: English words pass through', R.extractSlots('a red vintage car on a street').extras.length > 0);
check('slots: colors', R.extractSlots('藍色的海和金色的沙灘').colors.join() === 'blue,golden', R.extractSlots('藍色的海和金色的沙灘').colors);
check('slots: single leftover characters are not treated as words to translate', R.extractSlots('畫成水彩風格').untranslated.length === 0, R.extractSlots('畫成水彩風格').untranslated);
check('slots: actions', R.extractSlots('小狗在草地上跑').action.indexOf('running') >= 0);
check('flux: fragments are joined into one sentence', (() => { const p = R.buildPrompt(R.extractSlots('畫一隻在夕陽下的貓，水彩風格，特寫'), 'flux').prompt; return (p.match(/\./g) || []).length === 1 && /, /.test(p); })(), R.buildPrompt(R.extractSlots('畫一隻在夕陽下的貓，水彩風格，特寫'), 'flux').prompt);

// ---- 模型給的欄位要通過驗證才收
check('mergeSlots: style must be in the closed list', R.mergeSlots(R.extractSlots('一隻饕餮'), { style: 'anime' }).style === 'anime' && R.mergeSlots(R.extractSlots('一隻饕餮'), { style: 'evil-wizard-mode' }).style === null);
check('mergeSlots: non-ASCII, markup and long text are stripped or limited', (() => { const m = R.mergeSlots(R.extractSlots('一隻饕餮'), { subject: 'mythical beast <script>alert(1)</script> 饕餮', extras: ['x'.repeat(200)] }); return !/[<>]/.test(m.subject.join()) && !/[^\x00-\x7f]/.test(m.subject.join()) && m.extras.every((e) => e.length <= 40); })());
check('mergeSlots: once there is a translated subject, untranslated is cleared', R.mergeSlots(R.extractSlots('一隻饕餮'), { subject: 'taotie, mythical beast' }).untranslated.length === 0);
check('mergeSlots ignores junk input', R.mergeSlots(R.extractSlots('貓'), null).subject.indexOf('cat') >= 0 && R.mergeSlots(R.extractSlots('貓'), 'x').subject.indexOf('cat') >= 0);

// ---- 範本：每一族吃的格式不一樣
const slots = R.extractSlots('畫一隻在夕陽下的貓，水彩風格，特寫，溫馨，藍色的天空');
const sd = R.buildPrompt(slots, 'sd15'), fx = R.buildPrompt(slots, 'flux'), s3 = R.buildPrompt(slots, 'sd3');
check('sd15: comma-separated keywords, subject first, no sentence', /^cat/.test(sd.prompt) && sd.prompt.indexOf(', ') > 0 && !/\. /.test(sd.prompt) && /watercolor/.test(sd.prompt) && /golden hour/.test(sd.prompt), sd.prompt);
check('sd15: stays inside the token budget', sd.tokens <= 70, sd);
check('flux: a natural sentence with the style phrase and no tag-style quality words', /^a watercolor painting of a cat/i.test(fx.prompt) && /\.$/.test(fx.prompt) && !/masterpiece/.test(fx.prompt), fx.prompt);
check('sd3: has quality words and a negative prompt', /highly detailed/.test(s3.prompt) && s3.negative.length > 0);
check('sd15 and flux have no negative prompt (and say so)', sd.negative === '' && fx.negative === '' && sd.notes.length === 1);
check('a tiny token budget drops the lightest parts first and reports them', (() => { const p = R.buildPrompt(slots, 'sd15', { maxTokens: 8 }); return /^cat/.test(p.prompt) && p.dropped.length > 0 && p.dropped.indexOf('subject') < 0 && p.tokens <= 8; })(), R.buildPrompt(slots, 'sd15', { maxTokens: 8 }));
check('flux respects its character limit', (() => { const big = { subject: ['a'.repeat(100)], action: [], setting: ['b'.repeat(250)], style: 'photo', lighting: null, camera: null, mood: null, colors: [], extras: ['c'.repeat(60)], untranslated: [] }; return R.buildPrompt(big, 'flux').prompt.length <= 330; })());
check('empty slots still give a usable prompt', R.buildPrompt(R.extractSlots(''), 'sd15').prompt.length > 0);
check('familyOf', R.familyOf('sdxs-512-cpu-int8') === 'sd15' && R.familyOf('black-forest-labs/flux.1-schnell') === 'flux' && R.familyOf('stabilityai/stable-diffusion-3-medium') === 'sd3' && R.familyOf('unknown') === 'flux');
check('estimateTokens is a conservative count', R.estimateTokens('a cat, sitting') >= 4 && R.estimateTokens('') === 0);

// ---- VLM 的描述 → 欄位
const cs = R.slotsFromCaption('This is a photograph of a red fox standing in a snowy forest at sunset. The fox looks at the camera.');
check('caption: subject, style, colors, lighting', /red fox/.test(cs.subject[0]) && cs.style === 'photo' && cs.colors.indexOf('red') >= 0 && cs.lighting && cs.lighting.tag === 'golden hour', cs);
check('caption: empty caption gives empty slots', R.slotsFromCaption('').subject.length === 0);
check('caption slots go through the same templates', /red fox/.test(R.buildPrompt(cs, 'sd15').prompt));

// ---- 形狀圖：提示詞與驗證
check('svg brief states the canvas and the safety rules', (() => { const b = R.svgBrief('三個圓', {}); return /viewBox="0 0 512 512"/.test(b.user) && /不要 script/.test(b.user); })());
check('mermaid brief names the diagram type', /sequenceDiagram/.test(R.mermaidBrief('x', 'sequenceDiagram').user));
check('extractSvg finds the svg in chatter and fences', R.extractSvg('好的：\n```svg\n<svg viewBox="0 0 1 1"><rect/></svg>\n```') === '<svg viewBox="0 0 1 1"><rect/></svg>' && R.extractSvg('沒有圖') === '');
check('extractMermaid unwraps a fence', R.extractMermaid('```mermaid\nflowchart TD\nA-->B\n```') === 'flowchart TD\nA-->B');
const good = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#fff"/><circle cx="256" cy="256" r="80"/><text x="10" y="20">hi</text></svg>';
check('validateSvg accepts a normal drawing', R.validateSvg(good).ok && R.validateSvg(good).elements === 3);
check('validateSvg refuses script, handlers, external images and empty drawings', !R.validateSvg('<svg viewBox="0 0 1 1"><script>1</script><rect/></svg>').ok && !R.validateSvg('<svg viewBox="0 0 1 1"><rect onclick="x()"/></svg>').ok && !R.validateSvg('<svg viewBox="0 0 1 1"></svg>').ok && !R.validateSvg('hello').ok && !R.validateSvg('<svg><image href="https://evil/x.png"/><rect/></svg>').ok);
check('validateMermaid', R.validateMermaid('flowchart TD\nA-->B').ok && R.validateMermaid('graph LR\nA-->B').ok && !R.validateMermaid('這是流程').ok && !R.validateMermaid('').ok);

// ---- 整體計畫
check('plan: shapes request yields a format and no diffusion slots', (() => { const p = R.plan('畫登入流程的流程圖'); return p.route === 'shapes' && p.format === 'mermaid' && !p.slots; })());
check('plan: diffusion request yields slots; an unknown subject asks for translation', (() => { const p = R.plan('畫一隻饕餮，水彩'); return p.route === 'diffusion' && p.slots.style === 'watercolor' && p.needsTranslate === true; })());

// ---- 使用者自訂範本
check('configure: a custom style is found by its Chinese keyword and shows up in the prompt', (() => { R.configure({ styles: [{ id: 'ghibli', zh: '吉卜力，宮崎駿', tags: 'ghibli style, soft pastel, hand painted', phrase: 'a Ghibli-style painting' }] }); const s = R.extractSlots('畫一隻貓，吉卜力風格'); return s.style === 'ghibli' && /ghibli style/.test(R.buildPrompt(s, 'sd15').prompt) && /^a Ghibli-style painting of a cat/.test(R.buildPrompt(s, 'flux').prompt); })());
check('configure: styles with no keyword or no tags are skipped and reported; non-ASCII tags are stripped', (() => { const r = R.configure({ styles: [{ zh: '甲', tags: '' }, { zh: '', tags: 'x' }, { id: 'ok', zh: '乙', tags: '漂亮 neon glow' }] }); return r.added === 1 && r.skipped.length === 2 && R.STYLES.ok.tags.join() === 'neon glow'; })());
check('configure: extra negative words and quality words apply to the families that use them', (() => { R.configure({ negative: 'extra fingers', quality: { sd3: 'award winning, 8k' } }); const s = R.extractSlots('貓'); return /extra fingers/.test(R.buildPrompt(s, 'sd3').negative) && /8k/.test(R.buildPrompt(s, 'sd3').prompt); })());
check('configure({}) goes back to the built-in templates', (() => { R.configure({}); const s = R.extractSlots('畫一隻貓，水彩'); return !R.STYLES.ghibli && !R.STYLES.ok && !/extra fingers/.test(R.buildPrompt(s, 'sd3').negative) && /highly detailed/.test(R.buildPrompt(s, 'sd3').prompt); })());
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'image_route: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
