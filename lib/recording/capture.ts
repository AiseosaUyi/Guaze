import type { DeviceOption } from "./types";

export class CaptureError extends Error {
  constructor(
    message: string,
    public readonly kind: "permission" | "not-found" | "unsupported" | "unknown"
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

function toCaptureError(err: unknown): CaptureError {
  if (err instanceof CaptureError) return err;
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new CaptureError("Permission was denied.", "permission");
  }
  if (name === "NotFoundError") {
    return new CaptureError("No matching device was found.", "not-found");
  }
  return new CaptureError(
    err instanceof Error ? err.message : "Could not access the device.",
    "unknown"
  );
}

export interface ScreenCaptureOptions {
  width: number;
  height: number;
  fps: number;
  withSystemAudio: boolean;
  withCursor: boolean;
}

/** Requests the screen/window/tab picker. Returns the raw stream — the
 * compositor draws from `video.srcObject`, it never consumes the track. */
export async function getScreenStream(
  opts: ScreenCaptureOptions
): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    throw new CaptureError("Screen capture isn't supported in this browser.", "unsupported");
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: opts.width },
        height: { ideal: opts.height },
        frameRate: { ideal: opts.fps },
      },
      audio: opts.withSystemAudio,
      // Chrome-specific hint; ignored elsewhere.
      // @ts-expect-error non-standard but widely supported in Chrome
      cursor: opts.withCursor ? "always" : "never",
    });
  } catch (err) {
    throw toCaptureError(err);
  }
}

export interface CameraCaptureOptions {
  deviceId?: string | null;
  width: number;
  height: number;
  fps: number;
}

export async function getCameraStream(
  opts: CameraCaptureOptions
): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError("Camera capture isn't supported in this browser.", "unsupported");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        width: { ideal: opts.width },
        height: { ideal: opts.height },
        frameRate: { ideal: opts.fps },
        facingMode: opts.deviceId ? undefined : "user",
      },
    });
  } catch (err) {
    throw toCaptureError(err);
  }
}

export interface MicCaptureOptions {
  deviceId?: string | null;
  noiseReduction: boolean;
}

export async function getMicStream(opts: MicCaptureOptions): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError("Microphone capture isn't supported in this browser.", "unsupported");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: opts.noiseReduction,
        sampleRate: { ideal: 48_000 },
      },
    });
  } catch (err) {
    throw toCaptureError(err);
  }
}

export async function listDevices(
  kind: "videoinput" | "audioinput"
): Promise<DeviceOption[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === kind)
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${i + 1}`,
    }));
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}
