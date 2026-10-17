const express = require("express");
const cors = require("cors");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));

function toSrtTime(ticks) {
  const ms = Math.floor(ticks / 10000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const r = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${r}`;
}

function buildSrt(words) {
  const sep = words.some((w) => /[\u1000-\u109F]/.test(w.text)) ? "" : " ";
  const cues = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    const text = cur.map((x) => x.text).join(sep);
    const dur = w.offset + w.duration - cur[0].offset;
    if (text.length >= 40 || dur >= 35000000 || /[။?!.]$/.test(w.text)) {
      cues.push(cur);
      cur = [];
    }
  }
  if (cur.length) cues.push(cur);
  return cues
    .map((c, i) => {
      const last = c[c.length - 1];
      return `${i + 1}\n${toSrtTime(c[0].offset)} --> ${toSrtTime(last.offset + last.duration)}\n${c.map((x) => x.text).join(sep)}\n`;
    })
    .join("\n");
}

app.post("/tts-srt", async (req, res) => {
  const { text, voice = "my-MM-ThihaNeural", rate = "+30%", pitch = "+0Hz" } = req.body || {};
  if (!text) return res.status(400).json({ error: "text is required" });

  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
      wordBoundaryEnabled: true,
      sentenceBoundaryEnabled: false,
    });

    const { audioStream, metadataStream } = await tts.toStream(text, { rate, pitch, volume: "+0%" });

    const chunks = [];
    const words = [];

    if (metadataStream) {
      metadataStream.on("data", (buf) => {
        try {
          const j = JSON.parse(buf.toString());
          for (const m of j.Metadata || []) {
            if (m.Type === "WordBoundary") {
              words.push({ offset: m.Data.Offset, duration: m.Data.Duration, text: m.Data.text.Text });
            }
          }
        } catch {}
      });
    }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("TTS timeout")), 120000);
      audioStream.on("data", (c) => chunks.push(c));
      audioStream.on("end", () => { clearTimeout(t); resolve(); });
      audioStream.on("close", () => { clearTimeout(t); resolve(); });
      audioStream.on("error", (e) => { clearTimeout(t); reject(e); });
    });

    const audio = Buffer.concat(chunks);
    if (!audio.length) throw new Error("Empty audio from Edge TTS");

    res.json({ audio: audio.toString("base64"), srt: buildSrt(words) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    try { tts.close(); } catch {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TTS server running on ${PORT}`));
