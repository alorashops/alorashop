import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { buildCsp } from './csp-policy';

// P8: the Content-Security-Policy is defined ONCE in ./csp-policy.ts, shared with
// vercel.json and the drift-guard test (scripts/verify_p8_headers.mjs).
// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // '.' = the project root (Vite resolves it), so this needs no @types/node.
  const env = loadEnv(mode, '.', 'VITE_');
  const csp = buildCsp(env.VITE_SUPABASE_URL ?? '');

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['alora-icon.svg', 'alora-icon-192.png', 'alora-icon-512.png', 'alora-icon-180.png'],
        manifest: {
          name: 'AloraShop POS',
          short_name: 'AloraShop',
          description: 'Offline-first POS & shop management for small retail shops',
          theme_color: '#0f172a',
          background_color: '#f1f5f9',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: 'alora-icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'alora-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            { src: 'alora-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
          ]
        },
        workbox: {
          // PGlite's embedded Postgres ships as .wasm (10 MB) + .data (6.3 MB)
          // engine files side-loaded relative to import.meta.url. They MUST be
          // precached or an offline launch cannot boot the local database —
          // without them the shell mounts but hangs at "Loading local database…"
          // forever. That's why .wasm/.data are in the globs AND the size cap is
          // raised above the engine's biggest single file.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm,data}'],
          maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
          runtimeCaching: []
        }
      })
    ],
    server: {
      port: 5173
      // NO CSP here ON PURPOSE. In dev, @vitejs/plugin-react injects React Fast
      // Refresh's INLINE preamble — an inline <script> that does NOT exist in a
      // production build. A policy here produced a phantom "Executing inline
      // script" violation and cost a measurement round-trip. Dev is noise; the
      // trustworthy surface is `npm run preview` (enforcing, see below).
    },
    preview: {
      // ENFORCING on purpose: a production build served with the EXACT policy
      // vercel.json sends, so a policy mistake breaks on localhost:4173 and
      // never on the live site. It also registers the real service worker.
      headers: { 'Content-Security-Policy': csp }
    },
    optimizeDeps: {
      // PGlite's Postgres WASM + fs.zip are side-loaded relative to import.meta.url.
      // Pre-bundling it into .vite/deps breaks those paths ("Invalid FS bundle size").
      exclude: ['@electric-sql/pglite']
    },
    build: {
      // es2022: top-level await (used by vite-plugin-pwa's register module) is
      // unsupported in es2020. All modern browsers handle TLA fine.
      target: 'es2022',
      sourcemap: false
    }
  };
});
