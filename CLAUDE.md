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

- **Bundle** (`vite.config.ts` `manualChunks`): each major dep gets its own chunk (react, react-dom, zustand, partysocket, sonner), build target `esnext`. Anything on the path of a normal visit is eager in the main entry — the channel view (`ChannelApp` + its components), `LandingPage`, and `ManualEntry`: lazy-loading something that always renders just adds a round trip mid-paint, which is what we're trying to avoid. A few kB of eager JS is cheaper than that. Lazy is for what most sessions never open: the debug panel (`#debug`), the review/import/VOD dialogs, and `services/vod` (imported by the recovery effect on owner channel visits, after PartyKit sync — off the paint path, and viewers never fetch it). New major dep → add a `manualChunks` entry.
- **Fonts**: self-hosted woff2, preloaded in `index.html`. Do NOT reintroduce Google Fonts (render-blocking).
- **Critical CSS**: inlined in `index.html` `<head>` to paint the dark shell pre-bundle; keep in sync with the bg/text tokens in `base.css` to avoid reflow.
- **Instant paint**: the queue hydrates from the `fila-dbd-queue` localStorage cache and mutations (add/toggleDone/reorder) are optimistic. New persisted client state → version the key + defensive reads (`store/queueCache.ts`).
- **Scroll**: the app owns its scroll position. `index.html` sets `history.scrollRestoration='manual'` (so reload/back-forward don't re-apply the prior offset into the cache-hydrated, full-height queue), and the page resets to the top on initial load/reload + every channel change (`App` `useLayoutEffect` on `channel`) and on push navigation (`navigate()`). Use `scrollToTop()` (`utils/helpers`), which resets **both** the window **and** `document.body.scrollTop` — ⚠️ on mobile (≤480px) `body` is the scroll container (`html` is `overflow:hidden`, `body` is `overflow:auto`/`height:100dvh`), so `window.scrollTo` alone is a no-op there. A URL hash (`#faq`/`#debug`) skips the reset so anchors still position.
- ⚠️ **PWA service worker**: custom SW at `src/sw.ts` (VitePWA `injectManifest` — it also handles Web Push for the "you're live" notification). It must keep precaching, the `index.html` navigation fallback, and the `SKIP_WAITING` message handler — the update flow below depends on them. `index.html` + all assets are precached (`registerType: 'prompt'`), so returning users get shell/asset changes only **after the SW updates** (the "new version" toast → reload). The toast self-surfaces without a reload: `main.tsx` calls `registration.update()` on `visibilitychange`/`online` + a 30-min backstop, so an open tab detects a new deploy on refocus/reconnect. A waiting SW still needs activation (skipWaiting + reload) — a plain reload won't swap it while the tab stays open: the user clicks "Update now", or the toast auto-updates after a 60s countdown that runs unconditionally (the Update button itself is the countdown bar; dismissing the toast cancels it — `components/UpdateToast.tsx`). Include this in the Release Impact Check.
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

## Testing owner paths locally

Every owner-only path — opening the queue, ✓ / undo, editing sources — is gated on a JWT
the party server verifies against `JWT_SECRET`, so without a Twitch OAuth round trip half
the app is unreachable. **Don't conclude the owner flow is untestable; mint a local token:**

```bash
cd apps/api && bun run dev:login <channel>   # e.g. bun run dev:login meriw_
```

It signs the same payload `/auth/token` signs after Twitch confirms identity, using the
`JWT_SECRET` from `apps/api/.env` (which `wrangler dev` and `partykit dev` both read via
dotenv). It prints a one-line `localStorage.setItem('dbd-auth', …)` snippet — paste it into
the DevTools console on `localhost:5173`, and the reload comes back signed in with the owner
UI live and mutations accepted.

- **Pass the channel you are testing as the login.** The server's owner check is
  `user.login === room.id`, so a matching login makes `isRoomOwner` true and the `DEV_MODE`
  bypass is never taken — you exercise the production path. A mismatched login still works in
  dev, but only via `isDev && connInfo?.user`, i.e. a branch that does not exist in prod.
- The token is signed with the **local** secret and is worthless against production. Nothing
  in the repo can mint a token for the deployed app — deliberately.
- ⚠️ **Never fake the auth state client-side instead** (writing a made-up token into
  `dbd-auth`). `isOwnChannel` only checks `isAuthenticated && user`, so the owner UI lights
  up — but `verifyJwt` fails server-side, both dev gates require `connInfo?.user`, and
  `not_room_owner` is logged rather than toasted while `toggleDone` is optimistic. The ✓
  appears to land and nothing persists: a silently-passing test, worse than no test.
- Sign out with `localStorage.removeItem('dbd-auth'); location.reload()`.

## Testing the live notification locally

`vite dev` registers no service worker and Twitch cannot reach `localhost`, so this one
feature needs the production preview plus a fake webhook — **it is not untestable**:

```bash
bun run --filter @filadbd/web preview   # :4173, the only build with a real SW
cd apps/api && bun run dev:live <channel>   # signed stream.online → local Worker
```

`scripts/dev-stream-online.ts` signs `messageId + timestamp + body` with `EVENTSUB_SECRET`
from `apps/api/.env`, so the Worker runs its real verification and dedupe path and
sends a real Web Push (the push service is reached over the internet from `wrangler dev`,
so it lands in your browser). For the SW's rendering alone, DevTools → Application →
Service Workers → Push with `{"type":"stream-online","channel":"…","locale":"pt-BR","pending":3}`
needs no keys at all.
See README "Testing the live notification locally".

To verify something actually reached the server rather than the optimistic store, clear the
queue cache before reloading: `Object.keys(localStorage).filter(k => k.startsWith('fila-dbd-queue')).forEach(k => localStorage.removeItem(k))`.

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

## Sessions & ownership

One PartyKit connection at a time holds the room lock (`activeOwnerConnId`), and the server
drops it whenever that socket closes — a wifi blip, a sleeping tab, a deploy. Ownership is
internal bookkeeping and must never surface as a mode the streamer has to notice or fix:

- **The client re-claims on its own** (`store/ChannelContext.tsx`): whenever the room is
  ownerless and ours to take — first sync, after a reconnect, when another session closes.
  Gated on `partySynced` so `owner` reflects the current server state, and re-armed only when
  ownership changes hands, so a refusal can't spin. Never make this one-shot again: that is
  exactly how a tab used to end up silently demoted until reload.
- **`canEditQueue` (= own channel) gates the whole owner UI**, because the server authorizes
  mutations per *room owner*, not per lock holder — every window of the streamer is a full
  editor, including the queue toggle.
- **One status, read off the channel** (`hooks/useQueueStatus.ts`): open / connecting /
  closed, the same for streamer and viewer, derived from `channelStatus` rather than this
  window's own sockets — so every window says the same thing. Sockets and the lock are
  internal; failures surface as toasts, not as a badge. Don't reintroduce a second
  connection indicator.
- **The lock transfers, it never refuses** (`party.ts` `claim-ownership`): a claim from
  another window of the same streamer hands the lock over and sends the old holder
  `ownership-denied` (which clears its lock and drops its IRC). So Open/Close the queue works
  from any window — `openQueue()` / `closeQueue()` in the context claim first when needed.
- **A deliberate close sticks.** `release-ownership` marks the channel `closedByOwner` (an
  additive, optional field on `ChannelState`); sessions skip the auto-reclaim while it's set,
  so nothing reopens a queue the streamer just closed. A socket that merely died leaves it
  unset, which is what makes the recovery above safe. A claim clears it.
- **Single-writer work follows `hasLock`**, not the UI capability: LLM identification and the
  VOD recovery scan, so a second tab never duplicates requests or burns a second round of
  tokens.
- **Authority `server-error` codes are not failures.** `not_room_owner` / `not_lock_holder`
  mean another session holds the lock or ours went stale; log and nudge a re-claim, never
  raise an error toast. Only `persist_failed` / `d1_sync_failed` are real server failures
  (toast id `server-error`, `duration: Infinity`); `pending_cap` and `chat_send_not_mod` are
  finite warnings under their own ids. Connection toasts own `party-status` / `irc-status` —
  don't reuse those ids for anything else.
- **Reconnects are quiet for the first 5s** (`RECONNECT_GRACE`): both sockets recover on their
  own within a second or two, so a warning is scheduled, not shown, and the "reconnected"
  toast only follows a warning that was actually displayed.

**Idempotency:** request IDs are a hash of the Twitch message ID alone — no time component
(`generateRequestId` in `services/twitch.ts`, `makeId` in `services/donation.ts`). Whoever
processes a message (a second tab, a session that just took the lock, a VOD replay) derives
the same ID, and the server's `add-request` dedupe collapses it to one row. Adding any
time-dependent term back re-introduces duplicates and, past `Number.MAX_SAFE_INTEGER`, rounds
the low bits of the hash away. Ordering comes from `position`, never from the ID.

## Data

**Primary (real-time):** PartyKit room storage (Durable Objects)
- Requests stored as individual keys (`req:${id}`) with ordering in `order` key
- Sources settings per room
- Write-through to D1 via async HTTP calls to Hono API
- ⚠️ **Done requests are pruned once they reach D1 — all but the newest
  `RECENT_DONE_KEPT` (`packages/shared/src/party.ts`).** Those few stay in DO storage
  and in `sync-full`, which is what makes the header's "recently played" strip
  (`components/RecentPlays.tsx`) identical in every window and able to survive a
  reload. They are excluded from `order` and from the pending cap, and every list that
  renders the queue filters `!r.done` — so don't "fix" a done request showing up in the
  room state, and DO add that filter to anything new that consumes the requests store
  (`useRequestToasts` in `App.tsx` needs it). Raising the constant grows DO storage and
  the full-sync statement (see the 100-param D1 limit).
- ⚠️ **D1 cannot tell a completed request from a deleted one, and the recovery
  endpoint must stay pending-only because of it.** `deleted_at` exists in the schema
  but is never written; deleting drops the request from the DO, and the next full
  sync's sweep marks anything missing as `done` (deliberate — `index.test.ts` pins it).
  So "the newest done rows in D1" also means "the most recently deleted", and serving
  them would resurrect a deleted request into the strip. The strip is fed from DO
  retention only; after a storage loss it starts empty.

**D1 database (persistent store):**
- `rooms` table — flattened sources settings, Twitch profile cache (`avatar_url`, `banner_url`), room `status`
- `requests` table — one row per request with `position` for ordering
- Debounced sync (10s) for requests, immediate for sources and status
- ⚠️ Timestamps are written as ISO-8601 with `Z`. Use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  never bare `datetime('now')` — that yields `YYYY-MM-DD HH:MM:SS`, which `new Date()`
  parses as **local** time (hours off) and which sorts below ISO values because
  `' ' < 'T'`. Rows written by older deploys still hold the naive form; `rooms.updated_at`
  is one, which is why `ChannelHeader` reads it as `new Date(updated_at + 'Z')`.
- Internal auth via `INTERNAL_API_SECRET` shared between Worker and PartyKit
- ⚠️ **100 bound params per statement** — D1 free plan limit. Full sync's `NOT IN` clause fails at ≥100 requests. See Known Issues below.
- `push_subscriptions` table — one Web Push subscription per (streamer, browser), registered by the client once notification permission is granted on the streamer's own channel (`services/push.ts`). Fed by the Twitch EventSub `stream.online` webhook (`POST /twitch/eventsub` in `index.ts`, HMAC-verified via `EVENTSUB_SECRET`): when a channel goes live, the Worker pushes a "you're live, open your queue" notification (`src/webpush.ts` — hand-rolled VAPID + aes128gcm, `web-push` is Node-only). Rows are dropped when the push service answers 404/410. The whole feature is optional: without `VAPID_*`/`EVENTSUB_SECRET` secrets, `/push/vapid-public-key` returns an empty key and clients never subscribe. Pushes are skipped when the queue is already open (PartyKit check); there is no rate limit, because `stream.online` fires once per stream and Twitch's own retries are deduped by message id. ⚠️ **The notification is localized via the payload, not the browser language**: the service worker cannot read the app's language toggle (`dbd-locale` in localStorage is off-limits there) and the browser language can contradict the UI, so each subscription stores the `locale` its browser registered with and the Worker sends it back (with the pending count) for `sw.ts` to render. The strings live in `apps/web/src/i18n/pushCopy.ts` — deliberately **not** in `locales/{en,pt-BR}.ts`, whose ~200-key object literals don't tree-shake and would triple a service worker that is re-fetched on every deploy. The client sends `locale` on every `/api/push/subscribe`, and `ChannelContext` re-registers whenever the language changes; a NULL `locale` (rows predating the column) is English. Clicking the notification focuses the channel tab **and opens the queue** — a tab already on the channel is told over `postMessage`, one the worker has to open or navigate carries `?open-queue=1` (there is no client to message until it loads). `ChannelContext` consumes both, waits for `partySynced`, and strips the param so a reload can't reopen a queue the streamer just closed.

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
- `fila-dbd-live-notif-disabled-v1` - set to `'1'` when the streamer turns off the
  "Live notifications" toggle (Settings → Behavior); blocks the Web Push auto-subscribe in
  `services/push.ts` on that browser (turning it off also unsubscribes locally + server-side).
  Absent = enabled.
- `fila-dbd-channels-v{N}` - landing-page featured-channels cache (stale-while-revalidate):
  the active list, the recently-active list (7-day window, closed queues) and the all-time
  channel count from `/rooms/active`. The landing merges them into one "featured" grid —
  live/open queues first, then a shuffled sample of recent channels — so the section is never
  empty. Hydrated into `LiveChannels` on mount so it paints before the request returns; the
  response wins. Versioned + defensively parsed (`store/channelsCache.ts`). `/rooms/active` is
  already KV-cached server-side (60s, key `rooms_active_v3`); this hides round-trip/cold-start
  latency from the user. Channel search (`/rooms/search`) is live-only — debounced in
  `ChannelSearch`, no cache.
