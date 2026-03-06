# Fila DBD

Aplicação web para gerenciar pedidos de personagens de Dead by Daylight durante streams na Twitch. 

Feito com carinho para a comunidade brasileira 🇧🇷 de Dead by Daylight, em especial [MandyMess](https://twitch.tv/mandymess) 🫶

## Como funciona

1. Conecta ao chat da Twitch em tempo real
2. Detecta pedidos de personagens de múltiplas fontes que o streamer configura (donates, resubs, comandos de chat)
3. Identifica automaticamente o personagem mencionado, usando IA (Gemini, free tier) quando necessário
4. Exibe fila ordenada por prioridade com retratos dos personagens

## Fontes de pedidos

| Fonte | Como funciona |
|-------|---------------|
| **Donates** | Detecta mensagens do bot de doação (ex: LivePix). Filtra por valor mínimo |
| **Resubs** | Captura mensagens de resub via USERNOTICE do Twitch IRC |
| **Chat** | Comando configurável (padrão: `!fila`) para inscritos. Filtra por tier mínimo |
| **Manual** | Entrada manual com autocomplete de personagens |

## Instalação

```bash
bun install
bun dev  # Servidor local com frontend + API + PartyKit
```

## Deploy

**Secrets necessários no GitHub:**
- `CLOUDFLARE_API_TOKEN` - token com permissão Workers
- `PARTYKIT_TOKEN` e `PARTYKIT_LOGIN` - obtido com `bunx partykit@latest token generate`

**Secrets no Cloudflare (via `wrangler secret put`):**
- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` - app Twitch
- `JWT_SECRET` - qualquer string segura
- `INTERNAL_API_SECRET` - secret compartilhado entre Worker e PartyKit

**Database D1 (via `wrangler d1 create fila-dbd`):**
- Criar o database e atualizar o `database_id` no `wrangler.toml`
- Aplicar migrations: `wrangler d1 migrations apply fila-dbd`

**Secrets no PartyKit (via `bunx partykit env add`):**
- `JWT_SECRET` - mesmo valor do Cloudflare
- `INTERNAL_API_SECRET` - mesmo valor do Cloudflare
- `API_URL` - URL do Worker em produção (ex: `https://dbd-tracker.<account>.workers.dev`)

## Uso

1. Digite o nome do canal e clique em **Conectar**
2. (Opcional) Adicione uma [API key do Gemini](https://aistudio.google.com/apikey) nas configurações para identificação automática de personagens

Funciona sem API key se os nomes dos personagens forem mencionados diretamente na mensagem.

## Interface

### Fila de pedidos

- Clique em um pedido para marcar como feito
- Arraste para reordenar manualmente
- Selecione a ordenação de pedidos por fila de chegada ou por prioridade
- Botão **+** adiciona pedido manual com autocomplete

### Painel de fontes

- Ative/desative cada fonte individualmente
- **Donates**: configure valor mínimo
- **Chat**: configure comando e tier mínimo de inscrito (ex: só Tier 2 e 3 podem pedir)
- Arraste os pills de prioridade para definir ordem de classificação

### Configurações LLM

Usamos o Google Gemini que oferece um plano gratuito e fácil de configurar.

- **API Key**: chave do Google Gemini para identificação de personagens
- **Modelos**: lista de modelos em ordem de prioridade (fallback em caso de rate limit)

### Chat ao vivo

Exibe mensagens do chat em tempo real. Pode ser escondido para mais espaço.

## Debug

Adicione `/debug` na URL para ativar o painel de debug. Exemplo: `http://localhost:5173/dbd-utils/#/meriw_/debug`.

- **Testar extração**: testa identificação de personagem em uma mensagem
- **Re-identificar todos**: reprocessa todos os pedidos da fila
- **Replay VOD**: reproduz chat de uma VOD para testes (requer ID da VOD, que pode ser encontrada na url do vídeo)

### Console (DevTools)

```js
dbdDebug.chat('User', 'msg')                      // chat sub tier 1
dbdDebug.chat('User', 'msg', { tier: 2 })         // chat sub tier 2
dbdDebug.chat('User', 'msg', { sub: false })      // chat não-sub
dbdDebug.donate('Donor', 50, 'msg')               // donate R$50
dbdDebug.resub('User', 'msg')                     // resub
dbdDebug.raw('@tags... PRIVMSG #ch :msg')         // raw IRC
```

## Licença

MIT

Todos os direitos de Dead by Daylight pertencem à Behaviour Interactive.
