// 對話動作判斷接線（renderer/src/floating-assistant.js）：閘門位置、上一步記錄、內嵌複本與來源模組一致
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8');
const mod = fs.readFileSync(path.join(root, 'renderer/src/offline/dialogue_act.js'), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log((c ? 'ok   ' : 'FAIL ') + m); };

const at = (s) => src.indexOf(s);
const pend = at('if (this._tryFeedPendingAsk(textToSend)) return;');
const gate = at('if (!hasAttachments && await this._dialogueActGate(textToSend)) return;');
const trans = at('{ const tr = !hasAttachments ? FaTranslate.intent(textToSend) : null;');
ok(pend > 0 && gate > pend, '閘門接在 _tryFeedPendingAsk 之後');
ok(trans > gate, '閘門在 FaTranslate 之前（反駁不被翻譯攔截）');
const offStart = at('    async _offlineRespond(userText, opts) {');
const rec = at('this._recordDialogueAction(text, plan, d);');
ok(offStart > 0 && rec > offStart && rec < at('    _handleAskModeIntent(text) {'), '_offlineRespond 在選定工具後記下 lastAction');
ok(at('    async _dialogueActGate(text) {') > 0 && at('    async _applyDialogueDecision(dec, text, la, sentence) {') > 0, '閘門與套用決定兩個方法都存在');

// 內嵌複本必須是來源模組的內容（改來源後要重跑 embed-code-ui.js）
const bA = src.indexOf('/* DIALOGUE-BEGIN */'), bB = src.indexOf('/* DIALOGUE-END */');
const block = bA >= 0 && bB > bA ? src.slice(bA, bB).replace(/\r\n/g, '\n') : '';
ok(block.indexOf('const FaDialogueAct = (function () {') > 0, '內嵌複本有 FaDialogueAct');
const core = mod.trim();
ok(block.indexOf(core.slice(0, 200)) >= 0, '內嵌複本與來源模組一致（開頭段落吻合）');
ok(block.indexOf('function guardCommandWord') > 0 && block.indexOf('function precheck') > 0, '內嵌複本含預檢與守門');

// 真實案例：句首「不是，我說的是」＋句中 review，上一步不是 review → 守門與預檢都會擋（來源模組行為）
const FD = require('../renderer/src/offline/dialogue_act.js');
const CASE = '不是，我說的是前面的review error不影響bitbake build';
const LA = { tool: 'redmine_issue_open', kind: 'url', candidates: [], alternatives: [], primary: 'redmine_issue_open' };
ok(FD.precheck(CASE, LA).triggered && FD.guardCommandWord(CASE, LA).hold, '同一句：預檢觸發，守門攔住 review 直接執行');

console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
