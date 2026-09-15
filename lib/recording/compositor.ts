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
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const hasScreen = settings.mode !== "camera" && this.readyVideo(sources.screenVideo);
    const hasCamera = settings.mode !== "screen" && this.readyVideo(sources.cameraVideo);

    if (settings.mode === "screen" || (!hasCamera && hasScreen)) {
      if (hasScreen) this.drawScreen(sources.screenVideo!, 0, 0, canvas.width, canvas.height);
    } else if (settings.mode === "camera" || (!hasScreen && hasCamera)) {
      if (hasCamera) this.drawCameraLayer(now, 0, 0, canvas.width, canvas.height, "rectangle", 0, false, false);
    } else if (hasScreen && hasCamera) {
      this.drawBoth(now, hasScreen ? sources.screenVideo! : null, sources.cameraVideo!);
    }

    ctx.restore();
  }

  private readyVideo(v: HTMLVideoElement | null): v is HTMLVideoElement {
    return !!v && v.readyState >= 2 && v.videoWidth > 0;
  }

  private drawBoth(now: number, screen: HTMLVideoElement | null, camera: HTMLVideoElement) {
    const { canvas, settings } = this;
    const layout = settings.layout;

    // Even in "both" capture mode, the layout picker lets you produce a
    // take that's 100% screen or 100% camera without switching modes and
    // losing the other source (PRD §11).
    if (layout === "screen-only") {
      if (screen) this.drawScreen(screen, 0, 0, canvas.width, canvas.height);
      return;
    }
    if (layout === "camera-only") {
      this.drawCameraLayer(now, 0, 0, canvas.width, canvas.height, "rectangle", 0, false, false);
      return;
    }

    if (layout === "side-by-side") {
      if (screen) this.drawScreen(screen, 0, 0, canvas.width / 2, canvas.height);
      this.drawCameraLayer(now, canvas.width / 2, 0, canvas.width / 2, canvas.height, "rectangle", 0, false, false);
      return;
    }

    if (layout === "split") {
      if (screen) this.drawScreen(screen, 0, 0, canvas.width, canvas.height / 2);
      this.drawCameraLayer(now, 0, canvas.height / 2, canvas.width, canvas.height / 2, "rectangle", 0, false, false);
      return;
    }

    if (layout === "camera-focus") {
      this.drawCameraLayer(now, 0, 0, canvas.width, canvas.height, "rectangle", 0, false, false);
      if (screen) {
        const rect = overlayRect(canvas.width, canvas.height, {
          ...settings.camera,
          position: settings.camera.position === "custom" ? "bottom-right" : settings.camera.position,
          shape: "rounded",
        }, 16 / 9);
        this.drawScreen(screen, rect.x, rect.y, rect.w, rect.h, true);
      }
      return;
    }

    // floating / pip (and camera-only fallback with a screen present)
    if (screen) this.drawScreen(screen, 0, 0, canvas.width, canvas.height);
    const rect = overlayRect(canvas.width, canvas.height, settings.camera, camera.videoWidth / camera.videoHeight || 16 / 9);
    this.drawCameraLayer(
      now,
      rect.x,
      rect.y,
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
    const { sx, sy, sw, sh } = coverFitSource(video.videoWidth, video.videoHeight, w, h);
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
    }
    ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
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

    const alpha = this.maskToAlphaCanvas(mask);

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

  /** Renders a Float32Array confidence mask into a feathered alpha canvas at
   * the video's resolution. */
  private maskToAlphaCanvas(mask: SegmentationMask): HTMLCanvasElement {
    if (this.maskCanvas.width !== mask.width || this.maskCanvas.height !== mask.height) {
      this.maskCanvas.width = mask.width;
      this.maskCanvas.height = mask.height;
    }
    const maskCtx = this.maskCanvas.getContext("2d")!;
    const imageData = maskCtx.createImageData(mask.width, mask.height);
    for (let i = 0; i < mask.data.length; i++) {
      const a = Math.max(0, Math.min(1, mask.data[i])) * 255;
      imageData.data[i * 4 + 3] = a;
    }
    maskCtx.putImageData(imageData, 0, 0);
    return this.maskCanvas;
  }
}
