// node scripts/music-tests/midigen_bridge.test.js -- midigenai 與作曲樹的橋:用假引擎驗證三層退路(模型 → 作曲樹 → 範本)與每種「處理不了」
const M = require('../../renderer/src/music/midi_core.js'), C = require('../../renderer/src/music/music_compose.js'), T = require('../../renderer/src/music/compose_tree.js'), B = require('../../renderer/src/music/midigen_bridge.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const tree = async (o) => T.plan({ fields: {}, options: Object.assign({ style: 'pop', key: 'C', tempo: 100, bars: 8 }, o || {}) }, {});
// 假引擎:收到旋律軌 MIDI,回「旋律軌＋新生成的一軌」;mode 決定生成什麼
function fake(mode, log) {
  return { accompany: async (bytes, op) => {
    if (log) log.push(op); const song = M.parse(bytes); const inst = op.instrument; let notes = [];
    const drum = inst === 'Drums'; if (mode === 'hang') return new Promise(() => {}); if (mode === 'fatal') throw Object.assign(new Error('模型載入失敗'), { fatal: true }); if (mode === 'throw') throw new Error('HTTP 500');
    if (mode === 'empty') notes = []; else for (let b = 0; b < op.bars; b++) {
      if (drum) { for (let i = 0; i < 8; i++) notes.push({ t: b * 1920 + i * 240, d: 120, n: i % 2 ? 42 : 36, v: 90 }); }
      else if (inst === 'Bass') notes.push({ t: b * 1920, d: 900, n: mode === 'offkey' ? 37 + 12 : mode === 'toolow' ? 12 : 36, v: 90 }, { t: b * 1920 + 960, d: 900, n: mode === 'offkey' ? 44 : 43, v: 80 });
      else notes.push({ t: b * 1920, d: 1800, n: 60, v: 70 }, { t: b * 1920, d: 1800, n: 64, v: 70 });
    }
    if (mode === 'short') notes = notes.slice(0, 1);
    const wrongKind = mode === 'wrongkind'; const out = Object.assign({}, song, { tracks: song.tracks.concat([{ name: 'gen', channel: (wrongKind ? !drum : drum) ? 9 : 1, program: 0, drum: wrongKind ? !drum : drum, volume: 100, pan: 64, notes }]) });
    return { midi: M.write(out) };
  } };
}
(async () => {
  const t = await tree();
  // 1. 完美的引擎:三個聲部都用模型,整首標 model
  const log = []; const r = await B.compose(t, 3, { engine: fake('ok', log), retries: 2 });
  check('完美:整首用模型', r.layer === 'model' && r.layers.length === 3 && r.layers.every((l) => l.layer === 'model'), r.layers);
  check('完美:每個聲部只問一次', log.length === 3 && log.every((x) => x.bars === 8 && x.tempoBpm === 100), log);
  check('完美:問了貝斯、鼓、和弦家族', log.map((x) => x.instrument).join() === 'Bass,Drums,' + 'Piano', log.map((x) => x.instrument));
  const bass = r.song.tracks[2].notes; check('完美:貝斯換成模型的音', bass.length === 16 && bass[0].n === 36, bass.length);
  check('完美:旋律仍是作曲樹的', JSON.stringify(r.song.tracks[0]) === JSON.stringify(T.compose(t, 3).song.tracks[0]));
  check('完美:歌能寫成 MIDI 再讀回', M.parse(M.write(r.song)).tracks.length >= 3);
  // 2. 沒有引擎(沒下載、沒載入):整首作曲樹,原因寫明
  const n1 = await B.compose(t, 3, { engine: null, noEngineReason: '模型還沒下載' }); check('沒引擎:整首用作曲樹並寫原因', n1.layer === 'tree' && /還沒下載/.test(n1.reason) && n1.layers.every((l) => /還沒下載/.test(l.reason)));
  check('沒引擎:仍作得出曲子', n1.song.tracks[0].notes.length > 10 && JSON.stringify(n1.song) === JSON.stringify(T.compose(t, 3).song));
  // 3. 超出模型範圍:三拍子、太長 → 不問模型就退回,原因寫明
  const lg = []; const w = await B.compose(await tree({ style: 'waltz', bars: 8 }), 1, { engine: fake('ok', lg) }); check('三拍子:退回作曲樹且沒呼叫模型', w.layer === 'tree' && /4\/4/.test(w.reason) && !lg.length, w.reason);
  const long = await B.compose(await tree({ bars: 32 }), 1, { engine: fake('ok', lg) }); check('超過 16 小節:退回並寫原因', long.layer === 'tree' && /16/.test(long.reason) && !lg.length, long.reason);
  check('範圍檢查:一般 pop 8 小節支援', B.unsupported(t) === '');
  // 4. 輸出不合格:空、太短、音域外、調外、鼓軌種類不對 → 重生兩次後仍失敗 → 該聲部用作曲樹
  for (const mode of ['empty', 'short', 'wrongkind']) { const lg2 = []; const x = await B.compose(t, 3, { engine: fake(mode, lg2), retries: 2 }); check('不合格(' + mode + '):每聲部試 3 次後退回作曲樹', x.layer === 'tree' && x.layers.every((l) => l.tries === 3 && /用作曲樹的原聲部/.test(l.reason)) && lg2.length === 9, { layer: x.layer, n: lg2.length, l: x.layers[0] }); check('不合格(' + mode + '):歌還是完整', JSON.stringify(x.song) === JSON.stringify(T.compose(t, 3).song)); }
  const off = await B.compose(t, 3, { engine: fake('offkey'), retries: 1 }); check('調外音被吸附進調內並記修正數', off.layers[0].layer === 'model' && off.fixes > 0 && off.song.tracks[2].notes.every((n) => [0, 2, 4, 5, 7, 9, 11].indexOf(n.n % 12) >= 0), { f: off.fixes, ns: off.song.tracks[2].notes.map((n) => n.n) });
  const low = await B.compose(t, 3, { engine: fake('toolow'), retries: 0 }); check('音域外被移八度', low.song.tracks[2].notes.every((n) => n.n >= 24 && n.n <= 67) && low.fixes > 0);
  // 5. 逾時、出錯、模型壞掉
  const hang = await B.compose(t, 3, { engine: fake('hang'), timeoutMs: 30, retries: 2 }); check('逾時:每聲部只試一次就退回,原因寫逾時', hang.layer === 'tree' && hang.layers.every((l) => l.tries === 1 && /逾時/.test(l.reason)), hang.layers[0]);
  const lg3 = []; const th = await B.compose(t, 3, { engine: fake('throw', lg3), retries: 1 }); check('出錯:寫出錯誤訊息並重試', th.layer === 'tree' && /HTTP 500/.test(th.layers[0].reason) && lg3.length === 6, lg3.length);
  const lg4 = []; const fa = await B.compose(t, 3, { engine: fake('fatal', lg4) }); check('模型壞掉:只問一次,其餘聲部不再問', fa.layer === 'tree' && lg4.length === 1 && /模型載入失敗/.test(fa.layers[2].reason), lg4.length);
  // 6. 部分聲部通過:標 partial
  let call = 0; const mixed = { accompany: async (b, op) => { call++; return op.instrument === 'Drums' ? fake('empty').accompany(b, op) : fake('ok').accompany(b, op); } };
  const p = await B.compose(t, 3, { engine: mixed, retries: 0 }); check('部分通過:標 partial,鼓用作曲樹、其餘用模型', p.layer === 'partial' && p.layers.find((l) => l.voice === 'drums').layer === 'tree' && p.layers.find((l) => l.voice === 'bass').layer === 'model', p.layers.map((l) => l.voice + ':' + l.layer));
  // 7. 沒有鼓的風格(古典)不請模型生鼓
  const lg5 = []; const cl = await B.compose(await tree({ style: 'classical', bars: 8 }), 2, { engine: fake('ok', lg5) }); check('古典:不問鼓', cl.layers.map((l) => l.voice).join() === 'bass,chords' && !lg5.some((x) => x.instrument === 'Drums'), cl.layers.map((l) => l.voice));
  // 8. 找模型:跟離線模型管理用同一個 status;已下載→找到、缺片→說明缺哪片、都沒有→附上找的鍵與看到的片數
  const AM = require('../../renderer/src/music/audio_models.js'); const mem = (keys) => ({ get: async (k) => keys[k], has: async (k) => !!keys[k] });
  const reg = AM.REGISTRY['midigenai-v5-cpu']; const nC = Math.ceil(reg.bytes / AM.CHUNK); const kk = (i) => 'model:midigenai-v5-cpu:' + reg.sha256.slice(0, 8) + ':' + i;
  const full = {}; for (let i = 0; i < nC; i++) full[kk(i)] = { length: Math.min(reg.bytes, (i + 1) * AM.CHUNK) - i * AM.CHUNK };
  const f1 = await B.findModel(['midigenai-v5-gpu', 'midigenai-v5-cpu'], (id) => AM.status(id, mem(full))); check('找模型:快取完整→判定已下載(跳過沒下載的 gpu)', f1.id === 'midigenai-v5-cpu' && !f1.reason, f1);
  const gap = Object.assign({}, full); delete gap[kk(3)]; const f2 = await B.findModel(['midigenai-v5-cpu'], (id) => AM.status(id, mem(gap))); check('找模型:缺第 4 片→說明缺哪一片與片數', !f2.id && /只下載了一部分/.test(f2.reason) && /缺第 4 片/.test(f2.reason) && new RegExp('看到 ' + (nC - 1) + ' / ' + nC).test(f2.reason), f2.reason);
  const f3 = await B.findModel(['midigenai-v5-cpu'], (id) => AM.status(id, mem({}))); check('找模型:完全沒有→附鍵前綴、0 片、位元組', /還沒下載/.test(f3.reason) && f3.reason.indexOf(kk(0).slice(0, -1)) >= 0 && /看到 0 \//.test(f3.reason) && /114561179/.test(f3.reason), f3.reason);
  const f4 = await B.findModel(['midigenai-v5-cpu'], async () => { throw new Error('IndexedDB 被擋'); }); check('找模型:讀狀態出錯→寫出錯原因而不是籠統說沒下載', /讀取下載狀態失敗\(IndexedDB 被擋\)/.test(f4.reason), f4.reason);
  const calls = []; const late = { n: 0 }; const f5a = await B.findModel(['midigenai-v5-cpu'], (id) => AM.status(id, mem({}))); const f5b = await B.findModel(['midigenai-v5-cpu'], (id) => AM.status(id, mem(full))); check('找模型:先沒有、後下載完→第二次找得到(不記住負面結果)', !f5a.id && f5b.id === 'midigenai-v5-cpu');
  // 9. 裝置選擇:一個模型、依偏好排序、失敗降級、記住已驗證與失敗
  {
    const mk = (over) => { const log = []; const o = Object.assign({ order: ['webgpu', 'wasm'], envKey: 'ort1|gpuA|gpu', record: {}, now: () => 1000, has: async () => true, ensure: async (d) => { log.push('ensure:' + d); return { ok: true }; }, load: async (d) => { log.push('load:' + d); return { dev: d }; }, smoke: async (e, d) => { log.push('smoke:' + d); return { ms: 1234 }; } }, over || {}); return { o, log }; };
    let x = mk(); let r = await B.openSession(x.o);
    check('裝置/GPU 成功:用 WebGPU,跑一次冒煙測試並記下已驗證', r.device === 'webgpu' && x.log.join() === 'ensure:webgpu,load:webgpu,smoke:webgpu' && x.o.record.verified.device === 'webgpu' && x.o.record.verified.env === 'ort1|gpuA|gpu' && x.o.record.verified.ms === 1234, x.log);
    r = await B.openSession(x.o); check('裝置/已驗證的裝置下次不再跑冒煙測試', r.device === 'webgpu' && x.log.slice(3).join() === 'ensure:webgpu,load:webgpu', x.log);
    x = mk({ load: async (d) => { if (d === 'webgpu') throw new Error('preferredOutputLocation 不支援'); return { dev: d }; } }); r = await B.openSession(x.o);
    check('裝置/GPU 載入失敗降級 CPU,並記下失敗原因', r.device === 'wasm' && /preferredOutputLocation/.test(x.o.record.failures.webgpu.reason) && /WebGPU\(midigenai-v5-gpu\)失敗,耗時/.test(x.o.record.failures.webgpu.reason) && x.o.record.verified.device === 'wasm', r.tried);
    r = await B.openSession(Object.assign(x.o, { load: async (d) => { x.log.push('retry:' + d); return {}; } })); check('裝置/同環境記過失敗的 GPU 下次不重踩', r.device === 'wasm' && !x.log.some((l) => l === 'retry:webgpu') && r.skipped.join() === 'webgpu', x.log.slice(-3));
    r = await B.openSession(Object.assign(x.o, { envKey: 'ort2|gpuA|gpu' })); check('裝置/換環境(ort 版本變了)再試 GPU', x.log.indexOf('retry:webgpu') >= 0 && r.device === 'webgpu');
    x = mk({ smoke: async (e, d) => { if (d === 'webgpu') throw new Error('冒煙測試:模型沒有生成任何音符'); return { ms: 50 }; } }); r = await B.openSession(x.o);
    check('裝置/冒煙測試失敗視同載入失敗,降級 CPU', r.device === 'wasm' && /沒有生成任何音符/.test(x.o.record.failures.webgpu.reason), x.log);
    x = mk({ load: async (d) => { throw new Error(d === 'webgpu' ? 'GPU 掛了' : 'wasm 也掛了'); } }); r = await B.openSession(x.o);
    check('裝置/兩個都失敗:訊息附兩邊原因', !r.engine && /GPU 掛了/.test(r.reason) && /wasm 也掛了/.test(r.reason) && /WebGPU/.test(r.reason) && /CPU/.test(r.reason), r.reason);
    r = await B.openSession(Object.assign(x.o, {})); check('裝置/兩個都失敗過:仍試最後一個(CPU),不直接放棄', r.tried.length === 1 && r.tried[0].device === 'wasm' && /GPU 掛了/.test(r.reason), r.reason);
    x = mk({ order: ['wasm'] }); r = await B.openSession(x.o); check('裝置/偏好 CPU:完全不碰 GPU', r.device === 'wasm' && !x.log.some((l) => /webgpu/.test(l)));
    x = mk({ has: async (d) => d === 'wasm' }); r = await B.openSession(x.o); check('裝置/只下載了 CPU 版:先用已下載的,不為了 GPU 再下載', r.device === 'wasm' && x.log[0] === 'ensure:wasm', x.log);
    x = mk({ has: async () => false, ensure: async (d) => { x.log.push('ensure:' + d); return { ok: false, reason: '使用者取消下載' }; } }); r = await B.openSession(x.o);
    check('裝置/都沒下載且取消:說明是沒下載,不記成裝置失敗', !r.engine && /使用者取消下載/.test(r.reason) && !x.o.record.failures.webgpu && r.tried.length === 2, r.reason);
    x = mk({ has: async () => false }); r = await B.openSession(x.o); check('裝置/都沒下載:先下載第一順位(WebGPU)這一版', r.device === 'webgpu' && x.log[0] === 'ensure:webgpu');
    const sm = await B.smoke(fake('ok')); check('冒煙測試:假引擎有音符就通過', sm.notes > 0 && sm.ms >= 0, sm);
    let smErr = ''; try { await B.smoke(fake('empty')); } catch (e) { smErr = e.message; } check('冒煙測試:沒音符就失敗並寫原因', /沒有生成任何音符/.test(smErr), smErr);
  }
  check('同種子同結果', JSON.stringify((await B.compose(t, 3, { engine: fake('ok') })).song) === JSON.stringify(r.song));
  console.log(ok + ' passed, ' + bad.length + ' failed'); if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})();
