// 把 Whisper 編碼器的 GPU 版接到 transformers.js 的編碼器 session（transcribe_media；DESIGN.webgpu-cuda.md §7.24）。純邏輯、依賴注入，node 可測。
// attach({ sess, enc, WE, ops, say }) → { get gpu(), stat }：sess.run 被換成 GPU 版（解碼器、特徵擷取不動）；
// 輸入不是 [1,80,3000]、任何運算沒跑在 T1、輸出形狀不對／含 NaN 或無限大、或丟錯，永久改回原 run（結果格式不變），原因寫進 stat.fellBack 並呼叫 say。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaWhisperAttach = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function attach(o) {
    const sess = o.sess, say = o.say || (() => {}), origRun = sess.run.bind(sess);
    let gpu = true; const stat = { runs: 0, ms: 0, tiers: null, fellBack: '' };
    sess.run = async (feeds) => {
      if (gpu) {
        try {
          const names = Object.keys(feeds), t = feeds.input_features;
          if (!t || !t.dims || t.dims.length !== 3 || t.dims[0] !== 1 || t.dims[1] !== 80 || t.dims[2] !== 3000 || names.length !== 1) throw new Error('輸入不是預期的 [1,80,3000] input_features');
          const t1 = Date.now();
          const out = await o.WE.encode(o.enc, Float32Array.from(t.data), o.ops);
          stat.runs++; stat.ms += Date.now() - t1; stat.tiers = Object.assign({}, o.ops.tiers);
          const bad = Object.keys(o.ops.tiers).filter((k) => !/^T1/.test(o.ops.tiers[k]));
          if (bad.length) throw new Error('運算沒有跑在 GPU：' + bad.map((k) => k + '＝' + o.ops.tiers[k]).join('、'));
          if (out.length !== 1500 * 512) throw new Error('輸出長度 ' + out.length);
          for (let i = 0; i < out.length; i += 97) if (!Number.isFinite(out[i])) throw new Error('輸出含 NaN／無限大');
          return { last_hidden_state: new t.constructor('float32', out, [1, 1500, 512]) };   // 還給 transformers.js 的必須是它自己的 ort Tensor
        } catch (e) { gpu = false; stat.fellBack = String((e && e.message) || e).slice(0, 200); say('Whisper 編碼器 GPU 失敗，已退回原編碼器：' + stat.fellBack); }
      }
      return origRun(feeds);
    };
    const h = { get gpu() { return gpu; }, stat }; sess.__faGpu = h; return h;
  }
  return { attach };
});
