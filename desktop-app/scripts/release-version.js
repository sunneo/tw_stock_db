#!/usr/bin/env node
'use strict';
// 熱更新（desktop-app-patch）版號的唯一維護處。多個 session／多個人都會發版，版號不能各自記在腦袋或對話裡：
//   desktop-app/PATCH_VERSION   一行整數＝「最後一次發出去的 patch 版號」，跟那次發版的 commit 一起提交（所以 git 歷史就是版號歷史）
//   origin/desktop-app-patch 的 manifest.json 的 version＝實際發出去的（最終依據）
// 用法：
//   node scripts/release-version.js status          印出檔案版號、遠端版號、下一版（兩邊不一致會警告）
//   node scripts/release-version.js next            只印下一版（= max(檔案, 遠端) + 1）；給腳本用
//   node scripts/release-version.js claim [N]       把 PATCH_VERSION 寫成下一版（或指定的 N，N 必須剛好是下一版）；發版的 commit 要包含這個檔案
//   node scripts/release-version.js check           檔案版號 ≠ 遠端版號就以 1 結束（發完版之後檢查有沒有漏提交）
// 遠端版號用 `git fetch origin desktop-app-patch` 後讀 origin/desktop-app-patch:manifest.json；沒有網路時用本機已有的那份，並且說明。
const fs = require('fs'), path = require('path'), cp = require('child_process');
const APP = path.resolve(__dirname, '..'), FILE = path.join(APP, 'PATCH_VERSION'), REMOTE = process.env.REMOTE || 'origin', BRANCH = 'desktop-app-patch';
function sh(args) { return cp.execFileSync('git', args, { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function fileVersion() { try { const n = parseInt(fs.readFileSync(FILE, 'utf8').trim(), 10); return isFinite(n) ? n : 0; } catch (_) { return 0; } }
// 遠端版號取三者最大的：manifest.v2.json（現在真正的最新；manifest.json 是給舊版客戶端的互換版、凍結在 188）、manifest.json、patch commit 訊息裡的 vNNN。
// 實際發生過 commit 訊息與 manifest 版號不一樣，三個都看才不會回頭用到已經用過的號碼
function remoteVersion() {
  let fetched = true; try { sh(['fetch', '-q', REMOTE, BRANCH]); } catch (_) { fetched = false; }
  const ver = (file) => { try { const m = JSON.parse(sh(['show', REMOTE + '/' + BRANCH + ':' + file])); const n = parseInt(m.version, 10); return { v: isFinite(n) ? n : 0, notes: String(m.notes || '').slice(0, 60) }; } catch (_) { return { v: 0, notes: '' }; } };
  const v2 = ver('manifest.v2.json'), v1 = ver('manifest.json'); let msg = 0;
  try { const mm = /desktop-app-patch:\s*v(\d+)/i.exec(sh(['log', '-1', '--format=%s', REMOTE + '/' + BRANCH])); msg = mm ? parseInt(mm[1], 10) : 0; } catch (_) { /* 沒有 */ }
  return { version: Math.max(v2.v, v1.v, msg), v2: v2.v, legacy: v1.v, message: msg, fresh: fetched, notes: v2.notes || v1.notes };
}
function state() { const f = fileVersion(), r = remoteVersion(); return { file: f, remote: r.version, v2: r.v2, legacy: r.legacy, message: r.message, fresh: r.fresh, notes: r.notes, next: Math.max(f, r.version) + 1, consistent: f === r.version && r.v2 === r.message }; }
const cmd = process.argv[2] || 'status', st = state();
if (cmd === 'next') { if (!st.fresh) { process.stderr.write('警告：連不上遠端，下一版是用本機已有的 manifest 算的，可能不是最新\n'); } console.log(st.next); }
else if (cmd === 'claim') {
  const want = process.argv[3] ? parseInt(process.argv[3], 10) : st.next;
  if (want !== st.next) { console.error('下一版是 ' + st.next + '，不是 ' + want + '（檔案 ' + st.file + '、遠端 ' + st.remote + '）。別的 session 可能剛發過版，重新確認再發。'); process.exit(1); }
  fs.writeFileSync(FILE, want + '\n'); console.log('PATCH_VERSION = ' + want + '（記得跟發版的 commit 一起提交）');
}
else if (cmd === 'check') { if (!st.consistent) { console.error('版號不一致：檔案 ' + st.file + '、遠端 manifest.v2 ' + st.v2 + '、遠端 commit 訊息 v' + st.message + (st.file < st.remote ? '（有人發了版但沒有更新 PATCH_VERSION）' : st.v2 !== st.message ? '（遠端的 manifest 與 commit 訊息版號不一樣：發版時版號沒傳對）' : '（檔案比遠端新：發版沒完成？）')); process.exit(1); } console.log('一致：' + st.file); }
else { console.log('PATCH_VERSION（檔案）：' + st.file + '\n遠端 ' + REMOTE + '/' + BRANCH + '：manifest.v2 ' + st.v2 + '（互換版 manifest.json ' + st.legacy + '）、commit 訊息 v' + st.message + '（取 ' + st.remote + '）' + (st.notes ? '（' + st.notes + '…）' : '') + (st.fresh ? '' : '　⚠ 連不上遠端，用本機的') + '\n下一版：' + st.next + (st.consistent ? '' : '\n⚠ 檔案與遠端不一致——以較大的為準；發版前先弄清楚為什麼')); }
