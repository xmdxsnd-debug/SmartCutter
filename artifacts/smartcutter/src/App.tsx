import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  AlertTriangle,
  AudioLines,
  Check,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  CloudUpload,
  Download,
  FileAudio,
  FileImage,
  Film,
  Gauge,
  Images,
  Info,
  LoaderCircle,
  LockKeyhole,
  Mic2,
  MoveUpRight,
  Play,
  RefreshCw,
  RotateCcw,
  Scissors,
  Sparkles,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  getDownloadSmartCutterVideoQueryKey,
  getGetSmartCutterJobQueryKey,
  getGetSmartCutterStatusQueryKey,
  getHealthCheckQueryKey,
  useAnalyzeSmartCutterJob,
  useDownloadSmartCutterVideo,
  useGetSmartCutterJob,
  useGetSmartCutterStatus,
  useHealthCheck,
  useRealignSmartCutterTimelineLine,
  useRenderSmartCutterJob,
  useUpdateSmartCutterTimelineLine,
} from '@workspace/api-client-react';
import type { SmartCutterJob, SmartCutterTimelineLine } from '@workspace/api-client-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Home() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [script, setScript] = useState('');
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<SmartCutterJob | undefined>();
  const [draftLines, setDraftLines] = useState<SmartCutterTimelineLine[]>([]);
  const [activeStep, setActiveStep] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [downloadRequested, setDownloadRequested] = useState(false);
  const [dismissedError, setDismissedError] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioDuration, setAudioDuration] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const scriptInputRef = useRef<HTMLTextAreaElement>(null);

  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), staleTime: 30_000 },
  });
  const capability = useGetSmartCutterStatus({
    query: { queryKey: getGetSmartCutterStatusQueryKey(), staleTime: 30_000 },
  });
  const jobQuery = useGetSmartCutterJob(jobId, {
    query: {
      enabled: Boolean(jobId),
      queryKey: getGetSmartCutterJobQueryKey(jobId),
      refetchInterval: jobId ? 1800 : false,
    },
  });
  const analyze = useAnalyzeSmartCutterJob();
  const updateLine = useUpdateSmartCutterTimelineLine();
  const realignLine = useRealignSmartCutterTimelineLine();
  const renderJob = useRenderSmartCutterJob();
  const download = useDownloadSmartCutterVideo(jobId, {
    query: {
      enabled: downloadRequested && Boolean(jobId),
      queryKey: getDownloadSmartCutterVideoQueryKey(jobId),
    },
  });

  useEffect(() => {
    if (jobQuery.data) {
      setJob(jobQuery.data);
      if (jobQuery.data.timeline?.length) setDraftLines(jobQuery.data.timeline);
      if (jobQuery.data.status === 'ready' || jobQuery.data.status === 'complete') setActiveStep(2);
      if (jobQuery.data.status === 'rendering') setActiveStep(3);
    }
  }, [jobQuery.data]);

  useEffect(() => {
    if (download.data instanceof Blob) {
      const href = URL.createObjectURL(download.data);
      const link = document.createElement('a');
      link.href = href;
      link.download = `smartcutter-${jobId}.mp4`;
      link.click();
      URL.revokeObjectURL(href);
      setDownloadRequested(false);
    }
  }, [download.data, jobId]);

  const timeline = draftLines.length ? draftLines : (job?.timeline ?? []);
  const activeLineId = timeline.find((line) => playbackTime >= line.start && playbackTime < line.end)?.id;
  const activeLine = timeline.find((line) => line.id === activeLineId);
  const reviewCount = timeline.filter((line) => line.needsReview).length;
  const mismatch = Boolean(job && job.scriptLineCount !== job.imageCount);
  const canAnalyze = Boolean(audioFile && script.trim() && imageFiles.length && !analyze.isPending);
  const overallError = analyze.error || jobQuery.error || renderJob.error || updateLine.error || realignLine.error;
  const statusLabel = job?.status === 'complete' ? 'Export ready' : job?.status === 'rendering' ? 'Rendering' : job?.status === 'ready' ? 'Review timeline' : job?.status === 'analyzing' ? 'Analyzing' : 'Workspace ready';

  const handleImages = (files: FileList | File[]) => {
    const next = Array.from(files).filter((file) => /\.(png|jpe?g|webp)$/i.test(file.name));
    setImageFiles((current) => [...current, ...next]);
  };

  useEffect(() => {
    if (!audioFile) {
      setAudioUrl('');
      setAudioDuration(0);
      return;
    }
    const url = URL.createObjectURL(audioFile);
    const probe = new Audio(url);
    probe.onloadedmetadata = () => setAudioDuration(probe.duration);
    setAudioUrl(url);
    return () => {
      probe.remove();
      URL.revokeObjectURL(url);
    };
  }, [audioFile]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files.length) handleImages(event.dataTransfer.files);
  };

  const handleAnalyze = () => {
    if (!canAnalyze || !audioFile) return;
    setDismissedError(false);
    setActiveStep(1);
    analyze.mutate(
      { data: { audio: audioFile, script, images: imageFiles } as never },
      {
        onSuccess: (result) => {
          setJob(result);
          setJobId(result.id);
          setDraftLines(result.timeline ?? []);
          setActiveStep(2);
        },
      },
    );
  };

  const updateDraft = (lineId: number, key: 'start' | 'end', value: string) => {
    setDraftLines((lines) => lines.map((line) => line.id === lineId ? { ...line, [key]: Number(value) } : line));
  };

  const saveLine = (line: SmartCutterTimelineLine, index: number) => {
    if (!jobId) return;
    updateLine.mutate(
      { jobId, lineId: line.id, data: { start: line.start, end: line.end, imageIndex: index } },
      { onSuccess: (result) => { setJob(result); setDraftLines(result.timeline ?? []); } },
    );
  };

  const realign = (line: SmartCutterTimelineLine) => {
    if (!jobId) return;
    realignLine.mutate(
      { jobId, lineId: line.id },
      { onSuccess: (result) => { setJob(result); setDraftLines(result.timeline ?? []); } },
    );
  };

  const render = () => {
    if (!jobId) return;
    setActiveStep(3);
    renderJob.mutate({ jobId }, { onSuccess: (result) => { setJob(result); setActiveStep(3); } });
  };

  const downloadVideo = () => {
    if (download.data instanceof Blob) {
      const href = URL.createObjectURL(download.data);
      const link = document.createElement('a');
      link.href = href;
      link.download = `smartcutter-${jobId}.mp4`;
      link.click();
      URL.revokeObjectURL(href);
    } else {
      setDownloadRequested(true);
    }
  };

  const clearWorkspace = () => {
    setAudioFile(null);
    setImageFiles([]);
    setScript('');
    setJob(undefined);
    setJobId('');
    setDraftLines([]);
    setActiveStep(0);
    setDismissedError(false);
  };

  return (
    <div className="sc-noise min-h-[100dvh] bg-background text-foreground">
      <header className="border-b border-border/70 bg-[hsl(var(--background)/.88)] backdrop-blur-md">
        <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-6 px-5 py-4 lg:px-10">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-primary text-primary-foreground shadow-sm">
              <Scissors size={18} strokeWidth={2.4} />
            </div>
            <div>
              <div className="font-display text-[17px] font-bold tracking-[-.04em]">SmartCutter</div>
              <div className="font-mono text-[9px] uppercase tracking-[.2em] text-muted-foreground">voice to picture</div>
            </div>
          </div>
          <div className="hidden items-center gap-6 md:flex">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`h-1.5 w-1.5 rounded-full ${health.isError ? 'bg-destructive' : health.isLoading ? 'bg-primary sc-pulse' : 'bg-[#6c9c7e]'}`} />
              {health.isError ? 'Service unavailable' : health.isLoading ? 'Checking studio' : 'Studio online'}
            </div>
            <div className="h-4 w-px bg-border" />
            <button type="button" onClick={clearWorkspace} data-testid="button-new-cut" className="text-xs font-bold uppercase tracking-[.14em] text-muted-foreground transition-colors hover:text-foreground">
              New cut <span className="ml-1 text-primary">⌘ N</span>
            </button>
          </div>
          <button type="button" onClick={clearWorkspace} data-testid="button-new-cut-mobile" className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-bold uppercase tracking-[.12em] md:hidden">
            New cut
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] px-5 pb-16 pt-7 lg:px-10 lg:pt-10">
        <div className="mb-8 flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div className="sc-reveal">
            <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.22em] text-primary">
              <span className="h-px w-7 bg-primary" /> Precision edit suite
            </div>
            <h1 className="max-w-[700px] font-display text-[clamp(2.2rem,5vw,4.6rem)] font-bold leading-[.92] tracking-[-.065em]">
              Make the picture<br /><span className="text-primary">follow the voice.</span>
            </h1>
            <p className="mt-5 max-w-[570px] text-sm leading-6 text-muted-foreground">
              Give SmartCutter one voice-over, your timestamped script, and the stills in order. We’ll build a reviewable cut — frame by frame.
            </p>
          </div>
          <div className="sc-reveal sc-reveal-delay-1 min-w-[220px] rounded-xl border border-border bg-card/65 p-4 shadow-[0_8px_30px_hsl(var(--foreground)/.04)]">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-[.18em] text-muted-foreground">Engine status</span>
              <CircleHelp size={14} className="text-muted-foreground" />
            </div>
            <div className="space-y-2 text-xs">
              <Capability label="FFmpeg" okay={capability.data?.ffmpegAvailable} loading={capability.isLoading} />
              <Capability label="Alignment" value={capability.data?.alignmentMode ?? 'checking'} okay={!capability.isError} loading={capability.isLoading} />
              <Capability label="WhisperX" value={capability.data?.whisperXAvailable ? 'available' : 'fallback'} okay={capability.data?.whisperXAvailable} loading={capability.isLoading} />
            </div>
          </div>
        </div>

        <StepRail activeStep={activeStep} />

        {overallError && !dismissedError && (
             <div data-testid="status-error" className="mb-6 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <AlertTriangle size={17} className="mt-0.5 shrink-0" />
             <div className="flex-1"><strong className="font-bold">Something needs attention.</strong><span className="ml-1 text-destructive/80">{overallError instanceof Error ? overallError.message : 'The last operation didn’t finish. Check the inputs and try again.'}</span></div>
            <button type="button" onClick={() => setDismissedError(true)} data-testid="button-dismiss-error" className="rounded p-1 hover:bg-destructive/10"><X size={15} /></button>
          </div>
        )}

        <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.03fr)_minmax(420px,.97fr)]">
          <div className="space-y-5">
            <PanelHeader eyebrow="01 / source material" title="Set the ingredients" detail="Order matters. We preserve it." />
            <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_12px_40px_hsl(var(--foreground)/.035)] sm:p-6">
              <div className="grid gap-4 md:grid-cols-[1fr_1.3fr]">
                <FileDrop
                  label="Voice-over"
                  icon={<Mic2 size={18} />}
                  accept=".mp3,.wav,.m4a,.aac,.ogg,.webm,.flac,audio/*"
                  file={audioFile}
                  duration={audioDuration}
                  onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)}
                  onRemove={() => setAudioFile(null)}
                  testId="input-audio"
                />
                <div
                  onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={onDrop}
                  className={`group relative min-h-[156px] rounded-xl border border-dashed p-5 transition-all ${isDragging ? 'border-primary bg-primary/8' : 'border-border bg-background/45 hover:border-primary/60 hover:bg-primary/[.025]'}`}
                >
                  <input type="file" accept=".png,.jpg,.jpeg,.webp" multiple disabled={Boolean(job)} onChange={(event) => { if (event.target.files) handleImages(event.target.files); }} data-testid="input-images" className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
                  <div className="flex items-start justify-between">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/45 text-accent-foreground"><Images size={18} /></div>
                    {imageFiles.length > 0 && <span className="rounded-full bg-accent px-2 py-1 font-mono text-[10px] text-accent-foreground">{imageFiles.length} loaded</span>}
                  </div>
                  <div className="mt-6">
                    <div className="text-sm font-bold">Ordered stills</div>
                    <div className="mt-1 text-xs leading-5 text-muted-foreground">{imageFiles.length ? `${imageFiles.map((file) => file.name).slice(0, 2).join(', ')}${imageFiles.length > 2 ? ` + ${imageFiles.length - 2} more` : ''}` : 'Drop images here or browse your sequence'}</div>
                  </div>
                  <div className="pointer-events-none absolute bottom-4 right-4 text-primary opacity-70 transition-transform group-hover:-translate-y-0.5"><CloudUpload size={17} /></div>
                </div>
              </div>
              {imageFiles.length > 0 && (
                <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
                  {imageFiles.map((file, index) => (
                    <div key={`${file.name}-${index}`} data-testid={`card-image-${index}`} className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                      <PreviewThumb file={file} />
                      <div className="absolute inset-x-0 bottom-0 bg-foreground/70 py-0.5 text-center font-mono text-[9px] text-background">{String(index + 1).padStart(2, '0')}</div>
                      <button type="button" disabled={Boolean(job)} onClick={() => setImageFiles((files) => files.filter((_, itemIndex) => itemIndex !== index))} data-testid={`button-remove-image-${index}`} className="absolute right-1 top-1 hidden rounded-full bg-foreground/80 p-0.5 text-background group-hover:block disabled:cursor-not-allowed disabled:opacity-40"><X size={11} /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="my-6 h-px bg-border/80" />
               <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-bold"><FileAudio size={16} className="text-primary" /> Timestamped script</span>
                 <div className="flex items-center gap-3">
                   <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] uppercase tracking-[.08em] text-primary hover:text-foreground">
                     <Upload size={12} /> Upload TXT
                     <input type="file" accept=".txt,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(setScript); }} className="sr-only" data-testid="input-script-file" />
                   </label>
                   <span className="font-mono text-[10px] text-muted-foreground">{script.split('\n').filter(Boolean).length || 0} lines</span>
                 </div>
               </div>
              <textarea
                id="script-input"
                ref={scriptInputRef}
                value={script}
                onChange={(event) => setScript(event.target.value)}
                data-testid="input-script"
                 placeholder={'[0:00] Open on the first frame\n[0:04] The idea starts here\n[0:09] Let the detail breathe'}
                className="min-h-[174px] w-full resize-y rounded-xl border border-input bg-background px-4 py-3 font-mono text-[12px] leading-6 text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
              <div className="mt-2 flex items-start gap-2 text-[11px] leading-5 text-muted-foreground"><Info size={13} className="mt-0.5 shrink-0 text-primary" /> Keep the original wording visible. SmartCutter only normalizes timestamps behind the scenes.</div>
              <button type="button" onClick={handleAnalyze} disabled={!canAnalyze} data-testid="button-analyze" className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground shadow-[0_7px_18px_hsl(var(--primary)/.22)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_22px_hsl(var(--primary)/.28)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0">
                {analyze.isPending ? <><LoaderCircle size={17} className="animate-spin" /> Reading your materials</> : <><WandSparkles size={17} /> Analyze and build timeline</>}
              </button>
            </div>
          </div>

          <div className="space-y-5 lg:sticky lg:top-5">
            <PanelHeader eyebrow="02 / alignment preview" title="Read the cut" detail={job ? statusLabel : 'Your timeline will appear here'} />
            {!job && !jobQuery.isLoading ? (
              <EmptyTimeline />
            ) : jobQuery.isLoading && !job ? (
              <TimelineSkeleton />
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_12px_40px_hsl(var(--foreground)/.035)]">
                <TimelineSummary job={job} reviewCount={reviewCount} mismatch={mismatch} />
                {mismatch && <MismatchNotice scriptCount={job?.scriptLineCount ?? 0} imageCount={job?.imageCount ?? 0} />}
                <div className="divide-y divide-border/70">
                  {timeline.map((line, index) => (
                    <TimelineRow
                      key={line.id}
                      line={line}
                      index={index}
                        imageFiles={imageFiles}
                        active={line.id === activeLineId}
                      onChange={updateDraft}
                        onSave={(imageIndex) => saveLine(line, imageIndex)}
                      onRealign={() => realign(line)}
                      saving={updateLine.isPending && updateLine.variables?.lineId === line.id}
                      realigning={realignLine.isPending && realignLine.variables?.lineId === line.id}
                    />
                  ))}
                </div>
                {timeline.length === 0 && <div className="p-10 text-center text-sm text-muted-foreground">The analyzer returned no timeline lines.</div>}
                {job && (
                  <div className="flex flex-col gap-3 border-t border-border bg-background/35 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground"><LockKeyhole size={13} /> Nothing renders until you approve the timing.</div>
                    <button type="button" onClick={render} disabled={!jobId || mismatch || reviewCount > 0 || renderJob.isPending || job.status === 'rendering'} data-testid="button-render" className="flex h-10 items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-xs font-bold text-background transition-all hover:bg-primary disabled:cursor-not-allowed disabled:opacity-40">
                      {renderJob.isPending || job.status === 'rendering' ? <LoaderCircle size={14} className="animate-spin" /> : <Film size={14} />}
                      {job.status === 'complete' ? 'Render again' : mismatch ? 'Match images first' : reviewCount ? `${reviewCount} review${reviewCount > 1 ? 's' : ''} needed` : 'Render MP4'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="mt-7 grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-[0_12px_40px_hsl(var(--foreground)/.035)] sm:p-6">
            <div className="mb-5 flex items-center justify-between">
              <PanelHeader eyebrow="03 / review monitor" title="Preview the rhythm" detail="Audio leads. Pictures follow." compact />
              {job?.duration ? <span data-testid="text-duration" className="font-mono text-xs text-muted-foreground">{formatTime(job.duration)} total</span> : null}
            </div>
             <div className="sc-scanline relative flex h-[230px] items-center justify-center overflow-hidden rounded-xl border border-border bg-[hsl(var(--sidebar))]">
               {job?.videoUrl ? (
                 <video src={job.videoUrl} controls className="h-full w-full bg-black object-contain" onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)} data-testid="video-preview" />
               ) : audioUrl ? (
                 <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4">
                   <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar)/.75)]">
                     {activeLine?.imageUrl ? <img src={activeLine.imageUrl} alt={activeLine.imageName} className="max-h-full max-w-full object-contain" /> : <div className="font-mono text-[10px] uppercase tracking-[.14em] text-[hsl(var(--sidebar-foreground)/.55)]">Play the audio to preview the active still</div>}
                   </div>
                   <audio src={audioUrl} controls className="h-9 w-full max-w-[520px]" onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)} data-testid="audio-preview" />
                 </div>
               ) : (
                 <>
                   <div className="absolute inset-x-8 top-1/2 h-px bg-[hsl(var(--accent)/.4)]" />
                   <div className="flex h-16 items-end gap-[3px] opacity-80">
                     {Array.from({ length: 44 }, (_, index) => <span key={index} className={`sc-wave w-[3px] rounded-full bg-primary/80 ${index % 4 === 0 ? 'h-9' : index % 3 === 0 ? 'h-5' : 'h-3'}`} style={{ animationDelay: `${index * .035}s` }} />)}
                   </div>
                   <div className="absolute bottom-3 left-4 font-mono text-[9px] tracking-[.12em] text-[hsl(var(--accent))]">AUDIO / WAITING FOR SOURCE</div>
                   <button type="button" disabled data-testid="button-preview" className="group relative flex h-12 w-12 items-center justify-center rounded-full border border-[hsl(var(--accent)/.6)] bg-[hsl(var(--sidebar)/.8)] text-[hsl(var(--accent))] opacity-40">
                     <Play size={18} fill="currentColor" className="ml-0.5" />
                   </button>
                 </>
               )}
             </div>
            <div className="mt-4 flex items-center justify-between text-[10px] font-mono uppercase tracking-[.15em] text-muted-foreground">
              <span>00:00</span><span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> {job?.videoUrl ? 'Preview available' : 'Render to unlock preview'}</span><span>{formatTime(job?.duration ?? 0)}</span>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-[hsl(var(--sidebar))] p-5 text-[hsl(var(--sidebar-foreground))] shadow-[0_12px_40px_hsl(var(--foreground)/.06)] sm:p-6">
            <div className="mb-8 flex items-start justify-between"><div><div className="mb-2 font-mono text-[9px] uppercase tracking-[.2em] text-[hsl(var(--accent))]">04 / deliver</div><h2 className="font-display text-2xl font-bold tracking-[-.04em]">The finished cut.</h2></div><Clapperboard size={23} className="text-[hsl(var(--accent))]" /></div>
            <div className="mb-7 border-l border-[hsl(var(--sidebar-border))] pl-4 text-sm leading-6 text-[hsl(var(--sidebar-foreground)/.65)]">A clean H.264 MP4, paced to the words you wrote. Review every join before it leaves the studio.</div>
            <button type="button" onClick={downloadVideo} disabled={!job?.videoUrl || download.isFetching} data-testid="button-download" className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[hsl(var(--accent))] text-sm font-bold text-[hsl(var(--sidebar))] transition-all hover:-translate-y-0.5 hover:bg-[hsl(var(--accent)/.9)] disabled:cursor-not-allowed disabled:opacity-35">
              {download.isFetching ? <LoaderCircle size={16} className="animate-spin" /> : <Download size={16} />} Download MP4
            </button>
            <div className="mt-4 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.13em] text-[hsl(var(--sidebar-foreground)/.45)]"><Gauge size={12} /> {job?.status === 'complete' ? 'Render complete' : 'Waiting for final render'}</div>
          </div>
        </section>
      </main>
      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-[1480px] flex-col gap-2 px-5 py-5 text-[10px] uppercase tracking-[.14em] text-muted-foreground sm:flex-row sm:items-center sm:justify-between lg:px-10">
          <span>SmartCutter / a quiet room for exact cuts</span><span className="flex items-center gap-2"><Sparkles size={12} className="text-primary" /> Built for the last frame</span>
        </div>
      </footer>
    </div>
  );
}

function Capability({ label, value, okay, loading }: { label: string; value?: string; okay?: boolean; loading?: boolean }) {
  return <div className="flex items-center justify-between"><span className="text-muted-foreground">{label}</span>{loading ? <span className="h-2 w-16 animate-pulse rounded bg-muted" /> : <span className={`flex items-center gap-1.5 font-mono text-[10px] ${okay ? 'text-[#5e8d70]' : 'text-primary'}`}><span className={`h-1.5 w-1.5 rounded-full ${okay ? 'bg-[#6c9c7e]' : 'bg-primary'}`} />{value ?? (okay ? 'available' : 'unavailable')}</span>}</div>;
}

function StepRail({ activeStep }: { activeStep: number }) {
  const steps = [{ label: 'Source', icon: Upload }, { label: 'Analyze', icon: WandSparkles }, { label: 'Review', icon: Check }, { label: 'Export', icon: MoveUpRight }];
  return <div className="mb-7 flex max-w-[720px] items-center gap-0 overflow-x-auto pb-1">{steps.map((step, index) => { const Icon = step.icon; const complete = activeStep > index; return <div key={step.label} className="flex min-w-[105px] flex-1 items-center">{index > 0 && <div className={`h-px flex-1 ${complete || activeStep >= index ? 'bg-primary' : 'bg-border'}`} />}<div className={`flex items-center gap-2 whitespace-nowrap text-[10px] font-bold uppercase tracking-[.14em] ${activeStep === index ? 'text-foreground' : complete ? 'text-primary' : 'text-muted-foreground'}`}><span className={`flex h-7 w-7 items-center justify-center rounded-full border ${activeStep === index ? 'border-primary bg-primary text-primary-foreground' : complete ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card'}`}>{complete ? <Check size={13} /> : <Icon size={13} />}</span>{step.label}</div></div>; })}</div>;
}

function PanelHeader({ eyebrow, title, detail, compact }: { eyebrow: string; title: string; detail: string; compact?: boolean }) {
  return <div className={compact ? '' : 'mb-1'}><div className="mb-1.5 font-mono text-[9px] uppercase tracking-[.2em] text-primary">{eyebrow}</div><div className={`font-display font-bold tracking-[-.04em] ${compact ? 'text-xl' : 'text-2xl'}`}>{title}</div><div className="mt-1 text-xs text-muted-foreground">{detail}</div></div>;
}

function PreviewThumb({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);
  return url ? <img src={url} alt="" className="h-full w-full object-cover" /> : null;
}

function FileDrop({ label, icon, accept, file, duration, onChange, onRemove, testId }: { label: string; icon: ReactNode; accept: string; file: File | null; duration?: number; onChange: (event: ChangeEvent<HTMLInputElement>) => void; onRemove: () => void; testId: string }) {
  return <div className="group relative min-h-[156px] rounded-xl border border-dashed border-border bg-background/45 p-5 transition-all hover:border-primary/60 hover:bg-primary/[.025]"><input type="file" accept={accept} onChange={onChange} data-testid={testId} className="absolute inset-0 cursor-pointer opacity-0" /><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">{file ? <Check size={18} /> : icon}</div><div className="mt-6 pr-4"><div className="text-sm font-bold">{label}</div><div className="mt-1 truncate text-xs text-muted-foreground">{file ? file.name : 'Drop a file here or browse'}</div>{file && <div className="mt-1 font-mono text-[9px] uppercase tracking-[.1em] text-muted-foreground">{file.type || 'Audio file'}{duration ? ` • ${formatTime(duration)}` : ''}</div>}</div>{file ? <button type="button" onClick={(event) => { event.stopPropagation(); onRemove(); }} data-testid="button-remove-audio" className="absolute right-4 top-4 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X size={14} /></button> : <div className="pointer-events-none absolute bottom-4 right-4 text-primary opacity-70 transition-transform group-hover:-translate-y-0.5"><CloudUpload size={17} /></div>}</div>;
}

function EmptyTimeline() {
  return <div data-testid="empty-timeline" className="sc-grid relative flex min-h-[478px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-border bg-card p-8 text-center"><div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary"><AudioLines size={29} /><span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-card bg-primary" /></div><h3 className="font-display text-xl font-bold tracking-[-.035em]">A timeline with a pulse.</h3><p className="mt-2 max-w-[270px] text-xs leading-5 text-muted-foreground">Upload your source material and the synchronized sequence will land here for a calm, line-by-line review.</p><div className="mt-7 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.18em] text-muted-foreground/70"><FileAudio size={12} /> <span className="h-px w-7 bg-border" /> <FileImage size={12} /> <span className="h-px w-7 bg-border" /> <Film size={12} /></div></div>;
}

function TimelineSkeleton() {
  return <div className="space-y-3 rounded-2xl border border-border bg-card p-5"><div className="h-16 animate-pulse rounded-lg bg-muted" /><div className="h-20 animate-pulse rounded-lg bg-muted/80" /><div className="h-20 animate-pulse rounded-lg bg-muted/60" /><div className="h-20 animate-pulse rounded-lg bg-muted/40" /></div>;
}

function TimelineSummary({ job, reviewCount, mismatch }: { job?: SmartCutterJob; reviewCount: number; mismatch: boolean }) {
  return <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-background/40 p-4"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><AudioLines size={18} /></div><div><div className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">{job?.audioName ?? 'Analyzed voice-over'}</div><div data-testid="status-job" className="mt-1 text-xs font-bold">{job?.scriptLineCount ?? 0} lines <span className="mx-1 text-border">/</span> {job?.imageCount ?? 0} stills</div></div></div><div className="flex items-center gap-2">{mismatch && <span className="rounded-full bg-primary/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.1em] text-primary">Mismatch</span>}<span className={`rounded-full px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.1em] ${reviewCount ? 'bg-primary/10 text-primary' : 'bg-[#6c9c7e]/15 text-[#4f7d60]'}`}>{reviewCount ? `${reviewCount} needs review` : 'Aligned'}</span></div></div>;
}

function MismatchNotice({ scriptCount, imageCount }: { scriptCount: number; imageCount: number }) {
  return <div data-testid="status-mismatch" className="flex items-start gap-2 border-b border-primary/20 bg-primary/5 px-4 py-3 text-xs leading-5 text-primary"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span><strong className="font-bold">The inputs don’t line up yet.</strong> {scriptCount} script lines and {imageCount} stills were found. Review the image assignment before rendering.</span></div>;
}

function TimelineRow({ line, index, imageFiles, active, onChange, onSave, onRealign, saving, realigning }: { line: SmartCutterTimelineLine; index: number; imageFiles: File[]; active: boolean; onChange: (lineId: number, key: 'start' | 'end', value: string) => void; onSave: (imageIndex: number) => void; onRealign: () => void; saving: boolean; realigning: boolean }) {
  const [expanded, setExpanded] = useState(line.needsReview);
  const [selectedImage, setSelectedImage] = useState(() => Math.max(0, imageFiles.findIndex((file) => file.name === line.imageName)));
  useEffect(() => {
    const matchingIndex = imageFiles.findIndex((file) => file.name === line.imageName);
    if (matchingIndex >= 0) setSelectedImage(matchingIndex);
  }, [imageFiles, line.imageName]);
  return <div data-testid={`row-timeline-${line.id}`} className={`group border-l-2 p-4 transition-colors hover:bg-background/40 ${active ? 'border-primary bg-primary/[.08]' : 'border-transparent'} ${line.needsReview ? 'bg-primary/[.035]' : ''}`}><div className="flex items-start gap-3"><div className="relative mt-0.5 h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">{line.imageUrl ? <img src={line.imageUrl} alt={line.imageName || `Still ${index + 1}`} className="h-full w-full object-cover" /> : <div className="sc-grid h-full w-full" />}<span className="absolute bottom-1 left-1 rounded bg-foreground/75 px-1 font-mono text-[9px] text-background">{String(index + 1).padStart(2, '0')}</span></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-xs font-bold">{line.imageName || `Still ${index + 1}`}</span>{line.needsReview ? <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[.08em] text-primary"><AlertTriangle size={10} /> Review</span> : <span className="font-mono text-[9px] text-[#5e8d70]">MATCHED</span>}</div><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{line.text || 'No script text was attached to this line.'}</p><div className="mt-3 flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><span className="rounded bg-muted px-1.5 py-1">{formatTime(line.start)}</span><span className="text-border">→</span><span className="rounded bg-muted px-1.5 py-1">{formatTime(line.end)}</span><span className="ml-1 text-[9px] text-muted-foreground/70">{Math.round(line.confidence * 100)}% confidence</span></div></div><button type="button" onClick={() => setExpanded((open) => !open)} data-testid={`button-expand-line-${line.id}`} className={`mt-1 rounded-lg border border-border p-2 text-muted-foreground transition-all hover:bg-muted hover:text-foreground ${expanded ? 'bg-muted' : ''}`}><ChevronDown size={15} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} /></button></div>{expanded && <div className="ml-[60px] mt-4 rounded-xl border border-border bg-background/60 p-3"><div className="grid gap-2 sm:grid-cols-3"><label className="font-mono text-[9px] uppercase tracking-[.1em] text-muted-foreground">In<input type="number" min="0" step=".01" value={line.start} onChange={(event) => onChange(line.id, 'start', event.target.value)} data-testid={`input-start-${line.id}`} className="mt-1 h-9 w-full rounded-lg border border-input bg-card px-2 font-mono text-xs text-foreground outline-none focus:border-primary" /></label><label className="font-mono text-[9px] uppercase tracking-[.1em] text-muted-foreground">Out<input type="number" min="0" step=".01" value={line.end} onChange={(event) => onChange(line.id, 'end', event.target.value)} data-testid={`input-end-${line.id}`} className="mt-1 h-9 w-full rounded-lg border border-input bg-card px-2 font-mono text-xs text-foreground outline-none focus:border-primary" /></label><label className="font-mono text-[9px] uppercase tracking-[.1em] text-muted-foreground">Still<select value={selectedImage} onChange={(event) => setSelectedImage(Number(event.target.value))} className="mt-1 h-9 w-full rounded-lg border border-input bg-card px-2 text-xs text-foreground outline-none focus:border-primary">{imageFiles.map((file, imageIndex) => <option key={`${file.name}-${imageIndex}`} value={imageIndex}>{String(imageIndex + 1).padStart(2, '0')} / {file.name}</option>)}</select></label></div><div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-[9px] uppercase tracking-[.08em] text-muted-foreground">{line.alignmentSource ?? 'manual alignment'} / hint {formatTime(line.hint)}</span><div className="flex gap-2"><button type="button" onClick={onRealign} disabled={realigning} data-testid={`button-realign-${line.id}`} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[10px] font-bold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">{realigning ? <LoaderCircle size={12} className="animate-spin" /> : <RotateCcw size={12} />} Re-align</button><button type="button" onClick={() => onSave(selectedImage)} disabled={saving} data-testid={`button-save-line-${line.id}`} className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-[10px] font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-40">{saving ? <LoaderCircle size={12} className="animate-spin" /> : <Check size={12} />} Save</button></div></div></div>}</div>;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '00:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
