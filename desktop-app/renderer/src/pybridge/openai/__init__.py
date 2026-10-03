# -*- coding: utf-8 -*-
"""
openai 的「轉接版」：Floating AI Assistant 在執行技能包的 Python 腳本時提供。

腳本照原本的寫法：
    from openai import OpenAI
    client = OpenAI(base_url=..., api_key=...)
    resp = client.chat.completions.create(model=..., messages=[...], max_tokens=..., temperature=...)
    resp.choices[0].message.content

但實際上不會連腳本設定的 base_url／金鑰，而是用 AI 助理目前選用的模型回答（使用者在助理設定的那一組），
所以腳本不需要自己的 LLM 設定或金鑰。base_url、api_key、model 等參數會被忽略。

支援：chat.completions.create（非串流）。其他功能（串流、embeddings、images、audio…）會丟出說明清楚的 NotImplementedError。
"""
import fa_bridge

__all__ = ["OpenAI", "AsyncOpenAI"]


class _Obj(object):
    """把 dict 變成可以用屬性存取的物件（resp.choices[0].message.content）。"""

    def __init__(self, d):
        self.__dict__["_d"] = d

    def __getattr__(self, k):
        v = self.__dict__["_d"].get(k)
        if isinstance(v, dict):
            return _Obj(v)
        if isinstance(v, list):
            return [_Obj(x) if isinstance(x, dict) else x for x in v]
        return v

    def to_dict(self):
        return self.__dict__["_d"]

    model_dump = to_dict

    def __repr__(self):
        return "<openai.response %r>" % (self.__dict__["_d"],)


def _nyi(what):
    raise NotImplementedError(
        "%s 在 AI 助理的 openai 轉接版沒有支援（目前只支援非串流的 chat.completions.create）。"
        "需要別的能力時，改用 fa_bridge.tool(...) 或 fa_bridge.domain(...)。" % what)


class _Completions(object):
    def create(self, model=None, messages=None, max_tokens=None, temperature=None, stream=False, **kw):
        if stream:
            _nyi("stream=True")
        r = fa_bridge.call("llm.chat", {"messages": messages or [], "max_tokens": max_tokens, "temperature": temperature}, timeout=600.0)
        text = (r or {}).get("text", "")
        return _Obj({
            "id": "fa-bridge",
            "object": "chat.completion",
            "model": (r or {}).get("model") or model or "assistant",
            "choices": [{"index": 0, "finish_reason": (r or {}).get("finish_reason") or "stop",
                         "message": {"role": "assistant", "content": text}}],
            "usage": (r or {}).get("usage") or {},
        })

    def __getattr__(self, k):
        _nyi("chat.completions." + k)


class _Chat(object):
    def __init__(self):
        self.completions = _Completions()

    def __getattr__(self, k):
        _nyi("chat." + k)


class OpenAI(object):
    def __init__(self, base_url=None, api_key=None, **kw):
        self.base_url = base_url
        self.chat = _Chat()

    def __getattr__(self, k):
        _nyi("client." + k)


class AsyncOpenAI(OpenAI):
    pass


class APIError(Exception):
    pass


class RateLimitError(APIError):
    pass
