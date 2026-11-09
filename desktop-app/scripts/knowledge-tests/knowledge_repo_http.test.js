// 物件格式的伺服器合約（renderer/src/knowledge/repo/，從藏書閣 keeplookup 原樣搬來、未接線）：httpFor 對 blob／root API 的呼叫形狀，用假的 fetch 驗證——
// blobs_missing 分批、blob 的 sha 當檔名、root 204 無／409 衝突帶 latest_version、可替換的 fetch 層。
const path = require('path');
const dir = path.join(__dirname, '../../renderer/src/knowledge/repo');
const Repo = require(path.join(dir, 'keeplookup_repo.js')), Pack = require(path.join(dir, 'keeplookup_pack.js')), Glue = require(path.join(dir, 'keeplookup_repoglue.js'));
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
(async () => {
  const calls = [], blobs = {}; let root = null, version = 0;
  const res = (status, body, buf) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), json: async () => body, arrayBuffer: async () => buf });
  const fetch = async (url, o) => {
    o = o || {}; calls.push({ url, method: o.method || 'GET', csrf: o.headers && o.headers['X-CSRF-Token'] }); const u = new URL('http://x/' + url.replace(/^\//, ''));
    if (u.pathname.endsWith('/blobs_missing')) { const shas = JSON.parse(o.body).shas; return res(200, { missing: shas.filter((s) => !blobs[s]) }); }
    if (u.pathname.endsWith('/blob') && o.method === 'POST') { blobs[u.searchParams.get('sha')] = o.body; return res(200, { ok: true }); }
    if (u.pathname.endsWith('/blob')) { const b = blobs[u.searchParams.get('sha')]; return b ? res(200, {}, Uint8Array.from(b).buffer) : res(404, { error: 'nope' }); }
    if (u.pathname.endsWith('/root') && o.method === 'POST') { if (String(u.searchParams.get('base_version')) !== String(root ? version : '')) return res(409, { conflict: true, latest_version: root ? version : null }); root = JSON.parse(o.body); return res(200, { ok: true, version: ++version }); }
    if (u.pathname.endsWith('/root')) return root ? res(200, { version, root }) : res(204, {});
    return res(404, {});
  };
  const http = Repo.httpFor({ url: '/projects/p/ai_chat/group_workspaces/7', csrf: () => 'tok', fetch });
  const many = Array.from({ length: 4500 }, (_, i) => 'sha' + i);
  check('blobsMissing: 4500 shas go in 2 requests, all reported missing', (await http.blobsMissing(many)).length === 4500 && calls.filter((c) => /blobs_missing/.test(c.url)).length === 2);
  await http.putBlob('abc', new Uint8Array([1, 2, 3]));
  check('putBlob: POST blob?sha=<sha> with the csrf token', calls.some((c) => c.method === 'POST' && /\/blob\?sha=abc$/.test(c.url) && c.csrf === 'tok'));
  check('getBlob: bytes back', Array.from(await http.getBlob('abc')).join() === '1,2,3');
  let e = null; try { await http.getBlob('zzz'); } catch (x) { e = x; }
  check('getBlob: 404 -> error with status', e && e.status === 404);
  check('getRoot: 204 = no library yet -> null', (await http.getRoot('default')) === null);
  const c1 = await http.commitRoot('default', { format: 2, lib: 'default' }, null);
  check('commitRoot: first commit (base empty) -> version 1', c1.version === 1);
  e = null; try { await http.commitRoot('default', { format: 2 }, null); } catch (x) { e = x; }
  check('commitRoot: stale base -> conflict with latest', e && e.conflict === true && e.latest === 1, e && e.message);
  check('getRoot: newest root', (await http.getRoot('default')).version === 1);
  // 頁面層：沒有群組庫伺服器時（groupUrl 回 null）isRepo 預設否
  const g = Glue.create({ rpc: async () => ({}), groupUrl: () => null, csrf: () => '', diag() {}, emit() {}, Pack, Repo, fetch });
  check('repoglue: loads and no library is a repository library by default', g.isRepo('group-7') === false);
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'knowledge_repo_http: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((x) => { console.error(x); process.exit(1); });
