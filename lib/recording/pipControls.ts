/**
 * A tiny always-on-top control bar for marking a zoom moment (and stopping
 * the take) while the tab that owns this recorder does NOT have keyboard
 * or mouse focus — the normal case, since the entire point of screen
 * sharing is that some other window or app has focus while you use it. An
 * in-page button or keyboard shortcut simply cannot receive that click or
 * keypress in that situation.
 *
 * Chrome's Document Picture-in-Picture API is the one way a plain web page
 * can put a real, independently-focusable, always-on-top window on screen
 * that stays clickable regardless of what else has focus. Feature-detected
 * and optional — recording works exactly as before wherever it isn't
 * available (Safari, older Chrome); see the in-tab "Mark zoom" button in
 * RecordingHUD.tsx for the fallback when this can't open.
 *
 * Real, unavoidable tradeoff: if the take captures the *entire screen*
 * rather than a specific window/tab, this floating window is itself an
 * on-screen window and may end up visible in the recording. Scoped to a
 * specific app/window, it won't be.
 *
 * Built with plain DOM, not React — this is a handful of static buttons in
 * a separate same-origin `Window`, and manual createElement/addEventListener
 * is far simpler and more robust here than a cross-document React portal
 * for something this small.
 */

export interface PipControlsHandlers {
  onMarkZoom: () => void;
  onStop: () => void;
}

export interface PipControlsHandle {
  close: () => void;
  /** Briefly confirms a mark was registered — there's no other feedback
   * channel visible while some other window has focus. */
  flashMarked: () => void;
}

interface DocumentPictureInPictureApi {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
}

function getDocumentPip(): DocumentPictureInPictureApi | null {
  if (typeof window === "undefined") return null;
  return (
    (window as unknown as { documentPictureInPicture?: DocumentPictureInPictureApi }).documentPictureInPicture ?? null
  );
}

export function isPipControlsSupported(): boolean {
  return getDocumentPip() !== null;
}

/** Opens the floating control window. Must be called from inside a
 * user-gesture handler (e.g. the "Start Recording" click) with no prior
 * `await` that could let the browser's transient-activation window expire —
 * requestWindow() requires one. Resolves to null (never throws) if the API
 * isn't available or the request is refused for any reason, so a caller can
 * always fall back to the in-tab button without extra error handling. */
export async function openPipControls(handlers: PipControlsHandlers): Promise<PipControlsHandle | null> {
  const pip = getDocumentPip();
  if (!pip) return null;

  let pipWindow: Window;
  try {
    pipWindow = await pip.requestWindow({ width: 280, height: 64 });
  } catch {
    return null;
  }

  const doc = pipWindow.document;
  doc.title = "Recording controls";
  const style = doc.createElement("style");
  style.textContent = `
    :root { color-scheme: dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #18181b; }
    .bar { display: flex; align-items: center; gap: 10px; height: 100%; padding: 0 12px; box-sizing: border-box; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; animation: pulse 1.4s ease-in-out infinite; flex: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
    button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; height: 40px; border-radius: 999px; border: 1px solid #3f3f46; background: #27272a; color: #f4f4f5; font-size: 13px; font-weight: 500; cursor: pointer; }
    button:hover { background: #3f3f46; }
    button:active { transform: scale(.97); }
    .stop { background: #ef4444; border-color: #ef4444; color: #fff; flex: none; width: 40px; padding: 0; }
    .stop:hover { background: #dc2626; }
    .mark.flash { background: #4f46e5; border-color: #4f46e5; }
  `;
  doc.head.appendChild(style);

  const bar = doc.createElement("div");
  bar.className = "bar";

  const dot = doc.createElement("div");
  dot.className = "dot";
  bar.appendChild(dot);

  const markBtn = doc.createElement("button");
  markBtn.className = "mark";
  markBtn.textContent = "✨ Mark zoom";
  markBtn.addEventListener("click", () => handlers.onMarkZoom());
  bar.appendChild(markBtn);

  const stopBtn = doc.createElement("button");
  stopBtn.className = "stop";
  stopBtn.textContent = "■";
  stopBtn.title = "Stop recording";
  stopBtn.addEventListener("click", () => handlers.onStop());
  bar.appendChild(stopBtn);

  doc.body.appendChild(bar);

  const defaultLabel = markBtn.textContent;
  let flashTimeout: number | null = null;

  return {
    close: () => {
      if (flashTimeout !== null) pipWindow.clearTimeout(flashTimeout);
      try {
        pipWindow.close();
      } catch {
        // Already closed (e.g. the user closed it manually) — fine.
      }
    },
    flashMarked: () => {
      markBtn.classList.add("flash");
      markBtn.textContent = "✓ Marked";
      if (flashTimeout !== null) pipWindow.clearTimeout(flashTimeout);
      flashTimeout = pipWindow.setTimeout(() => {
        markBtn.classList.remove("flash");
        markBtn.textContent = defaultLabel;
      }, 700);
    },
  };
}
