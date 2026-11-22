/* NES 樣本普查（唯讀）。模式：
 *   node musiclib_extract_nes_census.js headers <資料夾> [--json 路徑]
 *       只讀每個檔案的前 64 位元組（秒級）：分類，ROM 依 mapper 計數。
 *   node musiclib_extract_nes_census.js sample <資料夾> --per 3 --out 抽樣清單.json
 *       每個 mapper 依檔名排序取前 N 個 ROM，印出挑了哪些，寫成清單。
 *   node musiclib_extract_nes_census.js run <抽樣清單.json> [--workers 2] [--json 結果路徑]
 *       跑清單上的 ROM（最多 2 個工作程序）；每個 ROM 開始與結束各印一行（序號/總數、檔名、mapper、耗時、三類累計）。
 * 唯讀：不寫入樣本資料夾，不複製 ROM 進 repo。 */
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');
var NESX = require('./musiclib_extract_nes.js');

function walk(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc); else acc.push(full);
  });
  return acc;
}
function argOf(name, def) { var i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def; }
function headOf(file) {
  var fd = fs.openSync(file, 'r'), buf = Buffer.alloc(64), n = fs.readSync(fd, buf, 0, 64, 0);
  fs.closeSync(fd);
  return new Uint8Array(buf.subarray(0, n));
}
function scanHeaders(root) {
  return walk(root, []).map(function (f) {
    var rel = path.relative(root, f), head = headOf(f);
    var c = NESX.classifyFile(rel, head), row = { file: rel, abs: f, cls: c.cls, kind: c.kind, label: c.label, mapper: null };
    if (c.cls === 'rom') { var pr = NESX.parseInes(fs.readFileSync(f)); row.mapper = pr.ok ? pr.mapper : null; if (!pr.ok) row.headerReason = pr.reason; }
    return row;
  });
}
function mapperCounts(rows) {
  var m = {};
  rows.filter(function (r) { return r.cls === 'rom'; }).forEach(function (r) { var k = r.mapper == null ? '檔頭壞' : String(r.mapper); m[k] = (m[k] || 0) + 1; });
  return m;
}

// ───── 子程序：跑清單上的 ROM，每個 ROM 前後各印一行 JSON（給父程序排進度）─────
async function runChild(listFile) {
  var items = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  var NES = require('../../vendor/jsnes/jsnes.umd.cjs').NES;
  require('./musiclib_nes_mappers.js').install(NES);
  for (var i = 0; i < items.length; i++) {
    var it = items[i], bytes = fs.readFileSync(it.abs), t0 = Date.now();
    process.stdout.write(JSON.stringify({ ev: 'start', idx: it.idx, file: it.file, mapper: it.mapper }) + '\n');
    var row;
    try {
      var r = await NESX.extractNsf(bytes, NES, { name: it.file.replace(/\.[^.]+$/, '') });
      row = { mode: r.mode, stage: r.stage, reason: r.reason, nsfStage: r.nsfStage, nsfReason: r.nsfReason, midiReason: r.midiReason, nsfNote: r.nsfNote,
        play: r.play, init: r.init, bankInit: r.bankInit, frames: r.stats.frames, activeFrames: r.stats.activeFrames, quit: r.stats.quit,
        crashed: r.stats.crashed, notes: r.stats.notes || 0, durationSec: r.stats.durationSec || 0, apuWrites: r.stats.apuWrites };
    } catch (e) { row = { mode: 'none', stage: '例外', reason: String((e && e.message) || e) }; }
    row.ev = 'end'; row.idx = it.idx; row.file = it.file; row.mapper = it.mapper; row.ms = Date.now() - t0;
    process.stdout.write(JSON.stringify(row) + '\n');
  }
}

function fmtSec(ms) { return (ms / 1000).toFixed(1) + 's'; }

// 父程序：起最多 workers 個子程序，逐行讀 JSON，印進度與三類累計
function runParent(items, workers, jsonOut) {
  return new Promise(function (resolve) {
    var total = items.length, done = 0, results = [], started = 0, t0 = Date.now();
    var tally = { nsf: 0, midi: 0, none: 0 };
    var queues = [];
    for (var w = 0; w < workers; w++) queues.push(items.filter(function (_, i) { return i % workers === w; }));
    var tmp = path.join(path.dirname(jsonOut || process.cwd()), 'census_sample_' + process.pid);
    fs.mkdirSync(tmp, { recursive: true });
    var alive = 0;
    queues.forEach(function (q, wi) {
      if (!q.length) return;
      alive++;
      var lf = path.join(tmp, 'list_' + wi + '.json');
      fs.writeFileSync(lf, JSON.stringify(q), 'utf8');
      var p = cp.spawn(process.execPath, [__filename, 'child', lf], { stdio: ['ignore', 'pipe', 'inherit'] });
      var buf = '';
      p.stdout.on('data', function (d) {
        buf += d.toString('utf8');
        var lines = buf.split('\n'); buf = lines.pop();
        lines.forEach(function (ln) {
          if (!ln.trim()) return;
          var ev; try { ev = JSON.parse(ln); } catch (e) { return; }
          if (ev.ev === 'start') {
            started++;
            console.log('[' + (ev.idx + 1) + '/' + total + '] 開始 ' + ev.file + ' ｜mapper ' + ev.mapper + ' ｜已耗時 ' + fmtSec(Date.now() - t0) + ' ｜進行中 ' + (started - done));
          } else if (ev.ev === 'end') {
            done++;
            var key = ev.mode === 'nsf' || ev.mode === 'nsf+midi' ? 'nsf' : ev.mode === 'midi' ? 'midi' : 'none';
            tally[key]++;
            results.push(ev);
            console.log('[' + (ev.idx + 1) + '/' + total + '] 結束 ' + ev.file + ' ｜mapper ' + ev.mapper + ' ｜結果 ' + (ev.mode || 'none') +
              (ev.mode === 'none' || ev.mode === 'midi' ? '（' + (ev.nsfStage || ev.stage || '?') + '：' + (ev.nsfReason || ev.reason || '') + '）' : '') +
              ' ｜耗時 ' + fmtSec(ev.ms) + ' ｜已耗時 ' + fmtSec(Date.now() - t0) + ' ｜累計 有NSF ' + tally.nsf + '、只MIDI ' + tally.midi + '、都沒有 ' + tally.none + ' ｜完成 ' + done + '/' + total);
          }
        });
      });
      p.on('exit', function (code) {
        alive--;
        if (code !== 0) console.log('子程序 ' + wi + ' 結束碼 ' + code);
        if (alive === 0) {
          results.sort(function (a, b) { return a.idx - b.idx; });
          if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1), 'utf8');
          resolve(results);
        }
      });
    });
    if (!alive) resolve([]);
  });
}

async function main() {
  var mode = process.argv[2];
  if (mode === 'child') return runChild(process.argv[3]);
  if (mode === 'headers' || mode === 'sample') {
    var root = process.argv[3];
    var rows = scanHeaders(root);
    var roms = rows.filter(function (r) { return r.cls === 'rom'; });
    var nonrom = {};
    rows.filter(function (r) { return r.cls !== 'rom'; }).forEach(function (r) { nonrom[r.label] = (nonrom[r.label] || 0) + 1; });
    console.log('共 ' + rows.length + ' 個檔案；ROM（iNES 檔頭）' + roms.length + ' 個；非 ROM ' + (rows.length - roms.length) + ' 個');
    console.log('非 ROM 分類：' + Object.keys(nonrom).map(function (k) { return k + ' ' + nonrom[k]; }).join('、'));
    var mc = mapperCounts(rows);
    console.log('ROM 依 mapper 計數：' + Object.keys(mc).sort(function (a, b) { return a - b; }).map(function (k) { return 'mapper ' + k + ' × ' + mc[k] + (NESX.CORE_MAPPERS.indexOf(+k) < 0 && k !== '檔頭壞' ? '（核心不支援）' : ''); }).join('、'));
    var jsonOut = argOf('--json', null);
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows.map(function (r) { return { file: r.file, cls: r.cls, kind: r.kind, mapper: r.mapper }; }), null, 1), 'utf8');
    if (mode === 'sample') {
      var per = +argOf('--per', 3), byMap = {};
      roms.sort(function (a, b) { return a.file < b.file ? -1 : 1; }).forEach(function (r) {
        var k = r.mapper == null ? '檔頭壞' : String(r.mapper);
        (byMap[k] = byMap[k] || []).push(r);
      });
      var pick = [];
      Object.keys(byMap).sort(function (a, b) { return (+a || 0) - (+b || 0); }).forEach(function (k) {
        byMap[k].slice(0, per).forEach(function (r) { pick.push({ file: r.file, abs: r.abs, mapper: r.mapper }); });
      });
      pick.forEach(function (p, i) { p.idx = i; });
      fs.writeFileSync(argOf('--out', 'sample.json'), JSON.stringify(pick, null, 1), 'utf8');
      console.log('抽樣集（每個 mapper 最多 ' + per + ' 個，依檔名排序取前幾個）共 ' + pick.length + ' 個：');
      pick.forEach(function (p) { console.log('  mapper ' + p.mapper + '  ' + p.file); });
    }
    return;
  }
  if (mode === 'run') {
    var items = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    // 慢的 mapper 5（MMC5）排最後：所有其他 mapper 先跑完一輪
    items.sort(function (a, b) { return ((a.mapper === 5) - (b.mapper === 5)) || (a.idx - b.idx); });
    var workers = Math.min(2, +argOf('--workers', 2));
    var results = await runParent(items, workers, argOf('--json', null));
    console.log('完成：' + results.length + '/' + items.length);
    return;
  }
  console.error('用法：headers <資料夾> ｜ sample <資料夾> --per 3 --out 清單.json ｜ run 清單.json [--workers 2] [--json 結果]');
  process.exit(2);
}

main().then(function () { process.exit(0); }, function (e) { console.error(e); process.exit(1); });
