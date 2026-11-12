// node scripts/self-correct/domain_produces.test.js
// 領域「完成判準」與糾正訊息（FA_DOMAIN_PRODUCES／faDomainProduced／faCorrectionNote），加上委派流程接線檢查。
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c) => { if (c) ok++; else { bad++; console.log('FAIL ' + n); } };
const a = SRC.indexOf('const FA_DOMAIN_PRODUCES'), b = SRC.indexOf('const SUBAGENT_DOMAIN_REGISTRY');
const F = new Function(SRC.slice(a, b) + ';return {faDomainProduced,faCorrectionNote,FA_DOMAIN_PRODUCES,faDomainExpect}')();
const P = F.FA_DOMAIN_PRODUCES;
check('成功呼叫產物工具 → 做出成果', F.faDomainProduced([{ name: 'image_to_3d', ok: true }], P.scene_3d));
check('只有失敗的呼叫 → 沒做出成果', !F.faDomainProduced([{ name: 'image_to_3d', ok: false }], P.scene_3d));
check('只呼叫了非產物工具（list_uploaded_files）→ 沒做出成果', !F.faDomainProduced([{ name: 'list_uploaded_files', ok: true }], P.scene_3d));
check('沒有呼叫任何工具 → 沒做出成果', !F.faDomainProduced([], P.translate));
for (const d of ['scene_3d', 'animation_2d', 'interactive_component', 'translate', 'worksheet', 'drawing']) check('領域 ' + d + ' 有判準', Array.isArray(P[d]) && P[d].length > 0);
const note = F.faCorrectionNote([{ name: 'image_to_3d', ok: false, rawArgs: '{}', res: { error: '缺 file_id' } }], P.scene_3d, '3D 場景');
check('糾正訊息點名要用的工具', /render_3d_scene/.test(note) && /image_to_3d/.test(note));
check('糾正訊息帶上次的錯誤原文', /缺 file_id/.test(note));
check('糾正訊息禁止再用文字交差', /不要再只用文字交差/.test(note));
// 依任務文字的軟判準（image／music／coding／editors）
const E = F.faDomainExpect;
check('image：「畫一張海報」要有產物工具（軟）', (() => { const r = E('image', '畫一張夏日海報'); return r && r.soft === true && r.tools.indexOf('generate_image') >= 0; })());
check('image：「解讀這張圖」不設判準', E('image', '解讀這張圖') === null);
check('music：「幫我作曲」有判準；「播放這首」沒有', !!E('music', '幫我作一首曲，作曲') && E('music', '播放這首') === null);
check('coding：「修正這個函式的 bug」有判準；「解釋這段程式」沒有', !!E('coding', '修正這個函式的 bug') && E('coding', '解釋這段程式') === null);
check('editors：「把影片剪掉前十秒」有判準', !!E('editors', '把影片剪掉前十秒'));
check('硬判準領域不受任務文字影響（scene_3d）', E('scene_3d', '隨便').soft === false);
check('沒有登記的領域回 null', E('git_operations', '推上去') === null);
// 接線
check('委派流程收集工具呼叫（callLog → collectCalls）', /const callLog = \[\]/.test(SRC) && /collectCalls: callLog/.test(SRC));
check('判準不成立 → 糾正重來最多 2 次，再失敗就誠實失敗', /attempt <= 2 && !done\(\)/.test(SRC) && /沒有做出成果：已糾正重來 2 次/.test(SRC));
check('結尾是問句（向使用者釐清）不算放棄', /\[\?？\]\\s\*\$/.test(SRC));
check('失敗訊息附模型說的話，但不當成果', /model_said: String\(\(subResult && subResult\.text\)/.test(SRC));
check('軟判準：仍沒有只加警告、不判失敗', /expect\.soft\) \{/.test(SRC) && /這次沒有確認到成果/.test(SRC));
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
