'use strict';
// 單元測試：node scripts/gen-aiweb-pages.test.js（本機 node 16，沒有 node:test，所以用小型執行器）
const assert = require('assert/strict');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./gen-aiweb-pages.js');

const HERE = __dirname;
const REAL_SRC = path.join(HERE, '..', 'renderer', 'src', 'floating-assistant.js');
const TPL = path.join(HERE, 'aiweb-gui', 'fa-gui.template.js');
const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0';

function tmpWeb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-aiweb-'));
  fs.mkdirSync(path.join(root, 'web', 'aiweb'), { recursive: true });
  return root;
}

test('解析登錄表：單行與多行的 register_slash_command 都抓得到，描述取最長字串', () => {
  const src = [
    "this.register_slash_command('/one', '', '第一個指令的描述');",
    'this.register_slash_command(',
    "    '/two', '[x]',",
    "    '第二個：多行呼叫，描述在下一行。',",
    '    async (argsText, run) => { run.x("不是描述"); }',
    ');',
    "this.register_slash_command('/one', '', '重複的不該覆蓋');",
  ].join('\n');
  const reg = G.parseRegistry(src);
  assert.deepEqual([...reg.keys()], ['/one', '/two']);
  assert.equal(reg.get('/one').desc, '第一個指令的描述');
  assert.equal(reg.get('/two').desc, '第二個：多行呼叫，描述在下一行。');
});

test('真實登錄表：使用者點名的 GUI 指令都登錄過（/knowledge-ui 是 /knowledge ui 的別名）', () => {
  const reg = G.parseRegistry(fs.readFileSync(REAL_SRC, 'utf8'));
  for (const c of ['/musiclib', '/run-terminal', '/edit-midi', '/edit-svg', '/edit-picture', '/edit-3d-model', '/edit-3d', '/knowledge-ui']) {
    assert.ok(reg.has(c), c + ' 應該在登錄表裡');
  }
});

test('gui-commands.json：每個名稱都在真實登錄表裡，且沒有重複', () => {
  const list = G.readGuiList();
  const reg = G.parseRegistry(fs.readFileSync(REAL_SRC, 'utf8'));
  assert.ok(list.length >= 8);
  for (const c of list) assert.ok(reg.has(c), c + ' 不在登錄表');
  assert.equal(new Set(list).size, list.length);
});

test('gui 清單格式錯誤或重複要丟錯', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-aiweb-list-'));
  const f = path.join(dir, 'g.json');
  fs.writeFileSync(f, JSON.stringify({ gui: ['musiclib'] }));
  assert.throws(() => G.readGuiList(f), /指令名稱格式錯誤/);
  fs.writeFileSync(f, JSON.stringify({ gui: ['/musiclib', '/musiclib'] }));
  assert.throws(() => G.readGuiList(f), /重複/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('路徑深度：全螢幕頁在 aiweb/<指令>/，相對路徑解析後要落在真實的 fa-gui.js 與 coi-serviceworker.js', () => {
  const web = tmpWeb();
  const reg = "this.register_slash_command('/musiclib', '', '音樂庫：測試');";
  const plan = G.buildPlan({
    registrySrc: reg, sha: SHA_NEW, webRoot: web, guiList: ['/musiclib'],
    templateText: fs.readFileSync(TPL, 'utf8'), aiIndexHtml: '<html><body>\n</body></html>', existingGuiDirs: [],
  });
  const page = plan.files.find((f) => f.abs.endsWith(path.join('aiweb', 'musiclib', 'index.html')));
  assert.ok(page, '要產生 aiweb/musiclib/index.html');
  const pageDir = path.dirname(page.abs); // 相當於 URL 結尾有斜線的 .../aiweb/musiclib/
  const js = /<script src="([^"]+)" defer>/.exec(page.content)[1];
  const coi = /<script src="([^"]+)"><\/script>/.exec(page.content)[1];
  assert.equal(path.resolve(pageDir, js), path.join(web, 'web', 'aiweb', 'fa-gui.js'));
  assert.equal(path.resolve(pageDir, coi), path.join(web, 'web', 'coi-serviceworker.js'));
  const back = /href="(\.\.\/gui\/)"/.exec(page.content)[1];
  assert.equal(path.resolve(pageDir, back), path.join(web, 'web', 'aiweb', 'gui'));
  fs.rmSync(web, { recursive: true, force: true });
});

test('SHA 取代：fa-gui.js 的所有 __FA_SHA__ 都換成新 SHA；格式錯誤的 SHA 拒絕', () => {
  const tpl = fs.readFileSync(TPL, 'utf8');
  const out = G.faGuiScript(SHA_NEW, tpl);
  assert.equal(out.includes('__FA_SHA__'), false);
  assert.ok(out.includes("var FA_SHA = '" + SHA_NEW + "'"));
  assert.equal(out.split(SHA_NEW).length - 1, 1, 'SHA 只寫一處（FA_SHA），jsDelivr／raw 網址都由它串起來');
  assert.throws(() => G.faGuiScript('abc', tpl), /40 位/);
  assert.throws(() => G.faGuiScript(SHA_NEW.toUpperCase(), tpl), /40 位/);
});

test('讀網頁版 var SHA 當預設；讀不到就丟錯', () => {
  const web = tmpWeb();
  fs.mkdirSync(path.join(web, 'web'), { recursive: true });
  fs.writeFileSync(path.join(web, 'web', 'index.html'), "<script>\n  var SHA = '" + SHA_OLD + "';\n</script>");
  assert.equal(G.readPinnedSha(web), SHA_OLD);
  fs.writeFileSync(path.join(web, 'web', 'index.html'), '<html></html>');
  assert.throws(() => G.readPinnedSha(web), /找不到 var SHA/);
  fs.rmSync(web, { recursive: true, force: true });
});

test('hash 轉址區塊：第一次插在 <body> 後，第二次換掉舊區塊，結果一樣（冪等）', () => {
  const html = '<!DOCTYPE html><html><head></head><body class="x">\n<div>AI</div></body></html>';
  const block = G.routerBlock(['/musiclib', '/run-terminal']);
  const once = G.injectRouter(html, block);
  assert.ok(once.indexOf(G.ROUTER_BEGIN) > once.indexOf('<body'));
  assert.ok(once.includes('<div>AI</div>'), '原本的 AI 頁內容不能掉');
  const twice = G.injectRouter(once, block);
  assert.equal(twice, once);
  const other = G.injectRouter(once, G.routerBlock(['/musiclib']));
  assert.ok(other.includes('["musiclib"]'));
  assert.equal(other.split(G.ROUTER_BEGIN).length - 1, 1);
});

test('hash 轉址名單只含 GUI 指令，且 JSON 裡的 < 會跳脫，不會提早結束 <script>', () => {
  const block = G.routerBlock(['/musiclib']);
  assert.ok(block.includes('var GUI = ["musiclib"]'));
  const evil = G.routerBlock(['/x</script>']);
  assert.ok(evil.includes('["x\\u003c/script>"]'));
  assert.equal(evil.split('</script>').length - 1, 1, '只能有一個真正的 </script>');
});

test('清單頁：只列 GUI 指令、連結指向各自的全螢幕頁、名稱顯示在提示裡不會被當 HTML', () => {
  const reg = G.parseRegistry(fs.readFileSync(REAL_SRC, 'utf8'));
  const entries = ['/musiclib', '/edit-midi'].map((c) => reg.get(c));
  const html = G.listHtml(entries);
  assert.ok(html.includes('href="../musiclib/"'));
  assert.ok(html.includes('href="../edit-midi/"'));
  assert.equal(html.includes('/run-terminal'), false);
  assert.ok(html.includes("location.hash"), '找不到名稱時要顯示提示');
});

test('找出過期入口：只刪有 fa-gui-cmd 標記的目錄，不碰手寫頁面', () => {
  const web = tmpWeb();
  const aiweb = path.join(web, 'web', 'aiweb');
  fs.mkdirSync(path.join(aiweb, 'old-gui'));
  fs.writeFileSync(path.join(aiweb, 'old-gui', 'index.html'), '<meta name="fa-gui-cmd" content="/old">');
  fs.mkdirSync(path.join(aiweb, 'hand'));
  fs.writeFileSync(path.join(aiweb, 'hand', 'index.html'), '<html>手寫</html>');
  assert.deepEqual(G.listExistingGuiDirs(aiweb), ['old-gui']);
  fs.rmSync(web, { recursive: true, force: true });
});

test('整體計畫：真實登錄表 + 真實清單，每個 GUI 都有入口頁、報告提醒不會拿來當清單', () => {
  const web = tmpWeb();
  const plan = G.buildPlan({
    registrySrc: fs.readFileSync(REAL_SRC, 'utf8'), sha: SHA_NEW, webRoot: web, guiList: G.readGuiList(),
    templateText: fs.readFileSync(TPL, 'utf8'), aiIndexHtml: '<html><body></body></html>', existingGuiDirs: [],
  });
  const dirs = plan.entries.map((e) => G.dirOf(e.cmd));
  for (const d of dirs) {
    assert.ok(plan.files.some((f) => f.abs.endsWith(path.join('aiweb', d, 'index.html'))), d + ' 入口頁');
  }
  assert.ok(plan.files.some((f) => f.abs.endsWith(path.join('aiweb', 'fa-gui.js'))));
  assert.ok(plan.files.some((f) => f.abs.endsWith(path.join('aiweb', 'gui', 'index.html'))));
  fs.rmSync(web, { recursive: true, force: true });
});

let pass = 0; const fails = [];
for (const [name, fn] of tests) {
  try { fn(); pass++; } catch (e) { fails.push(name); console.log('FAIL', name, '\n  ' + (e && e.message).split('\n').slice(0, 6).join('\n  ')); }
}
console.log(`gen-aiweb-pages 測試：${pass}/${tests.length} 通過`);
if (fails.length) process.exit(1);
