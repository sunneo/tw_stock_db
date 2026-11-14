# -*- coding: utf-8 -*-
"""
guitpl_yaml -- the YAML subset a template can be written in (the emulator is not guaranteed to have a YAML package).

A YAML template is the same records as a .jsonl file, written as YAML documents separated by `---`; each document is one record:

    kind: meta
    id: demo/hello
    title: 打招呼
    standalone: true
    ---
    kind: layout
    window: {title: "{{title}}", width: 320}
    tree:
      - kind: column
        children:
          - id: hi
            kind: label
            text: 哈囉

Supported: block mappings and block sequences (spaces only, no tabs), `key: value`, `- item`, `- key: value` with more keys indented
under it, flow sequences `[a, b]` and flow mappings `{a: 1, b: [2, 3]}` (nested), double-quoted strings (JSON escapes), single-quoted
strings ('' for a quote), plain strings, integers, floats, true, false, null (also ~), comments (`#` at the start of a line or after a space,
outside quotes). Not supported (clear error): anchors and aliases (&, *), tags (!), multi-line strings (| and >), `? ` complex keys,
merge keys (<<), tabs, a document that is not a mapping. The JavaScript twin is renderer/src/guitpl/yaml_core.js; both must give the same records.
"""
import json
import re

NUMBER_RE = re.compile(r"^[-+]?(\d+)(\.\d+)?([eE][-+]?\d+)?$")


class YamlError(ValueError):
    pass


def _strip_comment(s):
    q = None
    i = 0
    while i < len(s):
        c = s[i]
        if q:
            if c == "\\" and q == '"':
                i += 2
                continue
            if c == q:
                if q == "'" and s[i + 1:i + 2] == "'":
                    i += 2
                    continue
                q = None
        elif c in "\"'" and (i == 0 or s[i - 1] in " \t[{,:-"):
            q = c
        elif c == "#" and (i == 0 or s[i - 1] in " \t"):
            return s[:i]
        i += 1
    return s


def _split_key(s):
    """(key, rest) when s is `key: rest` or `key:`; None when it is not a mapping line."""
    if not s or s[0] in "[{\"'" and not _quoted_key(s):
        return None
    i = 0
    if s[0] in "\"'":
        q = s[0]
        i = 1
        while i < len(s):
            if s[i] == "\\" and q == '"':
                i += 2
                continue
            if s[i] == q:
                if q == "'" and s[i + 1:i + 2] == "'":
                    i += 2
                    continue
                break
            i += 1
        if i >= len(s) or s[i + 1:i + 2] != ":" or (len(s) > i + 2 and s[i + 2] != " "):
            return None
        return _scalar(s[:i + 1]), s[i + 2:].strip()
    j = s.find(": ")
    if j < 0:
        if s.endswith(":"):
            j = len(s) - 1
        else:
            return None
    key = s[:j].strip()
    if not key or key[0] in "&*!|>?%@`":
        return None
    return key, s[j + 1:].strip()


def _quoted_key(s):
    return s[0] in "\"'"


def _scalar(s):
    s = s.strip()
    if s == "":
        return None
    if s[0] == '"':
        try:
            v, end = json.JSONDecoder().raw_decode(s)
        except ValueError:
            raise YamlError("雙引號字串沒有結尾或跳脫字元不對：%s" % s)
        if s[end:].strip():
            raise YamlError("字串後面還有多餘的字：%s" % s)
        return v
    if s[0] == "'":
        if not s.endswith("'") or len(s) < 2:
            raise YamlError("單引號字串沒有結尾：%s" % s)
        return s[1:-1].replace("''", "'")
    if s[0] in "&*!":
        raise YamlError("不支援錨點、別名與標籤：%s" % s)
    if s[0] in "|>":
        raise YamlError("不支援多行字串（| 與 >）：請用雙引號字串加 \\n")
    if s in ("true", "True"):
        return True
    if s in ("false", "False"):
        return False
    if s in ("null", "Null", "~"):
        return None
    if NUMBER_RE.match(s):
        return float(s) if ("." in s or "e" in s or "E" in s) else int(s)
    return s


class _Flow(object):
    def __init__(self, s):
        self.s = s
        self.i = 0

    def ws(self):
        while self.i < len(self.s) and self.s[self.i] in " \t":
            self.i += 1

    def value(self):
        self.ws()
        if self.i >= len(self.s):
            raise YamlError("行內寫法沒有寫完：%s" % self.s)
        c = self.s[self.i]
        if c == "[":
            self.i += 1
            out = []
            self.ws()
            if self.s[self.i:self.i + 1] == "]":
                self.i += 1
                return out
            while True:
                out.append(self.value())
                self.ws()
                c2 = self.s[self.i:self.i + 1]
                self.i += 1
                if c2 == ",":
                    self.ws()
                    if self.s[self.i:self.i + 1] == "]":  # trailing comma
                        self.i += 1
                        return out
                    continue
                if c2 == "]":
                    return out
                raise YamlError("行內陣列要用逗號分隔、用 ] 結尾：%s" % self.s)
        if c == "{":
            self.i += 1
            out = {}
            self.ws()
            if self.s[self.i:self.i + 1] == "}":
                self.i += 1
                return out
            while True:
                self.ws()
                key = self.token(":")
                self.ws()
                if self.s[self.i:self.i + 1] != ":":
                    raise YamlError("行內對照缺少冒號：%s" % self.s)
                self.i += 1
                out[key] = self.value()
                self.ws()
                c2 = self.s[self.i:self.i + 1]
                self.i += 1
                if c2 == ",":
                    self.ws()
                    if self.s[self.i:self.i + 1] == "}":
                        self.i += 1
                        return out
                    continue
                if c2 == "}":
                    return out
                raise YamlError("行內對照要用逗號分隔、用 } 結尾：%s" % self.s)
        return self.token(",]}")

    def token(self, stops):
        self.ws()
        c = self.s[self.i:self.i + 1]
        if c in ("\"", "'"):
            j = self.i + 1
            while j < len(self.s):
                if self.s[j] == "\\" and c == '"':
                    j += 2
                    continue
                if self.s[j] == c:
                    if c == "'" and self.s[j + 1:j + 2] == "'":
                        j += 2
                        continue
                    break
                j += 1
            else:
                raise YamlError("行內的引號字串沒有結尾：%s" % self.s)
            lit = self.s[self.i:j + 1]
            self.i = j + 1
            return _scalar(lit)
        j = self.i
        while j < len(self.s) and self.s[j] not in stops:
            j += 1
        raw = self.s[self.i:j]
        self.i = j
        return _scalar(raw)


def _flow_or_scalar(s):
    s = s.strip()
    if s and s[0] in "[{":
        f = _Flow(s)
        v = f.value()
        f.ws()
        if f.i != len(s):
            raise YamlError("行內寫法後面還有多餘的字：%s" % s)
        return v
    return _scalar(s)


def _lines(text):
    out = []
    for n, raw in enumerate(text.split("\n"), 1):
        raw = raw.rstrip("\r")
        if "\t" in raw[:len(raw) - len(raw.lstrip())]:
            raise YamlError("第 %d 行：縮排不能用 tab" % n)
        body = _strip_comment(raw).rstrip()
        if not body.strip():
            continue
        out.append((len(body) - len(body.lstrip(" ")), body.strip(), n))
    return out


class _Parser(object):
    def __init__(self, lines):
        self.l = lines
        self.i = 0

    def block(self, indent):
        ind, content, _n = self.l[self.i]
        if content == "-" or content.startswith("- "):
            return self.seq(indent)
        return self.map(indent)

    def map(self, indent):
        out = {}
        while self.i < len(self.l):
            ind, content, n = self.l[self.i]
            if ind < indent:
                break
            if ind > indent:
                raise YamlError("第 %d 行：縮排對不上" % n)
            if content == "-" or content.startswith("- "):
                break
            kv = _split_key(content)
            if kv is None:
                raise YamlError("第 %d 行：不是「鍵: 值」的寫法：%s" % (n, content))
            key, rest = kv
            if key == "<<":
                raise YamlError("第 %d 行：不支援合併鍵 <<" % n)
            if key in out:
                raise YamlError("第 %d 行：鍵重複：%s" % (n, key))
            self.i += 1
            if rest:
                out[key] = _flow_or_scalar(rest)
            elif self.i < len(self.l) and (self.l[self.i][0] > indent or (self.l[self.i][0] == indent and (self.l[self.i][1] == "-" or self.l[self.i][1].startswith("- ")))):
                out[key] = self.block(self.l[self.i][0])
            else:
                out[key] = None
        return out

    def seq(self, indent):
        out = []
        while self.i < len(self.l):
            ind, content, n = self.l[self.i]
            if ind < indent:
                break
            if ind > indent:
                raise YamlError("第 %d 行：縮排對不上" % n)
            if not (content == "-" or content.startswith("- ")):
                break
            rest = content[1:].lstrip(" ")
            offset = len(content) - len(rest)
            if not rest:
                self.i += 1
                if self.i < len(self.l) and self.l[self.i][0] > indent:
                    out.append(self.block(self.l[self.i][0]))
                else:
                    out.append(None)
            elif _split_key(rest) is not None and rest[0] not in "[{":
                # "- key: value": the item is a mapping whose first line sits after the dash
                self.l[self.i] = (indent + offset, rest, n)
                out.append(self.map(indent + offset))
            else:
                self.i += 1
                out.append(_flow_or_scalar(rest))
        return out


def parse_documents(text):
    """The records of a YAML template text: a list of dicts, one per document (separated by lines of ---)."""
    docs = []
    cur = []
    for raw in str(text).replace("\r\n", "\n").split("\n"):
        if raw.rstrip() == "---" or raw.startswith("--- "):
            docs.append("\n".join(cur))
            cur = []
        else:
            cur.append(raw)
    docs.append("\n".join(cur))
    records = []
    first = 1
    for d in docs:
        lines = _lines(d)
        if not lines:
            continue
        p = _Parser(lines)
        v = p.block(lines[0][0])
        if p.i < len(lines):
            raise YamlError("第 %d 行：多出來的內容（縮排不對？）" % lines[p.i][2])
        if not isinstance(v, dict):
            raise YamlError("每份文件（以 --- 分開）要是一筆「鍵: 值」的紀錄")
        records.append(v)
    return records
