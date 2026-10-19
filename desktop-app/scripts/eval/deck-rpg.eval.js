// 簡報的 RPG 場景（真實 Electron 畫圖）：用 collage 的物件（map:／actor:／bust:／cg:、tx／ty 走路、say style box／subtitle、spotlight、scenes black、curtain）
// 組出「桃園三結義」，驗證格式、畫出關鍵時間點的 PNG（FA_RPG_OUT 指定資料夾）。
const fa = window.fa; const R = {}; await fa._deckEnsureRuntime(); const Core = window.AiChatDeckCore; const OUT = window.__FA_RPG_OUT || '/tmp/rpg-frames';
const narration = ['劉備進了屋子，母親坐在桌邊。', '劉備說：母親，我想和兩位壯士結為兄弟。', '母親說：好孩子，去吧，路上小心。', '劉備走出屋外，來到村莊。', '張飛說：翼德我家後院有一片桃園。', '關羽說：在下關羽，願與二位同心協力。', '三人走向桃花樹下。', '劉備說：雖然異姓，既結為兄弟，則同心協力。', '關羽說：上報國家，下安黎庶。', '張飛說：不求同月同日生，但求同月同日死！'];
const A = (id, extra) => Object.assign({ src: 'actor:' + id, enter: 'none', z: 5 }, extra);
const visual = { kind: 'collage', spotlight: true,
  scenes: [{ scene: 'home' }, { scene: 'village', at: { sentence: 4 }, effect: 'black', sec: 1.2 }, { scene: 'oath', at: { sentence: 8 }, effect: 'black', sec: 1.2 }],
  curtain: [{ at: { sentence: 10, offset: 5 }, sec: 1.5, alpha: 1 }],
  items: [
    { src: 'map:house_interior', scene: 'home', enter: 'none', z: 0, at: 0 },
    { src: 'map:village', scene: 'village', enter: 'none', z: 0, at: 0 },
    { src: 'map:peach_orchard', scene: 'peach', enter: 'none', z: 0, at: 0 },
    { src: 'cg:peach_oath', scene: 'oath', enter: 'none', z: 0, at: 0 },
    A('liu_bei', { scene: 'home', tx: 7, ty: 7, at: 0, name: '劉備', say: [{ sentence: 2, text: '母親，我想和兩位壯士結為兄弟，一起保鄉衛國。', style: 'box' }, { sentence: 3, text: '兒子明白，母親請放心。', style: 'box' }],
      keys: [{ at: { sentence: 1, offset: 2 }, sec: 2, tx: 7, ty: 5 }] }),
    A('mother', { scene: 'home', tx: 8, ty: 4, at: 0, name: '母親', face: 'down', say: [{ sentence: 3, text: '好孩子，志氣可嘉。去吧，路上小心，記得做人要講信義。', style: 'box' }] }),
    A('liu_bei', { scene: 'village', tx: 3, ty: 4, at: { sentence: 4 }, name: '劉備', z: 6, look: { preset: 'liu_bei' }, say: [{ sentence: 7, text: '翼德兄，我正有此意。', style: 'box' }], keys: [{ at: { sentence: 4, offset: 4 }, sec: 2.5, tx: 7, ty: 6 }] }),
    A('zhang_fei', { scene: 'village', tx: 12, ty: 5, at: { sentence: 4 }, name: '張飛', face: 'left', say: [{ sentence: 5, text: '這位大哥，我家後院有一片桃園，桃花正開。', style: 'box' }] }),
    A('guan_yu', { scene: 'village', tx: 14, ty: 6, at: { sentence: 6 }, name: '關羽', face: 'left', say: [{ sentence: 6, text: '在下關羽，願與二位同心協力，匡扶漢室。', style: 'box' }], keys: [{ at: { sentence: 6, offset: 1.5 }, sec: 2, tx: 10, ty: 6 }] }),
    { src: 'bust:liu_bei', scene: 'oath', x: 0.08, y: 0.18, w: 0.26, enter: 'none', z: 3, name: '劉備', say: [{ sentence: 8, text: '念劉備、關羽、張飛，雖然異姓，既結為兄弟，則同心協力，救困扶危。', style: 'subtitle' }] },
    { src: 'bust:guan_yu', scene: 'oath', x: 0.37, y: 0.18, w: 0.26, enter: 'none', z: 3, name: '關羽', say: [{ sentence: 9, text: '上報國家，下安黎庶。', style: 'subtitle' }] },
    { src: 'bust:zhang_fei', scene: 'oath', x: 0.66, y: 0.18, w: 0.26, enter: 'none', z: 3, name: '張飛', say: [{ sentence: 10, text: '不求同月同日生，但求同月同日死！', style: 'subtitle' }] },
    { src: 'fx:petals', scene: 'oath', enter: 'none', z: 9, at: 0 }
  ] };
await window.AiChat2D.ensureJsYamlLoaded(); const yaml = window.jsyaml;
const mk = (v) => Core.parseDeck(yaml.dump({ deck: { title: '桃園三結義', lang: 'zh-TW' }, chapters: [{ title: '桃園', slides: [{ title: '桃園三結義', layout: 'visual', narration: narration.join(''), visual: v }] }] }), yaml);
const errsOf = (f) => { try { const d = f(); return (d.errors || []).map((e) => (e.path ? e.path + ': ' : '') + (e.message || e)).slice(0, 3); } catch (e) { return [String(e.message || e).split('\n')[0]]; } };
const d0 = mk(visual); R.valid = { slides: (d0.slides || []).length, warnings: (d0.warnings || []).slice(0, 3) };
R.bad_map = errsOf(() => mk({ kind: 'collage', items: [{ src: 'map:moon' }] })); R.bad_actor = errsOf(() => mk({ kind: 'collage', items: [{ src: 'actor:nobody' }] }));
R.bad_style = errsOf(() => mk({ kind: 'collage', items: [{ src: 'actor:liu_bei', say: [{ text: 'a', sentence: 1, style: 'loud' }] }] })); R.bad_tx = errsOf(() => mk({ kind: 'collage', items: [{ src: 'actor:liu_bei', tx: 99 }] }));
// render frames
const deck = d0; const slide = d0.slides[0]; slide.index = 0;
const timing = Core.timingFor(slide, 60, 0); const S = timing.sentences.map((x) => x.start); R.sentences = S.length; R.starts = S.map((x) => +x.toFixed(1));
const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080; const ctx = cv.getContext('2d');
const info = { width: 1920, height: 1080, subtitles: false, assets: {}, preps: [{ visual: { images: [] }, timing }] };
const shots = { s1_home_walk: S[0] + 3.2, s2_box_liu: S[1] + 2.4, s3_box_mother: S[2] + 2.6, s4_black_dip: S[3] + 0.6, s5_village_walk: S[3] + 4.2, s6_box_zhang: S[4] + 2.2, s7_box_guan: S[5] + 2.2, s8_black2: S[7] + 0.6, s9_cg_liu: S[7] + 3.0, s10_cg_zhang: S[9] + 3.0, s11_end_black: S[9] + 9 };
const files = {}; for (const [k, tt] of Object.entries(shots)) { ctx.clearRect(0, 0, 1920, 1080); Core.drawSlide(ctx, deck, slide, tt, info); const blob = await new Promise((r) => cv.toBlob(r, 'image/png')); const buf = new Uint8Array(await blob.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]); files[k] = btoa(bin); }
R.frames = Object.keys(files).length; R.fileData = files; R.cues = Core.sfxCues(slide, timing).length;
return R;
