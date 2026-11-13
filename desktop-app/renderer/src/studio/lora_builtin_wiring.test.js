// 內建 LoRA 每輪按需下載（studio_server_core 的 builtinEnsure／builtinView／/api/builtin，DESIGN.lora-training.md §33 批 2）。
// 用假的主行程（builtinCall）把 lora-adapters 暫存檔當成「已下載的 .fatrain」，走真的 Fatrain.importAsset 與登錄表。
// 需要 /home/hungfu.lee/fa-work/lora-adapters-stage（沒有就略過並明說）。沒測到的：真 Electron 的 IPC、真網路（見 §33 的探針）。
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const stage = '/home/hungfu.lee/fa-work/lora-adapters-stage';
if (!fs.existsSync(path.join(stage, 'builtin.json'))) { console.log('lora_builtin_wiring：略過（沒有暫存目錄 ' + stage + '）'); process.exit(0); }
const { createServer } = require('./studio_server_core.js');
const Storage = require('./storage_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'builtin.json'), 'utf8'));
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'blt-wire-'));
const joined = (id) => { // 把分片接成 .fatrain（與主行程下載後的檔案相同位元組）
    const e = manifest.entries.find((x) => x.id === id), p = path.join(ud, id + '.fatrain');
    if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.concat(e.parts.map((x) => fs.readFileSync(path.join(stage, e.dir, x.file)))));
    return p;
};
const calls = []; const failIds = new Set(); let downloaded = {};
const builtinCall = async (op, p) => {
    calls.push(op + ':' + ((p && p.id) || ''));
    if (op === 'builtin_manifest') return { ok: true, source: 'network', note: '', manifest };
    if (op === 'builtin_status') return { ok: true, downloaded, progress: {} };
    if (op === 'builtin_fetch') { if (failIds.has(p.id)) return { ok: false, code: 'network', message: '內建 LoRA「' + p.id + '」下載失敗：連不上 GitHub（測試）' }; const f = joined(p.id); downloaded[p.id] = fs.statSync(f).size; return { ok: true, id: p.id, path: f, size: downloaded[p.id] }; }
    if (op === 'builtin_delete') { delete downloaded[p.id]; return { ok: true, removed: true }; }
    return { ok: false, message: 'bad op' };
};
let prefs = {};
const storage = Storage.createStorage({ memory: Storage.createMemoryStore() });
const h = { storage, desktop: true, now: () => 1000, prefsGet: () => prefs, prefsSet: (p) => { prefs = p; }, download: async () => {}, pickFile: async () => null, pickFiles: async () => null,
    builtinCall, readBytes: async (f) => new Uint8Array(fs.readFileSync(f)) };
const srv = createServer(h);
const reg = async () => (await srv.registry());

(async () => {
    // 1. 閱讀：沒附文章 → 政策擋下，不下載
    let r = await srv.builtinEnsure('reading', '請問今天天氣如何', null);
    check('1 policy blocks reading w/o article', r.ok && r.skipped === 'policy', r);
    check('1 no fetch', !calls.some((c) => c.indexOf('builtin_fetch') === 0), calls);

    // 2. 閱讀：附文章＋依文作答 → 下載、匯入、登錄為內建
    const msgs = [];
    r = await srv.builtinEnsure('reading', '【文章】台北是台灣的首都。\n請依文回答：台灣首都是哪裡？', (m) => msgs.push(m));
    check('2 downloaded reading-r4', r.ok && r.downloaded === true && r.id === 'reading-r4', r);
    check('2 progress line mentions purpose and size', msgs.some((m) => /閱讀理解.*約 40 MB/.test(m)), msgs);
    let rg = await reg();
    const e2 = rg.get('reading-r4');
    check('2 registered as builtin', !!e2 && e2.source === 'builtin' && e2.enabled === true, e2 && { source: e2.source, enabled: e2.enabled });
    check('2 persisted builtinIds', (prefs.builtinIds || []).indexOf('reading-r4') >= 0, prefs);

    // 3. 再來一次：已載入，不再下載
    calls.length = 0;
    r = await srv.builtinEnsure('reading', '【文章】x 依文作答', null);
    check('3 loaded → no fetch', r.ok && r.skipped === 'loaded' && !calls.some((c) => c.indexOf('builtin_fetch') === 0), { r, calls });

    // 4. 解碼：決策式領域（toolcall）→ 下載 toolcall-r4
    r = await srv.builtinEnsure('toolcall', '幫我查天氣', null);
    check('4 toolcall downloaded', r.ok && r.id === 'toolcall-r4' && r.downloaded === true, r);

    // 5. 把關未通過的 plan-r4 不下載（預設啟用但路由擋住）
    r = await srv.builtinEnsure('plan', '幫我規劃', null);
    check('5 gate-blocked plan not fetched', r.ok && r.skipped === 'none' && !calls.includes('builtin_fetch:plan-r4'), { r, calls });

    // 6. 單顆關閉：colu 關掉後不下載
    let v = await srv.route('POST', new URL('http://x/api/builtin/enable'), { id: 'colu-r4', on: false }).then((x) => x.j);
    check('6 enable route ok', v.ok === true, v);
    r = await srv.builtinEnsure('colu', '選單', null);
    check('6 disabled colu not fetched', r.ok && r.skipped === 'none', r);
    v = await srv.route('POST', new URL('http://x/api/builtin/enable'), { id: 'colu-r4', on: true }).then((x) => x.j);

    // 7. 總開關關閉：不下載、已載入的登錄項停用（路由就回基底）
    v = await srv.route('POST', new URL('http://x/api/builtin/master'), { on: false }).then((x) => x.j);
    check('7 master off view', v.ok && v.master === false, v);
    calls.length = 0;
    r = await srv.builtinEnsure('decompose', '拆題', null);
    check('7 master off → skipped', r.ok && r.skipped === 'master-off' && calls.length === 0, { r, calls });
    rg = await reg();
    check('7 loaded builtin disabled when master off', rg.get('reading-r4') && rg.get('reading-r4').enabled === false, rg.get('reading-r4') && rg.get('reading-r4').enabled);
    v = await srv.route('POST', new URL('http://x/api/builtin/master'), { on: true }).then((x) => x.j);
    rg = await reg();
    check('7 master on re-enables', rg.get('reading-r4').enabled === true);

    // 8. 下載失敗：回原因、不丟例外、冷卻中不重試
    failIds.add('decompose-r4-v2'); calls.length = 0;
    r = await srv.builtinEnsure('decompose', '拆題', null);
    check('8 failure returned, not thrown', r.ok === false && /連不上/.test(r.message) && r.id === 'decompose-r4-v2', r);
    r = await srv.builtinEnsure('decompose', '拆題', null);
    check('8 cooldown: no second fetch', r.ok === false && r.cooldown === true && calls.filter((c) => c === 'builtin_fetch:decompose-r4-v2').length === 1, { r, calls });
    failIds.delete('decompose-r4-v2');

    // 9. 網頁版（沒有 builtinCall）：不做任何事
    const web = createServer(Object.assign({}, h, { builtinCall: undefined }));
    r = await web.builtinEnsure('reading', '【文章】依文作答', null);
    check('9 web no-op', r.ok === true && r.skipped === 'no-domain', r);
    v = await web.route('GET', new URL('http://x/api/builtin'), undefined).then((x) => x.j);
    check('9 web view says desktop only', v.ok === false && v.available === false && /桌面版/.test(v.message), v);

    // 10. 檢視：六顆卡片資料齊、限制與把關原因帶得出來；刪除後回到未下載
    v = await srv.route('GET', new URL('http://x/api/builtin'), undefined).then((x) => x.j);
    check('10 six entries', v.ok && v.entries.length === 6, v.entries && v.entries.length);
    const rd = v.entries.find((x) => x.id === 'reading-r4');
    check('10 reading card has purpose, downloaded size, limits', rd && rd.purpose === '閱讀理解' && rd.downloaded && rd.downloadedBytes > 0 && Array.isArray(rd.limits), rd);
    const pl = v.entries.find((x) => x.id === 'plan-r4');
    check('10 plan card has gate reason', pl && pl.gatePass === false && /未通過|未驗證/.test(pl.note), pl);
    v = await srv.route('POST', new URL('http://x/api/builtin/delete'), { id: 'reading-r4' }).then((x) => x.j);
    check('10 delete ok', v.ok === true, v);
    check('10 registry no longer has it', !(await reg()).get('reading-r4'));

    console.log('lora_builtin_wiring: ' + ok + ' 通過，' + bad.length + ' 失敗' + (bad.length ? '：' + bad.join('、') : ''));
    fs.rmSync(ud, { recursive: true, force: true });
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
