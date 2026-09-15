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
  private backgroundImage: HTMLImageElement | null = null;
  private backgroundImageUrl: string | null = null;

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
      if (hasScreen) this.drawScreen(sources.screenVideo!, cx, cy, cw, ch);
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
      this.drawScreen(sources.screenVideo!, cx, cy, cw, ch);
    }

    ctx.restore();
  }

  private readyVideo(v: HTMLVideoElement | null): v is HTMLVideoElement {
    return !!v && v.readyState >= 2 && v.videoWidth > 0;
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
      if (screen) this.drawScreen(screen, cx, cy, cw, ch);
      else this.drawScreenPlaceholder(cx, cy, cw, ch);
      return;
    }
    if (layout === "camera-only") {
      this.drawCameraLayer(now, cx, cy, cw, ch, "rectangle", 0, false, false);
      return;
    }

    if (layout === "side-by-side") {
      if (screen) this.drawScreen(screen, cx, cy, cw / 2, ch);
      else this.drawScreenPlaceholder(cx, cy, cw / 2, ch);
      this.drawCameraLayer(now, cx + cw / 2, cy, cw / 2, ch, "rectangle", 0, false, false);
      return;
    }

    if (layout === "split") {
      if (screen) this.drawScreen(screen, cx, cy, cw, ch / 2);
      else this.drawScreenPlaceholder(cx, cy, cw, ch / 2);
      this.drawCameraLayer(now, cx, cy + ch / 2, cw, ch / 2, "rectangle", 0, false, false);
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
    if (screen) this.drawScreen(screen, cx, cy, cw, ch);
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
    rounded = false
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
    const { dx, dy, dw, dh } = containFitDest(video.videoWidth, video.videoHeight, x, y, w, h);
    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, dx, dy, dw, dh);
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
      layerCtx.filter = "none";
      layerCtx.drawImage(video, 0, 0, vw, vh);
      return this.layerCanvas;
    }

    const mask = this.segmentation.segment(video, now);
    if (!mask) {
      // No fresh mask this frame — reuse whatever is already in layerCanvas
      // rather than flashing back to an unprocessed frame.
      return this.layerCanvas;
    }

    const alpha = this.maskToAlphaCanvas(mask, vw, vh);

    // 1. Paint the background layer (blurred self, image, or built-in CSS).
    layerCtx.filter = "none";
    if (bg.mode === "blur") {
      const px = bg.blurStrength === "light" ? 8 : bg.blurStrength === "strong" ? 28 : 16;
      layerCtx.filter = `blur(${px}px)`;
      layerCtx.drawImage(video, 0, 0, vw, vh);
      layerCtx.filter = "none";
    } else if (bg.mode === "image" && this.backgroundImage) {
      const { sx, sy, sw, sh } = coverFitSource(
        this.backgroundImage.naturalWidth,
        this.backgroundImage.naturalHeight,
        vw,
        vh
      );
      layerCtx.filter = `brightness(${bg.imageBrightness}) contrast(${bg.imageContrast})`;
      layerCtx.drawImage(this.backgroundImage, sx, sy, sw, sh, 0, 0, vw, vh);
      layerCtx.filter = "none";
    } else if (bg.mode === "builtin") {
      const builtin = BUILTIN_BACKGROUNDS.find((b) => b.id === bg.builtinId) ?? BUILTIN_BACKGROUNDS[0];
      layerCtx.fillStyle = angledGradient(layerCtx, vw, vh, builtin.angleDeg, builtin.stops);
      layerCtx.fillRect(0, 0, vw, vh);
    } else {
      layerCtx.fillStyle = "#111";
      layerCtx.fillRect(0, 0, vw, vh);
    }

    // 2. Cut the person out of the raw frame using the mask as alpha.
    if (this.personCanvas.width !== vw || this.personCanvas.height !== vh) {
      this.personCanvas.width = vw;
      this.personCanvas.height = vh;
    }
    const personCtx = this.personCanvas.getContext("2d")!;
    personCtx.clearRect(0, 0, vw, vh);
    personCtx.drawImage(video, 0, 0, vw, vh);
    personCtx.globalCompositeOperation = "destination-in";
    personCtx.drawImage(alpha, 0, 0, vw, vh);
    personCtx.globalCompositeOperation = "source-over";

    // 3. Composite person over background.
    layerCtx.drawImage(this.personCanvas, 0, 0);

    return this.layerCanvas;
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
        const sharpened = 1 / (1 + Math.exp(-(min - 0.5) * SHARPEN_K));
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
