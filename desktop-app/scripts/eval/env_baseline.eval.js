// 環境基準線（真實 Electron）：偵測、/env、模型跑完依政策卸載、OOM 降級
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/env_baseline.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.messages = [];
const cmd = (c) => fa.slashCommands.get(c);
R.has = { FaEnv: typeof FaEnv, host: typeof fa._envTier, cmd: !!cmd('/env') };
R.auto = { tier: fa._envTier(), raw: { mobile: fa._envRaw.mobile, mem: fa._envRaw.deviceMemory, cores: fa._envRaw.cores, heap: !!fa._envRaw.heapLimit } };
await cmd('/env').handler('low', fa); R.low = { tier: fa._envTier(), lite: fa._i3dLite(), saved: fa.advancedSettings.envProfile, unloadAfterTask: fa._envPolicy().unloadAfterTask };
R.report = String(fa.messages[fa.messages.length - 1].content).split('\n').slice(0, 4);
// 低檔：模型跑完幾秒後卸載
let disposed = 0; fa._whisperTranscriber = { dispose() { disposed++; } }; fa._envSettle('whisper'); await wait(1000); R.whisper_not_yet = !!fa._whisperTranscriber; await wait(4000); R.whisper_unloaded = fa._whisperTranscriber === null && disposed === 1;
// 高檔：不會跑完就卸載
await cmd('/env').handler('high', fa); fa._whisperTranscriber = { dispose() { disposed++; } }; fa._envSettle('whisper'); await wait(1500); R.high_keeps = !!fa._whisperTranscriber && fa._envPolicy().unloadAfterTask === false;
// 手動全卸載
await cmd('/env').handler('unload', fa); R.unload_all = fa._whisperTranscriber === null;
// OOM → 降級＋卸載＋明確錯誤
await cmd('/env').handler('auto', fa); fa._whisperTranscriber = { dispose() { disposed++; } }; const before = fa._envTier(); let err = null;
try { await fa._envGuard(async () => { throw new Error('Array buffer allocation failed'); }); } catch (e) { err = e.message; }
R.oom = { error: err, degraded: fa._envGov().degradeLevel, tier_before: before, tier_after: fa._envTier(), unloaded: fa._whisperTranscriber === null, notified: fa.messages.some((m) => /記憶體不足/.test(String(m.content || ''))) };
const other = await fa._envGuard(async () => 42); R.guard_passthrough = other === 42;
let other2 = null; try { await fa._envGuard(async () => { throw new Error('network'); }); } catch (e) { other2 = e.message; } R.guard_other_errors_untouched = other2 === 'network' && fa._envGov().degradeLevel === 1;
await cmd('/env').handler('reset', fa); R.reset = fa._envGov().degradeLevel === 0;
// 載入讓位：低檔預算 600MB，兩個 400MB 的不能同時常駐
await cmd('/env').handler('low', fa); const g = fa._envGov(); let loadedA = true; g.register('t:a', { bytes: () => 400 * 1048576, unload: async () => { loadedA = false; } }); g.register('t:b', { bytes: () => 400 * 1048576, unload: async () => {} });
await fa._envAcquire('t:a'); fa._envRelease('t:a'); const rb = await fa._envAcquire('t:b'); R.make_room = { a_unloaded_for_b: loadedA === false, fits: rb.fits };
// swap：大塊資料放 IndexedDB，熱區超過就寫出，讀回一致
const sw = fa._envSwap(); const mk = (n, c) => new Blob([new Uint8Array(n).fill(c)]); const hs = []; for (let i = 0; i < 8; i++) hs.push(await sw.put(mk(2 * 1048576, i + 1)));
R.swap = { items: sw.stats().items, hot_mb: Math.round(sw.stats().hotBytes / 1048576), disk_mb: Math.round(sw.stats().diskBytes / 1048576) };
const back = await sw.get(hs[0]); const u = new Uint8Array(await back.arrayBuffer()); R.swap.roundtrip = u.length === 2 * 1048576 && u[0] === 1 && u[u.length - 1] === 1;
await fa._envGov().unload('swap', '測試'); R.swap.after_unload_hot = sw.stats().hotBytes; for (const h of hs) await sw.drop(h); R.swap.cleared = sw.stats().items === 0;
await cmd('/env').handler('auto', fa);
console.log('ENV_RESULT ' + JSON.stringify(R));
return R;
