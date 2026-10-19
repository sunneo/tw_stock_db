// 人物精靈圖（真實 Electron）：make_character_sprite，三種風格 × 幾個人物，回傳精靈圖 PNG（data URL）供目視檢查，並檢查尺寸、顏色數、各格不同。
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const fa = window.fa; const R = { sheets: {} }; await fa._deckEnsureRuntime();
const toUrl = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
const t0 = Date.now();
for (const a of [{ preset: 'liu_bei', style: 'real' }, { preset: 'liu_bei', style: 'anime' }, { preset: 'liu_bei', style: 'cute' }, { preset: 'guan_yu', style: 'anime' }, { preset: 'zhang_fei', style: 'cute' }, { preset: 'mother', style: 'real' }, { look: { skin: 'tan', hair: 'brown', hairStyle: 'wild', robe: 'green', head: 'hat' }, style: 'cute' }]) {
  const j = JSON.parse(await fa.tools.make_character_sprite.callback.call(fa, JSON.stringify(a))); const key = (a.preset || 'custom') + ':' + a.style;
  if (!j.ok) { R.sheets[key] = { error: j.error }; continue; }
  const rec = await fa.fileCache.get(j.url.replace(/^client-file\//, '')); const bmp = await createImageBitmap(rec.blob);
  R.sheets[key] = { w: bmp.width, h: bmp.height, colors: j.colors, ref: j.ref, png: await toUrl(rec.blob) };
}
R.bad_preset = JSON.parse(await fa.tools.make_character_sprite.callback.call(fa, JSON.stringify({ preset: 'nobody' })));
R.bad_look = JSON.parse(await fa.tools.make_character_sprite.callback.call(fa, JSON.stringify({ look: { robe: 'pink' } })));
R.bad_style = JSON.parse(await fa.tools.make_character_sprite.callback.call(fa, JSON.stringify({ preset: 'liu_bei', style: 'photo' })));
R.ms = Date.now() - t0; return R;
