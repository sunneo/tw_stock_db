// 大段暫存策略（記憶體先放、背景落盤、記憶體上限淘汰不遺失、落盤失敗退回記憶體）單元測試。執行：node renderer/src/agent/big_stash.test.js
const S = require('./big_stash.js');
const C = require('./chunk_store.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };

// 假的磁碟後端（與主程式的 fa:stage:* 同語意：位元組位置、附加寫入、依位置讀）
function fakeBackend() {
  const files = new Map();
  return {
    files,
    backend: {
      async append(name, text) {
        const cur = files.get(name) || Buffer.alloc(0);
        files.set(name, Buffer.concat([cur, Buffer.from(text, 'utf8')]));
        return { start: cur.length };
      },
      async readRange(name, start, bytes) {
        const buf = files.get(name);
        if (!buf) throw new Error('檔案不存在：' + name);
        return buf.subarray(start, start + bytes).toString('utf8');
      },
      async remove(name) { files.delete(name); },
    },
  };
}
function makeDisk() { const fb = fakeBackend(); return { fb, store: C.createStore({ backend: fb.backend, chunkChars: 4000 }) }; }
function bigText(seed, n) { let s = ''; let i = 0; while (s.length < n) { s += seed + '-' + (i++) + ' 內容 😀 abc\n'; } return s.slice(0, n); }

(async () => {
  // 1. 沒有磁碟層：編號照舊 bc_1、bc_2，同步讀得到
  {
    const st = S.createBigStash({ capBytes: 1e9 });
    const a = st.add('hello', 'x'), b = st.add('world', 'y');
    check('ids sequential', a === 'bc_1' && b === 'bc_2', [a, b]);
    check('sync get text', st.get(a).text === 'hello' && st.get(b).label === 'y');
    check('text() from memory', (await st.text(b)) === 'world');
    check('missing id null', (await st.text('bc_99')) === null && st.get('bc_99') === null);
  }

  // 2. 落盤：超過門檻的文字背景寫入磁碟；落盤後 text() 從盤上取回＝原文（多塊、含中文與 emoji）
  {
    const d = makeDisk(); const orig = bigText('A', 30000);
    const st = S.createBigStash({ disk: d.store, capBytes: 1e9, spillChars: 1000, chunkChars: 4000 });
    const id = st.add(orig, 'page');
    await st.flush();
    const rec = st.get(id);
    check('spilled to disk', rec.disk && rec.disk.chunks > 1, rec);
    check('file written', Array.from(d.fb.files.keys()).length === 1 && d.fb.files.get(Array.from(d.fb.files.keys())[0]).length > orig.length);
    check('memory still holds text under cap', rec.text === orig);
    const back = await st.text(id);
    check('disk round trip equals original', back === orig, { got: back && back.length, want: orig.length });
  }

  // 3. 記憶體上限淘汰：已落盤的先丟文字，之後全部仍讀得回原文（淘汰不遺失）
  {
    const d = makeDisk(); const cap = 50000; const texts = [];
    const st = S.createBigStash({ disk: d.store, capBytes: cap, spillChars: 1000, chunkChars: 4000 });
    const ids = [];
    for (let i = 0; i < 6; i++) { const t = bigText('T' + i, 20000); texts.push(t); ids.push(st.add(t, 'doc' + i)); }
    await st.flush();
    check('memory under cap after spill', st.bytes() <= cap, st.bytes());
    const dropped = ids.filter((id) => st.get(id).text === null).length;
    check('some texts released from memory', dropped >= 3, dropped);
    check('ids kept after release', ids.every((id) => st.has(id)));
    let allOk = true; const why = [];
    for (let i = 0; i < ids.length; i++) { const t = await st.text(ids[i]); if (t !== texts[i]) { allOk = false; why.push(ids[i]); } }
    check('all readable after eviction', allOk, why);
  }

  // 4. 記錄清單的 head／shape 在釋放文字後保留（之後頁面才能正確帶 head）
  {
    const d = makeDisk();
    const st = S.createBigStash({ disk: d.store, capBytes: 20000, spillChars: 1000, chunkChars: 4000 });
    const full = '{"a":1}\n' + 'x'.repeat(25000); // 超過上限的記錄清單：落盤後丟文字
    const id = st.add(full, 'recs');
    st.get(id).recs = { lines: ['{"a":1}', 'x'.repeat(25000)], shape: 'jsonl', head: { title: 'T' }, bad: 0, path: [] };
    await st.flush();
    check('records meta kept after release', st.get(id).text === null && st.get(id).recsMeta && st.get(id).recsMeta.head.title === 'T' && st.get(id).recs === undefined, st.get(id));
    check('released records readable', (await st.text(id)) === full);
  }

  // 5. 沒有磁碟層、超過上限：照舊刪最舊的，留最新的（行為與舊版相同）
  {
    const st = S.createBigStash({ capBytes: 25000 });
    const a = st.add('a'.repeat(10000)), b = st.add('b'.repeat(10000)), c = st.add('c'.repeat(10000));
    check('no disk evicts oldest', !st.has(a) && st.has(b) && st.has(c), Array.from(st.keys()));
    check('newest kept intact', st.get(c).text === 'c'.repeat(10000));
  }

  // 6. 轉接層失敗：落盤寫不進去 → 留在記憶體、可讀、記下原因（不丟資料）
  {
    const logs = [];
    const brokenDisk = { put: async () => ({ ok: true, storage: 'memory', id: 'x' }), get: async () => ({ ok: false, error: 'no' }), remove: async () => {} };
    const st = S.createBigStash({ disk: brokenDisk, capBytes: 1e9, spillChars: 100, chunkChars: 100, log: (m) => logs.push(m) });
    const t = bigText('F', 5000); const id = st.add(t, 'f');
    await st.flush();
    check('spill failure keeps text in memory', st.get(id).spillFailed === true && st.get(id).text === t);
    check('spill failure readable', (await st.text(id)) === t);
    check('spill failure logged', logs.length >= 1 && logs[0].includes('落盤失敗'), logs);
    const throwing = { put: async () => { throw new Error('磁碟滿'); }, get: async () => ({ ok: false }), remove: async () => {} };
    const st2 = S.createBigStash({ disk: throwing, capBytes: 1e9, spillChars: 100, log: () => {} });
    const id2 = st2.add(t, 'g'); await st2.flush();
    check('put throws → memory kept', st2.get(id2).spillFailed && st2.get(id2).text === t && (await st2.text(id2)) === t);
  }

  // 7. 磁碟上的檔案被破壞：取回時明確丟錯，不回殘缺內容
  {
    const d = makeDisk(); const orig = bigText('G', 20000);
    const st = S.createBigStash({ disk: d.store, capBytes: 1000, spillChars: 1000, chunkChars: 4000 });
    const id = st.add(orig, 'g'); await st.flush();
    st.add(bigText('H', 2000), 'h'); // 把 bc_1 擠出記憶體
    await st.flush();
    d.fb.files.clear();
    let threw = false, msg = ''; try { await st.text(id); } catch (e) { threw = true; msg = String(e.message); }
    check('missing disk file throws explicitly', threw && msg.length > 0, msg);
  }

  // 8. 刪除會連盤上的檔一起刪
  {
    const d = makeDisk();
    const st = S.createBigStash({ disk: d.store, capBytes: 1e9, spillChars: 100, chunkChars: 500 });
    const id = st.add(bigText('R', 3000), 'r'); await st.flush();
    check('file exists before remove', d.fb.files.size === 1);
    st.remove(id); await new Promise((r) => setTimeout(r, 10));
    check('file removed with entry', d.fb.files.size === 0 && !st.has(id));
  }

  if (bad.length) { console.error('FAIL ' + bad.length + ' 項：\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('big_stash.test.js：全部通過（' + ok + ' 項）');
})().catch((e) => { console.error('測試例外：', e); process.exit(1); });
