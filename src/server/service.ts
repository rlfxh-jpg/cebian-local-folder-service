import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { watch } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import type { ServiceConfig } from "../config/index.ts";
import { ServiceError } from "../shared/errors.ts";
import { StateStore } from "../storage/state-store.ts";

import { WatcherRegistry } from "../watchers/registry.ts";
import { createRouter } from "../protocol/router.ts";
import { protocolVersion, type Connection, type RequestMessage } from "../protocol/types.ts";
import { sendEvent, sendResponse } from "../protocol/responses.ts";
import { consumeRate, isRecord } from "../protocol/validation.ts";
import { listen } from "./listen.ts";

export async function startService(config: ServiceConfig): Promise<{ close: () => Promise<void>; url: string; pairingCode: string; state: StateStore }> {
  const state = new StateStore(config.dataDir);
  await state.load();
  const pairingCode = randomBytes(5).toString("hex").toUpperCase();
  const connectionMap = new Set<Connection>();
  const watchers = new WatcherRegistry();
  const { dispatch, closeSubscription } = createRouter({ config, state, watchers, connections: connectionMap, pairingCode, getPort: () => getListeningPort(server, config.port), closeConnection });
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: "Cebian Local Folder Service", protocolVersion, status: "running", host: config.host, port: getListeningPort(server, config.port) }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes, perMessageDeflate: false });

  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if (!isLoopback(request) || (origin && !config.allowedOrigins.has(origin)) || request.url !== "/ws" || connectionMap.size >= config.maxConnections) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    const connection: Connection = { ws, requestTimes: [], searches: new Map(), pairAttempts: 0, activeRequests: 0, activeRequestIds: new Set(), alive: true };
    connectionMap.add(connection);
    ws.on("message", (raw) => void onMessage(connection, raw.toString()));
    ws.on("pong", () => { connection.alive = true; });
    ws.on("close", () => closeConnection(connection));
    ws.on("error", () => closeConnection(connection));
  });

  const heartbeat = setInterval(() => {
    for (const connection of connectionMap) {
      if (connection.ws.readyState !== WebSocket.OPEN) continue;
      if (!connection.alive) { connection.ws.terminate(); continue; }
      connection.alive = false;
      try { connection.ws.ping(); } catch { connection.ws.terminate(); }
    }
  }, 30_000).unref();

  const syncRevokedConnections = async () => {
    try {
      await state.refresh();
      const current = new Set(state.clients.map((client) => client.id));
      for (const connection of connectionMap) {
        if (connection.clientId && !current.has(connection.clientId)) {
          sendEvent(connection, { event: "auth.revoked" });
          closeConnection(connection, 4003, "authorization revoked");
        }
      }
    } catch (error) { console.error(`[LocalFolder] 无法检查授权状态：${String(error)}`); }
  };
  const stateWatcher = watch(config.dataDir, (_event, filename) => {
    if (filename?.toString() === "state.json") void syncRevokedConnections();
  });
  stateWatcher.on("error", (error) => console.error(`[LocalFolder] 授权变更监听失败：${error.message}`));
  const revokePoll = setInterval(() => void syncRevokedConnections(), 2000).unref();

  async function onMessage(connection: Connection, raw: string): Promise<void> {
    let message: RequestMessage;
    try {
      const parsed = JSON.parse(raw) as RequestMessage;
      if (parsed?.protocolVersion !== protocolVersion) throw new ServiceError("PROTOCOL_VERSION_UNSUPPORTED", "客户端与服务端协议版本不兼容。");
      if (parsed?.type !== "request" || typeof parsed.requestId !== "string" || !parsed.requestId || parsed.requestId.length > 128 || typeof parsed.method !== "string" || !isRecord(parsed.params ?? {})) {
        throw new ServiceError("INVALID_REQUEST", "WebSocket 请求格式无效或协议版本不受支持。");
      }
      message = parsed;
    } catch (error) {
      const problem = error instanceof ServiceError ? error : new ServiceError("INVALID_REQUEST", "请求必须是有效的 JSON 消息。");
      sendResponse(connection, "", undefined, problem);
      return;
    }
    if (!consumeRate(connection, config.maxRequestsPerMinute)) { sendResponse(connection, message.requestId, undefined, new ServiceError("RATE_LIMITED", "请求过于频繁，请稍后重试。", true)); return; }
    if (connection.activeRequestIds.has(message.requestId)) { sendResponse(connection, message.requestId, undefined, new ServiceError("DUPLICATE_REQUEST_ID", "requestId 正在使用中，必须为每个活动请求生成唯一 ID。")); return; }
    if (connection.activeRequests >= 32) { sendResponse(connection, message.requestId, undefined, new ServiceError("RESOURCE_LIMIT", "该连接的并发请求已达上限。", true)); return; }
    try { await state.refresh(); } catch (error) { sendResponse(connection, message.requestId, undefined, error); return; }
    if (connection.clientId && !state.clients.some((client) => client.id === connection.clientId)) {
      sendEvent(connection, { event: "auth.revoked" });
      closeConnection(connection, 4003, "authorization revoked");
      return;
    }
    const params = message.params ?? {};
    connection.activeRequests++;
    connection.activeRequestIds.add(message.requestId);
    try {
      const result = await dispatch(connection, message, params);
      sendResponse(connection, message.requestId, result);
    } catch (error) {
      sendResponse(connection, message.requestId, undefined, error);
    } finally { connection.activeRequests--; connection.activeRequestIds.delete(message.requestId); }
  }

  function closeConnection(connection: Connection, code?: number, reason?: string): void {
    closeSubscription(connection);
    for (const controller of connection.searches.values()) controller.abort();
    connection.searches.clear();
    connectionMap.delete(connection);
    if (connection.ws.readyState === WebSocket.OPEN && code) connection.ws.close(code, reason);
  }

  try {
    await listen(server, config.host, config.port, "后端服务", "LOCAL_FOLDER_PORT");
  } catch (error) {
    clearInterval(heartbeat);
    clearInterval(revokePoll);
    stateWatcher.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    throw error;
  }
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : config.port;
  const url = `ws://${config.host === "::1" ? `[${config.host}]` : config.host}:${actualPort}/ws`;
  const close = async () => {
    clearInterval(revokePoll);
    clearInterval(heartbeat);
    stateWatcher.close();
    const sockets = [...connectionMap].map((connection) => connection.ws);
    for (const connection of [...connectionMap]) {
      sendEvent(connection, { event: "service.shutting-down" });
      closeConnection(connection, 1001, "service shutting down");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  return { close, url, pairingCode, state };
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function getListeningPort(server: ReturnType<typeof createServer>, fallback: number): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : fallback;
}
