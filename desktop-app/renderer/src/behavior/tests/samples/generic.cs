using System.Collections.Generic;
using System.Linq;
class Generic {
    string Build(List<string> names, Dictionary<string,int> map, System.Text.StringBuilder sb) {
        var s = string.Join(", ", names);
        var v = map["x"];
        names.Add(s);
        names.Remove("q");
        sb.Append(s);
        if (names.Contains("z") || names.Count > 3) { return s.Trim().ToLower(); }
        var t = names.Where(x => x.Length > 1).Select(x => x.Trim()).ToList();
        t.Sort();
        return s + t.Count;
    }
}
