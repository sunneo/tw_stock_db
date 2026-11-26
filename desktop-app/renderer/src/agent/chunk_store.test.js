// 大段文字暫存（磁碟 jsonl／記憶體退路）單元測試。執行：node renderer/src/agent/chunk_store.test.js
const S = require('./chunk_store.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };

// 假的磁碟後端：檔名→字串，位元組位置以 UTF-8 計算（與主程式真檔案的語意一致）
function fakeDisk(opts) {
  opts = opts || {};
  const files = new Map();
  const enc = (s) => Buffer.from(s, 'utf8');
  return {
    files,
    failAppend: !!opts.failAppend,
    backend: {
      async append(name, text) {
        if (opts.failAppend) throw new Error('模擬寫入失敗');
        const cur = files.get(name) || Buffer.alloc(0);
        const add = enc(text);
        files.set(name, Buffer.concat([cur, add]));
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

(async () => {
  // 1. 大文字分塊後逐塊讀回＝原文（含中文、emoji、換行）
  let big = '';
  for (let i = 0; i < 3000; i++) big += '第' + i + '段 內容內容 🙂 abc。' + (i % 7 === 0 ? '\n\n' : '\n');
  big += 'x'.repeat(50000) + '😀'.repeat(3000); // 一長行、無換行：要硬切且不切斷代理字元
  const d1 = fakeDisk();
  const s1 = S.createStore({ backend: d1.backend, chunkChars: 20000 });
  const p1 = await s1.put('https://example.com/a', big);
  check('put disk ok', p1.ok && p1.storage === 'disk' && p1.truncated === false, p1);
  check('chunk count > 1', p1.chunks > 1, p1.chunks);
  check('total chars', p1.total_chars === big.length, p1.total_chars);
  let rebuilt = '';
  for (let i = 0; i < p1.chunks; i++) {
    const g = await s1.get(p1.id, i);
    if (!g.ok) { bad.push('get ' + i + ' ' + g.error); break; }
    rebuilt += g.text;
  }
  check('round trip equals original', rebuilt === big, { got: rebuilt.length, want: big.length });
  const oob = await s1.get(p1.id, p1.chunks);
  check('out of range explicit', oob.ok === false && oob.error.includes('超出範圍'), oob);
  check('jsonl line has url/i/off/len', JSON.parse(d1.files.get('stage-' + p1.id + '.jsonl').toString('utf8').split('\n')[0]).url === 'https://example.com/a');

  // 2. 重載（新的 store 實例）後舊 id 找不到：明確訊息，不是 undefined
  const s1b = S.createStore({ backend: d1.backend, chunkChars: 20000 });
  const gone = await s1b.get(p1.id, 0);
  check('reload not found explicit', gone.ok === false && gone.error.includes('找不到暫存') && gone.error.includes('重新讀取網頁'), gone);

  // 3. 寫入失敗（轉接層壞掉）→ 退回記憶體，仍可讀，並說明原因
  const d2 = fakeDisk({ failAppend: true });
  const s2 = S.createStore({ backend: d2.backend, chunkChars: 1000 });
  const p2 = await s2.put('https://example.com/b', 'hello\n'.repeat(800));
  check('fallback memory', p2.ok && p2.storage === 'memory' && typeof p2.fallback === 'string' && p2.fallback.includes('改用記憶體'), p2);
  const g2 = await s2.get(p2.id, 0);
  check('memory read works', g2.ok && g2.storage === 'memory' && g2.text.startsWith('hello'), g2);

  // 4. 沒有後端（網頁版）→ 純記憶體，行為不變
  const s3 = S.createStore({ chunkChars: 500 });
  const p3 = await s3.put('u', 'ab'.repeat(1000));
  const g3 = await s3.get(p3.id, p3.chunks - 1);
  check('no backend memory', p3.storage === 'memory' && g3.ok && g3.text.length > 0, p3);

  // 5. 截斷旗標與原因：超過上限只留前段，回傳 truncated 與丟掉的字數
  const s4 = S.createStore({ backend: fakeDisk().backend, chunkChars: 1000 });
  const p4 = await s4.put('u', 'y'.repeat(5000), { maxTotalChars: 2000 });
  check('truncated flag', p4.truncated === true && p4.dropped_chars === 3000 && p4.kept_chars === 2000 && p4.total_chars === 5000, p4);
  const txt4 = [];
  for (let i = 0; i < p4.chunks; i++) txt4.push((await s4.get(p4.id, i)).text);
  check('truncated content is head only', txt4.join('') === 'y'.repeat(2000));

  // 6. 刪除會同時刪檔
  const d5 = fakeDisk();
  const s5 = S.createStore({ backend: d5.backend, chunkChars: 100 });
  const p5 = await s5.put('u', 'z\n'.repeat(300));
  check('file exists before remove', d5.files.has('stage-' + p5.id + '.jsonl'));
  await s5.remove(p5.id);
  check('file removed', !d5.files.has('stage-' + p5.id + '.jsonl') && !s5.has(p5.id));

  // 7. 切分：短文一塊；空字串 0 塊讀回空
  check('splitText short', S.splitText('abc', 100).join('') === 'abc' && S.splitText('abc', 100).length === 1);
  check('splitText prefers newline', S.splitText('aaaa\nbbbb\ncccc', 9)[0] === 'aaaa\n' && S.splitText('aaaa\nbbbb\ncccc', 9).join('') === 'aaaa\nbbbb\ncccc');
  check('utf8Len', S.utf8Len('中a😀') === 3 + 1 + 4);

  if (bad.length) { console.error('FAIL ' + bad.length + ' 項：\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('chunk_store.test.js：全部通過（' + ok + ' 項）');
})().catch((e) => { console.error('測試例外：', e); process.exit(1); });
