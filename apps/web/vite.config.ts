import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const commitHash = (process.env.GITHUB_SHA ?? process.env.CF_PAGES_COMMIT_SHA)?.slice(0, 7) ?? 'dev';

// Cloudflare Pages builds (CF_PAGES=1) default to the production backends. The Pages
// dashboard sets these for the production environment only, so preview builds came out
// with no Twitch client id and the API/PartyKit on localhost. All three are public (they
// ship in the bundle); a dashboard value still wins. Gated on CF_PAGES rather than put
// in .env.production so a local production build (`vite preview`) keeps talking to the
// local Worker and PartyKit. Vite reads VITE_* from process.env after loading this file.
const PAGES_DEFAULTS = {
  VITE_TWITCH_CLIENT_ID: 'dqx7wpexjk0780igjk7luea6xz3im9',
  VITE_API_URL: 'https://dbd-tracker-production.meriw.workers.dev',
  VITE_PARTY_HOST: 'dbd-tracker-party.macecchi.partykit.dev',
};
if (process.env.CF_PAGES) {
  for (const [key, value] of Object.entries(PAGES_DEFAULTS)) process.env[key] ||= value;
}

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
      // Custom SW (src/sw.ts) instead of the generated one so we can handle Web
      // Push events ("your channel is live"). Precache + navigateFallback +
      // SKIP_WAITING live in sw.ts now — keep them in sync with UpdateToast/main.tsx.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,webp,woff2}'],
        // The PostHog SDK (~100 kB gz) is loaded lazily and is best-effort: precaching it
        // would make every visitor download it on each SW install for no offline benefit.
        // A tab on an old version whose chunk is gone after a deploy just loses analytics.
        globIgnores: ['**/posthog-*.js'],
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
          // Lazy: services/analytics.ts imports it after first paint, when idle.
          if (id.includes('node_modules/posthog-js') || id.includes('node_modules/@posthog/')) return 'posthog';
          return 'vendor';
        }
      }
    }
  }
});
