/* 設計抉擇與 framework 目錄（FaDesign）：UML 確定之後，就是「選架構、選各領域的 library」——把它變成選擇題與填空題。
 *
 *   ① 預先建立好的常見 framework 與抉擇（資料表）：架構風格、各個關注點（對外介面、持久化、驗證、測試、記錄、設定、HTTP 客戶端、認證、訊息、排程）的選項，
 *      每個選項有適用條件、各語言對應的 library、取捨說明。
 *   ② 推薦（程式）：從情境的關鍵字推出「需要哪些關注點」，每個關注點算出各選項的分數，贏的就程式決定；平手才變成選擇題給模型；使用者／訓練器記得的偏好優先。
 *   ③ 套用（程式，template）：依選擇調整專案配置（分層、service／repository／api／cli 檔案）、依賴清單、進入點；每個決定寫進 README 的「設計決策」表。
 *   ④ 常見設計片段（FRAGMENTS：CRUD 實體、Repository、Service 層、Observer、Strategy、Factory、狀態機、購物車、登入…）：預先建好的 UML 片段，
 *      情境符合就當種子（模型只需要確認與補充）；也是離線訓練器的內建知識（見 DESIGN.uml-framework.md）。
 *   ⑤ top-down 遞迴 rework：由上而下（系統 → 套件 → 類別 → 成員 → 呼叫順序）找出問題、只重做有問題的那一區，上層改了下層再驗證；每個 rework 都是離線訓練器可以學的樣式。
 * 純函式（UMD）；模型（generate）是注入的。
 */
(function (root, factory) {
    const R = (typeof FaRecipe !== 'undefined' && FaRecipe) || (root && root.FaRecipe) || (typeof require === 'function' ? require('../recipe/recipe_core.js') : null);
    const U = (typeof FaUml !== 'undefined' && FaUml) || (root && root.FaUml) || (typeof require === 'function' ? require('./uml_core.js') : null);
    const G = (typeof FaGlue !== 'undefined' && FaGlue) || (root && root.FaGlue) || (typeof require === 'function' ? require('./glue_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(R, U, G);
    else root.FaDesign = factory(R, U, G);
})(typeof self !== 'undefined' ? self : this, function (R, U, G) {
    'use strict';

    // ---------- ① 目錄 ----------
    // 架構風格：適用條件（tags）、說明、取捨
    const ARCH = [
        { id: 'layered', label: '分層架構（api → service → repository → domain）', tags: ['web', 'api', 'db', 'crud'], default: true, notes: '最常見、最好懂；每個使用案例一個 service，資料存取包在 repository。小到中型系統的預設選擇。', tradeoff: '業務邏輯多時 service 會變肥。' },
        { id: 'hexagonal', label: '六角架構（核心領域 + ports/adapters）', tags: ['integration', 'testable', 'multi_io'], notes: '核心不依賴框架，I/O 都透過 port 介面接 adapter；要接多種輸入輸出或要很好測試時選它。', tradeoff: '檔案與間接層較多。' },
        { id: 'cli_script', label: '命令列工具（commands → services → domain）', tags: ['cli'], notes: '每個使用案例一個指令，沒有伺服器。', tradeoff: '不適合長時間運行的服務。' },
        { id: 'library', label: '函式庫（只有 domain，沒有進入點）', tags: ['library', 'sdk'], notes: '只輸出類別與介面，給別的程式引用。', tradeoff: '沒有可以直接執行的東西。' },
        { id: 'event_driven', label: '事件驅動（handlers 訂閱事件）', tags: ['message', 'realtime', 'async'], notes: '用事件解耦；適合通知、工作流程、即時更新。', tradeoff: '除錯與順序較難追。' },
    ];
    // 關注點與選項。libs：各語言對應的 library（pkg＝依賴名稱）；kw：情境裡出現就加分的關鍵字；default：沒有線索時的預設（每個語言）
    const L = (python, typescript, java) => ({ python, typescript, java });
    const CONCERNS = {
        interface: { label: '對外介面', question: '系統怎麼對外提供功能？', options: [
            { id: 'rest', label: 'REST API', kw: ['api', 'rest', 'web', '網站', '網頁', '後端', '伺服器', '服務', 'http', 'endpoint', '前端', '行動'], libs: L('fastapi', 'express', 'spring-boot-web'), tradeoff: '通用，工具多；不適合需要雙向即時的情境。' },
            { id: 'cli', label: '命令列', kw: ['cli', '命令列', '指令', '終端', 'terminal', '批次', 'script', '腳本'], libs: L('typer', 'commander', 'picocli'), tradeoff: '最簡單；沒有圖形介面。' },
            { id: 'library', label: '只當函式庫', kw: ['函式庫', 'library', 'sdk', '套件', '模組'], libs: L('none', 'none', 'none'), tradeoff: '沒有進入點。' },
        ], default: L('rest', 'rest', 'rest') },
        persistence: { label: '資料儲存', question: '資料存在哪裡？', options: [
            { id: 'memory', label: '記憶體（先不持久化）', kw: ['暫存', '記憶體', '原型', 'prototype', 'demo'], libs: L('none', 'none', 'none'), tradeoff: '重啟就消失；最適合先把流程跑通。' },
            { id: 'sqlite', label: 'SQLite（單檔資料庫）', kw: ['sqlite', '本機', '單機', '輕量', '檔案資料庫'], libs: L('sqlalchemy', 'better-sqlite3', 'sqlite-jdbc'), tradeoff: '零設定；併發寫入有限。' },
            { id: 'orm', label: '關聯式資料庫＋ORM', kw: ['資料庫', 'database', 'db', 'sql', '訂單', '會員', '庫存', '交易', 'postgres', 'mysql', '儲存', '持久', '紀錄', '查詢'], libs: L('sqlalchemy', 'prisma', 'spring-data-jpa'), tradeoff: '成熟、可擴充；要管 schema 與遷移。' },
            { id: 'document', label: '文件型資料庫', kw: ['mongodb', '文件', 'json', '彈性結構', 'nosql'], libs: L('pymongo', 'mongodb', 'spring-data-mongodb'), tradeoff: '結構彈性；跨文件交易較弱。' },
        ], default: L('memory', 'memory', 'memory') },
        validation: { label: '資料驗證', question: '輸入資料怎麼驗證？', options: [
            { id: 'schema', label: '型別化 schema 驗證', kw: ['驗證', 'validate', '輸入', '表單', 'api', 'web'], libs: L('pydantic', 'zod', 'jakarta-validation'), tradeoff: '錯誤訊息清楚；多一層宣告。' },
            { id: 'manual', label: '自己在 service 裡檢查', kw: [], libs: L('none', 'none', 'none'), tradeoff: '沒有依賴；容易漏。' },
        ], default: L('schema', 'schema', 'schema') },
        testing: { label: '測試', question: '用什麼測試框架？', options: [
            { id: 'standard', label: '主流測試框架', kw: [], libs: L('pytest', 'vitest', 'junit-jupiter'), tradeoff: '' },
        ], default: L('standard', 'standard', 'standard') },
        logging: { label: '記錄', question: '怎麼記錄？', options: [
            { id: 'stdlib', label: '標準／主流記錄函式庫', kw: [], libs: L('none', 'pino', 'slf4j'), tradeoff: '' },
            { id: 'structured', label: '結構化記錄', kw: ['稽核', 'audit', '追蹤', 'trace', '監控', 'observability'], libs: L('structlog', 'pino', 'logback'), tradeoff: '利於查詢；設定較多。' },
        ], default: L('stdlib', 'stdlib', 'stdlib') },
        http_client: { label: '呼叫外部服務', question: '要不要呼叫外部 HTTP 服務？', options: [
            { id: 'none', label: '不需要', kw: [], libs: L('none', 'none', 'none'), tradeoff: '' },
            { id: 'client', label: 'HTTP 客戶端', kw: ['第三方', '外部', '串接', '金流', '付款', '物流', '簡訊', 'email', '郵件', 'webhook', '通知'], libs: L('httpx', 'axios', 'java-net-http'), tradeoff: '' },
        ], default: L('none', 'none', 'none') },
        auth: { label: '認證授權', question: '要不要登入與權限？', options: [
            { id: 'none', label: '不需要', kw: [], libs: L('none', 'none', 'none'), tradeoff: '' },
            { id: 'token', label: '登入＋Token', kw: ['登入', '會員', '帳號', '權限', '管理員', '密碼', 'login', 'auth', '角色'], libs: L('pyjwt', 'jsonwebtoken', 'spring-security'), tradeoff: '要處理密碼雜湊與 token 過期。' },
        ], default: L('none', 'none', 'none') },
        scheduler: { label: '排程', question: '有沒有定時工作？', options: [
            { id: 'none', label: '沒有', kw: [], libs: L('none', 'none', 'none'), tradeoff: '' },
            { id: 'cron', label: '定時排程', kw: ['每天', '每週', '定時', '排程', '週期', 'cron', '提醒', '到期'], libs: L('apscheduler', 'node-cron', 'spring-scheduling'), tradeoff: '' },
        ], default: L('none', 'none', 'none') },
        messaging: { label: '訊息／事件', question: '要不要訊息佇列或事件？', options: [
            { id: 'none', label: '不需要', kw: [], libs: L('none', 'none', 'none'), tradeoff: '' },
            { id: 'queue', label: '訊息佇列', kw: ['佇列', 'queue', '非同步', '事件', '訊息', '即時', '廣播', 'kafka', 'rabbitmq', 'redis'], libs: L('celery', 'bullmq', 'spring-amqp'), tradeoff: '多一個要維運的元件。' },
        ], default: L('none', 'none', 'none') },
    };
    // 依賴清單：library 名稱 → 各語言的實際套件與版本
    const PKG = {
        python: { fastapi: ['fastapi>=0.110', 'uvicorn>=0.29'], typer: ['typer>=0.12'], sqlalchemy: ['sqlalchemy>=2.0'], pydantic: ['pydantic>=2.6'], pytest: ['pytest>=8.0'], structlog: ['structlog>=24.1'], httpx: ['httpx>=0.27'], pyjwt: ['pyjwt>=2.8'], apscheduler: ['apscheduler>=3.10'], celery: ['celery>=5.3'], pymongo: ['pymongo>=4.6'] },
        typescript: { express: ['express@^4.19'], commander: ['commander@^12'], prisma: ['@prisma/client@^5', 'prisma@^5'], zod: ['zod@^3.23'], vitest: ['vitest@^1.6'], pino: ['pino@^9'], axios: ['axios@^1.7'], jsonwebtoken: ['jsonwebtoken@^9'], 'node-cron': ['node-cron@^3'], bullmq: ['bullmq@^5'], mongodb: ['mongodb@^6'], 'better-sqlite3': ['better-sqlite3@^11'] },
        java: { 'spring-boot-web': ['org.springframework.boot:spring-boot-starter-web'], picocli: ['info.picocli:picocli'], 'spring-data-jpa': ['org.springframework.boot:spring-boot-starter-data-jpa'], 'jakarta-validation': ['org.springframework.boot:spring-boot-starter-validation'], 'junit-jupiter': ['org.junit.jupiter:junit-jupiter'], slf4j: ['org.slf4j:slf4j-api'], logback: ['ch.qos.logback:logback-classic'], 'spring-security': ['org.springframework.boot:spring-boot-starter-security'], 'spring-scheduling': [], 'spring-amqp': ['org.springframework.boot:spring-boot-starter-amqp'], 'sqlite-jdbc': ['org.xerial:sqlite-jdbc'], 'spring-data-mongodb': ['org.springframework.boot:spring-boot-starter-data-mongodb'] },
    };

    // ---------- ② 推薦（程式）----------
    const TAG_KW = { web: ['網站', '網頁', 'web', 'api', 'rest', '後端', '前端', '伺服器', 'http'], cli: ['命令列', 'cli', '指令', '終端', 'terminal'], db: ['資料庫', 'database', 'sql', '儲存', '訂單', '會員', '庫存', '紀錄', '查詢'], crud: ['新增', '修改', '刪除', '查詢', '管理', '上架', '編輯'], message: ['佇列', '事件', '訊息', '通知', '即時', '廣播'], realtime: ['即時', '推播', 'websocket'], async: ['非同步', '背景'], library: ['函式庫', 'library', 'sdk'], integration: ['串接', '第三方', '外部'], testable: ['可測試', '解耦'], multi_io: ['多種輸入', '多個來源'] };
    function detectTags(scenario) { const s = String(scenario || '').toLowerCase(); const tags = new Set(); for (const [tag, kws] of Object.entries(TAG_KW)) if (kws.some((k) => s.includes(k.toLowerCase()))) tags.add(tag); return Array.from(tags); }
    // 每個關注點：各選項分數（關鍵字命中數）；回傳 { choices:[{concern,option,by,reason,score,alternatives}], ambiguous:[{concern,options}] }
    // prefs：使用者／離線訓練器記得的偏好 { concern: optionId }；constraints：呼叫者明確指定的 { concern: optionId }（最優先）
    function recommend(scenario, language, opts) {
        opts = opts || {}; const lang = ['python', 'typescript', 'java'].includes(language) ? language : 'python'; const s = String(scenario || '').toLowerCase(); const prefs = opts.prefs || {}, cons = opts.constraints || {}; const choices = []; const ambiguous = [];
        for (const [cid, c] of Object.entries(CONCERNS)) {
            const scored = c.options.map((o) => ({ o, score: o.kw.filter((k) => s.includes(k.toLowerCase())).length })).sort((a, b) => b.score - a.score);
            let pick, by, reason;
            if (cons[cid] && c.options.some((o) => o.id === cons[cid])) { pick = cons[cid]; by = 'constraint'; reason = '呼叫者指定'; }
            else if (prefs[cid] && c.options.some((o) => o.id === prefs[cid])) { pick = prefs[cid]; by = 'preference'; reason = '你／離線訓練器記得的偏好'; }
            else if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) { pick = scored[0].o.id; by = 'program'; reason = '情境提到：' + scored[0].o.kw.filter((k) => s.includes(k.toLowerCase())).slice(0, 3).join('、'); }
            else if (scored[0].score > 0 && scored[1] && scored[0].score === scored[1].score) { ambiguous.push({ concern: cid, question: c.question, options: scored.filter((x) => x.score === scored[0].score).map((x) => ({ id: x.o.id, label: x.o.label, tradeoff: x.o.tradeoff })) }); pick = c.default[lang]; by = 'default'; reason = '平手，先用預設（會問選擇題）'; }
            else { pick = c.default[lang]; by = 'default'; reason = '情境沒有線索，用預設'; }
            const opt = c.options.find((o) => o.id === pick); choices.push({ concern: cid, label: c.label, option: pick, optionLabel: opt.label, lib: opt.libs[lang], by, reason });
        }
        // 架構風格
        const tags = detectTags(scenario); let arch = ARCH.find((a) => a.default); let archBy = 'default', archReason = '沒有特殊線索，用預設';
        const iface = (choices.find((c) => c.concern === 'interface') || {}).option;
        if (cons.architecture && ARCH.some((a) => a.id === cons.architecture)) { arch = ARCH.find((a) => a.id === cons.architecture); archBy = 'constraint'; archReason = '呼叫者指定'; }
        else if (prefs.architecture && ARCH.some((a) => a.id === prefs.architecture)) { arch = ARCH.find((a) => a.id === prefs.architecture); archBy = 'preference'; archReason = '你／離線訓練器記得的偏好'; }
        else if (iface === 'cli') { arch = ARCH.find((a) => a.id === 'cli_script'); archBy = 'program'; archReason = '對外介面是命令列'; }
        else if (iface === 'library') { arch = ARCH.find((a) => a.id === 'library'); archBy = 'program'; archReason = '只當函式庫'; }
        else { const sc = ARCH.map((a) => ({ a, n: a.tags.filter((t) => tags.includes(t)).length })).sort((x, y) => y.n - x.n); if (sc[0].n > 0 && sc[0].n > (sc[1] ? sc[1].n : 0) && !sc[0].a.default) { arch = sc[0].a; archBy = 'program'; archReason = '情境的線索：' + sc[0].a.tags.filter((t) => tags.includes(t)).join('、'); } }
        return { language: lang, tags, architecture: { id: arch.id, label: arch.label, by: archBy, reason: archReason, notes: arch.notes, tradeoff: arch.tradeoff }, choices, ambiguous };
    }
    // 平手的關注點變成選擇題：{"choice": 編號}（沿用食譜的 chooseTool 格式：cands = [{tool: id, intent: label}]）
    async function resolveAmbiguous(rec, scenario, generate) {
        const decisions = [];
        for (const amb of rec.ambiguous) {
            const cands = amb.options.map((o) => ({ tool: o.id, intent: o.label + (o.tradeoff ? '（' + o.tradeoff + '）' : ''), score: 0 }));
            const ch = await R.chooseTool({ cands, question: amb.question + '\n' + scenario, generate }); decisions.push({ concern: amb.concern, answer: ch.ok && !ch.none ? cands[ch.index].tool : null, by: 'model', tries: ch.tries, rejected: ch.rejected });
            if (ch.ok && !ch.none) { const c = rec.choices.find((x) => x.concern === amb.concern); const o = CONCERNS[amb.concern].options.find((x) => x.id === cands[ch.index].tool); c.option = o.id; c.optionLabel = o.label; c.lib = o.libs[rec.language]; c.by = 'model'; c.reason = '平手，模型從選單挑'; }
        }
        rec.ambiguous = []; return decisions;
    }
    const pickOf = (design, concern) => ((design.choices || []).find((c) => c.concern === concern) || {}).option;

    // ---------- ③ 套用：依選擇展開專案配置 ----------
    function manifestFor(design, lang) {
        const libs = Array.from(new Set((design.choices || []).map((c) => c.lib).filter((x) => x && x !== 'none'))); if (design.architecture && design.architecture.id === 'library') libs.length = 0;
        const deps = []; for (const l of libs) for (const d of (PKG[lang] && PKG[lang][l]) || []) if (!deps.includes(d)) deps.push(d);
        return { libs, deps };
    }
    const snake = (s) => U.FILTERS.snake(s), camel = (s) => U.FILTERS.camel(s), pascal = (s) => U.FILTERS.pascal(s);
    function ucName(u) { return pascal(String(u.name).replace(/[^A-Za-z0-9_ ]/g, ' ').trim() || 'UseCase'); }
    function entities(model) { return model.classes.filter((c) => c.kind === 'class' && c.attrs.length && !model.usecases.some((u) => u.actor === c.name && false)); }
    const PY = {
        service: `"""使用案例：{{name}}（參與者：{{actor}}）"""
from __future__ import annotations
{{#each imports}}{{this}}
{{/each}}

class {{className}}Service:
    def __init__(self{{#if deps}}, {{deps}}{{/if}}) -> None:
{{#each depAssign}}        self.{{name}} = {{name}}
{{/each}}        pass

    def execute(self) -> None:
{{#each steps}}        # {{@index}}. {{from}} -> {{to}}.{{msg}}({{args}})
{{/each}}        raise NotImplementedError
`,
        repoIface: `from __future__ import annotations
from abc import ABC, abstractmethod
from typing import List, Optional
from ..domain.{{file}} import {{name}}


class {{name}}Repository(ABC):
    @abstractmethod
    def get(self, id: int) -> Optional[{{name}}]: ...

    @abstractmethod
    def list(self) -> List[{{name}}]: ...

    @abstractmethod
    def save(self, item: {{name}}) -> {{name}}: ...

    @abstractmethod
    def delete(self, id: int) -> None: ...


class InMemory{{name}}Repository({{name}}Repository):
    def __init__(self) -> None:
        self._items: dict[int, {{name}}] = {}

    def get(self, id: int) -> Optional[{{name}}]:
        return self._items.get(id)

    def list(self) -> List[{{name}}]:
        return list(self._items.values())

    def save(self, item: {{name}}) -> {{name}}:
        self._items[getattr(item, "id", len(self._items) + 1)] = item
        return item

    def delete(self, id: int) -> None:
        self._items.pop(id, None)
`,
        rest: `from fastapi import APIRouter

router = APIRouter()
{{#each ucs}}

@router.post("/{{path}}")
def {{snake}}() -> dict:
    """{{name}}（參與者：{{actor}}）——呼叫 {{className}}Service"""
    raise NotImplementedError
{{/each}}
`,
        main: `from fastapi import FastAPI
from .api.routes import router

app = FastAPI(title="{{title}}")
app.include_router(router)
`,
        cli: `import typer

app = typer.Typer(help="{{title}}")
{{#each ucs}}

@app.command("{{path}}")
def {{snake}}() -> None:
    """{{name}}（參與者：{{actor}}）——呼叫 {{className}}Service"""
    raise NotImplementedError
{{/each}}

if __name__ == "__main__":
    app()
`,
    };
    const TS = {
        service: `{{#each imports}}{{this}}
{{/each}}
/** 使用案例：{{name}}（參與者：{{actor}}） */
export class {{className}}Service {
    execute(): void {
{{#each steps}}        // {{@index}}. {{from}} -> {{to}}.{{msg}}({{args}})
{{/each}}        throw new Error("not implemented");
    }
}
`,
        repoIface: `import { {{name}} } from "../domain/{{name}}";

export interface {{name}}Repository {
    get(id: number): {{name}} | undefined;
    list(): {{name}}[];
    save(item: {{name}}): {{name}};
    delete(id: number): void;
}

export class InMemory{{name}}Repository implements {{name}}Repository {
    private items = new Map<number, {{name}}>();
    get(id: number): {{name}} | undefined { return this.items.get(id); }
    list(): {{name}}[] { return Array.from(this.items.values()); }
    save(item: {{name}}): {{name}} { this.items.set((item as any).id ?? this.items.size + 1, item); return item; }
    delete(id: number): void { this.items.delete(id); }
}
`,
        rest: `import express from "express";

export const router = express.Router();
{{#each ucs}}

/** {{name}}（參與者：{{actor}}）——呼叫 {{className}}Service */
router.post("/{{path}}", (_req, res) => {
    res.status(501).json({ error: "not implemented" });
});
{{/each}}
`,
        main: `import express from "express";
import { router } from "./api/routes";

const app = express();
app.use(express.json());
app.use(router);
app.listen(3000, () => console.log("{{title}} listening on :3000"));
`,
        cli: `import { Command } from "commander";

const program = new Command().description("{{title}}");
{{#each ucs}}
program.command("{{path}}").description("{{name}}（參與者：{{actor}}）").action(() => {
    throw new Error("not implemented");
});
{{/each}}
program.parse();
`,
    };
    const JV = {
        controller: `package {{package}}.api;

import org.springframework.web.bind.annotation.*;

@RestController
public class ApiController {
{{#each ucs}}
    /** {{name}}（參與者：{{actor}}） */
    @PostMapping("/{{path}}")
    public String {{camel}}() {
        throw new UnsupportedOperationException("not implemented");
    }
{{/each}}
}
`,
        service: `package {{package}}.services;

/** 使用案例：{{name}}（參與者：{{actor}}） */
public class {{className}}Service {
    public void execute() {
{{#each steps}}        // {{@index}}. {{from}} -> {{to}}.{{msg}}({{args}})
{{/each}}        throw new UnsupportedOperationException("not implemented");
    }
}
`,
        repoIface: `package {{package}}.repositories;

import java.util.List;
import java.util.Optional;
import {{package}}.domain.{{name}};

public interface {{name}}Repository {
    Optional<{{name}}> get(long id);
    List<{{name}}> list();
    {{name}} save({{name}} item);
    void delete(long id);
}
`,
        app: `package {{package}};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
`,
    };
    function buildProject(model, opts) {
        opts = opts || {}; const lang = ['python', 'typescript', 'java'].includes(opts.language) ? opts.language : 'python'; const pkg = (opts.package || 'app').toLowerCase().replace(/[^a-z0-9_.]/g, '');
        const design = opts.design || recommend(opts.scenario || '', lang, {}); const arch = (design.architecture && design.architecture.id) || 'layered'; const layered = arch !== 'library';
        const files = U.genFiles(model, { language: lang, package: pkg, scenario: opts.scenario, subdir: layered ? 'domain' : '' });
        const iface = pickOf(design, 'interface'); const persist = pickOf(design, 'persistence'); const ents = entities(model).filter((c) => !model.relations.some((r) => r.to === c.name && r.kind === 'compose' && false));
        const srcDir = lang === 'java' ? 'src/main/java/' + pkg.replace(/\./g, '/') : 'src' + (lang === 'python' ? '/' + pkg : '');
        const ucs = model.usecases.map((u) => ({ name: u.name, actor: u.actor, className: ucName(u), snake: snake(ucName(u)) || 'use_case', camel: camel(ucName(u)) || 'useCase', path: snake(ucName(u)).replace(/_/g, '-') || 'use-case', steps: u.steps.map((s) => ({ from: s.from, to: s.to, msg: s.msg, args: (s.args || []).join(', ') })) }));
        const fileOf = (n) => (lang === 'python' ? snake(n) : n);
        if (layered && arch !== 'library') {
            for (const u of ucs) {
                const imps = lang === 'python' ? Array.from(new Set(u.steps.map((s) => s.to))).filter((n) => model.classes.some((c) => c.name === n)).map((n) => 'from ..domain.' + snake(n) + ' import ' + n) : (lang === 'typescript' ? Array.from(new Set(u.steps.map((s) => s.to))).filter((n) => model.classes.some((c) => c.name === n)).map((n) => 'import { ' + n + ' } from "../domain/' + n + '";') : []);
                const ctx = Object.assign({}, u, { package: pkg, imports: imps, deps: '', depAssign: [] });
                if (lang === 'python') files.push({ path: srcDir + '/services/' + u.snake + '_service.py', content: U.renderTpl(PY.service, ctx), region: 'service:' + u.name });
                else if (lang === 'typescript') files.push({ path: 'src/services/' + u.className + 'Service.ts', content: U.renderTpl(TS.service, ctx), region: 'service:' + u.name });
                else files.push({ path: srcDir + '/services/' + u.className + 'Service.java', content: U.renderTpl(JV.service, ctx), region: 'service:' + u.name });
            }
            if (persist && persist !== 'none') for (const c of ents) { const ctx = { name: c.name, file: snake(c.name), package: pkg }; if (lang === 'python') files.push({ path: srcDir + '/repositories/' + snake(c.name) + '_repository.py', content: U.renderTpl(PY.repoIface, ctx), region: 'repository:' + c.name }); else if (lang === 'typescript') files.push({ path: 'src/repositories/' + c.name + 'Repository.ts', content: U.renderTpl(TS.repoIface, ctx), region: 'repository:' + c.name }); else files.push({ path: srcDir + '/repositories/' + c.name + 'Repository.java', content: U.renderTpl(JV.repoIface, ctx), region: 'repository:' + c.name }); }
            if (lang === 'python') { files.push({ path: srcDir + '/services/__init__.py', content: '', region: 'package' }); if (persist && persist !== 'none') files.push({ path: srcDir + '/repositories/__init__.py', content: '', region: 'package' }); }
            const ctx = { ucs, title: model.name, package: pkg };
            if (iface === 'rest') {
                if (lang === 'python') { files.push({ path: srcDir + '/api/routes.py', content: U.renderTpl(PY.rest, ctx), region: 'api' }, { path: srcDir + '/api/__init__.py', content: '', region: 'package' }, { path: srcDir + '/main.py', content: U.renderTpl(PY.main, ctx), region: 'entry' }); }
                else if (lang === 'typescript') files.push({ path: 'src/api/routes.ts', content: U.renderTpl(TS.rest, ctx), region: 'api' }, { path: 'src/main.ts', content: U.renderTpl(TS.main, ctx), region: 'entry' });
                else files.push({ path: srcDir + '/api/ApiController.java', content: U.renderTpl(JV.controller, ctx), region: 'api' }, { path: srcDir + '/Application.java', content: U.renderTpl(JV.app, ctx), region: 'entry' });
            } else if (iface === 'cli') {
                if (lang === 'python') files.push({ path: srcDir + '/cli.py', content: U.renderTpl(PY.cli, ctx), region: 'entry' }); else if (lang === 'typescript') files.push({ path: 'src/cli.ts', content: U.renderTpl(TS.cli, ctx), region: 'entry' });
            }
        }
        // 依賴清單
        const mf = manifestFor(design, lang);
        if (lang === 'python') files.push({ path: 'requirements.txt', content: mf.deps.join('\n') + (mf.deps.length ? '\n' : ''), region: 'manifest' });
        else if (lang === 'typescript') { const run = mf.deps.filter((d) => !/^(vitest|prisma|@types)/.test(d)), dev = mf.deps.filter((d) => /^(vitest|prisma|@types)/.test(d)); const toObj = (a) => Object.fromEntries(a.map((d) => { const i = d.lastIndexOf('@'); return i > 0 ? [d.slice(0, i), d.slice(i + 1)] : [d, '*']; })); files.push({ path: 'package.json', content: JSON.stringify({ name: pkg.replace(/\./g, '-'), version: '0.1.0', private: true, scripts: { test: 'vitest run' }, dependencies: toObj(run), devDependencies: Object.assign({ typescript: '^5.4' }, toObj(dev)) }, null, 2) + '\n', region: 'manifest' }); }
        else files.push({ path: 'pom-dependencies.xml.txt', content: mf.deps.map((d) => { const [g, a] = d.split(':'); return '<dependency><groupId>' + g + '</groupId><artifactId>' + a + '</artifactId></dependency>'; }).join('\n') + '\n', region: 'manifest' });
        // README：設計決策表（ADR）
        const readme = files.find((f) => f.path === 'README.md');
        if (readme) readme.content += '\n## 設計決策\n\n| 決策 | 選擇 | 由誰決定 | 原因 |\n|---|---|---|---|\n| 架構 | ' + design.architecture.label + ' | ' + design.architecture.by + ' | ' + design.architecture.reason + ' |\n' + design.choices.filter((c) => c.option !== 'none' || c.by !== 'default').map((c) => '| ' + c.label + ' | ' + c.optionLabel + (c.lib && c.lib !== 'none' ? '（' + c.lib + '）' : '') + ' | ' + c.by + ' | ' + c.reason + ' |').join('\n') + '\n';
        // 膠水（FaGlue）：把設計接到真正的 library（ORM 模型、repository 實作、schema、依賴注入、路由、啟動、測試…）；同一個位置有多塊時依驗證與經驗挑
        let glue = { files, applied: [], skipped: [] }; if (G && opts.glue !== false) glue = G.apply(model, design, files, { language: lang, package: pkg, userGlue: opts.userGlue, experience: opts.experience });
        return { files: glue.files, design, libs: mf.libs, glue: glue.applied, glueSkipped: glue.skipped };
    }

    // ---------- ④ 常見設計片段（預先建好的 UML＋抉擇）----------
    // triggers：情境裡出現就算符合；dsl：UML 片段（類別名稱用常見英文）；choices：這類系統常見的抉擇（給推薦當先驗）；note：何時用
    const FRAGMENTS = [
        { id: 'crud_entity', label: 'CRUD 實體管理', triggers: ['新增', '修改', '刪除', '查詢', '管理', '上架', '編輯', '維護'], note: '一個實體＋Repository＋Service 的最小骨架。', dsl: 'class Item { +id:int; +name:str; +createdAt:datetime }\ninterface ItemRepository { get(id:int):Optional<Item>; list():List<Item>; save(item:Item):Item; delete(id:int):void }\nclass ItemService { +create(name:str):Item; +rename(id:int, name:str):Item; +remove(id:int):void }\nItemService --> ItemRepository', choices: { architecture: 'layered', persistence: 'orm' } },
        { id: 'shopping_cart', label: '購物車與訂單', triggers: ['購物車', '結帳', '下單', '訂單', '付款', '商品'], note: '商品、購物車、訂單、付款的常見切法。', dsl: 'enum OrderStatus { NEW, PAID, SHIPPED, CANCELLED }\nclass Product { +id:int; +name:str; +price:decimal }\nclass CartItem { product:Product; quantity:int }\nclass Cart { items:List<CartItem>; +add(product:Product, quantity:int):void; +remove(product:Product):void; +total():decimal }\nclass Order { +id:int; status:OrderStatus; lines:List<CartItem>; +pay():bool; +cancel():void }\ninterface PaymentGateway { charge(amount:decimal):bool }\nCart o-- CartItem\nOrder *-- CartItem\nOrder --> PaymentGateway', choices: { interface: 'rest', persistence: 'orm', http_client: 'client' } },
        { id: 'auth_login', label: '登入與權限', triggers: ['登入', '帳號', '密碼', '權限', '角色', '管理員', '會員', 'login'], note: '使用者、角色、登入服務。', dsl: 'enum Role { USER, ADMIN }\nclass User { +id:int; +email:str; role:Role; passwordHash:str }\nclass AuthService { +login(email:str, password:str):Optional<str>; +verify(token:str):Optional<User> }\nAuthService --> User', choices: { auth: 'token', validation: 'schema' } },
        { id: 'observer', label: 'Observer（通知／訂閱）', triggers: ['通知', '訂閱', '事件', '推播', '提醒', '監聽'], note: '主題變化時通知所有訂閱者。', dsl: 'interface Observer { update(event:str):void }\nclass Subject { observers:List<Observer>; +attach(o:Observer):void; +detach(o:Observer):void; +notifyAll(event:str):void }\nSubject o-- Observer', choices: { messaging: 'queue' } },
        { id: 'strategy', label: 'Strategy（可替換的演算法）', triggers: ['策略', '計算方式', '折扣', '演算法', '可替換', '多種方式'], note: '同一件事有多種做法，執行時選一個。', dsl: 'interface Strategy { apply(value:decimal):decimal }\nclass Context { strategy:Strategy; +execute(value:decimal):decimal }\nContext --> Strategy', choices: {} },
        { id: 'factory', label: 'Factory（依條件建立物件）', triggers: ['建立不同', '依類型建立', '工廠', '多種類型'], note: '依參數決定建立哪一種物件。', dsl: 'interface Product { describe():str }\nclass Factory { +create(kind:str):Product }\nFactory ..> Product', choices: {} },
        { id: 'state_machine', label: '狀態機（流程狀態）', triggers: ['狀態', '流程', '審核', '核准', '待處理', '進行中', '完成'], note: '實體有生命週期，轉換要驗證。', dsl: 'enum State { PENDING, APPROVED, REJECTED, DONE }\nclass Workflow { +id:int; state:State; +approve():void; +reject():void; +complete():void }\nWorkflow --> State', choices: {} },
        { id: 'inventory', label: '庫存管理', triggers: ['庫存', '進貨', '出貨', '盤點', '倉庫'], note: '庫存量與異動紀錄。', dsl: 'class StockItem { +sku:str; quantity:int; +adjust(delta:int):void }\nclass StockMovement { +id:int; sku:str; delta:int; at:datetime }\nclass InventoryService { +receive(sku:str, qty:int):void; +ship(sku:str, qty:int):bool }\nInventoryService --> StockItem\nInventoryService --> StockMovement', choices: { persistence: 'orm' } },
        { id: 'scheduler_job', label: '定時工作', triggers: ['每天', '每週', '定時', '排程', '提醒', '週期'], note: '排程觸發工作。', dsl: 'interface Job { run():void }\nclass JobScheduler { jobs:List<Job>; +register(job:Job, cron:str):void; +start():void }\nJobScheduler o-- Job', choices: { scheduler: 'cron' } },
    ];
    function matchFragments(scenario, min) {
        const s = String(scenario || '').toLowerCase(); const out = [];
        for (const f of FRAGMENTS) { const hits = f.triggers.filter((t) => s.includes(t.toLowerCase())); if (hits.length >= (min || 1)) out.push({ fragment: f, hits, score: hits.length }); }
        return out.sort((a, b) => b.score - a.score);
    }
    // 把符合的片段合併成種子模型（類別名稱衝突就跳過後來的）；回傳 { model, used:[id], skipped:[…] }
    function seedModel(scenario, opts) {
        opts = opts || {}; const matches = matchFragments(scenario, opts.minHits || 1).slice(0, opts.maxFragments || 3); const model = U.emptyModel(); const used = [], skipped = [];
        for (const m of matches) {
            const part = U.parseDsl(m.fragment.dsl); if (part.errors.length) { skipped.push(m.fragment.id + '：片段本身有錯'); continue; }
            const clash = part.model.classes.filter((c) => model.classes.some((x) => x.name === c.name)).map((c) => c.name); if (clash.length) { skipped.push(m.fragment.id + '：類別名稱重複 ' + clash.join('、')); continue; }
            model.classes.push(...part.model.classes); model.relations.push(...part.model.relations); used.push(m.fragment.id);
        }
        return { model, used, skipped };
    }
    // 片段 → 離線訓練器的內建知識（宿主註冊成 domain 'uml_design'）：語意範例（觸發詞組）、說明、UML 片段
    function trainerPatterns() { return FRAGMENTS.map((f) => ({ id: 'uml_' + f.id, type: 'semantic', examples: [f.label].concat(f.triggers.map((t) => '設計一個有「' + t + '」的系統')), intent: 'UML 設計片段：' + f.label, description: f.note, uml: f.dsl, choices: f.choices, answer: f.label + '：' + f.note + '\n\n' + f.dsl, confidence: 0.6, source: 'builtin', enabled: true, hits: 0, risk: 'safe' })); }

    // ---------- ⑤ top-down 遞迴 rework ----------
    // 找出問題（由上而下排序：model → class → relation → usecase）。每個問題指出「哪一區」與「為什麼」，只有那一區會被重做。
    function findIssues(model) {
        const issues = []; const used = new Set(); for (const u of model.usecases) { used.add(u.actor); u.steps.forEach((s) => used.add(s.to)); } const related = new Set(); for (const r of model.relations) { related.add(r.from); related.add(r.to); }
        for (const e of U.validateModel(model)) { const m = /^([A-Z][A-Za-z0-9]*)[.\s]/.exec(e); issues.push({ level: 'class', region: m ? 'class:' + m[1] : 'model', kind: 'invalid', msg: e }); }
        if (!model.usecases.length) issues.push({ level: 'model', region: 'model', kind: 'no_usecase', msg: '沒有任何使用案例' });
        if (model.classes.length > 10) issues.push({ level: 'model', region: 'model', kind: 'too_many_classes', msg: '類別超過 10 個，需要合併或分成套件' });
        for (const c of model.classes) {
            if (c.kind === 'class' && !c.attrs.length && !c.ops.length) issues.push({ level: 'class', region: 'class:' + c.name, kind: 'empty', msg: c.name + ' 沒有任何屬性或操作' });
            if (c.ops.length > 8) issues.push({ level: 'class', region: 'class:' + c.name, kind: 'god_class', msg: c.name + ' 操作超過 8 個，責任太多' });
            if (!used.has(c.name) && !related.has(c.name) && c.kind !== 'enum') issues.push({ level: 'class', region: 'class:' + c.name, kind: 'orphan', msg: c.name + ' 沒有任何關係也沒有被任何使用案例用到' });
        }
        for (const u of model.usecases) if (u.steps.length < 2) issues.push({ level: 'usecase', region: 'usecase:' + u.name, kind: 'short_sequence', msg: '使用案例「' + u.name + '」呼叫順序少於 2 步' });
        const order = { model: 0, class: 1, relation: 2, usecase: 3 }; return issues.sort((a, b) => order[a.level] - order[b.level]);
    }
    // 上層改了，下層要跟著收拾：拿掉指向不存在類別的關係與呼叫步驟、補不存在的操作（程式，不問模型）
    function normalize(model) {
        const names = new Set(model.classes.map((c) => c.name)); const log = [];
        const nr = model.relations.length; model.relations = model.relations.filter((r) => names.has(r.from) && names.has(r.to) && r.from !== r.to || (r.kind === 'assoc' && names.has(r.from) && names.has(r.to))); if (model.relations.length !== nr) log.push('移除 ' + (nr - model.relations.length) + ' 個指向不存在類別的關係');
        for (const u of model.usecases) { const before = u.steps.length; u.steps = u.steps.filter((s) => names.has(s.to)); let prev = u.actor; for (const s of u.steps) { s.from = prev; prev = s.to; } if (u.steps.length !== before) log.push('使用案例 ' + u.name + ' 拿掉 ' + (before - u.steps.length) + ' 個無效呼叫'); }
        const added = U.ensureOps(model); if (added.length) log.push('補上操作：' + added.join('、')); return log;
    }
    function dslOfClass(model, name) { const c = model.classes.find((x) => x.name === name); if (!c) return ''; const one = U.emptyModel(); one.classes = [c]; return U.toDsl(one).split('\n').filter((l) => !/^model:/.test(l)).join('\n'); }
    // 只重做有問題的那一區（沿用 uml_core 的封閉小問題，並附上目前的內容與要修的問題）。回傳 { model, rounds:[…], remaining }
    async function reworkModel(model, scenario, opts) {
        opts = opts || {}; const maxRounds = opts.maxRounds || 2; const rounds = []; const names = () => model.classes.map((c) => c.name);
        const withIssue = (spec, current, issue) => { const m = spec.messages.slice(); const last = m[m.length - 1]; m[m.length - 1] = Object.assign({}, last, { content: last.content + '\n\n目前這一區的內容：\n' + current + '\n要修正的問題：' + issue.msg + '\n請只輸出修正後的 JSON。' }); return Object.assign({}, spec, { messages: m }); };
        for (let round = 1; round <= maxRounds; round++) {
            const issues = findIssues(model); if (!issues.length) break; const log = [];
            for (const iss of issues.slice(0, opts.maxIssues || 6)) {
                const [kind, name] = iss.region.split(':'); let did = false;
                if (kind === 'class' && model.classes.some((c) => c.name === name)) {
                    const c = model.classes.find((x) => x.name === name);
                    if (iss.kind === 'orphan' || iss.kind === 'invalid' && /關係/.test(iss.msg)) { const others = names().filter((n) => n !== name); if (others.length) { const spec = withIssue(U.stageSpec.relations(scenario, { cls: c, others, kinds: Object.fromEntries(model.classes.map((x) => [x.name, x.kind])) }), dslOfClass(model, name), iss); const r = await R.jsonStep({ generate: opts.generate, messages: spec.messages, validate: spec.validate, maxTries: 2, maxTokens: 300, prefill: U.PREFILL.relations }); log.push({ region: iss.region, issue: iss.kind, by: 'model', ok: r.ok, tries: r.tries, rejected: r.rejected }); if (r.ok) { for (const x of r.value.relations || []) if (!model.relations.some((y) => y.from === name && y.to === x.to && y.kind === x.kind)) model.relations.push({ from: name, to: x.to, kind: x.kind }); did = true; } } }
                    else if (iss.kind === 'empty' || iss.kind === 'god_class' || iss.kind === 'invalid') { const spec = withIssue(U.stageSpec.members(scenario, { cls: c, classNames: names(), usedBy: model.usecases.map((u) => u.name).join('、') }), dslOfClass(model, name), iss); const r = await R.jsonStep({ generate: opts.generate, messages: spec.messages, validate: spec.validate, maxTries: 2, maxTokens: 400, prefill: U.PREFILL.members }); log.push({ region: iss.region, issue: iss.kind, by: 'model', ok: r.ok, tries: r.tries, rejected: r.rejected }); if (r.ok && c.kind !== 'enum') { c.attrs = (r.value.attrs || []).map((a) => ({ name: a.name, type: U.parseType(a.type), visibility: '+' })); c.ops = (r.value.ops || []).map((o) => ({ name: o.name, params: (o.params || []).map((p) => ({ name: p.name, type: U.parseType(p.type) })), returns: o.returns && o.returns !== 'void' ? U.parseType(o.returns) : { base: 'void', args: [] }, visibility: '+', static: false })); did = true; } }
                } else if (kind === 'usecase') {
                    const u = model.usecases.find((x) => x.name === name); if (u) { const ops = Object.fromEntries(model.classes.filter((c) => c.kind !== 'enum').map((c) => [c.name, c.ops.map((o) => o.name)])); const menu = Object.entries(ops).map(([k, v]) => k + '（' + (v.length ? v.join('、') : '還沒有操作') + '）').join('；'); const spec = withIssue(U.stageSpec.sequence(scenario, { uc: u, ops, menu }), u.steps.map((s) => s.to + '.' + s.msg).join(' -> ') || '（空）', iss); const r = await R.jsonStep({ generate: opts.generate, messages: spec.messages, validate: spec.validate, maxTries: 2, maxTokens: 300, prefill: U.PREFILL.sequence }); log.push({ region: iss.region, issue: iss.kind, by: 'model', ok: r.ok, tries: r.tries, rejected: r.rejected }); if (r.ok) { u.steps = []; let prev = u.actor; for (const s of r.value.steps || []) { u.steps.push({ from: prev, to: s.to, msg: s.op, args: [], returns: '' }); prev = s.to; } did = true; } }
                } else if (iss.kind === 'too_many_classes') { log.push({ region: 'model', issue: iss.kind, by: 'program', ok: true, note: '分成套件（packagesOf）' }); }
                if (did) { const nl = normalize(model); if (nl.length) log.push({ region: 'model', issue: 'normalize', by: 'program', ok: true, note: nl.join('；') }); }
            }
            rounds.push({ round, issues: issues.map((i) => i.region + ':' + i.kind), log });
        }
        const remaining = findIssues(model); return { model, rounds, remaining };
    }
    // 套件分組（程式）：用關係與使用案例把類別分群（連通分量），每群用最多關係的類別命名
    function packagesOf(model) {
        const parent = {}; const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x]))); for (const c of model.classes) parent[c.name] = c.name; const uni = (a, b) => { if (parent[a] && parent[b]) parent[find(a)] = find(b); };
        for (const r of model.relations) if (r.kind !== 'depend') uni(r.from, r.to); for (const u of model.usecases) { let prev = null; for (const s of u.steps) { if (prev) uni(prev, s.to); prev = s.to; } }
        const groups = {}; for (const c of model.classes) (groups[find(c.name)] = groups[find(c.name)] || []).push(c.name);
        const deg = {}; for (const r of model.relations) { deg[r.from] = (deg[r.from] || 0) + 1; deg[r.to] = (deg[r.to] || 0) + 1; }
        return Object.values(groups).map((cs) => { const head = cs.slice().sort((a, b) => (deg[b] || 0) - (deg[a] || 0))[0]; return { name: head.replace(/(Service|Repository|Controller)$/, '').toLowerCase() || head.toLowerCase(), classes: cs }; });
    }
    // 整條：種子（片段）→ 情境到 UML → rework → 推薦與抉擇 → 專案；模型只做封閉的小決策
    async function designProject(scenario, opts) {
        opts = opts || {}; const lang = opts.language || 'python'; const trail = [];
        const seed = opts.seed === false ? { model: U.emptyModel(), used: [], skipped: [] } : seedModel(scenario, opts); trail.push({ stage: 'seed', by: 'program', used: seed.used });
        let res;
        if (opts.model) res = { ok: true, model: opts.model, decisions: [], warnings: [] };
        else { res = await U.scenarioToModel(scenario, { generate: opts.generate, onStage: opts.onStage, maxTries: opts.maxTries, program: opts.program, glossary: opts.glossary }); if (!res.ok) return { ok: false, error: res.error, trail, decisions: res.decisions, warnings: res.warnings }; }
        const model = res.model; // 種子片段的類別補進來（名稱不衝突的）
        for (const c of seed.model.classes) if (!model.classes.some((x) => x.name === c.name) && model.classes.length < 10) model.classes.push(c); for (const r of seed.model.relations) if (!model.relations.some((x) => x.from === r.from && x.to === r.to && x.kind === r.kind)) model.relations.push(r);
        normalize(model); let rw = { rounds: [], remaining: findIssues(model) }; if (opts.generate && opts.rework !== false) rw = await reworkModel(model, scenario, { generate: opts.generate, maxRounds: opts.maxRounds || 2 }); trail.push({ stage: 'rework', rounds: rw.rounds.length, remaining: rw.remaining.length });
        const frag = seed.used.map((id) => FRAGMENTS.find((f) => f.id === id)).filter(Boolean); const fragChoices = Object.assign({}, ...frag.map((f) => f.choices || {}));
        const rec = recommend(scenario, lang, { prefs: Object.assign({}, fragChoices, opts.prefs || {}), constraints: opts.constraints || {} });
        const dec = opts.generate ? await resolveAmbiguous(rec, scenario, opts.generate) : []; trail.push({ stage: 'design', by: 'program', ambiguous: dec.length });
        const proj = buildProject(model, { language: lang, package: opts.package, scenario, design: rec, userGlue: opts.userGlue, experience: opts.experience, glue: opts.glue });
        return { ok: true, model, dsl: U.toDsl(model), design: rec, files: proj.files, libs: proj.libs, glue: proj.glue, packages: packagesOf(model), rework: rw, trail, decisions: (res.decisions || []).concat(dec), warnings: (res.warnings || []).concat(rw.remaining.map((i) => '尚有問題：' + i.msg)), seedUsed: seed.used };
    }

    return { ARCH, CONCERNS, PKG, FRAGMENTS, detectTags, recommend, resolveAmbiguous, manifestFor, buildProject, matchFragments, seedModel, trainerPatterns, findIssues, normalize, reworkModel, packagesOf, designProject };
});
