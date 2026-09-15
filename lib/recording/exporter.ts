import type { AspectRatioId, ExportFormat } from "./types";
import { pickMimeType } from "./recorder";
import { ASPECT_RATIOS } from "./presets";

export interface ExportOptions {
  sourceBlob: Blob;
  width: number;
  height: number;
  fps: number;
  videoBitsPerSecond: number;
  format: ExportFormat;
  aspect: AspectRatioId;
  onProgress?: (fraction: number) => void;
}

export interface ExportResult {
  blob: Blob;
  format: ExportFormat;
  fileExtension: string;
}

/**
 * Re-renders the recorded take at the chosen resolution/fps/bitrate/aspect
 * by playing it back into a canvas (cropped/fit per the target aspect) and
 * re-recording that canvas — the same compose-then-record pattern the live
 * studio uses. This is what lets one recording produce a 16:9 YouTube export
 * and a 9:16 TikTok export without re-recording (PRD §6), entirely with
 * browser APIs and no server round trip.
 *
 * A WebCodecs-based transcode would be faster and avoid the realtime-playback
 * constraint; that's a good Phase 1 upgrade once broader codec support can be
 * assumed. This is the simple, reliable version for the foundation.
 */
export async function exportRecording(opts: ExportOptions): Promise<ExportResult> {
  const sourceUrl = URL.createObjectURL(opts.sourceBlob);
  const video = document.createElement("video");
  video.src = sourceUrl;
  video.muted = false;
  video.playsInline = true;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Could not read the recording."));
  });

  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2D canvas context is not available.");

  const targetRatio = ASPECT_RATIOS[opts.aspect].ratio ?? video.videoWidth / video.videoHeight;

  const draw = () => {
    const srcRatio = video.videoWidth / video.videoHeight;
    let sw = video.videoWidth;
    let sh = video.videoHeight;
    if (srcRatio > targetRatio) {
      sw = video.videoHeight * targetRatio;
    } else {
      sh = video.videoWidth / targetRatio;
    }
    const sx = (video.videoWidth - sw) / 2;
    const sy = (video.videoHeight - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  };

  const canvasStream = canvas.captureStream(opts.fps);
  const mediaStream = new MediaStream();
  canvasStream.getVideoTracks().forEach((t) => mediaStream.addTrack(t));
  // captureStream() on the source <video> carries its decoded audio track
  // through untouched — we only need to resample the picture, not the sound.
  const audioCapable = video as HTMLVideoElement & { captureStream?: () => MediaStream };
  audioCapable.captureStream?.().getAudioTracks().forEach((t) => mediaStream.addTrack(t));

  const { mimeType, format } = pickMimeType(opts.format);
  const recorder = new MediaRecorder(mediaStream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: opts.videoBitsPerSecond,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const durationMs = video.duration * 1000;
  let rafId = 0;
  const tick = () => {
    draw();
    opts.onProgress?.(Math.min(1, video.currentTime / (video.duration || 1)));
    if (!video.ended) rafId = requestAnimationFrame(tick);
  };

  const result = await new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
    recorder.onerror = () => reject(new Error("Export failed while encoding."));
    video.onended = () => {
      cancelAnimationFrame(rafId);
      recorder.stop();
    };
    video
      .play()
      .then(() => {
        recorder.start(250);
        rafId = requestAnimationFrame(tick);
      })
      .catch(reject);
    // Safety timeout in case `ended` never fires (e.g. a zero-length take).
    window.setTimeout(
      () => {
        if (recorder.state === "recording") {
          cancelAnimationFrame(rafId);
          recorder.stop();
        }
      },
      Math.max(2000, durationMs + 3000)
    );
  });

  URL.revokeObjectURL(sourceUrl);
  return { blob: result, format, fileExtension: format === "mp4" ? "mp4" : "webm" };
}
