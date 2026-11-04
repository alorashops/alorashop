/**
 * Scan feedback — the "did it register?" beep (STEPS.md S4.3 follow-up).
 *
 * WHY: scanning is eyes-free. Until now nothing told the cashier a scan had landed until they
 * looked up at the toast, so the owner scanned a product FOUR times before noticing three of
 * them did nothing. A short POS beep is the fix, and it is the single most-requested thing a
 * "slower than theirs" complaint turns on: the operator must HEAR that the item is in.
 *
 * NO ASSET, NO FETCH: this uses the Web Audio API to synthesise the tone with one oscillator.
 * There is no audio file to ship, nothing to load from the network, so it works fully offline
 * and needs no CSP `media-src`/`default-src` allowance (the same reasoning as the camera's
 * `video.srcObject`). An optional short vibration covers Android hardware.
 *
 * AUTOPLAY POLICY: a browser keeps an `AudioContext` SUSPENDED until the page has seen a user
 * gesture. `unlockAudio()` is therefore called from the first pointerdown/keydown (see POSPage),
 * and every `play()` also tries to resume first — so the very first scan after a tap is audible.
 */

let ctx: AudioContext | undefined;

/** Create (once) and return the shared AudioContext, or `undefined` if the browser lacks it. */
function getCtx(): AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return undefined;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return undefined;
    }
  }
  return ctx;
}

/**
 * Arm the audio context from a user gesture so the FIRST beep is not swallowed by the autoplay
 * policy. Safe to call many times (e.g. on every pointerdown); it only resumes when suspended.
 */
export function unlockAudio(): void {
  const c = getCtx();
  if (c && c.state === 'suspended') void c.resume();
}

/** Play one oscillator note with a short fade-out (the fade avoids an end-of-note click). */
function tone(
  freq: number,
  startOffset: number,
  duration: number,
  gain: number,
  type: OscillatorType
): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') void c.resume(); // best-effort; the gesture was already captured
  const t0 = c.currentTime + startOffset;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  // HOLD the tone flat for most of its length, then a short ~40 ms release. A pure exponential
  // ramp from the very start (the previous shape) faded continuously and sounded like a click;
  // holding first is what makes the success beep read as a steady "piiiiiiii".
  const release = Math.min(0.04, duration / 2);
  g.gain.setValueAtTime(gain, t0);
  g.gain.setValueAtTime(gain, t0 + duration - release);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration);
  osc.onended = () => {
    try {
      g.disconnect();
    } catch {
      /* a detached node is not an error */
    }
  };
}

/** Short vibration where supported (Android Chrome). iOS Safari ignores it — that is fine. */
function vibrate(pattern: number | number[]): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* some browsers throw when no gesture has happened yet */
    }
  }
}

/**
 * SUSTAINED HIGH "PIP" — a product landed in the cart (camera, USB wedge, or a tapped tile).
 *
 * Frequency 2700 Hz sits in the classic 2–4 kHz scanner band (that is exactly the "piiiiiiii"
 * a supermarket scanner makes), and ~450 ms is long enough to read as a steady tone rather than
 * the previous 90 ms blip that was easy to miss. A held 2.7 kHz tone cuts through shop noise far
 * better than a low, short one.
 */
export function playScanSuccess(): void {
  tone(2700, 0, 0.45, 0.12, 'sine');
  vibrate(35);
}

/**
 * DISTINCT LOW DOUBLE-BUZZ — a scan did NOT become a cart line: not found, out of stock, or
 * already at the stock limit. A different, lower, harsher tone so the operator can tell a miss
 * from a hit WITHOUT looking up.
 */
export function playScanError(): void {
  tone(320, 0, 0.14, 0.16, 'square');
  tone(240, 0.16, 0.18, 0.16, 'square');
  vibrate([50, 40, 70]);
}
