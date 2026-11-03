/**
 * QR label-sheet printing (`STEPS.md` S2.4).
 *
 * ── P7 XSS DOCTRINE (copied verbatim from `receiptDom.ts`) ──────────────────────────────
 * The popup document is built with `createElement` + `textContent` + `importNode` ONLY.
 * There is NO `document.write`, no `innerHTML`, no `insertAdjacentHTML`, and no inline
 * `onclick` (a `script-src 'self'` CSP blocks inline handlers). Product / shop names are
 * NEVER interpolated into a markup string — they live inside the React label subtree, which
 * is deep-cloned node-for-node into the sheet. `scripts/verify_qr_scan_wiring.mjs` pins this.
 *
 * ── BLANK-WINDOW LIFECYCLE (do NOT "tidy" this away) ────────────────────────────────────
 * `open()` → `replaceChildren()` → `close()` must run, exactly like `receiptDom.ts`. Removing
 * the `open()`/`close()` pair once produced a blank print window. The delayed `print()` below
 * is equally load-bearing: calling `print()` synchronously on a just-opened document can print
 * an empty page.
 *
 * ZERO imports on purpose, so a Node guard can load it (mirrors `receiptDom.ts`).
 */

/** Default columns per printed row. */
export const LABEL_COLUMNS = 3;

/** Copies hard-capped by the UI; the sheet builder also clamps defensively. */
export const LABEL_MAX_COPIES = 50;

/** The physical label size the sheet must lay out (structurally typed so this file stays import-free). */
export interface LabelGeometryMm {
  widthMm: number;
  heightMm: number;
}

/**
 * Print stylesheet for the label window. `columns` and the geometry are numbers we compute
 * (never user text), embedded so the grid holds its shape; they go through `textContent` like
 * any other stylesheet, so no HTML parser ever sees them.
 */
export function labelSheetCss(geometry: LabelGeometryMm, columns: number = LABEL_COLUMNS): string {
  const cols = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : LABEL_COLUMNS;
  const w = geometry.widthMm;
  const h = geometry.heightMm;
  return [
    '@page { margin: 6mm; }',
    'html, body { margin: 0; padding: 0; background: #ffffff; color: #000000; }',
    '.qr-toolbar { display: block; margin: 0 0 4mm; }',
    '.qr-toolbar button { font: 600 13px system-ui, sans-serif; padding: 6px 14px; cursor: pointer; }',
    `.qr-sheet { display: grid; grid-template-columns: repeat(${cols}, ${w}mm); gap: 0; justify-content: start; }`,
    `.qr-cell { width: ${w}mm; height: ${h}mm; page-break-inside: avoid; break-inside: avoid; }`,
    '@media print { .qr-toolbar { display: none; } }'
  ].join('\n');
}

/**
 * Builds the printable `<html>` tree for `copies` labels, deep-cloning the already-rendered
 * `sourceLabel` node (the exact preview the cashier saw) into each grid cell.
 *
 * `importNode(sourceLabel, true)` copies a DOM subtree — it is NOT a string sink. The QR
 * itself is an `<svg>` produced by `qrcode.react`, so cloning preserves the code node-for-node.
 *
 * @param doc          Target document (the popup's document; a stub in tests).
 * @param sourceLabel  The React-rendered label element to repeat.
 * @param copies       How many labels to lay out (clamped to >= 1).
 * @param onPrint      Click handler for the in-window "Print labels" button.
 * @param columns      Grid columns per row.
 */
export function buildLabelSheet(
  doc: Document,
  sourceLabel: Node,
  copies: number,
  onPrint: () => void,
  geometry: LabelGeometryMm,
  columns: number = LABEL_COLUMNS
): HTMLElement {
  const count = Math.max(1, Math.floor(copies) || 1);

  const html = doc.createElement('html');

  const head = doc.createElement('head');
  const title = doc.createElement('title');
  title.textContent = 'QR labels';
  head.appendChild(title);
  const style = doc.createElement('style');
  style.textContent = labelSheetCss(geometry, columns);
  head.appendChild(style);
  html.appendChild(head);

  const body = doc.createElement('body');

  // The in-window button is a MANUAL fallback (trackpad/again) — addEventListener, never an
  // inline `onclick`, so it still works under the P8 CSP.
  const toolbar = doc.createElement('div');
  toolbar.className = 'qr-toolbar';
  const btn = doc.createElement('button');
  btn.textContent = 'Print labels';
  btn.addEventListener('click', onPrint);
  toolbar.appendChild(btn);
  body.appendChild(toolbar);

  const sheet = doc.createElement('div');
  sheet.className = 'qr-sheet';
  for (let i = 0; i < count; i++) {
    const cell = doc.createElement('div');
    cell.className = 'qr-cell';
    // Deep clone the rendered label; no markup string is ever constructed.
    cell.appendChild(doc.importNode(sourceLabel, true));
    sheet.appendChild(cell);
  }
  body.appendChild(sheet);
  html.appendChild(body);
  return html;
}

/**
 * Installs the label sheet into a freshly opened print document.
 *
 * DO NOT REMOVE THE open()/close() PAIR — see the file header.
 */
export function renderLabelSheet(
  doc: Document,
  sourceLabel: Node,
  copies: number,
  onPrint: () => void,
  geometry: LabelGeometryMm,
  columns: number = LABEL_COLUMNS
): void {
  doc.open();
  doc.replaceChildren(buildLabelSheet(doc, sourceLabel, copies, onPrint, geometry, columns));
  doc.close();
}

/**
 * Open a print window for `copies` labels and print them.
 *
 * MUST be called from a user gesture (the modal's Print button) or the browser blocks the
 * popup — the caller surfaces a toast when this returns `false`, so the failure is never silent.
 *
 * @returns `true` if a print window was opened; `false` if a popup was blocked (or no label).
 */
export function printQrLabels(
  sourceLabel: Node | null,
  copies: number,
  geometry: LabelGeometryMm,
  columns: number = LABEL_COLUMNS
): boolean {
  if (!sourceLabel) return false;
  const w = window.open('', '_blank', 'width=860,height=1000');
  if (!w) return false; // popup blocked — caller toasts
  renderLabelSheet(w.document, sourceLabel, copies, () => w.print(), geometry, columns);
  // Delayed auto-print — printing synchronously here can blank a fresh window (see header).
  window.setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {
      /* window gone — the in-window button remains as the manual fallback */
    }
  }, 300);
  return true;
}
