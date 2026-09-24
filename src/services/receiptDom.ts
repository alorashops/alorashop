/**
 * Receipt document builder for the CSS / fallback print window.
 *
 * P7 (SECURITY_PLAN.md) — stored XSS. The old `printCss` built the receipt with
 * `document.write` + string interpolation, so an attacker-controlled shop name,
 * product name or cashier name (`<img src=x onerror=…>`, `<script>…`) ran as
 * script in the SAME-ORIGIN print window -> session + DB theft.
 *
 * Everything here is built with createElement + textContent: no
 * user-controlled string ever reaches an HTML parser.
 *
 * This module intentionally has ZERO imports. `scripts/verify_p7_receipt_dom.mjs`
 * loads it in plain Node to regression-test the DOM build; `printService.ts`
 * cannot be loaded there because it imports `config/env.ts`, which reads the
 * Vite-only `import.meta.env`.
 */

/** Print stylesheet for the fallback receipt window (80mm, monospace). */
export const PRINT_CSS = [
  '@page { size: 80mm auto; margin: 2mm; }',
  "body { font-family: 'Courier New', monospace; font-size: 12px; white-space: pre; }",
  '.no-print { display: block; margin-bottom: 8px; }',
  '@media print { .no-print { display: none; } }'
].join('\n');

/** Non-breaking space — preserves the monospace alignment the old `&nbsp;` gave. */
const NBSP = '\u00A0';

/**
 * Builds the receipt `<html>` tree for `doc`. Pure DOM construction: every
 * receipt line is assigned through `textContent`.
 *
 * @param doc     Target document (the popup's document; a stub in tests).
 * @param lines   Already-formatted receipt lines (plain text).
 * @param onPrint Click handler for the "Print Receipt" button.
 */
export function buildReceiptDocument(
  doc: Document,
  lines: readonly string[],
  onPrint: () => void
): HTMLHtmlElement {
  const html = doc.createElement('html');

  const head = doc.createElement('head');
  const title = doc.createElement('title');
  title.textContent = 'Receipt';
  head.appendChild(title);

  const style = doc.createElement('style');
  style.textContent = PRINT_CSS;
  head.appendChild(style);
  html.appendChild(head);

  const body = doc.createElement('body');

  // The old markup used an inline `onclick`, which a strict CSP (`script-src`
  // without `'unsafe-inline'`) blocks. addEventListener keeps the button
  // working under the P8 policy.
  const printBtn = doc.createElement('button');
  printBtn.className = 'no-print';
  printBtn.textContent = 'Print Receipt';
  printBtn.addEventListener('click', onPrint);
  body.appendChild(printBtn);

  for (const line of lines) {
    const div = doc.createElement('div');
    // textContent escapes any HTML in the (user-controlled) receipt lines.
    div.textContent = line.replace(/ /g, NBSP);
    body.appendChild(div);
  }
  html.appendChild(body);

  return html;
}

/**
 * Installs the receipt into a freshly opened print document.
 *
 * ── DO NOT REMOVE THE open()/close() PAIR ──────────────────────────────────
 * They are NOT leftovers of the old `document.write` model. They are what keeps
 * the new about:blank document alive long enough to render.
 *
 * Removing them (on the theory that DOM mutation alone was enough) produced a
 * BLANK print window — a real regression, found by the owner, reverted here.
 * `scripts/verify_p7_receipt_dom.mjs` now ASSERTS both calls happen exactly
 * once, so this cannot come back silently.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * `document.write()`/`writeln()` are never used: the tree is built with
 * createElement + textContent, so no user-controlled string reaches the parser.
 */
export function renderReceiptDocument(
  doc: Document,
  lines: readonly string[],
  onPrint: () => void
): void {
  doc.open();
  doc.replaceChildren(buildReceiptDocument(doc, lines, onPrint));
  doc.close();
}