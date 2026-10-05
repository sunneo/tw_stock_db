# -*- coding: utf-8 -*-
"""
anthropic（Claude）的「轉接版」：Floating AI Assistant 在執行技能包的 Python 腳本時提供。

腳本照原本的寫法（同步或 async）：
    from anthropic import Anthropic, AsyncAnthropic
    client = Anthropic(api_key=...)
    msg = client.messages.create(model="claude-...", max_tokens=1024, system="...", messages=[...], tools=[...])
    print(msg.content[0].text)
    with client.messages.stream(...) as s:
        for t in s.text_stream: ...

實際上不會連 Anthropic，而是把 Claude 格式的請求轉成 chat/completions，交給助理「已設定的 LLM Model 清單」裡的 Model
（有 tools 就挑支援工具呼叫的、有圖片就挑支援讀圖的；腳本自己的 api_key、model 都忽略），再把回應轉回 Claude 的格式
（content 區塊、stop_reason、usage、tool_use、串流事件）。所有 Model 都不支援該功能才丟 anthropic.NotSupportedError。
"""
import json
import re

import fa_bridge
import fa_llm

__version__ = "0.99.0+fa-bridge"


# ---------------------------------------------------------------- 錯誤
class AnthropicError(Exception):
    pass


class APIError(AnthropicError):
    def __init__(self, message="", request=None, body=None, **kw):
        super(APIError, self).__init__(message)
        self.message = message
        self.request = request
        self.body = body


class APIStatusError(APIError):
    status_code = 500

    def __init__(self, message="", response=None, body=None, status_code=None, **kw):
        super(APIStatusError, self).__init__(message, body=body)
        self.response = response
        if status_code:
            self.status_code = status_code


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


class RateLimitError(APIStatusError):
    status_code = 429


class InternalServerError(APIStatusError):
    status_code = 500


class NotSupportedError(APIStatusError, NotImplementedError):
    status_code = 501


_CLS = {400: BadRequestError, 401: AuthenticationError, 403: PermissionDeniedError, 404: NotFoundError, 429: RateLimitError}


def _translate(e):
    if isinstance(e, fa_bridge.NotSupported):
        return NotSupportedError(str(e) or "沒有任何已設定的 LLM Model 支援這個功能")
    msg = str(e)
    m = re.search(r"API錯誤\((\d{3})\)", msg)
    if m:
        c = int(m.group(1))
        return (_CLS.get(c) or (InternalServerError if c >= 500 else APIStatusError))(msg, status_code=c)
    if "逾時" in msg:
        return APITimeoutError(msg)
    return APIConnectionError(msg)


# ---------------------------------------------------------------- 物件
class _Obj(object):
    def __init__(self, d):
        self.__dict__["_d"] = d

    def __getattr__(self, k):
        if k.startswith("__"):
            raise AttributeError(k)
        return _wrap(self.__dict__["_d"].get(k))

    def __getitem__(self, k):
        return _wrap(self.__dict__["_d"][k])

    def get(self, k, default=None):
        return _wrap(self.__dict__["_d"].get(k, default))

    def to_dict(self, **kw):
        return self.__dict__["_d"]

    model_dump = to_dict

    def to_json(self, **kw):
        return json.dumps(self.__dict__["_d"], ensure_ascii=False)

    model_dump_json = to_json

    def __repr__(self):
        return "<anthropic.%s %r>" % (self.__dict__["_d"].get("type", "obj"), self.__dict__["_d"])


def _wrap(v):
    if isinstance(v, dict):
        return _Obj(v)
    if isinstance(v, list):
        return [_wrap(x) for x in v]
    return v


def _message(resp, model):
    return fa_llm.chat_to_anthropic(resp, model)


# ---------------------------------------------------------------- 串流管理員：messages.stream(...)
class MessageStream(object):
    def __init__(self, msg):
        self._m = msg
        self._events = list(fa_llm.anthropic_events(msg))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        for e in self._events:
            yield _Obj(e)

    @property
    def text_stream(self):
        for e in self._events:
            if e.get("type") == "content_block_delta" and e["delta"].get("type") == "text_delta":
                yield e["delta"]["text"]

    def get_final_message(self):
        return _Obj(self._m)

    def get_final_text(self):
        return "".join(b.get("text", "") for b in self._m["content"] if b["type"] == "text")

    def until_done(self):
        return None


class AsyncMessageStream(object):
    def __init__(self, awaitable_msg):
        self._aw = awaitable_msg
        self._m = None
        self._events = []

    async def __aenter__(self):
        self._m = await self._aw
        self._events = list(fa_llm.anthropic_events(self._m))
        return self

    async def __aexit__(self, *a):
        return False

    def __aiter__(self):
        async def gen():
            for e in self._events:
                yield _Obj(e)
        return gen()

    @property
    def text_stream(self):
        async def gen():
            for e in self._events:
                if e.get("type") == "content_block_delta" and e["delta"].get("type") == "text_delta":
                    yield e["delta"]["text"]
        return gen()

    async def get_final_message(self):
        return _Obj(self._m)

    async def get_final_text(self):
        return "".join(b.get("text", "") for b in self._m["content"] if b["type"] == "text")


class Stream(object):
    def __init__(self, events):
        self._it = iter(events)

    def __iter__(self):
        return self

    def __next__(self):
        return _Obj(next(self._it))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class AsyncStream(object):
    def __init__(self, events):
        self._it = iter(events)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return _Obj(next(self._it))
        except StopIteration:
            raise StopAsyncIteration

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


# ---------------------------------------------------------------- 資源
def _build(A):
    def prep(kw):
        model = kw.get("model")
        stream = kw.get("stream", False)
        req = fa_llm.anthropic_to_chat(**{k: v for k, v in kw.items() if k != "stream"})
        return model, stream, req

    class Messages(object):
        if A:
            async def create(self, **kw):
                model, stream, req = prep(kw)
                try:
                    r = await fa_llm.acomplete(req)
                except Exception as e:
                    raise _translate(e)
                m = _message(r, model)
                return AsyncStream(fa_llm.anthropic_events(m)) if stream else _Obj(m)

            def stream(self, **kw):
                model, _, req = prep(kw)

                async def go():
                    try:
                        r = await fa_llm.acomplete(req)
                    except Exception as e:
                        raise _translate(e)
                    return _message(r, model)
                return AsyncMessageStream(go())

            async def count_tokens(self, **kw):
                return _Obj({"input_tokens": fa_llm.estimate_tokens({"s": kw.get("system"), "m": kw.get("messages")})})
        else:
            def create(self, **kw):
                model, stream, req = prep(kw)
                try:
                    r = fa_llm.complete(req)
                except Exception as e:
                    raise _translate(e)
                m = _message(r, model)
                return Stream(fa_llm.anthropic_events(m)) if stream else _Obj(m)

            def stream(self, **kw):
                model, _, req = prep(kw)
                try:
                    r = fa_llm.complete(req)
                except Exception as e:
                    raise _translate(e)
                return MessageStream(_message(r, model))

            def count_tokens(self, **kw):
                return _Obj({"input_tokens": fa_llm.estimate_tokens({"s": kw.get("system"), "m": kw.get("messages")})})

        def __getattr__(self, k):
            raise NotSupportedError("messages.%s 在 AI 助理的 anthropic 轉接版沒有支援" % k)

    class Completions(object):
        """舊的 text completions（prompt 以 \\n\\nHuman: … \\n\\nAssistant: 組成）。"""
        if A:
            async def create(self, model=None, prompt="", max_tokens_to_sample=1024, **kw):
                msgs = _legacy_prompt(prompt)
                r = await fa_llm.acomplete(fa_llm.chat_request(model, msgs, max_tokens=max_tokens_to_sample, temperature=kw.get("temperature")))
                return _Obj({"id": "compl_fa", "type": "completion", "model": model, "completion": fa_llm.text_of(r["choices"][0]["message"]["content"]), "stop_reason": "stop_sequence"})
        else:
            def create(self, model=None, prompt="", max_tokens_to_sample=1024, **kw):
                msgs = _legacy_prompt(prompt)
                r = fa_llm.complete(fa_llm.chat_request(model, msgs, max_tokens=max_tokens_to_sample, temperature=kw.get("temperature")))
                return _Obj({"id": "compl_fa", "type": "completion", "model": model, "completion": fa_llm.text_of(r["choices"][0]["message"]["content"]), "stop_reason": "stop_sequence"})

    class Models(object):
        def _info(self):
            try:
                return fa_bridge.call("llm.info", {}, timeout=10.0).get("model") or "assistant"
            except Exception:
                return "assistant"

        if A:
            async def list(self, **kw):
                return _Obj({"data": [{"id": self._info(), "type": "model", "display_name": self._info()}], "has_more": False})
        else:
            def list(self, **kw):
                return _Obj({"data": [{"id": self._info(), "type": "model", "display_name": self._info()}], "has_more": False})

    class Client(object):
        def __init__(self, api_key=None, base_url=None, auth_token=None, timeout=None, max_retries=None, default_headers=None, http_client=None, **kw):
            self.api_key = api_key
            self.base_url = base_url
            self.messages = Messages()
            self.completions = Completions()
            self.models = Models()
            self.beta = self

        def with_options(self, **kw):
            return self

        copy = with_options

        def close(self):
            return None

        def __getattr__(self, k):
            if k.startswith("__"):
                raise AttributeError(k)
            raise NotSupportedError("client.%s 在 AI 助理的 anthropic 轉接版沒有支援" % k)
    return Client


def _legacy_prompt(prompt):
    msgs = []
    parts = re.split(r"\n\n(Human|Assistant):", "\n\n" + str(prompt or ""))
    i = 1
    while i + 1 < len(parts):
        role = "user" if parts[i] == "Human" else "assistant"
        txt = parts[i + 1].strip()
        if txt:
            msgs.append({"role": role, "content": txt})
        i += 2
    return msgs or [{"role": "user", "content": str(prompt or "")}]


class Anthropic(_build(False)):
    pass


class AsyncAnthropic(_build(True)):
    async def close(self):
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


HUMAN_PROMPT = "\n\nHuman:"
AI_PROMPT = "\n\nAssistant:"
