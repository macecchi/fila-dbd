import { Server, routePartykitRequest, type Connection, type ConnectionContext } from 'partyserver';
import app from './index';
import PartyRoomLogic from './party';

// One Worker serves both the Hono API and the realtime rooms. Rooms are `Main` Durable
// Objects (PartyServer), reached at /parties/main/:room — the path partysocket's default
// party uses, so clients only change host. Hosted PartyKit (*.partykit.dev) shut down on
// 2026-10-23; this replaces it on our own Cloudflare account.
type Env = Record<string, unknown>;

export class Main extends Server<Env> {
  // The room keeps its connections, lock holder and debounced D1 sync in memory, so it
  // must stay resident while sockets are open, as it did on hosted PartyKit.
  static options = { hibernate: false };

  private logic!: PartyRoomLogic;

  async onStart() {
    const ctx = this.ctx;
    const env = this.env;
    // In-process call into the API: same script, so no subrequest and no public hop.
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    this.logic = new PartyRoomLogic({
      id: this.name,
      env,
      storage: ctx.storage,
      getConnections: () => this.getConnections(),
      fetchApi: async (path, init) => app.fetch(new Request(`https://internal${path}`, init), env, executionCtx),
      consoleExported: true,
    });
    await this.logic.onStart();
  }

  onConnect(conn: Connection, ctx: ConnectionContext) {
    return this.logic.onConnect(conn, ctx);
  }

  onMessage(conn: Connection, message: string | ArrayBuffer | ArrayBufferView) {
    if (typeof message !== 'string') return;
    return this.logic.onMessage(message, conn);
  }

  onClose(conn: Connection) {
    this.logic.onClose(conn);
  }

  onError(conn: Connection, error: unknown) {
    this.logic.onError(conn, error);
  }

  onRequest(req: Request) {
    return this.logic.onRequest(req);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return (await routePartykitRequest(req, env as never)) ?? app.fetch(req, env, ctx);
  },
};
