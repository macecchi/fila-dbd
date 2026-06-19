import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const commitHash = (process.env.GITHUB_SHA ?? process.env.CF_PAGES_COMMIT_SHA)?.slice(0, 7) ?? 'dev';

export default defineConfig({
  base: '/',
  define: {
    __APP_VERSION__: JSON.stringify(commitHash)
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,webp,woff2}'],
        navigateFallback: 'index.html'
      }
    })
  ],
  build: {
    // Modern audience and no plugin-legacy installed, so down-leveling buys nothing.
    target: 'esnext',
    rollupOptions: {
      input: {
        main: 'index.html'
      },
      output: {
        // One hashed chunk per major dependency, so an app change or dep bump only
        // invalidates the affected chunk. Vite emits modulepreload for eager chunks.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('node_modules/react-dom')) return 'react-dom';
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/scheduler')
          ) return 'react';
          if (id.includes('node_modules/zustand')) return 'zustand';
          if (id.includes('node_modules/partysocket')) return 'partysocket';
          if (id.includes('node_modules/sonner')) return 'sonner';
          return 'vendor';
        }
      }
    }
  }
});
