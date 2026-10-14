import java.util.*;
class Generic {
    String build(List<String> names, Map<String, Integer> map, StringBuilder sb, Thread t) throws Exception {
        String s = String.join(", ", names);
        Integer v = map.get("x");
        map.put("a", 1);
        names.add(s);
        sb.append(s);
        if (names.isEmpty() || names.contains("z")) { return s.trim().toLowerCase(); }
        names.stream().map(String::trim).forEach(x -> {});
        return s + names.size();
    }
}
