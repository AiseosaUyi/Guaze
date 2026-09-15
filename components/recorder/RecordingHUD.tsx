"use client";

import { Pause, Play, Square } from "lucide-react";
import { formatDuration } from "@/lib/utils";

export function RecordingHUD({
  elapsedMs,
  paused,
  onPause,
  onResume,
  onStop,
}: {
  elapsedMs: number;
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-surface/80 px-4 py-2 shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)] backdrop-blur">
        <span className="flex items-center gap-2 pl-1 text-sm font-medium tabular-nums">
          <span
            className={`h-2 w-2 rounded-full bg-danger ${paused ? "" : "animate-pulse"}`}
            aria-hidden
          />
          {formatDuration(elapsedMs)}
        </span>
        <div className="h-4 w-px bg-border" />
        <button
          type="button"
          onClick={paused ? onResume : onPause}
          aria-label={paused ? "Resume" : "Pause"}
          className="flex h-8 w-8 items-center justify-center rounded-full text-foreground hover:bg-surface"
        >
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-danger text-danger-foreground hover:opacity-90"
        >
          <Square className="h-3.5 w-3.5" fill="currentColor" />
        </button>
      </div>
    </div>
  );
}
