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

- **Bundle** (`vite.config.ts` `manualChunks`): each major dep gets its own chunk (react, react-dom, zustand, partysocket, sonner, posthog), build target `esnext`. Anything on the path of a normal visit is eager in the main entry — the channel view (`ChannelApp` + its components), `LandingPage`, and `ManualEntry`: lazy-loading something that always renders just adds a round trip mid-paint, which is what we're trying to avoid. A few kB of eager JS is cheaper than that. Lazy is for what most sessions never open: the debug panel (`#debug`), the review/import/VOD dialogs, the PostHog SDK (~100 kB gz; `services/analytics.ts` imports it after `load`, on `requestIdleCallback`, and queues events until then — never import `posthog-js` statically), and `services/vod` (imported by the recovery effect on owner channel visits, after PartyKit sync — off the paint path, and viewers never fetch it). New major dep → add a `manualChunks` entry.
- **Fonts**: self-hosted woff2, preloaded in `index.html`. Do NOT reintroduce Google Fonts (render-blocking).
- **Critical CSS**: inlined in `index.html` `<head>` to paint the dark shell pre-bundle; keep in sync with the bg/text tokens in `base.css` to avoid reflow.
- **Compositing (render cost)**: streamers run the site next to a game + OBS on a busy GPU, so the channel page must stay cheap to paint and composite. Measured with Chrome traces under 4× CPU throttle + software compositing, these were the costs, so keep them out:
  - **No `backdrop-filter` on opaque surfaces.** `--bg-elevated` is opaque, so a blur behind `.panel-surface` / the sticky queue header can never show, yet the compositor re-blurred the whole panel every frame (scroll viz time ~34s → ~4s without it). `.panel-surface` uses `isolation: isolate` to keep the stacking context the blur used to create. Toasts are a near-opaque fill for the same reason.
  - **No `background-attachment: fixed`.** The page backdrop is a fixed `body::before` layer (rastered once, moved by the compositor). `body` itself stays transparent so it doesn't paint over it; `html` carries `--bg`.
  - **`.scroll-mask` (body `mask-image`) is mobile-only** (≤480px, where `body` scrolls). On desktop it was a visual no-op that pushed the whole page through a masked surface.
  - **Looping animations are transform/opacity only**, so the compositor runs them without main-thread paint: the identifying-name shimmer (`.t-shimmer`: a highlighted text copy in a masked window, counter-translated — `SwapText` renders it), `SyncSweep`, the "connecting" avatar pulse, the "Open queue" `.btn-pulse` glow. Never animate `background-position`, `box-shadow`, `background-color` or `mask-*` in a loop: each frame repaints the whole document (~20ms/frame throttled for three shimmering names before).
  - **No hover transitions on queue cards** (`.request-card` background, `.request-actions` opacity): a card the pointer crosses — including while scrolling under a resting pointer — repainted the page for 150ms and churned layers. Hover states switch instantly.
  - **Scroll-driven custom properties** (`animation-timeline: scroll()`) are animated on the one element that reads them, registered `inherits: false` — on `.app` with `inherits: true` every scroll frame restyled the whole app.
  - Identity values at rest (`transform: none`, `filter: none`, not `translateY(0)` / `blur(0)`) — they still create per-element property-tree nodes.
  - **Context values read by memoized list items must be stable.** `ContextMenuProvider` splits a stable actions context (`useContextMenuActions`, what cards use) from the menu state; one `{ state, show, hide }` object re-rendered all cards through `memo` on every queue change. Pass primitives, not per-render objects, as card props.
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

**Logs:** the API Worker exports `console.*` output and errors to PostHog Logs through the
account-level `posthog` OTLP destination (`[observability.logs] destinations` in
`apps/api/wrangler.toml`). Keep observability settings in that file — every deploy overwrites
whatever was set in the Cloudflare dashboard.

PartyKit has no log export, so `party.ts` logs **only** through `this.logger` (`RoomLogger`,
`apps/api/src/logs.ts`), never `console.*` directly: it prints the same arguments to the console
(`partykit tail` unchanged) and ships each line over OTLP/HTTP to PostHog Logs as service
`dbd-tracker-party`, with the room id in the `room.id` attribute and the console method in
`name` (like the Worker's export). Buffered and flushed fire-and-forget every 2s / 200 lines and
when a room's last connection closes; bodies are scrubbed of JWTs, `token=`/`code=` params and
Bearer values as a backstop — still never log a token. Keyed by the `POSTHOG_KEY` PartyKit env
var, which the deploy workflow sets with `partykit env add` — ⚠️ `partykit deploy` never ships
`partykit.json` `vars`, and `--with-vars` would also push its local-dev secrets. Off under
`DEV_MODE`. Export failures go to the console only, and one export per room is in flight at a
time (5s timeout) so a slow PostHog can't hold the room's D1/chat fetch slots. Client-supplied
values (e.g. an unknown message `type`) never name a throttle key or reach a log line verbatim:
`messageTypeLabel()` maps them to a fixed set.

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
- ⚠️ **Tokens never leave the browser.** The party socket URL carries `?token=<JWT>`, the OAuth
  callback carries `?code=&state=`, `dbd-auth` holds both tokens. `before_send` runs every
  event through `scrubProperties()` (JWT-shaped strings, token/code/state URL params,
  `accessToken`-style keys). Don't redact the bare `token` key — that's the SDK's project token,
  and ingestion routes on it. New event properties: report *facts about* a token
  (`token_present`, `token_ttl_s`), never the token or a URL containing it.
- **Realtime health** (`services/realtimeTelemetry.ts`, fed from `services/party.ts`): only the
  streamer's own channel reports. Every edit we send is tracked to its echo —
  `fila_mutation_acked` / `_rejected` (with the server-error `code`) / `_unacked` (no echo in
  15s, or the socket closed under it) / `_dropped` (sent while the socket was down). Plus
  `fila_party_connected` (reconnect, downtime, `token_present`, `token_ttl_s`, `token_expired`),
  `fila_party_disconnected`, `fila_claim_denied`, `fila_owner_recovered`, `fila_server_error`,
  and `fila_sync_diverged`: a `sync-full` that undoes what this window showed (`initial: true`
  = the queue cache, i.e. what the streamer saw before F5). Echo matching relies on the server
  echoing edits to their sender and on `reorder` carrying its `opId` — keep both.
- **PartyKit** (`apps/api/src/telemetry.ts`): PartyKit has no log export, so `party.ts` posts
  events straight to PostHog's `/batch/` endpoint — buffered, fire-and-forget, never awaited by
  storage or broadcast, throttled per room+key (one event per 60s plus a folded `count`).
  `fila_party_auth_failed` (JWT rejected at connect: `reason` expired/invalid/malformed,
  `claimed_login`, `is_room_login`), `fila_party_owner_connected`, `fila_party_claim_denied`,
  `fila_party_mutation_rejected` (`code`, `message_type`, `sender_authenticated`,
  `room_has_lock_holder`), `fila_party_persist_failed`, `fila_party_d1_sync_failed` /
  `_recovered`. Same `POSTHOG_KEY` env var as the logs; off under `DEV_MODE` (i.e. `partykit dev`).
  `distinct_id` is the room (= streamer login), with `$process_person_profile: false`.
- Test locally without touching the real project: build with `VITE_POSTHOG_HOST` pointing at
  a local sink + `VITE_POSTHOG_ALLOW_LOCAL=true`, run `partykit dev --var POSTHOG_KEY=phc_test
  --var POSTHOG_HOST=<sink>` (without `DEV_MODE`; the key is deliberately not in `partykit.json`).
  posthog-js drops headless browsers as bots: mask `navigator.webdriver` **and**
  `navigator.userAgentData`, and set a non-headless user agent, in the test browser.

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
- `ircCommand()` - Command of a raw IRC line (past tags/prefix). The socket dispatches by it, never by substring: tags and chat text routinely contain `366`/`USERNOTICE`
- `handleMessage()` - Parse donation bots (LivePix, StreamElements, etc.) + chat commands
- `isDonateBot()` - Check if username is a known donation bot
- `parseDonationMessage()` - Extract donor, amount, message from donation bot text
- `handleUserNotice()` - Parse resub USERNOTICE
- `handleChatCommand()` - Process chat requests with session limits
- `callLLM()` - Gemini API with model fallback/retry
- `identifyCharacter()` - Local match first, then LLM fallback
- `loadAndReplayVOD()` - VOD chat replay via GQL
- `useRequestToasts()` - One toast for everything that arrives (requests + skipped `type: 'none'` messages), updated in place instead of one toast per arrival: a single arrival keeps its classic look (skipped → Undo), more become a summary titled by the count ("3 novos pedidos", or "2 mensagens sem pedidos" if that's all), the names in one description line, never the count twice: "Huntress, Slasher e Lich · 2 mensagens sem pedidos de Ana e Beto" (each character and each sender once; only skipped → "De Ana e Beto"); Revisar → review dialog. Timing lives in `createToastDigest` (`utils/toastDigest.ts`): never times out while the streamer is off the tab — visible **and** focused, since sonner only pauses on `document.hidden` and a tab visible on a second monitor behind the game timed out unseen — and leaves `READ_DELAY_MS` after they're back. Each batch gets its own id (`new-requests-<n>`): with one fixed id, an arrival during the old toast's exit animation merged into it and was lost. What's in the queue at the first party sync (`partySynced`) is the baseline — per room, since `ChannelApp` stays mounted across an in-app channel switch; everything after it counts — keying it off the first non-empty batch instead swallowed the first request into an empty queue

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
  connection indicator. Before the server's first status (`statusKnown`) it goes by the
  room's last saved status from `/rooms/:id` — saved open → connecting, saved closed →
  closed, not loaded yet → `unknown` (no text, no animation). Never infer "connecting"
  from this window's socket opening: every channel page pulsed on load that way, only to
  settle on closed.
- **The lock transfers, it never refuses** (`party.ts` `claim-ownership`): a claim from
  another window of the same streamer hands the lock over and sends the old holder
  `ownership-denied` (which clears its lock and drops its IRC). So Open/Close the queue works
  from any window — `openQueue()` / `closeQueue()` in the context claim first when needed.
- **A deliberate close sticks.** `release-ownership` marks the channel `closedByOwner` (an
  additive, optional field on `ChannelState`); sessions skip the auto-reclaim while it's set,
  so nothing reopens a queue the streamer just closed. A socket that merely died leaves it
  unset, which is what makes the recovery above safe. A claim clears it.
- **Every grant re-reports chat.** The server resets the room to `online` on each claim and
  only an `irc-status` from the lock holder makes it `live`. A re-grant after a party reconnect
  finds IRC still joined, so no transition fires on its own — the grant effect sends
  `irc-status: true` itself. Without it the channel read "Conectando..." / "Fila fechada" to
  everyone for the rest of the stream while requests kept arriving.
- **Single-writer work follows `hasLock`**, not the UI capability: LLM identification and the
  VOD recovery scan, so a second tab never duplicates requests or burns a second round of
  tokens.
- ⚠️ **Every (re)connect presents a current token.** Access tokens live an hour and the party
  server authenticates a socket only at connect, so `connectParty` takes a token *getter* that
  partysocket runs before each attempt (`query` as an async function), and `getAccessToken`
  refreshes 5 min before `exp`. A token baked into the URL once is how a reconnect an hour into
  a stream came back anonymous: every ✓ was refused while the optimistic UI showed it landed,
  and a reload brought the whole queue back. The owner's session never connects anonymously —
  no token fails the attempt and the socket retries it.
- **Authority `server-error` codes are not failures, and never an error toast.**
  `not_lock_holder` means another session holds the lock or ours went stale: log and nudge a
  re-claim. `not_room_owner` (and `ownership-denied` with `not-room-owner`) on the streamer's
  own channel means this socket isn't authenticated as them — force a token refresh and
  reconnect (`reauthenticate`, throttled by `REAUTH_COOLDOWN`). If that keeps failing
  (the socket a heal reconnected is refused again, `REAUTH_WARN_AFTER` rounds in
  `REAUTH_WARN_WINDOW`, or an owner session that repeatedly can't get a token), an
  `auth-status` warning says edits may not be saved. It stays up (`duration: Infinity`) until a
  grant takes it down — the one state the streamer has to act on (reload / sign in again). Only
  `persist_failed` / `d1_sync_failed` are real server failures (toast id `server-error`,
  `duration: Infinity`); `pending_cap` and `chat_send_not_mod` are finite warnings under their
  own ids. Connection toasts own `party-status` / `irc-status` — don't reuse those ids for
  anything else.
- **`/auth/refresh` is single-flight and only a 400/401 signs out.** It runs on every reconnect
  near expiry, so treating a Worker 5xx as "logged out" would sign every live streamer out at once.
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
  (`hooks/useRequestToasts.tsx` needs it). Raising the constant grows DO storage and
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
