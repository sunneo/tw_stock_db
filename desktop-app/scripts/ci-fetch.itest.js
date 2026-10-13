'use strict';
// ci-fetch.js：本機 HTTP 伺服器測試（讀取上限、tail、重新導向不帶 Authorization、寫入確認、逾時）
if (typeof fetch === 'undefined') { console.log('0 passed, 0 failed [] (略過：這個 Node 沒有 fetch，需要 Node 18 以上)'); process.exit(0); }
const assert = require('assert'), http = require('http');
const { doFetch } = require('../ci-fetch.js');
let ok = 0; const bad = []; const q = []; const t = (n, f) => q.push([n, f]);
let srv, base; const seen = [];
const big = 'L'.repeat(100) + '\n';
t('啟動伺服器', async () => {
  srv = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, ct: req.headers['content-type'] });
    if (req.url === '/big') { res.end(big.repeat(50000) + 'THE-END\n'); }
    else if (req.url === '/redir') { res.writeHead(302, { Location: '/target' }); res.end(); }
    else if (req.url === '/target') { res.end('arrived'); }
    else if (req.url === '/slow') { setTimeout(() => res.end('late'), 5000); }
    else if (req.url === '/json') { res.setHeader('content-type', 'application/json'); res.end(')]}\'\n{"a":1}'); }
    else { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res.end('echo:' + b)); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + srv.address().port;
});
const deps = (allow) => ({ fetchImpl: (u, i) => fetch(u, i), confirm: async () => allow });
t('GET：預設只留前面、tail 保留最後', async () => {
  const h = await doFetch({ url: base + '/big', maxBytes: 2048 }, deps(false)); assert.ok(h.ok && h.truncated && h.text.length === 2048 && !h.text.includes('THE-END'), JSON.stringify({ n: h.text.length }));
  const tl = await doFetch({ url: base + '/big', maxBytes: 2048, keep: 'tail' }, deps(false)); assert.ok(tl.text.endsWith('THE-END\n') && tl.kept === 'tail' && tl.bytes > 4e6, String(tl.bytes));
});
t('重新導向會跟隨；Authorization 只送給原本的主機', async () => { const r = await doFetch({ url: base + '/redir', headers: { Authorization: 'Bearer x' } }, deps(false)); assert.strictEqual(r.text, 'arrived'); assert.ok(seen.some((s) => s.url === '/redir' && s.auth === 'Bearer x')); });
t('寫入：沒允許就不送', async () => {
  const n = seen.length; const r = await doFetch({ url: base + '/post', method: 'POST', body: { password: 'hunter2-secret' }, confirm: { message: 'm' } }, deps(false)); assert.ok(r.denied && !r.ok); assert.strictEqual(seen.length, n, '不能真的送出請求');
});
t('寫入：允許才送、JSON body 自動加 content-type；確認內容有遮蔽機密', async () => {
  let info; const r = await doFetch({ url: base + '/post', method: 'POST', body: { password: 'hunter2-secret', msg: 'hi' } }, { fetchImpl: (u, i) => fetch(u, i), confirm: async (x) => { info = x; return true; } });
  assert.ok(r.ok && r.text.includes('"msg":"hi"')); assert.ok(!/hunter2-secret/.test(info.detail) && /\*\*\*/.test(info.detail)); assert.ok(seen.some((s) => s.url === '/post' && /json/.test(s.ct)));
});
t('GET 不需要確認', async () => { let asked = false; const r = await doFetch({ url: base + '/json' }, { fetchImpl: (u, i) => fetch(u, i), confirm: async () => { asked = true; return false; } }); assert.ok(r.ok && !asked && r.headers['content-type'] === 'application/json'); });
t('逾時、壞網址、不支援的 method、被擋的標頭', async () => {
  const s = await doFetch({ url: base + '/slow', timeoutSec: 2 }, deps(false)); assert.ok(!s.ok && /逾時/.test(s.error), JSON.stringify(s));
  assert.ok(!(await doFetch({ url: 'file:///etc/passwd' }, deps(false))).ok); assert.ok(!(await doFetch({ url: base, method: 'TRACE' }, deps(false))).ok);
  const n = seen.length; await doFetch({ url: base + '/x', headers: { Cookie: 'a=b', Host: 'evil' } }, deps(false)); assert.ok(!('cookie' in (seen[n] || {})));
  const dead = await doFetch({ url: 'http://127.0.0.1:1/' }, deps(false)); assert.ok(!dead.ok && dead.error);
});
(async () => { for (const [n, f] of q) { try { await f(); ok++; } catch (e) { bad.push(n + ': ' + e.message); } } try { srv.close(); } catch (_) {} console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0); })();
