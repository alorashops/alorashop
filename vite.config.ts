import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['alora-icon.svg', 'alora-icon-192.png', 'alora-icon-512.png'],
      manifest: {
        name: 'AloraShop POS',
        short_name: 'AloraShop',
        description: 'Offline-first POS & shop management for small retail shops',
        theme_color: '#0f172a',
        background_color: '#f1f5f9',
        display: 'standalone',
        orientation: 'landscape',
        start_url: '/',
        icons: [
          { src: 'alora-icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'alora-icon-512.png', sizes: '512x512', type: 'image/png' },
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
});
