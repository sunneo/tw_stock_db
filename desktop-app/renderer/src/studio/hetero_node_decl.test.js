'use strict';
// 群組訓練節點宣告（hetero_node_decl.js）測試。用法：node renderer/src/studio/hetero_node_decl.test.js
const D = require('./hetero_node_decl.js');
const R = require('./hetero_resources.js');

let ok = 0, bad = 0;
const check = (name, c, d) => { if (c) { ok++; console.log('ok   ' + name); } else { bad++; console.log('FAIL ' + name + (d === undefined ? '' : ' ' + JSON.stringify(d).slice(0, 300))); } };
const NOW = Date.parse('2026-11-28T10:00:00Z');
const meas = (v, at) => ({ value: v, measuredAt: at || '2026-11-28T09:00:00Z', source: 'measured' });

// 1. 預設不勾選（明確選擇加入）
const base = D.makeDecl({ nodeId: 'n-b', label: 'B 機', now: NOW, capabilities: { cpu: meas(8), cudaweb: null, memGB: meas(16) } });
check('預設 enabled=false、status=off', base.enabled === false && base.status === 'off');
check('未勾選 → 不是可用節點', D.isEligible(base, NOW).ok === false && D.isEligible(base, NOW).why === '未勾選分享');

// 2. 勾選 → 可用；停用（忙碌時 stopping、閒置時 off）
const on = D.setEnabled(base, true, NOW);
check('勾選後 status=on 且宣告時間＝now', on.enabled && on.status === 'on' && on.announcedAt === new Date(NOW).toISOString());
check('勾選後是可用節點', D.isEligible(on, NOW).ok === true, D.isEligible(on, NOW));
const stopBusy = D.setEnabled(on, false, NOW, true);
check('忙碌時取消勾選 → stopping（之後依 8.2 安全交還）', stopBusy.status === 'stopping' && stopBusy.enabled === false);
check('stopping 不是可用節點', D.isEligible(stopBusy, NOW).ok === false);
const stopIdle = D.setEnabled(on, false, NOW, false);
check('閒置時取消勾選 → off', stopIdle.status === 'off');

// 3. 格式：每個數字必須是實測（source、measuredAt、正數）
check('格式正確的宣告沒有錯誤', D.validateDecl(on).length === 0, D.validateDecl(on));
const noSrc = D.setEnabled(D.makeDecl({ nodeId: 'x', now: NOW, capabilities: { cpu: { value: 8, measuredAt: '2026-11-28T09:00:00Z' } } }), true, NOW);
check('來源不是 measured → 格式錯誤', D.validateDecl(noSrc).some((e) => /measured/.test(e)));
const noTime = D.setEnabled(D.makeDecl({ nodeId: 'x', now: NOW, capabilities: { cpu: { value: 8, source: 'measured' } } }), true, NOW);
check('缺量測時間 → 格式錯誤', D.validateDecl(noTime).some((e) => /量測時間/.test(e)));
const negVal = D.setEnabled(D.makeDecl({ nodeId: 'x', now: NOW, capabilities: { cpu: meas(-3) } }), true, NOW);
check('負數 → 格式錯誤', D.validateDecl(negVal).some((e) => /不合理/.test(e)));
const badSchema = Object.assign({}, on, { schema: 'other/1' });
check('schema 不符 → 格式錯誤', D.validateDecl(badSchema).some((e) => /schema/.test(e)));
const inconsistent = Object.assign({}, on, { enabled: true, status: 'off' });
check('enabled 與 status 矛盾 → 格式錯誤', D.validateDecl(inconsistent).some((e) => /off/.test(e)));
const noCap = D.setEnabled(D.makeDecl({ nodeId: 'z', now: NOW, capabilities: {} }), true, NOW);
check('勾選但沒有任何實測能力 → 不可用', D.isEligible(noCap, NOW).ok === false && /實測能力/.test(D.isEligible(noCap, NOW).why));

// 4. 過期：超過 24 小時不算可用
const old = D.setEnabled(base, true, NOW - 25 * 3600 * 1000);
check('宣告超過 24 小時 → 過期、不可用', D.isEligible(old, NOW).ok === false && D.isEligible(old, NOW).why === '宣告過期');
check('可自訂較短的過期時間', D.isEligible(on, NOW + 60 * 1000, 30 * 1000).ok === false);

// 5. 節點清單與比例：只取可用節點，依 nodeId 排序；可直接餵給 hetero_resources
const n2 = D.setEnabled(D.makeDecl({ nodeId: 'n-a', now: NOW, capabilities: { cpu: meas(24) } }), true, NOW);
const n3 = D.setEnabled(D.makeDecl({ nodeId: 'n-c', now: NOW, capabilities: { cpu: meas(8) } }), true, NOW);
const list = [on, stopBusy, old, n2, n3, noCap];
const elig = D.eligibleNodes(list, NOW);
check('可用節點依 nodeId 排序，排除 stopping／過期／沒有能力者', elig.map((x) => x.nodeId).join() === 'n-a,n-b,n-c', elig.map((x) => x.nodeId));
const ratios = D.nodeRatios(list, NOW);
check('nodeRatios 只含可用節點的實測 gflops', ratios['n-a'] === 24 && ratios['n-b'] === 8 && ratios['n-c'] === 8 && !('n-x' in ratios), ratios);
const sh = R.sharesFromRates(Object.keys(ratios).map((id) => ({ id, rate: ratios[id] })));
check('餵給 sharesFromRates：份額總和為 1、比例 24:8:8', Math.abs(sh.reduce((a, s) => a + s.share, 0) - 1) < 1e-12 && Math.abs(sh[0].share - 0.6) < 1e-12, sh);

console.log('\n' + ok + ' passed, ' + bad + ' failed');
if (bad) process.exit(1);
