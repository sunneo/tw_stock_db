'use strict';
// 後端介面、登錄表、kind 宣告、規劃中後端的 probe（尚未實作要回具體阻礙）、cpu-js 後端與 Configure 設定模型
const B = require('./backend_core.js'), J = require('./backend_cpu_js.js'), P = require('./backend_planned.js'), SC = require('./studio_config_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
(async () => {
  // 介面型別
  const js = J.createCpuJsBackend();
  check('cpu-js 後端符合介面', B.validateBackend(js).length === 0, B.validateBackend(js));
  check('缺方法被抓到', B.validateBackend({ id: 'cpu-js', capabilities: { perStep: true }, probe() {} }).some((e) => /缺方法 step/.test(e)));
  check('id 不合法被抓到', B.validateBackend(Object.assign({}, js, { id: 'cuda' })).some((e) => /id/.test(e)));
  check('缺 capabilities 被抓到', B.validateBackend(Object.assign({}, js, { capabilities: undefined })).some((e) => /capabilities/.test(e)));
  check('probe 結果驗證：不可用必須有 reason', B.validateProbeResult({ available: false, device: {}, fingerprint: {} }).length > 0);
  check('probe 結果驗證：合法', B.validateProbeResult(B.probeResult(false, '沒有 python')).length === 0);
  const pj = await js.probe({ hw: { cpuModel: 'X', cores: 4 } });
  check('cpu-js probe 可用且指紋含核心數', pj.available && pj.fingerprint.cores === 4 && !pj.reason, pj);
  // kind 宣告
  ['trainer', 'colu', 'uml', 'blockly', 'matrix'].forEach((k) => check('符號式 ' + k + ' 只宣告 cpu-js', JSON.stringify(B.KIND_BACKENDS[k]) === '["cpu-js"]' && B.isSymbolicKind(k)));
  check('lora 宣告四個後端且不含 cpu-js', JSON.stringify(B.KIND_BACKENDS.lora) === '["cpu-py","webgpu","directml","vulkan"]');
  // 規劃中後端：probe 回具體阻礙，不假裝可用，其餘方法拒絕
  const reg = new B.BackendRegistry();
  reg.register(js).register(P.createWebgpuBackend()).register(P.createDirectmlBackend()).register(P.createVulkanBackend());
  check('規劃中後端也符合介面', ['webgpu', 'directml', 'vulkan'].every((i) => B.validateBackend(reg.get(i)).length === 0));
  const pw = await reg.get('webgpu').probe(), pd = await reg.get('directml').probe(), pv = await reg.get('vulkan').probe();
  check('webgpu 不可用且阻礙具體', !pw.available && /WGSL|反向/.test(pw.reason), pw);
  check('directml 阻礙引用已查證事實', !pd.available && /E_INVALIDARG/.test(pd.reason) && /SkipSimplifiedLayerNormalization/.test(pd.reason), pd);
  check('vulkan 阻礙說明上游未驗證與轉換器', !pv.available && /OUT_PROD/.test(pv.reason) && /GGUF/.test(pv.reason), pv);
  check('阻礙不寫成「刻意不做」', ![pw, pd, pv].some((p) => /刻意|不打算/.test(p.reason)));
  check('規劃中後端有解除條件', ['webgpu', 'directml', 'vulkan'].every((i) => P.BLOCKERS[i].unblock.length > 10));
  let threw = false; try { await reg.get('vulkan').step({}, {}); } catch (e) { threw = /尚未實作/.test(e.message); }
  check('規劃中後端的 step 拒絕並說明', threw);
  // listFor
  const lst = await reg.listFor('lora', {});
  check('lora 清單：cpu-py 沒登錄就灰掉並說明', lst.find((x) => x.id === 'cpu-py').available === false && /沒有登錄/.test(lst.find((x) => x.id === 'cpu-py').reason));
  check('lora 清單順序固定', lst.map((x) => x.id).join() === 'cpu-py,webgpu,directml,vulkan');
  check('符號式清單只有 cpu-js 且可用', (await reg.listFor('uml', {})).length === 1 && (await reg.listFor('uml', {}))[0].available);
  // safeProbe 不丟例外、格式錯也被攔下
  const boom = Object.assign({}, js, { probe: async () => { throw new Error('爆了'); } });
  const sp = await B.safeProbe(boom, {});
  check('probe 丟例外也不外洩', sp.available === false && /爆了/.test(sp.reason), sp);
  check('probe 格式錯被攔下', (await B.safeProbe(Object.assign({}, js, { probe: async () => ({ available: false }) }), {})).available === false);
  let regErr = null; try { reg.register({ id: 'cpu-js' }); } catch (e) { regErr = e.message; }
  check('登錄不合介面的後端會丟錯', /不合介面/.test(regErr || ''));
  check('成熟度順序 cpu-py>vulkan>directml>webgpu', B.maturityRank('cpu-py') < B.maturityRank('vulkan') && B.maturityRank('vulkan') < B.maturityRank('directml') && B.maturityRank('directml') < B.maturityRank('webgpu'));
  // Configure 設定模型（核心數）
  check('預設 auto＝N−1', SC.resolveThreads({}, 8) === 7 && SC.resolveThreads(undefined, 1) === 1 && SC.resolveThreads({}, 2) === 1);
  check('指定 3 核心就用 3', SC.resolveThreads({ cpuCores: 3 }, 8) === 3);
  check('超過總核心被限制', SC.resolveThreads({ cpuCores: 99 }, 8) === 8);
  check('基準測試即使設全部核心也只用 N−1', SC.resolveThreads({ cpuCores: 8 }, 8, 'benchmark') === 7 && SC.resolveThreads({ cpuCores: 2 }, 8, 'benchmark') === 2);
  check('關掉基準上限才可全核心', SC.resolveThreads({ cpuCores: 8, benchmarkCoresCap: false }, 8, 'benchmark') === 8);
  const n1 = SC.normalize({ cpuCores: '4' }, 8), n2 = SC.normalize({ cpuCores: 0 }, 8), n3 = SC.normalize({ cpuCores: 12 }, 8), n4 = SC.normalize({ cpuCores: 8 }, 8), n5 = SC.normalize({ lowPriority: 'yes' }, 8);
  check('字串數字被接受', n1.config.cpuCores === 4 && !n1.errors.length, n1);
  check('0 被拒絕並退回 auto', n2.config.cpuCores === 'auto' && n2.errors.length === 1, n2);
  check('超過總核心：改成總核心並警示', n3.config.cpuCores === 8 && n3.warnings.length >= 1, n3);
  check('全核心有變卡警示', n4.warnings.some((w) => /變卡/.test(w)), n4);
  check('型別錯誤有錯誤訊息', n5.errors.length === 1 && n5.config.lowPriority === true, n5);
  check('SCHEMA 欄位可供 GUI 畫', SC.SCHEMA.every((s) => s.key && s.label && s.help) && SC.SCHEMA.some((s) => s.key === 'cpuCores'));
  console.log(ok + ' passed, ' + bad.length + ' failed', bad);
  process.exit(bad.length ? 1 : 0);
})();
