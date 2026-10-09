// node test/media/deck_core.test.js -- the deck format, validator, timing, cue schedule, timeline and the frame renderer (against a recording mock canvas)
const C = require('../../renderer/src/deck/deck_core.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : '')); }

const GOOD = `
deck: { title: "BMC 韌體更新流程", lang: zh-TW, voice: zh-TW-HsiaoChenNeural }
chapters:
  - title: 背景
    slides:
      - id: s1
        layout: title
        title: BMC 韌體更新流程
        narration: 這份簡報說明 BMC 韌體更新的完整流程。
      - id: s2
        title: 更新的三個階段
        bullets: [下載映像, 驗證簽章, 寫入並重啟]
        narration: 更新分成三個階段。先下載映像。接著驗證簽章。最後寫入並重啟。
        visual:
          kind: shapes
          mode: loop
          scene:
            width: 480
            height: 320
            duration: 4
            shapes:
              - { id: dl, type: circle, radius: 30, fill: "#77BD1D", position: [100, 160] }
              - { id: fw, type: rect, width: 80, height: 50, fill: "#0E2841", animation: { type: move, from: [200, 160], to: [380, 160], duration: 2, loop: pingpong } }
        cues:
          - { at: "sentence:3", show: "shape:fw", effect: pop }
        transition: { type: slide-left, ms: 500 }
  - title: 資料
    slides:
      - id: s3
        title: 版本對照
        visual:
          kind: table
          header: [版本, 日期, 說明]
          rows: [["1.0", "2026-01", "初版"], ["1.1", "2026-03", "修正簽章驗證"], ["1.2", "2026-06", "新增回復機制"]]
        narration: 這是版本對照表。第一版是初版。後來修正了簽章驗證。
      - id: s4
        title: 畫面說明
        bullets: [登入頁面]
        visual:
          kind: image
          images: [{ src: "https://redmine.example/attachments/download/12/a.png", caption: 登入畫面 }]
          callouts: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.2, text: 帳號欄位 }]
        cues: [{ at: "sec:1.5", show: "callout:0" }]
        duration: 6
`;
const doc = yaml.load(GOOD);
let v = C.validate(doc);
check('a good deck validates', v.errors.length === 0, v.errors);
const deck = C.normalize(doc);
check('normalize flattens chapters into slides with defaults', deck.slides.length === 4 && deck.slides[0].layout === 'title' && deck.slides[1].layout === 'split' && deck.slides[2].layout === 'visual' && deck.slides[0].transition.type === 'none' && deck.slides[2].transition.type === 'fade', deck.slides.map(s => s.layout));
check('chapter bookkeeping', deck.chapters.length === 2 && deck.chapters[1].first === 2 && deck.slides[2].chapterTitle === '資料');
check('still images get a gentle default motion, shapes do not', deck.slides[3].visual.motion.type === 'float' && deck.slides[1].visual.motion.type === 'none');

// validator: the messages name the field and the fix
function errs(mut) { const d = yaml.load(GOOD); mut(d); return C.validate(d).errors.join('\n'); }
check('v: missing title', /deck\.title/.test(errs(d => { delete d.deck.title; })));
check('v: unknown layout', /layout.*one of/.test(errs(d => { d.chapters[0].slides[0].layout = 'poster'; })));
check('v: too many bullets', /at most 6 bullets/.test(errs(d => { d.chapters[0].slides[1].bullets = ['1', '2', '3', '4', '5', '6', '7']; })));
check('v: cue sentence that does not exist', /sentence 9 does not exist/.test(errs(d => { d.chapters[0].slides[1].cues = [{ at: 'sentence:9', show: 'bullet:0' }]; })));
check('v: cue on an unknown shape id', /no shape with id "zz"/.test(errs(d => { d.chapters[0].slides[1].cues = [{ at: 'sentence:2', show: 'shape:zz' }]; })));
check('v: table row length mismatch names the row', /rows\[1\].*3 cells|has 2 cells but the header has 3/.test(errs(d => { d.chapters[1].slides[0].visual.rows[1] = ['x', 'y']; })));
check('v: table too tall asks to split', /split the table/.test(errs(d => { d.chapters[1].slides[0].visual.rows = Array.from({ length: 13 }, () => ['a', 'b', 'c']); })));
check('v: image callout needs fractions', /fractions 0..1/.test(errs(d => { d.chapters[1].slides[1].visual.callouts[0].w = 5; })));
check('v: svg with a script is refused', /scripts or event handlers/.test(errs(d => { d.chapters[0].slides[1].visual = { kind: 'svg', svg: '<svg><script>alert(1)</script></svg>' }; })));
check('v: duplicate slide id', /duplicate id/.test(errs(d => { d.chapters[1].slides[0].id = 's1'; })));
check('v: shapes without a scene', /scene\.shapes/.test(errs(d => { d.chapters[0].slides[1].visual = { kind: 'shapes' }; })));
check('v: not a mapping', C.validate('x').errors[0].indexOf('mapping') > 0);
let threw = false; try { C.normalize({ deck: {}, chapters: [] }); } catch (e) { threw = Array.isArray(e.errors) && e.errors.length >= 2; } check('normalize throws with all errors', threw);

// sentences
check('sentences: CJK and latin, decimals stay whole', JSON.stringify(C.splitSentences('更新分成三個階段。先下載映像！Version 3.5 is out. Next step? ok')) === JSON.stringify(['更新分成三個階段。', '先下載映像！', 'Version 3.5 is out.', 'Next step?', 'ok']));
check('sentences: closing quote stays with its sentence', C.splitSentences('他說「好。」然後離開。').length === 2);
const dist = C.distribute(['aaaa', 'bb'], 6, 0.3);
check('timing: sentences share the narration in proportion to their length', Math.abs(dist[0].end - 4.3) < 1e-9 && Math.abs(dist[1].end - 6.3) < 1e-9);
const tm = C.timingFor(deck.slides[1], 8, 0);
check('timing: duration = lead + audio + tail', Math.abs(tm.duration - (0.3 + 8 + 0.6)) < 1e-9 && tm.audioKnown && tm.sentences.length === 4);
check('timing: no audio -> estimated from the text, flagged unknown', !C.timingFor(deck.slides[1], 0, 0).audioKnown && C.timingFor(deck.slides[1], 0, 0).duration > 2.5);
check('timing: a silent slide lasts its duration or 4 s', C.timingFor(deck.slides[3], 0, 0).duration === 6 && C.timingFor({ narration: '', visual: null, duration: 0 }, 0, 0).duration === 4);

// cue schedule
const t1 = C.timingFor(deck.slides[1], 8, 0);
const sch = C.cueSchedule(deck.slides[1], t1);
const bull = sch.filter(c => c.target.type === 'bullet');
check('cues: bullets auto-reveal one per sentence, skipping the intro sentence', bull.length === 3 && Math.abs(bull[0].at - t1.sentences[1].start) < 1e-9 && Math.abs(bull[2].at - t1.sentences[3].start) < 1e-9, bull.map(b => b.at));
const shapeCue = sch.find(c => c.target.type === 'shape');
check('cues: an explicit shape cue lands at the start of sentence 3', shapeCue && Math.abs(shapeCue.at - t1.sentences[2].start) < 1e-9 && shapeCue.effect === 'pop');
const rows = C.cueSchedule(deck.slides[2], C.timingFor(deck.slides[2], 6, 0)).filter(c => c.target.type === 'row');
check('cues: table rows reveal one after another', rows.length === 3 && rows[0].at < rows[1].at && rows[1].at < rows[2].at);
check('state: before its cue an element is hidden, after it is fully shown', C.elementState(sch, 'shape:fw', 0).p === 0 && C.elementState(sch, 'shape:fw', shapeCue.at + 5).p === 1 && C.elementState(sch, 'title', 1).p === 1);
check('state: pulse is a bump that returns to rest', (() => { const s = [{ kind: 'emphasize', key: 'visual', at: 1, ms: 1000 }]; return C.elementState(s, 'visual', 1.5).pulse > 0.9 && C.elementState(s, 'visual', 3).pulse === 0; })());

// timeline
const timings = deck.slides.map((s, i) => C.timingFor(s, [3, 8, 6, 0][i], 0));
const tl = C.buildTimeline(deck, timings);
check('timeline: transition into slide i runs before its body, first slide has none', tl.segs[0].transDur === 0 && tl.segs[1].transDur === 0.5 && Math.abs(tl.segs[1].bodyStart - (tl.segs[0].end + 0.5)) < 1e-9 && Math.abs(tl.total - tl.segs[3].end) < 1e-9);
check('locate: inside a transition / a body / past the end', C.locate(tl, tl.segs[1].transStart + 0.25).phase === 'transition' && C.locate(tl, tl.segs[1].transStart + 0.25).i === 1 && Math.abs(C.locate(tl, tl.segs[1].transStart + 0.25).p - 0.5) < 1e-9 && C.locate(tl, tl.segs[1].bodyStart + 2).phase === 'body' && Math.abs(C.locate(tl, tl.segs[1].bodyStart + 2).t - 2) < 1e-9 && C.locate(tl, 1e6).i === 3);

// subtitles file
const srt = C.buildSubtitleFile(deck, tl, timings, 'srt'), vtt = C.buildSubtitleFile(deck, tl, timings, 'vtt');
check('srt/vtt: numbered cues with comma/dot times, one per sentence', /^1\n00:00:00,300 --> /.test(srt) && vtt.indexOf('WEBVTT') === 0 && /00:00:00\.300 --> /.test(vtt) && srt.split('\n\n').filter(Boolean).length === 8, srt.slice(0, 200));

// renderer against a recording mock
function mockCtx() {
  const calls = []; const c = { calls, canvas: { width: 1920, height: 1080 }, measureText: (t) => ({ width: String(t).length * 20 }) };
  ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'rect', 'arc', 'fill', 'stroke', 'clip', 'translate', 'scale', 'rotate', 'setTransform', 'fillRect', 'clearRect', 'drawImage', 'strokeRect']
    .forEach(n => { c[n] = (...a) => { calls.push([n, ...a]); }; });
  c.fillText = (t, x, y) => { calls.push(['fillText', t, x, y]); };
  return c;
}
const fakeImg = { width: 800, height: 600, naturalWidth: 800, naturalHeight: 600 };
const info = { width: 1920, height: 1080, subtitles: true, assets: {}, makeCanvas: () => ({ getContext: () => mockCtx() }),
  preps: deck.slides.map((s, i) => ({ timing: timings[i], visual: s.visual && s.visual.kind === 'image' ? { images: [fakeImg] } : (s.visual && s.visual.kind === 'shapes' ? { duration: 4, draw: (ctx, rect, tv, fx) => { ctx.fillRect(rect.x, rect.y, 1, 1); info.lastFx = fx; info.lastTv = tv; } } : null) })) };
function texts(ctx) { return ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1]); }
let ctx = mockCtx(); C.renderFrame(ctx, deck, tl, tl.segs[0].bodyStart + 1, info);
check('render: title slide draws its title and the first subtitle', texts(ctx).indexOf('BMC 韌體更新流程') >= 0 && texts(ctx).some(t => /簡報說明/.test(t)));
ctx = mockCtx(); C.renderFrame(ctx, deck, tl, tl.segs[1].bodyStart + 0.1, info);
check('render: content slide shows title + chapter label, no bullets yet', texts(ctx).indexOf('更新的三個階段') >= 0 && texts(ctx).some(t => /1 · 背景/.test(t)) && texts(ctx).indexOf('下載映像') < 0);
ctx = mockCtx(); C.renderFrame(ctx, deck, tl, tl.segs[1].bodyStart + 7, info);
check('render: later in the slide all bullets are there, and the visual got a time + the shape cue state', ['下載映像', '驗證簽章', '寫入並重啟'].every(b => texts(ctx).indexOf(b) >= 0) && info.lastTv >= 0 && info.lastFx.fw && info.lastFx.fw.p === 1, [info.lastTv, info.lastFx]);
check('render: a loop visual wraps its time within its period', (() => { C.renderFrame(mockCtx(), deck, tl, tl.segs[1].bodyStart + 7.5, info); return info.lastTv < 4; })());
ctx = mockCtx(); C.renderFrame(ctx, deck, tl, tl.segs[2].bodyStart + 5, info);
check('render: table header and all rows after reveal', ['版本', '日期', '說明', '修正簽章驗證', '新增回復機制'].every(s => texts(ctx).indexOf(s) >= 0), texts(ctx));
ctx = mockCtx(); C.renderFrame(ctx, deck, tl, tl.segs[3].bodyStart + 3, info);
check('render: image with caption and a callout once cued', ctx.calls.some(c => c[0] === 'drawImage' && c[1] === fakeImg) && texts(ctx).indexOf('登入畫面') >= 0 && texts(ctx).indexOf('帳號欄位') >= 0);
ctx = mockCtx(); C.renderFrame(ctx, deck, tl, tl.segs[3].bodyStart + 0.5, info);
check('render: the callout is hidden before its cue', texts(ctx).indexOf('帳號欄位') < 0);
ctx = mockCtx(); C.renderFrame(ctx, deck, tl, tl.segs[1].transStart + 0.25, info);
check('render: during a transition both slides are composed through drawImage', ctx.calls.filter(c => c[0] === 'drawImage').length >= 2);
{ const small = Object.assign({}, info, { width: 1280, height: 720 }); const c2 = mockCtx(); C.renderFrame(c2, deck, tl, tl.segs[1].transStart + 0.25, small);
  const sets = c2.calls.filter(c => c[0] === 'setTransform');
  check('render: a transition keeps the design-space scale (one setTransform of 2/3, no identity reset after it)', sets.length === 1 && Math.abs(sets[0][1] - 1280 / 1920) < 1e-9, sets); }
for (const type of C.TRANSITIONS) { const d2 = JSON.parse(JSON.stringify(deck)); d2.slides[1].transition.type = type; const tl2 = C.buildTimeline(d2, timings); let t = false; try { C.renderFrame(mockCtx(), d2, tl2, tl2.segs[1].transStart + (tl2.segs[1].transDur || 0.1) / 2, info); } catch (e) { t = e.message; } check('render: transition ' + type + ' draws without error', !t, t); }
let allOk = true; try { for (let T = 0; T < tl.total; T += 0.37) { C.renderFrame(mockCtx(), deck, tl, T, info); } } catch (e) { allOk = e.stack; } check('render: every frame of the whole deck draws without error', allOk === true, allOk);
check('render is deterministic', (() => { const a = mockCtx(), b = mockCtx(); C.renderFrame(a, deck, tl, 9.1, info); C.renderFrame(b, deck, tl, 9.1, info); return JSON.stringify(a.calls) === JSON.stringify(b.calls); })());

ctx = mockCtx(); C.renderVisualSnapshot(ctx, deck.slides[2], info.preps[2], C.visualRect('visual'));
check('snapshot: the table is drawn complete (all rows) with no animation state', ['初版', '修正簽章驗證', '新增回復機制'].every(s => texts(ctx).indexOf(s) >= 0));


// ---- mixing 2D and 3D: group, overlay, inline/ref 3D, per-slide stage, the 3D stage with a mock
const MIX = `
deck: { title: "BMC 板卡", lang: zh-TW, style: 3d }
chapters:
  - title: 硬體
    slides:
      - { id: t1, layout: title, title: BMC 板卡導覽, narration: 這是板卡導覽。 }
      - id: m1
        title: 晶片模型
        bullets: [主晶片, 風扇]
        narration: 先看晶片。注意這個標籤。再看風扇。
        visual:
          kind: scene3d
          scene: { duration: 8, nodes: [ { id: chip, mesh: box, size: [2, 0.3, 2], material: { color: "#77BD1D" }, animation: { type: spin, speed: 0.5 } } ] }
          overlay: { scene: { width: 1840, height: 740, shapes: [ { id: tag, type: text, content: CPU, font_size: 40, fill: "#fff", position: [900, 300] } ] } }
        cues: [ { at: "sentence:2", show: "shape:tag", effect: pop } ]
        transition: { type: curtain, ms: 1400 }
      - id: m2
        title: 特寫
        bullets: [晶片]
        narration: 現在拉近。看這顆晶片。
        visual: { kind: scene3d, ref: "https://r.example/attachments/download/7/b.3dscene.yaml" }
        camera: [ front, { preset: closeup, focus: chip, at: "sentence:2" } ]
        transition: { type: fly, ms: 1400 }
      - id: g1
        title: 並排
        stage: flat
        visual:
          kind: group
          items:
            - { box: [0, 0, 0.55, 1], kind: scene3d, ref: "https://r.example/attachments/download/9/x.3dscene.yaml" }
            - { box: [0.58, 0.1, 0.42, 0.8], kind: table, header: [零件, 數量], rows: [["風扇", "2"], ["晶片", "1"]] }
        narration: 左邊是模型。右邊是零件表。
      - id: s3d
        title: 沒有模型的 3D 頁
        stage: 3d
        visual: { kind: table, header: [a, b], rows: [["1", "2"]] }
        narration: 這一頁沒有 3D 模型,照平面版型畫。
        transition: { type: spin, ms: 1000 }
`;
const mdoc = yaml.load(MIX);
check('mix: a deck with 3D, overlay, group and per-slide stage validates', C.validate(mdoc).errors.length === 0, C.validate(mdoc).errors);
const mdeck = C.normalize(mdoc);
check('mix: style 3d is the default stage, a slide can override it; 3D decks default to the camera fly', mdeck.slides.map(s => s.stage).join() === '3d,3d,3d,flat,3d' && mdeck.slides[1].transition.type === 'curtain' && mdeck.slides[3].transition.type === 'fly' && mdeck.slides[3].transition.ms === 1400);
check('camera: a shot list is normalized (a preset name becomes {preset}); the default environment follows the company template', mdeck.slides[2].camera.length === 2 && mdeck.slides[2].camera[0].preset === 'front' && mdeck.slides[2].camera[1].focus === 'chip' && mdeck.slides[1].camera === null && mdeck.deck.environment === 'template');
function merrs(mut) { const d = yaml.load(MIX); mut(d); return C.validate(d).errors.join('\n'); }
check('mix v: group item needs a box inside the area', /items\[0\]\.box: needs box/.test(merrs(d => { d.chapters[0].slides[3].visual.items[0].box = [0.7, 0, 0.6, 1]; })));
check('mix v: a group cannot nest', /cannot be nested/.test(merrs(d => { d.chapters[0].slides[3].visual.items[1] = { kind: 'group', box: [0.5, 0, 0.5, 1], items: [] }; })));
check('mix v: overlay must be a 2D scene', /overlay: must be \{scene/.test(merrs(d => { d.chapters[0].slides[1].visual.overlay = { scene: {} }; })));
check('mix v: a cue can address an overlay shape, an unknown one is refused', /no shape with id "nope"/.test(merrs(d => { d.chapters[0].slides[1].cues = [{ at: 'sentence:2', show: 'shape:nope' }]; })));
check('mix v: scene3d needs a ref or an inline scene; stage/style values checked', /needs "ref"/.test(merrs(d => { d.chapters[0].slides[1].visual = { kind: 'scene3d' }; })) && /stage: must be flat or 3d/.test(merrs(d => { d.chapters[0].slides[1].stage = 'hologram'; })) && /deck\.style/.test(merrs(d => { d.deck.style = 'cube'; })) && /transition\.type/.test(merrs(d => { d.chapters[0].slides[1].transition.type = 'carousel'; })));

check('camera v: unknown preset, out of range distance / elevation, unknown key, bad focus, first shot with a late "at" are refused',
  /preset: must be one of/.test(merrs(d => { d.chapters[0].slides[1].camera = 'sideways'; })) &&
  /distance: must be a number between 0\.1 and 6/.test(merrs(d => { d.chapters[0].slides[1].camera = { preset: 'front', distance: 40 }; })) &&
  /elevation: must be a number between 0 and 89/.test(merrs(d => { d.chapters[0].slides[1].camera = { elevation: 120 }; })) &&
  /unknown camera key/.test(merrs(d => { d.chapters[0].slides[1].camera = { zoom: 2 }; })) &&
  /focus: must be the id/.test(merrs(d => { d.chapters[0].slides[1].camera = { focus: 3 }; })) &&
  /first shot starts the slide/.test(merrs(d => { d.chapters[0].slides[1].camera = [{ preset: 'front', at: 'sec:3' }, 'top']; })) &&
  /sentence 9 does not exist/.test(merrs(d => { d.chapters[0].slides[1].camera = ['front', { preset: 'top', at: 'sentence:9' }]; })) &&
  /at most 8|1\.\.8/.test(merrs(d => { d.chapters[0].slides[1].camera = new Array(9).fill('front'); })));

// a mock stage: records what it was asked to show
const composed = [];
const stage = { compose(ctx, st) { composed.push(st); ctx.drawImage({ width: 1, height: 1 }, 0, 0, st.width, st.height); } };
const fakeModel = { advanceTo() {}, root() { return {}; } };
const drawn = [];
const mtimings = mdeck.slides.map(s => C.timingFor(s, 4, 0));
const minfo = { width: 1280, height: 720, subtitles: true, assets: {}, stage3d: stage, makeCanvas: (w, h) => ({ width: w, height: h, getContext: () => mockCtx() }),
  preps: mdeck.slides.map((s, i) => {
    const v = s.visual;
    let visual = null;
    if (v && v.kind === 'scene3d') { visual = { duration: 8, model: fakeModel, overlay: { duration: 4, draw: (ctx, rect, tv, fx) => { drawn.push(['overlay', rect, fx]); } } }; }
    if (v && v.kind === 'group') { visual = { duration: 8, children: [{ duration: 8, model: fakeModel, draw: () => { drawn.push(['flat3d']); } }, {}] }; }
    return { timing: mtimings[i], visual };
  }) };
const mtl = C.buildTimeline(mdeck, mtimings);
function mctx() { return mockCtx(); }
let c1 = mctx(); C.renderFrame(c1, mdeck, mtl, mtl.segs[1].bodyStart + 3.2, minfo);
check('stage: a 3D slide is composed on the stage with its model; the model is not drawn flat', composed.length === 1 && composed[0].cur.model === fakeModel && composed[0].phase === 'body' && composed[0].environment === 'template' && composed[0].cur.interactive === true && composed[0].rect && composed[0].rect.w < 1280 * 0.6 && composed[0].rect.x > 1280 * 0.4);
check('stage: a content slide is the company template page with the 3D in a viewport where a flat slide has its visual (not full-bleed)', Math.abs(composed[0].rect.w - C.visualRect('split').w * 1280 / 1920) < 1e-6 && Math.abs(composed[0].rect.y - C.visualRect('split').y * 1280 / 1920) < 1e-6, composed[0].rect);
const hudTexts = c1.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
check('stage: the HUD (title, bullets, subtitle) is drawn in front of the stage, after it', hudTexts.indexOf('晶片模型') >= 0 && hudTexts.indexOf('主晶片') >= 0 && hudTexts.some(t => /風扇|標籤|晶片/.test(t)) && c1.calls.findIndex(c => c[0] === 'drawImage') < c1.calls.findIndex(c => c[0] === 'fillText'));
check('stage: the 2D overlay over the 3D model is drawn by the HUD, with the cue state of its shape', drawn.some(d => d[0] === 'overlay' && d[2].tag && d[2].tag.p > 0) && !drawn.some(d => d[0] === 'flat3d'), drawn.map(d => d[0]));
drawn.length = 0; composed.length = 0;
let c2 = mctx(); C.renderFrame(c2, mdeck, mtl, mtl.segs[3].bodyStart + 3, minfo);
check('mix: a flat slide with a group draws both the 3D item (flat renderer) and the table item, no stage', composed.length === 0 && drawn.some(d => d[0] === 'flat3d') && c2.calls.filter(c => c[0] === 'fillText').map(c => c[1]).indexOf('風扇') >= 0);
composed.length = 0;
let c3 = mctx(); C.renderFrame(c3, mdeck, mtl, mtl.segs[3].transStart + 0.5, minfo);
check('mix: stage -> flat is a cross-fade of the two looks (the stage slide still goes through the stage)', composed.length === 1 && composed[0].phase === 'body' && c3.calls.filter(c => c[0] === 'drawImage').length >= 2);
composed.length = 0;
let c4 = mctx(); C.renderFrame(c4, mdeck, mtl, mtl.segs[2].transStart + 0.4, minfo);
check('stage: between two 3D slides the camera flies (fly), first half shows the old slide; the viewport is between the two places', composed.length === 1 && composed[0].phase === 'transition' && composed[0].type === 'fly' && composed[0].prev && composed[0].p < 0.5 && composed[0].rect && composed[0].rect.w > 0);
check('stage: the first transition of the deck (flat title -> 3D slide) is not a stage transition', (() => { composed.length = 0; C.renderFrame(mctx(), mdeck, mtl, mtl.segs[1].transStart + 0.4, minfo); return composed.length === 1 && composed[0].phase === 'body'; })());
composed.length = 0; C.renderFrame(mctx(), mdeck, mtl, mtl.segs[2].bodyStart + 2.5, minfo);
const sh = composed[0] && composed[0].cur.shots;
check('camera: the slide\'s shots reach the stage on the slide clock: the first at 0, "sentence:2" at the start of the 2nd sentence', sh && sh.length === 2 && sh[0].at === 0 && sh[0].shot.preset === 'front' && sh[1].shot.focus === 'chip' && Math.abs(sh[1].at - mtimings[2].sentences[1].start) < 1e-9, sh);
check('camera: a slide without a camera sends no shots (the stage uses its default shot); the model key is the scene ref', (() => { composed.length = 0; C.renderFrame(mctx(), mdeck, mtl, mtl.segs[1].bodyStart + 2, minfo); return composed[0].cur.shots.length === 0 && composed[0].cur.key === null; })() && composed.length === 1);
composed.length = 0; C.renderFrame(mctx(), mdeck, mtl, mtl.segs[2].bodyStart + 1, minfo);
check('camera: the key of a 3D slide is its scene ref (the stage flies straight between two slides that share it)', composed[0].cur.key === 'https://r.example/attachments/download/7/b.3dscene.yaml');
composed.length = 0; C.renderFrame(mctx(), mdeck, mtl, mtl.segs[4].bodyStart + 1, minfo);
check('stage: a slide marked 3d that has no 3D model is drawn as a flat slide (nothing is composed)', composed.length === 0);
composed.length = 0;
let c5 = mctx(); C.renderFrame(c5, mdeck, mtl, mtl.segs[4].transStart + 0.3, minfo);
check('stage: a flat slide next to a 3D-marked slide without a model stays a plain flat transition', composed.length === 0);
// a title slide with a model is full-bleed on the template's navy
const TD = yaml.load(`
deck: { title: T, lang: en, style: 3d }
chapters:
  - title: A
    slides:
      - { id: a, layout: title, title: Hello, narration: Welcome., visual: { kind: scene3d, scene: { duration: 4, nodes: [ { id: n, mesh: box } ] } } }
`);
const tdDeck = C.normalize(TD), tdT = [C.timingFor(tdDeck.slides[0], 4, 0)];
const tdInfo = { width: 1280, height: 720, subtitles: true, assets: {}, stage3d: stage, makeCanvas: minfo.makeCanvas, preps: [{ timing: tdT[0], visual: { duration: 4, model: fakeModel } }] };
composed.length = 0; C.renderFrame(mctx(), tdDeck, C.buildTimeline(tdDeck, tdT), 1, tdInfo);
check('stage: a title slide with a model is full-bleed 3D on the template\'s navy (template-dark), no viewport rectangle', composed.length === 1 && composed[0].environment === 'template-dark' && !composed[0].rect);
const noStage = Object.assign({}, minfo, { stage3d: null });
let okNo = true; try { for (let T = 0; T < mtl.total; T += 0.41) { C.renderFrame(mctx(), mdeck, mtl, T, noStage); } } catch (e) { okNo = e.stack; }
check('stage: without WebGL (no stage) every frame still draws, flat', okNo === true, okNo);
let okAll = true; try { for (let T = 0; T < mtl.total; T += 0.23) { C.renderFrame(mctx(), mdeck, mtl, T, minfo); } } catch (e) { okAll = e.stack; }
check('stage: every frame of the mixed deck draws without error', okAll === true, okAll);

check('mermaid: a label starting with / or holding parentheses is quoted, real shapes and quoted labels are left alone',
  C.fixMermaidSource('graph LR; Help[/help] --> List[指令清單]') === 'graph LR; Help["/help"] --> List[指令清單]' &&
  C.fixMermaidSource('A[設定 (選填)] --> B[/ok/] --> C["x (y)"] --> D[\\\\path]') === 'A["設定 (選填)"] --> B[/ok/] --> C["x (y)"] --> D["\\\\path"]' &&
  C.fixMermaidSource('flowchart LR; A[Start]-->B[Next]') === 'flowchart LR; A[Start]-->B[Next]');

console.log(`deck_core: ${ok} passed, ${bad.length} failed`); if (bad.length) { console.log(bad.map(b => ' - ' + b).join('\n')); process.exit(1); }
