import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { guardFoliateDisposal, guardFoliateFixedLayoutDisposal } from './build/foliateCompatibility';

const apiTarget = process.env['EPUB_API_URL'] || 'http://localhost:3000';
const frameLoader = fileURLToPath(new URL('./src/reader/foliateFrameLoad.ts', import.meta.url)).replaceAll('\\', '/');
const proxy: Record<string, string | ProxyOptions> = {
  '/api': apiTarget,
  '/covers': apiTarget,
};

// Workbox matches pathname + search, unlike Express's pathname-only matcher.
export const navigationFallbackDenylist = [
  /^\/api(?:[/?]|$)/,
  /^\/covers(?:[/?]|$)/,
];

export default defineConfig({
  // Keep development on the same checked source transform as production.
  optimizeDeps: { exclude: ['foliate-js'] },
  plugins: [
    {
      name: 'foliate-disposal-compatibility',
      enforce: 'pre',
      transform(code, id) {
        const path = id.replaceAll('\\', '/').split('?')[0];
        const transform = path?.endsWith('/foliate-js/paginator.js') ? guardFoliateDisposal
          : path?.endsWith('/foliate-js/fixed-layout.js') ? guardFoliateFixedLayoutDisposal : null;
        if (transform) {
          return { code: `import { loadFoliateFrame } from ${JSON.stringify(frameLoader)};\n${transform(code)}`, map: null };
        }
      },
    },
    // This product opens EPUB via its own loader. Foliate's optional PDF entry
    // uses a runtime asset glob incompatible with Vite; keep it out of the EPUB
    // build without changing the pinned dependency or loading assets from a CDN.
    {
      name: 'epub-only-foliate',
      enforce: 'pre',
      resolveId(source, importer) {
        if ((source === './pdf.js' && importer?.replaceAll('\\', '/').endsWith('/foliate-js/view.js')) || source.replaceAll('\\', '/').endsWith('/foliate-js/pdf.js')) return '\0foliate-no-pdf';
      },
      load(id) {
        if (id === '\0foliate-no-pdf') return 'export function makePDF() { throw new Error("Only EPUB is supported"); }';
      },
    },
    react(),
    VitePWA({
      injectRegister: 'script-defer',
      manifest: false,
      registerType: 'autoUpdate',
      includeAssets: [
        'app-icon.png',
        'manifest.webmanifest',
      ],
      workbox: {
        cacheId: 'epub-reader',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        globPatterns: ['**/*.{css,html,js,png,svg,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: navigationFallbackDenylist,
        runtimeCaching: [
          {
            urlPattern: /\/covers\/thumbnails\/.+\.webp(?:\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'epub-cover-thumbnails-v1',
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 500,
                purgeOnQuotaError: true,
              },
            },
          },
        ],
        skipWaiting: true,
      },
    }),
  ],
  server: {
    proxy,
  },
  preview: {
    proxy,
  },
});
