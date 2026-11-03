import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../stores/uiStore';
import { start, type QrCameraError } from '../services/qrCameraService';

/**
 * Inline camera viewfinder for the POS (`STEPS.md` S3.3, `D2`).
 *
 * Mounts a `<video>`, starts the camera through `qrCameraService`, and calls `onScan` with
 * every decoded/typed code. The parent owns the resolve + add (so the camera path and the
 * hardware wedge share `addProductToCart`).
 *
 * `playsInline` is mandatory on iOS or the video full-screens. The error state is ALWAYS
 * rendered as text — never a silent black rectangle (one of the silent-bug traps).
 */
export interface QrScannerPanelProps {
  /** A decoded or manually typed code — the parent resolves + adds + toasts. */
  onScan: (code: string) => void;
  /** Close the panel (unmounts it, which stops the camera). */
  onClose: () => void;
}

export function QrScannerPanel({ onScan, onClose }: QrScannerPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const toast = useUiStore((s) => s.push);
  const [error, setError] = useState<QrCameraError | null>(null);
  const [ready, setReady] = useState(false);
  const [manual, setManual] = useState('');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let session: { stop: () => void } | undefined;
    let cancelled = false;
    let failed = false;

    void (async () => {
      const s = await start(video, {
        onCode: (code) => onScan(code),
        onError: (e) => {
          failed = true;
          if (!cancelled) setError(e);
        },
        onInvalid: (raw) => toast('warn', `Scanned code is not a product code: ${raw.slice(0, 24)}`)
      });
      if (cancelled) {
        s.stop();
        return;
      }
      session = s;
      if (!failed) setReady(true);
    })();

    return () => {
      cancelled = true;
      session?.stop();
    };
    // Start once on mount; onScan/toast are stable enough (store getters) for this panel's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="qr-scanner"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 10,
        marginBottom: 12,
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--card)'
      }}
    >
      <div style={{ position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{ display: error ? 'none' : 'block', width: '100%', maxHeight: 280, objectFit: 'cover' }}
        />
        {!error && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: '20% 28%',
              border: '3px solid rgba(255,255,255,0.85)',
              borderRadius: 10,
              pointerEvents: 'none'
            }}
          />
        )}
      </div>

      {error ? (
        <div className="tag red" style={{ whiteSpace: 'normal' }}>{error.message}</div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {ready ? 'Point the camera at the product’s QR label.' : 'Starting the camera…'}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const code = manual.trim();
          if (!code) return;
          onScan(code);
          setManual('');
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input
          className="input"
          placeholder="…or type the SKU and press Add"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="btn btn-secondary" type="submit">Add</button>
      </form>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" type="button" onClick={onClose}>Stop camera</button>
      </div>
    </div>
  );
}
