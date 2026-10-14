use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Command;
use std::thread;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Read a whole file into a string and echo it.
fn read_all(path: &str) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let mut s = String::new();
    f.read_to_string(&mut s)?;
    println!("read {} bytes", s.len());
    Ok(s)
}

fn run(cmd: &str) -> Result<i32, String> {
    let out = Command::new("sh").arg("-c").arg(cmd).output().map_err(|e| e.to_string())?;
    let home = std::env::var("HOME").unwrap_or_default();
    let counter = Arc::new(Mutex::new(0));
    let c2 = Arc::clone(&counter);
    let h = thread::spawn(move || { *c2.lock().unwrap() += 1; });
    h.join().unwrap();
    thread::sleep(Duration::from_millis(10));
    let start = Instant::now();
    if out.status.success() { Ok(0) } else { Err(format!("failed after {:?}", start.elapsed())) }
}

fn fetch(host: &str) -> std::io::Result<()> {
    let mut stream = TcpStream::connect(host)?;
    stream.write_all(b"GET / HTTP/1.0\r\n\r\n")?;
    fs::create_dir_all("/tmp/x")?;
    fs::write("/tmp/x/out", "hi")?;
    for i in 0..3 { if i == 2 { break; } }
    match fs::read_to_string("/tmp/x/out") { Ok(_) => {}, Err(e) => eprintln!("{}", e) }
    Ok(())
}
