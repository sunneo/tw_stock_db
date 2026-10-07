// 離線設定檔結構學習測試：node renderer/src/logmine/cfg_core.test.js
const C = require('./cfg_core.js');
const L = require('./log_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 800))); } }

const INI = `; app config
[server]
host = 0.0.0.0:8080
workers = 4
debug = false   ; 上線要關
data_dir = /var/lib/app

[database]
url = postgres://db.local:5432/app
pool_size = 10
timeout = 30s
timeout = 45s
password =

[logging]
level = info
file = C:\\logs\\app.log
`;
(() => {
    const d = C.detect(INI); check('INI：認出格式', d.ok && d.format === 'ini', d);
    const m = C.parse(INI);
    check('INI：章節與鍵值、型別', m.sections.map((s) => s.name).join() === 'server,database,logging' && C.get(m, 'server', 'workers').type === 'int' && C.get(m, 'server', 'debug').type === 'bool' && C.get(m, 'database', 'url').type === 'url' && C.get(m, 'logging', 'file').type === 'path' && C.get(m, 'server', 'host').type === 'ip', m.sections.map((s) => s.entries.map((e) => e.key + ':' + e.type)));
    check('INI：行尾註解被分開、不進值', C.get(m, 'server', 'debug').value === 'false' && /上線要關/.test(C.get(m, 'server', 'debug').comment));
    check('INI：同一章節重複的鍵被抓到、空值被抓到', m.dupKeys.length === 1 && m.dupKeys[0].key === 'timeout' && m.dupKeys[0].lines.length === 2 && C.get(m, 'database', 'password').type === 'empty', m.dupKeys);
    const sum = C.summarize(m).join('\n'); check('INI：摘要提到章節數、重複、空值', /3 個章節/.test(sum) && /重複的鍵/.test(sum) && /值是空的/.test(sum) && /布林開關/.test(sum), sum);
    check('問答：[database] 有哪些設定', /pool_size = 10/.test(C.ask(m, '[database] 有哪些設定').answer), C.ask(m, '[database] 有哪些設定'));
    check('問答：workers 設成多少', /\[server\] workers = 4/.test(C.ask(m, 'workers 設成多少').answer), C.ask(m, 'workers 設成多少'));
    check('問答：哪些是布林', /debug = false/.test(C.ask(m, '哪些是布林開關').answer));
    check('問答：重複的鍵', /timeout/.test(C.ask(m, '有沒有重複的鍵').answer));
    check('問答：有哪些章節', /server/.test(C.ask(m, '有哪些章節').answer) && /logging/.test(C.ask(m, '有哪些章節').answer));
    check('問答：開放式問題 → 交精簡脈絡不亂答', C.ask(m, '這個設定安全嗎').kind === 'open' && /\[server\]/.test(C.ask(m, '這個設定安全嗎').context));
    const ml = C.matchLine(m, 'pool_size = 20'); check('單行比對：找到鍵、現值、型別相符', ml && ml.key === 'pool_size' && ml.where[0].current === '10' && ml.typeMatches, ml);
    check('單行比對：不認得的鍵 → null', C.matchLine(m, 'unknown_key = 1') === null);
    const INI2 = INI.replace('workers = 4', 'workers = 8').replace('level = info', 'level = debug\nformat = json').replace('[logging]', '[metrics]\nenabled = true\n\n[logging]');
    const dd = C.diff(m, C.parse(INI2)); check('比較兩份：改值、新增鍵、新增章節', dd.changed.some((c) => c.key === 'workers' && c.from === '4' && c.to === '8') && dd.changed.some((c) => c.key === 'level') && dd.added.some((x) => x.key === 'format') && dd.addedSections.includes('metrics') && !dd.same, dd);
    check('比較：完全相同 → same（註解與空白不算）', C.diff(m, C.parse(INI.replace('; app config', '# 換個註解').replace(/\n\n/g, '\n\n\n'))).same === true);
    const pat = C.toTrainerPattern(m, 'appini'); check('訓練器規則：只存結構；單行鍵值命中、一般句子不命中', pat.type === 'regex' && new RegExp(pat.expr).test('pool_size = 20') && !new RegExp(pat.expr).test('請幫我設定一下 pool_size 好不好') && JSON.stringify(pat).length < 60000 && !JSON.stringify(pat.log_model).includes('postgres://db.local:5432/app') === false, pat.expr && pat.expr.slice(0, 100));
    const back = C.fromSlim(JSON.parse(JSON.stringify(pat.log_model))); check('還原後仍能問答與比較', /pool_size = 10/.test(C.ask(back, '[database] 有哪些設定').answer) && C.diff(m, back).same);
})();

const TOML = `# 專案設定
title = "My App"
version = "1.2.3"

[owner]
name = "Tom"
dob = 1979-05-27T07:32:00Z

[database]
enabled = true
ports = [ 8000, 8001, 8002 ]
data = { host = "x", port = 5 }

[[products]]
name = "Hammer"
sku = 738594937

[[products]]
name = "Nail"
sku = 284758393
`;
(() => {
    const d = C.detect(TOML); check('TOML：認出格式（含 [[陣列]]）', d.ok && d.format === 'toml', d);
    const m = C.parse(TOML);
    check('TOML：最上層鍵＋章節；重複的 [[products]] 不算重複鍵', m.sections[0].name === '' && C.get(m, '', 'title').type === 'string' && m.dupKeys.length === 0 && m.sections.filter((s) => s.name === 'products' && s.tomlArray).length === 2, { s: m.sections.map((s) => s.name), d: m.dupKeys });
    check('TOML：型別（日期、陣列、內嵌表、布林）', C.get(m, 'owner', 'dob').type === 'datetime' && C.get(m, 'database', 'ports').type === 'array' && C.get(m, 'database', 'data').type === 'table' && C.get(m, 'database', 'enabled').type === 'bool', m.sections.map((s) => s.entries.map((e) => e.key + ':' + e.type)));
    check('TOML：比較時 [[products]] 依序對應，改第二個的值能看出', C.diff(m, C.parse(TOML.replace('Nail', 'Screw'))).changed.some((c) => c.from === '"Nail"' && c.to === '"Screw"'));
})();

const INF = `## @file
#  Sample driver
[Defines]
  INF_VERSION                    = 0x00010005
  BASE_NAME                      = MyDriver
  FILE_GUID                      = 8c8ce578-8a3d-4f1c-9935-896185c32dd3
  MODULE_TYPE                    = DXE_DRIVER
  ENTRY_POINT                    = MyDriverEntry

[Sources]
  MyDriver.c
  MyDriver.h

[Sources.X64]
  X64/Asm.nasm

[Packages]
  MdePkg/MdePkg.dec
  MdeModulePkg/MdeModulePkg.dec

[LibraryClasses]
  UefiDriverEntryPoint
  DebugLib

[Protocols]
  gEfiPciIoProtocolGuid                         ## CONSUMES

[Pcd]
  gEfiMdePkgTokenSpaceGuid.PcdDebugPropertyMask
`;
(() => {
    const d = C.detect(INF); check('EDK2 INF：認出格式', d.ok && d.format === 'edk2_inf', d);
    const m = C.parse(INF);
    check('EDK2 INF：[Defines] 的鍵值、GUID／十六進位型別', C.get(m, 'Defines', 'BASE_NAME').value === 'MyDriver' && C.get(m, 'Defines', 'INF_VERSION').type === 'hex' && C.get(m, 'Defines', 'FILE_GUID').type === 'guid' && m.guids.length === 1, m.sections[0].entries.map((e) => e.key + ':' + e.type));
    check('EDK2 INF：沒有鍵的行是條目（檔案清單）；[Sources.X64] 拆出架構', m.sections.find((s) => s.name === 'Sources').entries.length === 2 && m.sections.find((s) => s.name === 'Sources').entries[0].kind === 'item' && m.sections.find((s) => s.name === 'Sources.X64').parts[0].qual[0] === 'X64');
    const sum = C.summarize(m).join('\n'); check('EDK2 INF：摘要含模組名稱、GUID、類型、原始檔數', /BASE_NAME＝MyDriver/.test(sum) && /MODULE_TYPE＝DXE_DRIVER/.test(sum) && /原始檔：3 個/.test(sum), sum);
    check('問答：有哪些原始檔（含架構）', /3 個原始檔/.test(C.ask(m, 'Sources 有哪些原始檔').answer) && /X64\/Asm\.nasm（X64）/.test(C.ask(m, 'Sources 有哪些原始檔').answer), C.ask(m, 'Sources 有哪些原始檔'));
    check('問答：FILE_GUID 是多少', /8c8ce578/.test(C.ask(m, 'FILE_GUID 是多少').answer));
    check('註解（## 行尾與整行）不被當成條目', !m.sections.some((s) => s.entries.some((e) => /CONSUMES|Sample driver/.test(String(e.value)))) && m.sections.find((s) => s.name === 'Protocols').entries[0].comment === 'CONSUMES', m.sections.find((s) => s.name === 'Protocols').entries);
})();

const DSC = `[Defines]
  PLATFORM_NAME                  = MyPlatform
  PLATFORM_GUID                  = 11111111-2222-3333-4444-555555555555
  DSC_SPECIFICATION              = 0x00010005
  OUTPUT_DIRECTORY               = Build/MyPlatform
  SUPPORTED_ARCHITECTURES        = IA32|X64
  BUILD_TARGETS                  = DEBUG|RELEASE
  DEFINE SECURE_BOOT_ENABLE      = TRUE

!include MdePkg/MdeLibs.dsc.inc

[LibraryClasses]
  BaseLib|MdePkg/Library/BaseLib/BaseLib.inf
  DebugLib|MdePkg/Library/BaseDebugLibNull/BaseDebugLibNull.inf

[PcdsFixedAtBuild]
  gEfiMdePkgTokenSpaceGuid.PcdDebugPropertyMask|0x2f
  gEfiMdePkgTokenSpaceGuid.PcdMaximumUnicodeStringLength|1000000|UINT32|0x00000003

[Components]
  MdeModulePkg/Universal/Variable/RuntimeDxe/VariableRuntimeDxe.inf {
`;
(() => {
    const d = C.detect(DSC); check('EDK2 DSC：認出格式', d.ok && d.format === 'edk2_dsc', d);
    const m = C.parse(DSC);
    check('DSC：LibraryClasses 用 | 分隔變成鍵值；PCD 同理', C.get(m, 'LibraryClasses', 'BaseLib').value === 'MdePkg/Library/BaseLib/BaseLib.inf' && C.get(m, 'PcdsFixedAtBuild', 'gEfiMdePkgTokenSpaceGuid.PcdDebugPropertyMask').value === '0x2f', m.sections.map((s) => s.entries.map((e) => e.key)));
    check('DSC：DEFINE 與 !include 被識別', m.defines.SECURE_BOOT_ENABLE === 'TRUE' && m.directives.some((x) => x.name === 'include' && /MdeLibs/.test(x.arg)));
    check('DSC：摘要含平台名稱與 PCD 數', /PLATFORM_NAME＝MyPlatform/.test(C.summarize(m).join('\n')) && /PCD 設定：2 個/.test(C.summarize(m).join('\n')), C.summarize(m));
})();

const DEC = `[Defines]
  DEC_SPECIFICATION              = 0x00010005
  PACKAGE_NAME                   = MyPkg
  PACKAGE_GUID                   = aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
  PACKAGE_VERSION                = 0.1

[Guids]
  gMyTokenSpaceGuid  = { 0x12345678, 0x1234, 0x1234, { 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0 }}

[PcdsFixedAtBuild]
  gMyTokenSpaceGuid.PcdFoo|0x1|UINT32|0x00000001
`;
(() => { const d = C.detect(DEC); check('EDK2 DEC：認出格式', d.ok && d.format === 'edk2_dec', d); const m = C.parse(DEC); check('DEC：套件名稱、Guids 的鍵值', C.get(m, 'Defines', 'PACKAGE_NAME').value === 'MyPkg' && C.get(m, 'Guids', 'gMyTokenSpaceGuid') && /套件：PACKAGE_NAME＝MyPkg/.test(C.summarize(m).join('\n'))); })();

// 機密不外流：密碼、金鑰、網址裡的帳密，在存檔、問答結果、給模型的脈絡裡都被遮掉
(() => {
    const m = C.parse('[db]\nuser = admin\npassword = hunter2\napi_key = sk-LIVE-12345\nurl = postgres://admin:hunter2@db.local/app\nhost = db.local\n');
    const all = [C.ask(m, 'password 是多少').answer, C.ask(m, '[db] 有哪些設定').answer, C.ask(m, '這個設定安全嗎').context, C.summarize(m).join('\n'), JSON.stringify(C.toTrainerPattern(m, 'x')), C.describeDiff(C.diff(m, C.parse('[db]\nuser = admin\npassword = other\n'))).join('\n')].join('\n');
    check('機密：password／api_key／網址帳密不出現在任何輸出', !/hunter2|sk-LIVE-12345/.test(all) && /已遮蔽/.test(all), all.slice(0, 400));
    const stored = C.fromSlim(JSON.parse(JSON.stringify(C.toTrainerPattern(m, 'x').log_model)));
    check('存起來（已遮蔽）的版本跟原檔比較：不會假裝機密欄位有差異', C.diff(stored, m).same === true, C.diff(stored, m));
    check('兩份真實檔案的機密值不同：只說「有變」，不顯示內容', (() => { const d = C.diff(m, C.parse('[db]\nuser = admin\npassword = other\napi_key = sk-LIVE-12345\nurl = postgres://admin:hunter2@db.local/app\nhost = db.local\n')); const s = C.describeDiff(d).join('\n'); return d.changed.length === 1 && d.changed[0].secret && /機密值有變/.test(s) && !/other|hunter2/.test(s); })());
    check('機密：一般欄位照常顯示', /host = db\.local/.test(C.ask(m, '[db] 有哪些設定').answer));
})();

// 不是設定檔就說不是
(() => {
    const log = Array.from({ length: 30 }, (_, i) => `2026-10-07 12:00:${String(i).padStart(2, '0')} INFO request ${i} took ${i * 3} ms`).join('\n');
    check('日誌不會被當成設定檔', C.detect(log).ok === false, C.detect(log));
    const kvLog = Array.from({ length: 30 }, (_, i) => `ts=2026-10-07T10:00:${String(i).padStart(2, '0')}Z level=info order_id=${i} user=u${i % 3}`).join('\n');
    check('key=value 日誌（重複的鍵）不會被當成設定檔', C.detect(kvLog).ok === false, C.detect(kvLog));
    check('二進位被拒絕', C.detect(String.fromCharCode(...Array.from({ length: 4000 }, (_, i) => (i * 7) % 31))).kind === 'binary');
    check('散文被拒絕', C.detect('這是一段普通的文字。\n沒有任何章節。\n也沒有鍵值。\n只是句子而已。').ok === false);
    const flat = 'HOST=localhost\nPORT=5432\nDEBUG=true\nSECRET_KEY=abc123\nREGION=tw\n'; const fd = C.detect(flat); check('沒有章節的 key=value（.env 類）→ flat', fd.ok && fd.format === 'flat', fd);
    check('日誌格式學習不受影響：同一份日誌 FaLog 仍能學', L.mine(log).ok === true);
})();

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
