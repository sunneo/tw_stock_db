(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaJsonlStream = factory()); })(typeof self !== 'undefined' ? self : this, function () {
'use strict';
// 串流讀取 jsonl（P2 M1）：來源是「可分段讀取」的物件，不必整檔載入記憶體。
//   source = { size: 位元組數, read(offset, length) → Uint8Array（可以是 Promise） }
// 桌面版的 fap 資料夾參照（fapRead）可以包成這樣的來源：讀整檔後切片（M1 的做法；真正的分段讀取列為後續）。
// 以位元組找換行（0x0A）切行，再整行做 UTF-8 解碼：UTF-8 的多位元組字元不會含 0x0A，所以跨分段的字元不會被切壞。
// 回傳非同步產生器：每次 yield { line: 文字（已去掉結尾的 \r）, index: 行號（從 0 起，含空行）, offset: 這行第一個位元組的位置 }。

async function* streamLines(source, opts) {
  const chunk = Math.max(1, (opts && opts.chunkSize) || 65536);
  const dec = new TextDecoder('utf-8', { fatal: true });
  let cur = [];          // 目前這一行尚未結束的位元組
  let lineOff = 0;       // 目前這一行的起點（絕對位置）
  let index = 0;
  const emit = () => {
    const bytes = Uint8Array.from(cur);
    cur = [];
    return { line: dec.decode(bytes).replace(/\r$/, ''), index: index++, offset: lineOff };
  };
  for (let pos = 0; pos < source.size; pos += chunk) {
    const len = Math.min(chunk, source.size - pos);
    const buf = await source.read(pos, len);
    if (!buf || buf.length !== len) throw new Error('jsonl 串流：分段讀取長度不符（位置 ' + pos + '，要 ' + len + '，得 ' + (buf ? buf.length : 'null') + '）');
    let seg = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        for (let j = seg; j < i; j++) cur.push(buf[j]);
        yield emit();
        seg = i + 1;
        lineOff = pos + i + 1;
      }
    }
    for (let j = seg; j < buf.length; j++) cur.push(buf[j]);
  }
  if (cur.length) yield emit();
}

// 把整段位元組變成來源（測試與 fap 字串包裝用）
function sourceFromBytes(u8) {
  return { size: u8.length, read: async (off, len) => u8.subarray(off, off + len) };
}

// fap 文字來源：fapRead 回傳整檔字串，UTF-8 編碼後當作位元組來源（M1 的做法）。
// 注意：這不是分段讀取；大檔需要範圍讀取的 IPC（目前主行程只有整檔與讀開頭），那是尚未做的決定，不在 M1 內。
function sourceFromFapText(text) {
  return sourceFromBytes(new TextEncoder().encode(String(text)));
}

return { streamLines, sourceFromBytes, sourceFromFapText };
});
