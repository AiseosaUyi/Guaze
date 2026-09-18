import { SegmentationEngine, type SegmentationMask } from "./segmentation";
import type { CameraTransform, RecordingSettings } from "./types";
import { BUILTIN_BACKGROUNDS } from "./presets";

export interface CompositorSources {
  screenVideo: HTMLVideoElement | null;
  cameraVideo: HTMLVideoElement | null;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SHARPEN_FILTER_ID = "social-recorder-sharpen";

/** Canvas2D's `filter: url(#id)` needs a matching SVG <filter> element
 * present in the document — there's no native convolution filter on
 * CanvasRenderingContext2D itself. Injects one (hidden, zero-size) the
 * first time it's needed and reuses it after that. Backs the webcam
 * clean-up pass's sharpen kernel. */
function ensureSharpenFilterDom(): Element | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(`${SHARPEN_FILTER_ID}-matrix`);
  if (existing) return existing;

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  (svg as unknown as HTMLElement).style.position = "absolute";
  (svg as unknown as HTMLElement).style.pointerEvents = "none";

  const filter = document.createElementNS(svgNs, "filter");
  filter.setAttribute("id", SHARPEN_FILTER_ID);
  filter.setAttribute("color-interpolation-filters", "sRGB");

  const matrixEl = document.createElementNS(svgNs, "feConvolveMatrix");
  matrixEl.setAttribute("id", `${SHARPEN_FILTER_ID}-matrix`);
  matrixEl.setAttribute("order", "3");
  matrixEl.setAttribute("kernelMatrix", "0 0 0 0 1 0 0 0 0");
  matrixEl.setAttribute("divisor", "1");
  matrixEl.setAttribute("bias", "0");
  matrixEl.setAttribute("edgeMode", "duplicate");
  matrixEl.setAttribute("preserveAlpha", "true");

  filter.appendChild(matrixEl);
  svg.appendChild(filter);
  document.body.appendChild(svg);
  return matrixEl;
}

const SIZE_FRACTIONS: Record<CameraTransform["size"], number> = {
  tiny: 0.13,
  small: 0.2,
  medium: 0.28,
  large: 0.4,
};

function coverFitSource(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
) {
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;
  let sw = srcW;
  let sh = srcH;
  if (srcRatio > dstRatio) {
    sw = srcH * dstRatio;
  } else {
    sh = srcW / dstRatio;
  }
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

/** Fits the whole source inside the destination box without cropping —
 * unlike coverFitSource, nothing outside the box is ever cut off. Used for
 * the screen share so the user always sees their entire screen; any
 * leftover space is letterboxed against the canvas's existing black fill. */
function containFitDest(
  srcW: number,
  srcH: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number
) {
  const srcRatio = srcW / srcH;
  const boxRatio = boxW / boxH;
  let dw = boxW;
  let dh = boxH;
  if (srcRatio > boxRatio) {
    dh = boxW / srcRatio;
  } else {
    dw = boxH * srcRatio;
  }
  return { dx: boxX + (boxW - dw) / 2, dy: boxY + (boxH - dh) / 2, dw, dh };
}

/** Blends between a tight cover-crop (zoom 0 — fills the box completely,
 * same result as coverFitSource) and a full contain-fit (zoom 1 — the
 * entire source visible, letterboxed) with no distortion at any point in
 * between: the cropped region is always drawn at its own true aspect
 * ratio via containFitDest rather than stretched to fill the box, so
 * partial zoom just means a partial letterbox, never a warped picture.
 * Pan shifts which part of the source the crop is centered on and does
 * nothing at zoom 1 — the crop window is the whole source by then, so
 * there's nothing left to shift. */
function zoomedCoverFit(
  srcW: number,
  srcH: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  zoom: number,
  panX: number,
  panY: number
) {
  const cover = coverFitSource(srcW, srcH, boxW, boxH);
  const z = Math.max(0, Math.min(1, zoom));
  const cropW = cover.sw + (srcW - cover.sw) * z;
  const cropH = cover.sh + (srcH - cover.sh) * z;
  const slackX = Math.max(0, srcW - cropW);
  const slackY = Math.max(0, srcH - cropH);
  const px = Math.max(-1, Math.min(1, panX));
  const py = Math.max(-1, Math.min(1, panY));
  const centerX = srcW / 2 + px * (slackX / 2);
  const centerY = srcH / 2 + py * (slackY / 2);
  const sx = Math.max(0, Math.min(srcW - cropW, centerX - cropW / 2));
  const sy = Math.max(0, Math.min(srcH - cropH, centerY - cropH / 2));
  const { dx, dy, dw, dh } = containFitDest(cropW, cropH, boxX, boxY, boxW, boxH);
  return { sx, sy, sw: cropW, sh: cropH, dx, dy, dw, dh };
}

function angledGradient(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  angleDeg: number,
  stops: { offset: number; color: string }[]
): CanvasGradient {
  const angle = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(angle) * 0.5;
  const dy = -Math.cos(angle) * 0.5;
  const gradient = ctx.createLinearGradient(
    w / 2 - dx * w,
    h / 2 - dy * h,
    w / 2 + dx * w,
    h / 2 + dy * h
  );
  for (const stop of stops) gradient.addColorStop(stop.offset, stop.color);
  return gradient;
}

function overlayRect(
  canvasW: number,
  canvasH: number,
  transform: CameraTransform,
  aspect: number
): Rect {
  const margin = canvasW * 0.03;
  const fraction = SIZE_FRACTIONS[transform.size];
  const w = canvasW * fraction;
  const h = transform.shape === "circle" ? w : w / aspect;

  if (transform.position === "custom") {
    return {
      x: transform.customX * canvasW - w / 2,
      y: transform.customY * canvasH - h / 2,
      w,
      h,
    };
  }

  const [vAnchor, hAnchor] = transform.position.split("-") as [
    "top" | "middle" | "bottom",
    "left" | "center" | "right"
  ];

  const x =
    hAnchor === "left"
      ? margin
      : hAnchor === "right"
        ? canvasW - w - margin
        : (canvasW - w) / 2;
  const y =
    vAnchor === "top"
      ? margin
      : vAnchor === "bottom"
        ? canvasH - h - margin
        : (canvasH - h) / 2;

  return { x, y, w, h };
}

function clipShape(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  transform: CameraTransform
) {
  ctx.beginPath();
  if (transform.shape === "circle") {
    const r = Math.min(rect.w, rect.h) / 2;
    ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, r, 0, Math.PI * 2);
  } else {
    const radius =
      transform.shape === "rounded" ? Math.min(transform.cornerRadius, rect.h / 2, rect.w / 2) : 0;
    const { x, y, w, h } = rect;
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
  }
  ctx.closePath();
  ctx.clip();
}

/** Builds a rounded-rect path without clipping, so callers can choose to
 * `.fill()` (for a shadow-casting card) or `.clip()` (for the content mask)
 * independently. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cornerRadius: number
) {
  const radius = Math.max(0, Math.min(cornerRadius, h / 2, w / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Owns the offscreen canvas that the whole recording is drawn to, one
 * requestAnimationFrame at a time. Also owns the SegmentationEngine, since
 * a composited frame and its person mask are only meaningful together.
 */
export class CompositionEngine {
  private ctx: CanvasRenderingContext2D;
  private sources: CompositorSources = { screenVideo: null, cameraVideo: null };
  private settings: RecordingSettings;
  private segmentation = new SegmentationEngine();
  private rafId: number | null = null;
  private running = false;

  // Reused offscreen buffers to avoid per-frame allocation.
  private maskCanvas = document.createElement("canvas");
  private featherCanvas = document.createElement("canvas");
  private personCanvas = document.createElement("canvas");
  private layerCanvas = document.createElement("canvas");
  private bgLayerCanvas = document.createElement("canvas");
  private haloOuterCanvas = document.createElement("canvas");
  private haloCanvas = document.createElement("canvas");
  private wrapCanvas = document.createElement("canvas");
  private backgroundImage: HTMLImageElement | null = null;
  private backgroundImageUrl: string | null = null;
  private backgroundVideo: HTMLVideoElement | null = null;
  private backgroundVideoUrl: string | null = null;
  /** CSS filter string for the webcam clean-up pass — recomputed whenever
   * settings.enhance changes (updateSettings), applied per-frame for free
   * as a native Canvas2D filter rather than any per-pixel JS work. */
  private enhanceFilterCss = "none";

  constructor(
    private canvas: HTMLCanvasElement,
    initialSettings: RecordingSettings
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context is not available.");
    this.ctx = ctx;
    this.settings = initialSettings;
  }

  setSources(sources: CompositorSources) {
    this.sources = sources;
  }

  updateSettings(settings: RecordingSettings) {
    this.settings = settings;
    if (settings.background.mode !== "none" && !this.segmentation.ready) {
      void this.segmentation.load();
    }
    const url = settings.background.imageUrl;
    if (url && url !== this.backgroundImageUrl) {
      this.backgroundImageUrl = url;
      const img = new Image();
      img.onload = () => {
        this.backgroundImage = img;
      };
      img.src = url;
    }
    if (!url) {
      this.backgroundImage = null;
      this.backgroundImageUrl = null;
    }

    const videoUrl = settings.background.videoUrl;
    if (videoUrl && videoUrl !== this.backgroundVideoUrl) {
      this.backgroundVideoUrl = videoUrl;
      const vid = document.createElement("video");
      vid.loop = true;
      vid.muted = true;
      vid.playsInline = true;
      vid.src = videoUrl;
      void vid.play().catch(() => {
        // Autoplay can be blocked until a user gesture has happened in the
        // tab — the mode-select screen's own click already provides one in
        // practice, so this only matters on a rare edge case, and playback
        // starts as soon as it's allowed.
      });
      this.backgroundVideo = vid;
    }
    if (!videoUrl) {
      this.backgroundVideo?.pause();
      this.backgroundVideo = null;
      this.backgroundVideoUrl = null;
    }

    this.updateEnhanceFilter();
  }

  /** Recomputes the clean-up pass's filter string from settings.enhance.
   * Cheap enough to just redo in full on every settings change (this runs
   * on React state updates, never per animation frame) — no need to diff. */
  private updateEnhanceFilter() {
    const e = this.settings.enhance;
    if (!e || !e.enabled) {
      this.enhanceFilterCss = "none";
      return;
    }
    const strength = Math.max(0, Math.min(1, e.strength));
    const filters: string[] = [];
    if (strength > 0.05) {
      // Denoise then sharpen, in that order — a light pre-blur knocks down
      // sensor noise so the sharpen kernel amplifies real edges instead of
      // grain. The kernel itself is blended between identity (strength 0)
      // and a standard 4-neighbor sharpen (strength 1) by scaling its
      // center/side weights, so the slider has no hard on/off jump.
      filters.push(`blur(${(0.6 * strength).toFixed(2)}px)`);
      const matrixEl = ensureSharpenFilterDom();
      if (matrixEl) {
        const center = 1 + 4 * strength;
        const side = -strength;
        matrixEl.setAttribute("kernelMatrix", `0 ${side} 0 ${side} ${center} ${side} 0 ${side} 0`);
        filters.push(`url(#${SHARPEN_FILTER_ID})`);
      }
    }
    filters.push(`brightness(${e.brightness})`, `contrast(${e.contrast})`, `saturate(${e.saturation})`);
    this.enhanceFilterCss = filters.join(" ");
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  get segmentationReady() {
    return this.segmentation.ready;
  }

  get segmentationError() {
    return this.segmentation.lastError;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (now: number) => {
      if (!this.running) return;
      this.draw(now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  getStream(fps: number): MediaStream {
    return this.canvas.captureStream(fps);
  }

  dispose() {
    this.stop();
    this.segmentation.dispose();
    this.backgroundVideo?.pause();
    this.backgroundVideo = null;
  }

  // ---- drawing ----

  private draw(now: number) {
    const { ctx, canvas, settings, sources } = this;
    ctx.save();

    // The "frame" is the Screen-Studio-style padded backdrop: the actual
    // recording composites into a smaller, rounded, shadowed content rect
    // instead of the full canvas, with a gradient/wallpaper filling the rest.
    // When disabled, cx/cy/cw/ch collapse to the full canvas and every draw
    // call below behaves exactly as it did before the frame existed.
    const frame = settings.frame;
    let cx = 0;
    let cy = 0;
    let cw = canvas.width;
    let ch = canvas.height;

    if (frame.enabled) {
      this.drawBackdrop(canvas.width, canvas.height, frame.backdropId);
      const pad = Math.round(Math.min(canvas.width, canvas.height) * (frame.padding / 100));
      cx = pad;
      cy = pad;
      cw = canvas.width - pad * 2;
      ch = canvas.height - pad * 2;

      if (frame.shadow) {
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = Math.max(8, Math.round(cw * 0.035));
        ctx.shadowOffsetY = Math.max(4, Math.round(cw * 0.012));
        ctx.fillStyle = "#000";
        roundedRectPath(ctx, cx, cy, cw, ch, frame.cornerRadius);
        ctx.fill();
        ctx.restore();
      }
      roundedRectPath(ctx, cx, cy, cw, ch, frame.cornerRadius);
      ctx.clip();
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Screen capture is only requested once recording actually starts (it
    // needs the OS picker), so sources.screenVideo stays null for the whole
    // setup phase — that's expected, not a dropped source. Only treat a
    // missing screen as a mid-recording failure (and fall back to full-frame
    // camera so the take isn't lost) once a screen video has actually been
    // attached at least once.
    const screenRequested = settings.mode !== "camera" && sources.screenVideo !== null;
    const hasScreen = screenRequested && this.readyVideo(sources.screenVideo);
    const hasCamera = settings.mode !== "screen" && this.readyVideo(sources.cameraVideo);

    if (settings.mode === "screen") {
      if (hasScreen) this.drawScreen(sources.screenVideo!, cx, cy, cw, ch, false, this.effectiveScreenFit(cw, ch));
    } else if (settings.mode === "camera") {
      if (hasCamera) this.drawCameraLayer(now, cx, cy, cw, ch, "rectangle", 0, false, false);
    } else if (screenRequested && !hasScreen && hasCamera) {
      this.drawCameraLayer(now, cx, cy, cw, ch, "rectangle", 0, false, false);
    } else if (hasCamera) {
      // Setup preview (no screen yet) or a normal both-sources take —
      // drawBoth already places the camera at its configured bubble
      // position against a placeholder when screen is absent, so the setup
      // preview matches the eventual recording layout instead of the camera
      // filling the whole frame.
      this.drawBoth(now, hasScreen ? sources.screenVideo! : null, sources.cameraVideo!, cx, cy, cw, ch);
    } else if (hasScreen) {
      this.drawScreen(sources.screenVideo!, cx, cy, cw, ch, false, this.effectiveScreenFit(cw, ch));
    }

    ctx.restore();
  }

  private readyVideo(v: HTMLVideoElement | null): v is HTMLVideoElement {
    return !!v && v.readyState >= 2 && v.videoWidth > 0;
  }

  /** Resolves settings.screenFitMode against a specific box. "auto" fills
   * (crops) a box that's portrait or near-square — the shape a mobile-social
   * recording's screen block actually is — and shows the whole screen
   * letterboxed in a wide/landscape box, same as it always has. */
  private effectiveScreenFit(boxW: number, boxH: number): "contain" | "cover" {
    const mode = this.settings.screenFitMode;
    if (mode === "contain" || mode === "cover") return mode;
    return boxH >= boxW ? "cover" : "contain";
  }

  /** Fills the full canvas with the frame's wallpaper/gradient backdrop. */
  private drawBackdrop(w: number, h: number, backdropId: string) {
    const { ctx } = this;
    const bg = BUILTIN_BACKGROUNDS.find((b) => b.id === backdropId) ?? BUILTIN_BACKGROUNDS[0];
    ctx.fillStyle = angledGradient(ctx, w, h, bg.angleDeg, bg.stops);
    ctx.fillRect(0, 0, w, h);
  }

  private drawBoth(
    now: number,
    screen: HTMLVideoElement | null,
    camera: HTMLVideoElement,
    cx: number,
    cy: number,
    cw: number,
    ch: number
  ) {
    const { settings } = this;
    const layout = settings.layout;

    // Even in "both" capture mode, the layout picker lets you produce a
    // take that's 100% screen or 100% camera without switching modes and
    // losing the other source (PRD §11).
    if (layout === "screen-only") {
      if (screen) this.drawScreen(screen, cx, cy, cw, ch, false, this.effectiveScreenFit(cw, ch));
      else this.drawScreenPlaceholder(cx, cy, cw, ch);
      return;
    }
    if (layout === "camera-only") {
      this.drawCameraLayer(now, cx, cy, cw, ch, "rectangle", 0, false, false);
      return;
    }

    if (layout === "side-by-side") {
      if (screen) this.drawScreen(screen, cx, cy, cw / 2, ch, false, this.effectiveScreenFit(cw / 2, ch));
      else this.drawScreenPlaceholder(cx, cy, cw / 2, ch);
      this.drawCameraLayer(now, cx + cw / 2, cy, cw / 2, ch, "rectangle", 0, false, false);
      return;
    }

    if (layout === "split") {
      // On a portrait/mobile-social canvas, a 50/50 split wastes most of
      // the frame on a face that doesn't need that much room — bias toward
      // the screen content (the thing being taught/shown) the way real
      // tutorial-style vertical videos are cut, with the camera as a
      // smaller reaction band underneath. Landscape keeps the original
      // even split.
      const portrait = ch > cw;
      const screenH = portrait ? ch * 0.62 : ch / 2;
      if (screen) this.drawScreen(screen, cx, cy, cw, screenH, false, this.effectiveScreenFit(cw, screenH));
      else this.drawScreenPlaceholder(cx, cy, cw, screenH);
      this.drawCameraLayer(now, cx, cy + screenH, cw, ch - screenH, "rectangle", 0, false, false);
      return;
    }

    if (layout === "camera-focus") {
      this.drawCameraLayer(now, cx, cy, cw, ch, "rectangle", 0, false, false);
      if (screen) {
        const rect = overlayRect(cw, ch, {
          ...settings.camera,
          position: settings.camera.position === "custom" ? "bottom-right" : settings.camera.position,
          shape: "rounded",
        }, 16 / 9);
        this.drawScreen(screen, cx + rect.x, cy + rect.y, rect.w, rect.h, true);
      }
      return;
    }

    // floating / pip (and camera-only fallback with a screen present)
    if (screen) this.drawScreen(screen, cx, cy, cw, ch, false, this.effectiveScreenFit(cw, ch));
    else this.drawScreenPlaceholder(cx, cy, cw, ch);
    const rect = overlayRect(cw, ch, settings.camera, camera.videoWidth / camera.videoHeight || 16 / 9);
    this.drawCameraLayer(
      now,
      cx + rect.x,
      cy + rect.y,
      rect.w,
      rect.h,
      settings.camera.shape,
      settings.camera.cornerRadius,
      settings.camera.border,
      settings.camera.shadow
    );
  }

  private drawScreen(
    video: HTMLVideoElement,
    x: number,
    y: number,
    w: number,
    h: number,
    rounded = false,
    fit: "contain" | "cover" = "contain"
  ) {
    const { ctx } = this;
    ctx.save();
    if (rounded) {
      clipShape(ctx, { x, y, w, h }, {
        position: "custom",
        customX: 0,
        customY: 0,
        size: "small",
        shape: "rounded",
        cornerRadius: 14,
        border: true,
        shadow: true,
      });
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
    } else {
      // Full-frame draws land on top of the canvas's own black fill from
      // draw(), but filling here too keeps this box correct in isolation
      // (e.g. side-by-side/split call this with less than the full canvas).
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
    }
    if (fit === "cover") {
      // Crops the source to fill the box edge-to-edge — the "phone app
      // screen recording" look mobile-social viewers expect, instead of a
      // small landscape rectangle floating in a sea of black. screenView
      // lets that default tightest crop be pulled back (zoom) and
      // repositioned (pan) instead of being stuck with the centered
      // minimum crop.
      const view = this.settings.screenView;
      const { sx, sy, sw, sh, dx, dy, dw, dh } = zoomedCoverFit(
        video.videoWidth,
        video.videoHeight,
        x,
        y,
        w,
        h,
        view.zoom,
        view.panX,
        view.panY
      );
      ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
    } else {
      const { dx, dy, dw, dh } = containFitDest(video.videoWidth, video.videoHeight, x, y, w, h);
      ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, dx, dy, dw, dh);
    }
    ctx.restore();
    if (rounded) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 2;
      clipShape(ctx, { x, y, w, h }, {
        position: "custom",
        customX: 0,
        customY: 0,
        size: "small",
        shape: "rounded",
        cornerRadius: 14,
        border: true,
        shadow: true,
      });
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Fills the region where the screen would go before recording starts
   * (getDisplayMedia can only be requested on the actual Start click), so the
   * setup preview reads as "your screen goes here" instead of a stray black
   * hole next to the camera bubble. */
  private drawScreenPlaceholder(x: number, y: number, w: number, h: number) {
    const { ctx } = this;
    if (w < 120 || h < 60) return;
    ctx.save();
    ctx.fillStyle = "#161616";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.font = `${Math.max(11, Math.round(Math.min(w, h) * 0.045))}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Your screen appears here when you record", x + w / 2, y + h / 2);
    ctx.restore();
  }

  /** Draws the processed (background-replaced) camera into the destination
   * rect, clipped to the requested shape. */
  private drawCameraLayer(
    now: number,
    x: number,
    y: number,
    w: number,
    h: number,
    shape: CameraTransform["shape"],
    cornerRadius: number,
    border: boolean,
    shadow: boolean
  ) {
    const video = this.sources.cameraVideo;
    if (!video || !this.readyVideo(video)) return;
    const { ctx, settings } = this;
    const processed = this.renderProcessedCameraFrame(video, now);

    ctx.save();
    if (shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 20;
      ctx.shadowOffsetY = 6;
    }
    const rect = { x, y, w, h };
    clipShape(ctx, rect, { position: "custom", customX: 0, customY: 0, size: "small", shape, cornerRadius, border, shadow });
    ctx.shadowColor = "transparent";
    const { sx, sy, sw, sh } = coverFitSource(processed.width, processed.height, w, h);
    ctx.drawImage(processed, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();

    if (border) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 3;
      clipShape(ctx, { x: x + 1.5, y: y + 1.5, w: w - 3, h: h - 3 }, {
        position: "custom",
        customX: 0,
        customY: 0,
        size: "small",
        shape,
        cornerRadius,
        border,
        shadow,
      });
      ctx.stroke();
      ctx.restore();
    }
    void settings; // settings.background read inside renderProcessedCameraFrame
  }

  /** Returns a canvas containing the camera frame with the current
   * background mode applied, at the video's native resolution. */
  private renderProcessedCameraFrame(video: HTMLVideoElement, now: number): HTMLCanvasElement {
    const bg = this.settings.background;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (this.layerCanvas.width !== vw || this.layerCanvas.height !== vh) {
      this.layerCanvas.width = vw;
      this.layerCanvas.height = vh;
    }
    const layerCtx = this.layerCanvas.getContext("2d")!;

    if (bg.mode === "none" || !this.segmentation.ready) {
      layerCtx.filter = this.enhanceFilterCss;
      layerCtx.drawImage(video, 0, 0, vw, vh);
      layerCtx.filter = "none";
      return this.layerCanvas;
    }

    const mask = this.segmentation.segment(video, now);
    if (!mask) {
      // No fresh mask this frame — reuse whatever is already in layerCanvas
      // rather than flashing back to an unprocessed frame.
      return this.layerCanvas;
    }

    const alpha = this.maskToAlphaCanvas(mask, vw, vh);

    // 1. Paint the background layer (blurred self, image, video, or
    // built-in CSS) into its own buffer rather than straight into
    // layerCanvas — the light-wrap pass (step 4) needs the background's
    // own pixels after the person is composited on top, so it has to
    // survive independently of the final frame.
    if (this.bgLayerCanvas.width !== vw || this.bgLayerCanvas.height !== vh) {
      this.bgLayerCanvas.width = vw;
      this.bgLayerCanvas.height = vh;
    }
    const bgCtx = this.bgLayerCanvas.getContext("2d")!;
    bgCtx.filter = "none";
    if (bg.mode === "blur") {
      const px = bg.blurStrength === "light" ? 8 : bg.blurStrength === "strong" ? 28 : 16;
      bgCtx.filter = `blur(${px}px)`;
      bgCtx.drawImage(video, 0, 0, vw, vh);
      bgCtx.filter = "none";
    } else if (bg.mode === "image" && this.backgroundImage) {
      const { sx, sy, sw, sh } = coverFitSource(
        this.backgroundImage.naturalWidth,
        this.backgroundImage.naturalHeight,
        vw,
        vh
      );
      bgCtx.filter = `brightness(${bg.imageBrightness}) contrast(${bg.imageContrast})`;
      bgCtx.drawImage(this.backgroundImage, sx, sy, sw, sh, 0, 0, vw, vh);
      bgCtx.filter = "none";
    } else if (
      bg.mode === "video" &&
      this.backgroundVideo &&
      this.backgroundVideo.readyState >= 2 &&
      this.backgroundVideo.videoWidth > 0
    ) {
      const { sx, sy, sw, sh } = coverFitSource(
        this.backgroundVideo.videoWidth,
        this.backgroundVideo.videoHeight,
        vw,
        vh
      );
      bgCtx.filter = `brightness(${bg.imageBrightness}) contrast(${bg.imageContrast})`;
      bgCtx.drawImage(this.backgroundVideo, sx, sy, sw, sh, 0, 0, vw, vh);
      bgCtx.filter = "none";
    } else if (bg.mode === "builtin") {
      const builtin = BUILTIN_BACKGROUNDS.find((b) => b.id === bg.builtinId) ?? BUILTIN_BACKGROUNDS[0];
      bgCtx.fillStyle = angledGradient(bgCtx, vw, vh, builtin.angleDeg, builtin.stops);
      bgCtx.fillRect(0, 0, vw, vh);
    } else {
      bgCtx.fillStyle = "#111";
      bgCtx.fillRect(0, 0, vw, vh);
    }
    layerCtx.filter = "none";
    layerCtx.drawImage(this.bgLayerCanvas, 0, 0);

    // 2. Cut the person out of the raw frame using the mask as alpha.
    if (this.personCanvas.width !== vw || this.personCanvas.height !== vh) {
      this.personCanvas.width = vw;
      this.personCanvas.height = vh;
    }
    const personCtx = this.personCanvas.getContext("2d")!;
    personCtx.clearRect(0, 0, vw, vh);
    personCtx.filter = this.enhanceFilterCss;
    personCtx.drawImage(video, 0, 0, vw, vh);
    personCtx.filter = "none";
    personCtx.globalCompositeOperation = "destination-in";
    personCtx.drawImage(alpha, 0, 0, vw, vh);
    personCtx.globalCompositeOperation = "source-over";

    // 3. Composite person over background.
    layerCtx.drawImage(this.personCanvas, 0, 0);

    // 4. Light wrap: bleed a soft, tinted rim of the background onto the
    // subject's silhouette edge. A static/video photo behind a cleanly cut
    // out person reads as a virtual-background cutout no matter how good
    // the edge is, because nothing about the subject's own lighting
    // acknowledges the scene behind them — this is the standard
    // compositing fix for that. Skipped for "blur" (the "background" there
    // is the same live footage, so there's nothing to integrate) and
    // "none".
    if (bg.mode === "image" || bg.mode === "video" || bg.mode === "builtin") {
      this.applyLightWrap(layerCtx, alpha, vw, vh);
    }

    return this.layerCanvas;
  }

  /** Blends a soft, tinted rim of the background around the subject's
   * silhouette edge so the composite reads as sitting in the scene rather
   * than pasted in front of it — the classic "light wrap" from real
   * compositing work. Reuses the already-computed edge alpha, one extra
   * blur pass to widen it, and a masked screen-blend draw of the
   * background itself; all on small, video-resolution buffers, so the
   * added cost per frame is comparable to the existing feather step. */
  private applyLightWrap(
    layerCtx: CanvasRenderingContext2D,
    alpha: HTMLCanvasElement,
    vw: number,
    vh: number
  ) {
    for (const c of [this.haloOuterCanvas, this.haloCanvas, this.wrapCanvas]) {
      if (c.width !== vw || c.height !== vh) {
        c.width = vw;
        c.height = vh;
      }
    }

    // A wider, softer blur of the subject's alpha than the edge feather
    // uses — expands the silhouette a bit further out. This radius is a
    // ring WIDTH, not a subtle feather: at the previous 0.014 factor (~27px
    // on a 1920-wide frame) the ring swallowed most of a face at typical
    // framing instead of hugging the edge, which is exactly the washed-out
    // "hazy veil over the whole face" bug this fixes.
    const outerCtx = this.haloOuterCanvas.getContext("2d")!;
    outerCtx.clearRect(0, 0, vw, vh);
    const wrapPx = Math.max(2, Math.round(vw * 0.005));
    outerCtx.filter = `blur(${wrapPx}px)`;
    outerCtx.drawImage(alpha, 0, 0, vw, vh);
    outerCtx.filter = "none";

    // Subtract the tighter silhouette back out, leaving a ring that
    // straddles the edge — this is the band the wrap actually lands in.
    const haloCtx = this.haloCanvas.getContext("2d")!;
    haloCtx.clearRect(0, 0, vw, vh);
    haloCtx.drawImage(this.haloOuterCanvas, 0, 0);
    haloCtx.globalCompositeOperation = "destination-out";
    haloCtx.drawImage(alpha, 0, 0, vw, vh);
    haloCtx.globalCompositeOperation = "source-over";

    // Blur the background itself for the wrap's color, then clip it down
    // to just that ring.
    const wrapCtx = this.wrapCanvas.getContext("2d")!;
    wrapCtx.clearRect(0, 0, vw, vh);
    wrapCtx.filter = `blur(${wrapPx}px)`;
    wrapCtx.drawImage(this.bgLayerCanvas, 0, 0, vw, vh);
    wrapCtx.filter = "none";
    wrapCtx.globalCompositeOperation = "destination-in";
    wrapCtx.drawImage(this.haloCanvas, 0, 0, vw, vh);
    wrapCtx.globalCompositeOperation = "source-over";

    // Screen-blend it onto the composited frame at a subtle strength —
    // enough to read as ambient light from the scene, not a visible glow.
    layerCtx.save();
    layerCtx.globalCompositeOperation = "screen";
    layerCtx.globalAlpha = 0.22;
    layerCtx.drawImage(this.wrapCanvas, 0, 0);
    layerCtx.restore();
  }

  /** Renders a Float32Array confidence mask into a refined alpha canvas at
   * the video's resolution.
   *
   * The segmenter's raw confidence has a wide, noisy "maybe" band around
   * hair and fast-moving edges — the model is genuinely unsure there, not
   * just low-resolution. Blurring that raw band (the previous approach)
   * only smears the uncertainty wider, which reads as a visible ghost /
   * double-exposure seam once the background is a photo of the real room
   * rather than a forgiving blur or gradient. The standard real-time matting
   * fix is erode-then-sharpen-then-feather, in that order: a small min-filter
   * pulls the silhouette in just past the unsure band, a steep sigmoid
   * snaps what's left toward decisively foreground/background, and only
   * then does a light blur anti-alias the now-thin, confident edge. */
  private maskToAlphaCanvas(mask: SegmentationMask, vw: number, vh: number): HTMLCanvasElement {
    const { width: w, height: h, data } = mask;
    if (this.maskCanvas.width !== w || this.maskCanvas.height !== h) {
      this.maskCanvas.width = w;
      this.maskCanvas.height = h;
    }
    const maskCtx = this.maskCanvas.getContext("2d")!;
    const imageData = maskCtx.createImageData(w, h);
    const SHARPEN_K = 10;
    // Raw confidence right around 0.5 doesn't only happen at real body
    // edges — a cluster of background clutter (shelving, bags, anything
    // with a person-ish silhouette or texture) can sit there too, and
    // since it's a coherent region rather than isolated noise, the erode
    // pass above doesn't remove it. Requiring a higher bar before
    // something commits to "person" cuts down on those false-positive
    // ghost patches showing through image/video backgrounds, while a
    // genuinely well-lit subject's real confidence is normally well above
    // this anyway.
    const CONFIDENCE_MIDPOINT = 0.62;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let min = 1;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          const rowOffset = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const v = data[rowOffset + nx];
            if (v < min) min = v;
          }
        }
        const sharpened = 1 / (1 + Math.exp(-(min - CONFIDENCE_MIDPOINT) * SHARPEN_K));
        imageData.data[(y * w + x) * 4 + 3] = Math.max(0, Math.min(1, sharpened)) * 255;
      }
    }
    maskCtx.putImageData(imageData, 0, 0);

    if (this.featherCanvas.width !== vw || this.featherCanvas.height !== vh) {
      this.featherCanvas.width = vw;
      this.featherCanvas.height = vh;
    }
    const featherCtx = this.featherCanvas.getContext("2d")!;
    featherCtx.clearRect(0, 0, vw, vh);
    const featherPx = Math.max(1, Math.round(vw * 0.0025));
    featherCtx.filter = `blur(${featherPx}px)`;
    featherCtx.drawImage(this.maskCanvas, 0, 0, vw, vh);
    featherCtx.filter = "none";
    return this.featherCanvas;
  }
}
