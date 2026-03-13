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
- `handleMessage()` - Parse donation bot + chat commands
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
