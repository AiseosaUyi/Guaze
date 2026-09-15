"use client";

import { Monitor, Camera, Layers } from "lucide-react";
import { useRecorderStore } from "@/lib/store/useRecorderStore";
import type { SourceMode } from "@/lib/recording/types";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { cn } from "@/lib/utils";

const MODES: {
  id: SourceMode;
  title: string;
  description: string;
  icon: typeof Monitor;
}[] = [
  {
    id: "screen",
    title: "Screen",
    description: "Record your display, a window, or a browser tab.",
    icon: Monitor,
  },
  {
    id: "camera",
    title: "Camera",
    description: "Talking-head, with your background replaced or blurred.",
    icon: Camera,
  },
  {
    id: "both",
    title: "Screen + Camera",
    description: "Your screen with a camera bubble on top.",
    icon: Layers,
  },
];

export function ModeSelectScreen() {
  const chooseMode = useRecorderStore((s) => s.chooseMode);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent">
            <span className="h-2.5 w-2.5 rounded-full border-2 border-accent-foreground" />
          </span>
          <span className="text-sm font-medium text-foreground">
            Social Screen Recorder
          </span>
        </span>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-10 px-6 pb-20">
        <div className="text-center">
          <h1 className="text-2xl font-semibold sm:text-3xl">
            What are you recording today?
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Everything stays on this device. No account, no upload.
          </p>
        </div>

        <div className="grid w-full max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
          {MODES.map(({ id, title, description, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => chooseMode(id)}
              className={cn(
                "group flex flex-col items-start gap-4 rounded-xl border border-border bg-surface-raised p-6 text-left transition-all",
                "hover:border-accent hover:shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-foreground transition-colors group-hover:bg-accent group-hover:text-accent-foreground">
                <Icon className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <span>
                <span className="block text-base font-medium">{title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {description}
                </span>
              </span>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
