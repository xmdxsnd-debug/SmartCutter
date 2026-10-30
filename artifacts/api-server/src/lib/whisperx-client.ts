import { openAsBlob } from "node:fs";
import path from "node:path";

const healthTimeoutMs = 10_000;
const defaultTranscriptionTimeoutMs = 12 * 60 * 60 * 1000;

export type WhisperXSegment = {
  start: number;
  end: number;
  text: string;
};

export type WhisperXWordSegment = {
  word: string;
  start: number;
  end: number;
};

export type WhisperXTranscription = {
  language: string;
  segments: WhisperXSegment[];
  wordSegments: WhisperXWordSegment[];
};

export type WhisperXWorkerHealth = {
  available: boolean;
  cuda: boolean;
  device: string;
};

export type SmartCutterTranscriptionSegment = {
  start: number;
  end: number;
  text: string;
  word_segments: WhisperXWordSegment[];
};

export class WhisperXClientError extends Error {
  readonly code: "configuration" | "timeout" | "http" | "protocol" | "network";
  readonly statusCode?: number;

  constructor(
    message: string,
    code: WhisperXClientError["code"],
    statusCode?: number,
  ) {
    super(message);
    this.name = "WhisperXClientError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function getWorkerUrl(pathname: string) {
  const configuredUrl = process.env.WHISPERX_URL?.trim();
  if (!configuredUrl) {
    throw new WhisperXClientError(
      "WhisperX Worker is not configured. Set WHISPERX_URL.",
      "configuration",
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(configuredUrl);
  } catch {
    throw new WhisperXClientError(
      "WHISPERX_URL must be a valid HTTP(S) URL.",
      "configuration",
    );
  }

  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new WhisperXClientError(
      "WHISPERX_URL must use HTTP or HTTPS.",
      "configuration",
    );
  }

  return new URL(pathname.replace(/^\/+/, ""), `${baseUrl.toString().replace(/\/+$/, "")}/`);
}

function getApiKey() {
  const apiKey = process.env.WHISPERX_API_KEY?.trim();
  if (!apiKey) {
    throw new WhisperXClientError(
      "WhisperX Worker is not configured. Set WHISPERX_API_KEY.",
      "configuration",
    );
  }
  return apiKey;
}

function getTranscriptionTimeoutMs() {
  const configured = Number(process.env.WHISPERX_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return defaultTranscriptionTimeoutMs;
}

function audioMimeType(audioName: string) {
  switch (path.extname(audioName).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".ogg":
      return "audio/ogg";
    case ".webm":
      return "audio/webm";
    case ".flac":
      return "audio/flac";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    case ".m4v":
      return "video/x-m4v";
    case ".avi":
      return "video/x-msvideo";
    default:
      return "application/octet-stream";
  }
}

async function readWorkerError(response: Response) {
  const body = await response.text().catch(() => "");
  if (!body) return `WhisperX Worker returned HTTP ${response.status}.`;

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["detail", "error", "message"]) {
        if (typeof record[key] === "string" && record[key].trim()) {
          return `WhisperX Worker returned HTTP ${response.status}: ${record[key]}`;
        }
      }
    }
  } catch {
    // Keep the non-JSON response concise and avoid echoing an arbitrary HTML page.
  }

  return `WhisperX Worker returned HTTP ${response.status}: ${body.slice(0, 240)}`;
}

function validateTranscription(payload: unknown): WhisperXTranscription {
  if (typeof payload !== "object" || payload === null) {
    throw new WhisperXClientError(
      "WhisperX Worker returned an invalid JSON object.",
      "protocol",
    );
  }

  const record = payload as Record<string, unknown>;
  const rawSegments = record.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    throw new WhisperXClientError(
      "WhisperX Worker returned no transcription segments.",
      "protocol",
    );
  }

  const segments = rawSegments.map((rawSegment, index): WhisperXSegment => {
    if (typeof rawSegment !== "object" || rawSegment === null) {
      throw new WhisperXClientError(
        `WhisperX segment ${index + 1} is invalid.`,
        "protocol",
      );
    }

    const segment = rawSegment as Record<string, unknown>;
    const start = Number(segment.start);
    const end = Number(segment.end);
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new WhisperXClientError(
        `WhisperX segment ${index + 1} has invalid start/end timestamps.`,
        "protocol",
      );
    }
    if (!text) {
      throw new WhisperXClientError(
        `WhisperX segment ${index + 1} has no text.`,
        "protocol",
      );
    }

    return {
      start,
      end,
      text,
    };
  });

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].start < segments[index - 1].start) {
      throw new WhisperXClientError(
        "WhisperX segments are not ordered by start time.",
        "protocol",
      );
    }
  }

  const rawWordSegments = record.word_segments;
  if (!Array.isArray(rawWordSegments) || rawWordSegments.length === 0) {
    throw new WhisperXClientError(
      "WhisperX Worker returned no word_segments. Word-level alignment is required.",
      "protocol",
    );
  }

  const wordSegments = rawWordSegments.map((rawWord, index): WhisperXWordSegment => {
    if (typeof rawWord !== "object" || rawWord === null) {
      throw new WhisperXClientError(
        `WhisperX word segment ${index + 1} is invalid.`,
        "protocol",
      );
    }

    const wordSegment = rawWord as Record<string, unknown>;
    const word = typeof wordSegment.word === "string" ? wordSegment.word.trim() : "";
    const start = Number(wordSegment.start);
    const end = Number(wordSegment.end);
    if (!word) {
      throw new WhisperXClientError(
        `WhisperX word segment ${index + 1} has no word text.`,
        "protocol",
      );
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new WhisperXClientError(
        `WhisperX word segment ${index + 1} has invalid start/end timestamps.`,
        "protocol",
      );
    }

    return { word, start, end };
  });

  for (let index = 1; index < wordSegments.length; index += 1) {
    if (
      wordSegments[index].start < wordSegments[index - 1].start ||
      wordSegments[index].end < wordSegments[index - 1].end
    ) {
      throw new WhisperXClientError(
        "WhisperX word_segments are not ordered by time.",
        "protocol",
      );
    }
  }

  return {
    language: typeof record.language === "string" && record.language.trim() ? record.language : "ar",
    segments,
    wordSegments,
  };
}

function hasSentenceEnding(word: string) {
  return /[.!?؟؛。！？]$/u.test(word.trim());
}

function hasClauseEnding(word: string) {
  return /[,،:：]$/u.test(word.trim());
}

export function buildIntelligentSegments(
  transcription: WhisperXTranscription,
  duration: number,
): SmartCutterTranscriptionSegment[] {
  const words = transcription.wordSegments;
  const segments: SmartCutterTranscriptionSegment[] = [];
  let currentWords: WhisperXWordSegment[] = [];
  let rawSegmentIndex = 0;

  const flush = () => {
    if (!currentWords.length) return;
    const start = currentWords[0].start;
    const end = Math.min(duration, currentWords[currentWords.length - 1].end);
    segments.push({
      start: Number(start.toFixed(3)),
      end: Number(Math.max(start + 0.05, end).toFixed(3)),
      text: currentWords.map((word) => word.word.trim()).filter(Boolean).join(" "),
      word_segments: currentWords.map(({ word, start: wordStart, end: wordEnd }) => ({
        word,
        start: wordStart,
        end: wordEnd,
      })),
    });
    currentWords = [];
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const nextWord = words[index + 1];
    currentWords.push(word);
    if (!nextWord) {
      flush();
      continue;
    }

    while (
      rawSegmentIndex < transcription.segments.length - 1 &&
      transcription.segments[rawSegmentIndex].end <= word.end + 0.05
    ) {
      rawSegmentIndex += 1;
    }

    const pause = Math.max(0, nextWord.start - word.end);
    const rawBoundary =
      transcription.segments[rawSegmentIndex - 1]?.end !== undefined &&
      Math.abs(transcription.segments[rawSegmentIndex - 1].end - word.end) <= 0.18;
    const sentenceBoundary = hasSentenceEnding(word.word);
    const clauseBoundary = hasClauseEnding(word.word);
    const naturalPause =
      pause >= 0.55 ||
      (pause >= 0.3 && (sentenceBoundary || clauseBoundary || rawBoundary));
    const emergencyBoundary = nextWord.start - currentWords[0].start >= 18;

    if (sentenceBoundary || naturalPause || emergencyBoundary) flush();
  }

  return segments;
}

async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new WhisperXClientError(
        "WhisperX transcription timed out. The audio may be too long for the Worker.",
        "timeout",
      );
    }
    throw new WhisperXClientError(
      "Could not reach the external WhisperX Worker.",
      "network",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function getWhisperXWorkerHealth(): Promise<WhisperXWorkerHealth> {
  try {
    const response = await fetchWithTimeout(
      getWorkerUrl("/health"),
      {
        method: "GET",
        headers: { "x-api-key": getApiKey() },
      },
      healthTimeoutMs,
    );
    if (!response.ok) return { available: false, cuda: false, device: "unavailable" };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { available: false, cuda: false, device: "unavailable" };
    }
    if (typeof payload !== "object" || payload === null) {
      return { available: false, cuda: false, device: "unavailable" };
    }
    const health = payload as Record<string, unknown>;
    const cuda = health.cuda === true;
    const available =
      health.status === "ok" &&
      (typeof health.cuda === "boolean") &&
      health.model === "large-v3";
    return {
      available,
      cuda,
      device: typeof health.device === "string" ? health.device : cuda ? "cuda" : "cpu",
    };
  } catch {
    return { available: false, cuda: false, device: "unavailable" };
  }
}

export async function checkWhisperXHealth() {
  return (await getWhisperXWorkerHealth()).available;
}

export async function transcribeWithWhisperX(
  audioPath: string,
  audioName: string,
  language = "auto",
) {
  const audio = await openAsBlob(audioPath, { type: audioMimeType(audioName) });
  const formData = new FormData();
  formData.append("audio", audio, path.basename(audioName));
  if (language !== "auto") formData.append("language", language);

  const response = await fetchWithTimeout(
    getWorkerUrl("/v1/transcribe"),
    {
      method: "POST",
      headers: { "x-api-key": getApiKey() },
      body: formData,
    },
    getTranscriptionTimeoutMs(),
  );

  if (!response.ok) {
    throw new WhisperXClientError(
      await readWorkerError(response),
      "http",
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WhisperXClientError(
      "WhisperX Worker returned a response that is not valid JSON.",
      "protocol",
    );
  }

  return validateTranscription(payload);
}