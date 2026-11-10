'use strict';
// 嵌入檢查：floating-assistant.js 裡的 STUDIO 區塊要和 renderer/src/studio 的來源逐字一致（改了來源忘記跑 node scripts/embed-code-ui.js 會在這裡失敗），
// 並且把嵌入的主行程端檔案寫到暫存資料夾後真的能載入、探測（就是 main-ext.js 的 studio_* 信箱操作走的路）。
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..', '..');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const fa = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
const sect = (b, e) => { const i = fa.indexOf('/* ' + b + ' */'), j = fa.indexOf('/* ' + e + ' */'); return i < 0 || j < 0 ? null : fa.slice(i, j); };
const studio = sect('STUDIO-BEGIN', 'STUDIO-END'), view = sect('STUDIOVIEW-BEGIN', 'STUDIOVIEW-END');
check('有 STUDIO 與 STUDIOVIEW 標記', !!studio && !!view);
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
// 載入嵌入的核心（取得 FaStudio、FA_STUDIO_HOST_FILES、FA_STUDIO_LAYOUT_SRC）
const sandbox = { TextEncoder, TextDecoder }; vm.createContext(sandbox);
vm.runInContext(studio.replace(/^\/\* STUDIO-BEGIN \*\/\n/, '').replace(/const (FaStudio|FA_STUDIO_LAYOUT_SRC|FA_STUDIO_HOST_FILES) =/g, 'var $1 ='), sandbox);
check('FaStudio 帶齊九個核心', ['FaStudioAsset', 'FaFatrain', 'FaStudioStorage', 'FaStudioTrainerAdapter', 'FaStudioLayout', 'FaLoraRegistry', 'FaStudioIngest', 'FaStudioClean', 'FaStudioServer'].every((k) => sandbox.FaStudio[k]), Object.keys(sandbox.FaStudio));
check('版面核心原始碼一致', sandbox.FA_STUDIO_LAYOUT_SRC === rd('renderer/src/studio/studio_layout_core.js'));
const files = sandbox.FA_STUDIO_HOST_FILES;
Object.keys(files).forEach((n) => { const src = n.indexOf('lora-train/') === 0 ? 'lora-train/' + n.slice(11) : 'renderer/src/studio/' + n; check('嵌入與來源一致：' + n, files[n] === rd(src)); });
const lit = (t) => JSON.stringify(t).split(String.fromCharCode(0x2028)).join('\u2028').split(String.fromCharCode(0x2029)).join('\u2029');
check('檢視器範本一致', view.indexOf(lit(rd('renderer/src/studio/studio-viewer.template.html'))) >= 0);
// 寫到暫存資料夾、載入、探測
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-studio-embed-'));
Object.keys(files).forEach((n) => { const f = path.join(dir, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, files[n]); });
const mod = require(path.join(dir, 'studio_host.js'));
const cp = { spawnSync: () => ({ error: new Error('ENOENT') }), spawn: () => { throw new Error('不該啟動'); } };
const h = mod.createStudioHost({ fs, path, os, cp, hostDir: dir, loraDir: path.join(dir, 'lora-train'), env: {} });
(async () => {
  const r = await h.handle('studio_probe', { kind: 'lora' });
  check('嵌入版主行程端可載入並探測', r.ok && r.backends.length === 4, r);
  check('lora-train 資料夾以嵌入的訓練腳本為準', r.loraDir === path.join(dir, 'lora-train'), r.loraDir);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})();
