// 桌面版的 RPG 食譜（真實 Electron）：「桃園三結義」＋對話 → 食譜回傳 render_presentation 的 yaml；驗證能被簡報解析、有全螢幕舞台、對話、轉場、結尾黑幕；沒有 RPG 線索的故事不走這條。
const fa = window.fa; const R = {}; await fa._deckEnsureRuntime(); const Core = window.AiChatDeckCore; await window.AiChat2D.ensureJsYamlLoaded(); const yaml = window.jsyaml; const logs = [];
const task = '用RPG對話的方式做桃園三結義，要有人物走路和頭像：\n【屋內】\n劉備：「母親，我想和兩位壯士結為兄弟。」\n母親：「好孩子，去吧，路上小心。」\n劉備走出屋外，來到村莊。\n張飛：「這位大哥，我家後院有一片桃園。」\n三人走向桃花樹下。\n【暗下來】\n【桃園結義的大張畫面】\n張飛：「不求同月同日生，但求同月同日死！」\n【暗下來】';
const r = await fa._deckStoryRecipe(task, (m) => logs.push(m)); R.keys = Object.keys(r || {}); R.error = r && r.error; R.log = logs;
if (r && r.yaml) { const doc = JSON.parse(r.yaml); const d = Core.parseDeck(yaml.dump(doc), yaml); const v = d.slides[0].visual; R.deck = { slides: d.slides.length, kind: v.kind, fullscreen: v.fullscreen, spotlight: v.spotlight, items: v.items.length, scenes: v.scenes.length, curtain: !!v.curtain, says: v.items.reduce((n, i) => n + (i.say ? i.say.length : 0), 0), styles: [...new Set(v.items.flatMap((i) => (i.say || []).map((s) => s.style)))] }; R.name = r.name; R.notes = r.notes; }
// 口語描述（沒有任何「名字：「台詞」」）：程式讀成動作
const say = '假使我們模仿桃園三結義，用地圖方式，在屋內劉備跟他母親對話，出來屋外到村莊，跟張飛對話、跟關羽對話，對話中都有人物頭像\n\n三個人走向桃花樹下\n暗下來切到下一張scene，這個scene是劉關張三人桃園三結義的劇情畫面，大張的，有三個人說話的字幕，不求同月同日生，但求同月同日死\n\n暗下來';
const lg = []; const rc = await fa._deckStoryRecipe(say, (m) => lg.push(m)); if (rc && rc.yaml) { const dd = Core.parseDeck(yaml.dump(JSON.parse(rc.yaml)), yaml); const vv = dd.slides[0].visual; R.colloquial = { scenes: vv.scenes.length, items: vv.items.length, lines: vv.items.reduce((n, i) => n + (i.say ? i.say.length : 0), 0), oath: vv.items.some((i) => (i.say || []).some((q) => /不求同月同日生，但求同月同日死/.test(q.text))), narration: JSON.parse(rc.yaml).chapters[0].slides[0].narration, log: lg } } else { R.colloquial = { error: rc && rc.error, log: lg }; }
// 對話內容沒給、內建故事也沒有：請 AI 補寫（成功），或補寫失敗保留範本並說明
fa._pyBridgeCompleteLlm = async () => ({ text: '村民：老伯，請問桃園怎麼走？\n老者：往東走，看到桃花就是了。\n村民：多謝您。' });
const r1 = await fa._deckStoryRecipe('在村莊村民跟老者對話，用地圖方式，對話有頭像', () => {}); R.ai_fill = !!(r1 && r1.yaml && /往東走，看到桃花就是了/.test(r1.yaml)) && !((r1.notes || []).length);
fa._pyBridgeCompleteLlm = async () => ({ text: '好的，我來寫。' });
const r2 = await fa._deckStoryRecipe('在村莊村民跟老者對話，用地圖方式，對話有頭像', () => {}); R.ai_fail_template = !!(r2 && r2.yaml && /你好，老者/.test(r2.yaml)) && (r2.notes || []).length >= 1;
const plain = await fa._deckStoryRecipe('給小朋友講三隻小豬的故事', (m) => {}); R.plain_story_kept = !!(plain && (plain.yaml || plain.error)) && !(plain.yaml && /"fullscreen":true/.test(plain.yaml));
return R;
