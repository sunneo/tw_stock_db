// 各語言樣本（tests/samples/）的期望：每個函式應該被歸到哪些行為分類、分支／迴圈至少幾個、文件註解要讀得到。
// 這是「真的 tree-sitter 文法 ＋ 完整 FaBeh2」的整合測試（langs.itest.js）；名稱表在 names_more_langs.json（scripts/gen-name-tables-more.py 產生）。
const F = (categories, extra) => Object.assign({ categories }, extra || {});
module.exports = {
  python: { file: 'sample.py', minFunctions: 3, maxUnclassified: 4, functions: {
    load_config: F(['file_io', 'structured_data_parsing', 'logging_output'], { branches: 1, loops: 2, doc: 'JSON config' }),
    run: F(['time_date', 'process_exec', 'env_config_access', 'concurrency']),
    fetch_and_store: F(['network_io', 'crypto_security', 'database_access', 'structured_data_parsing']) } },
  java: { file: 'sample.java', minFunctions: 3, maxUnclassified: 4, functions: {
    load: F(['file_io', 'logging_output'], { branches: 1, loops: 2, doc: 'text file' }),
    fetch: F(['network_io']),
    run: F(['process_exec', 'env_config_access', 'concurrency', 'time_date', 'database_access']) } },
  javascript: { file: 'sample.js', minFunctions: 3, maxUnclassified: 2, functions: {
    loadConfig: F(['file_io', 'logging_output'], { branches: 1, loops: 2, doc: 'JSON' }),
    fetchAndSave: F(['network_io', 'crypto_security', 'filesystem_management']),
    run: F(['process_exec', 'event_handling']) } },
  rust: { file: 'sample.rs', minFunctions: 3, maxUnclassified: 3, functions: {
    read_all: F(['file_io'], { doc: 'whole file' }),
    run: F(['process_exec', 'env_config_access', 'concurrency', 'time_date'], { branches: 1 }),
    fetch: F(['network_io', 'file_io', 'filesystem_management'], { branches: 2 }) } },
  cpp: { file: 'sample.cpp', language: 'cpp', minFunctions: 3, maxUnclassified: 2, functions: {
    read_all: F(['file_io'], { branches: 1, loops: 1, doc: 'whole file' }),
    start: F(['concurrency', 'time_date'], { doc: 'background thread' }),
    save: F(['filesystem_management', 'memory_management']) } },
  csharp: { file: 'sample.cs', minFunctions: 6, maxUnclassified: 2, functions: {
    LoadAsync: F(['file_io', 'structured_data_parsing', 'logging_output'], { branches: 1, loops: 2, doc: 'scene file' }),
    FetchAsync: F(['network_io', 'logging_output']),
    Run: F(['process_exec', 'env_config_access', 'concurrency']),
    Save: F(['filesystem_management', 'file_io', 'database_access'], { branches: 2 }) } },
  ruby: { file: 'sample.rb', minFunctions: 3, maxUnclassified: 2, functions: {
    load: F(['file_io', 'structured_data_parsing', 'logging_output'], { branches: 2, loops: 2, doc: 'config file' }),
    fetch: F(['network_io', 'process_exec', 'concurrency', 'time_date', 'filesystem_management']) } },
  lua: { file: 'sample.lua', minFunctions: 3, maxUnclassified: 2, functions: {
    'M.load': F(['file_io', 'structured_data_parsing', 'logging_output'], { branches: 1, loops: 2, doc: 'config file' }),
    'M:fetch': F(['network_io', 'process_exec', 'env_config_access', 'time_date', 'concurrency']) } },
  // 3D／SDL／OpenGL 的 C#（使用者 Babylon3DScene.cs 那一類）：圖形、視窗、事件、線性代數要認得
  csharp_gl: { file: 'scene3d.cs', language: 'csharp', minFunctions: 4, maxUnclassified: 3, functions: {
    Init: F(['multimedia_io', 'graphics_rendering'], { branches: 1, doc: 'window' }),
    UpdateCamera: F(['linear_algebra'], { doc: 'camera' }),
    Frame: F(['event_handling', 'graphics_rendering', 'multimedia_io'], { branches: 1, loops: 1, doc: 'frame' }),
    Dispose: F(['graphics_rendering', 'multimedia_io']) } },
  // WinForms／GDI+ 的 C#（使用者 Babylon3DCubeDemo.cs 那一類）：建構子、事件處理、OnPaint、Application.Run
  csharp_winforms: { file: 'winforms.cs', language: 'csharp', minFunctions: 5, maxUnclassified: 2, functions: {
    Babylon3DCubeDemo: F(['gui_toolkit'], { doc: 'window' }),
    OnTick: F(['string_formatting', 'gui_toolkit'], { doc: 'rotation' }),
    OnPaint: F(['graphics_rendering', 'arithmetic_logic'], { loops: 1, doc: 'GDI' }),
    Run: F(['gui_toolkit'], { doc: 'standalone' }) } },
  // 泛用方法名（join／get／update／append／sort／split…）對任何物件都可能出現：不能因此被當成執行緒、檔案、資料庫
  python_generic: { file: 'generic.py', language: 'python', minFunctions: 2, maxUnclassified: 3, functions: {
    build: { notCategories: ['concurrency', 'file_io', 'database_access', 'network_io', 'process_exec', 'ipc'] },
    lookup: { notCategories: ['concurrency', 'file_io', 'database_access', 'network_io', 'process_exec', 'ipc'] } } },
  javascript_generic: { file: 'generic.js', language: 'javascript', minFunctions: 1, maxUnclassified: 4, functions: { build: { notCategories: ['file_io', 'database_access', 'network_io', 'process_exec', 'ipc', 'crypto_security', 'filesystem_management'] } } },
  java_generic: { file: 'Generic.java', language: 'java', minFunctions: 1, maxUnclassified: 4, functions: { build: { notCategories: ['concurrency', 'file_io', 'database_access', 'network_io', 'process_exec', 'ipc', 'crypto_security', 'filesystem_management'] } } },
  csharp_generic: { file: 'generic.cs', language: 'csharp', minFunctions: 1, maxUnclassified: 4, functions: { Build: { notCategories: ['concurrency', 'file_io', 'database_access', 'network_io', 'process_exec', 'ipc', 'crypto_security', 'filesystem_management'] } } },
  ruby_generic: { file: 'generic.rb', language: 'ruby', minFunctions: 1, maxUnclassified: 4, functions: { build: { notCategories: ['concurrency', 'file_io', 'database_access', 'network_io', 'process_exec', 'ipc', 'crypto_security', 'filesystem_management'] } } },
  lua_generic: { file: 'generic.lua', language: 'lua', minFunctions: 1, maxUnclassified: 4, functions: { build: { notCategories: ['concurrency', 'file_io', 'database_access', 'network_io', 'process_exec', 'ipc', 'crypto_security', 'filesystem_management'] } } },
  // 語法有錯／文法不認得的新語法：不能整個檔案都沒有函式；錯誤區段外的函式照樣分析
  csharp_broken: { file: 'broken.cs', language: 'csharp', minFunctions: 2, maxUnclassified: 6, functions: { Load: { categories: ['file_io'] }, Save: { categories: ['file_io'] }, After: { categories: ['filesystem_management'] } } },
};
