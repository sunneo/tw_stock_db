/*
 * 文件撰寫器核心（/user-guide、/design-guide）：把一包原始檔「掃描 → 取出事實 → 比對架構 → 選範本 → 組成文件模型 → 驗證」。
 * 純函式，不碰檔案系統、網路、DOM；來源檔由呼叫端讀好交進來（桌面版與網頁版共用）。
 *
 *   parseOptions(argsText)                    斜線指令的參數（fap:／wiki:／format:／template:／lang:／level:／analysis／nokb／noai／version:）
 *   analyze(files, opts)                      files = [{path, text}] → 事實（透鏡：build／entry／cli／config／routes／data／hardware／special／deps）
 *   matchArchitecture(facts)                  加權訊號比對，回 [{id, label, score, reasons}]
 *   selectTemplate(kind, facts, opts)         範本選擇：分數 ≥28 且贏過通用（20）才用專用的；使用者指定或自訂範本優先
 *   build(kind, facts, template, opts)        → { doc, steps }（steps＝程式寫的過程敘述，不是給 AI 看的）
 *   verify(doc, facts)                        每個 path:line 引用都要真的有那個檔案；回 issues
 *   rewritePlan(doc) / acceptRewrite(a, b)    給「線上模型潤飾」用：只動說明段落，並檢查識別字、路徑、數字有沒有被改掉
 *
 * 每個事實都帶證據 path:line，文件裡寫成「（見 path:line）」。找不到的東西不編，寫進「待確認」。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDocgen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMATS = ['md', 'mediawiki', 'html', 'pdf', 'docx'];
  var LEVELS = { brief: 8, standard: 25, detailed: 60 };

  // ───── 指令參數 ─────
  function parseOptions(argsText) {
    var s = String(argsText || ''), o = { fap: '', wiki: [], format: ['md'], template: '', lang: 'zh-TW', level: 'standard', analysis: false, nokb: false, noai: false, version: '', rest: '', unknown: [] };
    var rest = [], re = /(?:^|\s)([a-z]+):(?:"([^"]*)"|'([^']*)'|(\S+))|(?:^|\s)(analysis|nokb|noai)(?=\s|$)/gi, last = 0, m;
    while ((m = re.exec(s))) {
      rest.push(s.slice(last, m.index)); last = m.index + m[0].length;
      if (m[5]) { o[m[5].toLowerCase()] = true; continue; }
      var k = m[1].toLowerCase(), v = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
      if (k === 'fap') o.fap = v; else if (k === 'wiki') o.wiki = v.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      else if (k === 'format') { var f = v.toLowerCase().split(',').map(function (x) { x = x.trim(); return x === 'wiki' ? 'mediawiki' : x === 'markdown' ? 'md' : x; }).filter(function (x) { return FORMATS.indexOf(x) >= 0; }); if (f.length) o.format = f.filter(function (x, i) { return f.indexOf(x) === i; }); else o.unknown.push('format:' + v); }
      else if (k === 'template') o.template = v; else if (k === 'lang') o.lang = /^en/i.test(v) ? 'en' : 'zh-TW';
      else if (k === 'level') { if (LEVELS[v.toLowerCase()]) o.level = v.toLowerCase(); else o.unknown.push('level:' + v); }
      else if (k === 'version') o.version = v.slice(0, 40); else if (k === 'publish') o.unknown.push('publish:（桌面版與網頁版不發佈到 wiki；用檔案卡片取回）');
      else o.rest += ' ' + m[0].trim();
    }
    rest.push(s.slice(last)); o.rest = (rest.join(' ') + ' ' + o.rest).replace(/\s+/g, ' ').trim();
    return o;
  }

  // ───── 檔案分類 ─────
  var LANG = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', c: 'C', h: 'C/C++ 標頭', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++ 標頭', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', rb: 'Ruby', php: 'PHP', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', lua: 'Lua', swift: 'Swift', html: 'HTML', css: 'CSS', sql: 'SQL', proto: 'Protobuf', yaml: 'YAML', yml: 'YAML', json: 'JSON', toml: 'TOML', ini: 'INI', md: 'Markdown', bb: 'BitBake', bbappend: 'BitBake', inf: 'EDK2 INF', dec: 'EDK2 DEC', dsc: 'EDK2 DSC', s: '組合語言', ld: '連結腳本', service: 'systemd', cmake: 'CMake', gradle: 'Gradle' };
  var SOURCE_LANG = /^(JavaScript|TypeScript|Python|C|C\+\+|C\/C\+\+ 標頭|C\+\+ 標頭|Go|Rust|Java|Kotlin|C#|Ruby|PHP|Shell|PowerShell|Lua|Swift|組合語言)$/;
  function extOf(p) { var b = String(p).split('/').pop(); var i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; }
  function baseOf(p) { return String(p).split('/').pop(); }
  function langOf(p) { var b = baseOf(p).toLowerCase(); if (b === 'makefile' || b === 'gnumakefile') return 'Makefile'; if (b === 'dockerfile' || /^dockerfile\./.test(b)) return 'Dockerfile'; if (b === 'cmakelists.txt') return 'CMake'; return LANG[extOf(p)] || ''; }
  function isTest(p) { return /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|[._-](test|spec)\.[a-z]+$|^test_.*\.py$/i.test(p); }
  function isVendor(p) { return /(^|\/)(node_modules|vendor|third_party|3rdparty|dist|build|out|\.git|__pycache__|\.venv|venv|target|bower_components)(\/|$)/.test(p); }
  function lineOf(text, index) { var n = 1; for (var i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }
  function uniqBy(a, f) { var seen = {}, o = []; a.forEach(function (x) { var k = f(x); if (!seen[k]) { seen[k] = 1; o.push(x); } }); return o; }

  function helpOf(line) { var h = /help\s*=\s*['"]([^'"]*)['"]/.exec(line); return h ? h[1] : ''; }
  // ───── 透鏡：逐行規則（每筆都帶 path:line 證據）─────
  // [透鏡, 路徑條件, 行規則, (m, line) → {name, detail}]
  var LINE_RULES = [
    ['entry', /\.(c|cc|cpp|cxx)$/, /^\s*(?:int|void)\s+main\s*\(/, function () { return { name: 'main()', detail: 'C／C++ 程式進入點' }; }],
    ['entry', /\.go$/, /^\s*func\s+main\s*\(\s*\)/, function () { return { name: 'main()', detail: 'Go 程式進入點' }; }],
    ['entry', /\.java$/, /public\s+static\s+void\s+main\s*\(/, function () { return { name: 'main()', detail: 'Java 程式進入點' }; }],
    ['entry', /\.py$/, /^if\s+__name__\s*==\s*['"]__main__['"]/, function () { return { name: '__main__', detail: 'Python 腳本進入點' }; }],
    ['entry', /\.rs$/, /^\s*fn\s+main\s*\(\s*\)/, function () { return { name: 'main()', detail: 'Rust 程式進入點' }; }],
    ['entry', /\.(js|mjs|cjs|ts)$/, /new\s+BrowserWindow\s*\(/, function () { return { name: 'BrowserWindow', detail: 'Electron 主視窗建立處' }; }],
    ['entry', /\.(js|mjs|cjs|ts)$/, /\b(?:app|server)\.listen\s*\(\s*([^,)]*)/, function (m) { return { name: 'listen(' + m[1].trim().slice(0, 30) + ')', detail: '網路服務開始接受連線' }; }],
    ['entry', /\.service$/, /^\s*ExecStart\s*=\s*(.+)$/, function (m) { return { name: 'ExecStart', detail: m[1].trim().slice(0, 80) }; }],
    ['entry', /(^|\/)Dockerfile[^/]*$/, /^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/i, function (m) { return { name: 'Docker 啟動命令', detail: m[1].trim().slice(0, 80) }; }],
    ['cli', /\.py$/, /add_argument\(\s*['"](-{1,2}[\w-]+)['"](?:\s*,\s*['"](-{1,2}[\w-]+)['"])?/, function (m, line) { return { name: m[1] + (m[2] ? ', ' + m[2] : ''), detail: helpOf(line) }; }],
    ['cli', /\.py$/, /click\.option\(\s*['"](-{1,2}[\w-]+)['"](?:\s*,\s*['"](-{1,2}[\w-]+)['"])?/, function (m, line) { return { name: m[1] + (m[2] ? ', ' + m[2] : ''), detail: helpOf(line) }; }],
    ['cli', /\.(js|mjs|cjs|ts)$/, /\.(?:option|requiredOption)\(\s*['"`](-[^'"`]+)['"`](?:\s*,\s*['"`]([^'"`]*)['"`])?/, function (m) { return { name: m[1].trim(), detail: m[2] || '' }; }],
    ['cli', /\.go$/, /flag\.(String|Int|Bool|Duration|Float64)\(\s*"([\w-]+)"\s*,\s*[^,]+,\s*"([^"]*)"/, function (m) { return { name: '-' + m[2], detail: m[3] + '（' + m[1].toLowerCase() + '）' }; }],
    ['cli', /\.(c|cc|cpp|cxx|h)$/, /^\s*\{\s*"([\w-]{2,})"\s*,\s*(?:no_argument|required_argument|optional_argument)/, function (m) { return { name: '--' + m[1], detail: 'getopt_long 長選項' }; }],
    ['cli', /\.(sh|bash)$/, /^\s*(--?[\w-]+)(?:\|(--?[\w-]+))?\)\s*$/, function (m) { return { name: m[1] + (m[2] ? ', ' + m[2] : ''), detail: 'Shell case 分支' }; }],
    ['config', /\.(js|mjs|cjs|ts|jsx|tsx)$/, /process\.env\.([A-Z][A-Z0-9_]{2,})/, function (m) { return { name: m[1], detail: '環境變數' }; }],
    ['config', /\.py$/, /os\.(?:environ(?:\.get)?\s*[\[(]|getenv\s*\()\s*['"]([A-Za-z][\w]{2,})['"]/, function (m) { return { name: m[1], detail: '環境變數' }; }],
    ['config', /\.(c|cc|cpp|cxx|go)$/, /(?:getenv|Getenv)\s*\(\s*"([A-Za-z][\w]{2,})"/, function (m) { return { name: m[1], detail: '環境變數' }; }],
    ['config', /(^|\/)\.env[^/]*$/, /^\s*([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/, function (m) { return { name: m[1], detail: '.env 設定（預設值：' + (/(KEY|SECRET|TOKEN|PASSWORD)/.test(m[1]) ? '（已隱藏）' : m[2].trim().slice(0, 30) || '空') + '）' }; }],
    ['routes', /\.(js|mjs|cjs|ts)$/, /\b(app|router|server|api)\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/, function (m) { return { name: m[2].toUpperCase() + ' ' + m[3], detail: 'HTTP 路由' }; }],
    ['routes', /\.py$/, /@(?:\w+)\.route\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/, function (m) { return { name: (m[2] ? m[2].replace(/['"\s]/g, '').toUpperCase() : 'GET') + ' ' + m[1], detail: 'Flask 路由' }; }],
    ['routes', /\.py$/, /@(?:app|router|\w+)\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/, function (m) { return { name: m[1].toUpperCase() + ' ' + m[2], detail: 'FastAPI 路由' }; }],
    ['routes', /\.(java|kt)$/, /@(Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*)?\{?\s*"([^"]*)"/, function (m) { return { name: m[1].toUpperCase() + ' ' + m[2], detail: 'Spring 路由' }; }],
    ['routes', /\.go$/, /(?:HandleFunc|Handle|GET|POST|PUT|DELETE)\(\s*"([^"]+)"/, function (m) { return { name: m[1], detail: 'Go HTTP 路由' }; }],
    ['routes', /\.(c|cc|cpp|cxx|js|ts|py|json|go)$/, /(\/redfish\/v1[\w\/{}.$-]*)/, function (m) { return { name: m[1].slice(0, 80), detail: 'Redfish 資源路徑' }; }],
    ['routes', /\.(c|cc|cpp|cxx|h|hpp|py|js)$/, /["'](xyz\.openbmc_project\.[A-Za-z0-9_.]+|org\.freedesktop\.[A-Za-z0-9_.]+)["']/, function (m) { return { name: m[1], detail: 'D-Bus 介面／服務名稱' }; }],
    ['routes', /\.proto$/, /^\s*rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?(\w+)\s*\)/, function (m) { return { name: m[1], detail: 'gRPC：' + m[2] + ' → ' + m[3] }; }],
    ['routes', /\.(js|ts|py|go|java)$/, /\.subscribe\(\s*['"`]([\w\/+#.${}-]+)['"`]/, function (m) { return { name: m[1], detail: '訂閱主題（MQTT／訊息佇列）' }; }],
    ['data', /\.sql$|\.(py|js|ts|sh|java|go)$/, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?(\w+)/i, function (m) { return { name: m[1], detail: 'SQL 資料表' }; }],
    ['data', /\.py$/, /^class\s+(\w+)\(\s*(?:db\.Model|Base|models\.Model|SQLModel|BaseModel)\b/, function (m) { return { name: m[1], detail: 'ORM／資料模型類別' }; }],
    ['data', /\.(js|ts)$/, /mongoose\.model\(\s*['"](\w+)['"]/, function (m) { return { name: m[1], detail: 'Mongoose 模型' }; }],
    ['data', /\.proto$/, /^\s*message\s+(\w+)\s*\{/, function (m) { return { name: m[1], detail: 'Protobuf 訊息' }; }],
    ['data', /\.(ts|tsx)$/, /^export\s+(?:interface|type)\s+(\w+)/, function (m) { return { name: m[1], detail: 'TypeScript 型別' }; }],
    ['hardware', /\.(c|cc|cpp|cxx|h|hpp|py|go|rs|sh)$/, /["'](\/dev\/[\w\/%d.-]+|\/sys\/[\w\/.%d-]+)["']/, function (m) { return { name: m[1], detail: '裝置／sysfs 路徑' }; }],
    ['hardware', /\.(c|cc|cpp|cxx|h|hpp)$/, /\b(ioctl|mmap|i2c_smbus_\w+|spi_sync|gpio_\w+|request_irq)\s*\(/, function (m) { return { name: m[1] + '()', detail: '硬體／核心介面呼叫' }; }],
    ['special', /\.(c|cc|cpp|h)$/, /xTaskCreate(?:Static)?\s*\(\s*(\w+)\s*,\s*"([^"]*)"\s*,\s*[^,]+,\s*[^,]+,\s*([^,]+)/, function (m) { return { group: 'RTOS 任務', name: m[2] || m[1], detail: '函式 ' + m[1] + '，優先權 ' + m[3].trim() }; }],
    ['special', /\.(c|cc|cpp|h)$/, /K_THREAD_DEFINE\s*\(\s*\w+\s*,\s*[^,]+,\s*(\w+)\s*,[^,]+,[^,]+,[^,]+,\s*(\d+)/, function (m) { return { group: 'RTOS 任務', name: m[1], detail: 'Zephyr 執行緒，優先權 ' + m[2] }; }],
    ['special', /\.(c|cc)$/, /module_param\(\s*(\w+)\s*,\s*(\w+)/, function (m) { return { group: '模組參數', name: m[1], detail: '型別 ' + m[2] }; }],
    ['special', /\.(c|cc)$/, /\.(open|read|write|unlocked_ioctl|release|mmap|poll)\s*=\s*(\w+)/, function (m) { return { group: 'file_operations 處理函式', name: m[1], detail: m[2] }; }],
    ['special', /\.inf$/, /^\s*(BASE_NAME|MODULE_TYPE|ENTRY_POINT)\s*=\s*(\S+)/, function (m) { return { group: 'EDK2 模組定義', name: m[1], detail: m[2] }; }],
    ['special', /\.(js|ts|mjs)$/, /ipcMain\.(?:handle|on)\(\s*['"`]([^'"`]+)['"`]/, function (m) { return { group: 'IPC 頻道', name: m[1], detail: '主行程處理的訊息' }; }],
    ['special', /\.(js|ts|mjs|cjs)$/, /\.command\(\s*['"`]([^'"`\s<\[]+)/, function (m) { return { group: '子命令', name: m[1], detail: '命令列子命令' }; }],
    ['special', /\.py$/, /add_parser\(\s*['"]([\w-]+)['"]/, function (m) { return { group: '子命令', name: m[1], detail: '命令列子命令' }; }],
    ['special', /\.(js|ts|py|go)$/, /(?:registerPlugin|register_plugin|loadPlugin|plugins\.register)\(\s*['"`]?([\w.-]+)/, function (m) { return { group: '外掛', name: m[1], detail: '外掛註冊處' }; }]
  ];

  // ───── 整檔規則（建置檔、設定檔）─────
  function jsonSafe(t) { try { return JSON.parse(t); } catch (_) { return null; } }
  function scanBuildFile(f, out) {
    var b = baseOf(f.path), t = f.text, ev = function (i) { return f.path + ':' + (i || 1); };
    if (b === 'package.json' && !isVendor(f.path)) {
      var j = jsonSafe(t); if (!j) return;
      var at = function (key) { var i = t.indexOf('"' + key + '"'); return i < 0 ? 1 : lineOf(t, i); };
      if (j.name) out.build.push({ name: '套件', detail: j.name + (j.version ? ' ' + j.version : ''), ev: ev(at('name')) });
      if (j.main) out.entry.push({ name: 'main', detail: String(j.main), ev: ev(at('main')) });
      if (j.bin) out.entry.push({ name: 'bin', detail: typeof j.bin === 'string' ? j.bin : Object.keys(j.bin).join('、'), ev: ev(at('bin')) });
      Object.keys(j.scripts || {}).slice(0, 30).forEach(function (k) { out.build.push({ name: 'npm run ' + k, detail: String(j.scripts[k]).slice(0, 100), ev: ev(at(k)) }); });
      ['dependencies', 'devDependencies'].forEach(function (g) { Object.keys(j[g] || {}).slice(0, 60).forEach(function (k) { out.deps.push({ name: k, detail: j[g][k] + (g === 'devDependencies' ? '（開發用）' : ''), ev: ev(at(k)) }); }); });
    } else if (/^requirements[\w.-]*\.txt$/.test(b)) {
      t.split('\n').forEach(function (l, i) { var m = /^\s*([A-Za-z0-9_.-]+)\s*([<>=!~]=?.*)?$/.exec(l); if (m && !/^#/.test(l)) out.deps.push({ name: m[1], detail: (m[2] || '').trim() || '（未指定版本）', ev: ev(i + 1) }); });
    } else if (b === 'go.mod') {
      t.split('\n').forEach(function (l, i) { var m = /^\s*(?:require\s+)?([\w.\/-]+\.[\w.\/-]+)\s+(v[\w.+-]+)/.exec(l); if (m) out.deps.push({ name: m[1], detail: m[2], ev: ev(i + 1) }); });
    } else if (b === 'Cargo.toml') {
      var sec = ''; t.split('\n').forEach(function (l, i) { var h = /^\[([^\]]+)\]/.exec(l); if (h) { sec = h[1]; return; } var m = /^([\w-]+)\s*=\s*(.+)$/.exec(l); if (m && /dependencies/.test(sec)) out.deps.push({ name: m[1], detail: m[2].slice(0, 40), ev: ev(i + 1) }); });
    } else if (b === 'CMakeLists.txt') {
      t.split('\n').forEach(function (l, i) { var m = /^\s*(project|add_executable|add_library|find_package|add_subdirectory)\s*\(\s*([\w.${}-]+)/i.exec(l); if (m) (/find_package/i.test(m[1]) ? out.deps : out.build).push({ name: m[1].toLowerCase(), detail: m[2], ev: ev(i + 1) }); });
    } else if (/^(GNU)?[Mm]akefile$/.test(b)) {
      t.split('\n').forEach(function (l, i) { var m = /^([A-Za-z][\w.-]*)\s*:(?!=)/.exec(l); if (m && out.build.length < 400) out.build.push({ name: 'make ' + m[1], detail: '', ev: ev(i + 1) }); });
    } else if (/^Dockerfile/.test(b)) {
      t.split('\n').forEach(function (l, i) { var m = /^\s*(FROM|EXPOSE|WORKDIR|ENV)\s+(.+)$/i.exec(l); if (m) out.build.push({ name: m[1].toUpperCase(), detail: m[2].trim().slice(0, 80), ev: ev(i + 1) }); });
    } else if (/\.(bb|bbappend)$/.test(b)) {
      t.split('\n').forEach(function (l, i) { var m = /^\s*(SUMMARY|DESCRIPTION|LICENSE|DEPENDS|inherit|SRC_URI)\b\s*[:+?]*=?\s*(.*)$/.exec(l); if (m) out.build.push({ name: 'BitBake ' + m[1], detail: m[2].replace(/["\\]/g, '').trim().slice(0, 80), ev: ev(i + 1) }); });
    } else if (/(^|\/)docker-compose[\w.-]*\.ya?ml$/.test(f.path)) {
      var inSvc = false; t.split('\n').forEach(function (l, i) { if (/^services\s*:/.test(l)) { inSvc = true; return; } if (inSvc && /^\S/.test(l)) inSvc = false; var m = /^  ([\w-]+)\s*:\s*$/.exec(l); if (inSvc && m) out.build.push({ name: 'compose 服務', detail: m[1], ev: ev(i + 1) }); });
    } else if (/\.service$/.test(b)) {
      t.split('\n').forEach(function (l, i) { var m = /^\s*(Description|After|Requires|User|Restart)\s*=\s*(.+)$/.exec(l); if (m) out.build.push({ name: 'systemd ' + m[1], detail: m[2].trim().slice(0, 80), ev: ev(i + 1) }); });
    }
    if (/(^|\/)(config|settings|conf)[\w.-]*\.(json|ya?ml|toml|ini|conf|cfg)$/i.test(f.path) && !isVendor(f.path) && !/package(-lock)?\.json$/.test(b)) {
      var keys = [];
      if (/\.json$/i.test(b)) { var cj = jsonSafe(t); if (cj && typeof cj === 'object' && !Array.isArray(cj)) Object.keys(cj).slice(0, 40).forEach(function (k) { keys.push([k, lineOf(t, Math.max(0, t.indexOf('"' + k + '"')))]); }); }
      else t.split('\n').forEach(function (l, i) { var m = /^([A-Za-z_][\w.-]*)\s*[:=]\s*(.*)$/.exec(l); if (m && !/^\s*#/.test(l)) keys.push([m[1], i + 1]); });
      keys.slice(0, 40).forEach(function (k) { out.config.push({ name: k[0], detail: '設定檔 ' + b + ' 的欄位', ev: ev(k[1]) }); });
    }
  }

  // ───── 架構訊號（加權）─────
  // 每個訊號：[說明, 比對路徑或內容, 權重]；內容訊號只要某個檔案出現一次就算；同一個架構的分數上限 100
  var ARCH = [
    { id: 'openbmc', label: 'OpenBMC／BMC 韌體', sig: [['BitBake 配方（.bb／.bbappend）', 'path', /\.(bb|bbappend)$/, 30], ['sdbusplus', 'text', /sdbusplus/, 25], ['xyz.openbmc_project 介面', 'text', /xyz\.openbmc_project/, 25], ['phosphor- 套件', 'text', /phosphor-[a-z-]+/, 15], ['bmcweb／Redfish', 'text', /bmcweb|\/redfish\/v1/, 15]] },
    { id: 'rtos', label: '即時作業系統（RTOS）韌體', sig: [['FreeRTOS 任務', 'text', /xTaskCreate|vTaskDelay|FreeRTOS\.h/, 30], ['Zephyr 執行緒', 'text', /K_THREAD_DEFINE|k_thread_create|<zephyr\//, 30], ['ThreadX／CMSIS-RTOS', 'text', /tx_thread_create|osThreadNew|cmsis_os/, 28], ['連結腳本（.ld）', 'path', /\.ld$/, 12], ['啟動組語（startup_*.s）', 'path', /startup_[\w]+\.s$/i, 15], ['STM32 HAL', 'text', /HAL_[A-Z]\w+\(|stm32\w*xx/i, 10]] },
    { id: 'bios', label: 'BIOS／UEFI 韌體', sig: [['EFI 狀態與服務', 'text', /EFI_STATUS|gBS->|UefiBootServicesTableLib/, 30], ['EDK2 模組檔（.inf／.dec／.dsc）', 'path', /\.(inf|dec|dsc)$/, 22], ['EDK2／PCD', 'text', /PcdGet|edk2|EDK2/, 15], ['coreboot', 'text', /coreboot|romstage|ramstage/, 30]] },
    { id: 'kernel-driver', label: 'Linux 核心驅動', sig: [['module_init／MODULE_LICENSE', 'text', /module_init|module_exit|MODULE_LICENSE/, 35], ['linux/module.h', 'text', /<linux\/module\.h>/, 25], ['platform_driver／of_match_table', 'text', /platform_driver|of_match_table/, 20], ['字元裝置註冊', 'text', /file_operations|cdev_add|misc_register/, 20], ['Kconfig／Kbuild', 'path', /(^|\/)(Kconfig|Kbuild)$/, 10]] },
    { id: 'cgi', label: 'CGI／FastCGI 程式', sig: [['cgi-bin 目錄', 'path', /(^|\/)cgi-bin(\/|$)/, 30], ['CGI 環境變數', 'text', /QUERY_STRING|REQUEST_METHOD|CONTENT_LENGTH/, 25], ['Python cgi 模組', 'text', /import cgi|cgitb/, 25], ['FastCGI', 'text', /FCGI_Accept|fcgi_stdio/, 25]] },
    { id: 'web-service', label: '網路服務／Web API', sig: [['Express／Koa', 'text', /require\(['"](?:express|koa)['"]\)|from ['"](?:express|koa)['"]/, 30], ['Flask／FastAPI／Django', 'text', /from flask|import flask|FastAPI\(|django\.urls/, 30], ['Spring', 'text', /@RestController|@SpringBootApplication/, 30], ['Go net/http', 'text', /"net\/http"|gin-gonic/, 24], ['listen 開埠', 'text', /\.listen\s*\(|ListenAndServe/, 12], ['Dockerfile EXPOSE', 'text', /^\s*EXPOSE\s+\d+/m, 10]] },
    { id: 'system-service', label: '系統服務（常駐程式）', sig: [['systemd 單元（.service）', 'path', /\.service$/, 22], ['[Service]／ExecStart', 'text', /^\[Service\]|^\s*ExecStart\s*=/m, 25], ['sd_notify／sd_bus／sd_event', 'text', /sd_notify|sd_bus_|sd_event_/, 25], ['daemon 化', 'text', /\bdaemon\s*\(|\bsetsid\s*\(/, 20], ['訊號處理', 'text', /sigaction\s*\(|\bsignal\s*\(\s*SIG/, 8]] },
    { id: 'gui', label: '桌面／圖形介面應用程式', sig: [['Electron', 'text', /BrowserWindow|ipcMain|ipcRenderer/, 50], ['Qt', 'text', /QApplication|QWidget|QML|QMainWindow/, 30], ['Tkinter／wx／GTK', 'text', /import tkinter|from tkinter|wx\.App|wxFrame|GtkWindow|gtk_init/, 26], ['WinForms／WPF', 'text', /System\.Windows\.Forms|\.xaml/, 26], ['SwiftUI／UIKit', 'text', /SwiftUI|UIKit|NSWindow/, 26], ['React／Vue 介面', 'text', /ReactDOM|createRoot\(|createApp\(/, 14]] },
    { id: 'distributed', label: '分散式系統', sig: [['gRPC／Protobuf 服務', 'text', /^\s*service\s+\w+\s*\{/m, 22], ['訊息佇列', 'text', /kafka|rabbitmq|amqp|nats\.|zeromq|\bzmq\b/i, 24], ['共識／協調', 'text', /\braft\b|paxos|etcd|zookeeper|consul/i, 26], ['Kubernetes／Helm', 'text', /kind:\s*(Deployment|StatefulSet)|helm/i, 14], ['MQTT', 'text', /mqtt/i, 12]] },
    { id: 'plugin-cli', label: '外掛式命令列工具', sig: [['子命令', 'text', /\.command\(\s*['"`]|add_subparsers|cobra\.Command/, 28], ['外掛註冊／載入', 'text', /registerPlugin|register_plugin|loadPlugin|entry_points|plugins?[\\/]\w+/, 24], ['bin 進入點', 'text', /"bin"\s*:/, 10]] }
  ];
  var GENERIC = 20, THRESHOLD = 28;

  // ───── 掃描 ─────
  function analyze(files, opts) {
    opts = opts || {}; var maxFiles = opts.maxFiles || 3000, maxText = opts.maxTextBytes || 400000;
    var out = { docs: [], fileCount: 0, lineCount: 0, langs: {}, tops: {}, tests: 0, build: [], entry: [], cli: [], config: [], routes: [], data: [], hardware: [], special: [], deps: [], readme: null, paths: {}, truncated: false, skipped: 0 };
    var list = (files || []).filter(function (f) { return f && typeof f.path === 'string'; }); if (list.length > maxFiles) { out.truncated = true; list = list.slice(0, maxFiles); }
    var archHit = {}; ARCH.forEach(function (a) { archHit[a.id] = {}; });
    list.forEach(function (f) {
      var p = String(f.path).replace(/\\/g, '/').replace(/^\.\//, ''), text = String(f.text == null ? '' : f.text); f = { path: p, text: text.length > maxText ? text.slice(0, maxText) : text };
      if (isVendor(p)) { out.skipped++; return; }
      out.fileCount++; out.paths[p] = 1; var lang = langOf(p), lines = f.text ? f.text.split('\n') : [];
      if (lang) { var L = out.langs[lang] || (out.langs[lang] = { files: 0, lines: 0 }); L.files++; L.lines += lines.length; }
      if (SOURCE_LANG.test(lang)) out.lineCount += lines.length;
      var top = p.indexOf('/') > 0 ? p.split('/')[0] : '（根目錄）'; var T = out.tops[top] || (out.tops[top] = { files: 0, lines: 0, langs: {} }); T.files++; if (SOURCE_LANG.test(lang)) { T.lines += lines.length; T.langs[lang] = (T.langs[lang] || 0) + lines.length; }
      if (isTest(p)) out.tests++;
      if (/^readme(\.\w+)?$/i.test(baseOf(p)) && p.split('/').length <= 2 && (!out.readme || p.split('/').length < out.readme.path.split('/').length)) out.readme = parseReadme(f);
      scanBuildFile(f, out);
      // 逐行規則：測試檔與標頭以外的說明文字也掃（測試檔裡的路由、參數不算產品的介面）
      if (!isTest(p) && lines.length <= 20000) {
        for (var li = 0; li < lines.length && li < 8000; li++) {
          var line = lines[li]; if (line.length > 400) continue;
          for (var r = 0; r < LINE_RULES.length; r++) { var R = LINE_RULES[r]; if (!R[1].test(p)) continue; var m = R[2].exec(line); if (!m) continue; var item = R[3](m, line); item.ev = p + ':' + (li + 1); out[R[0]].push(item); }
        }
      }
      // 內容訊號只看原始碼與專案設定檔：文件、資料檔、測試、以及這個模組自己（裡面寫著各種關鍵字）都不算證據
      var textSignalOk = !isTest(p) && (SOURCE_LANG.test(lang) || /\.(service|inf|dec|dsc|proto|ya?ml|bb|bbappend|ld)$/.test(p) || /^Dockerfile/.test(baseOf(p))) && !/root\.FaDocgen|root\.FaDocRender/.test(f.text);
      ARCH.forEach(function (a) { a.sig.forEach(function (s, si) { if (archHit[a.id][si]) return; if (s[1] === 'path') { if (s[2].test(p)) archHit[a.id][si] = p + ':1'; } else if (textSignalOk && s[2].test(f.text)) { var mm = s[2].exec(f.text); archHit[a.id][si] = p + ':' + lineOf(f.text, mm.index); } }); });
    });
    ['entry', 'cli', 'config', 'routes', 'data', 'hardware', 'special', 'deps', 'build'].forEach(function (k) { out[k] = uniqBy(out[k], function (x) { return (x.group || '') + '|' + x.name + '|' + (k === 'config' ? '' : x.ev); }); });
    out.config = uniqBy(out.config, function (x) { return x.name; }); out.routes = uniqBy(out.routes, function (x) { return x.name; }); out.cli = uniqBy(out.cli, function (x) { return x.name; });
    // wiki 頁面等「專案外的說明文件」：不當原始碼，只拿來補 README（沒有 README 時用第一頁），並列在概述裡
    out.docs = (Array.isArray(opts.docs) ? opts.docs : []).filter(function (d) { return d && d.text; }).slice(0, 20).map(function (d) { var r = parseReadme({ path: d.path, text: String(d.text).slice(0, 200000) }); return { path: d.path, title: r.title || d.title || d.path, rec: r, url: d.url || '' }; });
    if (!out.readme && out.docs.length) out.readme = out.docs[0].rec;
    out.archHit = archHit; out.arch = matchArchitecture(out);
    return out;
  }
  function parseReadme(f) {
    var lines = f.text.split('\n'), title = '', intro = [], sections = {}, cur = '', fenced = false;
    lines.forEach(function (l) {
      if (/^\s*```/.test(l)) fenced = !fenced;
      var h = !fenced && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(l);
      if (h) { if (!title && h[1] === '#') { title = h[2]; cur = '__intro'; return; } cur = h[2].toLowerCase(); sections[cur] = sections[cur] || []; return; }
      if (cur === '__intro' || (!cur && title === '')) { if (l.trim()) intro.push(l.trim()); } else if (cur) sections[cur].push(l);
    });
    var secOut = {}; Object.keys(sections).forEach(function (k) { secOut[k] = sections[k].join('\n').trim(); });
    return { path: f.path, title: title.replace(/[*_`]/g, ''), intro: intro.join(' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').slice(0, 700), sections: secOut };
  }

  function matchArchitecture(facts) {
    var res = ARCH.map(function (a) {
      var score = 0, reasons = []; a.sig.forEach(function (s, i) { var hit = facts.archHit && facts.archHit[a.id][i]; if (hit) { score += s[3]; reasons.push(s[0] + '（見 ' + hit + '）'); } });
      return { id: a.id, label: a.label, score: Math.min(100, score), raw: score, reasons: reasons };
    });
    var cliScore = Math.min(100, facts.cli.length * 8 + (facts.entry.length ? 10 : 0)); res.push({ id: 'cli', label: '命令列工具', score: cliScore, raw: cliScore * 0.9, reasons: facts.cli.slice(0, 3).map(function (c) { return '選項 ' + c.name + '（見 ' + c.ev + '）'; }) });
    return res.sort(function (a, b) { return b.raw - a.raw; }); // 顯示分數上限 100，排序用原始分數才分得出誰更像
  }

  // ───── 文字（繁中／英文）─────
  var TXT = {
    'zh-TW': { overview: '概述', architecture: '系統架構', modules: '目錄與模組', build: '建置與部署', entry: '進入點與執行流程', interfaces: '對外介面', config: '設定', data: '資料模型', hardware: '硬體與系統存取', deps: '相依套件', special: '重點項目', risks: '待確認與風險', verify: '驗證與測試', intro: '簡介', install: '安裝', start: '啟動', usage: '使用方式', cli: '命令列選項', api: 'API 與路由', trouble: '疑難排解', evidence: '證據', name: '名稱', desc: '說明', item: '項目', kind: '類型', see: '見', lang: '語言', files: '檔案數', lines: '行數', dir: '目錄', share: '占比', none: '（沒有找到）', docinfo: '文件資訊', source: '來源', scanned: '掃描', title_design: '設計文件', title_user: '使用手冊' },
    en: { overview: 'Overview', architecture: 'Architecture', modules: 'Directories and Modules', build: 'Build and Deployment', entry: 'Entry Points and Flow', interfaces: 'External Interfaces', config: 'Configuration', data: 'Data Model', hardware: 'Hardware and System Access', deps: 'Dependencies', special: 'Key Items', risks: 'Open Questions and Risks', verify: 'Verification and Tests', intro: 'Introduction', install: 'Installation', start: 'Getting Started', usage: 'Usage', cli: 'Command-line Options', api: 'API and Routes', trouble: 'Troubleshooting', evidence: 'Evidence', name: 'Name', desc: 'Description', item: 'Item', kind: 'Kind', see: 'see', lang: 'Language', files: 'Files', lines: 'Lines', dir: 'Directory', share: 'Share', none: '(none found)', docinfo: 'Document Info', source: 'Source', scanned: 'Scanned', title_design: 'Design Document', title_user: 'User Guide' }
  };

  // ───── 章節：每個章節從事實產生區塊；沒有素材就回空陣列（該章節不出現，並進「待確認」）─────
  function lim(ctx, n) { return Math.min(n || 999, LEVELS[ctx.level] || LEVELS.standard); }
  function evCell(e) { return e ? '`' + e + '`' : ''; }
  function tableOf(ctx, head, items, rowFn, max) { if (!items.length) return null; var shown = items.slice(0, lim(ctx, max)); var t = { t: 'table', head: head, rows: shown.map(rowFn) }; return [t].concat(items.length > shown.length ? [{ t: 'p', x: '（另有 ' + (items.length - shown.length) + ' 筆未列出；用 level:detailed 可以列更多）' }] : []); }
  function sentenceCount(s) { return (String(s).match(/[。.!?！？]/g) || []).length; }

  var SECTIONS = {
    overview: function (c) {
      var f = c.facts, b = [], r = f.readme, a = c.arch[0];
      if (r && r.intro) b.push({ t: 'p', x: r.intro + '（見 ' + r.path + '）' });
      else b.push({ t: 'p', x: '專案裡沒有 README 說明，以下內容完全由原始檔推得。' });
      var langs = Object.keys(f.langs).filter(function (k) { return SOURCE_LANG.test(k); }).sort(function (x, y) { return f.langs[y].lines - f.langs[x].lines; }), tot = langs.reduce(function (s, k) { return s + f.langs[k].lines; }, 0) || 1;
      b.push({ t: 'p', x: '共掃描 **' + f.fileCount + '** 個檔案，原始碼約 **' + f.lineCount + '** 行' + (langs.length ? '；主要語言：' + langs.slice(0, 4).map(function (k) { return k + ' ' + Math.round(f.langs[k].lines * 100 / tot) + '%'; }).join('、') : '') + '。' });
      if (f.docs.length) b.push({ t: 'p', x: '參考的說明文件：' + f.docs.slice(0, 8).map(function (d) { return d.title + (d.url ? '（' + d.url + '）' : ''); }).join('、') + '。' });
      if (a && a.score >= THRESHOLD) b.push({ t: 'p', x: '依程式內容判斷，這是 **' + a.label + '**（把握度 ' + a.score + '／100）。' });
      return b;
    },
    architecture: function (c) {
      var f = c.facts, b = [], a = c.arch.filter(function (x) { return x.score >= THRESHOLD; });
      if (a.length) { b.push({ t: 'p', x: '架構判斷依下列訊號加權而來，每一項都能回到原始檔查證：' }); a.slice(0, 2).forEach(function (x) { b.push({ t: 'h', l: 2, x: x.label + '（' + x.score + '）' }); b.push({ t: 'ul', items: x.reasons.slice(0, lim(c, 8)) }); }); }
      var tops = Object.keys(f.tops).filter(function (k) { return f.tops[k].files > 0; }).sort(function (x, y) { return f.tops[y].lines - f.tops[x].lines; }).slice(0, 8);
      if (tops.length > 1) {
        var id = function (k) { return 'M' + tops.indexOf(k); };
        var src = 'flowchart LR\n' + tops.map(function (k) { return '  ' + id(k) + '["' + k.replace(/"/g, '') + '<br/>' + f.tops[k].files + ' 個檔案"]'; }).join('\n');
        b.push({ t: 'fig', kind: 'mermaid', src: src, caption: '頂層目錄（依原始碼行數排序；箭頭關係需人工補上）' });
      }
      return b;
    },
    modules: function (c) {
      var f = c.facts, tx = c.tx, tops = Object.keys(f.tops).sort(function (x, y) { return f.tops[y].lines - f.tops[x].lines || f.tops[y].files - f.tops[x].files; });
      return tableOf(c, [tx.dir, tx.files, tx.lines, tx.lang], tops, function (k) { var T = f.tops[k], l = Object.keys(T.langs).sort(function (x, y) { return T.langs[y] - T.langs[x]; })[0] || ''; return ['`' + k + '`', String(T.files), String(T.lines), l]; }, 40) || [];
    },
    build: function (c) {
      var tx = c.tx; return tableOf(c, [tx.item, tx.desc, tx.evidence], c.facts.build, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 40) || [];
    },
    entry: function (c) { var tx = c.tx; return tableOf(c, [tx.item, tx.desc, tx.evidence], c.facts.entry, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 20) || []; },
    interfaces: function (c) {
      var f = c.facts, tx = c.tx, b = [];
      var t1 = tableOf(c, [tx.name, tx.desc, tx.evidence], f.cli, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 40); if (t1) { b.push({ t: 'h', l: 2, x: tx.cli }); b = b.concat(t1); }
      var t2 = tableOf(c, [tx.name, tx.desc, tx.evidence], f.routes, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 60); if (t2) { b.push({ t: 'h', l: 2, x: tx.api }); b = b.concat(t2); }
      return b;
    },
    config: function (c) { var tx = c.tx; return tableOf(c, [tx.name, tx.desc, tx.evidence], c.facts.config, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 60) || []; },
    data: function (c) { var tx = c.tx; return tableOf(c, [tx.name, tx.kind, tx.evidence], c.facts.data, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 40) || []; },
    hardware: function (c) { var tx = c.tx; return tableOf(c, [tx.name, tx.desc, tx.evidence], c.facts.hardware, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 40) || []; },
    deps: function (c) { var tx = c.tx; return tableOf(c, [tx.name, tx.desc, tx.evidence], c.facts.deps, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 50) || []; },
    special: function (c) {
      var tx = c.tx, groups = {}, b = []; c.facts.special.forEach(function (x) { (groups[x.group] = groups[x.group] || []).push(x); });
      Object.keys(groups).forEach(function (g) { var t = tableOf(c, [tx.name, tx.desc, tx.evidence], groups[g], function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 30); if (t) { b.push({ t: 'h', l: 2, x: g }); b = b.concat(t); } });
      return b;
    },
    risks: function (c) {
      var f = c.facts, items = c.gaps.slice();
      if (!f.readme) items.push('沒有 README，目的與使用情境無法從專案本身確認。');
      if (!f.tests) items.push('沒有找到測試檔（tests／spec／*.test.*），行為正確性沒有自動驗證的依據。');
      if (f.truncated) items.push('檔案數超過掃描上限，只分析了前面一部分。');
      if (f.skipped) items.push('已略過 ' + f.skipped + ' 個第三方或建置產物檔案（node_modules、dist、build 等）。');
      if (!items.length) return [];
      return [{ t: 'ul', items: items }];
    },
    verify: function (c) {
      var f = c.facts, b = [], t = f.build.filter(function (x) { return /test|check|lint/.test(x.name); });
      b.push({ t: 'p', x: f.tests ? '專案內有 **' + f.tests + '** 個測試檔。' : '專案內沒有找到測試檔。' });
      if (t.length) b.push({ t: 'ul', items: t.slice(0, 8).map(function (x) { return '`' + x.name + '`' + (x.detail ? '：' + x.detail : '') + '（見 ' + x.ev + '）'; }) });
      return b;
    },
    // 使用手冊
    u_intro: function (c) { var r = c.facts.readme, b = []; if (r && r.intro) b.push({ t: 'p', x: r.intro }); else b.push({ t: 'p', x: '專案沒有 README，這份手冊只根據原始檔裡找得到的選項與設定寫成。' }); var a = c.arch[0]; if (a && a.score >= THRESHOLD) b.push({ t: 'p', x: '類型：' + a.label + '。' }); return b; },
    u_install: function (c) {
      var r = c.facts.readme, b = [], k = r ? Object.keys(r.sections).filter(function (x) { return /install|setup|安裝|環境|getting started|快速開始|prerequisite|需求/.test(x); })[0] : null;
      if (k && r.sections[k]) b.push({ t: 'quote', x: r.sections[k].slice(0, 900) + '（摘自 ' + r.path + '）' });
      var deps = c.facts.deps.filter(function (x) { return !/開發用/.test(x.detail); }); if (deps.length) b.push({ t: 'p', x: '執行時需要這些套件：' + deps.slice(0, lim(c, 12)).map(function (x) { return '`' + x.name + '`'; }).join('、') + (deps.length > 12 ? ' 等 ' + deps.length + ' 個' : '') + '。' });
      var bs = c.facts.build.filter(function (x) { return /^npm run (build|install|setup)|^make |^cmake|^FROM|^EXPOSE/.test(x.name); }); if (bs.length) b.push({ t: 'ul', items: bs.slice(0, 8).map(function (x) { return '`' + x.name + '`' + (x.detail ? '：' + x.detail : '') + '（見 ' + x.ev + '）'; }) });
      return b;
    },
    u_start: function (c) {
      var b = [], r = c.facts.readme, k = r ? Object.keys(r.sections).filter(function (x) { return /usage|run|start|使用|執行|啟動|quick/.test(x); })[0] : null;
      if (k && r.sections[k]) b.push({ t: 'quote', x: r.sections[k].slice(0, 900) + '（摘自 ' + r.path + '）' });
      var st = c.facts.build.filter(function (x) { return /^npm run (start|dev|serve)/.test(x.name); }); if (st.length) b.push({ t: 'ul', items: st.map(function (x) { return '`' + x.name + '`：' + x.detail + '（見 ' + x.ev + '）'; }) });
      var en = c.facts.entry.filter(function (x) { return /ExecStart|listen|Docker|bin/.test(x.name); }); if (en.length) b.push({ t: 'ul', items: en.slice(0, 6).map(function (x) { return x.name + '：' + x.detail + '（見 ' + x.ev + '）'; }) });
      return b;
    },
    u_cli: function (c) { var tx = c.tx; return tableOf(c, [tx.name, tx.desc, tx.evidence], c.facts.cli, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 60) || []; },
    u_api: function (c) { var tx = c.tx; return tableOf(c, [tx.name, tx.desc, tx.evidence], c.facts.routes, function (x) { return ['`' + x.name + '`', x.detail, evCell(x.ev)]; }, 60) || []; },
    u_config: function (c) { return SECTIONS.config(c); },
    u_trouble: function (c) {
      var f = c.facts, items = [], ports = f.build.filter(function (x) { return x.name === 'EXPOSE'; }).map(function (x) { return x.detail; });
      if (ports.length) items.push('連不上服務時，先確認埠 ' + ports.join('、') + ' 沒有被其他程式佔用，也沒有被防火牆擋住。');
      var req = f.config.filter(function (x) { return /環境變數/.test(x.detail); }); if (req.length) items.push('啟動失敗時，先檢查這些環境變數有沒有設：' + req.slice(0, 8).map(function (x) { return '`' + x.name + '`'; }).join('、') + '。');
      if (f.cli.length) items.push('不確定可以用哪些選項時，先看「命令列選項」一節；選項名稱要照原樣輸入。');
      if (!items.length) return [];
      return [{ t: 'ul', items: items }];
    }
  };
  var TITLE_KEY = { u_intro: 'intro', u_install: 'install', u_start: 'start', u_cli: 'cli', u_api: 'api', u_config: 'config', u_trouble: 'trouble' };

  // ───── 範本目錄 ─────
  var D = ['overview', 'architecture', 'modules', 'build', 'entry', 'interfaces', 'config', 'data', 'hardware', 'deps', 'risks', 'verify'];
  function mk(id, kind, label, arch, sections, lead) { return { id: id, kind: kind, label: label, arch: arch, sections: sections, lead: lead || '', builtin: true }; }
  var TEMPLATES = [
    mk('design-generic', 'design', '通用設計文件', '*', D),
    mk('openbmc', 'design', 'OpenBMC 設計文件', 'openbmc', ['overview', 'architecture', 'special', 'modules', 'build', 'interfaces', 'config', 'data', 'hardware', 'deps', 'entry', 'risks', 'verify'], 'BMC 韌體的重點在 Yocto 配方（建置）、D-Bus 服務（對外介面）與 Redfish 資源（管理介面）。'),
    mk('rtos', 'design', 'RTOS 韌體設計文件', 'rtos', ['overview', 'architecture', 'special', 'hardware', 'modules', 'build', 'entry', 'config', 'deps', 'risks', 'verify'], 'RTOS 韌體的重點在任務（優先權與堆疊）、中斷與周邊存取，以及連結配置。'),
    mk('bios', 'design', 'BIOS／UEFI 設計文件', 'bios', ['overview', 'architecture', 'special', 'modules', 'build', 'config', 'deps', 'hardware', 'risks', 'verify'], 'UEFI 韌體以模組（.inf）為單位，重點是模組型態、進入點與 PCD 設定。'),
    mk('kernel-driver', 'design', 'Linux 核心驅動設計文件', 'kernel-driver', ['overview', 'architecture', 'special', 'hardware', 'interfaces', 'config', 'build', 'modules', 'risks', 'verify'], '核心驅動的重點在裝置註冊、file_operations 處理函式、模組參數與硬體存取。'),
    mk('web-service', 'design', 'Web 服務設計文件', 'web-service', ['overview', 'architecture', 'interfaces', 'data', 'config', 'build', 'entry', 'modules', 'deps', 'risks', 'verify'], 'Web 服務的重點在路由與資料模型，其次是設定（環境變數）與部署。'),
    mk('cgi', 'design', 'CGI 程式設計文件', 'cgi', ['overview', 'architecture', 'interfaces', 'config', 'build', 'modules', 'risks', 'verify'], 'CGI 程式由伺服器逐次呼叫，輸入來自環境變數與標準輸入。'),
    mk('system-service', 'design', '系統服務設計文件', 'system-service', ['overview', 'architecture', 'entry', 'build', 'config', 'interfaces', 'hardware', 'modules', 'deps', 'risks', 'verify'], '常駐程式的重點在啟動方式（systemd 單元）、訊號處理與對外介面。'),
    mk('gui', 'design', 'GUI 應用程式設計文件', 'gui', ['overview', 'architecture', 'special', 'modules', 'entry', 'build', 'config', 'deps', 'risks', 'verify'], '桌面應用程式的重點在視窗、主行程與介面行程之間的溝通（IPC），以及打包與更新。'),
    mk('distributed', 'design', '分散式系統設計文件', 'distributed', ['overview', 'architecture', 'interfaces', 'data', 'config', 'build', 'deps', 'modules', 'risks', 'verify'], '分散式系統的重點在服務之間的介面（gRPC／訊息主題）、資料模型與部署。'),
    mk('plugin-cli', 'design', '外掛式命令列工具設計文件', 'plugin-cli', ['overview', 'architecture', 'special', 'interfaces', 'config', 'build', 'modules', 'deps', 'risks', 'verify'], '外掛式工具的重點在子命令、外掛的註冊與載入方式。'),
    mk('user-generic', 'user', '通用使用手冊', '*', ['u_intro', 'u_install', 'u_start', 'u_cli', 'u_api', 'u_config', 'u_trouble']),
    mk('user-bmc', 'user', 'BMC 管理使用手冊', 'openbmc', ['u_intro', 'u_start', 'u_api', 'u_config', 'u_trouble'], '管理介面主要是 Redfish 與 D-Bus；下列路徑都取自原始碼。'),
    mk('user-gui', 'user', 'GUI 使用手冊', 'gui', ['u_intro', 'u_install', 'u_start', 'u_config', 'u_trouble']),
    mk('user-service', 'user', '系統服務使用手冊', 'system-service', ['u_intro', 'u_install', 'u_start', 'u_config', 'u_cli', 'u_trouble']),
    mk('user-cli', 'user', '命令列工具使用手冊', 'cli', ['u_intro', 'u_install', 'u_cli', 'u_config', 'u_trouble']),
    mk('user-web-api', 'user', 'Web API 使用手冊', 'web-service', ['u_intro', 'u_install', 'u_start', 'u_api', 'u_config', 'u_trouble']),
    mk('user-driver', 'user', '驅動程式使用手冊', 'kernel-driver', ['u_intro', 'u_install', 'u_config', 'u_trouble']),
    mk('user-plugin-cli', 'user', '外掛式命令列工具使用手冊', 'plugin-cli', ['u_intro', 'u_install', 'u_cli', 'u_config', 'u_trouble'])
  ];
  function listTemplates(userTemplates) {
    var ut = (Array.isArray(userTemplates) ? userTemplates : []).map(sanitizeTemplate).filter(Boolean);
    return TEMPLATES.map(function (t) { return Object.assign({}, t); }).concat(ut);
  }
  // 使用者自訂的範本：{id, kind, label, arch, sections:[章節代號｜「自訂:標題|內文」], lead}
  function sanitizeTemplate(t) {
    if (!t || typeof t !== 'object') return null; var id = String(t.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30); if (!id || TEMPLATES.some(function (b) { return b.id === id; })) return null;
    var kind = t.kind === 'user' ? 'user' : 'design', arch = String(t.arch || '*'); if (arch !== '*' && !ARCH.some(function (a) { return a.id === arch; }) && arch !== 'cli') arch = '*';
    var secs = (Array.isArray(t.sections) ? t.sections : String(t.sections || '').split('\n')).map(function (s) { return String(s).trim(); }).filter(Boolean).slice(0, 30).map(function (s) { return s.slice(0, 600); });
    if (!secs.length) return null;
    return { id: id, kind: kind, label: String(t.label || id).slice(0, 60), arch: arch, sections: secs, lead: String(t.lead || '').slice(0, 400), builtin: false };
  }
  function sectionIds() { return Object.keys(SECTIONS); }

  // ───── 範本選擇 ─────
  function selectTemplate(kind, facts, opts) {
    opts = opts || {}; var all = listTemplates(opts.userTemplates).filter(function (t) { return t.kind === kind; });
    if (opts.template) { var forced = all.filter(function (t) { return t.id === String(opts.template).toLowerCase(); })[0]; if (forced) return { template: forced, scores: [], reason: '依你指定的範本 ' + forced.id }; }
    var archScore = {}; facts.arch.forEach(function (a) { archScore[a.id] = a; });
    // 使用手冊沒有專屬的 rtos／bios／cgi／distributed 範本，這幾類退回通用或最接近的
    var scored = all.map(function (t) { var s = t.arch === '*' ? GENERIC : (archScore[t.arch] ? archScore[t.arch].raw : 0); if (!t.builtin && t.arch !== '*') s += 2; return { id: t.id, score: s, t: t }; }).sort(function (a, b) { return b.score - a.score; });
    var best = scored[0], generic = scored.filter(function (x) { return x.t.arch === '*'; })[0];
    if (best.t.arch !== '*' && best.score >= THRESHOLD && best.score > GENERIC) return { template: best.t, scores: scored.map(function (x) { return { id: x.id, score: x.score }; }), reason: '架構比對 ' + (archScore[best.t.arch] ? archScore[best.t.arch].label : best.t.arch) + '（' + best.score + ' 分，門檻 ' + THRESHOLD + '）' };
    return { template: generic ? generic.t : all[0], scores: scored.map(function (x) { return { id: x.id, score: x.score }; }), reason: '沒有哪一種架構的分數過門檻（' + THRESHOLD + '），用通用範本' };
  }

  // ───── 組文件 ─────
  function build(kind, facts, template, opts) {
    opts = opts || {}; var lang = opts.lang === 'en' ? 'en' : 'zh-TW', tx = TXT[lang], steps = [];
    var ctx = { facts: facts, arch: facts.arch, tx: tx, level: opts.level || 'standard', gaps: [] };
    steps.push({ id: 'scan', text: '掃描 ' + facts.fileCount + ' 個檔案、約 ' + facts.lineCount + ' 行原始碼' + (facts.skipped ? '（略過 ' + facts.skipped + ' 個第三方／建置檔）' : '') + '。' });
    var found = ['build', 'entry', 'cli', 'config', 'routes', 'data', 'hardware', 'special', 'deps'].filter(function (k) { return facts[k].length; }).map(function (k) { return ({ build: '建置', entry: '進入點', cli: '命令列選項', config: '設定', routes: '路由／介面', data: '資料模型', hardware: '硬體存取', special: '重點項目', deps: '相依套件' })[k] + ' ' + facts[k].length; });
    steps.push({ id: 'extract', text: '取出事實：' + (found.join('、') || '沒有找到可條列的事實') + '。每一筆都記下檔案與行號。' });
    var top = facts.arch[0]; steps.push({ id: 'match', text: '架構比對：最高的是「' + top.label + '」' + top.score + ' 分' + (top.score >= THRESHOLD ? '，過門檻。' : '，沒過門檻（' + THRESHOLD + '）。') });
    var title = (facts.readme && facts.readme.title) || opts.title || opts.name || '專案'; title = String(title).slice(0, 80);
    var doc = { title: title + (lang === 'en' ? ' ' : '　') + (kind === 'design' ? tx.title_design : tx.title_user), subtitle: opts.rest || '', meta: { version: opts.version || '0.1', date: opts.date || '', lang: lang, template: template.label, source: opts.source || '' }, blocks: [] };
    if (template.lead) doc.blocks.push({ t: 'quote', x: template.lead });
    var used = [], omitted = [], parts = [];
    template.sections.forEach(function (sid) {
      var custom = /^自訂[:：]/.exec(sid), blocks, head;
      if (custom) { var seg = sid.slice(custom[0].length).split('|'); head = (seg[0] || '').trim(); blocks = seg.slice(1).join('|').trim() ? [{ t: 'p', x: seg.slice(1).join('|').trim() }] : []; }
      else if (SECTIONS[sid]) { head = tx[TITLE_KEY[sid] || sid] || sid; blocks = sid === 'risks' ? null : (SECTIONS[sid](ctx) || []); }
      else { omitted.push(sid + '（不認得的章節）'); return; }
      if (blocks && !blocks.length) { if (!custom) { omitted.push(head); ctx.gaps.push('「' + head + '」一節沒有可寫的素材：原始檔裡沒有找到對應的內容。'); } return; }
      parts.push({ head: head, blocks: blocks }); // 「待確認與風險」要看得到其他章節留下的缺口，所以最後才算
    });
    parts.forEach(function (pt) {
      if (!pt.blocks) pt.blocks = SECTIONS.risks(ctx); if (!pt.blocks.length) return;
      doc.blocks.push({ t: 'h', l: 1, x: pt.head }); pt.blocks.forEach(function (bk) { doc.blocks.push(bk); }); used.push(pt.head);
    });
    steps.push({ id: 'synth', text: '用「' + template.label + '」組成文件：' + used.length + ' 章（' + used.join('、') + '）' + (omitted.length ? '；沒有素材所以略過：' + omitted.join('、') : '') + '。' });
    if (opts.analysis) doc.blocks = doc.blocks.concat(analysisAppendix(facts, tx));
    var issues = verify(doc, facts); steps.push({ id: 'verify', text: issues.length ? '驗證：' + issues.length + ' 個問題（' + issues.slice(0, 3).join('；') + '）。' : '驗證：所有引用的檔案都存在，沒有重複的章節標題。' });
    return { doc: doc, steps: steps, issues: issues, used: used, omitted: omitted };
  }
  function analysisAppendix(facts, tx) {
    var b = [{ t: 'pb' }, { t: 'h', l: 1, x: '分析附錄' }, { t: 'p', x: '這一節列出程式比對架構時用到的所有訊號與分數，方便人工複查。' }];
    b.push({ t: 'table', head: ['架構', '分數', '依據'], rows: facts.arch.map(function (a) { return [a.label, String(a.score), a.reasons.slice(0, 4).join('；') || '（沒有命中任何訊號）']; }) });
    b.push({ t: 'table', head: ['事實類別', '筆數'], rows: ['build', 'entry', 'cli', 'config', 'routes', 'data', 'hardware', 'special', 'deps'].map(function (k) { return [k, String(facts[k].length)]; }) });
    return b;
  }

  // ───── 驗證：每個「見 path:line」都要有那個檔案；章節標題不重複；表格不空 ─────
  function verify(doc, facts) {
    var issues = [], heads = {}, cite = /`?([\w.\/-]+\.[A-Za-z0-9]+):(\d+)`?/g;
    function chk(s) { var m; cite.lastIndex = 0; while ((m = cite.exec(String(s)))) { if (/^\d+\.\d+/.test(m[1])) continue; if (!facts.paths[m[1]]) issues.push('引用了不存在的檔案 ' + m[1]); } }
    (doc.blocks || []).forEach(function (b) {
      if (b.t === 'h' && b.l === 1) { if (heads[b.x]) issues.push('章節標題重複：' + b.x); heads[b.x] = 1; }
      if (b.t === 'table') { if (!b.rows.length) issues.push('有空的表格'); b.rows.forEach(function (r) { r.forEach(chk); }); }
      if (b.t === 'p' || b.t === 'quote') chk(b.x); if (b.t === 'ul' || b.t === 'ol') b.items.forEach(chk);
    });
    return uniqBy(issues, function (x) { return x; });
  }

  // ───── 線上模型潤飾：只動說明段落；識別字、路徑、數字不能被改 ─────
  function rewritePlan(doc) { var o = []; (doc.blocks || []).forEach(function (b, i) { if (b.t === 'p' && String(b.x).length >= 30) o.push({ index: i, text: b.x }); }); return o; }
  function protectedTokens(s) { var t = []; String(s).replace(/`[^`]+`|[\w.\/-]+\.[A-Za-z0-9]+:\d+|\d+(?:\.\d+)?/g, function (m) { t.push(m); return m; }); return uniqBy(t, function (x) { return x; }); }
  function acceptRewrite(orig, rewritten) {
    var a = String(orig || ''), b = String(rewritten == null ? '' : rewritten).trim();
    if (!b) return { ok: false, why: '空白' };
    if (/\n\s*([#>*-]|\d+\.)\s/.test('\n' + b) || /\n\n/.test(b)) return { ok: false, why: '多了標題、清單或分段' };
    if (b.length < a.length * 0.5 || b.length > a.length * 1.8) return { ok: false, why: '長度差太多（' + b.length + ' 對 ' + a.length + '）' };
    var miss = protectedTokens(a).filter(function (tk) { return b.indexOf(tk) < 0; }); if (miss.length) return { ok: false, why: '少了：' + miss.slice(0, 3).join('、') };
    var urlsB = b.match(/https?:\/\/\S+/g) || [], urlsA = a.match(/https?:\/\/\S+/g) || []; if (urlsB.some(function (u) { return urlsA.indexOf(u) < 0; })) return { ok: false, why: '多了網址' };
    return { ok: true };
  }

  // ───── 計畫（給過程記錄看的四個階段）─────
  function plan(kind) { return [{ id: 'analyze', text: '蒐集來源並掃描' }, { id: 'extract', text: '取出事實與證據' }, { id: 'synthesize', text: kind === 'design' ? '比對架構、選範本、組成設計文件' : '選範本、組成使用手冊' }, { id: 'verify', text: '驗證引用並輸出檔案' }]; }

  return { FORMATS: FORMATS, LEVELS: LEVELS, THRESHOLD: THRESHOLD, GENERIC: GENERIC, parseOptions: parseOptions, analyze: analyze, matchArchitecture: matchArchitecture, selectTemplate: selectTemplate, listTemplates: listTemplates, sanitizeTemplate: sanitizeTemplate, sectionIds: sectionIds, build: build, verify: verify, rewritePlan: rewritePlan, acceptRewrite: acceptRewrite, plan: plan, TXT: TXT };
});
