# -*- coding: utf-8 -*-
"""
fa_llm — LLM API 的格式轉換與串流模擬（只用標準函式庫）。

助理實際使用的模型走「OpenAI 相容的 chat/completions」。腳本卻可能用各種寫法呼叫 LLM：
  * OpenAI 標準：chat.completions、responses、completions（舊）、embeddings
  * Claude（Anthropic）：messages
這個模組把它們全部轉成同一種請求（chat/completions），再把回應轉回腳本期待的格式，所以不管腳本用哪一種，
實際上都是助理目前選用的那個模型在回答。

兩種呼叫方式都支援：Python 套件（openai／anthropic，同步與 async）與直接送 HTTP（requests／httpx／urllib，見 fa_http.py）。
"""
import json
import time
import uuid

import fa_bridge


# ---------------------------------------------------------------- 小工具
def _id(prefix):
    return "%s_%s" % (prefix, uuid.uuid4().hex[:24])


def _now():
    return int(time.time())


def text_of(content):
    """把各種 content 形式（字串、區塊清單）變成純文字。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, str):
                out.append(b)
            elif isinstance(b, dict):
                t = b.get("type")
                if t in ("text", "input_text", "output_text") or ("text" in b and t is None):
                    out.append(str(b.get("text", "")))
                elif t == "tool_result":
                    out.append(text_of(b.get("content")))
        return "".join(out)
    if isinstance(content, dict):
        return str(content.get("text", ""))
    return str(content)


def estimate_tokens(text):
    """沒有真正的 tokenizer 時的粗估：英文約 4 字元一個 token，中日韓字約 1.3 字一個。"""
    s = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    cjk = sum(1 for ch in s if "぀" <= ch <= "鿿" or "가" <= ch <= "힯")
    return max(1, int(cjk / 1.3 + (len(s) - cjk) / 4.0))


# ---------------------------------------------------------------- 呼叫助理的模型
def complete(req, timeout=600.0):
    """req 是 OpenAI chat/completions 形式的 dict；回傳 OpenAI chat.completion 形式的 dict。"""
    return fa_bridge.call("llm.complete", req, timeout=timeout)


async def acomplete(req, timeout=600.0):
    return await fa_bridge.acall("llm.complete", req, timeout=timeout)


def vision_describe(image, prompt="", policy=None, max_tokens=None, timeout=900.0):
    """看圖：交給助理外層「抽象的 vision API」，由助理依設定決定用線上視覺模型還是離線模型（優先順序與備援都在外層處理）。
    image：bytes、檔案路徑（例如 /work/in/a.png）、data URL 或 http(s) 網址；prompt：一般的自然語言（中文英文都行，要描述、辨識文字或問問題）——
    各模型自己的提示詞格式由外層處理，這裡不用管。policy（選填）：llm-first／offline-first／llm／offline，不給就用助理的設定。
    回傳 dict：text、backend（"llm"或"offline"）、model、attempts（每個後端試了什麼、為什麼失敗）。"""
    import base64
    if isinstance(image, (bytes, bytearray)):
        img = "data:image/png;base64," + base64.b64encode(bytes(image)).decode("ascii")
    elif isinstance(image, str) and (image.startswith("data:") or image.startswith("http://") or image.startswith("https://")):
        img = image
    else:
        with open(image, "rb") as f:
            raw = f.read()
        ext = str(image).lower().rsplit(".", 1)[-1]
        mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp"}.get(ext, "image/png")
        img = "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))
    req = {"image": img, "prompt": prompt or ""}
    if policy:
        req["policy"] = policy
    if max_tokens:
        req["max_tokens"] = int(max_tokens)
    return fa_bridge.call("vision.describe", req, timeout=timeout)


async def avision_describe(image, prompt="", policy=None, max_tokens=None, timeout=900.0):
    """vision_describe 的 async 版本。"""
    import base64
    if isinstance(image, (bytes, bytearray)):
        img = "data:image/png;base64," + base64.b64encode(bytes(image)).decode("ascii")
    elif isinstance(image, str) and (image.startswith("data:") or image.startswith("http://") or image.startswith("https://")):
        img = image
    else:
        with open(image, "rb") as f:
            raw = f.read()
        img = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
    req = {"image": img, "prompt": prompt or ""}
    if policy:
        req["policy"] = policy
    if max_tokens:
        req["max_tokens"] = int(max_tokens)
    return await fa_bridge.acall("vision.describe", req, timeout=timeout)


def upstream(cap, path, json_body=None, form=None, want="json", method="POST", timeout=600.0):
    """把一個 OpenAI 標準的 HTTP 呼叫轉給助理「已設定的 LLM Model 清單」裡有這個能力的那一個（依序試，第一個成功的就用）。
    cap：embeddings、images、audio_transcribe、audio_speech、chat、tools、vision。
    所有 Model 都不支援才會丟 fa_bridge.NotSupported。回傳 {status, content_type, json | b64, model}。"""
    return fa_bridge.call("llm.upstream", {"cap": cap, "path": path, "method": method, "json": json_body, "form": form, "want": want}, timeout=timeout)


async def aupstream(cap, path, json_body=None, form=None, want="json", method="POST", timeout=600.0):
    return await fa_bridge.acall("llm.upstream", {"cap": cap, "path": path, "method": method, "json": json_body, "form": form, "want": want}, timeout=timeout)


def file_part(name, file, default_filename="file", default_type="application/octet-stream"):
    """把腳本給的檔案（bytes、路徑、檔案物件、(檔名, 內容[, 類型]) 元組）變成可以傳過橋接的表單檔案。"""
    import base64
    import mimetypes
    import os
    filename, data, ctype = default_filename, None, None
    if isinstance(file, tuple):
        filename = file[0] or filename
        data = file[1] if len(file) > 1 else b""
        ctype = file[2] if len(file) > 2 else None
    else:
        data = file
    if isinstance(data, str) and os.path.exists(data):
        filename = os.path.basename(data)
        data = open(data, "rb").read()
    elif hasattr(data, "read"):
        filename = os.path.basename(str(getattr(data, "name", filename)))
        data = data.read()
    elif hasattr(data, "__fspath__"):
        filename = os.path.basename(str(data))
        data = open(data, "rb").read()
    if isinstance(data, str):
        data = data.encode("utf-8")
    ctype = ctype or mimetypes.guess_type(filename)[0] or default_type
    return {"name": name, "filename": filename, "type": ctype, "b64": base64.b64encode(data or b"").decode("ascii")}


def note_simulated(api):
    """告訴助理：這個呼叫是模擬的（助理沒有對應能力），讓上層 AI 知道結果不是真的。"""
    try:
        fa_bridge.call("sim.note", {"api": api}, timeout=10.0)
    except Exception:
        pass


# ---------------------------------------------------------------- OpenAI chat 的清理
_CHAT_KEYS = ("messages", "temperature", "top_p", "max_tokens", "stop", "tools", "tool_choice", "response_format",
              "n", "presence_penalty", "frequency_penalty", "seed", "user", "logit_bias", "parallel_tool_calls")


def chat_request(model=None, messages=None, **kw):
    """整理成可以送去上游的 chat/completions 請求（丟掉上游不一定認得的欄位）。"""
    req = {"messages": list(messages or [])}
    if kw.get("max_completion_tokens") is not None and kw.get("max_tokens") is None:
        kw["max_tokens"] = kw["max_completion_tokens"]
    for k in _CHAT_KEYS:
        if k == "messages":
            continue
        v = kw.get(k)
        if v is not None:
            req[k] = v
    if model:
        req["_requested_model"] = model
    return req


def chat_chunks(resp, chunk_chars=24, include_usage=False):
    """把一個完整的 chat.completion 變成串流的 chunk（模擬串流：上游先整段回來，再分段送出）。"""
    cid = resp.get("id") or _id("chatcmpl")
    model = resp.get("model") or "assistant"
    created = resp.get("created") or _now()
    base = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model}
    for ch in resp.get("choices") or [{}]:
        idx = ch.get("index", 0)
        msg = ch.get("message") or {}
        yield dict(base, choices=[{"index": idx, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}])
        text = text_of(msg.get("content"))
        for i in range(0, len(text), max(1, chunk_chars)):
            yield dict(base, choices=[{"index": idx, "delta": {"content": text[i:i + chunk_chars]}, "finish_reason": None}])
        for ti, tc in enumerate(msg.get("tool_calls") or []):
            fn = tc.get("function") or {}
            yield dict(base, choices=[{"index": idx, "delta": {"tool_calls": [{"index": ti, "id": tc.get("id") or _id("call"), "type": "function",
                                                                              "function": {"name": fn.get("name", ""), "arguments": fn.get("arguments", "")}}]},
                                       "finish_reason": None}])
        yield dict(base, choices=[{"index": idx, "delta": {}, "finish_reason": ch.get("finish_reason") or "stop"}])
    if include_usage:
        yield dict(base, choices=[], usage=resp.get("usage") or {})


# ---------------------------------------------------------------- 舊的 completions
def completions_to_chat(prompt, **kw):
    if isinstance(prompt, list):
        prompt = "\n".join(str(p) for p in prompt)
    return chat_request(messages=[{"role": "user", "content": str(prompt or "")}], **kw)


def chat_to_completion(resp):
    return {"id": (resp.get("id") or _id("cmpl")).replace("chatcmpl", "cmpl"), "object": "text_completion", "created": resp.get("created") or _now(),
            "model": resp.get("model") or "assistant",
            "choices": [{"text": text_of((c.get("message") or {}).get("content")), "index": c.get("index", 0), "logprobs": None,
                         "finish_reason": c.get("finish_reason") or "stop"} for c in resp.get("choices") or []],
            "usage": resp.get("usage") or {}}


# ---------------------------------------------------------------- OpenAI Responses API
def _resp_content_to_chat(content):
    if isinstance(content, str):
        return content
    parts = []
    for b in content or []:
        t = b.get("type") if isinstance(b, dict) else None
        if t in ("input_text", "output_text", "text"):
            parts.append({"type": "text", "text": b.get("text", "")})
        elif t == "input_image":
            url = b.get("image_url") or b.get("url") or ""
            parts.append({"type": "image_url", "image_url": {"url": url if isinstance(url, str) else (url or {}).get("url", "")}})
    if all(p["type"] == "text" for p in parts):
        return "".join(p["text"] for p in parts)
    return parts


def responses_to_chat(model=None, input=None, instructions=None, **kw):
    msgs = []
    if instructions:
        msgs.append({"role": "system", "content": str(instructions)})
    if isinstance(input, str):
        msgs.append({"role": "user", "content": input})
    else:
        for it in input or []:
            t = it.get("type", "message") if isinstance(it, dict) else "message"
            if t == "message" or "role" in it:
                role = it.get("role", "user")
                msgs.append({"role": "system" if role == "developer" else role, "content": _resp_content_to_chat(it.get("content"))})
            elif t == "function_call":
                msgs.append({"role": "assistant", "content": None, "tool_calls": [{"id": it.get("call_id") or it.get("id") or _id("call"), "type": "function",
                                                                                     "function": {"name": it.get("name", ""), "arguments": it.get("arguments", "{}")}}]})
            elif t == "function_call_output":
                msgs.append({"role": "tool", "tool_call_id": it.get("call_id", ""), "content": text_of(it.get("output"))})
    tools = None
    if kw.get("tools"):
        tools = []
        for t in kw["tools"]:
            if t.get("type") == "function":
                fn = t.get("function") or {"name": t.get("name"), "description": t.get("description", ""), "parameters": t.get("parameters") or {"type": "object", "properties": {}}}
                tools.append({"type": "function", "function": fn})
    rf = None
    fmt = (kw.get("text") or {}).get("format") if isinstance(kw.get("text"), dict) else None
    if isinstance(fmt, dict) and fmt.get("type") in ("json_object", "json_schema"):
        rf = {"type": fmt["type"]}
        if fmt["type"] == "json_schema":
            rf["json_schema"] = {"name": fmt.get("name", "output"), "schema": fmt.get("schema") or {}, "strict": bool(fmt.get("strict"))}
    return chat_request(model=model, messages=msgs, temperature=kw.get("temperature"), top_p=kw.get("top_p"),
                        max_tokens=kw.get("max_output_tokens"), tools=tools, tool_choice=kw.get("tool_choice"), response_format=rf)


def chat_to_response(resp, requested=None):
    ch = (resp.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    text = text_of(msg.get("content"))
    rid = _id("resp")
    output = []
    if text or not msg.get("tool_calls"):
        output.append({"id": _id("msg"), "type": "message", "status": "completed", "role": "assistant",
                       "content": [{"type": "output_text", "text": text, "annotations": []}]})
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        output.append({"id": _id("fc"), "type": "function_call", "status": "completed", "call_id": tc.get("id") or _id("call"),
                       "name": fn.get("name", ""), "arguments": fn.get("arguments", "{}")})
    u = resp.get("usage") or {}
    pt, ct = u.get("prompt_tokens") or 0, u.get("completion_tokens") or 0
    return {"id": rid, "object": "response", "created_at": resp.get("created") or _now(), "status": "completed", "error": None,
            "model": resp.get("model") or requested or "assistant", "output": output, "output_text": text,
            "usage": {"input_tokens": pt, "output_tokens": ct, "total_tokens": u.get("total_tokens") or (pt + ct)}}


def response_events(r, chunk_chars=24):
    """Responses API 的串流事件（模擬）。"""
    seq = 0

    def ev(t, **kw):
        nonlocal seq
        seq += 1
        d = {"type": t, "sequence_number": seq}
        d.update(kw)
        return d
    skeleton = dict(r, status="in_progress", output=[], output_text="")
    yield ev("response.created", response=skeleton)
    yield ev("response.in_progress", response=skeleton)
    for oi, item in enumerate(r.get("output") or []):
        yield ev("response.output_item.added", output_index=oi, item=dict(item, status="in_progress", content=[]) if item["type"] == "message" else item)
        if item["type"] == "message":
            yield ev("response.content_part.added", output_index=oi, content_index=0, item_id=item["id"], part={"type": "output_text", "text": "", "annotations": []})
            t = item["content"][0]["text"]
            for i in range(0, len(t), max(1, chunk_chars)):
                yield ev("response.output_text.delta", output_index=oi, content_index=0, item_id=item["id"], delta=t[i:i + chunk_chars])
            yield ev("response.output_text.done", output_index=oi, content_index=0, item_id=item["id"], text=t)
            yield ev("response.content_part.done", output_index=oi, content_index=0, item_id=item["id"], part=item["content"][0])
        elif item["type"] == "function_call":
            yield ev("response.function_call_arguments.delta", output_index=oi, item_id=item["id"], delta=item.get("arguments", ""))
            yield ev("response.function_call_arguments.done", output_index=oi, item_id=item["id"], arguments=item.get("arguments", ""))
        yield ev("response.output_item.done", output_index=oi, item=item)
    yield ev("response.completed", response=r)


# ---------------------------------------------------------------- Anthropic（Claude）messages
_STOP_MAP = {"stop": "end_turn", "length": "max_tokens", "tool_calls": "tool_use", "function_call": "tool_use", "content_filter": "refusal"}


def _a_content_to_chat(content, role):
    """Anthropic 的 content（字串或區塊）→ OpenAI 的訊息清單（可能展開成多則：tool_result 要變成 role=tool）。"""
    if isinstance(content, str):
        return [{"role": role, "content": content}]
    parts, tool_calls, tool_msgs = [], [], []
    for b in content or []:
        t = b.get("type")
        if t == "text":
            parts.append({"type": "text", "text": b.get("text", "")})
        elif t == "image":
            src = b.get("source") or {}
            if src.get("type") == "base64":
                parts.append({"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (src.get("media_type", "image/png"), src.get("data", ""))}})
            elif src.get("type") == "url":
                parts.append({"type": "image_url", "image_url": {"url": src.get("url", "")}})
        elif t == "tool_use":
            tool_calls.append({"id": b.get("id") or _id("toolu"), "type": "function",
                               "function": {"name": b.get("name", ""), "arguments": json.dumps(b.get("input") or {}, ensure_ascii=False)}})
        elif t == "tool_result":
            tool_msgs.append({"role": "tool", "tool_call_id": b.get("tool_use_id", ""), "content": text_of(b.get("content")) or ("（錯誤）" if b.get("is_error") else "")})
        elif t in ("thinking", "redacted_thinking"):
            continue
    out = []
    if parts or tool_calls:
        msg = {"role": role}
        if parts and all(p["type"] == "text" for p in parts):
            msg["content"] = "".join(p["text"] for p in parts)
        else:
            msg["content"] = parts or None
        if tool_calls:
            msg["tool_calls"] = tool_calls
        out.append(msg)
    return tool_msgs + out if role == "user" else out + tool_msgs


def anthropic_to_chat(model=None, messages=None, system=None, max_tokens=None, temperature=None, top_p=None, stop_sequences=None, tools=None, tool_choice=None, **kw):
    msgs = []
    if system:
        msgs.append({"role": "system", "content": text_of(system)})
    for m in messages or []:
        msgs.extend(_a_content_to_chat(m.get("content"), m.get("role", "user")))
    oa_tools = None
    if tools:
        oa_tools = [{"type": "function", "function": {"name": t.get("name"), "description": t.get("description", ""),
                                                      "parameters": t.get("input_schema") or {"type": "object", "properties": {}}}} for t in tools if t.get("name")]
    tc = None
    if isinstance(tool_choice, dict):
        k = tool_choice.get("type")
        tc = "auto" if k == "auto" else ("required" if k == "any" else ({"type": "function", "function": {"name": tool_choice.get("name")}} if k == "tool" else ("none" if k == "none" else None)))
    return chat_request(model=model, messages=msgs, temperature=temperature, top_p=top_p, max_tokens=max_tokens, stop=stop_sequences or None, tools=oa_tools, tool_choice=tc)


def chat_to_anthropic(resp, requested=None):
    ch = (resp.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    content = []
    text = text_of(msg.get("content"))
    if text or not msg.get("tool_calls"):
        content.append({"type": "text", "text": text})
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        try:
            inp = json.loads(fn.get("arguments") or "{}")
        except ValueError:
            inp = {"_raw": fn.get("arguments")}
        content.append({"type": "tool_use", "id": tc.get("id") or _id("toolu"), "name": fn.get("name", ""), "input": inp})
    u = resp.get("usage") or {}
    return {"id": _id("msg"), "type": "message", "role": "assistant", "model": resp.get("model") or requested or "assistant", "content": content,
            "stop_reason": _STOP_MAP.get(ch.get("finish_reason") or "stop", "end_turn"), "stop_sequence": None,
            "usage": {"input_tokens": u.get("prompt_tokens") or 0, "output_tokens": u.get("completion_tokens") or 0}}


def anthropic_events(m, chunk_chars=24):
    """Anthropic messages 的串流事件（模擬）。"""
    start = dict(m, content=[], stop_reason=None, usage={"input_tokens": m["usage"]["input_tokens"], "output_tokens": 0})
    yield {"type": "message_start", "message": start}
    for i, b in enumerate(m["content"]):
        if b["type"] == "text":
            yield {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}
            t = b["text"]
            for k in range(0, len(t), max(1, chunk_chars)):
                yield {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": t[k:k + chunk_chars]}}
        else:
            yield {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}}}
            js = json.dumps(b["input"], ensure_ascii=False)
            for k in range(0, len(js), 40):
                yield {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": js[k:k + 40]}}
        yield {"type": "content_block_stop", "index": i}
    yield {"type": "message_delta", "delta": {"stop_reason": m["stop_reason"], "stop_sequence": None}, "usage": {"output_tokens": m["usage"]["output_tokens"]}}
    yield {"type": "message_stop"}


# ---------------------------------------------------------------- SSE 文字（給直接送 HTTP 的腳本用）
def sse(events, done=False):
    out = []
    for e in events:
        name = e.get("type") if isinstance(e, dict) and "type" in e and "object" not in e else None
        out.append(("event: %s\n" % name if name else "") + "data: " + json.dumps(e, ensure_ascii=False) + "\n\n")
    if done:
        out.append("data: [DONE]\n\n")
    return "".join(out)


# ---------------------------------------------------------------- 嵌入（回應）格式
def embeddings_response(vectors, model, tokens=0):
    return {"object": "list", "model": model or "assistant-embedding",
            "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)],
            "usage": {"prompt_tokens": tokens, "total_tokens": tokens}}
