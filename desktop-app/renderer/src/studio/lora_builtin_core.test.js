// node renderer/src/studio/lora_builtin_core.test.js —— 內建 LoRA 清單與延遲下載（§32.3）
const B = require('./lora_builtin_core.js'), crypto = require('crypto');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); } };
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const u8 = (s) => new TextEncoder().encode(s);
const whole = u8('abcdefghijklmnopqrstuvwxyz'.repeat(3));
const p1 = whole.slice(0, 40), p2 = whole.slice(40);
const entry = { id: 'toolcall-r4', size: whole.length, sha256: hash(whole), dir: 'builtin/toolcall-r4', parts: [
  { file: 'toolcall-r4.fatrain.part00', size: p1.length, sha256: hash(p1) }, { file: 'toolcall-r4.fatrain.part01', size: p2.length, sha256: hash(p2) }] };
const files = { 'https://x/b/builtin/toolcall-r4/toolcall-r4.fatrain.part00': p1, 'https://x/b/builtin/toolcall-r4/toolcall-r4.fatrain.part01': p2 };
const deps = (over) => Object.assign({ baseUrl: 'https://x/b', hash, fetch: async (url) => { if (!(url in files)) throw new Error('404'); return files[url]; } }, over || {});

// 清單
const manifest = { format: B.FORMAT, version: 1, base_url: 'https://x/b/', entries: [entry] };
const L = B.listBuiltin(manifest);
check('清單有效', L.ok && L.entries.length === 1, L);
check('清單項目帶完整 URL', L.entries[0].url === 'https://x/b/builtin/toolcall-r4', L.entries[0]);
check('清單格式錯誤會列出原因', !B.listBuiltin({ format: 'x', entries: [{}] }).ok && B.listBuiltin({ format: 'x' }).errors.length > 0);
check('清單缺 base_url 會報錯', B.validManifest({ format: B.FORMAT, entries: [] }).some((e) => /base_url/.test(e)));

// 下載成功：分片接起來、整檔符合
(async () => {
  const r = await B.fetchBuiltin(entry, deps());
  check('下載成功並核對整檔', r.ok === true && hash(r.bytes) === entry.sha256, r);
  // 網路失敗（分片 01 一直 404）→ network，且有人看得懂的訊息
  const r2 = await B.fetchBuiltin(entry, deps({ fetch: async (url) => { if (/part01/.test(url)) throw new Error('ECONNRESET'); return files[url]; } }), { retries: 2 });
  check('網路失敗回報 network，訊息提到網路', !r2.ok && r2.code === 'network' && /連不上 GitHub/.test(r2.message), r2);
  // 分片被截斷 → part_mismatch
  const r3 = await B.fetchBuiltin(entry, deps({ fetch: async (url) => (/part00/.test(url) ? files[url].slice(0, 10) : files[url]) }));
  check('截斷的分片回報 part_mismatch', !r3.ok && r3.code === 'part_mismatch' && /已丟棄/.test(r3.message), r3);
  // 分片大小對但內容被改 → part_mismatch
  const tampered = Uint8Array.from(p2); tampered[0] ^= 1;
  const r4 = await B.fetchBuiltin(entry, deps({ fetch: async (url) => (/part01/.test(url) ? tampered : files[url]) }));
  check('內容被改的分片回報 part_mismatch', !r4.ok && r4.code === 'part_mismatch', r4);
  // 清單的整檔雜湊錯 → total_mismatch
  const r5 = await B.fetchBuiltin(Object.assign({}, entry, { sha256: hash(u8('x')) }), deps());
  check('整檔雜湊不符回報 total_mismatch', !r5.ok && r5.code === 'total_mismatch', r5);
  // 沒有清單項目
  const r6 = await B.fetchBuiltin(null, deps());
  check('沒有項目回報 no_entry', !r6.ok && r6.code === 'no_entry' && /找不到/.test(r6.message), r6);
  check('humanError 不外露英文代碼', !/[a-z_]{5,}/.test(B.humanError('network', 'x')));
  // ---- defaultOn 與規劃（DESIGN §32.10）----
  const mk = (id, extra) => Object.assign({}, entry, { id, dir: 'builtin/' + id }, extra || {});
  const m4 = { format: B.FORMAT, version: 1, base_url: 'https://x/b/', entries: [
    mk('decompose-r4-v2', { defaultOn: true, gate: { pass: true, reason: '' } }),
    mk('codewrite-r4', { defaultOn: false, gate: { pass: true, reason: '' } }),
    mk('plan-r4', { defaultOn: true, gate: { pass: false, reason: 'self_validate 單邊退化' } }),
    mk('reading-r4', { gate: undefined }) ] };
  check('validManifest：defaultOn 非布林拒絕', B.validManifest(Object.assign({}, m4, { entries: [mk('x', { defaultOn: 'yes' })] })).length > 0);
  check('validManifest：沒有 defaultOn 欄位仍合法（舊清單）', B.validManifest({ format: B.FORMAT, version: 1, base_url: 'https://x/b/', entries: [entry] }).length === 0);
  const pl = B.planBuiltin(m4, {});
  const byId = (x) => pl.entries.find((e) => e.id === x);
  check('規劃：defaultOn 由清單決定（true 預設啟用）', byId('decompose-r4-v2').defaultOn === true && byId('decompose-r4-v2').enabled === true && byId('decompose-r4-v2').optional === false);
  check('規劃：沒有 defaultOn 的顆是選用，預設不啟用', byId('codewrite-r4').optional === true && byId('codewrite-r4').enabled === false);
  check('規劃：沒有 defaultOn 欄位的舊清單視為選用', byId('reading-r4').defaultOn === false && byId('reading-r4').enabled === false);
  check('規劃：未通過把關者寫明原因', byId('plan-r4').gatePass === false && /未通過把關或未驗證：self_validate/.test(byId('plan-r4').note), byId('plan-r4'));
  check('規劃：沒有把關資料者寫明未驗證', byId('reading-r4').gatePass === false && /未驗證/.test(byId('reading-r4').note));
  check('規劃：通過把關者沒有註記', byId('decompose-r4-v2').note === '');
  const pl2 = B.planBuiltin(m4, { enabled: { codewrite_r4: true, 'codewrite-r4': true, 'decompose-r4-v2': false } });
  check('規劃：使用者設定覆蓋預設（選用開、預設開的關）', byId('decompose-r4-v2') && B.planBuiltin(m4, { enabled: { 'codewrite-r4': true, 'decompose-r4-v2': false } }).entries.find((e) => e.id === 'codewrite-r4').enabled === true && B.planBuiltin(m4, { enabled: { 'decompose-r4-v2': false } }).entries.find((e) => e.id === 'decompose-r4-v2').enabled === false);
  const off = B.planBuiltin(m4, { master: false });
  check('規劃：總開關關閉時全部不啟用（不論預設）', off.master === false && off.entries.every((e) => e.enabled === false));
  const dl = B.planBuiltin(m4, { downloaded: { 'decompose-r4-v2': 40377386 } });
  const d1 = dl.entries.find((e) => e.id === 'decompose-r4-v2');
  check('規劃：已下載的顆標示大小與可刪除，未下載的顆不標', d1.downloaded === true && d1.downloadedBytes === 40377386 && d1.deletable === true && dl.entries.find((e) => e.id === 'codewrite-r4').downloaded === false);
  check('規劃：清單不合法時回傳錯誤、沒有項目', B.planBuiltin({ format: 'x' }, {}).ok === false && B.planBuiltin({ format: 'x' }, {}).entries.length === 0);
  console.log('lora_builtin 測試：通過 ' + ok + '、失敗 ' + bad);
  if (bad) process.exit(1);
})();
