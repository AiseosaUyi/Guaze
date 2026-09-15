export type SourceMode = "screen" | "camera" | "both";

export type BackgroundMode = "none" | "blur" | "image" | "builtin";

export type BlurStrength = "light" | "medium" | "strong";

export interface GradientStop {
  offset: number;
  color: string;
}

export interface BuiltinBackground {
  id: string;
  label: string;
  /** For the picker UI swatch (DOM). */
  css: string;
  /** For the actual composited render (canvas gradient) — kept separate
   * from `css` so the compositor never has to parse a CSS gradient string. */
  angleDeg: number;
  stops: GradientStop[];
}

export type CameraShape = "rectangle" | "rounded" | "circle";

export type CameraPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "custom";

export type CameraSizeToken = "small" | "medium" | "large";

export interface CameraTransform {
  position: CameraPosition;
  /** Normalized 0..1 coordinates, used when position is "custom" (drag). */
  customX: number;
  customY: number;
  size: CameraSizeToken;
  shape: CameraShape;
  cornerRadius: number;
  border: boolean;
  shadow: boolean;
}

export type LayoutPreset =
  | "screen-only"
  | "camera-only"
  | "floating"
  | "pip"
  | "side-by-side"
  | "camera-focus"
  | "split";

export type QualityPresetId =
  | "social"
  | "high"
  | "pro"
  | "ultra"
  | "custom";

export interface QualityPreset {
  id: QualityPresetId;
  label: string;
  description: string;
  width: number;
  height: number;
  fps: 24 | 30 | 60;
  videoBitsPerSecond: number;
}

export type AspectRatioId = "original" | "16:9" | "9:16" | "1:1" | "4:5";

export type ExportFormat = "mp4" | "webm";

export interface RecordingSettings {
  mode: SourceMode;
  layout: LayoutPreset;
  background: {
    mode: BackgroundMode;
    blurStrength: BlurStrength;
    builtinId: string | null;
    imageUrl: string | null;
    imageScale: number;
    imageBrightness: number;
    imageContrast: number;
  };
  camera: CameraTransform;
  quality: QualityPresetId;
  customQuality: Pick<QualityPreset, "width" | "height" | "fps" | "videoBitsPerSecond">;
  cursor: {
    visible: boolean;
  };
  audio: {
    micEnabled: boolean;
    micDeviceId: string | null;
    systemAudioEnabled: boolean;
    noiseReduction: boolean;
  };
}

/** A timestamped change to the composition, captured during recording so a
 * future editor can re-render the take with the same layout changes without
 * asking the user to re-record. Timestamps are ms from recording start. */
export interface CompositionEvent {
  atMs: number;
  type: "layout" | "background" | "camera";
  settings: Partial<RecordingSettings>;
}

export type Stage = "select" | "setup" | "recording" | "review";

export interface DeviceOption {
  deviceId: string;
  label: string;
}
