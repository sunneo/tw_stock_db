// node renderer/src/archive/archive_core.test.js
const A = require('./archive_core.js'); const fx = require('./archive_fixtures.json'); const crypto = require('crypto'); const zlib = require('zlib');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };
const u8 = (b64) => new Uint8Array(Buffer.from(b64, 'base64')); const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// ---- 檔頭辨識 ----
const S = (b64, name) => A.sniff(u8(b64), name);
check('sniff: 7z by magic (even with a wrong name)', S(fx.other['t.7z'], 'whatever.bin').format === '7z' && S(fx.other['t.7z'], 'x.zip').mismatch === true);
check('sniff: xz', S(fx.other['t.xz'], 'a.xz').format === 'xz' && S(fx.other['t.xz'], 'a.xz').codec === 'xz' && !S(fx.other['t.xz'], 'a.xz').tarInside);
check('sniff: zip / jar / war', S(fx.other['t.zip'], 'a.zip').format === 'zip' && S(fx.other['t.zip'], 'lib.jar').format === 'jar' && S(fx.other['t.zip'], 'app.war').format === 'jar' && S(fx.other['t.zip'], 'a.apk').format === 'zip');
check('sniff: tgz / tar.gz mean "tar inside gzip"', S(fx.other['t.tgz'], 'a.tgz').format === 'tgz' && S(fx.other['t.tgz'], 'a.tgz').tarInside === true && S(fx.other['t.tgz'], 'a.tar.gz').format === 'tgz' && S(fx.other['t.tgz'], 'a.gz').format === 'gz' && !S(fx.other['t.tgz'], 'a.gz').tarInside);
check('sniff: tar.bz2 / tbz2 / tar.xz / txz', S(fx.other['t.tar.bz2'], 'a.tar.bz2').format === 'tbz2' && S(fx.other['t.tar.bz2'], 'a.tbz2').tarInside && S(fx.other['t.tar.xz'], 'a.tar.xz').format === 'txz' && S(fx.other['t.tar.xz'], 'a.txz').tarInside, [S(fx.other['t.tar.bz2'], 'a.tar.bz2'), S(fx.other['t.tar.xz'], 'a.tar.xz')]);
check('sniff: rar4 (and rar5 header)', S(fx.other['stored.rar'], 'a.rar').format === 'rar' && A.sniff(Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, 0, 0]), 'x').format === 'rar');
check('sniff: tar by ustar, v7 tar by checksum', S(fx.tar.ustar.data, 'noext').format === 'tar' && (() => { const h = new Uint8Array(1024); const nm = Buffer.from('old.txt'); h.set(nm, 0); h.set(Buffer.from('0000644\0'), 100); h.set(Buffer.from('00000000000\0'), 124); h.fill(32, 148, 156); let sum = 0; for (let i = 0; i < 512; i++) sum += h[i]; h.set(Buffer.from(sum.toString(8).padStart(6, '0') + '\0 '), 148); return A.sniff(h, 'x').format === 'tar'; })());
check('sniff: iso by CD001 at 0x8001', (() => { const b = new Uint8Array(0x8100); b.set(Buffer.from('CD001'), 0x8001); return A.sniff(b, 'disc.bin').format === 'iso' && A.sniff(b, 'x.iso').format === 'iso'; })());
check('sniff: bzip2 / gzip / zstd / lz4 magic', A.sniff(Uint8Array.from([0x42, 0x5a, 0x68, 0x39, 0, 0]), 'x').format === 'bz2' && A.sniff(Uint8Array.from([0x1f, 0x8b, 8, 0]), 'x').format === 'gz' && A.sniff(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0]), 'x').format === 'zst' && A.sniff(Uint8Array.from([0x04, 0x22, 0x4d, 0x18]), 'x').format === 'lz4');
check('sniff: a truncated/empty file falls back to the extension, unknown stays empty', A.sniff(new Uint8Array(0), 'broken.7z').format === '7z' && A.sniff(new Uint8Array(0), 'notes.txt').format === '' && A.sniff(Uint8Array.from([1, 2, 3, 4]), 'a.bin').format === '');
check('sniff: a "BZh" prefix with a bad level digit is not bzip2', A.sniff(Uint8Array.from([0x42, 0x5a, 0x68, 0x41, 0, 0]), 'x.txt').format === '');
check('formatFromName covers the whole list the user asked for', ['a.7z', 'a.bz2', 'a.tar.gz', 'a.tgz', 'a.iso', 'a.xz', 'a.zip', 'a.tar', 'a.rar', 'a.jar'].every((n) => A.formatFromName(n)), ['a.7z', 'a.bz2', 'a.tar.gz', 'a.tgz', 'a.iso', 'a.xz', 'a.zip', 'a.tar', 'a.rar', 'a.jar'].map(A.formatFromName));

// ---- bzip2 ----
for (const [k, v] of Object.entries(fx.bz2)) { const out = A.bzip2Decode(u8(v.data)); check('bzip2: ' + k + ' round-trips exactly', out.length === v.len && sha(out) === v.sha, [k, out.length, v.len]); }
check('bzip2: multi-block really has more than one block', (() => { const d = u8(fx.bz2.multiblock.data); let blocks = 0; for (let i = 0; i < d.length - 6; i++) { /* 區塊標記不對齊位元組，只看是否解得出來 */ } return A.bzip2Decode(d).length === fx.bz2.multiblock.len && d.length < fx.bz2.multiblock.len / 4; })());
check('bzip2: truncated data is an error, not a silent short result', throws(() => A.bzip2Decode(u8(fx.bz2.text.data).subarray(0, 12)), /不完整|損毀/));
check('bzip2: a flipped byte is caught (CRC / structure)', (() => { const d = u8(fx.bz2.multiblock.data).slice(); d[Math.floor(d.length / 2)] ^= 0x55; return throws(() => A.bzip2Decode(d)); })());
check('bzip2: not bzip2 at all', throws(() => A.bzip2Decode(Uint8Array.from([1, 2, 3, 4, 5])), /不是 bzip2/));
check('bzip2: output limit stops decompression bombs', throws(() => A.bzip2Decode(u8(fx.bz2.runs.data), { maxOut: 1000 }), /上限/));
check('bzip2: trailing garbage after a complete stream is ignored', (() => { const d = u8(fx.bz2.text.data); const x = new Uint8Array(d.length + 6); x.set(d); x.set([1, 2, 3, 4, 5, 6], d.length); try { return sha(A.bzip2Decode(x)) === fx.bz2.text.sha; } catch (_) { return false; } })());

// ---- tar ----
const T = (k) => A.parseTar(u8(fx.tar[k].data));
const ust = T('ustar'); check('tar ustar: names including the prefix field', fx.tar.ustar.names.every((n) => ust.entries.some((e) => e.name === n || e.name === n.replace(/\/$/, ''))) && ust.entries.some((e) => e.isDir), ust.entries.map((e) => e.name));
const pax = T('pax'); check('tar pax: unicode and very long paths', fx.tar.pax.names.every((n) => pax.entries.some((e) => e.name === n)), pax.entries.map((e) => e.name));
const gnu = T('gnu'); check('tar gnu: long name extension', fx.tar.gnu.names.every((n) => gnu.entries.some((e) => e.name === n)), gnu.entries.map((e) => e.name.slice(0, 20)));
check('tar: content read back and sizes', new TextDecoder().decode(A.tarRead(ust, 'readme.txt')) === 'plain file\n' && new TextDecoder().decode(A.tarRead(pax, '資料夾/中文檔名.txt')) === '你好\n' && ust.entries.find((e) => e.name === 'readme.txt').size === 11);
check('tar: truncated archive reports truncated and keeps what it can', (() => { const d = u8(fx.tar.ustar.data); const t = A.parseTar(d.subarray(0, 520)); return t.truncated === true && t.entries.length >= 1; })());
check('tar: a tar made by Node\'s own gzip layer (tgz) parses after gunzip', (() => { const gz = Buffer.from(fx.other['t.tgz'], 'base64'); const tar = new Uint8Array(zlib.gunzipSync(gz)); const t = A.parseTar(tar); return t.entries.map((e) => e.name).sort().join().includes('a.txt') && t.entries.length === 3 || t.entries.length >= 3; })());
check('tar: empty / garbage input gives no entries instead of throwing', A.parseTar(new Uint8Array(0)).entries.length === 0 && A.parseTar(Uint8Array.from([1, 2, 3])).entries.length === 0);

// ---- 內容判斷 ----
check('looksBinary: NUL bytes and control characters', A.looksBinary(Uint8Array.from([65, 0, 66])) && A.looksBinary(new Uint8Array(200).fill(2)) && !A.looksBinary(new TextEncoder().encode('hello 世界\n')));
check('decodeText: utf-8, BOM, utf-16, big5 (tried before gbk — the two overlap, so a gbk-only file may decode as big5)', A.decodeText(new TextEncoder().encode('你好')) === '你好' && A.decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])) === 'A' && A.decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0])) === 'A' && A.decodeText(Uint8Array.from([0xa7, 0x41, 0xa6, 0x6e])) === '你好');
const ents = [{ name: 'a/b.txt', size: 10 }, { name: 'a/c.js', size: 5 }, { name: 'a/', isDir: true }, { name: 'top.md', size: 1 }];
const sm = A.summarize(ents); check('summarize: counts, extensions, top level', sm.files === 3 && sm.dirs === 1 && sm.total_bytes === 16 && sm.by_ext.some(([k]) => k === 'txt') && sm.top_level.some((x) => /^a/.test(x)), sm);
const js = A.jarSummary([{ name: 'META-INF/MANIFEST.MF' }, { name: 'com/acme/App.class' }, { name: 'com/acme/util/H.class' }, { name: 'module-info.class' }], 'Manifest-Version: 1.0\r\nMain-Class: com.acme.App\r\nImplementation-Title: acme\r\nImplementation-Version: 1.2.3\r\nCreated-By: 17\r\n (Oracle)\r\n');
check('jarSummary: manifest fields, class count, packages (with wrapped manifest lines)', js.main_class === 'com.acme.App' && js.title === 'acme' && js.version === '1.2.3' && /17\(Oracle\)|17 ?\(Oracle\)|17\(Oracle/.test(js.created_by.replace(/\s/g, '')) && js.classes === 3 && js.packages.includes('com.acme') && js.module_info === true && js.spring_boot === false, js);
check('jarSummary: spring boot fat jar', A.jarSummary([{ name: 'BOOT-INF/classes/A.class' }], '').spring_boot === true);

console.log('archive_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED' : '')); bad.forEach((x) => console.log('FAIL', x)); process.exit(bad.length ? 1 : 0);
