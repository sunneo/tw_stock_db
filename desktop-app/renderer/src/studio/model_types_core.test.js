// node renderer/src/studio/model_types_core.test.js —— 模型類型登錄表：狀態分類、開關守門、輸出可用性、文字不夾英文縮寫（除了既有格式名）
const M = require('./model_types_core.js');
let ok = 0, bad = 0; const check = (n, c, d) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };
const ids = M.TYPES.map((t) => t.id);
check('七種模型類型都在（語言模型、離線訓練器、語音合成、音樂作曲、語音辨識、音訊轉音符、圖像生成、看圖說文字）', M.TYPES.length === 8 && ['llm', 'symbolic', 'speech', 'music', 'speech_recognition', 'audio_to_notes', 'image', 'vision'].every((x) => ids.indexOf(x) >= 0), ids);
check('id 不重複', new Set(ids).size === ids.length);
check('狀態只會是 done／half／design', M.TYPES.every((t) => ['done', 'half', 'design'].indexOf(t.status) >= 0));
check('已完成：語言模型（LoRA 與完整模型都可輸出）', M.find('llm').status === 'done' && M.find('llm').outputs.every((o) => o.available));
check('語言模型的完整模型寫明格式與手動的第二步', M.find('llm').outputs[1].formats.join('').indexOf('ONNX') >= 0 && /匯出區/.test(M.find('llm').outputs[1].note));
check('半成品：語音合成、音樂作曲（小型模型的訓練核心已命令列實測，工作室還沒接上）', M.TYPES.filter((t) => t.status === 'half').map((t) => t.id).join() === 'speech,music');
check('只有設計：語音辨識、音訊轉音符、圖像生成、看圖說文字', ['speech_recognition', 'audio_to_notes', 'image', 'vision'].every((x) => M.find(x).status === 'design'));
check('每個不可用的輸出都寫原因', M.TYPES.every((t) => t.outputs.every((o) => o.available || (o.reason && o.reason.length > 4))));
check('每個半成品與只有設計的類型都寫缺口', M.TYPES.filter((t) => t.status !== 'done').every((t) => t.gap && /缺：/.test(t.gap) && /已有：/.test(t.gap)));
// 開關：預設（關）只顯示已完成
check('開關關：只列已完成的類型', M.listFor(false).every((t) => t.status === 'done') && M.listFor(false).length === 2, M.listFor(false).map((t) => t.id));
check('開關開：全部類型都列出，半成品與只有設計有徽章', M.listFor(true).length === 8 && M.listFor(true).filter((t) => t.status !== 'done').every((t) => t.badge === M.STATUS_LABEL[t.status]));
check('已完成的類型沒有徽章', M.listFor(false).every((t) => t.badge === ''));
check('listFor 回傳的是複本（改它不影響登錄表）', (() => { const l = M.listFor(true); l[0].can.push('x'); return M.find('llm').can.indexOf('x') < 0; })());
// 守門
check('已完成＋可用輸出 → run', M.canStart('llm', 'lora', false).level === 'run' && M.canStart('llm', 'full', false).ok === true);
check('已完成但輸出不可用 → blocked 並給原因（用暫時加入的假類型測）', (() => { M.TYPES.push({ id: 'fake', name: '假', status: 'done', summary: '', sources: [], backends: [], outputs: [{ id: 'lora', label: 'L', available: false, formats: [], reason: '沒有訓練核心。' }], can: [], cannot: [], gap: '' }); const r = M.canStart('fake', 'lora', false); M.TYPES.pop(); return r.level === 'blocked' && !r.ok && /沒有訓練核心/.test(r.message); })());
check('開關關時選半成品 → blocked，說明要開開關', (() => { const r = M.canStart('speech', 'lora', false); return r.level === 'blocked' && /顯示半成品的功能/.test(r.message); })());
check('半成品（開關開）→ partial，說明能做到哪一步、不假裝能訓練', (() => { const r = M.canStart('speech', 'lora', true); return r.level === 'partial' && !r.ok && /目前能做到：整理語音樣本/.test(r.message) && /還不能做：/.test(r.message) && r.can.length > 0; })());
check('只有設計（開關開）→ blocked，不產生檔案', (() => { const r = M.canStart('image', 'lora', true); return r.level === 'blocked' && !r.ok && /不會產生任何檔案/.test(r.message) && r.can.length === 0; })());
check('不認得的類型 → blocked', M.canStart('nope', 'lora', true).level === 'blocked');
check('未知輸出代號：退回第一個輸出', M.canStart('llm', 'xyz', false).level === 'run');
// 文字：不夾英文縮寫（既有格式名與模型名除外）
const txt = M.TYPES.map((t) => [t.name, t.summary, t.gap, t.can.join(' '), t.cannot.join(' '), t.sources.join(' '), t.outputs.map((o) => [o.label, o.note || '', o.reason || '', (o.formats || []).join(' ')].join(' ')).join(' ')].join(' ')).join(' ');
const allowed = /ONNX|GGUF|LoRA|SDXS|Python|WebAssembly|WebGPU|Q8_0|\.jsonl|\.fatrain|cpu|wasm|CoLU|UML|llama\.cpp|q8/g;
const stray = (txt.match(/[A-Za-z][A-Za-z0-9_.\-]{1,}/g) || []).filter((w) => !/^(ONNX|GGUF|LoRA|SDXS|Python|WebAssembly|Q8_0|jsonl|fatrain|cpu|wasm|CoLU|UML|llama\.cpp|q8|js|WebGPU|DirectML|Vulkan)$/.test(w.replace(/^\.|\.$/g, '')));
check('介面文字不夾英文縮寫（既有格式與模型名除外）', stray.length === 0, [...new Set(stray)]);
check('文字沒有簡體字', !/[这个们说话时间东车长门语问题发过还满书为个]/.test(txt));
// 接線：設定頁有開關（預設關）、app 傳入清單與守門、樣板從 CFG 讀取（不自己判斷）
const fs = require('fs'), path = require('path');
const FA = fs.readFileSync(path.join(__dirname, '../floating-assistant.js'), 'utf8'), TPL = fs.readFileSync(path.join(__dirname, 'studio-viewer.template.html'), 'utf8');
check('設定頁開關「顯示半成品的功能」存在，預設關（studioShowHalfFinished: false）', /studioShowHalfFinished: false/.test(FA) && /顯示半成品的功能/.test(FA) && /ai-studio-half-chk/.test(FA));
check('開關的存法與 offlineDevicePreference 相同：advancedSettings → _saveAdvancedSettings', /advancedSettings\.studioShowHalfFinished = halfChk\.checked === true; this\._saveAdvancedSettings\(\)/.test(FA) && /studioShowHalfFinished: raw\.studioShowHalfFinished === true/.test(FA));
check('視窗啟動帶入清單與守門；開關變更時即時推送', /modelTypes: mtp\.list, guards: mtp\.guards, showHalf: mtp\.showHalf/.test(FA) && /__fa_modeltypes: p/.test(FA));
check('樣板只讀 CFG／訊息傳來的結果，不 require 登錄表', /CFG\.modelTypes/.test(TPL) && /CFG\.guards/.test(TPL) && !/model_types_core/.test(TPL));
check('embed 清單已登錄 model_types_core', /'model_types_core'/.test(fs.readFileSync(path.join(__dirname, '../../../scripts/embed-code-ui.js'), 'utf8')));
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
