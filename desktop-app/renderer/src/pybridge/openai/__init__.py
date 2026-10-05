# -*- coding: utf-8 -*-
"""
openai 的「轉接版」：Floating AI Assistant 在執行技能包的 Python 腳本時提供。

腳本照原本的寫法（同步或 async 都可以）：
    from openai import OpenAI, AsyncOpenAI
    client = OpenAI(base_url=..., api_key=...)
    client.chat.completions.create(model=..., messages=[...], tools=[...], stream=True)
    client.responses.create(...); client.embeddings.create(...); client.images.generate(...); client.audio.transcriptions.create(...)

但實際上不會連腳本設定的 base_url／金鑰，而是用 AI 助理「已設定的 LLM Model 清單」裡的 Model（腳本自己的 base_url、api_key、model 都忽略）：
  * chat／responses／completions：用目前的 Model；有 tools 就挑支援工具呼叫的 Model，有圖片就挑支援讀圖的 Model（依序試）。
  * embeddings、images、audio：不直接當不支援——從清單裡找有這個能力的 Model（依序試），所有 Model 都不支援才丟 openai.NotSupportedError。
  * 串流（stream=True）：上游整段回來後分段送出（行為跟真的串流一樣，只是沒有逐字延遲）。
  * moderations、files、batches、threads／runs、fine_tuning 等助理沒有對應的東西：用 fa_sim 的模擬回應（欄位正確、內容誠實、並通知助理「這是模擬的」）。
"""
import json
import re

import fa_bridge
import fa_llm
import fa_sim

__version__ = "1.99.0+fa-bridge"


# ---------------------------------------------------------------- 錯誤（跟真的 openai 套件同名同繼承）
class OpenAIError(Exception):
    pass


class APIError(OpenAIError):
    def __init__(self, message="", request=None, body=None, **kw):
        super(APIError, self).__init__(message)
        self.message = message
        self.request = request
        self.body = body
        self.code = (body or {}).get("code") if isinstance(body, dict) else None
        self.param = None
        self.type = None


class APIStatusError(APIError):
    status_code = 500

    def __init__(self, message="", response=None, body=None, status_code=None, **kw):
        super(APIStatusError, self).__init__(message, body=body)
        self.response = response
        if status_code:
            self.status_code = status_code
        self.request_id = None


class APIConnectionError(APIError):
    pass


class APITimeoutError(APIConnectionError):
    pass


class BadRequestError(APIStatusError):
    status_code = 400


class AuthenticationError(APIStatusError):
    status_code = 401


class PermissionDeniedError(APIStatusError):
    status_code = 403


class NotFoundError(APIStatusError):
    status_code = 404


class ConflictError(APIStatusError):
    status_code = 409


class UnprocessableEntityError(APIStatusError):
    status_code = 422


class RateLimitError(APIStatusError):
    status_code = 429


class InternalServerError(APIStatusError):
    status_code = 500


class NotSupportedError(APIStatusError, NotImplementedError):
    """助理已設定的所有 LLM Model 都沒有這個能力。"""
    status_code = 501


_STATUS_CLS = {400: BadRequestError, 401: AuthenticationError, 403: PermissionDeniedError, 404: NotFoundError, 409: ConflictError, 422: UnprocessableEntityError, 429: RateLimitError}


def _translate(e):
    """把橋接的錯誤轉成 openai 套件的錯誤型別（腳本的 except 會照原本的寫法接得到）。"""
    if isinstance(e, fa_bridge.NotSupported):
        return NotSupportedError(str(e) or "沒有任何已設定的 LLM Model 支援這個功能")
    msg = str(e)
    m = re.search(r"API錯誤\((\d{3})\)", msg)
    if m:
        code = int(m.group(1))
        cls = _STATUS_CLS.get(code) or (InternalServerError if code >= 500 else APIStatusError)
        return cls(msg, status_code=code)
    if "逾時" in msg:
        return APITimeoutError(msg)
    return APIConnectionError(msg)


# ---------------------------------------------------------------- 物件
class _Obj(object):
    """dict 包成可以用屬性存取的物件（resp.choices[0].message.content），也可以用 resp["choices"]。"""

    def __init__(self, d):
        self.__dict__["_d"] = d

    def __getattr__(self, k):
        if k.startswith("__"):
            raise AttributeError(k)
        v = self.__dict__["_d"].get(k)
        return _wrap(v)

    def __getitem__(self, k):
        return _wrap(self.__dict__["_d"][k])

    def __contains__(self, k):
        return k in self.__dict__["_d"]

    def get(self, k, default=None):
        return _wrap(self.__dict__["_d"].get(k, default))

    def keys(self):
        return self.__dict__["_d"].keys()

    def to_dict(self, **kw):
        return self.__dict__["_d"]

    model_dump = to_dict

    def to_json(self, **kw):
        return json.dumps(self.__dict__["_d"], ensure_ascii=False)

    model_dump_json = to_json

    def __repr__(self):
        return "<openai.%s %r>" % (self.__dict__["_d"].get("object", "obj"), self.__dict__["_d"])


def _wrap(v):
    if isinstance(v, dict):
        return _Obj(v)
    if isinstance(v, list):
        return [_wrap(x) for x in v]
    return v


class Stream(object):
    """串流回應（同步）：for chunk in stream:。"""

    def __init__(self, gen):
        self._gen = gen
        self.response = None

    def __iter__(self):
        return self

    def __next__(self):
        return _wrap(next(self._gen))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass


class AsyncStream(object):
    def __init__(self, gen):
        self._gen = gen

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return _wrap(next(self._gen))
        except StopIteration:
            raise StopAsyncIteration

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def close(self):
        pass


class _Raw(object):
    """with_raw_response 的結果：.parse() 取回物件，.headers／.http_response 給個樣子。"""

    def __init__(self, obj):
        self._obj = obj
        self.headers = {"x-fa-bridge": "1"}
        self.status_code = 200

    def parse(self):
        return self._obj

    def __getattr__(self, k):
        return getattr(self._obj, k)


# ---------------------------------------------------------------- 執行：每個操作寫成 generator，yield 請求、收回結果，同步與 async 共用
def _drive(gen):
    try:
        req = next(gen)
        while True:
            try:
                res = _do(req)
            except Exception as e:
                req = gen.throw(_translate(e))
                continue
            req = gen.send(res)
    except StopIteration as stop:
        return stop.value


async def _adrive(gen):
    try:
        req = next(gen)
        while True:
            try:
                res = await _ado(req)
            except Exception as e:
                req = gen.throw(_translate(e))
                continue
            req = gen.send(res)
    except StopIteration as stop:
        return stop.value


def _do(req):
    k = req[0]
    if k == "complete":
        return fa_llm.complete(req[1])
    if k == "upstream":
        return fa_llm.upstream(**req[1])
    raise ValueError(k)


async def _ado(req):
    k = req[0]
    if k == "complete":
        return await fa_llm.acomplete(req[1])
    if k == "upstream":
        return await fa_llm.aupstream(**req[1])
    raise ValueError(k)


def _model(r, requested):
    return (r or {}).get("model") or requested or "assistant"


# ---------------------------------------------------------------- 各 API 的操作（generator）
def _op_chat(model=None, messages=None, stream=False, stream_options=None, **kw):
    req = fa_llm.chat_request(model, messages, **kw)
    r = yield ("complete", req)
    r = dict(r or {})
    r["model"] = _model(r, model)
    if stream:
        gen = fa_llm.chat_chunks(r, include_usage=bool((stream_options or {}).get("include_usage")))
        return ("stream", gen)
    r.setdefault("object", "chat.completion")
    return ("obj", r)


def _op_completion(model=None, prompt=None, stream=False, **kw):
    r = yield ("complete", fa_llm.completions_to_chat(prompt, model=model, **{k: v for k, v in kw.items() if k in ("temperature", "max_tokens", "top_p", "stop", "n", "seed")}))
    d = fa_llm.chat_to_completion(r)
    d["model"] = _model(r, model)
    if stream:
        def gen():
            for c in d["choices"]:
                text = c["text"]
                for i in range(0, len(text), 24):
                    yield {"id": d["id"], "object": "text_completion", "created": d["created"], "model": d["model"], "choices": [{"text": text[i:i + 24], "index": c["index"], "finish_reason": None}]}
            yield {"id": d["id"], "object": "text_completion", "created": d["created"], "model": d["model"], "choices": [{"text": "", "index": 0, "finish_reason": "stop"}]}
        return ("stream", gen())
    return ("obj", d)


def _op_response(model=None, input=None, instructions=None, stream=False, **kw):
    r = yield ("complete", fa_llm.responses_to_chat(model=model, input=input, instructions=instructions, **kw))
    d = fa_llm.chat_to_response(r, model)
    if stream:
        return ("stream", fa_llm.response_events(d))
    return ("obj", d)


def _op_embeddings(input=None, model=None, dimensions=None, encoding_format=None, **kw):
    body = {"input": input, "model": model or "text-embedding-3-small"}
    if dimensions:
        body["dimensions"] = dimensions
    if encoding_format:
        body["encoding_format"] = encoding_format
    r = yield ("upstream", {"cap": "embeddings", "path": "/embeddings", "json_body": body})
    return ("obj", (r or {}).get("json") or {})


def _op_image(kind, **kw):
    path = {"generate": "/images/generations", "edit": "/images/edits", "variation": "/images/variations"}[kind]
    if kind == "generate":
        body = {k: v for k, v in kw.items() if v is not None}
        r = yield ("upstream", {"cap": "images", "path": path, "json_body": body})
    else:
        files, fields = [], {}
        for k, v in kw.items():
            if v is None:
                continue
            if k in ("image", "mask"):
                for item in (v if isinstance(v, list) else [v]):
                    files.append(fa_llm.file_part("image[]" if isinstance(v, list) else k, item, k + ".png", "image/png"))
            else:
                fields[k] = v
        r = yield ("upstream", {"cap": "images", "path": path, "form": {"fields": fields, "files": files}})
    return ("obj", (r or {}).get("json") or {})


def _op_audio(kind, **kw):
    if kind == "speech":
        body = {k: v for k, v in kw.items() if v is not None}
        r = yield ("upstream", {"cap": "audio_speech", "path": "/audio/speech", "json_body": body, "want": "bytes"})
        import base64
        return ("bytes", base64.b64decode((r or {}).get("b64") or ""), (r or {}).get("content_type"))
    path = "/audio/transcriptions" if kind == "transcriptions" else "/audio/translations"
    files = [fa_llm.file_part("file", kw.pop("file"), "audio.wav", "audio/wav")]
    fields = {k: v for k, v in kw.items() if v is not None}
    fmt = fields.get("response_format")
    r = yield ("upstream", {"cap": "audio_transcribe", "path": path, "form": {"fields": fields, "files": files}, "want": "bytes" if fmt in ("text", "srt", "vtt") else "json"})
    if fmt in ("text", "srt", "vtt"):
        import base64
        return ("text", base64.b64decode((r or {}).get("b64") or "").decode("utf-8", "replace"))
    return ("obj", (r or {}).get("json") or {})


def _finish(res):
    k = res[0]
    if k == "obj":
        return _Obj(res[1])
    if k == "stream":
        return res[1]
    if k == "bytes":
        return fa_sim.SimBytes(res[1], res[2])
    return res[1]


def _run(gen):
    res = _drive(gen)
    return Stream(res[1]) if res[0] == "stream" else _finish(res)


async def _arun(gen):
    res = await _adrive(gen)
    return AsyncStream(res[1]) if res[0] == "stream" else _finish(res)


# ---------------------------------------------------------------- 資源（同步與 async 兩套，內容一致）
def _make_resources(A):
    """A=True 產生 async 版。回傳 (client 屬性建立函式)。用 exec 風格太難讀，這裡用小工廠。"""
    run = _arun if A else _run

    def call(gen):
        return run(gen)

    class _Wrap(object):
        def __init__(self, fn):
            self._fn = fn

        def __call__(self, *a, **kw):
            return self._fn(*a, **kw)

    def method(op):
        if A:
            async def m(self, *a, **kw):
                return await run(op(*a, **kw))
        else:
            def m(self, *a, **kw):
                return run(op(*a, **kw))
        return m

    def raw_method(op):
        if A:
            async def m(self, *a, **kw):
                return _Raw(await run(op(*a, **kw)))
        else:
            def m(self, *a, **kw):
                return _Raw(run(op(*a, **kw)))
        return m

    def simple(fn, wrap=True):
        if A:
            async def m(self, *a, **kw):
                return _wrapx(fn(*a, **kw), wrap)
        else:
            def m(self, *a, **kw):
                return _wrapx(fn(*a, **kw), wrap)
        return m

    def _wrapx(v, wrap):
        return _Obj(v) if wrap and isinstance(v, dict) else v

    class WithRaw(object):
        def __init__(self, op):
            self.create = raw_method(op).__get__(self)

    class Completions(object):
        create = method(_op_chat)

        def __init__(self):
            self.with_raw_response = WithRaw(_op_chat)
            self.with_streaming_response = WithRaw(_op_chat)

        def parse(self, *a, **kw):
            fmt = kw.get("response_format")
            kw2 = dict(kw)
            if fmt is not None and not isinstance(fmt, dict):
                kw2["response_format"] = {"type": "json_object"}
            if A:
                async def go():
                    r = await self.create(*a, **kw2)
                    return _parsed(r, fmt)
                return go()
            return _parsed(self.create(*a, **kw2), fmt)

        def __getattr__(self, k):
            raise NotSupportedError("chat.completions.%s 在 AI 助理的 openai 轉接版沒有支援" % k)

    def _parsed(r, fmt):
        try:
            text = r.choices[0].message.content
            data = json.loads(text)
            if fmt is not None and hasattr(fmt, "model_validate"):
                data = fmt.model_validate(data)
            r.choices[0].message.__dict__["_d"]["parsed"] = data
        except Exception:
            pass
        return r

    class Chat(object):
        def __init__(self):
            self.completions = Completions()

        def __getattr__(self, k):
            raise NotSupportedError("chat.%s 在 AI 助理的 openai 轉接版沒有支援" % k)

    class LegacyCompletions(object):
        create = method(_op_completion)

    class Responses(object):
        create = method(_op_response)

        def __init__(self):
            self.with_raw_response = WithRaw(_op_response)

        def __getattr__(self, k):
            raise NotSupportedError("responses.%s 在 AI 助理的 openai 轉接版沒有支援（只有 create）" % k)

    class Embeddings(object):
        create = method(_op_embeddings)

        def __init__(self):
            self.with_raw_response = WithRaw(_op_embeddings)

    class Images(object):
        def generate(self, **kw):
            return call(_op_image("generate", **kw)) if not A else _arun(_op_image("generate", **kw))

        def edit(self, **kw):
            return call(_op_image("edit", **kw)) if not A else _arun(_op_image("edit", **kw))

        def create_variation(self, **kw):
            return call(_op_image("variation", **kw)) if not A else _arun(_op_image("variation", **kw))

    class _AudioSub(object):
        def __init__(self, kind):
            self.kind = kind
            self.with_streaming_response = self

        def create(self, **kw):
            gen = _op_audio(self.kind, **kw)
            return _arun(gen) if A else _run(gen)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class Audio(object):
        def __init__(self):
            self.transcriptions = _AudioSub("transcriptions")
            self.translations = _AudioSub("translations")
            self.speech = _AudioSub("speech")

    class Models(object):
        list = simple(lambda: fa_sim.models(_current_model())[0])
        retrieve = simple(lambda model: fa_sim.models(model)[1])

    class Moderations(object):
        create = simple(lambda **kw: fa_sim.moderation(**kw))

    class Files(object):
        create = simple(lambda **kw: fa_sim.file_create(**kw))
        retrieve = simple(lambda fid: fa_sim.file_get(fid)[0])
        list = simple(lambda **kw: fa_sim.file_list())
        delete = simple(lambda fid: fa_sim.file_delete(fid))
        content = simple(lambda fid: fa_sim.SimBytes(fa_sim.file_get(fid)[1]), wrap=False)
        retrieve_content = content

    class Batches(object):
        create = simple(lambda **kw: fa_sim.batch_create(**kw))
        retrieve = simple(lambda bid: fa_sim.batch_get(bid))

    class _Jobs(object):
        create = simple(lambda **kw: fa_sim.finetune_create(**kw))
        retrieve = simple(lambda jid: fa_sim._STORE["jobs"][jid])

    class FineTuning(object):
        def __init__(self):
            self.jobs = _Jobs()

    class _Messages(object):
        create = simple(lambda thread_id, **kw: fa_sim.message_create(thread_id, **kw))
        list = simple(lambda thread_id, **kw: fa_sim.messages_list(thread_id, **kw))

    class _Runs(object):
        create = simple(lambda thread_id, **kw: fa_sim.run_create(thread_id, **kw))
        create_and_poll = create
        retrieve = simple(lambda thread_id, run_id: {"id": run_id, "object": "thread.run", "status": "completed"})

    class _Threads(object):
        create = simple(lambda **kw: fa_sim.thread_create(**kw))

        def __init__(self):
            self.messages = _Messages()
            self.runs = _Runs()

    class _Assistants(object):
        create = simple(lambda **kw: fa_sim.assistant_create(**kw))

    class _VectorStores(object):
        create = simple(lambda **kw: fa_sim.vector_store_create(**kw))

    class Beta(object):
        def __init__(self):
            self.chat = Chat()
            self.threads = _Threads()
            self.assistants = _Assistants()
            self.vector_stores = _VectorStores()

    return dict(Chat=Chat, Completions=LegacyCompletions, Responses=Responses, Embeddings=Embeddings, Images=Images, Audio=Audio, Models=Models,
                Moderations=Moderations, Files=Files, Batches=Batches, FineTuning=FineTuning, Beta=Beta, VectorStores=_VectorStores)


_CURRENT = {"model": None}


def _current_model():
    if _CURRENT["model"] is None:
        try:
            _CURRENT["model"] = fa_bridge.call("llm.info", {}, timeout=10.0).get("model")
        except Exception:
            _CURRENT["model"] = "assistant"
    return _CURRENT["model"]


def _client_class(A):
    R = _make_resources(A)

    class _Client(object):
        def __init__(self, api_key=None, base_url=None, organization=None, project=None, timeout=None, max_retries=None, default_headers=None, http_client=None, **kw):
            self.api_key = api_key
            self.base_url = base_url
            self.organization = organization
            self.project = project
            self.timeout = timeout
            self.max_retries = max_retries
            self.chat = R["Chat"]()
            self.completions = R["Completions"]()
            self.responses = R["Responses"]()
            self.embeddings = R["Embeddings"]()
            self.images = R["Images"]()
            self.audio = R["Audio"]()
            self.models = R["Models"]()
            self.moderations = R["Moderations"]()
            self.files = R["Files"]()
            self.batches = R["Batches"]()
            self.fine_tuning = R["FineTuning"]()
            self.beta = R["Beta"]()
            self.vector_stores = R["VectorStores"]()
            self.with_raw_response = self
            self.with_streaming_response = self

        def with_options(self, **kw):
            return self

        copy = with_options

        def close(self):
            return None

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def __getattr__(self, k):
            if k.startswith("__"):
                raise AttributeError(k)
            raise NotSupportedError("client.%s 在 AI 助理的 openai 轉接版沒有支援" % k)

    return _Client


class OpenAI(_client_class(False)):
    pass


class AsyncOpenAI(_client_class(True)):
    async def close(self):
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


AzureOpenAI = OpenAI
AsyncAzureOpenAI = AsyncOpenAI

# 舊版（0.x）的模組層級寫法：openai.ChatCompletion.create(...)、openai.Embedding.create(...)
_default = OpenAI()
chat = _default.chat
completions = _default.completions
responses = _default.responses
embeddings = _default.embeddings
images = _default.images
audio = _default.audio
models = _default.models
moderations = _default.moderations
files = _default.files
api_key = None
base_url = None


class ChatCompletion(object):
    @staticmethod
    def create(*a, **kw):
        return _default.chat.completions.create(*a, **kw)


class Embedding(object):
    @staticmethod
    def create(*a, **kw):
        return _default.embeddings.create(*a, **kw)


class Completion(object):
    @staticmethod
    def create(*a, **kw):
        return _default.completions.create(*a, **kw)
