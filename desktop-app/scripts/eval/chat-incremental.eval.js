// 對話重繪是增量的（真實 Electron）：沒變的訊息節點身分不變（上面掛好的元件、捲動位置不會被重置），只有變了的訊息重畫，新訊息只是附加在後面；
// 與畫面無關的設定變動不會重畫，畫面相關的（顯示內部過程、主題）才整批重畫。
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const fa = window.fa; const R = {}; const body = document.getElementById('ai-chat-body');
fa.messages = fa.messages.filter((m) => m.role === 'system').slice(0, 1);
for (let i = 0; i < 30; i++) { fa.messages.push({ role: i % 2 ? 'assistant' : 'user', content: '第 ' + i + ' 則：' + '內容 '.repeat(40) }); }
fa._renderMessageHistory();
const wraps = () => Array.from(body.querySelectorAll(':scope > .fa-msg-wrap'));
const mark = () => wraps().forEach((w, i) => { w.__mark = 'm' + i; });
const marks = () => wraps().map((w) => w.__mark || null);
mark(); R.wraps = wraps().length; R.has_wrap_per_message = R.wraps >= 30;
// 在中間放一個「已掛載的元件」：計時器每 50ms 增加計數，重畫若重建就會歸零
const host = wraps()[10]; const widget = document.createElement('div'); widget.id = 'probe-widget'; widget.__ticks = 0; host.appendChild(widget); const iv = setInterval(() => { widget.__ticks++; }, 50);
body.scrollTop = 120; const st0 = body.scrollTop; R.scroll_set = st0;
// 1) 什麼都沒變，重畫：所有節點身分不變、元件還在、捲動不動
fa._renderMessageHistory();
R.same_nodes_after_noop = marks().every((m, i) => m === 'm' + i) && wraps().length === R.wraps; R.widget_alive = document.getElementById('probe-widget') === widget; R.scroll_after_noop = body.scrollTop;
// 2) 與畫面無關的設定改動（system prompt 重整、一般設定）：不重畫
const before = marks();
try { fa._refreshSystemPromptMessage && fa._refreshSystemPromptMessage(); } catch (e) { R.refresh_err = String(e); }
fa.advancedSettings.someUnrelatedSetting = (fa.advancedSettings.someUnrelatedSetting || 0) + 1; fa._renderMessageHistory();
R.same_nodes_after_settings = JSON.stringify(marks()) === JSON.stringify(before); R.widget_alive_settings = document.getElementById('probe-widget') === widget;
// 3) 新訊息：只附加，舊節點不動，捲動位置（沒在底部）不變
fa.messages.push({ role: 'assistant', content: '新的一則' }); fa._renderMessageHistory();
const after3 = marks(); R.appended = wraps().length === R.wraps + 1 && after3.slice(0, R.wraps).every((m, i) => m === 'm' + i) && after3[after3.length - 1] === null; R.widget_alive_append = document.getElementById('probe-widget') === widget; R.scroll_after_append = body.scrollTop;
// 4) 改一則訊息：只有那一則重畫
fa.messages[fa.messages.length - 1].content = '改過的一則'; const target = wraps()[wraps().length - 1]; fa._renderMessageHistory();
R.one_rebuilt = wraps()[wraps().length - 1] !== target && wraps().slice(0, -1).every((w, i) => w.__mark === 'm' + i) && wraps()[wraps().length - 1].textContent.indexOf('改過的一則') >= 0;
// 5) 刪掉中間一則：其他節點不動，那一則不見
const gone = fa.messages.findIndex((m) => String(m.content).indexOf('第 5 則') === 0); const goneText = fa.messages[gone].content; fa.messages.splice(gone, 1); fa._renderMessageHistory();
R.deleted = wraps().length === R.wraps && !body.textContent.includes('第 5 則') && wraps().filter((w) => w.__mark).length === R.wraps - 1 && document.getElementById('probe-widget') === widget;
// 6) 畫面相關的設定（顯示內部過程）：整批重畫（節點身分全換），內容仍然都在
const mk = marks().filter(Boolean).length; fa.advancedSettings.showInternalTrace = !fa.advancedSettings.showInternalTrace; fa._renderMessageHistory();
R.env_rebuilds_all = marks().filter(Boolean).length === 0 && wraps().length > 25; fa.advancedSettings.showInternalTrace = !fa.advancedSettings.showInternalTrace; fa._renderMessageHistory();
// 7) 還在底部時新增訊息：跟到新的底部
body.scrollTop = body.scrollHeight; fa.messages.push({ role: 'assistant', content: '底部的新訊息' }); fa._renderMessageHistory(); R.follows_bottom = Math.abs(body.scrollHeight - body.clientHeight - body.scrollTop) < 4;
// 8) 簽章：同樣內容簽章相同、改一個字就不同、不可列舉的屬性也算、超長字串改了頭尾會變
const s1 = fa._chatMsgSig({ role: 'user', content: 'abc' }), s2 = fa._chatMsgSig({ role: 'user', content: 'abc' }), s3 = fa._chatMsgSig({ role: 'user', content: 'abd' });
const m4 = { role: 'assistant', content: 'x' }; const a4 = fa._chatMsgSig(m4); Object.defineProperty(m4, '_displayDeckUrl', { value: 'client-file/abc', enumerable: false, configurable: true }); const b4 = fa._chatMsgSig(m4);
const big = 'x'.repeat(50000); const sb1 = fa._chatMsgSig({ role: 'tool', content: big }), sb2 = fa._chatMsgSig({ role: 'tool', content: big + 'y' }), sb3 = fa._chatMsgSig({ role: 'tool', content: 'z' + big.slice(1) });
R.sig = { same: s1 === s2, differ: s1 !== s3, nonenumerable: a4 !== b4, long_append: sb1 !== sb2, long_head: sb1 !== sb3, handle_ignored: fa._chatMsgSig({ role: 'a', _scene3DHandle: { x: 1 } }) === fa._chatMsgSig({ role: 'a', _scene3DHandle: { x: 2 } }), dom_ignored: fa._chatMsgSig({ role: 'a', _w: document.body }) === fa._chatMsgSig({ role: 'a', _w: document.head }) };
// 9) 一則訊息的渲染丟例外：不會中斷其他訊息，下次會再試
const bad = { role: 'assistant', content: 'boom' }; Object.defineProperty(bad, 'content', { get() { throw new Error('x'); }, enumerable: true, configurable: true }); fa.messages.push(bad); let threw = false; try { fa._renderMessageHistory(); } catch (e) { threw = true; } R.bad_message_survives = !threw && wraps().length > 25; fa.messages.pop(); fa._renderMessageHistory();
await new Promise((r) => setTimeout(r, 400)); // 10) 簡報播放器：只掛載一次（重畫、新訊息、設定變動都不重新掛載——「全部重新配音」的進度才不會被打斷）
await fa._deckEnsureRuntime(); await window.AiChat2D.ensureJsYamlLoaded();
const saved = await fa._deckSaveYaml(window.jsyaml.dump({ deck: { title: 't', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: 's', layout: 'title', narration: '你好。' }] }] }), 'inc');
let mounts = 0; const origMount = fa._deckMount; fa._deckMount = function () { mounts++; return origMount.apply(this, arguments); };
fa._pushDisplayToolMessage('[簡報]', '_displayDeckUrl', saved.url); fa._renderMessageHistory();
await new Promise((r) => setTimeout(r, 600)); const player = body.querySelector('.ai-chat-deck'); R.deck_mounted_once = mounts === 1 && !!player;
fa.messages.push({ role: 'assistant', content: '又一則' }); fa._renderMessageHistory(); fa.advancedSettings.someUnrelatedSetting = 2; fa._renderMessageHistory(); fa.messages.push({ role: 'user', content: '再一則' }); fa._renderMessageHistory();
R.deck_not_remounted = mounts === 1 && body.querySelector('.ai-chat-deck') === player; R.mounts = mounts; fa._deckMount = origMount;
clearInterval(iv); R.widget_ticks_continuous = widget.__ticks > 3;
return R;
