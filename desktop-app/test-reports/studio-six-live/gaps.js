const st = require('./studio');
(async () => {
  const s = await st.open();
  await st.shimMemoryStorage(s);
  const out = {};
  for (const t of ['speech', 'music', 'speech_recognition', 'audio_to_notes', 'image', 'vision']) {
    await st.setType(s, t);
    out[t] = await s.fr.evalIn(`[...document.querySelectorAll('.todo')].map(e=>e.innerText).filter(x=>/實測|限制/.test(x)).join(' || ')`);
  }
  console.log(JSON.stringify(out, null, 1));
  s.main.close(); s.fr.close();
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
