// node scripts/harness-tests/consensus.test.js
// 共識閘門：中文字面條款、正規表達式、行號、allow 遮罩、必須缺漏、結束碼、設定錯誤。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../../skills/weak-model-harness/scripts/consensus_check.js');

let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };

const sample = [
  '第一行：本階段採用標準輸入輸出溝通。',          // 1
  '進度寫進 progress.jsonl，每行一則。',          // 2
  '不要 http，這是禁止的句子。',                  // 3
  '網址 https://cdn.jsdelivr.net/npm/x 可以用。',  // 4
  '錯誤示範：http://127.0.0.1:8080 不可以。',      // 5
  '伺服器模式（選用）需要金鑰。',                  // 6
  'HTTP 大寫也要抓到。',                          // 7
].join('\n');

// 1 中文字面 must 通過並給行號
let r = C.checkConsensus({ must: ['標準輸入輸出', 'progress.jsonl'] }, sample);
check('must 中文與英文字面命中並回報行號', r.violations === 0 && r.results[0].lines.join() === '1' && r.results[1].lines.join() === '2', r);

// 2 must 缺漏算違反
r = C.checkConsensus({ must: ['直接實作'] }, sample);
check('must 找不到是違反', r.violations === 1 && r.results[0].ok === false, r);

// 3 forbid 字面、不分大小寫、回報所有行號
r = C.checkConsensus({ forbid: ['http'] }, sample);
const hl = r.results[0].lines;
check('forbid 不分大小寫，列出所有行號（含大寫 HTTP）', r.results[0].ok === false && hl.join() === '3,4,5,7', r.results[0]);

// 4 allow 遮罩：CDN 網址與禁止註明句子不算違反，但遮掉後同行的違反仍抓得到
r = C.checkConsensus({ forbid: ['http'], allow: [{ re: 'https://[^\\s]+' }, '不要 http'] }, sample);
check('allow 遮掉 https 網址與註明句子後，剩下的 http:// 與大寫 HTTP 仍命中（第 5、7 行）', r.results[0].lines.join() === '5,7' && r.violations === 1, r.results[0]);

// 5 正規表達式條款與 flags
r = C.checkConsensus({ forbid: [{ re: '127\\.0\\.0\\.\\d+' }] }, sample);
check('forbid 正規表達式命中 IP', r.results[0].lines.join() === '5', r.results[0]);
r = C.checkConsensus({ must: [{ re: '金鑰', flags: '' }] }, sample);
check('must 正規表達式（flags 空字串）命中中文', r.results[0].ok === true && r.results[0].lines.join() === '6', r.results[0]);

// 6 中文禁止條款
r = C.checkConsensus({ forbid: ['伺服器模式', '金鑰'] }, sample);
check('中文 forbid 條款各自回報', r.results[0].ok === false && r.results[1].ok === false && r.violations === 2, r);

// 7 全部通過時結束碼需為 0（經由 CLI）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-test-'));
const target = path.join(dir, 'target.md'); fs.writeFileSync(target, sample, 'utf8');
const cli = path.join(__dirname, '../../skills/weak-model-harness/scripts/consensus_check.js');
const writeC = (name, obj) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(obj), 'utf8'); return p; };
let s = spawnSync(process.execPath, [cli, writeC('pass.json', { name: 'p', must: ['標準輸入輸出'], forbid: ['沒有這句'] }), '--target', target], { encoding: 'utf8' });
check('全部通過結束碼 0', s.status === 0 && /全部通過/.test(s.stdout), { status: s.status, out: s.stdout });

// 8 違反時結束碼 1，輸出含行號
s = spawnSync(process.execPath, [cli, writeC('fail.json', { name: 'f', forbid: ['伺服器模式'] }), '--target', target], { encoding: 'utf8' });
check('違反結束碼 1 且輸出含行號', s.status === 1 && /違反/.test(s.stdout) && /第 6 行/.test(s.stdout), { status: s.status, out: s.stdout });

// 9 設定錯誤（壞的正規表達式）結束碼 2
s = spawnSync(process.execPath, [cli, writeC('bad.json', { forbid: [{ re: '(' }] }), '--target', target], { encoding: 'utf8' });
check('壞正規表達式結束碼 2', s.status === 2 && /正規表達式錯誤/.test(s.stderr), { status: s.status, err: s.stderr });

// 10 scope 與 --root 組合、--json 輸出
fs.mkdirSync(path.join(dir, 'sub'));
fs.writeFileSync(path.join(dir, 'sub', 'a.md'), '只有 標準輸入輸出 一句', 'utf8');
s = spawnSync(process.execPath, [cli, writeC('scope.json', { must: ['標準輸入輸出'], scope: ['sub/a.md'] }), '--root', dir, '--json'], { encoding: 'utf8' });
let j = null; try { j = JSON.parse(s.stdout); } catch (e) { }
check('--root 與 scope 組合、--json 輸出 violations 為 0', s.status === 0 && j && j.violations === 0 && j.files[0].target === 'sub/a.md', { status: s.status, out: s.stdout });

// 11 空條款與缺設定
let threw = false; try { C.validateConsensus({}); } catch (e) { threw = /至少要有一條/.test(e.message); }
check('沒有任何條款的共識檔拒絕', threw);
threw = false; try { C.toRegExp(''); } catch (e) { threw = true; }
check('空字串條款拒絕', threw);

// 12 真實的共識檔格式與 formatResult
const fr = C.formatResult({ kind: 'forbid', label: 'http', ok: false, lines: [3, 5], sample: 'http' });
check('formatResult 中文輸出含行號與命中字', /\[違反\] 禁止出現：http（第 3, 5 行，命中：http）/.test(fr), fr);

fs.rmSync(dir, { recursive: true, force: true });
console.log(ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '\n' + bad.join('\n') : ''));
process.exit(bad.length ? 1 : 0);
