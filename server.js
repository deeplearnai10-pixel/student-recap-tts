const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const WebSocket = require("ws");

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM = "143.0.3650.75";
const GEC_VERSION = `1-${CHROMIUM}`;
const MAJOR = CHROMIUM.split(".")[0];
const HOSTS = [
  `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=${TOKEN}`,
  `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}`,
];
const VOICES = ["my-MM-ThihaNeural", "my-MM-NilarNeural"];
const MAX_BYTES = 4096;
const TICKS_PER_BYTE = 10000000 / 6000; // 48 kbps CBR = 6000 bytes/sec

let skewSec = 0;

const uuid = () => crypto.randomUUID().replace(/-/g, "");

function genGec() {
  let secs = Math.floor(Date.now() / 1000 + skewSec) + 11644473600;
  secs -= secs % 300;
  const ticks = BigInt(secs) * 10000000n;
  return crypto.createHash("sha256").update(`${ticks}${TOKEN}`, "ascii").digest("hex").toUpperCase();
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function fullVoiceName(v) {
  const [a, b, name] = v.split("-");
  return `Microsoft Server Speech Text to Speech Voice (${a}-${b}, ${name})`;
}

function splitText(text) {
  const fits = (s) => Buffer.byteLength(escapeXml(s), "utf8") <= MAX_BYTES;
  const parts = text.replace(/\r/g, "").split(/(?<=[။?!.\n])/);
  const out = [];
  let cur = "";
  for (let p of parts) {
    if (fits(cur + p)) { cur += p; continue; }
    if (cur.trim()) out.push(cur);
    cur = "";
    while (!fits(p)) {
      let cut = p.length;
      while (cut > 1 && !fits(p.slice(0, cut))) cut = Math.floor(cut * 0.9);
      const sp = p.lastIndexOf(" ", cut);
      if (sp > cut * 0.5) cut = sp;
      out.push(p.slice(0, cut));
      p = p.slice(cut);
    }
    cur = p;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function synthOnce(url, ssml) {
  return new Promise((resolve, reject) => {
    const full = `${url}&Sec-MS-GEC=${genGec()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${uuid()}`;
    const ws = new WebSocket(full, {
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `muid=${crypto.randomBytes(16).toString("hex").toUpperCase()};`,
      },
    });

    const audio = [];
    const words = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error("TTS timeout")), 60000);

    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      err ? reject(err) : resolve({ audio: Buffer.concat(audio), words });
    }

    ws.on("unexpected-response", (req, res) => {
      const e = new Error(`Edge TTS handshake ${res.statusCode}`);
      e.status = res.statusCode;
      const d = Date.parse(res.headers.date || "");
      e.serverDate = isNaN(d) ? null : d;
      finish(e);
    });
    ws.on("error", (e) => finish(e));

    ws.on("open", () => {
      const ts = new Date().toString();
      const config = {
        context: { synthesis: { audio: {
          metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" },
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        } } },
      };
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(config)}\r\n`);
      ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) {
        if (buf.length < 2) return;
        const hl = buf.readUInt16BE(0);                 // measured from START of whole message
        const headers = buf.subarray(2, hl + 2).toString();
        if (headers.includes("Path:audio")) {
          const body = buf.subarray(hl + 2);            // NOT slice-then-+2
          if (body.length) audio.push(body);
        }
        return;
      }
      const str = buf.toString();
      const sep = str.indexOf("\r\n\r\n");
      const head = str.slice(0, sep);
      const body = str.slice(sep + 4);
      if (head.includes("Path:audio.metadata")) {
        try {
          for (const m of JSON.parse(body).Metadata || []) {
            if (m.Type === "WordBoundary") {
              words.push({ offset: m.Data.Offset, duration: m.Data.Duration, text: m.Data.text.Text });
            }
          }
        } catch {}
      } else if (head.includes("Path:turn.end")) {
        finish();
      }
    });
  });
}

async function synthChunk(text, voice, rate, pitch) {
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${fullVoiceName(voice)}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
  let lastErr;
  for (const url of HOSTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await synthOnce(url, ssml);
        if (!r.audio.length) throw new Error("No audio received");
        return r;
      } catch (e) {
        lastErr = e;
        if (e.status === 403 && e.serverDate && attempt === 0) {
          skewSec = (e.serverDate - Date.now()) / 1000; // one-time clock-skew retry
          continue;
        }
        break;
      }
    }
  }
  throw lastErr;
}

function isMp3(b) {
  return b.length > 3 && ((b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || b.subarray(0, 3).toString() === "ID3");
}

function toSrtTime(ticks) {
  const ms = Math.floor(ticks / 10000);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

function buildSrt(words) {
  const sep = words.some((w) => /[\u1000-\u109F]/.test(w.text)) ? "" : " ";
  const cues = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    const text = cur.map((x) => x.text).join(sep);
    const dur = w.offset + w.duration - cur[0].offset;
    if (text.length >= 40 || dur >= 35000000 || /[။?!.]$/.test(w.text)) { cues.push(cur); cur = []; }
  }
  if (cur.length) cues.push(cur);
  return cues.map((c, i) => {
    const last = c[c.length - 1];
    return `${i + 1}\n${toSrtTime(c[0].offset)} --> ${toSrtTime(last.offset + last.duration)}\n${c.map((x) => x.text).join(sep)}\n`;
  }).join("\n");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/voices", (req, res) => res.json({ voices: VOICES }));

app.post("/tts-srt", async (req, res) => {
  let { text, voice = "my-MM-ThihaNeural", rate = "+30%", pitch = "+0Hz" } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "text is required" });
  text = String(text);
  if (text.length > 20000) return res.status(413).json({ error: "text too long (max 20000 characters)" });
  if (!VOICES.includes(voice)) voice = "my-MM-ThihaNeural";
  if (!/^[+-]\d{1,3}%$/.test(rate)) rate = "+30%";
  if (!/^[+-]\d{1,3}Hz$/.test(pitch)) pitch = "+0Hz";

  try {
    const audioParts = [];
    const allWords = [];
    let offset = 0;
    for (const chunk of splitText(text)) {
      const r = await synthChunk(chunk, voice, rate, pitch);
      for (const w of r.words) allWords.push({ ...w, offset: w.offset + offset });
      audioParts.push(r.audio);
      offset += r.audio.length * TICKS_PER_BYTE; // CBR offset compensation
    }
    const audio = Buffer.concat(audioParts);
    if (!isMp3(audio)) throw new Error("Output is not valid MP3 (frame sync check failed)");
    console.log(`TTS ok: ${audio.length} bytes, ${allWords.length} word boundaries`);
    res.json({ audio: audio.toString("base64"), srt: buildSrt(allWords) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TTS server running on ${PORT}`));
