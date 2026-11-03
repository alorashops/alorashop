import { forwardRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  buildQrPayload,
  qrLabelTitle,
  qrLabelSize,
  DEFAULT_QR_LABEL_SIZE,
  type QrLabelSize
} from '../lib/qr';

/**
 * A printable QR label (`STEPS.md` Phase 2, S2.3).
 *
 * ── TRAP T1 (`STEPS.md` §5) — DO NOT render the QR through an <img> ─────────────────────
 * `csp-policy.ts` is `img-src 'self'`, and dev has no CSP at all. `toDataURL()` fed into
 * `<img src={...}>` renders perfectly under `npm run dev` and shows a BROKEN image on the
 * deployed site — a production-only silent bug. The code is therefore drawn as inline SVG
 * (`QRCodeSVG`). Never `toDataURL`, never a `data:` URL, never `<img>`.
 *
 * ── TRAP — the dark theme must not follow the label ────────────────────────────────────
 * A QR needs black-on-white contrast, so the label forces a white background and black ink
 * inline. A theme change can then never make a printed code unscannable.
 *
 * The digits under the code are the PAYLOAD (the trimmed SKU), so a torn or undecodable label
 * can still be typed into search or the scanner's manual field (fallback).
 */

/**
 * Fixed physical sizing lives in `src/lib/qr.ts` (`QR_LABEL_SIZES`) — the preview, the print
 * sheet and the guard all read those numbers, so they cannot drift. Two sizes are offered:
 * `small` = 38×21 mm (default) and `large` = 50×30 mm.
 */

export interface ProductQrLabelProps {
  /** Shop name shown in small print at the top of the label. */
  shopName: string;
  /** Product name (truncated by `qrLabelTitle`). */
  name: string;
  /** The SKU — becomes the QR payload AND the human-readable digits under it. */
  sku: string;
  /** Label size — `small` (38×21 mm, default) or `large` (50×30 mm). */
  size?: QrLabelSize;
}

/**
 * The label. Exposes its root `div` via `ref` so the print service can deep-clone the exact
 * rendered node into the print sheet (so preview === paper, and no markup string is built).
 */
export const ProductQrLabel = forwardRef<HTMLDivElement, ProductQrLabelProps>(
  function ProductQrLabel({ shopName, name, sku, size = DEFAULT_QR_LABEL_SIZE }, ref) {
    // The ONE derivation of the payload (D1) — the preview and the print sheet share it.
    const payload = buildQrPayload({ sku });
    // Geometry from the size table (single source of truth for both sizes).
    const geo = qrLabelSize(size);
    return (
      <div
        ref={ref}
        className="qr-label"
        style={{
          width: `${geo.widthMm}mm`,
          height: `${geo.heightMm}mm`,
          background: '#ffffff',
          color: '#000000',
          display: 'flex',
          gap: '1mm',
          padding: '1mm',
          boxSizing: 'border-box',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          overflow: 'hidden'
        }}
      >
        {/* Inline SVG — never an <img>/data: URL (see T1). marginSize reserves the quiet zone. */}
        <QRCodeSVG
          value={payload}
          size={geo.qrPx}
          level="M"
          marginSize={4}
          bgColor="#ffffff"
          fgColor="#000000"
          title={`QR for SKU ${payload}`}
          style={{ flex: '0 0 auto' }}
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            minWidth: 0,
            lineHeight: 1.05
          }}
        >
          <div
            style={{
              fontSize: '4.6pt',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {shopName}
          </div>
          <div
            style={{
              fontSize: '6.4pt',
              fontWeight: 800,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}
          >
            {qrLabelTitle({ name })}
          </div>
          <div
            style={{
              fontSize: '8pt',
              fontWeight: 800,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              letterSpacing: '0.2px',
              whiteSpace: 'nowrap'
            }}
          >
            {payload}
          </div>
        </div>
      </div>
    );
  }
);
