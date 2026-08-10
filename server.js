const express = require("express");
const cors = require("cors");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/tts-srt", async (req, res) => {
  try {
    const { text, voice = "my-MM-ThihaNeural", rate = "+30%", pitch = "+0Hz" } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
      wordBoundaryEnabled: true,
      sentenceBoundaryEnabled: false,
    });

    // IMPORTANT: toStream() returns a Promise in msedge-tts v2 — must await it
    const { audioStream, metadataStream } = await tts.toStream(text, { rate, pitch, volume: "+0%" });

    const audioChunks = [];
    audioStream.on("data", (chunk) => audioChunks.push(chunk));

    const wordBoundaries = [];
    metadataStream.on("data", (meta) => {
      try {
        const parsed = JSON.parse(meta.toString());
        if (parsed.Metadata) {
          parsed.Metadata.forEach((m) => {
            if (m.Type === "WordBoundary") {
              wordBoundaries.push({
                text: m.Data.text.Text,
                offset: m.Data.Offset / 10000, // ms
                duration: m.Data.Duration / 10000, // ms
              });
            }
          });
        }
      } catch (e) {}
    });

    audioStream.on("end", () => {
      const audioBase64 = Buffer.concat(audioChunks).toString("base64");
      res.json({ audio_base64: audioBase64, word_boundaries: wordBoundaries });
    });

    audioStream.on("error", (err) => {
      res.status(500).json({ error: "TTS stream error", detail: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: "TTS failed", detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TTS server running on port ${PORT}`));
