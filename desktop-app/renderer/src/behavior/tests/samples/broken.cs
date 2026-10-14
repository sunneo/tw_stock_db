using System.IO;
namespace Demo
{
    public class Broken
    {
        /// <summary>Reads a file, but uses syntax the grammar may not know.</summary>
        public string Load(string path)
        {
            var text = File.ReadAllText(path);
            string json = """
                {"a": 1}
                """;
            if (text is { Length: > 3 } and not "x") { Console.WriteLine(text); }
            return text switch { "a" => "b", _ => json };
        }

        public void Save(string path, string data)
        {
            #if DEBUG
            Console.WriteLine("saving");
            #endif
            File.WriteAllText(path, data
        }

        public void After() { Directory.CreateDirectory("x"); }
    }
}
