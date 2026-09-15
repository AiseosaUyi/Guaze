import type { QualityPresetId } from "./types";
import { QUALITY_FALLBACK_LADDER, QUALITY_PRESETS } from "./presets";

export interface CapabilityReport {
  recommended: QualityPresetId;
  /** True if the requested preset is probably too demanding for this device. */
  downgraded: boolean;
  reason?: string;
}

/** Cheap, synchronous-ish heuristic — not a benchmark. Real per-model
 * segmentation benchmarking (PRD §26) is a Phase 1 item once there's more
 * than one model to compare; this just keeps V1 from picking a preset the
 * device clearly can't sustain. */
export function assessDeviceCapability(): { cores: number; roughTier: "low" | "mid" | "high" } {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  const roughTier = cores >= 10 ? "high" : cores >= 6 ? "mid" : "low";
  return { cores, roughTier };
}

export function recommendQuality(
  requested: QualityPresetId,
  segmentationActive: boolean
): CapabilityReport {
  if (requested === "custom") {
    return { recommended: "custom", downgraded: false };
  }
  const { roughTier } = assessDeviceCapability();
  const ceiling: QualityPresetId =
    roughTier === "high" ? "ultra" : roughTier === "mid" ? "pro" : "high";

  const ladderIndexRequested = QUALITY_FALLBACK_LADDER.indexOf(requested);
  const ladderIndexCeiling = QUALITY_FALLBACK_LADDER.indexOf(ceiling);

  // Segmentation adds real per-frame cost; be one notch more conservative
  // while it's on, per the PRD's "4K+60fps+AI background" fallback note.
  const penalty = segmentationActive ? 1 : 0;
  const effectiveCeilingIndex = Math.min(
    QUALITY_FALLBACK_LADDER.length - 1,
    ladderIndexCeiling + penalty
  );

  if (ladderIndexRequested >= effectiveCeilingIndex) {
    return { recommended: requested, downgraded: false };
  }

  const recommended = QUALITY_FALLBACK_LADDER[effectiveCeilingIndex];
  const preset = QUALITY_PRESETS[recommended as Exclude<QualityPresetId, "custom">];
  return {
    recommended,
    downgraded: true,
    reason: `Your device may struggle with the selected preset. Falling back to ${preset.label} (${preset.width}x${preset.height} @ ${preset.fps}fps).`,
  };
}
