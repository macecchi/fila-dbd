# Fila DBD

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2?logo=discord&logoColor=white)](https://discord.gg/hXsAgk5KnX)

[English](#english) | [Português](#português)

---

## English

A website to manage Dead by Daylight character requests during Twitch streams.

Made with love for the Dead by Daylight community, especially [MandyMess](https://twitch.tv/mandymess) 🫶

Use our [Discord](https://discord.gg/hXsAgk5KnX) or GitHub to send feedback, suggest features, and report bugs.

### How it works

1. Connects to Twitch chat in real time
2. Detects character requests from multiple sources configured by the streamer (donations, resubs, chat commands)
3. Automatically identifies the mentioned character, using AI when needed
4. Displays an ordered queue with character portraits

### How to use

1. Go to the website and click **Start my queue** to connect with your Twitch account
2. Your queue will open automatically
3. Configure your request sources

You need to keep the site open to receive requests.

**Notifications**: we only show a small notice on the page when a new request is received. Enable browser notifications to get alerts when there's an issue — and to get a push when your stream goes live reminding you to open your queue (works even with the site closed).

#### Request sources

| Source | How it works |
|--------|-------------|
| **Donations** | Detects messages from donation bots (LivePix, StreamElements, etc.). Filters by minimum amount. Donations that exceed the minimum may contain multiple requests in one message (up to 10). LivePix relays only the first 250 characters of the message to chat — donates that hit that cap are never hidden and stay in the queue for manual review (a ✂️ marker links to the LivePix dashboard hint) |
| **Resubs** | Captures resub messages via Twitch IRC USERNOTICE |
| **Chat** | Configurable command (default: `!fila`) for subscribers. Filters by minimum tier |
| **Manual** | Manual character entry |

#### Request queue

- Click the ✓ button on a request to mark it as done
- Done requests leave the queue and appear in the **Recently played** strip in the header: the latest one open, the previous few collapsed to their portraits. Hover a portrait to expand it (the open one collapses) and, if you're the streamer, undo the ✓ from there
- Drag to reorder manually
- Select request ordering by arrival order or by priority
- **+** button adds a manual request

#### Sources panel

Enable/disable each source individually at any time:

- **Donations**: configure minimum amount
- **Chat**: configure command and minimum subscriber tier (e.g. only Tier 2 and 3 can request)
- **Resubs**: resubscription messages

Drag the priority pills to define the order in which new requests enter the queue.

---

## Installation

Install [Bun](https://bun.sh) and run:

```bash
bun install
bun dev  # Local server with frontend + API + PartyKit
```

## Deploy

The service is designed to be deployed on [Cloudflare Workers](https://workers.cloudflare.com/) and [PartyKit](https://www.partykit.io/).

**Required GitHub secrets:**

- `CLOUDFLARE_API_TOKEN` - token with Workers permission
- `PARTYKIT_TOKEN` and `PARTYKIT_LOGIN` - obtained with `bunx partykit@latest token generate`

**Cloudflare secrets (via `wrangler secret put`):**

- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` - Twitch app
- `JWT_SECRET` - any secure string
- `INTERNAL_API_SECRET` - shared secret between Worker and PartyKit
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` - Web Push keys for the "you're live" notification (generate with `bun scripts/generate-vapid-keys.ts` from `apps/api/`). Optional — the feature stays off without them
- `EVENTSUB_SECRET` - any secure string; signs Twitch EventSub webhooks (`stream.online`). Optional, required for the "you're live" notification

**KV Namespace (via `wrangler kv namespace create CACHE`):**

- Create the namespace and update the `id` in `wrangler.toml`

**D1 Database (via `wrangler d1 create fila-dbd`):**

- Create the database and update the `database_id` in `wrangler.toml`
- Apply migrations: `wrangler d1 migrations apply fila-dbd`

**Cloudflare Pages environment variables:**

- `VITE_TWITCH_CLIENT_ID` - same Twitch app Client ID (used by frontend for OAuth redirect)
- `VITE_API_URL` - Production Worker URL

**PartyKit secrets (via `bunx partykit env add`):**

- `JWT_SECRET` - same value as Cloudflare
- `INTERNAL_API_SECRET` - same value as Cloudflare
- `API_URL` - Production Worker URL (e.g. `https://dbd-tracker.<account>.workers.dev`)

**Chat confirmation bot (`@filadbd`):**

Optional. Required for the "Confirm requests in chat" toggle to deliver messages.

1. Create / log into a dedicated Twitch account (the bot identity, e.g. `@filadbd`).
2. Add `http://localhost:8923/callback` to the Twitch app's OAuth Redirect URLs.
3. From `apps/api/`, run the one-time authorization flow:
   ```bash
   TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... bun scripts/authorize-bot.ts
   ```
   It opens the consent screen, captures the code locally, exchanges it, and prints the
   `wrangler kv key put` command for the resulting `bot_token`. Run that command against
   `--remote` (and/or `--local` for dev). The Worker refreshes the token automatically.
4. Each streamer using the feature must add the bot as a moderator in their channel
   (`/mod filadbd`) — the UI shows this hint when the toggle is enabled.

## Debug

Add `#debug` to the URL to activate the debug panel. Example: `http://localhost:5173/meriw_/#debug`.

- **Test extraction**: tests character identification on a message
- **Re-identify all**: reprocesses all requests in the queue
- **Replay VOD**: replays VOD chat for testing (requires VOD ID, which can be found in the video URL)

### Console (DevTools)

```js
dbdDebug.chat('User', 'msg')                      // chat sub tier 1
dbdDebug.chat('User', 'msg', { tier: 2 })         // chat sub tier 2
dbdDebug.chat('User', 'msg', { sub: false })      // chat non-sub
dbdDebug.donate('Donor', 50, 'msg')               // donate R$50 (LivePix format)
dbdDebug.resub('User', 'msg')                     // resub
dbdDebug.raw('@tags... PRIVMSG #ch :msg')         // raw IRC
dbdDebug.newVersion()                             // "new version" toast + auto-update countdown
dbdDebug.newVersion({ mismatch: true })           // server version_mismatch warning variant
```

To test StreamElements format:

```js
dbdDebug.raw('@display-name=StreamElements :streamelements!streamelements@streamelements.tmi.twitch.tv PRIVMSG #ch :Donor mandou 5.00 e disse: Huntress')
```

### Signing in as the channel owner (local only)

Owner-only paths (opening the queue, ✓ / undo, editing sources) need a JWT the party server
verifies, which normally means a full Twitch OAuth round trip. For local testing, mint one
directly:

```bash
cd apps/api && bun run dev:login <channel>
```

Pass the channel you're testing as the login, so the server's `user.login === room.id` check
passes for real and you exercise the production path rather than the `DEV_MODE` bypass. The
script prints a `localStorage.setItem('dbd-auth', …)` snippet to paste into the DevTools
console on `localhost:5173`; the reload comes back signed in.

The token is signed with the `JWT_SECRET` in `apps/api/.env` — your local dev secret — so it
is only ever valid against `wrangler dev` / `partykit dev`, never production.

### Testing the live notification locally

The "your channel is live" push is the one flow the dev server cannot show you:
`vite dev` registers no service worker, and Twitch cannot reach `localhost` to deliver
the EventSub webhook. Both halves are replaceable locally.

**1. Just the notification UI (30 seconds, no keys needed).** Build and preview, then
use DevTools → Application → Service Workers → the *Push* box, and send:

```json
{"type":"stream-online","channel":"meriw_","locale":"pt-BR","pending":3}
```

That runs the real `push` / `notificationclick` handlers in `apps/web/src/sw.ts` — the
notification copy, the icon and the click-through to the channel.

**2. The whole chain (Worker → Web Push → your browser).**

```bash
# once: generate keys and add them to apps/api/.env
cd apps/api && bun scripts/generate-vapid-keys.ts
echo "EVENTSUB_SECRET=$(openssl rand -hex 32)" >> .env

bun run dev                                   # from the repo root
bun run --filter @filadbd/web preview         # production build — the SW only exists here
```

Open `http://localhost:4173/<your channel>/`, sign in with `bun run dev:login <channel>`,
allow notifications, and confirm the subscription landed:

```bash
cd apps/api && wrangler d1 execute fila-dbd --local --command "SELECT room_id, locale, substr(endpoint,1,40) FROM push_subscriptions"
```

Then fire a fake `stream.online`:

```bash
cd apps/api && bun run dev:live <channel>
```

The script signs the webhook exactly as Twitch does, so the Worker runs its real
verification, dedupe, cooldown and push path — and the push goes out to the real push
service, which delivers it to your browser even with the site closed.

Nothing arriving is usually one of: the queue is already open (pushes are deliberately
skipped then), or no `VAPID_*` keys (the feature stays off — `/push/vapid-public-key`
returns an empty key). The `wrangler dev` log tells you which.

The notification is written in whichever language the streamer has the site set to: each
subscription stores that language, the Worker sends it back with the push, and the service
worker renders the strings from `apps/web/src/i18n/pushCopy.ts` (the SW can't read the
app's language toggle itself). Switching the language re-registers the subscription, so
the next push follows.

### LLM extraction evals

Live evals against the real Gemini API live in `apps/api/src/gemini.eval.test.ts`. They are skipped by the default test suite (and by CI) and run on demand:

```bash
cd apps/api
set -a && source .env && set +a   # load GEMINI_API_KEY
bun run test:eval
```

Scenarios are sampled from real anonymized donation messages and cover single-character nicknames, no-request messages, and multi-character requests (including quantifiers like "2 de trapper e 1 de nurse"). Comparison is multiset — order doesn't matter, duplicates do. Add new cases to the file when a new edge case surfaces in production.

## License

MIT ([LICENSE](LICENSE))

All Dead by Daylight rights belong to Behaviour Interactive.

## Acknowledgments

- [MandyMess](https://twitch.tv/mandymess) - for inspiring me to create this project
- [Dead by Daylight Wiki](https://deadbydaylight.wiki.gg/) - character database and images
- [MaChInEgUn3](https://www.twitch.tv/machinigun3) - added support for GGPix via StreamElements

---

## Português

Site para gerenciar pedidos de personagens de Dead by Daylight durante streams na Twitch.

Feito com carinho para a comunidade brasileira 🇧🇷 de Dead by Daylight, em especial [MandyMess](https://twitch.tv/mandymess) 🫶

Use o nosso [Discord](https://discord.gg/hXsAgk5KnX) ou o próprio GitHub para mandar feedback, sugerir funcionalidades e reportar bugs.

### Como funciona

1. Conecta ao chat da Twitch em tempo real
2. Detecta pedidos de personagens de múltiplas fontes que o streamer configura (donates, resubs, comandos de chat)
3. Identifica automaticamente o personagem mencionado, usando IA quando necessário
4. Exibe fila ordenada com retratos dos personagens

### Como usar

1. Acesse o site e clique em **Começar minha fila** para conectar com sua conta da Twitch
2. Sua fila será aberta automaticamente
3. Configure as fontes de pedidos

É preciso estar com o site aberto para receber pedidos.

**Notificações**: só mostramos um pequeno aviso na página quando um novo pedido é recebido. Ative as notificações do navegador para receber alertas quando houver algum problema — e para receber um aviso quando sua live começar lembrando de abrir sua fila (funciona mesmo com o site fechado).

#### Fontes de pedidos

| Fonte | Como funciona |
|-------|---------------|
| **Donates** | Detecta mensagens de bots de doação (LivePix, StreamElements, etc.). Filtra por valor mínimo. Donates acima do mínimo podem conter múltiplos pedidos numa mesma mensagem (até 10). O LivePix envia só os primeiros 250 caracteres da mensagem pro chat — donates que batem nesse limite nunca são ocultados e ficam na fila para revisão manual (marcador ✂️ com dica para conferir o painel do LivePix) |
| **Resubs** | Captura mensagens de resub via USERNOTICE do Twitch IRC |
| **Chat** | Comando configurável (padrão: `!fila`) para inscritos. Filtra por tier mínimo |
| **Manual** | Entrada manual de personagens |

#### Fila de pedidos

- Clique no botão ✓ do pedido para marcar como feito
- Pedidos feitos saem da fila e aparecem em **Jogados recentemente**, no topo da página: o último aberto e os anteriores reduzidos ao retrato. Passe o mouse num retrato para expandi-lo (o que estava aberto encolhe) e, se você é o streamer, desfaça o ✓ por ali
- Arraste para reordenar manualmente
- Selecione a ordenação de pedidos por fila de chegada ou por prioridade
- Botão **+** adiciona pedido manual

#### Painel de fontes

Ative/desative cada fonte individualmente e a qualquer momento:

- **Donates**: configure valor mínimo
- **Chat**: configure comando e tier mínimo de inscrito (ex: só Tier 2 e 3 podem pedir)
- **Resubs**: mensagens de reinscrição

Arraste os pills de prioridade para definir ordem que os novos pedidos entram na fila.
