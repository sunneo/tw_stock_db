// 虛擬領域 general（認識所有工具的通用子代理）：永遠排第 0、所有退路改指它、need_clarification 回問申請者、關閉時完全不出現。真實 Electron；語言模型是模擬的假回覆。
const fa = window.fa; const R = {};
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
fa._getGroundingContext = () => '[固定]';
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 }); fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true;
const setFlag = (v) => { if (v == null) localStorage.removeItem('fa.compactToolIndex'); else localStorage.setItem('fa.compactToolIndex', v); };
const realFetch = window.fetch.bind(window); const bodies = []; let routerReply = '這不是JSON'; let generalReply = '好的，已完成。';
window.fetch = async (url, init) => { if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init); const b = JSON.parse(init.body); const sys = String((b.messages[0] || {}).content || ''); bodies.push({ sys, user: String(b.messages[b.messages.length - 1].content), tools: (b.tools || []).map((t) => t.function.name), isRouter: /工具領域路由器/.test(sys) });
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: /工具領域路由器/.test(sys) ? routerReply : generalReply }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
// 1) 關／開：領域清單與委派說明
setFlag('0'); fa._syncGeneralDomain(); const keysOff0 = Object.keys(fa.domains); const descOff0 = fa._buildDelegateToSubagentDescription();
setFlag(null); fa._syncGeneralDomain(); const keysOn = Object.keys(fa.domains); const descOn = fa._buildDelegateToSubagentDescription();
fa._syncGeneralDomain(); const keysOn2 = Object.keys(fa.domains); // 重複呼叫不變
setFlag('0'); fa._syncGeneralDomain(); const keysOff1 = Object.keys(fa.domains); const descOff1 = fa._buildDelegateToSubagentDescription(); setFlag(null);
R.domains = { firstWhenOn: keysOn[0], sameCountOnTwice: keysOn.length === keysOn2.length && keysOn2[0] === 'general', offHasGeneral0: keysOff0.includes('general'), offAfterOnHasGeneral: keysOff1.includes('general'), offListUnchanged: JSON.stringify(keysOff0) === JSON.stringify(keysOff1), offDelegateDescUnchanged: descOff0 === descOff1, onDelegateMentionsGeneral: /general/.test(descOn) && !/general/.test(descOff1) };
setFlag(null); fa._syncGeneralDomain();
// 2) 所有取 domains[0] 的退路都改指 general：反思提示（模型說沒有工具）、能力反思、路由失敗、路由說不需要任何領域
const MODEL_REPLY = '我目前沒有直接瀏覽外部網頁的工具，無法即時抓取該網頁內容。'; fa.messages = [{ role: 'system', content: 'x' }, { role: 'user', content: 'https://example.com/a 這篇在說什麼' }]; fa._currentTurnUserText = 'https://example.com/a 這篇在說什麼'; fa._toolCallLog = { calls: [] }; fa._intentGuard = { count: 0 }; fa._forceNoTools = false;
const nudge = fa._noToolClaimNudge(MODEL_REPLY, fa._intentGuard) || ''; R.nudge = { domainLines: nudge.split('\n').filter((l) => /domain 填/.test(l)).map((l) => l.trim().slice(0, 80)), mentionsMusic: /music/.test(nudge), allGeneral: nudge.split('\n').filter((l) => /domain 填/.test(l)).every((l) => /填「general」/.test(l)) };
const refl = fa._capabilityReflectionText('我需要抓取網頁的內容並用瀏覽器讀取網頁 fetch web page'); R.reflection = { candidates: /domain 填/.test(refl), usesGeneral: !/domain 填 (?!general)/.test(refl), mentionsMusic: /domain 填 music/.test(refl) };
const TASK = '請讀取並總結這個東西'; bodies.length = 0; routerReply = '這不是JSON'; const r1 = await fa._delegateToSubagentAuto(TASK); const gen1 = bodies.find((b) => !b.isRouter && /通用子代理/.test(b.sys));
R.routeFail = { ok: r1 && r1.ok, result: String((r1 && (r1.result || r1.error)) || '').slice(0, 30), generalPromptHasIndex: !!gen1 && /## /.test(gen1.sys) && /need_clarification/.test(gen1.sys), generalPromptChars: gen1 ? gen1.sys.length : 0, userIsTask: !!gen1 && gen1.user.includes(TASK), toolsGiven: gen1 ? gen1.tools : null };
bodies.length = 0; routerReply = '{"domains": []}'; const r2 = await fa._delegateToSubagentAuto(TASK); R.routeEmpty = { ok: r2 && r2.ok, wentToGeneral: bodies.some((b) => !b.isRouter && /通用子代理/.test(b.sys)) };
// 3) 虛擬領域永遠在第 0（含別的領域後來才登記）
fa.register_domain('late_domain_x', { label: '晚登記', toolNames: [], systemPrompt: 'x' }); fa._syncGeneralDomain(); R.order = { first: Object.keys(fa.domains)[0], lateExists: !!fa.domains.late_domain_x }; delete fa.domains.late_domain_x;
// 4) 回問申請者：通用子代理回 need_clarification
generalReply = '{"need_clarification":true,"question":"你要的是摘要還是翻譯？","options":["摘要","翻譯"]}'; bodies.length = 0;
const c1 = await fa._delegateToSubagentDomain('general', TASK); const asJson = JSON.parse(await fa.tools.delegate_to_subagent.callback.call(fa, JSON.stringify({ task: TASK, domain: 'general' })));
R.clarify = { direct: { ok: c1.ok, need: c1.need_clarification, q: c1.question, options: c1.options, hasNote: !!c1.note }, viaTool: { ok: asJson.ok, need: asJson.need_clarification, q: asJson.question } };
// 重複防護：補充後重派（任務文字幾乎一樣）不被攔；同一輪回問兩次也不被當成成功而擋
const log = { calls: [] }; const run = async () => JSON.stringify(c1); const a = await fa._callToolGuarded(log, 'delegate_to_subagent', JSON.stringify({ task: TASK, domain: 'general' }), run); const b = await fa._callToolGuarded(log, 'delegate_to_subagent', JSON.stringify({ task: TASK + '（摘要）', domain: 'general' }), run);
R.clarify.guard = { first: /need_clarification/.test(String(a)), second: /need_clarification/.test(String(b)), secondNotBlocked: !/已經做過|重複/.test(String(b)), recorded: log.calls.map((c) => ({ ok: c.ok, soft: c.soft })) };
// 一般成功結果不受影響
generalReply = '摘要：這是一段正常的回覆。'; const n1 = await fa._delegateToSubagentDomain('general', TASK); R.normal = { ok: n1.ok, need: n1.need_clarification, result: String(n1.result || '').slice(0, 20) };
window.fetch = realFetch; setFlag(null);
return R;
