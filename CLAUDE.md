# DBD Utils

See @README.md for project overview.
Keep project docs updated when making changes.

## Release Impact Check

Before and after each feature or refactoring, evaluate how changes impact existing users on release:
- Will existing data (DO storage, D1, localStorage) work with the new code without migration?
- Are new fields optional/defaulted so old data doesn't break? (e.g. `hideNonRequests ?? true`)
- Is there risk of data loss if old clients/servers interact with new data shapes?
- Do users need to take any action (clear cache, re-auth, re-deploy)?
- Will the PartyKit server and Cloudflare Worker stay compatible during rolling deploys?

## Performance

The web app is tuned for fast initial load. When modifying it, preserve these invariants and apply the same patterns to new code:

- **Bundle** (`vite.config.ts` `manualChunks`): each major dep gets its own chunk (react, react-dom, zustand, partysocket, sonner), build target `esnext`. Keep the channel view (`ChannelApp` + its components) eager in the main entry; `LandingPage`, dialogs, debug panel, and `services/vod` stay lazy. New heavy off-first-paint feature → lazy-load it. New major dep → add a `manualChunks` entry.
- **Fonts**: self-hosted woff2, preloaded in `index.html`. Do NOT reintroduce Google Fonts (render-blocking).
- **Critical CSS**: inlined in `index.html` `<head>` to paint the dark shell pre-bundle; keep in sync with the bg/text tokens in `base.css` to avoid reflow.
- **Instant paint**: the queue hydrates from the `fila-dbd-queue` localStorage cache and mutations (add/toggleDone/reorder) are optimistic. New persisted client state → version the key + defensive reads (`store/queueCache.ts`).
- **Scroll**: the app owns its scroll position. `index.html` sets `history.scrollRestoration='manual'` (so reload/back-forward don't re-apply the prior offset into the cache-hydrated, full-height queue), and the page resets to the top on initial load/reload + every channel change (`App` `useLayoutEffect` on `channel`) and on push navigation (`navigate()`). Use `scrollToTop()` (`utils/helpers`), which resets **both** the window **and** `document.body.scrollTop` — ⚠️ on mobile (≤480px) `body` is the scroll container (`html` is `overflow:hidden`, `body` is `overflow:auto`/`height:100dvh`), so `window.scrollTo` alone is a no-op there. A URL hash (`#faq`/`#debug`) skips the reset so anchors still position.
- ⚠️ **PWA service worker**: `index.html` + all assets are precached (`registerType: 'prompt'`), so returning users get shell/asset changes only **after the SW updates** (the "new version" toast → reload). The toast self-surfaces without a reload: `main.tsx` calls `registration.update()` on `visibilitychange`/`online` + a 30-min backstop, so an open tab detects a new deploy on refocus/reconnect. A waiting SW still needs the user's "Update" click (skipWaiting + reload) to activate — a plain reload won't swap it while the tab stays open. Include this in the Release Impact Check.
- **Verify prod behavior with the production build**, not the dev server (which serves unbundled ESM and skips the SW): `bun run --filter @filadbd/web preview` (the `preview` launch config serves `dist` on :4173). Clear the SW (unregister + delete caches) to see fresh changes.

## Structure

```
apps/
├── web/              # React frontend (Vite)
│   ├── src/
│   │   ├── components/
│   │   ├── data/
│   │   ├── services/
│   │   ├── store/
│   │   ├── styles/
│   │   ├── types/
│   │   └── App.tsx
│   └── public/
└── api/              # Cloudflare Worker backend (Hono) + PartyKit
    ├── migrations/     # D1 database migrations
    └── src/
        ├── index.ts    # Hono API (auth, LLM, internal D1 endpoints, public /rooms/active)
        └── party.ts    # PartyKit server (real-time sync + D1 write-through)
```

## Commands

ALWAYS use bun, never npm. npm -> bunm, npx -> bunx, node -> bun.

```bash
bun install          # Install all deps
bun run dev          # Start frontend + API + PartyKit
bun run build        # Build frontend
bun run test         # Run all tests (uses Vitest)
bun run typecheck    # Type check all packages
bun run deploy:api   # Deploy API to Cloudflare
bun run deploy:party # Deploy PartyKit
```

> **Note:** Use `bun run test`, not `bun test`. The project uses Vitest for testing,
> but `bun test` invokes Bun's native test runner which is incompatible with this project.

## Key functions

- `connect()` - Twitch IRC WebSocket
- `handleMessage()` - Parse donation bots (LivePix, StreamElements, etc.) + chat commands
- `isDonateBot()` - Check if username is a known donation bot
- `parseDonationMessage()` - Extract donor, amount, message from donation bot text
- `handleUserNotice()` - Parse resub USERNOTICE
- `handleChatCommand()` - Process chat requests with session limits
- `callLLM()` - Gemini API with model fallback/retry
- `identifyCharacter()` - Local match first, then LLM fallback
- `loadAndReplayVOD()` - VOD chat replay via GQL

## Data

**Primary (real-time):** PartyKit room storage (Durable Objects)
- Requests stored as individual keys (`req:${id}`) with ordering in `order` key
- Sources settings per room
- Write-through to D1 via async HTTP calls to Hono API

**D1 database (persistent store):**
- `rooms` table — flattened sources settings, Twitch profile cache (`avatar_url`, `banner_url`), room `status`
- `requests` table — one row per request with `position` for ordering
- Debounced sync (10s) for requests, immediate for sources and status
- Internal auth via `INTERNAL_API_SECRET` shared between Worker and PartyKit
- ⚠️ **100 bound params per statement** — D1 free plan limit. Full sync's `NOT IN` clause fails at ≥100 requests. See Known Issues below.

## Known Limits

- **DO storage**: 128 KiB per value — per-key storage avoids this for requests, but keep in mind for any future changes
- **D1 free plan**: 100 bound params per statement, 100 statements per `DB.batch()`

**KV (CACHE namespace):**
- Twitch app access token cache (client credentials flow)

**localStorage (seeding only):**
- `dbd_chat` - Recent chat messages
- `dbd-auth` - Twitch auth tokens and user info
- `fila-dbd-queue-v{N}-{slug}` - per-room queue cache (stale-while-revalidate). Hydrated into
  the requests store on boot so the queue paints before PartyKit `sync-full`, which then
  replaces it (authoritative). Versioned + defensively parsed (`store/queueCache.ts`); bump the
  version to invalidate on a shape change. Never authoritative — DO remains source of truth.
- `fila-dbd-notif-toast-dismissed-v1` - set to `'1'` once the streamer dismisses the
  "notifications blocked" warning toast; suppresses it permanently on that browser
  (`store/ChannelContext.tsx`). Absent = show it.
- `fila-dbd-channels-v{N}` - landing-page active-channels cache (stale-while-revalidate).
  Hydrated into `LiveChannels` on mount so the list paints before `/rooms/active` returns; the
  response wins. Versioned + defensively parsed (`store/channelsCache.ts`). `/rooms/active` is
  already KV-cached server-side (60s); this hides round-trip/cold-start latency from the user.
