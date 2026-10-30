import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import os from "node:os";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { logger } from "../lib/logger";
import {
  buildIntelligentSegments,
  getWhisperXWorkerHealth,
  transcribeWithWhisperX,
  type SmartCutterTranscriptionSegment,
  type WhisperXWordSegment,
} from "../lib/whisperx-client";

const execFileAsync = promisify(execFile);
const router: IRouter = Router();
const jobs = new Map<string, InternalJob>();
const tempRoot = path.join(os.tmpdir(), "smartcutter");
const maxUploadBytes = 500 * 1024 * 1024;
const allowedAudio = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".webm", ".flac",
  ".mp4", ".mov", ".mkv", ".m4v", ".avi",
]);
const allowedImages = new Set([".png", ".jpg", ".jpeg", ".webp"]);

type JobStatus = "queued" | "analyzing" | "ready" | "rendering" | "complete" | "error";

type TimelineLine = {
  id: number;
  imageName: string;
  imageUrl: string;
  start: number;
  end: number;
  hint: number;
  text: string;
  confidence: number;
  needsReview: boolean;
  alignmentSource: string;
};

type InternalLine = TimelineLine & { imageIndex: number | null };

type InternalJob = {
  id: string;
  dir: string;
  audioPath: string;
  audioName: string;
  imagePaths: string[];
  imageNames: string[];
  scriptLines: Array<{ hint: number; text: string }>;
  language: string;
  speechStarts: number[];
  wordSegments: WhisperXWordSegment[];
  transcription: {
    language: string;
    duration: number;
    segments: SmartCutterTranscriptionSegment[];
    word_segments: WhisperXWordSegment[];
  } | null;
  duration: number;
  status: JobStatus;
  progress: number;
  progressLabel: string;
  timeline: InternalLine[];
  videoPath: string | null;
  errors: string[];
};

type MultipartPart = {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
};

function publicJob(job: InternalJob) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    progressLabel: job.progressLabel,
    duration: Number(job.duration.toFixed(3)),
    scriptLineCount: job.scriptLines.length,
    imageCount: job.imagePaths.length,
    audioName: job.audioName,
    transcription: job.transcription
      ? {
          language: job.transcription.language,
          duration: Number(job.transcription.duration.toFixed(3)),
          segments: job.transcription.segments,
          word_segments: job.transcription.word_segments,
        }
      : null,
    timeline: job.timeline.map(({ imageIndex: _imageIndex, ...line }) => line),
    videoUrl: job.videoPath ? `/api/smartcutter/jobs/${job.id}/preview` : null,
    errors: job.errors,
  };
}

function fail(res: Response, status: number, message: string) {
  return res.status(status).json({ error: message });
}

function parseHint(raw: string) {
  const parts = raw.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) {
    return null;
  }
  const secondsPart = parts.at(-1) ?? 0;
  const minutesPart = parts.length === 3 ? parts[1] : parts[0];
  if (secondsPart >= 60 || (parts.length === 3 && minutesPart >= 60)) return null;
  const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
  return seconds >= 0 ? seconds : null;
}

function parseScript(input: string) {
  const lines: Array<{ hint: number; text: string }> = [];
  let previousHint = -1;
  for (const [lineNumber, rawLine] of input.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^\s*\[([0-9:.]+)\]\s*(.+?)\s*$/);
    if (!match || !match[2]) throw new Error(`Script line ${lineNumber + 1} is missing a valid timestamp. Use [00:06] Your sentence.`);
    const hint = parseHint(match[1]);
    if (hint === null) throw new Error(`Script line ${lineNumber + 1} has an invalid timestamp. Use [MM:SS] or [HH:MM:SS].`);
    if (hint < previousHint) throw new Error("Script timestamps must stay in the same order as the lines.");
    previousHint = hint;
    lines.push({ hint, text: match[2] });
  }
  return lines;
}

function parseLanguage(input: string) {
  const language = input.trim().toLowerCase();
  if (language === "auto") return language;
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(language)) {
    throw new Error("Choose a supported transcription language or Auto Detect.");
  }
  return language;
}

async function parseMultipart(req: Request): Promise<MultipartPart[]> {
  const contentType = req.headers["content-type"] ?? "";
  const match = contentType.match(/boundary="?([^";]+)"?/i);
  if (!match) throw new Error("The upload was not sent as multipart form data.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxUploadBytes) throw new Error("Upload is too large. Keep the combined files under 500 MB.");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const boundary = Buffer.from(`--${match[1]}`);
  const separator = Buffer.from("\r\n\r\n");
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(boundary);
  while (cursor !== -1) {
    cursor += boundary.length;
    if (body.subarray(cursor, cursor + 2).toString() === "--") break;
    if (body.subarray(cursor, cursor + 2).toString() === "\r\n") cursor += 2;
    const next = body.indexOf(boundary, cursor);
    if (next === -1) break;
    const rawPart = body.subarray(cursor, Math.max(cursor, next - 2));
    const headerEnd = rawPart.indexOf(separator);
    if (headerEnd !== -1) {
      const headerText = rawPart.subarray(0, headerEnd).toString("utf8");
      const data = rawPart.subarray(headerEnd + separator.length);
      const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] ?? "";
      const name = disposition.match(/name="([^"]+)"/i)?.[1];
      if (name) {
        parts.push({
          name,
          filename: disposition.match(/filename="([^"]*)"/i)?.[1],
          contentType: headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim(),
          data,
        });
      }
    }
    cursor = next;
  }
  return parts;
}

async function probeDuration(audioPath: string) {
  const result = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath,
  ]);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("The audio duration could not be read.");
  return duration;
}

function normalizeWord(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[ـ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase("ar");
}

function tokenizeText(value: string) {
  return value
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
}

function chooseWordTimings(
  lines: Array<{ hint: number; text: string }>,
  duration: number,
  wordSegments: WhisperXWordSegment[],
) {
  let previousWordIndex = -1;
  const window = Math.max(2.5, Math.min(7, (duration / Math.max(lines.length, 1)) * 1.6));
  return lines.map((line) => {
    const lineWords = tokenizeText(line.text);
    if (lineWords.length === 0) {
      throw new Error(`Script line "${line.text}" has no words that can be aligned.`);
    }
    let best:
      | {
          startWordIndex: number;
          endWordIndex: number;
          matchedWords: number;
          distance: number;
        }
      | undefined;

    for (let startWordIndex = previousWordIndex + 1; startWordIndex < wordSegments.length; startWordIndex += 1) {
      const firstWord = wordSegments[startWordIndex];
      const distance = Math.abs(firstWord.start - line.hint);
      if (distance > window) continue;
      if (firstWord.start >= duration) continue;
      if (normalizeWord(firstWord.word) !== lineWords[0]) continue;

      let matchedWords = 1;
      let endWordIndex = startWordIndex;
      for (let lineWordIndex = 1; lineWordIndex < lineWords.length; lineWordIndex += 1) {
        const candidateWordIndex = startWordIndex + lineWordIndex;
        const candidateWord = wordSegments[candidateWordIndex];
        if (!candidateWord || normalizeWord(candidateWord.word) !== lineWords[lineWordIndex]) break;
        matchedWords += 1;
        endWordIndex = candidateWordIndex;
      }

      if (
        !best ||
        matchedWords / lineWords.length > best.matchedWords / lineWords.length ||
        (matchedWords === best.matchedWords && distance < best.distance)
      ) {
        best = { startWordIndex, endWordIndex, matchedWords, distance };
      }
    }

    if (!best) {
      throw new Error(`WhisperX returned no matching word timestamps near script line "${line.text}".`);
    }

    previousWordIndex = best.endWordIndex;
    const start = wordSegments[best.startWordIndex].start;
    const end = Math.min(duration, wordSegments[best.endWordIndex].end);
    const matchRatio = best.matchedWords / lineWords.length;
    const confidence = Math.max(0.5, Math.min(0.99, matchRatio - best.distance * 0.04 + 0.1));
    return {
      start: Math.max(0, Math.min(duration - 0.05, start)),
      end: Math.max(start + 0.05, end),
      confidence,
      needsReview: matchRatio < 0.8 || best.distance > 2.5,
    };
  });
}

async function analyzeJob(job: InternalJob) {
  job.status = "analyzing";
  job.progress = 10;
  job.progressLabel = "Reading audio";
  try {
    job.duration = await probeDuration(job.audioPath);
    job.progress = 28;
    job.progressLabel = "Transcribing with local WhisperX large-v3";
    const transcription = await transcribeWithWhisperX(job.audioPath, job.audioName, job.language);
    job.wordSegments = transcription.wordSegments;
    job.speechStarts = transcription.wordSegments.map((word) => word.start);
    job.transcription = {
      language: transcription.language,
      duration: job.duration,
      segments: buildIntelligentSegments(transcription, job.duration),
      word_segments: transcription.wordSegments,
    };
    job.progress = 55;
    job.progressLabel = "Aligning script to WhisperX word timestamps";
    if (!job.scriptLines.length) {
      job.progress = 100;
      job.progressLabel = "Transcription ready";
      job.status = "ready";
      job.errors = [];
      return;
    }
    if (job.scriptLines.length * 0.05 > job.duration) {
      throw new Error("The audio is too short for the number of script lines. Check that the voice-over is complete.");
    }
    const actualTimings = chooseWordTimings(job.scriptLines, job.duration, job.wordSegments);
    job.progress = 78;
    job.progressLabel = "Calculating timings";
    job.timeline = job.scriptLines.map((line, index) => {
      const timing = actualTimings[index];
      const safeStart = Math.min(timing.start, Math.max(0, job.duration - 0.05));
      const end = Math.min(job.duration, Math.max(safeStart + 0.05, timing.end));
      return {
        id: index,
        imageName: job.imageNames[index] ?? "Image needed",
        imageUrl: job.imagePaths[index] ? `/api/smartcutter/jobs/${job.id}/images/${index}` : "",
        imageIndex: job.imagePaths[index] ? index : null,
         start: Number(safeStart.toFixed(3)),
         end: Number(Math.min(job.duration, Math.max(safeStart + 0.05, end)).toFixed(3)),
        hint: line.hint,
        text: line.text,
        confidence: timing.confidence,
        needsReview: timing.needsReview,
        alignmentSource: "WhisperX word timestamp",
      };
    });
    if (job.imagePaths.length !== job.scriptLines.length) {
      job.errors = [`${job.scriptLines.length} script lines detected, but only ${job.imagePaths.length} images were provided. Add or remove images before exporting.`];
    } else {
      job.errors = [];
    }
    job.progress = 100;
    job.progressLabel = "Timeline ready";
    job.status = "ready";
  } catch (error) {
    job.status = "error";
    job.progressLabel = "Analysis failed";
    job.errors = [error instanceof Error ? error.message : "Speech alignment failed. Check the audio and try again."];
  }
}

async function renderJob(job: InternalJob) {
  job.status = "rendering";
  job.progress = 12;
  job.progressLabel = "Preparing";
  const outputPath = path.join(job.dir, "smartcutter.mp4");
  try {
    if (job.imagePaths.length !== job.scriptLines.length || job.timeline.some((line) => line.imageIndex === null)) {
      throw new Error("The number of images must match the number of script lines before exporting.");
    }
    const segments: Array<{ kind: "black" | "image"; duration: number; imagePath?: string }> = [];
    let cursor = 0;
    for (let index = 0; index < job.timeline.length; index += 1) {
      const line = job.timeline[index];
      const previous = job.timeline[index - 1];
      if (previous && line.start < previous.end - 0.001) {
        throw new Error(`Line ${index + 1} overlaps the previous line. Adjust the in/out points before exporting.`);
      }
      if (line.start > cursor + 0.001) {
        segments.push({ kind: "black", duration: line.start - cursor });
      }
      segments.push({
        kind: "image",
        duration: Math.max(0.05, line.end - line.start),
        imagePath: job.imagePaths[line.imageIndex as number],
      });
      cursor = line.end;
    }
    if (cursor < job.duration - 0.001) {
      segments.push({ kind: "black", duration: job.duration - cursor });
    }
    const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
    for (const segment of segments) {
      if (segment.kind === "black") {
        args.push("-f", "lavfi", "-t", segment.duration.toFixed(3), "-i", "color=c=black:s=1920x1080:r=30");
      } else {
        args.push("-loop", "1", "-t", segment.duration.toFixed(3), "-i", segment.imagePath as string);
      }
    }
    const audioIndex = segments.length;
    args.push("-i", job.audioPath);
    const filters: string[] = [];
    const videoCount = segments.length;
    segments.forEach((segment, index) => {
      if (segment.kind === "black") {
        filters.push(`[${index}:v]fps=30,format=yuv420p[v${index}]`);
      } else {
        filters.push(`[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x111827,fps=30,format=yuv420p[v${index}]`);
      }
    });
    const concatInputs = Array.from({ length: videoCount }, (_, index) => `[v${index}]`).join("");
    filters.push(`${concatInputs}concat=n=${videoCount}:v=1:a=0[outv]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[outv]", "-map", `${audioIndex}:a:0`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", outputPath);
    job.progress = 36;
    job.progressLabel = "Rendering images";
    await execFileAsync("ffmpeg", args, { maxBuffer: 4 * 1024 * 1024 });
    job.progress = 92;
    job.progressLabel = "Finalizing";
    await stat(outputPath);
    job.videoPath = outputPath;
    job.progress = 100;
    job.progressLabel = "Video ready";
    job.status = "complete";
  } catch (error) {
    job.status = "error";
    job.progressLabel = "Rendering failed";
    job.errors = [error instanceof Error ? error.message : "Rendering failed. Check the images and try again."];
  }
}

router.get("/smartcutter/status", async (_req, res) => {
  let ffmpegAvailable = false;
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  const whisperX = await getWhisperXWorkerHealth();
  res.json({
    status: "ready",
    ffmpegAvailable,
    alignmentMode: whisperX.available
      ? `Local WhisperX ${whisperX.device.toUpperCase()}`
      : "Local WhisperX Worker unavailable",
    whisperXAvailable: whisperX.available,
  });
});

router.post("/smartcutter/analyze", async (req, res) => {
  try {
    const parts = await parseMultipart(req);
    const audio = parts.find((part) => part.name === "audio" && part.filename);
    const script = parts.find((part) => part.name === "script" && !part.filename);
    const languagePart = parts.find((part) => part.name === "language" && !part.filename);
    const images = parts.filter((part) => part.name === "images" && part.filename);
    if (!audio) return fail(res, 400, "Add an audio or video file to continue.");
    const audioExt = path.extname(audio.filename ?? "").toLowerCase();
    if (!allowedAudio.has(audioExt)) return fail(res, 400, "Unsupported media type. Use MP3, WAV, M4A, AAC, OGG, WEBM, FLAC, MP4, MOV, MKV, M4V, or AVI.");
    const invalidImage = images.find((image) => !allowedImages.has(path.extname(image.filename ?? "").toLowerCase()));
    if (invalidImage) return fail(res, 400, "Unsupported image type. Use PNG, JPG, JPEG, or WEBP.");
    const scriptText = script?.data.toString("utf8").trim() ?? "";
    if (Boolean(scriptText) !== (images.length > 0)) {
      return fail(res, 400, "For MP4 creation, provide both a timestamped script and ordered images. For transcription only, omit both.");
    }
    const scriptLines = scriptText ? parseScript(scriptText) : [];
    const language = parseLanguage(languagePart?.data.toString("utf8") || "auto");
    if (scriptText && !scriptLines.length) return fail(res, 400, "No valid script lines were found. Use lines such as [0:06] Your sentence.");
    const id = crypto.randomUUID();
    const dir = path.join(tempRoot, id);
    await mkdir(dir, { recursive: true });
    const audioPath = path.join(dir, `audio${audioExt}`);
    await writeFile(audioPath, audio.data);
    const imagePaths: string[] = [];
    const imageNames: string[] = [];
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const extension = path.extname(image.filename ?? "").toLowerCase();
      const imagePath = path.join(dir, `image-${index}${extension}`);
      await writeFile(imagePath, image.data);
      imagePaths.push(imagePath);
      imageNames.push(path.basename(image.filename ?? `image-${index}${extension}`));
    }
    const job: InternalJob = {
      id, dir, audioPath, audioName: path.basename(audio.filename ?? "voice-over"), imagePaths, imageNames, scriptLines,
      language, speechStarts: [], wordSegments: [], transcription: null, duration: 0, status: "queued", progress: 3, progressLabel: "Queued", timeline: [], videoPath: null, errors: [],
    };
    jobs.set(id, job);
    setImmediate(() => void analyzeJob(job));
    return res.status(202).json(publicJob(job));
  } catch (error) {
    logger.error({ err: error }, "SmartCutter upload failed");
    return fail(res, 400, error instanceof Error ? error.message : "Upload failed. Check the files and try again.");
  }
});

router.get("/smartcutter/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return fail(res, 404, "This SmartCutter job no longer exists.");
  return res.json(publicJob(job));
});

router.get("/smartcutter/jobs/:jobId/images/:imageIndex", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  const imageIndex = Number(req.params.imageIndex);
  if (!job || !Number.isInteger(imageIndex) || !job.imagePaths[imageIndex]) return fail(res, 404, "Image not found.");
  res.type(path.extname(job.imagePaths[imageIndex]));
  return createReadStream(job.imagePaths[imageIndex]).pipe(res);
});

router.patch("/smartcutter/jobs/:jobId/timeline/:lineId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  const lineId = Number(req.params.lineId);
  if (!job) return fail(res, 404, "This SmartCutter job no longer exists.");
  const line = job.timeline.find((item) => item.id === lineId);
  if (!line) return fail(res, 404, "Timeline line not found.");
  const { start, end, imageIndex } = req.body ?? {};
  const nextStart = start === undefined ? line.start : Number(start);
  const nextEnd = end === undefined ? line.end : Number(end);
  const lineIndex = job.timeline.findIndex((item) => item.id === lineId);
  const previous = job.timeline[lineIndex - 1];
  const next = job.timeline[lineIndex + 1];
  if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextStart < 0 || nextEnd <= nextStart || nextEnd > job.duration) {
    return fail(res, 400, "Start and end times must be within the audio and end after they start.");
  }
  if ((previous && nextStart < previous.end) || (next && nextEnd > next.start)) {
    return fail(res, 400, "This line overlaps a neighboring line. Adjust the neighboring in/out point first.");
  }
  if (imageIndex !== undefined && (!Number.isInteger(Number(imageIndex)) || !job.imagePaths[Number(imageIndex)])) {
    return fail(res, 400, "Choose one of the uploaded images.");
  }
  line.start = Number(nextStart.toFixed(3));
  line.end = Number(nextEnd.toFixed(3));
  if (imageIndex !== undefined) {
    line.imageIndex = Number(imageIndex);
    line.imageName = job.imageNames[line.imageIndex];
    line.imageUrl = `/api/smartcutter/jobs/${job.id}/images/${line.imageIndex}`;
  }
  line.needsReview = false;
  line.confidence = Math.max(line.confidence, 0.9);
  job.videoPath = null;
  job.status = "ready";
  return res.json(publicJob(job));
});

router.post("/smartcutter/jobs/:jobId/timeline/:lineId/realign", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  const lineId = Number(req.params.lineId);
  if (!job) return fail(res, 404, "This SmartCutter job no longer exists.");
  const line = job.timeline.find((item) => item.id === lineId);
  if (!line) return fail(res, 404, "Timeline line not found.");
  job.status = "analyzing";
  job.progress = 60;
  job.progressLabel = `Re-aligning line ${lineId + 1}`;
  const hint = line.hint;
  const lineIndex = job.timeline.findIndex((item) => item.id === lineId);
  const previous = job.timeline[lineIndex - 1];
  const next = job.timeline[lineIndex + 1];
  const minimumStart = (previous?.end ?? 0) + (previous ? 0.04 : 0);
  const maximumStart = (next?.start ?? job.duration) - 0.05;
  const candidate = job.speechStarts
    .filter((start) => start >= minimumStart && start <= maximumStart && start < job.duration)
    .sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint))[0];
  if (candidate !== undefined) {
    line.start = Number(candidate.toFixed(3));
    line.confidence = 0.82;
    line.alignmentSource = "WhisperX segment timestamp";
    line.needsReview = false;
  } else {
    line.needsReview = true;
    line.confidence = 0.48;
    line.alignmentSource = "No safe waveform onset found";
  }
  if (candidate !== undefined) line.end = Number((next?.start ?? job.duration).toFixed(3));
  job.status = "ready";
  job.progress = 100;
  job.progressLabel = "Timeline ready";
  job.videoPath = null;
  return res.status(202).json(publicJob(job));
});

router.post("/smartcutter/jobs/:jobId/render", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return fail(res, 404, "This SmartCutter job no longer exists.");
  if (job.status === "rendering") return res.status(202).json(publicJob(job));
  if (job.status !== "ready" && job.status !== "complete") return fail(res, 409, "Finish analysis before exporting.");
  setImmediate(() => void renderJob(job));
  job.status = "rendering";
  job.progress = 8;
  job.progressLabel = "Preparing";
  return res.status(202).json(publicJob(job));
});

router.get("/smartcutter/jobs/:jobId/preview", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.videoPath) return fail(res, 409, "The video is not ready yet.");
  try {
    await stat(job.videoPath);
    res.type("video/mp4");
    return res.sendFile(job.videoPath);
  } catch {
    return fail(res, 404, "The rendered video is no longer available.");
  }
});

router.get("/smartcutter/jobs/:jobId/download", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.videoPath) return fail(res, 409, "The video is not ready yet.");
  try {
    await stat(job.videoPath);
    return res.download(job.videoPath, "smartcutter-video.mp4");
  } catch {
    return fail(res, 404, "The rendered video is no longer available.");
  }
});

setInterval(() => {
  void readdir(tempRoot, { withFileTypes: true }).then(async (entries) => {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const entryPath = path.join(tempRoot, entry.name);
      const entryStat = await stat(entryPath).catch(() => null);
      if (entryStat && entryStat.mtimeMs < cutoff) {
        await rm(entryPath, { recursive: true, force: true });
        jobs.delete(entry.name);
      }
    }));
  }).catch(() => undefined);
}, 60 * 60 * 1000).unref();

export default router;