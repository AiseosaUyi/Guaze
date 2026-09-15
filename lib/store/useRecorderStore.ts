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

export const DEFAULT_SETTINGS: RecordingSettings = {
  mode: "both",
  layout: "floating",
  frame: {
    enabled: false,
    padding: 8,
    cornerRadius: 20,
    shadow: true,
    backdropId: "soft-gradient",
  },
  background: {
    mode: "none",
    blurStrength: "medium",
    builtinId: null,
    imageUrl: null,
    imageScale: 1,
    imageBrightness: 1,
    imageContrast: 1,
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
}

interface RecorderStore {
  stage: Stage;
  settings: RecordingSettings;
  devices: { cameras: DeviceOption[]; mics: DeviceOption[] };
  capability: CapabilityReport | null;
  error: string | null;
  result: RecordingResultState | null;
  zoomKeyframes: ZoomKeyframe[];

  setStage: (stage: Stage) => void;
  chooseMode: (mode: SourceMode) => void;
  updateFrame: (partial: Partial<RecordingSettings["frame"]>) => void;
  updateBackground: (partial: Partial<RecordingSettings["background"]>) => void;
  updateCamera: (partial: Partial<RecordingSettings["camera"]>) => void;
  setLayout: (layout: RecordingSettings["layout"]) => void;
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

  setStage: (stage) => set({ stage }),
  chooseMode: (mode) =>
    set((s) => ({ settings: { ...s.settings, mode }, stage: "setup" })),
  updateFrame: (partial) =>
    set((s) => ({ settings: { ...s.settings, frame: { ...s.settings.frame, ...partial } } })),
  updateBackground: (partial) =>
    set((s) => ({ settings: { ...s.settings, background: { ...s.settings.background, ...partial } } })),
  updateCamera: (partial) =>
    set((s) => ({ settings: { ...s.settings, camera: { ...s.settings.camera, ...partial } } })),
  setLayout: (layout) => set((s) => ({ settings: { ...s.settings, layout } })),
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
    // A new take invalidates any zoom edits made against the previous one.
    set({ result, zoomKeyframes: [] });
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
    });
  },
}));
