import { execFileSync } from "node:child_process";
import { openAsBlob } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type TimelineLine = {
  id: number;
  imageName: string;
  start: number;
  end: number;
  hint: number;
  text: string;
  confidence: number;
  needsReview: boolean;
  alignmentSource?: string;
};

type WordSegment = { word: string; start: number; end: number };
type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  word_segments: WordSegment[];
};
type Transcript = {
  language: string;
  duration: number;
  segments: TranscriptSegment[];
  word_segments: WordSegment[];
};
type Job = {
  id: string;
  status: "queued" | "analyzing" | "ready" | "rendering" | "complete" | "error";
  progress: number;
  progressLabel: string;
  duration: number;
  scriptLineCount: number;
  imageCount: number;
  audioName?: string;
  transcription?: Transcript | null;
  timeline: TimelineLine[];
  errors: string[];
};

const apiBase = (process.env.SMARTCUTTER_API_URL || "http://127.0.0.1:8080/api").replace(/\/+$/, "");
const terminal = createInterface({ input, output });

function line() {
  console.log("─".repeat(74));
}

function resolveInputPath(value: string) {
  const cleaned = value.trim().replace(/^["']|["']$/g, "");
  return path.resolve(cleaned);
}

function heading(title: string) {
  console.log(`\n  ${title}`);
  line();
}

async function ask(message: string, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await terminal.question(`  ${message}${suffix}: `)).trim();
  return answer || defaultValue;
}

function displayTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("تعذر الاتصال بخادم SmartCutter المحلي. تأكد من تشغيل run.ps1.");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: string; detail?: string };
      message = parsed.error || parsed.detail || message;
    } catch {
      if (body) message = body.slice(0, 300);
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

async function requestMediaJob(
  mediaPath: string,
  language: string,
  scriptText?: string,
  imagePaths: string[] = [],
) {
  const absoluteMediaPath = resolveInputPath(mediaPath);
  const form = new FormData();
  const mediaBlob = await openAsBlob(absoluteMediaPath);
  form.append("audio", mediaBlob, path.basename(absoluteMediaPath));
  form.append("language", language);

  if (scriptText) form.append("script", scriptText);
  for (const imagePath of imagePaths) {
    const absoluteImagePath = path.resolve(imagePath);
    form.append("images", await openAsBlob(absoluteImagePath), path.basename(absoluteImagePath));
  }

  return requestJson<Job>(`${apiBase}/smartcutter/analyze`, {
    method: "POST",
    body: form,
  });
}

async function getJob(jobId: string) {
  return requestJson<Job>(`${apiBase}/smartcutter/jobs/${encodeURIComponent(jobId)}`);
}

async function pollJob(job: Job, finalStatuses: Job["status"][]) {
  let current = job;
  let lastLabel = "";
  const deadline = Date.now() + 13 * 60 * 60 * 1000;
  while (!finalStatuses.includes(current.status)) {
    if (Date.now() > deadline) {
      throw new Error("انتهت مهلة الانتظار. أعد المحاولة بملف أقصر أو تحقق من موارد الجهاز.");
    }
    if (current.progressLabel !== lastLabel) {
      console.log(`  ${current.progressLabel || current.status} — ${current.progress ?? 0}%`);
      lastLabel = current.progressLabel;
    }
    await new Promise((resolve) => setTimeout(resolve, 1800));
    current = await getJob(current.id);
  }
  return current;
}

async function chooseLanguage() {
  console.log("\n  لغة التفريغ:");
  console.log("  1) اكتشاف تلقائي");
  console.log("  2) العربية");
  console.log("  3) English");
  console.log("  4) إدخال رمز لغة آخر (مثل fr أو es)");
  const choice = await ask("اختيار", "1");
  if (choice === "2") return "ar";
  if (choice === "3") return "en";
  if (choice === "4") {
    const code = (await ask("رمز اللغة")).toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(code)) {
      throw new Error("رمز اللغة غير صالح.");
    }
    return code;
  }
  return "auto";
}

function formatTranscript(transcript: Transcript) {
  return transcript.segments
    .map((segment) => `[${displayTime(segment.start)}] ${segment.text}`)
    .join("\n");
}

function outputBaseName(mediaPath: string) {
  const extension = path.extname(mediaPath);
  return path.resolve(path.dirname(mediaPath), path.basename(mediaPath, extension));
}

async function saveTranscript(job: Job, mediaPath: string) {
  const transcript = job.transcription;
  if (!transcript) throw new Error("لم يرجع Worker نتيجة تفريغ صالحة.");
  const base = outputBaseName(mediaPath);
  const choices = (await ask("التصدير: أدخل c للنسخ، t لـTXT، j لـJSON أو أكثر من خيار (ctj)", "ctj")).toLowerCase();
  const timestampText = formatTranscript(transcript);

  if (choices.includes("c")) {
    try {
      execFileSync("clip.exe", [], { input: timestampText, stdio: ["pipe", "ignore", "ignore"] });
      console.log("  تم نسخ التفريغ مع التوقيتات.");
    } catch {
      console.log("  تعذر استخدام clip.exe هنا. نص التفريغ:\n");
      console.log(timestampText);
    }
  }

  if (choices.includes("t")) {
    const txtPath = `${base}.txt`;
    await writeFile(txtPath, `${timestampText}\n`, "utf8");
    console.log(`  TXT: ${txtPath}`);
  }

  if (choices.includes("j")) {
    const jsonPath = `${base}.json`;
    const json = {
      language: transcript.language,
      duration: transcript.duration,
      segments: transcript.segments,
      word_segments: transcript.word_segments,
    };
    await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
    console.log(`  JSON: ${jsonPath}`);
  }
}

async function runTranscription() {
  heading("تفريغ صوت أو فيديو محليًا");
  const mediaInput = await ask("مسار ملف الصوت أو الفيديو");
  if (!mediaInput) return;
  const mediaPath = resolveInputPath(mediaInput);
  const language = await chooseLanguage();
  console.log("\n  تُرسل المعالجة إلى WhisperX المحلي. قد يستغرق التحميل الأول للنموذج وقتًا.");
  let job = await requestMediaJob(mediaPath, language);
  job = await pollJob(job, ["ready", "error"]);
  if (job.status === "error") throw new Error(job.errors.join("\n") || "فشل التفريغ.");
  const transcript = job.transcription;
  if (!transcript) throw new Error("انتهت المهمة دون نتيجة تفريغ.");

  console.log(`\n  اللغة: ${transcript.language} | المدة: ${displayTime(transcript.duration)}`);
  line();
  console.log(formatTranscript(transcript));
  line();
  console.log(`  كلمات بمحاذاة فعلية: ${transcript.word_segments.length}`);
  await saveTranscript(job, mediaPath);
}

async function readImages() {
  console.log("\n  أدخل مسارات الصور بالترتيب. اترك السطر فارغًا عند الانتهاء.");
  const imagePaths: string[] = [];
  while (true) {
    const imagePath = await ask(`الصورة ${imagePaths.length + 1}`);
    if (!imagePath) break;
    imagePaths.push(resolveInputPath(imagePath));
  }
  if (!imagePaths.length) throw new Error("يلزم اختيار صورة واحدة على الأقل لمسار MP4.");
  return imagePaths;
}

async function updateLine(jobId: string, line: TimelineLine, imageIndex: number) {
  return requestJson<Job>(
    `${apiBase}/smartcutter/jobs/${encodeURIComponent(jobId)}/timeline/${line.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: line.start,
        end: line.end,
        imageIndex,
      }),
    },
  );
}

async function realignLine(jobId: string, lineId: number) {
  return requestJson<Job>(
    `${apiBase}/smartcutter/jobs/${encodeURIComponent(jobId)}/timeline/${lineId}/realign`,
    { method: "POST" },
  );
}

function showTimeline(job: Job, images: string[]) {
  heading("مراجعة التوقيتات والصور");
  for (const [index, line] of job.timeline.entries()) {
    const marker = line.needsReview ? "مراجعة مطلوبة" : "جاهز";
    const image = images.findIndex((item) => path.basename(item) === line.imageName);
    console.log(
      `  ${String(index + 1).padStart(2, "0")} ${displayTime(line.start)}–${displayTime(line.end)} | ` +
      `صورة ${image >= 0 ? image + 1 : index + 1}: ${line.imageName} | ${marker}`,
    );
    console.log(`     ${line.text}`);
  }
}

async function reviewTimeline(initialJob: Job, images: string[]) {
  let job = initialJob;
  showTimeline(job, images);
  console.log("\n  لكل سطر: Enter لاعتماد، e لتعديل، r لإعادة المحاذاة. اكتب done للإنهاء.");
  for (let index = 0; index < job.timeline.length; index += 1) {
    while (true) {
      const line = job.timeline[index];
      const command = (await ask(`السطر ${index + 1}${line.needsReview ? " (مراجعة)" : ""}`, "")).toLowerCase();
      if (command === "done") return getJob(job.id);
      if (command === "r") {
        job = await realignLine(job.id, line.id);
        showTimeline(job, images);
        continue;
      }
      if (command === "e") {
        const start = Number(await ask("بداية بالثواني", String(line.start)));
        const end = Number(await ask("نهاية بالثواني", String(line.end)));
        const imageNumber = Number(await ask("رقم الصورة", String(index + 1)));
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          !Number.isInteger(imageNumber) ||
          imageNumber < 1 ||
          imageNumber > images.length
        ) {
          console.log("  قيم التوقيت أو رقم الصورة غير صالحة.");
          continue;
        }
        job = await updateLine(job.id, { ...line, start, end }, imageNumber - 1);
        showTimeline(job, images);
        break;
      }
      const currentImageIndex = Math.max(
        0,
        images.findIndex((image) => path.basename(image) === line.imageName),
      );
      job = await updateLine(job.id, line, currentImageIndex);
      break;
    }
  }
  return getJob(job.id);
}

async function runVideoCut() {
  heading("إنشاء MP4 من الصوت والسكربت والصور");
  const mediaInput = await ask("مسار ملف الصوت أو الفيديو");
  const scriptInput = await ask("مسار ملف السكربت TXT بتوقيتاته");
  if (!mediaInput || !scriptInput) return;
  const mediaPath = resolveInputPath(mediaInput);
  const scriptText = await readFile(resolveInputPath(scriptInput), "utf8");
  const imagePaths = await readImages();
  const language = await chooseLanguage();
  let job = await requestMediaJob(mediaPath, language, scriptText, imagePaths);
  job = await pollJob(job, ["ready", "error"]);
  if (job.status === "error") throw new Error(job.errors.join("\n") || "فشل التحليل.");
  if (!job.timeline.length) throw new Error("لم ينتج التحليل timeline صالحًا.");
  if (job.scriptLineCount !== job.imageCount) {
    throw new Error(`عدد أسطر السكربت (${job.scriptLineCount}) لا يطابق عدد الصور (${job.imageCount}).`);
  }

  job = await reviewTimeline(job, imagePaths);
  if (job.timeline.some((item) => item.needsReview)) {
    throw new Error("توجد أسطر ما زالت تحتاج مراجعة. شغّل المسار مجددًا واعتمد توقيتاتها أولًا.");
  }

  const confirm = (await ask("إنشاء MP4 الآن؟ (y/n)", "y")).toLowerCase();
  if (!["y", "yes"].includes(confirm)) return;
  job = await requestJson<Job>(`${apiBase}/smartcutter/jobs/${encodeURIComponent(job.id)}/render`, {
    method: "POST",
  });
  job = await pollJob(job, ["complete", "error"]);
  if (job.status === "error") throw new Error(job.errors.join("\n") || "فشل تصدير الفيديو.");

  const response = await fetch(`${apiBase}/smartcutter/jobs/${encodeURIComponent(job.id)}/download`);
  if (!response.ok) throw new Error(`تعذر تنزيل الفيديو محليًا (HTTP ${response.status}).`);
  const video = Buffer.from(await response.arrayBuffer());
  const outputPath = `${outputBaseName(mediaPath)}-smartcutter.mp4`;
  await writeFile(outputPath, video);
  console.log(`\n  تم إنشاء الفيديو: ${outputPath}`);

  const preview = (await ask("فتح الفيديو بالمشغل الافتراضي؟ (y/n)", "n")).toLowerCase();
  if (["y", "yes"].includes(preview) && process.platform === "win32") {
    execFileSync("cmd.exe", ["/c", "start", "", outputPath], { stdio: "ignore" });
  }
}

async function verifyLocalServices() {
  const response = await requestJson<{
    ffmpegAvailable: boolean;
    alignmentMode: string;
    whisperXAvailable: boolean;
  }>(`${apiBase}/smartcutter/status`);
  if (!response.ffmpegAvailable) throw new Error("FFmpeg غير متاح. أعد تشغيل setup.ps1.");
  if (!response.whisperXAvailable) {
    throw new Error("WhisperX المحلي لا يزال يحمّل النموذج أو تعذر تشغيله. انتظر قليلًا ثم أعد تشغيل run.ps1.");
  }
  return response;
}

async function main() {
  console.clear();
  console.log("╔══════════════════════════════════════════════════════════════════════════╗");
  console.log("║  SMARTCUTTER — LOCAL CONSOLE                                           ║");
  console.log("║  WhisperX large-v3 • forced alignment • local processing              ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════╝");

  const status = await verifyLocalServices();
  console.log(`\n  المحرك: ${status.alignmentMode}`);
  console.log("  الملفات والنموذج تتم معالجتها محليًا.\n");

  while (true) {
    console.log("  1) تفريغ صوت/فيديو إلى TXT أو JSON");
    console.log("  2) إنشاء MP4 من سكربت وصور");
    console.log("  0) خروج");
    const choice = await ask("اختر", "1");
    try {
      if (choice === "0") break;
      if (choice === "1") await runTranscription();
      else if (choice === "2") await runVideoCut();
      else console.log("  اختر رقمًا من القائمة.");
    } catch (error) {
      console.error(`\n  تعذر إكمال العملية: ${error instanceof Error ? error.message : "خطأ غير معروف"}`);
    }
    await ask("\nاضغط Enter للعودة إلى القائمة");
    console.clear();
  }
}

main()
  .catch((error) => {
    console.error(`\nSmartCutter: ${error instanceof Error ? error.message : "تعذر التشغيل."}`);
    process.exitCode = 1;
  })
  .finally(() => terminal.close());
