"use client";

import * as React from "react";
import { Plus, RefreshCw, RotateCcw, Sparkles, Trash2, ZoomIn } from "lucide-react";
import { useRecorderStore } from "@/lib/store/useRecorderStore";
import type { ZoomKeyframe } from "@/lib/recording/types";
import { findZoomGapAt, zoomFactorForIntensity } from "@/lib/recording/smartCamera";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn, formatDuration } from "@/lib/utils";

export const MIN_KEYFRAME_MS = 400;
const DEFAULT_HOLD_MS = 2000;
const DEFAULT_RECT = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
const MIN_RECT_SIZE = 0.08;

function makeId() {
  return `zoom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Same centered-square sizing Smart Camera itself uses at a given
 * intensity — what "Reset" on a keyframe puts it back to. */
function defaultRectForIntensity(intensity: number): ZoomKeyframe["rect"] {
  const size = 1 / zoomFactorForIntensity(intensity);
  const offset = (1 - size) / 2;
  return { x: offset, y: offset, w: size, h: size };
}

/** The draggable/resizable rectangle for the currently selected keyframe,
 * rendered as an absolutely-positioned sibling of the <video> inside its
 * `relative` wrapper. The video here renders with no internal letterboxing
 * (its CSS only constrains width/max-height, so its box always matches its
 * own aspect ratio) — so the video's bounding rect maps directly to
 * normalized 0..1 video space with no extra letterbox math. */
export function ZoomRegionOverlay({
  videoRef,
  keyframe,
  onChange,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  keyframe: ZoomKeyframe;
  onChange: (rect: ZoomKeyframe["rect"]) => void;
}) {
  const drag = React.useRef<{
    mode: "move" | "nw" | "ne" | "sw" | "se";
    startClientX: number;
    startClientY: number;
    rect: ZoomKeyframe["rect"];
  } | null>(null);

  function onPointerDown(e: React.PointerEvent, mode: "move" | "nw" | "ne" | "sw" | "se") {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, startClientX: e.clientX, startClientY: e.clientY, rect: keyframe.rect };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const video = videoRef.current;
    if (!d || !video) return;
    const box = video.getBoundingClientRect();
    const dx = (e.clientX - d.startClientX) / box.width;
    const dy = (e.clientY - d.startClientY) / box.height;
    let { x, y, w, h } = d.rect;

    if (d.mode === "move") {
      x = d.rect.x + dx;
      y = d.rect.y + dy;
    } else {
      if (d.mode.includes("w")) {
        x = d.rect.x + dx;
        w = d.rect.w - dx;
      }
      if (d.mode.includes("e")) {
        w = d.rect.w + dx;
      }
      if (d.mode.includes("n")) {
        y = d.rect.y + dy;
        h = d.rect.h - dy;
      }
      if (d.mode.includes("s")) {
        h = d.rect.h + dy;
      }
      w = Math.max(MIN_RECT_SIZE, w);
      h = Math.max(MIN_RECT_SIZE, h);
    }
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    onChange({ x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) });
  }

  function onPointerUp() {
    drag.current = null;
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        onPointerDown={(e) => onPointerDown(e, "move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="pointer-events-auto absolute cursor-move border-2 border-accent bg-accent/10"
        style={{
          left: `${keyframe.rect.x * 100}%`,
          top: `${keyframe.rect.y * 100}%`,
          width: `${keyframe.rect.w * 100}%`,
          height: `${keyframe.rect.h * 100}%`,
        }}
      >
        {(["nw", "ne", "sw", "se"] as const).map((corner) => (
          <div
            key={corner}
            onPointerDown={(e) => onPointerDown(e, corner)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className={cn(
              "absolute h-3.5 w-3.5 rounded-full border-2 border-accent bg-background",
              corner === "nw" && "-left-1.5 -top-1.5 cursor-nwse-resize",
              corner === "ne" && "-right-1.5 -top-1.5 cursor-nesw-resize",
              corner === "sw" && "-left-1.5 -bottom-1.5 cursor-nesw-resize",
              corner === "se" && "-right-1.5 -bottom-1.5 cursor-nwse-resize"
            )}
          />
        ))}
      </div>
    </div>
  );
}

/** The "Add zoom" button + timeline track of zoom keyframes, rendered below
 * the video preview. Selecting a keyframe here is what makes
 * `ZoomRegionOverlay` show its editable rectangle. */
export function ZoomTimeline({
  videoRef,
  durationMs,
  selectedId,
  onSelect,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  durationMs: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const zoomKeyframes = useRecorderStore((s) => s.zoomKeyframes);
  const addZoomKeyframe = useRecorderStore((s) => s.addZoomKeyframe);
  const updateZoomKeyframe = useRecorderStore((s) => s.updateZoomKeyframe);
  const removeZoomKeyframe = useRecorderStore((s) => s.removeZoomKeyframe);
  const smartCameraIntensity = useRecorderStore((s) => s.smartCameraIntensity);

  const [playheadMs, setPlayheadMs] = React.useState(0);
  const timelineRef = React.useRef<HTMLDivElement | null>(null);
  const selected = zoomKeyframes.find((k) => k.id === selectedId) ?? null;

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => setPlayheadMs(video.currentTime * 1000);
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoRef]);

  function selectKeyframe(kf: ZoomKeyframe) {
    onSelect(kf.id);
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = kf.startMs / 1000;
    }
  }

  const playheadGap = findZoomGapAt(zoomKeyframes, durationMs, playheadMs);
  const canAddAtPlayhead = !!playheadGap && playheadGap.end - playheadGap.start >= MIN_KEYFRAME_MS;

  function handleAddZoom() {
    const video = videoRef.current;
    const atMs = video ? video.currentTime * 1000 : 0;
    const gap = findZoomGapAt(zoomKeyframes, durationMs, atMs);
    if (!gap || gap.end - gap.start < MIN_KEYFRAME_MS) return;
    const startMs = atMs;
    const endMs = Math.min(gap.end, startMs + DEFAULT_HOLD_MS);
    const id = makeId();
    addZoomKeyframe({ id, startMs, endMs, rect: DEFAULT_RECT, source: "manual" });
    onSelect(id);
    video?.pause();
  }

  const drag = React.useRef<{
    id: string;
    mode: "move" | "resize-left" | "resize-right";
    startClientX: number;
    startMs: number;
    endMs: number;
  } | null>(null);

  function onTimelinePointerDown(e: React.PointerEvent, kf: ZoomKeyframe, mode: "move" | "resize-left" | "resize-right") {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { id: kf.id, mode, startClientX: e.clientX, startMs: kf.startMs, endMs: kf.endMs };
    selectKeyframe(kf);
  }

  function onTimelinePointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const el = timelineRef.current;
    if (!d || !el) return;
    const rect = el.getBoundingClientRect();
    const deltaMs = ((e.clientX - d.startClientX) / rect.width) * durationMs;

    const others = zoomKeyframes.filter((k) => k.id !== d.id);
    const prevEnd = Math.max(0, ...others.filter((n) => n.endMs <= d.startMs).map((n) => n.endMs));
    const nextStart = Math.min(durationMs, ...others.filter((n) => n.startMs >= d.endMs).map((n) => n.startMs));

    if (d.mode === "move") {
      const length = d.endMs - d.startMs;
      const newStart = Math.max(prevEnd, Math.min(nextStart - length, d.startMs + deltaMs));
      updateZoomKeyframe(d.id, { startMs: newStart, endMs: newStart + length, source: "manual" });
    } else if (d.mode === "resize-left") {
      const newStart = Math.max(prevEnd, Math.min(d.endMs - MIN_KEYFRAME_MS, d.startMs + deltaMs));
      updateZoomKeyframe(d.id, { startMs: newStart, source: "manual" });
    } else {
      const newEnd = Math.min(nextStart, Math.max(d.startMs + MIN_KEYFRAME_MS, d.endMs + deltaMs));
      updateZoomKeyframe(d.id, { endMs: newEnd, source: "manual" });
    }
  }

  function onTimelinePointerUp() {
    drag.current = null;
  }

  function seekFromClientX(clientX: number) {
    const el = timelineRef.current;
    const video = videoRef.current;
    if (!el || !video || durationMs <= 0) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = (frac * durationMs) / 1000;
  }

  return (
    <div className="w-full max-w-3xl space-y-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ZoomIn className="h-3.5 w-3.5" /> Zoom
        </span>
        <Button size="sm" variant="secondary" onClick={handleAddZoom} disabled={!canAddAtPlayhead}>
          <Plus /> Add zoom at playhead
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {selected
          ? "Drag the highlighted box on the video above to move it, drag a corner to resize it, and drag its block below to change when it happens."
          : zoomKeyframes.length === 0
            ? "Play or scrub the video to the moment you want to punch in on, then click “Add zoom at playhead.” It adds a zoomed-in segment there that you can then drag to reposition and resize."
            : "Click a segment below to select it and edit its position, size, or timing."}
      </p>

      <div
        ref={timelineRef}
        onPointerMove={onTimelinePointerMove}
        onPointerUp={onTimelinePointerUp}
        onClick={(e) => seekFromClientX(e.clientX)}
        className="relative h-9 w-full cursor-pointer rounded-md border border-border bg-surface"
      >
        {zoomKeyframes.map((kf) => (
          <div
            key={kf.id}
            onPointerDown={(e) => onTimelinePointerDown(e, kf, "move")}
            onPointerMove={onTimelinePointerMove}
            onPointerUp={onTimelinePointerUp}
            onClick={(e) => e.stopPropagation()}
            title={kf.source === "auto" ? "Smart Camera" : "Manual zoom"}
            className={cn(
              "absolute top-1 bottom-1 cursor-grab rounded border transition-colors",
              kf.id === selectedId
                ? "border-accent bg-accent/70"
                : kf.source === "auto"
                  ? "border-accent/30 bg-accent/20 hover:bg-accent/30"
                  : "border-accent/40 bg-accent/30 hover:bg-accent/40"
            )}
            style={{
              left: durationMs > 0 ? `${(kf.startMs / durationMs) * 100}%` : "0%",
              width: durationMs > 0 ? `${((kf.endMs - kf.startMs) / durationMs) * 100}%` : "0%",
            }}
          >
            <div
              onPointerDown={(e) => onTimelinePointerDown(e, kf, "resize-left")}
              onPointerMove={onTimelinePointerMove}
              onPointerUp={onTimelinePointerUp}
              className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize"
            />
            <div
              onPointerDown={(e) => onTimelinePointerDown(e, kf, "resize-right")}
              onPointerMove={onTimelinePointerMove}
              onPointerUp={onTimelinePointerUp}
              className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize"
            />
          </div>
        ))}
        {durationMs > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-foreground/60"
            style={{ left: `${(playheadMs / durationMs) * 100}%` }}
          />
        )}
      </div>

      {selected && (
        <div className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            {selected.source === "auto" && (
              <span title="Placed by Smart Camera" className="flex items-center gap-1 text-accent">
                <Sparkles className="h-3 w-3" />
              </span>
            )}
            {formatDuration(selected.startMs)} – {formatDuration(selected.endMs)}
          </span>
          <span className="flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                updateZoomKeyframe(selected.id, {
                  rect: defaultRectForIntensity(smartCameraIntensity),
                  source: "manual",
                })
              }
              className="flex items-center gap-1 hover:text-foreground"
              title="Reset position and zoom amount"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </button>
            <button
              type="button"
              onClick={() => {
                removeZoomKeyframe(selected.id);
                onSelect(null);
              }}
              className="flex items-center gap-1 text-danger hover:opacity-80"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/** Global Smart Camera controls — on/off + intensity + a manual re-run.
 * Rendered above `ZoomTimeline`, whose auto-detected blocks (Sparkles-marked
 * in the selected-keyframe bar above) this panel's toggle/slider populate or
 * clear. Disabled entirely when the take has no screen motion samples to
 * work with (camera-only recordings). */
export function SmartCameraPanel({ hasActivity }: { hasActivity: boolean }) {
  const enabled = useRecorderStore((s) => s.smartCameraEnabled);
  const intensity = useRecorderStore((s) => s.smartCameraIntensity);
  const setEnabled = useRecorderStore((s) => s.setSmartCameraEnabled);
  const setIntensity = useRecorderStore((s) => s.setSmartCameraIntensity);
  const regenerate = useRecorderStore((s) => s.regenerateSmartCamera);
  const autoCount = useRecorderStore((s) => s.zoomKeyframes.filter((k) => k.source === "auto").length);

  return (
    <div className="w-full max-w-3xl space-y-3 rounded-md border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-accent" />
          <div>
            <Label htmlFor="smart-camera">Smart Camera</Label>
            <p className="text-[11px] text-muted-foreground">
              {hasActivity
                ? "Automatically zooms and pans to follow clicks and typing — scrolling stays smooth and steady."
                : "No screen activity was recorded in this take, so there's nothing to detect."}
            </p>
          </div>
        </div>
        <Switch
          id="smart-camera"
          checked={enabled}
          disabled={!hasActivity}
          onCheckedChange={setEnabled}
        />
      </div>

      {enabled && hasActivity && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between">
            <Label>Movement intensity</Label>
            <button
              type="button"
              onClick={() => regenerate()}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              title="Re-run detection (keeps any zooms you've hand-edited)"
            >
              <RefreshCw className="h-3 w-3" /> Regenerate
            </button>
          </div>
          <Slider
            value={[intensity]}
            min={0}
            max={1}
            step={0.05}
            onValueChange={([v]) => setIntensity(v)}
          />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Subtle</span>
            <span>{autoCount} auto {autoCount === 1 ? "zoom" : "zooms"}</span>
            <span>Bold</span>
          </div>
        </div>
      )}
    </div>
  );
}
