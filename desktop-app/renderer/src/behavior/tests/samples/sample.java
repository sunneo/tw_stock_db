import java.io.*;
import java.net.URL;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.util.*;
import java.util.concurrent.*;
import java.util.logging.Logger;

public class Loader {
    private static final Logger LOG = Logger.getLogger("Loader");
    private int count;

    /** Read a text file fully and parse it into lines. */
    public List<String> load(String path) throws IOException {
        if (!Files.exists(Paths.get(path))) { throw new FileNotFoundException(path); }
        List<String> lines = Files.readAllLines(Paths.get(path));
        for (String line : lines) { LOG.info(line); }
        for (int i = 0; i < 3; i++) { count += i; }
        while (count > 0) { count--; }
        return lines;
    }

    public String fetch(String url) throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        HttpRequest req = HttpRequest.newBuilder().uri(new java.net.URI(url)).build();
        try {
            return client.send(req, java.net.http.HttpResponse.BodyHandlers.ofString()).body();
        } catch (IOException e) {
            System.err.println(e.getMessage());
            return null;
        } finally {
            System.out.println("done");
        }
    }

    public int run(String cmd) throws Exception {
        Process p = Runtime.getRuntime().exec(cmd);
        int rc = p.waitFor();
        String home = System.getenv("HOME");
        ExecutorService ex = Executors.newFixedThreadPool(2);
        ex.submit(() -> count++);
        Thread.sleep(100);
        long now = System.currentTimeMillis();
        Connection c = DriverManager.getConnection("jdbc:sqlite:x.db");
        c.createStatement().executeQuery("select 1");
        Files.write(Paths.get("/tmp/out"), "x".getBytes());
        return rc;
    }
}
