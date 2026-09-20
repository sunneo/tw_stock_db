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
    // tw_stock_db客製: 2026-09-16修bug——這裡原本回傳一個duck-type物件
    // （帶`arrayBuffer: () => blob.arrayBuffer()`這種函式屬性），大部分
    // 呼叫端（.text()/.arrayBuffer()/.slice()）用起來沒問題，但Skill資料夾
    // 匯入（_importSkillFolder）會把這個物件整包塞進IndexedDB
    // （FileCache.put，見floating-assistant.js），structured clone
    // algorithm不能複製函式，直接丟出`could not be cloned`。改回傳真正的
    // File實體（Blob的子類別，原生支援structured clone），這裡跟
    // JSZip.loadAsync().file().async('blob')回傳的真Blob就完全等價，
    // 桌面版資料夾匯入才會跟zip/.skill匯入行為一致。
    return new File([bytes], this.name, { lastModified: st.mtimeMs });
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
  // tw_stock_db客製: 2026-09-16使用者要求——桌面版要能在不同資料夾底下
  // 運作，每個資料夾各自獨立的對話紀錄+設定（見main.js fa:workspace:*
  // 系列handler的完整說明：判斷順序/預設資料夾邏輯都寫在那邊，這裡只管
  // renderer端這一半）。這一步必須是整個main() IIFE最先做、且要await
  // 完成才能繼續——下面new FloatingAssistant()建構子本身就會同步呼叫
  // 好幾次localStorage.getItem/setItem（還原對話紀錄/Advance設定/指令
  // 輸入history，見那邊建構子的說明），如果先建構完才換掉
  // window.localStorage（跟下面window.prompt/confirm/alert那組「先建構、
  // 後覆寫」的順序不一樣，不能照抄），建構子這幾次讀寫會打到瀏覽器原生
  // localStorage（永遠是空的、也不會真的被存檔），使用者會發現「明明就在
  // 這個資料夾、卻看不到任何之前的對話/設定」。
  const workspaceInit = await window.desktopAPI.workspace.init();
  let activeWorkspaceFolder = workspaceInit.folder;
  const workspaceCache = new Map(Object.entries(workspaceInit.data || {}));
  // tw_stock_db客製: 寫入排隊成一條promise chain，保證main行程收到的
  // 寫入順序跟這裡呼叫setItem/removeItem/clear的順序一致——main.js
  // fa:workspace:persist選擇「整包覆寫、不做read-modify-write」是為了
  // 避免並發寫入互相覆蓋，前提是這裡真的按照呼叫順序把每次的完整快照
  // 送過去，不能讓後一次呼叫的invoke先於前一次抵達main行程（fire-and-
  // forget的話，理論上有機會因為IPC/事件迴圈排程而不按順序抵達）。
  let workspaceWriteChain = Promise.resolve();
  const persistWorkspace = () => {
    workspaceWriteChain = workspaceWriteChain.then(() =>
      window.desktopAPI.workspace.persist(Object.fromEntries(workspaceCache))
    );
    return workspaceWriteChain;
  };
  // tw_stock_db客製: 整個換掉window.localStorage（跟下面window.prompt/
  // confirm/alert同一招），floating-assistant.js核心幾十處既有的
  // localStorage.getItem/setItem/removeItem呼叫完全不用改一行、自動變成
  // 「這個資料夾專屬」。讀取一律從這裡的記憶體快照（workspaceCache，
  // 開機時從main行程一次載入，見上面）回答，不用每次都IPC往返；寫入才
  // 需要非同步通知main行程落地到磁碟——localStorage.setItem()本來就
  // 不要求真的等到「已經寫進磁碟」才返回（瀏覽器原生實作也是這樣），
  // 這正是這裡不需要像window.prompt那樣用sendSync同步阻塞的原因。
  // tw_stock_db客製: `window.localStorage`在現代瀏覽器/Electron是
  // 只有getter、沒有setter的存取器屬性（定義在Window.prototype上）——
  // 直接`window.localStorage = {...}`這樣單純賦值，在"use strict"模式下
  // 會直接丟`TypeError: Cannot set property localStorage of #<Window>
  // which has only a getter`（實測撞過，不是理論上的風險），一定要用
  // Object.defineProperty()明確蓋掉這個屬性描述子（configurable+
  // writable:true，之後如果需要還能再次覆寫/還原）才能真正換掉。
  // window.prompt/confirm/alert沒有這個問題是因為它們本來就是Window
  // 原型鏈上的一般（可寫）方法，不是像localStorage/sessionStorage這種
  // 特殊的存取器屬性。
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem(key) {
        const v = workspaceCache.get(String(key));
        return v === undefined ? null : v;
      },
      setItem(key, value) {
        workspaceCache.set(String(key), String(value));
        persistWorkspace();
      },
      removeItem(key) {
        workspaceCache.delete(String(key));
        persistWorkspace();
      },
      clear() {
        workspaceCache.clear();
        persistWorkspace();
      },
      key(index) {
        const keys = [...workspaceCache.keys()];
        return index >= 0 && index < keys.length ? keys[index] : null;
      },
      get length() {
        return workspaceCache.size;
      },
    },
  });

  // tw_stock_db客製: 2026-09-15使用者要求——主題切換要放在主畫面。桌面版
  // 原本完全沒有設定過<html data-theme>，floating-assistant.js核心的
  // _isLightTheme()預設規則是「data-theme !== 'dark' 就算淺色」，等於
  // 聊天面板永遠是淺色，卻疊在topbar自己寫死的深色chrome（index.html的
  // #topbar background:#0d1117）底下，兩者對不上、也完全沒有入口可以
  // 切換——這裡在建構FloatingAssistant之前（避免第一次畫面出現後才套用
  // 造成的閃爍）就先套用使用者上次選的主題，預設'dark'（配合topbar既有的
  // 深色外觀，第一次使用者體感才會一致，不是「一半深一半淺」）。
  const THEME_STORAGE_KEY = "fa_desktop_theme_preference";
  const applyTheme = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("topbar-theme-toggle");
    if (btn) btn.textContent = theme === "light" ? "☀️ 淺色" : "🌙 深色";
  };
  applyTheme(localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark");

  const fa = new FloatingAssistant({
    mountSelector: "#app",
    buttonStyle: "display:none;",
    windowStyle: "position:static; width:100%; height:100%; max-height:none; box-shadow:none; z-index:1;",
  });
  window.fa = fa; // 方便除錯；正式功能不依賴這個全域變數

  // tw_stock_db客製: 2026-09-17使用者回報——模型常常把自己當成純網頁小
  // 工具，遇到「幫我存這個檔案」「讀取我電腦上的XX」這類要求會先入為主
  // 回答「我做不到」，即使desktop_ops domain(見下面register_domain)早就
  // 有run_command/fs_*/tmux_*這些真的能碰到本機檔案系統的工具——問題是
  // 那段詳細說明只有「被委派到desktop_ops domain之後」才看得到，根對話
  // 完全不知道這件事、也就不會主動考慮委派過去。這裡用引擎提供的公開
  // setEnvironmentNote()（跟setSystemPrompt那個給使用者編輯人設用的
  // baseSystemPrompt分開，見floating-assistant.js的說明）把這個環境事實
  // 放進每一輪system prompt（根對話+委派出去的子agent都看得到，見
  // _getGroundingContext），純網頁版完全不呼叫這個方法，維持host-agnostic。
  // tw_stock_db客製: 2026-09-17使用者實測回報——就算有這段note，實務上還是
  // 「有時候會忘記」（同一個使用者直接提醒一次「你是desktop app」，模型
  // 才想起來要用fs_read_file）。追查過_refreshSystemPromptMessage()/
  // _getGroundingContext()的程式碼本身：不管是全新對話、還原自舊對話紀錄
  // 的system message、還是委派出去的子agent，這段note都確實有正確送進去
  // （寫了真實的Electron環境測試＋單元測試逐一驗證過，不是code層級的
  // bug）——問題出在原本這段文字只講抽象的「domain」概念（"desktop_ops
  // 領域"），模型讀到「幫我算XX、跑一段程式」這類乍看跟「檔案」無關的
  // 請求時，不會主動聯想到這句話跟這次任務有關；只有使用者的訊息裡明確
  // 出現「檔案」「儲存」這類字眼時才會觸發聯想。改成直接點名實際工具
  // 名稱（fs_read_file/fs_write_file/run_command）跟一個「乍看跟檔案無關
  // 但其實需要」的具體反例（提到絕對路徑，即使只是要「執行」或「計算」）
  // ——具體的工具名稱+反例比抽象概念更容易讓模型在非典型措辭下也聯想到
  // 這件事適用，這是prompt salience的調整，不是邏輯bug。
  fa.setEnvironmentNote(
    "[執行環境] 你現在執行在桌面版(Electron)應用程式裡，不是只能碰對話文字的純網頁小工具——有能力透過delegate_to_subagent委派給desktop_ops領域，直接呼叫fs_read_file/fs_write_file/fs_list_files等工具讀寫這台電腦上使用者帳號權限碰得到的任何真實檔案、用run_command執行系統指令、用tmux_*操作持久化終端機session。這件事不是只有「使用者明講要存檔/讀檔」時才相關——任何時候只要任務裡出現一個真實磁碟絕對路徑（例如\"/home/user/xxx.py\"），即使表面上是要你「執行」「計算」「跑一下」看起來跟檔案無關，也代表你需要先取得那個路徑目前的真實內容，不要假設自己做不到就直接拒絕或回答「我沒有檔案存取能力/只能在隔離沙盒裡運作」——委派給code_execution執行程式時同理，那個domain的bash_execute/python_execute工具本身有real_input_files參數可以直接指定真實絕對路徑、不需要另外委派desktop_ops。**寫程式/改bug/實作功能/重構這類程式設計任務，改委派給coding領域**（它有固定流程：讀狀態→設計計畫→git patch修改→語法檢查→測試→commit，並把進度寫進專案的DESIGN-INDEX.md可中斷後恢復；不要用desktop_ops的fs_write_file直接改寫程式碼）。"
  );

  // tw_stock_db客製: 2026-09-17使用者要求——web/floating-assistant.js（web/
  // desktop共用引擎）裡bash_execute/python_execute/fetch_web_page這幾個
  // 工具的description本來直接寫死提到「桌面版」/「純網頁版」，使用者
  // 明確要求共用檔案不該出現特定host的字眼、這類補充說明要走override/
  // 外掛機制注入——這裡用引擎新提供的appendToolDescription()（跟
  // setEnvironmentNote/setDomainNote同一批公開API，見floating-assistant.js
  // 裡三個方法各自的說明）把「這台桌面app具體怎麼支援real_input_files/
  // output_ref/CORS代理」這些桌面專屬細節，從host端補充到工具description
  // 後面，引擎本身的文字維持完全host中立（只描述「如果目前環境有提供
  // 這個能力」，不假設也不排除任何host）。
  // tw_stock_db客製: 2026-09-18使用者要求的輕量stopgap——上面的
  // setEnvironmentNote()已經是「不是code bug、是prompt salience調整」的
  // 既有修復（見該處說明的完整追查過程），這裡加第二個獨立訊號通道：
  // 直接把同一件事也補在delegate_to_subagent工具自己的description後面
  // （跟bash_execute/python_execute的補充同一種host-override機制，不是
  // 改floating-assistant.js本身——那個工具描述本身完全host中立，不該
  // 寫死「桌面版」字眼）。根模型每次考慮「這次該呼叫哪個工具」時，
  // delegate_to_subagent自己的description是會被直接看到的一級資訊，跟
  // environmentNote（掛在system prompt另一段）是兩個獨立的資訊來源——
  // 同一個關鍵事實出現在兩個地方，比只出現一次更不容易被模型的注意力
  // 忽略，尤其是在environmentNote前面已經疊了很多其他內容的長對話中。
  // tw_stock_db客製: 2026-09-18——delegate_to_subagent這個工具的description
  // 會被引擎自己在register_domain()/_saveAdvancedSettings()時整段程式化
  // 重建（見_updateDelegateToSubagentDescription()），一度讓這裡append的
  // 補充文字活不過下一次重建——已經在引擎層修好（appendToolDescription()
  // 現在會記住補充內容，重建時自動重新接上，見該方法的說明），這裡呼叫
  // 順序不再重要，跟其餘工具一樣直接放在這裡即可。
  fa.appendToolDescription(
    "delegate_to_subagent",
    "[桌面版補充] 這是唯一的桌面本機操作入口：domain留空、task裡描述「讀寫這台電腦上的真實檔案／執行系統指令／操作終端機session」，系統會自動委派給desktop_ops領域（fs_read_file/fs_write_file/fs_list_files/run_command/tmux_*）。任何時候task內容裡出現一個真實磁碟絕對路徑，即使表面上只是要「執行」「計算」「跑一下」，也代表需要委派過去先取得那個路徑的真實內容——不要假設自己只能操作對話文字、不要直接回答「我沒有檔案存取能力」。但「寫程式/修bug/實作功能」類任務不要走這個入口，明確指定domain為coding（固定流程＋git patch＋可恢復的TODO狀態）。"
  );
  fa.appendToolDescription(
    "bash_execute",
    "[桌面版補充] real_input_files會透過fs_read_file讀取這台電腦上的真實檔案；output_ref可以直接給一個真實磁碟絕對路徑，會透過fs_write_file寫入。"
  );
  fa.appendToolDescription(
    "python_execute",
    "[桌面版補充] real_input_files會透過fs_read_file讀取這台電腦上的真實檔案；output_ref可以直接給一個真實磁碟絕對路徑，會透過fs_write_file寫入。"
  );
  fa.appendToolDescription(
    "fetch_web_page",
    "[桌面版補充] 已經內建本地代理服務(local-proxy.js)，不需要另外部署Cloudflare Worker即可直接使用。"
  );

  // tw_stock_db客製: 2026-09-17使用者要求——Advance設定分組後多了一個
  // 「桌面程式/單機」群組（見floating-assistant.js的ADVANCED_SETTINGS_GROUPS/
  // setAdvancedSettingsGroupVisible說明），目前還沒有任何真正桌面專屬的
  // 設定項目、群組本身是空的，但先把容器打開，等以後真的有桌面專屬設定
  // （例如#3 xterm的sandbox後端切換）時就能直接加進去，不用再補這一行。
  // 純網頁版沒有呼叫這個方法，該群組維持隱藏（引擎預設值）。
  fa.setAdvancedSettingsGroupVisible("desktop", true);

  // ---- 主題切換（見上面applyTheme的說明）----
  const themeToggleBtn = document.getElementById("topbar-theme-toggle");
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
      // tw_stock_db客製: refreshTheme()是floating-assistant.js核心公開方法
      // （見那邊的說明），負責把所有用_getThemePalette()決定顏色的既有DOM
      // 節點（聊天面板本身）重新套用一次——Advance設定那邊改用CSS
      // html[data-theme="light"]屬性選擇器直接跟著<html>屬性變化自動套用，
      // 不需要JS介入。
      fa.refreshTheme();
    });
  }

  // 檔案存取直接存取override：整個FAP store換成IPC版本，其餘fap_*工具/
  // git_operations完全不用改，因為它們只透過_resolveFapAccessPoint→
  // this.fileAccessPoints.getAll()這個單一入口拿handle。
  fa.fileAccessPoints = new ElectronFapStore();

  // tw_stock_db客製: 2026-09-15使用者回報「檔案存取管理」的重新命名／移除
  // 按鈕完全沒作用——追查到floating-assistant.js核心那兩個按鈕分別是
  // `prompt('新的名稱：', rec.label)`跟`confirm('移除授權...')`，而
  // Electron從來沒有實作`window.prompt()`（呼叫了不會顯示任何東西、直接
  // 回傳null，這是Electron本身的已知限制，不是這個app或floating-assistant.js
  // 的bug），`window.confirm()`在這個build同樣不可靠。不能改
  // floating-assistant.js本身（要維持host-agnostic，在真正瀏覽器裡這兩個
  // API完全正常），改成在桌面版把這兩個全域函式整個蓋掉，底層呼叫
  // preload.js暴露的`desktopAPI.dialogs.*`（用`ipcRenderer.sendSync`，
  // renderer執行緒真的會被阻塞到main行程跳出modal視窗、使用者按下按鈕、
  // 把`event.returnValue`設好為止——語意跟原生prompt()/confirm()一致，
  // 呼叫端不用改寫成await）。這樣一來，不只檔案存取管理的重新命名/移除，
  // 整個floating-assistant.js核心裡任何地方用到prompt()/confirm()/alert()
  // 的既有功能，桌面版全部自動變成可靠可用，不用逐一去找、逐一改。
  window.prompt = (message, defaultValue) => window.desktopAPI.dialogs.prompt(message, defaultValue);
  window.confirm = (message) => window.desktopAPI.dialogs.confirm(message);
  window.alert = (message) => { window.desktopAPI.dialogs.alert(message); };

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
    // tw_stock_db客製: 2026-09-16使用者要求——單機板的bash_execute/
    // python_execute執行環境（busybox.wasm／Pyodide）改經本地proxy帶入，
    // 見floating-assistant.js的_resolveAssetProxyUrl/FA_ASSET_URLS.bashWasmJsBase
    // 的說明。跟其餘三個proxy欄位同一種「留空=直接fetch，有填=經本地proxy」
    // 慣例，只是指到local-proxy.js既有的/proxy/<url>通用路由。
    fa.advancedSettings.assetBackupProxyUrl = localBase;
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
  // tw_stock_db客製: 2026-09-16使用者實測回報——「Failed to fetch」連續失敗
  // 10次。追查發現：本地proxy改成每次啟動隨機挑一個可用port（見
  // cc3c2de「Let the local proxy pick a random free port」），但這裡原本
  // 用`!localStorage.getItem(fa.LLM_BASE_URL_KEY)`當「要不要seed」的判斷——
  // 這個guard的原意是「使用者自己改過就不要覆蓋」，在port固定寫死47891的
  // 年代是安全的（seed過一次之後，之後每次啟動seed的值都跟已經存在的值
  // 完全一樣，這個guard形同虛設）；但port隨機化之後，這個「只seed一次」
  // 的邏輯讓localStorage永遠卡住第一次啟動時的（隨機）port號碼，之後
  // 每次app重開、proxy換了新的隨機port，renderer卻還在打舊port——舊port
  // 已經沒有任何process在監聽，每個LLM請求都在TCP連線階段就直接失敗
  // （connection refused），對應到_loopFetch/_loopFetchNative的
  // catch區塊，重試10次後放棄、顯示「連線本身失敗」。改成用正規表示式
  // 判斷目前存的值「看起來像不像是我們自己先前seed過的本地proxy網址」
  // （固定是`http://127.0.0.1:<任意port>/nvidia`這個形狀）——是的話，
  // 代表這不是使用者自己刻意填的真實外部端點，每次啟動都可以放心覆寫成
  // 目前這次真正綁定到的port；使用者如果真的自己改成別的網址（例如自己
  // 部署的雲端端點），就不會符合這個形狀，維持原本「不覆蓋使用者自訂值」
  // 的行為不變。
  const currentApiUrl = localStorage.getItem(fa.LLM_BASE_URL_KEY);
  const looksLikeOurOwnSeededProxyUrl = !currentApiUrl || /^https?:\/\/127\.0\.0\.1:\d+\/nvidia$/.test(currentApiUrl);
  if (port && secretsStatus.nvidia && looksLikeOurOwnSeededProxyUrl) {
    localStorage.setItem(fa.LLM_BASE_URL_KEY, `http://127.0.0.1:${port}/nvidia`);
    if (!localStorage.getItem(fa.STORAGE_KEY)) localStorage.setItem(fa.STORAGE_KEY, "local-desktop-proxy");
  }

  // 「🔑 設定API金鑰」——2026-09-15實測發現window.prompt()在這個Electron
  // 版本點了完全沒反應（不會丟錯誤、就是靜默沒有任何對話框跳出來），改成
  // 手刻一個輕量modal（跟floating-assistant.js自己
  // _showMp4ExportOptionsDialog/_showFapPermissionDialog同一種寫法：
  // 全螢幕半透明遮罩+置中卡片），保證在任何Electron版本都可靠運作，不依賴
  // 瀏覽器原生對話框。設定完成後重新整理頁面套用（改動的是localStorage的
  // LLM_BASE_URL_KEY seed邏輯，最單純可靠的作法是重新走一次上面這段判斷，
  // 而不是嘗試就地更新已經建構好的model rows）。
  // tw_stock_db客製: 2026-09-15使用者實測回報——這顆按鈕後來被搬進Advance
  // 設定的「桌面版設定」分頁（見下面把DOM節點appendChild過去那段），但這裡
  // 的z-index(999999)從一開始就比floating-assistant.js核心.ai-advanced-overlay
  // 的z-index(1000001)低，導致這個overlay雖然真的有被建立、插進
  // document.body，卻被Advance設定的遮罩蓋在下面，畫面上完全看不到、
  // 也點不到，使用者必須先關掉Advance設定才會「突然看得到」——不是沒開啟，
  // 是被疊在下面。改成比.ai-advanced-overlay更高，不管將來這顆按鈕擺在
  // 哪個z-index層級的容器裡，都保證疊在最上層。
  function showSecretsDialog() {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:1000002; display:flex; align-items:center; justify-content:center;";
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
    // tw_stock_db客製: 見showSecretsDialog同樣位置的說明——跟那邊同樣的理由，
    // 統一用比.ai-advanced-overlay(1000001)更高的z-index，避免將來這顆
    // 按鈕也被搬進Advance設定裡時，重蹈同一個「疊在下面點不到」的問題。
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:1000002; display:flex; align-items:center; justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:#161b22; color:#e5e7eb; border:1px solid #30363d; border-radius:10px; padding:20px 22px; width:min(520px,90vw); font-size:13px; font-family:inherit;";
    box.innerHTML = `
      <div style="font-weight:bold; font-size:15px; margin-bottom:14px;">📁 直接輸入路徑新增資料夾</div>
      <p style="color:#93a4b7; margin:0 0 14px 0; line-height:1.5;">跳過原生資料夾選擇對話框，直接授權一個本機資料夾路徑給AI直接讀寫。</p>
      <label style="display:block; margin-bottom:12px;">
        <div style="margin-bottom:4px; color:#93a4b8;">資料夾完整路徑</div>
        <div style="display:flex; gap:6px;">
          <input type="text" id="addfolder-dlg-path" placeholder="例如 D:\\Downloads\\我的專案" style="flex:1; min-width:0; box-sizing:border-box; padding:6px 8px; border:1px solid #30363d; border-radius:6px; background:#0d1117; color:#e5e7eb; font-size:13px;">
          <button type="button" id="addfolder-dlg-browse" style="padding:6px 12px; border-radius:6px; border:1px solid #30363d; background:#21262d; color:#e5e7eb; cursor:pointer; font-size:13px; white-space:nowrap;">瀏覽…</button>
        </div>
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
    // 瀏覽按鈕：dialog.showOpenDialog在這台機器不會顯示（同一個已知問題），
    // 改叫main.js自己刻的資料夾瀏覽器視窗（desktopAPI.roots.browse），選定
    // 後把絕對路徑直接填回文字輸入框，使用者仍然要按「新增」才會真的送出
    // （瀏覽跟新增分開兩步，讓使用者有機會在送出前調整顯示名稱）。
    box.querySelector("#addfolder-dlg-browse").addEventListener("click", async () => {
      try {
        const picked = await window.desktopAPI.roots.browse(pathInput.value.trim() || undefined);
        if (picked) { pathInput.value = picked; errEl.textContent = ""; }
      } catch (err) {
        errEl.textContent = String((err && err.message) || err);
      }
    });
    pathInput.focus();
  }
  const addFolderBtn = document.getElementById("topbar-add-folder-btn");
  if (addFolderBtn) addFolderBtn.addEventListener("click", showAddFolderDialog);

  // desktop_ops domain：run_command是這個桌面版新增的唯一「真的碰到系統
  // 層」的工具（檔案讀寫沿用既有fap_*工具，直接透過override後的
  // fileAccessPoints運作，不用另外重複造一套）。
  fa.register_openai_tool(
    "run_command",
    `在使用者這台電腦上直接執行一個程式/指令——真的透過shell執行（${window.desktopAPI.platform.isWindows ? "依序嘗試Git Bash／PowerShell／cmd.exe，找得到哪個就用哪個" : "/bin/bash"}），管線(|)、重導向(>/>>)、&&、萬用字元等shell語法都可以直接用，也可以是像「跑腳本、編譯、執行測試、開啟其他應用程式」這類單一指令。command可以是完整的一整行指令（含參數），也可以只給執行檔名稱、參數另外放args陣列（兩種都支援）。這是風險最高的工具：整體功能預設關閉，需要使用者自己在Advance設定的「桌面版設定」分頁勾選「允許AI執行程式」才能呼叫；預設每次呼叫都會跳出原生確認對話框，顯示完整指令與工作目錄，由使用者當場按「執行」才會真的跑——**這個原生對話框本身就是真正的人工確認關卡**。只有在你要自己「發明/推測」具體指令（使用者沒有明確講清楚要跑什麼、你得自己決定用哪個指令/參數達成目的），或這個指令本身有破壞性/不可逆風險（刪除檔案、格式化、部署到正式環境、對外發送資料等——這類操作應該建議使用者自己手動執行，不要透過這個工具代勞）時，才需要先用自然語言跟使用者確認清楚要跑的指令、參數、預期效果。**如果使用者已經在原始請求裡明確講清楚要做什麼（例如明確要求「產生某個腳本並試跑」、給了明確的檔名/路徑/內容），不要再回頭多問一次「請問我可以執行嗎」——使用者已經確認過了，直接呼叫這個工具即可，原生確認對話框會處理剩下的把關**；反覆多問只會讓使用者以為你在敷衍、卡在原地什麼都沒做。參數: {"command":"ls -la /some/path"} 或 {"command":"node","args":["script.js"],"cwd_abs":"/home/user/project"}`,
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
          cwdAbs: parsed.cwd_abs || null,
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
      }
    },
    {
      type: "object",
      properties: {
        command: { type: "string", description: "要執行的完整指令行（可含參數/管線/重導向等shell語法），或只給執行檔名稱（參數另外放args）" },
        args: { type: "array", items: { type: "string" }, description: "選填，命令列參數陣列（跟command分開給時用；會自動加上正確的shell引號後接在command後面）" },
        root_ref: { type: "string", description: "選填，格式fap:<名稱或id>，指定工作目錄要在哪個已授權資料夾底下；跟cwd_abs擇一使用，都留空則用使用者家目錄" },
        cwd: { type: "string", description: "選填，相對於root_ref資料夾的子路徑，當作實際工作目錄" },
        cwd_abs: { type: "string", description: "選填，直接指定工作目錄的絕對路徑，不受任何root範圍限制（跟fs_*系列同樣的無限制精神）；有給的話優先於root_ref/cwd" },
      },
      required: ["command"],
      additionalProperties: false,
    }
  );

  // tw_stock_db客製: 2026-09-15使用者明確要求桌面版檔案存取「不應該有任何
  // 限制」——fap_*系列工具維持原本「先授權root、只能碰授權範圍」的模型
  // （給使用者想維持範圍控管時用），這裡新增一組平行的fs_*工具，直接吃
  // 絕對路徑、完全不做root範圍檢查（main.js的fa:rawfs:*），唯一邊界是OS
  // 帳號本身的檔案權限。兩組工具都掛在desktop_ops domain底下，AI依情境
  // 自行選用——已知在某個FAP root底下操作優先用fap_*（語意上跟使用者在
  // 「檔案存取管理」看到的授權清單一致），需要碰觸未授權路徑（例如使用者
  // 只分享了父資料夾、AI需要讀它底下沒被逐一列在roots.json裡的子資料夾）
  // 時改用fs_*，不用先叫使用者去新增一個新的root。
  const fsToolSchema = (extra) => ({
    type: "object",
    properties: { path: { type: "string", description: "絕對路徑（或相對於使用者家目錄的路徑）" }, ...extra },
    required: ["path"],
    additionalProperties: false,
  });
  // tw_stock_db客製: 2026-09-15使用者實測回報——單一大檔案（30KB+文字，例如
  // 一份完整XML/文件說明）用fs_read_file整份塞回對話後，根模型收到這麼大一包
  // tool result常常直接reasoning-deadend（只輸出思考過程、生不出最終回覆）。
  // 既有的「批次分段」機制（batch_process_items）只解決「多個檔案」的情境，
  // 「單一大檔案」完全沒有對應機制——使用者明確要求「大檔案解析都要採用
  // chunks」。這裡讓fs_read_file自己對純文字內容做字元分段：預設一次最多
  // 回傳getAdaptiveFsReadChunkChars()算出的字元數（跟著模型上下文容量
  // 自動調整，見下面定義），超過的部分要AI自己帶offset續讀，
  // 每次都回傳明確的chunk/hasMore/nextOffset中繼資料+提示文字，讓AI知道
  // 「這只是片段，不要當作已經拿到全部內容就直接作答」。base64（疑似二進位）
  // 內容不做這個字元切割（語意不同，維持整包回傳）。
  // tw_stock_db客製: 2026-09-15使用者明確要求——「我們的做法要可以滿足
  // 小模型，當換到token足夠的大模型也要可以自己self-adaptive」：這個
  // 預設分段大小不能寫死，要跟著使用者自己在效能設定填的contextWindowTokens
  // （每個model row的真實上下文容量）按比例縮放——複用floating-assistant.js
  // 核心新增的_getAdaptiveContentBudgetChars()共用公式（fraction=0.1，
  // 保留大部分window給system prompt/工具schema/對話歷史；floor=6000維持
  // 小模型原本就驗證過的安全預設值不變）。每次呼叫都重新計算（不是模組
  // 載入時算一次），使用者中途調整設定立刻反映。
  const getAdaptiveFsReadChunkChars = () => fa._getAdaptiveContentBudgetChars(0.1, 6000);
  fa.register_openai_tool(
    "fs_read_file",
    "直接讀取這台電腦上任意路徑的檔案內容，不需要先授權/註冊資料夾。純文字檔案（原始碼/設定檔/markdown等）直接回傳文字；偵測到疑似二進位內容（含NUL byte）時自動改回傳base64（並標註likely_binary），不會像fap_read_file那樣直接拒絕。**大檔案會自動分段**：純文字內容超過門檻時，一次只回傳一段（回應裡的chunk.hasMore/chunk.nextOffset會告訴你有沒有更多、下一段從哪裡開始，實際門檻依目前模型的上下文容量設定自動調整），需要更多內容時帶offset參數再呼叫一次；每讀完一段就把重點摘要記下來，不要等所有段落都讀完才動筆、也不要把每段原始全文都留在對話裡。參數: {\"path\":\"/home/user/notes.txt\",\"offset\":0,\"maxChars\":6000}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const r = await window.desktopAPI.rawfs.readFile(parsed.path, parsed.encoding);
        if (r && typeof r.text === "string" && !r.likely_binary) {
          const fullText = r.text;
          const totalChars = fullText.length;
          const offset = Number.isFinite(Number(parsed.offset)) && Number(parsed.offset) > 0 ? Math.floor(Number(parsed.offset)) : 0;
          const maxChars = Number.isFinite(Number(parsed.maxChars)) && Number(parsed.maxChars) > 0 ? Math.floor(Number(parsed.maxChars)) : getAdaptiveFsReadChunkChars();
          if (totalChars > maxChars || offset > 0) {
            const chunkText = fullText.slice(offset, offset + maxChars);
            const nextOffset = offset + chunkText.length;
            const hasMore = nextOffset < totalChars;
            return JSON.stringify({
              ok: true, ...r, text: chunkText,
              chunk: { offset, length: chunkText.length, totalChars, hasMore, nextOffset: hasMore ? nextOffset : null },
              note: hasMore ? `這是第${offset}~${nextOffset}字元的片段（全檔共${totalChars}字元），還有更多內容，需要的話帶offset=${nextOffset}再呼叫一次。` : `這是最後一段（第${offset}~${nextOffset}字元，全檔共${totalChars}字元）。`,
            });
          }
        }
        return JSON.stringify({ ok: true, ...r });
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    fsToolSchema({
      encoding: { type: "string", enum: ["auto", "base64"], description: "選填，'base64'強制以base64回傳（例如已知是圖片/二進位檔）；預設auto自動偵測" },
      offset: { type: "number", description: "選填，從第幾個字元開始讀（0-based）。續讀大檔案時，帶上一次回應chunk.nextOffset的值。預設0。" },
      maxChars: { type: "number", description: `選填，這次最多回傳幾個字元。預設依目前模型的上下文容量設定自動調整（目前約${getAdaptiveFsReadChunkChars()}）。` },
    })
  );
  fa.register_openai_tool(
    "fs_write_file",
    "直接寫入這台電腦上任意路徑的檔案（不存在會自動建立，含父資料夾），不需要先授權/註冊資料夾。寫入前務必先跟使用者確認要寫的內容/目標路徑，不要自作主張覆蓋重要檔案。參數: {\"path\":\"/home/user/out.txt\",\"content\":\"...\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const payload = parsed.encoding === "base64" ? { base64: String(parsed.content ?? "") } : { text: String(parsed.content ?? "") };
        const r = await window.desktopAPI.rawfs.writeFile(parsed.path, payload);
        return JSON.stringify({ ok: true, ...r });
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    fsToolSchema({
      content: { type: "string", description: "要寫入的內容" },
      encoding: { type: "string", enum: ["text", "base64"], description: "選填，content是base64編碼的二進位內容時傳'base64'；預設text" },
    })
  );
  fa.register_openai_tool(
    "fs_list_files",
    "列出這台電腦上任意路徑（資料夾）底下的檔案/子資料夾，不需要先授權/註冊資料夾。**如果列出的檔案數量較多（大致抓3-5個以上）、且任務需要逐一讀取/處理每一個檔案**，不要自己一個個sequentially呼叫fs_read_file——改用batch_process_items把每個檔案獨立委派給平行子任務處理，避免把所有檔案內容塞進同一個對話歷史。參數: {\"path\":\"/home/user/Shared/KeywordDocs/StepAction\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const entries = await window.desktopAPI.rawfs.readdir(parsed.path);
        return JSON.stringify({ ok: true, path: parsed.path, entries });
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    fsToolSchema()
  );
  fa.register_openai_tool(
    "fs_stat",
    "查詢這台電腦上任意路徑的中繼資料（是檔案還是資料夾、大小、修改時間），不需要先授權/註冊資料夾。參數: {\"path\":\"/home/user/notes.txt\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const st = await window.desktopAPI.rawfs.stat(parsed.path);
        return JSON.stringify({ ok: true, ...st });
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    fsToolSchema()
  );
  fa.register_openai_tool(
    "fs_find_file",
    "在這台電腦上任意路徑底下遞迴搜尋檔名符合pattern（正規表示式，不分大小寫）的檔案/資料夾，不需要先授權/註冊資料夾。**如果搜尋結果數量較多、且任務需要逐一讀取/處理每一個檔案**，改用batch_process_items平行處理，不要自己逐一sequentially呼叫fs_read_file。參數: {\"path\":\"/home/user/project\",\"pattern\":\"\\\\.ya?ml$\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const results = await window.desktopAPI.rawfs.find(parsed.path, parsed.pattern, parsed.max_depth, parsed.max_results);
        return JSON.stringify({ ok: true, results });
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    fsToolSchema({
      pattern: { type: "string", description: "檔名比對用的正規表示式（不分大小寫），例如 \\\\.ya?ml$" },
      max_depth: { type: "number", description: "選填，最大遞迴深度，預設8" },
      max_results: { type: "number", description: "選填，最多回傳幾筆，預設200" },
    })
  );

  // tw_stock_db客製: 2026-09-15使用者要求——「大量解析檔案需求，要batch且
  // 開多個subagent去個別讀取，最後再reduce/gather結果，避免context
  // overflow」，並要求這個能力要generic、AI要自己知道數量多時該這樣做。
  // floating-assistant.js核心早就有這個map-reduce引擎——runBatchSubAgents
  // （目前只透過web/index.html的batch_analyze_stocks工具包成「批次分析
  // 股票」，引擎本身刻意跟股票無關，見那個函式的既有註解）：把一份items
  // 清單拆成N個獨立、平行執行的_runSubAgentTask，**每個子任務都是全新、
  // 彼此獨立的對話（只看得到自己負責的那一項），不會共用/累積成長中的
  // 訊息歷史**——這正是避免context overflow的關鍵，跟「用同一個子agent
  // 依序sequentially讀N個檔案、訊息歷史越疊越長」是完全不同的兩種做法。
  // 這裡直接複用這個既有引擎（零核心改動），包成desktop_ops專用的
  // batch_process_items工具，讓一個原本可能要sequentially呼叫N次
  // fs_read_file、把N個檔案內容都塞進同一個對話歷史的任務，改成N個獨立
  // 平行子任務（map），完成後只需要處理N份精簡結論（reduce，由呼叫這個
  // 工具的AI自己統整，不需要再重新讀取原始檔案內容）。
  fa.register_openai_tool(
    "batch_process_items",
    "把一份「項目清單」（最常見是檔案絕對路徑，但也可以是任何字串識別碼，依instruction決定怎麼處理）拆成多個獨立、平行執行的子任務（map階段）：每個子任務只看得到自己負責的那一項，彼此互不干擾、不會共用對話歷史，處理完回傳一段精簡結論。全部完成後回傳{item, verdict}陣列給你，由你自己統整成最終報告（reduce/gather階段）——不需要、也不應該再重新讀取每個項目的完整原始內容。**這是avoid context overflow的標準做法：任何時候你發現要對「多個獨立項目」（尤其是多個檔案）逐一做同性質的處理/摘要/分析，且項目數量較多（大致抓3-5個以上），都應該優先用這個工具，而不是自己一個個sequentially呼叫fs_read_file等工具把所有原始內容都累積進同一個對話歷史**——那樣容易造成上下文快速膨脹，增加模型只回覆思考過程、沒有給出實際結論的機率（處理量越大，風險越高）。參數: {\"items\":[\"/abs/path/file1.xml\",\"/abs/path/file2.xml\"],\"instruction\":\"用fs_read_file讀取這個檔案的內容，摘要它的用途、格式與關鍵欄位\",\"concurrency\":4}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      const items = Array.isArray(parsed.items) ? parsed.items.map(String) : [];
      if (!items.length) return JSON.stringify({ ok: false, error: "缺少items陣列（至少一個要處理的項目，例如檔案絕對路徑）" });
      const instruction = String(parsed.instruction || "").trim();
      if (!instruction) return JSON.stringify({ ok: false, error: "缺少instruction（描述每個項目要做什麼處理，例如'用fs_read_file讀取這個檔案的內容並摘要'）" });
      try {
        const results = await fa.runBatchSubAgents(items, instruction, parsed.concurrency);
        return JSON.stringify({ ok: true, results });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
      }
    },
    {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "要平行處理的項目清單（通常是檔案絕對路徑，可先用fs_list_files/fs_find_file取得）" },
        instruction: { type: "string", description: "每個項目的子任務要做什麼（例如「用fs_read_file讀取這個檔案的內容，摘要它的用途與關鍵內容」）；子agent會自動被提醒「這次只需要處理這一項：<item>」，不用自己在instruction裡重複這句" },
        concurrency: { type: "number", description: "選填，同時執行幾個子任務（1-8），留空用系統預設批次並行度" },
      },
      required: ["items", "instruction"],
      additionalProperties: false,
    }
  );
  // tw_stock_db客製: 2026-09-15使用者實測回報——單一大檔案（30KB+純文字）
  // 整份塞進fs_read_file的tool result後，根模型常常直接reasoning-deadend
  // （只輸出思考過程、生不出最終回覆），使用者對此明確表達強烈不滿並要求：
  // 「大檔案解析都要採用chunks」「不論LLM model能力怎麼樣都可以達到解析
  // 完整的檔案的內容」「送出去的subagent自己可以切chunks，回收的時候找
  // 地方放，最後gather/reduce的時候，如果內容太大，自己也分chunks去合併」。
  // 這裡新增analyze_large_file：單一檔案版的map-reduce（batch_process_items
  // 是「多檔案」版本，這個是「單一大檔案內部切塊」版本，底層共用同一個
  // runBatchSubAgents引擎，語意一致）——
  //   1. Map: 讀完整檔，按字元數切成固定大小區塊，每個區塊各自是一個獨立、
  //      平行、會被retry/model-fallback（見_runSubAgentTask既有機制）的
  //      子任務，不共用彼此的對話歷史，天生涵蓋全文、不依賴AI自己記得要
  //      繼續讀下一段。
  //   2. 每個區塊的原始子任務結果（連同offset/區塊原文）存進
  //      fa._largeFileAnalysisJobs（純JS Map，活在app記憶體裡，不會進到
  //      任何LLM對話上下文）——這就是使用者說的「回收的時候找地方放」，
  //      需要回頭查某個區塊的細節時用get_large_file_analysis_chunk按需
  //      查詢，不用整包塞回對話。
  //   3. Reduce: 把M個區塊結果的『精簡結論』依序合併——如果全部串起來還是
  //      超過REDUCE_CHUNK_CHARS，不會一次全部塞給模型合併，而是先分組、
  //      每組各自再跑一次runBatchSubAgents濃縮成一段，遞迴這個「分組→
  //      濃縮」的過程直到收斂成一份（或夠小可以一次合併），這就是使用者
  //      要求的「reduce階段內容太大時，自己也分chunks去合併」——不管檔案
  //      多大、多少個區塊，最終一定會收斂成一份完整結果，不會因為某一次
  //      合併呼叫本身內容太大而卡住/失敗。
  fa._largeFileAnalysisJobs = fa._largeFileAnalysisJobs || new Map();
  // tw_stock_db客製: 見getAdaptiveFsReadChunkChars()同一段說明——這裡的
  // map/reduce分段大小同樣要跟著contextWindowTokens自動調整，不是寫死的
  // 固定數字，每次呼叫時重新計算。
  const getAdaptiveMapChunkChars = () => fa._getAdaptiveContentBudgetChars(0.1, 6000);
  const getAdaptiveReduceChunkChars = () => fa._getAdaptiveContentBudgetChars(0.1, 6000);
  async function reduceChunkVerdicts(fa, verdictTexts, instruction) {
    let level = verdictTexts.slice();
    let depth = 0;
    while (true) {
      const reduceChunkChars = getAdaptiveReduceChunkChars();
      const combinedLen = level.reduce((s, t) => s + t.length, 0);
      if (level.length <= 1 || combinedLen <= reduceChunkChars) {
        if (level.length === 1 && depth === 0) return { finalText: level[0], reduceDepth: depth };
        const finalPrompt = `以下是針對任務「${instruction}」，依照原始檔案順序切出的多份分析結果（共${level.length}份，可能已經是前幾輪濃縮過的中繼結果），請統整成一份完整、連貫、依序涵蓋每一份重點的最終結果，不要遺漏任何一份提到的具體內容，也不要重複贅述：\n\n${level.map((t, i) => `【第${i + 1}份】\n${t}`).join("\n\n")}`;
        // tw_stock_db客製: 這一次呼叫是繞過runBatchSubAgents直接呼叫
        // _runSubAgentTask，一樣要帶上rpm設定才會被同一個端點的限流計入，
        // 邏輯跟runBatchSubAgents裡resolve rowRpm的方式一致。
        const primaryRow = (fa._getModelRows() || [])[0];
        const rowRpm = primaryRow && primaryRow.requestsPerMinute != null ? primaryRow.requestsPerMinute : null;
        const finalResult = await fa._runSubAgentTask(finalPrompt, undefined, { rateLimitPerMinute: rowRpm });
        return { finalText: finalResult.text, reduceDepth: depth + 1 };
      }
      const groups = [];
      let cur = [];
      let curLen = 0;
      for (const t of level) {
        if (cur.length && curLen + t.length > reduceChunkChars) { groups.push(cur); cur = []; curLen = 0; }
        cur.push(t);
        curLen += t.length;
      }
      if (cur.length) groups.push(cur);
      const groupItems = groups.map((g, i) => `【合併群組${i + 1}／共${groups.length}組，內含${g.length}份分析結果】\n${g.map((t, j) => `- 第${j + 1}份：${t}`).join("\n")}`);
      const batchResult = await fa.runBatchSubAgents(
        groupItems,
        `以下是針對任務「${instruction}」，多份分析結果的其中一組，請把這組結果濃縮成一段連貫摘要，保留具體數據/名稱/關鍵細節，不要只給空泛結論。`
      );
      level = batchResult.map(r => r.verdict);
      depth++;
    }
  }
  fa.register_openai_tool(
    "analyze_large_file",
    `完整解析「單一」大檔案的全部內容——不論檔案多大、不論目前使用的LLM模型能力/穩定度如何，都保證涵蓋檔案從頭到尾每一段內容（內部會自動切成固定大小區塊，各區塊獨立平行處理、各自重試，不依賴單次模型呼叫的穩定度；彙整階段內容太大時也會自動分組遞迴濃縮，不會因為單次合併內容過大而失敗）。**任何時候使用者要求完整解析/摘要/分析一個可能較大的檔案（尤其大於數KB、或使用者明確提到大檔案/完整內容），都應該優先用這個工具，不要自己用fs_read_file手動分段讀取再逐段記憶**（那樣依賴你自己記得要繼續讀下一段、且大量原始內容會塞進對話歷史，正是造成模型當機的原因）。這個工具只回傳最終彙整結果；如果之後需要查某個特定區塊的原始分析細節，用get_large_file_analysis_chunk按job_id查詢。參數: {"path":"/home/user/big.xml","instruction":"摘要這份檔案的用途、結構與關鍵內容"}`,
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      const path = parsed.path;
      const instruction = String(parsed.instruction || "").trim();
      if (!path) return JSON.stringify({ ok: false, error: "缺少path" });
      if (!instruction) return JSON.stringify({ ok: false, error: "缺少instruction（描述要對這個檔案做什麼分析/摘要）" });
      let fileResult;
      try { fileResult = await window.desktopAPI.rawfs.readFile(path, "auto"); }
      catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
      if (!fileResult || typeof fileResult.text !== "string" || fileResult.likely_binary) {
        return JSON.stringify({ ok: false, error: "這個工具只支援純文字檔案的完整分段解析，偵測到疑似二進位內容，請改用fs_read_file。" });
      }
      const fullText = fileResult.text;
      const chunkChars = Number.isFinite(Number(parsed.chunkChars)) && Number(parsed.chunkChars) > 0 ? Math.floor(Number(parsed.chunkChars)) : getAdaptiveMapChunkChars();
      const offsets = [];
      for (let i = 0; i < fullText.length; i += chunkChars) offsets.push(i);
      if (!offsets.length) return JSON.stringify({ ok: true, path, totalChars: 0, totalChunks: 0, finalText: "（檔案是空的）" });
      const chunkTexts = offsets.map(o => fullText.slice(o, o + chunkChars));
      const items = chunkTexts.map((t, i) => `【區塊${i + 1}/${offsets.length}（第${offsets[i]}~${offsets[i] + t.length}字元）】\n${t}`);
      let mapResults;
      try {
        mapResults = await fa.runBatchSubAgents(items, `這是檔案「${path}」其中一個區塊（已標明第幾區塊/字元範圍），請只針對這個區塊的內容執行以下任務，不要假設看得到檔案其他部分，也不要提到「這只是一部分」這類後設說明：${instruction}`, parsed.concurrency);
      } catch (err) {
        return JSON.stringify({ ok: false, error: `區塊分析失敗: ${String(err.message || err)}` });
      }
      const jobId = `lfa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      fa._largeFileAnalysisJobs.set(jobId, {
        path, instruction, createdAt: Date.now(),
        chunks: mapResults.map((r, i) => ({ index: i, offset: offsets[i], text: chunkTexts[i], verdict: r.verdict })),
      });
      const reduced = await reduceChunkVerdicts(fa, mapResults.map(r => r.verdict), instruction);
      return JSON.stringify({
        ok: true, path, totalChars: fullText.length, totalChunks: offsets.length,
        job_id: jobId, finalText: reduced.finalText,
        note: `已切成${offsets.length}個區塊各自分析後彙整（彙整遞迴深度${reduced.reduceDepth}）。需要查特定區塊的原始分析時用get_large_file_analysis_chunk({"job_id":"${jobId}","chunk_index":0})。`,
      });
    },
    {
      type: "object",
      properties: {
        path: { type: "string", description: "絕對路徑" },
        instruction: { type: "string", description: "要對這個檔案做什麼分析/摘要/擷取，例如「摘要這份檔案的用途、結構與關鍵內容」" },
        chunkChars: { type: "number", description: `選填，每個區塊的字元數，預設依目前模型的上下文容量設定自動調整（目前約${getAdaptiveMapChunkChars()}）` },
        concurrency: { type: "number", description: "選填，同時處理幾個區塊（1-8），留空用系統預設" },
      },
      required: ["path", "instruction"],
      additionalProperties: false,
    }
  );
  fa.register_openai_tool(
    "get_large_file_analysis_chunk",
    "查詢analyze_large_file某次執行中，某個特定區塊的原始分析結果與原文片段（按需查詢，不會自動出現在analyze_large_file的回應裡，避免污染對話歷史）。參數: {\"job_id\":\"lfa_...\",\"chunk_index\":0}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      const job = fa._largeFileAnalysisJobs.get(String(parsed.job_id || ""));
      if (!job) return JSON.stringify({ ok: false, error: "找不到這個job_id（可能是打錯，或app重新啟動後記憶體已清空）" });
      const idx = Number(parsed.chunk_index);
      if (!Number.isFinite(idx) || idx < 0 || idx >= job.chunks.length) {
        return JSON.stringify({ ok: false, error: `chunk_index超出範圍，這個job共有${job.chunks.length}個區塊（0~${job.chunks.length - 1}）` });
      }
      return JSON.stringify({ ok: true, path: job.path, totalChunks: job.chunks.length, chunk: job.chunks[idx] });
    },
    {
      type: "object",
      properties: { job_id: { type: "string" }, chunk_index: { type: "number" } },
      required: ["job_id", "chunk_index"],
      additionalProperties: false,
    }
  );
  fa.register_openai_tool(
    "fs_mkdir",
    "直接在這台電腦上任意路徑建立資料夾（含父資料夾，已存在則不報錯），不需要先授權/註冊資料夾。參數: {\"path\":\"/home/user/new-folder\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const r = await window.desktopAPI.rawfs.mkdir(parsed.path);
        return JSON.stringify({ ok: true, ...r });
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    fsToolSchema()
  );
  fa.register_openai_tool(
    "fs_remove",
    "直接刪除這台電腦上任意路徑的檔案/資料夾，不需要先授權/註冊資料夾。這是破壞性操作，執行前務必先跟使用者確認清楚要刪的確切路徑，不要自作主張刪除。參數: {\"path\":\"/home/user/tmp-file.txt\",\"recursive\":false}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const r = await window.desktopAPI.rawfs.remove(parsed.path, !!parsed.recursive);
        return JSON.stringify({ ok: true, ...r });
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    fsToolSchema({ recursive: { type: "boolean", description: "刪除的是非空資料夾時要傳true，否則會失敗" } })
  );

  // ─── coding domain專用工具（TODO.md Phase 4）────────────────────────────
  // 設計原則：模型太弱，不能依賴它記住進度/自己組對的git指令/手寫合法JSON
  // 狀態檔——狀態外部化成檔案、寫入只走結構化action，工具本身擁有格式跟驗證。
  const capGitOutput = (r) => {
    if (!r || typeof r !== "object") return r;
    const max = fa._getAdaptiveContentBudgetChars(0.15, 8000);
    const out = { ...r };
    for (const k of ["stdout", "stderr"]) {
      if (typeof out[k] === "string" && out[k].length > max) {
        out[k] = out[k].slice(0, max) + `\n…（已截斷，原本${r[k].length}字元）`;
        out.truncated = true;
      }
    }
    return out;
  };

  fa.register_openai_tool(
    "apply_git_patch",
    "用git apply套用一份unified diff（git diff格式）到指定git repo——**修改程式碼的唯一入口**。內部一定先做`git apply --check`乾跑：乾跑失敗時完全不會碰任何檔案，並把git原始錯誤文字放在stderr回傳（例如context對不上、路徑錯誤），請仔細讀stderr、重新用fs_read_file讀取檔案「最新」內容後重寫patch，不要原封不動重送。patch格式要求：`--- a/路徑`／`+++ b/路徑`檔頭、`@@ -起始行,行數 +起始行,行數 @@` hunk header、每個hunk前後至少3行未變更的context行（以一個空白開頭）、刪除行以`-`開頭、新增行以`+`開頭；新增檔案用`--- /dev/null`＋`+++ b/路徑`。參數: {\"cwd_abs\":\"/home/user/project\",\"patch\":\"--- a/src/x.js\\n+++ b/src/x.js\\n@@ -1,3 +1,3 @@\\n ...\",\"check_only\":false}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      if (!parsed.cwd_abs) return JSON.stringify({ ok: false, error: "缺少cwd_abs（git repo的絕對路徑）" });
      if (!parsed.patch) return JSON.stringify({ ok: false, error: "缺少patch內容" });
      try {
        const r = await window.desktopAPI.git.applyPatch(String(parsed.cwd_abs), String(parsed.patch), {
          checkOnly: !!parsed.check_only,
          strip: parsed.strip,
        });
        return JSON.stringify(capGitOutput(r));
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    {
      type: "object",
      properties: {
        cwd_abs: { type: "string", description: "目標git repo（或其子資料夾）的絕對路徑" },
        patch: { type: "string", description: "完整的unified diff文字" },
        check_only: { type: "boolean", description: "選填，true=只乾跑驗證、不真的套用。預設false（乾跑通過後直接套用）" },
        strip: { type: "number", description: "選填，git apply -p<n>，預設1（對應標準的a/ b/前綴）" },
      },
      required: ["cwd_abs", "patch"],
      additionalProperties: false,
    }
  );

  fa.register_openai_tool(
    "git_inspect",
    "唯讀查看git repo狀態，或把單一檔案還原到最後一次commit的乾淨狀態。mode: status（目前變更/是不是git repo）、diff（未commit的實際變更內容，可用path限定單一檔案、staged=true看已staged的）、log（最近commit，max_commits預設20）、restore（`git checkout -- <path>`，把path那個檔案還原到最後一次commit——檔案被patch弄壞/語法檢查失敗時用，還原後再重新讀檔重寫patch，不要在壞掉的版本上疊加）。參數: {\"cwd_abs\":\"/home/user/project\",\"mode\":\"diff\",\"path\":\"src/x.js\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      if (!parsed.cwd_abs) return JSON.stringify({ ok: false, error: "缺少cwd_abs" });
      try {
        const r = await window.desktopAPI.git.inspect(String(parsed.cwd_abs), parsed.mode || "status", {
          path: parsed.path, staged: !!parsed.staged, maxCommits: parsed.max_commits,
        });
        return JSON.stringify(capGitOutput(r));
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    {
      type: "object",
      properties: {
        cwd_abs: { type: "string", description: "git repo的絕對路徑" },
        mode: { type: "string", enum: ["status", "diff", "log", "restore"], description: "預設status" },
        path: { type: "string", description: "選填，diff限定單一檔案；restore模式必填（要還原哪個檔案）" },
        staged: { type: "boolean", description: "選填，diff模式：true=看已staged的變更" },
        max_commits: { type: "number", description: "選填，log模式最多列幾筆，預設20" },
      },
      required: ["cwd_abs"],
      additionalProperties: false,
    }
  );

  // coding_task_state：狀態機本體已搬進floating-assistant.js（_codingStateAction，
  // 網頁版共用同一份邏輯），這裡只負責提供桌面版的檔案io（rawfs絕對路徑）。
  const joinP = (base, ...parts) => [String(base).replace(/[\\/]+$/, ""), ...parts].join("/");
  const codingDesktopIo = (cwd) => ({
    async readText(rel) {
      try { const r = await window.desktopAPI.rawfs.readFile(joinP(cwd, rel)); return typeof r.text === "string" ? r.text : null; }
      catch (_) { return null; }
    },
    writeText: (rel, text) => window.desktopAPI.rawfs.writeFile(joinP(cwd, rel), { text }),
    remove: (rel) => window.desktopAPI.rawfs.remove(joinP(cwd, rel), false),
    async listNames(rel) {
      try { const r = await window.desktopAPI.rawfs.readdir(joinP(cwd, rel)); return (r.entries || r || []).map((e) => (typeof e === "string" ? e : e.name)); }
      catch (_) { return []; }
    },
    describe: (rel) => joinP(cwd, rel),
  });
  fa.register_openai_tool(
    "coding_task_state",
    "管理程式設計任務的持久化狀態（TODO清單／目前階段／設計索引），存在目標專案資料夾的.floating-assistant/coding-task-state.json、DESIGN-INDEX.md、tests/。**處理coding任務前第一件事永遠是action:get讀取真實狀態，不要假設記得之前做到哪。** action：get（讀狀態，沒有時exists:false）；init（title,requirements,design=照Plan Template寫的設計文字,todos=[{text,files_hint}]，建立新任務）；add_todo（text,position=now|next|end，插入新TODO；使用者中途插隊要求用now）；update_todo（id,status=pending|in_progress|blocked,notes）；complete_todo（id,design_summary,source_locations[],entry_points[]，標記完成並自動append DESIGN-INDEX.md）；record_test_result（todo_id,command,stdout,stderr,passed，存進tests/）；set_phase（phase=requirements_analysis|design|planning|executing|blocked|done）。參數: {\"cwd_abs\":\"/home/user/project\",\"action\":\"get\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      const cwd = String(parsed.cwd_abs || "").trim();
      if (!cwd) return JSON.stringify({ ok: false, error: "缺少cwd_abs（目標專案資料夾的絕對路徑）" });
      return JSON.stringify(await fa._codingStateRun(cwd, parsed, codingDesktopIo(cwd)));
    },
    {
      type: "object",
      properties: {
        cwd_abs: { type: "string", description: "目標專案資料夾的絕對路徑" },
        action: { type: "string", enum: ["get", "init", "add_todo", "update_todo", "complete_todo", "record_test_result", "set_phase"] },
        title: { type: "string" }, requirements: { type: "string" }, design: { type: "string" },
        todos: { type: "array", items: { type: "object", properties: { text: { type: "string" }, files_hint: { type: "array", items: { type: "string" } } } } },
        force: { type: "boolean" },
        text: { type: "string" }, position: { type: "string", enum: ["now", "next", "end"] }, files_hint: { type: "array", items: { type: "string" } },
        id: { type: "number" }, status: { type: "string", enum: ["pending", "in_progress", "blocked"] }, notes: { type: "string" },
        design_summary: { type: "string" }, source_locations: { type: "array", items: { type: "string" } }, entry_points: { type: "array", items: { type: "string" } },
        todo_id: { type: "number" }, command: { type: "string" }, stdout: { type: "string" }, stderr: { type: "string" }, passed: { type: "boolean" },
        phase: { type: "string", enum: ["requirements_analysis", "design", "planning", "executing", "blocked", "done"] },
      },
      required: ["cwd_abs", "action"],
      additionalProperties: true,
    }
  );

  // tw_stock_db客製: 2026-09-15使用者明確要求「執行指令也要有有bash, tmux
  // 的能力」——run_command每次呼叫都是獨立、跑完就結束的子行程，沒辦法讓
  // 一個長時間執行/互動式程式（開發伺服器、REPL等）跨越多次工具呼叫維持
  // 狀態。tmux讓AI可以開一個具名session、之後分好幾次送鍵入/讀畫面，模擬
  // 真人打開一個終端機視窗持續操作。POSIX限定（main.js的
  // requireTmuxAvailable），Windows上呼叫會得到明確的「這個平台不支援」
  // 錯誤，不是靜默失敗。
  const tmuxToolBase = { type: "object", properties: { name: { type: "string", description: "tmux session名稱（自己取一個好記的，例如dev-server）" } }, required: ["name"], additionalProperties: false };
  fa.register_openai_tool(
    "tmux_start_session",
    "開一個新的tmux具名session（背景執行，不會卡住對話），可選擇性在session裡直接跑一個初始指令（例如啟動一個開發伺服器）。之後用tmux_send_keys送指令進去、tmux_capture_pane讀畫面內容。跟run_command一樣需要「允許AI執行程式」已開啟，且預設會跳確認視窗。參數: {\"name\":\"dev-server\",\"command\":\"npm run dev\",\"cwd\":\"/home/user/project\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const r = await window.desktopAPI.tmux.start(parsed.name, parsed.command, parsed.cwd);
        return JSON.stringify(r);
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    { ...tmuxToolBase, properties: { ...tmuxToolBase.properties, command: { type: "string", description: "選填，session建立後立刻執行的初始指令" }, cwd: { type: "string", description: "選填，session的工作目錄絕對路徑，留空則用使用者家目錄" } } }
  );
  fa.register_openai_tool(
    "tmux_send_keys",
    "把一段按鍵/指令送進一個已經存在的tmux session（模擬在終端機裡打字+按Enter）。跟run_command一樣需要確認。參數: {\"name\":\"dev-server\",\"keys\":\"ls -la\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const r = await window.desktopAPI.tmux.sendKeys(parsed.name, parsed.keys, parsed.enter !== false);
        return JSON.stringify(r);
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    { ...tmuxToolBase, properties: { ...tmuxToolBase.properties, keys: { type: "string", description: "要送進去的按鍵/指令內容" }, enter: { type: "boolean", description: "選填，送出後是否自動按Enter，預設true" } }, required: ["name", "keys"] }
  );
  fa.register_openai_tool(
    "tmux_capture_pane",
    "讀取一個tmux session目前畫面上的文字內容（純讀取，不會執行/改變任何東西，不需要確認視窗）。參數: {\"name\":\"dev-server\",\"lines\":200}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try {
        const r = await window.desktopAPI.tmux.capture(parsed.name, parsed.lines);
        return JSON.stringify(r);
      } catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    { ...tmuxToolBase, properties: { ...tmuxToolBase.properties, lines: { type: "number", description: "選填，往回讀取的行數（含scrollback），預設只讀目前畫面" } } }
  );
  fa.register_openai_tool(
    "tmux_list_sessions",
    "列出目前所有tmux session名稱（純讀取，不需要確認視窗）。無參數。",
    async () => {
      try { return JSON.stringify(await window.desktopAPI.tmux.list()); }
      catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    { type: "object", properties: {}, additionalProperties: false }
  );
  fa.register_openai_tool(
    "tmux_kill_session",
    "結束並移除一個tmux session（裡面還在跑的程式會一併被終止）。跟run_command一樣需要確認。參數: {\"name\":\"dev-server\"}",
    async (rawArgs) => {
      let parsed = {};
      try { parsed = await fa.repairJsonPayload(String(rawArgs || "{}")); } catch (_) {}
      try { return JSON.stringify(await window.desktopAPI.tmux.kill(parsed.name)); }
      catch (err) { return JSON.stringify({ ok: false, error: String(err.message || err) }); }
    },
    tmuxToolBase
  );

  const platformLabel = window.desktopAPI.platform.isWindows ? "Windows" : (window.desktopAPI.platform.isMac ? "macOS" : "Linux");
  fa.register_domain("desktop_ops", {
    enabled: true,
    label: "本機直接檔案存取與程式執行（桌面版限定）",
    toolNames: [
      "run_command",
      "tmux_start_session", "tmux_send_keys", "tmux_capture_pane", "tmux_list_sessions", "tmux_kill_session",
      "fs_read_file", "fs_write_file", "fs_list_files", "fs_find_file", "fs_stat", "fs_mkdir", "fs_remove",
      "batch_process_items", "analyze_large_file", "get_large_file_analysis_chunk",
      "fap_write_file", "fap_read_file", "fap_list_files", "fap_find_file",
      "fap_copy_from_storage", "fap_copy_to_storage", "list_file_access_points",
    ],
    systemPrompt:
      `你是桌面版FloatingAssistant專用的子任務助理。這台電腦目前跑的是${platformLabel}，下指令/挑工具時要符合這個平台的慣例（例如${window.desktopAPI.platform.isWindows ? "路徑分隔字元是反斜線、列目錄用dir、環境變數用%VAR%或$env:VAR" : "路徑分隔字元是斜線、列目錄用ls、環境變數用$VAR"}）。\n\n檔案存取有兩組工具：fap_*系列操作使用者已明確授權（在「檔案存取管理」清單裡）的資料夾，ref格式\`fap:<名稱或id>[/<路徑>]\`；fs_*系列（fs_read_file/fs_write_file/fs_list_files/fs_find_file/fs_stat/fs_mkdir/fs_remove）直接吃絕對路徑，完全不需要先授權/註冊資料夾，能讀寫這台電腦上任何fs_*呼叫端OS帳號有權限碰到的路徑——使用者已經明確要求桌面版檔案存取不應該有範圍限制，這是刻意設計，不是漏洞；即使使用者只分享了一個父資料夾，AI也可以直接用fs_*工具存取它底下任何子路徑，不用要求使用者額外新增授權。寫入/刪除操作如果內容/目標路徑是你自己推測/發明出來的（使用者沒有講清楚），要先跟使用者確認清楚；**但如果委派給你的task裡已經明確講清楚要寫什麼內容、寫到哪個路徑（例如使用者原始請求就指定了確切的資料夾、檔名、腳本內容/用途），代表使用者已經確認過了，直接執行即可，不要多此一舉再問一次「請問我可以嗎」**——這種情況下你唯一該做的是實際呼叫fs_write_file/run_command把事情做完，然後回報結果；反覆問同一個已經被明確授權的問題，只會讓使用者以為你完全沒有動作、在敷衍了事。\n\n**重要：處理「多個檔案/多個獨立項目」的任務時，先判斷數量。** 用fs_list_files/fs_find_file列出清單後，如果需要逐一讀取/處理的項目數量較多（大致抓3-5個以上），一定要改用batch_process_items把每個項目獨立委派給平行子任務處理（map），自己再統整這些精簡結論（reduce）——絕對不要自己一個個sequentially呼叫fs_read_file，把所有檔案的完整原始內容都累積進同一個對話歷史。這不只是效率考量：這個對話歷史是有限的，逐一累積大量檔案內容容易造成上下文快速膨脹，明顯提高模型某一輪只給出內部思考、沒有實際結論就結束的機率（處理的檔案越多，風險越高）。項目數量少（1-2個）時直接自己讀取即可，不需要為了一兩個檔案就特地委派。\n\nrun_command會透過真正的shell執行（${window.desktopAPI.platform.isWindows ? "Git Bash/PowerShell/cmd.exe，依序嘗試" : "bash"}），管線/重導向/&&等shell語法都能用，一次性、跑完就結束；tmux_*系列（tmux_start_session/tmux_send_keys/tmux_capture_pane/tmux_list_sessions/tmux_kill_session，僅Linux/macOS）則是持久化的具名session，適合需要跨多次工具呼叫維持狀態的情境（長時間執行的伺服器、REPL互動等），Windows上呼叫會直接回報不支援。這幾個工具風險最高：指令內容是你自己推測/發明出來的時候，執行前要先跟使用者確認清楚；**如果使用者的原始請求已經明確講清楚要跑什麼（例如指定了要產生並執行的具體腳本），就不需要再多問一次，直接呼叫run_command即可**——真正的人工把關是呼叫當下跳出的原生確認對話框（使用者當場按「執行」才會真的跑），不是你自己在文字裡先問一輪。使用者必須已經在Advance設定（⚙️）的「桌面版設定」分頁開啟「允許AI執行程式」才能真正執行（沒開啟時呼叫會直接失敗並清楚說明原因，這種情況下如實告知使用者去哪裡開啟，不要自己瞎猜原因）。

**寫程式/修bug/實作功能/重構這類程式設計任務不是這個domain的工作**——那類任務要用coding領域的固定流程（git patch修改、語法檢查、測試、可恢復的TODO狀態），不要在這裡用fs_write_file直接改寫程式碼；如果收到這類任務，在回覆裡明確指出應改委派給coding領域。`,
  });


  // ─── coding domain（TODO.md Phase 4）──────────────────────────────────
  // 專為弱模型（nemotron/gpt-oss/qwen/gemma）設計：狀態外部化成檔案、
  // 修改一律走git patch、流程逐步強制。刻意沒有fs_write_file/fs_remove——
  // 模型手上沒有能繞過patch流程的工具。
  fa.register_domain("coding", {
    enabled: true,
    label: "程式設計（需求分析／設計計畫／git patch實作／語法檢查／測試／修bug，可中斷恢復，桌面版限定）",
    toolNames: [
      "fs_read_file", "fs_list_files", "fs_find_file", "fs_stat",
      "batch_process_items", "analyze_large_file", "get_large_file_analysis_chunk",
      "run_command",
      "apply_git_patch", "git_inspect", "coding_task_state",
    ],
    systemPrompt: fa._buildCodingSystemPrompt({ kind: "desktop", platformLabel }),
  });

  // tw_stock_db客製: 2026-09-15使用者實測回報（Linux桌面版真實對話記錄）——
  // 即使multiSubAgentMode設成'router'/'hierarchical'，根模型還是直接呼叫了
  // fs_list_files/fs_read_file、逐一sequentially讀了好幾個檔案，完全沒有
  // 透過delegate_to_subagent委派，也完全沒用到batch_process_items，最後在
  // 根層級對話本身（不是_runSubAgentTask）撞上「這一輪模型只輸出思考過程」
  // 而放棄。追查發現：core的`_getRootToolNames()`只會排除靠
  // `_registerBuiltinAiTools()`內部`registerOptional`包裝註冊、進而被記錄進
  // `this._domainGatedToolNames`的25個內建工具——這裡用公開的
  // `register_openai_tool()`API註冊的run_command/tmux_*/fs_*/
  // batch_process_items從來沒有被加進那個Set，所以即使已經用
  // `register_domain('desktop_ops', {...})`把它們歸進一個domain，它們仍然
  // 跟一般host工具一樣無條件曝光在根層級——`register_domain`只是告訴
  // delegate_to_subagent「委派到這個domain時可以用哪些工具」，從來不會反過來
  // 「因為被歸進某個domain，就該從根層級隱藏」，這兩件事必須分開做，先前
  // 漏掉了後者。這裡比照core內部`registerOptional`的機制，手動把這些工具
  // 名稱加進`fa._domainGatedToolNames`（雖然是`_`開頭的instance屬性、不是
  // 正式公開API，但目前沒有其他公開管道能做到「host自己註冊的工具也要
  // domain-gated」，等floating-assistant.js之後補上正式API再改用那個）。
  // 加了這個之後，根模型在router/full/hierarchical模式下就完全看不到、
  // 叫不到這些工具，只能透過delegate_to_subagent委派給desktop_ops
  // domain——這樣一來batch_process_items的map-reduce設計才會真正被強制
  // 用上，不會再被根模型繞過去直接sequentially呼叫fs_read_file。
  // 'off'模式（完全沒有subagent委派）不受影響：_getRootToolNames()對
  // mode==='off'的分支本來就無視_domainGatedToolNames、回傳全部工具，這組
  // 桌面工具在'off'模式下維持原本「直接掛根層級」的行為，跟其他domain-gated
  // 工具的既有規則完全一致。
  [
    "run_command",
    "tmux_start_session", "tmux_send_keys", "tmux_capture_pane", "tmux_list_sessions", "tmux_kill_session",
    "fs_read_file", "fs_write_file", "fs_list_files", "fs_find_file", "fs_stat", "fs_mkdir", "fs_remove",
    "batch_process_items", "analyze_large_file", "get_large_file_analysis_chunk",
    "apply_git_patch", "git_inspect", "coding_task_state",
  ].forEach((name) => fa._domainGatedToolNames.add(name));

  // tw_stock_db客製: 2026-09-18使用者要求（TODO.md Phase 3第一項）——
  // floating-assistant.js的SUBAGENT_DOMAIN_REGISTRY已經定義了web+desktop
  // 都適用的「research」domain基礎版（FAP唯讀工具），這裡疊加桌面版限定
  // 的唯讀真實檔案系統工具（fs_read_file/fs_list_files/fs_find_file/
  // fs_stat——刻意不含fs_write_file/fs_remove/run_command，這個domain的
  // 精神就是「只讀不動手」）。用「先讀現有toolNames、合併、整段
  // register_domain()寫回去」的方式疊加，不是憑空覆寫——這樣才不會把
  // floating-assistant.js已經定義好的FAP工具跟systemPrompt整段蓋掉，跟
  // desktop_ops是全新domain（可以直接整段定義）不同，這裡是在既有domain
  // 上疊加桌面限定能力。fs_*這幾個名稱已經在上面被加進_domainGatedToolNames
  // 了（跟desktop_ops共用同一份桌面工具，不用再加一次）。
  {
    const baseResearch = fa.domains.research || { toolNames: [], systemPrompt: '' };
    const desktopReadOnlyTools = ["fs_read_file", "fs_list_files", "fs_find_file", "fs_stat"];
    fa.register_domain("research", {
      enabled: true,
      label: baseResearch.label || '研究／程式碼與檔案分析（唯讀，不修改/不執行）',
      toolNames: [...new Set([...(baseResearch.toolNames || []), ...desktopReadOnlyTools])],
      systemPrompt: baseResearch.systemPrompt + `\n\n[桌面版補充] 這台電腦目前跑的是${platformLabel}，除了FAP唯讀工具，也可以用fs_read_file/fs_list_files/fs_find_file/fs_stat直接讀取任意真實磁碟絕對路徑（不需要先授權/註冊資料夾）——同樣是唯讀，這個domain完全沒有fs_write_file/fs_remove/run_command。**如果任務其實是要寫程式/修bug/實作功能，要明確指出應改委派給coding領域（有git patch＋測試＋可恢復進度的固定流程），不是desktop_ops。**任務裡如果提到相對路徑、或沒有明確給出根目錄，先參考目前的workspace目錄（見下面動態補充的實際路徑）當作起點。`,
    });
    fa.setDomainNote("research", () => `目前workspace目錄：${activeWorkspaceFolder || '（尚未設定）'}`);
  }

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

  // tw_stock_db客製: 2026-09-15使用者要求——把原本擠在頂部列的「🔑設定API
  // 金鑰」「允許AI執行程式」「每次執行前跳確認框」搬進Advance設定，只留
  // 「📁直接輸入路徑新增資料夾」在外層。
  // tw_stock_db客製: 2026-09-18使用者實測回報的真實回歸修復——這裡原本是
  // 自己動手把.ai-advanced-cat節點insertBefore塞進.ai-advanced-sidebar，
  // Advance設定分組功能（AI/多媒體/桌面程式單機三組，可展開收合）上線後，
  // 每次_renderAdvancedSettings()都會整個重建sidebar的innerHTML，手動插入
  // 的節點活不過第一次重繪，導致這個分頁憑空消失（_renderAdvancedSettings()
  // 幾乎任何設定變動都會觸發，不是罕見情境）。改用引擎新提供的
  // fa.registerAdvancedSettingsTab(groupKey, catKey, label, paneElement)——
  // 跟setEnvironmentNote/setDomainNote/appendToolDescription同一批
  // host-override公開API，這裡把整份pane內容（含真實搬移過來、監聽器
  // 完全不受影響的按鈕/checkbox）掛進本來就是空的'desktop'這一組（見
  // ADVANCED_SETTINGS_GROUPS，桌面程式/單機專屬設定的容器），之後每次
  // sidebar重繪都會正確涵蓋這個cat，不會再被沖掉。
  if (advancedModal) {
    const relocatedContainer = document.getElementById("topbar-relocated-controls");
    if (relocatedContainer) {
      const pane = document.createElement("div");
      pane.innerHTML = `
        <div class="ai-advanced-stack">
          <label class="ai-advanced-label">API 金鑰</label>
          <p class="ai-advanced-hint">NVIDIA／OpenRouter金鑰存在本機secrets.json，不會出現在畫面上、也不會傳到聊天內容——按下面按鈕即可設定，桌面版不需要另外部署雲端Worker。</p>
          <div id="desktop-settings-secrets-slot"></div>
        </div>
        <div class="ai-advanced-stack">
          <label class="ai-advanced-label">程式執行權限</label>
          <p class="ai-advanced-hint">AI是否可以透過run_command在這台電腦上直接執行程式/指令——執行本身風險最高，預設每次執行前都會跳出原生確認視窗，顯示完整指令內容，由你親自按「執行」才會真的跑。</p>
          <div id="desktop-settings-exec-slot" style="display:flex; flex-direction:column; gap:8px;"></div>
        </div>
        <div class="ai-advanced-stack">
          <label class="ai-advanced-label">工作區資料夾</label>
          <p class="ai-advanced-hint">對話紀錄跟這裡的所有設定都存在這個資料夾底下的隱藏子資料夾<code>.floating-assistant</code>裡，不同資料夾各自獨立。預設是啟動當下的目錄（例如從終端機<code>cd</code>到某個專案再啟動）；GUI捷徑啟動時目錄常常不是你真正在用的資料夾，可以在這裡手動切換。切換資料夾時，目前的設定（金鑰／模型清單／偏好等）會複製過去，但目前的對話紀錄不會帶過去——新資料夾一律是全新的對話。</p>
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <code id="desktop-workspace-folder-path" style="flex:1; min-width:200px; padding:6px 8px; background:rgba(0,0,0,0.2); border-radius:6px; font-size:12px; word-break:break-all;"></code>
            <button type="button" id="desktop-workspace-switch-btn" class="ai-advanced-btn">切換資料夾…</button>
          </div>
        </div>
      `;

      pane.querySelector("#desktop-settings-secrets-slot").appendChild(document.getElementById("topbar-secrets-btn"));
      const execSlot = pane.querySelector("#desktop-settings-exec-slot");
      // exec-enabled/exec-confirm的<label>本身包住checkbox+文字，整個搬過去
      // 即可，樣式沿用.ai-advanced-label的checkbox常見排版（inline-flex）。
      const execEnabledLabel = document.getElementById("topbar-exec-enabled").closest("label");
      const execConfirmLabel = document.getElementById("topbar-exec-confirm").closest("label");
      if (execEnabledLabel) { execEnabledLabel.style.cssText = "display:flex; align-items:center; gap:6px; cursor:pointer;"; execSlot.appendChild(execEnabledLabel); }
      if (execConfirmLabel) { execConfirmLabel.style.cssText = "display:flex; align-items:center; gap:6px; cursor:pointer;"; execSlot.appendChild(execConfirmLabel); }
      relocatedContainer.remove();

      const workspacePathEl = pane.querySelector("#desktop-workspace-folder-path");
      if (workspacePathEl) workspacePathEl.textContent = activeWorkspaceFolder;
      const workspaceSwitchBtn = pane.querySelector("#desktop-workspace-switch-btn");
      if (workspaceSwitchBtn) {
        workspaceSwitchBtn.addEventListener("click", async () => {
          const picked = await window.desktopAPI.roots.browse(activeWorkspaceFolder);
          if (!picked || picked === activeWorkspaceFolder) return;
          // tw_stock_db客製: 使用者原話「如果目前已經有設定，在裡面改
          // folder，就copy configure過去，但是對話清除」——這裡決定哪些
          // key算「設定」（複製）、哪些算「對話」（清除），只有這裡需要
          // 知道floating-assistant.js的實際key常數（main.js刻意不寫死
          // 任何一個，見fa:workspace:switch的說明，維持host-agnostic
          // 分工原則）：CHAT_HISTORY_KEY（訊息本體）／HISTORY_KEY（打過
          // 的指令輸入歷史）算「對話」，清除；其餘（Advance設定、legacy
          // 單一API欄位、model benchmark卡片、原生tool_calls探測快取等）
          // 都算「設定」，複製過去。
          const ok = window.confirm(
            `確定要切換工作區資料夾嗎？\n\n新資料夾：\n${picked}\n\n` +
            `目前的設定（API金鑰／模型清單／偏好設定等）會複製過去，` +
            `但目前的對話紀錄不會帶過去（新資料夾會是全新的對話）。這個動作無法復原，確定要繼續嗎？`
          );
          if (!ok) return;
          const CHAT_RELATED_KEYS = new Set([fa.CHAT_HISTORY_KEY, fa.HISTORY_KEY].filter(Boolean));
          const copiedData = {};
          for (const [k, v] of workspaceCache.entries()) {
            if (!CHAT_RELATED_KEYS.has(k)) copiedData[k] = v;
          }
          const result = await window.desktopAPI.workspace.switchTo(picked, copiedData);
          if (!result.ok) {
            window.alert(`切換工作區資料夾失敗：${result.error}`);
            return;
          }
          location.reload();
        });
      }

      fa.registerAdvancedSettingsTab("desktop", "desktop-app", "桌面版設定", pane);
    }
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

  // tw_stock_db客製: 2026-09-16使用者要求——CLI模式(`-p`，見main.js
  // runCliPrompt的說明)需要知道「這個main() IIFE整個跑完了、fa已經建構好
  // 且run_command等工具都註冊完」才能安全送prompt/覆蓋window.confirm等，
  // 單純輪詢`window.fa`存不存在不夠（IIFE中間就已經`window.fa = fa`，
  // 但proxy設定/secrets/run_command註冊等後續步驟那時候都還沒跑完）。這個
  // flag是整個IIFE最後一行才設，純粹是給CLI模式輪詢用的完成訊號，不影響
  // GUI既有的任何行為/順序。
  window.__faBootstrapReady = true;
})();
