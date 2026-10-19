// CoLU：故事文字 → collage（規劃器 rpg_plan.js）→ 真實 Electron 畫圖。FA_RPG_OUT 之類的輸出由呼叫端取回 fileData。
const fa = window.fa; const R = {}; await fa._deckEnsureRuntime(); const Core = window.AiChatDeckCore, Plan = window.AiChatDeckRpgPlan;
await window.AiChat2D.ensureJsYamlLoaded(); const yaml = window.jsyaml;
const plan = Plan.planRpgStory(Plan.STORIES.peach_garden); R.plan = { ok: plan.ok, beats: plan.beats, scenes: plan.scenes.map((s) => s.id + ':' + s.name + '[' + s.actors.join(',') + ']'), errors: plan.errors, questions: plan.questions };
const d = Core.parseDeck(yaml.dump({ deck: { title: '桃園三結義', lang: 'zh-TW' }, chapters: [{ title: '桃園', slides: [{ title: '桃園三結義', layout: 'visual', narration: plan.narration, visual: plan.visual }] }] }), yaml);
const slide = d.slides[0]; slide.index = 0; const timing = Core.timingFor(slide, 0, 0); const LS = timing.lines.list; R.lines = LS.length; R.duration = +timing.duration.toFixed(1); R.starts = LS.map((l) => +l.t0.toFixed(1));
const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080; const ctx = cv.getContext('2d'); const info = { width: 1920, height: 1080, subtitles: false, assets: {}, preps: [{ visual: { images: [] }, timing }] };
const mid = (i) => LS[i].t0 + 1.6, after = (i, d) => LS[i].t0 + LS[i].dur + d; // line i (0-based): while it is typed / a moment after it
const shots = { a_home_liu: mid(0), b_home_mother: mid(1), c_exit_walk: after(2, 1.2), d_village_zhang: mid(3), e_village_guan: mid(5), f_walk_to_tree: after(7, 1.4), g_orchard: after(7, 3.2), h_cg_liu: mid(8), i_cg_zhang: mid(LS.length - 1), j_end: timing.duration - 0.4 };
const files = {}; for (const [n, tt] of Object.entries(shots)) { ctx.clearRect(0, 0, 1920, 1080); Core.drawSlide(ctx, d, slide, tt, info); const blob = await new Promise((r) => cv.toBlob(r, 'image/png')); const buf = new Uint8Array(await blob.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]); files[n] = btoa(bin); }
R.fileData = files; R.cues = Core.sfxCues(slide, timing).length; return R;
