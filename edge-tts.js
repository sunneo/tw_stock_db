// 本機版 /edge-tts 路由：轉接 Microsoft Edge 神經網路語音（免費、不用金鑰），給 AI 助理的中文/粵語/日文/韓文語音用。
// 移植自 Cloudflare Worker 的 handleEdgeTts（見 tw_stock_db_code 的 code/cloudflare-worker/worker.js），
// 協定細節相同：Sec-MS-GEC 簽章、speech.config + ssml 兩則文字訊息、二進位 audio frame（2 bytes 長度前綴 + header + 音訊）。
// 這裡用 Electron 主行程（Node 22+）內建的 WebSocket（undici），它允許在建構時指定 headers（瀏覽器版不行，
// 這也是需要代理的原因）。
"use strict";
const crypto = require("crypto");

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"; // 公開已知的固定值，不是使用者的密鑰
const CHROMIUM_VERSION = "143.0.3650.75";
const WINDOWS_EPOCH_OFFSET_SEC = 11644473600;
const VOICE_PATTERN = /^[A-Za-z]{2}-[A-Za-z]{2,8}-[A-Za-z0-9]+Neural$/;
const PROSODY_PATTERN = /^[+-]?\d{1,3}(%|Hz)$/;
const MAX_TEXT_LENGTH = 4000;
const TIMEOUT_MS = 15000;

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

function secMsGec() {
  let ticks = Date.now() / 1000 + WINDOWS_EPOCH_OFFSET_SEC;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  return crypto.createHash("sha256").update(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`).digest("hex").toUpperCase();
}

function parseBinaryFrame(data) {
  if (data.length < 2) return null;
  const headerLength = (data[0] << 8) | data[1];
  if (data.length < 2 + headerLength) return null;
  const headers = {};
  for (const line of Buffer.from(data.slice(2, 2 + headerLength)).toString("utf8").split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return { headers, body: data.slice(2 + headerLength) };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 1024 * 1024) { reject(new Error("body too large")); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function synthesize({ text, voice, rate, pitch, volume }) {
  return new Promise((resolve) => {
    if (typeof WebSocket === "undefined") return resolve({ ok: false, error: "這個 Electron 版本的主行程沒有內建 WebSocket，無法使用本機中文語音" });
    const connectionId = crypto.randomUUID().replace(/-/g, "");
    const url = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
      + `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}&ConnectionId=${connectionId}`;
    const major = CHROMIUM_VERSION.split(".")[0];
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: {
          "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
          Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: `muid=${crypto.randomBytes(16).toString("hex").toUpperCase()};`,
        },
      });
    } catch (err) { return resolve({ ok: false, error: "無法建立連線：" + String((err && err.message) || err) }); }
    ws.binaryType = "arraybuffer";
    const audio = [];
    const debug = [];
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch (_) {} resolve(Object.assign({}, r, { audioParts: r.ok ? audio : null })); };
    const timer = setTimeout(() => finish({ ok: false, error: `逾時（${TIMEOUT_MS / 1000}秒內沒有收到完整音訊）` }), TIMEOUT_MS);
    ws.addEventListener("open", () => {
      ws.send('Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      const requestId = crypto.randomUUID().replace(/-/g, "");
      const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
        + `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.addEventListener("message", (evt) => {
      if (typeof evt.data === "string") {
        const m = /Path:(\S+)/.exec(evt.data);
        const p = m ? m[1] : "?";
        if (debug.length < 10) debug.push("text:" + p);
        if (p === "turn.end") finish(audio.length ? { ok: true } : { ok: false, error: `收到turn.end但沒有任何音訊（${JSON.stringify(debug)}）` });
        return;
      }
      const frame = parseBinaryFrame(new Uint8Array(evt.data));
      if (!frame) { if (debug.length < 10) debug.push("binary:malformed"); return; }
      if (frame.headers.Path === "audio" && frame.body.length > 0) audio.push(Buffer.from(frame.body));
      else if (debug.length < 10) debug.push(`binary:${frame.headers.Path || "?"}(${frame.body.length}B)`);
    });
    ws.addEventListener("close", (evt) => finish(audio.length ? { ok: true } : { ok: false, error: `WebSocket關閉時還沒收到音訊（code=${evt.code} reason=${evt.reason || "無"}）：${JSON.stringify(debug)}` }));
    ws.addEventListener("error", (evt) => finish({ ok: false, error: `WebSocket連線錯誤：${(evt && (evt.message || (evt.error && evt.error.message))) || "unknown"}（可能是 Sec-MS-GEC 簽章過期或網路被擋）` }));
  });
}

async function handleEdgeTts(req, res) {
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  let body;
  try { body = await readJsonBody(req); } catch (_) { return json(400, { ok: false, error: "invalid JSON body" }); }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json(400, { ok: false, error: "缺少text" });
  if (text.length > MAX_TEXT_LENGTH) return json(400, { ok: false, error: `文字過長（${text.length}字元，單次上限${MAX_TEXT_LENGTH}），請分段` });
  const voice = typeof body.voice === "string" ? body.voice.trim() : "";
  if (!VOICE_PATTERN.test(voice)) return json(400, { ok: false, error: `voice格式不合法（例如 zh-TW-HsiaoChenNeural）：${voice}` });
  const pick = (v, dflt) => (PROSODY_PATTERN.test(v) ? v : dflt);
  const r = await synthesize({ text, voice, rate: pick(body.rate, "+0%"), pitch: pick(body.pitch, "+0Hz"), volume: pick(body.volume, "+0%") });
  if (!r.ok || !r.audioParts || !r.audioParts.length) return json(502, { ok: false, error: r.error || "沒有收到音訊資料" });
  const merged = Buffer.concat(r.audioParts);
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": String(merged.length) });
  res.end(merged);
}

module.exports = { handleEdgeTts };
