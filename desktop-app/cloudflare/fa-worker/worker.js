// Floating Assistant 的 Cloudflare Worker（一個 Worker 做兩件事）：
//  1. 保活：每 5 天對四個 Supabase 專案各送一個最輕的請求，避免免費專案 7 天沒有活動被暫停。
//  2. 慢速信箱（Cloudflare KV）：所有 Supabase 專案都不能用時，遠端群組退到這裡傳訊息。很慢（輪詢），只適合文字與少量訊息。
// 這裡只存「加密過的」內容與一個房間登記（代號＋由密碼推導的驗證值），看不到密碼與明文。
// 設定與部署見 README.md。KV 綁定名稱必須是 KV。

const PROJECTS = [
  { name: '主要', url: 'https://schvtbxufjwkibnfgbay.supabase.co', key: 'sb_publishable_Y4hgmYhipEf2S-rS-v45rg_R1Gg-dZe' },
  { name: '備援', url: 'https://wxxovxvasgwqnchwxbxo.supabase.co', key: 'sb_publishable_5YoJVSApOHEsEcKXi3vwxQ_MWzvhh9q' },
  { name: '備援2', url: 'https://kvnnjlbtitvkxfanutup.supabase.co', key: 'sb_publishable_XA9f-Y5ZcIbk-mVzTdcb-A_AMhPwbA_' },
  { name: '備援3', url: 'https://wwpiriwfmmpmtckenqjo.supabase.co', key: 'sb_publishable_MeHx1Qjhu6IV-rp6LvMS7g_Hwp-jUTp' },
];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS) });
const MAX_PAYLOAD = 70000;          // 單則（一塊）訊息的字元上限
const REG_TTL = 48 * 3600;          // 房間登記：48 小時沒有「touch」就自動消失（客戶端每 6 小時 touch 一次）
const PRES_TTL = 1800;              // 在線登記：30 分鐘（客戶端每 10 分鐘更新一次）
const MSG_TTL = 1800, MSG_KEEP = 30, MSG_AGE = 20 * 60 * 1000;
const okCh = (c) => typeof c === 'string' && /^rg:[0-9a-f]{8,64}$/.test(c);
const okNode = (n) => typeof n === 'string' && /^[0-9a-zA-Z_-]{3,40}$/.test(n);

const isErr = (r) => !!(r && typeof r === 'object' && 'error' in r); // 編輯器的型別檢查會挑 r.error，用 in 判斷最乾淨
async function getJson(kv, key) { const t = await kv.get(key); if (!t) return null; try { return JSON.parse(t); } catch (_) { return null; } }

// ---- 房間登記（對應 Supabase 那邊的 rg_* 函式；回傳值一樣）
async function rpc(env, fn, a) {
  const code = String((a && a.p_code) || ''), ver = String((a && a.p_verifier) || '');
  if (!/^\d{8,14}$/.test(code) || !ver || ver.length > 200) return { error: '參數不對' };
  const key = 'reg:' + code, now = Date.now(); const r = await getJson(env.KV, key);
  if (fn === 'rg_create_room') {
    if (r) return false;
    await env.KV.put(key, JSON.stringify({ verifier: ver, created: now, fails: 0, lockedUntil: 0 }), { expirationTtl: REG_TTL }); return true;
  }
  if (fn === 'rg_join_room') {
    if (!r) return 'not_found';
    if (r.lockedUntil > now) return 'locked';
    if (r.verifier !== ver) { r.fails = (r.fails || 0) + 1; if (r.fails >= 8) { r.fails = 0; r.lockedUntil = now + 15 * 60 * 1000; } await env.KV.put(key, JSON.stringify(r), { expirationTtl: REG_TTL }); return 'bad_password'; }
    if (r.fails) { r.fails = 0; await env.KV.put(key, JSON.stringify(r), { expirationTtl: REG_TTL }); }
    return 'ok';
  }
  if (fn === 'rg_touch_room') { if (!r || r.verifier !== ver) return false; await env.KV.put(key, JSON.stringify(r), { expirationTtl: REG_TTL }); return true; }
  if (fn === 'rg_close_room') { if (!r || r.verifier !== ver) return false; await env.KV.delete(key); return true; }
  return { error: '沒有這個函式' };
}

// ---- 信箱：每個「收件人×寄件人」一個 key，只有寄件人寫它（避免兩邊同時寫互相蓋掉）
async function send(env, a) {
  if (!okCh(a.ch) || !okNode(a.to) || !okNode(a.from) || !Array.isArray(a.payloads) || !a.payloads.length || a.payloads.length > 20) return { error: '參數不對' };
  if (a.payloads.some((p) => JSON.stringify(p).length > MAX_PAYLOAD)) return { error: '單則訊息太大' };
  const key = 'i:' + a.ch + ':' + a.to + ':' + a.from, now = Date.now(); const cur = (await getJson(env.KV, key)) || { seq: 0, msgs: [] };
  for (const p of a.payloads) { cur.seq++; cur.msgs.push({ s: cur.seq, t: now, p }); }
  cur.msgs = cur.msgs.filter((m) => now - m.t < MSG_AGE).slice(-MSG_KEEP);
  await env.KV.put(key, JSON.stringify(cur), { expirationTtl: MSG_TTL }); return { ok: true, seq: cur.seq };
}
async function poll(env, a) {
  if (!okCh(a.ch) || !okNode(a.node) || !Array.isArray(a.from) || a.from.length > 40) return { error: '參數不對' };
  const since = a.since || {}, out = [];
  for (const f of a.from) {
    if (!okNode(f)) continue; const cur = await getJson(env.KV, 'i:' + a.ch + ':' + a.node + ':' + f); if (!cur) continue;
    const s = Number(since[f]) || 0; out.push({ from: f, seq: cur.seq, msgs: cur.msgs.filter((m) => m.s > s) });
  }
  return { ok: true, out };
}
// ---- 在線名單
async function pres(env, a) {
  if (!okCh(a.ch) || !okNode(a.node) || typeof a.e !== 'string' || a.e.length > 8000) return { error: '參數不對' };
  await env.KV.put('p:' + a.ch + ':' + a.node, a.e, { expirationTtl: PRES_TTL }); return { ok: true };
}
async function roster(env, a) {
  if (!okCh(a.ch)) return { error: '參數不對' };
  const l = await env.KV.list({ prefix: 'p:' + a.ch + ':', limit: 40 }); const out = [];
  for (const k of l.keys) { const e = await env.KV.get(k.name); if (e) out.push({ node: k.name.slice(('p:' + a.ch + ':').length), e }); }
  return { ok: true, out };
}
async function leave(env, a) { if (!okCh(a.ch) || !okNode(a.node)) return { error: '參數不對' }; await env.KV.delete('p:' + a.ch + ':' + a.node); return { ok: true }; }

async function pingAll() {
  const out = [];
  for (const p of PROJECTS) {
    const t0 = Date.now();
    try {
      const r = await fetch(p.url + '/rest/v1/rpc/rg_join_room', { method: 'POST', headers: { apikey: p.key, Authorization: 'Bearer ' + p.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_code: '00000000', p_verifier: 'keepalive' }) });
      // 200 正常；404＝活著但還沒執行 remote_group.sql；5xx 或逾時多半是專案被暫停，要到後台按 Restore
      out.push({ project: p.name, status: r.status, ms: Date.now() - t0, body: (await r.text()).slice(0, 120) });
    } catch (e) { out.push({ project: p.name, error: String((e && e.message) || e), ms: Date.now() - t0 }); }
  }
  return out;
}

export default {
  async scheduled() { console.log(JSON.stringify(await pingAll())); },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') return json({ ok: true, kv: !!env.KV, keepalive: await pingAll() });
    if (!env.KV) return json({ error: '這個 Worker 還沒綁定 KV（綁定名稱要是 KV）' }, 500);
    let a; try { a = await request.json(); } catch (_) { return json({ error: '不是 JSON' }, 400); }
    try {
      if (path.startsWith('/rpc/')) { const r = await rpc(env, path.slice(5), a); return json(isErr(r) ? r : { result: r }, isErr(r) ? 400 : 200); }
      const fn = { '/send': send, '/poll': poll, '/pres': pres, '/roster': roster, '/leave': leave }[path];
      if (!fn) return json({ error: '沒有這個路徑' }, 404);
      const r = await fn(env, a); return json(r, isErr(r) ? 400 : 200);
    } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
  },
};
