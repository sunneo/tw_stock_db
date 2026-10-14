def build(names, d, q, items, path):
    s = ", ".join(names)
    v = d.get("x")
    d.update({"a": 1})
    items.append(s)
    items.sort()
    n = len(items)
    parts = s.split(",")
    text = s.strip().lower()
    return "%s-%d" % (text, n)


def lookup(conn, key, cache):
    row = cache.get(key)
    if row is None:
        row = conn.get(key)
    return row
