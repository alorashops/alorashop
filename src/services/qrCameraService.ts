/**
 * Camera QR scanning (`STEPS.md` S3.2, `D3`).
 *
 * Reads a product's QR with the device camera and hands the decoded string to `onCode`. It is
 * a *new way to obtain a code*; the caller resolves it with the SAME `findProductByBarcode()`
 * and adds it with the SAME `addProductToCart()` the hardware wedge uses.
 *
 * ── SILENT-BUG GUARDS (STEPS.md §5 / §7) ────────────────────────────────────────────────
 *  T2 — a QR held in frame decodes MANY times per second. Without a dedupe window the cart
 *       jumps to 20 units and the cashier only notices at payment. See `QR_DEDUPE_MS`.
 *  T3 — `BarcodeDetector` is missing in Firefox and Safari today. A feature-detect that
 *       silently falls through to nothing is the worst outcome, so `jsQR` is a MANDATORY
 *       fallback and every failure mode has an explicit, distinct message.
 *  Camera light — every track is stopped on `stop()` / tab hide / page hide, so the indicator
 *       light goes OFF and the camera never stays on in the background.
 */
import jsQR from 'jsqr';
import { isPlausibleScanPayload } from '../lib/qr';

export type QrCameraErrorCode =
  | 'permission-denied'
  | 'no-camera'
  | 'insecure-origin'
  | 'unsupported'
  | 'start-failed';

export interface QrCameraError {
  code: QrCameraErrorCode;
  message: string;
}

export interface QrCameraCallbacks {
  /** A plausible SKU was decoded. */
  onCode: (code: string) => void;
  /** The camera could not start / was blocked — `message` is user-facing. */
  onError: (error: QrCameraError) => void;
  /** A decoded string that is not a plausible SKU (e.g. a URL on a printed advert). */
  onInvalid?: (raw: string) => void;
}

export interface QrCameraSession {
  /** Stop the decode loop and release the camera. Safe to call more than once. */
  stop: () => void;
}

/** How long the same decoded code is ignored after it fires (T2 dedupe window). */
export const QR_DEDUPE_MS = 1200;
/** Decode cadence (ms) — ~11 fps keeps older phones cool while still feeling instant. */
const DECODE_INTERVAL_MS = 90;

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | undefined {
  return (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
}

/** Whether the device exposes a camera API at all (independent of permission/secure context). */
export function isSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** Single source of the user-facing message for each failure mode. */
export function cameraErrorMessage(code: QrCameraErrorCode): string {
  switch (code) {
    case 'permission-denied':
      return 'Camera blocked — allow it in the browser, or type the SKU instead.';
    case 'no-camera':
      return 'No camera found — type the SKU instead.';
    case 'insecure-origin':
      return 'The camera needs HTTPS (or localhost) — type the SKU instead.';
    case 'unsupported':
      return 'This browser cannot open the camera — type the SKU instead.';
    case 'start-failed':
      return 'Could not start the camera — type the SKU instead.';
  }
}

/**
 * Start decoding QR codes from `video`'s camera.
 *
 * On failure a distinct `QrCameraError` is delivered and a no-op session is returned, so a
 * caller can render an explicit message (never a black rectangle). The returned `stop()` must
 * be called on unmount — it releases the camera and clears the loop.
 */
export async function start(video: HTMLVideoElement, cb: QrCameraCallbacks): Promise<QrCameraSession> {
  const noop: QrCameraSession = { stop: () => {} };

  // getUserMedia needs a secure context (HTTPS or localhost) — a LAN-IP dev server fails here.
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    cb.onError({ code: 'insecure-origin', message: cameraErrorMessage('insecure-origin') });
    return noop;
  }
  if (!isSupported()) {
    cb.onError({ code: 'unsupported', message: cameraErrorMessage('unsupported') });
    return noop;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    const name = (err as DOMException | undefined)?.name ?? '';
    const code: QrCameraErrorCode =
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'permission-denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError'
          ? 'no-camera'
          : 'start-failed';
    cb.onError({ code, message: cameraErrorMessage(code) });
    return noop;
  }

  // Assign the stream directly — no object URL, so no fetch and no `media-src` CSP directive.
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true'); // iOS: without this the video full-screens
  video.muted = true;
  try {
    await video.play();
  } catch {
    /* autoplay may reject until a gesture; frames still arrive once play() succeeds */
  }

  // Decoder choice (D3): BarcodeDetector only when it really supports qr_code, else jsQR.
  const detectorCtor = getBarcodeDetectorCtor();
  let detector: BarcodeDetectorLike | undefined;
  if (detectorCtor) {
    try {
      const formats = await detectorCtor.getSupportedFormats?.();
      if (!formats || formats.includes('qr_code')) {
        detector = new detectorCtor({ formats: ['qr_code'] });
      }
    } catch {
      detector = undefined;
    }
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stopped = false;
  let decoding = false;
  let lastCode = '';
  let lastAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const handleDecoded = (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    if (!isPlausibleScanPayload(code)) {
      // Not one of ours (a URL/advert) — report, do NOT look it up.
      cb.onInvalid?.(code);
      return;
    }
    const now = Date.now();
    // T2: the same code held in frame decodes repeatedly — fire it once per window.
    if (code === lastCode && now - lastAt < QR_DEDUPE_MS) return;
    lastCode = code;
    lastAt = now;
    cb.onCode(code);
  };

  const tick = async () => {
    if (stopped) return;
    // One decode in flight at a time, and only once the video has real frames.
    if (!decoding && video.readyState >= 2 && video.videoWidth > 0) {
      decoding = true;
      try {
        if (detector) {
          const found = await detector.detect(video);
          if (found && found.length > 0 && found[0].rawValue) handleDecoded(found[0].rawValue);
        } else if (ctx) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
          if (result?.data) handleDecoded(result.data);
        }
      } catch {
        /* transient decode error — keep the loop alive */
      } finally {
        decoding = false;
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), DECODE_INTERVAL_MS);
  };

  const onVisibility = () => {
    if (document.hidden) stop();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', stop);
    for (const track of stream.getTracks()) track.stop(); // turns the camera indicator light OFF
    if (video.srcObject === stream) video.srcObject = null;
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', stop);

  void tick();
  return { stop };
}

