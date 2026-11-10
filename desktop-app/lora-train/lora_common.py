"""Shared row normalisation + encoding used by training, DPO and eval (one encoding everywhere).

Reference row format: {task, kind, messages, tools, prefill, chosen, rejected}.
Our unified rows (schema.md) carry id/domain/stage/split/meta and `completion` instead of `chosen`; this module maps
them so both formats train/eval identically:
    chosen  = row.chosen  or row.completion
    task    = row.task    or row.domain          kind = row.kind or row.stage
    tools   = row.tools (may be None)            prefill = row.prefill or ''
Encoding (same as the reference): apply_chat_template(messages, tools=tools, add_generation_prompt=True,
enable_thinking=False, tokenize=False) + prefill, then loss only on  chosen + '<|im_end|>'.
(meta.thinking=True rows keep enable_thinking=True.)
"""
import json, os


def read_jsonl(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def normalize(row):
    r = dict(row)
    r["chosen"] = row.get("chosen") if row.get("chosen") is not None else row.get("completion")
    r["task"] = row.get("task") or row.get("domain") or "?"
    r["kind"] = row.get("kind") or row.get("stage") or "?"
    r["tools"] = row.get("tools") or None
    r["prefill"] = row.get("prefill") or ""
    r["rejected"] = row.get("rejected")
    return r


def prompt_text(tok, x):
    thinking = bool((x.get("meta") or {}).get("thinking", False))
    return tok.apply_chat_template(x["messages"], tools=x["tools"], add_generation_prompt=True,
                                   enable_thinking=thinking, tokenize=False) + x["prefill"]


def encode(tok, x, tail=None, seq=None):
    """-> (ids, labels). labels are -100 over the prompt(+prefill); loss on tail + <|im_end|> (tail defaults to chosen)."""
    seq = seq or int(os.environ.get("LORA_SEQ", 1024))
    a = tok(prompt_text(tok, x), add_special_tokens=False)["input_ids"]
    b = tok((x["chosen"] if tail is None else tail) + "<|im_end|>", add_special_tokens=False)["input_ids"]
    return (a + b)[-seq:], ([-100] * len(a) + b)[-seq:]
