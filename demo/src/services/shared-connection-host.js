import { SocketClient } from "./socket-client.js";

const errorData = (error) => ({ message: error.message, ...(error.code ? { code: error.code } : {}) });

/** Each tab owns a socket/subscription. Only pairing credentials are shared by endpoint. */
export function createSharedConnectionHost({ createClient = () => new SocketClient(), graceMs = 30_000 } = {}) {
  const sessions = new Map();
  const credentials = new Map();
  const ports = new Set();
  const bindings = new Map();
  let disposed = false;

  const send = (port, message) => { try { port?.postMessage(message); } catch { /* A navigating page has no receiver. */ } };
  const snapshot = (session) => ({ sessionId: session.id, endpoint: session.endpoint,
    connected: session.client.connected, authenticated: session.authenticated, subscription: session.subscription });
  function createSession(id) {
    const client = createClient();
    const session = { id, client, endpoint: "", authenticated: false, subscription: null, owner: null, timer: null };
    client.onEvent = (event) => {
      if (event.event === "auth.revoked") {
        credentials.delete(session.endpoint);
        session.authenticated = false; session.subscription = null;
      }
      send(session.owner, { type: "event", event });
    };
    client.onClose = () => {
      session.authenticated = false; session.subscription = null;
      send(session.owner, { type: "closed" });
    };
    client.onRequest = (method, code, duration) => send(session.owner, { type: "request-log", method, code, duration });
    sessions.set(id, session);
    return session;
  }
  function release(port) {
    const session = bindings.get(port);
    bindings.delete(port); ports.delete(port);
    if (!session || session.owner !== port) return;
    session.owner = null;
    session.timer = setTimeout(() => {
      if (session.owner) return;
      session.client.disconnect(); sessions.delete(session.id);
    }, graceMs);
    session.timer.unref?.();
  }
  function validateEndpoint(value) {
    const url = new URL(value);
    if (!["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw new Error("请输入不含凭据的本机 WebSocket 地址。");
    return url.href;
  }
  async function connect(session, endpoint) {
    const url = validateEndpoint(endpoint);
    if (session.client.connected) {
      if (session.endpoint !== url) throw new Error("请先断开当前连接。");
      return snapshot(session);
    }
    if (session.connecting) throw new Error("正在连接服务，请稍候。");
    session.connecting = true; session.endpoint = url;
    try {
      await session.client.connect(url);
      const token = credentials.get(url);
      if (token) {
        try {
          await session.client.request("authenticate", { token });
          session.authenticated = true;
        } catch (error) {
          if (error.code !== "UNAUTHORIZED") throw error;
          credentials.delete(url);
        }
      }
      return snapshot(session);
    } catch (error) {
      session.client.disconnect();
      throw error;
    } finally { session.connecting = false; }
  }
  async function request(session, { method, params = {}, timeout }) {
    const result = await session.client.request(method, params, timeout);
    if (method === "pair/complete") {
      credentials.set(session.endpoint, result.token);
      session.authenticated = true;
      // The page never receives the credential in SharedWorker mode.
      const { token, ...publicResult } = result;
      return publicResult;
    }
    if (method === "authenticate") {
      credentials.set(session.endpoint, params.token); session.authenticated = true;
    }
    if (["folder/choose", "subscription/open"].includes(method) && !result.cancelled) session.subscription = result;
    if (method === "subscription/close") session.subscription = null;
    return result;
  }
  function attach(port) {
    if (disposed) throw new Error("SharedWorker 已停止。");
    ports.add(port);
    port.onmessage = async ({ data }) => {
      try {
        if (data.type === "detach") { release(port); port.close(); return; }
        let session = bindings.get(port);
        let result;
        if (data.type === "attach") {
          if (!session) {
            const requested = typeof data.sessionId === "string" && /^[\w-]{1,100}$/.test(data.sessionId) ? data.sessionId : crypto.randomUUID();
            session = sessions.get(requested);
            // Duplicated tabs copy sessionStorage. They must never steal an active tab's subscription.
            if (session?.owner && session.owner !== port) session = null;
            session ??= createSession(sessions.has(requested) ? crypto.randomUUID() : requested);
            clearTimeout(session.timer); session.timer = null;
            session.owner = port; bindings.set(port, session);
          }
          result = snapshot(session);
        } else {
          if (!session) throw new Error("请先接入 SharedWorker。");
          switch (data.type) {
            case "connect": result = await connect(session, data.url); break;
            case "snapshot": result = snapshot(session); break;
            case "request": result = await request(session, data); break;
            case "disconnect":
              session.authenticated = false; session.subscription = null;
              session.client.disconnect(); result = {}; break;
            default: throw new Error("未知的 SharedWorker 操作。");
          }
        }
        send(port, { replyTo: data.id, result });
      } catch (error) { send(port, { replyTo: data.id, error: errorData(error) }); }
    };
    port.addEventListener("close", () => release(port));
    port.start();
  }
  function dispose() {
    disposed = true;
    for (const session of sessions.values()) { clearTimeout(session.timer); session.client.disconnect(); }
    for (const port of ports) port.close();
    ports.clear(); bindings.clear(); sessions.clear(); credentials.clear();
  }
  return { attach, dispose };
}
