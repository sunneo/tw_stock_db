'use strict';
// GPU 非同步提交佇列（純邏輯，不碰 WebGPU）。
// 語意仿 CUDA：
//  - submit() 立刻回傳句柄（handle），不等 GPU；
//  - 同一個 stream 內依提交順序執行（保序）；不同 stream 各自獨立，可以重疊；
//  - 錯誤不在 submit 丟出，而是存到句柄上，在 wait／synchronize／eventSynchronize 時才丟出；
//  - 某個 stream 出錯後，該 stream 之後的操作全部以同一個錯誤失敗（sticky，與 CUDA 相同），直到 reset(stream)；
//  - 未完成句柄數達上限時 submit 丟 QueueFullError（同步函式不能等，由呼叫端先 wait 最舊的再重試）。
// execute(op, args) 由宿主提供，回傳 Promise；測試時用假裝置。

class QueueFullError extends Error {
  constructor(limit) { super('GPU 佇列已滿（未完成的操作達上限 ' + limit + '），請先等待較早的句柄'); this.name = 'QueueFullError'; this.limit = limit; }
}

function createGpuQueue(opts) {
  opts = opts || {};
  if (typeof opts.execute !== 'function') throw new TypeError('createGpuQueue：需要 execute(op, args) 函式');
  const execute = opts.execute;
  const maxPending = opts.maxPending > 0 ? opts.maxPending : 64;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const streams = new Map(); // streamId → { tail, pending:Set<rec>, poison:null }
  const recs = new Map();    // handleId → rec
  let seq = 0;
  let pendingTotal = 0;

  function getStream(id) {
    let s = streams.get(id);
    if (!s) { s = { tail: Promise.resolve(), pending: new Set(), poison: null }; streams.set(id, s); }
    return s;
  }

  function submit(op, args, streamId) {
    const sid = streamId == null ? 0 : streamId;
    if (pendingTotal >= maxPending) throw new QueueFullError(maxPending);
    const s = getStream(sid);
    // op 可以是字串，也可以是物件（例如 { device: 'cpu', name: 'matmul' }，給多裝置排程用）；原樣交給 execute
    const rec = { id: ++seq, stream: sid, op, state: 'pending', result: undefined, error: null, doneAt: null, done: null };
    recs.set(rec.id, rec);
    s.pending.add(rec);
    pendingTotal++;
    const prev = s.tail;
    rec.done = prev.then(() => {
      if (s.poison) throw s.poison; // 同一個 stream 已出錯：這一筆直接以同一個錯誤失敗
      return execute(rec.op, args);
      // （rec.op 維持原樣：字串或裝置物件）
    }).then((v) => {
      rec.state = 'done'; rec.result = v;
    }, (e) => {
      rec.state = 'error'; rec.error = e;
      if (!s.poison) s.poison = e;
    }).then(() => {
      rec.doneAt = now();
      s.pending.delete(rec);
      pendingTotal--;
    });
    s.tail = rec.done; // rec.done 不會 reject，tail 可安全串接
    return { id: rec.id, stream: sid };
  }

  function getRec(handle) {
    const rec = recs.get(handle && handle.id);
    if (!rec) throw new Error('未知的 GPU 句柄（已被 forget，或不屬於這個佇列）');
    return rec;
  }

  // 等單一句柄完成；回傳結果或丟出它的錯誤。可重複等待。
  async function wait(handle) {
    const rec = getRec(handle);
    await rec.done;
    if (rec.state === 'error') throw rec.error;
    return rec.result;
  }

  // 非阻塞查詢：'pending' | 'done' | 'error'
  function query(handle) {
    return getRec(handle).state;
  }

  // 釋放句柄與結果（Python 讀完後呼叫，避免結果一直佔記憶體）
  function forget(handle) {
    const rec = getRec(handle);
    if (rec.state === 'pending') throw new Error('句柄尚未完成，不能 forget');
    recs.delete(rec.id);
  }

  // 等某個 stream（或全部 stream）的所有已提交操作；若有錯誤（含 sticky）就丟出
  async function synchronize(streamId) {
    const targets = streamId == null ? Array.from(streams.values()) : (streams.has(streamId) ? [streams.get(streamId)] : []);
    await Promise.all(targets.map((s) => s.tail));
    for (const s of targets) if (s.poison) throw s.poison;
  }

  // 事件：記錄「此刻 stream 中尚未完成的操作」。事件完成 = 這些操作全部完成。
  function record(streamId) {
    const sid = streamId == null ? 0 : streamId;
    const s = getStream(sid);
    const snap = Array.from(s.pending);
    const ev = { stream: sid, snap, poisonAtRecord: s.poison, doneAt: null, _p: null };
    ev._p = Promise.all(snap.map((r) => r.done)).then(() => { ev.doneAt = now(); });
    return ev;
  }

  // 等事件；若記錄時或現在 stream 已有錯誤，丟出錯誤
  async function eventSynchronize(ev) {
    await ev._p;
    for (const r of ev.snap) if (r.state === 'error') throw r.error;
    if (ev.poisonAtRecord) throw ev.poisonAtRecord;
    const s = streams.get(ev.stream);
    if (s && s.poison) throw s.poison;
  }

  function eventQuery(ev) {
    return ev.doneAt != null;
  }

  // 兩個已完成事件之間的牆鐘時間（毫秒）；未完成回傳 NaN。注意：這是主機時鐘，不是 GPU 時間戳。
  function eventElapsed(a, b) {
    if (a.doneAt == null || b.doneAt == null) return NaN;
    return b.doneAt - a.doneAt;
  }

  // 清除某個 stream 的 sticky 錯誤（重新開始用）
  function reset(streamId) {
    const s = streams.get(streamId == null ? 0 : streamId);
    if (s) s.poison = null;
  }

  function stats() {
    return { pending: pendingTotal, streams: streams.size, handles: recs.size, limit: maxPending };
  }

  return { submit, wait, query, forget, synchronize, record, eventSynchronize, eventQuery, eventElapsed, reset, stats };
}

module.exports = { createGpuQueue, QueueFullError };
