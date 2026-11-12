// node renderer/src/studio/lora_route_wiring.test.js
// 守住「聊天裡真正送進模型的呼叫點有標任務類型」：colu、toolcall、plan、decompose 四類都要接上每輪 LoRA 路由。
// 這是原始碼接線檢查（不啟動產品）；實際切換行為由 lora_route.test.js 與 studio_server_core.test.js 覆蓋。
const fs = require('fs'); const path = require('path');
const Rt = require('./lora_route_core.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c) => { if (c) ok++; else { bad++; console.log('FAIL ' + n); } };

check('選單呼叫點標 colu', /_llmGenerate\(S\.model, \{ task: 'colu'/.test(SRC));
check('工具參數呼叫點標 toolcall', /_llmGenerate\(S\.model, \{ task: 'toolcall'/.test(SRC));
check('工具階段呼叫點標 toolcall', /_llmGenerate\(m, \{ task: 'toolcall'/.test(SRC));
check('食譜規劃模型預設標 plan（呼叫端沒指定時）', /return this\._llmGenerate\(model, Object\.assign\(\{\}, a, \{ tools: \[\], deterministic: true, task: a\.task \|\| opts\.task \|\| 'plan' \}\), \{\}\);/.test(SRC));
check('UML design 拆解經 _umlModel 傳 decompose', /const off = await this\._planModel\(\{ task: 'decompose' \}\)/.test(SRC));
check('路由前先備好儲存層（沒開過工作室也能讀登錄表）', /if \(!this\._studioStoreSync\) \{ try \{ this\._studioStoreSync = await this\._studioStorage\(\);/.test(SRC));
// 路由核心認得這四種任務
for (const [t, d] of [['colu', 'colu'], ['toolcall', 'toolcall'], ['plan', 'plan'], ['decompose', 'decompose']]) check('taskDomain ' + t, Rt.taskDomain(t) === d);
check('未知任務回 null（走基底）', Rt.taskDomain('chitchat') === null);
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
