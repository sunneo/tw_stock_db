# -*- coding: utf-8 -*-
"""
fa_sim — 助理沒有對應能力時的「回應模擬」（只用標準函式庫）。

OpenAI／Claude 的 API 有些功能助理沒有對應的東西（審核、檔案、批次、微調、assistants…）。
腳本在這些地方丟例外會讓整支腳本壞掉，所以這裡提供「結構正確、內容誠實」的模擬回應：
  * 欄位與型別跟真的一樣，腳本的後續處理不會因為少欄位而當掉；
  * 內容不假裝是真的：微調工作直接回報不支援、審核一律回報未違規並標示是模擬；
  * 每次模擬都會通知助理（fa_llm.note_simulated），上層 AI 看得到「哪些呼叫是模擬的」。
能真的做的就真的做：batches 逐筆走助理的模型、threads／runs 用助理的模型回答。
圖片、語音、嵌入、工具呼叫不模擬——先從已設定的 LLM Model 找有支援的，所有 Model 都不支援才丟 NotSupported。
"""
import base64
import io
import json
import re
import struct
import time
import uuid
import zlib

import fa_llm

_STORE = {"files": {}, "batches": {}, "threads": {}, "vector_stores": {}, "assistants": {}, "jobs": {}}


def _id(p):
    return "%s_%s" % (p, uuid.uuid4().hex[:20])


def _now():
    return int(time.time())


def _png(w=64, h=64, rgb=(200, 200, 200)):
    """產生純色 PNG（占位圖）。"""
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def _wav(seconds=0.2, rate=16000):
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return buf.getvalue()


class SimBytes(object):
    """語音／檔案內容的回應（有 .content、.read()、.iter_bytes()、.stream_to_file()）。"""

    def __init__(self, data):
        self.content = data

    def read(self):
        return self.content

    def iter_bytes(self, chunk_size=1024):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i:i + chunk_size]

    def stream_to_file(self, path):
        with open(path, "wb") as f:
            f.write(self.content)

    write_to_file = stream_to_file

    @property
    def text(self):
        return self.content.decode("utf-8", "replace")


def _mark(d, api):
    d["fa_simulated"] = True
    fa_llm.note_simulated(api)
    return d


# 圖片、語音、嵌入、工具呼叫「不」在這裡模擬：它們要先從助理已設定的 LLM Model 清單裡找有這個能力的 Model（fa_llm.upstream），
# 所有 Model 都不支援才丟 NotSupported，不會回傳假的結果。
class SimBytes(object):
    """二進位內容的回應（有 .content、.read()、.iter_bytes()、.stream_to_file()）。語音合成等真的由 Model 回傳的二進位用這個包起來。"""

    def __init__(self, data, content_type=None):
        self.content = data
        self.content_type = content_type

    def read(self):
        return self.content

    def iter_bytes(self, chunk_size=1024):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i:i + chunk_size]

    def stream_to_file(self, path):
        with open(path, "wb") as f:
            f.write(self.content)

    write_to_file = stream_to_file

    @property
    def text(self):
        return self.content.decode("utf-8", "replace")


def _mark(d, api):
    d["fa_simulated"] = True
    fa_llm.note_simulated(api)
    return d


# ---------------------------------------------------------------- 審核
_CATS = ["hate", "hate/threatening", "harassment", "harassment/threatening", "self-harm", "self-harm/intent", "self-harm/instructions",
         "sexual", "sexual/minors", "violence", "violence/graphic", "illicit", "illicit/violent"]


def moderation(input=None, model=None, **kw):
    items = input if isinstance(input, list) else [input]
    res = [{"flagged": False, "categories": {c: False for c in _CATS}, "category_scores": {c: 0.0 for c in _CATS}} for _ in items]
    return _mark({"id": _id("modr"), "model": model or "omni-moderation-latest", "results": res}, "moderations")


# ---------------------------------------------------------------- 模型
def models(current):
    m = {"id": current or "assistant", "object": "model", "created": _now(), "owned_by": "floating-assistant"}
    return {"object": "list", "data": [m]}, m


# ---------------------------------------------------------------- 檔案（記憶體內）
def file_create(file=None, purpose="assistants", **kw):
    data = b""
    name = "file"
    if isinstance(file, tuple):
        name = file[0]
        data = file[1] if len(file) > 1 else b""
        data = data.read() if hasattr(data, "read") else data
    elif hasattr(file, "read"):
        data = file.read()
        name = getattr(file, "name", name)
    elif isinstance(file, (bytes, str)):
        data = file if isinstance(file, bytes) else file.encode("utf-8")
    elif isinstance(file, str):
        data = open(file, "rb").read()
        name = file
    if isinstance(data, str):
        data = data.encode("utf-8")
    fid = _id("file")
    meta = {"id": fid, "object": "file", "bytes": len(data), "created_at": _now(), "filename": str(name).split("/")[-1].split(chr(92))[-1], "purpose": purpose, "status": "processed"}
    _STORE["files"][fid] = (meta, data)
    return _mark(dict(meta), "files.create")


def file_get(fid):
    if fid not in _STORE["files"]:
        raise KeyError(fid)
    return _STORE["files"][fid]


def file_list():
    return {"object": "list", "data": [m for m, _ in _STORE["files"].values()]}


def file_delete(fid):
    _STORE["files"].pop(fid, None)
    return {"id": fid, "object": "file", "deleted": True}


# ---------------------------------------------------------------- 批次：真的逐筆走助理的模型
def batch_create(input_file_id=None, endpoint="/v1/chat/completions", completion_window="24h", metadata=None, **kw):
    meta, data = file_get(input_file_id)
    outs, errs, total = [], [], 0
    for line in data.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        total += 1
        try:
            item = json.loads(line)
            body = item.get("body") or {}
            if "messages" in body:
                resp = fa_llm.complete(fa_llm.chat_request(**body))
            else:
                raise ValueError("只支援 chat/completions 的批次")
            outs.append({"id": _id("batch_req"), "custom_id": item.get("custom_id"), "response": {"status_code": 200, "request_id": _id("req"), "body": resp}, "error": None})
        except Exception as e:
            errs.append({"id": _id("batch_req"), "custom_id": (item or {}).get("custom_id") if isinstance(locals().get("item"), dict) else None,
                         "response": None, "error": {"code": "failed", "message": str(e)[:300]}})
    ofid = errfid = None
    if outs:
        ofid = file_create(("batch_output.jsonl", "\n".join(json.dumps(o, ensure_ascii=False) for o in outs).encode("utf-8")), purpose="batch_output")["id"]
    if errs:
        errfid = file_create(("batch_errors.jsonl", "\n".join(json.dumps(o, ensure_ascii=False) for o in errs).encode("utf-8")), purpose="batch_output")["id"]
    bid = _id("batch")
    b = {"id": bid, "object": "batch", "endpoint": endpoint, "input_file_id": input_file_id, "completion_window": completion_window, "status": "completed",
         "output_file_id": ofid, "error_file_id": errfid, "created_at": _now(), "completed_at": _now(),
         "request_counts": {"total": total, "completed": len(outs), "failed": len(errs)}, "metadata": metadata}
    _STORE["batches"][bid] = b
    return b


def batch_get(bid):
    if bid not in _STORE["batches"]:
        raise KeyError(bid)
    return _STORE["batches"][bid]


# ---------------------------------------------------------------- 微調：誠實回報不支援
def finetune_create(model=None, training_file=None, **kw):
    jid = _id("ftjob")
    j = {"id": jid, "object": "fine_tuning.job", "model": model, "training_file": training_file, "created_at": _now(), "status": "failed", "fine_tuned_model": None,
         "error": {"code": "not_supported", "message": "AI 助理的轉接層不支援微調（沒有可訓練的模型）。這是模擬回應。", "param": None}}
    _STORE["jobs"][jid] = j
    return _mark(dict(j), "fine_tuning.jobs.create")


# ---------------------------------------------------------------- threads／runs（Assistants，最小版：用助理的模型回答）
def thread_create(messages=None, **kw):
    tid = _id("thread")
    t = {"id": tid, "object": "thread", "created_at": _now(), "metadata": kw.get("metadata") or {}}
    _STORE["threads"][tid] = {"meta": t, "messages": []}
    for m in messages or []:
        message_create(tid, role=m.get("role", "user"), content=m.get("content", ""))
    return _mark(dict(t), "beta.threads.create")


def message_create(thread_id, role="user", content="", **kw):
    th = _STORE["threads"].get(thread_id)
    if th is None:
        raise KeyError(thread_id)
    msg = {"id": _id("msg"), "object": "thread.message", "created_at": _now(), "thread_id": thread_id, "role": role,
           "content": [{"type": "text", "text": {"value": fa_llm.text_of(content), "annotations": []}}], "assistant_id": kw.get("assistant_id"), "run_id": kw.get("run_id")}
    th["messages"].append(msg)
    return msg


def messages_list(thread_id, order="desc", limit=20):
    th = _STORE["threads"].get(thread_id)
    if th is None:
        raise KeyError(thread_id)
    msgs = list(th["messages"])
    if order == "desc":
        msgs.reverse()
    return {"object": "list", "data": msgs[:int(limit or 20)], "has_more": False}


def run_create(thread_id, assistant_id=None, instructions=None, **kw):
    th = _STORE["threads"].get(thread_id)
    if th is None:
        raise KeyError(thread_id)
    asst = _STORE["assistants"].get(assistant_id) or {}
    msgs = []
    sysm = instructions or asst.get("instructions")
    if sysm:
        msgs.append({"role": "system", "content": sysm})
    for m in th["messages"]:
        msgs.append({"role": m["role"], "content": m["content"][0]["text"]["value"]})
    rid = _id("run")
    try:
        resp = fa_llm.complete(fa_llm.chat_request(messages=msgs))
        text = fa_llm.text_of(((resp.get("choices") or [{}])[0].get("message") or {}).get("content"))
        message_create(thread_id, role="assistant", content=text, assistant_id=assistant_id, run_id=rid)
        status, err = "completed", None
    except Exception as e:
        status, err = "failed", {"code": "server_error", "message": str(e)[:300]}
    return {"id": rid, "object": "thread.run", "created_at": _now(), "thread_id": thread_id, "assistant_id": assistant_id, "status": status, "last_error": err,
            "completed_at": _now() if status == "completed" else None, "model": asst.get("model") or "assistant"}


def assistant_create(**kw):
    aid = _id("asst")
    a = {"id": aid, "object": "assistant", "created_at": _now(), "name": kw.get("name"), "description": kw.get("description"), "model": kw.get("model") or "assistant",
         "instructions": kw.get("instructions"), "tools": kw.get("tools") or [], "metadata": kw.get("metadata") or {}}
    _STORE["assistants"][aid] = a
    return _mark(dict(a), "beta.assistants.create")


def vector_store_create(name=None, **kw):
    vid = _id("vs")
    v = {"id": vid, "object": "vector_store", "created_at": _now(), "name": name, "status": "completed", "file_counts": {"in_progress": 0, "completed": 0, "failed": 0, "cancelled": 0, "total": 0}}
    _STORE["vector_stores"][vid] = v
    return _mark(dict(v), "vector_stores.create")
