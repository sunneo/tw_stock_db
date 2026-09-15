// tw_stock_db客製寫法沿用：floating-assistant.js本身保持host-agnostic，
// 所有Electron專屬的行為（直接檔案存取、本機程式執行、指到本地proxy、
// UI文字微調）都從這支host bootstrap掛進去，不改floating-assistant.js
// 核心一行程式碼——延續piano-web/index.html「引擎共用、host各自注入內容」
// 的既有慣例。
"use strict";

// ---------------------------------------------------------------------
// 1. ElectronDirectHandle / ElectronDirectFileHandle：duck-type瀏覽器
//    FileSystemDirectoryHandle / FileSystemFileHandle的介面，讓
//    floating-assistant.js既有的_resolveFapDirectory/_resolveFapFileParent/
//    FapGitFs（git_operations）完全不用改，就能把它們原本假設的瀏覽器
//    handle換成直接走IPC打真實fs的版本。queryPermission/requestPermission
//    一律回傳'granted'——桌面app的信任模型是「使用者自己用原生資料夾選擇
//    對話框選了這個資料夾，就是同意」，不需要瀏覽器那套per-session重新
//    授權機制（那是專門為了瀏覽器沙盒設計的，桌面app沒有對應限制）。
// ---------------------------------------------------------------------
class ElectronDirectHandle {
  constructor({ rootId, relPath, name }) {
    this.kind = "directory";
    this.rootId = rootId;
    this.relPath = relPath || "";
    this.name = name || (this.relPath.split("/").filter(Boolean).pop() || "root");
  }
  async queryPermission() { return "granted"; }
  async requestPermission() { return "granted"; }

  _childPath(name) {
    return this.relPath ? `${this.relPath}/${name}` : name;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const childRel = this._childPath(name);
    let st = null;
    try {
      st = await window.desktopAPI.fs.stat(this.rootId, childRel);
    } catch (_) {
      st = null;
    }
    if (st && !st.isDirectory) throw new Error(`「${name}」是檔案，不是資料夾`);
    if (!st) {
      if (!create) throw notFoundError(childRel);
      await window.desktopAPI.fs.mkdir(this.rootId, childRel);
    }
    return new ElectronDirectHandle({ rootId: this.rootId, relPath: childRel, name });
  }

  async getFileHandle(name, { create = false } = {}) {
    const childRel = this._childPath(name);
    let st = null;
    try {
      st = await window.desktopAPI.fs.stat(this.rootId, childRel);
    } catch (_) {
      st = null;
    }
    if (st && st.isDirectory) throw new Error(`「${name}」是資料夾，不是檔案`);
    if (!st) {
      if (!create) throw notFoundError(childRel);
      await window.desktopAPI.fs.writeFile(this.rootId, childRel, { text: "" });
    }
    return new ElectronDirectFileHandle({ rootId: this.rootId, relPath: childRel, name });
  }

  async removeEntry(name, { recursive = false } = {}) {
    const childRel = this._childPath(name);
    try {
      await window.desktopAPI.fs.remove(this.rootId, childRel, recursive);
    } catch (err) {
      throw notFoundError(childRel);
    }
  }

  async *entries() {
    let list;
    try {
      list = await window.desktopAPI.fs.readdir(this.rootId, this.relPath);
    } catch (err) {
      throw notFoundError(this.relPath);
    }
    for (const e of list) {
      const childRel = this._childPath(e.name);
      const handle = e.isDirectory
        ? new ElectronDirectHandle({ rootId: this.rootId, relPath: childRel, name: e.name })
        : new ElectronDirectFileHandle({ rootId: this.rootId, relPath: childRel, name: e.name });
      yield [e.name, handle];
    }
  }
}

class ElectronDirectFileHandle {
  constructor({ rootId, relPath, name }) {
    this.kind = "file";
    this.rootId = rootId;
    this.relPath = relPath;
    this.name = name;
  }
  async getFile() {
    const { base64 } = await window.desktopAPI.fs.readFile(this.rootId, this.relPath);
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const st = await window.desktopAPI.fs.stat(this.rootId, this.relPath);
    const blob = new Blob([bytes]);
    return {
      name: this.name,
      type: "",
      size: st.size,
      lastModified: st.mtimeMs,
      arrayBuffer: () => blob.arrayBuffer(),
      text: () => blob.text(),
      slice: (...a) => blob.slice(...a),
    };
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (data) => {
        if (typeof data === "string") chunks.push(new TextEncoder().encode(data));
        else if (data instanceof Blob) chunks.push(new Uint8Array(await data.arrayBuffer()));
        else chunks.push(new Uint8Array(data));
      },
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        let bin = "";
        for (let i = 0; i < merged.length; i++) bin += String.fromCharCode(merged[i]);
        await window.desktopAPI.fs.writeFile(this.rootId, this.relPath, { base64: btoa(bin) });
      },
    };
  }
}

function notFoundError(p) {
  const err = new Error(`ENOENT: no such file or directory, '${p}'`);
  err.name = "NotFoundError";
  err.code = "ENOENT";
  return err;
}

// ---------------------------------------------------------------------
// 2. ElectronFapStore：duck-type FileAccessPointStore（floating-assistant.js
//    內建class，只透過add/getAll/get/rename/delete這5個方法被其餘程式碼
//    使用，見_resolveFapAccessPoint/_renderFapList/「+新增資料夾」按鈕
//    handler——整個FAP系統除了這5個方法完全沒有直接碰過IndexedDB實作細節，
//    這裡直接整組換成走IPC的版本）。
// ---------------------------------------------------------------------
class ElectronFapStore {
  async _recList() {
    const roots = await window.desktopAPI.roots.list();
    return roots.map((r) => ({
      id: r.id,
      label: r.label,
      addedAt: r.addedAt,
      handle: new ElectronDirectHandle({ rootId: r.id, relPath: "", name: r.label }),
    }));
  }
  async getAll() { return this._recList(); }
  async get(id) { return (await this._recList()).find((r) => r.id === id) || null; }
  async add(label, handle) {
    // showDirectoryPicker()的polyfill（見下面）已經在使用者選資料夾當下
    // 就透過fa:roots:add持久化過一筆（含預設label＝資料夾名稱），這裡收到
    // 的handle帶著那筆記錄的id（handle.rootId）——既有UI流程接著會跳
    // prompt()問使用者想要的顯示名稱，這裡就是套用那個名稱，不要重新
        // 建立一筆造成重複。
    if (handle && handle.rootId) {
      await window.desktopAPI.roots.rename(handle.rootId, label);
      return handle.rootId;
    }
    throw new Error("ElectronFapStore.add() 需要一個由showDirectoryPicker()產生的handle");
  }
  async rename(id, label) { return window.desktopAPI.roots.rename(id, label); }
  async delete(id) { return window.desktopAPI.roots.remove(id); }
}

// window.showDirectoryPicker polyfill——floating-assistant.js既有的
// 「+新增資料夾」按鈕(_initEventListeners)就是呼叫這個瀏覽器API，桌面版
// 完全複用那段既有邏輯，不用另外刻UI：Electron原生資料夾選擇對話框沒有
// 瀏覽器showDirectoryPicker()的「transient activation」限制，隨時可以
// 呼叫，取消時丟出跟瀏覽器一致的AbortError讓既有的catch邏輯自然處理。
window.showDirectoryPicker = async function showDirectoryPicker() {
  const rec = await window.desktopAPI.roots.add();
  if (!rec) {
    const err = new Error("使用者取消了資料夾選擇");
    err.name = "AbortError";
    throw err;
  }
  const handle = new ElectronDirectHandle({ rootId: rec.id, relPath: "", name: rec.label });
  handle.rootId = rec.id;
  return handle;
};

// ---------------------------------------------------------------------
// 3. 把Advance Settings裡跟Cloudflare Worker有關的說明文字，改寫成桌面版
//    用語——這些字串是floating-assistant.js核心HTML樣板裡寫死的（給web
//    部署情境寫的），桌面版不需要使用者自己部署/管理Worker（本地proxy已經
//    內建，見local-proxy.js），維持原始文字會誤導使用者去找根本不需要的
//    設定項。只重寫呈現文字，不動任何邏輯/欄位本身（gitCorsProxyUrl等
//    欄位還在，只是預設值指向本地、說明文字改了）。
// ---------------------------------------------------------------------
function patchCloudflareWording(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const rules = [
    [/一定要透過一個部署了\/git-proxy路由的Cloudflare Worker中繼[，,]?/g, "已經內建本地代理服務(不需要另外部署)，"],
    [/需要一個部署了\/git-proxy路由的Cloudflare Worker/g, "已經內建本地代理服務(不需要另外部署)"],
    [/Cloudflare Worker/g, "本地代理服務(桌面版內建)"],
    [/雲端\/Cloudflare Worker/g, "本地代理服務"],
  ];
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    let text = node.nodeValue;
    let changed = false;
    for (const [pattern, replacement] of rules) {
      if (pattern.test(text)) { text = text.replace(pattern, replacement); changed = true; }
    }
    if (changed) node.nodeValue = text;
  }
}

// ---------------------------------------------------------------------
// 4. 建構FloatingAssistant、套用桌面版override、註冊desktop_ops domain。
// ---------------------------------------------------------------------
(async function main() {
  const fa = new FloatingAssistant({
    mountSelector: "#app",
    buttonStyle: "display:none;",
    windowStyle: "position:static; width:100%; height:100%; max-height:none; box-shadow:none; z-index:1;",
  });
  window.fa = fa; // 方便除錯；正式功能不依賴這個全域變數

  // 檔案存取直接存取override：整個FAP store換成IPC版本，其餘fap_*工具/
  // git_operations完全不用改，因為它們只透過_resolveFapAccessPoint→
  // this.fileAccessPoints.getAll()這個單一入口拿handle。
  fa.fileAccessPoints = new ElectronFapStore();

  // 本地proxy設定：git_operations（isomorphic-git的http transport還是在
  // renderer用fetch()，仍然需要CORS繞道）跟browser_search/TTS API等既有
  // 「留空→退回目前AI端點apiUrl」的功能，一律指向本機的local-proxy.js，
  // 不需要使用者自己申請/部署Cloudflare Worker、也不用網路連線到任何
  // 第三方代理。
  const port = await window.desktopAPI.config.getLocalProxyPort();
  const proxyStatusEl = document.getElementById("topbar-proxy-status");
  if (port) {
    const localBase = `http://127.0.0.1:${port}`;
    fa.advancedSettings.gitCorsProxyUrl = localBase;
    fa.advancedSettings.browserSearchProxyUrl = localBase;
    fa.advancedSettings.ttsApiProxyUrl = localBase;
    fa._saveAdvancedSettings();
    if (proxyStatusEl) proxyStatusEl.textContent = `本地proxy：127.0.0.1:${port}`;
  } else if (proxyStatusEl) {
    proxyStatusEl.textContent = "本地proxy：啟動失敗（git/搜尋等功能可能無法使用）";
    proxyStatusEl.style.color = "#f87171";
  }

  // tw_stock_db客製: 2026-09-15使用者要求的「server configure」——
  // NVAPI_KEY/OPENROUTER_API_KEY存在main.js管理的本機secrets.json，
  // renderer完全看不到實際金鑰值（desktopAPI.secrets.status()只回報有/
  // 沒有設定）。有設定NVIDIA金鑰時，把`floating_ai_base_url_key`
  // seed成本地proxy的`/nvidia`路由——這是跟tw_stock_db的index.html完全
  // 同一招（它seed成自己部署的Cloudflare Worker網址），對
  // _resolveModelRowConfig()而言只是「留空的row退回哪個網址」的問題，
  // 不需要改floating-assistant.js一行。apiKey留空即可（local-proxy.js
  // 會用真金鑰蓋掉client端送出的Authorization，client端填什麼都無所謂），
  // 這裡仍填一個無意義的占位字串，單純避免其他程式碼把「空字串apiKey」
  // 誤判成「使用者完全沒有設定過」而顯示額外的提示。
  let secretsStatus = { nvidia: false, openrouter: false };
  try { secretsStatus = await window.desktopAPI.secrets.status(); } catch (_) {}
  if (port && secretsStatus.nvidia && !localStorage.getItem(fa.LLM_BASE_URL_KEY)) {
    localStorage.setItem(fa.LLM_BASE_URL_KEY, `http://127.0.0.1:${port}/nvidia`);
    if (!localStorage.getItem(fa.STORAGE_KEY)) localStorage.setItem(fa.STORAGE_KEY, "local-desktop-proxy");
  }

  // 頂部列「🔑 設定API金鑰」——2026-09-15實測發現window.prompt()在這個
  // Electron版本點了完全沒反應（不會丟錯誤、就是靜默沒有任何對話框跳出來），
  // 改成手刻一個輕量modal（跟floating-assistant.js自己
  // _showMp4ExportOptionsDialog/_showFapPermissionDialog同一種寫法：
  // 全螢幕半透明遮罩+置中卡片），保證在任何Electron版本都可靠運作，不依賴
  // 瀏覽器原生對話框。讓使用者可以在不打開Advance Settings、不用碰任何
  // 檔案的情況下，把NVAPI_KEY/OPENROUTER_API_KEY寫進secrets.json。設定
  // 完成後重新整理頁面套用（改動的是localStorage的LLM_BASE_URL_KEY seed
  // 邏輯，最單純可靠的作法是重新走一次上面這段判斷，而不是嘗試就地更新
  // 已經建構好的model rows）。
  function showSecretsDialog() {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:999999; display:flex; align-items:center; justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:#161b22; color:#e5e7eb; border:1px solid #30363d; border-radius:10px; padding:20px 22px; width:min(420px,90vw); font-size:13px; font-family:inherit;";
    box.innerHTML = `
      <div style="font-weight:bold; font-size:15px; margin-bottom:14px;">🔑 設定API金鑰</div>
      <p style="color:#93a4b7; margin:0 0 14px 0; line-height:1.5;">存在本機 secrets.json（不會顯示在畫面上、不會傳到renderer）。留空欄位不會修改目前已儲存的值。</p>
      <label style="display:block; margin-bottom:12px;">
        <div style="margin-bottom:4px; color:#93a4b8;">NVIDIA API Key（NVAPI_KEY）</div>
        <input type="password" id="secrets-dlg-nvidia" style="width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid #30363d; border-radius:6px; background:#0d1117; color:#e5e7eb; font-size:13px;">
      </label>
      <label style="display:block; margin-bottom:18px;">
        <div style="margin-bottom:4px; color:#93a4b8;">OpenRouter API Key（OPENROUTER_API_KEY）</div>
        <input type="password" id="secrets-dlg-openrouter" style="width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid #30363d; border-radius:6px; background:#0d1117; color:#e5e7eb; font-size:13px;">
      </label>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button type="button" id="secrets-dlg-cancel" style="padding:6px 14px; border-radius:6px; border:1px solid #30363d; background:#21262d; color:#e5e7eb; cursor:pointer; font-size:13px;">取消</button>
        <button type="button" id="secrets-dlg-save" style="padding:6px 14px; border-radius:6px; border:none; background:#3182ce; color:#fff; cursor:pointer; font-size:13px;">儲存</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    box.querySelector("#secrets-dlg-cancel").addEventListener("click", close);
    box.querySelector("#secrets-dlg-save").addEventListener("click", async () => {
      const nvKey = box.querySelector("#secrets-dlg-nvidia").value.trim();
      const orKey = box.querySelector("#secrets-dlg-openrouter").value.trim();
      const patch = {};
      if (nvKey) patch.NVAPI_KEY = nvKey;
      if (orKey) patch.OPENROUTER_API_KEY = orKey;
      close();
      if (Object.keys(patch).length === 0) return;
      await window.desktopAPI.secrets.set(patch);
      location.reload();
    });
    box.querySelector("#secrets-dlg-nvidia").focus();
  }
  const secretsBtn = document.getElementById("topbar-secrets-btn");
  if (secretsBtn) secretsBtn.addEventListener("click", showSecretsDialog);

  // tw_stock_db客製: 2026-09-15使用者回報——核心內建的「+新增資料夾」按鈕
  // （走window.showDirectoryPicker→原生資料夾選擇對話框）在他的環境點了
  // 完全沒反應，明確要求要有跳過原生對話框、直接輸入路徑的後路。跟
  // showSecretsDialog同一種手刻modal寫法；新增成功後如果Advance Settings
  // 剛好開著，順便呼叫fa._renderFapList()讓清單即時反映，不用使用者自己
  // 關掉再打開設定才看得到剛新增的資料夾。
  function showAddFolderDialog() {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:999999; display:flex; align-items:center; justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:#161b22; color:#e5e7eb; border:1px solid #30363d; border-radius:10px; padding:20px 22px; width:min(520px,90vw); font-size:13px; font-family:inherit;";
    box.innerHTML = `
      <div style="font-weight:bold; font-size:15px; margin-bottom:14px;">📁 直接輸入路徑新增資料夾</div>
      <p style="color:#93a4b7; margin:0 0 14px 0; line-height:1.5;">跳過原生資料夾選擇對話框，直接授權一個本機資料夾路徑給AI直接讀寫。</p>
      <label style="display:block; margin-bottom:12px;">
        <div style="margin-bottom:4px; color:#93a4b8;">資料夾完整路徑</div>
        <input type="text" id="addfolder-dlg-path" placeholder="例如 D:\\Downloads\\我的專案" style="width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid #30363d; border-radius:6px; background:#0d1117; color:#e5e7eb; font-size:13px;">
      </label>
      <label style="display:block; margin-bottom:8px;">
        <div style="margin-bottom:4px; color:#93a4b8;">顯示名稱（選填，留空＝用資料夾本身的名稱）</div>
        <input type="text" id="addfolder-dlg-label" style="width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid #30363d; border-radius:6px; background:#0d1117; color:#e5e7eb; font-size:13px;">
      </label>
      <div id="addfolder-dlg-error" style="color:#f87171; font-size:12px; min-height:16px; margin-bottom:6px;"></div>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button type="button" id="addfolder-dlg-cancel" style="padding:6px 14px; border-radius:6px; border:1px solid #30363d; background:#21262d; color:#e5e7eb; cursor:pointer; font-size:13px;">取消</button>
        <button type="button" id="addfolder-dlg-save" style="padding:6px 14px; border-radius:6px; border:none; background:#3182ce; color:#fff; cursor:pointer; font-size:13px;">新增</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    box.querySelector("#addfolder-dlg-cancel").addEventListener("click", close);
    const pathInput = box.querySelector("#addfolder-dlg-path");
    const errEl = box.querySelector("#addfolder-dlg-error");
    const doSave = async () => {
      const folderPath = pathInput.value.trim();
      const label = box.querySelector("#addfolder-dlg-label").value.trim();
      if (!folderPath) { errEl.textContent = "請輸入資料夾路徑"; return; }
      try {
        const rec = await window.desktopAPI.roots.addByPath(folderPath, label);
        close();
        if (typeof fa._renderFapList === "function") { try { await fa._renderFapList(); } catch (_) {} }
        console.log(`已授權資料夾「${rec.label}」，AI可以用 fap:${rec.label} 存取。`);
      } catch (err) {
        errEl.textContent = String((err && err.message) || err);
      }
    };
    box.querySelector("#addfolder-dlg-save").addEventListener("click", doSave);
    pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
    pathInput.focus();
  }
  const addFolderBtn = document.getElementById("topbar-add-folder-btn");
  if (addFolderBtn) addFolderBtn.addEventListener("click", showAddFolderDialog);

  // desktop_ops domain：run_command是這個桌面版新增的唯一「真的碰到系統
  // 層」的工具（檔案讀寫沿用既有fap_*工具，直接透過override後的
  // fileAccessPoints運作，不用另外重複造一套）。
  fa.register_openai_tool(
    "run_command",
    "在使用者這台電腦上直接執行一個程式/指令（子行程）——例如跑腳本、編譯、執行測試、開啟其他應用程式。這是風險最高的工具：整體功能預設關閉，需要使用者自己在應用程式頂部列勾選「允許AI執行程式」才能呼叫；預設每次呼叫都會跳出原生確認對話框，顯示完整指令與工作目錄，由使用者當場按「執行」才會真的跑（除非使用者自己在頂部列關閉這個確認）。執行前務必先用自然語言跟使用者確認清楚要跑的指令、參數、預期效果，不要自作主張執行任何有破壞性或不可逆的指令（刪除檔案、格式化、部署到正式環境、對外發送資料等）——這類操作應該建議使用者自己手動執行，而不是透過這個工具代勞。參數: {\"command\":\"node\",\"args\":[\"script.js\"],\"root_ref\":\"fap:我的專案\",\"cwd\":\".\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      const command = String(parsed.command || "").trim();
      if (!command) return JSON.stringify({ ok: false, error: "缺少command參數" });
      let rootId = null;
      if (parsed.root_ref) {
        try {
          const { fapIdOrLabel } = fa._parseFapRef(parsed.root_ref);
          const rec = await fa._resolveFapAccessPoint(fapIdOrLabel);
          rootId = rec.id;
        } catch (err) {
          return JSON.stringify({ ok: false, error: String(err.message || err) });
        }
      }
      try {
        const result = await window.desktopAPI.exec.run({
          rootId,
          command,
          args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
          cwdRel: parsed.cwd || ".",
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
      }
    },
    {
      type: "object",
      properties: {
        command: { type: "string", description: "要執行的程式名稱或路徑" },
        args: { type: "array", items: { type: "string" }, description: "命令列參數陣列（不要拼成一整串字串，每個參數要獨立成陣列元素，不會經過shell解析）" },
        root_ref: { type: "string", description: "選填，格式fap:<名稱或id>，指定工作目錄要在哪個已授權資料夾底下；留空則用使用者家目錄" },
        cwd: { type: "string", description: "選填，相對於root_ref資料夾的子路徑，當作實際工作目錄" },
      },
      required: ["command"],
      additionalProperties: false,
    }
  );

  fa.register_domain("desktop_ops", {
    enabled: true,
    label: "本機直接檔案存取與程式執行（桌面版限定）",
    toolNames: [
      "run_command",
      "fap_write_file", "fap_read_file", "fap_list_files", "fap_find_file",
      "fap_copy_from_storage", "fap_copy_to_storage", "list_file_access_points",
    ],
    systemPrompt:
      "你是桌面版FloatingAssistant專用的子任務助理，操作對象是使用者透過原生資料夾選擇對話框授權的本機資料夾（桌面版是「直接存取」，一經授權就能直接讀寫，不像瀏覽器版每次都要重新確認權限）。檔案讀寫沿用fap_*系列工具（ref格式`fap:<名稱或id>[/<路徑>]`）；run_command可以執行真正的本機程式/指令，這個工具風險最高，執行前一定要先跟使用者確認清楚指令內容，且使用者必須已經在應用程式頂部列開啟「允許AI執行程式」這個工具才能真正執行（沒開啟時呼叫會直接失敗並清楚說明原因）。",
  });

  // ---- 頂部列：執行程式開關 ----
  const settings = await window.desktopAPI.exec.getSettings();
  const execEnabledChk = document.getElementById("topbar-exec-enabled");
  const execConfirmChk = document.getElementById("topbar-exec-confirm");
  if (execEnabledChk) {
    execEnabledChk.checked = !!settings.execEnabled;
    execEnabledChk.addEventListener("change", () => {
      window.desktopAPI.exec.setSettings({ execEnabled: execEnabledChk.checked });
    });
  }
  if (execConfirmChk) {
    execConfirmChk.checked = settings.execConfirmRequired !== false;
    execConfirmChk.addEventListener("change", () => {
      window.desktopAPI.exec.setSettings({ execConfirmRequired: execConfirmChk.checked });
    });
  }

  // ---- Cloudflare用語替換：開啟就先跑一次，之後每次Advance Settings
  // modal內容變動（開關modal、切分頁、儲存設定重繪…）都自動重新套用。 ----
  const advancedModal = document.getElementById("ai-advanced-modal");
  if (advancedModal) {
    patchCloudflareWording(advancedModal);
    new MutationObserver(() => patchCloudflareWording(advancedModal)).observe(advancedModal, {
      childList: true, subtree: true, characterData: true,
    });
  }

  // ---- 桌面版是單一用途、永遠鋪滿視窗的對話介面，不是「可以收合成小藥丸
  // 再點開」的浮動widget（那套機制刻意被關掉，見上面buttonStyle:'display:
  // none'）——既有的❌關閉鈕（#ai-btn-close）點下去只會呼叫toggleWindow()
  // 把整個對話框藏起來，但因為藥丸按鈕不存在，使用者會完全沒有辦法在app
  // 裡面把它找回來。桌面版直接把這顆按鈕藏掉，不給使用者按到的機會——
  // 要離開對話就是關閉整個應用程式視窗（工作列/Alt+F4），不是「關掉對話
  // 本身」。
  const closeBtn = document.getElementById("ai-btn-close");
  if (closeBtn) closeBtn.style.display = "none";

  // ---- Advance Settings本來就已經是「全螢幕深色遮罩+置中卡片」的彈出式
  // 對話框（見floating-assistant.js的.ai-advanced-overlay/.ai-advanced-dialog
  // 樣式），不是塞在小視窗裡的內嵌面板——桌面版把卡片寬度從960px放寬到
  // 1200px，搭配現在預設最大化的主視窗，視覺上會更接近「彈出一個獨立
  // 對話視窗」的感覺。這裡刻意不做成真正獨立的OS視窗（第二個BrowserWindow）
  // ——那需要另外設計跨行程狀態同步（advancedSettings目前只活在這個
  // renderer的記憶體裡），複雜度高很多；如果這個视覺效果還不夠、真的需要
  // 獨立視窗，需要另外討論再做。
  const style = document.createElement("style");
  style.textContent = `
    .ai-advanced-dialog { width: min(1200px, 96vw) !important; }
  `;
  document.head.appendChild(style);

  fa.toggleWindow();
})();
