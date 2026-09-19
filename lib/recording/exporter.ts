import type { AspectRatioId, ExportFormat, ZoomKeyframe } from "./types";
import { pickMimeType } from "./recorder";
import { ASPECT_RATIOS } from "./presets";
import { transcodeToMp4 } from "./mp4Fallback";

export interface ExportOptions {
  sourceBlob: Blob;
  width: number;
  height: number;
  fps: number;
  videoBitsPerSecond: number;
  format: ExportFormat;
  aspect: AspectRatioId;
  zoomKeyframes?: ZoomKeyframe[];
  /** The recording's real duration from `RecordingSession`'s own wall-clock
   * timer (`result.durationMs`), not derived from the source Blob. Passed
   * through to the ffmpeg.wasm MP4 fallback so it can compute transcode
   * progress reliably — see `mp4Fallback.ts`'s `totalDurationMs` doc
   * comment for why the Blob's own duration can't be trusted for this. */
  sourceDurationMs?: number;
  /** `phase` distinguishes the (fast) canvas re-render pass from the (slow,
   * only when MP4 recording failed and format: "mp4" was requested)
   * ffmpeg.wasm transcode pass, so the caller can label its progress bar
   * accurately instead of implying the whole thing is one uniform step. */
  onProgress?: (fraction: number, phase?: "recording" | "transcoding") => void;
}

const FULL_RECT = { x: 0, y: 0, w: 1, h: 1 };
/** Ease-in/out window either side of a keyframe's [start, end] — the zoom
 * glides in, holds, then glides back out rather than snapping. */
const ZOOM_TRANSITION_MS = 350;
/** How long the interaction-pulse ring (Smart Camera's approximation of a
 * "click highlight" — there's no real cursor/click position available, only
 * the detected motion region a keyframe was generated from) stays on
 * screen, fading out over the whole window. Only drawn for source: "auto"
 * keyframes — a manually-placed zoom has no detected "moment" to mark. */
const INTERACTION_PULSE_MS = 500;

/** Soft expanding-ring pulse centered on `(cx, cy)` in canvas space, at
 * progress `t` (0 = just triggered, 1 = fully faded). */
function drawInteractionPulse(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  cx: number,
  cy: number,
  t: number
) {
  const maxRadius = Math.min(canvasW, canvasH) * 0.05;
  const radius = maxRadius * (0.3 + 0.7 * t);
  const alpha = (1 - t) * 0.5;
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineWidth = Math.max(1.5, maxRadius * 0.06);
  ctx.stroke();
  ctx.restore();
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerpRect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  t: number
) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

/** Normalized (0..1, relative to the full source frame) region the export
 * should be zoomed into at `timeMs`, easing between the full frame and each
 * keyframe's target rect at its boundaries. Keyframes are assumed
 * non-overlapping, so the first match wins. */
function getActiveZoomRect(keyframes: ZoomKeyframe[], timeMs: number) {
  for (const kf of keyframes) {
    if (timeMs < kf.startMs - ZOOM_TRANSITION_MS || timeMs > kf.endMs + ZOOM_TRANSITION_MS) continue;
    let t: number;
    if (timeMs < kf.startMs) {
      t = (timeMs - (kf.startMs - ZOOM_TRANSITION_MS)) / ZOOM_TRANSITION_MS;
    } else if (timeMs > kf.endMs) {
      t = 1 - (timeMs - kf.endMs) / ZOOM_TRANSITION_MS;
    } else {
      t = 1;
    }
    return lerpRect(FULL_RECT, kf.rect, easeInOutCubic(Math.max(0, Math.min(1, t))));
  }
  return FULL_RECT;
}

export interface ExportResult {
  blob: Blob;
  format: ExportFormat;
  fileExtension: string;
  /** How the delivered format was actually arrived at:
   * - "native": MediaRecorder produced the requested format directly.
   * - "transcoded-to-mp4": the browser's own encoder couldn't produce MP4
   *   for this stream, so it was re-encoded into a real MP4 client-side
   *   with ffmpeg.wasm — slower, but still delivers exactly what was asked.
   * - "webm-fallback": MP4 was requested and couldn't be produced natively
   *   *or* via the ffmpeg.wasm fallback — WebM is what's actually in `blob`.
   * Lets the caller tell the user what happened instead of silently handing
   * back a different container than the one they picked. */
  outcome: "native" | "transcoded-to-mp4" | "webm-fallback";
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
  const zoomKeyframes = opts.zoomKeyframes ?? [];

  const draw = () => {
    // First crop down to whatever region the active zoom keyframe (if any)
    // wants on screen right now, then fit-crop THAT region to the target
    // aspect ratio — same "cover" math as before, just operating on the
    // zoomed-in bounds instead of the full frame.
    const timeMs = video.currentTime * 1000;
    const zoom = getActiveZoomRect(zoomKeyframes, timeMs);
    const zx = zoom.x * video.videoWidth;
    const zy = zoom.y * video.videoHeight;
    const zw = zoom.w * video.videoWidth;
    const zh = zoom.h * video.videoHeight;

    const srcRatio = zw / zh;
    let sw = zw;
    let sh = zh;
    if (srcRatio > targetRatio) {
      sw = zh * targetRatio;
    } else {
      sh = zw / targetRatio;
    }
    const sx = zx + (zw - sw) / 2;
    const sy = zy + (zh - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    // Smart Camera's "click highlight": a soft pulse at the spot each
    // auto-detected moment was centered on, riding along the same crop
    // math above so it stays pinned to that point through the zoom-in ease.
    const activeAuto = zoomKeyframes.find(
      (kf) => kf.source === "auto" && timeMs >= kf.startMs && timeMs <= kf.startMs + INTERACTION_PULSE_MS
    );
    if (activeAuto) {
      const px = (activeAuto.rect.x + activeAuto.rect.w / 2) * video.videoWidth;
      const py = (activeAuto.rect.y + activeAuto.rect.h / 2) * video.videoHeight;
      const cx = ((px - sx) / sw) * canvas.width;
      const cy = ((py - sy) / sh) * canvas.height;
      if (cx >= 0 && cx <= canvas.width && cy >= 0 && cy <= canvas.height) {
        const t = Math.max(0, Math.min(1, (timeMs - activeAuto.startMs) / INTERACTION_PULSE_MS));
        drawInteractionPulse(ctx, canvas.width, canvas.height, cx, cy, t);
      }
    }
  };

  const canvasStream = canvas.captureStream(opts.fps);
  const mediaStream = new MediaStream();
  canvasStream.getVideoTracks().forEach((t) => mediaStream.addTrack(t));

  // Routing the source <video>'s audio through Web Audio (rather than a
  // second captureStream() call combined with the canvas's video track) is
  // deliberate: mixing MediaStreamTracks pulled from two independent
  // captureStream() calls into one MediaStream fed to a single MediaRecorder
  // is a known-flaky Chromium combination — it produced exactly the
  // 0x0 / undecodable exports documented in TODOS.md. A
  // MediaStreamAudioDestinationNode fed by createMediaElementSource is the
  // standard, reliable way to record a canvas's picture together with an
  // HTMLMediaElement's audio. Side effect: createMediaElementSource takes
  // over the element's audio output, so export now re-encodes silently
  // instead of audibly playing the recording while it processes.
  let audioCtx: AudioContext | null = null;
  if (typeof AudioContext !== "undefined") {
    audioCtx = new AudioContext();
    const sourceNode = audioCtx.createMediaElementSource(video);
    const destNode = audioCtx.createMediaStreamDestination();
    sourceNode.connect(destNode);
    destNode.stream.getAudioTracks().forEach((t) => mediaStream.addTrack(t));
  }

  const durationMs = video.duration * 1000;

  // MediaRecorder.isTypeSupported() can report an MP4/H.264 codec string as
  // supported when the browser's actual encoder still fails to *initialize*
  // for a given stream (observed live: "EncodingError — Encoder
  // initialization failed", on a real MP4-capable Chrome, against a plain
  // canvas+Web Audio stream). There's no reliable way to pre-check this —
  // the only real test is starting the recorder — so one MP4 export
  // attempt is made and, specifically on that failure, retried once against
  // WebM (VP8/VP9, which doesn't carry MP4's proprietary-codec licensing
  // constraints and has not been observed to fail this way) rather than
  // leaving the user with a permanently broken "Export Video" button.
  async function runAttempt(format: ExportFormat): Promise<{ blob: Blob; format: ExportFormat }> {
    const { mimeType, format: resolvedFormat } = pickMimeType(format);
    const recorder = new MediaRecorder(mediaStream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: opts.videoBitsPerSecond,
    });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    let rafId = 0;
    const tick = () => {
      draw();
      opts.onProgress?.(Math.min(1, video.currentTime / (video.duration || 1)), "recording");
      if (!video.ended) rafId = requestAnimationFrame(tick);
    };

    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        cancelAnimationFrame(rafId);
        resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
      };
      recorder.onerror = (event) => {
        // MediaRecorder's "error" event carries the real DOMException on
        // `.error` (name + message) — the generic string this used to
        // reject with threw that diagnostic info away entirely, making any
        // real encoding failure impossible to debug from the UI or here,
        // and impossible to distinguish from any other failure for the
        // MP4-to-WebM fallback above.
        cancelAnimationFrame(rafId);
        const mediaError = (event as unknown as { error?: DOMException }).error;
        console.error("Export MediaRecorder error:", mediaError ?? event);
        reject(
          new Error(
            mediaError
              ? `${mediaError.name}${mediaError.message ? `: ${mediaError.message}` : ""}`
              : "Export failed while encoding."
          )
        );
      };
      video.pause();
      video.currentTime = 0;
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

    return { blob, format: resolvedFormat };
  }

  let result: { blob: Blob; format: ExportFormat };
  let outcome: ExportResult["outcome"] = "native";
  try {
    result = await runAttempt(opts.format);
  } catch (err) {
    const isEncodingError = err instanceof Error && /encod/i.test(err.message);
    if (opts.format === "mp4" && isEncodingError) {
      console.warn("MP4 export failed to initialize — retrying as WebM.", err);
      try {
        result = await runAttempt("webm");
      } catch (fallbackErr) {
        await audioCtx?.close();
        URL.revokeObjectURL(sourceUrl);
        throw fallbackErr;
      }
      outcome = "webm-fallback";

      // The browser's own encoder can't produce MP4 for this stream at all
      // (a real, observed Chrome/OS limitation — see mp4Fallback.ts) —
      // re-encode the WebM we just got into a genuine MP4 client-side so
      // "Export as MP4" still actually delivers one instead of silently
      // downgrading the container.
      try {
        const mp4Blob = await transcodeToMp4(result.blob, {
          onProgress: (f) => opts.onProgress?.(f, "transcoding"),
          totalDurationMs: opts.sourceDurationMs,
        });
        result = { blob: mp4Blob, format: "mp4" };
        outcome = "transcoded-to-mp4";
      } catch (transcodeErr) {
        console.warn("Client-side MP4 transcode failed — delivering WebM instead.", transcodeErr);
        // result/outcome stay on the WebM fallback from above.
      }
    } else {
      await audioCtx?.close();
      URL.revokeObjectURL(sourceUrl);
      throw err;
    }
  }

  await audioCtx?.close();
  URL.revokeObjectURL(sourceUrl);
  return { blob: result.blob, format: result.format, fileExtension: result.format === "mp4" ? "mp4" : "webm", outcome };
}
