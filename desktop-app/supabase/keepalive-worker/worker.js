// Cloudflare Worker：每 5 天對兩個 Supabase 專案各送一個最輕的請求，避免免費專案 7 天沒有活動被自動暫停。
// 送的是「問一個不存在的房間」(rg_join_room)，不會改動任何資料。
// 設定見 README.md。這裡只用公開（publishable）金鑰，跟 App 裡的一樣，不需要資料庫密碼。
const PROJECTS = [
  { name: '主要', url: 'https://schvtbxufjwkibnfgbay.supabase.co', key: 'sb_publishable_Y4hgmYhipEf2S-rS-v45rg_R1Gg-dZe' },
  { name: '備援', url: 'https://wxxovxvasgwqnchwxbxo.supabase.co', key: 'sb_publishable_5YoJVSApOHEsEcKXi3vwxQ_MWzvhh9q' },
];

async function pingAll() {
  const out = [];
  for (const p of PROJECTS) {
    const t0 = Date.now();
    try {
      const r = await fetch(p.url + '/rest/v1/rpc/rg_join_room', {
        method: 'POST',
        headers: { apikey: p.key, Authorization: 'Bearer ' + p.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_code: '00000000', p_verifier: 'keepalive' }),
      });
      const text = (await r.text()).slice(0, 120);
      // 200 = 正常；404 = 還沒執行 remote_group.sql，但請求本身一樣算「有活動」；503/5xx 或逾時多半是專案已暫停，需要到後台按「Restore」
      out.push({ project: p.name, status: r.status, ms: Date.now() - t0, body: text });
    } catch (e) {
      out.push({ project: p.name, error: String(e && e.message || e), ms: Date.now() - t0 });
    }
  }
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    const res = await pingAll();
    console.log(JSON.stringify(res));
  },
  // 用瀏覽器開 Worker 網址可以手動測一次（會回傳兩個專案的狀態）
  async fetch() {
    return new Response(JSON.stringify(await pingAll(), null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  },
};
