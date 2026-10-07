// 離線日誌格式學習測試：node renderer/src/logmine/log_core.test.js
const L = require('./log_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 800))); } }
const tpl = (m, re) => m.templates.find((t) => re.test(t.pattern));
const pad = (n) => String(n).padStart(2, '0');

// ① 開頭有時間戳＋等級＋多行堆疊
(() => {
    const lines = [];
    for (let i = 0; i < 80; i++) {
        const s = pad(i % 60);
        lines.push(`2026-10-07 12:01:${s},${100 + i} INFO [worker-${i % 4}] Request GET /api/books/${1000 + i} from 10.0.0.${i % 7} took ${20 + i} ms`);
        if (i % 10 === 3) lines.push(`2026-10-07 12:01:${s},500 ERROR [worker-1] Failed to connect to db host=db${i % 2}.local port=5432 retry=${i % 3}`, 'java.sql.SQLException: timeout', '\tat com.x.Db.connect(Db.java:42)', '\tat com.x.Main.run(Main.java:10)');
    }
    const m = L.mine(lines.join('\n'));
    check('①格式：時間戳文字、2 種模板、涵蓋 100%', m.ok && m.format === 'timestamped' && m.templates.length === 2 && m.coverage === 1, { f: m.format, n: m.templates.length, c: m.coverage });
    const req = tpl(m, /Request GET/);
    check('①請求模板：路徑、IP、耗時、編號都變成欄位，固定文字留著', req && /Request GET <PATH> from <IP> took <DUR>/.test(req.pattern) && req.count === 80 && req.fields.length === 4, req && req.pattern);
    const err = tpl(m, /Failed to connect/);
    check('①錯誤模板：堆疊接到上一筆、例外類別被統計', err && err.count === 8 && err.withStack === 8 && m.exceptions[0][0] === 'java.sql.SQLException' && m.withStack === 8, { err: err && err.pattern, ex: m.exceptions });
    check('①紀錄數：堆疊行不算獨立紀錄（80+8，不是 80+8×4）', m.records === 88, m.records);
    check('①時間範圍與等級統計', m.timeRange && m.levels.INFO === 80 && m.levels.ERROR === 8 && L.fmtTs(m.timeRange.from) === '2026-10-07 12:01:00', { tr: m.timeRange, lv: m.levels });
    const dur = req.fields.find((f) => f.type === 'DUR');
    check('①欄位值分布：耗時 80 種值', dur && dur.distinct === 80, dur);
    const hit = L.matchLine(m, '2026-10-08 09:00:00,1 INFO [worker-3] Request GET /api/books/7 from 10.0.0.2 took 9 ms');
    check('①新紀錄比對到同一個模板並取出欄位值', hit && hit.template === req.id && hit.params.ip === '10.0.0.2' && hit.params.path === '/api/books/7' && hit.level === 'INFO', hit);
    check('①完全不同的行比對不到（不硬套）', L.matchLine(m, 'totally different message with other shape here now ok') === null);
    check('問答：哪個錯誤最多 → 錯誤模板', /Failed to connect/.test(L.ask(m, '哪個錯誤最多').answer));
    check('問答：錯誤什麼時候第一次出現', /第一次 2026-10-07 12:01:03/.test(L.ask(m, '錯誤什麼時候第一次出現').answer), L.ask(m, '錯誤什麼時候第一次出現'));
    check('問答：有幾筆錯誤 → 8', /8 筆/.test(L.ask(m, '有幾筆錯誤').answer), L.ask(m, '有幾筆錯誤'));
    check('問答：欄位 port 的值分布（port 是固定值時明說不是欄位或照實回答）', typeof L.ask(m, '欄位 port 的值分布').answer === 'string');
    const f = L.ask(m, '找 "db1.local" 在哪些行', { lines });
    check('問答：找某個值（有原始行）列出行號', f.kind === 'find' && /出現在 8 行/.test(f.answer), f);
    check('問答：找某個值但沒有原始行 → 明說需要檔案，不編造', L.ask(m, '找 "db1.local"').needsLines === true);
    const open = L.ask(m, '這個系統可能出了什麼問題');
    check('問答：開放式問題 → 不亂答，交出精簡脈絡', open.kind === 'open' && open.answer === null && /Request GET/.test(open.context) && open.context.length < 3600, open);
    check('摘要：含格式、時間、等級、模板、例外', (() => { const s = L.summarize(m).join('\n'); return /開頭有時間戳/.test(s) && /等級：INFO 80/.test(s) && /java\.sql\.SQLException/.test(s) && /T1/.test(s); })());
    const pat = L.toTrainerPattern(m, 'myapp');
    check('訓練器規則：regex 觸發、能命中這個格式的一行、不含整份日誌', pat.type === 'regex' && new RegExp(pat.expr).test('INFO [worker-1] Request GET /api/books/9 from 10.0.0.1 took 5 ms') && JSON.stringify(pat).length < 60000, pat.expr && pat.expr.slice(0, 120));
    check('訓練器規則：不會誤判無關的句子', !new RegExp(pat.expr).test('請幫我寫一個排序函式'));
    const back = L.fromSlim(JSON.parse(JSON.stringify(pat.log_model)));
    check('還原：精簡模型仍能問答與比對', /Failed to connect/.test(L.ask(back, '哪個錯誤最多').answer) && L.matchLine(back, 'INFO [worker-3] Request GET /api/books/7 from 10.0.0.2 took 9 ms') !== null);
})();

// ② syslog（沒有年份）＋ key=value
(() => {
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(`Oct  7 12:${pad(i % 60)}:01 host1 sshd[${2000 + i}]: Accepted password for user${i % 3} from 192.168.1.${i} port ${50000 + i} ssh2`);
    for (let i = 0; i < 10; i++) lines.push(`Oct  7 13:0${i}:01 host1 sshd[${3000 + i}]: Failed password for invalid user admin from 10.1.1.${i} port ${40000 + i} ssh2`);
    const m = L.mine(lines.join('\n'));
    check('②syslog：2～3 種模板，pid／IP／port 是欄位', m.ok && m.templates.length >= 2 && m.templates.length <= 3, m.templates.map((t) => t.pattern));
    const failed = m.templates.find((t) => /Failed password/.test(t.pattern));
    check('②syslog：失敗登入 10 次', failed && failed.count === 10, failed && failed.pattern);
    const kv = [];
    for (let i = 0; i < 30; i++) kv.push(`ts=2026-10-07T10:00:${pad(i)}Z level=info msg="order created" order_id=${5000 + i} user=u${i % 3} amount=${(i * 3.5).toFixed(2)}`);
    for (let i = 0; i < 5; i++) kv.push(`ts=2026-10-07T10:01:0${i}Z level=error msg="payment failed" order_id=${6000 + i} user=u1 code=E${i}`);
    const m2 = L.mine(kv.join('\n'));
    check('②key=value：格式辨識為 key_value、欄位用鍵名命名', m2.ok && m2.format === 'key_value' && m2.templates.some((t) => t.fields.some((f) => /order_id/.test(f.name))), { f: m2.format, n: m2.templates.map((t) => t.fields.map((f) => f.name)) });
    check('②key=value：error 等級被讀出', (m2.levels.ERROR || 0) === 5, m2.levels);
})();

// ③ JSON 每行一筆
(() => {
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ time: `2026-10-07T11:00:${pad(i % 60)}Z`, level: i % 8 === 0 ? 'error' : 'info', msg: i % 8 === 0 ? `upstream timeout after ${i * 10} ms` : `served ${i} bytes to client 10.0.0.${i % 5}`, req_id: 'r' + i }));
    const m = L.mine(lines.join('\n'));
    check('③JSON lines：認出格式，等級與時間取自欄位，訊息被模板化', m.ok && m.format === 'json_lines' && m.templates.length === 2 && m.levels.ERROR === 5 && m.timeRange, { f: m.format, t: m.templates.map((t) => t.pattern), lv: m.levels });
})();

// ④ 不是日誌就說不是
(() => {
    const bin = String.fromCharCode(...Array.from({ length: 4000 }, (_, i) => (i * 7) % 31));
    check('④二進位內容 → 拒絕', L.mine(bin).ok === false && L.mine(bin).kind === 'binary');
    check('④太短 → 拒絕', L.mine('a\nb').ok === false && L.mine('').ok === false);
    const rnd = Array.from({ length: 60 }, (_, i) => Array.from({ length: 7 }, (_, j) => 'w' + ((i * 7919 + j * 104729) % 9973)).join(' ')).join('\n');
    const m = L.mine(rnd);
    check('④幾乎沒有重複 → 標成弱（不假裝學會了）', m.ok && m.weak === true && /涵蓋率/.test(m.note), { c: m.coverage, w: m.weak });
})();

// ⑤ 規模與穩定
(() => {
    const lines = [];
    for (let i = 0; i < 30000; i++) lines.push(`2026-10-07 12:${pad(Math.floor(i / 60) % 60)}:${pad(i % 60)} INFO job-${i % 50} finished in ${i % 997} ms status=${i % 9 === 0 ? 'FAILED' : 'OK'} id=${i}`);
    const t0 = Date.now(); const m = L.mine(lines.join('\n')); const dt = Date.now() - t0;
    check('⑤三萬行在合理時間內完成（<8 秒）且模板數很少', m.ok && dt < 8000 && m.templates.length <= 4, { dt, n: m.templates.length });
    const huge = L.mine(lines.join('\n'), { maxLines: 1000 });
    check('⑤超過上限只分析前面並註明', huge.truncatedFrom === 30000 && huge.lines === 1000 && /只分析了前 1000 行/.test(L.summarize(huge)[0]));
})();

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
