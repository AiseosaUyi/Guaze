import { create } from "zustand";
import type {
  DeviceOption,
  ExportFormat,
  RecordingSettings,
  SourceMode,
  Stage,
  ZoomKeyframe,
} from "@/lib/recording/types";
import type { CapabilityReport } from "@/lib/recording/performance";
import type { ActivitySample } from "@/lib/recording/activity";
import {
  DEFAULT_SMART_CAMERA_INTENSITY,
  generateSmartZoomKeyframes,
  resolveZoomMarkers,
} from "@/lib/recording/smartCamera";

export const DEFAULT_SETTINGS: RecordingSettings = {
  mode: "both",
  layout: "floating",
  aspectRatio: "original",
  screenFitMode: "auto",
  screenView: { zoom: 0, panX: 0, panY: 0 },
  frame: {
    enabled: false,
    padding: 8,
    cornerRadius: 20,
    shadow: true,
    backdropId: "soft-gradient",
  },
  enhance: {
    enabled: true,
    strength: 0.5,
    brightness: 1.05,
    contrast: 1.08,
    saturation: 1.08,
  },
  background: {
    mode: "none",
    blurStrength: "medium",
    builtinId: null,
    imageUrl: null,
    imageScale: 1,
    imageBrightness: 1,
    imageContrast: 1,
    videoUrl: null,
  },
  camera: {
    position: "bottom-right",
    customX: 0.85,
    customY: 0.85,
    size: "medium",
    shape: "rounded",
    cornerRadius: 20,
    border: true,
    shadow: true,
  },
  quality: "social",
  customQuality: { width: 1920, height: 1080, fps: 30, videoBitsPerSecond: 6_000_000 },
  cursor: { visible: true },
  audio: {
    micEnabled: true,
    micDeviceId: null,
    systemAudioEnabled: false,
    noiseReduction: true,
  },
};

export interface RecordingResultState {
  url: string;
  blob: Blob;
  format: ExportFormat;
  durationMs: number;
  /** Motion samples captured over the screen source while recording (empty
   * for camera-only takes) — Smart Camera's only input. Kept on the result
   * rather than re-derived, since the source video only exists as this blob
   * from here on. */
  activitySamples?: ActivitySample[];
  /** ms-from-start timestamps from the floating "Mark zoom" control (or its
   * in-tab fallback) during this take — resolved into zoom keyframes in
   * setResult below, same as Smart Camera's own auto-detection, just from
   * explicit intent instead of inferred motion. */
  zoomMarkers?: number[];
}

interface RecorderStore {
  stage: Stage;
  settings: RecordingSettings;
  devices: { cameras: DeviceOption[]; mics: DeviceOption[] };
  capability: CapabilityReport | null;
  error: string | null;
  result: RecordingResultState | null;
  zoomKeyframes: ZoomKeyframe[];
  /** User-facing "Smart Camera" toggle + intensity — persisted per take so
   * turning it off/on or nudging intensity doesn't require re-recording.
   * Recomputing only ever touches zoomKeyframes entries with
   * source: "auto"; anything the user hand-edited (or added manually) is
   * left alone. */
  smartCameraEnabled: boolean;
  smartCameraIntensity: number;

  setStage: (stage: Stage) => void;
  chooseMode: (mode: SourceMode) => void;
  updateFrame: (partial: Partial<RecordingSettings["frame"]>) => void;
  updateEnhance: (partial: Partial<RecordingSettings["enhance"]>) => void;
  updateBackground: (partial: Partial<RecordingSettings["background"]>) => void;
  updateCamera: (partial: Partial<RecordingSettings["camera"]>) => void;
  setLayout: (layout: RecordingSettings["layout"]) => void;
  setAspectRatio: (aspectRatio: RecordingSettings["aspectRatio"]) => void;
  setScreenFitMode: (mode: RecordingSettings["screenFitMode"]) => void;
  updateScreenView: (partial: Partial<RecordingSettings["screenView"]>) => void;
  setQuality: (quality: RecordingSettings["quality"]) => void;
  updateCustomQuality: (partial: Partial<RecordingSettings["customQuality"]>) => void;
  setCursorVisible: (visible: boolean) => void;
  updateAudio: (partial: Partial<RecordingSettings["audio"]>) => void;
  setDevices: (devices: { cameras: DeviceOption[]; mics: DeviceOption[] }) => void;
  setCapability: (report: CapabilityReport | null) => void;
  setError: (error: string | null) => void;
  setResult: (result: RecordingResultState | null) => void;
  addZoomKeyframe: (keyframe: ZoomKeyframe) => void;
  updateZoomKeyframe: (id: string, partial: Partial<Omit<ZoomKeyframe, "id">>) => void;
  removeZoomKeyframe: (id: string) => void;
  setSmartCameraEnabled: (enabled: boolean) => void;
  setSmartCameraIntensity: (intensity: number) => void;
  regenerateSmartCamera: () => void;
  reset: () => void;
}

export const useRecorderStore = create<RecorderStore>((set, get) => ({
  stage: "select",
  settings: DEFAULT_SETTINGS,
  devices: { cameras: [], mics: [] },
  capability: null,
  error: null,
  result: null,
  zoomKeyframes: [],
  smartCameraEnabled: true,
  smartCameraIntensity: DEFAULT_SMART_CAMERA_INTENSITY,

  setStage: (stage) => set({ stage }),
  chooseMode: (mode) =>
    set((s) => ({ settings: { ...s.settings, mode }, stage: "setup" })),
  updateFrame: (partial) =>
    set((s) => ({ settings: { ...s.settings, frame: { ...s.settings.frame, ...partial } } })),
  updateEnhance: (partial) =>
    set((s) => ({ settings: { ...s.settings, enhance: { ...s.settings.enhance, ...partial } } })),
  updateBackground: (partial) =>
    set((s) => ({ settings: { ...s.settings, background: { ...s.settings.background, ...partial } } })),
  updateCamera: (partial) =>
    set((s) => ({ settings: { ...s.settings, camera: { ...s.settings.camera, ...partial } } })),
  setLayout: (layout) => set((s) => ({ settings: { ...s.settings, layout } })),
  // A portrait/square canvas turns "Side by Side" into two razor-thin
  // slivers — nudge to "Split" (screen on top, camera below) instead, the
  // layout built for a vertical mobile-social frame. Only auto-corrects
  // away from that one specific bad combination; every other layout choice
  // is left alone.
  setAspectRatio: (aspectRatio) =>
    set((s) => {
      const portraitish = aspectRatio !== "original" && aspectRatio !== "16:9";
      const layout =
        portraitish && s.settings.layout === "side-by-side" ? "split" : s.settings.layout;
      return { settings: { ...s.settings, aspectRatio, layout } };
    }),
  setScreenFitMode: (screenFitMode) =>
    set((s) => ({ settings: { ...s.settings, screenFitMode } })),
  updateScreenView: (partial) =>
    set((s) => ({ settings: { ...s.settings, screenView: { ...s.settings.screenView, ...partial } } })),
  setQuality: (quality) => set((s) => ({ settings: { ...s.settings, quality } })),
  updateCustomQuality: (partial) =>
    set((s) => ({ settings: { ...s.settings, customQuality: { ...s.settings.customQuality, ...partial } } })),
  setCursorVisible: (visible) =>
    set((s) => ({ settings: { ...s.settings, cursor: { visible } } })),
  updateAudio: (partial) =>
    set((s) => ({ settings: { ...s.settings, audio: { ...s.settings.audio, ...partial } } })),
  setDevices: (devices) => set({ devices }),
  setCapability: (capability) => set({ capability }),
  setError: (error) => set({ error }),
  setResult: (result) => {
    const prev = get().result;
    if (prev?.url) URL.revokeObjectURL(prev.url);
    // A new take invalidates any zoom edits made against the previous one —
    // but immediately seed Smart Camera's own auto keyframes from this
    // take's motion samples (if any) when it's enabled, same as it would be
    // after a manual regenerate, so a recording lands already polished.
    const s = get();
    const auto =
      s.smartCameraEnabled && result?.activitySamples?.length
        ? generateSmartZoomKeyframes(result.activitySamples, result.durationMs, s.smartCameraIntensity)
        : [];
    // Intentional "Mark zoom" triggers apply regardless of the Smart Camera
    // toggle — they're direct user intent, not inferred, so they're tagged
    // source: "manual" and layered on top of whatever auto set (if any) is
    // active.
    const withMarkers = result?.zoomMarkers?.length
      ? resolveZoomMarkers(result.zoomMarkers, result.activitySamples, auto, result.durationMs, s.smartCameraIntensity)
      : auto;
    set({ result, zoomKeyframes: withMarkers });
  },
  addZoomKeyframe: (keyframe) =>
    set((s) => ({ zoomKeyframes: [...s.zoomKeyframes, keyframe].sort((a, b) => a.startMs - b.startMs) })),
  updateZoomKeyframe: (id, partial) =>
    set((s) => ({
      zoomKeyframes: s.zoomKeyframes
        .map((k) => (k.id === id ? { ...k, ...partial } : k))
        .sort((a, b) => a.startMs - b.startMs),
    })),
  removeZoomKeyframe: (id) =>
    set((s) => ({ zoomKeyframes: s.zoomKeyframes.filter((k) => k.id !== id) })),
  setSmartCameraEnabled: (enabled) =>
    set((s) => {
      if (!enabled) {
        // Turning it off just removes what it generated — anything the user
        // added or edited by hand (source !== "auto") stays untouched.
        return { smartCameraEnabled: false, zoomKeyframes: s.zoomKeyframes.filter((k) => k.source !== "auto") };
      }
      const manual = s.zoomKeyframes.filter((k) => k.source !== "auto");
      const auto = s.result?.activitySamples?.length
        ? generateSmartZoomKeyframes(s.result.activitySamples, s.result.durationMs, s.smartCameraIntensity)
        : [];
      return {
        smartCameraEnabled: true,
        zoomKeyframes: [...manual, ...auto].sort((a, b) => a.startMs - b.startMs),
      };
    }),
  setSmartCameraIntensity: (intensity) =>
    set((s) => {
      if (!s.smartCameraEnabled || !s.result?.activitySamples?.length) {
        return { smartCameraIntensity: intensity };
      }
      const manual = s.zoomKeyframes.filter((k) => k.source !== "auto");
      const auto = generateSmartZoomKeyframes(s.result.activitySamples, s.result.durationMs, intensity);
      return {
        smartCameraIntensity: intensity,
        zoomKeyframes: [...manual, ...auto].sort((a, b) => a.startMs - b.startMs),
      };
    }),
  regenerateSmartCamera: () =>
    set((s) => {
      if (!s.result?.activitySamples?.length) return {};
      const manual = s.zoomKeyframes.filter((k) => k.source !== "auto");
      const auto = generateSmartZoomKeyframes(s.result.activitySamples, s.result.durationMs, s.smartCameraIntensity);
      return {
        smartCameraEnabled: true,
        zoomKeyframes: [...manual, ...auto].sort((a, b) => a.startMs - b.startMs),
      };
    }),
  reset: () => {
    const prev = get().result;
    if (prev?.url) URL.revokeObjectURL(prev.url);
    set({
      stage: "select",
      settings: DEFAULT_SETTINGS,
      result: null,
      error: null,
      capability: null,
      zoomKeyframes: [],
      smartCameraEnabled: true,
      smartCameraIntensity: DEFAULT_SMART_CAMERA_INTENSITY,
    });
  },
}));
