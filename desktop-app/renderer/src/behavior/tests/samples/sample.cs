using System;
using System.IO;
using System.Net.Http;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Demo
{
    /// <summary>Loads and caches the scene description.</summary>
    public class SceneLoader : IDisposable
    {
        private readonly HttpClient client = new HttpClient();
        private int count;
        public string Name { get; set; }

        public SceneLoader(string name) { Name = name; }

        /// <summary>Read a scene file and parse it as JSON.</summary>
        public async Task<string> LoadAsync(string path)
        {
            if (!File.Exists(path)) { throw new FileNotFoundException(path); }
            var text = await File.ReadAllTextAsync(path);
            var doc = JsonSerializer.Deserialize<Dictionary<string, object>>(text);
            foreach (var kv in doc) { Console.WriteLine($"{kv.Key}={kv.Value}"); }
            for (int i = 0; i < 3; i++) { count += i; }
            while (count > 0) { count--; }
            return text;
        }

        public async Task<string> FetchAsync(string url)
        {
            try
            {
                var resp = await client.GetAsync(url);
                resp.EnsureSuccessStatusCode();
                return await resp.Content.ReadAsStringAsync();
            }
            catch (HttpRequestException e) { Console.Error.WriteLine(e.Message); return null; }
            finally { Console.WriteLine("done"); }
        }

        public int Run(string cmd)
        {
            var psi = new ProcessStartInfo(cmd) { RedirectStandardOutput = true };
            var proc = Process.Start(psi);
            proc.WaitForExit();
            var home = Environment.GetEnvironmentVariable("HOME");
            Thread.Sleep(100);
            var t = Task.Run(() => count++);
            lock (this) { count += 1; }
            return proc.ExitCode;
        }

        public void Save(string path, string data)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, data);
            using (var conn = new SqliteConnection("Data Source=x.db"))
            {
                conn.Open();
                var cmd = conn.CreateCommand();
                cmd.ExecuteNonQuery();
            }
            var now = DateTime.UtcNow;
            var rnd = new Random();
            switch (count) { case 1: break; default: break; }
        }

        public int Twice(int a) => a * 2;
        public void Dispose() { client.Dispose(); }
    }
}
