/**
 * P8 (SECURITY_PLAN.md) — the ONE source of truth for the
 * Content-Security-Policy.
 *
 * Three consumers, which is exactly why it is a single function:
 *   1. `vite.config.ts` -> `Content-Security-Policy` on `npm run preview`: an
 *      ENFORCING local rehearsal of what production sends. If the policy is
 *      wrong it breaks on localhost:4173, never on the live site.
 *   2. `vercel.json`    -> the same string, enforced on the deployed site.
 *   3. `scripts/verify_p8_headers.mjs` -> asserts that (2) is exactly this
 *      output, so the two cannot silently drift apart.
 *
 * Zero imports on purpose, so plain Node can load it for that guard.
 *
 * EVERY directive is backed by a measurement (see SECURITY_PLAN.md P8):
 *  - NO 'unsafe-inline' for scripts: `dist/index.html` contains zero inline
 *    <script>. The DEV server injects React Fast Refresh's inline preamble,
 *    which is why the dev server carries NO CSP at all — a policy there
 *    reported a phantom "Executing inline script" violation.
 *  - NO 'unsafe-eval': PGlite's Emscripten glue does contain eval(), but a
 *    preview run on 2026-09-22 booted the local DB with NO eval violation.
 *  - 'wasm-unsafe-eval' IS required: PGlite compiles its Postgres WASM.
 *    Without it the local database never starts and offline mode is dead.
 *  - `https://js.paystack.co`: the Paystack Inline script (paystack.ts:28).
 *  - `style-src 'unsafe-inline'`: 175+ React style={{}} props across ~11 files.
 *    Tightening to style-src-elem/style-src-attr is a tracked residual, not
 *    something to do blind.
 *  - `frame-src`: Paystack Inline renders checkout in an iframe. UNMEASURED
 *    until the Paystack key exists (P9b) — flagged, not assumed.
 *  - NO `Permissions-Policy` here: `printService.ts` calls
 *    `navigator.usb.requestDevice` (WebUSB thermal printing). A wrong `usb=()`
 *    would silently break printing, and P8 does not require it.
 */
export function buildCsp(supabaseUrl: string): string {
  const connect = ["'self'"];
  const origin = /^(https?:\/\/[^/]+)/.exec(supabaseUrl);
  if (origin) {
    // Origin only — REST, auth and functions/ all live on this host.
    // Parsed by regex (not `new URL`) so this file needs no DOM/Node lib types.
    connect.push(origin[1]);
  }
  return [
    "default-src 'self'",
    "script-src 'self' https://js.paystack.co 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "frame-src https://checkout.paystack.com https://*.paystack.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'"
  ].join('; ');
}
