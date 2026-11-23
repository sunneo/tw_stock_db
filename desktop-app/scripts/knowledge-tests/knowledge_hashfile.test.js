// knowledge-native.js 的 hashFile（唯讀、串流算 md5／sha256）單元測試：node scripts/knowledge-tests/knowledge_hashfile.test.js
// 不需要 node:sqlite。比對對象是 crypto.createHash 一次算的結果；大檔用 300 MB 稀疏檔，測完刪除。
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const N = require('../../knowledge-native.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const rej = async (p) => { try { await p; return null; } catch (e) { return String(e.message || e); } };
const oneShot = (file, algo) => crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
function streamHash(file, algo) { return new Promise((resolve, reject) => { const h = crypto.createHash(algo); const s = fs.createReadStream(file); s.on('data', (d) => h.update(d)); s.on('error', reject); s.on('end', () => resolve(h.digest('hex'))); }); }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa_hf_'));
  const ops = N.makeOps({ userDataDir: () => dir });

  // 空檔、小檔：和一次算的結果一致（md5 的 RFC 空字串向量也要對）
  const empty = path.join(dir, 'empty.mp3'); fs.writeFileSync(empty, '');
  const rEmpty = await ops.hashFile({ path: empty });
  check('空檔 md5 = RFC 1321 空字串向量', rEmpty.hex === 'd41d8cd98f00b204e9800998ecf8427e' && rEmpty.size === 0 && rEmpty.algo === 'md5', rEmpty);
  const small = path.join(dir, 'small.wav'); fs.writeFileSync(small, 'abc');
  check('小檔 md5 = "abc" 向量', (await ops.hashFile({ path: small })).hex === '900150983cd24fb0d6963f7d28e17f72');

  // 跨多個串流區塊的大檔（3 MB 隨機）：串流結果與一次算的一致；sha256 也要支援
  const mid = path.join(dir, 'mid.mp4'); const midData = crypto.randomBytes(3 * 1024 * 1024); fs.writeFileSync(mid, midData);
  const rMid = await ops.hashFile({ path: mid });
  check('3 MB（跨多個區塊）md5 與一次算的一致', rMid.hex === oneShot(mid, 'md5') && rMid.size === midData.length, { got: rMid.hex });
  const rSha = await ops.hashFile({ path: mid, algo: 'sha256' });
  check('sha256 也支援，且與 crypto 一致', rSha.algo === 'sha256' && rSha.hex === oneShot(mid, 'sha256'));
  check('回傳 mtimeMs（給 sig 比對用）', typeof rMid.mtimeMs === 'number' && rMid.mtimeMs > 0);

  // 拒絕：相對路徑、資料夾、不存在、不認得的演算法
  check('相對路徑拒絕', /完整路徑/.test(await rej(ops.hashFile({ path: 'rel.mp3' })) || ''));
  check('資料夾拒絕', /不是一般檔案/.test(await rej(ops.hashFile({ path: dir })) || ''));
  check('不存在的路徑拒絕', /讀不到這個檔案/.test(await rej(ops.hashFile({ path: path.join(dir, 'nope.mp3') })) || ''));
  check('不認得的演算法拒絕', /不支援的雜湊演算法/.test(await rej(ops.hashFile({ path: small, algo: 'crc32' })) || ''));

  // 例外只在 hashFile：其他操作仍然只認 .keeplookup
  check('hashFile 不套用 .keeplookup 限制（.mp3 可以）', (await ops.hashFile({ path: small })).hex.length === 32);
  check('其他操作的 .keeplookup 限制不變（stat 拒絕 .mp3）', /keeplookup/.test(await rej(ops.stat({ path: small })) || ''));

  // 大檔：300 MB 稀疏檔（幾乎不佔磁碟），串流計算；結果與另一條串流路徑一致；測完刪除
  const big = path.join(dir, 'big-cd.wav'), GB300 = 300 * 1024 * 1024;
  const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, GB300); fs.closeSync(fd);
  const t0 = Date.now();
  const rBig = await ops.hashFile({ path: big });
  const secs = ((Date.now() - t0) / 1000).toFixed(2);
  const want = await streamHash(big, 'md5');
  check('300 MB 大檔：串流 md5 與獨立串流計算一致', rBig.hex === want && rBig.size === GB300, { got: rBig.hex, want: want });
  console.log('  大檔 300 MB md5 用時 ' + secs + ' 秒');
  fs.rmSync(big, { force: true });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* */ }
  const lines = ['knowledge_hashfile：' + ok + ' ok, ' + bad.length + ' failed'];
  if (bad.length) lines.push('  失敗：' + bad.join('\n  '));
  console.log(lines.join('\n'));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('knowledge_hashfile 丟錯：', e && e.stack); process.exit(1); });
