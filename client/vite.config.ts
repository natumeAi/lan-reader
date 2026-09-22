import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const apiTarget = process.env['EPUB_API_URL'] || 'http://localhost:3000';
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
  plugins: [
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
