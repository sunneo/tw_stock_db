// node renderer/src/studio/offline_training_studio_slash.test.js
// /offline-training-studio 的接線檢查（靜態讀原始碼，不啟動桌面版、不渲染頁面）：
//   1. 指令已登錄，handler 會呼叫 _studioCommand；
//   2. 別名 /training-studio、/訓練工作室 存在，而且從選單隱藏（_menuHidden）；
//   3. _studioCommand 真的用 studioview 開視窗（_wgOpen），reset 會還原版面；
//   4. 網頁版 /gui 的清單（aiweb-gui/gui-commands.json）有它，產生腳本能產出它的全螢幕頁與清單列。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const DESKTOP = path.join(__dirname, '..', '..', '..');
const SRC = fs.readFileSync(path.join(DESKTOP, 'renderer', 'src', 'floating-assistant.js'), 'utf8');
const GUI_LIST = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'scripts', 'aiweb-gui', 'gui-commands.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('ok   ' + name); }
    catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); }
}

// 取出 /offline-training-studio 的登錄區塊（到下一個 register_slash_command 為止）
const regAt = SRC.indexOf("'/offline-training-studio', '[reset]'");
const regStart = SRC.lastIndexOf('this.register_slash_command(', regAt);
const regEnd = SRC.indexOf('this.register_slash_command(', regAt + 10);
const regBlock = SRC.slice(regStart, regEnd);

check('指令已登錄為 /offline-training-studio，參數提示 [reset]', () => {
    assert.ok(regAt >= 0, '找不到 /offline-training-studio 的登錄');
    assert.ok(/'\[reset\]'/.test(regBlock), '參數提示缺 [reset]');
});

check('handler 呼叫 _studioCommand（指令與設定頁按鈕走同一條路）', () => {
    assert.ok(/_studioCommand\(argsText\)/.test(regBlock), 'handler 沒有呼叫 _studioCommand');
});

check('別名 /training-studio 與 /訓練工作室 存在，且選單隱藏', () => {
    const at = SRC.indexOf("['/training-studio', '/訓練工作室'].forEach");
    assert.ok(at >= 0, '找不到別名區塊');
    const line = SRC.slice(SRC.lastIndexOf('\n', at) + 1, SRC.indexOf('\n', at));
    assert.ok(/slashCommands\.get\('\/offline-training-studio'\)/.test(line), '別名沒有取自 /offline-training-studio');
    assert.ok(/_menuHidden: true/.test(line), '別名沒有設 _menuHidden: true');
    assert.ok(/cmd: al/.test(line), '別名的 cmd 沒有改成別名本身');
});

check('_studioCommand 用 studioview 開視窗，失敗會回訊息（不靜默）', () => {
    const at = SRC.indexOf('async _studioCommand(argsText)');
    assert.ok(at >= 0, '找不到 _studioCommand');
    const body = SRC.slice(at, SRC.indexOf('\n    }', at));
    assert.ok(/_wgOpen\('studioview'/.test(body), '沒有用 studioview 開視窗');
    assert.ok(/r\.ok === false/.test(body) && /開不起訓練工作室/.test(body), '開窗失敗時沒有提示訊息');
});

check('reset 會還原版面（有 reset 才有的分支）', () => {
    const at = SRC.indexOf('async _studioCommand(argsText)');
    const body = SRC.slice(at, SRC.indexOf('\n    }', at));
    assert.ok(/a === 'reset'/.test(body) && /delete p\.layout/.test(body), 'reset 分支不見了');
});

check('網頁版 /gui 清單含 /offline-training-studio', () => {
    assert.ok(GUI_LIST.gui.includes('/offline-training-studio'), 'gui-commands.json 沒有列它');
});

check('產生腳本能從登錄表抓到它，並產出全螢幕頁與清單列', () => {
    const G = require(path.join(DESKTOP, 'scripts', 'gen-aiweb-pages.js'));
    const reg = G.parseRegistry(SRC);
    const e = reg.get('/offline-training-studio');
    assert.ok(e, '登錄表解析不到 /offline-training-studio');
    assert.ok(e.desc.indexOf('離線訓練工作室') === 0, '描述取得不對：' + e.desc);
    const sha = '45953c9bd0000000000000000000000000000000';
    const page = G.pageHtml('/offline-training-studio', e.desc, sha);
    assert.ok(/<meta name="fa-gui-cmd" content="\/offline-training-studio">/.test(page), '頁面缺 fa-gui-cmd 標記');
    assert.ok(/\.\.\/fa-gui\.js\?v=45953c9b/.test(page), '頁面沒有用 SHA 釘住的載入器');
    const list = G.listHtml([{ cmd: '/offline-training-studio', desc: e.desc }]);
    assert.ok(/href="\.\.\/offline-training-studio\/"/.test(list), '清單頁沒有連到全螢幕頁');
});

console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
if (fail) process.exit(1);
