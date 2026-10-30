# DBD Utils

See @README.md for project overview.
Keep project docs updated when making changes.

## Release Impact Check

Before and after each feature or refactoring, evaluate how changes impact existing users on release:
- Will existing data (D1, KV, localStorage) work with the new code without migration?
- Are new fields optional/defaulted so old data doesn't break? (e.g. `hideNonRequests ?? true`)
- Is there risk of data loss if old clients/servers interact with new data shapes?
- Do users need to take any action (clear cache, re-auth, re-deploy)?
- Old web clients stay compatible with the Worker across a deploy (protocol `v`, `PROTOCOL_VERSION`)? A client cached by the service worker keeps running until the update toast swaps it, and its polls/edits are refused with `426`/`version_mismatch` when the protocol moved.

## Performance

The web app is tuned for fast initial load. When modifying it, preserve these invariants and apply the same patterns to new code:

- **Bundle** (`vite.config.ts` `manualChunks`): each major dep gets its own chunk (react, react-dom, zustand, sonner, posthog), build target `esnext`. Anything on the path of a normal visit is eager in the main entry — the channel view (`ChannelApp` + its components), `LandingPage`, and `ManualEntry`: lazy-loading something that always renders just adds a round trip mid-paint, which is what we're trying to avoid. A few kB of eager JS is cheaper than that. Lazy is for what most sessions never open: the debug panel (`#debug`), the review/import/VOD dialogs, the PostHog SDK (~100 kB gz; `services/analytics.ts` imports it after `load`, on `requestIdleCallback`, and queues events until then — never import `posthog-js` statically), and `services/vod` (imported by the recovery effect on owner channel visits, after PartyKit sync — off the paint path, and viewers never fetch it). New major dep → add a `manualChunks` entry.
- **Fonts**: self-hosted woff2, preloaded in `index.html`. Do NOT reintroduce Google Fonts (render-blocking).
- **Critical CSS**: inlined in `index.html` `<head>` to paint the dark shell pre-bundle; keep in sync with the bg/text tokens in `base.css` to avoid reflow.
- **Compositing (render cost)**: streamers run the site next to a game + OBS on a busy GPU, so the channel page must stay cheap to paint and composite. Measured with Chrome traces under 4× CPU throttle + software compositing, these were the costs, so keep them out:
  - **No `backdrop-filter` on opaque surfaces.** `--bg-elevated` is opaque, so a blur behind `.panel-surface` / the sticky queue header can never show, yet the compositor re-blurred the whole panel every frame (scroll viz time ~34s → ~4s without it). `.panel-surface` uses `isolation: isolate` to keep the stacking context the blur used to create. Toasts are a near-opaque fill for the same reason.
  - **No `background-attachment: fixed`.** The page backdrop is a fixed `body::before` layer (rastered once, moved by the compositor). `body` itself stays transparent so it doesn't paint over it; `html` carries `--bg`.
  - **`.scroll-mask` (body `mask-image`) is mobile-only** (≤480px, where `body` scrolls). On desktop it was a visual no-op that pushed the whole page through a masked surface.
  - **Looping animations are transform/opacity only**, so the compositor runs them without main-thread paint: the identifying-name shimmer (`.t-shimmer`: a highlighted text copy in a masked window, counter-translated — `SwapText` renders it), `SyncSweep`, the "connecting" avatar pulse, the "Open queue" `.btn-pulse` glow. Never animate `background-position`, `box-shadow`, `background-color` or `mask-*` in a loop: each frame repaints the whole document (~20ms/frame throttled for three shimmering names before).
  - **No hover transitions on queue cards** (`.request-card` background, `.request-actions` opacity): a card the pointer crosses — including while scrolling under a resting pointer — repainted the page for 150ms and churned layers. Hover states switch instantly.
  - **The gap above the stuck queue header is covered by a copy of the page backdrop, never a solid colour.** The backdrop is a textured image, so any colour (the old `box-shadow: 0 -1rem 0 black`) reads as a bar. `.panel-header::before` is a `position: fixed` clone of `--page-backdrop` clipped to the top 1rem, `display: none` until `@container scroll-state(stuck: top)` matches — nothing painted or animated otherwise. Without scroll-state queries the header sticks flush (`top: 0`). Desktop only; on mobile `body` scrolls and the gap is 0.
  - **Scroll-driven custom properties** (`animation-timeline: scroll()`) are animated on the one element that reads them, registered `inherits: false` — on `.app` with `inherits: true` every scroll frame restyled the whole app.
  - Identity values at rest (`transform: none`, `filter: none`, not `translateY(0)` / `blur(0)`) — they still create per-element property-tree nodes.
  - **Context values read by memoized list items must be stable.** `ContextMenuProvider` splits a stable actions context (`useContextMenuActions`, what cards use) from the menu state; one `{ state, show, hide }` object re-rendered all cards through `memo` on every queue change. Pass primitives, not per-render objects, as card props.
- **Instant paint**: the queue hydrates from the `fila-dbd-queue` localStorage cache and mutations (add/toggleDone/reorder) are optimistic. New persisted client state → version the key + defensive reads (`store/queueCache.ts`).
- **Scroll**: the app owns its scroll position. `index.html` sets `history.scrollRestoration='manual'` (so reload/back-forward don't re-apply the prior offset into the cache-hydrated, full-height queue), and the page resets to the top on initial load/reload + every channel change (`App` `useLayoutEffect` on `channel`) and on push navigation (`navigate()`). Use `scrollToTop()` (`utils/helpers`), which resets **both** the window **and** `document.body.scrollTop` — ⚠️ on mobile (≤480px) `body` is the scroll container (`html` is `overflow:hidden`, `body` is `overflow:auto`/`height:100dvh`), so `window.scrollTo` alone is a no-op there. A URL hash (`#faq`/`#debug`) skips the reset so anchors still position.
- ⚠️ **PWA service worker**: custom SW at `src/sw.ts` (VitePWA `injectManifest` — it also handles Web Push for the "you're live" notification). It must keep precaching, the `index.html` navigation fallback, and the `SKIP_WAITING` message handler — the update flow below depends on them. `index.html` + all assets are precached (`registerType: 'prompt'`), so returning users get shell/asset changes only **after the SW updates** (the "new version" toast → reload). The toast self-surfaces without a reload: `main.tsx` calls `registration.update()` on `visibilitychange`/`online` + a 30-min backstop, so an open tab detects a new deploy on refocus/reconnect. A failed check (typically a network blip on wake) retries once after 15s; only a second failure in a row is left unhandled, so PostHog reports persistent failures (a bad deploy, a broken `sw.js`) but not transient ones — don't swallow it with a bare `.catch`. If the browser dropped the registration under the open tab (no installing/waiting/active worker — Safari eviction, cleared site data), `update()` throws `InvalidStateError: newestWorker is null` on every check; the check re-registers `sw.js` instead (safe: `sw.ts` never calls `clients.claim()`, so the tab isn't reloaded). A waiting SW still needs activation (skipWaiting + reload) — a plain reload won't swap it while the tab stays open: the user clicks "Update now", or the toast auto-updates after a 60s countdown that runs unconditionally (the Update button itself is the countdown bar; dismissing the toast cancels it — `components/UpdateToast.tsx`). Include this in the Release Impact Check.
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
└── api/              # Cloudflare Worker: Hono API + the rooms (HTTP on D1)
    ├── migrations/     # D1 database migrations
    └── src/
        ├── index.ts    # Hono API (auth, LLM, internal D1 endpoints, public /rooms/active)
        └── rooms.ts    # Room state (GET /rooms/:id/state) + owner edits (POST /rooms/:id/ops)
```

## Commands

ALWAYS use bun, never npm. npm -> bunm, npx -> bunx, node -> bun.

```bash
bun install          # Install all deps
bun run dev          # Start frontend + API (:8787)
bun run build        # Build frontend
bun run test         # Run all tests (uses Vitest)
bun run typecheck    # Type check all packages
bun run deploy:api   # Deploy the Worker to Cloudflare
```

> **Note:** Use `bun run test`, not `bun test`. The project uses Vitest for testing,
> but `bun test` invokes Bun's native test runner which is incompatible with this project.

**Logs:** the API Worker exports `console.*` output and errors to PostHog Logs through the
account-level `posthog` OTLP destination (`[observability.logs] destinations` in
`apps/api/wrangler.toml`). Keep observability settings in that file — every deploy overwrites
whatever was set in the Cloudflare dashboard.

⚠️ **The rooms are plain HTTP on D1** (`src/rooms.ts`): no WebSocket, no Durable Object, no
lock. Hosted PartyKit (`*.partykit.dev`) shut down on 2026-10-23 and deleted its room storage;
the queue only needs to be live for the streamer's own edits, so rooms became two endpoints on
D1, which was already the persistent store:

- `GET /rooms/:id/state?p=<protocol>&v=<version>` — anyone. `rooms.version` bumps on every
  write, so an unchanged room answers from one row with only the channel status; a moved one
  sends the pending queue, the `RECENT_DONE_KEPT` newest done and the sources. Polled by
  `services/party.ts` (owner 5s, viewer 10s, hidden 30s; a tab coming back polls at once).
- `POST /rooms/:id/ops` — the streamer only (`user.login === room`, or any user under
  `DEV_MODE`). One `PartyMessage` edit per call; the response's `messages` are the server's
  echo (or a `server-error`), which the client applies exactly as it used to apply the socket's,
  and relays to its other windows over `BroadcastChannel`.
- **Status is derived on read** (`roomStatus`): `closed_by_owner` → offline; else a fresh
  `irc_live_at` → live; a fresh `owner_seen_at` → online; else offline. The heartbeats are the
  streamer's own polls (`irc=1` from a window reading chat), written at most every 30s;
  "fresh" is `PRESENCE_TTL_MS` (150s), because background tabs get their timers throttled to
  about once a minute. `/rooms/active`, `/rooms/:id` and the live-push skip read the same function.
- **Concurrency is D1's, never KV's** (KV has no put-if-absent and propagates in ~60s): every
  window of the streamer reads chat and sends what it sees. An add is claimed by its insert
  (`ON CONFLICT DO NOTHING RETURNING`); only the window whose insert landed gets the echo and
  sends the chat confirmation. An LLM call is claimed in `llm_claims` (`claimLlm`, by Twitch
  message id or `req:<id>`; 60s takeover in case the window died): the loser gets `409` and
  writes nothing. Keep a new single-writer side effect behind one of these two claims.

Logs: plain `console.*`, exported with the rest of the Worker's (service
`dbd-tracker-production`). Never log a token.

## Observability (PostHog)

Everything lands in PostHog project 618081 (US), which is **shared with other apps** — filter
on `app = 'fila-dbd'` (every event carries it). Event names are prefixed `fila_`.

- **Web** (`services/analytics.ts`): `posthog-js`, lazy (see Performance), keyed by
  `VITE_POSTHOG_KEY` from `apps/web/.env.production` (the public ingestion token; a Pages env
  var overrides it). Silent in `vite dev`, in tests, and on `localhost` even in a production
  build unless `VITE_POSTHOG_ALLOW_LOCAL=true`. Pageviews + exception autocapture only;
  autocapture, replay, heatmaps, surveys and flags are off **in code**, not left to the shared
  project's remote config. Viewers are anonymous (`person_profiles: 'identified_only'`); a
  signed-in streamer is identified by Twitch login (`main.tsx`).
- ⚠️ **Tokens never leave the browser.** Room requests carry `Authorization: Bearer <JWT>`, the OAuth
  callback carries `?code=&state=`, `dbd-auth` holds both tokens. `before_send` runs every
  event through `scrubProperties()` (JWT-shaped strings, token/code/state URL params,
  `accessToken`-style keys). Don't redact the bare `token` key — that's the SDK's project token,
  and ingestion routes on it. New event properties: report *facts about* a token
  (`token_present`, `token_ttl_s`), never the token or a URL containing it.
- **Realtime health** (`services/realtimeTelemetry.ts`, fed from `services/party.ts`): only the
  streamer's own channel reports. Every edit we send is tracked to its echo —
  `fila_mutation_acked` / `_rejected` (with the server-error `code`) / `_unacked` (no echo in
  15s, or the room became unreachable under it) / `_dropped` (sent while it was unreachable). Plus
  `fila_party_connected` (reconnect, downtime, `token_present`, `token_ttl_s`, `token_expired`),
  `fila_party_disconnected` (the polls reaching the room or not), `fila_owner_recovered`, `fila_server_error`,
  and `fila_sync_diverged`: the first `sync-full` after (re)connecting undoes what this window
  showed (`initial: true` = the queue cache, i.e. what the streamer saw before F5); later syncs
  carry other windows' edits and aren't compared. Echo matching relies on the ops response
  echoing the edit and on `reorder` carrying its `opId` — keep both. An edit answered with no
  echo (a duplicate add another window won) is cleared, not reported (`onNoEcho`).
- Test locally without touching the real project: build with `VITE_POSTHOG_HOST` pointing at
  a local sink + `VITE_POSTHOG_ALLOW_LOCAL=true`.
  posthog-js drops headless browsers as bots: mask `navigator.webdriver` **and**
  `navigator.userAgentData`, and set a non-headless user agent, in the test browser.

## Testing owner paths locally

Every owner-only path — opening the queue, ✓ / undo, editing sources — is gated on a JWT
the Worker verifies against `JWT_SECRET`, so without a Twitch OAuth round trip half
the app is unreachable. **Don't conclude the owner flow is untestable; mint a local token:**

```bash
cd apps/api && bun run dev:login <channel>   # e.g. bun run dev:login meriw_
```

It signs the same payload `/auth/token` signs after Twitch confirms identity, using the
`JWT_SECRET` from `apps/api/.env` (which `wrangler dev` reads via
dotenv). It prints a one-line `localStorage.setItem('dbd-auth', …)` snippet — paste it into
the DevTools console on `localhost:5173`, and the reload comes back signed in with the owner
UI live and mutations accepted.

- **Pass the channel you are testing as the login.** The server's owner check is
  `user.login === room.id` (`isRoomOwner` in `rooms.ts`), so a matching login passes it for
  real — you exercise the production path. A mismatched login still works in dev, but only via
  the `DEV_MODE === 'true'` bypass, i.e. a branch that does not exist in prod.
- The token is signed with the **local** secret and is worthless against production. Nothing
  in the repo can mint a token for the deployed app — deliberately.
- ⚠️ **Never fake the auth state client-side instead** (writing a made-up token into
  `dbd-auth`). `isOwnChannel` only checks `isAuthenticated && user`, so the owner UI lights
  up — but `verifyJwt` fails server-side, the dev bypass still requires a valid user, and
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
- `ircCommand()` - Command of a raw IRC line (past tags/prefix). The socket dispatches by it, never by substring: tags and chat text routinely contain `366`/`USERNOTICE`
- `handleMessage()` - Parse donation bots (LivePix, StreamElements, etc.) + chat commands
- `isDonateBot()` - Check if username is a known donation bot
- `parseDonationMessage()` - Extract donor, amount, message from donation bot text
- `handleUserNotice()` - Parse resub USERNOTICE
- `handleChatCommand()` - Process chat requests with session limits
- `callLLM()` - Gemini API with model fallback/retry
- `identifyCharacter()` - Local match first, then LLM fallback
- `loadAndReplayVOD()` - VOD chat replay via GQL
- `useRequestToasts()` - One toast, updated in place, for what arrives while the page is open (requests + skipped `type: 'none'` messages): one arrival keeps its classic look, more become "3 novos pedidos" / "Huntress e Lich · 2 mensagens sem pedidos de Ana e Beto". It waits while the streamer is off the tab and goes `READ_DELAY_MS` after they're back (`utils/toastDigest.ts`). The baseline is the queue at the first party sync

## Sessions & the queue switch

There is no lock and no "session that owns the room". The server keeps one switch per room
(`closed_by_owner`) and two heartbeats; everything else is per window:

- **`canEditQueue` (= own channel) gates the whole owner UI**: the server authorizes edits per
  *room owner*, so every window of the streamer is a full editor, including the queue toggle.
- **Every window of the streamer takes requests while the queue is open** — joins chat,
  identifies with the LLM, scans the VOD. That is `hasLock` in the channel store (the name is
  historical): `isOwnChannel && first sync seen && !closedByOwner`, set by `ChannelContext`. It
  waits for the first sync so `closedByOwner` is the server's answer, then survives connection
  blips; only the switch drops it. Duplicates are the server's job (see "Concurrency is D1's"
  above and Idempotency below), never a client-side election.
- **Open/close is the room switch** (`open-queue` / `close-queue` ops). The response is an
  `update-channel`, relayed to this browser's windows at once; windows elsewhere see it on their
  next poll and join or leave chat. A closed queue stays closed across reloads and devices until
  the streamer opens it: a fresh room starts open. While closed, the server ignores `irc=1`.
- **Every chat join re-reports chat**: the effect that joins on `hasLock` sends
  `irc-status: true` when chat is already joined (a reopen), since no IRC transition fires then.
  After that, each poll from a window reading chat carries `irc=1`, which is what keeps the
  room `live`; a window that stops polling ages out after `PRESENCE_TTL_MS`.
- **One status, read off the channel** (`hooks/useQueueStatus.ts`): open / connecting /
  closed, the same for streamer and viewer, derived from `channelStatus` rather than this
  window's own connection — so every window says the same thing. Failures surface as toasts,
  not as a badge. Don't reintroduce a second connection indicator. Until the server's first
  status (`status` is `null`) it goes by the room's last saved status from `/rooms/:id`
  (`useRoomInfo`) — saved open → connecting, saved closed → closed, not loaded yet → `unknown`
  (no text, no animation). Never infer "connecting" from this window's own poll. The queue
  panel's sync bar follows the same rule, and what can't be known yet is held (hidden, space
  kept) rather than guessed and swapped: the header's name, badge and subtitle, the avatar's
  fallback letter, and the panel's `SourcesBadges`. On the streamer's own channel the name and
  avatar come from the sign-in (`dbd-auth`), so they don't wait. Queue cards play their enter
  animation only for what arrives after the first sync (`CharacterRequestList`), never for the
  queue the page loads with.
- **The transport** (`services/party.ts`, same exports the socket had): edits go out one at a
  time, in order, retried 1s/2s/4s on network or 5xx, then surface as `persist_failed`. Poll
  answers are dropped while an edit is in flight or when older than the last write's version,
  so a poll can't paint the queue from before an optimistic change. After any write the next
  poll is a full one. A failed poll is `disconnected` (backoff up to 30s); the next answer is a
  full sync.
- ⚠️ **Every request presents a current token.** Access tokens live an hour, so `connectParty`
  takes a token *getter*, called before each poll and each edit, and `getAccessToken` refreshes
  5 min before `exp`. The owner's session never polls anonymously — no token fails that poll
  and the transport retries it (an anonymous poll would read fine but stop the heartbeat).
- **`not_room_owner` is not a failure, and never an error toast.** On the streamer's own
  channel it means this session isn't authenticated as them — force a token refresh and poll
  again (`reauthenticate`, throttled by `REAUTH_COOLDOWN`). If that keeps failing (an edit is
  refused again after a heal, `REAUTH_WARN_AFTER` rounds in `REAUTH_WARN_WINDOW`, or an owner
  session that repeatedly can't get a token), an `auth-status` warning says edits may not be
  saved. It stays up (`duration: Infinity`) until an edit is echoed again — the one state the
  streamer has to act on (reload / sign in again). `persist_failed` is a real failure (toast id
  `server-error`, `duration: Infinity`); `pending_cap` and `chat_send_not_mod` are finite
  warnings under their own ids. Connection toasts own `party-status` / `irc-status` — don't
  reuse those ids for anything else.
- **`/auth/refresh` is single-flight and only a 400/401 signs out.** It runs before requests
  near expiry, so treating a Worker 5xx as "logged out" would sign every live streamer out at once.
- **Reconnects are quiet for the first 5s** (`RECONNECT_GRACE`): chat and the room recover on
  their own within a second or two, so a warning is scheduled, not shown, and the "reconnected"
  toast only follows a warning that was actually displayed.

**Idempotency:** request IDs are a hash of the Twitch message ID alone — no time component
(`generateRequestId` in `services/twitch.ts`, `makeId` in `services/donation.ts`). Whoever
processes a message (every window of the streamer, on any device, or a VOD replay) derives
the same ID, and the server's `add-request` insert collapses it to one row — the first one
wins, and an ID that was ever played or deleted never comes back. Adding any
time-dependent term back re-introduces duplicates and, past `Number.MAX_SAFE_INTEGER`, rounds
the low bits of the hash away. Ordering comes from `position`, never from the ID.

## Data

**D1 database (the rooms' only store):**
- `rooms` table — flattened sources settings (`sources_config`), Twitch profile cache
  (`avatar_url`, `banner_url`), `version` (bumped by every write, what polls compare),
  `closed_by_owner`, and the `owner_seen_at` / `irc_live_at` heartbeats (epoch ms). The old
  `status` column is no longer written; status is derived (`roomStatus`).
- `requests` table — one row per request with `position` for ordering. Positions are rewritten
  for the whole pending queue in one statement from a JSON array of ids (`writeOrder`, via
  `json_each`), so queue length never hits the bound-param limit.
- ⚠️ **Deletes write `deleted_at`; done is `done = 1`.** Before this, deletes were never
  recorded and the old realtime server's sweep marked anything missing as done, so D1 couldn't
  tell a played request from a deleted one. The "recently played" strip
  (`components/RecentPlays.tsx`) reads done rows with `deleted_at IS NULL` and `done_at` after
  `DELETES_RECORDED_SINCE` (and within 7 days), newest `RECENT_DONE_KEPT` — never relax that
  cutoff, or deleted requests come back into the strip. Every list that renders the queue
  filters `!r.done` — DO add that filter to anything new that consumes the requests store
  (`hooks/useRequestToasts.tsx` needs it).
- `llm_claims` table — (room, key) claims for LLM calls; see "Concurrency is D1's".
- ⚠️ Timestamps are written as ISO-8601 with `Z`. Use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  never bare `datetime('now')` — that yields `YYYY-MM-DD HH:MM:SS`, which `new Date()`
  parses as **local** time (hours off) and which sorts below ISO values because
  `' ' < 'T'`. Rows written by older deploys still hold the naive form; `rooms.updated_at`
  is one, which is why `ChannelHeader` reads it as `new Date(updated_at + 'Z')`.
- ⚠️ **100 bound params per statement, 100 statements per `DB.batch()`** — D1 free plan
  limits. Pass lists as one JSON parameter (`json_each`) and chunk batches (`set-all` writes
  rows 80 at a time).
- Tests run the real SQL: `src/test/d1.ts` is a `D1Database` over sql.js with every migration
  applied (`rooms.test.ts`). Prefer it to mocks for anything that touches the rooms.
- `push_subscriptions` table — one Web Push subscription per (streamer, browser), registered by the client once notification permission is granted on the streamer's own channel (`services/push.ts`). Fed by the Twitch EventSub `stream.online` webhook (`POST /twitch/eventsub` in `index.ts`, HMAC-verified via `EVENTSUB_SECRET`): when a channel goes live, the Worker pushes a "you're live, open your queue" notification (`src/webpush.ts` — hand-rolled VAPID + aes128gcm, `web-push` is Node-only). Rows are dropped when the push service answers 404/410. The whole feature is optional: without `VAPID_*`/`EVENTSUB_SECRET` secrets, `/push/vapid-public-key` returns an empty key and clients never subscribe. Pushes are skipped when the queue is already open (`roomStatus` not offline); there is no rate limit, because `stream.online` fires once per stream and Twitch's own retries are deduped by message id. ⚠️ **The notification is localized via the payload, not the browser language**: the service worker cannot read the app's language toggle (`dbd-locale` in localStorage is off-limits there) and the browser language can contradict the UI, so each subscription stores the `locale` its browser registered with and the Worker sends it back (with the pending count) for `sw.ts` to render. The strings live in `apps/web/src/i18n/pushCopy.ts` — deliberately **not** in `locales/{en,pt-BR}.ts`, whose ~200-key object literals don't tree-shake and would triple a service worker that is re-fetched on every deploy. The client sends `locale` on every `/api/push/subscribe`, and `ChannelContext` re-registers whenever the language changes; a NULL `locale` (rows predating the column) is English. Clicking the notification focuses the channel tab **and opens the queue** — a tab already on the channel is told over `postMessage`, one the worker has to open or navigate carries `?open-queue=1` (there is no client to message until it loads). `ChannelContext` consumes both, waits for `partySynced`, and strips the param so a reload can't reopen a queue the streamer just closed.

## Known Limits

- **D1 free plan**: 100 bound params per statement, 100 statements per `DB.batch()`, and 100k
  rows written / 5M read per day. Polls cost one row read when nothing changed; heartbeats are
  at most one write per window per 30s.

**KV (CACHE namespace):**
- Twitch app access token cache (client credentials flow)

**localStorage (seeding only):**
- `dbd_chat` - Recent chat messages
- `dbd-auth` - Twitch auth tokens and user info
- `fila-dbd-queue-v{N}-{slug}` - per-room queue cache (stale-while-revalidate). Hydrated into
  the requests store on boot so the queue paints before the room's first `sync-full`, which then
  replaces it (authoritative). Versioned + defensively parsed (`store/queueCache.ts`); bump the
  version to invalidate on a shape change. Never authoritative — D1 remains source of truth.
- `fila-dbd-sidebar-hidden-v1` - set to `'1'` when the streamer hides the settings side column
  (`ChannelApp`; the queue takes the full width, a button in the queue header brings it back).
  Per-browser UI preference; absent = shown.
- `fila-dbd-live-notif-disabled-v1` - set to `'1'` when the streamer turns off the
  "Live notifications" toggle (Settings → Behavior); blocks the Web Push auto-subscribe in
  `services/push.ts` on that browser (turning it off also unsubscribes locally + server-side).
  Absent = enabled.
- `ph_<project token>_posthog` - posthog-js's own persistence (anonymous id, or the streamer's
  Twitch login once identified), written only after the SDK loads in a production build.
  Not app state: nothing reads it, and clearing it only resets analytics identity.
- `fila-dbd-channels-v{N}` - landing-page featured-channels cache (stale-while-revalidate):
  the active list, the recently-active list (7-day window, closed queues) and the all-time
  channel count from `/rooms/active`. The landing merges them into one "featured" grid —
  live/open queues first, then a shuffled sample of recent channels — so the section is never
  empty. Hydrated into `LiveChannels` on mount so it paints before the request returns; the
  response wins. Versioned + defensively parsed (`store/channelsCache.ts`). `/rooms/active` is
  already KV-cached server-side (60s, key `rooms_active_v3`); this hides round-trip/cold-start
  latency from the user. Channel search (`/rooms/search`) is live-only — debounced in
  `ChannelSearch`, no cache.
