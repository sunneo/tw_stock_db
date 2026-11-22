// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄）。 2. 一次只跑一個評測。 3. 結束前取消工作並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 不需要 GPU、網路、模型。遊戲檔有版權：只把樣本複製到 scratchpad 的測試資料夾，不進 repo。 5. 每個 Electron 實際執行最多兩次。
// 晶片音樂播放器真桌面版評測：chiptest/lib 放 3 個真實 RIX、2 個真實 FC ROM（唯讀複製）。
// 驗證：RIX 播放核心（渲染不靜音、seek 與連續渲染一致、goto 解析、曲目）、曲庫面板「▶ 晶片播放（RIX）」按鈕真的掛出控制卡片、
// NES 擷取出的 NSF 能用 NSF 後端播放（渲染前幾秒、回報是否靜音）、NSF 的「▶ 晶片播放」按鈕掛出卡片。
const ROOT = 'E:/Temp/claude/1845096e089295dd/e49cfb73-b239-407d-a0c7-0036bc8d60d4/scratchpad/chiptest';
const out = { checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const a = window.desktopAPI;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function rms(f) { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / Math.max(1, f.length)); }
try {
  check('模組存在', typeof FaChipPlayer !== 'undefined' && typeof FaChipPlayerUI !== 'undefined' && typeof FaChipNsf !== 'undefined' && typeof FaMusicLibHost !== 'undefined', '');
  if (!out.checks.every((c) => c.ok)) throw new Error('前置條件不符，停止');
  const L = FaMusicLibHost.getLib(); await L.ready;
  const entries = await FaMusicLibHost.walkFolder(ROOT + '/lib');
  const readHead = (p, n) => a.rawfs.readHead(p, n).then((r) => (r && r.base64 != null ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : null));
  const sid = L.addSource('folder', 'chiplib'); await L.scan(sid, entries, readHead); await L.save();
  const rixes = L.records.filter((r) => r.kind === 'rix'), nes = L.records.filter((r) => r.kind === 'nes');
  check('掃到 3 個 RIX、2 個 NES', rixes.length === 3 && nes.length === 2, rixes.length + '/' + nes.length);

  // RIX 播放核心
  const rb = b64ToBytes((await a.rawfs.readFile(rixes[0].path, 'base64')).base64);
  const p = FaChipPlayer.createPlayer('rix', rb, { sampleRate: 44100 });
  const pcm = p.render(0, 0, 3);
  out.rixRms = rms(pcm);
  check('RIX 渲染 3 秒：長度對、不靜音', pcm.length === 44100 * 3 && out.rixRms > 0.005, 'len=' + pcm.length + ' rms=' + out.rixRms.toFixed(4));
  const cont = p.render(0, 0, 8), seeked = p.render(0, 5, 2);
  let maxd = 0; for (let i = 0; i < seeked.length; i++) maxd = Math.max(maxd, Math.abs(seeked[i] - cont[5 * 44100 + i]));
  check('seek 到 5 秒與連續渲染一致', maxd < 1e-4, 'maxdiff=' + maxd);
  const g1 = FaChipPlayer.parseGoto('1:23'), g2 = FaChipPlayer.parseGoto('曲目 2');
  check('goto 解析（時間、曲目）', g1 && g1.sec === 83 && g2 && g2.kind !== 'time', JSON.stringify([g1, g2]));

  // 面板按鈕（RIX）
  window.fa._mlOpen(); await sleep(1500);
  const panel = Array.from(document.querySelectorAll('.fml')).pop();
  const btn = panel && Array.from(panel.querySelectorAll('button')).find((b) => /晶片播放（RIX）/.test(b.textContent));
  check('面板有「▶ 晶片播放（RIX）」按鈕', !!btn, panel ? '' : '無面板');
  if (btn) { btn.click(); await sleep(2500); }
  const card = panel && Array.from(panel.querySelectorAll('button')).map((b) => b.textContent).join('|');
  out.cardButtons = card;
  check('按下後掛出控制卡片（有播放、匯出 mp3／MIDI 等按鈕）', !!card && /播放|▶/.test(card) && /mp3/i.test(card), String(card).slice(0, 200));
  try { document.querySelectorAll('audio').forEach((x) => x.pause()); } catch (_) { /* */ }

  // NES → NSF → NSF 後端播放
  const r1 = await FaMusicLibHost.extract.run(nes, { userRoot: ROOT + '/out' });
  const nsfs = L.records.filter((r) => r.kind === 'nsf' && r.derivedFrom);
  check('NES 擷取出 NSF 子曲目', nsfs.length >= 1, JSON.stringify(r1.summary) + ' nsf=' + nsfs.length);
  out.nsf = [];
  for (const k of nsfs) {
    try {
      try { FaChipPlayer.getBackend('nsf'); } catch (_) { FaChipPlayer.registerBackend(FaChipNsf.createBackend(FaJsnes.NES)); }
      const nb = b64ToBytes((await a.rawfs.readFile(k.path, 'base64')).base64);
      const np = FaChipPlayer.createPlayer('nsf', nb, { sampleRate: 44100 });
      const t0 = Date.now(); const f = np.render(0, 0, 3); const ms = Date.now() - t0;
      const c2 = np.render(0, 0, 6), s2 = np.render(0, 3, 2); let md = 0; for (let i = 0; i < s2.length; i++) md = Math.max(md, Math.abs(s2[i] - c2[3 * 44100 + i]));
      out.nsf.push({ name: k.name, rms: Math.round(rms(f) * 10000) / 10000, ms: ms, seekDiff: md });
    } catch (e) { out.nsf.push({ name: k.name, error: String((e && e.message) || e) }); }
  }
  check('NSF 後端：每個 NSF 都能載入並渲染（不丟錯）', out.nsf.length >= 1 && out.nsf.every((x) => !x.error), JSON.stringify(out.nsf));
  check('NSF 後端：至少一個不靜音', out.nsf.some((x) => x.rms > 0.005), JSON.stringify(out.nsf.map((x) => x.rms)));
  check('NSF 後端：seek 與連續渲染一致', out.nsf.every((x) => x.error || x.seekDiff < 1e-4), JSON.stringify(out.nsf.map((x) => x.seekDiff)));
  // NSF 按鈕
  window.fa._mlOpen(); await sleep(1500);
  const panel2 = Array.from(document.querySelectorAll('.fml')).pop();
  const nb2 = panel2 && Array.from(panel2.querySelectorAll('button')).filter((b) => /▶ 晶片播放$/.test(b.textContent.trim()));
  check('曲庫列有 NSF「▶ 晶片播放」按鈕', nb2 && nb2.length >= 1, String(nb2 && nb2.length));
  if (nb2 && nb2.length) { nb2[0].click(); await sleep(3500); }
  const txt = panel2 ? panel2.textContent : '';
  check('按 NSF 按鈕後沒有出現「無法開啟」「尚未內嵌」', !/無法開啟晶片播放器|尚未內嵌|還沒有內嵌/.test(txt), (txt.match(/⚠️[^\n]{0,80}/) || [''])[0]);
} catch (e) { out.error = String((e && e.stack) || e); }
try { FaMusicLibHost.extract && FaMusicLibHost.extract.cancel(); document.querySelectorAll('audio').forEach((x) => x.pause()); } catch (_) { /* */ }
out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
return out;
