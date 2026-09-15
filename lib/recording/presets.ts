import type {
  AspectRatioId,
  BuiltinBackground,
  QualityPreset,
  QualityPresetId,
} from "./types";

export const QUALITY_PRESETS: Record<Exclude<QualityPresetId, "custom">, QualityPreset> = {
  social: {
    id: "social",
    label: "Social",
    description: "1080p / 30fps — optimized file size",
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitsPerSecond: 6_000_000,
  },
  high: {
    id: "high",
    label: "High",
    description: "1080p / 60fps — higher bitrate",
    width: 1920,
    height: 1080,
    fps: 60,
    videoBitsPerSecond: 10_000_000,
  },
  pro: {
    id: "pro",
    label: "Pro",
    description: "1440p / 60fps — high bitrate",
    width: 2560,
    height: 1440,
    fps: 60,
    videoBitsPerSecond: 16_000_000,
  },
  ultra: {
    id: "ultra",
    label: "Ultra",
    description: "4K / 60fps — maximum available quality",
    width: 3840,
    height: 2160,
    fps: 60,
    videoBitsPerSecond: 32_000_000,
  },
};

export function resolveQualityDims(
  quality: QualityPresetId,
  customQuality: Pick<QualityPreset, "width" | "height" | "fps" | "videoBitsPerSecond">
): Pick<QualityPreset, "width" | "height" | "fps" | "videoBitsPerSecond"> {
  if (quality === "custom") return customQuality;
  return QUALITY_PRESETS[quality];
}

/** Adapts a quality preset's target pixel budget to the actual aspect ratio
 * of the captured screen, so the live recording canvas never has to
 * letterbox/pillarbox a display that isn't 16:9 (MacBook panels are 16:10,
 * ultrawides are 21:9, some external monitors are 4:3, etc). Keeps the
 * preset's total pixel count roughly constant so encoded detail/bitrate
 * still matches the label (e.g. "1080p"). Falls back to the preset's own
 * (16:9) dims when no screen aspect is known yet — camera-only mode, or
 * before the screen picker has resolved. */
export function computeEffectiveDims(
  quality: Pick<QualityPreset, "width" | "height">,
  screenAspect: number | null
): { width: number; height: number } {
  if (!screenAspect) return { width: quality.width, height: quality.height };
  const area = quality.width * quality.height;
  let height = Math.round(Math.sqrt(area / screenAspect));
  let width = Math.round(height * screenAspect);
  // Even dimensions avoid chroma-subsampling edge cases in some encoders.
  height -= height % 2;
  width -= width % 2;
  return { width, height };
}

export const QUALITY_PRESET_ORDER: QualityPresetId[] = [
  "social",
  "high",
  "pro",
  "ultra",
  "custom",
];

/** Fallback ladder used by the performance probe when the chosen preset is
 * too demanding for the device. Ordered from most to least demanding. */
export const QUALITY_FALLBACK_LADDER: Exclude<QualityPresetId, "custom">[] = [
  "ultra",
  "pro",
  "high",
  "social",
];

export const ASPECT_RATIOS: Record<AspectRatioId, { label: string; ratio: number | null }> = {
  original: { label: "Original", ratio: null },
  "16:9": { label: "16:9", ratio: 16 / 9 },
  "9:16": { label: "9:16", ratio: 9 / 16 },
  "1:1": { label: "1:1", ratio: 1 },
  "4:5": { label: "4:5", ratio: 4 / 5 },
};

/** A small, tasteful set — per the PRD, quality over quantity. Implemented as
 * CSS so the foundation ships with zero binary asset dependencies; swap in
 * photography later without touching the compositor. */
export const BUILTIN_BACKGROUNDS: BuiltinBackground[] = [
  {
    id: "minimal-studio",
    label: "Minimal Studio",
    css: "linear-gradient(160deg, #e8e6e1 0%, #cfcac2 100%)",
    angleDeg: 160,
    stops: [
      { offset: 0, color: "#e8e6e1" },
      { offset: 1, color: "#cfcac2" },
    ],
  },
  {
    id: "dark-studio",
    label: "Dark Studio",
    css: "linear-gradient(160deg, #1c1c1e 0%, #0a0a0b 100%)",
    angleDeg: 160,
    stops: [
      { offset: 0, color: "#1c1c1e" },
      { offset: 1, color: "#0a0a0b" },
    ],
  },
  {
    id: "modern-office",
    label: "Modern Office",
    css: "linear-gradient(160deg, #d9dee3 0%, #aeb8c2 55%, #8d99a6 100%)",
    angleDeg: 160,
    stops: [
      { offset: 0, color: "#d9dee3" },
      { offset: 0.55, color: "#aeb8c2" },
      { offset: 1, color: "#8d99a6" },
    ],
  },
  {
    id: "soft-gradient",
    label: "Soft Gradient",
    css: "linear-gradient(135deg, #a78bfa 0%, #60a5fa 50%, #34d399 100%)",
    angleDeg: 135,
    stops: [
      { offset: 0, color: "#a78bfa" },
      { offset: 0.5, color: "#60a5fa" },
      { offset: 1, color: "#34d399" },
    ],
  },
  {
    id: "neutral-wall",
    label: "Neutral Wall",
    css: "linear-gradient(160deg, #f3f1ec 0%, #ded9cf 100%)",
    angleDeg: 160,
    stops: [
      { offset: 0, color: "#f3f1ec" },
      { offset: 1, color: "#ded9cf" },
    ],
  },
  {
    id: "creator-setup",
    label: "Creator Setup",
    css: "linear-gradient(160deg, #2a1f3d 0%, #1a1025 60%, #0d0712 100%)",
    angleDeg: 160,
    stops: [
      { offset: 0, color: "#2a1f3d" },
      { offset: 0.6, color: "#1a1025" },
      { offset: 1, color: "#0d0712" },
    ],
  },
];

export interface DestinationExportPreset {
  id: string;
  label: string;
  aspect: AspectRatioId[];
  resolution: string;
}

export const DESTINATION_PRESETS: DestinationExportPreset[] = [
  { id: "x", label: "X / Twitter", aspect: ["16:9", "1:1"], resolution: "1080p" },
  { id: "linkedin", label: "LinkedIn", aspect: ["16:9"], resolution: "1080p" },
  { id: "tiktok", label: "TikTok", aspect: ["9:16"], resolution: "1080p" },
  { id: "reels", label: "Instagram Reels", aspect: ["9:16"], resolution: "1080p" },
  { id: "youtube", label: "YouTube", aspect: ["16:9"], resolution: "1080p / 1440p / 4K" },
  { id: "shorts", label: "YouTube Shorts", aspect: ["9:16"], resolution: "1080p" },
];
