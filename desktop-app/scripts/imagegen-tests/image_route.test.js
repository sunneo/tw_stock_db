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
check('no cue at all -> diffusion without asking a model (no shape words means not a shape drawing)', (() => { const c = R.classify('給我一張圖'); return c.ask === false && c.route === 'diffusion'; })());
check('scene requests go to diffusion without asking', ['產生一個音樂會的場景', '產生音樂會場景', '畫一個熱鬧的夜市'].every((t) => { const c = R.classify(t); return c.route === 'diffusion' && c.ask === false; }));
check('mixed or weak shape cues still ask', R.classify('畫一個圖示風格的貓').ask === true || R.classify('畫一個圖示風格的貓').route === 'diffusion');
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

// ---- 反思（構想）：擴散模型不熟的概念，先想要準備哪些主體、場景元素與素材
check('reflect: needed for a scene, for unknown words, for several subjects; not for a simple known subject', (() => { const f = (t, o) => R.reflectNeeded(t, R.extractSlots(t), o).need; return f('產生一個音樂會的場景') && f('哥倫布在月球騎馬') && !f('畫一隻貓，水彩風格') && !f('畫一隻貓', {}) ; })());
check('reflect: can be forced on or off', R.reflectNeeded('畫一隻貓', R.extractSlots('畫一隻貓'), { reflect: true }).need && !R.reflectNeeded('音樂會的場景', R.extractSlots('音樂會的場景'), { reflect: false }).need);
check('reflect: the brief asks as an animator / svg artist / 3d designer and demands json', (() => { const b = R.reflectBrief('音樂會的場景'); return /2D 動畫/.test(b.user) && /SVG/.test(b.user) && /3D/.test(b.user) && /JSON/.test(b.user) && /音樂會的場景/.test(b.user); })());
check('reflect: a good answer fills subject, setting (with the layout) and extras', (() => { const s0 = R.extractSlots('產生一個音樂會的場景'); const r = R.applyReflection(s0, '好的：{"subject":["a rock band"],"setting":["concert stage"],"extras":["spotlights","crowd silhouettes","speaker stacks"],"layout":"band on stage in the center, crowd in the foreground"}'); return r.ok && r.slots.subject.indexOf('a rock band') >= 0 && r.slots.setting.some((x) => /crowd in the foreground/.test(x)) && r.slots.extras.length === 3 && /foreground/.test(r.layout); })());
check('reflect: junk or non-json answers change nothing; non-ascii and markup are stripped', (() => { const s0 = R.extractSlots('音樂會的場景'); const a = R.applyReflection(s0, '我不知道'), b = R.applyReflection(s0, '{"subject":["<b>搖滾樂團</b>"],"extras":["spot<script>"]}'); return !a.ok && a.slots === s0 && !/[<>\u4e00-\u9fff]/.test(JSON.stringify(b.slots.subject) + JSON.stringify(b.slots.extras)); })());
check('reflect: the english result goes through the normal templates (sd15 and flux)', (() => { const r = R.applyReflection(R.extractSlots('哥倫布在月球騎馬'), '{"subject":["Columbus","a horse"],"setting":["the moon surface"],"extras":["craters","earth in the sky"],"layout":"Columbus riding a horse in the foreground, huge moon behind"}'); return /columbus/.test(R.buildPrompt(r.slots, 'sd15').prompt) && /moon/.test(R.buildPrompt(r.slots, 'flux').prompt) && r.slots.untranslated.length === 0; })());

// ---- 場景素材目錄（背景知識）與主體關係
const SC = require('../../renderer/src/imagegen/scene_catalog.js');
check('catalog: a concert request is recognized by the program and fills elements and layout without any model', (() => { const m = SC.match('產生一個音樂會的場景'); if (!m.length || m[0].id !== 'concert') return false; const r = R.applyScene(R.extractSlots('產生一個音樂會的場景'), SC.toLlmSlots(m[0].entry), m[0].hit); const p = R.buildPrompt(r.slots, 'sd15').prompt; return r.got > 3 && /stage/.test(p) && !R.reflectNeeded('產生一個音樂會的場景', r.slots, { catalogHit: true }).need; })());
check('catalog: unknown scenes are not matched; two matches at most; the moon is found', SC.match('畫一隻貓').length === 0 && SC.match('音樂會在教室裡').length === 2 && SC.match('哥倫布在月球騎馬')[0].id === 'moon');
check('catalog: every entry has english fields only, a layout and keywords', SC.SCENES.every((s) => s.zh.length && s.layout && !/[^\x00-\x7f]/.test(s.layout + s.setting.join() + s.extras.join() + s.subject.join())) && SC.SCENES.length >= 35);
check('catalog: hints are handed to the model brief', (() => { const h = SC.hints(SC.match('音樂會')); const b = R.reflectBrief('音樂會', h); return /音樂會／演唱會/.test(b.user) && /spotlights/.test(b.user); })());
check('relations: only words from the closed list are accepted and they become a subject phrase', (() => { const r = R.applyReflection(R.extractSlots('哥倫布在月球騎馬'), '{"relations":[{"a":"Columbus","rel":"riding","b":"a horse"},{"a":"x","rel":"destroying","b":"y"}],"subject":["a horse"],"layout":"x"}'); return r.slots.subject.indexOf('columbus riding a horse') >= 0 && !r.slots.subject.some((x) => /destroying/.test(x)); })());
check('relations: the brief lists the closed relation words', /riding/.test(R.reflectBrief('x').user) && R.RELATIONS.indexOf('riding') >= 0);

// ---- 細節（從封閉清單挑）
check('details: only the missing ones are asked; the brief lists closed choices', (() => { const s0 = R.extractSlots('畫一隻貓，水彩風格'); const m = R.detailMissing(s0); const b = R.detailBrief('畫一隻貓', s0, m); return m.indexOf('style') < 0 && m.indexOf('lighting') >= 0 && /golden hour/.test(b.user) && !/watercolor/.test(b.user.split('style')[1] || 'x'); })());
check('details: choices outside the lists are refused, inside are taken', (() => { const s0 = R.extractSlots('音樂會'); const r = R.applyDetails(s0, '{"style":"cinematic","lighting":"golden hour","camera":"drone-shot","mood":"warm, cozy"}'); return r.slots.style === 'cinematic' && r.slots.lighting.tag === 'golden hour' && !r.slots.camera && r.slots.mood.tag === 'warm, cozy' && r.got.join() === 'style,lighting,mood'; })());
check('details: junk changes nothing; styles already chosen are not overridden', (() => { const s0 = R.extractSlots('水彩貓'); const a = R.applyDetails(s0, '隨便'), b = R.applyDetails(s0, '{"style":"anime"}'); return a.got.length === 0 && b.slots.style === 'watercolor'; })());
// ---- 修圖：程式量得到的先用程式處理
const mk = (v, sat) => { const w = 50, h = 50, d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const x = v(i); d[i * 4] = x[0]; d[i * 4 + 1] = x[1]; d[i * 4 + 2] = x[2]; d[i * 4 + 3] = 255; } return { width: w, height: h, data: d }; };
const darkImg = mk((i) => [30 + (i % 7), 30, 32]), brightImg = mk((i) => [230, 232 - (i % 5), 228]), goodImg = mk((i) => (i % 2 ? [210, 170, 130] : [40, 55, 85]));
check('stats: darkImg, brightImg and balanced pictures are told apart', R.imageStats(darkImg).mean < 60 && R.imageStats(brightImg).mean > 200 && R.imageStats(goodImg).std > 40, [R.imageStats(darkImg), R.imageStats(brightImg), R.imageStats(goodImg)]);
check('retouch: a darkImg flat picture gets contrast and brightness; a brightImg one gets pulled down; a balanced one is only sharpened lightly', (() => { const a = R.retouchPlan(R.imageStats(darkImg)), b = R.retouchPlan(R.imageStats(brightImg)), c = R.retouchPlan(R.imageStats(goodImg)); const has = (p, op, sign) => p.ops.some((o) => o.op === op && (sign ? o.amount * sign > 0 : true)); return has(a, 'auto_contrast') && has(a, 'brightness', 1) && has(b, 'brightness', -1) && c.ops.length === 1 && c.ops[0].op === 'sharpen' && a.why.length >= 2; })());
check('retouch: every planned op name is one imgproc understands', (() => { const P = require('../../renderer/src/imgproc/imgproc_core.js'); return ['darkImg', 'brightImg', 'goodImg'].every((k) => { const pl = R.retouchPlan(R.imageStats({ darkImg, brightImg, goodImg }[k])); return P.normalizeOps(pl.ops).ok; }); })());
// ---- 視覺模型的檢查與草稿
check('check: only elements from the required list are kept', (() => { const r = R.parseCheck('{"missing":["crowd silhouettes","a unicorn"],"ok":false}', ['spotlights', 'crowd silhouettes with raised hands']); return r.missing.join() === 'crowd silhouettes' && r.ok === false; })());
check('check: nothing missing and ok=true is a pass; junk is null', R.parseCheck('{"missing":[],"ok":true}', ['x']).ok === true && R.parseCheck('not json', ['x']) === null);
check('draft: gaps are the wanted elements the vlm never mentioned', (() => { const g = R.draftGaps('A diagram with a stage in the center and a crowd at the bottom.', ['concert stage', 'crowd silhouettes', 'speaker stacks']); return g.length === 1 && g[0] === 'speaker stacks'; })());
check('draft: the request lists the elements and the layout', (() => { const s0 = R.applyScene(R.extractSlots('音樂會場景'), { subject: ['a band'], setting: ['concert stage'], extras: ['spotlights'], layout: 'band center, crowd in front' }).slots; const r = R.draftRequest('音樂會場景', s0); return /a band/.test(r) && /spotlights/.test(r) && /crowd in front/.test(r); })());
check('catalog scene keeps the words it could not translate so they still get translated', (() => { const s0 = R.extractSlots('哥倫布在月球騎馬'); const r = R.applyScene(s0, { subject: [], setting: ['lunar surface'], extras: ['craters'], layout: '' }, ['月球']); return r.slots.untranslated.join() === '哥倫布' && s0.untranslated.length > 1; })());
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'image_route: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
