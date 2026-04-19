/**
 * WebhookHub — Durable Object that holds WebSocket connections to the dashboard.
 * The webhook handler sends events here, and they get broadcast to all connected clients.
 *
 * Single instance ("default") used for all clients — adequate for a few admin tabs.
 * For multi-tenant scale, key the DO by tenant/user.
 */

export class WebhookHub {
  private state: DurableObjectState;
  private sockets: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── WebSocket upgrade for clients ──
    if (url.pathname === "/ws") {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      this.sockets.add(server);

      server.addEventListener("close", () => this.sockets.delete(server));
      server.addEventListener("error", () => this.sockets.delete(server));

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Broadcast events from webhook ──
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const payload = await request.text(); // already JSON string
      const dead: WebSocket[] = [];
      for (const ws of this.sockets) {
        try {
          ws.send(payload);
        } catch {
          dead.push(ws);
        }
      }
      for (const d of dead) this.sockets.delete(d);
      return new Response(JSON.stringify({ delivered: this.sockets.size }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
