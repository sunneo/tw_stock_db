const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

/** Read a JSON file and return the parsed object. */
function loadConfig(file, strict) {
  if (!fs.existsSync(file)) { throw new Error('missing ' + file); }
  const text = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(text);
  for (const key of Object.keys(data)) { console.log(key, data[key]); }
  for (let i = 0; i < 3; i++) { data.count += i; }
  while (strict) { break; }
  return data;
}

async function fetchAndSave(url, out) {
  try {
    const res = await fetch(url);
    const body = await res.text();
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    await fs.promises.writeFile(out, body);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    setTimeout(() => console.log('saved', digest), 10);
    return digest;
  } catch (e) {
    console.error(e.message);
    return null;
  }
}

const run = (cmd) => {
  const out = execSync(cmd).toString();
  const home = process.env.HOME;
  const child = spawn('ls', ['-l']);
  child.on('close', (code) => console.log(code));
  localStorage.setItem('last', out);
  document.getElementById('out').textContent = out;
  return home;
};

module.exports = { loadConfig, fetchAndSave, run };
