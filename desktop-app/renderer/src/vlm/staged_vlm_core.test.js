'use strict';
// staged_vlm_core.js 的單檔測試（替身工作階段，不載入真模型）。執行：node renderer/src/vlm/staged_vlm_core.test.js
const C = require('./staged_vlm_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

const V = 10, S_IMG = 4;
// 替身模型：下一個權杖 = (上一個 + 1) % V，遇到 eos(2) 就停；decoder 的 present 形狀與真模型一致（只要形狀對即可）
function makeFactory(log) {
  const sessions = {};
  const createSession = async (name, bytes) => {
    if (!bytes || bytes.length === 0) throw new Error('空權重：' + name);
    log.push('load:' + name);
    const s = {
      name, released: false,
      run: async (feeds) => {
        if (s.released) throw new Error('已釋放仍被呼叫：' + name);
        log.push('run:' + name);
        if (name === 'vision') return { image_features: { data: new Float32Array(S_IMG * 768).fill(0.1), dims: [1, S_IMG, 768] } };
        if (name === 'embed') {
          const n = feeds.input_ids.dims[1]; return { inputs_embeds: { data: new Float32Array(n * 768).fill(0.2), dims: [1, n, 768] } };
        }
        if (name === 'encoder') { const n = feeds.inputs_embeds.dims[1]; return { last_hidden_state: { data: new Float32Array(n * 768), dims: [1, n, 768] } }; }
        if (name === 'decoder') {
          const tok = Number(feeds.inputs_embeds.data.length ? 0 : 0);
          const useCache = feeds.use_cache_branch.data[0];
          const past = feeds['past_key_values.0.decoder.key'].dims[2];
          const logits = new Float32Array(V); const want = s.nextTok;
          logits[want] = 1;
          const out = { logits: { data: logits, dims: [1, 1, V] } };
          const k = past + 1;
          for (let l = 0; l < 6; l++) {
            out['present.' + l + '.decoder.key'] = { data: new Float32Array(12 * k * 64), dims: [1, 12, k, 64] };
            out['present.' + l + '.decoder.value'] = { data: new Float32Array(12 * k * 64), dims: [1, 12, k, 64] };
            const enc = useCache ? 0 : S_IMG + 4;
            out['present.' + l + '.encoder.key'] = { data: new Float32Array(12 * enc * 64), dims: [1, 12, enc, 64] };
            out['present.' + l + '.encoder.value'] = { data: new Float32Array(12 * enc * 64), dims: [1, 12, enc, 64] };
          }
          return out;
        }
        throw new Error('未知工作階段 ' + name);
      },
      release: async () => { if (s.released) throw new Error('重複釋放：' + name); s.released = true; log.push('release:' + name); },
    };
    sessions[name] = s; return s;
  };
  return { createSession, sessions };
}
// 替身的「下一個權杖」要依步數決定：把 run 包起來，每次 decoder 呼叫前設定 nextTok
function wrapDecoderNext(factory, seq) {
  let i = 0; const orig = factory.createSession;
  factory.createSession = async (name, bytes) => {
    const s = await orig(name, bytes);
    if (name === 'decoder') { const r = s.run; s.run = async (f) => { s.nextTok = seq[Math.min(i, seq.length - 1)]; i++; return r(f); }; }
    return s;
  };
  return factory;
}
const store = (names) => ({ get: async (n) => { store.reads = (store.reads || 0) + 1; return new Uint8Array([1, 2, 3, names ? 0 : 0]); } });
const baseOpts = (factory, seq) => ({ inputIds: [0, 5, 6, 2], pixelValues: { data: new Float32Array(3 * 8), dims: [1, 3, 8, 8] }, maxNewTokens: 12, store: store(), createSession: factory.createSession, now: () => 0 });

(async () => {
  // 1. 常駐與分階段的權杖逐字相同（同一段程式）
  const seq = [3, 4, 5, 6, 7, 2];  // 第二步會被強制成 BOS(0)，之後照序列，遇 eos 停止
  const f1 = wrapDecoderNext(makeFactory([]), seq);
  const r1 = await C.generateResident(baseOpts(f1, seq));
  const f2 = wrapDecoderNext(makeFactory([]), seq);
  const r2 = await C.generateStaged(baseOpts(f2, seq));
  check('常駐與分階段權杖相同', JSON.stringify(r1.tokens) === JSON.stringify(r2.tokens), [r1.tokens, r2.tokens]);
  check('強制 BOS：第二個權杖是 0', r2.tokens[1] === 0, r2.tokens);
  check('遇到 eos 會停止（不含 eos）', r2.tokens[r2.tokens.length - 1] !== 2 && r2.tokens.indexOf(2) < 0, r2.tokens);

  // 2. 分階段：同時最多兩個工作階段；vision 釋放後才載入 encoder
  const log = [];
  const f3 = wrapDecoderNext(makeFactory(log), seq);
  const r3 = await C.generateStaged(baseOpts(f3, seq));
  const idx = (x) => log.indexOf(x);
  check('分階段：vision 釋放在 encoder 載入之前', idx('release:vision') >= 0 && idx('release:vision') < idx('load:encoder'), log);
  check('分階段：同時最多 2 個工作階段（decode 階段 embed＋decoder）', r3.maxSessionsAtOnce === 2, r3.maxSessionsAtOnce);
  check('分階段：結束時全部釋放', Object.values(f3.sessions).every((s) => s.released));
  check('分階段：每個階段都有載入與釋放紀錄', r3.switchMs.length === 6 && r3.switchMs.filter((x) => x.phase === 'load').length === 3, r3.switchMs);

  // 3. 常駐：四個工作階段一開始就全部載入，結束才釋放
  const log2 = [];
  const f4 = wrapDecoderNext(makeFactory(log2), seq);
  await C.generateResident(baseOpts(f4, seq));
  const loads = log2.filter((x) => x.startsWith('load:')).length;
  check('常駐：四個工作階段各載入一次', loads === 4, log2);
  check('常駐：沒有中途釋放（release 都在最後）', log2.indexOf('release:vision') > log2.lastIndexOf('run:decoder'), log2);

  // 4. 階段外取用會丟錯（防止在錯的階段偷用工作階段）
  const S = { get: (n) => { throw new Error('階段外取用工作階段：' + n); } };
  let threw = false; try { await C.runPipeline({ enter: async () => {}, leave: async () => {}, get: S.get }, baseOpts(makeFactory([]), seq)); } catch (e) { threw = /階段外/.test(e.message); }
  check('階段外取用工作階段會丟錯', threw);

  // 5. argmax 與空權重保護
  check('argmax 取最大值位置', C.argmax(new Float32Array([0.1, 0.9, 0.5]), 0, 3) === 1);
  check('argmax 支援位移（回傳相對於位移的位置）', C.argmax(new Float32Array([9, 0.1, 0.9, 0.5]), 1, 3) === 1);
  let emptyErr = false; try { await C.generateStaged({ ...baseOpts(makeFactory([]), seq), store: { get: async () => new Uint8Array(0) } }); } catch (e) { emptyErr = /空權重/.test(e.message); }
  check('空權重會明確失敗（不靜默）', emptyErr);

  // 6. 檔名表與階段表一致
  check('每個工作階段都有檔名', ['vision', 'embed', 'encoder', 'decoder'].every((n) => C.FILES[n]));
  check('階段表涵蓋四個工作階段', ['vision', 'embed', 'encoder', 'decoder'].every((n) => Object.values(C.STAGES).flat().includes(n)));

  console.log(`\n${ok} 通過，${bad.length} 失敗`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外', e.stack); process.exit(1); });
