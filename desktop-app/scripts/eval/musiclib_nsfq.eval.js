// 評測守則同 musiclib_chip.eval.js。NSF 擷取品質：3 個真實 FC ROM（唯讀複製）擷取成 NSF 後，用 NSF 後端渲染前 5 秒，回報音量與是否大部分靜音。
const ROOT = 'E:/Temp/claude/1845096e089295dd/e49cfb73-b239-407d-a0c7-0036bc8d60d4/scratchpad/nsfq';
const out = { checks: [], nsf: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function rms(f) { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / Math.max(1, f.length)); }
function silentRatio(f, sr) { const w = Math.floor(sr / 10); let sil = 0, n = 0; for (let i = 0; i + w <= f.length; i += w) { let s = 0; for (let k = 0; k < w; k++) s += f[i + k] * f[i + k]; if (Math.sqrt(s / w) < 0.002) sil++; n++; } return n ? sil / n : 1; }
try {
  localStorage.setItem('fa.musiclib.derivedDir', ROOT + '/out');
  const L = FaMusicLibHost.getLib(); await L.ready;
  const entries = await FaMusicLibHost.walkFolder(ROOT + '/lib');
  const readHead = (p, n) => a.rawfs.readHead(p, n).then((r) => (r && r.base64 != null ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : null));
  const sid = L.addSource('folder', 'nsfq'); await L.scan(sid, entries, readHead); await L.save();
  const srcs = L.records.filter((r) => r.kind === 'nes');
  const r1 = await FaMusicLibHost.extract.run(srcs, { userRoot: ROOT + '/out' });
  check('3 個 NES 都擷取完成', r1.summary.done === 3, JSON.stringify(r1.summary));
  try { FaChipPlayer.getBackend('nsf'); } catch (_) { FaChipPlayer.registerBackend(FaChipNsf.createBackend(FaJsnes.NES)); }
  for (const k of L.records.filter((r) => r.kind === 'nsf' && r.derivedFrom)) {
    try {
      const nb = b64ToBytes((await a.rawfs.readFile(k.path, 'base64')).base64);
      const np = FaChipPlayer.createPlayer('nsf', nb, { sampleRate: 44100 });
      const t0 = Date.now(), f = np.render(0, 0, 5), ms = Date.now() - t0;
      out.nsf.push({ name: k.name, rms: Math.round(rms(f) * 10000) / 10000, silent: Math.round(silentRatio(f, 44100) * 100) / 100, ms: ms });
    } catch (e) { out.nsf.push({ name: k.name, error: String((e && e.message) || e) }); }
  }
  check('每個 NSF 都能載入並渲染（不丟錯）', out.nsf.length === 3 && out.nsf.every((x) => !x.error), JSON.stringify(out.nsf));
  check('每個 NSF 前 5 秒音量大於 0.005', out.nsf.every((x) => x.rms > 0.005), JSON.stringify(out.nsf.map((x) => x.name + ':' + x.rms)));
  check('每個 NSF 前 5 秒靜音比例低於 70%', out.nsf.every((x) => x.silent < 0.7), JSON.stringify(out.nsf.map((x) => x.name + ':' + x.silent)));
} catch (e) { out.error = String((e && e.stack) || e); }
try { FaMusicLibHost.extract && FaMusicLibHost.extract.cancel(); } catch (_) { /* */ }
out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
return out;
