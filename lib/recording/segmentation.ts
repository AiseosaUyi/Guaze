import {
  FilesetResolver,
  ImageSegmenter,
  type ImageSegmenterResult,
} from "@mediapipe/tasks-vision";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

export interface SegmentationMask {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Wraps MediaPipe's Image Segmenter for real-time selfie segmentation.
 * Runs entirely on-device (WASM). Only the ~250KB WASM runtime and the model
 * file are ever fetched over the network, once, on first use — no camera
 * frame or pixel data leaves the machine.
 *
 * Designed to fail soft: if the model can't load (offline on first run, an
 * unsupported browser, a slow device), `ready` stays false and the caller
 * should treat background mode as forced to "none" rather than blocking
 * recording on it.
 */
export class SegmentationEngine {
  private segmenter: ImageSegmenter | null = null;
  private loading: Promise<void> | null = null;
  private lastTimestampMs = -1;
  public ready = false;
  public lastError: string | null = null;

  async load(): Promise<void> {
    if (this.ready || this.loading) return this.loading ?? Promise.resolve();
    this.loading = (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
        this.segmenter = await ImageSegmenter.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });
        this.ready = true;
      } catch (err) {
        this.lastError =
          err instanceof Error ? err.message : "Background segmentation failed to load.";
        this.ready = false;
      }
    })();
    return this.loading;
  }

  /**
   * Segments one video frame. Returns person-confidence data (0..1 per
   * pixel, at the mask's own resolution, which may differ from the video's)
   * or null if the engine isn't ready or the frame is a duplicate timestamp.
   */
  segment(video: HTMLVideoElement, timestampMs: number): SegmentationMask | null {
    if (!this.ready || !this.segmenter || video.videoWidth === 0) return null;
    if (timestampMs <= this.lastTimestampMs) return null;
    this.lastTimestampMs = timestampMs;
    try {
      const result: ImageSegmenterResult = this.segmenter.segmentForVideo(
        video,
        timestampMs
      );
      const confidence = result.confidenceMasks?.[0];
      if (!confidence) {
        result.categoryMask?.close();
        return null;
      }
      const mask: SegmentationMask = {
        data: new Float32Array(confidence.getAsFloat32Array()),
        width: confidence.width,
        height: confidence.height,
      };
      confidence.close();
      result.categoryMask?.close();
      return mask;
    } catch {
      // A single bad frame shouldn't take down the recording — the caller
      // just reuses the previous composited frame.
      return null;
    }
  }

  dispose() {
    this.segmenter?.close();
    this.segmenter = null;
    this.ready = false;
  }
}
