const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const ytdlp = require("yt-dlp-exec");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json());

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// in-memory job tracker: { status, filePath, error, progress }
const jobs = new Map();

const RATIOS = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
};

function getVideoDimensions(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const stream = data.streams.find((s) => s.width && s.height);
      if (!stream) return reject(new Error("No video stream found"));
      resolve({ width: stream.width, height: stream.height });
    });
  });
}

function computeCrop(ratioKey, width, height) {
  const target = RATIOS[ratioKey];
  if (!target) throw new Error("Invalid ratio");
  let cw, ch;
  if (width / height > target) {
    ch = height;
    cw = Math.round(height * target);
  } else {
    cw = width;
    ch = Math.round(width / target);
  }
  cw -= cw % 2;
  ch -= ch % 2;
  const x = Math.floor((width - cw) / 2);
  const y = Math.floor((height - ch) / 2);
  return { cw, ch, x, y };
}

// ---- 1) Video info ----
app.post("/api/video-info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
    });
    res.json({
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
    });
  } catch (err) {
    res.status(500).json({ error: "वीडियो की जानकारी नहीं मिल पाई", detail: err.message });
  }
});

// ---- 2) Start clip job ----
app.post("/api/clip", async (req, res) => {
  const { url, start, end, ratio } = req.body;

  if (!url || start == null || end == null || !ratio) {
    return res.status(400).json({ error: "url, start, end, ratio ज़रूरी हैं" });
  }
  if (!RATIOS[ratio]) {
    return res.status(400).json({ error: "ratio सिर्फ 16:9, 9:16, या 1:1 हो सकता है" });
  }
  if (Number(end) <= Number(start)) {
    return res.status(400).json({ error: "end, start से बड़ा होना चाहिए" });
  }

  const jobId = uuidv4();
  jobs.set(jobId, { status: "processing", progress: "downloading" });
  res.json({ jobId });

  processClip(jobId, url, Number(start), Number(end), ratio).catch((err) => {
    jobs.set(jobId, { status: "error", error: err.message });
  });
});

async function processClip(jobId, url, start, end, ratio) {
  const rawPath = path.join(TMP_DIR, `${jobId}_raw.mp4`);
  const outPath = path.join(TMP_DIR, `${jobId}_out.mp4`);

  jobs.set(jobId, { status: "processing", progress: "downloading" });
  await ytdlp(url, {
    output: rawPath,
    format: "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]",
    mergeOutputFormat: "mp4",
  });

  jobs.set(jobId, { status: "processing", progress: "cropping" });
  const { width, height } = await getVideoDimensions(rawPath);
  const { cw, ch, x, y } = computeCrop(ratio, width, height);

  await new Promise((resolve, reject) => {
    ffmpeg(rawPath)
      .setStartTime(start)
      .duration(end - start)
      .videoFilters(`crop=${cw}:${ch}:${x}:${y}`)
      .outputOptions(["-c:v libx264", "-c:a aac", "-preset fast"])
      .output(outPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  fs.unlink(rawPath, () => {});
  jobs.set(jobId, { status: "done", filePath: outPath });
}

// ---- 3) Job status ----
app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job नहीं मिला" });
  res.json(job);
});

// ---- 4) Download finished clip ----
app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "क्लिप अभी तैयार नहीं है" });
  }
  res.download(job.filePath, "clip.mp4", (err) => {
    if (!err) {
      fs.unlink(job.filePath, () => {});
      jobs.delete(req.params.jobId);
    }
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Clip Bay backend चल रहा है: http://localhost:${PORT}`));
