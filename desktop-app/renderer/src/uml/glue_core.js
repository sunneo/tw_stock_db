/* 膠水（FaGlue）：骨架之後的下一步——把設計（UML 的類別、使用案例）接到「真正的 library」，變成可以跑的系統。
 *
 * 骨架只有結構（stub）；真實系統還需要一堆「膠水」：domain 類別 ↔ ORM 資料列、domain ↔ API schema、repository 的資料庫實作、依賴注入、路由、進入點、
 * 設定、記錄、認證、排程、外部 HTTP 客戶端……這些寫法對每個 library 組合都是固定的、而且是「經驗」——某個組合怎麼接才會動，是試出來（跑過測試）才知道的。
 * 所以膠水是**資料**，不是程式邏輯：
 *   - 每一塊膠水：適用條件（語言、對外介面、儲存、library）、要展開的檔案（template，欄位來自 UML）、驗證過的版本、經驗統計（成功／失敗、最近一次、環境）、來源（內建／線上 AI／使用者）。
 *   - **經驗會累積**：用膠水產生的系統跑過、測試過，結果回報（glue_report）；同一個位置有多塊膠水時，依「驗證過的版本＋成功率」挑。
 *   - **AI 可以貢獻膠水**：線上 AI 手動把某個組合接通（測試通過）之後，把那些檔案整理成 template 登記（glue_define）；之後離線小模型和其他 AI 直接重用，不用重新摸索。
 *   - 實作用到的 library API 都寫死在 template 裡（fastapi 0.110、pydantic 2、sqlalchemy 2.0…），驗證過的版本標在資料上。
 * 純函式（UMD）；模型不參與（膠水展開是 template）。
 */
(function (root, factory) {
    const U = (typeof FaUml !== 'undefined' && FaUml) || (root && root.FaUml) || (typeof require === 'function' ? require('./uml_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(U);
    else root.FaGlue = factory(U);
})(typeof self !== 'undefined' ? self : this, function (U) {
    'use strict';
    const snake = (s) => U.FILTERS.snake(s), camel = (s) => U.FILTERS.camel(s), pascal = (s) => U.FILTERS.pascal(s);
    const plural = (n) => { const s = snake(n); return /y$/.test(s) && !/[aeiou]y$/.test(s) ? s.slice(0, -1) + 'ies' : (/(s|x|ch|sh)$/.test(s) ? s + 'es' : s + 's'); };

    // ---------- 從 UML 取出膠水需要的資料 ----------
    function baseOf(model, c) { const r = model.relations.find((x) => x.from === c.name && x.kind === 'inherit'); return r ? model.classes.find((x) => x.name === r.to) : null; }
    function allAttrs(model, c, seen) { seen = seen || new Set(); if (seen.has(c.name)) return []; seen.add(c.name); const b = baseOf(model, c); return (b ? allAttrs(model, b, seen) : []).concat(c.attrs); }
    // 純量欄位：基本型別、Optional<基本型別>、列舉；其他（List、Map、類別參照）不持久化（以空值還原）
    function scalarOf(model, t) {
        if (!t) return null; let optional = false; let x = t; if (x.base === 'Optional' && x.args && x.args[0]) { optional = true; x = x.args[0]; }
        if (U.PRIMS.includes(x.base) && x.base !== 'void' && x.base !== 'any') return { base: x.base, optional };
        const en = model.classes.find((c) => c.name === x.base && c.kind === 'enum'); if (en) return { base: 'enum', enumName: en.name, enumFile: snake(en.name), optional, values: en.values || [] };
        return null;
    }
    const PY = { int: 'int', float: 'float', str: 'str', bool: 'bool', date: 'date', datetime: 'datetime', bytes: 'bytes', decimal: 'Decimal' };
    const SA = { int: 'Integer', float: 'Float', str: 'String(255)', bool: 'Boolean', date: 'Date', datetime: 'DateTime', bytes: 'LargeBinary', decimal: 'Numeric(18, 2)', enum: 'String(64)' };
    const SAMPLE = { int: '1', float: '1.5', str: '"x"', bool: 'True', date: '"2024-01-01"', datetime: '"2024-01-01T00:00:00"', decimal: '"1.50"', bytes: '"eA=="' };
    function fieldCtx(model, a) {
        const sc = scalarOf(model, a.type); if (!sc) return null; const isId = a.name === 'id'; const py = sc.base === 'enum' ? sc.enumName : PY[sc.base];
        return { name: a.name, base: sc.base, optional: sc.optional, enumName: sc.enumName, enumFile: sc.enumFile, py: sc.optional ? 'Optional[' + py + ']' : py, pyd: sc.optional ? 'Optional[' + py + '] = None' : py, mapped: sc.optional ? 'Optional[' + py + ']' : py, col: SA[sc.base] + (isId ? ', primary_key=True, autoincrement=True' : (sc.optional ? ', nullable=True' : '')), sample: sc.base === 'enum' ? '"' + (sc.values[0] || '') + '"' : SAMPLE[sc.base], isId, domainValue: sc.base === 'enum' ? '{x}' : '{x}' };
    }
    // 實體：一般類別（非抽象）而且有 id 欄位；回傳膠水 template 要的完整 context
    function entitiesOf(model) {
        const out = [];
        for (const c of model.classes) {
            if (c.kind !== 'class') continue; const attrs = allAttrs(model, c); if (!attrs.some((a) => a.name === 'id')) continue;
            const fields = attrs.map((a) => fieldCtx(model, a)).filter(Boolean); if (!fields.some((f) => f.isId)) continue;
            // 還原 domain 物件時，非純量欄位（含關係推出的欄位）用空值
            const derived = model.relations.filter((r) => r.from === c.name && ['compose', 'aggregate', 'assoc'].includes(r.kind)).map((r) => ({ name: camel(r.to) + (r.mult && /\*|\.\.\d/.test(r.mult) && !/^1$/.test(r.mult) ? 's' : ''), many: !!(r.mult && /\*|\.\.\d/.test(r.mult) && !/^1$/.test(r.mult)) }));
            const nonScalar = attrs.filter((a) => !scalarOf(model, a.type) && !fields.some((f) => f.name === a.name)).map((a) => ({ name: a.name, empty: a.type && a.type.base === 'List' ? '[]' : (a.type && a.type.base === 'Map' ? '{}' : 'None') })).concat(derived.filter((d) => !attrs.some((a) => a.name === d.name)).map((d) => ({ name: d.name, empty: d.many ? '[]' : 'None' })));
            const enums = Array.from(new Map(fields.filter((f) => f.enumName).map((f) => [f.enumName, { name: f.enumName, file: f.enumFile }])).values());
            const baseFields = fields.filter((f) => !f.isId);
            const defaults = ['"id": 0'].concat(nonScalar.map((n) => '"' + n.name + '": ' + n.empty)).join(', ');
            out.push({ name: c.name, snake: snake(c.name), plural: plural(c.name), table: plural(c.name), fields, baseFields, noBase: baseFields.length === 0, enums, nonScalar, defaults, sample: baseFields.map((f) => '"' + f.name + '": ' + f.sample).join(', '), sampleBody: '{' + baseFields.map((f) => '"' + f.name + '": ' + f.sample).join(', ') + '}', domainArgs: fields.map((f) => ({ name: f.name, expr: 'row.' + f.name + (f.base === 'enum' ? (f.optional ? ' and ' + f.enumName + '(row.' + f.name + ')' : '') : '') })).map((a, i) => (fields[i].base === 'enum' && !fields[i].optional ? { name: a.name, expr: fields[i].enumName + '(row.' + a.name + ')' } : a)).concat(nonScalar.map((n) => ({ name: n.name, expr: n.empty })).slice(0, 50)), saveData: fields.map((f) => ({ name: f.name, expr: 'item.' + f.name + (f.base === 'enum' ? (f.optional ? '.value if item.' + f.name + ' is not None else None' : '.value') : '') })) });
        }
        return out;
    }
    // 使用案例：只有「單一步驟、對實體做 list／get／create／update／delete」的才能直接實作；其他維持 stub（但依賴都接好）
    const CRUD = { list: 'get', get: 'get', create: 'post', update: 'post', delete: 'delete' };
    function usecasesOf(model, entities) {
        const byName = Object.fromEntries(entities.map((e) => [e.name, e]));
        return model.usecases.map((u) => {
            const cn = pascal(String(u.name).replace(/[^A-Za-z0-9_ ]/g, ' ').trim() || 'UseCase'); const touched = Array.from(new Set(u.steps.map((s) => s.to))).filter((n) => byName[n]).map((n) => byName[n]);
            const one = u.steps.length === 1 && byName[u.steps[0].to] && CRUD[u.steps[0].msg] ? { entity: byName[u.steps[0].to], op: u.steps[0].msg } : null;
            return { name: u.name, actor: u.actor, className: cn, snake: snake(cn) || 'use_case', path: (snake(cn) || 'use_case').replace(/_/g, '-'), repos: touched, crud: one, steps: u.steps.map((s, i) => ({ i, from: s.from, to: s.to, msg: s.msg, args: (s.args || []).join(', ') })), method: one ? CRUD[one.op] : 'post' };
        });
    }

    // ---------- 膠水（template）----------
    // 每塊膠水：id、slot（同一個位置只留一塊）、語言、適用條件 requires、files:[{path, tpl, per:'project'|'entity'|'usecase', when}]、templates:{name: 字串}、verified、source
    const T = {};
    T.db = `import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///{{pkg}}.db")
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def init_db() -> None:
    from . import orm  # noqa: F401  註冊所有資料表
    Base.metadata.create_all(engine)
`;
    T.orm = `from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, Float, Integer, LargeBinary, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
{{#each entities}}


class {{name}}Row(Base):
    __tablename__ = "{{table}}"
{{#each fields}}    {{name}}: Mapped[{{mapped}}] = mapped_column({{col}})
{{/each}}{{/each}}
`;
    T.sqlRepo = `from __future__ import annotations

from typing import List, Optional

from sqlalchemy.orm import Session

from ..domain.{{snake}} import {{name}}
{{#each enums}}from ..domain.{{file}} import {{name}}
{{/each}}from ..orm import {{name}}Row
from .{{snake}}_repository import {{name}}Repository


def _to_domain(row: {{name}}Row) -> {{name}}:
    return {{name}}(
{{#each domainArgs}}        {{name}}={{expr}},
{{/each}}    )


class Sql{{name}}Repository({{name}}Repository):
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self, id: int) -> Optional[{{name}}]:
        row = self.session.get({{name}}Row, id)
        return _to_domain(row) if row is not None else None

    def list(self) -> List[{{name}}]:
        return [_to_domain(r) for r in self.session.query({{name}}Row).all()]

    def save(self, item: {{name}}) -> {{name}}:
        data = {
{{#each saveData}}            "{{name}}": {{expr}},
{{/each}}        }
        row = self.session.get({{name}}Row, data["id"]) if data.get("id") else None
        if row is None:
            data.pop("id", None)
            row = {{name}}Row(**data)
            self.session.add(row)
        else:
            for key, value in data.items():
                setattr(row, key, value)
        self.session.commit()
        return _to_domain(row)

    def delete(self, id: int) -> None:
        row = self.session.get({{name}}Row, id)
        if row is not None:
            self.session.delete(row)
            self.session.commit()
`;
    T.schemas = `from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict
{{#each allEnums}}
from .domain.{{file}} import {{name}}
{{/each}}
{{#each entities}}

class {{name}}Base(BaseModel):
{{#each baseFields}}    {{name}}: {{pyd}}
{{/each}}{{#if noBase}}    pass
{{/if}}

class {{name}}Create({{name}}Base):
    pass


class {{name}}Read({{name}}Base):
    model_config = ConfigDict(from_attributes=True)
    id: int
{{/each}}
`;
    T.factories = `"""依 UML 產生的 domain 物件工廠：補上 id 與關係欄位的空值。"""
from __future__ import annotations

from typing import Any
{{#each entities}}
from .domain.{{snake}} import {{name}}
{{/each}}
{{#each entities}}

def new_{{snake}}(data: dict[str, Any]) -> {{name}}:
    return {{name}}(**{**{ {{defaults}} }, **data})
{{/each}}
`;
    T.depsSql = `from __future__ import annotations

from typing import Iterator

from fastapi import Depends
from sqlalchemy.orm import Session

from ..db import SessionLocal
{{#each entities}}
from ..repositories.{{snake}}_sql_repository import Sql{{name}}Repository
{{/each}}{{#each usecases}}
from ..services.{{snake}}_service import {{className}}Service
{{/each}}

def get_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
{{#each entities}}

def get_{{snake}}_repo(session: Session = Depends(get_session)) -> Sql{{name}}Repository:
    return Sql{{name}}Repository(session)
{{/each}}{{#each usecases}}

def get_{{snake}}_service({{#each repos}}{{snake}}_repo: Sql{{name}}Repository = Depends(get_{{snake}}_repo){{#if @last}}{{else}}, {{/if}}{{/each}}) -> {{className}}Service:
    return {{className}}Service({{#each repos}}{{snake}}_repo{{#if @last}}{{else}}, {{/if}}{{/each}})
{{/each}}
`;
    T.depsMem = `from __future__ import annotations

{{#each entities}}
from ..repositories.{{snake}}_repository import {{name}}Repository, InMemory{{name}}Repository
{{/each}}{{#each usecases}}
from ..services.{{snake}}_service import {{className}}Service
{{/each}}
{{#each entities}}
_{{snake}}_repo = InMemory{{name}}Repository()
{{/each}}
{{#each entities}}

def get_{{snake}}_repo() -> {{name}}Repository:
    return _{{snake}}_repo
{{/each}}{{#each usecases}}

def get_{{snake}}_service() -> {{className}}Service:
    return {{className}}Service({{#each repos}}_{{snake}}_repo{{#if @last}}{{else}}, {{/if}}{{/each}})
{{/each}}
`;
    T.routes = `from __future__ import annotations

from typing import Any, List

from fastapi import APIRouter, Depends, HTTPException
{{#each entities}}
from ..domain.{{snake}} import {{name}}
{{/each}}
from ..factories import {{#each entities}}new_{{snake}}{{#if @last}}{{else}}, {{/if}}{{/each}}
from ..schemas import {{#each entities}}{{name}}Create, {{name}}Read{{#if @last}}{{else}}, {{/if}}{{/each}}
from .deps import {{#each entities}}get_{{snake}}_repo{{#if @last}}{{else}}, {{/if}}{{/each}}{{#each usecases}}, get_{{snake}}_service{{/each}}

routers: List[APIRouter] = []
{{#each entities}}

{{snake}}_router = APIRouter(prefix="/{{plural}}", tags=["{{name}}"])


@{{snake}}_router.get("", response_model=List[{{name}}Read])
def list_{{plural}}(repo=Depends(get_{{snake}}_repo)):
    return [{{name}}Read.model_validate(i) for i in repo.list()]


@{{snake}}_router.get("/{item_id}", response_model={{name}}Read)
def get_{{snake}}(item_id: int, repo=Depends(get_{{snake}}_repo)):
    item = repo.get(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="{{name}} not found")
    return {{name}}Read.model_validate(item)


@{{snake}}_router.post("", response_model={{name}}Read, status_code=201)
def create_{{snake}}(payload: {{name}}Create, repo=Depends(get_{{snake}}_repo)):
    return {{name}}Read.model_validate(repo.save(new_{{snake}}(payload.model_dump())))


@{{snake}}_router.delete("/{item_id}", status_code=204)
def delete_{{snake}}(item_id: int, repo=Depends(get_{{snake}}_repo)):
    repo.delete(item_id)


routers.append({{snake}}_router)
{{/each}}

usecase_router = APIRouter(prefix="/usecases", tags=["use cases"])
{{#each usecases}}

@usecase_router.{{method}}("/{{path}}")
def {{snake}}({{#if hasPayload}}payload: dict[str, Any] | None = None, {{/if}}service=Depends(get_{{snake}}_service)):
    """{{name}}（參與者：{{actor}}）"""
    try:
        result = service.execute({{#if hasPayload}}payload{{/if}})
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="use case not implemented yet")
    return {"result": jsonable(result)}
{{/each}}

routers.append(usecase_router)


def jsonable(value: Any) -> Any:
    from fastapi.encoders import jsonable_encoder
    return jsonable_encoder(value)
`;
    T.main = `from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
{{#if sql}}
from .db import init_db
{{/if}}from .api.routes import routers


@asynccontextmanager
async def lifespan(app: FastAPI):
{{#if sql}}    init_db()
{{/if}}    yield


app = FastAPI(title="{{title}}", lifespan=lifespan)
for router in routers:
    app.include_router(router)
`;
    T.service = `"""使用案例：{{name}}（參與者：{{actor}}）"""
from __future__ import annotations

from typing import Any
{{#each repos}}
from ..factories import new_{{snake}}
from ..repositories.{{snake}}_repository import {{name}}Repository
{{/each}}

class {{className}}Service:
    def __init__(self{{#each repos}}, {{snake}}_repo: {{name}}Repository{{/each}}) -> None:
{{#each repos}}        self.{{snake}}_repo = {{snake}}_repo
{{/each}}        pass

    def execute(self, payload: dict[str, Any] | None = None) -> Any:
{{#if crud}}{{crudBody}}{{else}}{{#each steps}}        # {{i}}. {{from}} -> {{to}}.{{msg}}({{args}})
{{/each}}        raise NotImplementedError
{{/if}}`;
    T.smokeTest = `"""API 冒煙測試：每個實體 建立 → 列出 → 取得 → 刪除。"""
import os
import tempfile

os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "test.db")

from fastapi.testclient import TestClient  # noqa: E402

from {{pkg}}.main import app  # noqa: E402
{{#each entities}}

def test_{{snake}}_crud():
    with TestClient(app) as client:
        created = client.post("/{{plural}}", json={{sampleBody}})
        assert created.status_code == 201, created.text
        item_id = created.json()["id"]
        assert any(i["id"] == item_id for i in client.get("/{{plural}}").json())
        assert client.get(f"/{{plural}}/{item_id}").status_code == 200
        assert client.delete(f"/{{plural}}/{item_id}").status_code == 204
        assert client.get(f"/{{plural}}/{item_id}").status_code == 404
{{/each}}
`;
    T.cli = `from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

import typer
{{#each allEnums}}
from .domain.{{file}} import {{name}}
{{/each}}

from .db import SessionLocal, init_db
{{#each entities}}
from .repositories.{{snake}}_sql_repository import Sql{{name}}Repository
{{/each}}{{#each usecases}}
from .services.{{snake}}_service import {{className}}Service
{{/each}}
app = typer.Typer(help="{{title}}")


def _encode(value):
    import dataclasses
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    return str(value)
{{#each usecases}}

@app.command("{{path}}")
def {{snake}}({{cliSig}}) -> None:
    """{{name}}（參與者：{{actor}}）"""
    init_db()
{{#if cliPayload}}    payload = {{cliPayload}}
{{/if}}    with SessionLocal() as session:
        service = {{className}}Service({{#each repos}}Sql{{name}}Repository(session){{#if @last}}{{else}}, {{/if}}{{/each}})
        try:
            result = service.execute({{#if cliPayload}}payload{{/if}})
        except NotImplementedError:
            typer.echo("use case not implemented yet", err=True)
            raise typer.Exit(code=2)
        typer.echo(json.dumps(result, default=_encode, ensure_ascii=False))
{{/each}}

if __name__ == "__main__":
    app()
`;
    T.auth = `"""密碼雜湊與 JWT（PyJWT）。祕密從環境變數 AUTH_SECRET 讀，沒有就用開發用的預設值（正式環境一定要設）。"""
from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Any, Optional

import jwt

SECRET = os.environ.get("AUTH_SECRET", "dev-only-secret-change-me-in-production-0123")
ALGORITHM = "HS256"


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120_000)
    return salt.hex() + "$" + digest.hex()


def verify_password(password: str, stored: str) -> bool:
    salt_hex, digest_hex = stored.split("$", 1)
    candidate = hash_password(password, bytes.fromhex(salt_hex)).split("$", 1)[1]
    return hmac.compare_digest(candidate, digest_hex)


def create_token(subject: str, ttl_seconds: int = 3600, **claims: Any) -> str:
    now = int(time.time())
    return jwt.encode({"sub": subject, "iat": now, "exp": now + ttl_seconds, **claims}, SECRET, algorithm=ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, SECRET, algorithms=[ALGORITHM])
`;
    T.httpClient = `"""呼叫外部服務的 HTTP 客戶端（httpx）：逾時、重試、錯誤轉成例外。"""
from __future__ import annotations

from typing import Any, Optional

import httpx


class ExternalServiceError(RuntimeError):
    pass


class HttpClient:
    def __init__(self, base_url: str = "", timeout: float = 10.0, retries: int = 2) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self.retries = retries

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        last: Optional[Exception] = None
        for _ in range(self.retries + 1):
            try:
                with httpx.Client(base_url=self.base_url, timeout=self.timeout) as client:
                    response = client.request(method, url, **kwargs)
                response.raise_for_status()
                return response
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                last = exc
        raise ExternalServiceError(str(last))

    def get_json(self, url: str, **kwargs: Any) -> Any:
        return self.request("GET", url, **kwargs).json()

    def post_json(self, url: str, payload: Any, **kwargs: Any) -> Any:
        return self.request("POST", url, json=payload, **kwargs).json()
`;
    T.jobs = `"""定時工作（APScheduler）。register_jobs() 在應用程式啟動時呼叫。"""
from __future__ import annotations

from typing import Callable

from apscheduler.schedulers.background import BackgroundScheduler

scheduler = BackgroundScheduler()


def register_job(func: Callable[[], None], cron: str) -> None:
    """cron：五欄位 cron 運算式，例如 "0 9 * * *"（每天九點）。"""
    from apscheduler.triggers.cron import CronTrigger
    scheduler.add_job(func, CronTrigger.from_crontab(cron))


def start() -> None:
    if not scheduler.running:
        scheduler.start()


def stop() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
`;
    T.logging = `"""記錄設定（標準 logging）：LOG_LEVEL 環境變數控制。"""
import logging
import os


def setup_logging() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
`;
    T.config = `"""設定：全部從環境變數讀，集中在這裡。"""
import os

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///{{pkg}}.db")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
`;
    T.conftest = `import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
`;

    const GLUE = [
        { id: 'py-sqlalchemy-persistence', lang: 'python', slot: 'persistence', label: 'SQLAlchemy 2.0 資料存取（ORM 模型、repository 實作、session）', requires: { persistence: ['orm', 'sqlite'], libs: ['sqlalchemy'] }, verified: { python: '3.10', sqlalchemy: '2.0.x' }, source: 'builtin', needs: ['entities'],
            files: [{ path: '{{src}}/db.py', tpl: 'db', per: 'project' }, { path: '{{src}}/orm.py', tpl: 'orm', per: 'project' }, { path: '{{src}}/repositories/{{snake}}_sql_repository.py', tpl: 'sqlRepo', per: 'entity' }] },
        { id: 'py-fastapi-wiring', lang: 'python', slot: 'api', label: 'FastAPI＋Pydantic v2：schema、依賴注入、CRUD 路由、使用案例路由、啟動、冒煙測試', requires: { interface: ['rest'], libs: ['fastapi'] }, verified: { python: '3.10', fastapi: '0.110.x', pydantic: '2.x' }, source: 'builtin', needs: ['entities'],
            files: [{ path: '{{src}}/schemas.py', tpl: 'schemas', per: 'project' }, { path: '{{src}}/api/deps.py', tpl: 'deps', per: 'project' }, { path: '{{src}}/api/routes.py', tpl: 'routes', per: 'project' }, { path: '{{src}}/main.py', tpl: 'main', per: 'project' }, { path: 'tests/test_api_smoke.py', tpl: 'smokeTest', per: 'project' }, { path: 'tests/conftest.py', tpl: 'conftest', per: 'project' }] },
        { id: 'py-services-crud', lang: 'python', slot: 'services', label: '使用案例 service：依賴注入 repository；單一步驟的 CRUD 使用案例直接實作', requires: { libs: [] }, verified: { python: '3.10' }, source: 'builtin', needs: ['entities'], files: [{ path: '{{src}}/factories.py', tpl: 'factories', per: 'project' }, { path: '{{src}}/services/{{snake}}_service.py', tpl: 'service', per: 'usecase' }] },
        { id: 'py-typer-wiring', lang: 'python', slot: 'cli', label: 'Typer 命令列：每個使用案例一個指令，接 SQLAlchemy repository', requires: { interface: ['cli'], persistence: ['orm', 'sqlite'], libs: ['typer', 'sqlalchemy'] }, verified: { python: '3.10', typer: '0.12.x' }, source: 'builtin', needs: ['entities'], files: [{ path: '{{src}}/cli.py', tpl: 'cli', per: 'project' }] },
        { id: 'py-pyjwt-auth', lang: 'python', slot: 'auth', label: '密碼雜湊（PBKDF2）＋JWT（PyJWT）', requires: { auth: ['token'], libs: ['pyjwt'] }, verified: { python: '3.10', pyjwt: '2.x' }, source: 'builtin', files: [{ path: '{{src}}/auth.py', tpl: 'auth', per: 'project' }] },
        { id: 'py-httpx-client', lang: 'python', slot: 'http_client', label: 'HTTP 客戶端（httpx）：逾時、重試、錯誤轉例外', requires: { http_client: ['client'], libs: ['httpx'] }, verified: { python: '3.10', httpx: '0.27.x' }, source: 'builtin', files: [{ path: '{{src}}/clients/http_client.py', tpl: 'httpClient', per: 'project' }, { path: '{{src}}/clients/__init__.py', tpl: '', per: 'project' }] },
        { id: 'py-apscheduler-jobs', lang: 'python', slot: 'scheduler', label: '定時工作（APScheduler）', requires: { scheduler: ['cron'], libs: ['apscheduler'] }, verified: { python: '3.10', apscheduler: '3.10.x' }, source: 'builtin', files: [{ path: '{{src}}/jobs.py', tpl: 'jobs', per: 'project' }] },
        { id: 'py-logging-config', lang: 'python', slot: 'logging', label: '記錄設定（標準 logging）', requires: {}, verified: { python: '3.10' }, source: 'builtin', files: [{ path: '{{src}}/logging_config.py', tpl: 'logging', per: 'project' }] },
        { id: 'py-env-config', lang: 'python', slot: 'config', label: '環境變數設定', requires: {}, verified: { python: '3.10' }, source: 'builtin', files: [{ path: '{{src}}/config.py', tpl: 'config', per: 'project' }] },
    ];

    // ---------- 經驗 ----------
    // experience：{ glueId: { ok, fail, last, env:{…}, notes:[…] } }；分數＝驗證過的版本加分＋成功率（平滑），同一個位置有多塊膠水時依分數挑
    function score(g, exp) { const e = (exp && exp[g.id]) || { ok: 0, fail: 0 }; const n = e.ok + e.fail; const rate = (e.ok + 1) / (n + 2); return (g.verified && Object.keys(g.verified).length ? 2 : 0) + rate * 3 + Math.min(e.ok, 10) * 0.1 - (g.source === 'user' || g.source === 'ai' ? 0.5 : 0); }
    function report(exp, id, ok, env, note) { const out = Object.assign({}, exp); const e = Object.assign({ ok: 0, fail: 0, notes: [] }, out[id]); if (ok) e.ok++; else e.fail++; e.last = Date.now(); if (env && typeof env === 'object') e.env = Object.assign({}, e.env, env); if (note) e.notes = (e.notes || []).concat([String(note).slice(0, 200)]).slice(-5); out[id] = e; return out; }
    // 使用者／AI 登記的膠水：檢查格式（template 能解析、路徑安全、欄位名稱合法），回傳 { ok, errors, glue }
    function validateGlue(def) {
        const errs = []; if (!def || typeof def !== 'object') return { ok: false, errors: ['不是物件'] };
        if (!/^[a-z][a-z0-9-]{2,60}$/.test(def.id || '')) errs.push('id 要是小寫英數與連字號（3～60 字）');
        if (!['python', 'typescript', 'java'].includes(def.lang)) errs.push('lang 只能是 python／typescript／java');
        if (!/^[a-z_]{2,30}$/.test(def.slot || '')) errs.push('slot 要是小寫英文（它決定這塊膠水取代哪個位置，例如 api、persistence、auth）');
        if (!Array.isArray(def.files) || !def.files.length || def.files.length > 30) errs.push('files 要有 1～30 個');
        for (const f of def.files || []) {
            if (!f || typeof f.path !== 'string' || /(^|\/)\.\.(\/|$)|^\//.test(f.path.replace(/\{\{[^}]*\}\}/g, 'x')) || f.path.length > 200) errs.push('檔案路徑不安全或太長：' + (f && f.path)); if (!f || typeof f.template !== 'string' || f.template.length > 60000) errs.push('template 要是字串（≤60000 字）：' + (f && f.path));
            else { try { U.renderTpl(f.template, { pkg: 'x', title: 'x', entities: [], usecases: [] }); } catch (e) { errs.push('template 無法解析：' + f.path + '：' + e.message); } }
        }
        if (def.requires && typeof def.requires !== 'object') errs.push('requires 要是物件');
        if (errs.length) return { ok: false, errors: errs };
        const glue = { id: def.id, lang: def.lang, slot: def.slot, label: String(def.label || def.id).slice(0, 120), requires: def.requires || {}, verified: {}, source: def.source === 'ai' ? 'ai' : 'user', needs: def.needs || [], notes: String(def.notes || '').slice(0, 500), files: def.files.map((f) => ({ path: f.path, tpl: '@inline', per: f.per === 'entity' || f.per === 'usecase' ? f.per : 'project', template: f.template })) };
        return { ok: true, errors: [], glue };
    }

    // ---------- 選膠水與展開 ----------
    function matches(g, lang, design) {
        if (g.lang !== lang) return false; const choose = (c) => ((design.choices || []).find((x) => x.concern === c) || {}); const r = g.requires || {};
        for (const k of ['interface', 'persistence', 'auth', 'http_client', 'scheduler', 'validation', 'logging']) if (r[k] && !r[k].includes(choose(k).option)) return false;
        if (r.libs && r.libs.length) { const have = new Set((design.choices || []).map((c) => c.lib)); if (!r.libs.every((l) => have.has(l))) return false; }
        if (design.architecture && design.architecture.id === 'library') return false; return true;
    }
    // 同一個 slot 只留分數最高的一塊（包含使用者／AI 登記的）
    function select(lang, design, opts) {
        opts = opts || {}; const cands = GLUE.concat(opts.userGlue || []).filter((g) => matches(g, lang, design)); const bySlot = new Map();
        for (const g of cands) { const cur = bySlot.get(g.slot); if (!cur || score(g, opts.experience) > score(cur, opts.experience)) bySlot.set(g.slot, g); }
        return Array.from(bySlot.values());
    }
    function fillPath(p, ctx) { return U.renderTpl(p, ctx); }
    // files：buildProject 已產生的檔案（會被同路徑的膠水檔案取代）；回傳 { files, applied:[{id, source, verified}], skipped:[] }
    function apply(model, design, files, opts) {
        opts = opts || {}; const lang = opts.language || 'python'; if (lang !== 'python') return { files, applied: [], skipped: [{ reason: lang + ' 還沒有內建膠水（只有骨架）；可以用 glue_define 登記' }] };
        const pkg = (opts.package || 'app').toLowerCase().replace(/[^a-z0-9_.]/g, ''); const entities = entitiesOf(model); const usecases = usecasesOf(model, entities); const sql = ['orm', 'sqlite'].includes((design.choices.find((c) => c.concern === 'persistence') || {}).option);
        const allEnums = Array.from(new Map([].concat(...entities.map((e) => e.enums)).map((e) => [e.name, e])).values());
        const CLI_T = { int: 'int', float: 'float', str: 'str', bool: 'bool', decimal: 'float', date: 'str', datetime: 'str', bytes: 'str', enum: 'str' };
        const conv = (f, v) => (f.base === 'decimal' ? 'Decimal(str(' + v + '))' : (f.base === 'date' ? 'date.fromisoformat(' + v + ')' : (f.base === 'datetime' ? 'datetime.fromisoformat(' + v + ')' : (f.base === 'enum' ? f.enumName + '(' + v + ')' : v))));
        for (const u of usecases) {
            u.cliSig = ''; u.cliPayload = '';
            if (u.crud) { const e = u.crud.entity; const op = u.crud.op; const idP = 'item_id: int = typer.Option(..., "--id", help="編號")'; const fp = (req) => e.baseFields.map((f) => f.name + ': ' + (req ? CLI_T[f.base] : 'Optional[' + CLI_T[f.base] + ']') + ' = typer.Option(' + (req && !f.optional ? '...' : 'None') + ', "--' + snake(f.name).replace(/_/g, '-') + '", help="' + f.name + '")');
                if (op === 'create') { u.cliSig = fp(true).join(', '); u.cliPayload = '{' + e.baseFields.map((f) => '"' + f.name + '": ' + (f.optional ? f.name + ' if ' + f.name + ' is None else ' + conv(f, f.name) : conv(f, f.name))).join(', ') + '}'; }
                else if (op === 'update') { u.cliSig = [idP].concat(fp(false)).join(', '); u.cliPayload = '{k: v for k, v in {"id": item_id, ' + e.baseFields.map((f) => '"' + f.name + '": ' + f.name + ' if ' + f.name + ' is None else ' + conv(f, f.name)).join(', ') + '}.items() if v is not None}'; }
                else if (op === 'get' || op === 'delete') { u.cliSig = idP; u.cliPayload = '{"id": item_id}'; } } }
        for (const u of usecases) { u.hasPayload = !!(u.crud && ['create', 'update', 'delete', 'get'].includes(u.crud.op)); u.crudBody = u.crud ? crudBody(u) : ''; u.crud = u.crud ? { op: u.crud.op, entity: u.crud.entity.name } : null; }
        const base = { pkg, src: 'src/' + pkg, title: model.name, entities, usecases, allEnums, sql, memory: !sql };
        const chosen = select(lang, design, opts); const out = files.slice(); const applied = []; const put = (path, content, region) => { const i = out.findIndex((f) => f.path === path); const f = { path, content, region: region || 'glue' }; if (i >= 0) out[i] = f; else out.push(f); };
        for (const g of chosen) {
            if ((g.needs || []).includes('entities') && !entities.length) continue;
            for (const f of g.files) {
                const tpl = f.tpl === '@inline' ? f.template : (f.tpl === 'deps' ? (sql ? T.depsSql : T.depsMem) : (f.tpl === 'sqlRepo' ? T.sqlRepo : (f.tpl === 'service' ? T.service : (f.tpl ? T[f.tpl] : ''))));
                if (f.tpl && f.tpl !== '@inline' && tpl === undefined) continue;
                if (f.per === 'entity') for (const e of entities) put(fillPath(f.path, Object.assign({}, base, e)), U.renderTpl(tpl, Object.assign({}, base, e)), 'glue:' + g.id + ':' + e.name);
                else if (f.per === 'usecase') for (const u of usecases) put(fillPath(f.path, Object.assign({}, base, u)), U.renderTpl(tpl, Object.assign({}, base, u)), 'glue:' + g.id + ':' + u.name);
                else put(fillPath(f.path, base), U.renderTpl(tpl, base), 'glue:' + g.id);
            }
            applied.push({ id: g.id, slot: g.slot, source: g.source, verified: g.verified, label: g.label });
        }
        return { files: out.map((f) => Object.assign({}, f, { content: f.content.replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n') })), applied, skipped: [] };
    }
    function crudBody(u) {
        const e = u.crud.entity; const r = e.snake + '_repo'; const op = u.crud.op;
        if (op === 'list') return '        return self.' + r + '.list()\n';
        if (op === 'get') return '        return self.' + r + '.get(int((payload or {})["id"]))\n';
        if (op === 'create') return '        return self.' + r + '.save(new_' + e.snake + '(dict(payload or {})))\n';
        if (op === 'update') return '        data = dict(payload or {})\n        current = self.' + r + '.get(int(data.pop("id")))\n        if current is None:\n            raise KeyError("not found")\n        for key, value in data.items():\n            setattr(current, key, value)\n        return self.' + r + '.save(current)\n';
        return '        self.' + r + '.delete(int((payload or {})["id"]))\n        return None\n';
    }
    return { GLUE, TEMPLATES: T, entitiesOf, usecasesOf, allAttrs, scalarOf, score, report, validateGlue, matches, select, apply, plural };
});
