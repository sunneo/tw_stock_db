function build(names, map, list, p, buf) {
  const s = names.join(", ");
  const v = map.get("x");
  map.set("a", 1);
  list.push(s);
  list.sort();
  const t = s.split(",").map((x) => x.trim()).filter(Boolean);
  p.then((r) => r.length).catch(() => 0);
  buf.write("x");
  return t.length + list.length;
}
